<script lang="ts">
// Replay guard for the toolbar format/compress requests. The ids are global
// monotonic counters shared by every tab, and ContentArea delivers them by
// gating the inactive tab's prop back to `undefined`; returning to the tab
// re-arms the same stale id on the reused editor instance (a replay, not a new
// command). The cursors live at module scope — not in `<script setup>` — so
// they also survive an editor unmount/remount (data-page switches), letting a
// freshly mounted editor consume the stale id instead of replaying it. The
// check is strictly monotonic (`>`), not `!==`: because ids are shared across
// tabs, a lower id is always an already-handled request from an active tab
// (delivery is same-tick), never a pending undelivered one.
let lastHandledFormatRequestId = 0;
let lastHandledCompressRequestId = 0;
</script>

<script setup lang="ts">
import { useQueryEditorCompletionKeys } from "./useQueryEditorCompletionKeys";
import { useQueryEditorPointer } from "./useQueryEditorPointer";
import { useQueryEditorTableDrop } from "./useQueryEditorTableDrop";
import { createQueryEditorHoverContent } from "./queryEditorHoverContent";
import { useQueryEditorHover } from "./useQueryEditorHover";
import { useQueryEditorObjectNavigation } from "./useQueryEditorObjectNavigation";

import { useQueryEditorCodeMirror } from "./useQueryEditorCodeMirror";
import { configureQueryEditorSqlExtensions } from "./queryEditorSqlExtensions";
import { useQueryEditorStatementBoundaries } from "./useQueryEditorStatementBoundaries";
import { createQueryEditorCodeMirrorRuntime } from "./queryEditorCodeMirrorRuntime";
import { useQueryEditorCompletion } from "./useQueryEditorCompletion";

import { useQueryEditorCompletionMetadata } from "./useQueryEditorCompletionMetadata";
import { ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, shallowRef, computed, nextTick } from "vue";
import { useI18n } from "vue-i18n";

import { Transaction } from "@codemirror/state";
import type { Text } from "@codemirror/state";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { search as cmSearch } from "@codemirror/search";
import { useQueryEditorBatchSelection } from "./useQueryEditorBatchSelection";
import { useQueryEditorDiagnostics } from "./useQueryEditorDiagnostics";
import { useQueryEditorDocumentState } from "./useQueryEditorDocumentState";
import type { QueryEditorProps } from "./queryEditorTypes";
import { useQueryEditorLayout } from "./useQueryEditorLayout";
import { useQueryEditorExecution } from "./useQueryEditorExecution";
import { useQueryEditorTextActions } from "./useQueryEditorTextActions";
import { useQueryEditorIntentions } from "./useQueryEditorIntentions";
import QueryEditorIntentionPopup from "./QueryEditorIntentionPopup.vue";
import EditorSearchPanel from "./EditorSearchPanel.vue";
import EditorGotoLinePanel from "./EditorGotoLinePanel.vue";
import SqlExecutionTargetPicker from "./SqlExecutionTargetPicker.vue";
import DelimitedListDialog from "./DelimitedListDialog.vue";
import TableStructurePeekDialog from "./TableStructurePeekDialog.vue";
import type { TableStructurePeekInsertKind } from "./TableStructurePeekDialog.vue";
import type { ColumnInfo } from "@/types/database";
import { createColumnReferencePayload, tableReferenceInsertText } from "@/lib/editor/queryEditorTableDrop";
import { clearRememberedFocusedQueryEditorView, focusedQueryEditorView, queryEditorInsertContext, registerQueryEditorInsertContext, rememberFocusedQueryEditorView, unregisterQueryEditorInsertContext } from "@/lib/editor/focusedQueryEditorView";
import { loadObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import { structurePeekPanelId } from "@/lib/editor/structurePeekPanel";
import CodeSnapshotDialog from "@/components/codeSnapshot/CodeSnapshotDialog.vue";
import QueryEditorContextMenu, { type QueryEditorContextMenuState, type QueryEditorContextMenuActions } from "./QueryEditorContextMenu.vue";

import { readTextFromClipboard } from "@/lib/common/clipboard";

import { resolveExecutableSql, type SqlExecutionOverride } from "@/lib/sql/sqlExecutionTarget";
import { supportsExecutionTargetPicker, type SqlTextRange } from "@/lib/sql/sqlStatementRanges";
import { executableStatementRangeAtCursor, executableStatementRangeCacheForDoc, executableStatementRangeStartingAt as executableStatementRangeStartingAtLine, type ExecutableStatementRangeCache } from "@/lib/sql/executableStatementRangeCache";

import { looksLikeDmlStatement } from "@/lib/sql/dmlChangePreview";

import { canFormatSqlForDatabaseType, formatSqlForEditing, compressSqlText } from "@/lib/sql/sqlFormatter";
import { detectAndFormatStructured } from "@/lib/sql/autoFormat";
import { enabledSqlParameterSyntaxes, resolveSqlVariableSyntaxToggles } from "@/lib/sql/sqlVariableSyntax";

import { createQueryEditorExecutionViewportOwnership, isQueryEditorPositionVisible } from "@/lib/editor/queryEditorExecutionViewport";
import { joinQueryEditorLines } from "@/lib/editor/queryEditorJoinLines";

import { resolveSqlSingleQuoteKeyAction } from "@/lib/sql/sqlQuoteCaret";

import { formatMongoShellText } from "@/lib/mongo/mongoFormatter";
import { detectAndFormatElasticsearchRequests } from "@/lib/elasticsearch/elasticsearchFormatter";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import { buildSelectStarExpansion, selectStarResultColumnsMatch } from "@/lib/sql/sqlCompletion";

import { sqlCompletionContextFromSemantic, sqlSemanticSelectStarIsOnlyProjection, sqlSemanticSelectStarQualifierSql, sqlSemanticSelectStarTableSources } from "@/lib/sql/semantic/completion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";

import { sqlObjectNavigationSourceKind, type SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";

import { EDITOR_FONT_FAMILY_CSS_VAR, EDITOR_FONT_SIZE_CSS_VAR, editorDiagnosticColors, editorThemeAppearanceFor, loadEditorTheme, editorFontTheme, sqlCompletionTheme } from "@/lib/editor/editorThemes";
import { shouldShowStatementGutter } from "@/lib/editor/codemirrorStatementGutter";

import { createQueryEditorSqlShortcutDomHandler, isCharacterProducingShortcut } from "@/lib/editor/queryEditorSqlShortcut";
import { createQueryEditorReplaceShortcutBindings, createQueryEditorReplaceShortcutHandler, createQueryEditorSearchKeymap } from "@/lib/editor/queryEditorSearchKeymap";
import { createQueryEditorEscapeHandler } from "@/lib/editor/queryEditorEscape";
import { buildQueryEditorLineNumbersExtension, createQueryEditorLineNumberAlignmentExtension } from "@/lib/editor/queryEditorLineNumbers";
import { searchKeymapWithoutModD } from "@/lib/editor/codemirrorSearchKeymap";
import { defaultKeymapForGlobalShortcuts } from "@/lib/editor/codemirrorDefaultKeymap";
import { createShowWhitespaceExtension } from "@/lib/editor/codemirrorShowWhitespace";

import { clampEditorFontSize, createEditorWheelZoomGestureGuard, createEditorZoomCommitScheduler, fontSizeFromGestureScale, fontSizeFromWheelDelta } from "@/lib/editor/editorZoom";
import { buildSqlShortcutExecutionSql, enabledSqlShortcutActions, resolveSqlShortcutForDatabase, uniqueSqlShortcutBindings } from "@/lib/sql/sqlShortcutActions";
import { resolveSqlShortcutTableToken } from "@/lib/sql/sqlShortcutTableTarget";
import { normalizeShortcutSettings, shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";
import { trimmedSelectionLayer } from "@/lib/editor/codemirrorTrimmedSelectionLayer";
import { editorClipboardLineEndingsExtension } from "@/lib/editor/editorClipboardLineEndings";

import { selectionMatchOccurrences } from "@/lib/editor/codemirrorSelectionMatches";

import { createInsertValueHintsExtension, requestInsertValueHintsRefresh, supportsInsertValueHints } from "@/lib/editor/codemirrorInsertValueHints";
import { sqlBlockFoldService } from "@/lib/editor/codemirrorSqlBlockFolding";
import { focusEditorView } from "@/lib/editor/queryEditorFocus";

import { startsQueryEditorRectangularSelection } from "@/lib/editor/queryEditorPointerSelection";
import { LARGE_PASTE_HISTORY_USER_EVENT, normalizeQueryEditorPasteText, recoverableNativePasteSuffix, shouldRecoverLargeTauriPaste } from "@/lib/editor/queryEditorLargePaste";

import { computePasteCaretResyncTarget } from "@/lib/editor/queryEditorPasteCaretResync";

import { extendQueryEditorSelection, runQueryEditorAltExtendSelection } from "@/lib/editor/queryEditorExtendSelection";
import { addNextQueryEditorSelectionOccurrence, selectAllQueryEditorSelectionOccurrences } from "@/lib/editor/queryEditorOccurrenceSelection";
import { createQueryEditorStringMouseSelection } from "@/lib/editor/queryEditorStringMouseSelection";
import { createQueryEditorCompletionShortcutBindings } from "@/lib/editor/queryEditorCompletionShortcut";
import { createQueryEditorSelectionCaseShortcutBindings } from "@/lib/editor/queryEditorSelectionCaseShortcut";

import { createQueryEditorExecutionShortcutBindings, createQueryEditorPostCompositionKeyGuard } from "@/lib/editor/queryEditorExecutionShortcut";

import { supportsQueryEditorBlockComments, supportsSqlInListPaste } from "@/lib/database/databaseFeatureSupport";

import { queryContextObjectRoute, queryTableCandidateAtSqlPosition, resolveQueryContextCandidateDatabase, resolveQueryContextObjectTarget, type QueryContextObjectAction } from "@/lib/sql/queryCursorTableTarget";
import * as api from "@/lib/backend/api";

import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

import { resolveSqlDialectId } from "@/lib/sql/semantic/dialect";

import type { SqlCompletionColumn, SqlCompletionContext, SqlCompletionReferencedTable } from "@/lib/sql/sqlCompletion";

const props = defineProps<QueryEditorProps>();

function sqlBehaviorDialect(): "mysql" | "postgres" | "sqlserver" | undefined {
  return props.syntaxDialect === "clickhouse" ? props.dialect : (props.syntaxDialect ?? props.dialect);
}

function queryEditorSelectionLanguage(): "sql" | "text" {
  const databaseType = props.databaseType;
  return databaseType === "redis" || databaseType === "mongodb" || databaseType === "elasticsearch" || databaseType === "easysearch" || databaseType === "meilisearch" || databaseType === "solr" || databaseType === "victoriametrics" ? "text" : "sql";
}

const COMPLETION_REMOTE_LATENCY_BUDGET_MS = 120;
const COMPLETION_DEBOUNCE_DELAY_MS = 150;
const COMPLETION_TRIGGER_DEFER_DELAY_MS = 50;
const COMPLETION_TAB_RETRY_DELAY_MS = 16;
const COMPLETION_TAB_MAX_WAIT_MS = COMPLETION_DEBOUNCE_DELAY_MS + COMPLETION_REMOTE_LATENCY_BUDGET_MS + 100;
const COMPLETION_ENTER_MAX_WAIT_MS = 125;
// Signature-help only ever looks backward from the cursor; past this distance
// no human-authored call site is worth the scan on huge documents.
const SQL_SIGNATURE_HELP_WINDOW_CHARS = 10_000;
// Internal rollback switch: flip to false to route completion, diagnostics, and navigation through the legacy SQL context path.
const SEMANTIC_SQL_COMPLETION_ENABLED = true;

const emit = defineEmits<{
  "update:modelValue": [value: string];
  selectionChange: [value: string];
  cursorChange: [pos: number];
  previewChangesAvailable: [value: boolean];
  formatError: [message: string];
  execute: [source: SqlExecutionOverride];
  executeInNewResultTab: [source: SqlExecutionOverride];
  explain: [];
  exportQuery: [payload: { sql: string; format: "csv" | "xlsx" | "txt"; columnComments?: (string | null)[] }];
  save: [];
  clickTable: [target: SqlObjectNavigationTarget];
  viewTableData: [target: SqlObjectNavigationTarget];
  viewTableDdl: [target: SqlObjectNavigationTarget];
  editTableStructure: [target: SqlObjectNavigationTarget];
  openObjectSource: [target: SqlObjectNavigationTarget, initialEditing: boolean];
  clickColumn: [columns: Array<{ name: string; table: string; schema?: string }>, error?: string | undefined];
  closeColumnPanel: [];
  viewportChange: [viewport: { scrollTop: number; scrollLeft: number }, tabId?: string];
  selectionStateChange: [selection: { anchor: number; head: number }];
  editorStateFlushed: [];
  editorRevealConsumed: [];
  sendSelectionToAi: [sql: string];
}>();

const editorRef = ref<HTMLDivElement>();

useQueryEditorLayout(editorRef);

const view = shallowRef<EditorViewType | null>(null);
const contextMenuOpen = ref(false);
let contextMenuPointerCleanup: (() => void) | null = null;

const executionViewportOwnership = createQueryEditorExecutionViewportOwnership();

let contextMenuDoc: Text | null = null;
let contextMenuDocText = "";
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();

function sqlStatementParameterOptions() {
  const toggles = resolveSqlVariableSyntaxToggles(settingsStore.editorSettings.sqlVariableSyntaxOverrides, props.databaseType, settingsStore.editorSettings.sqlVariableSubstitutionEnabled);
  return {
    databaseType: props.databaseType,
    compatibilityMode: props.databaseType === "opengauss" ? connectionStore.databaseCompatibilityMode(props.connectionId, props.database) : undefined,
    enabledSyntaxes: enabledSqlParameterSyntaxes(toggles),
  };
}
const { isDark, themePalette, activeCustomUiColors } = useTheme();
const { t } = useI18n();
const { toast } = useToast();
const sqlDriverProfile = computed(() => (props.connectionId ? connectionStore.getConfig(props.connectionId)?.driver_profile : undefined));
const MAX_COMPLETION_TABLES = 200;
const PRESTO_ON_DEMAND_TABLE_COMPLETION_MIN_PREFIX = 2;
const PRESTO_ON_DEMAND_TABLE_COMPLETION_LIMIT = 20;

const liveFontSize = ref(settingsStore.editorSettings.fontSize);
const gestureStartFontSize = ref(settingsStore.editorSettings.fontSize);
const isGestureZooming = ref(false);

const { pickerVisible, pickerCandidates, pickerActiveIndex, pickerAnchor, captureExecutionSnapshot, requestExecute, requestExecuteInNewResultTab, onPickerActiveIndexChange, onPickerConfirm, closePicker, sqlExecutionSnapshotFromView, sqlExecutionSnapshotForRange } = useQueryEditorExecution({
  props,
  view,
  editorRef,
  settingsStore,
  executionViewportOwnership,
  sqlStatementParameterOptions,
  setPreviewRange,
  emitExecutionRequest,
  onExecute: (source) => emit("execute", source),
});

const searchPanelRef = ref<InstanceType<typeof EditorSearchPanel>>();
const gotoLinePanelRef = ref<InstanceType<typeof EditorGotoLinePanel>>();
const { intentionPopup, closeIntentionPopup, executeIntentionAction, handleSqlIntentionActions } = useQueryEditorIntentions({ props, view, sqlBehaviorDialect, focusEditor });

const selectedSql = ref("");
const {
  delimitedListOpen,
  delimitedListSelectedText,
  codeSnapshotOpen,
  codeSnapshotSource,
  openCodeSnapshot,
  openDelimitedListDialog,
  applyDelimitedListResult,
  copySelectedSqlFromContextMenu,
  copySelectedSqlAsRichTextFromContextMenu,
  cutSelectedSqlFromContextMenu,
  pasteClipboardSqlFromContextMenu,
  toggleCommentFromContextMenu,
  toggleBlockCommentFromContextMenu,
  selectAllSqlFromContextMenu,
  convertSelectedSqlCase,
  convertSelectedNamingStyle,
  pasteClipboardAsSqlInCondition,
  deleteEmptyLines,
} = useQueryEditorTextActions({
  props,
  view,
  selectedSql,
  settingsStore,
  sqlBehaviorDialect,
  focusEditor,
  getEditorSelection: () => codeMirrorRuntime.codeMirrorEditorSelection,
  toggleLineComment: (currentView) => {
    codeMirrorRuntime.codeMirrorToggleLineComment?.(currentView);
  },
  toggleBlockComment: (currentView) => {
    codeMirrorRuntime.codeMirrorToggleBlockComment?.(currentView);
  },
});
const executableSql = ref("");
const previewContextSql = ref("");
interface StructurePeekPanelState {
  id: string;
  target: SqlObjectNavigationTarget;
  columns: ColumnInfo[];
  loading: boolean;
  error: string;
  zIndex: number;
  cascadeIndex: number;
  requestId: number;
}

const structurePeekPanels = ref<StructurePeekPanelState[]>([]);
let structurePeekRequestSeq = 0;
let structurePeekZIndexSeq = 50;
let structurePeekCascadeSeq = 0;

function bringStructurePeekToFront(panelId: string) {
  const panel = structurePeekPanels.value.find((item) => item.id === panelId);
  if (!panel) return;
  structurePeekZIndexSeq += 1;
  panel.zIndex = structurePeekZIndexSeq;
}

function closeStructurePeekPanel(panelId: string) {
  structurePeekPanels.value = structurePeekPanels.value.filter((item) => item.id !== panelId);
}

async function loadStructurePeekColumns(panelId: string, requestId: number, target: SqlObjectNavigationTarget, database: string, schema: string) {
  if (!props.connectionId) return;
  try {
    const objectMetadataRequest = {
      connectionId: props.connectionId,
      database,
      schema,
      tableName: target.name,
      catalog: props.catalog,
      objectType: sqlObjectNavigationSourceKind(target),
    };
    const { value } = await loadObjectMetadataFacet(objectMetadataRequest, "columns", () => api.getColumns(props.connectionId!, database, schema, target.name, props.catalog, props.clientSessionId));
    const current = structurePeekPanels.value.find((item) => item.id === panelId && item.requestId === requestId);
    if (!current) return;
    current.columns = value;
    current.error = "";
    current.loading = false;
  } catch (error: unknown) {
    const current = structurePeekPanels.value.find((item) => item.id === panelId && item.requestId === requestId);
    if (!current) return;
    current.error = error instanceof Error ? error.message : String(error);
    current.columns = [];
    current.loading = false;
  }
}

async function openTableStructurePeek(target: SqlObjectNavigationTarget) {
  if (!props.connectionId) return;
  const database = target.database || props.database || "";
  const schema = target.schema ?? props.schema ?? "";
  const id = structurePeekPanelId(props.connectionId, database, schema, target.name, props.catalog);
  const existing = structurePeekPanels.value.find((item) => item.id === id);
  if (existing) {
    bringStructurePeekToFront(existing.id);
    // Retry when a previous open left the panel in an error state.
    if (existing.error && !existing.loading) {
      const requestId = ++structurePeekRequestSeq;
      existing.requestId = requestId;
      existing.loading = true;
      existing.error = "";
      existing.columns = [];
      await loadStructurePeekColumns(existing.id, requestId, existing.target, database, schema);
    }
    return;
  }

  structurePeekZIndexSeq += 1;
  const requestId = ++structurePeekRequestSeq;
  const cascadeIndex = structurePeekCascadeSeq++;
  const panel: StructurePeekPanelState = {
    id,
    target: { ...target, database, schema: schema || target.schema },
    columns: [],
    loading: true,
    error: "",
    zIndex: structurePeekZIndexSeq,
    cascadeIndex,
    requestId,
  };
  structurePeekPanels.value = [...structurePeekPanels.value, panel];
  await loadStructurePeekColumns(id, requestId, panel.target, database, schema);
}

function syncQueryEditorInsertContext(currentView: EditorViewType | null = view.value) {
  if (!currentView) return;
  registerQueryEditorInsertContext(currentView, {
    connectionId: props.connectionId,
    database: props.database,
    schema: props.schema,
    databaseType: props.databaseType,
  });
}

function insertStructurePeekValue(panel: StructurePeekPanelState, value: string, kind: TableStructurePeekInsertKind) {
  if (!value) return;
  // Insert into the focused query editor, or the last one if focus is inside peek chrome.
  // Focus elsewhere (sidebar, etc.) → no-op.
  const targetView = focusedQueryEditorView();
  if (!targetView || targetView.state.readOnly) return;

  const targetCtx = queryEditorInsertContext(targetView);
  const connectionId = targetCtx?.connectionId ?? props.connectionId;
  const databaseType = targetCtx?.databaseType ?? props.databaseType;
  const database = panel.target.database || targetCtx?.database || props.database || "";

  let insertText = value;
  if (kind === "identifier" && connectionId && database != null) {
    const payload = createColumnReferencePayload({
      connectionId,
      database,
      schema: panel.target.schema ?? targetCtx?.schema ?? props.schema,
      columnNames: [value],
      databaseType,
      columnNameSeparator: settingsStore.editorSettings.sidebarCopyTableNameSeparator,
    });
    if (payload) {
      insertText = tableReferenceInsertText(payload, databaseType, {
        columnNameSeparator: settingsStore.editorSettings.sidebarCopyTableNameSeparator,
      });
    }
  }

  // Peek inserts at the caret (or replaces a non-empty selection). Do not use
  // replaceSelectedEditorText — that helper requires a selection and no-ops on caret.
  const selection = targetView.state.selection.main;
  const from = selection.from;
  const to = selection.empty ? from : selection.to;
  targetView.dispatch({
    changes: { from, to, insert: insertText },
    selection: { anchor: from + insertText.length },
    scrollIntoView: true,
    userEvent: "input.type",
  });
  focusEditorView(targetView);
  rememberFocusedQueryEditorView(targetView);
}

const contextObjectTarget = ref<SqlObjectNavigationTarget | null>(null);

interface SelectStarExpansionTarget {
  from: number;
  to: number;
  references: SqlCompletionReferencedTable[];
  context: SqlCompletionContext;
  qualifierSql?: string;
  statementSql: string;
  allowResultColumnsFallback: boolean;
}

const selectStarExpansionTarget = ref<SelectStarExpansionTarget | null>(null);

const canExecuteContextSql = computed(() => executableSql.value.trim().length > 0);

interface EditorGestureEvent extends Event {
  scale?: number;
}

const codeMirrorRuntime = createQueryEditorCodeMirrorRuntime();

let previewContextRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let editorIsActive = true;

let imeCompositionActive = false;
let pendingImeModelEmit = false;
const postCompositionKeyGuard = createQueryEditorPostCompositionKeyGuard();
let postCompositionKeyGuardCleanup: (() => void) | null = null;

function runStatementGutterExtension(): import("@codemirror/state").Extension {
  const showRunButtons = !props.hideExecutionControls && settingsStore.editorSettings.showStatementRunButtons;
  return shouldShowStatementGutter(showRunButtons) ? (codeMirrorRuntime.buildRunStatementGutterExtension?.() ?? []) : [];
}

let executableStatementRangeCache: ExecutableStatementRangeCache | null = null;

const statementBoundaries = useQueryEditorStatementBoundaries({
  props,
  view,
  sqlStatementParameterOptions,
  runtime: codeMirrorRuntime,
  cache: {
    get value() {
      return executableStatementRangeCache;
    },
    set value(value) {
      executableStatementRangeCache = value;
    },
  },
});

const DBX_VIM_SAVE_EVENT = "dbx-vim-save";

function editorThemeAppearance() {
  return editorThemeAppearanceFor(isDark.value ? "dark" : "light", themePalette.value, themePalette.value === "custom" ? activeCustomUiColors.value : undefined);
}

const completionMetadata = useQueryEditorCompletionMetadata({
  props,
  view,
  connectionStore,
  sqlBehaviorDialect,
  remoteLatencyBudgetMs: COMPLETION_REMOTE_LATENCY_BUDGET_MS,
  maxCompletionTables: MAX_COMPLETION_TABLES,
  onDemandMinPrefix: PRESTO_ON_DEMAND_TABLE_COMPLETION_MIN_PREFIX,
  semanticCompletionEnabled: SEMANTIC_SQL_COMPLETION_ENABLED,
});
const {
  sqlCompletionDialectOptions,
  getEditorSqlCompletionContext,
  ensureColumnsForTable,
  cachedColumnsByTable,
  completionCacheKey,
  usesOracleSessionCompletionColumns,
  cachedCompletionObjectsByScope,
  loadedColumnsByTable,
  findExactSemanticDiagnosticTable,
  isMissingTableMetadataError,
  getInsertValueHintTableColumns,
  requestInsertValueHintTableColumns,
  refreshCompletionCache,
} = completionMetadata;
const hoverContent = createQueryEditorHoverContent({ isDark, t, toast });
const { resolveSqlHoverTooltip } = useQueryEditorHover({ props, contextMenuOpen, settingsStore, connectionStore, metadata: completionMetadata, createHoverDom: hoverContent.createHoverDom, semanticCompletionEnabled: SEMANTIC_SQL_COMPLETION_ENABLED, maxCompletionTables: MAX_COMPLETION_TABLES });
const pointerInteractions = useQueryEditorPointer({ props, clearTableNavigationHover: () => clearTableNavigationHover(), emit });
const { registerEditorScrollbarPointerGuard, startEditorSelectionDrag } = pointerInteractions;
const tableDrop = useQueryEditorTableDrop({ props, view, editorRef, settingsStore });
const { hasDroppedTableReference, insertDroppedTableReference, queryEditorDropCaret, queryEditorDropCaretStyle, showQueryEditorDropCaretAt, hideQueryEditorDropCaret, registerTableReferenceDropListener, unregisterTableReferenceDropListener } = tableDrop;
const objectNavigation = useQueryEditorObjectNavigation({
  props,
  view,
  editorRef,
  settingsStore,
  connectionStore,
  metadata: completionMetadata,
  runtime: codeMirrorRuntime,
  semanticCompletionEnabled: SEMANTIC_SQL_COMPLETION_ENABLED,
  maxCompletionTables: MAX_COMPLETION_TABLES,
  dismissHoverTooltip,
  startEditorSelectionDrag,
  emit,
});
const { clearTableNavigationHover, updateTableNavigationHover, onEditorMouseDown } = objectNavigation;

const zoomCommitScheduler = createEditorZoomCommitScheduler((fontSize) => {
  if (settingsStore.editorSettings.fontSize === fontSize) return;
  settingsStore.updateEditorSettings({ fontSize });
});
const wheelZoomGestureGuard = createEditorWheelZoomGestureGuard();

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
    showWhitespace: settings.showWhitespace,
    vimModeEnabled: settings.vimModeEnabled,
    autoCloseBrackets: settings.autoCloseBrackets,
    showLineNumbers: settings.showLineNumbers,
    shortcuts: settings.shortcuts,
    showStatementRunButtons: settings.showStatementRunButtons,
  };
});

function syncEditorFontCssVars(fontSize = liveFontSize.value, fontFamily = settingsStore.editorSettings.fontFamily) {
  if (!editorRef.value) return;
  editorRef.value.style.setProperty(EDITOR_FONT_SIZE_CSS_VAR, `${clampEditorFontSize(fontSize)}px`);
  editorRef.value.style.setProperty(EDITOR_FONT_FAMILY_CSS_VAR, fontFamily);
}

// Diagnostics render on the editor surface, so their marker colors follow the
// resolved editor appearance (which already adapts to custom backgrounds) via
// editor-scoped variables instead of the app-level warning/destructive tokens.
function syncEditorDiagnosticCssVars() {
  if (!editorRef.value) return;
  const colors = editorDiagnosticColors(editorThemeAppearance());
  editorRef.value.style.setProperty("--dbx-editor-diagnostic-error", colors.error);
  editorRef.value.style.setProperty("--dbx-editor-diagnostic-warning", colors.warning);
}

let pendingFontReconfig: { size: number; family: string } | null = null;
let fontReconfigScheduled = false;

function reconfigureFontTheme(size: number, family: string) {
  if (!codeMirrorRuntime.fontThemeComp || !codeMirrorRuntime.editorViewModule || !view.value) return;
  view.value.dispatch({
    effects: codeMirrorRuntime.fontThemeComp.reconfigure(
      editorFontTheme(codeMirrorRuntime.editorViewModule.EditorView, size, family, {
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

function emitExecutionRequest(source: SqlExecutionOverride, openInNewResultTab = false) {
  if (typeof source === "string" || source.editorViewportRequestId === undefined) {
    executionViewportOwnership.cancelPendingRequest();
  }
  if (openInNewResultTab) {
    emit("executeInNewResultTab", source);
  } else {
    emit("execute", source);
  }
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
  const EditorSelection = codeMirrorRuntime.codeMirrorEditorSelection;
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

function setPreviewRange(range: { from: number; to: number } | null) {
  if (!view.value || !codeMirrorRuntime.setPreviewRangeEffect) return;
  view.value.dispatch({
    effects: codeMirrorRuntime.setPreviewRangeEffect.of(range),
  });
}

function setResultSourceRange(range: { from: number; to: number } | null) {
  if (!view.value || !codeMirrorRuntime.setResultSourceRangeEffect) return;
  view.value.dispatch({
    effects: codeMirrorRuntime.setResultSourceRangeEffect.of(range),
  });
}

function previewStatementRange(range: { from: number; to: number } | null) {
  const currentView = view.value;
  if (!range || !currentView || !codeMirrorRuntime.editorViewModule || !codeMirrorRuntime.setResultSourceRangeEffect) {
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
    effects: [codeMirrorRuntime.setResultSourceRangeEffect.of({ from, to }), codeMirrorRuntime.editorViewModule.EditorView.scrollIntoView(from, { y: "center" })],
  });
}

function focusStatementRange(range: { from: number; to: number } | null) {
  const currentView = view.value;
  if (!range || !currentView || !codeMirrorRuntime.editorViewModule || !codeMirrorRuntime.setResultSourceRangeEffect) {
    setResultSourceRange(null);
    return;
  }
  const from = Math.max(0, Math.min(range.from, currentView.state.doc.length));
  const to = Math.max(from, Math.min(range.to, currentView.state.doc.length));
  if (from === to) return;
  currentView.dispatch({
    selection: { anchor: from, head: to },
    effects: [codeMirrorRuntime.setResultSourceRangeEffect.of({ from, to }), codeMirrorRuntime.editorViewModule.EditorView.scrollIntoView(from, { y: "center" })],
  });
  currentView.focus();
}

function focusErrorPosition(offset: number) {
  const currentView = view.value;
  if (!currentView || !codeMirrorRuntime.editorViewModule) return;
  const errorPos = Math.max(0, Math.min(offset, currentView.state.doc.length));
  currentView.dispatch({
    selection: { anchor: errorPos },
    effects: [codeMirrorRuntime.editorViewModule.EditorView.scrollIntoView(errorPos, { y: "center" })],
  });
  currentView.focus();
}

function insertLineBelow(currentView: EditorViewType): boolean {
  if (props.readOnly) return false;
  const line = currentView.state.doc.lineAt(currentView.state.selection.main.head);
  const indentation = line.text.match(/^\s*/)?.[0] ?? "";
  const insertion = `\n${indentation}`;
  const cursor = line.to + insertion.length;
  currentView.dispatch({
    changes: { from: line.to, to: line.to, insert: insertion },
    selection: { anchor: cursor },
    userEvent: "input.insertLineBelow",
  });
  return true;
}

function currentEditorDocText(currentView: EditorViewType): string {
  const doc = currentView.state.doc;
  if (contextMenuDoc !== doc) {
    contextMenuDoc = doc;
    contextMenuDocText = doc.toString();
  }
  return contextMenuDocText;
}

function syncEditorSelectionState(currentView: EditorViewType) {
  selectedSql.value = selectedSqlFromView(currentView);
  executableSql.value = resolveExecutableSql(currentEditorDocText(currentView), selectedSql.value);
}

function syncContextMenuState(currentView: EditorViewType, starPosition?: number, previewPosition?: number) {
  syncEditorSelectionState(currentView);
  previewContextSql.value = resolvePreviewDmlCandidate(previewPosition);
  selectStarExpansionTarget.value = selectStarExpansionTargetForView(currentView, starPosition);
}

function clearScheduledPreviewContextRefresh() {
  if (previewContextRefreshTimer === null) return;
  clearTimeout(previewContextRefreshTimer);
  previewContextRefreshTimer = null;
}

function schedulePreviewContextRefresh(currentView: EditorViewType) {
  clearScheduledPreviewContextRefresh();
  const expectedDoc = currentView.state.doc;
  const expectedSelection = currentView.state.selection.main;
  previewContextRefreshTimer = setTimeout(() => {
    previewContextRefreshTimer = null;
    const currentSelection = currentView.state.selection.main;
    if (view.value !== currentView || currentView.state.doc !== expectedDoc || currentSelection.from !== expectedSelection.from || currentSelection.to !== expectedSelection.to || !editorIsActive) return;
    previewContextSql.value = resolvePreviewDmlCandidate();
    emit("previewChangesAvailable", !!previewContextSql.value);
  }, 120);
}

function selectStarExpansionTargetForView(currentView: EditorViewType, position?: number): SelectStarExpansionTarget | null {
  if (!props.connectionId || props.database == null || props.readOnly || !SEMANTIC_SQL_COMPLETION_ENABLED) return null;

  const sql = currentEditorDocText(currentView);
  const selection = currentView.state.selection.main;
  let cursor: number;
  if (position != null) {
    if (sql[position] === "*") {
      cursor = position + 1;
    } else if (sql[position - 1] === "*") {
      cursor = position;
    } else {
      return null;
    }
  } else if (!selection.empty) {
    if (currentView.state.sliceDoc(selection.from, selection.to) !== "*") return null;
    cursor = selection.to;
  } else if (sql[selection.head] === "*") {
    cursor = selection.head + 1;
  } else if (sql[selection.head - 1] === "*") {
    cursor = selection.head;
  } else {
    return null;
  }

  const model = buildSqlSemanticModel(sql, cursor, sqlCompletionDialectOptions());
  const intent = model.cursorIntent;
  if (intent.kind !== "star" || intent.confidence !== "high" || intent.replacementRange.end - intent.replacementRange.start !== 1 || sql.slice(intent.replacementRange.start, intent.replacementRange.end) !== "*") return null;
  if (position == null && !selection.empty && (selection.from !== intent.replacementRange.start || selection.to !== intent.replacementRange.end)) return null;

  const starToken = model.tokens.find((token) => token.span.start === intent.replacementRange.start && token.span.end === intent.replacementRange.end && token.text === "*");
  if (!starToken) return null;
  let isSelectProjection = false;
  for (let index = model.tokens.length - 1; index >= 0; index -= 1) {
    const token = model.tokens[index];
    if (!token || token.span.end > starToken.span.start || token.depth !== starToken.depth || token.kind !== "word") continue;
    if (token.normalized === "from") return null;
    if (token.normalized === "select") {
      isSelectProjection = true;
      break;
    }
  }
  if (!isSelectProjection) return null;

  const sources = sqlSemanticSelectStarTableSources(model);
  if (sources.length === 0) return null;

  const references = sources.map((source): SqlCompletionReferencedTable => {
    const identifierParts = source.qualifiedName?.parts ?? [];
    return {
      // Use the semantic metadata target instead of reparsing the table token at
      // its source span. The latter can resolve the alias token in aliased
      // sources, causing column metadata requests for `tv` instead of
      // `tVillage`.
      name: source.metadataTarget?.table ?? source.name,
      nameQuoted: !!identifierParts[identifierParts.length - 1]?.quote,
      database: source.metadataTarget?.database,
      schema: source.metadataTarget?.schema ?? source.qualifierParts[source.qualifierParts.length - 1],
      schemaQuoted: source.qualifierParts.length > 0 ? !!identifierParts[identifierParts.length - 2]?.quote : undefined,
      alias: source.alias,
      aliasSql: source.aliasSpan ? sql.slice(source.aliasSpan.start, source.aliasSpan.end) : source.alias,
    };
  });
  const legacyContext = getEditorSqlCompletionContext(sql, cursor);
  const context = sqlCompletionContextFromSemantic(model, legacyContext);
  if (context.statementKind !== "select" || !context.onStar) return null;

  return {
    from: intent.replacementRange.start,
    to: intent.replacementRange.end,
    references,
    context: { ...context, referencedTables: references },
    qualifierSql: sqlSemanticSelectStarQualifierSql(model),
    statementSql: model.statement.text,
    allowResultColumnsFallback: references.length === 1 && model.rowSources.length === 1 && sqlSemanticSelectStarIsOnlyProjection(model),
  };
}

function syncContextMenuStateAtEvent(currentView: EditorViewType, event: MouseEvent) {
  const pos = currentView.posAtCoords({ x: event.clientX, y: event.clientY });
  clearScheduledPreviewContextRefresh();
  // 预览按“右键点击处”解析当前语句（执行按光标处），右键处与光标一致时才直觉一致。
  syncContextMenuState(currentView, pos ?? undefined, pos ?? undefined);
  if (pos == null) {
    contextObjectTarget.value = null;
    return;
  }

  const sql = currentEditorDocText(currentView);
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
  const tables = connectionStore.lookupLocalCompletionTables(candidate.connectionId, candidate.database, candidate.tableName, MAX_COMPLETION_TABLES, candidate.schema, props.catalog);
  contextObjectTarget.value = resolveQueryContextObjectTarget(candidate, tables);
}

function focusEditor() {
  view.value?.focus();
  rememberFocusedQueryEditorView(view.value);
}

function executeFromContextMenu() {
  if (!canExecuteContextSql.value) return;
  requestExecute();
  focusEditor();
}

function executeInNewResultTabFromContextMenu() {
  if (!canExecuteContextSql.value) return;
  requestExecuteInNewResultTab();
  focusEditor();
}

function exportQueryFromContextMenu(format: "csv" | "xlsx" | "txt") {
  const sql = executableSql.value;
  if (!sql.trim()) return;
  emit("exportQuery", { sql, format, columnComments: undefined });
}

// 与「执行」使用同一套候选解析：选区优先，否则取 position（右键点击处）/ 光标处的单条语句。
// 注意：不跟随 executeAllOnBlankLine 回退到“整篇文档”（那会包含多条语句）。
function resolvePreviewDmlCandidate(position?: number): string {
  const currentView = view.value;
  if (!currentView) return "";
  const selection = currentView.state.selection.main;
  if (!selection.empty) {
    const text = currentView.state.sliceDoc(selection.from, selection.to);
    return looksLikeDmlStatement(text) ? text : "";
  }
  const cursorPos = position ?? selection.head;
  executableStatementRangeCache = executableStatementRangeCacheForDoc(executableStatementRangeCache, currentView.state.doc, props.databaseType, sqlStatementParameterOptions());
  const cursorRange = executableStatementRangeAtCursor(executableStatementRangeCache, cursorPos);
  return cursorRange && looksLikeDmlStatement(cursorRange.sql) ? cursorRange.sql : "";
}

function emitModelValue(currentView: EditorViewType): string {
  const sql = currentEditorDocText(currentView);
  emit("update:modelValue", sql);
  return sql;
}

// 「预览变更」：把当前 DML 语句改写为只读 SELECT，作为新结果标签执行（干跑，不写库）。
async function requestPreviewChanges(stackSql?: string) {
  let sql = (stackSql ?? "").trim();
  // 永远只预览“单条语句”：禁用整篇文档回退（那会包含多条语句）。
  if (!sql) sql = resolvePreviewDmlCandidate();
  if (!sql) {
    toast(t("editor.previewChangesNoStatement"), 3000);
    return false;
  }
  try {
    const identifierQuote = props.connectionId ? connectionStore.connectionIdentifierQuote?.(props.connectionId) : undefined;
    // 第一次：生成基础预览 SELECT，并拿到目标表引用。
    let preview = await api.buildDmlChangePreviewSql({ sql, databaseType: props.databaseType, identifierQuote });
    // 单表 UPDATE：拉取目标表列元数据，让「新值」列紧跟其原值列（交错展开）。
    if (preview.tables.length === 1 && props.connectionId && props.database) {
      const tableRef = preview.tables[0];
      if (tableRef.table) {
        const columns = await api
          .getColumns(props.connectionId, props.database, tableRef.schema ?? "", tableRef.table, tableRef.catalog)
          .then((infos) => infos.map((column) => column.name))
          .catch(() => undefined);
        if (columns?.length) {
          preview = await api.buildDmlChangePreviewSql({ sql, databaseType: props.databaseType, identifierQuote, columns });
        }
      }
    }
    // 前置注释标注干跑预览（引擎会忽略注释），并在新结果标签中展示受影响行 + 新值列。
    emit("executeInNewResultTab", `/* ${t("editor.previewChangesComment", { operation: preview.operation })} */\n${preview.sql}`);
    return true;
  } catch (error: any) {
    // http 层抛 BackendErrorException（Error），tauri 层拒绝时是 String。
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : t("editor.previewChangesFailed");
    toast(message, 4000);
    return false;
  }
}

// See queryEditorPasteCaretResync.ts for why this nudge is needed (WebKit-only caret bug).
function resyncCaretAfterPaste(view: EditorViewType) {
  const EditorSelection = codeMirrorRuntime.codeMirrorEditorSelection;
  if (!EditorSelection) return;
  const selection = view.state.selection;
  const pos = selection.main.head;
  const nudged = computePasteCaretResyncTarget(selection, view.state.doc.length);
  if (nudged === null) return;
  requestAnimationFrame(() => {
    if (!view.dom.isConnected || view.state.selection.ranges.length !== 1 || view.state.selection.main.head !== pos || !view.state.selection.main.empty) return;
    view.dispatch({ selection: EditorSelection.cursor(nudged) });
    view.dispatch({ selection: EditorSelection.cursor(pos) });
  });
}

function recoverLargeTauriPaste(event: ClipboardEvent, currentView: EditorViewType): boolean {
  const eventText = event.clipboardData?.getData("text/plain") ?? "";
  if (props.readOnly || currentView.state.selection.ranges.length !== 1 || !shouldRecoverLargeTauriPaste(eventText, isTauriRuntime())) return false;

  event.preventDefault();
  const selection = currentView.state.selection.main;
  const insertedText = normalizeQueryEditorPasteText(eventText);
  const insertedFrom = selection.from;
  const insertedTo = insertedFrom + insertedText.length;
  const pasteStartedAt = Date.now();
  currentView.dispatch({
    changes: { from: selection.from, to: selection.to, insert: insertedText },
    selection: { anchor: insertedTo },
    scrollIntoView: true,
    // CodeMirror only joins input.type history events; keep one timestamp so delayed recovery is one undo step.
    annotations: Transaction.time.of(pasteStartedAt),
    userEvent: LARGE_PASTE_HISTORY_USER_EVENT,
  });

  void readTextFromClipboard()
    .then((nativeText) => {
      const suffix = recoverableNativePasteSuffix(eventText, nativeText);
      if (!suffix || props.readOnly || view.value !== currentView) return;
      if (currentView.state.doc.sliceString(insertedFrom, insertedTo) !== insertedText) return;
      const currentSelection = currentView.state.selection.main;
      const selectionRemainedAtPasteEnd = currentSelection.empty && currentSelection.head === insertedTo;
      currentView.dispatch({
        changes: { from: insertedTo, insert: suffix },
        ...(selectionRemainedAtPasteEnd ? { selection: { anchor: insertedTo + suffix.length } } : {}),
        scrollIntoView: selectionRemainedAtPasteEnd,
        annotations: Transaction.time.of(pasteStartedAt),
        userEvent: LARGE_PASTE_HISTORY_USER_EVENT,
      });
    })
    .catch(() => {});
  return true;
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
    case "peekTableStructure":
      void openTableStructurePeek(route.payload[0]);
      focusEditor();
      return;
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

function executableStatementRangeStartingAt(currentView: EditorViewType, lineFrom: number) {
  executableStatementRangeCache = executableStatementRangeCacheForDoc(executableStatementRangeCache, currentView.state.doc, props.databaseType, sqlStatementParameterOptions());
  return executableStatementRangeStartingAtLine(executableStatementRangeCache, lineFrom);
}

function currentExecutableStatementRange(currentView: EditorViewType): SqlTextRange | null {
  if (!supportsExecutionTargetPicker(props.databaseType) && props.databaseType !== "mongodb") return null;
  executableStatementRangeCache = executableStatementRangeCacheForDoc(executableStatementRangeCache, currentView.state.doc, props.databaseType, sqlStatementParameterOptions());
  return executableStatementRangeAtCursor(executableStatementRangeCache, currentView.state.selection.main.head);
}

function executeSqlStatementFromGutter(currentView: EditorViewType, line: { from: number; to: number }, event: Event): boolean {
  if (!(event instanceof MouseEvent) || event.button !== 0) return false;
  const statementRange = executableStatementRangeStartingAt(currentView, line.from);
  if (!statementRange) return false;
  event.preventDefault();
  event.stopPropagation();
  // Gutter play is always scoped to the statement/command for that line, even
  // when the main editor execute action would run the full document. An explicit
  // selection overlapping that statement is more specific, so preserve it; a
  // selection elsewhere in the document must not hijack the click.
  const editorViewportRequestId = executionViewportOwnership.beginRequest();
  const selection = currentView.state.selection.main;
  const hasSelectedSql = !selection.empty && currentView.state.sliceDoc(selection.from, selection.to).trim().length > 0;
  const selectionOverlapsStatement = hasSelectedSql && selection.from < statementRange.to && statementRange.from < selection.to;
  const executionSnapshot = selectionOverlapsStatement ? sqlExecutionSnapshotFromView(currentView) : sqlExecutionSnapshotForRange(currentView, statementRange);
  emitExecutionRequest({ ...executionSnapshot, editorViewportRequestId });
  // 不主动聚焦编辑器，否则 CodeMirror 会把屏幕滚回之前的光标位置。
  // currentView.focus();
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

const contextMenuActions: QueryEditorContextMenuActions = {
  executeFromContextMenu,
  executeInNewResultTabFromContextMenu,
  requestPreviewChanges,
  exportQueryFromContextMenu,
  toggleCommentFromContextMenu,
  toggleBlockCommentFromContextMenu,
  formatCurrentSql,
  compressCurrentSql,
  copySelectedSqlFromContextMenu,
  copySelectedSqlAsRichTextFromContextMenu,
  cutSelectedSqlFromContextMenu,
  pasteClipboardSqlFromContextMenu,
  convertSelectedSqlCase,
  convertSelectedNamingStyle,
  openDelimitedListDialog,
  addNextSelectionOccurrenceFromContextMenu,
  selectAllSelectionOccurrencesFromContextMenu,
  openFindReplaceFromContextMenu,
  deleteEmptyLines,
  selectAllSqlFromContextMenu,
  emitContextObjectAction,
  openCodeSnapshot,
  sendSelectionToAi: () => {
    if (selectedSql.value.trim()) emit("sendSelectionToAi", selectedSql.value);
  },
};

function getContextMenuState(): QueryEditorContextMenuState {
  const target = selectStarExpansionTarget.value;
  return {
    readOnly: props.readOnly,
    hideExecutionControls: props.hideExecutionControls,
    databaseType: props.databaseType,
    selectedSql: selectedSql.value,
    executableSql: executableSql.value,
    previewContextSql: previewContextSql.value,
    contextObjectTarget: contextObjectTarget.value,
    shortcuts: settingsStore.editorSettings.shortcuts,
    expandSelectStar: target ? () => void expandSelectStar(target) : undefined,
  };
}

function runSqlShortcutAction(action: ReturnType<typeof enabledSqlShortcutActions>[number], currentView: EditorViewType, event?: KeyboardEvent): boolean {
  // Non-SQL editors (Redis / Mongo / ES / …) keep their own command languages; do not inject SELECT templates.
  if (queryEditorSelectionLanguage() !== "sql") return false;
  if (shouldBlockExecutionShortcut(event, currentView)) return true;
  if (props.readOnly) return true;
  const { from, to, empty, head } = currentView.state.selection.main;
  let selected: string | null = null;
  if (!empty) {
    selected = currentView.state.sliceDoc(from, to).trim() || null;
  } else {
    const line = currentView.state.doc.lineAt(head);
    const localHead = Math.min(Math.max(0, head - line.from), line.text.length);
    selected = resolveSqlShortcutTableToken(line.text, { from: localHead, to: localHead, empty: true, head: localHead });
  }
  if (!selected) return false;
  const sql = buildSqlShortcutExecutionSql(action, selected, props.databaseType);
  emitExecutionRequest(sql);
  return true;
}

function runKeymapExtension(codeMirrorKeymap: (typeof import("@codemirror/view"))["keymap"]) {
  const shortcuts = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);
  const Prec = codeMirrorRuntime.codeMirrorPrec;
  const binding = (shortcut: string, run: (view: EditorViewType) => boolean) => (shortcut ? [{ key: shortcutToCodeMirrorKey(shortcut), preventDefault: true, run }] : []);
  // Keep the shortcut on the shared execution-mode path (selection priority + configured cursor/all target),
  // but bypass the picker so the keyboard shortcut always executes directly instead of popping a dialog.
  const executeBindings = props.hideExecutionControls
    ? []
    : createQueryEditorExecutionShortcutBindings(
        shortcuts.executeSql,
        () => requestExecute({ bypassPicker: true }),
        (currentView) => shouldBlockExecutionShortcut(undefined, currentView),
      );
  const executeInNewResultTabBindings = props.hideExecutionControls ? [] : createQueryEditorExecutionShortcutBindings(shortcuts.executeSqlInNewResultTab, requestExecuteInNewResultTab, (currentView) => shouldBlockExecutionShortcut(undefined, currentView));
  const explainBindings = props.enableExplainShortcut
    ? createQueryEditorExecutionShortcutBindings(
        shortcuts.explainSql,
        () => {
          emit("explain");
          return true;
        },
        (currentView) => shouldBlockExecutionShortcut(undefined, currentView),
        () => !!props.canExplain,
      )
    : [];
  const replaceShortcutBindings = createQueryEditorReplaceShortcutBindings(shortcuts.replace, openReplace);
  const replaceShortcutHandler = createQueryEditorReplaceShortcutHandler({
    shortcut: shortcuts.replace,
    openReplace,
    isReadOnly: () => !!props.readOnly,
  });
  const sqlShortcutActions = enabledSqlShortcutActions(settingsStore.editorSettings.sqlShortcuts);
  const sqlShortcutKeymapBindings = uniqueSqlShortcutBindings(sqlShortcutActions).filter((shortcut) => !isCharacterProducingShortcut(shortcut));
  // Do not set preventDefault: true — when run returns false (wrong DB scope / no table token),
  // CodeMirror must not swallow the browser default. Returning true still prevents default.
  const sqlShortcutBindings = sqlShortcutKeymapBindings.flatMap((shortcut) =>
    shortcut
      ? [
          {
            key: shortcutToCodeMirrorKey(shortcut),
            run: (currentView: EditorViewType) => {
              const action = resolveSqlShortcutForDatabase(settingsStore.editorSettings.sqlShortcuts, shortcut, props.databaseType);
              if (!action) return false;
              return runSqlShortcutAction(action, currentView);
            },
          },
        ]
      : [],
  );
  const sqlShortcutDomHandler = createQueryEditorSqlShortcutDomHandler(
    () => settingsStore.editorSettings.sqlShortcuts,
    (action, currentView, event) => runSqlShortcutAction(action, currentView, event),
    () => props.databaseType,
  );
  const combinedDomKeydownHandler = (event: KeyboardEvent, view: EditorViewType) => {
    if (replaceShortcutHandler(event)) return true;
    return sqlShortcutDomHandler(event, view);
  };
  const moveCompletion = (view: EditorViewType, forward: boolean, by?: "page") => codeMirrorRuntime.codeMirrorMoveCompletionSelection?.(forward, by)?.(view) ?? false;
  return [
    codeMirrorRuntime.editorViewModule
      ? (Prec?.high(
          codeMirrorRuntime.editorViewModule.EditorView.domEventHandlers({
            keydown: combinedDomKeydownHandler,
          }),
        ) ?? [])
      : [],
    Prec?.highest(
      codeMirrorKeymap.of([
        { key: "ArrowDown", run: (view) => moveCompletion(view, true) },
        { key: "ArrowUp", run: (view) => moveCompletion(view, false) },
        { key: "PageDown", run: (view) => moveCompletion(view, true, "page") },
        { key: "PageUp", run: (view) => moveCompletion(view, false, "page") },
      ]),
    ) ?? [],
    Prec?.high(
      codeMirrorKeymap.of([
        {
          key: "Enter",
          run: handleEnter,
        },
        {
          key: "Space",
          run: toggleSelectedBatchColumnSelection,
        },
        ...binding(shortcuts.find, openSearch),
        ...binding(shortcuts.gotoLine, openGotoLine),
        ...replaceShortcutBindings,
        ...executeInNewResultTabBindings,
        ...executeBindings,
        ...explainBindings,
        ...binding(shortcuts.saveSql, () => {
          emit("save");
          return true;
        }),
        ...binding(shortcuts.formatSql, () => {
          void formatCurrentSql();
          return true;
        }),
        ...binding(shortcuts.expandSelectStar, (currentView) => {
          const target = selectStarExpansionTargetForView(currentView);
          if (!target) return false;
          void expandSelectStar(target);
          return true;
        }),
        ...binding(shortcuts.indentMore, (view) => codeMirrorRuntime.codeMirrorIndentMore?.(view) ?? false),
        ...binding(shortcuts.indentLess, (view) => codeMirrorRuntime.codeMirrorIndentLess?.(view) ?? false),
        ...binding(shortcuts.insertLineBelow, insertLineBelow),
        ...binding(shortcuts.joinLines, joinQueryEditorLines),
        ...binding(shortcuts.duplicateLine, (view) => codeMirrorRuntime.codeMirrorCopyLineDown?.(view) ?? false),
        ...binding(shortcuts.deleteLine, (view) => codeMirrorRuntime.codeMirrorDeleteLine?.(view) ?? false),
        ...binding(shortcuts.moveLineUp, (view) => codeMirrorRuntime.codeMirrorMoveLineUp?.(view) ?? false),
        ...binding(shortcuts.moveLineDown, (view) => codeMirrorRuntime.codeMirrorMoveLineDown?.(view) ?? false),
        ...binding(shortcuts.copyLineUp, (view) => codeMirrorRuntime.codeMirrorCopyLineUp?.(view) ?? false),
        ...binding(shortcuts.copyLineDown, (view) => codeMirrorRuntime.codeMirrorCopyLineDown?.(view) ?? false),
        ...binding(shortcuts.undo, (view) => codeMirrorRuntime.codeMirrorUndo?.(view) ?? false),
        ...binding(shortcuts.redo, (view) => codeMirrorRuntime.codeMirrorRedo?.(view) ?? false),
        ...binding(shortcuts.selectAll, (view) => codeMirrorRuntime.codeMirrorSelectAll?.(view) ?? false),
        ...binding(shortcuts.extendSelection, extendQueryEditorSelectionForView),
        ...binding(shortcuts.addNextSelectionOccurrence, addNextQueryEditorSelectionOccurrence),
        ...binding(shortcuts.selectAllSelectionOccurrences, selectAllQueryEditorSelectionOccurrences),
        ...createQueryEditorSelectionCaseShortcutBindings(shortcuts.uppercaseSelection, () => convertSelectedSqlCase("upper")),
        ...createQueryEditorSelectionCaseShortcutBindings(shortcuts.lowercaseSelection, () => convertSelectedSqlCase("lower")),
        ...createQueryEditorSelectionCaseShortcutBindings(shortcuts.convertNamingStyle, () => convertSelectedNamingStyle()),
        ...binding(shortcuts.toggleLineComment, (view) => codeMirrorRuntime.codeMirrorToggleLineComment?.(view) ?? false),
        ...binding(shortcuts.toggleBlockComment, (view) => {
          if (!supportsQueryEditorBlockComments(props.databaseType)) return false;
          return codeMirrorRuntime.codeMirrorToggleBlockComment?.(view) ?? false;
        }),
        ...binding(shortcuts.toggleFold, (view) => codeMirrorRuntime.codeMirrorToggleFold?.(view) ?? false),
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
        ...binding(shortcuts.sqlIntentionActions, handleSqlIntentionActions),
        ...createQueryEditorCompletionShortcutBindings(shortcuts.triggerCompletion, triggerSqlCompletion),
        ...createQueryEditorSearchKeymap({
          openSearch,
          openReplace,
          isReadOnly: () => !!props.readOnly,
        }),
        ...sqlShortcutBindings,
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

function extendQueryEditorSelectionForView(currentView: EditorViewType): boolean {
  const databaseType = props.databaseType;
  return extendQueryEditorSelection(currentView, {
    databaseType,
    dialect: sqlBehaviorDialect(),
    language: queryEditorSelectionLanguage(),
  });
}

function addNextSelectionOccurrenceFromContextMenu() {
  if (!view.value) return;
  addNextQueryEditorSelectionOccurrence(view.value);
  focusEditor();
}

function selectAllSelectionOccurrencesFromContextMenu() {
  if (!view.value) return;
  selectAllQueryEditorSelectionOccurrences(view.value);
  focusEditor();
}

function wordWrapExtension() {
  if (!codeMirrorRuntime.editorViewModule) return [];
  return props.forceWordWrap || settingsStore.editorSettings.wordWrap ? codeMirrorRuntime.editorViewModule.EditorView.lineWrapping : [];
}

function showWhitespaceExtension(enabled = settingsStore.editorSettings.showWhitespace) {
  if (!codeMirrorRuntime.editorViewModule) return [];
  return createShowWhitespaceExtension(codeMirrorRuntime.editorViewModule, enabled);
}

function lineNumbersExtension(enabled = settingsStore.editorSettings.showLineNumbers) {
  return buildQueryEditorLineNumbersExtension(codeMirrorRuntime.codeMirrorLineNumbers, enabled, {
    domEventHandlers: {
      mousedown: selectSqlLineFromGutter,
    },
  });
}

function closeBracketsExtension(enabled = settingsStore.editorSettings.autoCloseBrackets) {
  if (!enabled || !codeMirrorRuntime.codeMirrorCloseBrackets) return [];
  const exts: import("@codemirror/state").Extension[] = [codeMirrorRuntime.codeMirrorCloseBrackets()];
  if (codeMirrorRuntime.codeMirrorCloseBracketsKeymap?.length && codeMirrorRuntime.codeMirrorPrec && codeMirrorRuntime.editorViewModule) {
    exts.push(codeMirrorRuntime.codeMirrorPrec.highest(codeMirrorRuntime.editorViewModule.keymap.of([...codeMirrorRuntime.codeMirrorCloseBracketsKeymap])));
  }
  return exts;
}

function vimModeExtension(enabled = settingsStore.editorSettings.vimModeEnabled) {
  if (!codeMirrorRuntime.codeMirrorVim || !enabled) return [];
  const vimExtension = codeMirrorRuntime.codeMirrorVim({ status: true });
  if (!codeMirrorRuntime.codeMirrorPrec || !codeMirrorRuntime.editorViewModule || !codeMirrorRuntime.codeMirrorGetVimCm || !codeMirrorRuntime.codeMirrorVimApi) return vimExtension;

  // Beekeeper treats Vim as a first-class editor keymap. Keep it above DBX's
  // normal shortcuts so regular normal-mode keys are not stolen by other maps.
  return codeMirrorRuntime.codeMirrorPrec.highest([
    codeMirrorRuntime.editorViewModule.keymap.of([
      {
        key: "Ctrl-[",
        mac: "Ctrl-[",
        linux: "Ctrl-[",
        win: "Ctrl-[",
        run(currentView) {
          const cm = codeMirrorRuntime.codeMirrorGetVimCm?.(currentView);
          if (cm?.state.vim?.insertMode) {
            codeMirrorRuntime.codeMirrorVimApi?.exitInsertMode(cm as any, true);
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
  if (codeMirrorRuntime.dbxVimCommandsConfigured) return;
  codeMirrorRuntime.dbxVimCommandsConfigured = true;
  vimApi.defineEx("write", "w", (cm) => {
    cm.cm6?.contentDOM.dispatchEvent(new CustomEvent(DBX_VIM_SAVE_EVENT, { bubbles: true }));
  });
}

async function ensureCodeMirrorVim() {
  if (codeMirrorRuntime.codeMirrorVim && codeMirrorRuntime.codeMirrorVimApi && codeMirrorRuntime.codeMirrorGetVimCm) return true;
  codeMirrorRuntime.codeMirrorVimImportPromise ??= import("@replit/codemirror-vim");
  const { vim, Vim, getCM } = await codeMirrorRuntime.codeMirrorVimImportPromise;
  codeMirrorRuntime.codeMirrorVim = vim;
  codeMirrorRuntime.codeMirrorVimApi = Vim;
  codeMirrorRuntime.codeMirrorGetVimCm = getCM;
  configureDbxVimCommands(Vim);
  return true;
}

function indentExtension() {
  if (!codeMirrorRuntime.codeMirrorIndentUnit) return [];
  return codeMirrorRuntime.codeMirrorIndentUnit.of(editorIndentUnit());
}

function selectedSqlFromView(currentView: EditorViewType): string {
  const selection = currentView.state.selection.main;
  return currentView.state.sliceDoc(selection.from, selection.to);
}

function resultColumnsForSelectStar(target: SelectStarExpansionTarget, sql: string): SqlCompletionColumn[] {
  if (
    !target.allowResultColumnsFallback ||
    target.references.length !== 1 ||
    !selectStarResultColumnsMatch({
      currentSql: sql,
      targetFrom: target.from,
      targetTo: target.to,
      statementSql: target.statementSql,
      sourceStatement: props.resultSourceStatement,
      sourceFrom: props.resultSourceFrom,
      sourceTo: props.resultSourceTo,
    })
  )
    return [];
  return (props.resultColumns ?? [])
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, table: target.references[0]!.name, schema: target.references[0]!.schema }));
}

async function expandSelectStar(target = selectStarExpansionTarget.value) {
  const currentView = view.value;
  if (!currentView || props.readOnly) return;
  if (!target) return;

  const originalDocument = currentView.state.doc.toString();
  try {
    await Promise.all(target.references.map((reference) => ensureColumnsForTable(reference, reference)));
  } catch (error) {
    console.warn("expandSelectStar: failed to load columns", error);
    toast(t("editor.contextMenu.expandSelectStarUnavailable"), 3000);
    return;
  }

  if (view.value !== currentView || currentView.state.doc.toString() !== originalDocument || currentView.state.sliceDoc(target.from, target.to) !== "*") return;
  const columnsByReference = new Map<string, SqlCompletionColumn[]>();
  for (const reference of target.references) {
    const columns = cachedColumnsByTable.get(completionCacheKey(reference));
    const expansionColumns = columns?.length ? columns : target.references.length === 1 ? resultColumnsForSelectStar(target, originalDocument) : [];
    if (expansionColumns.length === 0) {
      toast(t("editor.contextMenu.expandSelectStarUnavailable"), 3000);
      return;
    }
    columnsByReference.set(completionCacheKey(reference), expansionColumns);
  }
  const expansion = buildSelectStarExpansion(target.context, columnsByReference, props.dialect, target.qualifierSql, props.databaseType);
  if (!expansion) {
    toast(t("editor.contextMenu.expandSelectStarUnavailable"), 3000);
    return;
  }

  currentView.dispatch({
    changes: { from: target.from, to: target.to, insert: expansion },
    selection: { anchor: target.from + expansion.length },
    scrollIntoView: true,
    userEvent: "input.expandSelectStar",
  });
  currentView.focus();
}

const { sqlErrorDecorationRange, sqlSemanticDecorationRanges, reconfigureDiagnostics, setSemanticDiagnostics, clearScheduledSemanticDiagnostics, invalidateSemanticDiagnosticsForDocumentChange, shouldSkipSqlSemanticDiagnostics, scheduleSemanticDiagnostics } = useQueryEditorDiagnostics({
  props,
  view,
  settingsStore,
  connectionStore,
  sqlDriverProfile,
  sqlStatementParameterOptions,
  sqlBehaviorDialect,
  semanticCompletionEnabled: SEMANTIC_SQL_COMPLETION_ENABLED,
  maxCompletionTables: MAX_COMPLETION_TABLES,
  runtime: {
    get setSqlDiagnosticsEffect() {
      return codeMirrorRuntime.setSqlDiagnosticsEffect;
    },
    get diagnosticComp() {
      return codeMirrorRuntime.diagnosticComp;
    },
    get buildSqlDiagnosticExtension() {
      return codeMirrorRuntime.buildSqlDiagnosticExtension;
    },
    get codeMirrorCompletionStatus() {
      return codeMirrorRuntime.codeMirrorCompletionStatus;
    },
    get executableStatementRangeCache() {
      return executableStatementRangeCache;
    },
    set executableStatementRangeCache(value) {
      executableStatementRangeCache = value;
    },
    get editorIsActive() {
      return editorIsActive;
    },
  },
  metadata: {
    get cachedTables() {
      return completionMetadata.cachedTables;
    },
    cachedColumnsByTable,
    loadedColumnsByTable,
    usesOracleSessionCompletionColumns,
    findExactSemanticDiagnosticTable,
    completionCacheKey,
    ensureColumnsForTable,
    isMissingTableMetadataError,
  },
});

async function formatCurrentSql() {
  if (props.readOnly) return;
  if (!canFormatSqlForDatabaseType(props.databaseType)) return;
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
    let formatted: string;
    if (props.databaseType === "mongodb") {
      formatted = formatMongoShellText(source, settingsStore.editorSettings.sqlFormatter);
    } else {
      const esRequest = detectAndFormatElasticsearchRequests(source, props.databaseType, settingsStore.editorSettings.sqlFormatter.tabWidth);
      if (esRequest.kind === "elasticsearch") {
        formatted = esRequest.formatted;
      } else if (esRequest.kind === "unsupported") {
        toast(t("toolbar.formatAutoDetectFailed"), 3000);
        return;
      } else {
        const structured = detectAndFormatStructured(source, {
          indentSize: settingsStore.editorSettings.sqlFormatter.tabWidth,
          useTabs: settingsStore.editorSettings.sqlFormatter.useTabs,
        });
        if (structured.kind === "json" || structured.kind === "xml") {
          formatted = structured.formatted;
        } else if (structured.kind === "unsupported") {
          // Keep invalid structured text untouched — the SQL formatter would
          // silently corrupt XML-looking content.
          toast(t("toolbar.formatAutoDetectFailed"), 3000);
          return;
        } else {
          formatted = await formatSqlForEditing(source, props.formatDialect ?? props.dialect ?? "generic", settingsStore.editorSettings.sqlFormatter);
        }
      }
    }
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

function compressCurrentSql() {
  if (props.readOnly) return;
  const currentView = view.value;
  if (!currentView) return;

  const originalState = currentView.state;
  const selection = originalState.selection.main;
  const compressesSelection = !selection.empty;
  const from = compressesSelection ? selection.from : 0;
  const to = compressesSelection ? selection.to : originalState.doc.length;
  const source = originalState.sliceDoc(from, to);
  if (!source.trim()) return;

  const compressed = compressSqlText(source, props.formatDialect ?? props.dialect ?? "generic");
  if (currentView !== view.value || currentView.state !== originalState || currentView.state.sliceDoc(from, to) !== source) {
    return;
  }
  if (compressed === source) return;
  currentView.dispatch({
    changes: { from, to, insert: compressed },
    selection: compressesSelection ? { anchor: from, head: from + compressed.length } : { anchor: from + compressed.length },
  });
}

const batchSelection = useQueryEditorBatchSelection({
  view,
  settingsStore,
  markCompletionAccepted: (item) => completion.markCompletionAccepted(item),
  runtime: {
    get completionComp() {
      return codeMirrorRuntime.completionComp;
    },
    get buildSqlCompletionExtension() {
      return codeMirrorRuntime.buildSqlCompletionExtension;
    },
    get codeMirrorCompletionStatus() {
      return codeMirrorRuntime.codeMirrorCompletionStatus;
    },
    get codeMirrorStartCompletion() {
      return codeMirrorRuntime.codeMirrorStartCompletion;
    },
    get codeMirrorCurrentCompletions() {
      return codeMirrorRuntime.codeMirrorCurrentCompletions;
    },
    get codeMirrorSetSelectedCompletion() {
      return codeMirrorRuntime.codeMirrorSetSelectedCompletion;
    },
    get codeMirrorSelectedCompletion() {
      return codeMirrorRuntime.codeMirrorSelectedCompletion;
    },
    get codeMirrorSnippetCompletion() {
      return codeMirrorRuntime.codeMirrorSnippetCompletion;
    },
  },
});
const { cancelBatchColumnSelectionRefresh, finishBatchColumnSelectionDrag, clearBatchColumnSelectionSession, toggleSelectedBatchColumnSelection } = batchSelection;

const completion = useQueryEditorCompletion({
  props,
  view,
  connectionStore,
  settingsStore,
  sqlDriverProfile,
  t,
  metadata: completionMetadata,
  batchSelection,
  isEditorComposing,
  debounceDelayMs: COMPLETION_DEBOUNCE_DELAY_MS,
  triggerDeferDelayMs: COMPLETION_TRIGGER_DEFER_DELAY_MS,
  maxCompletionTables: MAX_COMPLETION_TABLES,
  onDemandTableLimit: PRESTO_ON_DEMAND_TABLE_COMPLETION_LIMIT,
  semanticCompletionEnabled: SEMANTIC_SQL_COMPLETION_ENABLED,
  runtime: {
    get codeMirrorCompletionStatus() {
      return codeMirrorRuntime.codeMirrorCompletionStatus;
    },
    get codeMirrorInsertCompletionText() {
      return codeMirrorRuntime.codeMirrorInsertCompletionText;
    },
    get codeMirrorSnippetCompletion() {
      return codeMirrorRuntime.codeMirrorSnippetCompletion;
    },
    get codeMirrorStartCompletion() {
      return codeMirrorRuntime.codeMirrorStartCompletion;
    },
    get imeCompositionActive() {
      return imeCompositionActive;
    },
  },
});
const { triggerSqlCompletion, shouldTriggerSqlCompletionForPosition, scheduleSqlCompletionStart, consumeSqlCompletionAutoStartSuppression, scheduleDeferredCompletionTrigger, clearDeferredCompletionTrigger } = completion;

const { editorIndentUnit, handleTab, handleEnter, acceptCompletionOrNextSnippetField, acceptSqlServerCompletionOnSpace, clearPendingCompletionEnter, clearPendingCompletionTab } = useQueryEditorCompletionKeys({
  props,
  settingsStore,
  runtime: codeMirrorRuntime,
  completion,
  batchSelection,
  isEditorComposing,
  retryDelayMs: COMPLETION_TAB_RETRY_DELAY_MS,
  tabMaxWaitMs: COMPLETION_TAB_MAX_WAIT_MS,
  enterMaxWaitMs: COMPLETION_ENTER_MAX_WAIT_MS,
});

function isEditorComposing(currentView: EditorViewType): boolean {
  return imeCompositionActive || currentView.compositionStarted || currentView.composing;
}

function flushImeComposition() {
  const currentView = view.value;
  if (!currentView || !pendingImeModelEmit) return;
  pendingImeModelEmit = false;
  emitModelValue(currentView);
  invalidateSemanticDiagnosticsForDocumentChange();
  scheduleSemanticDiagnostics();
  syncEditorSelectionState(currentView);
  schedulePreviewContextRefresh(currentView);
  emit("selectionChange", selectedSqlFromView(currentView));
  emit("cursorChange", currentView.state.selection.main.head);
  documentState.recordSelection(currentView);
  const fullDoc = currentView.state.doc.toString();
  const position = currentView.state.selection.main.head;
  if (shouldTriggerSqlCompletionForPosition(fullDoc, position)) {
    scheduleSqlCompletionStart(currentView);
  }
}

function defaultKeymapExtension() {
  if (!codeMirrorRuntime.editorViewModule || !codeMirrorRuntime.codeMirrorDefaultKeymap || !codeMirrorRuntime.codeMirrorToggleBlockComment) return [];
  return codeMirrorRuntime.editorViewModule.keymap.of(defaultKeymapForGlobalShortcuts(codeMirrorRuntime.codeMirrorDefaultKeymap, settingsStore.editorSettings.shortcuts).filter((item) => item.run !== codeMirrorRuntime.codeMirrorToggleBlockComment));
}

const codeMirrorLifecycle = useQueryEditorCodeMirror({
  editorRef,
  view,
  runtime: codeMirrorRuntime,
  beforeLoad() {
    hoverContent.initializeHighlighter();
  },
  async prepare(modules) {
    const initializedRuntime = modules.runtime;
    const {
      EditorView,
      keymap,
      rectangularSelection,
      hoverTooltip,
      tooltips,
      highlightActiveLineGutter,
      highlightSpecialChars,
      drawSelection,
      dropCursor,
      crosshairCursor,
      scrollPastEnd,
      ViewPlugin,
      EditorState,
      Prec,
      completionKeymap,
      history,
      historyKeymap,
      bracketMatching,
      foldGutter,
      indentOnInput,
      syntaxHighlighting,
      defaultHighlightStyle,
      foldKeymap,
      searchKeymap,
    } = modules;
    const statementBoundariesTrackingPlugin = statementBoundaries.createTrackingPlugin(ViewPlugin);
    objectNavigation.attach();
    const sqlExtensions = configureQueryEditorSqlExtensions({
      props,
      runtime: codeMirrorRuntime,
      modules,
      settingsStore,
      t,
      sqlBehaviorDialect,
      sqlDriverProfile,
      sqlStatementParameterOptions,
      queryEditorSelectionLanguage,
      cache: {
        get value() {
          return executableStatementRangeCache;
        },
        set value(value) {
          executableStatementRangeCache = value;
        },
      },
      completion,
      batchSelection,
      diagnostics: { sqlErrorDecorationRange, sqlSemanticDecorationRanges },
      statementBoundaries,
      currentExecutableStatementRange,
      executeSqlStatementFromGutter,
      signatureHelpWindowChars: SQL_SIGNATURE_HELP_WINDOW_CHARS,
    });
    const initialSettings = settingsStore.editorSettings;
    const theme = await loadEditorTheme(initialSettings.theme, editorThemeAppearance(), getCurrentCustomThemeColors(), themePalette.value);
    if (initialSettings.vimModeEnabled) {
      await ensureCodeMirrorVim();
    }
    const { currentStatementFrameExtension, activeLineHighlighter } = sqlExtensions.createViewDecorations();
    const editorElement = editorRef.value;
    if (!editorElement) return;
    const tooltipParent = editorElement.closest<HTMLElement>("#root")?.querySelector<HTMLElement>("#dbx-query-editor-tooltip-root") ?? editorElement;
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
          // Center the match instead of the default "nearest" alignment, which
          // often lands the match flush against the viewport edge and makes an
          // immediate drag-select there trigger CodeMirror's edge autoscroll.
          scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: "center" }),
        }),
        // Must update before the run gutter's plugin registers below: each
        // keystroke maps the boundary view to the new doc before any lineMarker
        // callback reads it, otherwise the gutter would trigger a full parse.
        statementBoundariesTrackingPlugin,
        initializedRuntime.runGutterComp.of(runStatementGutterExtension()),
        initializedRuntime.lineNumbersComp.of(lineNumbersExtension(initialSettings.showLineNumbers)),
        createQueryEditorLineNumberAlignmentExtension(ViewPlugin),
        currentStatementFrameExtension,
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        initializedRuntime.historyResetComp.of(history()),
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
        sqlBlockFoldService,
        drawSelection(),
        editorClipboardLineEndingsExtension(EditorView),
        trimmedSelectionLayer(),
        selectionMatchOccurrences(),
        dropCursor(),
        props.readOnly ? [] : scrollPastEnd(),
        EditorView.dragMovesSelection.of((event) => !event.ctrlKey && !event.metaKey),
        Prec.highest(
          EditorView.mouseSelectionStyle.of((currentView, event) =>
            createQueryEditorStringMouseSelection(currentView, event, {
              databaseType: props.databaseType,
              dialect: sqlBehaviorDialect(),
              language: queryEditorSelectionLanguage(),
              composing: isEditorComposing(currentView),
            }),
          ),
        ),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        crosshairCursor(),
        activeLineHighlighter,
        // Vim must be mounted before DBX/default keymaps so normal-mode keys are handled first.
        initializedRuntime.vimModeComp.of(vimModeExtension(initialSettings.vimModeEnabled)),
        initializedRuntime.defaultKeymapComp.of(defaultKeymapExtension()),
        keymap.of([...searchKeymapWithoutModD(searchKeymap), ...historyKeymap, ...foldKeymap, ...completionKeymap]),
        Prec.highest(keymap.of([{ key: "Space", run: acceptSqlServerCompletionOnSpace }])),
        initializedRuntime.sqlLanguageComp.of(sqlExtensions.buildSqlLanguageExtension()),
        initializedRuntime.sqlSemanticHighlightComp.of(sqlExtensions.buildSqlSemanticHighlightExtension()),
        tooltips({ parent: tooltipParent }),
        initializedRuntime.completionComp.of(sqlExtensions.buildSqlCompletionExtension()),
        sqlCompletionTheme(EditorView),
        initializedRuntime.codeMirrorTheme.of(theme),
        initializedRuntime.closeBracketsComp.of(closeBracketsExtension(initialSettings.autoCloseBrackets)),
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
        initializedRuntime.sqlSignatureComp.of(sqlExtensions.buildSqlSignatureExtension()),
        initializedRuntime.diagnosticComp.of(sqlExtensions.buildSqlDiagnosticExtension()),
        createInsertValueHintsExtension({
          isEnabled: () => settingsStore.editorSettings.showInsertValueHints && supportsInsertValueHints(props.databaseType),
          getTableColumns: getInsertValueHintTableColumns,
          requestTableColumns: requestInsertValueHintTableColumns,
          getDialectId: () => resolveSqlDialectId({ databaseType: props.databaseType, dialect: sqlBehaviorDialect() }),
        }),
        initializedRuntime.previewRangeComp.of(sqlExtensions.buildPreviewRangeExtension()),
        sqlExtensions.buildResultSourceRangeExtension(),
        Prec.highest(
          keymap.of([
            { key: "'", run: handleSqlSingleQuote },
            { key: "Tab", run: handleTab },
            {
              key: "Escape",
              run: createQueryEditorEscapeHandler({
                clearBatchSelection: clearBatchColumnSelectionSession,
                cancelPendingAcceptance: () => {
                  clearPendingCompletionEnter();
                  clearPendingCompletionTab();
                },
                closeSearch: () => searchPanelRef.value?.closeSearch() ?? false,
                closeCompletion: (currentView) => initializedRuntime.codeMirrorCloseCompletion?.(currentView) ?? false,
              }),
            },
          ]),
        ),
        initializedRuntime.runKeymapComp.of(runKeymapExtension(keymap)),
        Prec.highest(
          EditorView.domEventHandlers({
            keydown(event, currentView) {
              const shortcuts = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);
              return runQueryEditorAltExtendSelection(event, shortcuts.extendSelection, currentView, extendQueryEditorSelectionForView);
            },
          }),
        ),
        initializedRuntime.wordWrapComp.of(props.forceWordWrap || initialSettings.wordWrap ? EditorView.lineWrapping : []),
        initializedRuntime.showWhitespaceComp.of(showWhitespaceExtension(initialSettings.showWhitespace)),
        initializedRuntime.readOnlyComp.of([EditorState.readOnly.of(!!props.readOnly), EditorView.editable.of(!props.readOnly)]),
        initializedRuntime.indentComp.of(indentExtension()),
        // Alt+drag belongs exclusively to rectangular selection. Registering the
        // same gesture as an added cursor preserves the previous cursor.
        rectangularSelection({
          eventFilter: startsQueryEditorRectangularSelection,
        }),
        EditorView.updateListener.of((update) => {
          if (update.focusChanged && update.view.hasFocus) {
            rememberFocusedQueryEditorView(update.view);
          }
          if (update.docChanged) {
            searchPanelRef.value?.scheduleDocumentSearchUpdate();
            if (isEditorComposing(update.view)) {
              pendingImeModelEmit = true;
              completion.invalidateRequests();
            } else {
              emitModelValue(update.view);
              invalidateSemanticDiagnosticsForDocumentChange();
              scheduleSemanticDiagnostics();
              let insertedText = "";
              let removedText = "";
              update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
                insertedText += inserted.toString();
                removedText += update.startState.doc.sliceString(fromA, toA);
              });
              const suppressCompletionAutoStart = consumeSqlCompletionAutoStartSuppression();
              if (!suppressCompletionAutoStart) scheduleDeferredCompletionTrigger(update.view, insertedText, removedText);
            }
            if (update.transactions.some((tr) => tr.isUserEvent("input.paste"))) {
              resyncCaretAfterPaste(update.view);
            }
          }
          if (update.selectionSet || update.docChanged) {
            syncEditorSelectionState(update.view);
            schedulePreviewContextRefresh(update.view);
            emit("selectionChange", selectedSql.value);
            emit("cursorChange", update.state.selection.main.head);
            documentState.recordSelection(update.view);
          }
          // Clear activeCompletionOrigin when the completion session ends.
          if (initializedRuntime.codeMirrorCompletionStatus) {
            const status = initializedRuntime.codeMirrorCompletionStatus(update.state) ?? null;
            if (status === null) {
              completion.activeOrigin = null;
              clearBatchColumnSelectionSession();
            }
          }
        }),
        initializedRuntime.fontThemeComp.of(
          editorFontTheme(EditorView, liveFontSize.value, initialSettings.fontFamily, {
            fixedHeight: true,
            scrollable: true,
          }),
        ),
        EditorView.domEventHandlers({
          paste(event, currentView) {
            return recoverLargeTauriPaste(event, currentView);
          },
          dragover(event) {
            if (props.readOnly || !hasDroppedTableReference(event)) {
              hideQueryEditorDropCaret();
              return false;
            }
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
            showQueryEditorDropCaretAt(event.clientX, event.clientY);
            return true;
          },
          dragleave() {
            hideQueryEditorDropCaret();
            return false;
          },
          drop(event, currentView) {
            hideQueryEditorDropCaret();
            return insertDroppedTableReference(currentView, event);
          },
          blur(_event, currentView) {
            documentState.recordSelection(currentView);
            return false;
          },
          compositionstart() {
            imeCompositionActive = true;
            completion.invalidateRequests();
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
            if (!wheelZoomGestureGuard.accepts(event)) return false;
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
          mousedown: onEditorMouseDown,
        }),
      ],
    });
    return {
      state,
      parent: editorElement,
      onReady() {
        if (!view.value) return;
        syncQueryEditorInsertContext(view.value);
        batchSelection.attach(view.value, tooltipParent);
        postCompositionKeyGuardCleanup = postCompositionKeyGuard.attach(view.value.contentDOM);
        registerEditorScrollbarPointerGuard(view.value);
        view.value.scrollDOM.addEventListener("scroll", scheduleEditorViewportEmit, {
          passive: true,
        });
        const scrollDOM = view.value.scrollDOM;
        const onEditorScroll = () => {
          if (contextMenuOpen.value) {
            contextMenuOpen.value = false;
          }
        };
        scrollDOM.addEventListener("scroll", onEditorScroll);
        contextMenuPointerCleanup = () => {
          scrollDOM.removeEventListener("scroll", onEditorScroll);
          contextMenuPointerCleanup = null;
        };
        restoreEditorSelection(props.initialSelection, !props.initialViewport);
        restoreEditorViewport();
        performEditorReveal();
        syncContextMenuState(view.value);
        emit("previewChangesAvailable", !!previewContextSql.value);
        syncEditorFontCssVars(liveFontSize.value, initialSettings.fontFamily);
        syncEditorDiagnosticCssVars();
        registerTableReferenceDropListener();
        completionMetadata.cachedTables = [];
        cachedCompletionObjectsByScope.clear();
        scheduleSemanticDiagnostics();
        if (props.autoFocus) {
          // Query tabs opt in; shared editor instances must preserve the surrounding UI focus.
          nextTick(() => {
            requestAnimationFrame(() => {
              focusEditorView(view.value);
            });
          });
        }
        void nextTick(async () => {
          if (!view.value || !initializedRuntime.codeMirrorTheme) return;
          const settings = settingsStore.editorSettings;
          const themeColors = settings.theme === "custom" ? getCurrentCustomThemeColors() : settings.customThemeColors;
          const themeExt = await loadEditorTheme(settings.theme, editorThemeAppearance(), themeColors, themePalette.value);
          view.value.dispatch({
            effects: [initializedRuntime.codeMirrorTheme.reconfigure(themeExt)],
          });
        });
      },
    };
  },
});
onMounted(codeMirrorLifecycle.initialize);

// When completionTriggerMode changes, close any open typing session
// that would no longer be allowed under the new mode.
watch(
  () => settingsStore.editorSettings.completionTriggerMode,
  (newMode) => {
    if (!view.value || !codeMirrorRuntime.codeMirrorCompletionStatus || !codeMirrorRuntime.codeMirrorCloseCompletion) return;
    const status = codeMirrorRuntime.codeMirrorCompletionStatus(view.value.state);
    if (!status || completion.activeOrigin !== "typing") return;
    // If switching to manual, close all typing sessions.
    if (newMode === "manual") {
      codeMirrorRuntime.codeMirrorCloseCompletion(view.value);
      return;
    }
    // For other mode changes, re-evaluate the policy.
    // If the current position would not trigger under the new mode, close.
    const fullDoc = view.value.state.doc.toString();
    const position = view.value.state.selection.main.head;
    if (!shouldTriggerSqlCompletionForPosition(fullDoc, position)) {
      codeMirrorRuntime.codeMirrorCloseCompletion(view.value);
    }
  },
);

const documentState = useQueryEditorDocumentState({
  isEditorComposing,
  props,
  view,
  previewContextSql,
  emit,
  scheduleSemanticDiagnostics,
  clearScheduledPreviewContextRefresh,
  syncContextMenuState,
  applyEditorAppearance,
  applyEditorShortcutKeymaps,
  applyEditorIndentExtension,
  applyEditorCompletionExtension,
  invalidateSemanticDiagnosticsForDocumentChange,
  currentEditorDocText,
  scheduleDocumentSearchUpdate: () => searchPanelRef.value?.scheduleDocumentSearchUpdate(),
  runtime: {
    get historyResetComp() {
      return codeMirrorRuntime.historyResetComp;
    },
    get codeMirrorHistory() {
      return codeMirrorRuntime.codeMirrorHistory;
    },
    get codeMirrorEditorSelection() {
      return codeMirrorRuntime.codeMirrorEditorSelection;
    },
    get editorIsActive() {
      return editorIsActive;
    },
  },
});
const { normalizedEditorSelection, restoreEditorSelection, performEditorReveal, restoreEditorFocus, scheduleEditorViewportEmit, restoreEditorViewport } = documentState;

// The editor component is reused across tabs, so a tab switch can change the
// connection/database without remounting it.
watch([() => props.connectionId, () => props.database, () => props.catalog, () => props.clientSessionId], () => warmActiveTabConnection());

watch(
  () => [props.connectionId, props.database, props.schema, props.databaseType] as const,
  () => syncQueryEditorInsertContext(),
);

// Restored tabs mount before their connection is established, so the warm-up
// above is skipped and never retried when connecting finishes later.
watch(
  () => (props.connectionId ? connectionStore.connectedIds.has(props.connectionId) : false),
  (connected) => {
    if (connected) warmActiveTabConnection();
  },
);

// A content-search jump. Fires on id change (a new or reused tab, or a repeat
// click on the same result), and on mount when the request is already pending.
watch(
  () => props.revealRequest?.id,
  (id, previousId) => {
    if (!id || id === previousId) return;
    performEditorReveal();
  },
);

watch(
  () => props.formatRequestId,
  (val) => {
    if (val && val > lastHandledFormatRequestId) {
      lastHandledFormatRequestId = val;
      formatCurrentSql();
    }
  },
);

watch(
  () => props.compressRequestId,
  (val) => {
    if (val && val > lastHandledCompressRequestId) {
      lastHandledCompressRequestId = val;
      compressCurrentSql();
    }
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
    if (!view.value || !codeMirrorRuntime.setStatementExecutionMarkersEffect) return;
    view.value.dispatch({
      effects: codeMirrorRuntime.setStatementExecutionMarkersEffect.of(markers),
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
  () => props.catalog,
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
  () => connectionStore.completionCacheRevision(props.connectionId, props.database),
  () => {
    completion.invalidateRequests();
    refreshCompletionCache();
    setSemanticDiagnostics([]);
    scheduleSemanticDiagnostics();
  },
);

watch([() => props.clientSessionId, () => props.completionContextVersion], () => {
  completion.invalidateRequests();
  refreshCompletionCache();
  setSemanticDiagnostics([]);
  scheduleSemanticDiagnostics();
});

watch([() => props.databaseType, () => props.dialect, () => props.syntaxDialect, sqlDriverProfile], () => {
  executableStatementRangeCache = null;
  statementBoundaries.invalidate();
  if (!view.value || !codeMirrorRuntime.sqlLanguageComp || !codeMirrorRuntime.buildSqlLanguageExtension || !codeMirrorRuntime.sqlSemanticHighlightComp || !codeMirrorRuntime.buildSqlSemanticHighlightExtension || !codeMirrorRuntime.sqlSignatureComp || !codeMirrorRuntime.buildSqlSignatureExtension)
    return;
  // Signature tooltips depend on the external dialect, so refresh them even when the document and selection stay unchanged.
  view.value.dispatch({
    effects: [
      codeMirrorRuntime.sqlLanguageComp.reconfigure(codeMirrorRuntime.buildSqlLanguageExtension()),
      codeMirrorRuntime.sqlSemanticHighlightComp.reconfigure(codeMirrorRuntime.buildSqlSemanticHighlightExtension()),
      codeMirrorRuntime.sqlSignatureComp.reconfigure(codeMirrorRuntime.buildSqlSignatureExtension()),
    ],
  });
});

// openGauss compatibility mode is loaded asynchronously from the backend into a
// dedicated store map (not the sidebar tree). A restored tab may open before the
// map is warm; when the mode arrives, re-derive statement boundaries and
// diagnostics so package DDL is parsed with the correct PL/SQL rules.
watch(
  () => (props.databaseType === "opengauss" ? connectionStore.databaseCompatibilityMode(props.connectionId, props.database) : undefined),
  (now, before) => {
    if (now === before) return;
    executableStatementRangeCache = null;
    statementBoundaries.invalidate();
    if (props.databaseType !== "opengauss") return;
    if (!view.value) return;
    refreshCompletionCache();
    setSemanticDiagnostics([]);
    scheduleSemanticDiagnostics(0);
  },
);

watch(
  () => props.forceWordWrap,
  () => {
    if (!view.value || !codeMirrorRuntime.wordWrapComp) return;
    view.value.dispatch({
      effects: codeMirrorRuntime.wordWrapComp.reconfigure(wordWrapExtension()),
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

// Reactively apply editor settings changes. Also called after restoring a
// cached per-tab state, whose compartments predate any settings changed while
// another tab was active.
async function applyEditorAppearance() {
  const ss = queryEditorAppearanceSettings.value;
  if (
    !view.value ||
    !codeMirrorRuntime.codeMirrorTheme ||
    !codeMirrorRuntime.fontThemeComp ||
    !codeMirrorRuntime.wordWrapComp ||
    !codeMirrorRuntime.lineNumbersComp ||
    !codeMirrorRuntime.vimModeComp ||
    !codeMirrorRuntime.closeBracketsComp ||
    !codeMirrorRuntime.runGutterComp ||
    !codeMirrorRuntime.runKeymapComp ||
    !codeMirrorRuntime.editorViewModule
  ) {
    return;
  }
  if (!isGestureZooming.value && !zoomCommitScheduler.hasPendingCommit() && liveFontSize.value !== ss.fontSize) {
    liveFontSize.value = ss.fontSize;
  }
  syncEditorFontCssVars(liveFontSize.value, ss.fontFamily);
  syncEditorDiagnosticCssVars();
  const themeColors = getCurrentCustomThemeColors();
  const [themeExt] = await Promise.all([loadEditorTheme(ss.theme, editorThemeAppearance(), themeColors, themePalette.value), ss.vimModeEnabled ? ensureCodeMirrorVim() : Promise.resolve(false)]);
  if (
    !view.value ||
    !codeMirrorRuntime.codeMirrorTheme ||
    !codeMirrorRuntime.wordWrapComp ||
    !codeMirrorRuntime.lineNumbersComp ||
    !codeMirrorRuntime.vimModeComp ||
    !codeMirrorRuntime.closeBracketsComp ||
    !codeMirrorRuntime.runGutterComp ||
    !codeMirrorRuntime.runKeymapComp ||
    !codeMirrorRuntime.editorViewModule
  ) {
    return;
  }
  view.value.dispatch({
    effects: [
      codeMirrorRuntime.codeMirrorTheme.reconfigure(themeExt),
      codeMirrorRuntime.wordWrapComp.reconfigure(props.forceWordWrap || ss.wordWrap ? codeMirrorRuntime.editorViewModule.EditorView.lineWrapping : []),
      ...(codeMirrorRuntime.showWhitespaceComp ? [codeMirrorRuntime.showWhitespaceComp.reconfigure(showWhitespaceExtension(ss.showWhitespace))] : []),
      codeMirrorRuntime.lineNumbersComp.reconfigure(lineNumbersExtension(ss.showLineNumbers)),
      codeMirrorRuntime.vimModeComp.reconfigure(vimModeExtension(settingsStore.editorSettings.vimModeEnabled)),
      codeMirrorRuntime.closeBracketsComp.reconfigure(closeBracketsExtension(settingsStore.editorSettings.autoCloseBrackets)),
      codeMirrorRuntime.runGutterComp.reconfigure(runStatementGutterExtension()),
      codeMirrorRuntime.runKeymapComp.reconfigure(runKeymapExtension(codeMirrorRuntime.editorViewModule.keymap)),
    ],
  });
}

watch(
  [queryEditorAppearanceSettings, () => isDark.value, () => themePalette.value, editorThemeAppearance],
  () => {
    void applyEditorAppearance();
  },
  { deep: true },
);

// Re-sync shortcut-driven keymap compartments; shared with per-tab state restore.
function applyEditorShortcutKeymaps() {
  if (!view.value || !codeMirrorRuntime.editorViewModule) return;
  const effects = [];
  if (codeMirrorRuntime.defaultKeymapComp) {
    effects.push(codeMirrorRuntime.defaultKeymapComp.reconfigure(defaultKeymapExtension()));
  }
  if (codeMirrorRuntime.runKeymapComp) {
    effects.push(codeMirrorRuntime.runKeymapComp.reconfigure(runKeymapExtension(codeMirrorRuntime.editorViewModule.keymap)));
  }
  if (effects.length > 0) {
    view.value.dispatch({ effects });
  }
}

watch(
  () => [settingsStore.editorSettings.shortcuts, settingsStore.editorSettings.sqlShortcuts],
  () => {
    applyEditorShortcutKeymaps();
  },
  { deep: true },
);

// Re-sync the indent compartment; shared with per-tab state restore.
function applyEditorIndentExtension() {
  if (!view.value || !codeMirrorRuntime.indentComp) return;
  view.value.dispatch({ effects: codeMirrorRuntime.indentComp.reconfigure(indentExtension()) });
}

watch(
  () => [settingsStore.editorSettings.sqlFormatter.tabWidth, settingsStore.editorSettings.sqlFormatter.useTabs],
  () => {
    applyEditorIndentExtension();
  },
);

// Re-sync the completion compartment; shared with per-tab state restore.
function applyEditorCompletionExtension() {
  completion.invalidateRequests();
  if (!view.value || !codeMirrorRuntime.completionComp || !codeMirrorRuntime.buildSqlCompletionExtension) return;
  view.value.dispatch({
    effects: codeMirrorRuntime.completionComp.reconfigure(codeMirrorRuntime.buildSqlCompletionExtension()),
  });
  if (codeMirrorRuntime.codeMirrorCompletionStatus?.(view.value.state) === "active") {
    codeMirrorRuntime.codeMirrorStartCompletion?.(view.value);
  }
}

watch(
  () => [settingsStore.editorSettings.snippets, settingsStore.editorSettings.sortCompletionColumnsAlphabetically, settingsStore.editorSettings.selectFirstCompletionOnOpen],
  () => {
    applyEditorCompletionExtension();
  },
  { deep: true },
);

watch(
  () => settingsStore.editorSettings.sqlSemanticDiagnosticsEnabled,
  (enabled) => {
    if (props.databaseType === "redis" || props.databaseType === "mongodb" || props.databaseType === "victoriametrics") return;
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
  finishBatchColumnSelectionDrag(false);
  cancelBatchColumnSelectionRefresh();
  documentState.flushBeforeDeactivation();
  clearTableNavigationHover();
  clearPendingCompletionEnter();
  clearPendingCompletionTab();
  clearDeferredCompletionTrigger();
  clearScheduledPreviewContextRefresh();
  executionViewportOwnership.reset();
  editorIsActive = false;
  clearScheduledSemanticDiagnostics();
  completion.invalidateRequests();
  unregisterTableReferenceDropListener();
}

function resumeQueryEditorBackgroundWork() {
  editorIsActive = true;
  registerTableReferenceDropListener();
  scheduleSemanticDiagnostics();
  // Warm the database driver/pool while the user is still reading or typing, so
  // the first Run does not pay pool creation or external-driver startup.
  warmActiveTabConnection();
  if (view.value) schedulePreviewContextRefresh(view.value);
  restoreEditorSelection(undefined, !props.initialViewport);
  restoreEditorFocus();
  restoreEditorViewport();
}

function warmActiveTabConnection() {
  if (!props.connectionId) return;
  connectionStore.warmConnection(props.connectionId, {
    database: props.database,
    catalog: props.catalog,
    clientSessionId: props.clientSessionId,
  });
}

onActivated(resumeQueryEditorBackgroundWork);

onDeactivated(pauseQueryEditorBackgroundWork);

onMounted(() => {
  if (typeof window === "undefined") return;
  documentState.attach();
  warmActiveTabConnection();
});

onBeforeUnmount(() => {
  pauseQueryEditorBackgroundWork();
  documentState.dispose();
  pointerInteractions.dispose();
  objectNavigation.dispose();
  contextMenuPointerCleanup?.();
  postCompositionKeyGuardCleanup?.();
  postCompositionKeyGuardCleanup = null;
  batchSelection.dispose();
  zoomCommitScheduler.dispose();
  if (view.value) {
    unregisterQueryEditorInsertContext(view.value);
    clearRememberedFocusedQueryEditorView(view.value);
  }
  codeMirrorLifecycle.dispose();
});

function openSearch(): boolean {
  return searchPanelRef.value?.openSearch() ?? false;
}

function openGotoLine(): boolean {
  return gotoLinePanelRef.value?.openGotoLine() ?? false;
}

function openReplace(): boolean {
  if (props.readOnly) return false;
  return searchPanelRef.value?.openReplace() ?? false;
}

function scrollCursorIntoView() {
  const preserveViewport = executionViewportOwnership.consumeCompletionPreservation();
  const currentView = view.value;
  if (!currentView || !codeMirrorRuntime.editorViewModule || !editorIsActive || preserveViewport) return;
  const pos = currentView.state.selection.main.head;
  if (isQueryEditorPositionVisible(pos, currentView.visibleRanges, currentView.viewport)) return;
  // Use "center" rather than "nearest": by the time this runs, the results pane has already
  // opened/resized and shrunk the editor viewport, so the cursor's old position is often no
  // longer visible. "nearest" then pins it right at the new viewport's edge (Fixes #5281: in a
  // long multi-statement file, the just-executed statement lands flush against the results pane
  // divider), which is exactly where it's hardest to see and re-click. Centering keeps it
  // comfortably visible so the user doesn't have to scroll to find/re-run it.
  currentView.dispatch({
    effects: codeMirrorRuntime.editorViewModule.EditorView.scrollIntoView(pos, { y: "center" }),
  });
}

function beginExecutionViewportTracking() {
  executionViewportOwnership.beginExecution();
}

function recordExecutionViewportInteraction() {
  executionViewportOwnership.recordUserInteraction();
}

function dismissHoverTooltip() {
  if (!view.value || !codeMirrorRuntime.hoverCloseEffect) return;
  view.value.dispatch({ effects: codeMirrorRuntime.hoverCloseEffect });
}

function acceptGutterExecutionViewport(requestId: number) {
  return executionViewportOwnership.acceptRequest(requestId);
}

function cancelGutterExecutionViewport(requestId: number) {
  return executionViewportOwnership.cancelPendingRequest(requestId);
}

function shouldBlockExecutionShortcut(event?: KeyboardEvent, currentView: EditorViewType | null = view.value): boolean {
  return (currentView ? isEditorComposing(currentView) : false) || (event ? postCompositionKeyGuard.blocks(event) : false);
}

defineExpose({
  openSearch,
  openReplace,
  scrollCursorIntoView,
  beginExecutionViewportTracking,
  acceptGutterExecutionViewport,
  cancelGutterExecutionViewport,
  shouldBlockExecutionShortcut,
  requestExecute,
  requestExecuteInNewResultTab,
  requestPreviewChanges,
  captureExecutionSnapshot,
  pasteClipboardAsSqlInCondition,
  focusStatementRange,
  focusErrorPosition,
  previewStatementRange,
  refreshCompletionCache,
});
</script>

<template>
  <div class="h-full w-full overflow-hidden relative" @wheel="recordExecutionViewportInteraction" @pointerdown="recordExecutionViewportInteraction" @gesturestart="onEditorGestureStart" @gesturechange="onEditorGestureChange" @gestureend="onEditorGestureEnd">
    <QueryEditorContextMenu :get-state="getContextMenuState" :actions="contextMenuActions" @close="contextMenuOpen = false" v-slot="{ onContextMenu }">
      <div
        ref="editorRef"
        data-query-editor-root
        class="h-full w-full overflow-hidden"
        @contextmenu="
          (e: MouseEvent) => {
            if (view) {
              syncContextMenuStateAtEvent(view, e);
              dismissHoverTooltip();
            }
            onContextMenu(e);
            contextMenuOpen = true;
          }
        "
      />
    </QueryEditorContextMenu>
    <div v-show="queryEditorDropCaret" data-query-editor-drop-caret class="pointer-events-none absolute z-20 w-0.5 rounded-full bg-primary/70" :style="queryEditorDropCaretStyle" />
    <EditorSearchPanel ref="searchPanelRef" :view="view" @open="gotoLinePanelRef?.closeGotoLine()" />
    <EditorGotoLinePanel ref="gotoLinePanelRef" :view="view" @open="searchPanelRef?.closeSearch()" />
    <SqlExecutionTargetPicker v-if="pickerVisible" :candidates="pickerCandidates" :active-index="pickerActiveIndex" :anchor="pickerAnchor" @update:active-index="onPickerActiveIndexChange" @confirm="onPickerConfirm" @cancel="closePicker" />
    <DelimitedListDialog v-model:open="delimitedListOpen" :selected-text="delimitedListSelectedText" @confirm="applyDelimitedListResult" />
    <TableStructurePeekDialog
      v-for="panel in structurePeekPanels"
      :key="panel.id"
      :table-name="panel.target.name"
      :schema="panel.target.schema"
      :columns="panel.columns"
      :loading="panel.loading"
      :error="panel.error"
      :z-index="panel.zIndex"
      :cascade-index="panel.cascadeIndex"
      @close="closeStructurePeekPanel(panel.id)"
      @activate="bringStructurePeekToFront(panel.id)"
      @insert-value="(value, kind) => insertStructurePeekValue(panel, value, kind)"
    />
    <CodeSnapshotDialog v-model:open="codeSnapshotOpen" :source="codeSnapshotSource" />
    <QueryEditorIntentionPopup :state="intentionPopup" @close="closeIntentionPopup" @confirm="executeIntentionAction" @select="intentionPopup && (intentionPopup.selectedIndex = $event)" />
  </div>
</template>

<style scoped>
[data-query-editor-root] > :deep(.cm-editor) {
  /* The host supplies both dimensions. Keep viewport DOM changes from
     invalidating intrinsic sizes throughout the surrounding flex layout;
     WebKit otherwise spends a frame recomputing it on each viewport change.
     Leave paint uncontained so editor overlays retain their overflow. */
  contain: size layout style;
}

[data-query-editor-root] :deep(.cm-scroller::-webkit-scrollbar) {
  width: 5px;
  height: 5px;
}

[data-query-editor-root] :deep(.cm-scroller::-webkit-scrollbar-track) {
  background: rgba(127, 127, 127, 0.1);
}

[data-query-editor-root] :deep(.cm-scroller::-webkit-scrollbar-thumb) {
  background: rgba(127, 127, 127, 0.7);
  border-radius: 999px;
}

@supports not selector(::-webkit-scrollbar) {
  [data-query-editor-root] :deep(.cm-scroller) {
    scrollbar-width: thin;
  }
}

.query-editor--table-navigation-hover :deep(.cm-content),
.query-editor--table-navigation-hover :deep(.cm-line) {
  cursor: pointer;
}

:deep(.cm-db-execution-preview) {
  background: var(--dbx-editor-selection-background, rgba(59, 130, 246, 0.35));
}

:deep(.cm-db-result-source-highlight) {
  background: var(--dbx-editor-selection-background, rgba(126, 34, 206, 0.2));
}

:deep(.cm-lineNumbers .cm-db-result-source-line-number) {
  color: rgb(126 34 206) !important;
  font-weight: 700;
}

:global(.dark) :deep(.cm-lineNumbers .cm-db-result-source-line-number) {
  color: rgb(216 180 254) !important;
}

:deep(.cm-db-currentStatementFrameLayer) {
  pointer-events: none;
}

:deep(.cm-db-currentStatementFrame) {
  box-sizing: border-box;
  border: 1px solid rgb(34 197 94 / 0.75);
  border-radius: 2px;
  pointer-events: none;
}

:deep(.cm-run-statement-gutter) {
  min-width: 28px;
}

:deep(.cm-run-statement-gutter .cm-gutterElement) {
  align-items: center;
  box-sizing: border-box;
  display: flex;
  justify-content: center;
  min-width: 28px;
  padding: 0 2px;
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
  border-radius: var(--dbx-radius-fixed-6);
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

:deep(.cm-statement-execution-marker--running) {
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  color: var(--primary);
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
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: min(24px, calc(var(--dbx-editor-font-size, 13px) * 1.6));
  height: min(24px, calc(var(--dbx-editor-font-size, 13px) * 1.6));
  margin: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--dbx-radius-fixed-6);
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

:deep(.cm-run-statement-marker > svg) {
  display: block;
  width: min(14px, 70%);
  height: min(14px, 70%);
  pointer-events: none;
  flex-shrink: 0;
}

:deep(.cm-statement-execution-badge) {
  position: absolute;
  right: -1px;
  bottom: -1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: min(9px, 45%);
  height: min(9px, 45%);
  border-radius: 9999px;
  color: white;
  box-shadow: 0 0 0 1px rgb(255 255 255 / 0.9);
  pointer-events: none;
}

:deep(.cm-statement-execution-badge--success) {
  background: rgb(5 150 105);
}

:deep(.cm-statement-execution-badge--running) {
  background: var(--primary);
}

:deep(.cm-statement-execution-badge--error) {
  background: rgb(220 38 38);
}

:deep(.cm-statement-execution-badge svg) {
  display: block;
  width: 75%;
  height: 75%;
}

:deep(.cm-statement-execution-spinner) {
  animation: dbx-statement-execution-spin 0.8s linear infinite;
}

@keyframes dbx-statement-execution-spin {
  to {
    transform: rotate(360deg);
  }
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

<style>
[data-sql-structure-hover-content="true"] {
  scrollbar-color: color-mix(in oklab, var(--foreground) 42%, transparent) color-mix(in oklab, var(--muted) 65%, transparent);
}

[data-sql-structure-hover-content="true"]::-webkit-scrollbar {
  width: 8px;
  height: 0;
}

[data-sql-structure-hover-content="true"]::-webkit-scrollbar:horizontal {
  display: none;
  height: 0;
}

[data-sql-structure-hover-content="true"]::-webkit-scrollbar-track {
  border-radius: 999px;
  background: color-mix(in oklab, var(--muted) 65%, transparent);
}

[data-sql-structure-hover-content="true"]::-webkit-scrollbar-thumb {
  min-width: 32px;
  min-height: 32px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: color-mix(in oklab, var(--foreground) 42%, transparent);
  background-clip: padding-box;
}

[data-sql-structure-hover-content="true"]::-webkit-scrollbar-corner {
  background: transparent;
}

[data-sql-structure-hover-scrollbar="true"] {
  position: relative;
  width: 100%;
  height: 10px;
  margin-top: 6px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--muted) 72%, var(--border));
  cursor: pointer;
  touch-action: none;
  user-select: none;
  flex: 0 0 10px;
}

[data-sql-structure-hover-scrollbar-thumb="true"] {
  position: absolute;
  top: 1px;
  left: 0;
  height: 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: color-mix(in oklab, var(--foreground) 52%, transparent);
  background-clip: padding-box;
}

[data-sql-structure-hover-scrollbar="true"]:hover [data-sql-structure-hover-scrollbar-thumb="true"] {
  background: color-mix(in oklab, var(--foreground) 70%, transparent);
}

.cm-batch-column-selection-checkbox {
  width: 14px;
  height: 14px;
  margin: 0 2px 0 0;
  accent-color: var(--primary);
  cursor: pointer;
  flex: 0 0 auto;
}
</style>
