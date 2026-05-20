<script setup lang="ts">
import { ref, nextTick, onMounted, onBeforeUnmount, watch, shallowRef } from "vue";
import type { CompletionContext } from "@codemirror/autocomplete";
import type { EditorView as EditorViewType } from "@codemirror/view";
import {
  SearchQuery,
  setSearchQuery,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  replaceNext as cmReplaceNext,
  replaceAll as cmReplaceAll,
  search as cmSearch,
} from "@codemirror/search";
import { ChevronUp, ChevronDown, ChevronRight, X } from "lucide-vue-next";
import { resolveExecutableSql } from "@/lib/sqlExecutionTarget";
import { formatSqlText, type SqlFormatDialect } from "@/lib/sqlFormatter";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  buildSqlCompletionItemsFromContext,
  getSqlFunctionSignatureHelp,
  getSqlCompletionContext,
  shouldAutoOpenSqlCompletion,
} from "@/lib/sqlCompletion";
import { extractIdentifierAt, isSqlKeyword, matchTable } from "@/lib/sqlNavigation";
import { lineColumnToOffset, parseSqlErrorLocation } from "@/lib/sqlDiagnostics";
import { loadEditorTheme, editorFontTheme, sqlCompletionTheme } from "@/lib/editorThemes";
import { shortcutToCodeMirrorKey } from "@/lib/shortcutRegistry";
import type { SqlCompletionColumn } from "@/lib/sqlCompletion";

const props = defineProps<{
  modelValue: string;
  connectionId?: string;
  database?: string;
  dialect?: "mysql" | "postgres" | "sqlserver";
  formatDialect?: SqlFormatDialect;
  formatRequestId?: number;
  executionError?: string;
  readOnly?: boolean;
  forceWordWrap?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  selectionChange: [value: string];
  cursorChange: [pos: number];
  formatError: [message: string];
  execute: [sql: string];
  save: [];
  clickTable: [tableName: string];
  clickColumn: [columns: Array<{ name: string; table: string; schema?: string }>, error?: string | undefined];
  closeColumnPanel: [];
}>();

const editorRef = ref<HTMLDivElement>();
const view = shallowRef<EditorViewType | null>(null);
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const MAX_COMPLETION_TABLES = 200;

const searchVisible = ref(false);
const searchText = ref("");
const replaceText = ref("");
const showReplace = ref(false);
const caseSensitive = ref(false);
const useRegex = ref(false);
const matchCount = ref(0);
const currentMatchIndex = ref(0);
const searchInputRef = ref<HTMLInputElement>();

let editorViewModule: typeof import("@codemirror/view") | null = null;
let fontThemeComp: import("@codemirror/state").Compartment | null = null;
let codeMirrorTheme: import("@codemirror/state").Compartment | null = null;
let wordWrapComp: import("@codemirror/state").Compartment | null = null;
let readOnlyComp: import("@codemirror/state").Compartment | null = null;
let runKeymapComp: import("@codemirror/state").Compartment | null = null;
let diagnosticComp: import("@codemirror/state").Compartment | null = null;
let buildSqlDiagnosticExtension: (() => import("@codemirror/state").Extension) | null = null;
let buildSqlSignatureExtension: (() => import("@codemirror/state").Extension) | null = null;
let codeMirrorSnippetCompletion: typeof import("@codemirror/autocomplete").snippetCompletion;

// Completion cache
let cachedTables: Array<{ name: string; schema?: string; type?: "table" | "view" }> = [];
// Persistent column cache keyed by "schema.table" or "table"
const cachedColumnsByTable = new Map<string, SqlCompletionColumn[]>();

function setFontSize(size: number) {
  const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
  const ss = settingsStore.editorSettings;
  ss.fontSize = next;
  settingsStore.updateEditorSettings({ fontSize: next });
  if (view.value && fontThemeComp && editorViewModule) {
    view.value.dispatch({
      effects: [
        fontThemeComp.reconfigure(
          editorFontTheme(editorViewModule.EditorView, next, ss.fontFamily, {
            fixedHeight: true,
            scrollable: true,
          }),
        ),
      ],
    });
  }
}

function zoomIn() {
  setFontSize(settingsStore.editorSettings.fontSize + 1);
}

function zoomOut() {
  setFontSize(settingsStore.editorSettings.fontSize - 1);
}

function resetZoom() {
  setFontSize(13);
}

function runKeymapExtension(codeMirrorKeymap: (typeof import("@codemirror/view"))["keymap"]) {
  const shortcuts = settingsStore.editorSettings.shortcuts;
  return codeMirrorKeymap.of([
    {
      key: "Mod-=",
      run: () => {
        zoomIn();
        return true;
      },
    },
    {
      key: "Mod-+",
      run: () => {
        zoomIn();
        return true;
      },
    },
    {
      key: "Mod--",
      run: () => {
        zoomOut();
        return true;
      },
    },
    {
      key: "Mod-0",
      run: () => {
        resetZoom();
        return true;
      },
    },
    {
      key: shortcutToCodeMirrorKey(shortcuts.executeSql),
      run: () => {
        if (view.value) emit("execute", executableSqlFromView(view.value));
        return true;
      },
    },
    {
      key: shortcutToCodeMirrorKey(shortcuts.saveSql),
      run: () => {
        emit("save");
        return true;
      },
    },
  ]);
}

function wordWrapExtension() {
  if (!editorViewModule) return [];
  return props.forceWordWrap || settingsStore.editorSettings.wordWrap ? editorViewModule.EditorView.lineWrapping : [];
}

function selectedSqlFromView(currentView: EditorViewType): string {
  const selection = currentView.state.selection.main;
  return currentView.state.sliceDoc(selection.from, selection.to);
}

function executableSqlFromView(currentView: EditorViewType): string {
  return resolveExecutableSql(currentView.state.doc.toString(), selectedSqlFromView(currentView));
}

function identifierRangeAt(sql: string, pos: number): { from: number; to: number; text: string } | null {
  const isIdentifierChar = (ch: string | undefined) => !!ch && /[\w$.]/.test(ch);
  if (!isIdentifierChar(sql[pos]) && !isIdentifierChar(sql[pos - 1])) return null;

  let from = pos;
  while (from > 0 && isIdentifierChar(sql[from - 1])) from--;
  let to = pos;
  while (to < sql.length && isIdentifierChar(sql[to])) to++;

  const text = sql.slice(from, to).replace(/^\.+|\.+$/g, "");
  if (!text || isSqlKeyword(text)) return null;
  return { from, to, text };
}

function completionCacheKey(table: { name: string; schema?: string }) {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

async function ensureColumnsForTable(table: { name: string; schema?: string }) {
  const cacheKey = completionCacheKey(table);
  if (cachedColumnsByTable.has(cacheKey) || !props.connectionId || !props.database) return;
  const columns = await connectionStore.listCompletionColumns(
    props.connectionId,
    props.database,
    table.name,
    table.schema,
  );
  cachedColumnsByTable.set(cacheKey, columns);
}

function createHoverDom(title: string, detail: string, rows: string[] = []) {
  const dom = document.createElement("div");
  dom.className = "rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md";

  const heading = document.createElement("div");
  heading.className = "font-medium";
  heading.textContent = title;
  dom.appendChild(heading);

  const detailNode = document.createElement("div");
  detailNode.className = "mt-1 text-muted-foreground";
  detailNode.textContent = detail;
  dom.appendChild(detailNode);

  for (const row of rows) {
    const rowNode = document.createElement("div");
    rowNode.className = "mt-1 font-mono text-muted-foreground";
    rowNode.textContent = row;
    dom.appendChild(rowNode);
  }

  return dom;
}

function createSignatureDom(signature: ReturnType<typeof getSqlFunctionSignatureHelp>) {
  const dom = document.createElement("div");
  dom.className = "rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md";
  if (!signature) return dom;

  const signatureNode = document.createElement("div");
  signatureNode.className = "font-mono";

  const nameNode = document.createElement("span");
  nameNode.className = "text-muted-foreground";
  nameNode.textContent = `${signature.name}(`;
  signatureNode.appendChild(nameNode);

  signature.parameters.forEach((parameter, index) => {
    if (index > 0) {
      const comma = document.createElement("span");
      comma.className = "text-muted-foreground";
      comma.textContent = ", ";
      signatureNode.appendChild(comma);
    }
    const parameterNode = document.createElement("span");
    parameterNode.className =
      index === signature.activeParameter ? "font-semibold text-foreground" : "text-muted-foreground";
    parameterNode.textContent = parameter;
    signatureNode.appendChild(parameterNode);
  });

  const closeNode = document.createElement("span");
  closeNode.className = "text-muted-foreground";
  closeNode.textContent = ")";
  signatureNode.appendChild(closeNode);
  dom.appendChild(signatureNode);

  return dom;
}

async function resolveSqlHoverTooltip(currentView: EditorViewType, pos: number) {
  if (!props.connectionId || !props.database) return null;

  const sql = currentView.state.doc.toString();
  const range = identifierRangeAt(sql, pos);
  if (!range) return null;

  const identifier = range.text;
  const parts = identifier.split(".");
  const name = parts[parts.length - 1] ?? identifier;
  const qualifier = parts.length > 1 ? parts[parts.length - 2] : undefined;

  try {
    if (cachedTables.length === 0) {
      cachedTables = await connectionStore.listCompletionTables(
        props.connectionId,
        props.database,
        name,
        MAX_COMPLETION_TABLES,
      );
    }

    let table = matchTable(identifier, cachedTables) ?? matchTable(name, cachedTables);
    if (!table) {
      const hoverTables = await connectionStore.listCompletionTables(
        props.connectionId,
        props.database,
        name,
        MAX_COMPLETION_TABLES,
      );
      cachedTables = [...cachedTables, ...hoverTables];
      table = matchTable(identifier, hoverTables) ?? matchTable(name, hoverTables);
    }
    if (table && (!qualifier || table.schema?.toLowerCase() === qualifier.toLowerCase() || table.name === name)) {
      return {
        pos: range.from,
        end: range.to,
        create: () => ({
          dom: createHoverDom(table.name, table.schema ? `table in ${table.schema}` : "table"),
        }),
      };
    }

    const context = getSqlCompletionContext(sql, pos);
    const candidates = qualifier
      ? context.referencedTables.filter(
          (rt) =>
            rt.alias?.toLowerCase() === qualifier.toLowerCase() || rt.name.toLowerCase() === qualifier.toLowerCase(),
        )
      : context.referencedTables;

    for (const refTable of candidates) {
      await ensureColumnsForTable(refTable);
      const columns = cachedColumnsByTable.get(completionCacheKey(refTable)) ?? [];
      const column = columns.find((col) => col.name.toLowerCase() === name.toLowerCase());
      if (!column) continue;
      return {
        pos: range.from,
        end: range.to,
        create: () => ({
          dom: createHoverDom(column.name, column.dataType || "column", [
            column.schema ? `${column.schema}.${column.table}` : column.table,
          ]),
        }),
      };
    }
  } catch {
    return null;
  }

  return null;
}

function sqlErrorDecorationRange(currentState: import("@codemirror/state").EditorState) {
  if (!props.executionError) return [];
  const location = parseSqlErrorLocation(props.executionError);
  if (!location) return [];
  const offset = lineColumnToOffset(currentState.doc.toString(), location);
  if (offset == null) return [];
  return [
    {
      from: offset,
      to: Math.min(offset + 1, currentState.doc.length),
      message: props.executionError,
    },
  ];
}

async function formatCurrentSql() {
  const currentView = view.value;
  if (!currentView) return;

  const selection = currentView.state.selection.main;
  const formatsSelection = !selection.empty;
  const from = formatsSelection ? selection.from : 0;
  const to = formatsSelection ? selection.to : currentView.state.doc.length;
  const source = currentView.state.sliceDoc(from, to);
  if (!source.trim()) return;

  try {
    const formatted = await formatSqlText(source, props.formatDialect ?? props.dialect ?? "generic");
    if (formatted === source) return;
    currentView.dispatch({
      changes: { from, to, insert: formatted },
      selection: formatsSelection
        ? { anchor: from, head: from + formatted.length }
        : { anchor: from + formatted.length },
    });
  } catch (e: any) {
    emit("formatError", String(e?.message || e));
  }
}

async function provideSqlCompletions(
  currentState: import("@codemirror/state").EditorState,
  position: number,
  explicit: boolean,
) {
  if (!props.connectionId || !props.database) return null;

  try {
    const fullDoc = currentState.doc.toString();
    if (!explicit && !shouldAutoOpenSqlCompletion(fullDoc, position)) return null;

    const completionContext = getSqlCompletionContext(fullDoc, position);
    const shouldLoadTables = completionContext.suggestTables || !!completionContext.qualifier;
    let tables = shouldLoadTables
      ? await connectionStore.listCompletionTables(
          props.connectionId,
          props.database,
          completionContext.qualifier || completionContext.prefix,
          MAX_COMPLETION_TABLES,
        )
      : cachedTables;

    // If qualifier didn't match any table names, try it as a schema name
    let qualifierIsSchema = false;
    if (completionContext.qualifier && completionContext.suggestTables && tables.length === 0) {
      const schemaTables = await connectionStore.listCompletionTables(
        props.connectionId,
        props.database,
        completionContext.prefix,
        MAX_COMPLETION_TABLES,
        completionContext.qualifier,
      );
      if (schemaTables.length > 0) {
        tables = schemaTables;
        qualifierIsSchema = true;
      }
    }

    // Collect referenced tables — enrich with schema from filtered table lookup
    let refs = completionContext.referencedTables.map((rt) => {
      // If no schema, look it up in the cached tables
      if (!rt.schema) {
        const cached = tables.find((t) => t.name.toLowerCase() === rt.name.toLowerCase());
        if (cached && cached.schema) {
          return { ...rt, schema: cached.schema };
        }
      }
      return rt;
    });
    const unresolvedRefs = refs.filter((rt) => !rt.schema);
    if (unresolvedRefs.length > 0) {
      const lookupGroups = await Promise.all(
        unresolvedRefs.map((rt) =>
          connectionStore.listCompletionTables(props.connectionId!, props.database!, rt.name, 20),
        ),
      );
      const lookupTables = lookupGroups.flat();
      refs = refs.map((rt) => {
        if (rt.schema) return rt;
        const matched = lookupTables.find((table) => table.name.toLowerCase() === rt.name.toLowerCase());
        return matched?.schema ? { ...rt, schema: matched.schema } : rt;
      });
    }

    // If no referenced tables but qualifier exists, infer table from tables list
    if (refs.length === 0 && completionContext.qualifier) {
      const q = completionContext.qualifier.toLowerCase();
      const matched = tables.filter((t) => t.name.toLowerCase() === q || t.name.toLowerCase().endsWith("." + q));
      refs = matched.map((t) => ({ name: t.name, schema: t.schema }));
    }

    await Promise.all(
      refs.map(async (refTable) => {
        const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;
        if (cachedColumnsByTable.has(cacheKey)) {
          return;
        }
        try {
          const columns = await connectionStore.listCompletionColumns(
            props.connectionId!,
            props.database!,
            refTable.name,
            refTable.schema,
          );
          cachedColumnsByTable.set(cacheKey, columns);
        } catch (e) {
          console.error(`[DBX] Failed to load columns for ${cacheKey}:`, e);
        }
      }),
    );

    // Build columnsByTable from persistent cache — only include columns for referenced tables
    const columnsByTable = new Map<string, SqlCompletionColumn[]>();
    for (const refTable of refs) {
      const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;
      const cached = cachedColumnsByTable.get(cacheKey);
      if (cached) {
        columnsByTable.set(cacheKey, cached);
      }
    }

    const effectiveContext = qualifierIsSchema
      ? { ...completionContext, qualifier: undefined, suggestTables: true, suggestColumns: false }
      : completionContext;

    const items = buildSqlCompletionItemsFromContext(effectiveContext, {
      tables,
      columnsByTable,
    });

    if (items.length === 0) return null;

    return {
      from: position - completionContext.prefix.length,
      options: items.map((item) =>
        item.type === "snippet" && item.apply
          ? codeMirrorSnippetCompletion(item.apply, {
              label: item.label,
              type: "snippet",
              detail: item.detail,
              boost: item.boost,
            })
          : {
              label: item.label,
              type: item.type,
              detail: item.detail,
              boost: item.boost,
            },
      ),
      validFor: /^[\w$]*$/,
    };
  } catch {
    return null;
  }
}

async function refreshCompletionCache() {
  cachedTables = [];
  cachedColumnsByTable.clear();
}

onMounted(async () => {
  if (!editorRef.value) return;

  const [
    { EditorView, keymap, rectangularSelection, hoverTooltip, showTooltip, Decoration },
    { EditorState, Compartment, Prec, StateField },
    { sql, MSSQL, MySQL, PostgreSQL, SQLDialect },
    { basicSetup },
    { autocompletion, startCompletion, closeBrackets, closeBracketsKeymap, snippetCompletion },
    { indentWithTab },
    { bracketMatching },
  ] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("@codemirror/lang-sql"),
    import("codemirror"),
    import("@codemirror/autocomplete"),
    import("@codemirror/commands"),
    import("@codemirror/language"),
  ]);
  editorViewModule = { EditorView, keymap, rectangularSelection } as typeof import("@codemirror/view");
  codeMirrorSnippetCompletion = snippetCompletion;
  fontThemeComp = new Compartment();
  codeMirrorTheme = new Compartment();
  wordWrapComp = new Compartment();
  readOnlyComp = new Compartment();
  runKeymapComp = new Compartment();
  diagnosticComp = new Compartment();

  const diagnosticTheme = EditorView.baseTheme({
    ".cm-sql-error": {
      textDecoration: "underline wavy var(--destructive)",
      textUnderlineOffset: "3px",
    },
  });

  buildSqlDiagnosticExtension = () => {
    const buildDecorations = (state: import("@codemirror/state").EditorState) =>
      Decoration.set(
        sqlErrorDecorationRange(state).map((range) =>
          Decoration.mark({
            class: "cm-sql-error",
            attributes: { title: range.message },
          }).range(range.from, range.to),
        ),
      );

    const field = StateField.define({
      create: buildDecorations,
      update(value, transaction) {
        return transaction.docChanged ? buildDecorations(transaction.state) : value;
      },
      provide: (field) => EditorView.decorations.from(field),
    });

    return [field, diagnosticTheme];
  };

  buildSqlSignatureExtension = () =>
    showTooltip.compute(["doc", "selection"], (currentState) => {
      const signature = getSqlFunctionSignatureHelp(currentState.doc.toString(), currentState.selection.main.head);
      if (!signature) return null;
      return {
        pos: currentState.selection.main.head,
        above: false,
        clip: false,
        create: () => ({ dom: createSignatureDom(signature) }),
      };
    });

  const ss = settingsStore.editorSettings;

  const baseDialect = props.dialect === "postgres" ? PostgreSQL : props.dialect === "sqlserver" ? MSSQL : MySQL;
  const extraKeywords =
    "PIVOT UNPIVOT EXCLUDE REPLACE QUALIFY ASOF POSITIONAL ANTI SEMI SAMPLE TABLESAMPLE STRUCT MAP LIST ARRAY LAMBDA UNNEST LATERAL FILTER RECURSIVE SUMMARIZE PRAGMA READ_CSV READ_PARQUET READ_JSON DESCRIBE SHOW COPY EXPORT IMPORT";
  const dialect = SQLDialect.define({
    ...baseDialect.spec,
    keywords: (baseDialect.spec.keywords || "") + " " + extraKeywords,
  });

  const theme = await loadEditorTheme(ss.theme);

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      cmSearch({
        top: true,
        createPanel: () => {
          const dom = document.createElement("span");
          dom.style.display = "none";
          return { dom };
        },
      }),
      basicSetup,
      sql({ dialect }),
      autocompletion({
        activateOnTyping: true,
        override: [
          async (context: CompletionContext) => provideSqlCompletions(context.state, context.pos, context.explicit),
        ],
      }),
      sqlCompletionTheme(EditorView),
      codeMirrorTheme.of(theme),
      closeBrackets(),
      bracketMatching(),
      hoverTooltip((currentView, pos) => resolveSqlHoverTooltip(currentView, pos)),
      buildSqlSignatureExtension(),
      diagnosticComp.of(buildSqlDiagnosticExtension()),
      Prec.highest(keymap.of([...closeBracketsKeymap, indentWithTab])),
      runKeymapComp.of(runKeymapExtension(keymap)),
      wordWrapComp.of(props.forceWordWrap || ss.wordWrap ? EditorView.lineWrapping : []),
      readOnlyComp.of([EditorState.readOnly.of(!!props.readOnly), EditorView.editable.of(!props.readOnly)]),
      rectangularSelection({ eventFilter: (e: MouseEvent) => e.altKey || e.button === 1 }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          emit("update:modelValue", update.state.doc.toString());
          let insertedText = "";
          update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
            insertedText += inserted.toString();
          });
          if (insertedText.endsWith(".")) {
            startCompletion(update.view);
          }
        }
        if (update.selectionSet || update.docChanged) {
          emit("selectionChange", selectedSqlFromView(update.view));
          emit("cursorChange", update.state.selection.main.head);
          if (searchVisible.value) updateMatchInfo();
        }
      }),
      fontThemeComp.of(
        editorFontTheme(EditorView, ss.fontSize, ss.fontFamily, {
          fixedHeight: true,
          scrollable: true,
        }),
      ),
      EditorView.domEventHandlers({
        wheel(event) {
          if (!event.metaKey && !event.ctrlKey) return false;
          event.preventDefault();
          if (event.deltaY < 0) zoomIn();
          else if (event.deltaY > 0) zoomOut();
          return true;
        },
        mousedown: (event: MouseEvent) => {
          // Click without modifier -> close column panel
          if (!event.metaKey && !event.ctrlKey) {
            if (event.button === 0) {
              emit("closeColumnPanel");
            }
            return false;
          }
          // Only handle Ctrl/Cmd + left click
          if (event.button !== 0) return false;

          const currentView = view.value;
          if (!currentView || !props.connectionId || !props.database) {
            return false;
          }

          // Use posAtCoords for accurate click position
          const coords = { x: event.clientX, y: event.clientY };
          const pos = currentView.posAtCoords(coords);
          if (pos == null) {
            return false;
          }

          const doc = currentView.state.doc.toString();
          const identifier = extractIdentifierAt(doc, pos);
          if (!identifier) {
            return false;
          }
          if (isSqlKeyword(identifier)) {
            return false;
          }

          // Prevent default, resolve async
          event.preventDefault();
          setTimeout(async () => {
            try {
              // Ensure table cache is populated
              if (cachedTables.length === 0) {
                cachedTables = await connectionStore.listCompletionTables(
                  props.connectionId!,
                  props.database!,
                  identifier,
                  MAX_COMPLETION_TABLES,
                );
              }

              // 1. Check if it's a table name
              const matchedTable = matchTable(identifier, cachedTables);
              if (matchedTable) {
                emit(
                  "clickTable",
                  matchedTable.schema ? `${matchedTable.schema}.${matchedTable.name}` : matchedTable.name,
                );
                return;
              }

              // 2. Parse SQL at click position to get referenced tables
              const context = getSqlCompletionContext(doc, pos);
              let referencedTables = context.referencedTables;
              // Enrich referenced tables with schema from cachedTables
              referencedTables = referencedTables.map((rt) => {
                const cached = cachedTables.find((ct) => ct.name.toLowerCase() === rt.name.toLowerCase());
                if (cached && cached.schema && !rt.schema) {
                  return { ...rt, schema: cached.schema };
                }
                return rt;
              });

              // Check if identifier has a qualifier (e.g., c.card_name)
              const qualifierMatch = /^(.+)\.(.+)$/.exec(identifier);
              const qualifier = qualifierMatch ? qualifierMatch[1] : null;
              const colName = qualifierMatch ? qualifierMatch[2] : identifier;
              const colLower = colName.toLowerCase();

              if (referencedTables.length === 0) {
                return;
              }
              // 3. Fetch columns — if qualifier, only check matching table; otherwise check all
              const tablesToCheck = qualifier
                ? referencedTables.filter(
                    (rt) =>
                      rt.alias?.toLowerCase() === qualifier.toLowerCase() ||
                      rt.name.toLowerCase() === qualifier.toLowerCase(),
                  )
                : referencedTables;

              if (tablesToCheck.length === 0 && qualifier) {
                return;
              }

              const matchedCols: Array<{ name: string; table: string; schema?: string }> = [];

              for (const refTable of tablesToCheck) {
                const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;

                // Use persistent column cache; fetch only if missing
                let cols = cachedColumnsByTable.get(cacheKey);
                if (!cols) {
                  try {
                    cols = await connectionStore.listCompletionColumns(
                      props.connectionId!,
                      props.database!,
                      refTable.name,
                      refTable.schema,
                    );
                    cachedColumnsByTable.set(cacheKey, cols);
                  } catch {
                    continue;
                  }
                }
                for (const col of cols) {
                  if (col.name.toLowerCase() === colLower) {
                    matchedCols.push({
                      name: col.name,
                      table: refTable.name,
                      schema: col.schema || refTable.schema,
                    });
                  }
                }
              }

              if (matchedCols.length > 0) {
                emit("clickColumn", matchedCols);
              }
            } catch (e) {
              console.error("[DBX] Ctrl+click error:", e);
            }
          }, 0);
          return true;
        },
      }),
    ],
  });

  view.value = new EditorView({ state, parent: editorRef.value });

  cachedTables = [];
});

watch(
  () => props.modelValue,
  (val) => {
    if (view.value && val !== view.value.state.doc.toString()) {
      view.value.dispatch({
        changes: { from: 0, to: view.value.state.doc.length, insert: val },
      });
    }
  },
);

watch(
  () => props.formatRequestId,
  (val, oldVal) => {
    if (val && val !== oldVal) formatCurrentSql();
  },
);

watch(
  () => props.executionError,
  () => {
    if (!view.value || !diagnosticComp || !buildSqlDiagnosticExtension) return;
    view.value.dispatch({
      effects: diagnosticComp.reconfigure(buildSqlDiagnosticExtension()),
    });
  },
);

watch(
  () => props.connectionId,
  () => {
    refreshCompletionCache();
  },
);

watch(
  () => props.database,
  () => {
    refreshCompletionCache();
  },
);

watch(
  () => props.forceWordWrap,
  () => {
    if (!view.value || !wordWrapComp) return;
    view.value.dispatch({
      effects: wordWrapComp.reconfigure(wordWrapExtension()),
    });
  },
);

// Reactively apply editor settings changes
watch(
  () => settingsStore.editorSettings,
  async (ss) => {
    if (!view.value || !codeMirrorTheme || !fontThemeComp || !wordWrapComp || !runKeymapComp || !editorViewModule) {
      return;
    }
    const themeExt = await loadEditorTheme(ss.theme);
    view.value.dispatch({
      effects: [
        codeMirrorTheme.reconfigure(themeExt),
        wordWrapComp.reconfigure(props.forceWordWrap || ss.wordWrap ? editorViewModule.EditorView.lineWrapping : []),
        runKeymapComp.reconfigure(runKeymapExtension(editorViewModule.keymap)),
        fontThemeComp.reconfigure(
          editorFontTheme(editorViewModule.EditorView, ss.fontSize, ss.fontFamily, {
            fixedHeight: true,
            scrollable: true,
          }),
        ),
      ],
    });
  },
  { deep: true },
);

onBeforeUnmount(() => {
  view.value?.destroy();
});

function dispatchSearchQuery() {
  const v = view.value;
  if (!v) return;
  const q = new SearchQuery({
    search: searchText.value,
    caseSensitive: caseSensitive.value,
    regexp: useRegex.value,
    replace: replaceText.value,
  });
  v.dispatch({ effects: setSearchQuery.of(q) });
  updateMatchInfo();
}

function updateMatchInfo() {
  const v = view.value;
  if (!v || !searchText.value) {
    matchCount.value = 0;
    currentMatchIndex.value = 0;
    return;
  }
  try {
    const q = new SearchQuery({
      search: searchText.value,
      caseSensitive: caseSensitive.value,
      regexp: useRegex.value,
    });
    if (!q.valid) {
      matchCount.value = 0;
      currentMatchIndex.value = 0;
      return;
    }
    const iter = q.getCursor(v.state);
    let count = 0;
    let curIdx = 0;
    const selFrom = v.state.selection.main.from;
    const selTo = v.state.selection.main.to;
    let r = iter.next();
    while (!r.done) {
      count++;
      if (r.value.from === selFrom && r.value.to === selTo) curIdx = count;
      r = iter.next();
    }
    matchCount.value = count;
    currentMatchIndex.value = curIdx || (count > 0 ? 1 : 0);
  } catch {
    matchCount.value = 0;
    currentMatchIndex.value = 0;
  }
}

function openSearch(): boolean {
  searchVisible.value = true;
  const v = view.value;
  if (v) {
    const sel = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
    if (sel && !sel.includes("\n")) searchText.value = sel;
  }
  nextTick(() => {
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
  });
  if (searchText.value) dispatchSearchQuery();
  return true;
}

function closeSearch() {
  searchVisible.value = false;
  showReplace.value = false;
  const v = view.value;
  if (v) {
    v.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
    v.focus();
  }
  matchCount.value = 0;
  currentMatchIndex.value = 0;
}

function nextMatch() {
  const v = view.value;
  if (!v || !searchText.value) return;
  cmFindNext(v);
  updateMatchInfo();
}

function prevMatch() {
  const v = view.value;
  if (!v || !searchText.value) return;
  cmFindPrevious(v);
  updateMatchInfo();
}

function doReplace() {
  const v = view.value;
  if (!v || !searchText.value) return;
  cmReplaceNext(v);
  updateMatchInfo();
}

function doReplaceAll() {
  const v = view.value;
  if (!v || !searchText.value) return;
  cmReplaceAll(v);
  updateMatchInfo();
}

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  } else if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    nextMatch();
  } else if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    prevMatch();
  }
}

watch([searchText, caseSensitive, useRegex, replaceText], () => {
  if (searchVisible.value) dispatchSearchQuery();
});

defineExpose({ openSearch });
</script>

<template>
  <div class="h-full w-full overflow-hidden relative">
    <div ref="editorRef" data-query-editor-root class="h-full w-full overflow-hidden" />
    <Transition
      enter-active-class="transition-all duration-150"
      leave-active-class="transition-all duration-100"
      enter-from-class="opacity-0 -translate-y-1"
      leave-to-class="opacity-0 -translate-y-1"
    >
      <div
        v-if="searchVisible"
        class="absolute top-1 right-4 z-20 bg-background border rounded-md shadow-md p-1.5 flex flex-col gap-1"
      >
        <div class="flex items-center gap-0.5">
          <input
            ref="searchInputRef"
            v-model="searchText"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="w-48 h-6 text-xs bg-input border rounded px-2 outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            placeholder="查找"
            @keydown="onSearchKeydown"
          />
          <button
            class="w-6 h-6 flex items-center justify-center rounded text-xs font-mono hover:bg-accent"
            :class="caseSensitive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'"
            title="区分大小写"
            @click="caseSensitive = !caseSensitive"
          >
            Aa
          </button>
          <button
            class="w-6 h-6 flex items-center justify-center rounded text-xs font-mono hover:bg-accent"
            :class="useRegex ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'"
            title="正则表达式"
            @click="useRegex = !useRegex"
          >
            .*
          </button>
          <span v-if="searchText" class="text-xs text-muted-foreground min-w-[3rem] text-center shrink-0">
            {{ matchCount > 0 ? `${currentMatchIndex}/${matchCount}` : "无结果" }}
          </span>
          <button
            class="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title="上一个 (Shift+Enter)"
            @click="prevMatch"
          >
            <ChevronUp class="w-3.5 h-3.5" />
          </button>
          <button
            class="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title="下一个 (Enter)"
            @click="nextMatch"
          >
            <ChevronDown class="w-3.5 h-3.5" />
          </button>
          <button
            class="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            :title="showReplace ? '收起替换' : '展开替换'"
            @click="showReplace = !showReplace"
          >
            <ChevronRight class="w-3 h-3 transition-transform" :class="showReplace && 'rotate-90'" />
          </button>
          <button
            class="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            title="关闭 (Esc)"
            @click="closeSearch"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
        <div v-if="showReplace" class="flex items-center gap-0.5">
          <input
            v-model="replaceText"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="w-48 h-6 text-xs bg-input border rounded px-2 outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
            placeholder="替换"
            @keydown.enter.prevent="doReplace"
          />
          <button
            class="h-6 px-1.5 flex items-center justify-center rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground border"
            title="替换"
            @click="doReplace"
          >
            替换
          </button>
          <button
            class="h-6 px-1.5 flex items-center justify-center rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground border"
            title="全部替换"
            @click="doReplaceAll"
          >
            全部
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
