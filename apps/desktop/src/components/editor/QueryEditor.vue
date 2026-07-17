<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, shallowRef, computed, nextTick } from "vue";
import { CaseLower, CaseUpper, Code2, FileCode, Pencil, PencilRuler, Play, Copy, List, Search, Sparkles, Table2, TextSelect, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { CompletionContext } from "@codemirror/autocomplete";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { search as cmSearch } from "@codemirror/search";
import EditorSearchPanel from "./EditorSearchPanel.vue";
import SqlExecutionTargetPicker from "./SqlExecutionTargetPicker.vue";
import DelimitedListDialog from "./DelimitedListDialog.vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { copyToClipboard, readTextFromClipboard } from "@/lib/common/clipboard";
import { resolveExecutableSql, type SqlExecutionSnapshot, type SqlExecutionOverride, type SqlExecutionCandidate } from "@/lib/sql/sqlExecutionTarget";
import { buildExecutionCandidates, hasMultipleExecutionTargets, supportsExecutionTargetPicker, type SqlTextRange } from "@/lib/sql/sqlStatementRanges";
import { executableStatementRangeAtCursor, executableStatementRangeCacheForDoc, executableStatementRangeStartingAt as executableStatementRangeStartingAtLine, type ExecutableStatementRangeCache } from "@/lib/sql/executableStatementRangeCache";
import { currentStatementFrameRangeTo, visualSqlColumnsWithInlineHints } from "@/lib/sql/currentStatementFrame";
import { expandToSqlStatementWindow, parseInsertValueHints } from "@/lib/sql/insertValueHints";
import { formatSqlText, type SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import { blankLineDeletionChanges, replaceSelectedEditorText } from "@/lib/editor/queryEditorTextEdits";
import { buildSqlInConditionFromPasteSource, insertTextForSqlInCondition } from "@/lib/sql/sqlInListPaste";
import { resolveSqlSingleQuoteKeyAction } from "@/lib/sql/sqlQuoteCaret";
import { formatMongoShellText } from "@/lib/mongo/mongoFormatter";
import { useConnectionStore, COMPLETION_METADATA_CONCURRENCY } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import {
  buildSqlCompletionItemsFromContext,
  getSqlFunctionSignatureHelp,
  getSqlCompletionContext,
  getSqlCompletionResultValidFor,
  isSqlCompletionSuppressedContext,
  isSqlLikeCompletionStatement,
  recordCompletionSelection,
  shouldAutoOpenSqlCompletion,
  shouldChainSqlCompletionAfterAccept,
  extractCteDefinitions,
} from "@/lib/sql/sqlCompletion";
import { sqlCompletionContextFromSemantic } from "@/lib/sql/semantic/completion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { mergeSqlSemanticReferenceAnalysis, resolveSqlSemanticNavigationTarget } from "@/lib/sql/semantic/references";
import { buildElasticsearchCompletionItemsFromContext, getElasticsearchCompletionContext, getElasticsearchCompletionResultValidFor, shouldAutoOpenElasticsearchCompletion, type ElasticsearchCompletionItem } from "@/lib/elasticsearch/elasticsearchCompletion";
import { buildMongoCompletionItemsFromContext, getMongoCompletionContext, getMongoCompletionResultValidFor, mongoCompletionNeedsCollections, mongoCompletionNeedsFields, shouldAutoOpenMongoCompletion, type MongoCompletionItem } from "@/lib/mongo/mongoCompletion";
import { resolveSqlCompletionTableLookupTarget } from "@/lib/sql/sqlCompletionLookupTarget";
import { extractIdentifierDetailsAt, isSqlKeyword, matchTable, mergeSqlObjectNavigationType, splitQualifiedIdentifier, sqlObjectHoverDetail, sqlObjectNavigationTarget, type SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";
import { lineColumnToOffset, parseSqlErrorLocation } from "@/lib/sql/sqlDiagnostics";
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
} from "@/lib/editor/queryEditorTableDrop";
import { EDITOR_FONT_FAMILY_CSS_VAR, EDITOR_FONT_SIZE_CSS_VAR, createRunStatementButtonDom, loadEditorTheme, editorFontTheme, sqlCompletionTheme, sqlSemanticHighlightTheme } from "@/lib/editor/editorThemes";
import { clampEditorFontSize, createEditorZoomCommitScheduler, fontSizeFromGestureScale, fontSizeFromWheelDelta } from "@/lib/editor/editorZoom";
import { normalizeShortcutSettings, shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";
import { trimmedSelectionLayer } from "@/lib/editor/codemirrorTrimmedSelectionLayer";
import { selectionMatchOccurrences } from "@/lib/editor/codemirrorSelectionMatches";
import { createInsertValueHintsExtension, requestInsertValueHintsRefresh } from "@/lib/editor/codemirrorInsertValueHints";
import { focusEditorView } from "@/lib/editor/queryEditorFocus";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { sqlSemanticTableNameSpansForSyntaxTree } from "@/lib/editor/codemirrorSqlSemanticHighlight";
import { startsQueryEditorRectangularSelection } from "@/lib/editor/queryEditorPointerSelection";
import type { StatementExecutionMarker } from "@/lib/tabs/tabPresentation";
import { isSchemaAware, isSingleDatabase, supportsSqlInListPaste } from "@/lib/database/databaseFeatureSupport";
import { usesLocalOnlyEditorCompletionMetadata, usesOnDemandOnlyEditorColumnMetadata } from "@/lib/metadata/completionMetadataPolicy";
import { queryContextObjectActions, queryContextObjectRoute, queryTableCandidateAtSqlPosition, resolveQueryContextCandidateDatabase, resolveQueryContextObjectTarget, type QueryContextObjectAction } from "@/lib/sql/queryCursorTableTarget";
import * as api from "@/lib/backend/api";
import { areSqlSemanticDiagnosticsEqual, buildSqlParserErrorDiagnostic, buildSqlSemanticDiagnostics, isSqlSemanticDiagnosticInputContext, shouldRunSqlSemanticDiagnostics, sqlSemanticDiagnosticRangesForViewport, tableReferenceKey, type SqlSemanticDiagnostic } from "@/lib/sql/semantic/diagnostics";
import { buildRedisSyntaxDiagnostics, shouldRunRedisDiagnostics } from "@/lib/redis/redisSyntaxDiagnostics";
import { buildRedisCompletionItemsFromContext, getRedisCompletionContext, getRedisCompletionResultValidFor, shouldAutoOpenRedisCompletion, takesKeyArgument, type RedisCompletionItem } from "@/lib/redis/redisCompletion";
import type { SqlCompletionColumn, SqlCompletionForeignKey, SqlCompletionItem, SqlCompletionObject, SqlCompletionReferencedTable, SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import type { DatabaseType, SqlReferenceAnalysis, SqlTableReference, SqlTextSpan } from "@/types/database";

const props = defineProps<{
  modelValue: string;
  connectionId?: string;
  database?: string;
  schema?: string;
  databaseType?: DatabaseType;
  dialect?: "mysql" | "postgres" | "sqlserver";
  syntaxDialect?: "mysql" | "postgres" | "sqlserver";
  formatDialect?: SqlFormatDialect;
  formatRequestId?: number;
  executionError?: string;
  executionErrorSql?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  forceWordWrap?: boolean;
  hideExecutionControls?: boolean;
  initialViewport?: { scrollTop: number; scrollLeft: number };
  initialSelection?: { anchor: number; head: number };
  statementExecutionMarkers?: StatementExecutionMarker[];
}>();

const COMPLETION_REMOTE_LATENCY_BUDGET_MS = 120;
// Internal rollback switch: flip to false to route completion, diagnostics, and navigation through the legacy SQL context path.
const SEMANTIC_SQL_COMPLETION_ENABLED = true;

const emit = defineEmits<{
  "update:modelValue": [value: string];
  selectionChange: [value: string];
  cursorChange: [pos: number];
  formatError: [message: string];
  execute: [source: SqlExecutionOverride];
  save: [];
  clickTable: [target: SqlObjectNavigationTarget];
  viewTableData: [target: SqlObjectNavigationTarget];
  viewTableDdl: [target: SqlObjectNavigationTarget];
  editTableStructure: [target: SqlObjectNavigationTarget];
  openObjectSource: [target: SqlObjectNavigationTarget, initialEditing: boolean];
  clickColumn: [columns: Array<{ name: string; table: string; schema?: string }>, error?: string | undefined];
  closeColumnPanel: [];
  viewportChange: [viewport: { scrollTop: number; scrollLeft: number }];
  selectionStateChange: [selection: { anchor: number; head: number }];
  sendSelectionToAi: [sql: string];
}>();

const editorRef = ref<HTMLDivElement>();
const view = shallowRef<EditorViewType | null>(null);
let viewportEmitFrame: number | null = null;
let viewportRestoreFrame: number | null = null;
let latestViewport: { scrollTop: number; scrollLeft: number } | undefined = props.initialViewport;
let lastEmittedViewport: { scrollTop: number; scrollLeft: number } | undefined = props.initialViewport;
let latestSelection: { anchor: number; head: number } | undefined = props.initialSelection;
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();
const { isDark, themePalette } = useTheme();
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
const PRESTO_ON_DEMAND_TABLE_COMPLETION_MIN_PREFIX = 2;
const PRESTO_ON_DEMAND_TABLE_COMPLETION_LIMIT = 20;
const MAX_JOIN_FK_PREFETCH_TABLES = 24;
const MAX_SEMANTIC_DIAGNOSTIC_COLUMN_TABLES = 4;
const liveFontSize = ref(settingsStore.editorSettings.fontSize);
const gestureStartFontSize = ref(settingsStore.editorSettings.fontSize);
const isGestureZooming = ref(false);

const searchPanelRef = ref<InstanceType<typeof EditorSearchPanel>>();
const selectedSql = ref("");
const executableSql = ref("");
const contextObjectTarget = ref<SqlObjectNavigationTarget | null>(null);

const hasSelectedSql = computed(() => selectedSql.value.trim().length > 0);
const canCopySelectedSql = computed(() => selectedSql.value.length > 0);
const canExecuteContextSql = computed(() => executableSql.value.trim().length > 0);

// Execution target picker state
const pickerVisible = ref(false);
const pickerCandidates = ref<SqlExecutionCandidate[]>([]);
const pickerActiveIndex = ref(0);
const pickerAnchor = ref<{ left: number; top: number }>();

// Delimited list dialog state
const delimitedListOpen = ref(false);
const delimitedListSelectedText = ref("");

function openDelimitedListDialog() {
  if (props.readOnly) return;
  if (!selectedSql.value.trim()) {
    toast(t("editor.delimitedList.selectFirst"), 3000);
    return;
  }
  delimitedListSelectedText.value = selectedSql.value;
  delimitedListOpen.value = true;
  focusEditor();
}

function applyDelimitedListResult(result: string) {
  const currentView = view.value;
  if (!currentView || props.readOnly) return;
  if (!replaceSelectedEditorText(currentView, result)) return;
  focusEditor();
}

const executeContextMenuLabel = computed(() => t(hasSelectedSql.value ? "editor.contextMenu.executeSelection" : "editor.contextMenu.executeCurrent"));

interface EditorGestureEvent extends Event {
  scale?: number;
}

let editorViewModule: typeof import("@codemirror/view") | null = null;
let codeMirrorPrec: typeof import("@codemirror/state").Prec | null = null;
let codeMirrorEditorSelection: typeof import("@codemirror/state").EditorSelection | null = null;
let fontThemeComp: import("@codemirror/state").Compartment | null = null;
let codeMirrorTheme: import("@codemirror/state").Compartment | null = null;
let wordWrapComp: import("@codemirror/state").Compartment | null = null;
let vimModeComp: import("@codemirror/state").Compartment | null = null;
let closeBracketsComp: import("@codemirror/state").Compartment | null = null;
let sqlLanguageComp: import("@codemirror/state").Compartment | null = null;
let sqlSemanticHighlightComp: import("@codemirror/state").Compartment | null = null;
let codeMirrorCloseBrackets: typeof import("@codemirror/autocomplete").closeBrackets | null = null;
let codeMirrorCloseBracketsKeymap: readonly import("@codemirror/view").KeyBinding[] | null = null;
let readOnlyComp: import("@codemirror/state").Compartment | null = null;
let runGutterComp: import("@codemirror/state").Compartment | null = null;
let statementExecutionGutterComp: import("@codemirror/state").Compartment | null = null;
let runKeymapComp: import("@codemirror/state").Compartment | null = null;
let completionComp: import("@codemirror/state").Compartment | null = null;
let diagnosticComp: import("@codemirror/state").Compartment | null = null;
let codeMirrorVim: typeof import("@replit/codemirror-vim").vim | null = null;
let codeMirrorVimApi: typeof import("@replit/codemirror-vim").Vim | null = null;
let codeMirrorGetVimCm: typeof import("@replit/codemirror-vim").getCM | null = null;
let codeMirrorVimImportPromise: Promise<typeof import("@replit/codemirror-vim")> | null = null;
let dbxVimCommandsConfigured = false;
let buildSqlDiagnosticExtension: (() => import("@codemirror/state").Extension) | null = null;
let buildSqlSignatureExtension: (() => import("@codemirror/state").Extension) | null = null;
let buildSqlCompletionExtension: (() => import("@codemirror/state").Extension) | null = null;
let buildSqlLanguageExtension: (() => import("@codemirror/state").Extension) | null = null;
let buildSqlSemanticHighlightExtension: (() => import("@codemirror/state").Extension) | null = null;
let codeMirrorSnippetCompletion: typeof import("@codemirror/autocomplete").snippetCompletion;
let codeMirrorCompletionStatus: typeof import("@codemirror/autocomplete").completionStatus | null = null;
let codeMirrorAcceptCompletion: typeof import("@codemirror/autocomplete").acceptCompletion | null = null;
let codeMirrorStartCompletion: typeof import("@codemirror/autocomplete").startCompletion | null = null;
let codeMirrorInsertCompletionText: typeof import("@codemirror/autocomplete").insertCompletionText | null = null;
let codeMirrorNextSnippetField: typeof import("@codemirror/autocomplete").nextSnippetField | null = null;
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
let codeMirrorToggleLineComment: typeof import("@codemirror/commands").toggleLineComment | null = null;
let setSqlDiagnosticsEffect: import("@codemirror/state").StateEffectType<SqlSemanticDiagnostic[]> | null = null;
let setPreviewRangeEffect:
  | import("@codemirror/state").StateEffectType<{
      from: number;
      to: number;
    } | null>
  | null = null;
let setResultSourceRangeEffect:
  | import("@codemirror/state").StateEffectType<{
      from: number;
      to: number;
    } | null>
  | null = null;
let setStatementExecutionMarkersEffect: import("@codemirror/state").StateEffectType<StatementExecutionMarker[]> | null = null;
let previewRangeComp: import("@codemirror/state").Compartment | null = null;
let buildPreviewRangeExtension: (() => import("@codemirror/state").Extension) | null = null;
let buildResultSourceRangeExtension: (() => import("@codemirror/state").Extension) | null = null;
let buildStatementExecutionMarkersExtension: (() => import("@codemirror/state").Extension) | null = null;
let buildRunStatementGutterExtension: (() => import("@codemirror/state").Extension) | null = null;
let indentComp: import("@codemirror/state").Compartment | null = null;
let codeMirrorIndentUnit: typeof import("@codemirror/language").indentUnit | null = null;
let semanticDiagnostics: SqlSemanticDiagnostic[] = [];
let semanticDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;
let semanticDiagnosticRunId = 0;
let pendingSemanticDiagnosticPreserveOutsideRanges = false;
let editorIsActive = true;
let tableReferenceDropListenerRegistered = false;
let imeCompositionActive = false;
let pendingImeModelEmit = false;

type SelectionCaseMode = "upper" | "lower";
let executableStatementRangeCache: ExecutableStatementRangeCache | null = null;
let editorScrollbarPointerCleanup: (() => void) | null = null;
let editorSelectionDragCleanup: (() => void) | null = null;
let editorSelectionDropCursorEl: HTMLDivElement | null = null;
const EDITOR_SCROLLBAR_POINTER_GUTTER_PX = 18;
const EDITOR_SELECTION_DRAG_THRESHOLD_PX = 6;
const tableNavigationHoverClass = "query-editor--table-navigation-hover";
const DBX_VIM_SAVE_EVENT = "dbx-vim-save";

function editorThemeAppearance() {
  return isDark.value ? "dark" : "light";
}

// Completion cache
let cachedTables: SqlCompletionTable[] = [];
let cachedCompletionObjects: SqlCompletionObject[] = [];
// Persistent column cache keyed by "schema.table" or "table"
const cachedColumnsByTable = new Map<string, SqlCompletionColumn[]>();
const cachedForeignKeysByTable = new Map<string, SqlCompletionForeignKey[]>();
const loadedColumnsByTable = new Set<string>();

const zoomCommitScheduler = createEditorZoomCommitScheduler((fontSize) => {
  if (settingsStore.editorSettings.fontSize === fontSize) return;
  settingsStore.updateEditorSettings({ fontSize });
});

const queryEditorAppearanceSettings = computed(() => {
  const settings = settingsStore.editorSettings;
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    theme: settings.theme,
    customThemeColors: settings.customThemeColors,
    customThemes: settings.customThemes,
    activeCustomThemeId: settings.activeCustomThemeId,
    wordWrap: settings.wordWrap,
    vimModeEnabled: settings.vimModeEnabled,
    autoCloseBrackets: settings.autoCloseBrackets,
    showCurrentStatementFrame: settings.showCurrentStatementFrame,
    showInsertValueHints: settings.showInsertValueHints,
    shortcuts: settings.shortcuts,
    showStatementRunButtons: settings.showStatementRunButtons,
  };
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

// Resolve the indent unit (one Tab worth) from the SQL formatter settings so
// the Tab key, multi-line indent and auto-indent all honor the configured width.
function editorIndentUnit(): string {
  const { useTabs, tabWidth } = settingsStore.editorSettings.sqlFormatter;
  return useTabs ? "\t" : " ".repeat(tabWidth);
}

function handleTab(view: EditorViewType): boolean {
  if (codeMirrorCompletionStatus?.(view.state) === "active") return false;
  const { state, dispatch } = view;
  const sel = state.selection.main;
  if (!sel.empty) return codeMirrorIndentMore?.(view) ?? false;
  const line = state.doc.lineAt(sel.from);
  const before = line.text.slice(0, sel.from - line.from);
  if (/^\s*$/.test(before)) return codeMirrorIndentMore?.(view) ?? false;
  dispatch(
    state.update(state.replaceSelection(editorIndentUnit()), {
      userEvent: "input.type",
    }),
  );
  return true;
}

interface RequestExecuteOptions {
  forceCurrent?: boolean;
  ignoreSelection?: boolean;
}

function requestExecute(options: RequestExecuteOptions = {}) {
  const currentView = view.value;
  if (!currentView) return false;
  return requestExecuteFromView(currentView, currentView.state.selection.main.head, options);
}

function requestExecuteFromView(currentView: EditorViewType, cursorPos: number, options: RequestExecuteOptions = {}) {
  const selection = currentView.state.selection.main;
  if (!options.ignoreSelection && !selection.empty) {
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
  const candidates = buildExecutionCandidates(doc, cursorPos, props.databaseType);
  if (candidates.length === 0) return false;
  if (options.forceCurrent) {
    const candidate = candidates.find((item) => item.kind === "cursor") ?? candidates[0];
    emit("execute", candidate.sql);
    return true;
  }
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

function sqlSingleQuoteKeyActionAt(state: EditorViewType["state"], position: number) {
  return resolveSqlSingleQuoteKeyAction({
    previousChar: position > 0 ? state.doc.sliceString(position - 1, position) : "",
    nextChar: position < state.doc.length ? state.doc.sliceString(position, position + 1) : "",
    autoCloseBrackets: settingsStore.editorSettings.autoCloseBrackets,
  });
}

function handleSqlSingleQuote(view: EditorViewType): boolean {
  const { state } = view;
  const EditorSelection = codeMirrorEditorSelection;
  if (state.readOnly || !EditorSelection) return false;
  if (state.selection.ranges.some((range) => !range.empty)) return false;
  if (state.selection.ranges.some((range) => sqlSingleQuoteKeyActionAt(state, range.from) === "pass")) return false;
  const transaction = state.changeByRange((range) => {
    const nextRange = EditorSelection.cursor(range.from + 1);
    if (sqlSingleQuoteKeyActionAt(state, range.from) !== "insertEscapedQuote") return { range: nextRange };
    return {
      changes: { from: range.from, insert: "'" },
      range: nextRange,
    };
  });
  view.dispatch(transaction, { userEvent: "input.type" });
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

function setResultSourceRange(range: { from: number; to: number } | null) {
  if (!view.value || !setResultSourceRangeEffect) return;
  view.value.dispatch({
    effects: setResultSourceRangeEffect.of(range),
  });
}

function previewStatementRange(range: { from: number; to: number } | null) {
  const currentView = view.value;
  if (!range || !currentView || !editorViewModule || !setResultSourceRangeEffect) {
    setResultSourceRange(null);
    return;
  }

  const from = Math.max(0, Math.min(range.from, currentView.state.doc.length));
  const to = Math.max(from, Math.min(range.to, currentView.state.doc.length));
  if (from === to) {
    setResultSourceRange(null);
    return;
  }

  currentView.dispatch({
    selection: { anchor: from },
    effects: [setResultSourceRangeEffect.of({ from, to }), editorViewModule.EditorView.scrollIntoView(from, { y: "center" })],
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
  if (pos == null) {
    contextObjectTarget.value = null;
    return;
  }

  const sql = currentView.state.doc.toString();
  if (!props.connectionId || props.database == null) {
    const candidate = queryTableCandidateAtSqlPosition({
      connectionId: "",
      database: props.database ?? "",
      schema: props.schema,
      databaseType: props.databaseType,
      sql,
      position: pos,
    });
    contextObjectTarget.value = candidate
      ? {
          name: candidate.tableName,
          database: candidate.database,
          schema: candidate.schema,
        }
      : null;
    return;
  }

  const parsedCandidate = queryTableCandidateAtSqlPosition({
    connectionId: props.connectionId,
    database: props.database,
    schema: props.schema,
    databaseType: props.databaseType,
    sql,
    position: pos,
  });
  if (!parsedCandidate) {
    contextObjectTarget.value = null;
    return;
  }

  // Right-click must stay instant: resolve from completion/tree caches and keep the legacy table fallback when metadata is unavailable.
  const candidate = resolveQueryContextCandidateDatabase(parsedCandidate, connectionStore.lookupLocalCompletionDatabases(parsedCandidate.connectionId, parsedCandidate.database, MAX_COMPLETION_TABLES));
  const tables = connectionStore.lookupLocalCompletionTables(candidate.connectionId, candidate.database, candidate.tableName, MAX_COMPLETION_TABLES, candidate.schema);
  contextObjectTarget.value = resolveQueryContextObjectTarget(candidate, tables);
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
  const extracted = extractIdentifierDetailsAt(currentView.state.doc.toString(), pos);
  if (!extracted || (!extracted.quoted && isSqlKeyword(extracted.identifier))) return null;
  return extracted.identifier;
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

function isEditorScrollbarPointerEvent(currentView: EditorViewType, event: MouseEvent) {
  if (event.button !== 0) return false;
  const scrollDOM = currentView.scrollDOM;
  const rect = scrollDOM.getBoundingClientRect();
  const hasVerticalScrollbar = scrollDOM.scrollHeight > scrollDOM.clientHeight + 1;
  const hasHorizontalScrollbar = scrollDOM.scrollWidth > scrollDOM.clientWidth + 1;
  const verticalGutter = Math.max(scrollDOM.offsetWidth - scrollDOM.clientWidth, EDITOR_SCROLLBAR_POINTER_GUTTER_PX);
  const horizontalGutter = Math.max(scrollDOM.offsetHeight - scrollDOM.clientHeight, EDITOR_SCROLLBAR_POINTER_GUTTER_PX);
  const inVerticalScrollbar = hasVerticalScrollbar && event.clientX >= rect.right - verticalGutter && event.clientX <= rect.right;
  const inHorizontalScrollbar = hasHorizontalScrollbar && event.clientY >= rect.bottom - horizontalGutter && event.clientY <= rect.bottom;
  return inVerticalScrollbar || inHorizontalScrollbar;
}

function registerEditorScrollbarPointerGuard(currentView: EditorViewType) {
  editorScrollbarPointerCleanup?.();
  const onPointerDown = (event: MouseEvent) => {
    if (!isEditorScrollbarPointerEvent(currentView, event)) return;
    clearTableNavigationHover();
    event.stopPropagation();
  };
  currentView.scrollDOM.addEventListener("mousedown", onPointerDown, true);
  editorScrollbarPointerCleanup = () => {
    currentView.scrollDOM.removeEventListener("mousedown", onPointerDown, true);
    editorScrollbarPointerCleanup = null;
  };
}

function selectedRangeAtPointer(currentView: EditorViewType, event: MouseEvent) {
  if (props.readOnly || event.button !== 0) return null;
  if (!currentView.contentDOM.contains(event.target as Node | null)) return null;
  const range = currentView.state.selection.main;
  if (range.empty) return null;
  const pos = currentView.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  if (pos == null || pos < range.from || pos > range.to) return null;
  return {
    from: range.from,
    to: range.to,
    text: currentView.state.sliceDoc(range.from, range.to),
  };
}

function moveOrCopySelectionToPointer(currentView: EditorViewType, selection: { from: number; to: number; text: string }, event: MouseEvent) {
  const dropPos = currentView.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  if (dropPos == null) return false;
  const copy = event.ctrlKey || event.metaKey;
  if (!copy && dropPos >= selection.from && dropPos <= selection.to) return true;

  const insert = { from: dropPos, insert: selection.text };
  const changes = copy ? currentView.state.changes(insert) : currentView.state.changes([{ from: selection.from, to: selection.to }, insert]);
  currentView.dispatch({
    changes,
    selection: {
      anchor: changes.mapPos(dropPos, -1),
      head: changes.mapPos(dropPos, 1),
    },
    scrollIntoView: true,
    userEvent: copy ? "input.drop" : "move.drop",
  });
  currentView.focus();
  return true;
}

function hideEditorSelectionDropCursor() {
  editorSelectionDropCursorEl?.remove();
  editorSelectionDropCursorEl = null;
}

function updateEditorSelectionDropCursor(currentView: EditorViewType, event: MouseEvent) {
  const pos = currentView.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  if (pos == null) {
    hideEditorSelectionDropCursor();
    return;
  }
  const coords = currentView.coordsAtPos(pos);
  if (!coords) {
    hideEditorSelectionDropCursor();
    return;
  }
  const ownerDocument = currentView.dom.ownerDocument;
  const cursor = editorSelectionDropCursorEl ?? ownerDocument.createElement("div");
  if (!editorSelectionDropCursorEl) {
    cursor.setAttribute("aria-hidden", "true");
    cursor.className = "dbx-editor-selection-drop-cursor";
    // Use a fixed overlay instead of CodeMirror's internal drop cursor layer so
    // the marker stays visible above selection layers, themes, and scrollers.
    cursor.style.position = "fixed";
    cursor.style.zIndex = "2147483647";
    cursor.style.width = "2px";
    cursor.style.pointerEvents = "none";
    cursor.style.backgroundImage = "repeating-linear-gradient(to bottom, #e879f9 0 4px, transparent 4px 7px)";
    cursor.style.filter = "drop-shadow(0 0 1px rgba(0, 0, 0, 0.7))";
    ownerDocument.body.appendChild(cursor);
    editorSelectionDropCursorEl = cursor;
  }
  cursor.style.left = `${Math.round(coords.left) - 1}px`;
  cursor.style.top = `${Math.round(coords.top)}px`;
  cursor.style.height = `${Math.max(16, Math.round(coords.bottom - coords.top))}px`;
}

function startEditorSelectionDrag(currentView: EditorViewType, event: MouseEvent): boolean {
  const selection = selectedRangeAtPointer(currentView, event);
  if (!selection) return false;

  event.preventDefault();
  event.stopPropagation();
  if (!event.ctrlKey && !event.metaKey) {
    emit("closeColumnPanel");
  }
  editorSelectionDragCleanup?.();
  const startX = event.clientX;
  const startY = event.clientY;
  let dragging = false;

  const cleanup = () => {
    currentView.contentDOM.ownerDocument.removeEventListener("mousemove", onMove, true);
    currentView.contentDOM.ownerDocument.removeEventListener("mouseup", onUp, true);
    currentView.contentDOM.ownerDocument.removeEventListener("keydown", onKeyDown, true);
    hideEditorSelectionDropCursor();
    editorSelectionDragCleanup = null;
  };

  const onMove = (moveEvent: MouseEvent) => {
    const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
    if (!dragging && distance < EDITOR_SELECTION_DRAG_THRESHOLD_PX) return;
    dragging = true;
    if (moveEvent.ctrlKey || moveEvent.metaKey) {
      currentView.contentDOM.style.cursor = "copy";
    } else {
      currentView.contentDOM.style.cursor = "move";
    }
    updateEditorSelectionDropCursor(currentView, moveEvent);
    moveEvent.preventDefault();
    moveEvent.stopImmediatePropagation();
  };

  const onUp = (upEvent: MouseEvent) => {
    cleanup();
    currentView.contentDOM.style.cursor = "";
    upEvent.preventDefault();
    upEvent.stopImmediatePropagation();
    if (dragging) {
      moveOrCopySelectionToPointer(currentView, selection, upEvent);
      return;
    }
    const pos = currentView.posAtCoords({
      x: upEvent.clientX,
      y: upEvent.clientY,
    });
    if (pos != null) {
      currentView.dispatch({
        selection: { anchor: pos },
        userEvent: "select.pointer",
      });
      currentView.focus();
    }
  };

  const onKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape") return;
    cleanup();
    currentView.contentDOM.style.cursor = "";
    keyEvent.preventDefault();
    keyEvent.stopImmediatePropagation();
  };

  currentView.contentDOM.ownerDocument.addEventListener("mousemove", onMove, true);
  currentView.contentDOM.ownerDocument.addEventListener("mouseup", onUp, true);
  currentView.contentDOM.ownerDocument.addEventListener("keydown", onKeyDown, true);
  editorSelectionDragCleanup = () => {
    cleanup();
    currentView.contentDOM.style.cursor = "";
  };
  return true;
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

function convertSelectedSqlCase(mode: SelectionCaseMode): boolean {
  const currentView = view.value;
  const EditorSelection = codeMirrorEditorSelection;
  if (!currentView || !EditorSelection) return false;

  const state = currentView.state;
  const transaction = state.changeByRange((range) => {
    if (range.empty) return { range };

    const selectedText = state.sliceDoc(range.from, range.to);
    const convertedText = mode === "upper" ? selectedText.toUpperCase() : selectedText.toLowerCase();
    return {
      changes: { from: range.from, to: range.to, insert: convertedText },
      range: EditorSelection.range(range.from, range.from + convertedText.length),
    };
  });

  if (!transaction.changes.empty) {
    currentView.dispatch({
      ...transaction,
      scrollIntoView: true,
      userEvent: "input",
    });
    focusEditor();
    return true;
  }
  return false;
}

async function pasteClipboardAsSqlInCondition(): Promise<boolean> {
  if (!supportsSqlInListPaste(props.databaseType)) return false;
  if (props.readOnly) return false;
  const currentView = view.value;
  if (!currentView) return false;

  const selection = currentView.state.selection.main;
  const selectedSource = selection.empty ? "" : currentView.state.sliceDoc(selection.from, selection.to);
  let source = selectedSource;
  if (!source) {
    try {
      source = await readTextFromClipboard();
    } catch (e: any) {
      toast(
        t("editor.exPasteClipboardReadFailed", {
          message: e?.message || String(e),
        }),
        5000,
      );
      focusEditor();
      return false;
    }
  }

  const result = buildSqlInConditionFromPasteSource(source);
  if (!result.ok) {
    const key = result.reason === "too-large" ? "editor.exPasteTooLarge" : result.reason === "too-many-values" ? "editor.exPasteTooManyValues" : result.reason === "not-list" ? "editor.exPasteNotList" : "editor.exPasteNoValues";
    toast(t(key, { limit: result.limit ?? 0 }), 5000);
    focusEditor();
    return false;
  }

  if (view.value !== currentView || props.readOnly) return false;
  const state = currentView.state;
  const line = state.doc.lineAt(selection.from);
  const prefix = state.sliceDoc(line.from, selection.from);
  const insertText = insertTextForSqlInCondition(result.sql, prefix);

  currentView.dispatch({
    changes: { from: selection.from, to: selection.to, insert: insertText },
    selection: { anchor: selection.from + insertText.length },
    scrollIntoView: true,
    userEvent: "input.paste",
  });
  currentView.focus();
  toast(t("editor.exPastePasted", { count: result.valueCount }), 2000);
  return true;
}

function deleteEmptyLines() {
  const currentView = view.value;
  if (!currentView || props.readOnly) return;

  const state = currentView.state;
  const selection = state.selection.main;
  const changes = blankLineDeletionChanges(state.doc, selection);
  if (changes.length === 0) return;

  currentView.dispatch({
    changes,
    scrollIntoView: true,
  });
  focusEditor();
}

function openFindReplaceFromContextMenu() {
  openSearch();
}

function emitContextObjectAction(action: QueryContextObjectAction) {
  if (!contextObjectTarget.value) return;
  const route = queryContextObjectRoute(action, contextObjectTarget.value);
  switch (route.event) {
    case "viewTableData":
      emit("viewTableData", route.payload[0]);
      break;
    case "editTableStructure":
      emit("editTableStructure", route.payload[0]);
      break;
    case "openObjectSource":
      emit("openObjectSource", route.payload[0], route.payload[1]);
      break;
    case "viewTableDdl":
      emit("viewTableDdl", route.payload[0]);
      break;
  }
  focusEditor();
}

function contextObjectMenuItem(action: QueryContextObjectAction): ContextMenuItem {
  const disabled = !contextObjectTarget.value;
  switch (action) {
    case "view-data":
      return {
        label: t("contextMenu.viewData"),
        action: () => emitContextObjectAction(action),
        disabled,
        icon: Table2,
      };
    case "edit-table-structure":
      return {
        label: t("contextMenu.editStructure"),
        action: () => emitContextObjectAction(action),
        disabled,
        icon: PencilRuler,
      };
    case "edit-view":
      return {
        label: t("contextMenu.editView"),
        action: () => emitContextObjectAction(action),
        disabled,
        icon: Pencil,
      };
    case "view-source":
      return {
        label: t("contextMenu.viewSource"),
        action: () => emitContextObjectAction(action),
        disabled,
        icon: Code2,
      };
    case "view-ddl":
      return {
        label: t("contextMenu.viewDdl"),
        action: () => emitContextObjectAction(action),
        disabled,
        icon: FileCode,
      };
  }
}

function executableStatementRangeStartingAt(currentView: EditorViewType, lineFrom: number) {
  executableStatementRangeCache = executableStatementRangeCacheForDoc(executableStatementRangeCache, currentView.state.doc, props.databaseType);
  return executableStatementRangeStartingAtLine(executableStatementRangeCache, lineFrom);
}

function currentExecutableStatementRange(currentView: EditorViewType): SqlTextRange | null {
  if (!supportsExecutionTargetPicker(props.databaseType)) return null;
  executableStatementRangeCache = executableStatementRangeCacheForDoc(executableStatementRangeCache, currentView.state.doc, props.databaseType);
  return executableStatementRangeAtCursor(executableStatementRangeCache, currentView.state.selection.main.head);
}

function executeSqlStatementFromGutter(currentView: EditorViewType, line: { from: number; to: number }, event: Event): boolean {
  if (!(event instanceof MouseEvent) || event.button !== 0) return false;
  const statementRange = executableStatementRangeStartingAt(currentView, line.from);
  if (!statementRange) return false;
  event.preventDefault();
  event.stopPropagation();
  // Gutter play is always scoped to the statement/command for that line, even
  // when the main editor execute action would run the full document.
  emit("execute", statementRange.sql);
  currentView.focus();
  return true;
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

const contextMenuItems = computed<ContextMenuItem[]>(() => {
  const shortcuts = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);
  return [
    ...(props.hideExecutionControls
      ? []
      : [
          {
            label: executeContextMenuLabel.value,
            action: executeFromContextMenu,
            disabled: !canExecuteContextSql.value,
            icon: Play,
            shortcut: shortcuts.executeSql,
          },
        ]),
    ...queryContextObjectActions(contextObjectTarget.value?.type).map(contextObjectMenuItem),
    { label: "", separator: true },
    {
      label: t("editor.contextMenu.copySelection"),
      action: copySelectedSqlFromContextMenu,
      disabled: !canCopySelectedSql.value,
      icon: Copy,
      shortcut: "Mod+C",
    },
    {
      label: t("editor.contextMenu.sendToAi"),
      action: () => {
        if (selectedSql.value.trim()) emit("sendSelectionToAi", selectedSql.value);
      },
      disabled: !canCopySelectedSql.value,
      icon: Sparkles,
      shortcut: shortcuts.sendSelectionToAi,
    },
    {
      label: t("editor.contextMenu.uppercaseSelection"),
      action: () => convertSelectedSqlCase("upper"),
      disabled: !canCopySelectedSql.value,
      icon: CaseUpper,
      shortcut: shortcuts.uppercaseSelection,
    },
    {
      label: t("editor.contextMenu.lowercaseSelection"),
      action: () => convertSelectedSqlCase("lower"),
      disabled: !canCopySelectedSql.value,
      icon: CaseLower,
      shortcut: shortcuts.lowercaseSelection,
    },
    {
      label: t("editor.contextMenu.delimitedList"),
      action: openDelimitedListDialog,
      disabled: props.readOnly || !canCopySelectedSql.value,
      icon: List,
    },
    { label: "", separator: true },
    {
      label: t("editor.contextMenu.findReplace"),
      action: openFindReplaceFromContextMenu,
      icon: Search,
      shortcut: shortcuts.find,
    },
    {
      label: t("editor.contextMenu.deleteEmptyLines"),
      action: deleteEmptyLines,
      disabled: props.readOnly,
      icon: Trash2,
    },
    { label: "", separator: true },
    {
      label: t("editor.contextMenu.selectAll"),
      action: selectAllSqlFromContextMenu,
      icon: TextSelect,
      shortcut: shortcuts.selectAll,
    },
  ];
});

function runKeymapExtension(codeMirrorKeymap: (typeof import("@codemirror/view"))["keymap"]) {
  const shortcuts = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);
  const Prec = codeMirrorPrec;
  const binding = (shortcut: string, run: (view: EditorViewType) => boolean) => (shortcut ? [{ key: shortcutToCodeMirrorKey(shortcut), preventDefault: true, run }] : []);
  const executeBindings = props.hideExecutionControls ? [] : binding(shortcuts.executeSql, () => requestExecute({ forceCurrent: true }));
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
        ...executeBindings,
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
        ...binding(shortcuts.uppercaseSelection, () => convertSelectedSqlCase("upper")),
        ...binding(shortcuts.lowercaseSelection, () => convertSelectedSqlCase("lower")),
        ...binding(shortcuts.toggleLineComment, (view) => codeMirrorToggleLineComment?.(view) ?? false),
        ...binding(shortcuts.exPasteSqlInCondition, () => {
          if (!supportsSqlInListPaste(props.databaseType)) return false;
          void pasteClipboardAsSqlInCondition();
          return true;
        }),
        ...binding(shortcuts.sendSelectionToAi, (currentView) => {
          const sql = selectedSqlFromView(currentView);
          if (sql.trim()) emit("sendSelectionToAi", sql);
          return true;
        }),
      ]),
    ) ?? [],
    codeMirrorKeymap.of(
      binding(shortcuts.acceptCompletion, acceptCompletionOrNextSnippetField).map((item) => ({
        ...item,
        preventDefault: false,
      })),
    ),
  ];
}

function acceptCompletionOrNextSnippetField(view: EditorViewType): boolean {
  if (codeMirrorCompletionStatus?.(view.state) && (codeMirrorAcceptCompletion?.(view) ?? false)) {
    return true;
  }
  // Table/column completions can happen inside a CodeMirror snippet field. When
  // the completion popup is gone, Tab should continue through the snippet fields.
  return codeMirrorNextSnippetField?.(view) ?? false;
}

function wordWrapExtension() {
  if (!editorViewModule) return [];
  return props.forceWordWrap || settingsStore.editorSettings.wordWrap ? editorViewModule.EditorView.lineWrapping : [];
}

function closeBracketsExtension(enabled = settingsStore.editorSettings.autoCloseBrackets) {
  if (!enabled || !codeMirrorCloseBrackets) return [];
  const exts: import("@codemirror/state").Extension[] = [codeMirrorCloseBrackets()];
  if (codeMirrorCloseBracketsKeymap?.length && codeMirrorPrec && editorViewModule) {
    exts.push(codeMirrorPrec.highest(editorViewModule.keymap.of([...codeMirrorCloseBracketsKeymap])));
  }
  return exts;
}

function vimModeExtension(enabled = settingsStore.editorSettings.vimModeEnabled) {
  if (!codeMirrorVim || !enabled) return [];
  const vimExtension = codeMirrorVim({ status: true });
  if (!codeMirrorPrec || !editorViewModule || !codeMirrorGetVimCm || !codeMirrorVimApi) return vimExtension;

  // Beekeeper treats Vim as a first-class editor keymap. Keep it above DBX's
  // normal shortcuts so regular normal-mode keys are not stolen by other maps.
  return codeMirrorPrec.highest([
    editorViewModule.keymap.of([
      {
        key: "Ctrl-[",
        mac: "Ctrl-[",
        linux: "Ctrl-[",
        win: "Ctrl-[",
        run(currentView) {
          const cm = codeMirrorGetVimCm?.(currentView);
          if (cm?.state.vim?.insertMode) {
            codeMirrorVimApi?.exitInsertMode(cm as any, true);
            return true;
          }
          return false;
        },
      },
    ]),
    vimExtension,
  ]);
}

function configureDbxVimCommands(vimApi: typeof import("@replit/codemirror-vim").Vim) {
  if (dbxVimCommandsConfigured) return;
  dbxVimCommandsConfigured = true;
  vimApi.defineEx("write", "w", (cm) => {
    cm.cm6?.contentDOM.dispatchEvent(new CustomEvent(DBX_VIM_SAVE_EVENT, { bubbles: true }));
  });
}

async function ensureCodeMirrorVim() {
  if (codeMirrorVim && codeMirrorVimApi && codeMirrorGetVimCm) return true;
  codeMirrorVimImportPromise ??= import("@replit/codemirror-vim");
  const { vim, Vim, getCM } = await codeMirrorVimImportPromise;
  codeMirrorVim = vim;
  codeMirrorVimApi = Vim;
  codeMirrorGetVimCm = getCM;
  configureDbxVimCommands(Vim);
  return true;
}

function indentExtension() {
  if (!codeMirrorIndentUnit) return [];
  return codeMirrorIndentUnit.of(editorIndentUnit());
}

function selectedSqlFromView(currentView: EditorViewType): string {
  const selection = currentView.state.selection.main;
  return currentView.state.sliceDoc(selection.from, selection.to);
}

function executableSqlFromView(currentView: EditorViewType): string {
  return resolveExecutableSql(currentView.state.doc.toString(), selectedSqlFromView(currentView));
}

function sqlExecutionSnapshotFromView(currentView: EditorViewType): SqlExecutionSnapshot {
  const selection = currentView.state.selection.main;
  return {
    fullSql: currentView.state.doc.toString(),
    selectedSql: selectedSqlFromView(currentView),
    cursorPos: selection.head,
    selectionFrom: selection.from,
    selectionTo: selection.to,
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

const pendingInsertValueHintColumnLoads = new Set<string>();

function insertHintCacheKey(table: { name: string; schema?: string | null; database?: string | null }) {
  if (table.database) {
    return table.schema ? `${table.database}.${table.schema}.${table.name}` : `${table.database}.${table.name}`;
  }
  return completionCacheKey(table);
}

function insertHintMetadataTarget(table: { name: string; schema?: string | null; database?: string | null }): { database: string; schema?: string } | null {
  if (props.database == null) return null;
  if (table.database) {
    return { database: table.database, schema: table.schema ?? undefined };
  }
  return completionMetadataTarget(table);
}

function getInsertValueHintTableColumns(table: string, schema?: string, database?: string): string[] | undefined {
  const cacheKey = insertHintCacheKey({ name: table, schema, database });
  const cached = cachedColumnsByTable.get(cacheKey);
  if (!cached) return undefined;
  return cached.map((column) => column.name);
}

function requestInsertValueHintTableColumns(table: string, schema?: string, database?: string) {
  if (!props.connectionId || props.database == null) return;
  if (props.databaseType === "redis" || props.databaseType === "mongodb" || props.databaseType === "elasticsearch") return;
  const cacheKey = insertHintCacheKey({ name: table, schema, database });
  if (cachedColumnsByTable.has(cacheKey) || pendingInsertValueHintColumnLoads.has(cacheKey)) return;
  const target = insertHintMetadataTarget({ name: table, schema, database });
  if (!target) return;
  pendingInsertValueHintColumnLoads.add(cacheKey);
  void connectionStore
    .listCompletionColumns(props.connectionId, target.database, table, target.schema)
    .then((columns) => {
      cachedColumnsByTable.set(cacheKey, columns);
      loadedColumnsByTable.add(cacheKey.toLowerCase());
      if (view.value) requestInsertValueHintsRefresh(view.value);
    })
    .catch(() => {})
    .finally(() => {
      pendingInsertValueHintColumnLoads.delete(cacheKey);
    });
}

function supportsDatabaseQualifierCompletion(): boolean {
  return !!props.databaseType && !isSchemaAware(props.databaseType) && !isSingleDatabase(props.databaseType);
}

function usesLocalOnlyCompletionMetadata(): boolean {
  return usesLocalOnlyEditorCompletionMetadata(props.databaseType);
}

function usesOnDemandOnlyCompletionColumns(): boolean {
  return usesOnDemandOnlyEditorColumnMetadata(props.databaseType);
}

function allowsOnDemandQualifiedTableCompletion(prefix: string): boolean {
  if (!usesLocalOnlyCompletionMetadata()) return false;
  if (props.databaseType !== "prestosql" && props.databaseType !== "trino") return false;
  return prefix.trim().length >= PRESTO_ON_DEMAND_TABLE_COMPLETION_MIN_PREFIX;
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

async function findExactSemanticDiagnosticTable(table: SqlTableReference): Promise<SqlCompletionTable | null> {
  if (!props.connectionId || props.database == null) return null;
  const target = completionMetadataTarget(table);
  if (!target) return null;
  const localMatches = connectionStore.lookupLocalCompletionTables(props.connectionId, target.database, table.name, MAX_COMPLETION_TABLES, target.schema);
  const localExact = localMatches.find((item) => completionTablesMatch(item, table));
  if (localExact) return localExact;

  const remoteMatches = await connectionStore.listCompletionTables(props.connectionId, target.database, table.name, MAX_COMPLETION_TABLES, target.schema, false, props.schema);
  cachedTables = mergeCompletionTables(cachedTables, remoteMatches);
  return remoteMatches.find((item) => completionTablesMatch(item, table)) ?? null;
}

async function ensureColumnsForTable(table: { name: string; schema?: string | null }): Promise<boolean> {
  const cacheKey = completionCacheKey(table);
  if (cachedColumnsByTable.has(cacheKey)) return true;
  if (!props.connectionId || props.database == null) return false;
  const target = completionMetadataTarget(table);
  if (!target) return false;
  const columns = await connectionStore.listCompletionColumns(props.connectionId, target.database, table.name, target.schema);
  cachedColumnsByTable.set(cacheKey, columns);
  loadedColumnsByTable.add(cacheKey.toLowerCase());
  return true;
}

function isMissingTableMetadataError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return message.includes("42s02") || message.includes("1146") || message.includes("doesn't exist") || message.includes("does not exist") || message.includes("unknown table");
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
  for (let index = 0; index < uniqueTables.length; index += COMPLETION_METADATA_CONCURRENCY) {
    await Promise.all(uniqueTables.slice(index, index + COMPLETION_METADATA_CONCURRENCY).map((table) => ensureForeignKeysForTable(table)));
  }
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
  const parts = splitQualifiedIdentifier(identifier);
  const name = parts[parts.length - 1] ?? identifier;
  const qualifier = parts.length > 1 ? parts[parts.length - 2] : undefined;
  const semanticModel = SEMANTIC_SQL_COMPLETION_ENABLED
    ? buildSqlSemanticModel(sql, pos, {
        databaseType: props.databaseType,
        dialect: props.syntaxDialect ?? props.dialect,
      })
    : null;
  const semanticTarget = semanticModel ? resolveSqlSemanticNavigationTarget(semanticModel, parts) : null;
  const semanticQualifierIsRowSource = !!qualifier && !!semanticTarget && (semanticTarget.alias?.toLowerCase() === qualifier.toLowerCase() || semanticTarget.source.name.toLowerCase() === qualifier.toLowerCase());
  const tableLookupName = semanticTarget && !semanticQualifierIsRowSource ? semanticTarget.name : name;
  const qualifiedTableLookup = semanticTarget?.schema ? `${semanticTarget.schema}.${semanticTarget.name}` : identifier;

  try {
    if (cachedTables.length === 0) {
      cachedTables = usesLocalOnlyCompletionMetadata()
        ? connectionStore.lookupLocalCompletionTables(props.connectionId, props.database, tableLookupName, MAX_COMPLETION_TABLES, props.schema)
        : await connectionStore.listCompletionTables(props.connectionId, props.database, tableLookupName, MAX_COMPLETION_TABLES, props.schema, false, props.schema);
    }

    let table = matchTable(qualifiedTableLookup, cachedTables) ?? matchTable(tableLookupName, cachedTables) ?? matchTable(identifier, cachedTables) ?? matchTable(name, cachedTables);
    if (!table && !usesLocalOnlyCompletionMetadata()) {
      const hoverTables = await connectionStore.listCompletionTables(props.connectionId, props.database, tableLookupName, MAX_COMPLETION_TABLES, semanticTarget?.schema ?? props.schema, false, props.schema);
      cachedTables = mergeCompletionTables(cachedTables, hoverTables);
      table = matchTable(qualifiedTableLookup, hoverTables) ?? matchTable(tableLookupName, hoverTables) ?? matchTable(identifier, hoverTables) ?? matchTable(name, hoverTables);
    }
    if (table && !semanticQualifierIsRowSource && (!qualifier || table.schema?.toLowerCase() === qualifier.toLowerCase() || table.name === name)) {
      return {
        pos: range.from,
        end: range.to,
        create: () => ({
          dom: createHoverDom(table.name, sqlObjectHoverDetail(table)),
        }),
      };
    }

    const legacyContext = getSqlCompletionContext(sql, pos);
    const context = semanticModel ? sqlCompletionContextFromSemantic(semanticModel, legacyContext) : legacyContext;
    const candidates = qualifier ? context.referencedTables.filter((rt) => rt.alias?.toLowerCase() === qualifier.toLowerCase() || rt.name.toLowerCase() === qualifier.toLowerCase()) : context.referencedTables;

    for (const refTable of candidates) {
      const columns: SqlCompletionColumn[] =
        refTable.columns?.map((columnName) => ({
          name: columnName,
          table: refTable.name,
          ...(refTable.schema ? { schema: refTable.schema } : {}),
        })) ?? [];
      if (columns.length === 0) {
        await ensureColumnsForTable(refTable);
        columns.push(...(cachedColumnsByTable.get(completionCacheKey(refTable)) ?? []));
      }
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
  if (!props.executionErrorSql || props.executionErrorSql !== currentState.doc.toString()) return [];
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
  const from = lineColumnToOffset(sql, {
    line: span.start_line - 1,
    column: span.start_column - 1,
  });
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
      return range
        ? {
            ...range,
            message: diagnostic.message,
            severity: diagnostic.severity,
          }
        : null;
    })
    .filter(
      (
        range,
      ): range is {
        from: number;
        to: number;
        message: string;
        severity: "error" | "warning";
      } => !!range,
    );
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

function clearScheduledSemanticDiagnostics() {
  semanticDiagnosticRunId++;
  if (semanticDiagnosticTimer) clearTimeout(semanticDiagnosticTimer);
  semanticDiagnosticTimer = null;
  pendingSemanticDiagnosticPreserveOutsideRanges = false;
}

function invalidateSemanticDiagnosticsForDocumentChange() {
  semanticDiagnosticRunId++;
  semanticDiagnostics = [];
}

function shouldSkipSqlSemanticDiagnostics() {
  return props.databaseType !== "redis" && !settingsStore.editorSettings.sqlSemanticDiagnosticsEnabled;
}

function rangesOverlap(left: { from: number; to: number }, right: { from: number; to: number }): boolean {
  return left.from < right.to && right.from < left.to;
}

function sqlLineColumnAtOffset(sql: string, offset: number): { line: number; column: number } {
  const safeOffset = Math.max(0, Math.min(offset, sql.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < safeOffset; index += 1) {
    if (sql[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: safeOffset - lineStart + 1 };
}

function offsetSqlTextSpan(span: SqlTextSpan, rangeStart: { line: number; column: number }): SqlTextSpan {
  const offsetLine = (line: number) => rangeStart.line + line - 1;
  const offsetColumn = (line: number, column: number) => (line === 1 ? rangeStart.column + column - 1 : column);
  return {
    start_line: offsetLine(span.start_line),
    start_column: offsetColumn(span.start_line, span.start_column),
    end_line: offsetLine(span.end_line),
    end_column: offsetColumn(span.end_line, span.end_column),
  };
}

function offsetSqlSemanticDiagnostics(diagnostics: readonly SqlSemanticDiagnostic[], range: SqlTextRange, fullSql: string): SqlSemanticDiagnostic[] {
  const rangeStart = sqlLineColumnAtOffset(fullSql, range.from);
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    span: offsetSqlTextSpan(diagnostic.span, rangeStart),
  }));
}

function replaceSemanticDiagnosticsInRanges(next: SqlSemanticDiagnostic[], ranges: readonly SqlTextRange[], fullSql: string) {
  const retained = semanticDiagnostics.filter((diagnostic) => {
    const diagnosticRange = sqlTextSpanToRange(fullSql, diagnostic.span);
    return !diagnosticRange || !ranges.some((range) => rangesOverlap(diagnosticRange, range));
  });
  setSemanticDiagnostics([...retained, ...next].sort(compareSqlSemanticDiagnostics));
}

function compareSqlSemanticDiagnostics(left: SqlSemanticDiagnostic, right: SqlSemanticDiagnostic): number {
  return left.span.start_line - right.span.start_line || left.span.start_column - right.span.start_column || left.span.end_line - right.span.end_line || left.span.end_column - right.span.end_column || left.message.localeCompare(right.message);
}

async function enrichSemanticDiagnosticTables(tables: SqlTableReference[]): Promise<{ tables: SqlTableReference[]; missingTables: Set<string> }> {
  if (!props.connectionId || props.database == null) return { tables, missingTables: new Set() };

  const enriched: SqlTableReference[] = [];
  const missingTables = new Set<string>();
  for (const table of tables) {
    if (isStatementLocalSemanticTable(table)) {
      enriched.push(table);
      continue;
    }
    try {
      const match = await findExactSemanticDiagnosticTable(table);
      if (!match) missingTables.add(tableReferenceKey(table));
      enriched.push(match?.schema ? { ...table, schema: match.schema } : table);
    } catch {
      enriched.push(table);
    }
  }
  return { tables: enriched, missingTables };
}

async function ensureColumnsForSemanticDiagnostics(tables: SqlTableReference[]): Promise<Set<string>> {
  const missingTables = new Set<string>();
  const seen = new Set<string>();
  const targets: SqlTableReference[] = [];
  for (const table of tables) {
    if (isStatementLocalSemanticTable(table)) continue;
    const tableWithInlineColumns = table as SqlTableReference & {
      columns?: string[];
    };
    if (tableWithInlineColumns.columns && tableWithInlineColumns.columns.length > 0) continue;
    const cacheKey = completionCacheKey(table);
    if (cachedColumnsByTable.has(cacheKey)) continue;
    const normalizedKey = cacheKey.toLowerCase();
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    targets.push(table);
    if (targets.length >= MAX_SEMANTIC_DIAGNOSTIC_COLUMN_TABLES) break;
  }
  await Promise.all(
    targets.map(async (table) => {
      try {
        await ensureColumnsForTable(table);
      } catch (error) {
        if (isMissingTableMetadataError(error)) {
          missingTables.add(tableReferenceKey(table));
        }
      }
    }),
  );
  return missingTables;
}

function isStatementLocalSemanticTable(table: SqlTableReference): boolean {
  const kind = (table as SqlTableReference & { semanticSourceKind?: string }).semanticSourceKind;
  return kind === "cte" || kind === "subquery" || kind === "table_function";
}

async function refreshSemanticDiagnostics(options: { preserveOutsideRanges?: boolean } = {}) {
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
      scheduleSemanticDiagnostics(900, {
        preserveOutsideRanges: options.preserveOutsideRanges,
      });
      return;
    }
    setSemanticDiagnostics(buildRedisSyntaxDiagnostics(sql));
    return;
  }
  if (shouldSkipSqlSemanticDiagnostics()) {
    setSemanticDiagnostics([]);
    return;
  }
  if (!shouldRunSqlSemanticDiagnostics(sql, currentView.state.selection.main.head, { databaseType: props.databaseType })) {
    scheduleSemanticDiagnostics(1200, {
      preserveOutsideRanges: options.preserveOutsideRanges,
    });
    return;
  }
  if (codeMirrorCompletionStatus?.(currentView.state) && isSqlSemanticDiagnosticInputContext(sql, currentView.state.selection.main.head, { databaseType: props.databaseType })) {
    scheduleSemanticDiagnostics(900, {
      preserveOutsideRanges: options.preserveOutsideRanges,
    });
    return;
  }

  const visibleRanges = currentView.visibleRanges.length > 0 ? currentView.visibleRanges : [currentView.viewport];
  const diagnosticRanges = sqlSemanticDiagnosticRangesForViewport(sql, visibleRanges, props.databaseType);
  if (diagnosticRanges.length === 0) {
    if (!options.preserveOutsideRanges) setSemanticDiagnostics([]);
    return;
  }

  const nextDiagnostics: SqlSemanticDiagnostic[] = [];
  for (const range of diagnosticRanges) {
    try {
      const analysis = await api.analyzeSqlReferences(range.sql, props.formatDialect ?? props.dialect ?? "generic");
      if (runId !== semanticDiagnosticRunId) return;

      const semanticCursor = Math.max(0, Math.min(currentView.state.selection.main.head - range.from, range.sql.length));
      const semanticModel = SEMANTIC_SQL_COMPLETION_ENABLED
        ? buildSqlSemanticModel(range.sql, semanticCursor, {
            databaseType: props.databaseType,
            dialect: props.syntaxDialect ?? props.dialect,
          })
        : null;
      const semanticAnalysis = semanticModel ? mergeSqlSemanticReferenceAnalysis(analysis, semanticModel) : analysis;
      const { tables, missingTables } = await enrichSemanticDiagnosticTables(semanticAnalysis.tables);
      const columnMetadataMissingTables = await ensureColumnsForSemanticDiagnostics(tables);
      for (const tableKey of columnMetadataMissingTables) missingTables.add(tableKey);
      if (runId !== semanticDiagnosticRunId) return;

      const enrichedAnalysis: SqlReferenceAnalysis = {
        ...semanticAnalysis,
        tables,
      };
      nextDiagnostics.push(
        ...offsetSqlSemanticDiagnostics(
          buildSqlSemanticDiagnostics(enrichedAnalysis, {
            tables: cachedTables,
            columnsByTable: cachedColumnsByTable,
            missingTables,
            loadedColumnTables: loadedColumnsByTable,
            sql: range.sql,
          }),
          range,
          sql,
        ),
      );
    } catch (error) {
      if (runId !== semanticDiagnosticRunId) return;
      const diagnostic = buildSqlParserErrorDiagnostic(error, range.sql);
      if (diagnostic) nextDiagnostics.push(...offsetSqlSemanticDiagnostics([diagnostic], range, sql));
    }
  }
  if (options.preserveOutsideRanges) {
    replaceSemanticDiagnosticsInRanges(nextDiagnostics, diagnosticRanges, sql);
  } else {
    setSemanticDiagnostics(nextDiagnostics.sort(compareSqlSemanticDiagnostics));
  }
}

function scheduleSemanticDiagnostics(delay = 500, options: { preserveOutsideRanges?: boolean } = {}) {
  if (!editorIsActive) return;
  if (shouldSkipSqlSemanticDiagnostics()) {
    clearScheduledSemanticDiagnostics();
    setSemanticDiagnostics([]);
    return;
  }
  pendingSemanticDiagnosticPreserveOutsideRanges = !!options.preserveOutsideRanges;
  if (semanticDiagnosticTimer) clearTimeout(semanticDiagnosticTimer);
  semanticDiagnosticTimer = setTimeout(() => {
    const preserveOutsideRanges = pendingSemanticDiagnosticPreserveOutsideRanges;
    pendingSemanticDiagnosticPreserveOutsideRanges = false;
    semanticDiagnosticTimer = null;
    void refreshSemanticDiagnostics({ preserveOutsideRanges });
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
  return insertTableReferencePayload(currentView, payload, {
    clientX: event.clientX,
    clientY: event.clientY,
  });
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
let typedCompletionActivationUntil = 0;
let suppressNextSqlCompletionAutoStartUntil = 0;

type QueryCompletionItem = SqlCompletionItem | ElasticsearchCompletionItem | RedisCompletionItem | MongoCompletionItem;

function markTypedCompletionActivation() {
  typedCompletionActivationUntil = Date.now() + 500;
}

function isTypedCompletionActivation(explicit: boolean) {
  return explicit && typedCompletionActivationUntil >= Date.now();
}

function markCompletionAccepted(item: QueryCompletionItem) {
  suppressNextSqlCompletionAutoStartUntil = shouldChainSqlCompletionAfterAccept(item) ? 0 : Date.now() + 750;
  completionEpoch++;
}

function consumeSqlCompletionAutoStartSuppression() {
  if (suppressNextSqlCompletionAutoStartUntil < Date.now()) {
    suppressNextSqlCompletionAutoStartUntil = 0;
    return false;
  }
  suppressNextSqlCompletionAutoStartUntil = 0;
  return true;
}

function buildCompletionResult(items: QueryCompletionItem[], from: number, validFor?: RegExp) {
  if (items.length === 0) return null;
  return {
    from,
    filter: false,
    options: items.map((item) => completionOptionForItem(item)),
    validFor,
  };
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

function localCompletionDatabaseNames(completionContext: ReturnType<typeof getSqlCompletionContext>): string[] {
  if (!supportsDatabaseQualifierCompletion() || !completionContext.suggestTables || completionContext.insertTable || !props.connectionId) return [];
  return connectionStore.lookupLocalCompletionDatabases(props.connectionId, completionContext.qualifier || completionContext.prefix, MAX_COMPLETION_TABLES);
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
        markCompletionAccepted(item);
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
      markCompletionAccepted(item);
      const insert = item.apply ?? item.label;
      if (codeMirrorInsertCompletionText) {
        view.dispatch(codeMirrorInsertCompletionText(view.state, insert, from, to));
      } else {
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        });
      }
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

  const items = buildRedisCompletionItemsFromContext(completionContext, {
    keys,
  });
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

  if (props.database && mongoCompletionNeedsCollections(completionContext.mode)) {
    try {
      collections = await connectionStore.listMongoCompletionCollections(props.connectionId, props.database);
    } catch {
      collections = [];
    }
  }

  if (props.database && mongoCompletionNeedsFields(completionContext.mode) && completionContext.collection) {
    try {
      fields = await connectionStore.listMongoCompletionFields(props.connectionId, props.database, completionContext.collection);
    } catch {
      fields = [];
    }
  }

  if (epoch !== completionEpoch) return null;

  const items = buildMongoCompletionItemsFromContext(completionContext, {
    collections,
    fields,
  });
  if (items.length === 0) return null;
  return {
    from: completionContext.from,
    options: items.map((item) => completionOptionForItem(item)),
    validFor: getMongoCompletionResultValidFor(),
  };
}

async function provideSqlCompletions(context: CompletionContext) {
  const currentState = context.state;
  const position = context.pos;
  const explicit = context.explicit;
  const typedActivation = isTypedCompletionActivation(explicit);
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
    if (isSqlCompletionSuppressedContext(fullDoc, position)) return null;
    if (!explicit && !shouldAutoOpenSqlCompletion(fullDoc, position)) return null;

    const legacyCompletionContext = getSqlCompletionContext(fullDoc, position);
    const semanticModel = SEMANTIC_SQL_COMPLETION_ENABLED
      ? buildSqlSemanticModel(fullDoc, position, {
          databaseType: props.databaseType,
          dialect: props.syntaxDialect ?? props.dialect,
        })
      : null;
    const completionContext = semanticModel ? sqlCompletionContextFromSemantic(semanticModel, legacyCompletionContext) : legacyCompletionContext;

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
        currentSchema: props.schema,
        keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
        autoAliasTables: settingsStore.editorSettings.autoAliasTables,
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
        currentSchema: props.schema,
        keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
        autoAliasTables: settingsStore.editorSettings.autoAliasTables,
      });
      return buildCompletionResult(items, position - completionContext.prefix.length, getSqlCompletionResultValidFor(fullDoc, position));
    }

    const tableNameCompletion = isTableNameCompletionContext(completionContext);
    const shouldResolveColumnCompletion = completionContext.suggestColumns && completionContext.referencedTables.length > 0 && (completionContext.prefix.length > 0 || typedActivation);
    const shouldResolveAsyncCompletion = tableNameCompletion || shouldResolveColumnCompletion;
    const localResult = buildLocalSqlCompletionResult(completionContext, fullDoc, position);
    if (localResult) {
      scheduleCompletionMetadataRefresh(completionContext);
      const hasLocalColumnResult = localResult.options.some((option) => option.type === "column");
      if ((!explicit || typedActivation) && (!shouldResolveColumnCompletion || hasLocalColumnResult)) return localResult;
    }
    if ((!explicit || typedActivation) && !shouldResolveAsyncCompletion) {
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
      context.addEventListener("abort", () => {
        if (epoch === completionEpoch) completionEpoch++;
      });
      completionDebounceTimer = setTimeout(async () => {
        completionDebounceTimer = null;
        if (epoch !== completionEpoch) {
          resolve(null);
          return;
        }
        try {
          const result = await performAsyncCompletionWithResult(epoch, completionContext, fullDoc, position);
          resolve(result ?? localResult);
        } catch {
          resolve(localResult);
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

function scheduleSqlCompletionStart(currentView: EditorViewType) {
  window.setTimeout(() => {
    if (!codeMirrorStartCompletion || isEditorComposing(currentView)) return;
    markTypedCompletionActivation();
    codeMirrorStartCompletion(currentView);
  }, 0);
}

function flushImeComposition() {
  const currentView = view.value;
  if (!currentView || !pendingImeModelEmit) return;
  pendingImeModelEmit = false;
  emit("update:modelValue", currentView.state.doc.toString());
  invalidateSemanticDiagnosticsForDocumentChange();
  scheduleSemanticDiagnostics();
  syncContextMenuState(currentView);
  emit("selectionChange", selectedSqlFromView(currentView));
  emit("cursorChange", currentView.state.selection.main.head);
  latestSelection = readEditorSelection(currentView);
  if (editorIsActive) emitEditorSelection(latestSelection);
  if (shouldAutoOpenSqlCompletion(currentView.state.doc.toString(), currentView.state.selection.main.head)) {
    scheduleSqlCompletionStart(currentView);
  }
}

function shouldStartSqlCompletionAfterInput(insertedText: string, removedText: string, currentView: EditorViewType): boolean {
  const position = currentView.state.selection.main.head;
  const fullDoc = currentView.state.doc.toString();
  if (!insertedText && removedText) {
    const completionContext = getSqlCompletionContext(fullDoc, position);
    return isTableNameCompletionContext(completionContext) && shouldAutoOpenSqlCompletion(fullDoc, position);
  }
  if (insertedText.endsWith(".")) return true;
  if (/[,(]$/.test(insertedText)) {
    const completionContext = getSqlCompletionContext(fullDoc, position);
    return !!completionContext.insertTable;
  }
  if (/\s$/.test(insertedText)) {
    return shouldAutoOpenSqlCompletion(fullDoc, position);
  }
  if (!/[\w$@]$/.test(insertedText)) return false;
  const completionContext = getSqlCompletionContext(fullDoc, position);
  return isTableNameCompletionContext(completionContext) || shouldAutoOpenSqlCompletion(fullDoc, position);
}

function buildLocalSqlCompletionResult(completionContext: ReturnType<typeof getSqlCompletionContext>, fullDoc: string, position: number) {
  if (!props.connectionId || props.database == null) return null;
  const databaseNames = localCompletionDatabaseNames(completionContext);
  const shouldLoadTables = completionContext.suggestTables || (!!completionContext.qualifier && !isReferencedTableQualifier(completionContext));
  const tableLookupTarget = resolveSqlCompletionTableLookupTarget({
    currentDatabase: props.database,
    currentSchema: props.schema,
    supportsDatabaseQualifier: supportsDatabaseQualifierCompletion(),
    completionContext,
    knownDatabases: databaseNames,
  });
  const globalOracleTableSearch = props.databaseType === "oracle" && completionContext.suggestTables && !completionContext.qualifier;
  const tables = shouldLoadTables ? connectionStore.lookupLocalCompletionTables(props.connectionId, tableLookupTarget.database, tableLookupTarget.filter, MAX_COMPLETION_TABLES, globalOracleTableSearch ? undefined : tableLookupTarget.schema) : cachedTables;

  const shouldLoadObjects = shouldLoadCompletionObjects(completionContext);
  const completionObjects = shouldLoadObjects ? lookupLocalCompletionObjectsForContext(completionContext) : cachedCompletionObjects;

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
        cteDef.columns.map((name) => ({
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
    currentSchema: props.schema,
    keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
    autoAliasTables: settingsStore.editorSettings.autoAliasTables,
  });

  return buildCompletionResult(items, position - completionContext.prefix.length, getSqlCompletionResultValidFor(fullDoc, position));
}

function scheduleCompletionMetadataRefresh(completionContext: ReturnType<typeof getSqlCompletionContext>) {
  if (!props.connectionId || props.database == null) return;
  const localOnlyMetadata = usesLocalOnlyCompletionMetadata();
  const onDemandOnlyColumns = usesOnDemandOnlyCompletionColumns();
  const tableNameCompletion = isTableNameCompletionContext(completionContext);
  const connectionId = props.connectionId;
  const database = props.database;
  const tableLookupTarget = resolveSqlCompletionTableLookupTarget({
    currentDatabase: database,
    currentSchema: props.schema,
    supportsDatabaseQualifier: supportsDatabaseQualifierCompletion(),
    completionContext,
    knownDatabases: localCompletionDatabaseNames(completionContext),
  });
  if (!localOnlyMetadata && (completionContext.suggestTables || (!!completionContext.qualifier && !isReferencedTableQualifier(completionContext)))) {
    const globalOracleTableSearch = props.databaseType === "oracle" && completionContext.suggestTables && !completionContext.qualifier;
    void connectionStore
      .refreshCompletionTables(connectionId, tableLookupTarget.database, tableLookupTarget.filter, MAX_COMPLETION_TABLES, tableLookupTarget.schema, globalOracleTableSearch, props.schema)
      .then((tables) => {
        cachedTables = mergeCompletionTables(cachedTables, tables);
        if (completionContext.suggestTables && completionContext.referencedTables.length > 0) {
          void ensureForeignKeysForTables([...completionContext.referencedTables, ...tables.slice(0, MAX_JOIN_FK_PREFETCH_TABLES)]);
        }
      })
      .catch(() => {});
  }
  if (!localOnlyMetadata && shouldLoadCompletionObjects(completionContext)) {
    void listCompletionObjectsForContext(completionContext)
      .then((objects) => {
        cachedCompletionObjects = mergeCompletionObjects(cachedCompletionObjects, objects);
      })
      .catch(() => {});
  }
  if (!localOnlyMetadata && completionContext.suggestTables && !completionContext.qualifier && !completionContext.insertTable) {
    void connectionStore.refreshCompletionSchemas(connectionId, database).catch(() => {});
    if (supportsDatabaseQualifierCompletion()) {
      void connectionStore.refreshCompletionDatabases(connectionId).catch(() => {});
    }
  }
  if (!onDemandOnlyColumns && completionContext.insertTable) {
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
  if (!onDemandOnlyColumns && qualifiedColumnTarget && qualifiedColumnCacheKey && !cachedColumnsByTable.has(qualifiedColumnCacheKey)) {
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
  if (!onDemandOnlyColumns && !tableNameCompletion) {
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
  }
  if (!tableNameCompletion && (completionContext.suggestTables || completionContext.suggestJoinConditions) && completionContext.referencedTables.length > 0) {
    void ensureForeignKeysForTables(completionContext.referencedTables);
  }
}

function mergeCompletionTables(existing: SqlCompletionTable[], incoming: SqlCompletionTable[]): SqlCompletionTable[] {
  const merged = [...existing];
  const indexes = new Map(existing.map((table, index) => [`${table.schema ?? ""}.${table.name}`.toLowerCase(), index]));
  for (const table of incoming) {
    const key = `${table.schema ?? ""}.${table.name}`.toLowerCase();
    const index = indexes.get(key);
    if (index == null) {
      indexes.set(key, merged.length);
      merged.push(table);
    } else {
      const existing = merged[index];
      // Preserve the more specific tree type if an older metadata endpoint reports a materialized view as VIEW.
      merged[index] = {
        ...existing,
        ...table,
        type: mergeSqlObjectNavigationType(existing.type, table.type),
      };
    }
  }
  return merged;
}

function withCompletionLatencyBudget<T>(remote: Promise<T>, local: T): Promise<T> {
  return Promise.race([remote, new Promise<T>((resolve) => setTimeout(() => resolve(local), COMPLETION_REMOTE_LATENCY_BUDGET_MS))]);
}

function listCompletionTablesWithLatencyBudget(connectionId: string, database: string, filter: string, limit: number, schema?: string, globalSearch = false): Promise<SqlCompletionTable[]> {
  const local = connectionStore.lookupLocalCompletionTables(connectionId, database, filter, limit, globalSearch ? undefined : schema);
  const remote = connectionStore.listCompletionTables(connectionId, database, filter, limit, schema, globalSearch, props.schema).then((tables) => {
    cachedTables = mergeCompletionTables(cachedTables, tables);
    return tables;
  });
  if (local.length === 0) return remote;
  return withCompletionLatencyBudget(remote, local);
}

interface RoutineCompletionTarget {
  schema?: string;
  parentName?: string;
  globalSearch?: boolean;
}

function shouldLoadCompletionObjects(completionContext: ReturnType<typeof getSqlCompletionContext>): boolean {
  const routineContext = completionContext.suggestRoutines || completionContext.exclusiveRoutineSuggestions || (!!completionContext.qualifier && !completionContext.exclusiveColumnSuggestions);
  return routineContext && !isReferencedTableQualifier(completionContext);
}

function oracleRoutineCompletionTargets(completionContext: ReturnType<typeof getSqlCompletionContext>): RoutineCompletionTarget[] {
  const parts = (completionContext.qualifierParts?.length ? completionContext.qualifierParts : completionContext.qualifier?.split("."))?.filter(Boolean) ?? [];
  if (parts.length === 0) return [{ schema: props.schema, globalSearch: true }];
  if (parts.length === 1) {
    return [{ schema: props.schema, parentName: parts[0] }, { schema: parts[0] }];
  }
  return [{ schema: parts[parts.length - 2], parentName: parts[parts.length - 1] }];
}

function lookupLocalCompletionObjectsForContext(completionContext: ReturnType<typeof getSqlCompletionContext>): SqlCompletionObject[] {
  if (!props.connectionId || props.database == null) return [];
  if (props.databaseType === "oracle") {
    return connectionStore.lookupLocalCompletionObjects(props.connectionId, props.database, completionContext.prefix, MAX_COMPLETION_TABLES);
  }
  return connectionStore.lookupLocalCompletionObjects(props.connectionId, props.database, completionContext.qualifier || completionContext.prefix, MAX_COMPLETION_TABLES, completionContext.qualifier && !completionContext.exclusiveColumnSuggestions ? completionContext.qualifier : props.schema);
}

async function listCompletionObjectsForContext(completionContext: ReturnType<typeof getSqlCompletionContext>): Promise<SqlCompletionObject[]> {
  if (!props.connectionId || props.database == null) return [];
  if (props.databaseType !== "oracle") {
    return connectionStore.listCompletionObjects(props.connectionId, props.database, completionContext.qualifier || completionContext.prefix, MAX_COMPLETION_TABLES, props.schema);
  }
  const groups = await Promise.all(oracleRoutineCompletionTargets(completionContext).map((target) => connectionStore.listCompletionObjects(props.connectionId!, props.database!, completionContext.prefix, MAX_COMPLETION_TABLES, target.schema, target.parentName, target.globalSearch, props.schema)));
  return groups.reduce((objects, group) => mergeCompletionObjects(objects, group), [] as SqlCompletionObject[]);
}

async function performAsyncCompletionWithResult(epoch: number, completionContext: ReturnType<typeof getSqlCompletionContext>, fullDoc: string, position: number) {
  const localOnlyMetadata = usesLocalOnlyCompletionMetadata();
  const onDemandOnlyColumns = usesOnDemandOnlyCompletionColumns();
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
  let databaseNames = localCompletionDatabaseNames(completionContext);
  if (!localOnlyMetadata && supportsDatabaseQualifierCompletion() && completionContext.suggestTables && !completionContext.insertTable && !completionContext.qualifier) {
    try {
      databaseNames = await connectionStore.listCompletionDatabases(props.connectionId!);
      if (epoch !== completionEpoch) return null;
    } catch {
      databaseNames = [];
    }
  }
  const tableLookupTarget = resolveSqlCompletionTableLookupTarget({
    currentDatabase: props.database!,
    currentSchema: props.schema,
    supportsDatabaseQualifier: supportsDatabaseQualifierCompletion(),
    completionContext,
    knownDatabases: databaseNames,
  });
  const globalOracleTableSearch = props.databaseType === "oracle" && completionContext.suggestTables && !completionContext.qualifier;
  let tables = shouldLoadTables
    ? localOnlyMetadata
      ? connectionStore.lookupLocalCompletionTables(props.connectionId!, tableLookupTarget.database, tableLookupTarget.filter, MAX_COMPLETION_TABLES, globalOracleTableSearch ? undefined : tableLookupTarget.schema)
      : await listCompletionTablesWithLatencyBudget(props.connectionId!, tableLookupTarget.database, tableLookupTarget.filter, MAX_COMPLETION_TABLES, tableLookupTarget.schema, globalOracleTableSearch)
    : cachedTables;
  if (epoch !== completionEpoch) return null;

  const shouldLoadObjects = shouldLoadCompletionObjects(completionContext);
  let completionObjects = shouldLoadObjects ? (localOnlyMetadata ? lookupLocalCompletionObjectsForContext(completionContext) : await listCompletionObjectsForContext(completionContext)) : cachedCompletionObjects;
  if (epoch !== completionEpoch) return null;

  if (props.databaseType !== "oracle" && !localOnlyMetadata && completionContext.qualifier && completionObjects.length === 0) {
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
    if (localOnlyMetadata) {
      schemaNames = mergeCompletionQualifierNames(connectionStore.lookupLocalCompletionSchemas(props.connectionId!, props.database!, completionContext.prefix, MAX_COMPLETION_TABLES), databaseNames);
    } else {
      try {
        const schemas = await connectionStore.listCompletionSchemas(props.connectionId!, props.database!);
        schemaNames = mergeCompletionQualifierNames(schemas, databaseNames);
        if (epoch !== completionEpoch) return null;
      } catch {
        schemaNames = databaseNames;
      }
    }
  }

  // If qualifier didn't match any table names, try it as a schema name
  let qualifierIsSchema = false;
  if (completionContext.qualifier && !tableLookupTarget.qualifierDatabase && !isReferencedTableQualifier(completionContext) && tables.length === 0 && (completionContext.suggestTables || completionContext.exclusiveColumnSuggestions)) {
    let schemaTables = connectionStore.lookupLocalCompletionTables(props.connectionId!, props.database!, completionContext.prefix, MAX_COMPLETION_TABLES, completionContext.qualifier);
    if (!localOnlyMetadata) {
      schemaTables = await listCompletionTablesWithLatencyBudget(props.connectionId!, props.database!, completionContext.prefix, MAX_COMPLETION_TABLES, completionContext.qualifier);
    } else if (schemaTables.length === 0 && allowsOnDemandQualifiedTableCompletion(completionContext.prefix)) {
      schemaTables = await listCompletionTablesWithLatencyBudget(props.connectionId!, props.database!, completionContext.prefix, PRESTO_ON_DEMAND_TABLE_COMPLETION_LIMIT, completionContext.qualifier);
    }
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
  if (!localOnlyMetadata && unresolvedRefs.length > 0) {
    const lookupGroups = await Promise.all(unresolvedRefs.map((rt) => connectionStore.listCompletionTables(props.connectionId!, props.database!, rt.name, 20, props.schema, false, props.schema)));
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

  const tableNameCompletion = isTableNameCompletionContext(completionContext);
  const shouldFetchColumnsForCompletion = !tableNameCompletion && (!onDemandOnlyColumns || completionContext.suggestColumns || completionContext.exclusiveColumnSuggestions || !!completionContext.insertTable);
  if (shouldFetchColumnsForCompletion) {
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
  }
  if (epoch !== completionEpoch) return null;

  if (!tableNameCompletion && (completionContext.suggestTables || completionContext.suggestJoinConditions) && refs.length > 0) {
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
    currentSchema: props.schema,
    keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
    autoAliasTables: settingsStore.editorSettings.autoAliasTables,
  });

  return buildCompletionResult(items, position - completionContext.prefix.length, getSqlCompletionResultValidFor(fullDoc, position));
}

function isReferencedTableQualifier(completionContext: ReturnType<typeof getSqlCompletionContext>): boolean {
  if (!completionContext.qualifier) return false;
  const qualifier = completionContext.qualifier.toLowerCase();
  const qualifiedColumnTarget = completionQualifiedTableTarget(completionContext);
  return completionContext.referencedTables.some((table) => table.alias?.toLowerCase() === qualifier || table.name.toLowerCase() === qualifier || (!!qualifiedColumnTarget && completionTablesMatch(table, qualifiedColumnTarget)));
}

function isTableNameCompletionContext(completionContext: ReturnType<typeof getSqlCompletionContext>): boolean {
  return completionContext.suggestTables || completionContext.exclusiveTableSuggestions;
}

function mergeCompletionObjects(existing: SqlCompletionObject[], incoming: SqlCompletionObject[]) {
  const merged = [...existing];
  const indexes = new Map(existing.map((object, index) => [`${object.type}:${object.schema ?? ""}:${object.name}:${object.parentName ?? ""}`.toLowerCase(), index]));
  for (const object of incoming) {
    const key = `${object.type}:${object.schema ?? ""}:${object.name}:${object.parentName ?? ""}`.toLowerCase();
    const index = indexes.get(key);
    if (index == null) {
      indexes.set(key, merged.length);
      merged.push(object);
    } else {
      merged[index] = { ...merged[index], ...object };
    }
  }
  return merged;
}

function refreshCompletionCache() {
  cachedTables = [];
  cachedCompletionObjects = [];
  cachedColumnsByTable.clear();
  loadedColumnsByTable.clear();
  cachedForeignKeysByTable.clear();
}

onMounted(async () => {
  if (!editorRef.value) return;

  const [
    { EditorView, keymap, rectangularSelection, hoverTooltip, showTooltip, Decoration, tooltips, gutter, GutterMarker, lineNumberMarkers, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, dropCursor, crosshairCursor, ViewPlugin },
    { EditorState, EditorSelection, Compartment, Prec, RangeSet, StateEffect, StateField },
    langSql,
    { autocompletion, startCompletion, acceptCompletion, closeBrackets, closeBracketsKeymap, snippetCompletion, completionStatus, completionKeymap, insertCompletionText, nextSnippetField },
    { copyLineDown, copyLineUp, deleteLine, indentLess, indentMore, insertNewlineKeepIndent, moveLineDown, moveLineUp, redo, selectAll, undo, toggleLineComment, history, defaultKeymap, historyKeymap },
    { bracketMatching, foldGutter, indentOnInput, indentUnit, syntaxHighlighting, defaultHighlightStyle, foldKeymap, ensureSyntaxTree },
    { searchKeymap },
  ] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("@codemirror/autocomplete"), import("@codemirror/commands"), import("@codemirror/language"), import("@codemirror/search")]);
  editorViewModule = {
    EditorView,
    keymap,
    rectangularSelection,
  } as typeof import("@codemirror/view");
  codeMirrorPrec = Prec;
  codeMirrorEditorSelection = EditorSelection;
  codeMirrorSnippetCompletion = snippetCompletion;
  fontThemeComp = new Compartment();
  codeMirrorTheme = new Compartment();
  wordWrapComp = new Compartment();
  vimModeComp = new Compartment();
  closeBracketsComp = new Compartment();
  sqlLanguageComp = new Compartment();
  sqlSemanticHighlightComp = new Compartment();
  codeMirrorCloseBrackets = closeBrackets;
  codeMirrorCloseBracketsKeymap = closeBracketsKeymap;
  readOnlyComp = new Compartment();
  runGutterComp = new Compartment();
  statementExecutionGutterComp = new Compartment();
  runKeymapComp = new Compartment();
  completionComp = new Compartment();
  diagnosticComp = new Compartment();
  previewRangeComp = new Compartment();
  indentComp = new Compartment();
  setSqlDiagnosticsEffect = StateEffect.define<SqlSemanticDiagnostic[]>();
  codeMirrorCompletionStatus = completionStatus;
  codeMirrorAcceptCompletion = acceptCompletion;
  codeMirrorStartCompletion = startCompletion;
  codeMirrorInsertCompletionText = insertCompletionText;
  codeMirrorNextSnippetField = nextSnippetField;
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
  codeMirrorToggleLineComment = toggleLineComment;
  codeMirrorIndentUnit = indentUnit;
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
        if (diagnosticsChanged) return buildDecorations(transaction.state);
        if (transaction.docChanged) return Decoration.set([]);
        return value;
      },
      provide: (field) => EditorView.decorations.from(field),
    });

    return [field, diagnosticTheme];
  };

  setPreviewRangeEffect = StateEffect.define<{
    from: number;
    to: number;
  } | null>();
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
        if (transaction.docChanged || transaction.selection) return Decoration.none;
        return decorations;
      },
      provide: (f) => EditorView.decorations.from(f),
    });
    return field;
  };

  class ResultSourceLineNumberMarker extends GutterMarker {
    elementClass = "cm-db-result-source-line-number";
  }

  const resultSourceLineNumberMarker = new ResultSourceLineNumberMarker();
  setResultSourceRangeEffect = StateEffect.define<{
    from: number;
    to: number;
  } | null>();
  buildResultSourceRangeExtension = () => {
    const effectType = setResultSourceRangeEffect!;
    const markersForRange = (state: import("@codemirror/state").EditorState, range: { from: number; to: number }) => {
      const from = Math.max(0, Math.min(range.from, state.doc.length));
      const to = Math.max(from, Math.min(range.to, state.doc.length));
      const startLine = state.doc.lineAt(from);
      const endLine = state.doc.lineAt(Math.max(from, to - 1));
      const markers = Array.from({ length: endLine.number - startLine.number + 1 }, (_, index) => resultSourceLineNumberMarker.range(state.doc.line(startLine.number + index).from));
      return RangeSet.of(markers);
    };

    const field = StateField.define({
      create() {
        return RangeSet.empty;
      },
      update(markers, transaction) {
        for (const effect of transaction.effects) {
          if (effect.is(effectType)) {
            return effect.value ? markersForRange(transaction.state, effect.value) : RangeSet.empty;
          }
        }
        if (transaction.docChanged || transaction.selection) return RangeSet.empty;
        return markers;
      },
      provide: (field) => lineNumberMarkers.from(field),
    });
    return field;
  };

  class StatementExecutionStatusMarker extends GutterMarker {
    constructor(readonly marker: StatementExecutionMarker) {
      super();
    }

    eq(other: import("@codemirror/view").GutterMarker): boolean {
      return other instanceof StatementExecutionStatusMarker && other.marker.status === this.marker.status && other.marker.successCount === this.marker.successCount && other.marker.errorCount === this.marker.errorCount;
    }

    toDOM() {
      const element = document.createElement("span");
      const title = statementExecutionMarkerTitle(this.marker);
      element.className = `cm-statement-execution-marker cm-statement-execution-marker--${this.marker.status}`;
      element.title = title;
      element.setAttribute("aria-label", title);
      element.appendChild(createStatementExecutionStatusIconDom(this.marker.status));
      return element;
    }
  }

  function statementExecutionMarkerTitle(marker: StatementExecutionMarker) {
    const parts = [];
    if (marker.successCount > 0) parts.push(t("editor.statementExecutionSucceeded", { count: marker.successCount }));
    if (marker.errorCount > 0) parts.push(t("editor.statementExecutionFailed", { count: marker.errorCount }));
    return parts.join(", ");
  }

  function createStatementExecutionStatusIconDom(status: StatementExecutionMarker["status"]) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");

    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "10");
    const mark = document.createElementNS("http://www.w3.org/2000/svg", "path");
    mark.setAttribute("d", status === "error" ? "m15 9-6 6m0-6 6 6" : "m9 12 2 2 4-4");
    svg.append(circle, mark);

    return svg;
  }

  setStatementExecutionMarkersEffect = StateEffect.define<StatementExecutionMarker[]>();
  buildStatementExecutionMarkersExtension = () => {
    const effectType = setStatementExecutionMarkersEffect!;
    const markersForState = (state: import("@codemirror/state").EditorState, markers: readonly StatementExecutionMarker[]) => {
      const ranges = markers.map((marker) => {
        const from = Math.max(0, Math.min(marker.from, state.doc.length));
        return new StatementExecutionStatusMarker(marker).range(state.doc.lineAt(from).from);
      });
      return RangeSet.of(ranges, true);
    };

    const field = StateField.define({
      create(state) {
        return markersForState(state, props.statementExecutionMarkers ?? []);
      },
      update(markers, transaction) {
        for (const effect of transaction.effects) {
          if (effect.is(effectType)) return markersForState(transaction.state, effect.value);
        }
        if (transaction.docChanged) return RangeSet.empty;
        return markers;
      },
      provide: (field) =>
        gutter({
          class: "cm-statement-execution-gutter",
          markers: (currentView) => currentView.state.field(field),
        }),
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
      override: [async (context: CompletionContext) => provideSqlCompletions(context)],
    });

  buildSqlLanguageExtension = () =>
    langSql.sql({
      dialect: createDbxCodeMirrorSqlDialect(langSql, props.syntaxDialect ?? props.dialect, props.databaseType),
    });
  buildSqlSemanticHighlightExtension = () => [
    ViewPlugin.fromClass(
      class {
        decorations: import("@codemirror/view").DecorationSet;
        constructor(currentView: import("@codemirror/view").EditorView) {
          this.decorations = this.buildDecorations(currentView);
        }
        update(update: import("@codemirror/view").ViewUpdate) {
          if (update.docChanged || update.viewportChanged) this.decorations = this.buildDecorations(update.view);
        }
        buildDecorations(currentView: import("@codemirror/view").EditorView) {
          const sql = currentView.state.doc.toString();
          const windows: Array<{ from: number; to: number }> = [];
          for (const visibleRange of currentView.visibleRanges) {
            const next = expandToSqlStatementWindow(sql, visibleRange.from, visibleRange.to);
            const previous = windows[windows.length - 1];
            if (previous && next.from <= previous.to) previous.to = Math.max(previous.to, next.to);
            else windows.push(next);
          }
          const tree = ensureSyntaxTree(currentView.state, windows[windows.length - 1]?.to ?? 0, 25);
          if (!tree) return Decoration.set([]);
          const ranges = windows.flatMap((window) =>
            sqlSemanticTableNameSpansForSyntaxTree(sql, window, tree, {
              databaseType: props.databaseType,
              dialect: props.syntaxDialect ?? props.dialect,
            }),
          );
          return Decoration.set(
            ranges.map((range) =>
              Decoration.mark({
                class: "cm-sql-table-name",
                attributes: {
                  "data-sql-token": "table",
                },
              }).range(range.start, range.end),
            ),
            true,
          );
        }
      },
      { decorations: (value) => value.decorations },
    ),
    sqlSemanticHighlightTheme(EditorView),
  ];

  const initialSettings = settingsStore.editorSettings;
  const theme = await loadEditorTheme(initialSettings.theme, editorThemeAppearance(), getCurrentCustomThemeColors(), themePalette.value);
  if (initialSettings.vimModeEnabled) {
    await ensureCodeMirrorVim();
  }

  class RunStatementGutterMarker extends GutterMarker {
    toDOM() {
      return createRunStatementButtonDom("Execute statement");
    }
  }

  const executableStatementMarker = new RunStatementGutterMarker();
  buildRunStatementGutterExtension = () =>
    settingsStore.editorSettings.showStatementRunButtons
      ? gutter({
          class: "cm-run-statement-gutter",
          lineMarker(currentView, line) {
            return executableStatementRangeStartingAt(currentView, line.from) ? executableStatementMarker : null;
          },
          domEventHandlers: {
            mousedown: executeSqlStatementFromGutter,
          },
        })
      : [];

  const currentStatementFrameHighlighter = ViewPlugin.fromClass(
    class {
      decorations: import("@codemirror/view").DecorationSet;
      constructor(view: import("@codemirror/view").EditorView) {
        this.decorations = this.getDeco(view);
      }
      update(update: import("@codemirror/view").ViewUpdate) {
        this.decorations = this.getDeco(update.view);
      }
      getDeco(view: import("@codemirror/view").EditorView) {
        if (!settingsStore.editorSettings.showCurrentStatementFrame) return Decoration.none;
        if (view.state.selection.ranges.some((range) => !range.empty)) return Decoration.none;
        const range = currentExecutableStatementRange(view);
        if (!range) return Decoration.none;

        const startLine = view.state.doc.lineAt(range.from);
        const frameTo = currentStatementFrameTo(view, range);
        const endLine = view.state.doc.lineAt(Math.max(range.from, frameTo - 1));
        let insertValueHints: Array<{ from: number; column: string }> = [];
        try {
          if (settingsStore.editorSettings.showInsertValueHints && props.databaseType !== "redis" && props.databaseType !== "mongodb" && props.databaseType !== "elasticsearch") {
            insertValueHints = parseInsertValueHints(view.state.doc.sliceString(range.from, range.to), { resolveTableColumns: getInsertValueHintTableColumns }).map((hint) => ({
              ...hint,
              from: hint.from + range.from,
            }));
          }
        } catch {
          insertValueHints = [];
        }
        let maxWidth = 1;
        for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
          const line = view.state.doc.line(lineNumber);
          const lineRangeTo = Math.min(line.to, frameTo);
          maxWidth = Math.max(maxWidth, visualSqlColumnsWithInlineHints(view.state.doc.sliceString(line.from, lineRangeTo), line.from, lineRangeTo, insertValueHints));
        }

        const deco: any[] = [];
        const frameWidth = `calc(${maxWidth}ch + 2ch)`;
        for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
          const line = view.state.doc.line(lineNumber);
          const classes = ["cm-db-current-statement-line"];
          if (lineNumber === startLine.number) classes.push("cm-db-current-statement-line--first");
          if (lineNumber === endLine.number) classes.push("cm-db-current-statement-line--last");
          deco.push(
            Decoration.line({
              class: classes.join(" "),
              attributes: {
                style: `--dbx-current-statement-frame-width: ${frameWidth};`,
              },
            }).range(line.from),
          );
        }
        return Decoration.set(deco);
      }
    },
    { decorations: (v) => v.decorations },
  );

  function currentStatementFrameTo(view: import("@codemirror/view").EditorView, range: SqlTextRange): number {
    const nextChar = range.to < view.state.doc.length ? view.state.doc.sliceString(range.to, range.to + 1) : "";
    return currentStatementFrameRangeTo(nextChar, range);
  }

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
      runGutterComp.of(props.hideExecutionControls ? [] : buildRunStatementGutterExtension()),
      lineNumbers({
        domEventHandlers: {
          mousedown: selectSqlLineFromGutter,
        },
      }),
      currentStatementFrameHighlighter,
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
      EditorView.dragMovesSelection.of((event) => !event.ctrlKey && !event.metaKey),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      crosshairCursor(),
      activeLineHighlighter,
      // Vim must be mounted before DBX/default keymaps so normal-mode keys are handled first.
      vimModeComp.of(vimModeExtension(initialSettings.vimModeEnabled)),
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap]),
      sqlLanguageComp.of(buildSqlLanguageExtension()),
      sqlSemanticHighlightComp.of(buildSqlSemanticHighlightExtension()),
      tooltips({ parent: document.body }),
      completionComp.of(buildSqlCompletionExtension()),
      sqlCompletionTheme(EditorView),
      codeMirrorTheme.of(theme),
      closeBracketsComp.of(closeBracketsExtension(initialSettings.autoCloseBrackets)),
      bracketMatching(),
      // Fix: intercept quote characters to prevent closeBrackets from
      // producing triple quotes ('''). When the cursor is immediately
      // before an auto-inserted closing quote, just skip past it.
      Prec.highest(
        EditorView.inputHandler.of((view: EditorViewType, _from: number, _to: number, text: string) => {
          if (text !== "'" && text !== '"' && text !== "`") return false;
          const pos = view.state.selection.main.head;
          const nextChar = view.state.doc.sliceString(pos, pos + 1);
          if (nextChar !== text) return false;
          // Only skip when the character ahead matches and it was auto-inserted
          // (i.e. the doc has a matching pair at this position).
          const prevChar = pos > 0 ? view.state.doc.sliceString(pos - 1, pos) : "";
          if (prevChar === text) return false; // already inside a quoted region
          view.dispatch({
            selection: { anchor: pos + 1 },
            scrollIntoView: true,
          });
          return true;
        }),
      ),
      hoverTooltip((currentView, pos) => resolveSqlHoverTooltip(currentView, pos)),
      buildSqlSignatureExtension(),
      diagnosticComp.of(buildSqlDiagnosticExtension()),
      createInsertValueHintsExtension({
        isEnabled: () => settingsStore.editorSettings.showInsertValueHints && props.databaseType !== "redis" && props.databaseType !== "mongodb" && props.databaseType !== "elasticsearch",
        getTableColumns: getInsertValueHintTableColumns,
        requestTableColumns: requestInsertValueHintTableColumns,
      }),
      previewRangeComp.of(buildPreviewRangeExtension()),
      buildResultSourceRangeExtension(),
      statementExecutionGutterComp.of(buildStatementExecutionMarkersExtension()),
      Prec.highest(
        keymap.of([
          { key: "'", run: handleSqlSingleQuote },
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
      indentComp.of(indentExtension()),
      // Alt+drag belongs exclusively to rectangular selection. Registering the
      // same gesture as an added cursor preserves the previous cursor.
      rectangularSelection({
        eventFilter: startsQueryEditorRectangularSelection,
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          searchPanelRef.value?.scheduleDocumentSearchUpdate();
          if (isEditorComposing(update.view)) {
            pendingImeModelEmit = true;
            completionEpoch++;
          } else {
            emit("update:modelValue", update.state.doc.toString());
            invalidateSemanticDiagnosticsForDocumentChange();
            scheduleSemanticDiagnostics();
            let insertedText = "";
            let removedText = "";
            update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
              insertedText += inserted.toString();
              removedText += update.startState.doc.sliceString(fromA, toA);
            });
            const suppressCompletionAutoStart = consumeSqlCompletionAutoStartSuppression();
            if (!suppressCompletionAutoStart && shouldStartSqlCompletionAfterInput(insertedText, removedText, update.view)) {
              scheduleSqlCompletionStart(update.view);
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
        [DBX_VIM_SAVE_EVENT]() {
          emit("save");
          return true;
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
          const currentView = view.value;
          if (currentView && startEditorSelectionDrag(currentView, event)) {
            return true;
          }
          // Click without modifier -> close column panel
          if (!event.metaKey && !event.ctrlKey) {
            if (event.button === 0) {
              emit("closeColumnPanel");
            }
            return false;
          }
          // Only handle Ctrl/Cmd + left click
          if (event.button !== 0) return false;

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
          const extracted = extractIdentifierDetailsAt(doc, pos);
          if (!extracted) {
            return false;
          }
          if (!extracted.quoted && isSqlKeyword(extracted.identifier)) {
            return false;
          }
          const identifier = extracted.identifier;

          // Prevent default, resolve async
          event.preventDefault();
          setTimeout(async () => {
            try {
              const identifierParts = splitQualifiedIdentifier(identifier);
              const tableLookupFilter = identifierParts[identifierParts.length - 1] ?? identifier;

              // Ensure table cache is populated
              if (cachedTables.length === 0) {
                // Some metadata providers only accept table-name masks, not schema.table masks.
                cachedTables = usesLocalOnlyCompletionMetadata()
                  ? connectionStore.lookupLocalCompletionTables(props.connectionId!, props.database!, tableLookupFilter, MAX_COMPLETION_TABLES, props.schema)
                  : await connectionStore.listCompletionTables(props.connectionId!, props.database!, tableLookupFilter, MAX_COMPLETION_TABLES, props.schema, false, props.schema);
              }

              // 1. Check if it's a table name
              const matchedTable = matchTable(identifier, cachedTables);
              if (matchedTable) {
                emit("clickTable", sqlObjectNavigationTarget(matchedTable));
                return;
              }

              // 2. Parse SQL at click position to get referenced tables
              const context = getSqlCompletionContext(doc, pos);
              let referencedTables: Array<SqlCompletionReferencedTable & Pick<SqlCompletionTable, "type">> = context.referencedTables;
              // Enrich referenced tables with schema from cachedTables
              referencedTables = referencedTables.map((rt) => {
                const cached = cachedTables.find((ct) => ct.name.toLowerCase() === rt.name.toLowerCase() && (!rt.schema || !ct.schema || ct.schema.toLowerCase() === rt.schema.toLowerCase()));
                if (!cached) return rt;
                return {
                  ...rt,
                  ...(!rt.schema && cached.schema ? { schema: cached.schema } : {}),
                  ...(cached.type ? { type: cached.type } : {}),
                };
              });

              // Check if identifier has a qualifier (e.g., c.card_name or schema.table)
              const qualifier = identifierParts.length >= 2 ? identifierParts[identifierParts.length - 2] : null;

              const matchedRef = matchTable(identifier, referencedTables);
              if (matchedRef) {
                emit("clickTable", sqlObjectNavigationTarget(matchedRef));
                return;
              }
              const colName = identifierParts[identifierParts.length - 1] ?? identifier;
              const colLower = colName.toLowerCase();

              if (referencedTables.length === 0) {
                return;
              }
              // 3. Fetch columns — if qualifier, only check matching table; otherwise check all
              const tablesToCheck = qualifier ? referencedTables.filter((rt) => rt.alias?.toLowerCase() === qualifier.toLowerCase() || rt.name.toLowerCase() === qualifier.toLowerCase()) : referencedTables;

              if (tablesToCheck.length === 0 && qualifier) {
                return;
              }

              const matchedCols: Array<{
                name: string;
                table: string;
                schema?: string;
              }> = [];

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
  registerEditorScrollbarPointerGuard(view.value);
  view.value.scrollDOM.addEventListener("scroll", scheduleEditorViewportEmit, {
    passive: true,
  });
  restoreEditorViewport();
  syncContextMenuState(view.value);
  syncEditorFontCssVars(liveFontSize.value, initialSettings.fontFamily);
  registerTableReferenceDropListener();

  cachedTables = [];
  cachedCompletionObjects = [];
  scheduleSemanticDiagnostics();

  if (props.autoFocus) {
    // Query tabs opt in; shared editor instances must preserve the surrounding UI focus.
    nextTick(() => {
      requestAnimationFrame(() => {
        focusEditorView(view.value);
      });
    });
  }

  // Ensure theme is applied with the latest settings after mount
  void nextTick(async () => {
    if (!view.value || !codeMirrorTheme) return;
    const settings = settingsStore.editorSettings;
    const themeColors = settings.theme === "custom" ? getCurrentCustomThemeColors() : settings.customThemeColors;
    const themeExt = await loadEditorTheme(settings.theme, editorThemeAppearance(), themeColors, themePalette.value);
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
      scheduleSemanticDiagnostics();
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
  () => props.statementExecutionMarkers ?? [],
  (markers) => {
    if (!view.value || !setStatementExecutionMarkersEffect) return;
    view.value.dispatch({
      effects: setStatementExecutionMarkersEffect.of(markers),
    });
  },
  { deep: true },
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

watch([() => props.databaseType, () => props.dialect, () => props.syntaxDialect], () => {
  executableStatementRangeCache = null;
  if (!view.value || !sqlLanguageComp || !buildSqlLanguageExtension || !sqlSemanticHighlightComp || !buildSqlSemanticHighlightExtension) return;
  view.value.dispatch({
    effects: [sqlLanguageComp.reconfigure(buildSqlLanguageExtension()), sqlSemanticHighlightComp.reconfigure(buildSqlSemanticHighlightExtension())],
  });
});

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
  [queryEditorAppearanceSettings, () => isDark.value, () => themePalette.value],
  async ([ss]) => {
    if (!view.value || !codeMirrorTheme || !fontThemeComp || !wordWrapComp || !vimModeComp || !closeBracketsComp || !runGutterComp || !runKeymapComp || !editorViewModule) {
      return;
    }
    if (!isGestureZooming.value && !zoomCommitScheduler.hasPendingCommit() && liveFontSize.value !== ss.fontSize) {
      liveFontSize.value = ss.fontSize;
    }
    syncEditorFontCssVars(liveFontSize.value, ss.fontFamily);
    const themeColors = getCurrentCustomThemeColors();
    const [themeExt] = await Promise.all([loadEditorTheme(ss.theme, editorThemeAppearance(), themeColors, themePalette.value), ss.vimModeEnabled ? ensureCodeMirrorVim() : Promise.resolve(false)]);
    if (!view.value || !codeMirrorTheme || !wordWrapComp || !vimModeComp || !closeBracketsComp || !runGutterComp || !runKeymapComp || !editorViewModule) {
      return;
    }
    view.value.dispatch({
      effects: [
        codeMirrorTheme.reconfigure(themeExt),
        wordWrapComp.reconfigure(props.forceWordWrap || ss.wordWrap ? editorViewModule.EditorView.lineWrapping : []),
        vimModeComp.reconfigure(vimModeExtension(settingsStore.editorSettings.vimModeEnabled)),
        closeBracketsComp.reconfigure(closeBracketsExtension(settingsStore.editorSettings.autoCloseBrackets)),
        runGutterComp.reconfigure(props.hideExecutionControls ? [] : (buildRunStatementGutterExtension?.() ?? [])),
        runKeymapComp.reconfigure(runKeymapExtension(editorViewModule.keymap)),
      ],
    });
  },
  { deep: true },
);

watch(
  () => [settingsStore.editorSettings.sqlFormatter.tabWidth, settingsStore.editorSettings.sqlFormatter.useTabs],
  () => {
    if (!view.value || !indentComp) return;
    view.value.dispatch({ effects: indentComp.reconfigure(indentExtension()) });
  },
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

watch(
  () => settingsStore.editorSettings.sqlSemanticDiagnosticsEnabled,
  (enabled) => {
    if (props.databaseType === "redis") return;
    if (!shouldSkipSqlSemanticDiagnostics() && enabled) {
      scheduleSemanticDiagnostics(0);
      return;
    }
    clearScheduledSemanticDiagnostics();
    setSemanticDiagnostics([]);
  },
);

watch(
  () => settingsStore.editorSettings.showInsertValueHints,
  () => {
    if (view.value) requestInsertValueHintsRefresh(view.value);
  },
);

function pauseQueryEditorBackgroundWork() {
  flushEditorViewport();
  flushEditorSelection();
  clearTableNavigationHover();
  editorIsActive = false;
  clearScheduledSemanticDiagnostics();
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
  editorScrollbarPointerCleanup?.();
  editorSelectionDragCleanup?.();
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

function sameEditorViewport(a: { scrollTop: number; scrollLeft: number } | undefined, b: { scrollTop: number; scrollLeft: number }) {
  return a?.scrollTop === b.scrollTop && a.scrollLeft === b.scrollLeft;
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
    focusEditorView(view.value);
  };
  focusEditorAcrossFrames();
  nextTick(() => {
    focusEditorAcrossFrames();
    requestAnimationFrame(focusEditorAcrossFrames);
  });
}

function emitEditorViewport(viewport: { scrollTop: number; scrollLeft: number }) {
  if (sameEditorViewport(lastEmittedViewport, viewport)) return;
  lastEmittedViewport = { ...viewport };
  emit("viewportChange", viewport);
}

function scheduleEditorViewportEmit() {
  if (!view.value || !editorIsActive) return;
  latestViewport = readEditorViewport(view.value);
  scheduleSemanticDiagnostics(700, { preserveOutsideRanges: true });
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

defineExpose({
  openSearch,
  openReplace,
  scrollCursorIntoView,
  requestExecute,
  pasteClipboardAsSqlInCondition,
  previewStatementRange,
  refreshCompletionCache,
});
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
    <DelimitedListDialog v-model:open="delimitedListOpen" :selected-text="delimitedListSelectedText" @confirm="applyDelimitedListResult" />
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

:deep(.cm-lineNumbers .cm-db-result-source-line-number) {
  color: rgb(126 34 206) !important;
  font-weight: 700;
}

:global(.dark) :deep(.cm-lineNumbers .cm-db-result-source-line-number) {
  color: rgb(216 180 254) !important;
}

:deep(.cm-db-current-statement-line) {
  position: relative;
}

:deep(.cm-db-current-statement-line::after) {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  box-sizing: border-box;
  width: var(--dbx-current-statement-frame-width, 100%);
  border-right: 1px solid rgb(34 197 94 / 0.75);
  border-left: 1px solid rgb(34 197 94 / 0.75);
  pointer-events: none;
}

:deep(.cm-db-current-statement-line--first::after) {
  border-top: 1px solid rgb(34 197 94 / 0.75);
}

:deep(.cm-db-current-statement-line--last::after) {
  border-bottom: 1px solid rgb(34 197 94 / 0.75);
}

:deep(.cm-run-statement-gutter) {
  min-width: 34px;
}

:deep(.cm-run-statement-gutter .cm-gutterElement) {
  align-items: center;
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  min-width: 34px;
  padding: 0 5px;
}

:deep(.cm-statement-execution-gutter) {
  min-width: 34px;
}

:deep(.cm-statement-execution-gutter .cm-gutterElement) {
  align-items: center;
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  min-width: 34px;
  padding: 0 5px;
}

:deep(.cm-statement-execution-marker) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: min(24px, calc(var(--dbx-editor-font-size, 13px) * 1.6));
  height: min(24px, calc(var(--dbx-editor-font-size, 13px) * 1.6));
  margin: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  vertical-align: middle;
  white-space: nowrap;
  transition:
    color 0.15s,
    background-color 0.15s;
  user-select: none;
  flex-shrink: 0;
}

:deep(.cm-statement-execution-marker--success) {
  background: rgb(16 185 129 / 0.1);
  color: rgb(4 120 87);
}

:deep(.cm-statement-execution-marker--error) {
  background: rgb(239 68 68 / 0.1);
  color: rgb(185 28 28);
}

:deep(.dark .cm-statement-execution-marker--success) {
  color: rgb(110 231 183);
}

:deep(.dark .cm-statement-execution-marker--error) {
  color: rgb(252 165 165);
}

:deep(.cm-statement-execution-marker svg) {
  display: block;
  width: min(14px, 70%);
  height: min(14px, 70%);
  pointer-events: none;
  flex-shrink: 0;
}

:deep(.cm-run-statement-marker) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: min(24px, calc(var(--dbx-editor-font-size, 13px) * 1.6));
  height: min(24px, calc(var(--dbx-editor-font-size, 13px) * 1.6));
  margin: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: transparent;
  vertical-align: middle;
  white-space: nowrap;
  transition:
    color 0.15s,
    background-color 0.15s;
  outline: none;
  user-select: none;
  flex-shrink: 0;
}

:deep(.cm-run-statement-marker--active) {
  background: rgb(16 185 129 / 0.1);
  color: rgb(4 120 87);
  cursor: pointer;
}

:deep(.cm-run-statement-marker--active:hover) {
  background: rgb(16 185 129 / 0.2);
  color: rgb(6 95 70);
}

:deep(.dark .cm-run-statement-marker--active) {
  color: rgb(110 231 183);
}

:deep(.dark .cm-run-statement-marker--active:hover) {
  color: rgb(167 243 208);
}

:deep(.cm-run-statement-marker svg) {
  display: block;
  width: min(14px, 70%);
  height: min(14px, 70%);
  pointer-events: none;
  flex-shrink: 0;
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
