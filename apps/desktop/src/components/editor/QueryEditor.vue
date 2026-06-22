<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, shallowRef, computed, nextTick } from "vue";
import { Play, Copy, Table2, TextSelect } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { CompletionContext } from "@codemirror/autocomplete";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { search as cmSearch } from "@codemirror/search";
import EditorSearchPanel from "./EditorSearchPanel.vue";
import SqlExecutionTargetPicker from "./SqlExecutionTargetPicker.vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { copyToClipboard } from "@/lib/clipboard";
import { resolveExecutableSql, type SqlExecutionSnapshot, type SqlExecutionOverride, type SqlExecutionCandidate } from "@/lib/sqlExecutionTarget";
import { buildExecutionCandidates, hasMultipleExecutionTargets, supportsExecutionTargetPicker } from "@/lib/sqlStatementRanges";
import { formatSqlText, type SqlFormatDialect } from "@/lib/sqlFormatter";
import { formatMongoShellText } from "@/lib/mongoFormatter";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import { buildSqlCompletionItemsFromContext, getSqlFunctionSignatureHelp, getSqlCompletionContext, getSqlCompletionResultValidFor, isSqlLikeCompletionStatement, recordCompletionSelection, shouldAutoOpenSqlCompletion, extractCteDefinitions } from "@/lib/sqlCompletion";
import { buildElasticsearchCompletionItemsFromContext, getElasticsearchCompletionContext, getElasticsearchCompletionResultValidFor, shouldAutoOpenElasticsearchCompletion, type ElasticsearchCompletionItem } from "@/lib/elasticsearchCompletion";
import { buildMongoCompletionItemsFromContext, getMongoCompletionContext, getMongoCompletionResultValidFor, shouldAutoOpenMongoCompletion, type MongoCompletionItem } from "@/lib/mongoCompletion";
import { extractIdentifierAt, isSqlKeyword, matchTable } from "@/lib/sqlNavigation";
import { lineColumnToOffset, parseSqlErrorLocation } from "@/lib/sqlDiagnostics";
import {
  DBX_TABLE_REFERENCE_MIME,
  DBX_TABLE_REFERENCE_DROP_EVENT,
  activeTableReferencePayloadValue,
  clearActiveTableReferencePayload,
  hasTableReferencePayloadType,
  parseTableReferencePayload,
  tableReferenceInsertText,
  type QueryEditorTableReferenceDropDetail,
  type QueryEditorTableReferencePayload,
} from "@/lib/queryEditorTableDrop";
import { EDITOR_FONT_FAMILY_CSS_VAR, EDITOR_FONT_SIZE_CSS_VAR, loadEditorTheme, editorFontTheme, sqlCompletionTheme } from "@/lib/editorThemes";
import { clampEditorFontSize, createEditorZoomCommitScheduler, fontSizeFromGestureScale, fontSizeFromWheelDelta } from "@/lib/editorZoom";
import { normalizeShortcutSettings, shortcutToCodeMirrorKey } from "@/lib/shortcutRegistry";
import { trimmedSelectionLayer } from "@/lib/codemirrorTrimmedSelectionLayer";
import { selectionMatchOccurrences } from "@/lib/codemirrorSelectionMatches";
import { isSchemaAware, isSingleDatabase } from "@/lib/databaseFeatureSupport";
import { qualifiedTableNameAtSqlPosition } from "@/lib/queryCursorTableTarget";
import * as api from "@/lib/api";
import { areSqlSemanticDiagnosticsEqual, buildSqlParserErrorDiagnostic, buildSqlSemanticDiagnostics, shouldRunSqlSemanticDiagnostics, type SqlSemanticDiagnostic } from "@/lib/sqlSemanticDiagnostics";
import { buildRedisSyntaxDiagnostics, shouldRunRedisDiagnostics } from "@/lib/redisSyntaxDiagnostics";
import { buildRedisCompletionItemsFromContext, getRedisCompletionContext, getRedisCompletionResultValidFor, shouldAutoOpenRedisCompletion, takesKeyArgument, type RedisCompletionItem } from "@/lib/redisCompletion";
import type { SqlCompletionColumn, SqlCompletionForeignKey, SqlCompletionItem, SqlCompletionObject } from "@/lib/sqlCompletion";
import type { DatabaseType, SqlReferenceAnalysis, SqlTableReference, SqlTextSpan } from "@/types/database";

const props = defineProps<{
  modelValue: string;
  connectionId?: string;
  database?: string;
  schema?: string;
  databaseType?: DatabaseType;
  dialect?: "mysql" | "postgres" | "sqlserver";
  formatDialect?: SqlFormatDialect;
  formatRequestId?: number;
  executionError?: string;
  readOnly?: boolean;
  forceWordWrap?: boolean;
  initialViewport?: { scrollTop: number; scrollLeft: number };
  initialSelection?: { anchor: number; head: number };
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  selectionChange: [value: string];
  cursorChange: [pos: number];
  formatError: [message: string];
  execute: [source: SqlExecutionOverride];
  save: [];
  clickTable: [tableName: string];
  viewTableData: [tableName: string];
  clickColumn: [columns: Array<{ name: string; table: string; schema?: string }>, error?: string | undefined];
  closeColumnPanel: [];
  viewportChange: [viewport: { scrollTop: number; scrollLeft: number }];
  selectionStateChange: [selection: { anchor: number; head: number }];
}>();

const editorRef = ref<HTMLDivElement>();
const view = shallowRef<EditorViewType | null>(null);
let viewportEmitFrame: number | null = null;
let viewportRestoreFrame: number | null = null;
let latestViewport: { scrollTop: number; scrollLeft: number } | undefined = props.initialViewport;
let latestSelection: { anchor: number; head: number } | undefined = props.initialSelection;
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();
const { isDark } = useTheme();
const { t } = useI18n();
const { toast } = useToast();

const SQL_FUNCTION_NAMES = [
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "GROUP_CONCAT",
  "STRING_AGG",
  "CONCAT",
  "CONCAT_WS",
  "SUBSTRING",
  "REPLACE",
  "TRIM",
  "UPPER",
  "LOWER",
  "LENGTH",
  "REGEXP_REPLACE",
  "DATE_FORMAT",
  "DATEDIFF",
  "DATE_ADD",
  "DATE_SUB",
  "EXTRACT",
  "NOW",
  "ROUND",
  "FLOOR",
  "CEIL",
  "ABS",
  "MOD",
  "COALESCE",
  "IFNULL",
  "NULLIF",
  "CAST",
  "JSON_EXTRACT",
  "JSON_VALUE",
  "JSON_OBJECT",
  "JSON_ARRAY",
] as const;

const completionTranslations = computed(() => ({
  nullValue: t("editor.completion.nullValue"),
  isNull: t("editor.completion.isNull"),
  isNotNull: t("editor.completion.isNotNull"),
  stringLiteral: t("editor.completion.stringLiteral"),
  numericLiteral: t("editor.completion.numericLiteral"),
  booleanValue: t("editor.completion.booleanValue"),
  starExpansionColumns: t("editor.completion.starExpansionColumns"),
  functionDescriptions: Object.fromEntries(SQL_FUNCTION_NAMES.map((name) => [name, t(`editor.completion.functionDescriptions.${name}`)])) as Record<string, string>,
}));
const MAX_COMPLETION_TABLES = 200;
const MAX_JOIN_FK_PREFETCH_TABLES = 24;
const liveFontSize = ref(settingsStore.editorSettings.fontSize);
const gestureStartFontSize = ref(settingsStore.editorSettings.fontSize);
const isGestureZooming = ref(false);

const searchPanelRef = ref<InstanceType<typeof EditorSearchPanel>>();
const selectedSql = ref("");
const executableSql = ref("");
const contextTableName = ref<string | null>(null);

const hasSelectedSql = computed(() => selectedSql.value.trim().length > 0);
const canCopySelectedSql = computed(() => selectedSql.value.length > 0);
const canExecuteContextSql = computed(() => executableSql.value.trim().length > 0);

// Execution target picker state
const pickerVisible = ref(false);
const pickerCandidates = ref<SqlExecutionCandidate[]>([]);
const pickerActiveIndex = ref(0);
const pickerAnchor = ref<{ left: number; top: number }>();

const executeContextMenuLabel = computed(() => t(hasSelectedSql.value ? "editor.contextMenu.executeSelection" : "editor.contextMenu.executeCurrent"));

interface EditorGestureEvent extends Event {
  scale?: number;
}

let editorViewModule: typeof import("@codemirror/view") | null = null;
let codeMirrorPrec: typeof import("@codemirror/state").Prec | null = null;
let fontThemeComp: import("@codemirror/state").Compartment | null = null;
let codeMirrorTheme: import("@codemirror/state").Compartment | null = null;
let wordWrapComp: import("@codemirror/state").Compartment | null = null;
let readOnlyComp: import("@codemirror/state").Compartment | null = null;
let runKeymapComp: import("@codemirror/state").Compartment | null = null;
let completionComp: import("@codemirror/state").Compartment | null = null;
let diagnosticComp: import("@codemirror/state").Compartment | null = null;
let buildSqlDiagnosticExtension: (() => import("@codemirror/state").Extension) | null = null;
let buildSqlSignatureExtension: (() => import("@codemirror/state").Extension) | null = null;
let buildSqlCompletionExtension: (() => import("@codemirror/state").Extension) | null = null;
let codeMirrorSnippetCompletion: typeof import("@codemirror/autocomplete").snippetCompletion;
let codeMirrorCompletionStatus: typeof import("@codemirror/autocomplete").completionStatus | null = null;
let codeMirrorAcceptCompletion: typeof import("@codemirror/autocomplete").acceptCompletion | null = null;
let codeMirrorStartCompletion: typeof import("@codemirror/autocomplete").startCompletion | null = null;
let codeMirrorIndentMore: typeof import("@codemirror/commands").indentMore | null = null;
let codeMirrorIndentLess: typeof import("@codemirror/commands").indentLess | null = null;
let codeMirrorCopyLineDown: typeof import("@codemirror/commands").copyLineDown | null = null;
let codeMirrorCopyLineUp: typeof import("@codemirror/commands").copyLineUp | null = null;
let codeMirrorDeleteLine: typeof import("@codemirror/commands").deleteLine | null = null;
let codeMirrorMoveLineUp: typeof import("@codemirror/commands").moveLineUp | null = null;
let codeMirrorMoveLineDown: typeof import("@codemirror/commands").moveLineDown | null = null;
let codeMirrorUndo: typeof import("@codemirror/commands").undo | null = null;
let codeMirrorRedo: typeof import("@codemirror/commands").redo | null = null;
let codeMirrorSelectAll: typeof import("@codemirror/commands").selectAll | null = null;
let codeMirrorInsertNewlineKeepIndent: typeof import("@codemirror/commands").insertNewlineKeepIndent | null = null;
let setSqlDiagnosticsEffect: import("@codemirror/state").StateEffectType<SqlSemanticDiagnostic[]> | null = null;
let setPreviewRangeEffect: import("@codemirror/state").StateEffectType<{ from: number; to: number } | null> | null = null;
let previewRangeComp: import("@codemirror/state").Compartment | null = null;
let buildPreviewRangeExtension: (() => import("@codemirror/state").Extension) | null = null;
let semanticDiagnostics: SqlSemanticDiagnostic[] = [];
let semanticDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
let semanticDiagnosticRunId = 0;
let editorIsActive = true;
let tableReferenceDropListenerRegistered = false;
let imeCompositionActive = false;
let pendingImeModelEmit = false;
const tableNavigationHoverClass = "query-editor--table-navigation-hover";

function editorThemeAppearance() {
  return isDark.value ? "dark" : "light";
}

// Completion cache
let cachedTables: Array<{ name: string; schema?: string; type?: "table" | "view" }> = [];
let cachedCompletionObjects: SqlCompletionObject[] = [];
// Persistent column cache keyed by "schema.table" or "table"
const cachedColumnsByTable = new Map<string, SqlCompletionColumn[]>();
const cachedForeignKeysByTable = new Map<string, SqlCompletionForeignKey[]>();

const zoomCommitScheduler = createEditorZoomCommitScheduler((fontSize) => {
  if (settingsStore.editorSettings.fontSize === fontSize) return;
  settingsStore.updateEditorSettings({ fontSize });
});

function syncEditorFontCssVars(fontSize = liveFontSize.value, fontFamily = settingsStore.editorSettings.fontFamily) {
  if (!editorRef.value) return;
  editorRef.value.style.setProperty(EDITOR_FONT_SIZE_CSS_VAR, `${clampEditorFontSize(fontSize)}px`);
  editorRef.value.style.setProperty(EDITOR_FONT_FAMILY_CSS_VAR, fontFamily);
}

let pendingFontReconfig: { size: number; family: string } | null = null;
let fontReconfigScheduled = false;

function reconfigureFontTheme(size: number, family: string) {
  if (!fontThemeComp || !editorViewModule || !view.value) return;
  view.value.dispatch({
    effects: fontThemeComp.reconfigure(
      editorFontTheme(editorViewModule.EditorView, size, family, {
        fixedHeight: true,
        scrollable: true,
      }),
    ),
  });
}

function scheduleFontThemeReconfig(size: number, family: string) {
  pendingFontReconfig = { size, family };
  if (fontReconfigScheduled) return;
  fontReconfigScheduled = true;
  requestAnimationFrame(() => {
    fontReconfigScheduled = false;
    const p = pendingFontReconfig;
    if (p) {
      pendingFontReconfig = null;
      reconfigureFontTheme(p.size, p.family);
    }
  });
}

function applyLiveFontSize(size: number) {
  const next = clampEditorFontSize(size);
  if (liveFontSize.value === next) return;
  liveFontSize.value = next;
  syncEditorFontCssVars(next);
  // Throttle compartment reconfiguration to at most once per animation
  // frame so that CSS variable changes remain smooth on every wheel tick,
  // while the CodeMirror measure → syncGutters path keeps gutters aligned.
  scheduleFontThemeReconfig(next, settingsStore.editorSettings.fontFamily);
}

function scheduleFontSizeCommit(size: number) {
  zoomCommitScheduler.schedule(size);
}

function onEditorGestureStart(event: EditorGestureEvent) {
  event.preventDefault();
  isGestureZooming.value = true;
  gestureStartFontSize.value = liveFontSize.value;
}

function onEditorGestureChange(event: EditorGestureEvent) {
  if (typeof event.scale !== "number") return;
  event.preventDefault();
  applyLiveFontSize(fontSizeFromGestureScale(gestureStartFontSize.value, event.scale));
}

function onEditorGestureEnd(event: Event) {
  event.preventDefault();
  isGestureZooming.value = false;
  zoomCommitScheduler.flush(liveFontSize.value);
}

function handleTab(view: EditorViewType): boolean {
  if (codeMirrorCompletionStatus?.(view.state) === "active") return false;
  const { state, dispatch } = view;
  const sel = state.selection.main;
  if (!sel.empty) return codeMirrorIndentMore?.(view) ?? false;
  const line = state.doc.lineAt(sel.from);
  const before = line.text.slice(0, sel.from - line.from);
  if (/^\s*$/.test(before)) return codeMirrorIndentMore?.(view) ?? false;
  dispatch(state.update(state.replaceSelection("  "), { userEvent: "input.type" }));
  return true;
}

function requestExecute() {
  const currentView = view.value;
  if (!currentView) return false;
  const selection = currentView.state.selection.main;
  if (!selection.empty) {
    // Has manual selection → execute directly, skip picker.
    emit("execute", sqlExecutionSnapshotFromView(currentView));
    return true;
  }
  if (!supportsExecutionTargetPicker(props.databaseType)) {
    emit("execute", sqlExecutionSnapshotFromView(currentView));
    return true;
  }
  // No selection → show the execution target picker.
  const doc = currentView.state.doc.toString();
  const cursorPos = selection.head;
  const candidates = buildExecutionCandidates(doc, cursorPos, props.databaseType);
  if (candidates.length === 0) return false;
  if (!settingsStore.editorSettings.showExecutionTargetPicker || !hasMultipleExecutionTargets(doc, props.databaseType)) {
    const preferredKind = settingsStore.editorSettings.executeMode === "current" ? "cursor" : "all";
    const candidate = candidates.find((item) => item.kind === preferredKind) ?? candidates[0];
    emit("execute", candidate.sql);
    return true;
  }
  closePicker();
  pickerCandidates.value = candidates;
  pickerActiveIndex.value = 0;
  pickerAnchor.value = executionPickerAnchor(currentView, cursorPos, candidates.length);
  pickerVisible.value = true;
  setPreviewRange({ from: candidates[0].from, to: candidates[0].to });
  return true;
}

function executionPickerAnchor(currentView: EditorViewType, cursorPos: number, candidateCount: number): { left: number; top: number } | undefined {
  const cursorRect = currentView.coordsAtPos(cursorPos);
  const rootRect = editorRef.value?.getBoundingClientRect();
  if (!cursorRect || !rootRect) return undefined;

  const verticalGap = 8;
  const pickerHeight = 40 + Math.max(1, candidateCount) * 36;
  const verticalMargin = 12;
  const left = rootRect.width / 2;
  const cursorBottom = cursorRect.bottom - rootRect.top;
  const maxTop = Math.max(verticalMargin, rootRect.height - pickerHeight - verticalMargin);
  const top = Math.min(cursorBottom + verticalGap, maxTop);

  return { left, top };
}

function setPreviewRange(range: { from: number; to: number } | null) {
  if (!view.value || !setPreviewRangeEffect) return;
  view.value.dispatch({
    effects: setPreviewRangeEffect.of(range),
  });
}

function onPickerActiveIndexChange(index: number) {
  pickerActiveIndex.value = index;
  const candidate = pickerCandidates.value[index];
  if (candidate) {
    setPreviewRange({ from: candidate.from, to: candidate.to });
  }
}

function onPickerConfirm(candidate: SqlExecutionCandidate) {
  closePicker();
  emit("execute", candidate.sql);
}

function closePicker() {
  pickerVisible.value = false;
  pickerAnchor.value = undefined;
  setPreviewRange(null);
  // Restore focus to the CodeMirror editor.
  view.value?.focus();
}

function syncContextMenuState(currentView: EditorViewType) {
  selectedSql.value = selectedSqlFromView(currentView);
  executableSql.value = executableSqlFromView(currentView);
}

function syncContextMenuStateAtEvent(currentView: EditorViewType, event: MouseEvent) {
  syncContextMenuState(currentView);
  const pos = currentView.posAtCoords({ x: event.clientX, y: event.clientY });
  contextTableName.value = pos == null ? null : qualifiedTableNameAtSqlPosition(currentView.state.doc.toString(), pos);
}

function focusEditor() {
  view.value?.focus();
}

function clearTableNavigationHover() {
  editorRef.value?.classList.remove(tableNavigationHoverClass);
}

function tableNavigationIdentifierAt(currentView: EditorViewType, event: MouseEvent): string | null {
  if (!props.connectionId || props.database == null) return null;
  const pos = currentView.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return null;
  const identifier = extractIdentifierAt(currentView.state.doc.toString(), pos);
  if (!identifier || isSqlKeyword(identifier)) return null;
  return identifier;
}

function updateTableNavigationHover(currentView: EditorViewType, event: MouseEvent) {
  if (!event.metaKey && !event.ctrlKey) {
    clearTableNavigationHover();
    return false;
  }
  const identifier = tableNavigationIdentifierAt(currentView, event);
  editorRef.value?.classList.toggle(tableNavigationHoverClass, !!identifier);
  return !!identifier;
}

function clearTableNavigationHoverOnModifierRelease(event: KeyboardEvent) {
  if (!event.metaKey && !event.ctrlKey) clearTableNavigationHover();
}

function executeFromContextMenu() {
  if (!canExecuteContextSql.value) return;
  requestExecute();
  focusEditor();
}

async function copySelectedSqlFromContextMenu() {
  if (!canCopySelectedSql.value) return;
  try {
    await copyToClipboard(selectedSql.value);
    toast(t("grid.copied"));
    focusEditor();
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function selectAllSqlFromContextMenu() {
  const currentView = view.value;
  if (!currentView) return;
  currentView.dispatch({
    selection: { anchor: 0, head: currentView.state.doc.length },
    scrollIntoView: true,
  });
  focusEditor();
}

function openTableFromContextMenu() {
  if (!contextTableName.value) return;
  emit("viewTableData", contextTableName.value);
  focusEditor();
}

function selectSqlLineFromGutter(currentView: EditorViewType, line: { from: number; to: number }, event: Event): boolean {
  if (!(event instanceof MouseEvent) || event.button !== 0) return false;
  event.preventDefault();
  currentView.dispatch({
    selection: { anchor: line.from, head: line.to },
    scrollIntoView: true,
    userEvent: "select.pointer",
  });
  currentView.focus();
  return true;
}

const contextMenuItems = computed<ContextMenuItem[]>(() => [
  {
    label: executeContextMenuLabel.value,
    action: executeFromContextMenu,
    disabled: !canExecuteContextSql.value,
    icon: Play,
  },
  {
    label: t("contextMenu.viewData"),
    action: openTableFromContextMenu,
    disabled: !contextTableName.value,
    icon: Table2,
  },
  { label: "", separator: true },
  {
    label: t("editor.contextMenu.copySelection"),
    action: copySelectedSqlFromContextMenu,
    disabled: !canCopySelectedSql.value,
    icon: Copy,
  },
  { label: t("editor.contextMenu.selectAll"), action: selectAllSqlFromContextMenu, icon: TextSelect },
]);

function runKeymapExtension(codeMirrorKeymap: (typeof import("@codemirror/view"))["keymap"]) {
  const shortcuts = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);
  const Prec = codeMirrorPrec;
  const binding = (shortcut: string, run: (view: EditorViewType) => boolean) => (shortcut ? [{ key: shortcutToCodeMirrorKey(shortcut), preventDefault: true, run }] : []);
  return [
    Prec?.high(
      codeMirrorKeymap.of([
        {
          key: "Enter",
          run: codeMirrorInsertNewlineKeepIndent ?? undefined,
          shift: codeMirrorInsertNewlineKeepIndent ?? undefined,
        },
        ...binding(shortcuts.find, openSearch),
        ...binding(shortcuts.replace, openReplace),
        ...binding(shortcuts.executeSql, requestExecute),
        ...binding(shortcuts.saveSql, () => {
          emit("save");
          return true;
        }),
        ...binding(shortcuts.formatSql, () => {
          void formatCurrentSql();
          return true;
        }),
        ...binding(shortcuts.indentMore, (view) => codeMirrorIndentMore?.(view) ?? false),
        ...binding(shortcuts.indentLess, (view) => codeMirrorIndentLess?.(view) ?? false),
        ...binding(shortcuts.duplicateLine, (view) => codeMirrorCopyLineDown?.(view) ?? false),
        ...binding(shortcuts.deleteLine, (view) => codeMirrorDeleteLine?.(view) ?? false),
        ...binding(shortcuts.moveLineUp, (view) => codeMirrorMoveLineUp?.(view) ?? false),
        ...binding(shortcuts.moveLineDown, (view) => codeMirrorMoveLineDown?.(view) ?? false),
        ...binding(shortcuts.copyLineUp, (view) => codeMirrorCopyLineUp?.(view) ?? false),
        ...binding(shortcuts.copyLineDown, (view) => codeMirrorCopyLineDown?.(view) ?? false),
        ...binding(shortcuts.undo, (view) => codeMirrorUndo?.(view) ?? false),
        ...binding(shortcuts.redo, (view) => codeMirrorRedo?.(view) ?? false),
        ...binding(shortcuts.selectAll, (view) => codeMirrorSelectAll?.(view) ?? false),
      ]),
    ) ?? [],
    codeMirrorKeymap.of(
      binding(shortcuts.acceptCompletion, (view) => codeMirrorAcceptCompletion?.(view) ?? false).map((item) => ({
        ...item,
        preventDefault: false,
      })),
    ),
  ];
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

function sqlExecutionSnapshotFromView(currentView: EditorViewType): SqlExecutionSnapshot {
  return {
    fullSql: currentView.state.doc.toString(),
    selectedSql: selectedSqlFromView(currentView),
    cursorPos: currentView.state.selection.main.head,
  };
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

function completionCacheKey(table: { name: string; schema?: string | null }) {
  const schema = table.schema ?? props.schema;
  return schema ? `${schema}.${table.name}` : table.name;
}

function supportsDatabaseQualifierCompletion(): boolean {
  return !!props.databaseType && !isSchemaAware(props.databaseType) && !isSingleDatabase(props.databaseType);
}

function completionMetadataTarget(table: { name: string; schema?: string | null }): { database: string; schema?: string } | null {
  if (props.database == null) return null;
  if (supportsDatabaseQualifierCompletion() && table.schema) {
    return { database: table.schema };
  }
  return { database: props.database, schema: table.schema ?? props.schema };
}

function completionQualifiedTableTarget(completionContext: ReturnType<typeof getSqlCompletionContext>): { name: string; schema: string } | null {
  if (!completionContext.suggestColumns) return null;
  const parts = completionContext.qualifierParts ?? completionContext.qualifier?.split(".").filter(Boolean) ?? [];
  if (parts.length < 2) return null;
  const name = parts[parts.length - 1];
  const schema = parts[parts.length - 2];
  if (!name || !schema) return null;
  return { name, schema };
}

function completionTablesMatch(left: { name: string; schema?: string | null }, right: { name: string; schema?: string | null }) {
  if (left.name.toLowerCase() !== right.name.toLowerCase()) return false;
  if (!left.schema || !right.schema) return true;
  return left.schema.toLowerCase() === right.schema.toLowerCase();
}

async function ensureColumnsForTable(table: { name: string; schema?: string | null }) {
  const cacheKey = completionCacheKey(table);
  if (cachedColumnsByTable.has(cacheKey) || !props.connectionId || props.database == null) return;
  const target = completionMetadataTarget(table);
  if (!target) return;
  const columns = await connectionStore.listCompletionColumns(props.connectionId, target.database, table.name, target.schema);
  if (columns.length === 0) return;
  cachedColumnsByTable.set(cacheKey, columns);
}

async function ensureForeignKeysForTable(table: { name: string; schema?: string | null }) {
  const cacheKey = completionCacheKey(table);
  if (cachedForeignKeysByTable.has(cacheKey) || !props.connectionId || props.database == null) return;
  const target = completionMetadataTarget(table);
  if (!target) return;
  try {
    const foreignKeys = await connectionStore.listCompletionForeignKeys(props.connectionId, target.database, table.name, target.schema);
    cachedForeignKeysByTable.set(cacheKey, foreignKeys);
  } catch (e) {
    console.warn(`[DBX] Failed to load foreign keys for ${cacheKey}:`, e);
    cachedForeignKeysByTable.set(cacheKey, []);
  }
}

async function ensureForeignKeysForTables(tables: Array<{ name: string; schema?: string | null }>) {
  const seen = new Set<string>();
  const uniqueTables = tables.filter((table) => {
    const key = completionCacheKey(table).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  await Promise.all(uniqueTables.map((table) => ensureForeignKeysForTable(table)));
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
    parameterNode.className = index === signature.activeParameter ? "font-semibold text-foreground" : "text-muted-foreground";
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
  if (!props.connectionId || props.database == null) return null;

  const sql = currentView.state.doc.toString();
  const range = identifierRangeAt(sql, pos);
  if (!range) return null;

  const identifier = range.text;
  const parts = identifier.split(".");
  const name = parts[parts.length - 1] ?? identifier;
  const qualifier = parts.length > 1 ? parts[parts.length - 2] : undefined;

  try {
    if (cachedTables.length === 0) {
      cachedTables = await connectionStore.listCompletionTables(props.connectionId, props.database, name, MAX_COMPLETION_TABLES, props.schema);
    }

    let table = matchTable(identifier, cachedTables) ?? matchTable(name, cachedTables);
    if (!table) {
      const hoverTables = await connectionStore.listCompletionTables(props.connectionId, props.database, name, MAX_COMPLETION_TABLES, props.schema);
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
    const candidates = qualifier ? context.referencedTables.filter((rt) => rt.alias?.toLowerCase() === qualifier.toLowerCase() || rt.name.toLowerCase() === qualifier.toLowerCase()) : context.referencedTables;

    for (const refTable of candidates) {
      await ensureColumnsForTable(refTable);
      const columns = cachedColumnsByTable.get(completionCacheKey(refTable)) ?? [];
      const column = columns.find((col) => col.name.toLowerCase() === name.toLowerCase());
      if (!column) continue;
      return {
        pos: range.from,
        end: range.to,
        create: () => ({
          dom: createHoverDom(column.name, column.dataType || "column", [column.schema ? `${column.schema}.${column.table}` : column.table, ...(column.comment?.trim() ? [column.comment.trim()] : [])]),
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

function sqlTextSpanToRange(sql: string, span: SqlTextSpan): { from: number; to: number } | null {
  if (!span.start_line || !span.start_column) return null;
  const from = lineColumnToOffset(sql, { line: span.start_line - 1, column: span.start_column - 1 });
  const to = lineColumnToOffset(sql, {
    line: Math.max(span.end_line - 1, span.start_line - 1),
    column: Math.max(span.end_column, span.start_column),
  });
  if (from == null || to == null || to <= from) return null;
  return { from, to };
}

function sqlSemanticDecorationRanges(currentState: import("@codemirror/state").EditorState) {
  const sql = currentState.doc.toString();
  return semanticDiagnostics
    .map((diagnostic) => {
      const range = sqlTextSpanToRange(sql, diagnostic.span);
      return range ? { ...range, message: diagnostic.message, severity: diagnostic.severity } : null;
    })
    .filter((range): range is { from: number; to: number; message: string; severity: "error" | "warning" } => !!range);
}

function reconfigureDiagnostics() {
  if (!view.value) return;
  if (setSqlDiagnosticsEffect) {
    view.value.dispatch({
      effects: setSqlDiagnosticsEffect.of(semanticDiagnostics),
    });
    return;
  }
  if (!diagnosticComp || !buildSqlDiagnosticExtension) return;
  view.value.dispatch({
    effects: diagnosticComp.reconfigure(buildSqlDiagnosticExtension()),
  });
}

function setSemanticDiagnostics(next: SqlSemanticDiagnostic[]) {
  if (areSqlSemanticDiagnosticsEqual(semanticDiagnostics, next)) return;
  semanticDiagnostics = next;
  reconfigureDiagnostics();
}

async function enrichSemanticDiagnosticTables(tables: SqlTableReference[]) {
  if (!props.connectionId || props.database == null) return tables;

  const enriched: SqlTableReference[] = [];
  for (const table of tables) {
    if (table.schema) {
      enriched.push(table);
      continue;
    }
    const cached = cachedTables.find((item) => item.name.toLowerCase() === table.name.toLowerCase());
    if (cached?.schema) {
      enriched.push({ ...table, schema: cached.schema });
      continue;
    }
    try {
      const matches = await connectionStore.listCompletionTables(props.connectionId, props.database, table.name, MAX_COMPLETION_TABLES, props.schema);
      cachedTables = [...cachedTables, ...matches];
      const match = matches.find((item) => item.name.toLowerCase() === table.name.toLowerCase());
      enriched.push(match?.schema ? { ...table, schema: match.schema } : table);
    } catch {
      enriched.push(table);
    }
  }
  return enriched;
}

async function refreshSemanticDiagnostics() {
  const currentView = view.value;
  const runId = ++semanticDiagnosticRunId;
  if (!currentView || !props.connectionId || props.database == null) {
    setSemanticDiagnostics([]);
    return;
  }

  const sql = currentView.state.doc.toString();
  if (!sql.trim()) {
    setSemanticDiagnostics([]);
    return;
  }
  if (props.databaseType === "mongodb" || props.databaseType === "elasticsearch") {
    setSemanticDiagnostics([]);
    return;
  }
  if (props.databaseType === "redis") {
    // Redis has no SQL semantics; run command-name / arity / quote / danger checks instead.
    if (!shouldRunRedisDiagnostics(sql, currentView.state.selection.main.head)) {
      scheduleSemanticDiagnostics(900);
      return;
    }
    setSemanticDiagnostics(buildRedisSyntaxDiagnostics(sql));
    return;
  }
  if (!shouldRunSqlSemanticDiagnostics(sql, currentView.state.selection.main.head, { databaseType: props.databaseType })) {
    scheduleSemanticDiagnostics(1200);
    return;
  }
  if (codeMirrorCompletionStatus?.(currentView.state)) {
    scheduleSemanticDiagnostics(900);
    return;
  }

  try {
    const analysis = await api.analyzeSqlReferences(sql, props.formatDialect ?? props.dialect ?? "generic");
    if (runId !== semanticDiagnosticRunId) return;

    const tables = await enrichSemanticDiagnosticTables(analysis.tables);
    await Promise.all(tables.map((table) => ensureColumnsForTable(table)));
    if (runId !== semanticDiagnosticRunId) return;

    const enrichedAnalysis: SqlReferenceAnalysis = { ...analysis, tables };
    setSemanticDiagnostics(
      buildSqlSemanticDiagnostics(enrichedAnalysis, {
        tables: cachedTables,
        columnsByTable: cachedColumnsByTable,
      }),
    );
  } catch (error) {
    if (runId === semanticDiagnosticRunId) {
      const diagnostic = buildSqlParserErrorDiagnostic(error, sql);
      setSemanticDiagnostics(diagnostic ? [diagnostic] : []);
    }
  }
}

function scheduleSemanticDiagnostics(delay = 500) {
  if (!editorIsActive) return;
  if (semanticDiagnosticTimer) clearTimeout(semanticDiagnosticTimer);
  semanticDiagnosticTimer = setTimeout(() => {
    semanticDiagnosticTimer = null;
    void refreshSemanticDiagnostics();
  }, delay);
}

async function formatCurrentSql() {
  if (props.readOnly) return;
  const currentView = view.value;
  if (!currentView) return;

  const originalState = currentView.state;
  const selection = originalState.selection.main;
  const formatsSelection = !selection.empty;
  const from = formatsSelection ? selection.from : 0;
  const to = formatsSelection ? selection.to : originalState.doc.length;
  const source = originalState.sliceDoc(from, to);
  if (!source.trim()) return;

  try {
    const formatted = props.databaseType === "mongodb" ? formatMongoShellText(source, settingsStore.editorSettings.sqlFormatter) : await formatSqlText(source, props.formatDialect ?? props.dialect ?? "generic", settingsStore.editorSettings.sqlFormatter);
    if (view.value !== currentView || currentView.state !== originalState || currentView.state.sliceDoc(from, to) !== source) {
      return;
    }
    if (formatted === source) return;
    currentView.dispatch({
      changes: { from, to, insert: formatted },
      selection: formatsSelection ? { anchor: from, head: from + formatted.length } : { anchor: from + formatted.length },
    });
  } catch (e: any) {
    emit("formatError", String(e?.message || e));
  }
}

function droppedTableReference(event: DragEvent) {
  return activeTableReferencePayloadValue() ?? parseTableReferencePayload(event.dataTransfer?.getData(DBX_TABLE_REFERENCE_MIME));
}

function hasDroppedTableReference(event: DragEvent) {
  return !!activeTableReferencePayloadValue() || hasTableReferencePayloadType(event.dataTransfer?.types);
}

function insertTableReferencePayload(currentView: EditorViewType, payload: QueryEditorTableReferencePayload, coords?: { clientX: number; clientY: number }): boolean {
  if (props.readOnly) return false;
  const insertText = tableReferenceInsertText(payload, props.databaseType);
  const dropPos = coords ? currentView.posAtCoords({ x: coords.clientX, y: coords.clientY }) : null;
  const selection = currentView.state.selection.main;
  const from = dropPos ?? selection.from;
  const to = dropPos == null && !selection.empty ? selection.to : from;
  currentView.dispatch({
    changes: { from, to, insert: insertText },
    selection: { anchor: from + insertText.length },
    scrollIntoView: true,
    userEvent: "input.drop",
  });
  clearActiveTableReferencePayload(payload);
  currentView.focus();
  return true;
}

function insertDroppedTableReference(currentView: EditorViewType, event: DragEvent): boolean {
  const payload = droppedTableReference(event);
  if (!payload) return false;

  event.preventDefault();
  event.stopPropagation();
  return insertTableReferencePayload(currentView, payload, { clientX: event.clientX, clientY: event.clientY });
}

function onTableReferenceDropEvent(event: Event) {
  const currentView = view.value;
  if (!currentView || props.readOnly || !(event instanceof CustomEvent)) return;
  const detail = event.detail as QueryEditorTableReferenceDropDetail | undefined;
  if (!detail?.payload) return;
  const target = document.elementFromPoint(detail.clientX, detail.clientY);
  if (target instanceof Element && editorRef.value?.contains(target)) {
    insertTableReferencePayload(currentView, detail.payload, detail);
  }
}

function registerTableReferenceDropListener() {
  if (tableReferenceDropListenerRegistered) return;
  window.addEventListener(DBX_TABLE_REFERENCE_DROP_EVENT, onTableReferenceDropEvent);
  tableReferenceDropListenerRegistered = true;
}

function unregisterTableReferenceDropListener() {
  if (!tableReferenceDropListenerRegistered) return;
  window.removeEventListener(DBX_TABLE_REFERENCE_DROP_EVENT, onTableReferenceDropEvent);
  tableReferenceDropListenerRegistered = false;
}

let completionEpoch = 0;
let completionDebounceTimer: ReturnType<typeof setTimeout> | null = null;

type QueryCompletionItem = SqlCompletionItem | ElasticsearchCompletionItem | RedisCompletionItem | MongoCompletionItem;

function buildCompletionResult(items: QueryCompletionItem[], from: number, validFor?: RegExp) {
  if (items.length === 0) return null;
  return {
    from,
    filter: false,
    options: items.map((item) => completionOptionForItem(item)),
    validFor,
  };
}

function findExactName(names: string[], value: string): string | undefined {
  return names.find((name) => name.toLowerCase() === value.toLowerCase());
}

function mergeCompletionQualifierNames(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of [...primary, ...secondary]) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(name);
  }
  return merged;
}

function completionOptionForItem(item: QueryCompletionItem) {
  const record = () => {
    recordCompletionSelection(item.label, item.type);
  };
  if ((item.type === "snippet" || item.type === "function") && item.apply) {
    const completion = codeMirrorSnippetCompletion(item.apply, {
      label: item.label,
      type: item.type,
      detail: item.detail,
      info: item.info,
      boost: item.boost,
    });
    const originalApply = completion.apply;
    return {
      ...completion,
      apply(view: EditorViewType, completionItem: unknown, from: number, to: number) {
        record();
        if (typeof originalApply === "function") {
          originalApply(view, completionItem as never, from, to);
        } else {
          const insert = String(originalApply ?? item.label);
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + insert.length },
          });
        }
      },
    };
  }
  return {
    label: item.label,
    type: item.type,
    detail: item.detail,
    info: item.info,
    boost: item.boost,
    apply(view: EditorViewType, _completionItem: unknown, from: number, to: number) {
      record();
      const insert = item.apply ?? item.label;
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      });
    },
  };
}

async function provideElasticsearchCompletions(currentState: import("@codemirror/state").EditorState, position: number, explicit: boolean) {
  if (!props.connectionId) return null;
  const epoch = ++completionEpoch;
  const fullDoc = currentState.doc.toString();
  if (!explicit && !shouldAutoOpenElasticsearchCompletion(fullDoc, position)) return null;

  const completionContext = getElasticsearchCompletionContext(fullDoc, position);
  let indices: string[] = [];
  if (props.database != null && completionContext.mode === "path") {
    try {
      indices = await connectionStore.listElasticsearchCompletionIndices(props.connectionId, props.database);
    } catch {
      indices = [];
    }
  }
  if (epoch !== completionEpoch) return null;

  const items = buildElasticsearchCompletionItemsFromContext(completionContext, { indices });
  return buildCompletionResult(items, completionContext.from, getElasticsearchCompletionResultValidFor());
}

async function provideRedisCompletions(currentState: import("@codemirror/state").EditorState, position: number, explicit: boolean) {
  if (!props.connectionId) return null;
  const epoch = ++completionEpoch;
  const fullDoc = currentState.doc.toString();
  if (!explicit && !shouldAutoOpenRedisCompletion(fullDoc, position)) return null;

  const completionContext = getRedisCompletionContext(fullDoc, position);
  // Key-name completion needs a reliable db index; props.database may briefly be "" on
  // the New Query path before the active db resolves, and only key-argument commands warrant it.
  let keys: string[] = [];
  if (completionContext.mode === "argument" && props.database && takesKeyArgument(completionContext.mainCommand)) {
    try {
      keys = await connectionStore.listRedisCompletionKeys(props.connectionId, props.database);
    } catch {
      keys = [];
    }
  }
  if (epoch !== completionEpoch) return null;

  const items = buildRedisCompletionItemsFromContext(completionContext, { keys });
  if (items.length === 0) return null;
  // Use the built-in filter (the default) so typing narrows the list and moves
  // the selection synchronously. `filter: false` + `validFor` are mutually
  // exclusive (the latter is ignored), which would leave the menu frozen while
  // typing — hence we build the result here instead of via buildCompletionResult.
  return {
    from: completionContext.from,
    options: items.map((item) => completionOptionForItem(item)),
    validFor: getRedisCompletionResultValidFor(),
  };
}

async function provideMongoCompletions(currentState: import("@codemirror/state").EditorState, position: number, explicit: boolean) {
  if (!props.connectionId) return null;
  const epoch = ++completionEpoch;
  const fullDoc = currentState.doc.toString();
  if (!explicit && !shouldAutoOpenMongoCompletion(fullDoc, position)) return null;

  const completionContext = getMongoCompletionContext(fullDoc, position);
  let collections: string[] = [];
  let fields: Awaited<ReturnType<typeof connectionStore.listMongoCompletionFields>> = [];

  if (props.database && completionContext.mode === "collection") {
    try {
      collections = await connectionStore.listMongoCompletionCollections(props.connectionId, props.database);
    } catch {
      collections = [];
    }
  }

  if (props.database && completionContext.mode === "field" && completionContext.collection) {
    try {
      fields = await connectionStore.listMongoCompletionFields(props.connectionId, props.database, completionContext.collection);
    } catch {
      fields = [];
    }
  }

  if (epoch !== completionEpoch) return null;

  const items = buildMongoCompletionItemsFromContext(completionContext, { collections, fields });
  if (items.length === 0) return null;
  return {
    from: completionContext.from,
    options: items.map((item) => completionOptionForItem(item)),
    validFor: getMongoCompletionResultValidFor(),
  };
}

async function provideSqlCompletions(currentState: import("@codemirror/state").EditorState, position: number, explicit: boolean) {
  if (imeCompositionActive || view.value?.compositionStarted || view.value?.composing) return null;
  if (!props.connectionId) return null;
  const fullDoc = currentState.doc.toString();
  if (props.databaseType === "mongodb") {
    return provideMongoCompletions(currentState, position, explicit);
  }
  if (props.databaseType === "elasticsearch") {
    if (!isSqlLikeCompletionStatement(fullDoc, position)) {
      return provideElasticsearchCompletions(currentState, position, explicit);
    }
  }
  if (props.databaseType === "redis") {
    return provideRedisCompletions(currentState, position, explicit);
  }
  const hasDatabase = props.database != null;

  const epoch = ++completionEpoch;

  try {
    if (!explicit && !shouldAutoOpenSqlCompletion(fullDoc, position)) return null;

    const completionContext = getSqlCompletionContext(fullDoc, position);

    if (!hasDatabase) {
      const items = buildSqlCompletionItemsFromContext(completionContext, {
        tables: [],
        objects: [],
        columnsByTable: new Map(),
        schemas: [],
        translations: completionTranslations.value,
        snippets: settingsStore.editorSettings.snippets,
        dialect: props.dialect,
        databaseType: props.databaseType,
        keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
      });
      return buildCompletionResult(items, position - completionContext.prefix.length, getSqlCompletionResultValidFor(fullDoc, position));
    }

    const needsAsyncData =
      completionContext.suggestTables || completionContext.suggestRoutines || completionContext.exclusiveRoutineSuggestions || !!completionContext.qualifier || !!completionContext.insertTable || completionContext.exclusiveColumnSuggestions || completionContext.referencedTables.length > 0;

    if (!needsAsyncData) {
      const items = buildSqlCompletionItemsFromContext(completionContext, {
        tables: [],
        objects: [],
        columnsByTable: new Map(),
        schemas: [],
        translations: completionTranslations.value,
        snippets: settingsStore.editorSettings.snippets,
        dialect: props.dialect,
        databaseType: props.databaseType,
        keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
      });
      return buildCompletionResult(items, position - completionContext.prefix.length, getSqlCompletionResultValidFor(fullDoc, position));
    }

    const localResult = buildLocalSqlCompletionResult(completionContext, fullDoc, position);
    if (localResult) {
      scheduleCompletionMetadataRefresh(completionContext);
      if (!explicit) return localResult;
    }
    if (!explicit) {
      scheduleCompletionMetadataRefresh(completionContext);
      return null;
    }

    // Cancel any pending debounced completion
    if (completionDebounceTimer) {
      clearTimeout(completionDebounceTimer);
      completionDebounceTimer = null;
    }

    // Debounce the full async flow and return the promise to CodeMirror.
    // This prevents wasted backend calls during rapid typing while still
    // showing table/column names in the first popup.
    return new Promise<ReturnType<typeof buildCompletionResult>>((resolve) => {
      completionDebounceTimer = setTimeout(async () => {
        completionDebounceTimer = null;
        if (epoch !== completionEpoch) {
          resolve(null);
          return;
        }
        try {
          const result = await performAsyncCompletionWithResult(epoch, completionContext, fullDoc, position);
          resolve(result);
        } catch {
          resolve(null);
        }
      }, 150);
    });
  } catch {
    return null;
  }
}

function isEditorComposing(currentView: EditorViewType): boolean {
  return imeCompositionActive || currentView.compositionStarted || currentView.composing;
}

function flushImeComposition() {
  const currentView = view.value;
  if (!currentView || !pendingImeModelEmit) return;
  pendingImeModelEmit = false;
  emit("update:modelValue", currentView.state.doc.toString());
  scheduleSemanticDiagnostics();
  syncContextMenuState(currentView);
  emit("selectionChange", selectedSqlFromView(currentView));
  emit("cursorChange", currentView.state.selection.main.head);
  latestSelection = readEditorSelection(currentView);
  if (editorIsActive) emitEditorSelection(latestSelection);
}

function buildLocalSqlCompletionResult(completionContext: ReturnType<typeof getSqlCompletionContext>, fullDoc: string, position: number) {
  if (!props.connectionId || props.database == null) return null;
  const databaseNames = supportsDatabaseQualifierCompletion() && completionContext.suggestTables && !completionContext.insertTable ? connectionStore.lookupLocalCompletionDatabases(props.connectionId, completionContext.qualifier || completionContext.prefix, MAX_COMPLETION_TABLES) : [];
  const qualifierDatabase = completionContext.qualifier ? findExactName(databaseNames, completionContext.qualifier) : undefined;
  const shouldLoadTables = completionContext.suggestTables || (!!completionContext.qualifier && !isReferencedTableQualifier(completionContext));
  const tableLookupDatabase = qualifierDatabase ?? props.database;
  const tableLookupSchema = qualifierDatabase ? undefined : completionContext.qualifier && completionContext.suggestTables ? completionContext.qualifier : props.schema;
  const tableLookupFilter = completionContext.qualifier && completionContext.suggestTables ? completionContext.prefix : completionContext.qualifier || completionContext.prefix;
  const tables = shouldLoadTables ? connectionStore.lookupLocalCompletionTables(props.connectionId, tableLookupDatabase, tableLookupFilter, MAX_COMPLETION_TABLES, tableLookupSchema) : cachedTables;

  const shouldLoadObjects = completionContext.suggestRoutines || completionContext.exclusiveRoutineSuggestions || (!!completionContext.qualifier && !completionContext.exclusiveColumnSuggestions);
  const completionObjects = shouldLoadObjects
    ? connectionStore.lookupLocalCompletionObjects(props.connectionId, props.database, completionContext.qualifier || completionContext.prefix, MAX_COMPLETION_TABLES, completionContext.qualifier && !completionContext.exclusiveColumnSuggestions ? completionContext.qualifier : props.schema)
    : cachedCompletionObjects;

  const schemaNames =
    completionContext.suggestTables && !completionContext.qualifier && !completionContext.insertTable ? mergeCompletionQualifierNames(connectionStore.lookupLocalCompletionSchemas(props.connectionId, props.database, completionContext.prefix, MAX_COMPLETION_TABLES), databaseNames) : [];

  const columnsByTable = new Map<string, SqlCompletionColumn[]>();
  if (completionContext.insertTable) {
    const insertSchema = completionContext.insertSchema ?? props.schema;
    const insertColumns = connectionStore.lookupLocalCompletionColumns(props.connectionId, props.database, completionContext.insertTable, insertSchema);
    if (insertColumns.length > 0) {
      columnsByTable.set(insertSchema ? `${insertSchema}.${completionContext.insertTable}` : completionContext.insertTable, insertColumns);
    }
  }

  const qualifiedColumnTarget = completionQualifiedTableTarget(completionContext);
  if (qualifiedColumnTarget) {
    const cacheKey = completionCacheKey(qualifiedColumnTarget);
    const cached = cachedColumnsByTable.get(cacheKey);
    if (cached) {
      columnsByTable.set(cacheKey, cached);
    } else {
      const target = completionMetadataTarget(qualifiedColumnTarget);
      const localColumns = target ? connectionStore.lookupLocalCompletionColumns(props.connectionId, target.database, qualifiedColumnTarget.name, target.schema) : [];
      if (localColumns.length > 0) {
        columnsByTable.set(cacheKey, localColumns);
      }
    }
  }

  const cteDefs = extractCteDefinitions(fullDoc);
  for (const refTable of completionContext.referencedTables) {
    const cteDef = cteDefs.find((c) => c.name.toLowerCase() === refTable.name.toLowerCase());
    if (cteDef) {
      columnsByTable.set(
        refTable.name,
        cteDef.columns.map((name) => ({ name, table: refTable.name, dataType: undefined })),
      );
      continue;
    }
    const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;
    const cached = cachedColumnsByTable.get(cacheKey);
    if (cached) {
      columnsByTable.set(cacheKey, cached);
      continue;
    }
    const target = completionMetadataTarget(refTable);
    const localColumns = target ? connectionStore.lookupLocalCompletionColumns(props.connectionId, target.database, refTable.name, target.schema) : [];
    if (localColumns.length > 0) {
      columnsByTable.set(cacheKey, localColumns);
    }
    const localForeignKeys = target ? connectionStore.lookupLocalCompletionForeignKeys(props.connectionId, target.database, refTable.name, target.schema) : [];
    if (localForeignKeys.length > 0) {
      cachedForeignKeysByTable.set(cacheKey, localForeignKeys);
    }
  }

  if (tables.length === 0 && completionObjects.length === 0 && schemaNames.length === 0 && columnsByTable.size === 0 && (completionContext.exclusiveTableSuggestions || completionContext.exclusiveColumnSuggestions || completionContext.exclusiveRoutineSuggestions)) {
    return null;
  }

  const items = buildSqlCompletionItemsFromContext(completionContext, {
    tables,
    objects: completionObjects,
    columnsByTable,
    foreignKeysByTable: cachedForeignKeysByTable,
    schemas: schemaNames,
    translations: completionTranslations.value,
    snippets: settingsStore.editorSettings.snippets,
    dialect: props.dialect,
    databaseType: props.databaseType,
    keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
  });

  return buildCompletionResult(items, position - completionContext.prefix.length, getSqlCompletionResultValidFor(fullDoc, position));
}

function scheduleCompletionMetadataRefresh(completionContext: ReturnType<typeof getSqlCompletionContext>) {
  if (!props.connectionId || props.database == null) return;
  const connectionId = props.connectionId;
  const database = props.database;
  const schema = completionContext.qualifier && completionContext.suggestTables ? completionContext.qualifier : props.schema;
  if (completionContext.suggestTables || (!!completionContext.qualifier && !isReferencedTableQualifier(completionContext))) {
    void connectionStore
      .refreshCompletionTables(connectionId, database, completionContext.qualifier && !schema ? completionContext.qualifier : completionContext.prefix, MAX_COMPLETION_TABLES, schema)
      .then((tables) => {
        cachedTables = mergeCompletionTables(cachedTables, tables);
        if (completionContext.suggestTables && completionContext.referencedTables.length > 0) {
          void ensureForeignKeysForTables([...completionContext.referencedTables, ...tables.slice(0, MAX_JOIN_FK_PREFETCH_TABLES)]);
        }
      })
      .catch(() => {});
  }
  if (completionContext.suggestRoutines || completionContext.exclusiveRoutineSuggestions || (!!completionContext.qualifier && !completionContext.exclusiveColumnSuggestions)) {
    void connectionStore
      .refreshCompletionObjects(connectionId, database, completionContext.prefix, MAX_COMPLETION_TABLES, props.schema)
      .then((objects) => {
        cachedCompletionObjects = mergeCompletionObjects(cachedCompletionObjects, objects);
      })
      .catch(() => {});
  }
  if (completionContext.suggestTables && !completionContext.qualifier && !completionContext.insertTable) {
    void connectionStore.refreshCompletionSchemas(connectionId, database).catch(() => {});
    if (supportsDatabaseQualifierCompletion()) {
      void connectionStore.refreshCompletionDatabases(connectionId).catch(() => {});
    }
  }
  if (completionContext.insertTable) {
    const insertTable = completionContext.insertTable;
    void connectionStore
      .refreshCompletionColumns(connectionId, database, insertTable, completionContext.insertSchema ?? props.schema)
      .then((columns) => {
        const insertSchema = completionContext.insertSchema ?? props.schema;
        cachedColumnsByTable.set(insertSchema ? `${insertSchema}.${insertTable}` : insertTable, columns);
      })
      .catch(() => {});
  }
  const qualifiedColumnTarget = completionQualifiedTableTarget(completionContext);
  const qualifiedColumnCacheKey = qualifiedColumnTarget ? completionCacheKey(qualifiedColumnTarget) : undefined;
  if (qualifiedColumnTarget && qualifiedColumnCacheKey && !cachedColumnsByTable.has(qualifiedColumnCacheKey)) {
    const target = completionMetadataTarget(qualifiedColumnTarget);
    if (target) {
      void connectionStore
        .refreshCompletionColumns(connectionId, target.database, qualifiedColumnTarget.name, target.schema)
        .then((columns) => {
          if (columns.length > 0) cachedColumnsByTable.set(qualifiedColumnCacheKey, columns);
        })
        .catch(() => {});
    }
  }
  for (const refTable of completionContext.referencedTables) {
    if (refTable.columns && refTable.columns.length > 0) continue;
    const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;
    if (cacheKey === qualifiedColumnCacheKey) continue;
    if (cachedColumnsByTable.has(cacheKey)) continue;
    const target = completionMetadataTarget(refTable);
    if (!target) continue;
    void connectionStore
      .refreshCompletionColumns(connectionId, target.database, refTable.name, target.schema)
      .then((columns) => {
        if (columns.length > 0) cachedColumnsByTable.set(cacheKey, columns);
      })
      .catch(() => {});
  }
  if ((completionContext.suggestTables || completionContext.suggestJoinConditions) && completionContext.referencedTables.length > 0) {
    void ensureForeignKeysForTables(completionContext.referencedTables);
  }
}

function mergeCompletionTables(existing: Array<{ name: string; schema?: string; type?: "table" | "view" }>, incoming: Array<{ name: string; schema?: string; type?: "table" | "view" }>) {
  const merged = [...existing];
  const seen = new Set(existing.map((table) => `${table.schema ?? ""}.${table.name}`.toLowerCase()));
  for (const table of incoming) {
    const key = `${table.schema ?? ""}.${table.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(table);
  }
  return merged;
}

async function performAsyncCompletionWithResult(epoch: number, completionContext: ReturnType<typeof getSqlCompletionContext>, fullDoc: string, position: number) {
  // Handle INSERT column list: fetch columns for the target table
  let insertColumnsByTable = new Map<string, SqlCompletionColumn[]>();
  if (completionContext.insertTable) {
    try {
      const insertCols = await connectionStore.listCompletionColumns(props.connectionId!, props.database!, completionContext.insertTable, completionContext.insertSchema ?? props.schema);
      if (epoch !== completionEpoch) return null;
      if (insertCols.length > 0) {
        const insertSchema = completionContext.insertSchema ?? props.schema;
        const insertKey = insertSchema ? `${insertSchema}.${completionContext.insertTable}` : completionContext.insertTable;
        insertColumnsByTable.set(insertKey, insertCols);
      }
    } catch {
      // ignore
    }
  }

  const shouldLoadTables = completionContext.suggestTables || (!!completionContext.qualifier && !isReferencedTableQualifier(completionContext));
  let databaseNames: string[] = [];
  if (supportsDatabaseQualifierCompletion() && completionContext.suggestTables && !completionContext.insertTable) {
    try {
      databaseNames = await connectionStore.listCompletionDatabases(props.connectionId!);
      if (epoch !== completionEpoch) return null;
    } catch {
      databaseNames = [];
    }
  }
  const qualifierDatabase = completionContext.qualifier ? findExactName(databaseNames, completionContext.qualifier) : undefined;
  const tableLookupDatabase = qualifierDatabase ?? props.database!;
  const tableLookupSchema = qualifierDatabase ? undefined : props.schema;
  const tableLookupFilter = completionContext.qualifier && !qualifierDatabase ? completionContext.qualifier : completionContext.prefix;
  let tables = shouldLoadTables ? await connectionStore.listCompletionTables(props.connectionId!, tableLookupDatabase, tableLookupFilter, MAX_COMPLETION_TABLES, tableLookupSchema) : cachedTables;
  if (epoch !== completionEpoch) return null;

  const shouldLoadObjects = completionContext.suggestRoutines || completionContext.exclusiveRoutineSuggestions || (!!completionContext.qualifier && !completionContext.exclusiveColumnSuggestions);
  let completionObjects = shouldLoadObjects ? await connectionStore.listCompletionObjects(props.connectionId!, props.database!, completionContext.qualifier || completionContext.prefix, MAX_COMPLETION_TABLES, props.schema) : cachedCompletionObjects;
  if (epoch !== completionEpoch) return null;

  if (completionContext.qualifier && completionObjects.length === 0) {
    const schemaObjects = await connectionStore.listCompletionObjects(props.connectionId!, props.database!, completionContext.prefix, MAX_COMPLETION_TABLES, completionContext.qualifier);
    if (schemaObjects.length > 0) {
      completionObjects = schemaObjects;
    }
    if (epoch !== completionEpoch) return null;
  }
  cachedCompletionObjects = mergeCompletionObjects(cachedCompletionObjects, completionObjects);

  // Fetch schemas for schema completion
  let schemaNames: string[] = [];
  if (completionContext.suggestTables && !completionContext.qualifier && !completionContext.insertTable) {
    try {
      const schemas = await connectionStore.listCompletionSchemas(props.connectionId!, props.database!);
      schemaNames = mergeCompletionQualifierNames(schemas, databaseNames);
      if (epoch !== completionEpoch) return null;
    } catch {
      schemaNames = databaseNames;
    }
  }

  // If qualifier didn't match any table names, try it as a schema name
  let qualifierIsSchema = false;
  if (completionContext.qualifier && !qualifierDatabase && !isReferencedTableQualifier(completionContext) && tables.length === 0 && (completionContext.suggestTables || completionContext.exclusiveColumnSuggestions)) {
    const schemaTables = await connectionStore.listCompletionTables(props.connectionId!, props.database!, completionContext.prefix, MAX_COMPLETION_TABLES, completionContext.qualifier);
    if (schemaTables.length > 0) {
      tables = schemaTables;
      qualifierIsSchema = true;
    }
    if (epoch !== completionEpoch) return null;
  }

  // Collect referenced tables — enrich with schema from filtered table lookup
  let refs = completionContext.referencedTables.map((rt) => {
    if (!rt.schema) {
      const cached = tables.find((t) => t.name.toLowerCase() === rt.name.toLowerCase());
      if (cached && cached.schema) {
        return { ...rt, schema: cached.schema };
      }
    }
    return rt;
  });
  const unresolvedRefs = refs.filter((rt) => !rt.schema && !rt.columns);
  if (unresolvedRefs.length > 0) {
    const lookupGroups = await Promise.all(unresolvedRefs.map((rt) => connectionStore.listCompletionTables(props.connectionId!, props.database!, rt.name, 20, props.schema)));
    if (epoch !== completionEpoch) return null;
    const lookupTables = lookupGroups.flat();
    refs = refs.map((rt) => {
      if (rt.schema || rt.columns) return rt;
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

  const qualifiedColumnTarget = completionQualifiedTableTarget(completionContext);
  if (qualifiedColumnTarget && !refs.some((ref) => completionTablesMatch(ref, qualifiedColumnTarget))) {
    refs.push(qualifiedColumnTarget);
  }

  // Populate CTE columns from parsed definitions
  const cteDefs = extractCteDefinitions(fullDoc);
  for (const refTable of refs) {
    if (refTable.columns) continue;
    const cteDef = cteDefs.find((c) => c.name.toLowerCase() === refTable.name.toLowerCase());
    if (cteDef) {
      refTable.columns = cteDef.columns;
    }
  }

  await Promise.all(
    refs.map(async (refTable) => {
      if (refTable.columns && refTable.columns.length > 0) return;
      const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;
      if (cachedColumnsByTable.has(cacheKey)) return;
      try {
        const target = completionMetadataTarget(refTable);
        if (!target) return;
        const columns = await connectionStore.listCompletionColumns(props.connectionId!, target.database, refTable.name, target.schema);
        if (epoch !== completionEpoch) return;
        if (columns.length === 0) return;
        cachedColumnsByTable.set(cacheKey, columns);
      } catch (e) {
        console.error(`[DBX] Failed to load columns for ${cacheKey}:`, e);
      }
    }),
  );
  if (epoch !== completionEpoch) return null;

  if ((completionContext.suggestTables || completionContext.suggestJoinConditions) && refs.length > 0) {
    const fkPrefetchTables = completionContext.suggestTables ? [...refs, ...tables.slice(0, MAX_JOIN_FK_PREFETCH_TABLES)] : refs;
    await ensureForeignKeysForTables(fkPrefetchTables.filter((table) => !("columns" in table) || !table.columns || table.columns.length === 0));
    if (epoch !== completionEpoch) return null;
  }

  // Build columnsByTable — from cache or CTE definitions
  const columnsByTable = new Map<string, SqlCompletionColumn[]>();
  const foreignKeysByTable = new Map<string, SqlCompletionForeignKey[]>();
  if (insertColumnsByTable.size > 0) {
    for (const [key, cols] of insertColumnsByTable.entries()) {
      columnsByTable.set(key, cols);
    }
  } else {
    for (const refTable of refs) {
      if (refTable.columns && refTable.columns.length > 0) {
        const key = refTable.name;
        columnsByTable.set(
          key,
          refTable.columns.map((name) => ({
            name,
            table: refTable.name,
            dataType: undefined,
          })),
        );
        continue;
      }
      const cacheKey = refTable.schema ? `${refTable.schema}.${refTable.name}` : refTable.name;
      const cached = cachedColumnsByTable.get(cacheKey);
      if (cached) {
        columnsByTable.set(cacheKey, cached);
      }
      let cachedForeignKeys = cachedForeignKeysByTable.get(cacheKey);
      if (!cachedForeignKeys) {
        const target = completionMetadataTarget(refTable);
        cachedForeignKeys = target ? connectionStore.lookupLocalCompletionForeignKeys(props.connectionId!, target.database, refTable.name, target.schema) : [];
        if (cachedForeignKeys.length > 0) cachedForeignKeysByTable.set(cacheKey, cachedForeignKeys);
      }
      if (cachedForeignKeys) {
        foreignKeysByTable.set(cacheKey, cachedForeignKeys);
      }
    }
  }

  const effectiveContext = qualifierIsSchema
    ? {
        ...completionContext,
        qualifier: undefined,
        suggestTables: true,
        suggestColumns: false,
        exclusiveColumnSuggestions: false,
      }
    : completionContext;

  const items = buildSqlCompletionItemsFromContext(effectiveContext, {
    tables,
    objects: completionObjects,
    columnsByTable,
    foreignKeysByTable,
    schemas: schemaNames,
    translations: completionTranslations.value,
    snippets: settingsStore.editorSettings.snippets,
    dialect: props.dialect,
    databaseType: props.databaseType,
    keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
  });

  return buildCompletionResult(items, position - completionContext.prefix.length, getSqlCompletionResultValidFor(fullDoc, position));
}

function isReferencedTableQualifier(completionContext: ReturnType<typeof getSqlCompletionContext>): boolean {
  if (!completionContext.qualifier) return false;
  const qualifier = completionContext.qualifier.toLowerCase();
  const qualifiedColumnTarget = completionQualifiedTableTarget(completionContext);
  return completionContext.referencedTables.some((table) => table.alias?.toLowerCase() === qualifier || table.name.toLowerCase() === qualifier || (!!qualifiedColumnTarget && completionTablesMatch(table, qualifiedColumnTarget)));
}

function mergeCompletionObjects(existing: SqlCompletionObject[], incoming: SqlCompletionObject[]) {
  const merged = [...existing];
  const seen = new Set(existing.map((object) => `${object.type}:${object.schema ?? ""}:${object.name}:${object.parentName ?? ""}`.toLowerCase()));
  for (const object of incoming) {
    const key = `${object.type}:${object.schema ?? ""}:${object.name}:${object.parentName ?? ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(object);
  }
  return merged;
}

async function refreshCompletionCache() {
  cachedTables = [];
  cachedCompletionObjects = [];
  cachedColumnsByTable.clear();
  cachedForeignKeysByTable.clear();
}

onMounted(async () => {
  if (!editorRef.value) return;

  const [
    { EditorView, keymap, rectangularSelection, hoverTooltip, showTooltip, Decoration, tooltips, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, crosshairCursor, ViewPlugin },
    { EditorState, Compartment, Prec, StateEffect, StateField },
    { sql, MSSQL, MySQL, PostgreSQL, SQLDialect },
    { autocompletion, startCompletion, acceptCompletion, closeBrackets, closeBracketsKeymap, snippetCompletion, completionStatus, completionKeymap },
    { copyLineDown, copyLineUp, deleteLine, indentLess, indentMore, insertNewlineKeepIndent, moveLineDown, moveLineUp, redo, selectAll, undo, history, defaultKeymap, historyKeymap },
    { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldKeymap },
    { searchKeymap },
  ] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("@codemirror/autocomplete"), import("@codemirror/commands"), import("@codemirror/language"), import("@codemirror/search")]);
  editorViewModule = { EditorView, keymap, rectangularSelection } as typeof import("@codemirror/view");
  codeMirrorPrec = Prec;
  codeMirrorSnippetCompletion = snippetCompletion;
  fontThemeComp = new Compartment();
  codeMirrorTheme = new Compartment();
  wordWrapComp = new Compartment();
  readOnlyComp = new Compartment();
  runKeymapComp = new Compartment();
  completionComp = new Compartment();
  diagnosticComp = new Compartment();
  previewRangeComp = new Compartment();
  setSqlDiagnosticsEffect = StateEffect.define<SqlSemanticDiagnostic[]>();
  codeMirrorCompletionStatus = completionStatus;
  codeMirrorAcceptCompletion = acceptCompletion;
  codeMirrorStartCompletion = startCompletion;
  codeMirrorIndentMore = indentMore;
  codeMirrorIndentLess = indentLess;
  codeMirrorCopyLineDown = copyLineDown;
  codeMirrorCopyLineUp = copyLineUp;
  codeMirrorDeleteLine = deleteLine;
  codeMirrorMoveLineUp = moveLineUp;
  codeMirrorMoveLineDown = moveLineDown;
  codeMirrorUndo = undo;
  codeMirrorRedo = redo;
  codeMirrorSelectAll = selectAll;
  codeMirrorInsertNewlineKeepIndent = insertNewlineKeepIndent;
  window.addEventListener("keyup", clearTableNavigationHoverOnModifierRelease);
  window.addEventListener("blur", clearTableNavigationHover);

  const diagnosticTheme = EditorView.baseTheme({
    ".cm-sql-error": {
      textDecoration: "underline wavy var(--destructive)",
      textUnderlineOffset: "3px",
    },
    ".cm-sql-semantic-warning": {
      textDecoration: "underline wavy hsl(var(--warning, 38 92% 50%))",
      textUnderlineOffset: "3px",
    },
  });

  buildSqlDiagnosticExtension = () => {
    const diagnosticEffect = setSqlDiagnosticsEffect;
    const buildDecorations = (state: import("@codemirror/state").EditorState) => {
      const errorDecorations = sqlErrorDecorationRange(state).map((range) =>
        Decoration.mark({
          class: "cm-sql-error",
          attributes: { title: range.message },
        }).range(range.from, range.to),
      );
      const semanticDecorations = sqlSemanticDecorationRanges(state).map((range) =>
        Decoration.mark({
          class: range.severity === "error" ? "cm-sql-error" : "cm-sql-semantic-warning",
          attributes: { title: range.message },
        }).range(range.from, range.to),
      );
      return Decoration.set([...errorDecorations, ...semanticDecorations], true);
    };

    const field = StateField.define({
      create: buildDecorations,
      update(value, transaction) {
        const diagnosticsChanged = !!diagnosticEffect && transaction.effects.some((effect) => effect.is(diagnosticEffect));
        return transaction.docChanged || diagnosticsChanged ? buildDecorations(transaction.state) : value;
      },
      provide: (field) => EditorView.decorations.from(field),
    });

    return [field, diagnosticTheme];
  };

  setPreviewRangeEffect = StateEffect.define<{ from: number; to: number } | null>();
  buildPreviewRangeExtension = () => {
    const effectType = setPreviewRangeEffect!;
    const field = StateField.define({
      create() {
        return Decoration.none;
      },
      update(decorations, transaction) {
        for (const effect of transaction.effects) {
          if (effect.is(effectType)) {
            const range = effect.value;
            if (!range) return Decoration.none;
            return Decoration.set([Decoration.mark({ class: "cm-db-execution-preview" }).range(range.from, range.to)]);
          }
        }
        return decorations;
      },
      provide: (f) => EditorView.decorations.from(f),
    });
    return field;
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

  buildSqlCompletionExtension = () =>
    autocompletion({
      activateOnTyping: true,
      override: [async (context: CompletionContext) => provideSqlCompletions(context.state, context.pos, context.explicit)],
    });

  const baseDialect = props.dialect === "postgres" ? PostgreSQL : props.dialect === "sqlserver" ? MSSQL : MySQL;
  const extraKeywords = "PIVOT UNPIVOT EXCLUDE REPLACE QUALIFY ASOF POSITIONAL ANTI SEMI SAMPLE TABLESAMPLE STRUCT MAP LIST ARRAY LAMBDA UNNEST LATERAL FILTER RECURSIVE SUMMARIZE PRAGMA READ_CSV READ_PARQUET READ_JSON DESCRIBE SHOW COPY EXPORT IMPORT";

  // PL/pgSQL extension: add procedural language keywords and built-in variables for PostgreSQL function/procedure bodies
  const isPostgres = props.dialect === "postgres";
  const plpgsqlKeywords = isPostgres ? "PERFORM" : "";
  const plpgsqlTypes = isPostgres ? " RECORD JSON JSONB" : "";
  const plpgsqlBuiltin = isPostgres ? "SQLERRM TG_NAME TG_WHEN TG_LEVEL TG_OP TG_RELID TG_RELNAME TG_TABLE_NAME TG_TABLE_SCHEMA TG_NARGS TG_ARGV" : "";

  const dialect = SQLDialect.define({
    ...baseDialect.spec,
    keywords: [baseDialect.spec.keywords || "", extraKeywords, plpgsqlKeywords].filter(Boolean).join(" "),
    types: [baseDialect.spec.types || "", plpgsqlTypes].filter(Boolean).join(" ") || undefined,
    builtin: [baseDialect.spec.builtin || "", plpgsqlBuiltin].filter(Boolean).join(" ") || undefined,
    doubleDollarQuotedStrings: false,
  });

  const initialSettings = settingsStore.editorSettings;
  const theme = await loadEditorTheme(initialSettings.theme, editorThemeAppearance(), getCurrentCustomThemeColors());

  const activeLineHighlighter = ViewPlugin.fromClass(
    class {
      decorations: import("@codemirror/view").DecorationSet;
      constructor(view: import("@codemirror/view").EditorView) {
        this.decorations = this.getDeco(view);
      }
      update(update: import("@codemirror/view").ViewUpdate) {
        if (update.docChanged || update.selectionSet) this.decorations = this.getDeco(update.view);
      }
      getDeco(view: import("@codemirror/view").EditorView) {
        if (!view.state.selection.main.empty) return Decoration.none;
        let lastLineStart = -1;
        const deco: any[] = [];
        for (const r of view.state.selection.ranges) {
          if (!r.empty) continue;
          const line = view.lineBlockAt(r.head);
          if (line.from > lastLineStart) {
            deco.push(Decoration.line({ class: "cm-activeLine" }).range(line.from));
            lastLineStart = line.from;
          }
        }
        return Decoration.set(deco);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const state = EditorState.create({
    doc: props.modelValue,
    selection: normalizedEditorSelection(props.initialSelection, props.modelValue.length),
    extensions: [
      cmSearch({
        top: true,
        createPanel: () => {
          const dom = document.createElement("span");
          dom.style.display = "none";
          return { dom };
        },
      }),
      lineNumbers({
        domEventHandlers: {
          mousedown: selectSqlLineFromGutter,
        },
      }),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter({
        markerDOM(open: boolean) {
          const span = document.createElement("span");
          span.className = "cm-foldMarker-svg";
          span.innerHTML = open
            ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.5 6.5l3.5 3.5 3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.5 4.5l3.5 3.5-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          return span;
        },
      }),
      drawSelection(),
      trimmedSelectionLayer(),
      selectionMatchOccurrences(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      crosshairCursor(),
      activeLineHighlighter,
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
      sql({ dialect }),
      tooltips({ parent: document.body }),
      completionComp.of(buildSqlCompletionExtension()),
      sqlCompletionTheme(EditorView),
      codeMirrorTheme.of(theme),
      closeBrackets(),
      bracketMatching(),
      hoverTooltip((currentView, pos) => resolveSqlHoverTooltip(currentView, pos)),
      buildSqlSignatureExtension(),
      diagnosticComp.of(buildSqlDiagnosticExtension()),
      previewRangeComp.of(buildPreviewRangeExtension()),
      Prec.highest(
        keymap.of([
          ...closeBracketsKeymap,
          { key: "Tab", run: handleTab },
          {
            key: "Escape",
            run: () => {
              return searchPanelRef.value?.closeSearch() ?? false;
            },
          },
        ]),
      ),
      runKeymapComp.of(runKeymapExtension(keymap)),
      wordWrapComp.of(props.forceWordWrap || initialSettings.wordWrap ? EditorView.lineWrapping : []),
      readOnlyComp.of([EditorState.readOnly.of(!!props.readOnly), EditorView.editable.of(!props.readOnly)]),
      rectangularSelection({ eventFilter: (e: MouseEvent) => e.altKey || e.button === 1 }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          if (isEditorComposing(update.view)) {
            pendingImeModelEmit = true;
            completionEpoch++;
          } else {
            emit("update:modelValue", update.state.doc.toString());
            scheduleSemanticDiagnostics();
            let insertedText = "";
            update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
              insertedText += inserted.toString();
            });
            if (insertedText.endsWith(".")) {
              startCompletion(update.view);
            }
          }
        }
        if (update.selectionSet || update.docChanged) {
          syncContextMenuState(update.view);
          emit("selectionChange", selectedSqlFromView(update.view));
          emit("cursorChange", update.state.selection.main.head);
          latestSelection = readEditorSelection(update.view);
          if (editorIsActive) emitEditorSelection(latestSelection);
        }
      }),
      fontThemeComp.of(
        editorFontTheme(EditorView, liveFontSize.value, initialSettings.fontFamily, {
          fixedHeight: true,
          scrollable: true,
        }),
      ),
      EditorView.domEventHandlers({
        dragover(event) {
          if (props.readOnly || !hasDroppedTableReference(event)) return false;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
          return true;
        },
        drop(event, currentView) {
          return insertDroppedTableReference(currentView, event);
        },
        blur(_event, currentView) {
          latestSelection = readEditorSelection(currentView);
          if (editorIsActive) emitEditorSelection(latestSelection);
          return false;
        },
        compositionstart() {
          imeCompositionActive = true;
          completionEpoch++;
          return false;
        },
        compositionend() {
          imeCompositionActive = false;
          window.setTimeout(flushImeComposition, 0);
          return false;
        },
        wheel(event) {
          if (!event.metaKey && !event.ctrlKey) return false;
          event.preventDefault();
          const next = fontSizeFromWheelDelta(liveFontSize.value, event.deltaY);
          applyLiveFontSize(next);
          scheduleFontSizeCommit(next);
          return true;
        },
        mousemove: (event: MouseEvent) => {
          const currentView = view.value;
          if (!currentView) return false;
          updateTableNavigationHover(currentView, event);
          return false;
        },
        mouseleave: () => {
          clearTableNavigationHover();
          return false;
        },
        mousedown: (event: MouseEvent) => {
          clearTableNavigationHover();
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
          if (!currentView || !props.connectionId || props.database == null) {
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
                cachedTables = await connectionStore.listCompletionTables(props.connectionId!, props.database!, identifier, MAX_COMPLETION_TABLES, props.schema);
              }

              // 1. Check if it's a table name
              const matchedTable = matchTable(identifier, cachedTables);
              if (matchedTable) {
                emit("clickTable", matchedTable.schema ? `${matchedTable.schema}.${matchedTable.name}` : matchedTable.name);
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
              const tablesToCheck = qualifier ? referencedTables.filter((rt) => rt.alias?.toLowerCase() === qualifier.toLowerCase() || rt.name.toLowerCase() === qualifier.toLowerCase()) : referencedTables;

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
                    cols = await connectionStore.listCompletionColumns(props.connectionId!, props.database!, refTable.name, refTable.schema ?? props.schema);
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
  view.value.scrollDOM.addEventListener("scroll", scheduleEditorViewportEmit, { passive: true });
  restoreEditorViewport();
  syncContextMenuState(view.value);
  syncEditorFontCssVars(liveFontSize.value, initialSettings.fontFamily);
  registerTableReferenceDropListener();

  cachedTables = [];
  cachedCompletionObjects = [];
  scheduleSemanticDiagnostics();

  // Ensure theme is applied with the latest settings after mount
  void nextTick(async () => {
    if (!view.value || !codeMirrorTheme) return;
    const settings = settingsStore.editorSettings;
    const themeColors = settings.theme === "custom" ? getCurrentCustomThemeColors() : settings.customThemeColors;
    const themeExt = await loadEditorTheme(settings.theme, editorThemeAppearance(), themeColors);
    view.value.dispatch({
      effects: [codeMirrorTheme.reconfigure(themeExt)],
    });
  });
});

watch(
  () => props.modelValue,
  (val) => {
    if (view.value && val !== view.value.state.doc.toString()) {
      if (isEditorComposing(view.value)) return;
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
    reconfigureDiagnostics();
  },
);

watch(
  () => props.connectionId,
  () => {
    refreshCompletionCache();
    setSemanticDiagnostics([]);
    scheduleSemanticDiagnostics();
  },
);

watch(
  () => props.database,
  () => {
    refreshCompletionCache();
    setSemanticDiagnostics([]);
    scheduleSemanticDiagnostics();
  },
);

watch(
  () => props.schema,
  () => {
    refreshCompletionCache();
    setSemanticDiagnostics([]);
    scheduleSemanticDiagnostics();
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

// Derive current custom theme colors from settingsStore
function getCurrentCustomThemeColors() {
  const settings = settingsStore.editorSettings;
  if (settings.theme !== "custom") return settings.customThemeColors;
  const activeTheme = settings.customThemes?.find((t: { id: string }) => t.id === settings.activeCustomThemeId) || settings.customThemes?.[0];
  return activeTheme?.colors ?? settings.customThemeColors;
}

// Reactively apply editor settings changes
watch(
  [() => settingsStore.editorSettings, () => isDark.value],
  async ([ss]) => {
    if (!view.value || !codeMirrorTheme || !fontThemeComp || !wordWrapComp || !runKeymapComp || !editorViewModule) {
      return;
    }
    if (!isGestureZooming.value && !zoomCommitScheduler.hasPendingCommit() && liveFontSize.value !== ss.fontSize) {
      liveFontSize.value = ss.fontSize;
    }
    syncEditorFontCssVars(liveFontSize.value, ss.fontFamily);
    const themeColors = getCurrentCustomThemeColors();
    const themeExt = await loadEditorTheme(ss.theme, editorThemeAppearance(), themeColors);
    view.value.dispatch({
      effects: [codeMirrorTheme.reconfigure(themeExt), wordWrapComp.reconfigure(props.forceWordWrap || ss.wordWrap ? editorViewModule.EditorView.lineWrapping : []), runKeymapComp.reconfigure(runKeymapExtension(editorViewModule.keymap))],
    });
  },
  { deep: true },
);

watch(
  () => settingsStore.editorSettings.snippets,
  () => {
    completionEpoch++;
    if (!view.value || !completionComp || !buildSqlCompletionExtension) return;
    view.value.dispatch({
      effects: completionComp.reconfigure(buildSqlCompletionExtension()),
    });
    if (codeMirrorCompletionStatus?.(view.value.state) === "active") {
      codeMirrorStartCompletion?.(view.value);
    }
  },
  { deep: true },
);

function pauseQueryEditorBackgroundWork() {
  flushEditorViewport();
  flushEditorSelection();
  clearTableNavigationHover();
  editorIsActive = false;
  semanticDiagnosticRunId++;
  if (semanticDiagnosticTimer) clearTimeout(semanticDiagnosticTimer);
  semanticDiagnosticTimer = null;
  completionEpoch++;
  unregisterTableReferenceDropListener();
}

function resumeQueryEditorBackgroundWork() {
  editorIsActive = true;
  registerTableReferenceDropListener();
  scheduleSemanticDiagnostics();
  restoreEditorSelection();
  restoreEditorFocus();
  restoreEditorViewport();
}

onActivated(resumeQueryEditorBackgroundWork);

onDeactivated(pauseQueryEditorBackgroundWork);

onBeforeUnmount(() => {
  pauseQueryEditorBackgroundWork();
  if (viewportEmitFrame !== null) {
    cancelAnimationFrame(viewportEmitFrame);
    viewportEmitFrame = null;
  }
  if (viewportRestoreFrame !== null) {
    cancelAnimationFrame(viewportRestoreFrame);
    viewportRestoreFrame = null;
  }
  view.value?.scrollDOM.removeEventListener("scroll", scheduleEditorViewportEmit);
  window.removeEventListener("keyup", clearTableNavigationHoverOnModifierRelease);
  window.removeEventListener("blur", clearTableNavigationHover);
  zoomCommitScheduler.dispose();
  view.value?.destroy();
});

function readEditorViewport(currentView: EditorViewType) {
  return {
    scrollTop: Math.max(0, currentView.scrollDOM.scrollTop),
    scrollLeft: Math.max(0, currentView.scrollDOM.scrollLeft),
  };
}

function normalizedEditorSelection(selection: { anchor: number; head: number } | undefined, docLength: number) {
  if (!selection) return undefined;
  return {
    anchor: Math.min(Math.max(0, selection.anchor), docLength),
    head: Math.min(Math.max(0, selection.head), docLength),
  };
}

function readEditorSelection(currentView: EditorViewType) {
  const selection = currentView.state.selection.main;
  return {
    anchor: selection.anchor,
    head: selection.head,
  };
}

function emitEditorSelection(selection: { anchor: number; head: number }) {
  emit("selectionStateChange", selection);
}

function flushEditorSelection() {
  if (view.value) latestSelection = readEditorSelection(view.value);
  if (latestSelection) emitEditorSelection(latestSelection);
}

function restoreEditorSelection() {
  const selection = normalizedEditorSelection(props.initialSelection ?? latestSelection, props.modelValue.length);
  if (!view.value || !selection) return;
  view.value.dispatch({ selection });
}

function restoreEditorFocus() {
  const focusEditorAcrossFrames = () => {
    if (!view.value || view.value.hasFocus) return;
    view.value.focus();
  };
  focusEditorAcrossFrames();
  nextTick(() => {
    focusEditorAcrossFrames();
    requestAnimationFrame(focusEditorAcrossFrames);
  });
}

function emitEditorViewport(viewport: { scrollTop: number; scrollLeft: number }) {
  emit("viewportChange", viewport);
}

function scheduleEditorViewportEmit() {
  if (!view.value || !editorIsActive) return;
  latestViewport = readEditorViewport(view.value);
  if (viewportEmitFrame !== null) return;
  viewportEmitFrame = requestAnimationFrame(() => {
    viewportEmitFrame = null;
    if (latestViewport) emitEditorViewport(latestViewport);
  });
}

function flushEditorViewport() {
  if (viewportEmitFrame !== null) {
    cancelAnimationFrame(viewportEmitFrame);
    viewportEmitFrame = null;
  }
  if (latestViewport) emitEditorViewport(latestViewport);
}

function restoreEditorViewport() {
  const viewport = props.initialViewport ?? latestViewport;
  if (!view.value || !viewport) return;
  const restoreScroll = () => {
    if (!view.value) return;
    view.value.scrollDOM.scrollTo({
      top: viewport.scrollTop,
      left: viewport.scrollLeft,
    });
    view.value.scrollDOM.scrollTop = viewport.scrollTop;
    view.value.scrollDOM.scrollLeft = viewport.scrollLeft;
  };

  if (viewportRestoreFrame !== null) cancelAnimationFrame(viewportRestoreFrame);
  restoreScroll();
  nextTick(() => {
    restoreScroll();
    let attempts = 0;
    const restoreNextFrame = () => {
      restoreScroll();
      attempts += 1;
      if (attempts >= 8) {
        viewportRestoreFrame = null;
        return;
      }
      viewportRestoreFrame = requestAnimationFrame(restoreNextFrame);
    };
    viewportRestoreFrame = requestAnimationFrame(restoreNextFrame);
  });
}

function openSearch(): boolean {
  return searchPanelRef.value?.openSearch() ?? false;
}

function openReplace(): boolean {
  return searchPanelRef.value?.openReplace() ?? false;
}

function scrollCursorIntoView() {
  if (!view.value || !editorViewModule || !editorIsActive) return;
  const pos = view.value.state.selection.main.head;
  view.value.dispatch({
    effects: editorViewModule.EditorView.scrollIntoView(pos, { y: "nearest" }),
  });
}

defineExpose({ openSearch, openReplace, scrollCursorIntoView, requestExecute });
</script>

<template>
  <div class="h-full w-full overflow-hidden relative" @gesturestart="onEditorGestureStart" @gesturechange="onEditorGestureChange" @gestureend="onEditorGestureEnd">
    <CustomContextMenu :items="contextMenuItems" v-slot="{ onContextMenu }">
      <div
        ref="editorRef"
        data-query-editor-root
        class="h-full w-full overflow-hidden"
        @contextmenu="
          (e: MouseEvent) => {
            if (view) syncContextMenuStateAtEvent(view, e);
            onContextMenu(e);
          }
        "
      />
    </CustomContextMenu>
    <EditorSearchPanel ref="searchPanelRef" :view="view" />
    <SqlExecutionTargetPicker v-if="pickerVisible" :candidates="pickerCandidates" :active-index="pickerActiveIndex" :anchor="pickerAnchor" @update:active-index="onPickerActiveIndexChange" @confirm="onPickerConfirm" @cancel="closePicker" />
  </div>
</template>

<style scoped>
.query-editor--table-navigation-hover :deep(.cm-content),
.query-editor--table-navigation-hover :deep(.cm-line) {
  cursor: pointer;
}

:deep(.cm-db-execution-preview) {
  background: var(--dbx-editor-selection-background, rgba(59, 130, 246, 0.35));
}

:deep(.cm-foldMarker-svg) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  width: 16px;
  height: 16px;
  color: var(--muted-foreground);
  opacity: 0.65;
  transition: opacity 0.15s;
}

:deep(.cm-foldMarker-svg:hover) {
  opacity: 0.95;
}

:deep(.cm-foldMarker-svg svg) {
  display: block;
  width: 16px;
  height: 16px;
}
</style>
