<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, onActivated, onDeactivated, watch, shallowRef, computed, nextTick } from "vue";
import { AlignLeft, Camera, CaseLower, CaseSensitive, CaseUpper, ClipboardPaste, Code2, Download, Eye, FileCode, MessageSquareText, Minimize2, Pencil, PencilRuler, Play, Copy, List, Scissors, Search, Sparkles, Table2, TextSelect, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { Completion, CompletionContext } from "@codemirror/autocomplete";
import { Transaction, StateEffect } from "@codemirror/state";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { search as cmSearch } from "@codemirror/search";
import EditorSearchPanel from "./EditorSearchPanel.vue";
import SqlExecutionTargetPicker from "./SqlExecutionTargetPicker.vue";
import DelimitedListDialog from "./DelimitedListDialog.vue";
import CodeSnapshotDialog from "@/components/codeSnapshot/CodeSnapshotDialog.vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { CodeSnapshotSource } from "@/lib/codeSnapshot/codeSnapshot";
import { copyToClipboard, readTextFromClipboard } from "@/lib/common/clipboard";
import { completionMatchRanges } from "@/lib/common/completionMatch";
import { executionCandidateForMode, resolveExecutableSql, type SqlExecutionSnapshot, type SqlExecutionOverride, type SqlExecutionCandidate } from "@/lib/sql/sqlExecutionTarget";
import { buildExecutionCandidates, hasMultipleExecutionTargets, supportsExecutionTargetPicker, type SqlTextRange } from "@/lib/sql/sqlStatementRanges";
import { executableStatementRangeAtCursor, executableStatementRangeCacheForDoc, executableStatementRangeStartingAt as executableStatementRangeStartingAtLine, type ExecutableStatementRangeCache } from "@/lib/sql/executableStatementRangeCache";
import { currentStatementFrameRangeTo } from "@/lib/sql/currentStatementFrame";
import { looksLikeDmlStatement } from "@/lib/sql/dmlChangePreview";
import { expandToSqlStatementWindow } from "@/lib/sql/insertValueHints";
import { insertValueHintColumnNames } from "@/lib/sql/insertValueHintColumns";
import { canFormatSqlForDatabaseType, formatSqlForDisplay, formatSqlForEditing, compressSqlText, sqlFormatDialectForDbType, type SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import { detectAndFormatStructured } from "@/lib/sql/autoFormat";
import { enabledSqlParameterSyntaxes, resolveSqlVariableSyntaxToggles } from "@/lib/sql/sqlVariableSyntax";
import { blankLineDeletionChanges, replaceSelectedEditorText } from "@/lib/editor/queryEditorTextEdits";
import { createQueryEditorExecutionViewportOwnership, isQueryEditorPositionVisible } from "@/lib/editor/queryEditorExecutionViewport";
import { joinQueryEditorLines } from "@/lib/editor/queryEditorJoinLines";
import { insertQueryEditorNewline } from "@/lib/editor/queryEditorNewline";
import { createSqlSignatureTooltipDom } from "@/lib/editor/sqlSignatureTooltip";
import { buildSqlInConditionFromPasteSource, insertTextForSqlInCondition } from "@/lib/sql/sqlInListPaste";
import { resolveSqlSingleQuoteKeyAction } from "@/lib/sql/sqlQuoteCaret";
import { convertSqlSelectionCase, type SqlSelectionCaseMode } from "@/lib/sql/sqlSelectionCase";
import { convertToNextNamingStyle } from "@/lib/naming/namingStyleConverter";
import { formatMongoShellText } from "@/lib/mongo/mongoFormatter";
import { detectAndFormatElasticsearchRequests } from "@/lib/elasticsearch/elasticsearchFormatter";
import { useConnectionStore, COMPLETION_METADATA_CONCURRENCY } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import {
  buildSelectStarExpansion,
  buildSqlCompletionItemsFromContext,
  buildPostgresSequenceLiteralCompletionItems,
  getSqlFunctionSignatureHelp,
  getSqlCompletionContext,
  getPostgresSequenceLiteralCompletionContext,
  getSqlCompletionResultValidFor,
  isSqlCompletionSuppressedContext,
  isSqlLikeCompletionStatement,
  prepareSqlCompletionReplacement,
  recordCompletionSelection,
  selectStarResultColumnsMatch,
  shouldAutoOpenSqlCompletion,
  shouldChainSqlCompletionAfterAccept,
  extractCteDefinitions,
} from "@/lib/sql/sqlCompletion";
import { originForSqlCompletionProvider, originForTypedSqlCompletionStart, shouldAllowSqlCompletionTrigger, type SqlCompletionTriggerFacts, type SqlCompletionTriggerOrigin } from "@/lib/sql/sqlCompletionTriggerPolicy";
import { driverProfileHasCompletionCandidates } from "@/lib/database/driverProfileExtensions";
import { sqlCompletionContextFromSemantic, sqlSemanticSelectStarIsOnlyProjection, sqlSemanticSelectStarQualifierSql, sqlSemanticSelectStarTableSources } from "@/lib/sql/semantic/completion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { mergeSqlSemanticReferenceAnalysis, resolveSqlSemanticNavigationTarget } from "@/lib/sql/semantic/references";
import { buildElasticsearchCompletionItemsFromContext, getElasticsearchCompletionContext, getElasticsearchCompletionResultValidFor, shouldAutoOpenElasticsearchCompletion, type ElasticsearchCompletionItem } from "@/lib/elasticsearch/elasticsearchCompletion";
import { buildMongoCompletionItemsFromContext, getMongoCompletionContext, getMongoCompletionResultValidFor, mongoCompletionNeedsCollections, mongoCompletionNeedsFields, shouldAutoOpenMongoCompletion, type MongoCompletionItem } from "@/lib/mongo/mongoCompletion";
import {
  buildSqlServerUseDatabaseCompletionItems,
  mergeSqlCompletionQualifierNames,
  resolveSqlCompletionRoutineLookupTarget,
  resolveSqlCompletionSchemaLookupDatabase,
  resolveSqlCompletionScope,
  resolveSqlCompletionTableLookupTarget,
  resolveSqlServerUseDatabaseCompletion,
  sqlServerUseCompletionDatabaseNames,
  sqlServerUseDatabaseBeforeCursor,
  type SqlCompletionScope,
} from "@/lib/sql/sqlCompletionLookupTarget";
import { usesOracleSessionCompletionColumns as shouldUseOracleSessionCompletionColumns } from "@/lib/sql/oracleCompletionSession";
import {
  extractIdentifierDetailsAt,
  extractQualifiedIdentifierAt,
  isSqlKeyword,
  matchSqlObject,
  matchTable,
  mergeSqlObjectNavigationType,
  resolveSqlObjectNavigationIdentity,
  splitQualifiedIdentifier,
  sqlObjectHoverDetail,
  sqlObjectNavigationSourceKind,
  sqlObjectNavigationTarget,
  sqlObjectNavigationTargetFromIdentity,
  sqlObjectNavigationTypeFromCompletionObjectType,
  type SqlObjectNavigationTarget,
} from "@/lib/sql/sqlNavigation";
import { buildHoverTableSql, ddlForHoverPreview, hoverTableMatchesScope, normalizeAlignedSqlWhitespace, quoteIdentifier, quoteQualifiedName, reformatHoverDdl, scopeHoverTables, type HoverTableScope } from "@/lib/editor/hoverTableSql";
import { constrainSqlHoverLayout } from "@/lib/editor/sqlHoverLayout";
import { createHoverSearch, type HoverSearchController } from "@/lib/editor/sqlHoverSearch";
import { lineColumnToOffset, sqlErrorDecorationRange as resolveSqlErrorDecorationRange } from "@/lib/sql/sqlDiagnostics";
import { analyzeMysqlRoutineSyntax, supportsMysqlRoutineSyntaxDiagnostics } from "@/lib/sql/mysqlRoutineSyntaxDiagnostics";
import { buildOracleSyntaxDiagnostics } from "@/lib/sql/oracleSyntaxDiagnostics";
import {
  DBX_TABLE_REFERENCE_MIME,
  DBX_TABLE_REFERENCE_DROP_EVENT,
  DBX_TABLE_REFERENCE_HOVER_EVENT,
  DBX_TABLE_REFERENCE_DRAG_END_EVENT,
  activeTableReferencePayloadValue,
  clearActiveTableReferencePayload,
  hasTableReferencePayloadType,
  parseTableReferencePayload,
  tableReferenceInsertText,
  type QueryEditorTableReferenceDropDetail,
  type QueryEditorTableReferenceHoverDetail,
  type QueryEditorTableReferencePayload,
} from "@/lib/editor/queryEditorTableDrop";
import { isPointOverElementRoot } from "@/lib/editor/tableReferenceDragFeedback";
import type { SqlHighlighter } from "@/lib/sql/sqlHighlighter";
import { EDITOR_FONT_FAMILY_CSS_VAR, EDITOR_FONT_SIZE_CSS_VAR, editorDiagnosticColors, editorThemeAppearanceFor, loadEditorTheme, editorFontTheme, shellLineCommentTheme, sqlCompletionTheme, sqlSemanticHighlightTheme } from "@/lib/editor/editorThemes";
import { createStatementGutterMarkerDom, shouldShowStatementGutter } from "@/lib/editor/codemirrorStatementGutter";
import { createQueryEditorSqlShortcutDomHandler, isCharacterProducingShortcut } from "@/lib/editor/queryEditorSqlShortcut";
import { createQueryEditorReplaceShortcutBindings, createQueryEditorReplaceShortcutHandler, createQueryEditorSearchKeymap } from "@/lib/editor/queryEditorSearchKeymap";
import { buildQueryEditorLineNumbersExtension, createQueryEditorLineNumberAlignmentExtension } from "@/lib/editor/queryEditorLineNumbers";
import { searchKeymapWithoutModD } from "@/lib/editor/codemirrorSearchKeymap";
import { defaultKeymapForGlobalShortcuts } from "@/lib/editor/codemirrorDefaultKeymap";
import { appendSqlCompletionSpace } from "@/lib/editor/sqlCompletionInsertion";
import { batchColumnSelectionColumnList, batchColumnSelectionInsertReplacement, batchColumnSelectionReplaceTo, isBatchColumnSelectionCompletionActive, shouldResolveSqlColumnCompletion } from "@/lib/editor/batchColumnSelection";
import { compareSqlCompletions, completionLabelPresentation } from "@/lib/editor/sqlCompletionPresentation";
import { clampEditorFontSize, createEditorWheelZoomGestureGuard, createEditorZoomCommitScheduler, fontSizeFromGestureScale, fontSizeFromWheelDelta } from "@/lib/editor/editorZoom";
import { enabledSqlShortcutActions, resolveSqlShortcutTemplate } from "@/lib/sql/sqlShortcutActions";
import { normalizeShortcutSettings, shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";
import { trimmedSelectionLayer } from "@/lib/editor/codemirrorTrimmedSelectionLayer";
import { currentStatementFrameLayer } from "@/lib/editor/codemirrorCurrentStatementFrameLayer";
import { selectionMatchOccurrences } from "@/lib/editor/codemirrorSelectionMatches";
import { createInsertValueHintsExtension, requestInsertValueHintsRefresh, supportsInsertValueHints } from "@/lib/editor/codemirrorInsertValueHints";
import { sqlBlockFoldService } from "@/lib/editor/codemirrorSqlBlockFolding";
import { focusEditorView } from "@/lib/editor/queryEditorFocus";
import { createDbxCodeMirrorSqlDialect, type CodeMirrorSqlDialectName } from "@/lib/editor/codemirrorSqlDialect";
import { sqlSemanticTableNameSpansForSyntaxTree } from "@/lib/editor/codemirrorSqlSemanticHighlight";
import { startsQueryEditorRectangularSelection, usesQueryEditorObjectNavigationModifier } from "@/lib/editor/queryEditorPointerSelection";
import { LARGE_PASTE_HISTORY_USER_EVENT, normalizeQueryEditorPasteText, recoverableNativePasteSuffix, shouldRecoverLargeTauriPaste } from "@/lib/editor/queryEditorLargePaste";
import { computePasteCaretResyncTarget } from "@/lib/editor/queryEditorPasteCaretResync";
import { queryEditorCommentTokens, queryEditorLineCommentToken } from "@/lib/editor/queryEditorLineComment";
import { createShellLineCommentHighlight } from "@/lib/editor/codemirrorShellLineCommentHighlight";
import { extendQueryEditorSelection, runQueryEditorAltExtendSelection } from "@/lib/editor/queryEditorExtendSelection";
import { addNextQueryEditorSelectionOccurrence, selectAllQueryEditorSelectionOccurrences } from "@/lib/editor/queryEditorOccurrenceSelection";
import { createQueryEditorStringMouseSelection } from "@/lib/editor/queryEditorStringMouseSelection";
import { createQueryEditorCompletionShortcutBindings } from "@/lib/editor/queryEditorCompletionShortcut";
import { createQueryEditorSelectionCaseShortcutBindings } from "@/lib/editor/queryEditorSelectionCaseShortcut";
import { acceptSelectedCompletionWithRetry, acceptSelectedOrFirstCompletion } from "@/lib/editor/queryEditorCompletionAcceptance";
import { createQueryEditorExecutionShortcutBindings, createQueryEditorPostCompositionKeyGuard } from "@/lib/editor/queryEditorExecutionShortcut";
import type { StatementExecutionMarker } from "@/lib/tabs/tabPresentation";
import { isSchemaAware, isSingleDatabase, supportsDatabaseNameCompletion, supportsDatabaseSchemaQualifier, supportsQueryEditorBlockComments, supportsSqlInListPaste } from "@/lib/database/databaseFeatureSupport";
import { metadataSchemaForConnection, sqlSnippetDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { usesLocalOnlyEditorCompletionMetadata, usesOnDemandOnlyEditorColumnMetadata } from "@/lib/metadata/completionMetadataPolicy";
import { loadTableMetadata } from "@/lib/metadata/tableMetadataCache";
import { analyzeIntentionActions, prepareExpandWildcardContext, buildExpandWildcardReplacement, type IntentionAction } from "@/lib/editor/sqlIntentionActions";
import { loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import { loadObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import { queryContextObjectActions, queryContextObjectRoute, queryTableCandidateAtSqlPosition, queryTableNavigationTargetAtSqlPosition, resolveQueryContextCandidateDatabase, resolveQueryContextObjectTarget, type QueryContextObjectAction } from "@/lib/sql/queryCursorTableTarget";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { isMacOS } from "@/lib/backend/platform";
import {
  areSqlSemanticDiagnosticsEqual,
  buildSqlParserErrorDiagnostic,
  buildSqlSemanticDiagnostics,
  isSqlSemanticDiagnosticInputContext,
  isSqlVirtualTableReference,
  shouldRunSqlSemanticDiagnostics,
  sqlSemanticDiagnosticRangesForViewport,
  tableReferenceKey,
  type SqlSemanticDiagnostic,
} from "@/lib/sql/semantic/diagnostics";
import { resolveSqlDialectId, sqlReferenceAnalysisDialectFor } from "@/lib/sql/semantic/dialect";
import { buildRedisSyntaxDiagnostics, shouldRunRedisDiagnostics } from "@/lib/redis/redisSyntaxDiagnostics";
import { buildRedisCompletionItemsFromContext, getRedisCompletionContext, getRedisCompletionResultValidFor, shouldAutoOpenRedisCompletion, takesKeyArgument, type RedisCompletionItem } from "@/lib/redis/redisCompletion";
import type { SqlCompletionColumn, SqlCompletionContext, SqlCompletionForeignKey, SqlCompletionItem, SqlCompletionObject, SqlCompletionReferencedTable, SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import type { CompletionAssistantObjectKind, ColumnInfo, DatabaseType, IndexInfo, SqlReferenceAnalysis, SqlServerCompletionContext, SqlTableReference, SqlTextSpan } from "@/types/database";

const props = defineProps<{
  modelValue: string;
  connectionId?: string;
  catalog?: string;
  database?: string;
  schema?: string;
  clientSessionId?: string;
  completionContextVersion?: number;
  databaseType?: DatabaseType;
  dialect?: "mysql" | "postgres" | "sqlserver";
  syntaxDialect?: CodeMirrorSqlDialectName;
  formatDialect?: SqlFormatDialect;
  formatRequestId?: number;
  compressRequestId?: number;
  executionError?: string;
  executionErrorSql?: string;
  resultColumns?: string[];
  resultSourceStatement?: string;
  resultSourceFrom?: number;
  resultSourceTo?: number;
  readOnly?: boolean;
  autoFocus?: boolean;
  forceWordWrap?: boolean;
  hideExecutionControls?: boolean;
  initialViewport?: { scrollTop: number; scrollLeft: number };
  initialSelection?: { anchor: number; head: number };
  statementExecutionMarkers?: StatementExecutionMarker[];
}>();

function sqlBehaviorDialect(): "mysql" | "postgres" | "sqlserver" | undefined {
  return props.syntaxDialect === "clickhouse" ? props.dialect : (props.syntaxDialect ?? props.dialect);
}

function queryEditorSelectionLanguage(): "sql" | "text" {
  const databaseType = props.databaseType;
  return databaseType === "redis" || databaseType === "mongodb" || databaseType === "elasticsearch" || databaseType === "easysearch" || databaseType === "meilisearch" || databaseType === "victoriametrics" ? "text" : "sql";
}

const COMPLETION_REMOTE_LATENCY_BUDGET_MS = 120;
const COMPLETION_DEBOUNCE_DELAY_MS = 150;
const COMPLETION_TAB_RETRY_DELAY_MS = 16;
const COMPLETION_TAB_MAX_WAIT_MS = COMPLETION_DEBOUNCE_DELAY_MS + COMPLETION_REMOTE_LATENCY_BUDGET_MS + 100;
const COMPLETION_ENTER_MAX_WAIT_MS = 125;
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
  exportQuery: [payload: { sql: string; format: "csv" | "xlsx" | "txt"; columnComments?: (string | null)[] }];
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
const contextMenuOpen = ref(false);
let contextMenuPointerCleanup: (() => void) | null = null;
let viewportEmitFrame: number | null = null;
let viewportRestoreFrame: number | null = null;
let latestViewport: { scrollTop: number; scrollLeft: number } | undefined = props.initialViewport;
let lastEmittedViewport: { scrollTop: number; scrollLeft: number } | undefined = props.initialViewport;
const executionViewportOwnership = createQueryEditorExecutionViewportOwnership();
let latestSelection: { anchor: number; head: number } | undefined = props.initialSelection;
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();

function sqlStatementParameterOptions() {
  const toggles = resolveSqlVariableSyntaxToggles(settingsStore.editorSettings.sqlVariableSyntaxOverrides, props.databaseType, settingsStore.editorSettings.sqlVariableSubstitutionEnabled);
  return { databaseType: props.databaseType, enabledSyntaxes: enabledSqlParameterSyntaxes(toggles) };
}
const { isDark, themePalette, activeCustomUiColors } = useTheme();
const { t } = useI18n();
const { toast } = useToast();
const snippetDatabaseType = computed(() => {
  const connection = props.connectionId ? connectionStore.getConfig(props.connectionId) : undefined;
  return sqlSnippetDatabaseTypeForConnection(connection) ?? props.databaseType;
});
const sqlDriverProfile = computed(() => (props.connectionId ? connectionStore.getConfig(props.connectionId)?.driver_profile : undefined));

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
  "CURRENT_DATE",
  "CURRENT_TIME",
  "CURRENT_TIMESTAMP",
  "CURDATE",
  "CURTIME",
  "LOCALTIME",
  "LOCALTIMESTAMP",
  "UTC_DATE",
  "UTC_TIME",
  "UTC_TIMESTAMP",
  "SYSDATE",
  "DATE",
  "TIME",
  "TIMESTAMPDIFF",
  "YEAR",
  "MONTH",
  "DAY",
  "HOUR",
  "MINUTE",
  "SECOND",
  "DAYOFWEEK",
  "DAYOFYEAR",
  "LAST_DAY",
  "STR_TO_DATE",
  "IF",
  "LEFT",
  "RIGHT",
  "SUBSTRING_INDEX",
  "CHAR_LENGTH",
  "INSTR",
  "LOCATE",
  "LPAD",
  "RPAD",
  "FIND_IN_SET",
  "RAND",
  "MD5",
  "SHA1",
  "SHA2",
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
  tableAlias: t("editor.completion.tableAlias"),
  functionDescriptions: Object.fromEntries(SQL_FUNCTION_NAMES.map((name) => [name, t(`editor.completion.functionDescriptions.${name}`)])) as Record<string, string>,
}));
const MAX_COMPLETION_TABLES = 200;
const PRESTO_ON_DEMAND_TABLE_COMPLETION_MIN_PREFIX = 2;
const PRESTO_ON_DEMAND_TABLE_COMPLETION_LIMIT = 20;
const MAX_SEMANTIC_DIAGNOSTIC_COLUMN_TABLES = 4;
const liveFontSize = ref(settingsStore.editorSettings.fontSize);
const gestureStartFontSize = ref(settingsStore.editorSettings.fontSize);
const isGestureZooming = ref(false);

const searchPanelRef = ref<InstanceType<typeof EditorSearchPanel>>();
const selectedSql = ref("");
const executableSql = ref("");
const previewContextSql = ref("");
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
const codeSnapshotOpen = ref(false);
const codeSnapshotSource = ref<CodeSnapshotSource | null>(null);

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

// ==================== Intention Popup ====================

interface IntentionPopupState {
  visible: boolean;
  // 直接复用 IntentionAction 类型，避免手动重声明导致 replacements 等字段丢失（TS2551）
  actions: IntentionAction[];
  position: { x: number; y: number };
  selectedIndex: number;
}

const intentionPopup = ref<IntentionPopupState | null>(null);

function getIntentionActionLabel(kind: string): string {
  switch (kind) {
    case "expand_wildcard":
      return t("intentionExpandWildcard");
    case "qualify_identifier":
      return t("intentionQualifyIdentifier");
    case "unqualify_identifier":
      return t("intentionUnqualifyIdentifier");
    case "batch_qualify_identifiers":
      return t("intentionBatchQualifyIdentifiers");
    default:
      return kind;
  }
}

function closeIntentionPopup() {
  document.removeEventListener("keydown", onIntentionPopupKey);
  intentionPopup.value = null;
  focusEditor();
}

function onIntentionPopupKey(e: KeyboardEvent) {
  if (!intentionPopup.value?.visible) return;
  switch (e.key) {
    case "Escape":
      e.preventDefault();
      closeIntentionPopup();
      break;
    case "ArrowDown":
      e.preventDefault();
      intentionPopup.value.selectedIndex = Math.min(intentionPopup.value.selectedIndex + 1, intentionPopup.value.actions.length - 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      intentionPopup.value.selectedIndex = Math.max(intentionPopup.value.selectedIndex - 1, 0);
      break;
    case "Enter":
      e.preventDefault();
      executeIntentionAction(intentionPopup.value.actions[intentionPopup.value.selectedIndex]);
      break;
  }
}

function executeIntentionAction(action: IntentionPopupState["actions"][number]) {
  if (!intentionPopup.value) return;
  closeIntentionPopup();

  const currentView = view.value;
  if (!currentView) return;

  switch (action.kind) {
    case "expand_wildcard": {
      const sql = currentView.state.doc.toString();
      const cursor = currentView.state.selection.main.head;
      void (async () => {
        try {
          const ctx = prepareExpandWildcardContext(sql, cursor, props.databaseType, sqlBehaviorDialect());
          if (!ctx) return;

          const replacement = await buildExpandWildcardReplacement(props.databaseType, ctx.rowSources, async (source) => {
            const schema = source.metadataTarget?.schema;
            const tableName = source.metadataTarget?.table ?? source.name;
            if (!tableName) return [];
            const result = await loadTableMetadata({
              connectionId: props.connectionId ?? "",
              database: props.database ?? "",
              schema,
              tableName,
              databaseType: props.databaseType ?? "mysql",
              force: false,
            });
            return result.metadata.columns.map((c) => c.name);
          });
          const v = view.value;
          if (!v || v.state.doc.toString() !== sql) return;
          v.dispatch({ changes: { from: ctx.starSpan.start, to: ctx.starSpan.end, insert: replacement } });
        } catch {
          // metadata load failed
        }
      })();
      break;
    }
    case "qualify_identifier":
    case "unqualify_identifier":
      currentView.dispatch({
        changes: { from: action.span.start, to: action.span.end, insert: action.replacement },
      });
      break;

    case "batch_qualify_identifiers": {
      // 按从后往前的顺序逐一替换，避免 offset 漂移
      const reps = action.replacements ?? [];
      for (let i = reps.length - 1; i >= 0; i--) {
        const r = reps[i];
        currentView.dispatch({
          changes: { from: r.span.start, to: r.span.end, insert: r.replacement },
        });
      }
      break;
    }
  }
}

const executeContextMenuLabel = computed(() => t(hasSelectedSql.value ? "editor.contextMenu.executeSelection" : "editor.contextMenu.executeCurrent"));

interface EditorGestureEvent extends Event {
  scale?: number;
}

let editorViewModule: typeof import("@codemirror/view") | null = null;
let codeMirrorLineNumbers: typeof import("@codemirror/view").lineNumbers | null = null;
let codeMirrorPrec: typeof import("@codemirror/state").Prec | null = null;
let codeMirrorEditorSelection: typeof import("@codemirror/state").EditorSelection | null = null;
let hoverCloseEffect: StateEffect<unknown> | null = null;
let fontThemeComp: import("@codemirror/state").Compartment | null = null;
let codeMirrorTheme: import("@codemirror/state").Compartment | null = null;
let wordWrapComp: import("@codemirror/state").Compartment | null = null;
let lineNumbersComp: import("@codemirror/state").Compartment | null = null;
let vimModeComp: import("@codemirror/state").Compartment | null = null;
let closeBracketsComp: import("@codemirror/state").Compartment | null = null;
let sqlLanguageComp: import("@codemirror/state").Compartment | null = null;
let sqlSemanticHighlightComp: import("@codemirror/state").Compartment | null = null;
let sqlSignatureComp: import("@codemirror/state").Compartment | null = null;
let codeMirrorCloseBrackets: typeof import("@codemirror/autocomplete").closeBrackets | null = null;
let codeMirrorCloseBracketsKeymap: readonly import("@codemirror/view").KeyBinding[] | null = null;
let readOnlyComp: import("@codemirror/state").Compartment | null = null;
let runGutterComp: import("@codemirror/state").Compartment | null = null;
let runKeymapComp: import("@codemirror/state").Compartment | null = null;
let defaultKeymapComp: import("@codemirror/state").Compartment | null = null;
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
let codeMirrorCurrentCompletions: typeof import("@codemirror/autocomplete").currentCompletions | null = null;
let codeMirrorSelectedCompletionIndex: typeof import("@codemirror/autocomplete").selectedCompletionIndex | null = null;
let codeMirrorSelectedCompletion: typeof import("@codemirror/autocomplete").selectedCompletion | null = null;
let codeMirrorSetSelectedCompletion: typeof import("@codemirror/autocomplete").setSelectedCompletion | null = null;
let codeMirrorMoveCompletionSelection: typeof import("@codemirror/autocomplete").moveCompletionSelection | null = null;
let codeMirrorSelectFirstCompletion: import("@codemirror/view").Command | null = null;
let codeMirrorStartCompletion: typeof import("@codemirror/autocomplete").startCompletion | null = null;
let codeMirrorCloseCompletion: typeof import("@codemirror/autocomplete").closeCompletion | null = null;
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
let codeMirrorToggleBlockComment: typeof import("@codemirror/commands").toggleBlockComment | null = null;
let codeMirrorDefaultKeymap: readonly import("@codemirror/view").KeyBinding[] | null = null;
let codeMirrorToggleFold: typeof import("@codemirror/language").toggleFold | null = null;
let pendingCompletionTabTimer: ReturnType<typeof setTimeout> | null = null;
let cancelPendingCompletionEnter: (() => void) | null = null;
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
const postCompositionKeyGuard = createQueryEditorPostCompositionKeyGuard();
let postCompositionKeyGuardCleanup: (() => void) | null = null;

function runStatementGutterExtension(): import("@codemirror/state").Extension {
  const showRunButtons = !props.hideExecutionControls && settingsStore.editorSettings.showStatementRunButtons;
  return shouldShowStatementGutter(showRunButtons) ? (buildRunStatementGutterExtension?.() ?? []) : [];
}

let executableStatementRangeCache: ExecutableStatementRangeCache | null = null;
let editorScrollbarPointerCleanup: (() => void) | null = null;
let editorSelectionDragCleanup: (() => void) | null = null;
let editorSelectionDropCursorEl: HTMLDivElement | null = null;
const EDITOR_SCROLLBAR_POINTER_GUTTER_PX = 18;
const EDITOR_SELECTION_DRAG_THRESHOLD_PX = 6;
const tableNavigationHoverClass = "query-editor--table-navigation-hover";
const DBX_VIM_SAVE_EVENT = "dbx-vim-save";

function editorThemeAppearance() {
  return editorThemeAppearanceFor(isDark.value ? "dark" : "light", themePalette.value, themePalette.value === "custom" ? activeCustomUiColors.value : undefined);
}

// Completion cache
let cachedTables: SqlCompletionTable[] = [];
const cachedCompletionObjectsByScope = new Map<string, SqlCompletionObject[]>();
// Persistent column cache keyed by "schema.table" or "table"
const cachedColumnsByTable = new Map<string, SqlCompletionColumn[]>();
const cachedPrefixColumnsByTable = new Map<string, SqlCompletionColumn[]>();
const cachedInsertValueHintColumnsByTable = new Map<string, string[]>();
const cachedForeignKeysByTable = new Map<string, SqlCompletionForeignKey[]>();
const loadedColumnsByTable = new Set<string>();

// Hover tooltip shares the persisted object cache with the DDL and structure views.
let hoverSqlHighlighter: SqlHighlighter | null = null;

function sqlCompletionDialectOptions() {
  return {
    databaseType: props.databaseType,
    dialect: sqlBehaviorDialect(),
    editorState: view.value?.state,
  };
}

function usesOracleSessionCompletionColumns(schema?: string | null): boolean {
  return shouldUseOracleSessionCompletionColumns({
    databaseType: props.databaseType,
    selectedSchema: props.schema,
    referenceSchema: schema,
    clientSessionId: props.clientSessionId,
  });
}

function completionColumnRequestContext(reference?: Pick<SqlCompletionReferencedTable, "nameQuoted" | "schemaQuoted">) {
  return {
    clientSessionId: props.clientSessionId,
    version: props.completionContextVersion,
    tableQuoted: reference?.nameQuoted,
    schemaQuoted: reference?.schemaQuoted,
  };
}

async function listCompletionColumnsForEditor(connectionId: string, database: string, table: string, schema?: string, catalog = props.catalog, reference?: Pick<SqlCompletionReferencedTable, "nameQuoted" | "schemaQuoted">, prefix?: string) {
  const requestedVersion = props.completionContextVersion;
  const sessionScoped = usesOracleSessionCompletionColumns(schema);
  let columns: SqlCompletionColumn[];
  if (prefix && prefix.length >= 2 && (props.databaseType === "postgres" || props.databaseType === "mysql")) {
    try {
      columns = await connectionStore.listCompletionColumnsByPrefix(connectionId, database, table, schema, prefix, catalog, completionColumnRequestContext(reference));
    } catch {
      columns = await connectionStore.listCompletionColumns(connectionId, database, table, schema, completionColumnRequestContext(reference), catalog);
    }
  } else {
    columns = await connectionStore.listCompletionColumns(connectionId, database, table, schema, completionColumnRequestContext(reference), catalog);
  }
  if (sessionScoped && requestedVersion !== props.completionContextVersion) throw new Error("Stale Oracle completion context");
  return columns;
}

async function refreshCompletionColumnsForEditor(connectionId: string, database: string, table: string, schema?: string, catalog = props.catalog, reference?: Pick<SqlCompletionReferencedTable, "nameQuoted" | "schemaQuoted">) {
  const requestedVersion = props.completionContextVersion;
  const sessionScoped = usesOracleSessionCompletionColumns(schema);
  const columns = await connectionStore.refreshCompletionColumns(connectionId, database, table, schema, completionColumnRequestContext(reference), catalog);
  if (sessionScoped && requestedVersion !== props.completionContextVersion) throw new Error("Stale Oracle completion context");
  return columns;
}

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
  if (view.state.selection.ranges.some((range) => !range.empty)) return codeMirrorIndentMore?.(view) ?? false;
  if (tabKeyAcceptsCompletion()) {
    return acceptCompletionOrNextSnippetField(view) || performNormalTab(view);
  }
  return handleTabWithoutAcceptingCompletion(view) || performNormalTab(view);
}

// The Tab key is always wired up for indentation and snippet-field navigation,
// but it must only accept an open completion popup when the user's configured
// "accept completion" shortcut is actually Tab — otherwise a user who remapped
// that shortcut (e.g. to Enter) would find Tab silently accepting completions
// anyway, ignoring their setting (dbx#6236).
function tabKeyAcceptsCompletion(): boolean {
  const shortcuts = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);
  return shortcutToCodeMirrorKey(shortcuts.acceptCompletion) === "Tab";
}

function handleTabWithoutAcceptingCompletion(view: EditorViewType): boolean {
  if (codeMirrorCompletionStatus?.(view.state)) return false;
  return codeMirrorNextSnippetField?.(view) ?? false;
}

function performNormalTab(view: EditorViewType): boolean {
  const { state, dispatch } = view;
  if (state.selection.ranges.some((range) => !range.empty)) return codeMirrorIndentMore?.(view) ?? false;
  const sel = state.selection.main;
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
  ignoreSelection?: boolean;
  bypassPicker?: boolean;
  openInNewResultTab?: boolean;
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

/**
 * Captures a manual selection before a toolbar click can cause a platform
 * focus transition. The snapshot is immutable, so downstream execution keeps
 * the exact SQL and source offsets that were visible when the button was
 * pressed.
 */
function captureExecutionSnapshot(): SqlExecutionSnapshot | undefined {
  const currentView = view.value;
  if (!currentView || currentView.state.selection.main.empty) return undefined;
  return sqlExecutionSnapshotFromView(currentView);
}

function requestExecute(options: RequestExecuteOptions = {}) {
  executionViewportOwnership.cancelPendingRequest();
  const currentView = view.value;
  if (!currentView) return false;
  currentView.focus();
  return requestExecuteFromView(currentView, currentView.state.selection.main.head, options);
}

function requestExecuteInNewResultTab() {
  return requestExecute({ bypassPicker: true, openInNewResultTab: true });
}

function requestExecuteFromView(currentView: EditorViewType, cursorPos: number, options: RequestExecuteOptions = {}) {
  const selection = currentView.state.selection.main;
  if (!options.ignoreSelection && !selection.empty) {
    // Has manual selection → execute directly, skip picker.
    emitExecutionRequest(sqlExecutionSnapshotFromView(currentView), options.openInNewResultTab);
    return true;
  }
  if (!supportsExecutionTargetPicker(props.databaseType)) {
    emitExecutionRequest(sqlExecutionSnapshotFromView(currentView), options.openInNewResultTab);
    return true;
  }
  // No selection → resolve the execution target, optionally via the picker.
  const doc = currentView.state.doc.toString();
  const parameterOptions = sqlStatementParameterOptions();
  const candidates = buildExecutionCandidates(doc, cursorPos, props.databaseType, parameterOptions);
  const executeMode = settingsStore.editorSettings.executeMode;
  if (candidates.length === 0) {
    if (executeMode === "current") toast(t("editor.noExecutableStatementAtCursor"), 3000);
    return true;
  }
  const candidate = executionCandidateForMode(candidates, executeMode, {
    executeAllOnBlankLine: settingsStore.editorSettings.executeAllOnBlankLine,
  });
  if (!candidate) {
    toast(t("editor.noExecutableStatementAtCursor"), 3000);
    return true;
  }
  // The execution shortcut keeps executing the configured target (cursor/all) directly:
  // it stays keyboard-driven and never pops the picker, which is reserved for click entry points.
  if (options.bypassPicker || !settingsStore.editorSettings.showExecutionTargetPicker || !hasMultipleExecutionTargets(doc, props.databaseType, parameterOptions)) {
    emitExecutionRequest(sqlExecutionSnapshotForRange(currentView, candidate), options.openInNewResultTab);
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

function focusStatementRange(range: { from: number; to: number } | null) {
  const currentView = view.value;
  if (!range || !currentView || !editorViewModule || !setResultSourceRangeEffect) {
    setResultSourceRange(null);
    return;
  }
  const from = Math.max(0, Math.min(range.from, currentView.state.doc.length));
  const to = Math.max(from, Math.min(range.to, currentView.state.doc.length));
  if (from === to) return;
  currentView.dispatch({
    selection: { anchor: from, head: to },
    effects: [setResultSourceRangeEffect.of({ from, to }), editorViewModule.EditorView.scrollIntoView(from, { y: "center" })],
  });
  currentView.focus();
}

function onPickerActiveIndexChange(index: number) {
  pickerActiveIndex.value = index;
  const candidate = pickerCandidates.value[index];
  if (candidate) {
    setPreviewRange({ from: candidate.from, to: candidate.to });
  }
}

function onPickerConfirm(candidate: SqlExecutionCandidate) {
  const currentView = view.value;
  closePicker();
  emit("execute", currentView ? sqlExecutionSnapshotForRange(currentView, candidate) : candidate.sql);
}

function closePicker() {
  pickerVisible.value = false;
  pickerAnchor.value = undefined;
  setPreviewRange(null);
  // Restore focus to the CodeMirror editor.
  view.value?.focus();
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

function syncContextMenuState(currentView: EditorViewType, starPosition?: number, previewPosition?: number) {
  selectedSql.value = selectedSqlFromView(currentView);
  executableSql.value = executableSqlFromView(currentView);
  previewContextSql.value = resolvePreviewDmlCandidate(previewPosition);
  selectStarExpansionTarget.value = selectStarExpansionTargetForView(currentView, starPosition);
}

function selectStarExpansionTargetForView(currentView: EditorViewType, position?: number): SelectStarExpansionTarget | null {
  if (!props.connectionId || props.database == null || props.readOnly || !SEMANTIC_SQL_COMPLETION_ENABLED) return null;

  const sql = currentView.state.doc.toString();
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
  const legacyContext = getSqlCompletionContext(sql, cursor, sqlCompletionDialectOptions());
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
  // 预览按“右键点击处”解析当前语句（执行按光标处），右键处与光标一致时才直觉一致。
  syncContextMenuState(currentView, pos ?? undefined, pos ?? undefined);
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
  const tables = connectionStore.lookupLocalCompletionTables(candidate.connectionId, candidate.database, candidate.tableName, MAX_COMPLETION_TABLES, candidate.schema, props.catalog);
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
  if (!usesQueryEditorObjectNavigationModifier(event)) {
    clearTableNavigationHover();
    return false;
  }
  const identifier = tableNavigationIdentifierAt(currentView, event);
  editorRef.value?.classList.toggle(tableNavigationHoverClass, !!identifier);
  return !!identifier;
}

function clearTableNavigationHoverOnModifierRelease(event: KeyboardEvent) {
  if (!usesQueryEditorObjectNavigationModifier(event)) clearTableNavigationHover();
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
    if (isTauriRuntime() && isMacOS() && !currentView.contentDOM.contains(event.target as Node | null)) {
      event.preventDefault();
    }
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
  // Shift is CodeMirror's native extend-selection gesture. Keep it out of the
  // custom selection drag path so a shift-click inside the current selection
  // extends or shrinks the selection instead of collapsing it to the cursor.
  if (event.shiftKey) return false;

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
  const doc = currentView.state.doc.toString();
  const cursorPos = position ?? selection.head;
  const parameterOptions = sqlStatementParameterOptions();
  const candidates = buildExecutionCandidates(doc, cursorPos, props.databaseType, parameterOptions);
  const cursorCandidate = candidates.find((item) => item.supportedKinds.includes("cursor"));
  return cursorCandidate && looksLikeDmlStatement(cursorCandidate.sql) ? cursorCandidate.sql : "";
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

async function cutSelectedSqlFromContextMenu() {
  if (!canCopySelectedSql.value) return;
  const currentView = view.value;
  if (!currentView) return;
  try {
    await copyToClipboard(selectedSql.value);
    // 剪切：复制后删除选中内容
    const selection = currentView.state.selection.main;
    if (!selection.empty) {
      currentView.dispatch({
        changes: { from: selection.from, to: selection.to },
        selection: { anchor: selection.from, head: selection.from },
        scrollIntoView: true,
        userEvent: "input.cut",
      });
    }
    toast(t("grid.cut"));
    focusEditor();
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function pasteClipboardSqlFromContextMenu() {
  if (props.readOnly) return;
  const currentView = view.value;
  if (!currentView) return;
  try {
    const text = await readTextFromClipboard();
    if (!text) return;
    const selection = currentView.state.selection.main;
    // 粘贴：替换选中内容或在光标处插入
    currentView.dispatch({
      changes: { from: selection.from, to: selection.to, insert: text },
      selection: { anchor: selection.from + text.length, head: selection.from + text.length },
      scrollIntoView: true,
      userEvent: "input.paste",
    });
    focusEditor();
  } catch (e: any) {
    toast(t("editor.contextMenu.pasteClipboardReadFailed", { message: e?.message || String(e) }), 5000);
  }
}

function toggleCommentFromContextMenu() {
  const currentView = view.value;
  if (!currentView || props.readOnly) return;
  codeMirrorToggleLineComment?.(currentView);
  focusEditor();
}

function toggleBlockCommentFromContextMenu() {
  const currentView = view.value;
  if (!currentView || props.readOnly || !supportsQueryEditorBlockComments(props.databaseType)) return;
  codeMirrorToggleBlockComment?.(currentView);
  focusEditor();
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

function convertSelectedSqlCase(mode: SqlSelectionCaseMode): boolean {
  const currentView = view.value;
  const EditorSelection = codeMirrorEditorSelection;
  if (!currentView || !EditorSelection) return false;

  const state = currentView.state;
  const documentText = state.doc.toString();
  const transaction = state.changeByRange((range) => {
    if (range.empty) return { range };

    const convertedText = convertSqlSelectionCase(documentText, { from: range.from, to: range.to }, mode, sqlBehaviorDialect());
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

function convertSelectedNamingStyle(): boolean {
  const currentView = view.value;
  const EditorSelection = codeMirrorEditorSelection;
  if (!currentView || !EditorSelection) return false;

  const state = currentView.state;
  const transaction = state.changeByRange((range) => {
    if (range.empty) return { range };

    const selectedText = state.doc.sliceString(range.from, range.to);
    const result = convertToNextNamingStyle(selectedText);
    return {
      changes: { from: range.from, to: range.to, insert: result.text },
      range: EditorSelection.range(range.from, range.from + result.text.length),
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

  const result = buildSqlInConditionFromPasteSource(source, settingsStore.editorSettings.sqlFormatter.keywordCase);
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

// See queryEditorPasteCaretResync.ts for why this nudge is needed (WebKit-only caret bug).
function resyncCaretAfterPaste(view: EditorViewType) {
  const EditorSelection = codeMirrorEditorSelection;
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
  // when the main editor execute action would run the full document.
  const editorViewportRequestId = executionViewportOwnership.beginRequest();
  emitExecutionRequest({ ...sqlExecutionSnapshotForRange(currentView, statementRange), editorViewportRequestId });
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

const contextMenuItems = computed<ContextMenuItem[]>(() => {
  const shortcuts = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);
  // The menu closes before running its action, so retain this right-click's
  // resolved target instead of reading state after the close handler runs.
  const starExpansionTarget = selectStarExpansionTarget.value;
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
          {
            label: t("settings.shortcutExecuteSqlInNewResultTab"),
            action: executeInNewResultTabFromContextMenu,
            disabled: !canExecuteContextSql.value,
            icon: Play,
            shortcut: shortcuts.executeSqlInNewResultTab,
          },
          {
            label: t("editor.previewChanges"),
            action: () => void requestPreviewChanges(previewContextSql.value),
            disabled: !previewContextSql.value,
            icon: Eye,
          },
          {
            label: t("editor.contextMenu.export"),
            icon: Download,
            disabled: !canExecuteContextSql.value,
            children: [
              { label: t("editor.contextMenu.exportQueryResultTo", { format: "CSV" }), action: () => exportQueryFromContextMenu("csv") },
              { label: t("editor.contextMenu.exportQueryResultTo", { format: "XLSX" }), action: () => exportQueryFromContextMenu("xlsx") },
              { label: t("editor.contextMenu.exportQueryResultTo", { format: "TXT" }), action: () => exportQueryFromContextMenu("txt") },
            ],
          },
        ]),
    ...queryContextObjectActions(contextObjectTarget.value?.type).map(contextObjectMenuItem),
    {
      label: t("editor.contextMenu.expandSelectStar"),
      action: () => void expandSelectStar(starExpansionTarget),
      disabled: !starExpansionTarget,
      icon: Table2,
      shortcut: shortcuts.expandSelectStar,
    },
    { label: "", separator: true },
    {
      label: t("editor.contextMenu.commentSelection"),
      action: toggleCommentFromContextMenu,
      disabled: props.readOnly || !canCopySelectedSql.value,
      icon: MessageSquareText,
      shortcut: shortcuts.toggleLineComment,
    },
    {
      label: t("editor.contextMenu.blockCommentSelection"),
      action: toggleBlockCommentFromContextMenu,
      disabled: props.readOnly || !canCopySelectedSql.value || !supportsQueryEditorBlockComments(props.databaseType),
      icon: MessageSquareText,
      shortcut: shortcuts.toggleBlockComment,
    },
    {
      label: t("editor.contextMenu.formatSelectionSql"),
      action: () => void formatCurrentSql(),
      disabled: props.readOnly || !canCopySelectedSql.value || !canFormatSqlForDatabaseType(props.databaseType),
      icon: AlignLeft,
      shortcut: shortcuts.formatSql,
    },
    {
      label: t("editor.contextMenu.compressSelectionSql"),
      action: compressCurrentSql,
      disabled: props.readOnly || !canCopySelectedSql.value,
      icon: Minimize2,
    },
    {
      label: t("editor.contextMenu.copySelection"),
      action: copySelectedSqlFromContextMenu,
      disabled: !canCopySelectedSql.value,
      icon: Copy,
      shortcut: "Mod+C",
    },
    {
      label: t("editor.contextMenu.screenshotSelection"),
      action: () => {
        if (selectedSql.value.trim()) {
          codeSnapshotSource.value = { code: selectedSql.value, lang: "sql" };
          codeSnapshotOpen.value = true;
        }
      },
      disabled: !canCopySelectedSql.value,
      icon: Camera,
    },
    {
      label: t("editor.contextMenu.cutSelection"),
      action: cutSelectedSqlFromContextMenu,
      disabled: !canCopySelectedSql.value || props.readOnly,
      icon: Scissors,
      shortcut: "Mod+X",
    },
    {
      label: t("editor.contextMenu.pasteFromClipboard"),
      action: pasteClipboardSqlFromContextMenu,
      disabled: props.readOnly,
      icon: ClipboardPaste,
      shortcut: "Mod+V",
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
      label: t("editor.contextMenu.convertNamingStyle"),
      action: convertSelectedNamingStyle,
      disabled: !canCopySelectedSql.value,
      icon: CaseSensitive,
      shortcut: shortcuts.convertNamingStyle,
    },
    {
      label: t("editor.contextMenu.delimitedList"),
      action: openDelimitedListDialog,
      disabled: props.readOnly || !canCopySelectedSql.value,
      icon: List,
    },
    {
      label: t("editor.contextMenu.addNextSelectionOccurrence"),
      action: addNextSelectionOccurrenceFromContextMenu,
      icon: TextSelect,
      shortcut: shortcuts.addNextSelectionOccurrence,
    },
    {
      label: t("editor.contextMenu.selectAllSelectionOccurrences"),
      action: selectAllSelectionOccurrencesFromContextMenu,
      icon: TextSelect,
      shortcut: shortcuts.selectAllSelectionOccurrences,
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

function currentContextMenuItems(): ContextMenuItem[] {
  return contextMenuItems.value;
}

function handleSqlIntentionActions(currentView: EditorViewType): boolean {
  if (props.readOnly) return false;
  try {
    const sql = currentView.state.doc.toString();
    const sel = currentView.state.selection.main;

    const actions = analyzeIntentionActions({
      sql,
      cursor: sel.head,
      databaseType: props.databaseType,
      dialect: sqlBehaviorDialect(),
      selection: sel.from !== sel.to ? { from: sel.from, to: sel.to } : undefined,
    });

    if (actions.length === 0) return false;

    // 计算光标视口坐标，用于定位弹出菜单
    const coords = currentView.coordsAtPos(sel.head);
    if (!coords) return false;

    // 显示弹出菜单（参考 DataGrip Alt+Enter 意图操作弹出菜单）
    intentionPopup.value = {
      visible: true,
      actions,
      position: { x: coords.right + 8, y: coords.bottom + 4 },
      selectedIndex: 0,
    };
    document.addEventListener("keydown", onIntentionPopupKey);
    return true;
  } catch (err) {
    console.error("[SQL Intention] error:", err);
    return false;
  }
}

function runSqlShortcutAction(action: ReturnType<typeof enabledSqlShortcutActions>[number], currentView: EditorViewType, event?: KeyboardEvent): boolean {
  if (shouldBlockExecutionShortcut(event, currentView)) return true;
  if (props.readOnly) return true;
  const { from, to, empty } = currentView.state.selection.main;
  if (empty) return false;
  const selected = currentView.state.sliceDoc(from, to).trim();
  if (!selected) return false;
  const sql = resolveSqlShortcutTemplate(action.sql, selected);
  emitExecutionRequest(sql);
  return true;
}

function runKeymapExtension(codeMirrorKeymap: (typeof import("@codemirror/view"))["keymap"]) {
  const shortcuts = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);
  const Prec = codeMirrorPrec;
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
  const replaceShortcutBindings = createQueryEditorReplaceShortcutBindings(shortcuts.replace, openReplace);
  const replaceShortcutHandler = createQueryEditorReplaceShortcutHandler({
    shortcut: shortcuts.replace,
    openReplace,
    isReadOnly: () => !!props.readOnly,
  });
  const sqlShortcutActions = enabledSqlShortcutActions(settingsStore.editorSettings.sqlShortcuts);
  const sqlShortcutKeymapActions = sqlShortcutActions.filter((action) => !isCharacterProducingShortcut(action.shortcut));
  const sqlShortcutBindings = sqlShortcutKeymapActions.flatMap((action) => binding(action.shortcut, (currentView) => runSqlShortcutAction(action, currentView)));
  const sqlShortcutDomHandler = createQueryEditorSqlShortcutDomHandler(
    () => settingsStore.editorSettings.sqlShortcuts,
    (action, currentView, event) => runSqlShortcutAction(action, currentView, event),
  );
  const combinedDomKeydownHandler = (event: KeyboardEvent, view: EditorViewType) => {
    if (replaceShortcutHandler(event)) return true;
    return sqlShortcutDomHandler(event, view);
  };
  const moveCompletion = (view: EditorViewType, forward: boolean, by?: "page") => codeMirrorMoveCompletionSelection?.(forward, by)?.(view) ?? false;
  return [
    editorViewModule
      ? (Prec?.high(
          editorViewModule.EditorView.domEventHandlers({
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
        ...replaceShortcutBindings,
        ...executeInNewResultTabBindings,
        ...executeBindings,
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
        ...binding(shortcuts.indentMore, (view) => codeMirrorIndentMore?.(view) ?? false),
        ...binding(shortcuts.indentLess, (view) => codeMirrorIndentLess?.(view) ?? false),
        ...binding(shortcuts.insertLineBelow, insertLineBelow),
        ...binding(shortcuts.joinLines, joinQueryEditorLines),
        ...binding(shortcuts.duplicateLine, (view) => codeMirrorCopyLineDown?.(view) ?? false),
        ...binding(shortcuts.deleteLine, (view) => codeMirrorDeleteLine?.(view) ?? false),
        ...binding(shortcuts.moveLineUp, (view) => codeMirrorMoveLineUp?.(view) ?? false),
        ...binding(shortcuts.moveLineDown, (view) => codeMirrorMoveLineDown?.(view) ?? false),
        ...binding(shortcuts.copyLineUp, (view) => codeMirrorCopyLineUp?.(view) ?? false),
        ...binding(shortcuts.copyLineDown, (view) => codeMirrorCopyLineDown?.(view) ?? false),
        ...binding(shortcuts.undo, (view) => codeMirrorUndo?.(view) ?? false),
        ...binding(shortcuts.redo, (view) => codeMirrorRedo?.(view) ?? false),
        ...binding(shortcuts.selectAll, (view) => codeMirrorSelectAll?.(view) ?? false),
        ...binding(shortcuts.extendSelection, extendQueryEditorSelectionForView),
        ...binding(shortcuts.addNextSelectionOccurrence, addNextQueryEditorSelectionOccurrence),
        ...binding(shortcuts.selectAllSelectionOccurrences, selectAllQueryEditorSelectionOccurrences),
        ...createQueryEditorSelectionCaseShortcutBindings(shortcuts.uppercaseSelection, () => convertSelectedSqlCase("upper")),
        ...createQueryEditorSelectionCaseShortcutBindings(shortcuts.lowercaseSelection, () => convertSelectedSqlCase("lower")),
        ...createQueryEditorSelectionCaseShortcutBindings(shortcuts.convertNamingStyle, () => convertSelectedNamingStyle()),
        ...binding(shortcuts.toggleLineComment, (view) => codeMirrorToggleLineComment?.(view) ?? false),
        ...binding(shortcuts.toggleBlockComment, (view) => {
          if (!supportsQueryEditorBlockComments(props.databaseType)) return false;
          return codeMirrorToggleBlockComment?.(view) ?? false;
        }),
        ...binding(shortcuts.toggleFold, (view) => codeMirrorToggleFold?.(view) ?? false),
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

function handleEnter(view: EditorViewType): boolean {
  // While an IME composition is active, Enter confirms the composition (the
  // candidate list); intercepting it here would accept a completion popup on
  // top of the composition instead of committing the typed text (issue #8029).
  if (isEditorComposing(view)) return false;
  clearPendingCompletionEnter();
  if (isBatchColumnSelectionCompletionActive(codeMirrorCompletionStatus?.(view.state) ?? null) && applySelectedBatchColumnSelection(view)) return true;
  // CodeMirror's default completion keymap is disabled so batch selection can
  // take precedence. Preserve its normal single-item acceptance here.
  if (codeMirrorAcceptCompletion?.(view)) return true;
  if (settingsStore.editorSettings.selectFirstCompletionOnOpen && codeMirrorCompletionStatus) {
    let cancelRetry: (() => void) | null = null;
    const result = acceptSelectedCompletionWithRetry(view, {
      completionStatus: codeMirrorCompletionStatus,
      acceptCompletion: codeMirrorAcceptCompletion,
      selectedCompletionIndex: codeMirrorSelectedCompletionIndex,
      selectFirstCompletion: codeMirrorSelectFirstCompletion,
      retryDelayMs: COMPLETION_TAB_RETRY_DELAY_MS,
      maxWaitMs: COMPLETION_ENTER_MAX_WAIT_MS,
      isComposing: () => isEditorComposing(view),
      onUnavailable: () => insertNewlineWithoutCompletion(view),
      onSettled: () => {
        if (cancelPendingCompletionEnter === cancelRetry) cancelPendingCompletionEnter = null;
      },
    });
    if (result.handled) {
      cancelRetry = result.cancel ?? null;
      cancelPendingCompletionEnter = cancelRetry;
      return true;
    }
  }
  return insertNewlineWithoutCompletion(view);
}

function clearPendingCompletionEnter() {
  cancelPendingCompletionEnter?.();
  cancelPendingCompletionEnter = null;
}

function insertNewlineWithoutCompletion(view: EditorViewType): boolean {
  codeMirrorCloseCompletion?.(view);
  suppressNextSqlCompletionAutoStartUntil = Date.now() + 750;
  const handled = insertQueryEditorNewline(view, codeMirrorInsertNewlineKeepIndent, props.databaseType);
  if (!handled) suppressNextSqlCompletionAutoStartUntil = 0;
  return handled;
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

function acceptCompletionOrNextSnippetField(view: EditorViewType): boolean {
  // Any non-empty selection range means Tab is being used for block indent,
  // not word completion. A completion popup can still appear as a side effect
  // of the indent edit itself, so it must never hijack this or a following Tab.
  if (isEditorComposing(view)) return false;
  if (view.state.selection.ranges.every((range) => range.empty)) {
    const completionStatus = codeMirrorCompletionStatus?.(view.state) ?? null;
    if (isBatchColumnSelectionCompletionActive(completionStatus) && applySelectedBatchColumnSelection(view)) return true;
    if (completionStatus === "active" && acceptSelectedOrFirstCompletion(view, codeMirrorAcceptCompletion, codeMirrorSelectedCompletionIndex, codeMirrorSelectFirstCompletion)) return true;
    if (completionStatus) return waitForCompletionTab(view);
  }
  return codeMirrorNextSnippetField?.(view) ?? false;
}

function clearPendingCompletionTab() {
  if (pendingCompletionTabTimer === null) return;
  clearTimeout(pendingCompletionTabTimer);
  pendingCompletionTabTimer = null;
}

function waitForCompletionTab(view: EditorViewType): boolean {
  clearPendingCompletionTab();
  const initialDoc = view.state.doc;
  const initialSelectionRanges = view.state.selection.ranges.map((range) => ({ anchor: range.anchor, head: range.head }));
  const startedAt = Date.now();

  const retry = () => {
    pendingCompletionTabTimer = null;
    // The user started an IME composition while waiting for the pending
    // completion; Tab now belongs to the candidate list, so drop the queued
    // acceptance (and the normal-Tab fallback) instead of fighting the IME.
    if (isEditorComposing(view)) return;
    const selectionRanges = view.state.selection.ranges;
    if (view.state.doc !== initialDoc || selectionRanges.length !== initialSelectionRanges.length || selectionRanges.some((range, index) => !range.empty || range.anchor !== initialSelectionRanges[index]?.anchor || range.head !== initialSelectionRanges[index]?.head)) return;

    const completionStatus = codeMirrorCompletionStatus?.(view.state) ?? null;
    if (completionStatus === "active" && acceptSelectedOrFirstCompletion(view, codeMirrorAcceptCompletion, codeMirrorSelectedCompletionIndex, codeMirrorSelectFirstCompletion)) return;
    if (completionStatus && Date.now() - startedAt < COMPLETION_TAB_MAX_WAIT_MS) {
      pendingCompletionTabTimer = setTimeout(retry, COMPLETION_TAB_RETRY_DELAY_MS);
      return;
    }

    // A pending completion may resolve without any applicable option. Preserve
    // snippet navigation first, then fall back to the editor's normal Tab action.
    if (codeMirrorNextSnippetField?.(view)) return;
    performNormalTab(view);
  };

  pendingCompletionTabTimer = setTimeout(retry, COMPLETION_TAB_RETRY_DELAY_MS);
  return true;
}

function wordWrapExtension() {
  if (!editorViewModule) return [];
  return props.forceWordWrap || settingsStore.editorSettings.wordWrap ? editorViewModule.EditorView.lineWrapping : [];
}

function lineNumbersExtension(enabled = settingsStore.editorSettings.showLineNumbers) {
  return buildQueryEditorLineNumbersExtension(codeMirrorLineNumbers, enabled, {
    domEventHandlers: {
      mousedown: selectSqlLineFromGutter,
    },
  });
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

function sqlExecutionSnapshotForRange(currentView: EditorViewType, range: Pick<SqlExecutionCandidate, "sql" | "from" | "to">): SqlExecutionSnapshot {
  return {
    fullSql: currentView.state.doc.toString(),
    selectedSql: range.sql,
    cursorPos: currentView.state.selection.main.head,
    selectionFrom: range.from,
    selectionTo: range.to,
  };
}

/**
 * Locate the qualified identifier at `pos`, delegating to the same quote-aware
 * parser used by Ctrl+click navigation. A plain word-character scan (the
 * previous approach here) breaks on quoted identifiers containing characters
 * outside `[\w$]` (hyphens, spaces, ...), e.g. `schema."my-table"`.
 *
 * Every part is re-quoted in the returned text (regardless of whether it was
 * originally quoted) so downstream re-parsing via `splitQualifiedIdentifier`
 * round-trips correctly even when a part's raw value isn't a bare word.
 */
function identifierRangeAt(sql: string, pos: number): { from: number; to: number; text: string } | null {
  const located = extractQualifiedIdentifierAt(sql, pos);
  if (!located) return null;
  if (located.parts.length === 1 && !located.parts[0].quoted && isSqlKeyword(located.parts[0].value)) return null;
  const text = located.parts.map((part) => quoteIdentifier(part.value)).join(".");
  if (!text) return null;
  return { from: located.start, to: located.end, text };
}

type CompletionMetadataScope = Pick<SqlCompletionScope, "database" | "schema">;

function completionCacheKey(table: { name: string; catalog?: string | null; database?: string | null; schema?: string | null; nameQuoted?: boolean; schemaQuoted?: boolean }, scope?: CompletionMetadataScope) {
  const schema = table.schema ?? scope?.schema ?? props.schema;
  const scopedDatabase = scope && scope.database !== props.database ? scope.database : undefined;
  const database = supportsDatabaseSchemaQualifierCompletion() ? (table.database ?? scopedDatabase) : undefined;
  const baseKey = schema ? `${database ? `${database}.` : ""}${schema}.${table.name}` : table.name;
  if (props.databaseType !== "postgres" || (!table.nameQuoted && !table.schemaQuoted)) return baseKey;
  return `${baseKey}:quoted:s=${table.schemaQuoted ? "1" : "0"}:t=${table.nameQuoted ? "1" : "0"}`;
}

function completionPrefixCacheKey(table: { name: string; catalog?: string | null; database?: string | null; schema?: string | null; nameQuoted?: boolean; schemaQuoted?: boolean }, scope: CompletionMetadataScope | undefined, prefix: string) {
  return `${completionCacheKey(table, scope)}:prefix:${prefix.trim().toLowerCase()}`;
}

function lookupCachedPrefixColumns(table: { name: string; catalog?: string | null; database?: string | null; schema?: string | null; nameQuoted?: boolean; schemaQuoted?: boolean }, scope: CompletionMetadataScope | undefined, prefix: string): SqlCompletionColumn[] | undefined {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const exactKey = completionPrefixCacheKey(table, scope, normalizedPrefix);
  const exact = cachedPrefixColumnsByTable.get(exactKey);
  if (exact) return exact;

  const marker = `${completionCacheKey(table, scope)}:prefix:`;
  let best: { prefix: string; columns: SqlCompletionColumn[] } | undefined;
  for (const [key, columns] of cachedPrefixColumnsByTable) {
    if (!key.startsWith(marker)) continue;
    const cachedPrefix = key.slice(marker.length);
    if (!normalizedPrefix.startsWith(cachedPrefix) || (best && cachedPrefix.length <= best.prefix.length)) continue;
    best = { prefix: cachedPrefix, columns };
  }
  if (!best) return undefined;
  return best.columns.filter((column) => column.name.toLowerCase().startsWith(normalizedPrefix));
}

const pendingInsertValueHintColumnLoads = new Set<string>();

function insertHintCacheKey(table: { name: string; schema?: string | null; database?: string | null }) {
  if (table.database) {
    return table.schema ? `${table.database}.${table.schema}.${table.name}` : `${table.database}.${table.name}`;
  }
  return completionCacheKey(table);
}

function insertHintMetadataTarget(table: { name: string; schema?: string | null; database?: string | null }): { database: string; schema?: string; catalog?: string } | null {
  if (props.database == null) return null;
  if (table.database) {
    return { database: table.database, schema: table.schema ?? undefined, catalog: props.catalog };
  }
  return completionMetadataTarget(table);
}

function getInsertValueHintTableColumns(table: string, schema?: string, database?: string): string[] | undefined {
  const cacheKey = insertHintCacheKey({ name: table, schema, database });
  if (props.databaseType === "sqlserver") return cachedInsertValueHintColumnsByTable.get(cacheKey);
  const cached = cachedColumnsByTable.get(cacheKey);
  if (!cached) return undefined;
  return cached.map((column) => column.name);
}

function requestInsertValueHintTableColumns(table: string, schema?: string, database?: string) {
  if (!props.connectionId || props.database == null) return;
  if (!supportsInsertValueHints(props.databaseType)) return;
  const cacheKey = insertHintCacheKey({ name: table, schema, database });
  const hasCachedColumns = props.databaseType === "sqlserver" ? cachedInsertValueHintColumnsByTable.has(cacheKey) : cachedColumnsByTable.has(cacheKey);
  if (hasCachedColumns || pendingInsertValueHintColumnLoads.has(cacheKey)) return;
  const target = insertHintMetadataTarget({ name: table, schema, database });
  if (!target) return;
  pendingInsertValueHintColumnLoads.add(cacheKey);
  const connectionId = props.connectionId;
  const databaseType = props.databaseType;
  const loadColumns = async () => {
    if (databaseType === "sqlserver") {
      const querySchema = metadataSchemaForConnection(connectionStore.getConfig(connectionId), target.database, target.schema);
      const columns = await api.getSqlServerColumnMetadata(connectionId, target.database, querySchema, table);
      cachedInsertValueHintColumnsByTable.set(cacheKey, insertValueHintColumnNames(databaseType, columns));
      return;
    }
    const columns = await listCompletionColumnsForEditor(connectionId, target.database, table, target.schema, target.catalog);
    cachedColumnsByTable.set(cacheKey, columns);
  };
  void loadColumns()
    .then(() => {
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

function supportsDatabaseSchemaQualifierCompletion(): boolean {
  return supportsDatabaseSchemaQualifier(props.databaseType);
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

function completionMetadataTarget(table: { name: string; catalog?: string | null; database?: string | null; schema?: string | null }, scope?: CompletionMetadataScope): { database: string; schema?: string; catalog?: string } | null {
  const currentDatabase = scope?.database ?? props.database;
  if (currentDatabase == null) return null;
  // SQL Server metadata queries require a schema even when the SQL uses an
  // unqualified table name. The query editor commonly has no schema selected
  // when the user is working from a database-level tab, so use the same
  // default as the table/DDL metadata paths instead of returning no columns.
  const selectedSchema = table.schema ?? scope?.schema ?? props.schema;
  const effectiveSchema = selectedSchema ?? (props.databaseType === "sqlserver" ? metadataSchemaForConnection(connectionStore.getConfig(props.connectionId ?? ""), currentDatabase, undefined) : undefined);
  if (supportsDatabaseSchemaQualifierCompletion() && table.database) {
    return { database: table.database, schema: effectiveSchema, catalog: table.catalog ?? props.catalog };
  }
  if (supportsDatabaseQualifierCompletion() && effectiveSchema) {
    return { database: effectiveSchema, catalog: table.catalog ?? props.catalog };
  }
  return { database: currentDatabase, schema: effectiveSchema, catalog: table.catalog ?? props.catalog };
}

function isVirtualCompletionTableReference(table: { name: string; database?: string | null; schema?: string | null }): boolean {
  return isSqlVirtualTableReference(table, props.databaseType);
}

function completionQualifiedTableTarget(completionContext: ReturnType<typeof getSqlCompletionContext>): { name: string; database?: string; schema: string } | null {
  if (!completionContext.suggestColumns) return null;
  const parts = completionContext.qualifierParts ?? completionContext.qualifier?.split(".").filter(Boolean) ?? [];
  if (parts.length < 2) return null;
  const name = parts[parts.length - 1];
  const schema = parts[parts.length - 2];
  if (!name || !schema) return null;
  const database = supportsDatabaseSchemaQualifierCompletion() && parts.length >= 3 ? parts[parts.length - 3] : undefined;
  return { name, database, schema };
}

function completionTablesMatch(left: { name: string; catalog?: string | null; database?: string | null; schema?: string | null }, right: { name: string; catalog?: string | null; database?: string | null; schema?: string | null }) {
  if (left.name.toLowerCase() !== right.name.toLowerCase()) return false;
  if (left.catalog && right.catalog && left.catalog.toLowerCase() !== right.catalog.toLowerCase()) return false;
  if (left.database && right.database && left.database.toLowerCase() !== right.database.toLowerCase()) return false;
  if (!left.schema || !right.schema) return true;
  return left.schema.toLowerCase() === right.schema.toLowerCase();
}

async function findExactSemanticDiagnosticTable(table: SqlTableReference, scope?: CompletionMetadataScope): Promise<SqlCompletionTable | null> {
  if (!props.connectionId || props.database == null) return null;
  const target = completionMetadataTarget(table, scope);
  if (!target) return null;
  const localMatches = connectionStore.lookupLocalCompletionTables(props.connectionId, target.database, table.name, MAX_COMPLETION_TABLES, target.schema, target.catalog);
  const localExact = localMatches.find((item) => completionTablesMatch(item, table));
  if (localExact) {
    cachedTables = mergeCompletionTables(cachedTables, [localExact]);
    return localExact;
  }

  const remoteMatches = await connectionStore.listCompletionTables(props.connectionId, target.database, table.name, MAX_COMPLETION_TABLES, target.schema, false, scope?.schema ?? props.schema, target.catalog);
  cachedTables = mergeCompletionTables(cachedTables, remoteMatches);
  return remoteMatches.find((item) => completionTablesMatch(item, table)) ?? null;
}

async function ensureColumnsForTable(table: { name: string; database?: string | null; schema?: string | null }, reference?: Pick<SqlCompletionReferencedTable, "nameQuoted" | "schemaQuoted">, scope?: CompletionMetadataScope): Promise<boolean> {
  if (isVirtualCompletionTableReference(table)) return false;
  const cacheKey = completionCacheKey(table, scope);
  if (cachedColumnsByTable.has(cacheKey)) return true;
  if (!props.connectionId || props.database == null) return false;
  const target = completionMetadataTarget(table, scope);
  if (!target) return false;
  const localColumns = connectionStore.lookupLocalCompletionColumns(props.connectionId, target.database, table.name, target.schema, target.catalog, completionColumnRequestContext(reference));
  if (localColumns.length > 0) {
    cachedColumnsByTable.set(cacheKey, localColumns);
    loadedColumnsByTable.add(cacheKey.toLowerCase());
    return true;
  }
  let columns = await listCompletionColumnsForEditor(props.connectionId, target.database, table.name, target.schema, target.catalog, reference);

  // A schema-aware connection can legitimately return an empty result when
  // the editor has no selected schema. Resolve the physical table from the
  // local/remote table cache and retry with its schema before reporting that
  // star expansion is unavailable. This is especially important for aliased
  // sources because the alias itself must never be sent as the table name.
  if (columns.length === 0 && !table.schema && !target.schema && !supportsDatabaseQualifierCompletion()) {
    const schemaCandidates: string[] = [];
    const seenSchemas = new Set<string>();
    const addSchema = (schema?: string | null) => {
      const normalized = schema?.trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seenSchemas.has(key)) return;
      seenSchemas.add(key);
      schemaCandidates.push(normalized);
    };

    if (props.databaseType === "sqlserver") {
      addSchema(metadataSchemaForConnection(connectionStore.getConfig(props.connectionId), target.database, undefined));
    }

    const localTables = connectionStore.lookupLocalCompletionTables(props.connectionId, target.database, table.name, MAX_COMPLETION_TABLES, undefined, target.catalog);
    localTables.forEach((candidate) => {
      if (candidate.name.toLowerCase() === table.name.toLowerCase()) addSchema(candidate.schema);
    });
    if (schemaCandidates.length === 0 && !usesLocalOnlyCompletionMetadata()) {
      const remoteTables = await connectionStore.listCompletionTables(props.connectionId, target.database, table.name, MAX_COMPLETION_TABLES, undefined, false, undefined, target.catalog);
      remoteTables.forEach((candidate) => {
        if (candidate.name.toLowerCase() === table.name.toLowerCase()) addSchema(candidate.schema);
      });
    }

    for (const schema of schemaCandidates) {
      const schemaTarget = completionMetadataTarget({ ...table, schema }, scope);
      if (!schemaTarget) continue;
      const retryColumns = await listCompletionColumnsForEditor(props.connectionId, schemaTarget.database, table.name, schemaTarget.schema, schemaTarget.catalog, reference);
      if (retryColumns.length > 0) {
        columns = retryColumns;
        break;
      }
    }
  }
  // Do not memoize an empty response as a successful load. Empty results are
  // commonly caused by a temporarily unresolved schema; keeping that value
  // would prevent the next expansion attempt from retrying after metadata has
  // become available.
  if (columns.length > 0) {
    cachedColumnsByTable.set(cacheKey, columns);
    loadedColumnsByTable.add(cacheKey.toLowerCase());
  } else {
    cachedColumnsByTable.delete(cacheKey);
    loadedColumnsByTable.delete(cacheKey.toLowerCase());
  }
  return true;
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

function isMissingTableMetadataError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return message.includes("42s02") || message.includes("1146") || message.includes("doesn't exist") || message.includes("does not exist") || message.includes("unknown table");
}

async function ensureForeignKeysForTable(table: { name: string; database?: string | null; schema?: string | null }) {
  if (isVirtualCompletionTableReference(table)) return;
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

async function ensureForeignKeysForTables(tables: Array<{ name: string; database?: string | null; schema?: string | null }>) {
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

function createHoverDom(title: string, detail: string, sqlContent?: string, rows: string[] = []): { dom: HTMLElement; mount?: () => void; destroy?: () => void } {
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

  let layoutController: ReturnType<typeof constrainSqlHoverLayout> | null = null;
  let handleCopy: ((event: ClipboardEvent) => void) | null = null;
  let searchController: HoverSearchController | null = null;

  if (sqlContent) {
    heading.className = "flex items-center justify-between gap-3 font-medium";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "rounded border border-border/60 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
    copyButton.textContent = t("grid.copyDdl");
    copyButton.title = t("grid.copyDdl");
    copyButton.setAttribute("aria-label", t("grid.copyDdl"));
    copyButton.addEventListener("pointerdown", (event) => {
      // Keep CodeMirror's editor gestures from dismissing the tooltip before
      // the click can reach the copy action.
      event.preventDefault();
      event.stopPropagation();
    });
    copyButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        try {
          await copyToClipboard(normalizeAlignedSqlWhitespace(sqlContent));
          toast(t("contextMenu.ddlCopied"), 2000);
        } catch (error: any) {
          toast(t("grid.copyFailed", { message: error?.message || String(error) }), 5000);
        }
      })();
    });
    heading.appendChild(copyButton);

    const separator = document.createElement("div");
    separator.className = "mt-2 border-t border-border/60";
    dom.appendChild(separator);

    const sqlContainer = document.createElement("div");
    sqlContainer.className = "mt-1.5 text-[11px] leading-5 whitespace-pre font-mono";

    if (hoverSqlHighlighter) {
      sqlContainer.innerHTML = hoverSqlHighlighter(sqlContent, isDark.value ? "dark" : "light");
    } else {
      sqlContainer.className += " text-muted-foreground";
      sqlContainer.textContent = sqlContent;
    }

    // 纯前端搜索：在已生成的 DDL 内容上做大小写不敏感匹配并高亮，不重新请求元数据/DDL。
    // originalHtml 必须在挂到文档前、内容渲染后捕获，作为每次搜索的还原基线。
    searchController = createHoverSearch({
      target: sqlContainer,
      originalHtml: sqlContainer.innerHTML,
      placeholder: t("grid.hoverSearchPlaceholder"),
      noResultLabel: t("grid.hoverSearchNoResult"),
    });
    dom.appendChild(searchController.element);

    dom.appendChild(sqlContainer);
    dom.appendChild(searchController.status);
    // 返回 mount/destroy 给 CodeMirror TooltipView 生命周期钩子，
    // 避免 MutationObserver 监听 body 全子树来兜底清理。
    layoutController = constrainSqlHoverLayout(dom, sqlContainer);

    // The tooltip pads column names/types with literal spaces so they line up
    // visually (see alignColumnRows). Selecting that text and copying it via
    // the native OS/browser copy carries those spaces verbatim, which shows
    // up as long literal space runs when pasted into a plain-text editor.
    // Normalize just the clipboard payload so the on-screen alignment is
    // untouched but paste targets get clean single-spaced SQL.
    handleCopy = (event: ClipboardEvent) => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) return;
      if (!dom.contains(selection.anchorNode) && !dom.contains(selection.focusNode)) return;
      const text = selection.toString();
      if (text !== sqlContent) return;
      const normalized = normalizeAlignedSqlWhitespace(text);
      if (normalized === text) return;
      event.clipboardData?.setData("text/plain", normalized);
      event.preventDefault();
    };
  }

  for (const row of rows) {
    const rowNode = document.createElement("div");
    rowNode.className = "mt-1 font-mono text-muted-foreground";
    rowNode.textContent = row;
    dom.appendChild(rowNode);
  }

  return {
    dom,
    mount:
      layoutController || handleCopy || searchController
        ? () => {
            layoutController?.mount();
            if (handleCopy) document.addEventListener("copy", handleCopy);
          }
        : undefined,
    destroy:
      layoutController || handleCopy || searchController
        ? () => {
            layoutController?.destroy();
            searchController?.destroy();
            if (handleCopy) document.removeEventListener("copy", handleCopy);
          }
        : undefined,
  };
}

async function resolveSqlHoverTooltip(currentView: EditorViewType, pos: number) {
  if (!props.connectionId || props.database == null || contextMenuOpen.value) return null;

  const sql = currentView.state.doc.toString();
  const range = identifierRangeAt(sql, pos);
  if (!range) return null;

  const identifier = range.text;
  const parts = splitQualifiedIdentifier(identifier);
  const name = parts[parts.length - 1] ?? identifier;
  const qualifier = parts.length > 1 ? parts[parts.length - 2] : undefined;
  let semanticModel: ReturnType<typeof buildSqlSemanticModel> | null = null;
  if (SEMANTIC_SQL_COMPLETION_ENABLED) {
    try {
      semanticModel = buildSqlSemanticModel(sql, pos, sqlCompletionDialectOptions());
    } catch (error) {
      semanticModel = null;
      console.warn(`[DBX] Failed to build semantic model for hover tooltip:`, error);
    }
  }
  const semanticTarget = semanticModel ? resolveSqlSemanticNavigationTarget(semanticModel, parts) : null;
  const semanticQualifierIsRowSource = !!qualifier && !!semanticTarget && (semanticTarget.alias?.toLowerCase() === qualifier.toLowerCase() || semanticTarget.source.name.toLowerCase() === qualifier.toLowerCase());
  const tableLookupName = semanticTarget && !semanticQualifierIsRowSource ? semanticTarget.name : name;
  const qualifiedTableLookup = semanticTarget?.schema ? `${semanticTarget.schema}.${semanticTarget.name}` : identifier;

  const hoverTarget = completionMetadataTarget({
    name: tableLookupName,
    catalog: props.catalog,
    database: semanticTarget?.database,
    schema: semanticTarget?.schema,
  });
  if (!hoverTarget) return null;
  const hoverScope: HoverTableScope = {
    catalog: hoverTarget.catalog,
    database: hoverTarget.database,
    schema: hoverTarget.schema,
  };

  try {
    let hoverTables = cachedTables.filter((table) => hoverTableMatchesScope(table, hoverScope));
    let table = matchTable(qualifiedTableLookup, hoverTables) ?? matchTable(tableLookupName, hoverTables) ?? matchTable(identifier, hoverTables) ?? matchTable(name, hoverTables);
    if (!table) {
      const localTables = connectionStore.lookupLocalCompletionTables(props.connectionId, hoverScope.database, tableLookupName, MAX_COMPLETION_TABLES, hoverScope.schema, hoverScope.catalog);
      const localHoverTables = scopeHoverTables(localTables, hoverScope);
      hoverTables = mergeCompletionTables(localHoverTables, hoverTables);
      cachedTables = mergeCompletionTables(localHoverTables, cachedTables);
      table = matchTable(qualifiedTableLookup, hoverTables) ?? matchTable(tableLookupName, hoverTables) ?? matchTable(identifier, hoverTables) ?? matchTable(name, hoverTables);
    }
    if (!table && !usesLocalOnlyCompletionMetadata()) {
      const loadedTables = await connectionStore.listCompletionTables(props.connectionId, hoverScope.database, tableLookupName, MAX_COMPLETION_TABLES, hoverScope.schema, false, hoverScope.schema, hoverScope.catalog);
      const remoteHoverTables = scopeHoverTables(loadedTables, hoverScope);
      hoverTables = mergeCompletionTables(hoverTables, remoteHoverTables);
      cachedTables = mergeCompletionTables(cachedTables, remoteHoverTables);
      table = matchTable(qualifiedTableLookup, hoverTables) ?? matchTable(tableLookupName, hoverTables) ?? matchTable(identifier, hoverTables) ?? matchTable(name, hoverTables);
    }
    if (table && settingsStore.editorSettings.showTableDdlHoverPreview && !semanticQualifierIsRowSource && (!qualifier || table.schema?.toLowerCase() === qualifier.toLowerCase() || table.name === name)) {
      const hoverDatabase = hoverScope.database;
      const hoverSchema = hoverScope.schema ?? table.schema ?? "";
      const hoverQualifiedName = [hoverScope.catalog, hoverDatabase, hoverSchema, table.name].filter(Boolean).join(".");
      const objectMetadataRequest = {
        connectionId: props.connectionId,
        database: hoverDatabase,
        schema: hoverSchema,
        tableName: table.name,
        catalog: hoverScope.catalog,
        objectType: sqlObjectNavigationSourceKind(table),
      };
      let sqlContent: string | undefined;
      let metadataLoadFailed = false;

      // The persisted display DDL is canonical across the full-page and hover
      // views. Hover only removes PostgreSQL's appended access-control tail.
      try {
        const { ddl } = await loadObjectDdl(objectMetadataRequest);
        const rawDdl = ddlForHoverPreview(ddl);
        if (rawDdl && rawDdl.trim()) {
          // A view's display DDL wraps the raw (often single-line) view source
          // in `CREATE ... VIEW ... AS`; the table-oriented reformatter cannot
          // lay out a SELECT body, so views reuse the shared display formatter
          // (the same one the sidebar/object-source viewers use). Tables keep
          // the aligned column layout from reformatHoverDdl.
          const isViewObject = objectMetadataRequest.objectType === "VIEW" || objectMetadataRequest.objectType === "MATERIALIZED_VIEW";
          sqlContent = isViewObject ? await formatSqlForDisplay(rawDdl, props.formatDialect ?? sqlFormatDialectForDbType(props.databaseType), settingsStore.editorSettings.sqlFormatter) : reformatHoverDdl(rawDdl, quoteQualifiedName(hoverQualifiedName));
        }
      } catch (error) {
        console.warn(`[DBX] Failed to load table DDL for ${hoverDatabase}.${hoverSchema}.${table.name}:`, error);
      }

      // Fallback path: rebuild the DDL from cached table metadata when the
      // backend DDL is unavailable (empty result or request failure).
      if (!sqlContent) {
        let fullColumns: ColumnInfo[] = [];
        let fullIndexes: IndexInfo[] = [];
        let tableComment: string | undefined;
        try {
          const [columnsResult, indexesResult] = await Promise.all([
            loadObjectMetadataFacet(objectMetadataRequest, "columns", () => api.getColumns(props.connectionId!, hoverDatabase, hoverSchema, table.name, hoverScope.catalog)),
            loadObjectMetadataFacet(objectMetadataRequest, "indexes", () => api.listIndexes(props.connectionId!, hoverDatabase, hoverSchema, table.name, hoverScope.catalog)).catch(() => ({ value: [] as IndexInfo[], cacheStatus: "remote" as const })),
          ]);
          fullColumns = columnsResult.value;
          fullIndexes = indexesResult.value;
        } catch (error) {
          metadataLoadFailed = true;
          console.warn(`[DBX] Failed to load table metadata for ${hoverDatabase}.${hoverSchema}.${table.name}:`, error);
        }
        if (!metadataLoadFailed) {
          try {
            const commentResult = await loadObjectMetadataFacet(objectMetadataRequest, "comment", () => api.getTableComment(props.connectionId!, hoverDatabase, hoverSchema, table.name, hoverScope.catalog));
            if (commentResult.value) tableComment = commentResult.value;
          } catch (error) {
            console.warn(`[DBX] Failed to load table comment for ${hoverDatabase}.${hoverSchema}.${table.name}:`, error);
          }
        }
        if (fullColumns.length > 0) {
          sqlContent = buildHoverTableSql(quoteQualifiedName(hoverQualifiedName), fullColumns, fullIndexes, tableComment);
          metadataLoadFailed = false;
        }
      }
      // Re-check after async metadata load — the context menu may have opened
      // while the DDL request was in flight, and we must not display a hover
      // tooltip on top of an open context menu.
      if (contextMenuOpen.value) return null;
      return {
        pos: range.from,
        end: range.to,
        create: () => createHoverDom(table.name, sqlObjectHoverDetail(table), sqlContent, metadataLoadFailed ? ["[DBX] Failed to load table structure — check connection"] : undefined),
      };
    }

    const legacyContext = getSqlCompletionContext(sql, pos, sqlCompletionDialectOptions());
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
        create: () => createHoverDom(column.name, column.dataType || "column", undefined, [column.schema ? `${column.schema}.${column.table}` : column.table, ...(column.comment?.trim() ? [column.comment.trim()] : [])]),
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
  const range = resolveSqlErrorDecorationRange(currentState.doc.toString(), props.executionError);
  if (!range) return [];
  return [
    {
      ...range,
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
  return props.databaseType === "victoriametrics" || (props.databaseType !== "redis" && !settingsStore.editorSettings.sqlSemanticDiagnosticsEnabled);
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

function semanticDiagnosticMetadataScope(sql: string, range: SqlTextRange): CompletionMetadataScope {
  const selectedDatabase = props.database!;
  const parsedDatabase = props.databaseType === "sqlserver" ? sqlServerUseDatabaseBeforeCursor(sql, range.from) : undefined;
  if (!parsedDatabase || !props.connectionId) return { database: selectedDatabase, schema: props.schema };
  const database = connectionStore.lookupLocalCompletionDatabases(props.connectionId, parsedDatabase, MAX_COMPLETION_TABLES).find((candidate) => candidate.toLowerCase() === parsedDatabase.toLowerCase()) ?? parsedDatabase;
  return {
    database,
    schema: metadataSchemaForConnection(connectionStore.getConfig(props.connectionId), database, undefined),
  };
}

function semanticDiagnosticTablesForScope(tables: SqlTableReference[], scope: CompletionMetadataScope): SqlTableReference[] {
  if (props.databaseType !== "sqlserver" || scope.database === props.database) return tables;
  return tables.map((table) => (table.database ? table : { ...table, database: scope.database, schema: table.schema ?? scope.schema }));
}

async function enrichSemanticDiagnosticTables(tables: SqlTableReference[], scope?: CompletionMetadataScope): Promise<{ tables: SqlTableReference[]; missingTables: Set<string> }> {
  if (!props.connectionId || props.database == null) return { tables, missingTables: new Set() };

  const enriched: SqlTableReference[] = [];
  const missingTables = new Set<string>();
  for (const table of tables) {
    if (isStatementLocalSemanticTable(table) || isSqlVirtualTableReference(table, props.databaseType)) {
      enriched.push(table);
      continue;
    }
    if (usesOracleSessionCompletionColumns(table.schema)) {
      enriched.push(table);
      continue;
    }
    try {
      const match = await findExactSemanticDiagnosticTable(table, scope);
      if (!match) missingTables.add(tableReferenceKey(table));
      enriched.push(match?.schema ? { ...table, schema: match.schema } : table);
    } catch {
      enriched.push(table);
    }
  }
  return { tables: enriched, missingTables };
}

async function ensureColumnsForSemanticDiagnostics(tables: SqlTableReference[], scope?: CompletionMetadataScope): Promise<Set<string>> {
  const missingTables = new Set<string>();
  const seen = new Set<string>();
  const targets: SqlTableReference[] = [];
  for (const table of tables) {
    if (isStatementLocalSemanticTable(table) || isSqlVirtualTableReference(table, props.databaseType)) continue;
    const tableWithInlineColumns = table as SqlTableReference & {
      columns?: string[];
    };
    if (tableWithInlineColumns.columns && tableWithInlineColumns.columns.length > 0) continue;
    const cacheKey = completionCacheKey(table, scope);
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
        await ensureColumnsForTable(table, undefined, scope);
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
  if (props.databaseType === "mongodb" || props.databaseType === "elasticsearch" || props.databaseType === "easysearch" || props.databaseType === "meilisearch" || props.databaseType === "victoriametrics") {
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
  const oracleSyntaxDiagnostics = buildOracleSyntaxDiagnostics(sql, props.databaseType);
  nextDiagnostics.push(
    ...oracleSyntaxDiagnostics.filter((diagnostic) => {
      const diagnosticRange = sqlTextSpanToRange(sql, diagnostic.span);
      return !!diagnosticRange && diagnosticRanges.some((range) => rangesOverlap(diagnosticRange, range));
    }),
  );
  const mysqlRoutineAnalysis = props.databaseType === "mysql" && supportsMysqlRoutineSyntaxDiagnostics(sqlDriverProfile.value) ? analyzeMysqlRoutineSyntax(sql) : null;
  if (mysqlRoutineAnalysis) {
    nextDiagnostics.push(
      ...mysqlRoutineAnalysis.diagnostics.filter((diagnostic) => {
        const diagnosticRange = sqlTextSpanToRange(sql, diagnostic.span);
        return !!diagnosticRange && diagnosticRanges.some((range) => rangesOverlap(diagnosticRange, range));
      }),
    );
  }
  for (const range of diagnosticRanges) {
    if (mysqlRoutineAnalysis?.routineRanges.some((routineRange) => rangesOverlap(routineRange, range))) continue;
    try {
      const analysis = await api.analyzeSqlReferences(
        range.sql,
        sqlReferenceAnalysisDialectFor({
          databaseType: props.databaseType,
          identifierQuote: connectionStore.connectionIdentifierQuote(props.connectionId),
          fallbackDialect: props.formatDialect ?? props.dialect ?? "generic",
        }),
      );
      if (runId !== semanticDiagnosticRunId) return;

      const semanticCursor = Math.max(0, Math.min(currentView.state.selection.main.head - range.from, range.sql.length));
      const semanticModel = SEMANTIC_SQL_COMPLETION_ENABLED
        ? buildSqlSemanticModel(range.sql, semanticCursor, {
            databaseType: props.databaseType,
            dialect: sqlBehaviorDialect(),
          })
        : null;
      const semanticAnalysis = semanticModel ? mergeSqlSemanticReferenceAnalysis(analysis, semanticModel) : analysis;
      const metadataScope = semanticDiagnosticMetadataScope(sql, range);
      const scopedAnalysis = {
        ...semanticAnalysis,
        tables: semanticDiagnosticTablesForScope(semanticAnalysis.tables, metadataScope),
      };
      const { tables, missingTables } = await enrichSemanticDiagnosticTables(scopedAnalysis.tables, metadataScope);
      const columnMetadataMissingTables = await ensureColumnsForSemanticDiagnostics(tables, metadataScope);
      for (const tableKey of columnMetadataMissingTables) missingTables.add(tableKey);
      if (runId !== semanticDiagnosticRunId) return;

      const enrichedAnalysis: SqlReferenceAnalysis = {
        ...scopedAnalysis,
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
            databaseType: props.databaseType,
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

function droppedTableReference(event: DragEvent) {
  return activeTableReferencePayloadValue() ?? parseTableReferencePayload(event.dataTransfer?.getData(DBX_TABLE_REFERENCE_MIME));
}

function hasDroppedTableReference(event: DragEvent) {
  return !!activeTableReferencePayloadValue() || hasTableReferencePayloadType(event.dataTransfer?.types);
}

function insertTableReferencePayload(currentView: EditorViewType, payload: QueryEditorTableReferencePayload, coords?: { clientX: number; clientY: number }): boolean {
  if (props.readOnly) return false;
  const insertText = tableReferenceInsertText(payload, props.databaseType, {
    tableNameSeparator: settingsStore.editorSettings.sidebarCopyTableNameSeparator,
    columnNameSeparator: settingsStore.editorSettings.sidebarCopyTableNameSeparator,
    includeTableSchema: settingsStore.editorSettings.sidebarCopyTableNameIncludeSchema,
  });
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
  hideQueryEditorDropCaret();
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
  // elementFromPoint 被透明覆盖层拦截时回退为编辑器根节点包围盒判定（见 isPointOverElementRoot）。
  if (isPointOverElementRoot(detail.clientX, detail.clientY, editorRef.value)) {
    insertTableReferencePayload(currentView, detail.payload, detail);
  }
}

// --- 表引用拖拽悬停时的插入光标线（指针模拟拖拽经 window 事件驱动） ---
const queryEditorDropCaret = ref<{ left: number; top: number; height: number } | null>(null);
const queryEditorDropCaretStyle = computed(() => {
  const caret = queryEditorDropCaret.value;
  return caret ? { left: `${caret.left}px`, top: `${caret.top}px`, height: `${caret.height}px` } : {};
});

function showQueryEditorDropCaretAt(clientX: number, clientY: number) {
  const currentView = view.value;
  if (!currentView || props.readOnly || !editorRef.value) {
    hideQueryEditorDropCaret();
    return;
  }
  let dropPos: number | null = null;
  try {
    dropPos = currentView.posAtCoords({ x: clientX, y: clientY });
  } catch {
    dropPos = null;
  }
  if (dropPos == null) {
    hideQueryEditorDropCaret();
    return;
  }
  const coords = currentView.coordsAtPos(dropPos);
  if (!coords) {
    hideQueryEditorDropCaret();
    return;
  }
  const rect = editorRef.value.getBoundingClientRect();
  queryEditorDropCaret.value = { left: coords.left - rect.left, top: coords.top - rect.top, height: Math.max(coords.bottom - coords.top, 0) };
}

function hideQueryEditorDropCaret() {
  queryEditorDropCaret.value = null;
}

function onTableReferenceHoverEvent(event: Event) {
  if (!(event instanceof CustomEvent)) return;
  const detail = event.detail as QueryEditorTableReferenceHoverDetail | undefined;
  if (!detail) return;
  // elementFromPoint 被透明覆盖层拦截时回退为编辑器根节点包围盒判定（见 isPointOverElementRoot）。
  if (!isPointOverElementRoot(detail.clientX, detail.clientY, editorRef.value)) {
    hideQueryEditorDropCaret();
    return;
  }
  showQueryEditorDropCaretAt(detail.clientX, detail.clientY);
}

function onTableReferenceDragEndEvent() {
  hideQueryEditorDropCaret();
}

function registerTableReferenceDropListener() {
  if (tableReferenceDropListenerRegistered) return;
  window.addEventListener(DBX_TABLE_REFERENCE_DROP_EVENT, onTableReferenceDropEvent);
  window.addEventListener(DBX_TABLE_REFERENCE_HOVER_EVENT, onTableReferenceHoverEvent);
  window.addEventListener(DBX_TABLE_REFERENCE_DRAG_END_EVENT, onTableReferenceDragEndEvent);
  tableReferenceDropListenerRegistered = true;
}

function unregisterTableReferenceDropListener() {
  if (!tableReferenceDropListenerRegistered) return;
  window.removeEventListener(DBX_TABLE_REFERENCE_DROP_EVENT, onTableReferenceDropEvent);
  window.removeEventListener(DBX_TABLE_REFERENCE_HOVER_EVENT, onTableReferenceHoverEvent);
  window.removeEventListener(DBX_TABLE_REFERENCE_DRAG_END_EVENT, onTableReferenceDragEndEvent);
  tableReferenceDropListenerRegistered = false;
}

let completionEpoch = 0;
let tableCompletionRefreshActive = false;
let latestTableCompletionRefresh: (() => Promise<void>) | null = null;

function queueTableCompletionRefresh(task: () => Promise<void>): void {
  latestTableCompletionRefresh = task;
  if (tableCompletionRefreshActive) return;
  tableCompletionRefreshActive = true;
  void (async () => {
    while (latestTableCompletionRefresh) {
      const next = latestTableCompletionRefresh;
      latestTableCompletionRefresh = null;
      await next();
    }
  })().finally(() => {
    tableCompletionRefreshActive = false;
  });
}
let completionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let typedCompletionActivationUntil = 0;
let suppressNextSqlCompletionAutoStartUntil = 0;
let activeCompletionOrigin: SqlCompletionTriggerOrigin | null = null;

type QueryCompletionItem = SqlCompletionItem | ElasticsearchCompletionItem | RedisCompletionItem | MongoCompletionItem;

interface BatchColumnSelectionCandidate {
  key: string;
  apply: string;
}

interface BatchColumnSelectionSession {
  key: string;
  mode: "select" | "insert";
  qualifier?: string;
  document: string;
  from: number;
  to: number;
  replaceClosingQuote?: SqlCompletionItem["replaceClosingQuote"];
  candidates: BatchColumnSelectionCandidate[];
  selectedKeys: Set<string>;
  completionOptions: Map<string, QueryCompletionOption>;
}

interface BatchColumnSelectionActionItem {
  label: string;
  filterText?: string;
  type: "text";
  detail: string;
  boost: number;
  batchColumnSelectionAction: true;
  sessionKey: string;
}

type QueryCompletionOption = Completion & {
  dbxBatchColumnSelection?: { sessionKey: string; candidateKey: string };
  dbxBatchColumnSelectionAction?: { sessionKey: string };
};

let batchColumnSelectionSession: BatchColumnSelectionSession | null = null;
type BatchColumnSelectionCheckboxMarker = NonNullable<QueryCompletionOption["dbxBatchColumnSelection"]>;
interface BatchColumnSelectionDragState {
  view: EditorViewType;
  sessionKey: string;
  pointerId: number;
  anchorCandidateKey: string;
  baseSelectedKeys: Set<string>;
  selected: boolean;
  focusCandidateKey: string;
  previousUserSelect: string;
  scrollElement: HTMLElement | null;
  pointerClientX: number;
  pointerClientY: number;
  autoScrollFrame: number;
}

const batchColumnSelectionCheckboxMarkers = new WeakMap<HTMLElement, BatchColumnSelectionCheckboxMarker>();
const batchColumnSelectionActionMarkers = new WeakMap<HTMLElement, string>();
const batchColumnSelectionTooltipParents = new WeakMap<EditorViewType, HTMLElement>();
let batchColumnSelectionDragState: BatchColumnSelectionDragState | null = null;
let batchColumnSelectionRefreshCleanup: (() => void) | null = null;
let batchColumnSelectionExpandedRendering = false;
let batchColumnSelectionRenderLimitTimer: number | null = null;

function cancelBatchColumnSelectionRefresh() {
  batchColumnSelectionRefreshCleanup?.();
  batchColumnSelectionRefreshCleanup = null;
}

function setBatchColumnSelectionExpandedRendering(expanded: boolean) {
  if (batchColumnSelectionExpandedRendering === expanded) return;
  batchColumnSelectionExpandedRendering = expanded;
  if (batchColumnSelectionRenderLimitTimer !== null) window.clearTimeout(batchColumnSelectionRenderLimitTimer);

  const currentView = view.value;
  if (!currentView || !completionComp || !buildSqlCompletionExtension) return;
  batchColumnSelectionRenderLimitTimer = window.setTimeout(() => {
    batchColumnSelectionRenderLimitTimer = null;
    if (view.value !== currentView || !completionComp || !buildSqlCompletionExtension) return;
    currentView.dispatch({ effects: completionComp.reconfigure(buildSqlCompletionExtension()) });
    if (expanded && codeMirrorCompletionStatus?.(currentView.state) === "active") codeMirrorStartCompletion?.(currentView);
  }, 0);
}

function setBatchColumnSelectionValue(sessionKey: string, candidateKey: string, selected: boolean, checkbox?: HTMLInputElement) {
  const session = batchColumnSelectionSession;
  if (!session || session.key !== sessionKey || !session.candidates.some((candidate) => candidate.key === candidateKey)) return;
  if (selected) session.selectedKeys.add(candidateKey);
  else session.selectedKeys.delete(candidateKey);
  if (checkbox) checkbox.checked = selected;
}

function updateBatchColumnSelectionActionLabel(view: EditorViewType, sessionKey: string) {
  const session = batchColumnSelectionSession;
  if (!session || session.key !== sessionKey) return;
  const label = t("editor.completion.insertSelectedColumns", { count: session.selectedKeys.size });
  const tooltipParent = batchColumnSelectionTooltipParents.get(view) ?? view.dom;
  tooltipParent.querySelectorAll<HTMLElement>(".cm-batch-column-selection-action-marker").forEach((marker) => {
    if (batchColumnSelectionActionMarkers.get(marker) !== sessionKey) return;
    const element = marker.closest("li")?.querySelector<HTMLElement>(".cm-completionLabel");
    if (!element) return;
    if (element.textContent !== label) element.textContent = label;
  });
}

function scheduleBatchColumnSelectionRefresh(view: EditorViewType, sessionKey: string, focusCandidateKey: string, scrollState?: { element: HTMLElement | null; top: number; left: number }) {
  cancelBatchColumnSelectionRefresh();
  const preservedScroll =
    scrollState ??
    (() => {
      const element =
        visibleBatchColumnSelectionCheckboxes(sessionKey)
          .map(({ checkbox }) => batchColumnSelectionScrollElement(checkbox))
          .find((candidate): candidate is HTMLElement => !!candidate) ?? null;
      return { element, top: element?.scrollTop ?? 0, left: element?.scrollLeft ?? 0 };
    })();
  const restoreScroll = () => {
    const currentElement =
      visibleBatchColumnSelectionCheckboxes(sessionKey)
        .map(({ checkbox }) => batchColumnSelectionScrollElement(checkbox))
        .find((candidate): candidate is HTMLElement => !!candidate) ?? preservedScroll.element;
    if (!currentElement) return;
    currentElement.scrollTop = Math.min(preservedScroll.top, Math.max(0, currentElement.scrollHeight - currentElement.clientHeight));
    currentElement.scrollLeft = Math.min(preservedScroll.left, Math.max(0, currentElement.scrollWidth - currentElement.clientWidth));
  };
  let restoreAttempts = 0;
  let restoreFrame = 0;
  let restoreTimer = 0;
  let restoreStartTimer = 0;
  let stopped = false;
  const restoreObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(restoreScroll);
  const stopRestore = () => {
    if (stopped) return;
    stopped = true;
    restoreObserver?.disconnect();
    if (restoreFrame) window.cancelAnimationFrame(restoreFrame);
    if (restoreTimer) window.clearTimeout(restoreTimer);
    if (restoreStartTimer) window.clearTimeout(restoreStartTimer);
    if (batchColumnSelectionRefreshCleanup === stopRestore) batchColumnSelectionRefreshCleanup = null;
  };
  batchColumnSelectionRefreshCleanup = stopRestore;
  const restoreNextFrame = () => {
    if (batchColumnSelectionSession?.key !== sessionKey) {
      stopRestore();
      return;
    }
    restoreScroll();
    restoreAttempts += 1;
    if (restoreAttempts < 60) restoreFrame = window.requestAnimationFrame(restoreNextFrame);
    else stopRestore();
  };
  restoreStartTimer = window.setTimeout(() => {
    if (stopped || batchColumnSelectionSession?.key !== sessionKey) {
      stopRestore();
      return;
    }
    restoreObserver?.observe(document.body, { childList: true, subtree: true });
    // Keep CodeMirror's virtualized range anchored to the item where the drag ended.
    const focusIndex =
      codeMirrorCurrentCompletions?.(view.state).findIndex((completion) => {
        const marker = (completion as QueryCompletionOption).dbxBatchColumnSelection;
        return marker?.sessionKey === sessionKey && marker.candidateKey === focusCandidateKey;
      }) ?? -1;
    if (focusIndex >= 0 && codeMirrorSetSelectedCompletion) view.dispatch({ effects: codeMirrorSetSelectedCompletion(focusIndex) });
    codeMirrorStartCompletion?.(view);
    restoreNextFrame();
    restoreTimer = window.setTimeout(stopRestore, 1500);
  }, 0);
}

function finishBatchColumnSelectionDrag(refresh = true) {
  const state = batchColumnSelectionDragState;
  if (!state) return;
  const scrollState = state.scrollElement ? { element: state.scrollElement, top: state.scrollElement.scrollTop, left: state.scrollElement.scrollLeft } : undefined;
  batchColumnSelectionDragState = null;
  if (state.autoScrollFrame) window.cancelAnimationFrame(state.autoScrollFrame);
  window.removeEventListener("pointermove", onBatchColumnSelectionPointerMove, true);
  window.removeEventListener("pointerup", onBatchColumnSelectionPointerUp, true);
  window.removeEventListener("pointercancel", onBatchColumnSelectionPointerCancel, true);
  window.removeEventListener("blur", onBatchColumnSelectionPointerCancel, true);
  document.body.style.userSelect = state.previousUserSelect;
  if (refresh) scheduleBatchColumnSelectionRefresh(state.view, state.sessionKey, state.focusCandidateKey, scrollState);
}

function clearBatchColumnSelectionSession() {
  finishBatchColumnSelectionDrag(false);
  cancelBatchColumnSelectionRefresh();
  setBatchColumnSelectionExpandedRendering(false);
  batchColumnSelectionSession = null;
}

function isBatchColumnSelectionAction(item: QueryCompletionItem | BatchColumnSelectionActionItem): item is BatchColumnSelectionActionItem {
  return "batchColumnSelectionAction" in item && item.batchColumnSelectionAction === true;
}

function batchColumnSelectionCandidateKey(item: SqlCompletionItem): string {
  return `${item.label}\u0000${item.apply ?? item.label}`;
}

function prepareBatchColumnSelectionSession(items: SqlCompletionItem[], document: string, from: number, to: number): BatchColumnSelectionSession | null {
  const selectableItems = items.filter((item) => item.type === "column" && item.batchSelectionMode && item.apply);
  if (selectableItems.length === 0) {
    clearBatchColumnSelectionSession();
    return null;
  }

  const mode = selectableItems[0]!.batchSelectionMode!;
  const candidates = selectableItems.filter((item) => item.batchSelectionMode === mode).map((item) => ({ key: batchColumnSelectionCandidateKey(item), apply: item.apply! }));
  const key = `${mode}\u0000${from}\u0000${to}\u0000${document}`;
  if (!batchColumnSelectionSession || batchColumnSelectionSession.key !== key) {
    batchColumnSelectionSession = {
      key,
      mode,
      qualifier: selectableItems[0]!.batchSelectionQualifier,
      document,
      from,
      to,
      replaceClosingQuote: selectableItems[0]!.replaceClosingQuote,
      candidates,
      selectedKeys: new Set(),
      completionOptions: new Map(),
    };
    setBatchColumnSelectionExpandedRendering(true);
    return batchColumnSelectionSession;
  }

  setBatchColumnSelectionExpandedRendering(true);
  batchColumnSelectionSession.candidates = candidates;
  batchColumnSelectionSession.qualifier = selectableItems[0]!.batchSelectionQualifier;
  const candidateKeys = new Set(candidates.map((candidate) => candidate.key));
  batchColumnSelectionSession.selectedKeys = new Set([...batchColumnSelectionSession.selectedKeys].filter((candidateKey) => candidateKeys.has(candidateKey)));
  batchColumnSelectionSession.completionOptions = new Map([...batchColumnSelectionSession.completionOptions].filter(([candidateKey]) => candidateKeys.has(candidateKey)));
  return batchColumnSelectionSession;
}

function batchColumnSelectionMarkerForItem(item: QueryCompletionItem): QueryCompletionOption["dbxBatchColumnSelection"] | undefined {
  if (!("batchSelectionMode" in item) || item.type !== "column" || !item.batchSelectionMode || !item.apply) return undefined;
  const session = batchColumnSelectionSession;
  if (!session || session.mode !== item.batchSelectionMode) return undefined;
  const candidateKey = batchColumnSelectionCandidateKey(item);
  if (!session.candidates.some((candidate) => candidate.key === candidateKey)) return undefined;
  return { sessionKey: session.key, candidateKey };
}

function cacheBatchColumnSelectionOption(marker: QueryCompletionOption["dbxBatchColumnSelection"], option: QueryCompletionOption): QueryCompletionOption {
  if (!marker || !batchColumnSelectionSession || batchColumnSelectionSession.key !== marker.sessionKey) return option;
  const cached = batchColumnSelectionSession.completionOptions.get(marker.candidateKey);
  if (cached) return cached;
  batchColumnSelectionSession.completionOptions.set(marker.candidateKey, option);
  return option;
}

function toggleBatchColumnSelection(view: EditorViewType, sessionKey: string, candidateKey: string) {
  const session = batchColumnSelectionSession;
  if (!session || session.key !== sessionKey || !session.candidates.some((candidate) => candidate.key === candidateKey)) return;
  setBatchColumnSelectionValue(sessionKey, candidateKey, !session.selectedKeys.has(candidateKey));
  updateBatchColumnSelectionActionLabel(view, sessionKey);
  // Reopen the list so the action row and all virtualized checkboxes reflect the new state.
  scheduleBatchColumnSelectionRefresh(view, sessionKey, candidateKey);
}

function toggleSelectedBatchColumnSelection(view: EditorViewType): boolean {
  const completion = codeMirrorSelectedCompletion?.(view.state) as QueryCompletionOption | null | undefined;
  const marker = completion?.dbxBatchColumnSelection;
  if (!marker) return false;
  toggleBatchColumnSelection(view, marker.sessionKey, marker.candidateKey);
  return true;
}

function batchColumnSelectionMarkerAtPoint(clientX: number, clientY: number): { checkbox: HTMLInputElement; marker: BatchColumnSelectionCheckboxMarker } | null {
  const target = document.elementFromPoint(clientX, clientY);
  if (!(target instanceof HTMLElement)) return null;
  const checkbox = target.closest<HTMLInputElement>("input.cm-batch-column-selection-checkbox") ?? target.closest<HTMLElement>("[role='option']")?.querySelector<HTMLInputElement>("input.cm-batch-column-selection-checkbox") ?? null;
  if (!checkbox) return null;
  const marker = batchColumnSelectionCheckboxMarkers.get(checkbox);
  return marker ? { checkbox, marker } : null;
}

function batchColumnSelectionScrollElement(checkbox: HTMLElement): HTMLElement | null {
  let current = checkbox.parentElement;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (current.scrollHeight > current.clientHeight && /(auto|scroll|overlay)/.test(style.overflowY)) return current;
    current = current.parentElement;
  }
  return null;
}

function visibleBatchColumnSelectionCheckboxes(sessionKey: string): Array<{ checkbox: HTMLInputElement; marker: BatchColumnSelectionCheckboxMarker }> {
  return Array.from(document.querySelectorAll<HTMLInputElement>("input.cm-batch-column-selection-checkbox")).flatMap((checkbox) => {
    const marker = batchColumnSelectionCheckboxMarkers.get(checkbox);
    return marker?.sessionKey === sessionKey ? [{ checkbox, marker }] : [];
  });
}

function updateBatchColumnSelectionAtPoint(state: BatchColumnSelectionDragState, clientX: number, clientY: number) {
  const hit = batchColumnSelectionMarkerAtPoint(clientX, clientY);
  if (!hit || hit.marker.sessionKey !== state.sessionKey) return;
  state.focusCandidateKey = hit.marker.candidateKey;
  const session = batchColumnSelectionSession;
  if (!session) return;
  const visibleCheckboxes = visibleBatchColumnSelectionCheckboxes(state.sessionKey);
  const anchorIndex = visibleCheckboxes.findIndex(({ marker }) => marker.candidateKey === state.anchorCandidateKey);
  const focusIndex = visibleCheckboxes.findIndex(({ marker }) => marker.candidateKey === hit.marker.candidateKey);
  if (anchorIndex < 0 || focusIndex < 0) return;
  const nextSelectedKeys = new Set(state.baseSelectedKeys);
  const rangeStart = Math.min(anchorIndex, focusIndex);
  const rangeEnd = Math.max(anchorIndex, focusIndex);
  for (let index = rangeStart; index <= rangeEnd; index++) {
    const candidate = visibleCheckboxes[index]?.marker;
    if (!candidate) continue;
    if (state.selected) nextSelectedKeys.add(candidate.candidateKey);
    else nextSelectedKeys.delete(candidate.candidateKey);
  }
  session.selectedKeys = nextSelectedKeys;
  visibleCheckboxes.forEach(({ checkbox, marker }) => {
    checkbox.checked = nextSelectedKeys.has(marker.candidateKey);
  });
  updateBatchColumnSelectionActionLabel(state.view, state.sessionKey);
}

const BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX = 36;
const BATCH_COLUMN_SELECTION_AUTO_SCROLL_MAX_PX = 20;

function runBatchColumnSelectionAutoScroll() {
  const state = batchColumnSelectionDragState;
  if (!state) return;
  state.autoScrollFrame = 0;
  const scroller = state.scrollElement;
  if (!scroller) return;
  const rect = scroller.getBoundingClientRect();
  if (state.pointerClientX < rect.left || state.pointerClientX > rect.right) return;
  let delta = 0;
  if (state.pointerClientY < rect.top + BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX) {
    delta = -BATCH_COLUMN_SELECTION_AUTO_SCROLL_MAX_PX * Math.min(1, (rect.top + BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX - state.pointerClientY) / BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX);
  } else if (state.pointerClientY > rect.bottom - BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX) {
    delta = BATCH_COLUMN_SELECTION_AUTO_SCROLL_MAX_PX * Math.min(1, (state.pointerClientY - (rect.bottom - BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX)) / BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX);
  }
  if (!delta) return;
  const previousScrollTop = scroller.scrollTop;
  scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + delta));
  if (scroller.scrollTop === previousScrollTop) return;
  updateBatchColumnSelectionAtPoint(state, state.pointerClientX, state.pointerClientY);
  state.autoScrollFrame = window.requestAnimationFrame(runBatchColumnSelectionAutoScroll);
}

function scheduleBatchColumnSelectionAutoScroll(state: BatchColumnSelectionDragState) {
  if (!state.scrollElement || state.autoScrollFrame) return;
  state.autoScrollFrame = window.requestAnimationFrame(runBatchColumnSelectionAutoScroll);
}

function onBatchColumnSelectionPointerMove(event: PointerEvent) {
  const state = batchColumnSelectionDragState;
  if (!state || event.pointerId !== state.pointerId) return;
  if ((event.buttons & 1) === 0) {
    finishBatchColumnSelectionDrag();
    return;
  }
  state.pointerClientX = event.clientX;
  state.pointerClientY = event.clientY;
  updateBatchColumnSelectionAtPoint(state, event.clientX, event.clientY);
  scheduleBatchColumnSelectionAutoScroll(state);
}

function onBatchColumnSelectionPointerUp(event: PointerEvent) {
  const state = batchColumnSelectionDragState;
  if (!state || event.pointerId !== state.pointerId) return;
  finishBatchColumnSelectionDrag();
}

function onBatchColumnSelectionPointerCancel() {
  finishBatchColumnSelectionDrag();
}

function startBatchColumnSelectionDrag(view: EditorViewType, marker: BatchColumnSelectionCheckboxMarker, checkbox: HTMLInputElement, event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return;
  finishBatchColumnSelectionDrag(false);
  cancelBatchColumnSelectionRefresh();
  const session = batchColumnSelectionSession;
  if (!session || session.key !== marker.sessionKey) return;
  if (!session.candidates.some((candidate) => candidate.key === marker.candidateKey)) return;
  const selected = !session.selectedKeys.has(marker.candidateKey);
  const baseSelectedKeys = new Set(session.selectedKeys);
  setBatchColumnSelectionValue(marker.sessionKey, marker.candidateKey, selected, checkbox);
  batchColumnSelectionDragState = {
    view,
    sessionKey: marker.sessionKey,
    pointerId: event.pointerId,
    anchorCandidateKey: marker.candidateKey,
    baseSelectedKeys,
    selected,
    focusCandidateKey: marker.candidateKey,
    previousUserSelect: document.body.style.userSelect,
    scrollElement: batchColumnSelectionScrollElement(checkbox),
    pointerClientX: event.clientX,
    pointerClientY: event.clientY,
    autoScrollFrame: 0,
  };
  updateBatchColumnSelectionActionLabel(view, marker.sessionKey);
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", onBatchColumnSelectionPointerMove, true);
  window.addEventListener("pointerup", onBatchColumnSelectionPointerUp, true);
  window.addEventListener("pointercancel", onBatchColumnSelectionPointerCancel, true);
  window.addEventListener("blur", onBatchColumnSelectionPointerCancel, true);
}

function renderBatchColumnSelectionCheckbox(completion: Completion, _state: import("@codemirror/state").EditorState, currentView: EditorViewType): Node | null {
  const marker = (completion as QueryCompletionOption).dbxBatchColumnSelection;
  const session = batchColumnSelectionSession;
  if (!marker || !session || session.key !== marker.sessionKey) return null;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "cm-batch-column-selection-checkbox";
  checkbox.checked = session.selectedKeys.has(marker.candidateKey);
  checkbox.tabIndex = -1;
  checkbox.setAttribute("aria-label", completion.displayLabel ?? completion.label);
  batchColumnSelectionCheckboxMarkers.set(checkbox, marker);
  checkbox.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    startBatchColumnSelectionDrag(currentView, marker, checkbox, event);
  });
  checkbox.addEventListener("mousedown", (event) => {
    // CodeMirror accepts the completion on a list-item mousedown. Keep this
    // interaction local to the checkbox so a field can be toggled repeatedly.
    event.preventDefault();
    event.stopPropagation();
  });
  checkbox.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  return checkbox;
}

function renderBatchColumnSelectionActionMarker(completion: Completion): Node | null {
  const action = (completion as QueryCompletionOption).dbxBatchColumnSelectionAction;
  if (!action) return null;
  const marker = document.createElement("span");
  marker.className = "cm-batch-column-selection-action-marker";
  marker.hidden = true;
  batchColumnSelectionActionMarkers.set(marker, action.sessionKey);
  return marker;
}

function applyBatchColumnSelection(view: EditorViewType, item: BatchColumnSelectionActionItem, from: number, to: number) {
  const session = batchColumnSelectionSession;
  if (!session || session.key !== item.sessionKey || session.document !== view.state.doc.toString()) return;

  const selected = session.candidates.filter((candidate) => session.selectedKeys.has(candidate.key));
  if (selected.length === 0) {
    toast(t("editor.completion.selectColumnsBeforeInsert"), 3000);
    return;
  }

  const columns = batchColumnSelectionColumnList(
    selected.map((candidate) => candidate.apply),
    session.mode,
    session.qualifier,
  );
  let replaceTo = batchColumnSelectionReplaceTo({
    to,
    mode: session.mode,
    nextCharacter: view.state.sliceDoc(to, to + 1),
    replaceClosingQuote: session.replaceClosingQuote,
  });
  let insert = columns;
  if (session.mode === "insert") {
    const replacement = batchColumnSelectionInsertReplacement({
      document: view.state.doc.toString(),
      to,
      columns,
      valuesKeyword: settingsStore.editorSettings.sqlFormatter.keywordCase === "lower" ? "values" : "VALUES",
      valueCount: selected.length,
    });
    replaceTo = replacement.replaceTo;
    insert = replacement.insert;
  }

  if (session.mode === "insert" && !codeMirrorSnippetCompletion) {
    clearBatchColumnSelectionSession();
    return;
  }
  clearBatchColumnSelectionSession();
  markCompletionAccepted(item);
  if (session.mode === "insert") {
    const snippet = codeMirrorSnippetCompletion(insert, { label: item.label });
    if (typeof snippet.apply === "function") {
      snippet.apply(view, snippet, from, replaceTo);
      return;
    }
  }
  view.dispatch({
    changes: { from, to: replaceTo, insert },
    selection: { anchor: from + insert.length },
    scrollIntoView: true,
  });
}

function applySelectedBatchColumnSelection(view: EditorViewType): boolean {
  const session = batchColumnSelectionSession;
  if (!session || !isBatchColumnSelectionCompletionActive(codeMirrorCompletionStatus?.(view.state) ?? null) || session.document !== view.state.doc.toString() || session.selectedKeys.size === 0) return false;
  applyBatchColumnSelection(
    view,
    {
      label: t("editor.completion.insertSelectedColumns", { count: session.selectedKeys.size }),
      type: "text",
      detail: t("editor.completion.insertSelectedColumnsDetail"),
      boost: -1000,
      batchColumnSelectionAction: true,
      sessionKey: session.key,
    },
    session.from,
    session.to,
  );
  return true;
}

function markTypedCompletionActivation() {
  typedCompletionActivationUntil = Date.now() + 500;
}

function isTypedCompletionActivation(explicit: boolean) {
  return explicit && typedCompletionActivationUntil >= Date.now();
}

function markCompletionAccepted(item: QueryCompletionItem | BatchColumnSelectionActionItem) {
  clearBatchColumnSelectionSession();
  const shouldContinueCompletion = shouldChainSqlCompletionAfterAccept(item) || (props.databaseType === "sqlserver" && item.type === "keyword" && item.label.toUpperCase() === "USE");
  suppressNextSqlCompletionAutoStartUntil = shouldContinueCompletion ? 0 : Date.now() + 750;
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

function buildCompletionResult(items: Array<QueryCompletionItem | BatchColumnSelectionActionItem>, from: number, validFor?: RegExp, prefix?: string) {
  if (items.length === 0) return null;
  const bypassFilter = !!prefix && shouldBypassCompletionFilter(prefix, items);
  const resultItems = bypassFilter && prefix ? completionItemsForBypassedFilter(prefix, items) : items;
  return {
    from,
    // Keep CodeMirror's live filtering enabled so an already-open menu follows the typed prefix.
    options: resultItems.map((item) => completionOptionForItem(item)),
    validFor,
    // When bypassing CodeMirror's matcher, supply our own highlight ranges so
    // the matched characters (Han substring or pinyin initials) stay marked.
    // Ranges must target the rendered text, which is displayLabel when set.
    ...(bypassFilter && prefix ? { filter: false as const, getMatch: (option: { label: string; displayLabel?: string }) => completionMatchRanges(option.displayLabel ?? option.label, prefix) } : {}),
  };
}

function buildSqlCompletionResult(items: SqlCompletionItem[], completionContext: SqlCompletionContext, fullDoc: string, position: number) {
  const replacement = prepareSqlCompletionReplacement(fullDoc, position, completionContext, items);
  const session = prepareBatchColumnSelectionSession(replacement.items, fullDoc, replacement.from, position);
  const action: BatchColumnSelectionActionItem | undefined = session
    ? {
        label: t("editor.completion.insertSelectedColumns", { count: session.selectedKeys.size }),
        filterText: completionContext.prefix,
        type: "text",
        detail: t("editor.completion.insertSelectedColumnsDetail"),
        // Keep ordinary single-field completion as the default Enter target.
        boost: -1000,
        batchColumnSelectionAction: true,
        sessionKey: session.key,
      }
    : undefined;
  return buildCompletionResult(action ? [...replacement.items, action] : replacement.items, replacement.from, getSqlCompletionResultValidFor(fullDoc, position), completionContext.prefix);
}

// CodeMirror's built-in matcher only matches single-character queries against
// the label start, and cannot match pinyin initials against Han labels. Our
// provider already filters and ranks items itself (substring + pinyin), so
// skip the second-stage filter exactly in the cases it would break.
function shouldBypassCompletionFilter(prefix: string, items: Array<QueryCompletionItem | BatchColumnSelectionActionItem>): boolean {
  if (!prefix) return false;
  if (/\p{Script=Han}/u.test(prefix)) return true;
  return /^[a-z0-9]+$/i.test(prefix) && items.some((item) => /\p{Script=Han}/u.test(item.label));
}

function completionItemsForBypassedFilter(prefix: string, items: Array<QueryCompletionItem | BatchColumnSelectionActionItem>): Array<QueryCompletionItem | BatchColumnSelectionActionItem> {
  if ([...prefix].length !== 1 || !/^[a-z0-9]$/i.test(prefix)) return items;
  const normalized = prefix.toLowerCase();
  return items.filter((item) => {
    // The confirmation row must remain available while typing a Han/pinyin
    // prefix, otherwise checked columns cannot be applied from that menu.
    if (isBatchColumnSelectionAction(item)) return true;
    const renderedLabel = "displayLabel" in item && typeof item.displayLabel === "string" ? item.displayLabel : item.label;
    return /\p{Script=Han}/u.test(item.label) || renderedLabel.toLowerCase().startsWith(normalized);
  });
}

function localCompletionDatabaseNames(completionContext: ReturnType<typeof getSqlCompletionContext>): string[] {
  if (!supportsDatabaseNameCompletion(props.databaseType) || !completionContext.suggestTables || completionContext.insertTable || !props.connectionId) return [];
  return connectionStore.lookupLocalCompletionDatabases(props.connectionId, completionContext.qualifier || completionContext.prefix, MAX_COMPLETION_TABLES);
}

function mayCompleteDatabaseSchemaQualifier(completionContext: ReturnType<typeof getSqlCompletionContext>): boolean {
  if (!supportsDatabaseNameCompletion(props.databaseType) || !supportsDatabaseSchemaQualifierCompletion() || !completionContext.suggestTables || completionContext.insertTable) return false;
  return (completionContext.qualifierParts?.filter(Boolean).length ?? completionContext.qualifier?.split(".").filter(Boolean).length ?? 0) === 1;
}

function localCompletionSchemasForDatabaseDisambiguation(completionContext: ReturnType<typeof getSqlCompletionContext>, databaseNames: string[], scope?: CompletionMetadataScope): string[] {
  const currentDatabase = scope?.database ?? props.database;
  const currentSchema = scope?.schema ?? props.schema;
  if (!props.connectionId || currentDatabase == null || !mayCompleteDatabaseSchemaQualifier(completionContext)) return [];
  const database = resolveSqlCompletionSchemaLookupDatabase({
    supportsDatabaseSchemaQualifier: true,
    completionContext,
    knownDatabases: databaseNames,
  });
  if (!database) return [];
  return mergeSqlCompletionQualifierNames(currentSchema ? [currentSchema] : [], connectionStore.lookupLocalCompletionSchemas(props.connectionId, currentDatabase, completionContext.qualifier, MAX_COMPLETION_TABLES));
}

function shouldInsertSqlCompletionSpace(): boolean {
  return props.databaseType !== "mongodb" && props.databaseType !== "redis" && props.databaseType !== "elasticsearch" && props.databaseType !== "easysearch" && props.databaseType !== "meilisearch" && props.databaseType !== "victoriametrics";
}

// Snippet expansion normally follows from the item type; a provider can also
// opt a differently-typed item in so its `${}` fields still expand on accept.
function shouldApplyCompletionAsSnippet(item: QueryCompletionItem): boolean {
  if ("applyAsSnippet" in item && item.applyAsSnippet === true) return true;
  return item.type === "snippet" || item.type === "function";
}

function completionOptionForItem(item: QueryCompletionItem | BatchColumnSelectionActionItem) {
  const filterText = "filterText" in item && typeof item.filterText === "string" ? item.filterText : undefined;
  const labelPresentation = completionLabelPresentation(item.label, filterText);
  if (isBatchColumnSelectionAction(item)) {
    return {
      ...labelPresentation,
      dbxBatchColumnSelectionAction: { sessionKey: item.sessionKey },
      type: item.type,
      detail: item.detail,
      boost: item.boost,
      apply(view: EditorViewType, _completionItem: unknown, from: number, to: number) {
        applyBatchColumnSelection(view, item, from, to);
      },
    };
  }
  const record = () => {
    recordCompletionSelection(item.label, item.type);
  };
  const batchColumnSelection = batchColumnSelectionMarkerForItem(item);
  if (shouldApplyCompletionAsSnippet(item) && item.apply) {
    const completion = codeMirrorSnippetCompletion(item.apply, {
      ...labelPresentation,
      type: item.type,
      detail: item.detail,
      info: item.info,
      boost: item.boost,
    });
    const originalApply = completion.apply;
    return cacheBatchColumnSelectionOption(batchColumnSelection, {
      ...completion,
      ...(batchColumnSelection ? { dbxBatchColumnSelection: batchColumnSelection } : {}),
      apply(view: EditorViewType, completionItem: unknown, from: number, to: number) {
        record();
        markCompletionAccepted(item);
        const replaceTo = "replaceClosingQuote" in item && item.replaceClosingQuote === view.state.sliceDoc(to, to + 1) ? to + 1 : to;
        if (typeof originalApply === "function") {
          originalApply(view, completionItem as never, from, replaceTo);
        } else {
          const insert = String(originalApply ?? item.label);
          view.dispatch({
            changes: { from, to: replaceTo, insert },
            selection: { anchor: from + insert.length },
          });
        }
        if (props.databaseType === "mongodb") {
          const position = view.state.selection.main.head;
          if (getMongoCompletionContext(view.state.doc.toString(), position).mode === "collectionRef") {
            scheduleSqlCompletionStart(view, 50);
          }
        }
      },
    });
  }
  return cacheBatchColumnSelectionOption(batchColumnSelection, {
    ...labelPresentation,
    ...(batchColumnSelection ? { dbxBatchColumnSelection: batchColumnSelection } : {}),
    type: item.type,
    detail: item.detail,
    info: item.info,
    boost: item.boost,
    apply(view: EditorViewType, _completionItem: unknown, from: number, to: number) {
      record();
      markCompletionAccepted(item);
      const replaceTo = "replaceClosingQuote" in item && item.replaceClosingQuote === view.state.sliceDoc(to, to + 1) ? to + 1 : to;
      const insert = appendSqlCompletionSpace(item.apply ?? item.label, {
        enabled: ("appendSpace" in item && item.appendSpace === true) || (shouldInsertSqlCompletionSpace() && settingsStore.editorSettings.insertSpaceAfterCompletion),
        itemType: item.type,
        nextCharacter: view.state.sliceDoc(replaceTo, replaceTo + 1),
      });
      if (codeMirrorInsertCompletionText) {
        view.dispatch(codeMirrorInsertCompletionText(view.state, insert, from, replaceTo));
      } else {
        view.dispatch({
          changes: { from, to: replaceTo, insert },
          selection: { anchor: from + insert.length },
        });
      }
    },
  });
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

  let commands;
  try {
    commands = await connectionStore.listRedisCompletionCommandDocs(props.connectionId, props.database ?? "0");
  } catch {
    // Completion is deliberately instance-driven: do not substitute a bundled
    // command list when the server does not expose command metadata.
    return null;
  }
  if (epoch !== completionEpoch) return null;

  const completionInput = { commands };
  const completionContext = getRedisCompletionContext(fullDoc, position, completionInput);
  // Key-name completion needs a reliable db index; props.database may briefly be "" on
  // the New Query path before the active db resolves, and only key-argument commands warrant it.
  let keys: string[] = [];
  if (completionContext.mode === "argument" && props.database && takesKeyArgument(completionContext.commandName, completionInput, completionContext.argumentIndex, completionContext.argumentValues)) {
    try {
      keys = await connectionStore.listRedisCompletionKeys(props.connectionId, props.database);
    } catch {
      keys = [];
    }
  }
  if (epoch !== completionEpoch) return null;

  const items = buildRedisCompletionItemsFromContext(completionContext, {
    keys,
    commands,
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
    validFor: getMongoCompletionResultValidFor(completionContext),
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
  if (props.databaseType === "meilisearch") return null;
  if (props.databaseType === "elasticsearch" || props.databaseType === "easysearch") {
    if (!isSqlLikeCompletionStatement(fullDoc, position, sqlCompletionDialectOptions())) {
      return provideElasticsearchCompletions(currentState, position, explicit);
    }
  }
  if (props.databaseType === "redis") {
    return provideRedisCompletions(currentState, position, explicit);
  }
  if (props.databaseType === "victoriametrics") return null;
  const hasDatabase = props.database != null;
  const sequenceLiteralContext = getPostgresSequenceLiteralCompletionContext(fullDoc, position, props.databaseType);

  const epoch = ++completionEpoch;

  try {
    // 1. Suppressed context (comment / string literal) rejects everything, including explicit.
    if (isSqlCompletionSuppressedContext(fullDoc, position, { databaseType: props.databaseType, editorState: currentState }) && !sequenceLiteralContext) return null;

    // 2. Determine completion origin (session-level marker).
    activeCompletionOrigin = originForSqlCompletionProvider(activeCompletionOrigin, context.explicit);
    const origin = activeCompletionOrigin;

    // 3. Explicit (manual shortcut) -> always proceed. No mode gating.
    // 4. For typing sessions, apply mode gating with lazy fact computation.
    const useDatabaseCompletion = resolveSqlServerUseDatabaseCompletion({
      sql: fullDoc,
      cursor: position,
      databaseType: props.databaseType,
    });
    const useDatabasePrefix = useDatabaseCompletion?.prefix ?? null;

    if (origin !== "explicit") {
      const mode = settingsStore.editorSettings.completionTriggerMode;

      // manual: never auto-open. Return before computing any context.
      if (mode === "manual") return null;

      // require-prefix: only compute local facts (no positionalEligible).
      if (mode === "require-prefix") {
        const ctx = sequenceLiteralContext ?? getSqlCompletionContext(fullDoc, position, sqlCompletionDialectOptions());
        const prevChar = fullDoc[position - 1] ?? "";
        const facts: SqlCompletionTriggerFacts = {
          origin,
          hasIdentifierPrefix: ctx.prefix.length > 0,
          qualifierTriggered: prevChar === "." && ("from" in ctx ? ctx.schema != null : ctx.qualifier != null),
          useDatabasePrefix,
        };
        if (!shouldAllowSqlCompletionTrigger(mode, facts)) return null;
      }

      // positional: compute positionalEligible (lazy).
      if (mode === "positional") {
        const ctx = sequenceLiteralContext ?? getSqlCompletionContext(fullDoc, position, sqlCompletionDialectOptions());
        const prevChar = fullDoc[position - 1] ?? "";
        const positionalEligible = shouldAutoOpenSqlCompletion(fullDoc, position, sqlCompletionDialectOptions());
        const facts: SqlCompletionTriggerFacts = {
          origin,
          hasIdentifierPrefix: ctx.prefix.length > 0,
          qualifierTriggered: prevChar === "." && ("from" in ctx ? ctx.schema != null : ctx.qualifier != null),
          useDatabasePrefix,
          positionalEligible,
        };
        if (!shouldAllowSqlCompletionTrigger(mode, facts)) return null;
      }
    }

    if (useDatabaseCompletion) {
      const currentDatabase = props.database ?? "";
      if (!currentDatabase) return null;
      let sqlServerContext: SqlServerCompletionContext;
      try {
        sqlServerContext = await connectionStore.getSqlServerCompletionContext(props.connectionId, currentDatabase);
      } catch {
        // Without a server-reported capability, do not suggest a USE target
        // that the current SQL Server session may be unable to switch to.
        return null;
      }
      if (sqlServerContext.supports_session_database_switch) {
        try {
          await connectionStore.listCompletionDatabases(props.connectionId);
        } catch {
          // Keep locally indexed database names available when metadata refresh fails.
        }
      }
      if (epoch !== completionEpoch) return null;
      const databaseNames = sqlServerUseCompletionDatabaseNames({
        databaseNames: connectionStore.lookupLocalCompletionDatabases(props.connectionId, useDatabaseCompletion.prefix, MAX_COMPLETION_TABLES),
        currentDatabase,
        supportsSessionDatabaseSwitch: sqlServerContext.supports_session_database_switch,
      });
      const items = buildSqlServerUseDatabaseCompletionItems(databaseNames, useDatabaseCompletion);
      return buildCompletionResult(items, useDatabaseCompletion.from, undefined, useDatabaseCompletion.prefix);
    }

    if (sequenceLiteralContext) {
      if (!hasDatabase) return null;
      const sequences = await connectionStore.listCompletionObjects(props.connectionId, props.database!, sequenceLiteralContext.prefix, MAX_COMPLETION_TABLES, sequenceLiteralContext.schema, undefined, false, undefined, ["sequence"], sequenceLiteralContext.nameQuoted);
      if (epoch !== completionEpoch) return null;
      return buildCompletionResult(buildPostgresSequenceLiteralCompletionItems(sequenceLiteralContext, sequences), sequenceLiteralContext.from, undefined, sequenceLiteralContext.prefix);
    }

    const legacyCompletionContext = getSqlCompletionContext(fullDoc, position, sqlCompletionDialectOptions());
    const semanticModel = SEMANTIC_SQL_COMPLETION_ENABLED ? buildSqlSemanticModel(fullDoc, position, sqlCompletionDialectOptions()) : null;
    let completionContext = semanticModel ? sqlCompletionContextFromSemantic(semanticModel, legacyCompletionContext) : legacyCompletionContext;

    if (!hasDatabase) {
      const items = buildSqlCompletionItemsFromContext(completionContext, {
        tables: [],
        objects: [],
        columnsByTable: new Map(),
        schemas: [],
        translations: completionTranslations.value,
        snippets: settingsStore.editorSettings.snippets,
        dialect: props.dialect,
        databaseType: snippetDatabaseType.value,
        driverProfile: sqlDriverProfile.value,
        currentSchema: props.schema,
        keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
        functionCase: settingsStore.editorSettings.sqlFormatter.functionCase,
        autoAliasTables: settingsStore.editorSettings.autoAliasTables,
      });
      return buildSqlCompletionResult(items, completionContext, fullDoc, position);
    }

    const useDatabase = props.databaseType === "sqlserver" ? sqlServerUseDatabaseBeforeCursor(fullDoc, position) : undefined;
    let knownUseDatabases: string[] | undefined;
    let supportsSessionDatabaseSwitch: boolean | undefined;
    let useDatabaseDefaultSchema: string | undefined;
    if (useDatabase) {
      try {
        const currentContext = await connectionStore.getSqlServerCompletionContext(props.connectionId, props.database!);
        supportsSessionDatabaseSwitch = currentContext.supports_session_database_switch;
        knownUseDatabases = [props.database!];
        if (supportsSessionDatabaseSwitch) {
          knownUseDatabases = mergeSqlCompletionQualifierNames(knownUseDatabases, connectionStore.lookupLocalCompletionDatabases(props.connectionId, "", MAX_COMPLETION_TABLES));
          if (!knownUseDatabases.some((database) => database.toLowerCase() === useDatabase.toLowerCase())) {
            knownUseDatabases = mergeSqlCompletionQualifierNames(knownUseDatabases, await connectionStore.listCompletionDatabases(props.connectionId));
          }
        }
        const targetDatabase = knownUseDatabases.find((database) => database.toLowerCase() === useDatabase.toLowerCase());
        if (targetDatabase) {
          const targetContext = targetDatabase.toLowerCase() === props.database!.toLowerCase() ? currentContext : await connectionStore.getSqlServerCompletionContext(props.connectionId, targetDatabase);
          useDatabaseDefaultSchema = targetContext.default_schema;
        }
      } catch {
        // An unverified USE target must not replace the selected database.
      }
      if (epoch !== completionEpoch) return null;
    }

    const completionScope = resolveSqlCompletionScope({
      sql: fullDoc,
      cursor: position,
      databaseType: props.databaseType,
      currentDatabase: props.database!,
      currentSchema: props.schema,
      knownDatabases: knownUseDatabases,
      supportsSessionDatabaseSwitch,
      useDatabaseDefaultSchema,
      completionContext,
    });
    completionContext = completionScope.completionContext;

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
        databaseType: snippetDatabaseType.value,
        driverProfile: sqlDriverProfile.value,
        currentSchema: props.schema,
        keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
        functionCase: settingsStore.editorSettings.sqlFormatter.functionCase,
        autoAliasTables: settingsStore.editorSettings.autoAliasTables,
      });
      return buildSqlCompletionResult(items, completionContext, fullDoc, position);
    }

    const tableNameCompletion = isTableNameCompletionContext(completionContext);
    const shouldResolveColumnCompletion = shouldResolveSqlColumnCompletion({
      suggestColumns: completionContext.suggestColumns,
      hasReferencedTables: completionContext.referencedTables.length > 0,
      prefix: completionContext.prefix,
      typedActivation,
      selectListColumnContext: completionContext.selectListColumnContext,
    });
    const shouldResolveAsyncCompletion = tableNameCompletion || shouldResolveColumnCompletion;
    const localResult = buildLocalSqlCompletionResult(completionContext, fullDoc, position, completionScope);
    if (localResult) {
      scheduleCompletionMetadataRefresh(completionContext, fullDoc, position, completionScope);
      const hasLocalColumnResult = localResult.options.some((option) => option.type === "column");
      if ((!explicit || typedActivation) && (!shouldResolveColumnCompletion || hasLocalColumnResult)) return localResult;
    }
    if ((!explicit || typedActivation) && !shouldResolveAsyncCompletion) {
      scheduleCompletionMetadataRefresh(completionContext, fullDoc, position, completionScope);
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
          const result = await performAsyncCompletionWithResult(epoch, completionContext, fullDoc, position, completionScope);
          resolve(result ?? localResult);
        } catch {
          resolve(localResult);
        }
      }, COMPLETION_DEBOUNCE_DELAY_MS);
    });
  } catch {
    return null;
  }
}

function isEditorComposing(currentView: EditorViewType): boolean {
  return imeCompositionActive || currentView.compositionStarted || currentView.composing;
}

// Manual-trigger shortcut (default Alt+/). Opens the completion popup on the
// explicit path so auto-trigger mode gating is bypassed. Unlike
// scheduleSqlCompletionStart, it must NOT mark the activation as typed, or the
// session would be misclassified as typing and gated for 500ms.
function triggerSqlCompletion(currentView: EditorViewType): boolean {
  if (!codeMirrorStartCompletion || isEditorComposing(currentView)) return false;
  return codeMirrorStartCompletion(currentView);
}

function scheduleSqlCompletionStart(currentView: EditorViewType, delayMs = 0) {
  window.setTimeout(() => {
    if (!codeMirrorStartCompletion || isEditorComposing(currentView)) return;
    markTypedCompletionActivation();
    activeCompletionOrigin = originForTypedSqlCompletionStart(activeCompletionOrigin);
    codeMirrorStartCompletion(currentView);
  }, delayMs);
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
  const fullDoc = currentView.state.doc.toString();
  const position = currentView.state.selection.main.head;
  if (shouldTriggerSqlCompletionForPosition(fullDoc, position)) {
    scheduleSqlCompletionStart(currentView);
  }
}

/**
 * Returns true when the current SQL position should trigger completion under the active trigger mode.
 * Used by flushImeComposition and shouldStartSqlCompletionAfterInput.
 */
function shouldTriggerSqlCompletionForPosition(fullDoc: string, position: number): boolean {
  const sequenceLiteralContext = getPostgresSequenceLiteralCompletionContext(fullDoc, position, props.databaseType);
  if (isSqlCompletionSuppressedContext(fullDoc, position, { databaseType: props.databaseType, editorState: view.value?.state }) && !sequenceLiteralContext) return false;
  const mode = settingsStore.editorSettings.completionTriggerMode;
  if (mode === "manual") return false;

  const useDatabaseCompletion = resolveSqlServerUseDatabaseCompletion({
    sql: fullDoc,
    cursor: position,
    databaseType: props.databaseType,
  });
  const useDatabasePrefix = useDatabaseCompletion?.prefix ?? null;

  if (mode === "require-prefix") {
    const ctx = sequenceLiteralContext ?? getSqlCompletionContext(fullDoc, position, sqlCompletionDialectOptions());
    const prevChar = fullDoc[position - 1] ?? "";
    const facts: SqlCompletionTriggerFacts = {
      origin: "typing",
      hasIdentifierPrefix: ctx.prefix.length > 0,
      qualifierTriggered: prevChar === "." && ("from" in ctx ? ctx.schema != null : ctx.qualifier != null),
      useDatabasePrefix,
    };
    return shouldAllowSqlCompletionTrigger(mode, facts);
  }

  // positional
  const ctx = sequenceLiteralContext ?? getSqlCompletionContext(fullDoc, position, sqlCompletionDialectOptions());
  const prevChar = fullDoc[position - 1] ?? "";
  const positionalEligible = shouldAutoOpenSqlCompletion(fullDoc, position, sqlCompletionDialectOptions());
  const facts: SqlCompletionTriggerFacts = {
    origin: "typing",
    hasIdentifierPrefix: ctx.prefix.length > 0,
    qualifierTriggered: prevChar === "." && ("from" in ctx ? ctx.schema != null : ctx.qualifier != null),
    useDatabasePrefix,
    positionalEligible,
  };
  return shouldAllowSqlCompletionTrigger(mode, facts);
}

function shouldStartSqlCompletionAfterInput(insertedText: string, removedText: string, currentView: EditorViewType): boolean {
  const position = currentView.state.selection.main.head;
  const fullDoc = currentView.state.doc.toString();

  // Non-SQL providers: keep existing behavior (trigger mode policy does not apply).
  if (props.databaseType === "mongodb") {
    return !!(insertedText || removedText) && shouldAutoOpenMongoCompletion(fullDoc, position);
  }
  if (props.databaseType === "victoriametrics" || props.databaseType === "meilisearch") return false;
  if (props.databaseType === "redis" || props.databaseType === "elasticsearch" || props.databaseType === "easysearch") {
    // Preserve old character-based checks for non-SQL providers.
    if (!insertedText && removedText) {
      const completionContext = getSqlCompletionContext(fullDoc, position, sqlCompletionDialectOptions());
      return isTableNameCompletionContext(completionContext) && shouldAutoOpenSqlCompletion(fullDoc, position, sqlCompletionDialectOptions());
    }
    if (insertedText.endsWith(".")) return true;
    if (/[,(]$/.test(insertedText)) {
      const completionContext = getSqlCompletionContext(fullDoc, position, sqlCompletionDialectOptions());
      return !!completionContext.insertTable;
    }
    if (/\s$/.test(insertedText)) {
      return shouldAutoOpenSqlCompletion(fullDoc, position, sqlCompletionDialectOptions());
    }
    if (!/[\w$@]$/.test(insertedText)) return false;
    const completionContext = getSqlCompletionContext(fullDoc, position, sqlCompletionDialectOptions());
    return isTableNameCompletionContext(completionContext) || shouldAutoOpenSqlCompletion(fullDoc, position, sqlCompletionDialectOptions());
  }

  // SQL providers: use unified trigger mode policy.
  return shouldTriggerSqlCompletionForPosition(fullDoc, position);
}

function buildLocalSqlCompletionResult(completionContext: ReturnType<typeof getSqlCompletionContext>, fullDoc: string, position: number, scope: CompletionMetadataScope) {
  if (!props.connectionId || props.database == null) return null;
  const databaseNames = localCompletionDatabaseNames(completionContext);
  const currentDatabaseSchemaNames = localCompletionSchemasForDatabaseDisambiguation(completionContext, databaseNames, scope);
  const schemaLookupDatabase = resolveSqlCompletionSchemaLookupDatabase({
    supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
    completionContext,
    knownDatabases: databaseNames,
    knownSchemas: currentDatabaseSchemaNames,
  });
  const shouldLoadTables = !schemaLookupDatabase && (completionContext.suggestTables || (!!completionContext.qualifier && !isReferencedTableQualifier(completionContext)));
  const tableLookupTarget = resolveSqlCompletionTableLookupTarget({
    currentDatabase: scope.database,
    currentSchema: scope.schema,
    supportsDatabaseQualifier: supportsDatabaseQualifierCompletion(),
    supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
    completionContext,
    knownDatabases: databaseNames,
  });
  const globalOracleTableSearch = props.databaseType === "oracle" && completionContext.suggestTables && !completionContext.qualifier;
  const tables = schemaLookupDatabase ? [] : shouldLoadTables ? connectionStore.lookupLocalCompletionTables(props.connectionId, tableLookupTarget.database, tableLookupTarget.filter, MAX_COMPLETION_TABLES, globalOracleTableSearch ? undefined : tableLookupTarget.schema, props.catalog) : cachedTables;

  const shouldLoadObjects = shouldLoadCompletionObjects(completionContext);
  const completionObjectScope = routineCompletionScopeForContext(completionContext, scope);
  const scopedCachedCompletionObjects = completionObjectsForScope(completionObjectScope);
  const completionObjects = shouldLoadObjects ? lookupLocalCompletionObjectsForContext(completionContext, scope) : scopedCachedCompletionObjects;

  const schemaNames =
    completionContext.suggestTables && !completionContext.insertTable
      ? schemaLookupDatabase
        ? connectionStore.lookupLocalCompletionSchemas(props.connectionId, schemaLookupDatabase, completionContext.prefix, MAX_COMPLETION_TABLES)
        : !completionContext.qualifier
          ? mergeSqlCompletionQualifierNames(connectionStore.lookupLocalCompletionSchemas(props.connectionId, scope.database, completionContext.prefix, MAX_COMPLETION_TABLES), databaseNames)
          : []
      : [];

  const columnsByTable = new Map<string, SqlCompletionColumn[]>();
  if (completionContext.insertTable) {
    const insertDatabase = (supportsDatabaseSchemaQualifierCompletion() ? completionContext.insertDatabase : undefined) ?? scope.database;
    const insertSchema = completionContext.insertSchema ?? scope.schema;
    const insertColumns = usesOracleSessionCompletionColumns(insertSchema) ? [] : connectionStore.lookupLocalCompletionColumns(props.connectionId, insertDatabase, completionContext.insertTable, insertSchema, props.catalog);
    if (insertColumns.length > 0) {
      columnsByTable.set(completionCacheKey({ name: completionContext.insertTable, database: completionContext.insertDatabase, schema: insertSchema }, scope), insertColumns);
    }
  }

  const qualifiedColumnTarget = completionQualifiedTableTarget(completionContext);
  if (qualifiedColumnTarget) {
    const reference = completionContext.referencedTables.find((table) => completionTablesMatch(table, qualifiedColumnTarget));
    const qualifiedCacheTable = { ...qualifiedColumnTarget, nameQuoted: reference?.nameQuoted, schemaQuoted: reference?.schemaQuoted };
    const cacheKey = completionCacheKey(qualifiedCacheTable, scope);
    const cachedPrefix = completionContext.prefix.length >= 2 && (props.databaseType === "postgres" || props.databaseType === "mysql") ? lookupCachedPrefixColumns(qualifiedCacheTable, scope, completionContext.prefix) : undefined;
    const cached = cachedPrefix ?? cachedColumnsByTable.get(cacheKey);
    if (cached) {
      columnsByTable.set(cacheKey, cached);
    } else {
      const target = completionMetadataTarget(qualifiedColumnTarget, scope);
      const prefixColumns =
        target && completionContext.prefix.length >= 2 && (props.databaseType === "postgres" || props.databaseType === "mysql")
          ? connectionStore.lookupLocalCompletionColumnsByPrefix(props.connectionId, target.database, qualifiedColumnTarget.name, target.schema, completionContext.prefix, target.catalog, completionColumnRequestContext(reference))
          : [];
      const localColumns =
        prefixColumns.length > 0
          ? prefixColumns
          : target && !usesOracleSessionCompletionColumns(target.schema)
            ? connectionStore.lookupLocalCompletionColumns(props.connectionId, target.database, qualifiedColumnTarget.name, target.schema, target.catalog, completionColumnRequestContext(reference))
            : [];
      if (localColumns.length > 0) {
        columnsByTable.set(cacheKey, localColumns);
      }
    }
  }

  const cteDefs = extractCteDefinitions(fullDoc);
  for (const refTable of completionContext.referencedTables) {
    if (isVirtualCompletionTableReference(refTable)) continue;
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
    const cacheKey = completionCacheKey(refTable, scope);
    const prefixCompletion =
      (props.databaseType === "postgres" || props.databaseType === "mysql") &&
      completionContext.qualifier &&
      completionContext.prefix.length >= 2 &&
      isReferencedTableQualifier(completionContext) &&
      (refTable.alias?.toLowerCase() === completionContext.qualifier.toLowerCase() || refTable.name.toLowerCase() === completionContext.qualifier.toLowerCase())
        ? completionContext.prefix
        : undefined;
    const cached = (prefixCompletion ? lookupCachedPrefixColumns(refTable, scope, prefixCompletion) : undefined) ?? cachedColumnsByTable.get(cacheKey);
    if (cached) {
      columnsByTable.set(cacheKey, cached);
      continue;
    }
    const target = completionMetadataTarget(refTable, scope);
    const prefixColumns = target && prefixCompletion ? connectionStore.lookupLocalCompletionColumnsByPrefix(props.connectionId, target.database, refTable.name, target.schema, prefixCompletion, target.catalog, refTable) : [];
    const localColumns = prefixColumns.length > 0 ? prefixColumns : target && !usesOracleSessionCompletionColumns(target.schema) ? connectionStore.lookupLocalCompletionColumns(props.connectionId, target.database, refTable.name, target.schema, target.catalog, refTable) : [];
    if (localColumns.length > 0) {
      columnsByTable.set(cacheKey, localColumns);
    }
    const localForeignKeys = target ? connectionStore.lookupLocalCompletionForeignKeys(props.connectionId, target.database, refTable.name, target.schema) : [];
    if (localForeignKeys.length > 0) {
      cachedForeignKeysByTable.set(cacheKey, localForeignKeys);
    }
  }

  if (
    tables.length === 0 &&
    completionObjects.length === 0 &&
    schemaNames.length === 0 &&
    columnsByTable.size === 0 &&
    !driverProfileHasCompletionCandidates(sqlDriverProfile.value, completionContext) &&
    (completionContext.exclusiveTableSuggestions || completionContext.exclusiveColumnSuggestions || completionContext.exclusiveRoutineSuggestions)
  ) {
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
    databaseType: snippetDatabaseType.value,
    driverProfile: sqlDriverProfile.value,
    currentSchema: scope.schema,
    keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
    functionCase: settingsStore.editorSettings.sqlFormatter.functionCase,
    autoAliasTables: settingsStore.editorSettings.autoAliasTables,
  });

  return buildSqlCompletionResult(items, completionContext, fullDoc, position);
}

function scheduleCompletionMetadataRefresh(completionContext: ReturnType<typeof getSqlCompletionContext>, fullDoc: string, position: number, scope: CompletionMetadataScope) {
  if (!props.connectionId || props.database == null) return;
  const localOnlyMetadata = usesLocalOnlyCompletionMetadata();
  const onDemandOnlyColumns = usesOnDemandOnlyCompletionColumns();
  const tableNameCompletion = isTableNameCompletionContext(completionContext);
  const connectionId = props.connectionId;
  const database = scope.database;
  const databaseNames = localCompletionDatabaseNames(completionContext);
  const currentDatabaseSchemaNames = localCompletionSchemasForDatabaseDisambiguation(completionContext, databaseNames, scope);
  const schemaLookupDatabase = resolveSqlCompletionSchemaLookupDatabase({
    supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
    completionContext,
    knownDatabases: databaseNames,
    knownSchemas: currentDatabaseSchemaNames,
  });
  const tableLookupTarget = resolveSqlCompletionTableLookupTarget({
    currentDatabase: database,
    currentSchema: scope.schema,
    supportsDatabaseQualifier: supportsDatabaseQualifierCompletion(),
    supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
    completionContext,
    knownDatabases: databaseNames,
  });
  if (!localOnlyMetadata && !schemaLookupDatabase && (completionContext.suggestTables || (!!completionContext.qualifier && !isReferencedTableQualifier(completionContext)))) {
    const globalOracleTableSearch = props.databaseType === "oracle" && completionContext.suggestTables && !completionContext.qualifier;
    const refreshEpoch = completionEpoch;
    queueTableCompletionRefresh(async () => {
      if (refreshEpoch !== completionEpoch) return;
      try {
        const tables = await connectionStore.refreshCompletionTables(connectionId, tableLookupTarget.database, tableLookupTarget.filter, MAX_COMPLETION_TABLES, tableLookupTarget.schema, globalOracleTableSearch, scope.schema, props.catalog);
        if (refreshEpoch !== completionEpoch) return;
        const scopedTables = tables.map((table) => ({ ...table, database: table.database ?? tableLookupTarget.database }));
        cachedTables = mergeCompletionTables(cachedTables, scopedTables);
        if (completionContext.suggestJoinConditions && completionContext.referencedTables.length > 0) {
          void ensureForeignKeysForTables(completionContext.referencedTables);
        }
      } catch {
        // Local candidates remain available when the remote refresh fails.
      }
    });
  }
  if (!localOnlyMetadata && shouldLoadCompletionObjects(completionContext)) {
    const completionObjectScope = routineCompletionScopeForContext(completionContext, scope);
    void listCompletionObjectsForContext(completionContext, scope)
      .then((objects) => {
        const cachedObjects = completionObjectsForScope(completionObjectScope);
        const merged = mergeCompletionObjects(cachedObjects, objects);
        const changed = completionObjectsDiffer(cachedObjects, merged);
        cachedCompletionObjectsByScope.set(completionObjectScopeKey(completionObjectScope), merged);
        if (changed) refreshActiveSqlCompletion(fullDoc, position, completionContext);
      })
      .catch(() => {});
  }
  if (!localOnlyMetadata && completionContext.suggestTables && !completionContext.insertTable) {
    if (schemaLookupDatabase) {
      void connectionStore.refreshCompletionSchemas(connectionId, schemaLookupDatabase).catch(() => {});
    } else if (!completionContext.qualifier) {
      void connectionStore.refreshCompletionSchemas(connectionId, database).catch(() => {});
      if (supportsDatabaseNameCompletion(props.databaseType)) {
        void connectionStore.refreshCompletionDatabases(connectionId).catch(() => {});
      }
    }
  }
  if (!onDemandOnlyColumns && completionContext.insertTable) {
    const insertTable = completionContext.insertTable;
    const insertDatabase = (supportsDatabaseSchemaQualifierCompletion() ? completionContext.insertDatabase : undefined) ?? database;
    void refreshCompletionColumnsForEditor(connectionId, insertDatabase, insertTable, completionContext.insertSchema ?? scope.schema)
      .then((columns) => {
        const insertSchema = completionContext.insertSchema ?? scope.schema;
        cachedColumnsByTable.set(completionCacheKey({ name: insertTable, database: completionContext.insertDatabase, schema: insertSchema }, scope), columns);
      })
      .catch(() => {});
  }
  const qualifiedColumnTarget = completionQualifiedTableTarget(completionContext);
  const qualifiedColumnCacheKey = qualifiedColumnTarget ? completionCacheKey(qualifiedColumnTarget, scope) : undefined;
  if (!onDemandOnlyColumns && qualifiedColumnTarget && qualifiedColumnCacheKey && !cachedColumnsByTable.has(qualifiedColumnCacheKey)) {
    const target = completionMetadataTarget(qualifiedColumnTarget, scope);
    if (target) {
      void refreshCompletionColumnsForEditor(connectionId, target.database, qualifiedColumnTarget.name, target.schema, target.catalog)
        .then((columns) => {
          if (columns.length > 0) cachedColumnsByTable.set(qualifiedColumnCacheKey, columns);
        })
        .catch(() => {});
    }
  }
  if (!onDemandOnlyColumns && !tableNameCompletion) {
    for (const refTable of completionContext.referencedTables) {
      if (isVirtualCompletionTableReference(refTable)) continue;
      if (refTable.columns && refTable.columns.length > 0) continue;
      const cacheKey = completionCacheKey(refTable, scope);
      if (cacheKey === qualifiedColumnCacheKey) continue;
      if (cachedColumnsByTable.has(cacheKey)) continue;
      const target = completionMetadataTarget(refTable, scope);
      if (!target) continue;
      void refreshCompletionColumnsForEditor(connectionId, target.database, refTable.name, target.schema, target.catalog, refTable)
        .then((columns) => {
          if (columns.length > 0) cachedColumnsByTable.set(cacheKey, columns);
        })
        .catch(() => {});
    }
  }
  if (!tableNameCompletion && completionContext.suggestJoinConditions && completionContext.referencedTables.length > 0) {
    void ensureForeignKeysForTables(completionContext.referencedTables);
  }
}

function mergeCompletionTables(existing: SqlCompletionTable[], incoming: SqlCompletionTable[]): SqlCompletionTable[] {
  const merged = [...existing];
  const indexes = new Map(existing.map((table, index) => [`${table.catalog ?? ""}.${table.database ?? ""}.${table.schema ?? ""}.${table.name}`.toLowerCase(), index]));
  for (const table of incoming) {
    const key = `${table.catalog ?? ""}.${table.database ?? ""}.${table.schema ?? ""}.${table.name}`.toLowerCase();
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

function listCompletionTablesWithLatencyBudget(connectionId: string, database: string, filter: string, limit: number, schema?: string, globalSearch = false, catalog = props.catalog, currentSchema = props.schema): Promise<SqlCompletionTable[]> {
  const local = connectionStore.lookupLocalCompletionTables(connectionId, database, filter, limit, globalSearch ? undefined : schema, catalog).map((table) => ({ ...table, catalog: table.catalog ?? catalog, database: table.database ?? database }));
  const remote = connectionStore.listCompletionTables(connectionId, database, filter, limit, schema, globalSearch, currentSchema, catalog).then((tables) => {
    const scopedTables = tables.map((table) => ({ ...table, catalog: table.catalog ?? catalog, database: table.database ?? database }));
    cachedTables = mergeCompletionTables(cachedTables, scopedTables);
    return scopedTables;
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
  // Doris/StarRocks external catalogs currently expose table and column
  // metadata through catalog-aware APIs. The generic routine/object endpoint
  // is catalogless and would query the internal catalog, aborting completion.
  if (props.catalog) return false;
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

function routineCompletionTargetForContext(completionContext: ReturnType<typeof getSqlCompletionContext>, scope: CompletionMetadataScope) {
  return resolveSqlCompletionRoutineLookupTarget({
    currentDatabase: scope.database,
    currentSchema: scope.schema,
    supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
    completionContext,
  });
}

function routineCompletionScopeForContext(completionContext: ReturnType<typeof getSqlCompletionContext>, scope: CompletionMetadataScope): CompletionMetadataScope {
  if (props.databaseType === "oracle") return scope;
  const target = routineCompletionTargetForContext(completionContext, scope);
  return { database: target.database, schema: target.schema };
}

function lookupLocalCompletionObjectsForContext(completionContext: ReturnType<typeof getSqlCompletionContext>, scope: CompletionMetadataScope): SqlCompletionObject[] {
  if (!props.connectionId || props.database == null) return [];
  if (props.databaseType === "oracle") {
    return connectionStore.lookupLocalCompletionObjects(props.connectionId, scope.database, completionContext.prefix, MAX_COMPLETION_TABLES);
  }
  const target = routineCompletionTargetForContext(completionContext, scope);
  return connectionStore.lookupLocalCompletionObjects(props.connectionId, target.database, target.mask, MAX_COMPLETION_TABLES, target.schema);
}

async function listCompletionObjectsForContext(completionContext: ReturnType<typeof getSqlCompletionContext>, scope: CompletionMetadataScope): Promise<SqlCompletionObject[]> {
  if (!props.connectionId || props.database == null) return [];
  const objectKinds = completionObjectKindsForContext(completionContext);
  if (props.databaseType !== "oracle") {
    const target = routineCompletionTargetForContext(completionContext, scope);
    return connectionStore.listCompletionObjects(props.connectionId, target.database, target.mask, MAX_COMPLETION_TABLES, target.schema, undefined, false, scope.schema, objectKinds);
  }
  const groups = await Promise.all(
    oracleRoutineCompletionTargets(completionContext).map((target) => connectionStore.listCompletionObjects(props.connectionId!, scope.database, completionContext.prefix, MAX_COMPLETION_TABLES, target.schema, target.parentName, target.globalSearch, scope.schema, objectKinds)),
  );
  return groups.reduce((objects, group) => mergeCompletionObjects(objects, group), [] as SqlCompletionObject[]);
}

function completionObjectKindsForContext(completionContext: ReturnType<typeof getSqlCompletionContext>): CompletionAssistantObjectKind[] {
  if (completionContext.contextKind === "exec") return ["procedure"];
  if (completionContext.suggestColumns && completionContext.referencedTables.length > 0 && !completionContext.qualifier) return ["function"];
  return ["routine"];
}

async function performAsyncCompletionWithResult(epoch: number, completionContext: ReturnType<typeof getSqlCompletionContext>, fullDoc: string, position: number, scope: CompletionMetadataScope) {
  const localOnlyMetadata = usesLocalOnlyCompletionMetadata();
  const onDemandOnlyColumns = usesOnDemandOnlyCompletionColumns();
  // Handle INSERT column list: fetch columns for the target table
  let insertColumnsByTable = new Map<string, SqlCompletionColumn[]>();
  if (completionContext.insertTable) {
    try {
      const insertDatabase = (supportsDatabaseSchemaQualifierCompletion() ? completionContext.insertDatabase : undefined) ?? scope.database;
      const insertCols = await listCompletionColumnsForEditor(props.connectionId!, insertDatabase, completionContext.insertTable, completionContext.insertSchema ?? scope.schema);
      if (epoch !== completionEpoch) return null;
      if (insertCols.length > 0) {
        const insertSchema = completionContext.insertSchema ?? scope.schema;
        const insertKey = completionCacheKey({ name: completionContext.insertTable, database: completionContext.insertDatabase, schema: insertSchema }, scope);
        insertColumnsByTable.set(insertKey, insertCols);
      }
    } catch {
      // ignore
    }
  }

  let databaseNames = localCompletionDatabaseNames(completionContext);
  let currentDatabaseSchemaNames = localCompletionSchemasForDatabaseDisambiguation(completionContext, databaseNames, scope);
  const mayCompleteDatabaseSchema = mayCompleteDatabaseSchemaQualifier(completionContext);
  if (!localOnlyMetadata && supportsDatabaseNameCompletion(props.databaseType) && completionContext.suggestTables && !completionContext.insertTable && (!completionContext.qualifier || mayCompleteDatabaseSchema)) {
    const [databasesResult, schemasResult] = await Promise.allSettled([connectionStore.listCompletionDatabases(props.connectionId!), mayCompleteDatabaseSchema ? connectionStore.listCompletionSchemas(props.connectionId!, scope.database) : Promise.resolve(currentDatabaseSchemaNames)]);
    databaseNames = databasesResult.status === "fulfilled" ? databasesResult.value : [];
    if (schemasResult.status === "fulfilled") currentDatabaseSchemaNames = mergeSqlCompletionQualifierNames(scope.schema ? [scope.schema] : [], schemasResult.value);
    if (epoch !== completionEpoch) return null;
  }
  const schemaLookupDatabase = resolveSqlCompletionSchemaLookupDatabase({
    supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
    completionContext,
    knownDatabases: databaseNames,
    knownSchemas: currentDatabaseSchemaNames,
  });
  const shouldLoadTables = !schemaLookupDatabase && (completionContext.suggestTables || (!!completionContext.qualifier && !isReferencedTableQualifier(completionContext)));
  const tableLookupTarget = resolveSqlCompletionTableLookupTarget({
    currentDatabase: scope.database,
    currentSchema: scope.schema,
    supportsDatabaseQualifier: supportsDatabaseQualifierCompletion(),
    supportsDatabaseSchemaQualifier: supportsDatabaseSchemaQualifierCompletion(),
    completionContext,
    knownDatabases: databaseNames,
  });
  const globalOracleTableSearch = props.databaseType === "oracle" && completionContext.suggestTables && !completionContext.qualifier;
  let tables = schemaLookupDatabase
    ? []
    : shouldLoadTables
      ? localOnlyMetadata
        ? connectionStore.lookupLocalCompletionTables(props.connectionId!, tableLookupTarget.database, tableLookupTarget.filter, MAX_COMPLETION_TABLES, globalOracleTableSearch ? undefined : tableLookupTarget.schema, props.catalog)
        : await listCompletionTablesWithLatencyBudget(props.connectionId!, tableLookupTarget.database, tableLookupTarget.filter, MAX_COMPLETION_TABLES, tableLookupTarget.schema, globalOracleTableSearch, props.catalog, scope.schema)
      : cachedTables;
  if (localOnlyMetadata && tables.length === 0 && supportsDatabaseSchemaQualifierCompletion() && (completionContext.qualifierParts?.length ?? 0) >= 2 && allowsOnDemandQualifiedTableCompletion(completionContext.prefix)) {
    tables = await listCompletionTablesWithLatencyBudget(props.connectionId!, tableLookupTarget.database, tableLookupTarget.filter, PRESTO_ON_DEMAND_TABLE_COMPLETION_LIMIT, tableLookupTarget.schema, false, props.catalog, scope.schema);
  }
  if (epoch !== completionEpoch) return null;

  const shouldLoadObjects = shouldLoadCompletionObjects(completionContext);
  const completionObjectScope = routineCompletionScopeForContext(completionContext, scope);
  const scopedCachedCompletionObjects = completionObjectsForScope(completionObjectScope);
  let completionObjects = shouldLoadObjects ? (localOnlyMetadata ? lookupLocalCompletionObjectsForContext(completionContext, scope) : await listCompletionObjectsForContext(completionContext, scope)) : scopedCachedCompletionObjects;
  if (epoch !== completionEpoch) return null;

  if (!props.catalog && props.databaseType !== "oracle" && !localOnlyMetadata && completionContext.qualifier && completionObjects.length === 0) {
    const target = routineCompletionTargetForContext(completionContext, scope);
    const schemaObjects = await connectionStore.listCompletionObjects(props.connectionId!, target.database, target.mask, MAX_COMPLETION_TABLES, target.schema, undefined, false, scope.schema);
    if (schemaObjects.length > 0) {
      completionObjects = schemaObjects;
    }
    if (epoch !== completionEpoch) return null;
  }
  cachedCompletionObjectsByScope.set(completionObjectScopeKey(completionObjectScope), mergeCompletionObjects(scopedCachedCompletionObjects, completionObjects));

  // Fetch schemas for schema completion
  let schemaNames: string[] = [];
  if (completionContext.suggestTables && !completionContext.insertTable && (schemaLookupDatabase || !completionContext.qualifier)) {
    const database = schemaLookupDatabase ?? scope.database;
    if (localOnlyMetadata) {
      const schemas = connectionStore.lookupLocalCompletionSchemas(props.connectionId!, database, completionContext.prefix, MAX_COMPLETION_TABLES);
      schemaNames = schemaLookupDatabase ? schemas : mergeSqlCompletionQualifierNames(schemas, databaseNames);
    } else {
      try {
        const schemas = await connectionStore.listCompletionSchemas(props.connectionId!, database);
        schemaNames = schemaLookupDatabase ? schemas : mergeSqlCompletionQualifierNames(schemas, databaseNames);
        if (epoch !== completionEpoch) return null;
      } catch {
        schemaNames = schemaLookupDatabase ? [] : databaseNames;
      }
    }
  }

  // If qualifier didn't match any table names, try it as a schema name
  let qualifierIsSchema = false;
  if (completionContext.qualifier && !schemaLookupDatabase && !tableLookupTarget.qualifierDatabase && !isReferencedTableQualifier(completionContext) && tables.length === 0 && (completionContext.suggestTables || completionContext.exclusiveColumnSuggestions)) {
    let schemaTables = connectionStore.lookupLocalCompletionTables(props.connectionId!, scope.database, completionContext.prefix, MAX_COMPLETION_TABLES, completionContext.qualifier, props.catalog);
    if (!localOnlyMetadata) {
      schemaTables = await listCompletionTablesWithLatencyBudget(props.connectionId!, scope.database, completionContext.prefix, MAX_COMPLETION_TABLES, completionContext.qualifier, false, props.catalog, scope.schema);
    } else if (schemaTables.length === 0 && allowsOnDemandQualifiedTableCompletion(completionContext.prefix)) {
      schemaTables = await listCompletionTablesWithLatencyBudget(props.connectionId!, scope.database, completionContext.prefix, PRESTO_ON_DEMAND_TABLE_COMPLETION_LIMIT, completionContext.qualifier, false, props.catalog, scope.schema);
    }
    if (schemaTables.length > 0) {
      tables = schemaTables;
      qualifierIsSchema = true;
    }
    if (epoch !== completionEpoch) return null;
  }

  // Collect referenced tables — enrich with schema from filtered table lookup
  let refs = completionContext.referencedTables.map((rt) => {
    if (usesOracleSessionCompletionColumns(rt.schema)) return rt;
    if (!rt.schema) {
      const cached = tables.find((t) => t.name.toLowerCase() === rt.name.toLowerCase());
      if (cached && cached.schema) {
        return { ...rt, schema: cached.schema };
      }
    }
    return rt;
  });
  const unresolvedRefs = refs.filter((rt) => !usesOracleSessionCompletionColumns(rt.schema) && !rt.schema && !rt.columns && !isVirtualCompletionTableReference(rt));
  if (!localOnlyMetadata && unresolvedRefs.length > 0) {
    const lookupGroups = await Promise.all(
      unresolvedRefs.map((rt) => {
        const target = completionMetadataTarget(rt, scope);
        return connectionStore.listCompletionTables(props.connectionId!, target?.database ?? scope.database, rt.name, 20, target?.schema ?? scope.schema, false, scope.schema, target?.catalog ?? props.catalog);
      }),
    );
    if (epoch !== completionEpoch) return null;
    const lookupTables = lookupGroups.flat();
    refs = refs.map((rt) => {
      if (usesOracleSessionCompletionColumns(rt.schema)) return rt;
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
  const hasQualifiedColumnPrefix = (props.databaseType === "postgres" || props.databaseType === "mysql") && completionContext.qualifier && completionContext.prefix.length >= 2 && isReferencedTableQualifier(completionContext);
  const columnRefs = hasQualifiedColumnPrefix
    ? refs.filter((refTable) => refTable.alias?.toLowerCase() === completionContext.qualifier!.toLowerCase() || refTable.name.toLowerCase() === completionContext.qualifier!.toLowerCase() || (!!qualifiedColumnTarget && completionTablesMatch(refTable, qualifiedColumnTarget)))
    : refs.slice(0, 4);
  if (shouldFetchColumnsForCompletion) {
    await Promise.all(
      columnRefs.map(async (refTable) => {
        if (isVirtualCompletionTableReference(refTable)) return;
        if (refTable.columns && refTable.columns.length > 0) return;
        const cacheKey = completionCacheKey(refTable, scope);
        const prefixCompletion = hasQualifiedColumnPrefix ? completionContext.prefix : undefined;
        const prefixCacheKey = prefixCompletion ? completionPrefixCacheKey(refTable, scope, prefixCompletion) : undefined;
        if (prefixCompletion ? lookupCachedPrefixColumns(refTable, scope, prefixCompletion) : cachedColumnsByTable.has(cacheKey)) return;
        try {
          const target = completionMetadataTarget(refTable, scope);
          if (!target) return;
          const columns = await listCompletionColumnsForEditor(props.connectionId!, target.database, refTable.name, target.schema, target.catalog, refTable, prefixCompletion);
          if (epoch !== completionEpoch) return;
          if (columns.length === 0) return;
          if (prefixCacheKey) cachedPrefixColumnsByTable.set(prefixCacheKey, columns);
          else cachedColumnsByTable.set(cacheKey, columns);
        } catch (e) {
          console.error(`[DBX] Failed to load columns for ${cacheKey}:`, e);
        }
      }),
    );
  }
  if (epoch !== completionEpoch) return null;

  if (!tableNameCompletion && completionContext.suggestJoinConditions && refs.length > 0) {
    await ensureForeignKeysForTables(refs.filter((table) => !("columns" in table) || !table.columns || table.columns.length === 0));
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
      if (hasQualifiedColumnPrefix && !columnRefs.includes(refTable)) continue;
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
      const cacheKey = completionCacheKey(refTable, scope);
      const prefixCompletion =
        (props.databaseType === "postgres" || props.databaseType === "mysql") &&
        completionContext.qualifier &&
        completionContext.prefix.length >= 2 &&
        isReferencedTableQualifier(completionContext) &&
        (refTable.alias?.toLowerCase() === completionContext.qualifier.toLowerCase() || refTable.name.toLowerCase() === completionContext.qualifier.toLowerCase())
          ? completionContext.prefix
          : undefined;
      const cached = (prefixCompletion ? lookupCachedPrefixColumns(refTable, scope, prefixCompletion) : undefined) ?? cachedColumnsByTable.get(cacheKey);
      if (cached) {
        columnsByTable.set(cacheKey, cached);
      }
      let cachedForeignKeys = cachedForeignKeysByTable.get(cacheKey);
      if (!cachedForeignKeys) {
        const target = completionMetadataTarget(refTable, scope);
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
    databaseType: snippetDatabaseType.value,
    driverProfile: sqlDriverProfile.value,
    currentSchema: scope.schema,
    keywordCase: settingsStore.editorSettings.sqlFormatter.keywordCase,
    functionCase: settingsStore.editorSettings.sqlFormatter.functionCase,
    autoAliasTables: settingsStore.editorSettings.autoAliasTables,
  });

  return buildSqlCompletionResult(items, completionContext, fullDoc, position);
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
  const indexes = new Map(existing.map((object, index) => [completionObjectIdentityKey(object), index]));
  for (const object of incoming) {
    const key = completionObjectIdentityKey(object);
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

function completionObjectScopeKey(scope: CompletionMetadataScope): string {
  return `${scope.database}:${scope.schema ?? ""}`.toLowerCase();
}

function completionObjectsForScope(scope: CompletionMetadataScope): SqlCompletionObject[] {
  return cachedCompletionObjectsByScope.get(completionObjectScopeKey(scope)) ?? [];
}

function completionObjectIdentityKey(object: SqlCompletionObject): string {
  return `${object.type}:${object.schema ?? ""}:${object.name}:${object.parentName ?? ""}:${object.signature?.trim() ?? ""}`.toLowerCase();
}

function completionObjectsDiffer(existing: SqlCompletionObject[], incoming: SqlCompletionObject[]): boolean {
  if (existing.length !== incoming.length) return true;
  return existing.some((object, index) => {
    const other = incoming[index];
    return (
      !other ||
      object.name !== other.name ||
      object.schema !== other.schema ||
      object.type !== other.type ||
      object.parentSchema !== other.parentSchema ||
      object.parentName !== other.parentName ||
      object.dataType !== other.dataType ||
      object.signature !== other.signature ||
      object.comment !== other.comment ||
      object.applyName !== other.applyName ||
      object.boost !== other.boost
    );
  });
}

function refreshActiveSqlCompletion(fullDoc: string, position: number, completionContext: ReturnType<typeof getSqlCompletionContext>) {
  const currentView = view.value;
  if (!currentView || codeMirrorCompletionStatus?.(currentView.state) !== "active") return;
  if (currentView.state.doc.toString() !== fullDoc || currentView.state.selection.main.head !== position) return;
  const currentContext = getSqlCompletionContext(fullDoc, position);
  if (currentContext.prefix !== completionContext.prefix || currentContext.contextKind !== completionContext.contextKind) return;
  scheduleSqlCompletionStart(currentView);
}

function refreshCompletionCache() {
  cachedTables = [];
  cachedCompletionObjectsByScope.clear();
  cachedColumnsByTable.clear();
  cachedPrefixColumnsByTable.clear();
  cachedInsertValueHintColumnsByTable.clear();
  loadedColumnsByTable.clear();
  cachedForeignKeysByTable.clear();
}

function defaultKeymapExtension() {
  if (!editorViewModule || !codeMirrorDefaultKeymap || !codeMirrorToggleBlockComment) return [];
  return editorViewModule.keymap.of(defaultKeymapForGlobalShortcuts(codeMirrorDefaultKeymap, settingsStore.editorSettings.shortcuts).filter((item) => item.run !== codeMirrorToggleBlockComment));
}

onMounted(async () => {
  if (!editorRef.value) return;

  // Pre-load SQL highlighter for hover tooltips (non-blocking)
  void (async () => {
    try {
      const { createShikiSqlHighlighter } = await import("@/lib/sql/sqlHighlighter");
      hoverSqlHighlighter = await createShikiSqlHighlighter({
        appearance: () => (isDark.value ? "dark" : "light"),
      });
    } catch {
      // Highlighter unavailable; hover falls back to plain text
    }
  })();

  const [
    {
      EditorView,
      keymap,
      rectangularSelection,
      hoverTooltip,
      showTooltip,
      closeHoverTooltips,
      Decoration,
      tooltips,
      gutter,
      GutterMarker,
      lineNumberMarkers,
      lineNumbers,
      highlightActiveLineGutter,
      highlightSpecialChars,
      drawSelection,
      dropCursor,
      crosshairCursor,
      scrollPastEnd,
      ViewPlugin,
      layer,
      RectangleMarker,
    },
    { EditorState, EditorSelection, Compartment, Prec, RangeSet, StateEffect, StateField },
    langSql,
    {
      autocompletion,
      startCompletion,
      acceptCompletion,
      closeBrackets,
      closeBracketsKeymap,
      snippetCompletion,
      completionStatus,
      completionKeymap,
      insertCompletionText,
      nextSnippetField,
      closeCompletion,
      moveCompletionSelection,
      selectedCompletion,
      selectedCompletionIndex,
      currentCompletions,
      setSelectedCompletion,
    },
    { copyLineDown, copyLineUp, deleteLine, indentLess, indentMore, insertNewlineKeepIndent, moveLineDown, moveLineUp, redo, selectAll, undo, toggleLineComment, toggleBlockComment, history, defaultKeymap, historyKeymap },
    { bracketMatching, foldGutter, indentOnInput, indentUnit, syntaxHighlighting, defaultHighlightStyle, foldKeymap, toggleFold, ensureSyntaxTree, highlightingFor, syntaxTree },
    { searchKeymap },
  ] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("@codemirror/autocomplete"), import("@codemirror/commands"), import("@codemirror/language"), import("@codemirror/search")]);
  editorViewModule = {
    EditorView,
    keymap,
    rectangularSelection,
  } as typeof import("@codemirror/view");
  hoverCloseEffect = closeHoverTooltips;
  codeMirrorLineNumbers = lineNumbers;
  codeMirrorPrec = Prec;
  codeMirrorEditorSelection = EditorSelection;
  codeMirrorSnippetCompletion = snippetCompletion;
  fontThemeComp = new Compartment();
  codeMirrorTheme = new Compartment();
  wordWrapComp = new Compartment();
  lineNumbersComp = new Compartment();
  vimModeComp = new Compartment();
  closeBracketsComp = new Compartment();
  sqlLanguageComp = new Compartment();
  sqlSemanticHighlightComp = new Compartment();
  sqlSignatureComp = new Compartment();
  codeMirrorCloseBrackets = closeBrackets;
  codeMirrorCloseBracketsKeymap = closeBracketsKeymap;
  readOnlyComp = new Compartment();
  runGutterComp = new Compartment();
  runKeymapComp = new Compartment();
  defaultKeymapComp = new Compartment();
  completionComp = new Compartment();
  diagnosticComp = new Compartment();
  previewRangeComp = new Compartment();
  indentComp = new Compartment();
  setSqlDiagnosticsEffect = StateEffect.define<SqlSemanticDiagnostic[]>();
  codeMirrorCompletionStatus = completionStatus;
  codeMirrorAcceptCompletion = acceptCompletion;
  codeMirrorCurrentCompletions = currentCompletions;
  codeMirrorSelectedCompletion = selectedCompletion;
  codeMirrorSelectedCompletionIndex = selectedCompletionIndex;
  codeMirrorSetSelectedCompletion = setSelectedCompletion;
  codeMirrorMoveCompletionSelection = moveCompletionSelection;
  codeMirrorSelectFirstCompletion = moveCompletionSelection(true);
  codeMirrorCloseCompletion = closeCompletion;
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
  codeMirrorToggleBlockComment = toggleBlockComment;
  codeMirrorDefaultKeymap = defaultKeymap;
  codeMirrorToggleFold = toggleFold;
  codeMirrorIndentUnit = indentUnit;
  window.addEventListener("keyup", clearTableNavigationHoverOnModifierRelease);
  window.addEventListener("blur", clearTableNavigationHover);

  const diagnosticTheme = EditorView.baseTheme({
    ".cm-sql-error": {
      textDecoration: "underline wavy var(--dbx-editor-diagnostic-error, var(--destructive))",
      textUnderlineOffset: "3px",
    },
    ".cm-sql-semantic-warning": {
      textDecoration: "underline wavy var(--dbx-editor-diagnostic-warning, var(--warning))",
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

    const highlightField = StateField.define({
      create() {
        return Decoration.none;
      },
      update(decorations, transaction) {
        for (const effect of transaction.effects) {
          if (effect.is(effectType)) {
            const range = effect.value;
            if (!range) return Decoration.none;
            const from = Math.max(0, Math.min(range.from, transaction.state.doc.length));
            const to = Math.max(from, Math.min(range.to, transaction.state.doc.length));
            return from === to ? Decoration.none : Decoration.set([Decoration.mark({ class: "cm-db-result-source-highlight" }).range(from, to)]);
          }
        }
        if (transaction.docChanged || transaction.selection) return Decoration.none;
        return decorations;
      },
      provide: (field) => EditorView.decorations.from(field),
    });
    return [field, highlightField];
  };

  class StatementExecutionStateMarker extends GutterMarker {
    constructor(readonly marker: StatementExecutionMarker) {
      super();
    }

    eq(other: import("@codemirror/view").GutterMarker): boolean {
      return other instanceof StatementExecutionStateMarker && other.marker.status === this.marker.status && other.marker.successCount === this.marker.successCount && other.marker.errorCount === this.marker.errorCount && other.marker.runningCount === this.marker.runningCount;
    }
  }

  class StatementGutterMarker extends GutterMarker {
    constructor(
      readonly canExecute: boolean,
      readonly marker?: StatementExecutionMarker,
    ) {
      super();
    }

    eq(other: import("@codemirror/view").GutterMarker): boolean {
      return (
        other instanceof StatementGutterMarker &&
        other.canExecute === this.canExecute &&
        other.marker?.status === this.marker?.status &&
        other.marker?.successCount === this.marker?.successCount &&
        other.marker?.errorCount === this.marker?.errorCount &&
        other.marker?.runningCount === this.marker?.runningCount
      );
    }

    toDOM() {
      return createStatementGutterMarkerDom({
        canExecute: this.canExecute,
        executeLabel: t("editor.contextMenu.executeCurrent"),
        status: this.marker?.status,
        statusLabel: this.marker ? statementExecutionMarkerTitle(this.marker) : undefined,
      });
    }
  }

  function statementExecutionMarkerTitle(marker: StatementExecutionMarker) {
    const parts = [];
    if ((marker.runningCount ?? 0) > 0) parts.push(t("editor.statementExecutionRunning", { count: marker.runningCount }));
    if (marker.successCount > 0) parts.push(t("editor.statementExecutionSucceeded", { count: marker.successCount }));
    if (marker.errorCount > 0) parts.push(t("editor.statementExecutionFailed", { count: marker.errorCount }));
    return parts.join(", ");
  }

  setStatementExecutionMarkersEffect = StateEffect.define<StatementExecutionMarker[]>();
  buildRunStatementGutterExtension = () => {
    const effectType = setStatementExecutionMarkersEffect!;
    const showRunButtons = !props.hideExecutionControls && settingsStore.editorSettings.showStatementRunButtons;
    const markersForState = (state: import("@codemirror/state").EditorState, markers: readonly StatementExecutionMarker[]) => {
      const ranges = markers.map((marker) => {
        const from = Math.max(0, Math.min(marker.from, state.doc.length));
        return new StatementExecutionStateMarker(marker).range(state.doc.lineAt(from).from);
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
          class: "cm-run-statement-gutter",
          markers: (currentView) => currentView.state.field(field),
          lineMarker(currentView, line, markers) {
            const executionMarker = markers.find((marker) => marker instanceof StatementExecutionStateMarker)?.marker;
            const canExecute = showRunButtons && !!executableStatementRangeStartingAt(currentView, line.from);
            return canExecute || executionMarker ? new StatementGutterMarker(canExecute, executionMarker) : null;
          },
          domEventHandlers: showRunButtons
            ? {
                mousedown: executeSqlStatementFromGutter,
              }
            : {},
        }),
    });
    return field;
  };
  buildSqlSignatureExtension = () =>
    showTooltip.compute(["doc", "selection"], (currentState) => {
      const signature = getSqlFunctionSignatureHelp(currentState.doc.toString(), currentState.selection.main.head, props.databaseType, sqlDriverProfile.value);
      if (!signature) return null;
      return {
        pos: currentState.selection.main.head,
        above: false,
        clip: false,
        create: () => ({ dom: createSqlSignatureTooltipDom(signature) }),
      };
    });

  buildSqlCompletionExtension = () =>
    autocompletion({
      activateOnTyping: true,
      defaultKeymap: false,
      selectOnOpen: settingsStore.editorSettings.selectFirstCompletionOnOpen,
      compareCompletions: (a, b) => compareSqlCompletions(a, b, settingsStore.editorSettings.sortCompletionColumnsAlphabetically),
      // Keep normal completion lists virtualized; batch-field selection needs every row in the DOM.
      maxRenderedOptions: batchColumnSelectionExpandedRendering ? Number.MAX_SAFE_INTEGER : 100,
      optionClass: (completion) => ((completion as QueryCompletionOption).dbxBatchColumnSelectionAction ? "cm-batch-column-selection-action" : ""),
      addToOptions: [
        { position: 5, render: renderBatchColumnSelectionActionMarker },
        { position: 10, render: renderBatchColumnSelectionCheckbox },
      ],
      override: [async (context: CompletionContext) => provideSqlCompletions(context)],
    });

  const shellLineCommentHighlightPlugin = createShellLineCommentHighlight({ ViewPlugin, Decoration, highlightingFor, syntaxTree });
  buildSqlLanguageExtension = () => [
    langSql.sql({
      dialect: createDbxCodeMirrorSqlDialect(langSql, props.syntaxDialect ?? props.dialect, props.databaseType, sqlDriverProfile.value),
    }),
    // Non-SQL editors (MongoDB shell) keep the SQL grammar for highlighting, so override the
    // comment marker that toggleLineComment reads from language data.
    Prec.highest(EditorState.languageData.of(() => [{ commentTokens: queryEditorCommentTokens(props.databaseType) }])),
    // The SQL grammar does not tokenize `//`, so those comments are highlighted by hand.
    queryEditorLineCommentToken(props.databaseType) === "//" ? shellLineCommentHighlightPlugin : [],
  ];
  const MAX_SQL_SEMANTIC_HIGHLIGHT_WINDOWS = 32;
  buildSqlSemanticHighlightExtension = () => [
    ViewPlugin.fromClass(
      class {
        decorations: import("@codemirror/view").DecorationSet;
        private cachedDoc: import("@codemirror/state").Text | null = null;
        private cachedSql = "";
        private cachedDialectId = "";
        private cachedDatabaseType: DatabaseType | undefined;
        private cachedWindows: Array<{
          from: number;
          to: number;
          spans: Array<{ start: number; end: number }>;
        }> = [];

        constructor(currentView: import("@codemirror/view").EditorView) {
          this.decorations = this.buildDecorations(currentView);
        }

        update(update: import("@codemirror/view").ViewUpdate) {
          if (update.docChanged || update.viewportChanged) this.decorations = this.buildDecorations(update.view);
        }

        buildDecorations(currentView: import("@codemirror/view").EditorView) {
          const dialectId = resolveSqlDialectId({ databaseType: props.databaseType, dialect: sqlBehaviorDialect() });
          const doc = currentView.state.doc;
          if (this.cachedDoc !== doc || this.cachedDialectId !== dialectId || this.cachedDatabaseType !== props.databaseType) {
            this.cachedDoc = doc;
            this.cachedSql = doc.toString();
            this.cachedDialectId = dialectId;
            this.cachedDatabaseType = props.databaseType;
            this.cachedWindows = [];
          }

          const sql = this.cachedSql;
          const windows: Array<{
            from: number;
            to: number;
            spans: Array<{ start: number; end: number }>;
          }> = [];
          const pendingWindows: Array<{ from: number; to: number }> = [];
          for (const visibleRange of currentView.visibleRanges) {
            const cached = this.cachedWindows.find((candidate) => candidate.from <= visibleRange.from && candidate.to >= visibleRange.to);
            if (cached) {
              if (!windows.includes(cached)) windows.push(cached);
              continue;
            }

            const next = expandToSqlStatementWindow(sql, visibleRange.from, visibleRange.to, dialectId);
            const cachedWindow = this.cachedWindows.find((candidate) => candidate.from <= next.from && candidate.to >= next.to);
            if (cachedWindow) {
              if (!windows.includes(cachedWindow)) windows.push(cachedWindow);
              continue;
            }

            const previous = pendingWindows[pendingWindows.length - 1];
            if (previous && next.from <= previous.to) previous.to = Math.max(previous.to, next.to);
            else pendingWindows.push({ ...next });
          }

          if (pendingWindows.length > 0) {
            const tree = ensureSyntaxTree(currentView.state, Math.max(...pendingWindows.map((window) => window.to)), 25);
            if (!tree) return Decoration.set([]);
            for (const window of pendingWindows) {
              const entry = {
                ...window,
                spans: sqlSemanticTableNameSpansForSyntaxTree(sql, window, tree, {
                  databaseType: props.databaseType,
                  dialect: sqlBehaviorDialect(),
                }),
              };
              this.cachedWindows.push(entry);
              windows.push(entry);
            }
            if (this.cachedWindows.length > MAX_SQL_SEMANTIC_HIGHLIGHT_WINDOWS) {
              this.cachedWindows.splice(0, this.cachedWindows.length - MAX_SQL_SEMANTIC_HIGHLIGHT_WINDOWS);
            }
          }

          const ranges = windows.flatMap((window) => window.spans);
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
    shellLineCommentTheme(EditorView),
  ];

  const initialSettings = settingsStore.editorSettings;
  const theme = await loadEditorTheme(initialSettings.theme, editorThemeAppearance(), getCurrentCustomThemeColors(), themePalette.value);
  if (initialSettings.vimModeEnabled) {
    await ensureCodeMirrorVim();
  }

  const currentStatementFrameExtension = currentStatementFrameLayer({ layer, RectangleMarker }, (view) => {
    if (!settingsStore.editorSettings.showCurrentStatementFrame) return null;
    if (view.state.selection.ranges.some((range) => !range.empty)) return null;
    let range = currentExecutableStatementRange(view);
    if (!range) {
      const cursorPos = view.state.selection.main.head;
      const cursorLine = view.state.doc.lineAt(cursorPos);
      executableStatementRangeCache = executableStatementRangeCacheForDoc(executableStatementRangeCache, view.state.doc, props.databaseType, sqlStatementParameterOptions());
      // Find ranges that overlap the cursor line, then expand to include
      // adjacent ranges (handles parser fragments from edge cases like
      // ultra-long comments splitting a statement).
      let mergedFrom = cursorLine.from;
      let mergedTo = cursorLine.from;
      let changed = true;
      while (changed) {
        changed = false;
        for (const cachedRange of executableStatementRangeCache.ranges) {
          // Only merge ranges that overlap the cursor line or are adjacent
          // to the current merged region
          if (cachedRange.from <= mergedTo && cachedRange.to >= mergedFrom) {
            const newFrom = Math.min(mergedFrom, cachedRange.from);
            const newTo = Math.max(mergedTo, cachedRange.to);
            if (newFrom !== mergedFrom || newTo !== mergedTo) {
              mergedFrom = newFrom;
              mergedTo = newTo;
              changed = true;
            }
          }
        }
      }
      if (mergedTo > mergedFrom) {
        range = { from: mergedFrom, to: mergedTo, sql: view.state.doc.sliceString(mergedFrom, mergedTo) };
      }
    }
    if (!range) return null;
    return { from: range.from, to: currentStatementFrameTo(view, range) };
  });

  function currentStatementFrameTo(view: import("@codemirror/view").EditorView, range: SqlTextRange): number {
    return currentStatementFrameRangeTo(view.state.doc, range);
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
      runGutterComp.of(runStatementGutterExtension()),
      lineNumbersComp.of(lineNumbersExtension(initialSettings.showLineNumbers)),
      createQueryEditorLineNumberAlignmentExtension(ViewPlugin),
      currentStatementFrameExtension,
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
      sqlBlockFoldService,
      drawSelection(),
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
      vimModeComp.of(vimModeExtension(initialSettings.vimModeEnabled)),
      defaultKeymapComp.of(defaultKeymapExtension()),
      keymap.of([...searchKeymapWithoutModD(searchKeymap), ...historyKeymap, ...foldKeymap, ...completionKeymap]),
      sqlLanguageComp.of(buildSqlLanguageExtension()),
      sqlSemanticHighlightComp.of(buildSqlSemanticHighlightExtension()),
      tooltips({ parent: tooltipParent }),
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
      sqlSignatureComp.of(buildSqlSignatureExtension()),
      diagnosticComp.of(buildSqlDiagnosticExtension()),
      createInsertValueHintsExtension({
        isEnabled: () => settingsStore.editorSettings.showInsertValueHints && supportsInsertValueHints(props.databaseType),
        getTableColumns: getInsertValueHintTableColumns,
        requestTableColumns: requestInsertValueHintTableColumns,
        getDialectId: () => resolveSqlDialectId({ databaseType: props.databaseType, dialect: sqlBehaviorDialect() }),
      }),
      previewRangeComp.of(buildPreviewRangeExtension()),
      buildResultSourceRangeExtension(),
      Prec.highest(
        keymap.of([
          { key: "'", run: handleSqlSingleQuote },
          { key: "Tab", run: handleTab },
          {
            key: "Escape",
            run: () => {
              clearBatchColumnSelectionSession();
              return searchPanelRef.value?.closeSearch() ?? false;
            },
          },
        ]),
      ),
      runKeymapComp.of(runKeymapExtension(keymap)),
      Prec.highest(
        EditorView.domEventHandlers({
          keydown(event, currentView) {
            const shortcuts = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);
            return runQueryEditorAltExtendSelection(event, shortcuts.extendSelection, currentView, extendQueryEditorSelectionForView);
          },
        }),
      ),
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
          if (update.transactions.some((tr) => tr.isUserEvent("input.paste"))) {
            resyncCaretAfterPaste(update.view);
          }
        }
        if (update.selectionSet || update.docChanged) {
          syncContextMenuState(update.view);
          emit("selectionChange", selectedSqlFromView(update.view));
          emit("cursorChange", update.state.selection.main.head);
          emit("previewChangesAvailable", !!previewContextSql.value);
          latestSelection = readEditorSelection(update.view);
          if (editorIsActive) emitEditorSelection(latestSelection);
        }
        // Clear activeCompletionOrigin when the completion session ends.
        if (codeMirrorCompletionStatus) {
          const status = codeMirrorCompletionStatus(update.state) ?? null;
          if (status === null) {
            activeCompletionOrigin = null;
            clearBatchColumnSelectionSession();
          }
        }
      }),
      fontThemeComp.of(
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
        mousedown: (event: MouseEvent) => {
          clearTableNavigationHover();
          dismissHoverTooltip();
          const currentView = view.value;
          if (currentView && startEditorSelectionDrag(currentView, event)) {
            return true;
          }
          // Alt belongs to CodeMirror's rectangular and multi-cursor gestures,
          // even when Cmd/Ctrl is held at the same time.
          if (!usesQueryEditorObjectNavigationModifier(event)) {
            // Click without modifier -> close column panel
            if (!event.metaKey && !event.ctrlKey && event.button === 0) {
              emit("closeColumnPanel");
            }
            return false;
          }
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
              // Single identity model: quote flags + role (relation column list vs routine call vs unknown).
              const identity = resolveSqlObjectNavigationIdentity(doc, pos);
              if (!identity) return;

              const identifierParts = identity.parts.map((part) => part.value);
              const tableLookupFilter = identity.name;
              const objectNameFilter = identity.name;
              // 3-part schema.package.member; 2-part stays ambiguous until metadata resolves it.
              const objectParentHint = identity.parts.length >= 3 ? identity.qualifier : undefined;
              const objectSchemaHint = identity.parts.length >= 3 ? identity.schema : identity.parts.length === 1 ? props.schema : undefined;
              const isRoutineCall = identity.role === "routine_call";
              const isRelationColumnList = identity.role === "relation_column_list";
              const relationNavigationTarget = (target: SqlObjectNavigationTarget) =>
                queryTableNavigationTargetAtSqlPosition(
                  {
                    connectionId: props.connectionId!,
                    database: props.database!,
                    schema: props.schema,
                    databaseType: props.databaseType,
                    sql: doc,
                    position: pos,
                  },
                  target,
                );

              // 1. Local table cache (sync). Relation column lists always prefer tables over routines.
              if (cachedTables.length === 0) {
                cachedTables = connectionStore.lookupLocalCompletionTables(props.connectionId!, props.database!, tableLookupFilter, MAX_COMPLETION_TABLES, props.schema, props.catalog);
              }

              let matchedTable = matchTable(identifier, cachedTables);
              if (matchedTable) {
                emit("clickTable", relationNavigationTarget(matchedTable));
                return;
              }

              const preserveOracleStoreCase = (value?: string) => !!value && value !== value.toUpperCase();
              const openMatchedObject = (matchedObject: { name: string; schema?: string; type: string; signature?: string; parentName?: string; parentSchema?: string }) => {
                const navigationType = sqlObjectNavigationTypeFromCompletionObjectType(matchedObject.type);
                if (!navigationType) return false;
                // Metadata names are store-correct; mark mixed-case (or click-quoted) so Oracle normalize won't force UPPER.
                emit(
                  "openObjectSource",
                  sqlObjectNavigationTarget({
                    name: matchedObject.name,
                    schema: matchedObject.schema,
                    type: navigationType,
                    signature: matchedObject.signature,
                    parentName: matchedObject.parentName,
                    parentSchema: matchedObject.parentSchema,
                    nameQuoted: identity.nameQuoted || preserveOracleStoreCase(matchedObject.name),
                    schemaQuoted: matchedObject.schema ? identity.schemaQuoted || identity.qualifierQuoted || preserveOracleStoreCase(matchedObject.schema) : undefined,
                    parentNameQuoted: matchedObject.parentName ? identity.qualifierQuoted || preserveOracleStoreCase(matchedObject.parentName) : undefined,
                    parentSchemaQuoted: matchedObject.parentSchema ? identity.schemaQuoted || preserveOracleStoreCase(matchedObject.parentSchema) : undefined,
                  }),
                  false,
                );
                return true;
              };

              // 1b. Local routine cache — skip for pure relation column lists (INSERT INTO t(...)).
              if (!isRelationColumnList) {
                const localObjects = connectionStore.lookupLocalCompletionObjects(props.connectionId!, props.database!, objectNameFilter, MAX_COMPLETION_TABLES, props.schema);
                let matchedObject = matchSqlObject(identifier, localObjects);
                if (matchedObject && openMatchedObject(matchedObject)) return;

                if (!usesLocalOnlyCompletionMetadata()) {
                  // Disambiguate schema.routine vs package.member with small scoped lookups (no global scan).
                  if (identity.parts.length === 2 && identity.qualifier) {
                    // Prefer package.member under session schema (Oracle common: PKG.MEMBER()).
                    const packageObjects = await connectionStore.listCompletionObjects(props.connectionId!, props.database!, objectNameFilter, 20, props.schema, identity.qualifier, false, props.schema, ["routine"]);
                    matchedObject = matchSqlObject(identifier, packageObjects);
                    if (matchedObject && openMatchedObject(matchedObject)) return;

                    // Then schema.routine with qualifier as owner.
                    const schemaObjects = await connectionStore.listCompletionObjects(props.connectionId!, props.database!, objectNameFilter, 20, identity.qualifier, undefined, false, props.schema, ["routine"]);
                    matchedObject = matchSqlObject(identifier, schemaObjects);
                    if (matchedObject && openMatchedObject(matchedObject)) return;
                  } else {
                    const scopedObjects = await connectionStore.listCompletionObjects(props.connectionId!, props.database!, objectNameFilter, 20, objectSchemaHint, objectParentHint, false, props.schema, ["routine"]);
                    matchedObject = matchSqlObject(identifier, scopedObjects);
                    if (matchedObject && openMatchedObject(matchedObject)) return;
                  }
                }
              }

              // 1c. Remote table metadata — never skip for relation column lists or unknown identifiers.
              // Routine-call sites may still hit this when a table and procedure share a name and
              // local caches were empty; table wins only if listed as a relation.
              if (!usesLocalOnlyCompletionMetadata() && (!isRoutineCall || isRelationColumnList || identity.role === "unknown")) {
                cachedTables = await connectionStore.listCompletionTables(props.connectionId!, props.database!, tableLookupFilter, MAX_COMPLETION_TABLES, props.schema, false, props.schema, props.catalog);
                matchedTable = matchTable(identifier, cachedTables);
                if (matchedTable) {
                  emit("clickTable", relationNavigationTarget(matchedTable));
                  return;
                }
              } else if (!usesLocalOnlyCompletionMetadata() && isRoutineCall) {
                // Lightweight table check so INSERT INTO ORDERS(…) is not the only guarded path —
                // still avoid global scans: only session-scoped prefix lookup.
                cachedTables = await connectionStore.listCompletionTables(props.connectionId!, props.database!, tableLookupFilter, 20, props.schema, false, props.schema, props.catalog);
                matchedTable = matchTable(identifier, cachedTables);
                if (matchedTable) {
                  emit("clickTable", relationNavigationTarget(matchedTable));
                  return;
                }
              }

              // 1d. Optimistic routine open only for confirmed call sites after metadata + table checks.
              if (isRoutineCall) {
                const optimistic = sqlObjectNavigationTargetFromIdentity(identity, {
                  fallbackSchema: props.schema,
                  preferType: "procedure",
                  // 2-part: package.member under session schema (not schema.routine).
                  asPackageMember: identity.twoPartAmbiguous,
                });
                if (optimistic) {
                  emit("openObjectSource", optimistic, false);
                  return;
                }
              }

              // 2. Parse SQL at click position to get referenced tables
              const context = getSqlCompletionContext(doc, pos);
              let referencedTables: Array<SqlCompletionReferencedTable & Pick<SqlCompletionTable, "type">> = context.referencedTables;
              // Enrich referenced tables with schema from cachedTables
              referencedTables = referencedTables.map((rt) => {
                if (usesOracleSessionCompletionColumns(rt.schema)) return rt;
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
                emit("clickTable", relationNavigationTarget(matchedRef));
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
                const cacheKey = completionCacheKey(refTable);

                // Use persistent column cache; fetch only if missing
                let cols = cachedColumnsByTable.get(cacheKey);
                if (!cols) {
                  try {
                    const target = completionMetadataTarget(refTable);
                    if (!target) continue;
                    cols = await listCompletionColumnsForEditor(props.connectionId!, target.database, refTable.name, target.schema, target.catalog, refTable);
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

  view.value = new EditorView({ state, parent: editorElement });
  batchColumnSelectionTooltipParents.set(view.value, tooltipParent);
  postCompositionKeyGuardCleanup = postCompositionKeyGuard.attach(view.value.contentDOM);
  registerEditorScrollbarPointerGuard(view.value);
  view.value.scrollDOM.addEventListener("scroll", scheduleEditorViewportEmit, {
    passive: true,
  });

  // Register context-menu scroll listener on the actual EditorView scrollDOM
  // (deferred until after creation so view.value is non-null).
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

  restoreEditorViewport();
  syncContextMenuState(view.value);
  emit("previewChangesAvailable", !!previewContextSql.value);
  syncEditorFontCssVars(liveFontSize.value, initialSettings.fontFamily);
  syncEditorDiagnosticCssVars();
  registerTableReferenceDropListener();

  cachedTables = [];
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

// When completionTriggerMode changes, close any open typing session
// that would no longer be allowed under the new mode.
watch(
  () => settingsStore.editorSettings.completionTriggerMode,
  (newMode) => {
    if (!view.value || !codeMirrorCompletionStatus || !codeMirrorCloseCompletion) return;
    const status = codeMirrorCompletionStatus(view.value.state);
    if (!status || activeCompletionOrigin !== "typing") return;
    // If switching to manual, close all typing sessions.
    if (newMode === "manual") {
      codeMirrorCloseCompletion(view.value);
      return;
    }
    // For other mode changes, re-evaluate the policy.
    // If the current position would not trigger under the new mode, close.
    const fullDoc = view.value.state.doc.toString();
    const position = view.value.state.selection.main.head;
    if (!shouldTriggerSqlCompletionForPosition(fullDoc, position)) {
      codeMirrorCloseCompletion(view.value);
    }
  },
);

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
  () => props.compressRequestId,
  (val, oldVal) => {
    if (val && val !== oldVal) compressCurrentSql();
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
    completionEpoch++;
    refreshCompletionCache();
    setSemanticDiagnostics([]);
    scheduleSemanticDiagnostics();
  },
);

watch([() => props.clientSessionId, () => props.completionContextVersion], () => {
  completionEpoch++;
  refreshCompletionCache();
  setSemanticDiagnostics([]);
  scheduleSemanticDiagnostics();
});

watch([() => props.databaseType, () => props.dialect, () => props.syntaxDialect, sqlDriverProfile], () => {
  executableStatementRangeCache = null;
  if (!view.value || !sqlLanguageComp || !buildSqlLanguageExtension || !sqlSemanticHighlightComp || !buildSqlSemanticHighlightExtension || !sqlSignatureComp || !buildSqlSignatureExtension) return;
  // Signature tooltips depend on the external dialect, so refresh them even when the document and selection stay unchanged.
  view.value.dispatch({
    effects: [sqlLanguageComp.reconfigure(buildSqlLanguageExtension()), sqlSemanticHighlightComp.reconfigure(buildSqlSemanticHighlightExtension()), sqlSignatureComp.reconfigure(buildSqlSignatureExtension())],
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
  [queryEditorAppearanceSettings, () => isDark.value, () => themePalette.value, editorThemeAppearance],
  async ([ss]) => {
    if (!view.value || !codeMirrorTheme || !fontThemeComp || !wordWrapComp || !lineNumbersComp || !vimModeComp || !closeBracketsComp || !runGutterComp || !runKeymapComp || !editorViewModule) {
      return;
    }
    if (!isGestureZooming.value && !zoomCommitScheduler.hasPendingCommit() && liveFontSize.value !== ss.fontSize) {
      liveFontSize.value = ss.fontSize;
    }
    syncEditorFontCssVars(liveFontSize.value, ss.fontFamily);
    syncEditorDiagnosticCssVars();
    const themeColors = getCurrentCustomThemeColors();
    const [themeExt] = await Promise.all([loadEditorTheme(ss.theme, editorThemeAppearance(), themeColors, themePalette.value), ss.vimModeEnabled ? ensureCodeMirrorVim() : Promise.resolve(false)]);
    if (!view.value || !codeMirrorTheme || !wordWrapComp || !lineNumbersComp || !vimModeComp || !closeBracketsComp || !runGutterComp || !runKeymapComp || !editorViewModule) {
      return;
    }
    view.value.dispatch({
      effects: [
        codeMirrorTheme.reconfigure(themeExt),
        wordWrapComp.reconfigure(props.forceWordWrap || ss.wordWrap ? editorViewModule.EditorView.lineWrapping : []),
        lineNumbersComp.reconfigure(lineNumbersExtension(ss.showLineNumbers)),
        vimModeComp.reconfigure(vimModeExtension(settingsStore.editorSettings.vimModeEnabled)),
        closeBracketsComp.reconfigure(closeBracketsExtension(settingsStore.editorSettings.autoCloseBrackets)),
        runGutterComp.reconfigure(runStatementGutterExtension()),
        runKeymapComp.reconfigure(runKeymapExtension(editorViewModule.keymap)),
      ],
    });
  },
  { deep: true },
);

watch(
  () => [settingsStore.editorSettings.shortcuts, settingsStore.editorSettings.sqlShortcuts],
  () => {
    if (!view.value || !editorViewModule) return;
    const effects = [];
    if (defaultKeymapComp) {
      effects.push(defaultKeymapComp.reconfigure(defaultKeymapExtension()));
    }
    if (runKeymapComp) {
      effects.push(runKeymapComp.reconfigure(runKeymapExtension(editorViewModule.keymap)));
    }
    if (effects.length > 0) {
      view.value.dispatch({ effects });
    }
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
  () => [settingsStore.editorSettings.snippets, settingsStore.editorSettings.sortCompletionColumnsAlphabetically, settingsStore.editorSettings.selectFirstCompletionOnOpen],
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
    if (props.databaseType === "redis" || props.databaseType === "victoriametrics") return;
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
  flushEditorViewport();
  flushEditorSelection();
  clearTableNavigationHover();
  clearPendingCompletionEnter();
  clearPendingCompletionTab();
  executionViewportOwnership.reset();
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
  contextMenuPointerCleanup?.();
  postCompositionKeyGuardCleanup?.();
  postCompositionKeyGuardCleanup = null;
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
  if (props.readOnly) return false;
  return searchPanelRef.value?.openReplace() ?? false;
}

function scrollCursorIntoView() {
  const preserveViewport = executionViewportOwnership.consumeCompletionPreservation();
  const currentView = view.value;
  if (!currentView || !editorViewModule || !editorIsActive || preserveViewport) return;
  const pos = currentView.state.selection.main.head;
  if (isQueryEditorPositionVisible(pos, currentView.visibleRanges, currentView.viewport)) return;
  // Use "center" rather than "nearest": by the time this runs, the results pane has already
  // opened/resized and shrunk the editor viewport, so the cursor's old position is often no
  // longer visible. "nearest" then pins it right at the new viewport's edge (Fixes #5281: in a
  // long multi-statement file, the just-executed statement lands flush against the results pane
  // divider), which is exactly where it's hardest to see and re-click. Centering keeps it
  // comfortably visible so the user doesn't have to scroll to find/re-run it.
  currentView.dispatch({
    effects: editorViewModule.EditorView.scrollIntoView(pos, { y: "center" }),
  });
}

function beginExecutionViewportTracking() {
  executionViewportOwnership.beginExecution();
}

function recordExecutionViewportInteraction() {
  executionViewportOwnership.recordUserInteraction();
}

function dismissHoverTooltip() {
  if (!view.value || !hoverCloseEffect) return;
  view.value.dispatch({ effects: hoverCloseEffect });
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
  previewStatementRange,
  refreshCompletionCache,
});
</script>

<template>
  <div class="h-full w-full overflow-hidden relative" @wheel="recordExecutionViewportInteraction" @pointerdown="recordExecutionViewportInteraction" @gesturestart="onEditorGestureStart" @gesturechange="onEditorGestureChange" @gestureend="onEditorGestureEnd">
    <CustomContextMenu :items="currentContextMenuItems" @close="contextMenuOpen = false" v-slot="{ onContextMenu }">
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
    </CustomContextMenu>
    <div v-show="queryEditorDropCaret" data-query-editor-drop-caret class="pointer-events-none absolute z-20 w-0.5 rounded-full bg-primary/70" :style="queryEditorDropCaretStyle" />
    <EditorSearchPanel ref="searchPanelRef" :view="view" />
    <SqlExecutionTargetPicker v-if="pickerVisible" :candidates="pickerCandidates" :active-index="pickerActiveIndex" :anchor="pickerAnchor" @update:active-index="onPickerActiveIndexChange" @confirm="onPickerConfirm" @cancel="closePicker" />
    <DelimitedListDialog v-model:open="delimitedListOpen" :selected-text="delimitedListSelectedText" @confirm="applyDelimitedListResult" />
    <CodeSnapshotDialog v-model:open="codeSnapshotOpen" :source="codeSnapshotSource" />
    <!-- SQL 意图操作弹出菜单（参考 DataGrip Alt+Enter） -->
    <Teleport to="body">
      <div v-if="intentionPopup?.visible" class="intention-popup-overlay" @click.self="closeIntentionPopup">
        <div class="intention-popup" :style="{ left: intentionPopup.position.x + 'px', top: intentionPopup.position.y + 'px' }">
          <div v-for="(action, i) in intentionPopup.actions" :key="i" class="intention-popup-item" :class="{ 'intention-popup-item--active': i === intentionPopup.selectedIndex }" @click="executeIntentionAction(action)" @mouseenter="intentionPopup.selectedIndex = i">
            <span class="intention-popup-item__icon">💡</span>
            <span class="intention-popup-item__label">{{ action.label || getIntentionActionLabel(action.kind) }}</span>
          </div>
        </div>
      </div>
    </Teleport>
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

.intention-popup-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: transparent;
}

.intention-popup {
  position: fixed;
  z-index: 10000;
  min-width: 220px;
  max-width: 360px;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  padding: 4px 0;
  overflow: hidden;
}

.intention-popup-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  color: var(--foreground);
  font-size: 13px;
  line-height: 1.5;
  transition: background 0.1s;
}

.intention-popup-item:hover,
.intention-popup-item--active {
  background: var(--accent);
  color: var(--accent-foreground);
}

.intention-popup-item__icon {
  font-size: 14px;
  flex-shrink: 0;
}

.intention-popup-item__label {
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
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
