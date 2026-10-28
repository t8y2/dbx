<script setup lang="ts">
import { useTableCopyTaskStore } from "@/stores/tableCopyTaskStore";
import { uuid } from "@/lib/common/utils";
import { OBJECT_BROWSER_COMPACT_WIDTHS, normalizeObjectBrowserCompactWidth, type ObjectBrowserCompactWidth } from "@/lib/table/objectBrowserCompactWidth";
import { applyDdlTextPreferences } from "@/lib/sql/ddlPreferences";
import DatabaseActionsMenu from "@/components/objects/DatabaseActionsMenu.vue";
import FirebirdObjectManager from "@/components/objects/FirebirdObjectManager.vue";
import { useDatabaseBrowserMutation } from "@/lib/database/databaseBrowserActions";
import DdlStorageToggle from "@/components/objects/DdlStorageToggle.vue";

import { computed, createApp, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch, type Component } from "vue";
import { RecycleScroller } from "vue-virtual-scroller";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import {
  Activity,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Braces,
  Check,
  CheckSquare,
  CircleX,
  Clock,
  Clipboard,
  Code2,
  Copy,
  CopyPlus,
  ChevronDown,
  ChevronRight,
  Download,
  Eraser,
  Eye,
  FileCode,
  FileText,
  Info,
  GripVertical,
  Grid3X3,
  Settings2,
  KeyRound,
  LayoutGrid,
  Link2,
  List,
  ListTree,
  Upload,
  Loader2,
  Network,
  Pencil,
  PencilLine,
  PencilRuler,
  Play,
  Package,
  PanelRight,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Square,
  Table,
  Table2,
  TableProperties,
  TerminalSquare,
  Trash2,
  WrapText,
  X,
  Wrench,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";
import i18n from "@/i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import ToolbarOverflowMenu from "@/components/ui/ToolbarOverflowMenu.vue";
import { useToolbarOverflow } from "@/composables/useToolbarOverflow";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ProcedureExecutionDialog from "@/components/objects/ProcedureExecutionDialog.vue";
import { launchPlDebug } from "@/components/debug/plDebugLaunch";
import { supportsPlDebugRoutine } from "@/lib/database/databaseFeatureSupport";
import CustomTypeInfoPanel from "@/components/objects/CustomTypeInfoPanel.vue";
import TablePartitionsPanel from "@/components/structure/TablePartitionsPanel.vue";
import XlsxHeaderDialog from "@/components/export/XlsxHeaderDialog.vue";
import * as api from "@/lib/backend/api";
import ObjectDependenciesPanel from "@/components/objects/ObjectDependenciesPanel.vue";
import { objectDependencyTarget, type ObjectDependencyTarget, type ObjectDetailsSection } from "@/lib/database/objectDependencyDetails";
import type { SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";
import type { QueryTab } from "@/types/database";
import type {
  ColumnInfo,
  ConnectionConfig,
  ConstraintInfo,
  ForeignKeyInfo,
  IndexInfo,
  ObjectBrowserViewMode,
  ObjectBrowserViewport,
  ObjectInfo,
  ObjectSourceKind,
  ObjectStatistics,
  PgTablePartitioning,
  SchemaIndexIdentity,
  TableInfoTab,
  TableNameFilter,
  TreeNode,
  TriggerInfo,
} from "@/types/database";
import { sortTablesByFkDependency, type TableWithFk } from "@/lib/table/tableDependencySort";
import { isSchemaAware, supportsTableVacuum, supportsTransfer } from "@/lib/database/databaseCapabilities";
import { supportsAiAssistantContext, supportsDataDictionary, supportsSchemaDiagram, supportsTableImport, supportsTableStructureEditing, supportsTableTruncate } from "@/lib/database/databaseFeatureSupport";
import { codeMirrorSqlDialect, connectionObjectTreeNodeSchema, connectionTableSqlSchema, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection, objectListSchemaForConnection, tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { getTableMetadataCapabilities, type TableMetadataCapabilities } from "@/lib/table/tableMetadataCapabilities";
import { findTableStatistics } from "@/lib/dataGrid/tableInfoOverview";
import { constraintsForConstraintsTab } from "@/lib/table/constraintPresentation";
import { buildTableSelectSql, dropsSchemaQualifier } from "@/lib/table/tableSelectSql";
import { PARTITION_TREE_INDENT_PX } from "@/lib/table/pgPartitionPresentation";
import {
  buildDropObjectSql,
  buildDropTableSql,
  buildDuplicateTableStructurePlan as buildSharedDuplicateTableStructurePlan,
  buildCopyTableDataSql,
  buildEmptyTableSql,
  buildTruncateTableSql,
  buildVacuumTableSql,
  supportsDropTableCascade,
  supportsTruncateTableCascade,
  type TableAdminSqlOptions,
} from "@/lib/database/dbAdminSql";
import type { DuplicateTableStructurePlan } from "@/lib/database/dbAdminSql";
import { executeOceanbaseTableClone, executeOceanbaseTableCloneData, oceanbaseCloneDataPreparationError, OceanbaseTableCloneError, type OceanbaseTableClone } from "@/lib/database/oceanbaseTableClone";
import { useOceanbaseCloneDialog } from "@/composables/useOceanbaseCloneDialog";
import { useToast } from "@/composables/useToast";
import { buildExecutableObjectSourceStatements, buildRoutineRenameObjectSourceStatements, prepareObjectSourceSave, objectSourceSaveSuccessMessage, formatObjectSourceSaveError, supportsSourceBackedRoutineRename } from "@/lib/table/objectSourceEditor";
import { inspectExactOracleTriggerSource } from "@/lib/table/objectSourceLoad";
import {
  readOracleTriggerSource,
  prepareOracleTriggerPlan,
  prepareOracleTriggerDropBatchPlan,
  executeOracleTriggerDropBatchPlan,
  verifyOracleTriggerDeletion,
  type OracleTriggerDropBatchPlan,
  type OracleTriggerSnapshot,
  type OracleTriggerExecutionResult,
  type OracleTriggerAction,
  type OracleTriggerTarget,
} from "@/lib/database/oracleTriggerPlan";
import { confirmOracleTriggerPlan } from "@/lib/database/oracleTriggerActions";
import OracleTriggerStatus from "@/components/objects/OracleTriggerStatus.vue";
import ObjectSourceDialog from "@/components/objects/ObjectSourceDialog.vue";
import { assertSourceIdentity, beginSourceSave, captureSourceIdentity, freezeSourceIdentities, renewSourceIdentity, type SourceIdentitySnapshot } from "@/lib/table/objectSourceIdentity";
import { buildRenameObjectSql, supportsObjectRename } from "@/lib/table/objectRenameSql";
import { prepareOracleViewRename, executeOracleViewRename, OracleViewRenameFailure, type OracleViewRenamePlan } from "@/lib/table/oracleViewRename";
import OracleViewRenamePreview from "@/components/objects/OracleViewRenamePreview.vue";
import { prepareOracleRoutineRename, executeOracleRoutineRename, OracleRoutineRenameFailure, type OracleRoutineRenamePlan } from "@/lib/table/oracleRoutineRename";
import { prepareOracleTableRename, executeOracleTableRename, OracleTableRenameFailure, type OracleTableRenamePlan } from "@/lib/table/oracleTableRename";
import OracleTableRenamePreview from "@/components/objects/OracleTableRenamePreview.vue";
import OracleRoutineRenamePreview from "@/components/objects/OracleRoutineRenamePreview.vue";
import OraclePackageSaveAsDialog from "@/components/objects/OraclePackageSaveAsDialog.vue";
import OracleInvalidObjectsDialog from "@/components/objects/OracleInvalidObjectsDialog.vue";
import { prepareOraclePackageSaveAsExecution, OraclePackageSaveAsFailure, prepareOraclePackageSaveAs, type OraclePackageSaveAsPlan } from "@/lib/table/oraclePackageSaveAs";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { autoRevealExportedPathIfConfigured, promptExportSavePath } from "@/lib/export/exportPath";
import { generateDatabaseExportId } from "@/lib/export/databaseExport";
import { buildXlsxHeaderOverrides, hasXlsxHeaderComments, xlsxHeaderUsesCommentRows, type XlsxExportOptions, type XlsxHeaderMode } from "@/lib/export/xlsxHeader";
import { showSqlInsertModeDialog, type SqlInsertDialect, type SqlInsertMode } from "@/lib/export/sqlInsertMode";
import { showExportExecutionModeDialog } from "@/lib/export/exportExecutionMode";
import type { ManualExportMode } from "@/lib/export/manualExportQueue";
import { SnapshotCompletionError } from "@/lib/export/snapshotCompletion";
import { csvNullLiteralForMode } from "@/lib/export/csvNullMode";
import { copyToClipboard, eventTargetAllowsAppClipboardShortcut, eventTargetUsesNativeClipboard } from "@/lib/common/clipboard";
import { encodeSpreadsheetTsvCell } from "@/lib/common/spreadsheetTsv";
import {
  defaultPasteTableMode,
  pasteTableModeCopiesData,
  supportsWholeRowTableDataCopy,
  tableClipboardMatchesTarget,
  tableClipboardMenuState,
  tableClipboardSourceContext,
  tableDataCopyColumnOptions,
  tablePasteFeedback,
  type PasteTableMode,
  type TableClipboardContext,
} from "@/lib/table/tableClipboard";
import { buildSingleDdlExportFileContent } from "@/lib/export/ddlExport";
import { fetchTableDataForExport } from "@/lib/table/tableDataExport";
import { useConnectionStore } from "@/stores/connectionStore";
import { treeNodePinIdentity, type PinnedTreeNodeIdentity } from "@/lib/app/pinnedItems";
import { useExportTracker, type ExportTask } from "@/composables/useExportTracker";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { useSidebarMenuPresentation } from "@/composables/useSidebarMenuPresentation";
import { formatSidebarTableNamesForCopy, type SidebarTableCopyTarget } from "@/lib/sidebar/sidebarTableNameCopy";
import { useQueryStore } from "@/stores/queryStore";
import { getTableMutationHistoryStoreOrNull, recordTableMutationHistory } from "@/lib/history/tableMutationHistory";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import MySqlEventEditor from "@/components/objects/MySqlEventEditor.vue";
import { sqlFormatDialectForDbType, type SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import { applyDdlDatabaseQualifier, omitDdlIdentifierQuotes } from "@/lib/sql/ddlDisplay";
import { isCancelSearchShortcut } from "@/lib/editor/keyboardShortcuts";
import { parseSlashDelimitedRegexQuery } from "@/lib/common/searchPattern";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { exactOracleTriggerMetadata, oracleTriggerObjectReadOptions, oracleTriggerReadOptions } from "@/lib/database/oracleTriggerIdentity";
import { tablePageRowAnchorKey } from "@/lib/table/tableTree";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { mysqlDataCharsetEnabled } from "@/lib/connection/mysqlDataCharset";
import { buildXuguCompileSql } from "@/lib/database/xuguCompileSql";
import { buildDamengCompileViewSql } from "@/lib/database/damengCompileSql";
import { formatShortcut } from "@/lib/editor/shortcutRegistry";
import { batchTableEmptyFeedback, buildBatchTableEmptyPlan, runBatchTableEmpty, type BatchTableEmptyPlanItem } from "@/lib/sidebar/batchTableEmpty";
import { runBatchTableDrop } from "@/lib/table/batchTableDrop";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { matchesTableNameFilter } from "@/lib/table/tableVGroup";
import { filterSchemaNamesForConnection } from "@/lib/database/visibleDatabases";
import {
  buildObjectBrowserRows,
  buildMongoObjectBrowserRows,
  countObjectBrowserRowsByFilter,
  formatObjectBrowserBytes,
  formatObjectBrowserCount,
  formatObjectBrowserTimestamp,
  canonicalizeObjectBrowserPinnedTreeNodeIdentity,
  initialObjectBrowserSortDirection,
  objectBrowserRowLegacyPinnedTreeNodeIds,
  objectBrowserRowMatchesPinnedTreeNode,
  groupObjectBrowserRows,
  objectBrowserRowPinnedTreeNodeIdentity,
  sortObjectBrowserRows,
  summarizeObjectBrowserSearch,
  type ObjectBrowserFilter,
  type ObjectBrowserRow,
  type ObjectBrowserSortDirection,
  type ObjectBrowserSortKey,
} from "@/lib/table/objectBrowserRows";
import { isSourceOnlyObjectBrowserRow, resolveRowClickAction, shouldDeferSingleClick, singleClickRowAction, type ObjectBrowserRowAction } from "@/lib/table/objectBrowserRowAction";
import { objectBrowserTableSelectionAnchor, objectBrowserTableSelectionRange } from "@/lib/table/objectBrowserSelection";
import { customTypeCapabilities, isOracleFamilyTypeSource, sidebarObjectKindsForDatabase, supportsOracleFamilyTypeManagement, supportsSchemaIndexManagement, supportsTypeObjectSource, type SidebarObjectKind } from "@/lib/database/databaseObjectCapabilities";
import { requestOracleTypeManagement } from "@/lib/table/oracleTypeManagementRequest";
import { schemaIndexIdentity, schemaIndexIsSameOwner } from "@/lib/table/schemaIndexNavigation";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import { filterObjectBrowserTableColumns } from "@/lib/table/objectBrowserTableInfo";
import { visibleMongoCollections } from "@/lib/sidebar/mongoCollectionMutation";
import { createSidePanelRequestGuard } from "@/lib/table/sidePanelRequestGuard";
import { runBatchTableTruncate } from "@/lib/table/batchTableTruncate";
import { tableColumnDefaultDisplayValue } from "@/lib/table/tableColumnDefaultPresentation";
import { gaussdbMTypeDisplayName } from "@/lib/table/postgresDataTypeHelp";
import { cacheObjectBrowserRows, createObjectBrowserRowsCacheWriteToken, getCachedObjectBrowserRowsForScaffold, type ObjectBrowserRowsCacheScope, type ObjectBrowserRowsCacheWriteToken } from "@/lib/table/objectBrowserRowsCache";
import { createObjectBrowserRowsLoadGuard, type ObjectBrowserRowsLoadHandle } from "@/lib/table/objectBrowserRowsLoadGuard";
import { metadataLoadBudgetMs } from "@/lib/metadata/metadataLoadBudget";
import { loadObjectDdl, type ObjectDdlRequest } from "@/lib/metadata/objectDdlCache";
import { loadObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";
import { invalidateObjectDdl, invalidateObjectDdlCache } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { completeOracleInvalidObjectCompile, type OracleInvalidObjectCompileScope } from "@/lib/database/oracleInvalidObjectCacheRefresh";
import { oracleCompileUnsupportedReason, oracleInvalidObjectSourceKind } from "@/lib/database/oracleInvalidObjects";
import { eventEditorInstanceKey, resolveInitialEventEditorRequest } from "@/lib/table/eventEditorRequest";
import { createLocateTabMenuItem } from "@/lib/tabs/tabMenu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type ObjectFilter = ObjectBrowserFilter;
type ObjectBrowserColumnKey = "select" | "name" | "type" | "estimatedRows" | "totalBytes" | "created_at" | "updated_at" | "comment";

const props = defineProps<{
  connection: ConnectionConfig;
  database: string;
  catalog?: string;
  schema?: string;
  initialEventName?: string;
  initialEventReadOnly?: boolean;
  initialEventOpenRequestId?: number;
  /** 显式"新建事件"请求号：每次菜单点击递增，用于打开/重新进入 CREATE 编辑器 */
  initialEventCreateRequestId?: number;
  initialObjectFilter?: "tables" | "events" | "indexes";
  initialIndexCreateRequestId?: number;
  initialViewTarget?: SchemaIndexIdentity;
  initialViewRequestId?: number;
  selectedObjectFilter?: ObjectFilter;
  initialSearchQuery?: string;
  viewport?: ObjectBrowserViewport;
  propertyRequest?: QueryTab["objectPropertiesRequest"];
}>();

const emit = defineEmits<{
  openTable: [target: { tableName: string; schema?: string; tableType?: string; catalog?: string; comment?: string | null }];
  locateTable: [target: { tableName: string; schema?: string; tableType?: string; catalog?: string }];
  schemaChange: [schema: string | undefined];
  viewportChange: [viewport: ObjectBrowserViewport];
  searchChange: [query: string];
  filterChange: [filter: ObjectFilter];
  indexRequestConsumed: [kind: "create" | "view"];
  addToAi: [tables: Array<{ name: string; schema?: string }>];
  openDependencyObject: [context: ObjectDependencyTarget, target: SqlObjectNavigationTarget];
  propertyRequestConsumed: [requestId: string];
}>();

const { t } = useI18n();
const cloneDialog = useOceanbaseCloneDialog(t);
const { state: cloneDialogState, open: cloneDialogOpen } = cloneDialog;
const { toast } = useToast();
const { highlight } = useSqlHighlighter();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const { presentMenu, SidebarMenuPreferencesDialog, sidebarMenuPreferencesOpen, sidebarMenuPreferences } = useSidebarMenuPresentation();
const refreshTooltip = computed(() => {
  const shortcut = formatShortcut(settingsStore.editorSettings.shortcuts.refreshData);
  return shortcut ? `${t("grid.refresh")} (${shortcut})` : t("grid.refresh");
});

const firebirdManagerOpen = ref(false);
const schemas = ref<string[]>([]);
const selectedSchema = ref<string | undefined>(props.schema);
const triggerCreateOpen = ref(false);
const triggerCreateDialog = ref<InstanceType<typeof ObjectSourceDialog>>();
const triggerCreateContext = ref<{ connectionId: string; database: string; catalog?: string; schema: string; databaseType: ConnectionConfig["db_type"] }>();
const canCreateOracleTrigger = computed(() => !!selectedSchema.value && !!oracleTriggerReadOptions(effectiveDatabaseType.value));
function openCreateOracleTrigger() {
  if (!canCreateOracleTrigger.value || !selectedSchema.value) return;
  const context = { connectionId: props.connection.id, database: props.database, catalog: props.catalog, schema: selectedSchema.value, databaseType: effectiveDatabaseType.value };
  if (JSON.stringify(triggerCreateContext.value) !== JSON.stringify(context)) {
    if (triggerCreateDialog.value?.hasUnsavedDraft() && !window.confirm(t("objects.refreshDiscardConfirm"))) return;
    triggerCreateContext.value = context;
  }
  triggerCreateOpen.value = true;
}
watch([() => props.connection.id, () => props.database, () => props.catalog, selectedSchema], () => {
  triggerCreateOpen.value = false;
});
function refreshCreatedTrigger() {
  const context = triggerCreateContext.value;
  if (context && context.connectionId === props.connection.id && context.database === props.database && context.catalog === props.catalog && context.schema === selectedSchema.value) void reload({ preserveExistingRows: true });
}
const oracleInvalidObjectsOpen = ref(false);
const invalidTriggerContext = shallowRef<{ target: Readonly<OracleTriggerTarget>; expectedObjectId?: string; originRevision: number }>();
let invalidObjectsDialogGeneration = 0;
let invalidObjectSourceRequestGeneration = 0;
let objectBrowserUnmounted = false;
const rows = ref<ObjectBrowserRow[]>([]);
const rootRef = ref<HTMLElement>();
const search = ref(props.initialSearchQuery ?? "");
function initialObjectBrowserFilter(): ObjectFilter {
  const preferred = props.selectedObjectFilter ?? props.initialObjectFilter;
  if (preferred === "indexes") return "indexes";
  if (props.connection.db_type === "oceanbase-oracle") return preferred ?? "tables";
  return preferred === "triggers" && oracleTriggerObjectReadOptions(props.connection, ["TRIGGER"], props.catalog) ? "triggers" : "all";
}
const objectFilter = ref<ObjectFilter>(initialObjectBrowserFilter());
const userHasSelectedFilter = ref(false);
const sortKey = ref<ObjectBrowserSortKey>("name");
const sortDirection = ref<ObjectBrowserSortDirection>("asc");
const loadingSchemas = ref(false);
const loadingObjects = ref(false);
const loadingMoreObjects = ref(false);
const hasMoreObjects = ref(false);
let objectPageOffset = 0;
let objectPageNextAnchor: string | undefined;
let objectSearchTimer: ReturnType<typeof setTimeout> | undefined;
const refreshingObjects = ref(false);
const scaffoldRefreshError = ref("");
const sourceLoading = ref(false);
const sourceContent = ref("");
const sourceError = ref("");
const sourceRow = ref<ObjectBrowserRow | null>(null);
const sourceEditing = ref(false);
const sourceCanEdit = ref(true);
const showCompileErrorDialog = ref(false);
const compileErrorTitle = ref("");
const compileErrorMessage = ref("");
// --- Right-side panel state ---
// Unified panel: either "table-info" (for tables) or "source" (for views/procedures/etc.)
const sidePanelRow = ref<ObjectBrowserRow | null>(null);
const openedInitialEvent = ref("");
const isEventEditor = computed(() => sidePanelMode.value === "event-editor");
const isSidePanelOpen = computed(() => !!sidePanelRow.value || isEventEditor.value);
const sidePanelMode = ref<"table-info" | "source" | "type-info" | "event-editor">("source");
const isSchemaIndexInfo = computed(() => sidePanelMode.value === "table-info" && sidePanelRow.value?.type === "INDEX");
const eventEditorKey = computed(() =>
  eventEditorInstanceKey({
    createRequestId: props.initialEventCreateRequestId,
    openRequestId: props.initialEventOpenRequestId,
    rowId: sidePanelRow.value?.id,
  }),
);
// Table info panel state
const tableInfoTab = ref<TableInfoTab>("ddl");
const tableOverviewStats = ref<ObjectStatistics | null>(null);
const tableOverviewComment = ref<string | null>(null);
const tableOverviewLoading = ref(false);
const tableOverviewLoaded = ref(false);
const tableColumns = ref<ColumnInfo[]>([]);
const tableColumnsLoading = ref(false);
const tableColumnsLoaded = ref(false);
const rawTableDdlContent = ref("");
const tableDdlContent = computed(() => applyDdlTextPreferences(rawTableDdlContent.value, effectiveDatabaseType.value, settingsStore.editorSettings));
const tableDdlLoading = ref(false);
const tableDdlLoaded = ref(false);
let tableDdlRequestId = 0;
const tableIndexes = ref<IndexInfo[]>([]);
const tableIndexesLoading = ref(false);
const tableIndexesLoaded = ref(false);
const tableIndexesError = ref("");
const tableForeignKeys = ref<ForeignKeyInfo[]>([]);
const tableForeignKeysLoading = ref(false);
const tableForeignKeysLoaded = ref(false);
const tableTriggers = ref<TriggerInfo[]>([]);
const tableTriggersLoading = ref(false);
const tableTriggersLoaded = ref(false);
const tableConstraints = ref<ConstraintInfo[]>([]);
const tableConstraintsLoading = ref(false);
const tableConstraintsLoaded = ref(false);
const tableConstraintsError = ref("");
const tablePartitions = ref<PgTablePartitioning | null>(null);
const tablePartitionsLoading = ref(false);
const tablePartitionsLoaded = ref(false);
// Only tables that actually are partitioned get the Partitions tab; the cheap
// partition-status probe decides before the full tree is fetched.
const tableIsPartitioned = ref(false);
const tablePartitionStatusResolved = ref(false);
// The Constraints tab hides foreign keys when the dedicated Foreign Keys tab
// is also shown, mirroring DataGrid/TableStructureEditor.
const tableConstraintsForTab = computed(() => constraintsForConstraintsTab(tableConstraints.value, tableMetadataCapabilities.value.foreignKeys));
const tableInfoSearchQuery = ref("");
const selectedTableInfoColumns = ref<string[]>([]);
watch(tableInfoSearchQuery, () => {
  selectedTableInfoColumns.value = [];
});
const tableInfoDdlPreRef = ref<HTMLPreElement | null>(null);
const activeTableInfoLoading = computed(() => {
  if (tableInfoTab.value === "info") return tableOverviewLoading.value;
  if (tableInfoTab.value === "ddl") return tableDdlLoading.value;
  if (tableInfoTab.value === "columns") return tableColumnsLoading.value;
  if (tableInfoTab.value === "indexes") return tableIndexesLoading.value;
  if (tableInfoTab.value === "foreignKeys") return tableForeignKeysLoading.value;
  if (tableInfoTab.value === "partitions") return tablePartitionsLoading.value;
  if (tableInfoTab.value === "constraints") return tableConstraintsLoading.value;
  return tableInfoTab.value === "triggers" && tableTriggersLoading.value;
});
const SIDE_PANEL_MIN_WIDTH = 280;
const SIDE_PANEL_MAX_WIDTH = 900;
const sidePanelWidth = ref(settingsStore.editorSettings.tableInfoDrawerWidth || 420);
let sidePanelResizeStartX = 0;
let sidePanelResizeStartWidth = 0;
const isResizingSidePanel = ref(false);
const sidePanelGuard = createSidePanelRequestGuard();
const sidePanelRef = ref<InstanceType<typeof CustomTypeInfoPanel> | null>(null);
const tableMetadataCapabilities = computed<TableMetadataCapabilities>(() => getTableMetadataCapabilities(effectiveDatabaseType.value, { connectionType: props.connection.db_type, exactIdentity: sidePanelRow.value?.type === "INDEX" }));
const effectiveDatabaseType = computed(() => effectiveDatabaseTypeForConnection(props.connection) ?? props.connection.db_type);
const sourceSection = ref<ObjectDetailsSection>("source");
const tableRelationsSection = ref<ObjectDetailsSection>("dependencies");
const propertyFocus = ref<NonNullable<QueryTab["objectPropertiesRequest"]>["focusObject"]>();
const dependencyTarget = computed(() => {
  const row = sidePanelRow.value;
  if (row && sidePanelMode.value === "table-info" && propertyFocus.value)
    return objectDependencyTarget({ connectionId: props.connection.id, database: props.database, catalog: props.catalog, schema: propertyFocus.value.owner, name: propertyFocus.value.name, objectType: propertyFocus.value.type }, effectiveDatabaseType.value);
  return row ? objectDependencyTarget({ connectionId: props.connection.id, database: props.database, catalog: props.catalog, schema: row.schema || selectedSchema.value || props.database, name: row.name, objectType: row.type }, effectiveDatabaseType.value) : undefined;
});
function viewRelationSql(context: ObjectDependencyTarget, sql: string) {
  queryStore.createTab(context.connectionId, context.database, t("objectDependencies.viewSql"), "query", context.schema, sql, context.catalog, { forceNew: true });
}
function openRelationObject(context: ObjectDependencyTarget, target: SqlObjectNavigationTarget) {
  if (sidePanelMode.value === "source" && sourceEditing.value && sourceDraft.value !== sourceEditableText.value && !window.confirm(t("objectDependencies.navigateDiscardConfirm"))) return;
  emit("openDependencyObject", context, target);
}
const oracleInvalidObjectsSupported = computed(() => effectiveDatabaseType.value === "oracle" || effectiveDatabaseType.value === "oceanbase-oracle");
const supportsExactTriggerDiscovery = computed(() => !!oracleTriggerObjectReadOptions(props.connection, ["TRIGGER"], props.catalog));
const supportsSchemaIndexes = computed(() => supportsSchemaIndexManagement(effectiveDatabaseType.value));
const exactIndexList = computed(() => supportsSchemaIndexes.value && objectFilter.value === "indexes");
const usesServerObjectPaging = computed(() => props.connection.db_type === "oceanbase-oracle" || exactIndexList.value || (objectFilter.value === "triggers" && supportsExactTriggerDiscovery.value));
const objectPageSize = computed(() => Math.max(1, Math.min(10_000, Math.floor(settingsStore.desktopSettings?.sidebar_table_page_size || 500))));
const isGaussdbM = computed(() => effectiveDatabaseType.value === "gaussdb" && props.connection.driver_profile?.toLowerCase() === "gaussdb-m");

function setOracleInvalidObjectsOpen(open: boolean) {
  if (oracleInvalidObjectsOpen.value !== open) invalidObjectsDialogGeneration++;
  oracleInvalidObjectsOpen.value = open;
  if (!open) invalidTriggerContext.value = undefined;
}

function openBrowserTriggerDiagnostics() {
  const snapshot = sourceTriggerSnapshot.value;
  if (!snapshot?.exists) return;
  invalidTriggerContext.value = { target: snapshot.target, expectedObjectId: snapshot.metadata.objectId ?? undefined, originRevision: sidePanelGuard.capture() };
  setOracleInvalidObjectsOpen(true);
}

watch(
  () => [props.connection.id, JSON.stringify(props.connection), props.database, props.catalog, selectedSchema.value] as const,
  () => invalidObjectsDialogGeneration++,
  { flush: "sync" },
);
const isVictoriaMetrics = computed(() => effectiveDatabaseType.value === "victoriametrics");
const isMongodb = computed(() => props.connection.db_type === "mongodb");
// Neither VictoriaMetrics series nor NebulaGraph tag/edge metadata has table byte-size stats.
const supportsObjectSizeStats = computed(() => !isVictoriaMetrics.value && effectiveDatabaseType.value !== "nebula");
// The batch table toolbar (export/copy/truncate/empty/drop selected) is SQL-only:
// MongoDB collections are not dropped or truncated through it.
const supportsBatchTableActions = computed(() => !isVictoriaMetrics.value && !isMongodb.value && effectiveDatabaseType.value !== "nebula");
const showTableStatistics = computed(() => !usesServerObjectPaging.value && effectiveDatabaseType.value !== "nebula" && (objectFilter.value === "all" || objectFilter.value === "tables"));
const showObjectRowStats = computed(() => showTableStatistics.value);
const showObjectSizeStats = computed(() => supportsObjectSizeStats.value && showTableStatistics.value);
const objectRowsLabel = computed(() => t(isVictoriaMetrics.value ? "objects.series" : "objects.rows"));

function toggleTableDdlWordWrap() {
  settingsStore.updateEditorSettings({
    tableDdlWordWrap: !settingsStore.editorSettings.tableDdlWordWrap,
  });
}

function gaussdbMColumnType(dataType: string): string {
  if (isGaussdbM.value) {
    return gaussdbMTypeDisplayName(dataType);
  }
  return dataType;
}
const tableStructureDatabaseType = computed(() => tableStructureDatabaseTypeForConnection(props.connection) ?? props.connection.db_type);
const sourceEditableText = ref("");
const sourceDraft = ref("");
const sourceSaving = ref(false);
const sourceSaveError = ref("");
const sourceTriggerSnapshot = ref<OracleTriggerSnapshot>();
const sourceDependencyTarget = computed(() => {
  const row = sourceRow.value;
  if (!row) return undefined;
  return objectDependencyTarget({ connectionId: props.connection.id, database: props.database, catalog: props.catalog, schema: row.schema ?? selectedSchema.value ?? props.database, name: row.name, objectType: row.type }, effectiveDatabaseType.value, row.trigger);
});
watch(
  () => [props.connection.id, props.database, props.catalog, sourceRow.value?.id],
  () => {
    sourceSection.value = "source";
  },
  { flush: "sync" },
);
const sourceTriggerResult = ref<OracleTriggerExecutionResult>();
const sourceTriggerIssue = ref("");
const sourceTriggerRequested = ref(false);
const browserTriggerBusy = ref(false);
const browserTriggerActive = ref(true);
const browserTriggerViewRevision = ref(0);
const browserTriggerFeedback = shallowRef<{ target: Readonly<OracleTriggerTarget>; row: ObjectBrowserRow; result: OracleTriggerExecutionResult; snapshot?: OracleTriggerSnapshot; pinnedContext?: ReturnType<typeof objectBrowserPinnedTreeNodeContext> }>();
const browserTriggerContext = () => JSON.stringify([props.connection.id, props.database, props.catalog, selectedSchema.value, objectFilter.value, search.value]);
watch(
  () => [browserTriggerContext(), loadingObjects.value, refreshingObjects.value, loadingMoreObjects.value],
  () => browserTriggerViewRevision.value++,
  { flush: "sync" },
);
watch(showCompileErrorDialog, (open) => {
  if (!open) browserTriggerFeedback.value = undefined;
});
onDeactivated(() => {
  browserTriggerActive.value = false;
});
const error = ref("");
const showDropConfirm = ref(false);
const dropTarget = ref<ObjectBrowserRow | null>(null);
const dropPreviewSql = ref("");
const dropPreviewError = ref("");
const triggerDropPreview = shallowRef<BrowserTriggerDropPreview>();
const dropTableCascade = ref(false);
const batchDropCascade = ref(false);
const showRenameDialog = ref(false);
const renameTarget = ref<ObjectBrowserRow | null>(null);
const renameInput = ref("");
const renameError = ref("");
const renamePreviewSqlText = ref("");
const viewRenamePlan = ref<OracleViewRenamePlan>();
const viewRenameDrafts = ref<Record<string, string>>({});
const routineRenamePlan = ref<OracleRoutineRenamePlan>();
const routineRenameDrafts = ref<Record<string, string>>({});
const tableRenamePlan = ref<OracleTableRenamePlan>();
const tableRenameDrafts = ref<Record<string, string>>({});
const packageSaveAsOpen = ref(false);
const packageSaveAsTarget = ref<ObjectBrowserRow | null>(null);
const packageSaveAsName = ref("");
const packageSaveAsPlan = ref<OraclePackageSaveAsPlan>();
const packageSaveAsDrafts = ref<{ spec?: string; body?: string }>({});
const packageSaveAsLoading = ref(false);
const packageSaveAsValidating = ref(false);
const packageSaveAsExecuting = ref(false);
const packageSaveAsError = ref("");
const packageSaveAsDiagnostic = ref("");
const viewRenameLoading = ref(false);
const viewRenameValidating = ref(false);
const viewRenameExecuting = ref(false);
const showTruncateConfirm = ref(false);
const truncateTarget = ref<ObjectBrowserRow | null>(null);
const truncatePreviewSql = ref("");
const truncateTableCascade = ref(false);
const showVacuumConfirm = ref(false);
const vacuumTarget = ref<ObjectBrowserRow | null>(null);
const vacuumPreviewSql = ref("");
const vacuumTableFull = ref(false);
const vacuumTableAnalyze = ref(false);
const vacuumExecuting = ref(false);
const showEmptyConfirm = ref(false);
const emptyTarget = ref<ObjectBrowserRow | null>(null);
const emptyPreviewSql = ref("");
const showDuplicateDialog = ref(false);
const duplicateTarget = ref<ObjectBrowserRow | null>(null);
const duplicateTableName = ref("");
const showProcedureExecutionConfirm = ref(false);
const procedureExecutionTarget = ref<ObjectBrowserRow | null>(null);
const selectedTableIds = ref<Set<string>>(new Set());
const tableSelectionAnchorId = ref<string | null>(null);
const selectedRowId = ref<string | null>(null);
const expandedPartitionParentIds = ref<Set<string>>(new Set());
const showBatchDropConfirm = ref(false);
const batchDropExecuting = ref(false);
const batchDropProgress = ref({ completed: 0, total: 0 });
const batchDropPreviewSql = ref("");
const batchDropPreviewError = ref("");
const batchTriggerDropRequested = ref(false);
const batchTriggerDropPreview = shallowRef<BrowserTriggerDropPreview>();
const showBatchTruncateConfirm = ref(false);
const batchTruncatePreviewSql = ref("");
const batchTruncateCascade = ref(false);
const showBatchEmptyConfirm = ref(false);
const batchEmptyPreviewSql = ref("");
const batchEmptyPlan = ref<BatchTableEmptyPlanItem<ObjectBrowserRow>[]>([]);
// Paste table dialog state
const showPasteDialog = ref(false);
const pasteTableMode = ref<PasteTableMode>("structure-and-data");
const pasteTableEntries = ref<{ sourceName: string; targetName: string; schema?: string; tableComment?: string | null }[]>([]);
const pasteTableFromClipboard = ref(false);
const pasteTableDataCopySupported = computed(() => supportsWholeRowTableDataCopy(effectiveDatabaseType.value));
const objectColumnWidths = ref<Record<ObjectBrowserColumnKey, number>>({
  select: 34,
  name: 260,
  type: 110,
  estimatedRows: 110,
  totalBytes: 100,
  created_at: 150,
  updated_at: 150,
  comment: 260,
});
const objectColumnVisibility = ref<Partial<Record<ObjectBrowserColumnKey, boolean>>>({});
const objectColumnVisibilityStorageKey = computed(() => `dbx-object-browser-columns:v1:${props.connection.id}:${props.database}:${selectedSchema.value ?? ""}`);
const objectColumnDefinitions = computed(() => [
  { key: "name" as const, label: t("objects.name") },
  { key: "type" as const, label: t("objects.type") },
  ...(showObjectRowStats.value ? [{ key: "estimatedRows" as const, label: objectRowsLabel.value }] : []),
  ...(showObjectSizeStats.value ? [{ key: "totalBytes" as const, label: t("objects.size") }] : []),
  ...(hasCreatedAt.value ? [{ key: "created_at" as const, label: t("objects.createdAt") }] : []),
  ...(hasUpdatedAt.value ? [{ key: "updated_at" as const, label: t("objects.updatedAt") }] : []),
  { key: "comment" as const, label: t("objects.comment") },
]);
function isObjectColumnVisible(key: ObjectBrowserColumnKey) {
  return key === "name" || objectColumnVisibility.value[key] !== false;
}
function toggleObjectColumnVisibility(key: ObjectBrowserColumnKey) {
  if (key === "name") return;
  objectColumnVisibility.value = { ...objectColumnVisibility.value, [key]: !isObjectColumnVisible(key) };
  localStorage.setItem(objectColumnVisibilityStorageKey.value, JSON.stringify(objectColumnVisibility.value));
  nextTick(() => syncObjectListHeaderScroll());
}
function loadObjectColumnVisibility() {
  try {
    const saved = JSON.parse(localStorage.getItem(objectColumnVisibilityStorageKey.value) || "{}");
    if (saved && typeof saved === "object") objectColumnVisibility.value = saved;
  } catch {
    objectColumnVisibility.value = {};
  }
}
watch(objectColumnVisibilityStorageKey, loadObjectColumnVisibility, { immediate: true });
const objectBrowserRowsLoadGuard = createObjectBrowserRowsLoadGuard();
// schema 列表的失效只跟随上下文（连接/库/schema 变化、卸载），不跟随对象列表加载：
// loadObjects() 会推进 objectBrowserRowsLoadGuard 的 epoch，若两者共用一个 epoch，
// 与对象列表并行发起的 loadSchemas 会被判定为过期而放弃写入 schema 列表 (#8665)。
const schemaListLoadGuard = createObjectBrowserRowsLoadGuard();
let stopColumnResize: (() => void) | null = null;
let preserveObjectFilterScrollOnce = false;

// Export via background tracker
const exportTracker = useExportTracker();
const { addTask: addExportTask, updateTableExportTask } = exportTracker;

const needsSchema = computed(() => isSchemaAware(props.connection.db_type) && !connectionUsesDatabaseObjectTreeMode(props.connection));
const canDropTargetCascade = computed(() => dropTarget.value?.type === "TABLE" && supportsDropTableCascade(effectiveDatabaseType.value));
const canTruncateTargetCascade = computed(() => !!truncateTarget.value && supportsTruncateTableCascade(effectiveDatabaseType.value));
const objectNameFilters = computed(() => {
  const groupTypes = { TABLE: "group-tables", VIEW: "group-views", MATERIALIZED_VIEW: "group-materialized-views", PROCEDURE: "group-procedures", FUNCTION: "group-functions" } as const;
  const filters: Partial<Record<ObjectBrowserRow["type"], TableNameFilter>> = {};
  for (const [type, nodeKind] of Object.entries(groupTypes)) {
    filters[type as keyof typeof groupTypes] = connectionStore.tableNameFilterForScope({
      connectionId: props.connection.id,
      database: props.database,
      schema: connectionObjectTreeNodeSchema(props.connection, props.database, selectedSchema.value),
      catalog: props.catalog,
      nodeKind,
    });
  }
  return filters;
});
// Keep cached metadata intact so clearing a saved filter restores rows immediately.
const nameFilteredRows = computed(() => rows.value.filter((row) => matchesTableNameFilter(row.name, objectNameFilters.value[row.type])));
const objectCounts = computed(() => countObjectBrowserRowsByFilter(nameFilteredRows.value));
// Count direct search matches once; partition parents rendered only for context must not inflate badges.
const objectSearchSummary = computed(() => summarizeObjectBrowserSearch(nameFilteredRows.value, search.value));
const canOpenStructureEditor = computed(() => supportsTableStructureEditing(tableStructureDatabaseType.value));
const canCreateSchemaIndex = computed(() => supportsSchemaIndexes.value && !connectionIsEffectivelyReadOnly(props.connection));
const canOpenDiagram = computed(() => !!props.database && supportsSchemaDiagram(effectiveDatabaseType.value));
const canOpenDataDictionary = computed(() => !!props.database && supportsDataDictionary(effectiveDatabaseType.value));
const canOpenTableImport = computed(() => !!props.database && supportsTableImport(effectiveDatabaseType.value));
const supportsTruncateTable = computed(() => supportsTableTruncate(effectiveDatabaseType.value));
const supportsVacuumTable = computed(() => !connectionIsEffectivelyReadOnly(props.connection) && supportsTableVacuum(effectiveDatabaseType.value));
const vacuumRiskMessage = computed(() => (vacuumExecuting.value ? t("contextMenu.vacuumTableRunningHint") : vacuumTableFull.value ? t("contextMenu.vacuumTableFullRisk") : vacuumTableAnalyze.value ? t("contextMenu.vacuumTableAnalyzeRisk") : t("contextMenu.vacuumTableDefaultRisk")));
const sourceDialect = computed(() => codeMirrorSqlDialect(effectiveDatabaseType.value));
const sourceFormatDialect = computed<SqlFormatDialect>(() => sqlFormatDialectForDbType(effectiveDatabaseType.value));
const objectFilters = computed<ObjectFilter[]>(() =>
  props.connection.db_type === "oceanbase-oracle"
    ? ["all", "tables", "views", "procedures", "functions", "triggers", "sequences", ...(supportsSchemaIndexes.value ? ["indexes" as const] : []), "packages", "types"]
    : (
        [
          ["all", objectCounts.value.all],
          ["tables", objectCounts.value.tables],
          ["views", objectCounts.value.views],
          ["materializedViews", objectCounts.value.materializedViews],
          ["procedures", objectCounts.value.procedures],
          ["functions", objectCounts.value.functions],
          ["triggers", objectCounts.value.triggers],
          ["events", objectCounts.value.events],
          ["sequences", objectCounts.value.sequences],
          ["indexes", objectCounts.value.indexes],
          ["packages", objectCounts.value.packages],
          ["types", objectCounts.value.types],
        ] as Array<[ObjectFilter, number]>
      )
        .filter(([filter, count]) => filter === "all" || count > 0 || (filter === "triggers" && supportsExactTriggerDiscovery.value) || (filter === "indexes" && supportsSchemaIndexes.value))
        .map(([filter]) => filter),
);
const showObjectFilter = computed(() => objectFilters.value.length > 2 || (supportsExactTriggerDiscovery.value && objectFilters.value.length > 1) || (supportsSchemaIndexes.value && objectFilters.value.includes("indexes")));
// A scope that holds a single object kind makes "全部 14" and "表 14" the same number, so the
// strip is dropped as redundant — which used to drop the only object count the toolbar could
// show at all (t8y2/dbx#11624, the common MySQL "tables only" database). Keep that one kind's
// count visible on its own instead; it stays a value, not a filter control, because with a
// single kind there is no 全部 chip left for the user to reset the selection back to.
const singleKindFilter = computed<ObjectFilter | null>(() => (!showObjectFilter.value && objectFilters.value.length === 2 ? (objectFilters.value.find((filter) => filter !== "all") ?? null) : null));
// Measured condensation for the header row: tier 1 moves the sort/view/checkbox
// controls into the overflow menu, tier 2 additionally moves the object type
// filter there and drops the database chip. See useToolbarOverflow for the
// tier contract.
const toolbarRef = ref<HTMLElement | null>(null);
const { tier: toolbarTier } = useToolbarOverflow(toolbarRef, [
  () => props.database,
  () => selectedSchema.value,
  () => needsSchema.value,
  () => showObjectFilter.value,
  () => singleKindFilter.value,
  () => objectFilters.value.length,
  () => objectCounts.value,
  () => objectFilter.value,
  () => canCreateSchemaIndex.value,
  () => oracleInvalidObjectsSupported.value,
  () => settingsStore.editorSettings.objectBrowserViewMode,
]);
const showToolbarOverflow = computed(() => toolbarTier.value >= 1);
const showInlineSortAndView = computed(() => toolbarTier.value < 1);
const showInlineCheckboxToggle = computed(() => toolbarTier.value < 1);
const showInlineSidePanelToggle = computed(() => toolbarTier.value < 1);
const showInlineObjectFilter = computed(() => toolbarTier.value < 2);
const showDatabaseChip = computed(() => toolbarTier.value < 2);
const hasCreatedAt = computed(() => rows.value.some((row) => row.created_at?.trim()));
const hasUpdatedAt = computed(() => rows.value.some((row) => row.updated_at?.trim()));
const hasAnyComment = computed(() => rows.value.some((row) => row.comment?.trim()));
const viewMode = computed<ObjectBrowserViewMode>(() => settingsStore.editorSettings.objectBrowserViewMode);
const isListView = computed(() => viewMode.value === "list");
const isGridView = computed(() => viewMode.value === "grid");
const isCompactView = computed(() => viewMode.value === "compact");
const compactCardWidth = computed(() => normalizeObjectBrowserCompactWidth(settingsStore.editorSettings.objectBrowserCompactWidth));

function setCompactCardWidth(width: ObjectBrowserCompactWidth) {
  settingsStore.updateEditorSettings({ objectBrowserCompactWidth: width });
}

type ObjectBrowserScroller =
  | HTMLElement
  | {
      scrollToItem?: (index: number) => void;
      scrollToPosition?: (position: number) => void;
      $el?: HTMLElement;
      el?: HTMLElement | { value?: HTMLElement | null };
    };

// RecycleScroller exposes scroll helpers on its component instance. Keep the
// type loose because vue-virtual-scroller does not ship complete ref typings.
const listScrollerRef = ref<ObjectBrowserScroller | null>(null);
const gridScrollerRef = ref<ObjectBrowserScroller | null>(null);
const objectListHeaderRef = ref<HTMLElement | null>(null);
let viewportFrame = 0;
let restoreViewportFrame = 0;

function objectBrowserViewMode(): ObjectBrowserViewMode {
  return viewMode.value;
}

function activeScroller() {
  return isListView.value ? listScrollerRef.value : gridScrollerRef.value;
}

function scrollerElement(scroller: ObjectBrowserScroller | null = activeScroller()): HTMLElement | null {
  if (!scroller) return null;
  if (scroller instanceof HTMLElement) return scroller;
  if (scroller.$el instanceof HTMLElement) return scroller.$el;
  if (scroller.el instanceof HTMLElement) return scroller.el;
  if (scroller.el?.value instanceof HTMLElement) return scroller.el.value;
  return null;
}

function emitViewportChange(scrollTop: number) {
  const viewport: ObjectBrowserViewport = {
    scrollTop: Math.max(0, Math.round(scrollTop)),
    viewMode: objectBrowserViewMode(),
  };
  if (props.viewport?.scrollTop === viewport.scrollTop && props.viewport.viewMode === viewport.viewMode) return;
  emit("viewportChange", viewport);
}

function onObjectsScroll() {
  syncObjectListHeaderScroll();
  if (viewportFrame) return;
  viewportFrame = window.requestAnimationFrame(() => {
    viewportFrame = 0;
    const el = scrollerElement();
    if (!el) return;
    emitViewportChange(el.scrollTop);
  });
}

// The list header sits outside the row scroller and is clipped (overflow:
// hidden), so keep its programmatic scrollLeft aligned with the scroller's
// horizontal position on every scroll, resize, and (re)attach.
function syncObjectListHeaderScroll() {
  if (!isListView.value) return;
  const header = objectListHeaderRef.value;
  const el = scrollerElement(listScrollerRef.value);
  if (!header || !el) return;
  if (header.scrollLeft !== el.scrollLeft) header.scrollLeft = el.scrollLeft;
}

function flushObjectBrowserViewport() {
  if (viewportFrame) {
    window.cancelAnimationFrame(viewportFrame);
    viewportFrame = 0;
  }
  const el = scrollerElement();
  if (!el) return;
  emitViewportChange(el.scrollTop);
}

function applyObjectBrowserScrollTop(scrollTop: number) {
  const scroller = activeScroller();
  if (scroller && !(scroller instanceof HTMLElement)) {
    scroller.scrollToPosition?.(scrollTop);
    if (scrollTop === 0) scroller.scrollToItem?.(0);
  }
  const el = scrollerElement(scroller);
  if (el) el.scrollTop = scrollTop;
}

function restoreObjectBrowserViewport() {
  const viewport = props.viewport;
  if (!viewport || viewport.viewMode !== objectBrowserViewMode()) return;
  if (restoreViewportFrame) window.cancelAnimationFrame(restoreViewportFrame);
  const scrollTop = Math.max(0, viewport.scrollTop);
  nextTick(() => {
    applyObjectBrowserScrollTop(scrollTop);
    restoreViewportFrame = window.requestAnimationFrame(() => {
      applyObjectBrowserScrollTop(scrollTop);
      restoreViewportFrame = 0;
    });
  });
}

function scrollObjectsToTop() {
  // Read the active scroller inside nextTick so that after a list <-> grid
  // switch the (re)mounted scroller is the one we reset.
  emitViewportChange(0);
  nextTick(() => {
    applyObjectBrowserScrollTop(0);
  });
}

watch(
  [listScrollerRef, gridScrollerRef, isListView],
  (_value, _oldValue, onCleanup) => {
    const el = scrollerElement();
    if (!el) return;
    el.addEventListener("scroll", onObjectsScroll, { passive: true });
    restoreObjectBrowserViewport();
    nextTick(() => syncObjectListHeaderScroll());
    onCleanup(() => el.removeEventListener("scroll", onObjectsScroll));
  },
  { flush: "post" },
);

onActivated(() => {
  browserTriggerActive.value = true;
  restoreObjectBrowserViewport();
});

function setViewMode(mode: ObjectBrowserViewMode) {
  settingsStore.updateEditorSettings({ objectBrowserViewMode: mode });
  scrollObjectsToTop();
}

// Re-sorting reorders the rows; jump to the top so the new head is visible
// instead of leaving the view parked at a stale mid-scroll position.
// Note: watch(sortKeyOptions) may reset sortKey during setup when the persisted key
// is no longer valid, triggering this watcher before any scroller is mounted —
// scrollObjectsToTop() handles that safely via optional chaining.
watch([sortKey, sortDirection], () => scrollObjectsToTop());

// Also jump to the top when the search query or object-type filter changes —
// filtered results bear no relation to the previous scroll position.
watch(
  search,
  (value) => {
    scrollObjectsToTop();
    emit("searchChange", value);
    if (usesServerObjectPaging.value) {
      clearTimeout(objectSearchTimer);
      objectBrowserRowsLoadGuard.invalidate();
      rows.value = [];
      hasMoreObjects.value = false;
      objectPageNextAnchor = undefined;
      loadingMoreObjects.value = false;
      loadingObjects.value = true;
      if (!value.trim()) void loadObjects();
      else objectSearchTimer = setTimeout(() => void loadObjects(), 300);
    }
  },
  { flush: "sync" },
);
watch(objectFilter, () => {
  if (preserveObjectFilterScrollOnce) {
    preserveObjectFilterScrollOnce = false;
    return;
  }
  scrollObjectsToTop();
});
watch([() => props.initialEventName, () => props.initialEventOpenRequestId, rows, loadingObjects], openInitialEventIfNeeded, { flush: "post" });
watch(
  () => props.connection.show_system_schemas,
  (value, oldValue) => {
    if (value === oldValue) return;
    void reload();
  },
);

const showCheckboxColumn = computed(() => supportsBatchTableActions.value && (settingsStore.editorSettings.objectBrowserShowCheckbox || selectedTableCount.value > 0));

function toggleCheckboxColumn() {
  const next = !settingsStore.editorSettings.objectBrowserShowCheckbox;
  settingsStore.updateEditorSettings({ objectBrowserShowCheckbox: next });
  if (!next) clearTableSelection();
}

const objectBrowserColumns = computed<ObjectBrowserColumnKey[]>(() => {
  const columns: ObjectBrowserColumnKey[] = [];
  if (showCheckboxColumn.value) columns.push("select");
  for (const definition of objectColumnDefinitions.value) if (isObjectColumnVisible(definition.key)) columns.push(definition.key);
  return columns;
});
function isLastVisibleObjectColumn(key: ObjectBrowserColumnKey) {
  const visibleColumns = objectBrowserColumns.value.filter((column) => column !== "select");
  return visibleColumns[visibleColumns.length - 1] === key;
}
const gridTemplateColumns = computed(() => {
  return objectBrowserColumns.value
    .map((key, index, columns) => {
      const width = objectColumnWidths.value[key];
      if (key === "select") return `${width}px`;
      if (index === columns.length - 1) return `minmax(${width}px,1fr)`;
      return `${width}px`;
    })
    .join(" ");
});
const objectGridMinWidth = computed(() => {
  return objectBrowserColumns.value.reduce((total, key) => total + objectColumnWidths.value[key], 0) + Math.max(0, objectBrowserColumns.value.length - 1) * 12 + 24;
});

const groupedRows = computed(() => groupedFilteredRows());
const filteredRows = computed(() => groupedRows.value.rows);

/** Nesting level of a partition row (0 for a top-level object). */
function partitionRowDepth(row: ObjectBrowserRow): number {
  return groupedRows.value.depths.get(row.id) ?? 0;
}
const selectableRows = computed(() => nameFilteredRows.value);

// ---- Grid (tile) view virtualization ----
// The grid view chunks filteredRows into fixed-height rows and hands them to
// RecycleScroller, mirroring the list view so only visible rows are mounted.
// The previous flat `v-for` rendered every card (plus its CustomContextMenu)
// at once, which stalls the UI on schemas with thousands of objects.
const OBJECT_GRID_MIN_CARD_WIDTH = 160; // former `minmax(160px, 1fr)` floor
const OBJECT_GRID_GAP = 12; // 0.75rem, former grid gap (both axes)
const OBJECT_COMPACT_GAP = 4;
// Card height is dataset-stable: if any object has timestamps/comments, every card
// reserves those slots (even when empty) so borders stay level across a row.
// objectGridRowHeight adapts to the dataset instead of always using the worst case.
//   Base: p-3 top+bottom(24) + icon h-11(44) + name(18) + type/bytes(18) + gap-1×2(8) = 112
//   + optional timestamp row: text-[10px](15) + gap-1(4) = 19
//   + optional comment row:   text-[10px](15) + gap-1(4) = 19
// If the card gains a new metadata row, add a matching constant and include it below.
const OBJECT_GRID_CARD_BASE_H = 112;
const OBJECT_GRID_CARD_TIMESTAMP_H = 19;
const OBJECT_GRID_CARD_COMMENT_H = 19;
const OBJECT_GRID_CARD_SAFETY = 6; // buffer for sub-pixel font differences

const objectGridRowHeight = computed(() => {
  if (isCompactView.value) return 28 + OBJECT_COMPACT_GAP;
  let cardH = OBJECT_GRID_CARD_BASE_H;
  if (hasCreatedAt.value || hasUpdatedAt.value) cardH += OBJECT_GRID_CARD_TIMESTAMP_H;
  if (hasAnyComment.value) cardH += OBJECT_GRID_CARD_COMMENT_H;
  return cardH + OBJECT_GRID_GAP + OBJECT_GRID_CARD_SAFETY;
});
const gridContainerRef = ref<HTMLElement | null>(null);
const gridColumns = ref(1);
let gridResizeObserver: ResizeObserver | null = null;

function recomputeGridColumns(width: number) {
  const minWidth = isCompactView.value ? compactCardWidth.value : OBJECT_GRID_MIN_CARD_WIDTH;
  const gap = isCompactView.value ? OBJECT_COMPACT_GAP : OBJECT_GRID_GAP;
  gridColumns.value = Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
}

// The grid container lives inside a v-else, so it mounts/unmounts when the user
// toggles list <-> grid. Watch the template ref to (re)attach the observer each
// time the node appears, instead of once in onMounted (which would miss the
// case where the browser starts in list mode).
watch(
  gridContainerRef,
  (el, prevEl) => {
    if (prevEl) {
      gridResizeObserver?.disconnect();
      gridResizeObserver = null;
    }
    if (!el) return;
    // Use the content-box width (excluding padding) to match what ResizeObserver
    // delivers via entry.contentRect.width, avoiding a 1-frame column jump on mount.
    const style = getComputedStyle(el);
    recomputeGridColumns(el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    gridResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) recomputeGridColumns(entry.contentRect.width);
    });
    gridResizeObserver.observe(el);
  },
  { flush: "post" },
);
watch([viewMode, compactCardWidth], () =>
  nextTick(() => {
    const el = gridContainerRef.value;
    if (el) recomputeGridColumns(el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight));
  }),
);

onBeforeUnmount(() => {
  browserTriggerActive.value = false;
  gridResizeObserver?.disconnect();
  gridResizeObserver = null;
  if (viewportFrame) window.cancelAnimationFrame(viewportFrame);
  if (restoreViewportFrame) window.cancelAnimationFrame(restoreViewportFrame);
  window.removeEventListener("mousemove", onSidePanelResizeMove);
  window.removeEventListener("mouseup", onSidePanelResizeEnd);
  if (singleClickTimer) {
    clearTimeout(singleClickTimer);
    singleClickTimer = null;
  }
});

const gridRows = computed(() => {
  const cols = gridColumns.value;
  const cards = filteredRows.value;
  const rows: Array<{ key: string; cards: ObjectBrowserRow[] }> = [];
  for (let i = 0; i < cards.length; i += cols) {
    rows.push({ key: `row-${i}`, cards: cards.slice(i, i + cols) });
  }
  return rows;
});
const visibleSelectableRows = computed(() => filteredRows.value);
const selectedTableRows = computed(() => {
  const ids = selectedTableIds.value;
  return selectableRows.value.filter((row) => ids.has(row.id));
});
const selectedTableCount = computed(() => selectedTableRows.value.length);
const hasSelectedSchemaIndexes = computed(() => selectedTableRows.value.some((row) => row.type === "INDEX"));
const hasSelectedTablesOnly = computed(() => selectedTableRows.value.length > 0 && selectedTableRows.value.every((row) => row.type === "TABLE"));
const batchDropConfirmTitle = computed(() => (hasSelectedTablesOnly.value ? t("objects.confirmBatchDropTitle") : t("contextMenu.confirmBatchDropTitle")));
const batchDropConfirmMessage = computed(() => (hasSelectedTablesOnly.value ? t("objects.confirmBatchDropMessage", { count: selectedTableCount.value }) : t("contextMenu.confirmBatchDropMessage", { count: selectedTableCount.value })));
const canBatchDropCascade = computed(() => selectedTableCount.value > 0 && supportsDropTableCascade(effectiveDatabaseType.value));
const canBatchTruncateCascade = computed(() => selectedTableCount.value > 0 && supportsTruncateTableCascade(effectiveDatabaseType.value));

// Column resizes change the scrollable content width, so the header's clamped
// scrollLeft has to be re-aligned right after the DOM updates. Registered here
// (after every computed it transitively reads) because watch sources are
// evaluated eagerly at registration time.
watch([objectGridMinWidth, objectColumnWidths], () => {
  nextTick(() => syncObjectListHeaderScroll());
});
const allVisibleTablesSelected = computed(() => visibleSelectableRows.value.length > 0 && visibleSelectableRows.value.every((row) => selectedTableIds.value.has(row.id)));
const batchDropProgressPercent = computed(() => (batchDropProgress.value.total > 0 ? Math.round((batchDropProgress.value.completed / batchDropProgress.value.total) * 100) : 0));

function iconFor(row: ObjectBrowserRow) {
  if (row.type === "INDEX") return KeyRound;
  if (row.type === "VIEW" || row.type === "MATERIALIZED_VIEW") return Eye;
  if (row.type === "PROCEDURE") return ScrollText;
  if (row.type === "FUNCTION") return Braces;
  if (row.type === "TRIGGER") return RotateCcw;
  if (row.type === "EVENT") return Clock;
  if (row.type === "SEQUENCE") return ListTree;
  if (row.type === "PACKAGE" || row.type === "PACKAGE_BODY") return Package;
  if (row.type === "TYPE" || row.type === "TYPE_BODY") return Braces;
  return Table;
}

function typeLabel(row: ObjectBrowserRow) {
  if (row.type === "INDEX") return t("grid.tableInfoIndexes");
  if (isMongodb.value) {
    if (row.collectionKind === "view" || row.type === "VIEW") return t("objects.view");
    if (row.collectionKind === "timeseries") return t("objects.timeseries");
    return t("objects.collection");
  }
  if (row.type === "MATERIALIZED_VIEW") return t("common.materializedView");
  if (row.type === "VIEW") return t("objects.view");
  if (row.type === "PROCEDURE") return t("objects.procedure");
  if (row.type === "FUNCTION") return t("objects.function");
  if (row.type === "TRIGGER") return t("objects.trigger");
  if (row.type === "EVENT") return t("tree.events");
  if (row.type === "SEQUENCE") return t("objects.sequence");
  if (row.type === "PACKAGE") return t("objects.package");
  if (row.type === "PACKAGE_BODY") return t("objects.packageBody");
  if (row.type === "TYPE") return t("objects.typeDefinition");
  if (row.type === "TYPE_BODY") return t("objects.typeBody");
  return t("objects.table");
}

function sortIconFor(key: ObjectBrowserSortKey) {
  if (usesServerObjectPaging.value) return null;
  if (sortKey.value !== key) return null;
  return sortDirection.value === "asc" ? ArrowUp : ArrowDown;
}

function toggleSort(key: ObjectBrowserSortKey) {
  if (usesServerObjectPaging.value) return;
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
    return;
  }
  sortKey.value = key;
  sortDirection.value = initialObjectBrowserSortDirection(key);
}

const sortKeyOptions = computed<ObjectBrowserSortKey[]>(() => {
  const options: ObjectBrowserSortKey[] = ["name", "type"];
  if (showObjectRowStats.value) options.push("estimatedRows");
  if (showObjectSizeStats.value) options.push("totalBytes");
  if (hasCreatedAt.value) options.push("created_at");
  if (hasUpdatedAt.value) options.push("updated_at");
  options.push("comment");
  return options;
});

watch(sortKeyOptions, (options) => {
  if (!options.includes(sortKey.value)) {
    sortKey.value = "name";
    sortDirection.value = "asc";
  }
});

function sortKeyLabel(key: ObjectBrowserSortKey): string {
  if (key === "name") return t("objects.name");
  if (key === "type") return t("objects.type");
  if (key === "estimatedRows") return objectRowsLabel.value;
  if (key === "totalBytes") return t("objects.size");
  if (key === "created_at") return t("objects.createdAt");
  if (key === "updated_at") return t("objects.updatedAt");
  if (key === "comment") return t("objects.comment");
  return key;
}

function onSortKeyChange(key: ObjectBrowserSortKey) {
  toggleSort(key);
}

function minimumColumnWidth(key: ObjectBrowserColumnKey) {
  if (key === "select") return 34;
  if (key === "name" || key === "comment") return 120;
  return 72;
}

function onObjectColumnResizeStart(key: ObjectBrowserColumnKey, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  stopColumnResize?.();

  const startX = event.clientX;
  const startWidth = objectColumnWidths.value[key];
  const minWidth = minimumColumnWidth(key);
  document.body.classList.add("select-none", "cursor-col-resize");

  const onMove = (moveEvent: MouseEvent) => {
    objectColumnWidths.value = {
      ...objectColumnWidths.value,
      [key]: Math.max(minWidth, startWidth + moveEvent.clientX - startX),
    };
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("select-none", "cursor-col-resize");
    stopColumnResize = null;
  };

  stopColumnResize = onUp;
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function resetObjectColumnWidth(key: ObjectBrowserColumnKey, width: number, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  objectColumnWidths.value = {
    ...objectColumnWidths.value,
    [key]: width,
  };
}

function rowMatchesFilter(row: ObjectBrowserRow, filter: ObjectFilter) {
  if (filter === "tables") return row.type === "TABLE";
  if (filter === "views") return row.type === "VIEW";
  if (filter === "materializedViews") return row.type === "MATERIALIZED_VIEW";
  if (filter === "procedures") return row.type === "PROCEDURE";
  if (filter === "functions") return row.type === "FUNCTION";
  if (filter === "triggers") return row.type === "TRIGGER";
  if (filter === "events") return row.type === "EVENT";
  if (filter === "sequences") return row.type === "SEQUENCE";
  if (filter === "indexes") return row.type === "INDEX";
  if (filter === "packages") return row.type === "PACKAGE" || row.type === "PACKAGE_BODY";
  if (filter === "types") return row.type === "TYPE" || row.type === "TYPE_BODY";
  return true;
}

function rowMatchesObjectFilter(row: ObjectBrowserRow) {
  return rowMatchesFilter(row, objectFilter.value);
}

function objectBrowserPinnedTreeNodeContext() {
  return {
    connectionId: props.connection.id,
    database: props.database,
    schema: connectionObjectTreeNodeSchema(props.connection, props.database, selectedSchema.value),
    catalog: props.catalog,
    sidebarParentId: props.catalog
      ? `${props.connection.id}:doris-catalog:${encodeURIComponent(props.catalog)}:${encodeURIComponent(props.database)}`
      : needsSchema.value && selectedSchema.value
        ? `${props.connection.id}:${props.database}:${selectedSchema.value}`
        : `${props.connection.id}:${props.database}`,
  };
}

function canonicalizeObjectBrowserPinnedIdentity(identity: PinnedTreeNodeIdentity): PinnedTreeNodeIdentity {
  return canonicalizeObjectBrowserPinnedTreeNodeIdentity(objectBrowserPinnedTreeNodeContext())(identity);
}

function sortObjectBrowserRowsWithPins(items: ObjectBrowserRow[]): ObjectBrowserRow[] {
  const sorted = sortObjectBrowserRows(items, sortKey.value, sortDirection.value);
  const context = objectBrowserPinnedTreeNodeContext();
  return connectionStore.orderByPinnedTreeNodes(sorted, (row, identity) => objectBrowserRowMatchesPinnedTreeNode(row, identity, context));
}

function pinnedTreeNodeForObjectBrowserRow(row: ObjectBrowserRow): TreeNode {
  const identity = objectBrowserRowPinnedTreeNodeIdentity(row, objectBrowserPinnedTreeNodeContext());
  return {
    id: identity.id,
    label: identity.name,
    type: identity.type,
    objectName: identity.name,
    signature: identity.signature || undefined,
    connectionId: identity.connectionId,
    database: identity.database,
    schema: identity.schema || undefined,
    catalog: identity.catalog || undefined,
  };
}

function legacyPinnedTreeNodesForObjectBrowserRow(row: ObjectBrowserRow): TreeNode[] {
  const baseNode = pinnedTreeNodeForObjectBrowserRow(row);
  return objectBrowserRowLegacyPinnedTreeNodeIds(row, objectBrowserPinnedTreeNodeContext()).map((id) => ({ ...baseNode, id }));
}

function removePinnedObjectBrowserRows(rows: readonly ObjectBrowserRow[]) {
  const nodes = rows.flatMap((row) => [pinnedTreeNodeForObjectBrowserRow(row), ...legacyPinnedTreeNodesForObjectBrowserRow(row)]);
  connectionStore.removePinnedTreeNodes(nodes, canonicalizeObjectBrowserPinnedIdentity);
}

function groupedFilteredRows() {
  if (usesServerObjectPaging.value) return { rows: nameFilteredRows.value, depths: new Map<string, number>() };
  return groupObjectBrowserRows({
    rows: nameFilteredRows.value.filter(rowMatchesObjectFilter),
    matchingRows: objectSearchSummary.value.matchingRows.filter(rowMatchesObjectFilter),
    query: search.value.trim(),
    expandedPartitionParentIds: expandedPartitionParentIds.value,
    sortRows: sortObjectBrowserRowsWithPins,
  });
}

function iconClass(type: ObjectBrowserRow["type"]) {
  if (type === "VIEW") return "text-purple-500";
  if (type === "MATERIALIZED_VIEW") return "text-indigo-500";
  if (type === "PROCEDURE") return "text-blue-500";
  if (type === "FUNCTION") return "text-amber-500";
  if (type === "TRIGGER") return "text-rose-500";
  if (type === "EVENT") return "text-orange-500";
  if (type === "SEQUENCE") return "text-emerald-500";
  if (type === "PACKAGE" || type === "PACKAGE_BODY") return "text-cyan-500";
  if (type === "TYPE" || type === "TYPE_BODY") return "text-violet-500";
  return "text-green-500";
}

function iconBgClass(type: ObjectBrowserRow["type"]) {
  if (type === "VIEW" || type === "MATERIALIZED_VIEW") return "object-browser-icon-bg object-browser-icon-bg-view";
  if (type === "PROCEDURE") return "object-browser-icon-bg object-browser-icon-bg-procedure";
  if (type === "FUNCTION") return "object-browser-icon-bg object-browser-icon-bg-function";
  if (type === "TRIGGER") return "object-browser-icon-bg object-browser-icon-bg-procedure";
  if (type === "EVENT") return "object-browser-icon-bg object-browser-icon-bg-procedure";
  if (type === "SEQUENCE") return "object-browser-icon-bg object-browser-icon-bg-sequence";
  if (type === "PACKAGE" || type === "PACKAGE_BODY") return "object-browser-icon-bg object-browser-icon-bg-package";
  if (type === "TYPE" || type === "TYPE_BODY") return "object-browser-icon-bg object-browser-icon-bg-function";
  return "object-browser-icon-bg object-browser-icon-bg-table";
}

function isPartitionParentExpanded(row: ObjectBrowserRow) {
  return expandedPartitionParentIds.value.has(row.id);
}

function togglePartitionParent(row: ObjectBrowserRow) {
  if (!row.partitionCount) return;
  const next = new Set(expandedPartitionParentIds.value);
  if (next.has(row.id)) next.delete(row.id);
  else next.add(row.id);
  expandedPartitionParentIds.value = next;
}

function canRename(row: ObjectBrowserRow) {
  if (row.type === "INDEX") return false;
  return (
    supportsObjectRename(effectiveDatabaseType.value, row.type) ||
    ((effectiveDatabaseType.value === "oracle" || effectiveDatabaseType.value === "oceanbase-oracle") && (row.type === "PROCEDURE" || row.type === "FUNCTION")) ||
    supportsSourceBackedRoutineRename(effectiveDatabaseType.value, row.type as ObjectSourceKind)
  );
}

function sourceTitle(row: ObjectBrowserRow | null) {
  if (!row) return t("objects.source");
  return `${row.name} ${t("objects.source")}`;
}

const SINGLE_CLICK_DELAY = 250;
let singleClickTimer: ReturnType<typeof setTimeout> | null = null;

function executeRowAction(row: ObjectBrowserRow, action: ObjectBrowserRowAction) {
  switch (action) {
    case "index-info":
      void openTableInfo(row, "indexes");
      break;
    case "index-editor":
      openSchemaIndexEditor(row);
      break;
    case "table-info":
      void openTableInfo(row);
      break;
    case "type-info":
      void openTypeInfo(row);
      break;
    case "open-table":
      emit("openTable", { tableName: row.name, schema: row.schema, tableType: objectBrowserOpenTableType(row), catalog: props.catalog, comment: row.comment });
      break;
    case "open-source":
      void (row.type === "EVENT" ? openEventEditor(row) : openSource(row));
      break;
    case "open-source-tab":
      openSourceTab(row);
      break;
  }
}

function toggleTableSelectionWithAnchor(row: ObjectBrowserRow) {
  toggleTableSelection(row);
  tableSelectionAnchorId.value = row.id;
}

function selectTableRangeFromAnchor(row: ObjectBrowserRow) {
  const anchorId = objectBrowserTableSelectionAnchor(filteredRows.value, tableSelectionAnchorId.value, row.id);
  tableSelectionAnchorId.value = anchorId;
  setSelectedTableIds(new Set(objectBrowserTableSelectionRange(filteredRows.value, anchorId, row.id)));
}

function onRowClick(row: ObjectBrowserRow, event: MouseEvent) {
  selectedRowId.value = row.id;
  if (event.shiftKey) {
    selectTableRangeFromAnchor(row);
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    toggleTableSelectionWithAnchor(row);
    return;
  }
  tableSelectionAnchorId.value = row.id;
  const activation = settingsStore.editorSettings.sidebarActivation;
  const { action, isDouble } = resolveRowClickAction(row, event.detail, activation, effectiveDatabaseType.value);
  // Double click: cancel any pending single-click and fire immediately. When
  // the row's single/double actions are identical (e.g. SEQUENCE → open-source),
  // this gesture's first click already ran it — re-executing would toggle the
  // just-opened side panel back off (or emit open-table twice for MongoDB).
  if (isDouble) {
    if (singleClickTimer) {
      clearTimeout(singleClickTimer);
      singleClickTimer = null;
    }
    const firstClickRan = settingsStore.editorSettings.objectBrowserAutoOpenDetailPanel !== false || isSidePanelOpen.value;
    if (!firstClickRan || action !== singleClickRowAction(row, effectiveDatabaseType.value)) {
      executeRowAction(row, action);
    }
    return;
  }
  if (settingsStore.editorSettings.objectBrowserAutoOpenDetailPanel === false && !isSidePanelOpen.value) {
    return;
  }
  // Single click: defer when the row has a distinct double-click action so a
  // following second click can cancel it (e.g. TABLE single→table-info, double→open-table).
  if (shouldDeferSingleClick(row, action, effectiveDatabaseType.value)) {
    if (singleClickTimer) clearTimeout(singleClickTimer);
    singleClickTimer = setTimeout(() => {
      singleClickTimer = null;
      executeRowAction(row, action);
    }, SINGLE_CLICK_DELAY);
    return;
  }
  executeRowAction(row, action);
}

// --- Table info panel (replicates DataGrid table-info-drawer) ---

type TableInfoTabItem = { id: TableInfoTab; label: string; icon: Component; count?: number };

const tableInfoTabs = computed<TableInfoTabItem[]>(() => {
  const tabs: TableInfoTabItem[] = [];
  tabs.push({ id: "info", label: t("grid.tableInfoOverview"), icon: Info });
  if (tableMetadataCapabilities.value.ddl) {
    tabs.push({ id: "ddl", label: "DDL", icon: Code2 });
  }
  if (tableMetadataCapabilities.value.columns) {
    tabs.push({ id: "columns", label: t("grid.tableInfoColumns"), icon: ListTree, count: tableColumns.value.length });
  }
  if (tableMetadataCapabilities.value.indexes) {
    tabs.push({ id: "indexes", label: t("grid.tableInfoIndexes"), icon: KeyRound, count: tableIndexes.value.length });
  }
  if (tableMetadataCapabilities.value.foreignKeys) {
    tabs.push({ id: "foreignKeys", label: t("grid.tableInfoForeignKeys"), icon: Link2, count: tableForeignKeys.value.length });
  }
  if (tableMetadataCapabilities.value.constraints) {
    tabs.push({ id: "constraints", label: t("grid.tableInfoConstraints"), icon: ShieldCheck, count: tableConstraintsForTab.value.length });
  }
  if (tableMetadataCapabilities.value.triggers) {
    tabs.push({ id: "triggers", label: t("grid.tableInfoTriggers"), icon: RotateCcw, count: tableTriggers.value.length });
  }
  if (tableMetadataCapabilities.value.partitions && tableIsPartitioned.value) {
    tabs.push({ id: "partitions", label: t("structureEditor.partitions"), icon: Network, count: tablePartitions.value?.partitions.length });
  }
  if (dependencyTarget.value) tabs.push({ id: "relations", label: t("objectRelations.title"), icon: Network });
  return sidePanelRow.value?.type === "INDEX" ? tabs.filter((tab) => ["info", "ddl", "columns", "indexes", "relations"].includes(tab.id)) : tabs;
});

const tableInfoTabListStyle = computed(() => ({
  gridTemplateColumns: `repeat(${tableInfoTabs.value.length}, minmax(0, 1fr))`,
}));

const filteredTableColumns = computed(() => filterObjectBrowserTableColumns(tableColumns.value, tableInfoSearchQuery.value));

function toggleTableInfoColumnSelection(name: string, event: MouseEvent) {
  const current = selectedTableInfoColumns.value;
  const index = current.indexOf(name);
  if (event.ctrlKey || event.metaKey) {
    selectedTableInfoColumns.value = index < 0 ? [...current, name] : current.filter((column) => column !== name);
  } else if (event.shiftKey && current.length > 0) {
    const visibleNames = filteredTableColumns.value.map((column) => column.name);
    const anchor = visibleNames.indexOf(current[current.length - 1]!);
    const target = visibleNames.indexOf(name);
    selectedTableInfoColumns.value = anchor < 0 || target < 0 ? [name] : visibleNames.slice(Math.min(anchor, target), Math.max(anchor, target) + 1);
  } else {
    selectedTableInfoColumns.value = [name];
  }
}

function onTableInfoColumnContextMenu(name: string, event: MouseEvent, openMenu: (event: MouseEvent) => void) {
  if (!selectedTableInfoColumns.value.includes(name)) selectedTableInfoColumns.value = [name];
  openMenu(event);
}

function copyTableInfoColumnDetails() {
  const ordered = filteredTableColumns.value.filter((column) => selectedTableInfoColumns.value.includes(column.name));
  if (ordered.length === 0) return;
  const headers = ["#", t("grid.columnName"), t("grid.columnType"), t("grid.tableInfoNullable"), t("structureEditor.defaultValue"), t("grid.columnComment")];
  const rows = ordered.map((column) => [String(filteredTableColumns.value.findIndex((item) => item.name === column.name) + 1), column.name, gaussdbMColumnType(column.data_type), column.is_nullable ? "YES" : "NO", tableColumnDefaultDisplayValue(column.column_default), column.comment ?? ""]);
  const text = [headers, ...rows].map((row) => row.map(encodeSpreadsheetTsvCell).join("\t")).join("\n");
  void copyToClipboard(text)
    .then(() => toast(t("contextMenu.copyAdvancedInfo"), 2000))
    .catch((error) => toast(t("grid.copyFailed", { message: error?.message || String(error) }), 5000));
}

function tableInfoColumnContextMenuItems(): ContextMenuItem[] {
  return [{ label: t("contextMenu.copyAdvancedInfo"), icon: Copy, shortcut: "Ctrl+Shift+C", action: copyTableInfoColumnDetails }];
}

function onTableInfoColumnsCopy(event: ClipboardEvent) {
  if (selectedTableInfoColumns.value.length === 0 || !event.clipboardData) return;
  const names = filteredTableColumns.value.filter((column) => selectedTableInfoColumns.value.includes(column.name)).map((column) => column.name);
  if (names.length === 0) return;
  event.clipboardData.setData("text/plain", names.join("\n"));
  event.preventDefault();
}

function onTableInfoColumnsKeydown(event: KeyboardEvent) {
  const target = event.target;
  if (event.defaultPrevented || selectedTableInfoColumns.value.length === 0 || !(target instanceof Element) || (!target.closest("[data-table-info-column]") && target !== event.currentTarget) || !(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key !== "c") return;
  event.preventDefault();
  event.stopPropagation();
  if (key === "c" && !event.shiftKey) {
    const names = filteredTableColumns.value.filter((column) => selectedTableInfoColumns.value.includes(column.name)).map((column) => column.name);
    if (names.length) void copyToClipboard(names.join("\n")).catch((error) => toast(t("grid.copyFailed", { message: error?.message || String(error) }), 5000));
    return;
  }
  copyTableInfoColumnDetails();
}
const tableOverviewRows = computed(() => {
  const stats = tableOverviewStats.value;
  const source = sidePanelRow.value;
  const index = source?.type === "INDEX" ? schemaIndexIdentity(source) : null;
  const rows = [
    ...(index ? [{ label: t("grid.tableInfoIndexes"), value: `${index.schema}.${index.name}` }] : []),
    { label: t("common.table"), value: index ? `${index.parentSchema}.${index.parentName}` : (source?.name ?? "") },
    { label: t("common.schema"), value: index?.parentSchema ?? (source?.schema || selectedSchema.value || props.database) },
    { label: t("common.database"), value: props.database },
    ...(sidePanelRow.value?.valid != null ? [{ label: t("objects.validity"), value: t(sidePanelRow.value.valid ? "objects.validStatus" : "objects.invalidStatus") }] : []),
    { label: t("structureEditor.comment"), value: tableOverviewComment.value ?? "" },
    { label: t("grid.tableInfoEstimatedRows"), value: formatObjectBrowserCount(stats?.estimated_rows) },
    { label: t("grid.tableInfoTotalSize"), value: formatObjectBrowserBytes(stats?.total_bytes) },
    { label: t("grid.tableInfoDataLength"), value: formatObjectBrowserBytes(stats?.data_length) },
    { label: t("grid.tableInfoEngine"), value: stats?.engine ?? "" },
    { label: t("grid.tableInfoCreatedAt"), value: stats?.created_at ?? "" },
    { label: t("grid.tableInfoUpdatedAt"), value: stats?.updated_at ?? "" },
    { label: t("grid.tableInfoCollation"), value: stats?.collation ?? "" },
    { label: t("grid.tableInfoRowFormat"), value: stats?.row_format ?? "" },
    { label: t("grid.tableInfoAvgRowLength"), value: formatObjectBrowserBytes(stats?.avg_row_length) },
    { label: t("grid.tableInfoMaxDataLength"), value: formatObjectBrowserBytes(stats?.max_data_length) },
    { label: t("grid.tableInfoCheckTime"), value: stats?.check_time ?? "" },
    { label: t("grid.tableInfoIndexLength"), value: formatObjectBrowserBytes(stats?.index_length) },
    { label: t("grid.tableInfoAutoIncrement"), value: stats?.auto_increment ?? "" },
    { label: t("grid.tableInfoDataFree"), value: formatObjectBrowserBytes(stats?.data_free) },
  ];
  const query = tableInfoSearchQuery.value.trim().toLowerCase();
  return rows.filter((row) => row.value && (!query || row.label.toLowerCase().includes(query) || row.value.toLowerCase().includes(query)));
});

const filteredTableIndexes = computed(() => {
  if (!tableInfoSearchQuery.value) return tableIndexes.value;
  const q = tableInfoSearchQuery.value.toLowerCase();
  return tableIndexes.value.filter((i) => i.name.toLowerCase().includes(q) || i.columns.some((c) => c.toLowerCase().includes(q)));
});

function schemaIndexOwner(index: IndexInfo): string | undefined {
  return typeof index.owner === "string" ? index.owner : undefined;
}

function isInitialSchemaIndex(index: IndexInfo): boolean {
  const source = sidePanelRow.value;
  if (source?.type !== "INDEX" || !source.schema || schemaIndexOwner(index) !== source.schema || index.name !== source.name) return false;
  return tableIndexes.value.filter((item) => schemaIndexOwner(item) === source.schema && item.name === source.name).length === 1;
}

const filteredTableForeignKeys = computed(() => {
  if (!tableInfoSearchQuery.value) return tableForeignKeys.value;
  const q = tableInfoSearchQuery.value.toLowerCase();
  return tableForeignKeys.value.filter((fk) => fk.name.toLowerCase().includes(q) || fk.column.toLowerCase().includes(q) || fk.ref_table.toLowerCase().includes(q) || fk.ref_column.toLowerCase().includes(q));
});

const filteredTableTriggers = computed(() => {
  if (!tableInfoSearchQuery.value) return tableTriggers.value;
  const q = tableInfoSearchQuery.value.toLowerCase();
  return tableTriggers.value.filter((tr) => tr.name.toLowerCase().includes(q));
});

const filteredTableConstraints = computed(() => {
  const base = tableConstraintsForTab.value;
  if (!tableInfoSearchQuery.value) return base;
  const q = tableInfoSearchQuery.value.toLowerCase();
  return base.filter((c) => c.name.toLowerCase().includes(q) || c.constraint_type.toLowerCase().includes(q) || c.columns.some((col) => col.toLowerCase().includes(q)) || c.definition.toLowerCase().includes(q));
});

const filteredTableDdlContent = computed(() => {
  if (!tableDdlContent.value) return "";
  const html = highlight(tableDdlContent.value);
  if (!tableInfoSearchQuery.value) return html;
  const escaped = tableInfoSearchQuery.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  return html.replace(/>([^<]*)</g, (_, text) => {
    return `>${text.replace(regex, "<mark>$1</mark>")}<`;
  });
});

async function openTableInfo(row: ObjectBrowserRow, initialTab?: TableInfoTab, focusObject?: NonNullable<QueryTab["objectPropertiesRequest"]>["focusObject"]) {
  if (!confirmTriggerDraftDiscard()) return;
  if (row.type === "INDEX" && (!supportsSchemaIndexes.value || !schemaIndexIdentity(row))) {
    toast(t("schemaIndex.parentUnavailable"), 4000);
    return;
  }
  selectedTableInfoColumns.value = [];
  selectedRowId.value = row.id;
  // Toggle off if clicking the same table
  if (sidePanelRow.value?.id === row.id && sidePanelMode.value === "table-info" && !initialTab) {
    if (settingsStore.editorSettings.objectBrowserAutoOpenDetailPanel === false) {
      return;
    }
    closeSidePanel();
    return;
  }
  sidePanelRow.value = row;
  sidePanelMode.value = "table-info";
  propertyFocus.value = focusObject;
  sourceRow.value = null;
  const epoch = sidePanelGuard.start();
  // Reset state
  tableColumns.value = [];
  tableOverviewStats.value = null;
  tableOverviewComment.value = null;
  tableOverviewLoaded.value = false;
  rawTableDdlContent.value = "";
  tableIndexes.value = [];
  tableIndexesError.value = "";
  tableForeignKeys.value = [];
  tableTriggers.value = [];
  tableConstraints.value = [];
  tableConstraintsError.value = "";
  tablePartitions.value = null;
  tablePartitionsLoaded.value = false;
  tablePartitionsLoading.value = false;
  tableIsPartitioned.value = false;
  tablePartitionStatusResolved.value = false;
  tableColumnsLoaded.value = false;
  tableDdlLoaded.value = false;
  tableIndexesLoaded.value = false;
  tableForeignKeysLoaded.value = false;
  tableTriggersLoaded.value = false;
  tableConstraintsLoaded.value = false;
  tableInfoSearchQuery.value = "";
  tableRelationsSection.value = focusObject ? "ownership" : "dependencies";
  // Determine initial tab: explicit request > previously activated. Resolve the
  // partition status first so a persisted `partitions` tab is not rejected (and
  // overwritten) before the probe lands.
  if (initialTab !== "relations") await probeTablePartitionStatus();
  if (sidePanelGuard.isStale(epoch)) return;
  const firstTab = initialTab ?? tableInfoTab.value;
  await selectTableInfoTab(firstTab);
}

async function selectTableInfoTab(tab: TableInfoTab) {
  const epoch = sidePanelGuard.capture();
  // The panel can be re-selected (or restored) without `openTableInfo`, so make
  // sure the partition status has been probed before the tab list is consulted.
  if (tab !== "relations" && !tablePartitionStatusResolved.value) await probeTablePartitionStatus();
  if (sidePanelGuard.isStale(epoch)) return;
  const nextTab = tableInfoTabs.value.some((item) => item.id === tab) ? tab : tableInfoTabs.value[0]?.id;
  if (!nextTab) return;
  tableInfoTab.value = nextTab;
  selectedTableInfoColumns.value = [];
  tableInfoSearchQuery.value = "";
  if (nextTab === "info") await fetchTableOverview();
  else if (nextTab === "ddl") await fetchTableDdl();
  else if (nextTab === "columns") await fetchTableColumns();
  else if (nextTab === "indexes") await fetchTableIndexes();
  else if (nextTab === "foreignKeys") await fetchTableForeignKeys();
  else if (nextTab === "constraints") await fetchTableConstraints();
  else if (nextTab === "triggers") await fetchTableTriggers();
  else if (nextTab === "partitions") await fetchTablePartitions();
}

async function fetchTableOverview(force = false) {
  const row = sidePanelRow.value;
  if (!row || (!force && tableOverviewLoaded.value)) return;
  const epoch = sidePanelGuard.capture();
  const request = tableMetadataRequest(row);
  const schema = request.schema;
  tableOverviewLoading.value = true;
  try {
    const [statistics, comment] = await sidePanelGuard.wait(
      epoch,
      Promise.all([
        request.exactIdentity ? Promise.resolve([] as ObjectStatistics[]) : api.listObjectStatistics(props.connection.id, props.database, schema).catch(() => [] as ObjectStatistics[]),
        api.getTableComment(props.connection.id, props.database, schema, request.tableName, props.catalog, ...(request.exactIdentity ? ([true] as const) : [])).catch(() => null),
      ]),
      metadataLoadBudgetMs(props.connection.query_timeout_secs),
    );
    if (sidePanelGuard.isStale(epoch)) return;
    tableOverviewStats.value = findTableStatistics(statistics, request.tableName, schema) ?? null;
    tableOverviewComment.value = comment;
    tableOverviewLoaded.value = true;
  } catch (error) {
    if (sidePanelGuard.isFresh(epoch)) toast(translateBackendError(t, error), 5000);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) tableOverviewLoading.value = false;
  }
}

function tableMetadataRequest(row: ObjectBrowserRow): ObjectDdlRequest {
  const index = row.type === "INDEX" ? schemaIndexIdentity(row) : null;
  if (row.type === "INDEX" && !index) throw new Error("Index parent identity is unavailable");
  return {
    connectionId: props.connection.id,
    queryTimeoutSecs: props.connection.query_timeout_secs,
    database: props.database || "",
    schema: index ? index.parentSchema : row.schema || selectedSchema.value || props.database,
    explicitOwner: index ? index.parentSchema : row.schema || selectedSchema.value || undefined,
    tableName: index ? index.parentName : row.name,
    objectType: index ? undefined : tableDdlObjectType(row.type),
    catalog: props.catalog,
    ...(index ? { exactIdentity: true } : {}),
  };
}

async function fetchTableDdl(force = settingsStore.editorSettings.refreshDdlOnOpen) {
  const row = sidePanelRow.value;
  if (!row || (tableDdlLoaded.value && !force)) return;
  const epoch = sidePanelGuard.capture();
  const requestId = ++tableDdlRequestId;
  const request = tableMetadataRequest(row);
  if (effectiveDatabaseType.value === "oracle" || effectiveDatabaseType.value === "oceanbase-oracle") request.separateIndexes = settingsStore.editorSettings.separateDdlIndexes;
  tableDdlLoading.value = true;
  let loadedSuccessfully = false;
  try {
    const { ddl } = await sidePanelGuard.wait(epoch, loadObjectDdl(request, { force }), metadataLoadBudgetMs(props.connection.query_timeout_secs));
    if (sidePanelGuard.isStale(epoch) || requestId !== tableDdlRequestId) return;
    const formatDialect = sqlFormatDialectForDbType(effectiveDatabaseType.value);
    const unqualified = applyDdlDatabaseQualifier(ddl, formatDialect, effectiveDatabaseType.value, settingsStore.editorSettings.generateSqlIncludeDatabaseName, props.database, props.catalog);
    rawTableDdlContent.value = settingsStore.editorSettings.generateSqlQuoteIdentifiers ? unqualified : omitDdlIdentifierQuotes(unqualified, formatDialect);
    loadedSuccessfully = true;
  } catch (e: any) {
    if (sidePanelGuard.isStale(epoch) || requestId !== tableDdlRequestId) return;
    rawTableDdlContent.value = `-- Error: ${e?.message || e}`;
  } finally {
    if (sidePanelGuard.isFresh(epoch) && requestId === tableDdlRequestId) {
      tableDdlLoaded.value = loadedSuccessfully;
      tableDdlLoading.value = false;
    }
  }
}

watch(
  () => settingsStore.editorSettings.separateDdlIndexes,
  () => {
    if (effectiveDatabaseType.value !== "oracle" && effectiveDatabaseType.value !== "oceanbase-oracle") return;
    tableDdlRequestId++;
    tableDdlLoaded.value = false;
    tableDdlLoading.value = false;
    rawTableDdlContent.value = "";
    if (sidePanelMode.value === "table-info" && sidePanelRow.value && tableInfoTab.value === "ddl") void fetchTableDdl(false);
  },
);

async function fetchTableColumns(force = false) {
  const row = sidePanelRow.value;
  if (!row || (tableColumnsLoaded.value && !force)) return;
  const epoch = sidePanelGuard.capture();
  tableColumnsLoading.value = true;
  let loadedSuccessfully = false;
  try {
    const request = tableMetadataRequest(row);
    const { value: columns } = await sidePanelGuard.wait(
      epoch,
      loadObjectMetadataFacet(
        request,
        "columns",
        () =>
          request.exactIdentity ? api.getColumns(request.connectionId, request.database, request.schema, request.tableName, request.catalog, undefined, undefined, true) : api.getColumns(request.connectionId, request.database, request.schema || request.database, request.tableName, request.catalog),
        { force },
      ),
      metadataLoadBudgetMs(props.connection.query_timeout_secs),
    );
    if (sidePanelGuard.isStale(epoch)) return;
    tableColumns.value = columns;
    loadedSuccessfully = true;
  } catch (error) {
    if (sidePanelGuard.isStale(epoch)) return;
    tableColumns.value = [];
    toast(translateBackendError(t, error), 5000);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) {
      tableColumnsLoaded.value = loadedSuccessfully;
      tableColumnsLoading.value = false;
    }
  }
}

async function fetchTableIndexes(force = false) {
  const row = sidePanelRow.value;
  if (!row || (tableIndexesLoaded.value && !force)) return;
  const epoch = sidePanelGuard.capture();
  tableIndexesLoading.value = true;
  tableIndexesError.value = "";
  let loadedSuccessfully = false;
  try {
    const request = tableMetadataRequest(row);
    const { value: indexes } = await sidePanelGuard.wait(
      epoch,
      loadObjectMetadataFacet(request, "indexes", () => api.listIndexes(request.connectionId, request.database, request.schema || request.database, request.tableName, request.catalog, ...(request.exactIdentity ? ([true] as const) : [])), { force }),
      metadataLoadBudgetMs(props.connection.query_timeout_secs),
    );
    if (sidePanelGuard.isStale(epoch)) return;
    tableIndexes.value = indexes;
    loadedSuccessfully = true;
  } catch (error) {
    if (sidePanelGuard.isStale(epoch)) return;
    tableIndexes.value = [];
    tableIndexesError.value = translateBackendError(t, error);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) {
      tableIndexesLoaded.value = loadedSuccessfully;
      tableIndexesLoading.value = false;
    }
  }
}

async function fetchTableForeignKeys(force = false) {
  const row = sidePanelRow.value;
  if (!row || (tableForeignKeysLoaded.value && !force)) return;
  const epoch = sidePanelGuard.capture();
  tableForeignKeysLoading.value = true;
  let loadedSuccessfully = false;
  try {
    const request = tableMetadataRequest(row);
    const { value: fks } = await sidePanelGuard.wait(
      epoch,
      loadObjectMetadataFacet(request, "foreign-keys", () => api.listForeignKeys(request.connectionId, request.database, request.schema || request.database, request.tableName, request.catalog, ...(request.exactIdentity ? ([true] as const) : [])), { force }),
      metadataLoadBudgetMs(props.connection.query_timeout_secs),
    );
    if (sidePanelGuard.isStale(epoch)) return;
    tableForeignKeys.value = fks;
    loadedSuccessfully = true;
  } catch (error) {
    if (sidePanelGuard.isStale(epoch)) return;
    tableForeignKeys.value = [];
    toast(translateBackendError(t, error), 5000);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) {
      tableForeignKeysLoaded.value = loadedSuccessfully;
      tableForeignKeysLoading.value = false;
    }
  }
}

async function fetchTableTriggers(force = false) {
  const row = sidePanelRow.value;
  if (!row || (tableTriggersLoaded.value && !force)) return;
  const epoch = sidePanelGuard.capture();
  tableTriggersLoading.value = true;
  let loadedSuccessfully = false;
  try {
    const request = tableMetadataRequest(row);
    const readOptions = oracleTriggerObjectReadOptions(props.connection, undefined, request.catalog);
    const cacheRequest = readOptions ? { ...request, oracleTriggerContract: 1 as const } : request;
    const { value: triggers } = await sidePanelGuard.wait(
      epoch,
      loadObjectMetadataFacet(
        cacheRequest,
        "triggers",
        () =>
          readOptions
            ? api.listTriggers(request.connectionId, request.database, request.schema || request.database, request.tableName, request.catalog, readOptions)
            : api.listTriggers(request.connectionId, request.database, request.schema || request.database, request.tableName, request.catalog, ...(request.exactIdentity ? ([true] as const) : [])),
        { force },
      ),
      metadataLoadBudgetMs(props.connection.query_timeout_secs),
    );
    if (sidePanelGuard.isStale(epoch)) return;
    tableTriggers.value = triggers;
    loadedSuccessfully = true;
  } catch (error) {
    if (sidePanelGuard.isStale(epoch)) return;
    tableTriggers.value = [];
    toast(translateBackendError(t, error), 5000);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) {
      tableTriggersLoaded.value = loadedSuccessfully;
      tableTriggersLoading.value = false;
    }
  }
}

async function probeTablePartitionStatus() {
  const row = sidePanelRow.value;
  if (!row || row.type === "INDEX" || !tableMetadataCapabilities.value.partitions) {
    tableIsPartitioned.value = false;
    tablePartitionStatusResolved.value = true;
    return;
  }
  const epoch = sidePanelGuard.capture();
  try {
    const request = tableMetadataRequest(row);
    const status = await sidePanelGuard.wait(epoch, api.getTablePartitionStatus(request.connectionId, request.database, request.schema || request.database, request.tableName), metadataLoadBudgetMs(props.connection.query_timeout_secs));
    if (sidePanelGuard.isStale(epoch)) return;
    tableIsPartitioned.value = status.isPartitionedParent || status.isPartition;
  } catch {
    // Fail closed: hide the tab rather than offering one that cannot load.
    if (sidePanelGuard.isStale(epoch)) return;
    tableIsPartitioned.value = false;
  } finally {
    if (sidePanelGuard.isFresh(epoch)) tablePartitionStatusResolved.value = true;
  }
}

async function fetchTablePartitions(force = false) {
  const row = sidePanelRow.value;
  if (!row || (tablePartitionsLoaded.value && !force)) return;
  const epoch = sidePanelGuard.capture();
  tablePartitionsLoading.value = true;
  let loadedSuccessfully = false;
  try {
    const request = tableMetadataRequest(row);
    // Live catalog read: partition metadata has no persisted cache facet.
    const value = await sidePanelGuard.wait(epoch, api.getTablePartitioning(request.connectionId, request.database, request.schema || request.database, request.tableName), metadataLoadBudgetMs(props.connection.query_timeout_secs));
    if (sidePanelGuard.isStale(epoch)) return;
    tablePartitions.value = value;
    loadedSuccessfully = true;
  } catch (error) {
    if (sidePanelGuard.isStale(epoch)) return;
    tablePartitions.value = null;
    toast(translateBackendError(t, error), 5000);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) {
      tablePartitionsLoaded.value = loadedSuccessfully;
      tablePartitionsLoading.value = false;
    }
  }
}

async function fetchTableConstraints(force = false) {
  const row = sidePanelRow.value;
  if (!row || (tableConstraintsLoaded.value && !force)) return;
  const epoch = sidePanelGuard.capture();
  tableConstraintsLoading.value = true;
  tableConstraintsError.value = "";
  let loadedSuccessfully = false;
  try {
    const request = tableMetadataRequest(row);
    const { value: constraints } = await sidePanelGuard.wait(
      epoch,
      loadObjectMetadataFacet(request, "constraints", () => api.listConstraints(request.connectionId, request.database, request.schema || request.database, request.tableName, request.catalog, ...(request.exactIdentity ? ([true] as const) : [])), { force }),
      metadataLoadBudgetMs(props.connection.query_timeout_secs),
    );
    if (sidePanelGuard.isStale(epoch)) return;
    tableConstraints.value = constraints;
    loadedSuccessfully = true;
  } catch (error) {
    if (sidePanelGuard.isStale(epoch)) return;
    tableConstraints.value = [];
    tableConstraintsError.value = translateBackendError(t, error);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) {
      tableConstraintsLoaded.value = loadedSuccessfully;
      tableConstraintsLoading.value = false;
    }
  }
}

async function refreshActiveTableInfo() {
  if (sidePanelMode.value === "source") {
    await refreshActiveSource();
    return;
  }
  if (sidePanelMode.value === "type-info") {
    await sidePanelRef.value?.refresh();
    return;
  }
  if (sidePanelMode.value !== "table-info" || !sidePanelRow.value) return;
  sidePanelGuard.bump();

  if (tableInfoTab.value === "info") {
    tableOverviewStats.value = null;
    tableOverviewComment.value = null;
    tableOverviewLoaded.value = false;
    await fetchTableOverview(true);
  } else if (tableInfoTab.value === "ddl") {
    rawTableDdlContent.value = "";
    tableDdlLoaded.value = false;
    await fetchTableDdl(true);
  } else if (tableInfoTab.value === "columns") {
    tableColumns.value = [];
    tableColumnsLoaded.value = false;
    await fetchTableColumns(true);
  } else if (tableInfoTab.value === "indexes") {
    tableIndexes.value = [];
    tableIndexesLoaded.value = false;
    await fetchTableIndexes(true);
  } else if (tableInfoTab.value === "foreignKeys") {
    tableForeignKeys.value = [];
    tableForeignKeysLoaded.value = false;
    await fetchTableForeignKeys(true);
  } else if (tableInfoTab.value === "constraints") {
    tableConstraints.value = [];
    tableConstraintsLoaded.value = false;
    await fetchTableConstraints(true);
  } else if (tableInfoTab.value === "triggers") {
    tableTriggers.value = [];
    tableTriggersLoaded.value = false;
    await fetchTableTriggers(true);
  } else if (tableInfoTab.value === "partitions") {
    tablePartitions.value = null;
    tablePartitionsLoaded.value = false;
    await fetchTablePartitions(true);
  }
}

function copyTableDdl() {
  if (tableDdlLoading.value || !tableDdlLoaded.value) return;
  void copyToClipboard(tableDdlContent.value);
  toast(t("grid.copyDdl"), 2000);
}

function onTableInfoDdlKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "a") {
    e.preventDefault();
    const el = tableInfoDdlPreRef.value;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}

// --- Side panel resize ---
function onSidePanelResizeStart(event: MouseEvent) {
  isResizingSidePanel.value = true;
  sidePanelResizeStartX = event.clientX;
  sidePanelResizeStartWidth = sidePanelWidth.value;
  window.addEventListener("mousemove", onSidePanelResizeMove);
  window.addEventListener("mouseup", onSidePanelResizeEnd);
}

function onSidePanelResizeMove(event: MouseEvent) {
  if (!isResizingSidePanel.value) return;
  const delta = sidePanelResizeStartX - event.clientX;
  const next = Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, sidePanelResizeStartWidth + delta));
  sidePanelWidth.value = next;
}

function onSidePanelResizeEnd() {
  isResizingSidePanel.value = false;
  window.removeEventListener("mousemove", onSidePanelResizeMove);
  window.removeEventListener("mouseup", onSidePanelResizeEnd);
  settingsStore.updateEditorSettings({ tableInfoDrawerWidth: sidePanelWidth.value });
}

function confirmTriggerDraftDiscard() {
  return !sourceRow.value || !sourceTriggerRequested.value || !sourceEditing.value || sourceDraft.value === sourceEditableText.value || window.confirm(t("oracleTrigger.discardSourceConfirm"));
}

function closeSidePanel() {
  selectedTableInfoColumns.value = [];
  sidePanelRow.value = null;
  sourceRow.value = null;
  sidePanelMode.value = "source";
  sidePanelGuard.bump();
}

function toggleSidePanel() {
  if (isSidePanelOpen.value) {
    if (selectedRowId.value && sidePanelRow.value && sidePanelRow.value.id !== selectedRowId.value) {
      const targetRow = filteredRows.value.find((r) => r.id === selectedRowId.value);
      if (targetRow) {
        executeRowAction(targetRow, singleClickRowAction(targetRow, effectiveDatabaseType.value));
        return;
      }
    }
    if (confirmTriggerDraftDiscard()) closeSidePanel();
  } else {
    const targetRow = (selectedRowId.value ? filteredRows.value.find((r) => r.id === selectedRowId.value) : null) ?? filteredRows.value[0];
    if (targetRow) {
      selectedRowId.value = targetRow.id;
      executeRowAction(targetRow, singleClickRowAction(targetRow, effectiveDatabaseType.value));
    }
  }
}

function toggleAutoOpenDetailPanel() {
  settingsStore.updateEditorSettings({
    objectBrowserAutoOpenDetailPanel: settingsStore.editorSettings.objectBrowserAutoOpenDetailPanel === false,
  });
}

async function openTypeInfo(row: ObjectBrowserRow) {
  if (!confirmTriggerDraftDiscard()) return;
  selectedRowId.value = row.id;
  if (sidePanelRow.value?.id === row.id && sidePanelMode.value === "type-info") {
    if (settingsStore.editorSettings.objectBrowserAutoOpenDetailPanel === false) {
      return;
    }
    closeSidePanel();
    return;
  }
  sidePanelRow.value = row;
  sidePanelMode.value = "type-info";
  sourceRow.value = null;
  sidePanelGuard.bump();
}

function openTypeDdl(row: ObjectBrowserRow) {
  if (!confirmTriggerDraftDiscard()) return;
  selectedRowId.value = row.id;
  sidePanelRow.value = row;
  sidePanelMode.value = "type-info";
  sourceRow.value = null;
  sidePanelGuard.bump();
  // DDL tab is selected by the panel once details load; switching the tab is
  // deferred via a dedicated request so the panel can focus it.
  nextTick(() => {
    const panel = sidePanelRef.value;
    panel?.selectTab("ddl");
  });
}

const canOpenTableStructureEditor = computed(() => sidePanelRow.value?.type === "TABLE" && canOpenStructureEditor.value);

function openTableStructureEditor() {
  const row = sidePanelRow.value;
  if (!row || row.type !== "TABLE" || !canOpenTableStructureEditor.value) return;
  queryStore.openTableStructure(props.connection.id, props.database, row.schema || selectedSchema.value, row.name, tableInfoTab.value === "relations" ? "columns" : tableInfoTab.value, undefined, props.catalog);
}

/**
 * Double-clicking a routine opens its source as an editable query tab
 * (issue #10202), the same container the sidebar and editor navigation use.
 * The store owns connection setup, source loading and tab de-duplication, so
 * this path deliberately does not fall back to the side panel.
 */
function openSourceTab(row: ObjectBrowserRow) {
  queryStore.openObjectSourceTabPending({
    connectionId: props.connection.id,
    database: props.database,
    title: `Source - ${row.displayName || row.name}`,
    schema: row.schema || selectedSchema.value || props.database,
    catalog: props.catalog,
    initialEditing: true,
    request: { name: row.name, objectType: row.type as ObjectSourceKind, signature: row.signature ?? undefined },
  });
}

async function openSource(row: ObjectBrowserRow) {
  // Toggle off if clicking the same source row
  if (sidePanelRow.value?.id === row.id && sidePanelMode.value === "source") {
    if (settingsStore.editorSettings.objectBrowserAutoOpenDetailPanel === false) {
      return;
    }
    if (!confirmTriggerDraftDiscard()) return;
    closeSidePanel();
    return;
  }
  if (!confirmTriggerDraftDiscard()) return;
  await loadSourcePanel(row);
}

async function openInvalidObjectSource(object: { owner: string; name: string; type: string; objectId?: string }, location?: { line: number; position: number }) {
  const objectType = oracleInvalidObjectSourceKind(object.type);
  if (!objectType) return;
  const dialogGeneration = invalidObjectsDialogGeneration;
  const requestGeneration = ++invalidObjectSourceRequestGeneration;
  const connection = { ...props.connection };
  const connectionKey = JSON.stringify(connection);
  const database = props.database;
  const catalog = props.catalog;
  const schema = selectedSchema.value || database;
  const isCurrentRequest = () =>
    !objectBrowserUnmounted &&
    requestGeneration === invalidObjectSourceRequestGeneration &&
    dialogGeneration === invalidObjectsDialogGeneration &&
    oracleInvalidObjectsOpen.value &&
    props.connection.id === connection.id &&
    JSON.stringify(props.connection) === connectionKey &&
    props.database === database &&
    props.catalog === catalog &&
    (selectedSchema.value || props.database) === schema;
  if (objectType === "TRIGGER" && !invalidTriggerContext.value) {
    try {
      const source = await api.getObjectSource(connection.id, database, object.owner, object.name, objectType);
      if (!isCurrentRequest()) return;
      if (!source.source?.trim()) throw new Error(t("processList.oracleInvalidObjects.sourceUnavailable"));
      const tabId = queryStore.createTab(connection.id, database, `Repair - ${object.name}`, "query", object.owner, undefined, catalog);
      queryStore.updateSql(tabId, source.source);
      setOracleInvalidObjectsOpen(false);
    } catch (error) {
      if (isCurrentRequest()) toast(t("processList.oracleInvalidObjects.sourceLoadFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
    }
    return;
  }
  const connectionId = connection.id;
  const tabId = queryStore.openObjectSourceTabPending({
    connectionId,
    database,
    title: `Source - ${object.name}`,
    schema: object.owner,
    catalog,
    initialEditing: true,
    request: { name: object.name, objectType },
  });
  const sourceLoadResult = await new Promise<{ error?: string }>((resolve) => {
    const getResult = () => {
      const tab = queryStore.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return { error: t("processList.oracleInvalidObjects.sourceUnavailable") };
      if (tab.sourceLoad?.error) return { error: tab.sourceLoad.error };
      if (!tab.sourceLoad && tab.objectSource) return {};
      return null;
    };
    const stop = watch(
      getResult,
      (result) => {
        if (!result) return;
        stop();
        resolve(result);
      },
      { flush: "sync" },
    );
    const initial = getResult();
    if (initial) {
      stop();
      resolve(initial);
    }
  });
  if (!isCurrentRequest()) return;
  const tab = queryStore.tabs.find((candidate) => candidate.id === tabId);
  if (sourceLoadResult.error || !tab?.objectSource) {
    toast(t("processList.oracleInvalidObjects.sourceLoadFailed", { message: sourceLoadResult.error || tab?.sourceLoad?.error || t("processList.oracleInvalidObjects.sourceUnavailable") }), 5000);
    return;
  }
  if (location && objectType === "TRIGGER" && !queryStore.revealOracleTriggerSourceError(tabId, location, object.objectId)) toast(t("oracleTrigger.errorPositionUnavailable"), 3000);
  setOracleInvalidObjectsOpen(false);
}

let sourceIdentity: SourceIdentitySnapshot | undefined;

async function loadSourcePanel(row: ObjectBrowserRow, options?: { preserveEditing?: boolean }) {
  sourceSection.value = "source";
  selectedRowId.value = row.id;
  // Starting a different object must invalidate slower source requests before
  // any state is reset, otherwise an old response can populate the new row.
  const epoch = sidePanelGuard.start();
  const preserveEditing = options?.preserveEditing === true && sourceEditing.value;
  const keptDraft = preserveEditing && sourceRow.value?.id === row.id && sourceTriggerRequested.value ? sourceDraft.value : undefined;
  sidePanelRow.value = row;
  sidePanelMode.value = "source";
  sourceRow.value = row;
  sourceContent.value = "";
  sourceError.value = "";
  if (keptDraft === undefined) sourceEditing.value = false;
  sourceCanEdit.value = true;
  if (keptDraft === undefined) {
    sourceEditableText.value = "";
    sourceDraft.value = "";
  }
  sourceSaveError.value = "";
  // A new source context owns the save spinner: the previous save's finally()
  // can no longer run once this load starts (the guard epoch moved on) — the
  // success path itself closes the panel, which bumps the epoch — so without
  // this reset the Save button would spin and stay disabled for good.
  sourceSaving.value = false;
  sourceLoading.value = true;
  const connectionId = props.connection.id;
  const database = props.database;
  const schema = row.schema || selectedSchema.value || database;
  const identity = captureSourceIdentity({ connectionId, database, schema, objectType: row.type, name: row.name });
  sourceIdentity = undefined;
  sourceTriggerSnapshot.value = undefined;
  sourceTriggerIssue.value = "";
  sourceTriggerRequested.value = row.type === "TRIGGER" && (!!exactOracleTriggerMetadata(row.trigger) || !!oracleTriggerObjectReadOptions(props.connection, undefined, props.catalog));
  if (keptDraft === undefined) sourceTriggerResult.value = undefined;
  try {
    const readOptions = row.type === "TRIGGER" ? (exactOracleTriggerMetadata(row.trigger) ? { identityMode: "exact" as const, catalog: props.catalog } : oracleTriggerObjectReadOptions(props.connection, undefined, props.catalog)) : undefined;
    if (readOptions) {
      const loaded = await sidePanelGuard.wait(epoch, readOracleTriggerSource({ connectionId, database, catalog: props.catalog, owner: schema, name: row.name, executionSchema: selectedSchema.value || props.schema || schema }), metadataLoadBudgetMs(props.connection.query_timeout_secs));
      if (sidePanelGuard.isStale(epoch)) return;
      const inspected = await inspectExactOracleTriggerSource(loaded.raw, schema, row.name);
      if (sidePanelGuard.isStale(epoch)) return;
      sourceTriggerSnapshot.value = loaded.snapshot;
      sourceTriggerIssue.value = loaded.identityError || inspected.triggerSource.error || "";
      sourceIdentity = loaded.snapshot?.identity;
      sourceCanEdit.value = loaded.snapshot?.exists === true;
      if (keptDraft === undefined || loaded.snapshot) sourceEditableText.value = inspected.editableSource;
      sourceContent.value = loaded.raw.source;
      if (keptDraft === undefined) sourceDraft.value = inspected.editableSource;
      sourceEditing.value = keptDraft !== undefined || (sourceCanEdit.value && (options?.preserveEditing ? preserveEditing : true));
      return;
    }
    const sourceRequest = readOptions
      ? api.getObjectSource(connectionId, database, schema, row.name, row.type as ObjectSourceKind, row.signature ?? undefined, undefined, readOptions)
      : api.getObjectSource(connectionId, database, schema, row.name, row.type as ObjectSourceKind, row.signature ?? undefined);
    const result = await sidePanelGuard.wait(epoch, sourceRequest, metadataLoadBudgetMs(props.connection.query_timeout_secs));
    if (sidePanelGuard.isStale(epoch)) return;
    sourceCanEdit.value = result.editable !== false && (!["TRIGGER", "TYPE", "TYPE_BODY"].includes(row.type) || isOracleFamilyTypeSource(effectiveDatabaseType.value, row.type)) && (row.type !== "SEQUENCE" || effectiveDatabaseType.value === "oceanbase-oracle");
    const editable = sourceCanEdit.value
      ? await sidePanelGuard.wait(
          epoch,
          api.buildEditableObjectSource({
            databaseType: effectiveDatabaseType.value,
            objectType: row.type as ObjectSourceKind,
            schema,
            name: row.name,
            source: result.source,
          }),
          metadataLoadBudgetMs(props.connection.query_timeout_secs),
        )
      : result.source;
    if (sidePanelGuard.isStale(epoch)) return;
    // Viewing database source must preserve its original whitespace and comments;
    // formatting remains an explicit editor action instead of altering it on open.
    sourceIdentity = renewSourceIdentity(identity);
    sourceEditableText.value = editable;
    sourceContent.value = row.type === "SEQUENCE" ? result.source : editable;
    sourceDraft.value = editable;
    // Fresh open always enters edit when allowed; refresh preserves prior edit mode.
    const enterEditing = sourceCanEdit.value && row.type !== "SEQUENCE" && (options?.preserveEditing ? preserveEditing : !isOracleFamilyTypeSource(effectiveDatabaseType.value, row.type));
    sourceEditing.value = enterEditing;
    if (!sourceCanEdit.value && row.type !== "SEQUENCE") {
      toast(t("objects.sourceReadOnly"), 3000);
    }
  } catch (e: any) {
    if (sidePanelGuard.isStale(epoch)) return;
    if (keptDraft !== undefined) {
      sourceEditing.value = true;
      sourceSaveError.value = e?.message || String(e);
    } else sourceError.value = e?.message || String(e);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) sourceLoading.value = false;
  }
}

async function refreshActiveSource() {
  const row = sourceRow.value || (sidePanelMode.value === "source" ? sidePanelRow.value : null);
  if (!row || sidePanelMode.value !== "source") return;
  if (!sourceTriggerRequested.value && sourceEditing.value && !window.confirm(t("objects.refreshDiscardConfirm"))) return;
  await loadSourcePanel(row, { preserveEditing: true });
}

async function openRequestedProperties() {
  const request = props.propertyRequest;
  if (!request || request.connectionId !== props.connection.id || request.database !== props.database || (request.catalog || "") !== (props.catalog || "") || request.schema !== (props.schema || props.database)) return;
  if (sourceEditing.value && sourceDraft.value !== sourceEditableText.value && !window.confirm(t("objectDependencies.navigateDiscardConfirm"))) {
    emit("propertyRequestConsumed", request.requestId);
    return;
  }
  const row: ObjectBrowserRow = { id: JSON.stringify([request.objectType, request.schema, request.name]), name: request.name, displayName: request.name, schema: request.schema, type: request.objectType };
  await openTableInfo(row, request.initialTab, request.focusObject);
  if (props.propertyRequest?.requestId !== request.requestId) return;
  emit("propertyRequestConsumed", request.requestId);
}

function openEventEditor(row: ObjectBrowserRow) {
  if (!confirmTriggerDraftDiscard()) return;
  selectedRowId.value = row.id;
  sidePanelGuard.start();
  sidePanelRow.value = row;
  sourceRow.value = null;
  sidePanelMode.value = "event-editor";
}

async function onEventSaved(savedName: string) {
  const row = sidePanelRow.value;
  const name = savedName.trim() || row?.name || "";
  if (name) {
    const cacheSchema = row?.schema || selectedSchema.value || props.database;
    const cacheScope = { connectionId: props.connection.id, database: props.database, schema: cacheSchema, tableName: name };
    await Promise.all([invalidateObjectMetadataCache(cacheScope), invalidateObjectDdl(cacheScope)]);
    invalidateObjectBrowserRowsCache({ connectionId: props.connection.id, database: props.database, schema: cacheSchema });
    if (row && row.name !== name) {
      sidePanelRow.value = { ...row, id: `event:${cacheSchema}:${name}`, name, displayName: name };
    }
  }
  await loadObjects({ allowCached: false });
  toast(t("objects.sourceSaved"));
}

async function openNewQuery(row: ObjectBrowserRow) {
  flushObjectBrowserViewport();
  const schema = row.schema || selectedSchema.value;
  const tabId = queryStore.createTab(props.connection.id, props.database, row.name, "query", schema, undefined, props.catalog);
  queryStore.updateSql(
    tabId,
    await buildTableSelectSql({
      databaseType: effectiveDatabaseType.value,
      driverProfile: props.connection.driver_profile || (props.connection.db_type === "gbase8s" ? "gbase8s" : undefined),
      serverVersion: props.connection.database_info?.productVersion,
      identifierQuote: connectionStore.connectionIdentifierQuote?.(props.connection.id),
      catalog: props.catalog,
      database: props.database,
      schema: connectionTableSqlSchema(props.connection, schema),
      tableName: row.name,
      includeDatabaseName: settingsStore.editorSettings.generateSqlIncludeDatabaseName,
      limit: 100,
    }),
  );
}

function openProcedureExecution(row: ObjectBrowserRow) {
  if (row.type !== "PROCEDURE") return;
  procedureExecutionTarget.value = row;
  showProcedureExecutionConfirm.value = true;
}

function openProcedureExecutionSql(sql: string) {
  const row = procedureExecutionTarget.value;
  if (!row || !sql) return;
  const schema = row.schema || selectedSchema.value;
  const tabId = queryStore.createTab(props.connection.id, props.database, `Execute - ${row.name}`, "query", schema, undefined, props.catalog);
  queryStore.updateSql(tabId, sql);
}

async function executeProcedureSql(sql: string) {
  const row = procedureExecutionTarget.value;
  if (!row || !sql) return;
  const schema = row.schema || selectedSchema.value;
  const tabId = queryStore.createTab(props.connection.id, props.database, `Execute - ${row.name}`, "query", schema, undefined, props.catalog);
  queryStore.updateSql(tabId, sql);
  await queryStore.executeTabSql(tabId, sql);
}

function requestDrop(row: ObjectBrowserRow) {
  if (browserTriggerBusy.value && usesExactTriggerDrop(row)) return;
  if (selectedTableCount.value > 1 && selectedTableIds.value.has(row.id) && selectedTableRows.value.some((item) => item.type === "INDEX")) {
    toast(t("schemaIndex.editIndividually"), 4000);
    return;
  }
  if (row.type === "INDEX") {
    openSchemaIndexEditor(row, "delete");
    return;
  }
  if (isOracleFamilyTypeSource(effectiveDatabaseType.value, row.type)) {
    void manageTypeDrop(row);
    return;
  }
  dropTarget.value = row;
  dropPreviewSql.value = "";
  dropPreviewError.value = "";
  triggerDropPreview.value = undefined;
  dropTableCascade.value = false;
  showDropConfirm.value = true;
  void refreshDropPreviewSql();
}

async function manageTypeDrop(row: ObjectBrowserRow): Promise<boolean> {
  const connectionId = props.connection.id;
  const database = props.database;
  const owner = row.schema || selectedSchema.value || database;
  const selectedOwner = selectedSchema.value;
  const databaseType = effectiveDatabaseType.value as "oracle" | "oceanbase-oracle" | "dameng";
  try {
    const outcome = await requestOracleTypeManagement({
      target: { connectionId, database, owner, name: row.name, databaseType },
      operation: row.type === "TYPE_BODY" ? "delete-body" : "delete-spec",
      isCurrent: () => props.connection.id === connectionId && props.database === database && selectedSchema.value === selectedOwner && effectiveDatabaseType.value === databaseType,
    });
    if (!outcome.complete) return false;
    if (props.connection.id === connectionId && props.database === database && selectedSchema.value === selectedOwner) {
      const removed = rows.value.filter((item) => (item.schema || selectedOwner || database) === owner && item.name === row.name && (item.type === row.type || (row.type === "TYPE" && item.type === "TYPE_BODY")));
      removePinnedObjectBrowserRows(removed);
      rows.value = rows.value.filter((item) => !removed.includes(item));
      if (removed.some((item) => item.id === sourceRow.value?.id)) closeSource();
      try {
        await reload();
      } catch (error) {
        toast(t("objects.typeManagementRefreshFailed", { message: String(error) }), 5000);
      }
    }
    return true;
  } catch (error) {
    toast(t("contextMenu.tableOperationFailed", { message: String(error) }), 5000);
    return false;
  }
}

function requestRename(row: ObjectBrowserRow) {
  const nextTargetKey = JSON.stringify([props.connection.id, props.database, effectiveDatabaseType.value, row.schema || selectedSchema.value || props.database, row.type, row.name]);
  const sameTarget = nextTargetKey === currentViewRenameTargetKey;
  renameTarget.value = row;
  if (!sameTarget) renameInput.value = row.name;
  renameError.value = "";
  renamePreviewSqlText.value = "";
  viewRenamePlan.value = undefined;
  routineRenamePlan.value = undefined;
  tableRenamePlan.value = undefined;
  if (!sameTarget) {
    viewRenameDrafts.value = {};
    routineRenameDrafts.value = {};
    tableRenameDrafts.value = {};
  }
  showRenameDialog.value = true;
}

function requestPackageSaveAs(row: ObjectBrowserRow) {
  if ((effectiveDatabaseType.value !== "oracle" && effectiveDatabaseType.value !== "oceanbase-oracle") || (row.type !== "PACKAGE" && row.type !== "PACKAGE_BODY")) return;
  const sourceKey = JSON.stringify([props.connection.id, props.database, effectiveDatabaseType.value, row.schema || selectedSchema.value || props.database, row.name]);
  const sameTarget = sourceKey === currentPackageSaveAsSourceKey;
  currentPackageSaveAsSourceKey = sourceKey;
  packageSaveAsTarget.value = row;
  if (!sameTarget) {
    packageSaveAsName.value = `${row.name}_COPY`;
    packageSaveAsDrafts.value = {};
  }
  packageSaveAsPlan.value = undefined;
  packageSaveAsError.value = "";
  packageSaveAsDiagnostic.value = "";
  packageSaveAsOpen.value = true;
}

let currentPackageSaveAsSourceKey = "";
let packageSaveAsRequestId = 0;
watch([packageSaveAsOpen, packageSaveAsTarget, packageSaveAsName, () => props.connection.id, () => props.database, selectedSchema, effectiveDatabaseType], (_value, _oldValue, onCleanup) => {
  const requestId = ++packageSaveAsRequestId;
  const row = packageSaveAsTarget.value;
  const sourceKey = row ? JSON.stringify([props.connection.id, props.database, effectiveDatabaseType.value, row.schema || selectedSchema.value || props.database, row.name]) : "";
  if (sourceKey && sourceKey !== currentPackageSaveAsSourceKey) {
    currentPackageSaveAsSourceKey = sourceKey;
    packageSaveAsDrafts.value = {};
  }
  const newName = packageSaveAsName.value.trim();
  packageSaveAsPlan.value = undefined;
  packageSaveAsError.value = "";
  packageSaveAsDiagnostic.value = "";
  if (!packageSaveAsOpen.value || !row || !newName || newName === row.name || !props.connection.id || !props.database || (effectiveDatabaseType.value !== "oracle" && effectiveDatabaseType.value !== "oceanbase-oracle")) return;
  const timer = setTimeout(async () => {
    packageSaveAsLoading.value = true;
    try {
      const plan = await prepareOraclePackageSaveAs(
        {
          connectionId: props.connection.id,
          database: props.database,
          databaseType: effectiveDatabaseType.value as "oracle" | "oceanbase-oracle",
          schema: row.schema || selectedSchema.value || props.database,
          oldName: row.name,
          newName,
        },
        { ...packageSaveAsDrafts.value },
      );
      if (requestId === packageSaveAsRequestId) packageSaveAsPlan.value = plan;
    } catch (error) {
      if (requestId === packageSaveAsRequestId) packageSaveAsDiagnostic.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestId === packageSaveAsRequestId) packageSaveAsLoading.value = false;
    }
  }, 250);
  onCleanup(() => clearTimeout(timer));
});

async function confirmPackageSaveAs() {
  const row = packageSaveAsTarget.value;
  const plan = packageSaveAsPlan.value;
  if (!row || !plan || !plan.executable || !packageSaveAsOpen.value) return;
  const schema = row.schema || selectedSchema.value || props.database;
  if (plan.target.newName !== packageSaveAsName.value.trim() || plan.target.oldName !== row.name || plan.target.schema !== schema || plan.target.connectionId !== props.connection.id || plan.target.database !== props.database) {
    packageSaveAsError.value = t("objects.packageSaveAsMetadataProblem");
    return;
  }
  packageSaveAsExecuting.value = true;
  packageSaveAsError.value = "";
  packageSaveAsDiagnostic.value = "";
  const isCurrentPlan = () => {
    const currentRow = packageSaveAsTarget.value;
    return (
      packageSaveAsOpen.value &&
      packageSaveAsPlan.value === plan &&
      !!currentRow &&
      currentRow.name === plan.target.oldName &&
      props.connection.id === plan.target.connectionId &&
      props.database === plan.target.database &&
      (currentRow.schema || selectedSchema.value || props.database) === plan.target.schema &&
      effectiveDatabaseType.value === plan.target.databaseType &&
      packageSaveAsName.value.trim() === plan.target.newName
    );
  };
  let prepared: Awaited<ReturnType<typeof prepareOraclePackageSaveAsExecution>> | undefined;
  try {
    prepared = await prepareOraclePackageSaveAsExecution(plan, isCurrentPlan);
    const execute = prepared;
    const executed = await executeObjectBrowserSqlWithProductionGuard(plan.statements.join("\n\n"), async () => {
      await execute();
      return true;
    });
    if (!executed) return;
    toast(t("objects.packageSaveAsSuccess", { oldName: row.name, newName: plan.canonicalNewName }));
    packageSaveAsOpen.value = false;
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, schema);
  } catch (error) {
    if (isCurrentPlan()) {
      packageSaveAsError.value = t("objects.packageSaveAsFailed");
      packageSaveAsDiagnostic.value = error instanceof Error ? error.message : String(error);
      packageSaveAsPlan.value = { ...plan, executable: false };
    }
    if (error instanceof OraclePackageSaveAsFailure && error.dispatched) {
      try {
        await connectionStore.refreshObjectListTreeNode(plan.target.connectionId, plan.target.database, plan.target.schema);
        if (props.connection.id === plan.target.connectionId && props.database === plan.target.database && (packageSaveAsTarget.value?.schema || selectedSchema.value || props.database) === plan.target.schema) await reload();
      } catch {
        // Keep the package DDL failure visible when metadata refresh also fails.
      }
    }
  } finally {
    await prepared?.dispose();
    packageSaveAsExecuting.value = false;
  }
}

function editPackageSaveAsDraft(part: "spec" | "body", source: string) {
  packageSaveAsDrafts.value = { ...packageSaveAsDrafts.value, [part]: source };
  ++packageSaveAsRequestId;
  if (packageSaveAsPlan.value) packageSaveAsPlan.value = { ...packageSaveAsPlan.value, executable: false };
}

async function validatePackageSaveAsDrafts() {
  if (packageSaveAsPlan.value) packageSaveAsPlan.value = { ...packageSaveAsPlan.value, executable: false };
  packageSaveAsError.value = "";
  packageSaveAsDiagnostic.value = "";
  packageSaveAsValidating.value = true;
  try {
    const row = packageSaveAsTarget.value;
    const newName = packageSaveAsName.value.trim();
    if (!row || !newName) return;
    const requestId = ++packageSaveAsRequestId;
    const drafts = { ...packageSaveAsDrafts.value };
    const targetKey = JSON.stringify([props.connection.id, props.database, effectiveDatabaseType.value, row.schema || selectedSchema.value || props.database, row.name, newName]);
    const plan = await prepareOraclePackageSaveAs(
      {
        connectionId: props.connection.id,
        database: props.database,
        databaseType: effectiveDatabaseType.value as "oracle" | "oceanbase-oracle",
        schema: row.schema || selectedSchema.value || props.database,
        oldName: row.name,
        newName,
      },
      drafts,
    );
    if (
      requestId === packageSaveAsRequestId &&
      packageSaveAsOpen.value &&
      packageSaveAsTarget.value === row &&
      packageSaveAsName.value.trim() === newName &&
      targetKey === JSON.stringify([props.connection.id, props.database, effectiveDatabaseType.value, row.schema || selectedSchema.value || props.database, row.name, packageSaveAsName.value.trim()]) &&
      JSON.stringify(packageSaveAsDrafts.value) === JSON.stringify(drafts)
    )
      packageSaveAsPlan.value = plan;
  } catch (error) {
    packageSaveAsDiagnostic.value = error instanceof Error ? error.message : String(error);
  } finally {
    packageSaveAsValidating.value = false;
  }
}

let renamePreviewRequestId = 0;
let currentViewRenameTargetKey = "";

async function refreshRenamePreviewSql() {
  const requestId = ++renamePreviewRequestId;
  const row = renameTarget.value;
  const newName = renameInput.value.trim();
  if (!showRenameDialog.value || !row || row.type === "INDEX" || !newName || newName === row.name) {
    renamePreviewSqlText.value = "";
    viewRenamePlan.value = undefined;
    routineRenamePlan.value = undefined;
    tableRenamePlan.value = undefined;
    return;
  }
  if ((effectiveDatabaseType.value === "oracle" || effectiveDatabaseType.value === "oceanbase-oracle") && (row.type === "PROCEDURE" || row.type === "FUNCTION")) {
    const targetKey = JSON.stringify([props.connection.id, props.database, effectiveDatabaseType.value, row.schema || selectedSchema.value || props.database, row.type, row.name, newName]);
    const drafts = { ...routineRenameDrafts.value };
    viewRenameLoading.value = true;
    try {
      const plan = await prepareOracleRoutineRename(
        {
          connectionId: props.connection.id,
          database: props.database,
          databaseType: effectiveDatabaseType.value as "oracle" | "oceanbase-oracle",
          schema: row.schema || selectedSchema.value || props.database,
          objectType: row.type,
          oldName: row.name,
          newName,
        },
        drafts,
      );
      if (
        requestId === renamePreviewRequestId &&
        showRenameDialog.value &&
        renameTarget.value === row &&
        targetKey === JSON.stringify([props.connection.id, props.database, effectiveDatabaseType.value, row.schema || selectedSchema.value || props.database, row.type, row.name, renameInput.value.trim()]) &&
        JSON.stringify(drafts) === JSON.stringify(routineRenameDrafts.value)
      ) {
        routineRenamePlan.value = plan;
        renameError.value = "";
        renamePreviewSqlText.value = plan.statements.join("\n\n");
      }
    } catch (error) {
      if (requestId === renamePreviewRequestId) renameError.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestId === renamePreviewRequestId) viewRenameLoading.value = false;
    }
    return;
  }
  if (supportsSourceBackedRoutineRename(effectiveDatabaseType.value, row.type as ObjectSourceKind)) {
    renamePreviewSqlText.value = t("objects.routineRenamePreview");
    return;
  }
  if ((effectiveDatabaseType.value === "oracle" || effectiveDatabaseType.value === "oceanbase-oracle") && row.type === "TABLE") {
    viewRenameLoading.value = true;
    try {
      const plan = await prepareOracleTableRename({ connectionId: props.connection.id, database: props.database, databaseType: effectiveDatabaseType.value, schema: row.schema || selectedSchema.value || props.database, oldName: row.name, newName }, tableRenameDrafts.value);
      if (requestId === renamePreviewRequestId) {
        tableRenamePlan.value = plan;
        renameError.value = "";
        renamePreviewSqlText.value = `-- ${t("objects.tableRenameCoverage")}\n\n${plan.statements.join("\n\n")}`;
      }
    } catch (error) {
      if (requestId === renamePreviewRequestId) renameError.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (requestId === renamePreviewRequestId) viewRenameLoading.value = false;
    }
    return;
  }
  try {
    if (effectiveDatabaseType.value === "oceanbase-oracle" && row.type === "VIEW") {
      viewRenameLoading.value = true;
      const plan = await prepareOracleViewRename({ connectionId: props.connection.id, database: props.database, schema: row.schema || selectedSchema.value || props.database, oldName: row.name, newName }, viewRenameDrafts.value);
      if (requestId === renamePreviewRequestId) {
        viewRenamePlan.value = plan;
        renameError.value = "";
        renamePreviewSqlText.value = `-- ${t("objects.viewRenameCoverage")}\n\n${plan.statements.join("\n\n")}`;
      }
      return;
    }
    const sql = await buildRenameObjectSql({
      databaseType: effectiveDatabaseType.value,
      objectType: row.type,
      schema: row.schema || selectedSchema.value,
      oldName: row.name,
      newName,
    });
    if (requestId === renamePreviewRequestId) renamePreviewSqlText.value = sql;
  } catch (error) {
    if (requestId === renamePreviewRequestId) {
      renamePreviewSqlText.value = "";
      if (effectiveDatabaseType.value === "oceanbase-oracle" && row.type === "VIEW") renameError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (requestId === renamePreviewRequestId) viewRenameLoading.value = false;
  }
}

function editViewRenameDraft(name: string, source: string) {
  viewRenameDrafts.value = { ...viewRenameDrafts.value, [name]: source };
  if (viewRenamePlan.value) viewRenamePlan.value = { ...viewRenamePlan.value, executable: false };
}

function editTableRenameDraft(name: string, source: string) {
  tableRenameDrafts.value = { ...tableRenameDrafts.value, [name]: source };
  if (tableRenamePlan.value) tableRenamePlan.value = { ...tableRenamePlan.value, executable: false };
}

function editRoutineRenameDraft(name: string, source: string) {
  routineRenameDrafts.value = { ...routineRenameDrafts.value, [name]: source };
  ++renamePreviewRequestId;
  if (routineRenamePlan.value) routineRenamePlan.value = { ...routineRenamePlan.value, executable: false };
}

async function validateRoutineRenameDrafts() {
  if (routineRenamePlan.value) routineRenamePlan.value = { ...routineRenamePlan.value, executable: false };
  viewRenameValidating.value = true;
  try {
    await refreshRenamePreviewSql();
  } finally {
    viewRenameValidating.value = false;
  }
}

async function validateTableRenameDrafts(clearDrafts = false) {
  if (clearDrafts) tableRenameDrafts.value = {};
  viewRenameValidating.value = true;
  try {
    await refreshRenamePreviewSql();
  } finally {
    viewRenameValidating.value = false;
  }
}

async function validateViewRenameDrafts(clearDrafts = false) {
  const row = renameTarget.value;
  if (!row) return;
  if (clearDrafts) viewRenameDrafts.value = {};
  viewRenameValidating.value = true;
  try {
    await refreshRenamePreviewSql();
  } finally {
    viewRenameValidating.value = false;
  }
}

watch([showRenameDialog, renameTarget, renameInput, selectedSchema, () => props.connection.id, () => props.database], (_value, _oldValue, onCleanup) => {
  ++renamePreviewRequestId;
  const row = renameTarget.value;
  const targetKey = row && (row.type === "VIEW" || row.type === "PROCEDURE" || row.type === "FUNCTION" || row.type === "TABLE") ? JSON.stringify([props.connection.id, props.database, effectiveDatabaseType.value, row.schema || selectedSchema.value || props.database, row.type, row.name]) : "";
  if (targetKey !== currentViewRenameTargetKey) {
    currentViewRenameTargetKey = targetKey;
    viewRenameDrafts.value = {};
    viewRenamePlan.value = undefined;
    routineRenamePlan.value = undefined;
    tableRenamePlan.value = undefined;
    routineRenameDrafts.value = {};
    tableRenameDrafts.value = {};
  } else if (viewRenamePlan.value) viewRenamePlan.value = { ...viewRenamePlan.value, executable: false };
  if (routineRenamePlan.value) routineRenamePlan.value = { ...routineRenamePlan.value, executable: false };
  if ((effectiveDatabaseType.value !== "oracle" && effectiveDatabaseType.value !== "oceanbase-oracle") || (renameTarget.value?.type !== "VIEW" && renameTarget.value?.type !== "PROCEDURE" && renameTarget.value?.type !== "FUNCTION" && renameTarget.value?.type !== "TABLE")) {
    viewRenamePlan.value = undefined;
    routineRenamePlan.value = undefined;
    tableRenamePlan.value = undefined;
    void refreshRenamePreviewSql();
    return;
  }
  const timer = setTimeout(() => void refreshRenamePreviewSql(), 250);
  onCleanup(() => clearTimeout(timer));
});

async function confirmRename() {
  const row = renameTarget.value;
  let newName = renameInput.value.trim();
  if (!row || row.type === "INDEX" || !newName || newName === row.name) return;
  renameError.value = "";
  const oldPinnedNode = pinnedTreeNodeForObjectBrowserRow(row);
  const oldLegacyPinnedNodes = legacyPinnedTreeNodesForObjectBrowserRow(row);
  let renameApplied = false;
  let updatedViewDependencies: number | undefined;
  let updatedTableDependencies: number | undefined;
  let tableRenameFreeze: ReturnType<typeof freezeSourceIdentities> | undefined;
  try {
    const schema = row.schema || selectedSchema.value || props.database;
    if (row.type === "TABLE" && effectiveDatabaseType.value === "dameng") {
      tableRenameFreeze = freezeSourceIdentities([{ connectionId: props.connection.id, database: props.database, schema, objectType: "TABLE", name: row.name }]);
    }
    if ((effectiveDatabaseType.value === "oracle" || effectiveDatabaseType.value === "oceanbase-oracle") && row.type === "TABLE") {
      const plan = tableRenamePlan.value;
      if (!plan || plan.target.newName !== newName || plan.target.oldName !== row.name || plan.target.schema !== schema || plan.target.connectionId !== props.connection.id || plan.target.database !== props.database) throw new Error(t("objects.viewRenameRefresh"));
      if (!plan.executable) throw new Error(t("objects.viewRenameValidationPending"));
      viewRenameExecuting.value = true;
      const executed = await executeObjectBrowserSqlWithProductionGuard(plan.statements.join("\n\n"), async () => {
        await executeOracleTableRename(
          plan,
          tableRenameDrafts.value,
          () => tableRenamePlan.value === plan && showRenameDialog.value && props.connection.id === plan.target.connectionId && props.database === plan.target.database && (row.schema || selectedSchema.value || props.database) === plan.target.schema,
        );
        return true;
      });
      if (!executed) return;
      newName = plan.canonicalNewName;
      updatedTableDependencies = plan.dependents.length;
    } else if (effectiveDatabaseType.value === "oceanbase-oracle" && row.type === "VIEW") {
      const plan = viewRenamePlan.value;
      if (!plan || plan.target.newName !== newName || plan.target.oldName !== row.name || plan.target.schema !== schema || plan.target.connectionId !== props.connection.id || plan.target.database !== props.database) throw new Error(t("objects.viewRenameRefresh"));
      if (!plan.executable) throw new Error(t("objects.viewRenameValidationPending"));
      viewRenameExecuting.value = true;
      const executed = await executeObjectBrowserSqlWithProductionGuard(plan.statements.join("\n"), async () => {
        await executeOracleViewRename(plan, () => viewRenamePlan.value === plan && showRenameDialog.value && props.connection.id === plan.target.connectionId && props.database === plan.target.database && (row.schema || selectedSchema.value || props.database) === plan.target.schema);
        return true;
      });
      if (!executed) return;
      newName = plan.canonicalNewName;
      updatedViewDependencies = plan.views.length - 1;
    } else if ((effectiveDatabaseType.value === "oracle" || effectiveDatabaseType.value === "oceanbase-oracle") && (row.type === "PROCEDURE" || row.type === "FUNCTION")) {
      const plan = routineRenamePlan.value;
      if (!plan || plan.target.newName !== newName || plan.target.oldName !== row.name || plan.target.schema !== schema || plan.target.connectionId !== props.connection.id || plan.target.database !== props.database) throw new Error(t("objects.viewRenameRefresh"));
      if (!plan.executable) throw new Error(t("objects.viewRenameValidationPending"));
      viewRenameExecuting.value = true;
      const executed = await executeObjectBrowserSqlWithProductionGuard(plan.statements.join("\n\n"), async () => {
        await executeOracleRoutineRename(plan, () => routineRenamePlan.value === plan && showRenameDialog.value && props.connection.id === plan.target.connectionId && props.database === plan.target.database && (row.schema || selectedSchema.value || props.database) === plan.target.schema);
        return true;
      });
      if (!executed) return;
      newName = plan.canonicalNewName;
    } else if (supportsSourceBackedRoutineRename(effectiveDatabaseType.value, row.type as ObjectSourceKind)) {
      const source = await api.getObjectSource(props.connection.id, props.database, schema, row.name, row.type as ObjectSourceKind, row.signature ?? undefined);
      const statements = await buildRoutineRenameObjectSourceStatements({
        databaseType: effectiveDatabaseType.value,
        objectType: row.type as ObjectSourceKind,
        schema,
        name: row.name,
        newName,
        source: source.source,
      });
      const executed = await executeObjectBrowserSqlWithProductionGuard(statements.join(";\n"), async () => {
        for (const sql of statements) {
          await api.executeQuery(props.connection.id, props.database, sql, schema);
        }
        return true;
      });
      if (!executed) return;
    } else {
      const sql = await buildRenameObjectSql({
        databaseType: effectiveDatabaseType.value,
        objectType: row.type,
        schema,
        oldName: row.name,
        newName,
      });
      const executed = await executeObjectBrowserSqlWithProductionGuard(sql, () => {
        tableRenameFreeze?.markDispatched();
        return api.executeQuery(props.connection.id, props.database, sql, schema);
      });
      if (!executed) return;
    }
    renameApplied = true;
    toast(
      updatedTableDependencies !== undefined
        ? t("objects.tableRenameSuccess", { oldName: row.name, newName, count: updatedTableDependencies })
        : updatedViewDependencies === undefined
          ? t("contextMenu.renameObjectSuccess", { oldName: row.name, newName })
          : t("objects.viewRenameSuccess", { oldName: row.name, newName, count: updatedViewDependencies }),
    );
    showRenameDialog.value = false;
    if (sourceRow.value?.id === row.id) closeSource();
    const renamedTarget = { ...oldPinnedNode, label: newName, objectName: newName, tableName: newName };
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, row.schema || selectedSchema.value);
    const renamedRow = rows.value.find((candidate) => objectBrowserRowMatchesPinnedTreeNode(candidate, treeNodePinIdentity(renamedTarget), objectBrowserPinnedTreeNodeContext()));
    if (renamedRow) {
      connectionStore.replacePinnedTreeNode(
        oldPinnedNode,
        pinnedTreeNodeForObjectBrowserRow(renamedRow),
        canonicalizeObjectBrowserPinnedIdentity,
        oldLegacyPinnedNodes.map((node) => node.id),
      );
    } else {
      // The database mutation succeeded, so never leave the old name pinned if
      // metadata refresh cannot resolve its replacement.
      connectionStore.removePinnedTreeNodes([oldPinnedNode, ...oldLegacyPinnedNodes], canonicalizeObjectBrowserPinnedIdentity);
    }
  } catch (e: any) {
    if (e instanceof OracleViewRenameFailure) {
      connectionStore.removePinnedTreeNodes([oldPinnedNode, ...oldLegacyPinnedNodes], canonicalizeObjectBrowserPinnedIdentity);
      renamePreviewSqlText.value += `\n\n-- ${t("objects.viewRenameRecovery")}\n${e.plan.views.map((view) => view.source).join("\n\n")}`;
    }
    if (e instanceof OracleRoutineRenameFailure) {
      renameError.value = e.message;
      if (routineRenamePlan.value) routineRenamePlan.value = { ...routineRenamePlan.value, executable: false };
    }
    if (e instanceof OracleTableRenameFailure) {
      renameError.value = e.message;
      if (tableRenamePlan.value) tableRenamePlan.value = { ...tableRenamePlan.value, executable: false };
      if (e.completed.some((step) => step.startsWith("TABLE "))) connectionStore.removePinnedTreeNodes([oldPinnedNode, ...oldLegacyPinnedNodes], canonicalizeObjectBrowserPinnedIdentity);
    }
    if (viewRenamePlan.value) viewRenamePlan.value = { ...viewRenamePlan.value, executable: false, issues: [...viewRenamePlan.value.issues, { code: "metadata_drift", message: e?.message || String(e), repairable: false }] };
    if (renameApplied) {
      // The database mutation succeeded even when metadata refresh did not;
      // remove the old pin instead of allowing it to revive later.
      connectionStore.removePinnedTreeNodes([oldPinnedNode, ...oldLegacyPinnedNodes], canonicalizeObjectBrowserPinnedIdentity);
    }
    renameError.value = e?.message || String(e);
  } finally {
    tableRenameFreeze?.cancel();
    tableRenameFreeze?.finish();
    viewRenameExecuting.value = false;
  }
}

async function confirmDrop() {
  if (!dropTarget.value) return;
  const row = dropTarget.value;
  if (usesExactTriggerDrop(row)) {
    if (triggerDropPreview.value) await executeBrowserTriggerDrops(triggerDropPreview.value, false);
    return;
  }
  if (row.type === "INDEX") return;
  if (isOracleFamilyTypeSource(effectiveDatabaseType.value, row.type)) {
    await manageTypeDrop(row);
    dropTarget.value = null;
    return;
  }
  let executedSql = "";
  const start = Date.now();
  let successRecorded = false;
  try {
    const sql = dropPreviewSql.value || (await buildDropSqlForRow(row, { cascade: canDropTargetCascade.value && dropTableCascade.value }));
    executedSql = sql;
    const executed = await executeObjectBrowserSqlWithProductionGuard(sql, () => api.executeQuery(props.connection.id, props.database, sql));
    if (!executed) return;
    await recordTableMutationHistory(getTableMutationHistoryStoreOrNull(), {
      connectionId: props.connection.id,
      connectionName: props.connection.name,
      database: props.database,
      sql,
      elapsedMs: Date.now() - start,
      success: true,
      target: row.name,
    }).catch((err) => console.warn("[DBX] failed to record drop history", err));
    successRecorded = true;
    const successKey = row.type === "VIEW" ? "contextMenu.dropViewSuccess" : row.type === "PROCEDURE" ? "contextMenu.dropProcedureSuccess" : row.type === "FUNCTION" ? "contextMenu.dropFunctionSuccess" : row.type === "EVENT" ? "contextMenu.dropEventSuccess" : "contextMenu.dropTableSuccess";
    toast(t(successKey, { name: row.name }));
    const cacheSchema = row.schema || selectedSchema.value || props.database;
    await Promise.all([invalidateObjectMetadataCache({ connectionId: props.connection.id, database: props.database, schema: cacheSchema, tableName: row.name }), invalidateObjectDdl({ connectionId: props.connection.id, database: props.database, schema: cacheSchema, tableName: row.name })]);
    invalidateObjectBrowserRowsCache({ connectionId: props.connection.id, database: props.database, schema: cacheSchema });
    closeDroppedTableObjectTabsForRow(row);
    removePinnedObjectBrowserRows([row]);
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, row.schema || selectedSchema.value);
  } catch (e: any) {
    if (executedSql && !successRecorded) {
      await recordTableMutationHistory(getTableMutationHistoryStoreOrNull(), {
        connectionId: props.connection.id,
        connectionName: props.connection.name,
        database: props.database,
        sql: executedSql,
        elapsedMs: Date.now() - start,
        success: false,
        error: e?.message || String(e),
        target: row.name,
      }).catch((err) => console.warn("[DBX] failed to record drop history", err));
    }
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
  dropTarget.value = null;
  dropPreviewSql.value = "";
  dropTableCascade.value = false;
}

async function buildDropSqlForRow(row: ObjectBrowserRow, options?: { cascade?: boolean }): Promise<string> {
  if (row.type === "INDEX") throw new Error(t("schemaIndex.editIndividually"));
  if (isOracleFamilyTypeSource(effectiveDatabaseType.value, row.type)) throw new Error(t("objects.typeManagementUseSave"));
  if (row.type === "TYPE" || row.type === "TYPE_BODY") throw new Error(t("objects.sourceReadOnly"));
  if (row.type === "TABLE") {
    return buildDropTableSql(tableAdminSqlOptions(row, { cascade: options?.cascade && supportsDropTableCascade(effectiveDatabaseType.value) }));
  }
  return buildDropObjectSql({
    databaseType: effectiveDatabaseType.value,
    objectType: row.type,
    schema: row.schema || selectedSchema.value,
    name: row.name,
    signature: row.signature,
    identifierQuote: connectionStore.connectionIdentifierQuote?.(props.connection.id),
  });
}

let dropPreviewRequestId = 0;

async function refreshDropPreviewSql() {
  const requestId = ++dropPreviewRequestId;
  const row = dropTarget.value;
  if (!row) {
    dropPreviewSql.value = "";
    return;
  }
  dropPreviewSql.value = "";
  triggerDropPreview.value = undefined;
  dropPreviewError.value = "";
  if (usesExactTriggerDrop(row)) {
    try {
      const prepared = await prepareBrowserTriggerDrops([row], false);
      if (requestId !== dropPreviewRequestId || !prepared.isCurrent()) return;
      triggerDropPreview.value = prepared;
      dropPreviewSql.value = prepared.plan.entries.map((entry) => entry.sql).join("\n\n");
    } catch (error) {
      if (requestId === dropPreviewRequestId) dropPreviewError.value = error instanceof Error ? error.message : String(error);
    }
    return;
  }
  const sql = await buildDropSqlForRow(row, { cascade: canDropTargetCascade.value && dropTableCascade.value }).catch(() => "");
  if (requestId === dropPreviewRequestId) dropPreviewSql.value = sql;
}

function dropConfirmTitle(): string {
  if (!dropTarget.value) return "";
  const type = dropTarget.value.type;
  if (type === "TRIGGER") return t("contextMenu.confirmDropTriggerTitle");
  if (type === "VIEW" || type === "MATERIALIZED_VIEW") return t("contextMenu.confirmDropViewTitle");
  if (type === "PROCEDURE") return t("contextMenu.confirmDropProcedureTitle");
  if (type === "FUNCTION") return t("contextMenu.confirmDropFunctionTitle");
  if (type === "EVENT") return t("contextMenu.confirmDropEventTitle");
  return t("contextMenu.confirmDropTableTitle");
}

function dropConfirmMessage(): string {
  if (!dropTarget.value) return "";
  const name = dropTarget.value.name;
  const type = dropTarget.value.type;
  if (type === "TRIGGER") return t("contextMenu.confirmDropObjectMessage", { name });
  if (type === "VIEW" || type === "MATERIALIZED_VIEW") return t("contextMenu.confirmDropViewMessage", { name });
  if (type === "PROCEDURE") return t("contextMenu.confirmDropProcedureMessage", { name });
  if (type === "FUNCTION") return t("contextMenu.confirmDropFunctionMessage", { name });
  if (type === "EVENT") return t("contextMenu.confirmDropEventMessage", { name });
  return t("contextMenu.confirmDropTableMessage", { name });
}

function closeSource() {
  if (!confirmTriggerDraftDiscard()) return;
  closeSidePanel();
  sourceContent.value = "";
  sourceError.value = "";
  sourceEditing.value = false;
  sourceEditableText.value = "";
  sourceDraft.value = "";
  sourceSaveError.value = "";
}

async function saveFileContent(content: string, defaultFileName: string, filterName: string, filterExt: string) {
  if (isTauriRuntime()) {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await promptExportSavePath({
      defaultFileName,
      filters: [{ name: filterName, extensions: [filterExt] }],
    });
    if (path) await writeTextFile(path, content);
  } else {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultFileName;
    a.click();
    URL.revokeObjectURL(url);
  }
}

function objectBrowserOpenTableType(row: ObjectBrowserRow): string {
  if (row.collectionKind === "view") return "VIEW";
  if (row.collectionKind === "timeseries") return "TIMESERIES";
  return row.type;
}

function openViewData(row: ObjectBrowserRow) {
  emit("openTable", { tableName: row.name, schema: row.schema, tableType: objectBrowserOpenTableType(row), catalog: props.catalog, comment: row.comment });
}

function openStructureEditor(row: ObjectBrowserRow) {
  if (row.type !== "TABLE") return;
  queryStore.openTableStructure(props.connection.id, props.database, row.schema || selectedSchema.value, row.name, undefined, undefined, props.catalog);
}

function openSchemaIndexEditor(row: ObjectBrowserRow, action?: "delete") {
  if (row.type !== "INDEX" || !supportsSchemaIndexes.value) return;
  const target = schemaIndexIdentity(row);
  if (!target) return;
  if (!schemaIndexIsSameOwner(target) || connectionIsEffectivelyReadOnly(props.connection)) {
    if (!action) void openTableInfo(row, "indexes");
    return;
  }
  queryStore.openTableStructure(props.connection.id, props.database, target.parentSchema, target.parentName, "indexes", { kind: "index", name: target.name, owner: target.schema, ...(action ? { action } : {}) }, props.catalog, "table", true);
}

const showIndexParentPicker = ref(false);
const indexParentTables = ref<string[]>([]);
const indexParentTable = ref("");
const indexParentLoading = ref(false);
const indexParentError = ref("");
const indexParentGuard = createSidePanelRequestGuard();
let loadedIndexParentScope = "";
function indexParentSchema() {
  return selectedSchema.value ?? props.schema ?? objectListSchemaForConnection(props.connection, selectedSchema.value) ?? props.database;
}
function indexParentScope() {
  return JSON.stringify([props.connection.id, props.database, props.catalog, indexParentSchema(), connectionConfigFingerprint(props.connection)]);
}
async function loadIndexParentTables() {
  if (!showIndexParentPicker.value || !canCreateSchemaIndex.value) return;
  const epoch = indexParentGuard.start();
  const scope = indexParentScope();
  const schema = indexParentSchema();
  loadedIndexParentScope = "";
  indexParentLoading.value = true;
  indexParentError.value = "";
  indexParentTables.value = [];
  indexParentTable.value = "";
  try {
    const tables = await indexParentGuard.wait(epoch, api.listTables(props.connection.id, props.database, schema, undefined, undefined, undefined, ["TABLE"], props.catalog, undefined, true), metadataLoadBudgetMs(props.connection.query_timeout_secs));
    if (indexParentGuard.isStale(epoch) || indexParentScope() !== scope) return;
    indexParentTables.value = tables.filter((table) => table.table_type.toUpperCase() === "TABLE").map((table) => table.name);
    loadedIndexParentScope = scope;
  } catch (error) {
    if (indexParentGuard.isFresh(epoch) && indexParentScope() === scope) indexParentError.value = translateBackendError(t, error);
  } finally {
    if (indexParentGuard.isFresh(epoch)) indexParentLoading.value = false;
  }
}
function createSchemaIndex() {
  if (!canCreateSchemaIndex.value) return;
  showIndexParentPicker.value = true;
  void loadIndexParentTables();
}
function confirmIndexParent() {
  if (!showIndexParentPicker.value || !canCreateSchemaIndex.value || indexParentLoading.value || loadedIndexParentScope !== indexParentScope() || !indexParentTables.value.includes(indexParentTable.value)) return;
  queryStore.openTableStructure(props.connection.id, props.database, indexParentSchema(), indexParentTable.value, "indexes", { kind: "index", name: "", action: "create" }, props.catalog, "table", true);
  showIndexParentPicker.value = false;
}
watch(showIndexParentPicker, (open) => {
  if (open) return;
  indexParentGuard.bump();
  indexParentLoading.value = false;
  loadedIndexParentScope = "";
});
watch(
  () => [props.connection.id, props.database, selectedSchema.value, props.catalog, connectionConfigFingerprint(props.connection)],
  () => {
    showIndexParentPicker.value = false;
    indexParentGuard.bump();
  },
);
let consumedIndexCreateRequest = "";
watch(
  () => props.initialIndexCreateRequestId,
  () => {
    if (props.initialIndexCreateRequestId === undefined) return;
    const key = JSON.stringify([props.connection.id, props.database, props.schema, props.initialIndexCreateRequestId]);
    if (consumedIndexCreateRequest === key) return;
    consumedIndexCreateRequest = key;
    const scope = indexParentScope();
    emit("indexRequestConsumed", "create");
    void nextTick(() => {
      if (indexParentScope() === scope) createSchemaIndex();
    });
  },
  { immediate: true },
);
let consumedIndexViewRequest = "";
watch(
  () => [props.initialViewRequestId, props.initialViewTarget],
  () => {
    const target = props.initialViewTarget && schemaIndexIdentity(props.initialViewTarget);
    if (!target || props.initialViewRequestId === undefined || !supportsSchemaIndexes.value) return;
    const key = JSON.stringify([props.connection.id, props.database, target, props.initialViewRequestId]);
    if (consumedIndexViewRequest === key) return;
    consumedIndexViewRequest = key;
    const scope = indexParentScope();
    emit("indexRequestConsumed", "view");
    void nextTick(() => {
      if (indexParentScope() === scope) void openTableInfo({ ...target, id: `index:${JSON.stringify(target)}`, type: "INDEX", displayName: target.name }, "indexes");
    });
  },
  { immediate: true, flush: "post" },
);

function droppedTableObjectTypeForRow(row: ObjectBrowserRow): "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | null {
  if (row.type === "TABLE") return "TABLE";
  if (row.type === "VIEW") return "VIEW";
  if (row.type === "MATERIALIZED_VIEW") return "MATERIALIZED_VIEW";
  return null;
}

function closeDroppedTableObjectTabsForRow(row: ObjectBrowserRow) {
  const objectType = droppedTableObjectTypeForRow(row);
  if (!objectType) return;
  queryStore.closeDroppedTableObjectTabs({
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
    name: row.name,
    objectType,
  });
}

function openDiagram(row: ObjectBrowserRow) {
  connectionStore.diagramSource = {
    connectionId: props.connection.id,
    database: props.database,
    catalog: props.catalog,
    schema: row.schema || selectedSchema.value,
    tableName: row.type === "TABLE" ? row.name : undefined,
  };
}

function openTableImport(row: ObjectBrowserRow) {
  if (row.type !== "TABLE") return;
  connectionStore.tableImportSource = {
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
    tableName: row.name,
  };
}

function openDataCompare(row: ObjectBrowserRow) {
  connectionStore.dataCompareSource = {
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
    tableName: row.type === "TABLE" ? row.name : undefined,
  };
}

function openDataDictionary(row: ObjectBrowserRow) {
  connectionStore.dataDictionarySource = {
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
    tableNames: [row.name],
  };
}

function openDatabaseExport(row: ObjectBrowserRow) {
  connectionStore.databaseExportSource = {
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
    tableName: row.type === "TABLE" || row.type === "VIEW" || row.type === "MATERIALIZED_VIEW" ? row.name : undefined,
  };
}

function setSelectedTableIds(ids: Set<string>) {
  selectedTableIds.value = new Set(ids);
}

function toggleTableSelection(row: ObjectBrowserRow) {
  const next = new Set(selectedTableIds.value);
  if (next.has(row.id)) {
    next.delete(row.id);
  } else {
    next.add(row.id);
  }
  setSelectedTableIds(next);
}

function toggleVisibleTableSelection() {
  const next = new Set(selectedTableIds.value);
  if (allVisibleTablesSelected.value) {
    for (const row of visibleSelectableRows.value) next.delete(row.id);
  } else {
    for (const row of visibleSelectableRows.value) next.add(row.id);
  }
  setSelectedTableIds(next);
}

function clearTableSelection() {
  setSelectedTableIds(new Set());
}

function openBatchDatabaseExport() {
  if (hasSelectedSchemaIndexes.value) return;
  const selectedTables = selectedTableRows.value.map((row) => row.name);
  if (selectedTables.length === 0) return;
  connectionStore.databaseExportSource = {
    connectionId: props.connection.id,
    database: props.database,
    schema: selectedTableRows.value[0]?.schema || selectedSchema.value,
    tableNames: selectedTables,
  };
}

async function fetchSortedTableRowsForDrop(): Promise<ObjectBrowserRow[]> {
  const rows = [...selectedTableRows.value];
  if (rows.length <= 1) return rows;

  const fkResults = await Promise.all(rows.map((row) => (row.type === "TABLE" ? api.listForeignKeys(props.connection.id, props.database, row.schema || selectedSchema.value || "", row.name, props.catalog).catch(() => [] as ForeignKeyInfo[]) : Promise.resolve([] as ForeignKeyInfo[]))));

  const tablesWithFk: TableWithFk[] = rows.map((row, i) => ({
    name: row.name,
    schema: row.schema || selectedSchema.value,
    foreignKeys: fkResults[i] ?? [],
  }));

  const sorted = sortTablesByFkDependency(tablesWithFk);
  const nameToRow = new Map(rows.map((r) => [r.name, r]));
  return sorted.map((t) => nameToRow.get(t.name)!).filter(Boolean);
}

interface BrowserTriggerDropPreview {
  plan: OracleTriggerDropBatchPlan;
  rows: readonly ObjectBrowserRow[];
  context: string;
  pinnedContext: ReturnType<typeof objectBrowserPinnedTreeNodeContext>;
  isCurrent: () => boolean;
}
let batchTriggerDropPreviewRequestId = 0;

function usesExactTriggerDrop(row: ObjectBrowserRow): boolean {
  return row.type === "TRIGGER" && (!!exactOracleTriggerMetadata(row.trigger) || !!oracleTriggerObjectReadOptions(props.connection, undefined, props.catalog));
}

async function prepareBrowserTriggerDrops(selected: readonly ObjectBrowserRow[], batch: boolean): Promise<BrowserTriggerDropPreview> {
  const context = browserTriggerContext(),
    revision = browserTriggerViewRevision.value;
  const selection = [...selectedTableIds.value].sort().join("\n");
  const pinnedContext = { ...objectBrowserPinnedTreeNodeContext() };
  const fixed = { connectionId: props.connection.id, database: props.database, catalog: props.catalog, executionSchema: selectedSchema.value || props.schema || props.database };
  const expected = selected.map((row) => ({ id: row.id, objectId: exactOracleTriggerMetadata(row.trigger)?.objectId }));
  const cascade = batch && canBatchDropCascade.value && batchDropCascade.value;
  const current = () =>
    browserTriggerActive.value &&
    browserTriggerViewRevision.value === revision &&
    browserTriggerContext() === context &&
    (batch ? showBatchDropConfirm.value && [...selectedTableIds.value].sort().join("\n") === selection && (canBatchDropCascade.value && batchDropCascade.value) === cascade : showDropConfirm.value && dropTarget.value?.id === selected[0]?.id) &&
    expected.every((item) => rows.value.some((row) => row.id === item.id && (item.objectId === undefined || exactOracleTriggerMetadata(row.trigger)?.objectId === item.objectId)));
  // Verify triggers before dropping a selected parent. The existing FK sorter
  // still orders tables, with exact tuple keys instead of collapsing bare names.
  const tables = selected.filter((row) => row.type === "TABLE");
  const key = (schema: string | undefined | null, name: string) => JSON.stringify([schema ?? fixed.executionSchema, name]);
  const tableIds = new Map(tables.map((row) => [key(row.schema, row.name), row.id]));
  const foreignKeys = await Promise.all(tables.map((row) => api.listForeignKeys(fixed.connectionId, fixed.database, row.schema || fixed.executionSchema, row.name, fixed.catalog).catch(() => [] as ForeignKeyInfo[])));
  const sortedTables = sortTablesByFkDependency(tables.map((row, index) => ({ name: row.id, foreignKeys: foreignKeys[index].map((fk) => ({ ...fk, ref_table: tableIds.get(key(fk.ref_schema ?? row.schema, fk.ref_table)) ?? "" })) })));
  const ordered = [...selected.filter((row) => usesExactTriggerDrop(row)), ...sortedTables.map((table) => tables.find((row) => row.id === table.name)!), ...selected.filter((row) => row.type !== "TABLE" && !usesExactTriggerDrop(row))];
  const entries = [];
  let engine: OracleTriggerDropBatchPlan["engine"] | undefined;
  for (const row of ordered) {
    if (!current()) throw new Error(t("oracleTrigger.reloadBaseline"));
    if (usesExactTriggerDrop(row)) {
      const target = triggerRowTarget(row);
      const metadata = exactOracleTriggerMetadata(row.trigger)!;
      const triggerPlan = await prepareOracleTriggerPlan({ target, action: "delete", expectedObjectId: typeof metadata.objectId === "string" ? metadata.objectId : undefined });
      engine = triggerPlan.before.metadata.engine;
      entries.push({ id: row.id, sql: triggerPlan.steps[0].sql, triggerPlan });
    } else entries.push({ id: row.id, sql: await buildDropSqlForRow(row, { cascade }) });
  }
  if (!current() || !engine) throw new Error(t("oracleTrigger.reloadBaseline"));
  return { plan: prepareOracleTriggerDropBatchPlan({ target: fixed, entries, engine }), rows: ordered, context, pinnedContext, isCurrent: current };
}

function removeVerifiedBrowserDrop(row: ObjectBrowserRow, target: Pick<OracleTriggerTarget, "connectionId" | "database" | "catalog">, pinnedContext: ReturnType<typeof objectBrowserPinnedTreeNodeContext>) {
  const identity = objectBrowserRowPinnedTreeNodeIdentity(row, pinnedContext);
  const base = { ...identity, label: identity.name, objectName: identity.name, signature: identity.signature || undefined, schema: identity.schema || undefined, catalog: identity.catalog || undefined };
  connectionStore.removePinnedTreeNodes([base, ...objectBrowserRowLegacyPinnedTreeNodeIds(row, pinnedContext).map((id) => ({ ...base, id }))], exactOracleTriggerMetadata(row.trigger) ? undefined : canonicalizeObjectBrowserPinnedTreeNodeIdentity(pinnedContext));
  if (props.connection.id === target.connectionId && props.database === target.database && props.catalog === target.catalog) {
    const objectId = exactOracleTriggerMetadata(row.trigger)?.objectId;
    rows.value = rows.value.filter((item) => item.id !== row.id || (objectId !== undefined && exactOracleTriggerMetadata(item.trigger)?.objectId !== objectId));
    setSelectedTableIds(new Set([...selectedTableIds.value].filter((id) => rows.value.some((item) => item.id === id))));
  }
  const objectType = droppedTableObjectTypeForRow(row);
  if (objectType) queryStore.closeDroppedTableObjectTabs({ connectionId: target.connectionId, database: target.database, schema: row.schema ?? pinnedContext.schema, name: row.name, objectType });
  invalidateObjectBrowserRowsCache({ connectionId: target.connectionId, database: target.database });
}

async function executeBrowserTriggerDrops(preview: BrowserTriggerDropPreview, batch: boolean) {
  if (browserTriggerBusy.value || !preview.isCurrent()) return;
  const scope = `oracle-trigger-drop:${uuid()}`;
  const production = useProductionSafetyStore();
  const stop = watch(
    preview.isCurrent,
    (current) => {
      if (!current) production.cancelScope(scope);
    },
    { flush: "sync" },
  );
  browserTriggerBusy.value = true;
  batchDropExecuting.value = batch;
  batchDropProgress.value = { completed: 0, total: preview.rows.length };
  try {
    const result = await executeOracleTriggerDropBatchPlan(preview.plan, {
      confirmed: true,
      confirmationScope: scope,
      isCurrent: preview.isCurrent,
      onProgress: (completed) => {
        batchDropProgress.value = { completed, total: preview.rows.length };
      },
    });
    let completed = 0;
    const details: string[] = [];
    for (const [index, step] of result.steps.entries()) {
      const row = preview.rows[index];
      details.push(`${row.schema ?? preview.plan.target.executionSchema}.${row.name}\n${t(`oceanbasePrimaryKey.${step.state}`)}\n${step.sql}\n${step.error ?? ""}`);
      if (step.state === "committed" && (!step.trigger || step.trigger.verification === "deleted")) {
        removeVerifiedBrowserDrop(row, preview.plan.target, preview.pinnedContext);
        completed++;
        if (!step.trigger) {
          const request = { connectionId: preview.plan.target.connectionId, database: preview.plan.target.database, catalog: preview.plan.target.catalog, schema: row.schema ?? preview.plan.target.executionSchema, tableName: row.name };
          const refreshed = await Promise.allSettled([invalidateObjectMetadataCache(request), invalidateObjectDdl(request)]);
          details.push(...refreshed.flatMap((item) => (item.status === "rejected" ? [String(item.reason)] : [])));
        }
      }
    }
    const failed = result.triggerResults.find((item) => item.result.steps.some((step) => step.state !== "committed"));
    if (failed) {
      const index = preview.plan.entries.findIndex((entry) => entry.id === failed.draftId);
      const target = preview.plan.entries[index].triggerPlan!.target;
      browserTriggerFeedback.value = { target, row: preview.rows[index], result: failed.result, snapshot: failed.result.snapshot, pinnedContext: preview.pinnedContext };
    } else browserTriggerFeedback.value = undefined;
    if (completed === preview.rows.length && !result.triggerResults.some((item) => item.result.refreshError)) toast(batch ? t("contextMenu.batchDropSuccess", { count: completed }) : t("contextMenu.dropTableChildObjectSuccess", { name: preview.rows[0].name }));
    else if (!result.cancelled && browserTriggerActive.value && browserTriggerContext() === preview.context) {
      compileErrorTitle.value = t("oracleStructureResult.resultTitle");
      compileErrorMessage.value = [...details, ...result.triggerResults.map((item) => item.result.refreshError)].filter(Boolean).join("\n\n");
      showCompileErrorDialog.value = true;
    }
  } catch (error) {
    if (browserTriggerActive.value && browserTriggerContext() === preview.context) {
      browserTriggerFeedback.value = undefined;
      compileErrorTitle.value = t("oracleStructureResult.resultTitle");
      compileErrorMessage.value = error instanceof Error ? error.message : String(error);
      showCompileErrorDialog.value = true;
    }
  } finally {
    stop();
    production.cancelScope(scope);
    browserTriggerBusy.value = false;
    batchDropExecuting.value = false;
    if (batch) showBatchDropConfirm.value = false;
    else showDropConfirm.value = false;
  }
}

async function refreshBatchDropPreviewSql() {
  if (batchTriggerDropRequested.value) {
    const requestId = ++batchTriggerDropPreviewRequestId;
    batchTriggerDropPreview.value = undefined;
    batchDropPreviewSql.value = "";
    batchDropPreviewError.value = "";
    try {
      const prepared = await prepareBrowserTriggerDrops([...selectedTableRows.value], true);
      if (requestId !== batchTriggerDropPreviewRequestId || !prepared.isCurrent()) return;
      batchTriggerDropPreview.value = prepared;
      batchDropPreviewSql.value = prepared.plan.entries.map((entry) => entry.sql).join("\n\n");
    } catch (error) {
      if (requestId === batchTriggerDropPreviewRequestId) batchDropPreviewError.value = error instanceof Error ? error.message : String(error);
    }
    return;
  }
  const statements: string[] = [];
  const sortedRows = await fetchSortedTableRowsForDrop();
  const useCascade = canBatchDropCascade.value && batchDropCascade.value;
  for (const row of sortedRows) {
    const sql = await buildDropSqlForRow(row, { cascade: useCascade }).catch(() => "");
    if (sql) statements.push(sql);
  }
  batchDropPreviewSql.value = statements.join("\n");
}

function requestBatchDropTables() {
  if (selectedTableCount.value === 0) return;
  if (browserTriggerBusy.value) return;
  batchTriggerDropRequested.value = selectedTableRows.value.some(usesExactTriggerDrop);
  batchTriggerDropPreview.value = undefined;
  batchDropPreviewError.value = "";
  if (selectedTableRows.value.some((row) => row.type === "INDEX")) {
    toast(t("schemaIndex.editIndividually"), 4000);
    return;
  }
  const selected = [...selectedTableRows.value];
  const managed = selected.filter((row) => isOracleFamilyTypeSource(effectiveDatabaseType.value, row.type));
  if (managed.length) {
    void (async () => {
      const unique = managed.filter((row) => row.type !== "TYPE_BODY" || !managed.some((other) => other.type === "TYPE" && other.name === row.name && other.schema === row.schema));
      for (const row of unique) if (!(await manageTypeDrop(row))) return;
      const remaining = selected.filter((row) => !managed.includes(row));
      selectedTableIds.value = new Set(remaining.map((row) => row.id));
      if (remaining.length) requestBatchDropTables();
    })();
    return;
  }
  batchDropCascade.value = false;
  batchDropProgress.value = { completed: 0, total: 0 };
  batchDropPreviewSql.value = "";
  showBatchDropConfirm.value = true;
  void refreshBatchDropPreviewSql();
}

async function confirmBatchDropTables() {
  if (batchDropExecuting.value) return;
  if (selectedTableRows.value.some((row) => row.type === "INDEX")) return;
  if (batchTriggerDropRequested.value) {
    if (batchTriggerDropPreview.value) await executeBrowserTriggerDrops(batchTriggerDropPreview.value, true);
    return;
  }
  batchDropExecuting.value = true;
  let batchSql = "";
  let batchDropRecorded = false;
  let targets: ObjectBrowserRow[] = [];
  const start = Date.now();
  try {
    targets = await fetchSortedTableRowsForDrop();
    if (targets.length === 0) return;
    batchDropProgress.value = { completed: 0, total: targets.length };
    const useCascade = canBatchDropCascade.value && batchDropCascade.value;
    const plan = await Promise.all(
      targets.map(async (target) => ({
        target,
        sql: await buildDropSqlForRow(target, { cascade: useCascade }),
      })),
    );
    batchSql = plan.map(({ sql }) => sql).join(";\n");
    const result = await executeObjectBrowserSqlWithProductionGuard(batchSql, () =>
      runBatchTableDrop({
        databaseType: effectiveDatabaseType.value,
        plan,
        executeStatement: (sql) => api.executeQuery(props.connection.id, props.database, sql),
        executeBatch: (sql, onProgress) => api.executeMultiWithProgress(props.connection.id, props.database, sql, onProgress),
        onProgress: (progress) => {
          batchDropProgress.value = { completed: Math.min(progress.completed, targets.length), total: targets.length };
        },
      }),
    );
    if (!result) return;

    batchDropRecorded = true;
    await recordTableMutationHistory(getTableMutationHistoryStoreOrNull(), {
      connectionId: props.connection.id,
      connectionName: props.connection.name,
      database: props.database,
      sql: batchSql,
      elapsedMs: Date.now() - start,
      success: !result.failed,
      error: result.failed ? String(result.failed.message || result.failed) : undefined,
      target: targets.map((t) => t.name).join(", "),
    }).catch((err) => console.warn("[DBX] failed to record batch drop history", err));

    for (const row of result.succeeded) closeDroppedTableObjectTabsForRow(row);
    if (result.succeeded.length > 0) {
      removePinnedObjectBrowserRows(result.succeeded);
      await reload();
      await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, selectedSchema.value);
    }

    if (result.failed) throw result.failed;
    toast(hasSelectedTablesOnly.value ? t("objects.batchDropSuccess", { count: result.succeeded.length }) : t("contextMenu.batchDropSuccess", { count: result.succeeded.length }));
  } catch (e: any) {
    if (!batchDropRecorded && batchSql) {
      await recordTableMutationHistory(getTableMutationHistoryStoreOrNull(), {
        connectionId: props.connection.id,
        connectionName: props.connection.name,
        database: props.database,
        sql: batchSql,
        elapsedMs: Date.now() - start,
        success: false,
        error: e?.message || String(e),
        target: targets.map((t) => t.name).join(", "),
      }).catch((err) => console.warn("[DBX] failed to record batch drop history", err));
    }
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    batchDropExecuting.value = false;
    batchDropProgress.value = { completed: 0, total: 0 };
    showBatchDropConfirm.value = false;
  }
}

async function refreshBatchTruncatePreviewSql() {
  const statements: string[] = [];
  const useCascade = canBatchTruncateCascade.value && batchTruncateCascade.value;
  for (const row of selectedTableRows.value) {
    const sql = await buildTruncateTableSql(tableAdminSqlOptions(row, { cascade: useCascade })).catch(() => "");
    if (sql) statements.push(sql);
  }
  batchTruncatePreviewSql.value = statements.join("\n");
}

function requestBatchTruncateTables() {
  if (selectedTableCount.value === 0 || !supportsTruncateTable.value) return;
  batchTruncateCascade.value = false;
  batchTruncatePreviewSql.value = "";
  void refreshBatchTruncatePreviewSql();
  showBatchTruncateConfirm.value = true;
}

function tableDataRefreshTargetForRow(row: ObjectBrowserRow) {
  return {
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
    schemaCandidates: [row.schema, selectedSchema.value],
    catalog: props.catalog,
    name: row.name,
  };
}

async function refreshMutatedTableDataTabsForRows(rows: readonly ObjectBrowserRow[]) {
  for (const row of rows) {
    const target = tableDataRefreshTargetForRow(row);
    try {
      await queryStore.refreshDataTabsForTable(target);
    } catch (error) {
      console.warn("[DBX][table-data-refresh-after-mutation:error]", { target, error });
    }
  }
}

async function confirmBatchTruncateTables() {
  const targets = [...selectedTableRows.value];
  if (targets.length === 0) return;
  let batchSql = "";
  const start = Date.now();
  let successRecorded = false;
  try {
    const useCascade = canBatchTruncateCascade.value && batchTruncateCascade.value;
    const statements = await Promise.all(
      targets.map(async (row) => ({
        row,
        sql: await buildTruncateTableSql(tableAdminSqlOptions(row, { cascade: useCascade })),
      })),
    );
    batchSql = statements.map(({ sql }) => sql).join(";\n");
    const executed = await executeObjectBrowserSqlWithProductionGuard(batchSql, async () => {
      await runBatchTableTruncate(
        statements,
        async ({ sql }) => {
          await api.executeQuery(props.connection.id, props.database, sql);
        },
        async (succeeded) => refreshMutatedTableDataTabsForRows(succeeded.map(({ row }) => row)),
      );
      return true;
    });
    if (!executed) return;
    await recordTableMutationHistory(getTableMutationHistoryStoreOrNull(), {
      connectionId: props.connection.id,
      connectionName: props.connection.name,
      database: props.database,
      sql: batchSql,
      elapsedMs: Date.now() - start,
      success: true,
      target: targets.map((t) => t.name).join(", "),
    }).catch((err) => console.warn("[DBX] failed to record batch truncate history", err));
    successRecorded = true;
    toast(t("objects.batchTruncateSuccess", { count: targets.length }));
    clearTableSelection();
    showBatchTruncateConfirm.value = false;
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, selectedSchema.value);
  } catch (e: any) {
    if (batchSql && !successRecorded) {
      await recordTableMutationHistory(getTableMutationHistoryStoreOrNull(), {
        connectionId: props.connection.id,
        connectionName: props.connection.name,
        database: props.database,
        sql: batchSql,
        elapsedMs: Date.now() - start,
        success: false,
        error: e?.message || String(e),
        target: targets.map((t) => t.name).join(", "),
      }).catch((err) => console.warn("[DBX] failed to record batch truncate history", err));
    }
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function refreshBatchEmptyPreviewSql(targets: ObjectBrowserRow[]) {
  const plan = await buildBatchTableEmptyPlan(targets, (row) => buildEmptyTableSql(tableAdminSqlOptions(row)));
  // Freeze the reviewed SQL with its target so confirmation cannot execute a different destructive statement.
  batchEmptyPlan.value = plan;
  batchEmptyPreviewSql.value = plan.map(({ sql }) => sql).join("\n");
}

function requestBatchEmptyTables() {
  const targets = [...selectedTableRows.value];
  if (targets.length === 0) return;
  batchEmptyPlan.value = [];
  batchEmptyPreviewSql.value = "";
  void refreshBatchEmptyPreviewSql(targets)
    .then(() => {
      showBatchEmptyConfirm.value = true;
    })
    .catch((e: any) => {
      batchEmptyPlan.value = [];
      toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
    });
}

async function confirmBatchEmptyTables() {
  const plan = batchEmptyPlan.value.slice();
  if (plan.length === 0) return;
  const start = Date.now();
  const asynchronousMutation = effectiveDatabaseType.value === "clickhouse";
  const reviewSql = plan.map(({ sql }) => sql).join(";\n");
  const result = await executeObjectBrowserSqlWithProductionGuard(reviewSql, () => {
    return runBatchTableEmpty(plan, async ({ sql }) => {
      await api.executeQuery(props.connection.id, props.database, sql);
    });
  });
  if (!result) return;
  await recordTableMutationHistory(getTableMutationHistoryStoreOrNull(), {
    connectionId: props.connection.id,
    connectionName: props.connection.name,
    database: props.database,
    sql: reviewSql,
    elapsedMs: Date.now() - start,
    success: result.failed.length === 0,
    error: result.failed.length > 0 ? result.failed.map((f) => `${f.target.target.name}: ${f.error}`).join("; ") : undefined,
    target: plan.map((p) => p.target.name).join(", "),
  }).catch((err) => console.warn("[DBX] failed to record batch empty history", err));
  for (const failure of result.failed) {
    console.error(`Failed to empty table "${failure.target.target.name}":`, failure.error);
  }
  const feedback = batchTableEmptyFeedback(result, asynchronousMutation);
  if (feedback === "success") {
    toast(t("contextMenu.batchEmptySuccess", { count: result.succeeded.length }), 3000);
  } else if (feedback === "submitted") {
    toast(t("contextMenu.batchEmptySubmitted", { count: result.succeeded.length }), 3000);
  } else if (feedback === "submitted-partial") {
    toast(t("contextMenu.batchEmptySubmittedPartial", { success: result.succeeded.length, failed: result.failed.length }), 5000);
  } else {
    toast(t("contextMenu.batchEmptyPartialFail", { success: result.succeeded.length, failed: result.failed.length }), 5000);
  }
  batchEmptyPlan.value = [];
  showBatchEmptyConfirm.value = false;
  if (result.succeeded.length > 0) {
    clearTableSelection();
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, selectedSchema.value);
  }
}

async function exportStructure(row: ObjectBrowserRow) {
  try {
    const schema = row.schema || selectedSchema.value || props.database;
    const indexOptions: [boolean?, boolean?, string?] =
      (effectiveDatabaseType.value === "oracle" || effectiveDatabaseType.value === "oceanbase-oracle") && row.type === "TABLE" && settingsStore.editorSettings.separateDdlIndexes ? [undefined, true, row.schema || selectedSchema.value || undefined] : [];
    const ddl = await api.getTableDdl(props.connection.id, props.database, schema, row.name, tableDdlObjectType(row.type), props.catalog, true, ...indexOptions);
    await saveFileContent(buildSingleDdlExportFileContent(applyDdlTextPreferences(ddl, effectiveDatabaseType.value, settingsStore.editorSettings)), `${row.name}.sql`, "SQL", "sql");
  } catch (e: any) {
    console.error("Export structure failed:", e);
  }
}

function tableDdlObjectType(type: ObjectBrowserRow["type"]): ObjectSourceKind | undefined {
  if (type === "VIEW" || type === "MATERIALIZED_VIEW") return type;
  return undefined;
}

async function exportDataLegacy(row: ObjectBrowserRow, format: "json") {
  const { connection, database, catalog } = props;
  const { id: connectionId, db_type: databaseType, query_timeout_secs: timeoutSecs } = connection;
  const exportDatabaseType = effectiveDatabaseType.value;
  try {
    const schema = row.schema || selectedSchema.value;
    const queryColumns = databaseType === "neo4j" ? (await api.getColumns(connectionId, database, schema || database, row.name, catalog)).map((column) => column.name) : undefined;
    const useAgentCursor = databaseType === "cassandra";
    const clientSessionId = useAgentCursor ? `table-export:${generateDatabaseExportId()}` : undefined;
    const result = await fetchTableDataForExport({
      databaseType: exportDatabaseType,
      identifierQuote: connectionStore.connectionIdentifierQuote?.(connectionId),
      schema,
      tableName: row.name,
      columns: queryColumns,
      useAgentCursor,
      executePage: (sql, cursorOptions) => (cursorOptions ? api.executeQuery(connectionId, database, sql, undefined, undefined, { ...cursorOptions, clientSessionId, catalog, timeoutSecs }) : api.executeQuery(connectionId, database, sql)),
      closeCursor: useAgentCursor
        ? async (sessionId) => {
            try {
              if (sessionId) await api.closeQuerySession(connectionId, database, sessionId, clientSessionId, catalog);
            } finally {
              await api.closeClientConnectionSession(connectionId, database, clientSessionId!, catalog);
            }
          }
        : undefined,
    });

    if (format === "json") {
      let outputPath = `${row.name}.json`;
      if (isTauriRuntime()) {
        const path = await promptExportSavePath({
          defaultFileName: outputPath,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!path) return;
        outputPath = path;
      }
      await api.exportQueryResultJson(outputPath, result.columns, result.rows);
      toast(t("grid.exported"));
      void autoRevealExportedPathIfConfigured(outputPath);
    }
  } catch (e: any) {
    toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function exportData(row: ObjectBrowserRow, format: "csv" | "json" | "sql", insertDialect: SqlInsertDialect = "source") {
  if (format === "sql" && mysqlDataCharsetEnabled(props.connection)) {
    toast(t("connection.mysqlDataCharsetExportHint"), 5000);
    return;
  }
  if (format === "json" && !isTauriRuntime()) {
    await exportDataLegacy(row, format);
    return;
  }
  const captured = captureTableDataExport(row);
  const sqlExportOptions = format === "sql" ? await showSqlInsertModeDialog({ allowSplit: true, showExecutionMode: isTauriRuntime() }) : undefined;
  if (format === "sql" && sqlExportOptions === null) return;
  await exportTableData(row, format, undefined, "name", true, sqlExportOptions?.insertMode ?? "batch", sqlExportOptions?.splitMaxMb, insertDialect, captured, sqlExportOptions?.executionMode);
}

function showObjectBrowserXlsxHeaderDialog(hasComments: boolean): Promise<XlsxExportOptions | null> {
  if (typeof document === "undefined") return Promise.resolve({ headerMode: "name", autoFilter: false });

  return new Promise((resolve) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(XlsxHeaderDialog, {
      open: true,
      showHeaderOptions: hasComments,
      showExecutionMode: isTauriRuntime(),
      onConfirm: (exportOptions: XlsxExportOptions) => {
        resolve(exportOptions);
        app.unmount();
        document.body.removeChild(container);
      },
      onCancel: () => {
        resolve(null);
        app.unmount();
        document.body.removeChild(container);
      },
    });
    app.use(i18n);
    app.mount(container);
  });
}

async function exportDataXlsx(row: ObjectBrowserRow) {
  const captured = captureTableDataExport(row);
  const { connectionId, database, schema, catalog } = captured;
  let columnInfos: ColumnInfo[] | undefined;

  try {
    columnInfos = await api.getColumns(connectionId, database, schema || database, captured.tableName, catalog);
  } catch {
    // Export still works with field-name headers when column metadata is unavailable.
  }

  const exportOptions = await showObjectBrowserXlsxHeaderDialog(hasXlsxHeaderComments(columnInfos?.map((column) => column.comment)));
  if (exportOptions === null) return;
  await exportTableData(row, "xlsx", columnInfos, exportOptions.headerMode, exportOptions.autoFilter, "batch", undefined, "source", captured, exportOptions.executionMode);
}

function captureTableDataExport(row: ObjectBrowserRow) {
  return {
    connectionId: props.connection.id,
    fingerprint: connectionConfigFingerprint(props.connection),
    connectionType: props.connection.db_type,
    timeoutSecs: props.connection.query_timeout_secs,
    database: props.database,
    catalog: props.catalog,
    schema: row.schema || selectedSchema.value,
    tableName: row.name,
    databaseType: effectiveDatabaseType.value,
    identifierQuote: connectionStore.connectionIdentifierQuote(props.connection.id),
    settings: { ...settingsStore.editorSettings },
  };
}

async function exportTableData(
  row: ObjectBrowserRow,
  format: "csv" | "xlsx" | "sql" | "json",
  columnInfos?: ColumnInfo[],
  headerMode: XlsxHeaderMode = "name",
  autoFilter = true,
  insertMode: SqlInsertMode = "batch",
  splitMaxMb?: number,
  insertDialect: SqlInsertDialect = "source",
  captured = captureTableDataExport(row),
  selectedMode?: ManualExportMode,
) {
  const { connectionId, database, schema, catalog, tableName, identifierQuote, databaseType, settings } = captured;
  columnInfos = columnInfos?.map((column) => ({ ...column }));
  const native = isTauriRuntime();
  const mode = native ? (selectedMode ?? (await showExportExecutionModeDialog())) : "immediate";
  if (mode === null) return;
  const splitSqlOutput = format === "sql" && splitMaxMb !== undefined;

  // Save dialog first
  let filePath = "";
  const defaultName = `${tableName}.${splitSqlOutput ? "zip" : format}`;

  if (isTauriRuntime()) {
    try {
      const filter = format === "csv" ? { name: "CSV", extensions: ["csv"] } : format === "xlsx" ? { name: "Excel", extensions: ["xlsx"] } : format === "json" ? { name: "JSON", extensions: ["json"] } : splitSqlOutput ? { name: "ZIP", extensions: ["zip"] } : { name: "SQL", extensions: ["sql"] };
      const path = await promptExportSavePath({
        defaultFileName: defaultName,
        filters: [filter],
      });
      if (!path) return;
      filePath = path as string;
    } catch (e: any) {
      toast(e?.message || String(e), 5000);
      return;
    }
  } else {
    const webExportId = generateDatabaseExportId();
    filePath = `__web_export_${webExportId}.${splitSqlOutput ? "zip" : format}`;
  }

  if (native && (props.connection.id !== connectionId || props.database !== database || props.catalog !== catalog || (row.schema || selectedSchema.value) !== schema || row.name !== tableName || connectionConfigFingerprint(props.connection) !== captured.fingerprint)) {
    toast(t("exportProgress.connectionChanged"), 5000);
    return;
  }
  let task: ExportTask | null = native ? addExportTask(tableName, format, filePath) : null;
  const controller = new AbortController();
  let backendStarted = false;
  let unknown = false;
  let unknownMessage: string | undefined;
  let terminal: api.TableExportProgress | undefined;
  const check = () => {
    if (!native) return;
    if (unknown) throw new SnapshotCompletionError("unknown", unknownMessage ?? "Export completion was not confirmed");
    if (controller.signal.aborted) throw new SnapshotCompletionError("cancelled", "Export cancelled");
    const config = connectionStore.getConfig(connectionId);
    if (!config || connectionConfigFingerprint(config) !== captured.fingerprint) throw new SnapshotCompletionError("failed", t("exportProgress.connectionChanged"));
  };
  const read = async <T>(request: () => Promise<T>, cleanup = false): Promise<T> => {
    if (!cleanup) check();
    let value: T;
    try {
      value = await request();
    } catch (error) {
      if (!native) throw error;
      unknown = true;
      unknownMessage ??= error instanceof Error ? error.message : String(error);
      throw new SnapshotCompletionError("unknown", unknownMessage);
    }
    if (!cleanup && task?.canCancel !== false) check();
    return value;
  };
  const execute = async (): Promise<"settled" | "unknown"> => {
    if (native && task)
      exportTracker.registerTaskCancelHandler(task.exportId, async () => {
        controller.abort();
        task!.status = "Cancelling";
        if (backendStarted) await api.cancelTableExport(task!.exportId);
      });
    try {
      check();
      if (databaseType === "victoriametrics" || format === "json") {
        const queryColumns = captured.connectionType === "neo4j" ? (await read(() => api.getColumns(connectionId, database, schema || database, tableName, catalog))).map((column) => column.name) : undefined;
        const useAgentCursor = captured.connectionType === "cassandra";
        const clientSessionId = useAgentCursor ? `table-export:${generateDatabaseExportId()}` : undefined;
        const result = await fetchTableDataForExport({
          databaseType,
          identifierQuote,
          schema,
          tableName,
          columns: queryColumns,
          useAgentCursor,
          executePage: async (sql, cursorOptions) => {
            const result = await read(() => (cursorOptions ? api.executeQuery(connectionId, database, sql, undefined, undefined, { ...cursorOptions, clientSessionId, catalog, timeoutSecs: captured.timeoutSecs }) : api.executeQuery(connectionId, database, sql)));
            if (native && result.execution_error) throw new SnapshotCompletionError(result.error?.operationOutcome === "not_started" ? "failed" : "unknown", translateBackendError(t, result.error ?? String(result.rows[0]?.[0] ?? "Query failed")));
            if (native && (result.truncated || result.large_value_cells?.length)) throw new SnapshotCompletionError("failed", "Incomplete table export result");
            return result;
          },
          closeCursor: useAgentCursor
            ? async (sessionId) => {
                try {
                  if (sessionId) await read(() => api.closeQuerySession(connectionId, database, sessionId, clientSessionId, catalog), true);
                } finally {
                  await read(() => (native ? api.closeClientConnectionSession(connectionId, database, clientSessionId!, catalog, true) : api.closeClientConnectionSession(connectionId, database, clientSessionId!, catalog)), true);
                }
              }
            : undefined,
        });
        check();
        if (native && task) task.canCancel = false;
        if (format === "json") await read(() => api.exportQueryResultJson(filePath, result.columns, result.rows));
        else if (format === "csv") {
          await read(() => api.exportQueryResultCsv(filePath, result.columns, result.rows, settings.csvQuoteMode, csvNullLiteralForMode(settings.csvNullMode)));
        } else {
          const comments = result.columns.map((name) => columnInfos?.find((column) => column.name.toLocaleLowerCase() === name.toLocaleLowerCase())?.comment);
          const headerOverrides = buildXlsxHeaderOverrides(result.columns, comments, headerMode);
          await read(() => api.exportQueryResultXlsx(filePath, tableName, result.columns, result.column_types ?? result.columns.map(() => ""), headerOverrides, result.rows, undefined, autoFilter, settings.globalDateTimeExportFormat || undefined, xlsxHeaderUsesCommentRows(headerMode)));
        }
        if (task) {
          task.status = "Done";
          task.rowsExported = result.rows.length;
          task.totalRows = result.rows.length;
          task.finishedAt = Date.now();
        }
        toast(t("grid.exported"));
        void autoRevealExportedPathIfConfigured(filePath);
        return "settled";
      }
      let columns: string[] | undefined;
      let columnComments: (string | null)[] | undefined;

      if (columnInfos) {
        columns = columnInfos.map((c) => c.name);
        if (format === "xlsx") {
          columnComments = buildXlsxHeaderOverrides(
            columns,
            columnInfos.map((column) => column.comment),
            headerMode,
          );
        }
      } else if (captured.connectionType === "neo4j") {
        const infos = await read(() => api.getColumns(connectionId, database, schema || database, tableName, catalog));
        columns = infos.map((c) => c.name);
      }

      task ??= addExportTask(tableName, format, filePath);
      const currentTask = task;
      const rowLimit = settings.exportRowLimitEnabled ? settings.exportRowLimit : null;
      const request: api.TableExportRequest = {
        exportId: currentTask.exportId,
        connectionId,
        database,
        schema,
        identifierQuote,
        tableName,
        filePath,
        format,
        ...(format === "sql"
          ? {
              insertMode,
              insertDialect,
              splitMaxMb,
              omitDatabaseQualifier: dropsSchemaQualifier(databaseType, settings.generateSqlIncludeDatabaseName, catalog),
            }
          : {}),
        csvQuoteMode: settings.csvQuoteMode,
        nullLiteral: csvNullLiteralForMode(settings.csvNullMode),
        columns,
        columnComments: format === "xlsx" ? columnComments : undefined,
        headerCommentRows: format === "xlsx" ? xlsxHeaderUsesCommentRows(headerMode) : undefined,
        autoFilter: format === "xlsx" ? autoFilter : undefined,
        batchSize: settings.exportBatchSize,
        skipCount: format === "sql",
        rowLimit,
      };

      check();
      backendStarted = true;
      const onProgress = (progress: api.TableExportProgress) => {
        if (progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled") terminal = progress;
        updateTableExportTask(currentTask.exportId, progress);
      };
      const terminalProgress = await (native ? api.startTableExport(request, onProgress, true) : api.startTableExport(request, onProgress));
      if (native && terminalProgress.status !== "Done" && terminalProgress.status !== "Error" && terminalProgress.status !== "Cancelled") throw new SnapshotCompletionError("unknown", "Export completion was not confirmed");
      updateTableExportTask(currentTask.exportId, terminalProgress);
      if (terminalProgress.status === "Done") {
        toast(t("grid.exported"));
      }
      return "settled";
    } catch (e: any) {
      if (native && terminal?.status === "Done" && task) {
        updateTableExportTask(task.exportId, terminal);
        return "settled";
      }
      unknown ||= native && ((backendStarted && !terminal && !(e instanceof SnapshotCompletionError && e.status === "failed")) || (e instanceof SnapshotCompletionError && e.status === "unknown"));
      if (task) {
        task.status = unknown ? "Unknown" : native && (terminal?.status === "Cancelled" || (e instanceof SnapshotCompletionError && e.status === "cancelled")) ? "Cancelled" : "Error";
        task.errorMessage = e?.message || String(e);
        task.finishedAt = unknown ? undefined : Date.now();
      }
      toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      return unknown ? "unknown" : "settled";
    } finally {
      if (native && task) {
        task.canCancel = false;
        if (!unknown) exportTracker.unregisterTaskCancelHandler(task.exportId);
      }
    }
  };
  if (!native) {
    await execute();
    return;
  }
  let completion: Promise<"settled" | "unknown"> | undefined;
  exportTracker.submitExportTask(task!, mode, () => (completion = execute()));
  if (mode === "immediate") await completion;
}

function requestCopyAsNewTable(row: ObjectBrowserRow) {
  pasteTableFromClipboard.value = false;
  pasteTableMode.value = defaultPasteTableMode(effectiveDatabaseType.value);
  pasteTableEntries.value = [
    {
      sourceName: row.name,
      targetName: `${row.name}_copy`,
      schema: normalizeObjectBrowserTableClipboardSchema(row.schema || selectedSchema.value),
      tableComment: row.comment,
    },
  ];
  showPasteDialog.value = true;
}

function captureTableCopyContext() {
  return {
    connection: { ...props.connection },
    database: props.database,
    catalog: props.catalog,
    schema: selectedSchema.value,
    databaseType: effectiveDatabaseType.value,
    identifierQuote: connectionStore.connectionIdentifierQuote?.(props.connection.id),
  };
}

type TableCopyContext = ReturnType<typeof captureTableCopyContext>;

function reloadTableCopyContext(context: TableCopyContext) {
  if (props.connection.id === context.connection.id && props.database === context.database && props.catalog === context.catalog && selectedSchema.value === context.schema) return reload();
  return Promise.resolve();
}

async function buildDuplicateStructurePlan(context: TableCopyContext, sourceName: string, targetName: string, schema: string | undefined, tableComment?: string | null, sourceColumns?: ColumnInfo[]) {
  return buildSharedDuplicateTableStructurePlan({
    connectionId: context.connection.id,
    database: context.database,
    catalog: context.catalog,
    databaseType: context.databaseType,
    schema,
    sourceName,
    targetName,
    tableComment,
    sourceColumns,
    identifierQuote: context.identifierQuote,
  });
}

function executeDuplicateStructurePlan(context: TableCopyContext, plan: DuplicateTableStructurePlan, schema: string | undefined) {
  if (plan.oceanbaseClone) return executeOceanbaseTableClone(plan.oceanbaseClone, (sql) => api.executeQuery(context.connection.id, context.database, sql, plan.oceanbaseClone!.targetSchema));
  return plan.executeAsScript ? api.executeScript(context.connection.id, context.database, plan.sql, schema) : api.executeQuery(context.connection.id, context.database, plan.sql, schema);
}

async function confirmDuplicateStructure() {
  return effectiveDatabaseType.value === "oceanbase-oracle" ? cloneDialog.run(confirmDuplicateStructureImpl) : confirmDuplicateStructureImpl();
}

async function confirmDuplicateStructureImpl() {
  const row = duplicateTarget.value;
  const newName = duplicateTableName.value.trim();
  if (!row || !newName) return;
  const context = captureTableCopyContext();
  showDuplicateDialog.value = false;
  try {
    const schema = row.schema || context.schema;
    const plan = await buildDuplicateStructurePlan(context, row.name, newName, schema, row.comment);
    if (!(await cloneDialog.request([{ plan, scope: [context.connection.id, context.database, context.catalog || ""] }]))) return;
    const executed = await executeObjectBrowserSqlWithProductionGuard(plan.sql, () => executeDuplicateStructurePlan(context, plan, schema), context);
    if (!executed) return;
    toast(t("contextMenu.duplicateStructureSuccess", { name: newName }));
    await reloadTableCopyContext(context);
    await connectionStore.refreshObjectListTreeNode(context.connection.id, context.database, schema);
  } catch (e: any) {
    if (e instanceof OceanbaseTableCloneError) {
      const refreshed = await Promise.allSettled([reloadTableCopyContext(context), connectionStore.refreshObjectListTreeNode(context.connection.id, context.database, e.targetSchema)]);
      cloneDialog.showFailure(
        e,
        [],
        refreshed.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      );
      return;
    }
    if (context.databaseType === "oceanbase-oracle") {
      cloneDialog.showFailure(e);
      return;
    }
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function objectBrowserTableNamesCopyText(rows: readonly ObjectBrowserRow[]): string {
  const targets = rows.map(
    (row) =>
      ({
        id: row.name,
        label: row.name,
        type: "table",
        connectionId: props.connection.id,
        database: props.database,
        catalog: props.catalog,
        schema: row.schema || selectedSchema.value || undefined,
      }) as SidebarTableCopyTarget,
  );
  return formatSidebarTableNamesForCopy(targets, {
    separator: settingsStore.editorSettings.sidebarCopyTableNameSeparator,
    includeSchema: settingsStore.editorSettings.sidebarCopyTableNameIncludeSchema,
    databaseType: effectiveDatabaseType.value,
    driverProfile: props.connection.driver_profile,
    identifierQuote: connectionStore.connectionIdentifierQuote?.(props.connection.id),
  });
}

async function copySelectedTablesToClipboard() {
  if (hasSelectedSchemaIndexes.value) return;
  const selectedRows = selectedTableRows.value;
  if (selectedRows.length === 0) return;
  connectionStore.treeClipboard = {
    kind: "table-copy",
    tables: selectedRows.map((row) => ({
      connectionId: props.connection.id,
      database: props.database,
      schema: normalizeObjectBrowserTableClipboardSchema(row.schema || selectedSchema.value),
      tableName: row.name,
      tableComment: row.comment,
    })),
  };
  try {
    await copyToClipboard(objectBrowserTableNamesCopyText(selectedRows));
    toast(t("contextMenu.pasteTableClipboardUpdated"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function canPasteTableClipboard(): boolean {
  return supportsBatchTableActions.value && tableClipboardMatchesTarget(normalizedObjectBrowserTableClipboardEntries(), pasteTableTargetContext());
}

function normalizedObjectBrowserTableClipboardEntries() {
  const clipboard = connectionStore.treeClipboard;
  if (clipboard?.kind !== "table-copy") return [];
  return clipboard.tables.map((entry) => ({
    ...entry,
    schema: normalizeObjectBrowserTableClipboardSchema(entry.schema, entry.database, entry.connectionId),
  }));
}

function canTransferTableClipboard(): boolean {
  if (isVictoriaMetrics.value) return false;
  const entries = normalizedObjectBrowserTableClipboardEntries();
  const target = pasteTableTargetContext();
  if (entries.length === 0 || connectionIsEffectivelyReadOnly(props.connection)) return false;
  const source = tableClipboardSourceContext(entries);
  const sourceConfig = source ? connectionStore.getConfig(source.connectionId) : undefined;
  return !!source && !!sourceConfig && supportsTransfer(sourceConfig.db_type) && supportsTransfer(props.connection.db_type) && !tableClipboardMatchesTarget(entries, target);
}

function pasteTableTargetContext(): TableClipboardContext {
  return {
    connectionId: props.connection.id,
    database: props.database,
    schema: normalizeObjectBrowserTableClipboardSchema(selectedSchema.value),
  };
}

function normalizeObjectBrowserTableClipboardSchema(schema?: string, database = props.database, connectionId = props.connection.id): string | undefined {
  const connection = connectionStore.getConfig(connectionId) ?? props.connection;
  if (!isSchemaAware(connection.db_type) && connection.db_type !== "sqlite") return undefined;
  return connectionObjectTreeNodeSchema(connection, database, schema);
}

function openTransferFromTableClipboard(): boolean {
  const clipboard = connectionStore.treeClipboard;
  const entries = normalizedObjectBrowserTableClipboardEntries();
  const target = pasteTableTargetContext();
  if (clipboard?.kind !== "table-copy") return false;
  const source = tableClipboardSourceContext(entries);
  if (!source || tableClipboardMatchesTarget(entries, target)) return false;
  connectionStore.transferSource = {
    connectionId: source.connectionId,
    database: source.database,
    schema: source.schema ?? undefined,
    tables: clipboard.tables.map((entry) => entry.tableName),
    targetConnectionId: target.connectionId,
    targetDatabase: target.database,
    targetSchema: target.schema ?? undefined,
  };
  return true;
}

function copySingleTableToClipboard(row: ObjectBrowserRow) {
  connectionStore.treeClipboard = {
    kind: "table-copy",
    tables: [
      {
        connectionId: props.connection.id,
        database: props.database,
        schema: normalizeObjectBrowserTableClipboardSchema(row.schema || selectedSchema.value),
        tableName: row.name,
        tableComment: row.comment,
      },
    ],
  };
  toast(t("contextMenu.pasteTableClipboardUpdated"), 2000);
}

function openPasteTableDialog() {
  const clipboard = connectionStore.treeClipboard;
  if (canTransferTableClipboard()) {
    openTransferFromTableClipboard();
    return;
  }
  if (!canPasteTableClipboard() || clipboard?.kind !== "table-copy") {
    toast(t("contextMenu.noTableToPaste"), 2000);
    return;
  }
  pasteTableFromClipboard.value = true;
  pasteTableMode.value = defaultPasteTableMode(effectiveDatabaseType.value);
  pasteTableEntries.value = clipboard.tables.map((entry) => ({
    sourceName: entry.tableName,
    targetName: `${entry.tableName}_copy`,
    schema: normalizeObjectBrowserTableClipboardSchema(entry.schema, entry.database, entry.connectionId),
    tableComment: entry.tableComment,
  }));
  showPasteDialog.value = true;
}

function onObjectBrowserKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  const selectedIndex = rows.value.find((row) => row.id === selectedRowId.value && row.type === "INDEX");
  const target = event.target;
  if (event.key === "Delete" && target instanceof Element && !target.closest("input, textarea, select, [contenteditable='true']") && selectedTableCount.value > 1 && selectedTableRows.value.some((row) => row.type === "INDEX")) {
    event.preventDefault();
    event.stopPropagation();
    toast(t("schemaIndex.editIndividually"), 4000);
    return;
  }
  if (selectedIndex && target instanceof Element && !target.closest("input, textarea, select, [contenteditable='true']") && (event.key === "Delete" || event.key === "F2")) {
    event.preventDefault();
    event.stopPropagation();
    openSchemaIndexEditor(selectedIndex, event.key === "Delete" ? "delete" : undefined);
    return;
  }
  if (!supportsBatchTableActions.value) return;
  if (event.key === "Delete" && !event.isComposing && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !eventTargetUsesNativeClipboard(event) && selectedTableRows.value.some(usesExactTriggerDrop)) {
    event.preventDefault();
    event.stopPropagation();
    if (selectedTableCount.value === 1) requestDrop(selectedTableRows.value[0]);
    else requestBatchDropTables();
    return;
  }
  if (eventTargetAllowsAppClipboardShortcut(event, "c")) {
    if (selectedTableCount.value === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void copySelectedTablesToClipboard();
    return;
  }
  if (eventTargetAllowsAppClipboardShortcut(event, "v")) {
    if (!canPasteTableClipboard() && !canTransferTableClipboard()) return;
    event.preventDefault();
    event.stopPropagation();
    openPasteTableDialog();
  }
}

async function confirmPasteTable() {
  return effectiveDatabaseType.value === "oceanbase-oracle" ? cloneDialog.run(confirmPasteTableImpl) : confirmPasteTableImpl();
}

async function confirmPasteTableImpl() {
  const entries = pasteTableEntries.value.filter((entry) => entry.targetName.trim()).map((entry) => ({ ...entry }));
  if (entries.length === 0) return;
  const context = captureTableCopyContext();
  const shouldConsumeTableClipboard = pasteTableFromClipboard.value;
  const clipboardAtPasteStart = shouldConsumeTableClipboard ? connectionStore.treeClipboard : null;
  pasteTableFromClipboard.value = false;
  const mode = pasteTableMode.value;
  const copyData = pasteTableModeCopiesData(mode) && pasteTableDataCopySupported.value;
  showPasteDialog.value = false;
  if (context.databaseType === "mysql") {
    const copies = entries.map((entry) => ({ ...entry, connection: context.connection, database: context.database, catalog: context.catalog, schema: entry.schema || context.schema, identifierQuote: context.identifierQuote }));
    const completed = await useTableCopyTaskStore().run(copies, mode);
    if (completed && shouldConsumeTableClipboard && connectionStore.treeClipboard === clipboardAtPasteStart) connectionStore.treeClipboard = null;
    try {
      await reloadTableCopyContext(context);
    } catch (error) {
      const task = useTableCopyTaskStore().task;
      if (task) task.refreshError = error instanceof Error ? error.message : String(error);
    }
    return;
  }
  let successCount = 0;
  let pasteFailCount = 0;
  let firstPasteError: unknown;
  let pasteCancelled = false;
  let hasMutatedTable = false;
  const preparedClones = new Map<(typeof entries)[number], DuplicateTableStructurePlan>();
  if (context.databaseType === "oceanbase-oracle" && mode !== "data-only") {
    try {
      for (const entry of entries) preparedClones.set(entry, await buildDuplicateStructurePlan(context, entry.sourceName, entry.targetName.trim(), entry.schema || context.schema, entry.tableComment));
      if (!(await cloneDialog.request([...preparedClones.values()].map((plan) => ({ plan, scope: [context.connection.id, context.database, context.catalog || ""] }))))) return;
    } catch (error) {
      cloneDialog.showFailure(
        error,
        entries.map((entry) => `${entry.schema || context.schema || ""}.${entry.targetName}`),
      );
      return;
    }
  }
  let cloneFailure: { error: unknown; remaining: string[]; refreshErrors: unknown[] } | undefined;
  const completedCloneTargets: string[] = [];
  for (const entry of entries) {
    let targetName = entry.targetName.trim();
    let schema = entry.schema || context.schema;
    let completedClone: OceanbaseTableClone | undefined;
    try {
      let sourceColumns: ColumnInfo[] | undefined;
      if (mode === "structure-and-data" || mode === "structure-only") {
        const plan = preparedClones.get(entry) || (await buildDuplicateStructurePlan(context, entry.sourceName, targetName, schema, entry.tableComment, sourceColumns));
        sourceColumns = plan.sourceColumns;
        if (plan.oceanbaseClone) {
          targetName = plan.oceanbaseClone.targetName;
          schema = plan.oceanbaseClone.targetSchema;
        }
        const executed = await executeObjectBrowserSqlWithProductionGuard(plan.sql, () => executeDuplicateStructurePlan(context, plan, schema), context);
        if (!executed) {
          pasteCancelled = true;
          break;
        }
        hasMutatedTable = true;
        completedClone = plan.oceanbaseClone;
      }
      if (copyData) {
        sourceColumns ??= await api.getColumns(context.connection.id, context.database, schema || "", entry.sourceName, context.catalog);
        const dataCopyColumnOptions = tableDataCopyColumnOptions(context.databaseType, sourceColumns);
        if (dataCopyColumnOptions.columns.length === 0) {
          throw new Error("No writable columns available for table data copy.");
        }
        const dataSql = await buildCopyTableDataSql({
          databaseType: context.databaseType,
          schema,
          sourceName: entry.sourceName,
          targetName,
          normalizeNewTargetName: mode === "structure-and-data" && context.databaseType !== "oceanbase-oracle",
          identifierQuote: context.identifierQuote,
          ...dataCopyColumnOptions,
        });
        const clone = preparedClones.get(entry)?.oceanbaseClone;
        const execute = (sql: string) => api.executeQuery(context.connection.id, context.database, sql, schema, undefined, { timeoutSecs: 0 });
        const executed = await executeObjectBrowserSqlWithProductionGuard(dataSql, () => (clone ? executeOceanbaseTableCloneData(clone, dataSql, execute) : execute(dataSql)), context);
        if (!executed) {
          pasteCancelled = true;
          break;
        }
        hasMutatedTable = true;
      }
      successCount++;
      if (preparedClones.has(entry)) completedCloneTargets.push(`${schema}.${targetName}`);
    } catch (caught: any) {
      // 在 catch 开头统一归一化克隆错误，保证块内后续所有引用都能拿到 e
      const e = completedClone && !(caught instanceof OceanbaseTableCloneError) ? oceanbaseCloneDataPreparationError(completedClone, caught) : caught;
      if (context.databaseType === "oceanbase-oracle" && preparedClones.size) {
        const refreshed = await Promise.allSettled([reloadTableCopyContext(context), connectionStore.refreshObjectListTreeNode(context.connection.id, context.database, schema)]);
        cloneFailure = {
          error: e,
          remaining: entries.slice(entries.indexOf(entry) + 1).map((pending) => {
            const clone = preparedClones.get(pending)!.oceanbaseClone!;
            return `${clone.targetSchema}.${clone.targetName}`;
          }),
          refreshErrors: refreshed.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        };
        break;
      }
      pasteFailCount++;
      firstPasteError ??= caught;
      console.error(`Failed to paste table "${entry.sourceName}" -> "${targetName}":`, caught);
    }
  }
  if (cloneFailure) {
    cloneDialog.showFailure(cloneFailure.error, cloneFailure.remaining, cloneFailure.refreshErrors, completedCloneTargets);
    return;
  }
  if (pasteCancelled) {
    if (hasMutatedTable) {
      try {
        await reloadTableCopyContext(context);
        await connectionStore.refreshObjectListTreeNode(context.connection.id, context.database, context.schema);
        toast(t("contextMenu.pasteTableCancelledAfterPartial"), 5000);
      } catch (e: any) {
        toast(t("contextMenu.pasteTableRefreshFailed", { message: translateBackendError(t, e) }), 5000);
      }
    }
    return;
  }
  const pasteFeedback = tablePasteFeedback(successCount, pasteFailCount, firstPasteError);
  if (pasteFailCount === 0) {
    if (shouldConsumeTableClipboard && connectionStore.treeClipboard === clipboardAtPasteStart) {
      connectionStore.treeClipboard = null;
    }
    toast(t("contextMenu.batchPasteSuccess", { count: successCount }), 3000);
  } else {
    toast(`${t("contextMenu.batchPastePartialFail", { success: pasteFeedback.successCount, failed: pasteFeedback.failedCount })}\n${t("contextMenu.tableOperationFailed", { message: translateBackendError(t, pasteFeedback.firstError) })}`, 5000);
  }
  await reloadTableCopyContext(context);
  await connectionStore.refreshObjectListTreeNode(context.connection.id, context.database, context.schema);
}

function tableAdminSqlOptions(row: ObjectBrowserRow, options?: { cascade?: boolean }): TableAdminSqlOptions {
  const result: TableAdminSqlOptions = {
    databaseType: effectiveDatabaseType.value,
    schema: connectionTableSqlSchema(props.connection, row.schema || selectedSchema.value),
    tableName: row.name,
    // Cloud Spanner's dialect decides the quote; the static per-type mapping cannot.
    identifierQuote: connectionStore.connectionIdentifierQuote?.(props.connection.id),
  };
  if (options?.cascade) result.cascade = true;
  return result;
}

/**
 * Routes Object Browser writes through the shared production gate. The SQL is
 * assessed before the callback runs so generated DDL cannot bypass protection
 * via executable comments, EXPLAIN ANALYZE, or qualified production targets.
 */
async function executeObjectBrowserSqlWithProductionGuard<T>(sql: string, execute: () => Promise<T>, context: Pick<TableCopyContext, "connection" | "database"> = props): Promise<T | undefined> {
  return executeWithProductionSqlGuard({
    connection: context.connection,
    database: context.database,
    sql,
    source: t("production.sourceObjectBrowser"),
    execute,
  });
}

async function compileXuguObject(row: ObjectBrowserRow) {
  browserTriggerFeedback.value = undefined;
  if (effectiveDatabaseType.value !== "xugu") return;
  const sql = buildXuguCompileSql({ objectType: row.type, schema: row.schema || selectedSchema.value, name: row.name });
  if (!sql) return;
  try {
    const executed = await executeObjectBrowserSqlWithProductionGuard(sql, () => api.executeQuery(props.connection.id, props.database, sql, row.schema || selectedSchema.value));
    if (!executed) return;
    toast(t("contextMenu.compileObjectSuccess", { name: row.name }));
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, row.schema || selectedSchema.value);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function refreshAfterInvalidObjectCompile(scope: OracleInvalidObjectCompileScope) {
  await completeOracleInvalidObjectCompile(
    scope,
    () => ({ connectionId: props.connection.id, database: props.database, schema: selectedSchema.value || props.database }),
    async (completed) => {
      await invalidateObjectDdlCache(completed);
      invalidateObjectBrowserRowsCache(completed);
    },
    async (current) => {
      if (objectBrowserUnmounted) return;
      await Promise.all([reload(), connectionStore.refreshObjectListTreeNode(current.connectionId, current.database, current.schema)]);
    },
  );
}

async function compileDamengView(row: ObjectBrowserRow) {
  if (effectiveDatabaseType.value !== "dameng" || row.type !== "VIEW") return;
  const schema = row.schema || selectedSchema.value;
  const sql = buildDamengCompileViewSql({ schema, name: row.name });
  if (!sql) return;
  try {
    const executed = await executeObjectBrowserSqlWithProductionGuard(sql, () => api.executeQuery(props.connection.id, props.database, sql, schema));
    if (!executed) return;
    toast(t("contextMenu.compileObjectSuccess", { name: row.name }));
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, schema);
  } catch (e: any) {
    compileErrorTitle.value = t("contextMenu.compileObjectFailedTitle");
    compileErrorMessage.value = t("contextMenu.compileObjectFailedMessage", { name: row.name, message: e?.message || String(e) });
    showCompileErrorDialog.value = true;
  }
}

async function refreshTruncatePreviewSql(row: ObjectBrowserRow) {
  truncatePreviewSql.value = "";
  truncatePreviewSql.value = await buildTruncateTableSql(tableAdminSqlOptions(row, { cascade: canTruncateTargetCascade.value && truncateTableCascade.value })).catch(() => "");
}

function requestTruncateTable(row: ObjectBrowserRow) {
  truncateTarget.value = row;
  truncateTableCascade.value = false;
  void refreshTruncatePreviewSql(row);
  showTruncateConfirm.value = true;
}

async function confirmTruncateTable() {
  const row = truncateTarget.value;
  if (!row) return;
  let executedSql = "";
  const start = Date.now();
  let successRecorded = false;
  try {
    const sql = truncatePreviewSql.value || (await buildTruncateTableSql(tableAdminSqlOptions(row, { cascade: canTruncateTargetCascade.value && truncateTableCascade.value })));
    executedSql = sql;
    const executed = await executeObjectBrowserSqlWithProductionGuard(sql, () => api.executeQuery(props.connection.id, props.database, sql));
    if (!executed) return;
    await recordTableMutationHistory(getTableMutationHistoryStoreOrNull(), {
      connectionId: props.connection.id,
      connectionName: props.connection.name,
      database: props.database,
      sql,
      elapsedMs: Date.now() - start,
      success: true,
      target: row.name,
    }).catch((err) => console.warn("[DBX] failed to record truncate history", err));
    successRecorded = true;
    toast(t("contextMenu.truncateTableSuccess", { name: row.name }));
    await refreshMutatedTableDataTabsForRows([row]);
  } catch (e: any) {
    if (executedSql && !successRecorded) {
      await recordTableMutationHistory(getTableMutationHistoryStoreOrNull(), {
        connectionId: props.connection.id,
        connectionName: props.connection.name,
        database: props.database,
        sql: executedSql,
        elapsedMs: Date.now() - start,
        success: false,
        error: e?.message || String(e),
        target: row.name,
      }).catch((err) => console.warn("[DBX] failed to record truncate history", err));
    }
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
  truncateTarget.value = null;
}

async function refreshVacuumPreviewSql() {
  const row = vacuumTarget.value;
  vacuumPreviewSql.value = "";
  if (!row) return;
  vacuumPreviewSql.value = await buildVacuumTableSql({
    databaseType: effectiveDatabaseType.value,
    schema: row.schema || selectedSchema.value,
    tableName: row.name,
    full: vacuumTableFull.value,
    analyze: vacuumTableAnalyze.value,
  }).catch(() => "");
}

function requestVacuumTable(row: ObjectBrowserRow) {
  if (!supportsVacuumTable.value) return;
  vacuumTarget.value = row;
  vacuumTableFull.value = false;
  vacuumTableAnalyze.value = false;
  vacuumPreviewSql.value = "";
  void refreshVacuumPreviewSql();
  showVacuumConfirm.value = true;
}

async function confirmVacuumTable() {
  const row = vacuumTarget.value;
  if (!row || vacuumExecuting.value) return;
  vacuumExecuting.value = true;
  try {
    const sql =
      vacuumPreviewSql.value ||
      (await buildVacuumTableSql({
        databaseType: effectiveDatabaseType.value,
        schema: row.schema || selectedSchema.value,
        tableName: row.name,
        full: vacuumTableFull.value,
        analyze: vacuumTableAnalyze.value,
      }));
    const executed = await executeObjectBrowserSqlWithProductionGuard(sql, () => api.executeQuery(props.connection.id, props.database, sql, row.schema || selectedSchema.value));
    if (!executed) return;
    toast(t("contextMenu.vacuumTableSuccess", { name: row.name }));
    showVacuumConfirm.value = false;
    vacuumTarget.value = null;
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    vacuumExecuting.value = false;
  }
}

async function refreshEmptyPreviewSql(row: ObjectBrowserRow) {
  emptyPreviewSql.value = "";
  emptyPreviewSql.value = await buildEmptyTableSql(tableAdminSqlOptions(row)).catch(() => "");
}

function requestEmptyTable(row: ObjectBrowserRow) {
  emptyTarget.value = row;
  void refreshEmptyPreviewSql(row);
  showEmptyConfirm.value = true;
}

async function confirmEmptyTable() {
  const row = emptyTarget.value;
  if (!row) return;
  let executedSql = "";
  const start = Date.now();
  let successRecorded = false;
  try {
    const sql = emptyPreviewSql.value || (await buildEmptyTableSql(tableAdminSqlOptions(row)));
    executedSql = sql;
    const executed = await executeObjectBrowserSqlWithProductionGuard(sql, () => api.executeQuery(props.connection.id, props.database, sql));
    if (!executed) return;
    await recordTableMutationHistory(getTableMutationHistoryStoreOrNull(), {
      connectionId: props.connection.id,
      connectionName: props.connection.name,
      database: props.database,
      sql,
      elapsedMs: Date.now() - start,
      success: true,
      target: row.name,
    }).catch((err) => console.warn("[DBX] failed to record empty history", err));
    successRecorded = true;
    toast(t("contextMenu.emptyTableSuccess", { name: row.name }));
    await refreshMutatedTableDataTabsForRows([row]);
  } catch (e: any) {
    if (executedSql && !successRecorded) {
      await recordTableMutationHistory(getTableMutationHistoryStoreOrNull(), {
        connectionId: props.connection.id,
        connectionName: props.connection.name,
        database: props.database,
        sql: executedSql,
        elapsedMs: Date.now() - start,
        success: false,
        error: e?.message || String(e),
        target: row.name,
      }).catch((err) => console.warn("[DBX] failed to record empty history", err));
    }
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
  emptyTarget.value = null;
}

async function copyName(row: ObjectBrowserRow) {
  try {
    await copyToClipboard(row.name);
    toast(t("connection.copied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copySource() {
  if (!sourceContent.value) return;
  try {
    await copyToClipboard(sourceContent.value);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function editSource() {
  if (!sourceRow.value || !sourceEditableText.value) return;
  if (!sourceCanEdit.value) {
    toast(t("objects.sourceReadOnly"), 3000);
    return;
  }
  sourceDraft.value = sourceEditableText.value;
  sourceSaveError.value = "";
  sourceEditing.value = true;
}

function cancelEditSource() {
  sourceEditing.value = false;
  sourceDraft.value = "";
  sourceSaveError.value = "";
}

async function saveSource() {
  if (sourceSaving.value || sourceLoading.value) return;
  if (!sourceCanEdit.value) {
    toast(t("objects.sourceReadOnly"), 3000);
    return;
  }
  if (!sourceRow.value || !sourceDraft.value.trim()) return;
  if (sourceTriggerRequested.value) {
    if (!sourceTriggerSnapshot.value) {
      sourceSaveError.value = t("oracleTrigger.reloadBaseline");
      return;
    }
    await runSourceTriggerAction("replace");
    return;
  }
  const row = sourceRow.value;
  const epoch = sidePanelGuard.capture();
  const connectionId = props.connection.id;
  const database = props.database;
  const schema = row.schema || selectedSchema.value || database;
  const connection = props.connection;
  const databaseType = effectiveDatabaseType.value;
  sourceSaving.value = true;
  sourceSaveError.value = "";
  let save: Awaited<ReturnType<typeof prepareObjectSourceSave>> | undefined;
  try {
    if (!sourceIdentity) return;
    const identity = sourceIdentity;
    assertSourceIdentity(identity);
    if (isOracleFamilyTypeSource(databaseType, row.type)) {
      const source = sourceDraft.value;
      const result = await requestOracleTypeManagement({
        target: { connectionId, database, owner: schema, name: row.name, databaseType: databaseType as "oracle" | "oceanbase-oracle" | "dameng" },
        operation: row.type === "TYPE_BODY" ? "save-body" : "save-spec",
        source,
        baseSource: sourceEditableText.value,
        isCurrent: () => sidePanelGuard.isFresh(epoch) && sourceRow.value === row && sourceDraft.value === source,
      });
      if (!result.complete || sidePanelGuard.isStale(epoch)) return;
      toast(t("objects.sourceSaved"));
      sourceEditing.value = false;
      sourceDraft.value = "";
      await loadSourcePanel(row);
      return;
    }
    const statements = await buildExecutableObjectSourceStatements({
      databaseType,
      objectType: row.type as ObjectSourceKind,
      schema,
      name: row.name,
      source: sourceDraft.value,
    });
    save = await prepareObjectSourceSave(connectionId, database, databaseType, statements, schema, { objectType: row.type as ObjectSourceKind, name: row.name });
    const preparedSave = save;
    const execute = async () => {
      if (sidePanelGuard.isStale(epoch) || sourceRow.value !== row) return;
      const release = beginSourceSave(identity);
      try {
        return { operation: await preparedSave() };
      } finally {
        release();
      }
    };
    const executableSql = statements.filter((sql) => sql.trim()).join(";\n");
    let result;
    if (executableSql.trim()) {
      result = await executeWithProductionSqlGuard({
        connection,
        database,
        sql: executableSql,
        source: t("production.sourceObjectSource"),
        execute,
      });
    } else {
      result = await execute();
    }
    if (!result || sidePanelGuard.isStale(epoch)) return;
    toast(objectSourceSaveSuccessMessage(t("objects.sourceSaved"), result.operation), result.operation?.readback?.compilerMessages.length ? 6000 : 2000);
    sourceEditing.value = false;
    sourceDraft.value = "";
    await openSource(row);
  } catch (e: unknown) {
    if (sidePanelGuard.isStale(epoch)) return;
    sourceSaveError.value = formatObjectSourceSaveError(e, databaseType, row.type as ObjectSourceKind, t("objects.postgresViewColumnChangeHint"));
  } finally {
    await save?.dispose?.();
    if (sidePanelGuard.isFresh(epoch)) sourceSaving.value = false;
  }
}

async function runSourceTriggerAction(action: OracleTriggerAction) {
  const baseline = sourceTriggerSnapshot.value;
  const row = sourceRow.value;
  if (!baseline || !row || sourceSaving.value || sourceLoading.value) return;
  const epoch = sidePanelGuard.capture(),
    draft = sourceDraft.value;
  const current = () => sidePanelGuard.isFresh(epoch) && sourceRow.value === row && props.connection.id === baseline.target.connectionId && props.database === baseline.target.database && props.catalog === baseline.target.catalog && (action !== "replace" || sourceDraft.value === draft);
  sourceSaving.value = true;
  sourceSaveError.value = "";
  try {
    const plan = await prepareOracleTriggerPlan({ target: baseline.target, action, expectedObjectId: baseline.metadata.objectId ?? undefined, ...(action === "replace" ? { baseline, source: draft } : {}) });
    if (!current()) return;
    const result = await confirmOracleTriggerPlan(plan, { isCurrent: current });
    if (sidePanelGuard.isStale(epoch)) return;
    sourceTriggerResult.value = result;
    const committed = !result.cancelled && result.steps.every((step) => step.state === "committed");
    if (committed && result.snapshot && result.snapshot.metadata.objectId === baseline.metadata.objectId && (action === "replace" || baseline.raw.source === plan.before.raw.source)) {
      sourceTriggerSnapshot.value = result.snapshot;
      sourceIdentity = result.snapshot.identity;
    } else if (result.snapshot) sourceTriggerIssue.value = t("oracleTrigger.reloadBaseline");
    if (!result.cancelled && result.steps.every((step) => step.state === "committed") && !result.steps.some((step) => step.verification === "invalid") && action === "replace") {
      sourceEditing.value = false;
      await loadSourcePanel(row);
    }
  } catch (error) {
    if (sidePanelGuard.isFresh(epoch)) sourceSaveError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) sourceSaving.value = false;
  }
}

function openSourceTriggerParent() {
  const parent = sourceTriggerSnapshot.value?.metadata.parent;
  if (!parent || (sourceEditing.value && sourceDraft.value !== sourceEditableText.value && !window.confirm(t("objectDependencies.navigateDiscardConfirm")))) return;
  emit("openTable", { schema: parent.owner, tableName: parent.name, tableType: parent.objectType, catalog: props.catalog });
}

function triggerRowTarget(row: ObjectBrowserRow): OracleTriggerTarget {
  const metadata = exactOracleTriggerMetadata(row.trigger);
  if (!metadata) throw new Error(t("oracleTrigger.reloadBaseline"));
  return { connectionId: props.connection.id, database: props.database, catalog: props.catalog, owner: metadata.owner, name: metadata.name, executionSchema: selectedSchema.value || props.schema || metadata.owner };
}

function mergeBrowserTriggerSnapshot(target: Readonly<OracleTriggerTarget>, snapshot?: OracleTriggerSnapshot, nativeBefore?: OracleTriggerSnapshot, nativeVerified = false) {
  if (!snapshot?.exists || !snapshot.raw.trigger || props.connection.id !== target.connectionId || props.database !== target.database || props.catalog !== target.catalog) return;
  const trigger = snapshot.raw.trigger;
  rows.value = rows.value.map((row) => {
    const metadata = exactOracleTriggerMetadata(row.trigger);
    return row.type === "TRIGGER" && metadata?.owner === target.owner && metadata.name === target.name && (!nativeBefore || (metadata.objectId === nativeBefore.metadata.objectId && snapshot.metadata.objectId === nativeBefore.metadata.objectId))
      ? { ...row, trigger, valid: trigger.valid, updated_at: snapshot.metadata.lastDdlTime ?? row.updated_at }
      : row;
  });
  const source = sourceTriggerSnapshot.value;
  if (source?.target.connectionId === target.connectionId && source.target.database === target.database && source.target.catalog === target.catalog && source.target.owner === target.owner && source.target.name === target.name) {
    // A native action can update our own baseline only when it preserved the
    // version that this editor actually loaded. A read-only refresh is not consent
    // to replace a dirty candidate's baseline with an external definition.
    if (nativeVerified && nativeBefore && snapshot.metadata.objectId === source.metadata.objectId && source.metadata.objectId === nativeBefore.metadata.objectId && source.raw.source === nativeBefore.raw.source) {
      sourceTriggerSnapshot.value = snapshot;
      sourceIdentity = snapshot.identity;
    } else sourceTriggerIssue.value = t("oracleTrigger.reloadBaseline");
  }
}

function describeBrowserTriggerResult(target: Readonly<OracleTriggerTarget>, result: OracleTriggerExecutionResult): string {
  const snapshot = result.snapshot,
    metadata = snapshot?.metadata;
  const enabled = metadata?.reads.enabled?.state === "available" && typeof snapshot?.raw.trigger?.enabled === "boolean" ? t(snapshot.raw.trigger.enabled ? "objects.enabled" : "objects.disabled") : t("oracleTrigger.unknown");
  const valid = metadata?.reads.validity?.state === "available" && typeof snapshot?.raw.trigger?.valid === "boolean" ? (snapshot.raw.trigger.valid ? "VALID" : "INVALID") : t("oracleTrigger.unknown");
  const errors = metadata?.reads.errors?.state === "available" ? metadata.errors?.map((error) => `${error.line ?? "?"}:${error.position ?? "?"} ${error.text}`).join("\n") : `${t("processList.oracleInvalidObjects.errorsTitle")}: ${t("oracleTrigger.unknown")}`;
  return [
    `${target.database} · ${target.owner}.${target.name}`,
    `${t("oracleTrigger.executionSchema")}: ${target.executionSchema}`,
    `${enabled} · ${valid}`,
    ...result.steps.map((step) => `${t(`oceanbasePrimaryKey.${step.state}`)} · ${step.verification}\n${[step.error, step.readbackError].filter(Boolean).join("\n")}`),
    errors,
    result.refreshError,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function refreshBrowserTriggerFeedback() {
  const feedback = browserTriggerFeedback.value;
  if (!feedback || browserTriggerBusy.value) return;
  browserTriggerBusy.value = true;
  try {
    if (feedback.result.steps.some((step) => step.action === "delete")) {
      await verifyOracleTriggerDeletion({ ...feedback.target });
      if (browserTriggerFeedback.value !== feedback) return;
      if (feedback.pinnedContext) removeVerifiedBrowserDrop(feedback.row, feedback.target, feedback.pinnedContext);
      compileErrorMessage.value += `\n\n${t("contextMenu.dropTableChildObjectSuccess", { name: feedback.target.name })}`;
      browserTriggerFeedback.value = undefined;
      return;
    }
    const read = await readOracleTriggerSource({ ...feedback.target });
    if (browserTriggerFeedback.value !== feedback) return;
    const next = { ...feedback, snapshot: read.snapshot, result: { ...feedback.result, snapshot: read.snapshot } };
    browserTriggerFeedback.value = next;
    mergeBrowserTriggerSnapshot(feedback.target, read.snapshot);
    compileErrorMessage.value = describeBrowserTriggerResult(feedback.target, next.result) + (read.identityError ? `\n\n${read.identityError}` : "");
  } catch (error) {
    if (browserTriggerFeedback.value === feedback) compileErrorMessage.value += `\n\n${error instanceof Error ? error.message : String(error)}`;
  } finally {
    browserTriggerBusy.value = false;
  }
}

async function runBrowserTriggerAction(row: ObjectBrowserRow, action: "enable" | "disable" | "compile") {
  if (browserTriggerBusy.value) return;
  const context = browserTriggerContext(),
    revision = browserTriggerViewRevision.value;
  const metadata = exactOracleTriggerMetadata(row.trigger);
  const expectedId = typeof metadata?.objectId === "string" ? metadata.objectId : undefined;
  const current = () => browserTriggerActive.value && browserTriggerViewRevision.value === revision && browserTriggerContext() === context && rows.value.some((item) => item.id === row.id && (expectedId === undefined || exactOracleTriggerMetadata(item.trigger)?.objectId === expectedId));
  browserTriggerBusy.value = true;
  try {
    const target = triggerRowTarget(row);
    const plan = await prepareOracleTriggerPlan({ target, action, expectedObjectId: expectedId });
    if (!current()) return;
    const result = await confirmOracleTriggerPlan(plan, { isCurrent: current });
    if (result.cancelled) return;
    mergeBrowserTriggerSnapshot(
      plan.target,
      result.snapshot,
      plan.before,
      result.steps.every((step) => step.state === "committed"),
    );
    if (sourceTriggerSnapshot.value?.target.owner === target.owner && sourceTriggerSnapshot.value.target.name === target.name && sourceTriggerSnapshot.value.target.connectionId === target.connectionId) sourceTriggerResult.value = result;
    const complete = result.steps.every((step) => step.state === "committed" && step.verification !== "invalid");
    const message = describeBrowserTriggerResult(plan.target, result);
    if ((!complete || result.refreshError) && browserTriggerActive.value && browserTriggerContext() === context) {
      browserTriggerFeedback.value = { target: plan.target, row, result, snapshot: result.snapshot };
      compileErrorTitle.value = t("oracleStructureResult.resultTitle");
      compileErrorMessage.value = message;
      showCompileErrorDialog.value = true;
    } else {
      const label =
        result.steps.some((step) => step.verification === "invalid") || !complete
          ? message
          : `${t(action === "enable" ? "contextMenu.enableTriggerSuccess" : action === "disable" ? "contextMenu.disableTriggerSuccess" : "contextMenu.compileObjectSuccess", { name: target.name })}${result.snapshot?.raw.trigger?.valid === false ? " · INVALID" : ""}`;
      toast(label, !complete ? 10000 : 4000);
    }
  } catch (error) {
    if (browserTriggerActive.value && browserTriggerContext() === context) {
      browserTriggerFeedback.value = undefined;
      compileErrorTitle.value = t("oracleStructureResult.resultTitle");
      compileErrorMessage.value = error instanceof Error ? error.message : String(error);
      showCompileErrorDialog.value = true;
    }
  } finally {
    browserTriggerBusy.value = false;
  }
}

async function loadSchemas(epoch: number): Promise<boolean> {
  if (!schemaListLoadGuard.isEpochCurrent(epoch)) return false;
  if (!needsSchema.value) {
    schemas.value = [];
    selectedSchema.value = undefined;
    return true;
  }
  loadingSchemas.value = true;
  const connectionId = props.connection.id;
  const database = props.database;
  try {
    const names = filterSchemaNamesForConnection(await schemaListLoadGuard.wait(epoch, api.listSchemas(connectionId, database), metadataLoadBudgetMs(props.connection.query_timeout_secs)), props.connection, database, {
      showSystemSchemas: props.connection.show_system_schemas === true,
    });
    if (!schemaListLoadGuard.isEpochCurrent(epoch)) return false;
    schemas.value = names;
    if (names.length === 0) {
      selectedSchema.value = undefined;
      return true;
    }
    if (!selectedSchema.value || !names.includes(selectedSchema.value)) {
      selectedSchema.value = names.includes("public") ? "public" : names[0];
    }
    return true;
  } finally {
    if (schemaListLoadGuard.isEpochCurrent(epoch)) loadingSchemas.value = false;
  }
}

function objectBrowserRowsCacheScope(schema: string): ObjectBrowserRowsCacheScope {
  return {
    connectionId: props.connection.id,
    database: props.database,
    schema,
    catalog: props.catalog,
    ...(oracleTriggerObjectReadOptions(props.connection, undefined, props.catalog) ? { oracleTriggerContract: 1 as const } : {}),
    ...(supportsSchemaIndexes.value ? { exactIdentity: true } : {}),
  };
}

function applyObjectBrowserRows(nextRows: ObjectBrowserRow[]) {
  rows.value = nextRows;
  const availableIds = new Set(selectableRows.value.map((row) => row.id));
  setSelectedTableIds(new Set([...selectedTableIds.value].filter((id) => availableIds.has(id))));
  expandedPartitionParentIds.value = new Set([...expandedPartitionParentIds.value].filter((id) => rows.value.some((row) => row.id === id && row.partitionCount)));
}

function openInitialEventIfNeeded() {
  const name = props.initialEventName?.trim() ?? "";
  const decision = resolveInitialEventEditorRequest({
    eventCreateRequestId: props.initialEventCreateRequestId,
    eventName: props.initialEventName,
    eventOpenRequestId: props.initialEventOpenRequestId,
    openedRequestKey: openedInitialEvent.value,
    hasEventRow: rows.value.some((candidate) => candidate.type === "EVENT" && candidate.name === name),
    loadingObjects: loadingObjects.value,
  });
  if (decision.type === "ignore") return;
  openedInitialEvent.value = decision.requestKey;
  if (decision.type === "create") {
    // 新建事件：不依赖对象列表中的 EVENT row，直接进入 CREATE 编辑器。
    // MySqlEventEditor 收到空 name 时会以 CREATE 模式渲染。
    sidePanelGuard.start();
    sidePanelRow.value = null;
    sourceRow.value = null;
    sidePanelMode.value = "event-editor";
    return;
  }
  const row = rows.value.find((candidate) => candidate.type === "EVENT" && candidate.name === name);
  if (row) openEventEditor(row);
}

function finishObjectBrowserRowsLoad() {
  loadingObjects.value = false;
  const preferredFilter = props.initialEventName || props.initialEventCreateRequestId !== undefined ? "events" : (props.selectedObjectFilter ?? props.initialObjectFilter ?? "tables");
  if (!usesServerObjectPaging.value && !userHasSelectedFilter.value && objectCounts.value[preferredFilter] > 0) {
    // The default table filter is a presentation choice, not a user query
    // change, so preserve the tab's saved scroll offset across remounts.
    preserveObjectFilterScrollOnce = objectFilter.value !== "tables";
    objectFilter.value = preferredFilter;
  }
  openInitialEventIfNeeded();
  restoreObjectBrowserViewport();
}

watch([() => props.initialEventName, () => props.initialEventOpenRequestId, () => props.initialEventCreateRequestId], ([name, requestId, createRequestId], [previousName, previousRequestId, previousCreateRequestId]) => {
  if (name !== previousName || requestId !== previousRequestId || createRequestId !== previousCreateRequestId) {
    openedInitialEvent.value = "";
    if (name || createRequestId !== undefined) objectFilter.value = "events";
  }
  openInitialEventIfNeeded();
});

// 达梦的对象列表 SQL 固定 `WHERE o.OWNER = ?`（DamengAgent），空 schema 必然
// 匹配 0 行；schema 解析失败（loadSchemas 抛错或返回空列表）时标签会整体空白
// (#8301)。经 objectListSchemaForConnection 回退到连接用户名（大写），仅限
// 达梦；oracle/oceanbase-oracle 维持空 schema 由后端解析当前 schema。
async function loadObjects(options?: { allowCached?: boolean; preserveExistingRows?: boolean }) {
  clearTimeout(objectSearchTimer);
  if (usesServerObjectPaging.value) return loadObjectPage(false, options);
  error.value = "";
  // A new load supersedes any in-flight one, so reset the transient refresh flags
  // on entry. A superseded request's finally() can no longer run (the guard's
  // epoch moved on) and would otherwise leave refreshingObjects stuck spinning
  // the toolbar icon — the newest request owns the spinner state from here.
  loadingObjects.value = false;
  refreshingObjects.value = false;
  loadingMoreObjects.value = false;
  objectPageNextAnchor = undefined;
  scaffoldRefreshError.value = "";
  // True when we are revalidating on top of visible rows (a stale-cache scaffold, or a
  // same-instance refresh) — a failure then keeps the rows and raises a non-blocking
  // banner instead of replacing the whole list with a full-area error.
  let scaffoldRefresh = false;
  const schema = needsSchema.value ? objectListSchemaForConnection(props.connection, selectedSchema.value) : props.database;
  const request = objectBrowserRowsLoadGuard.start(objectBrowserRowsCacheScope(schema));
  const cacheWriteToken = createObjectBrowserRowsCacheWriteToken(request.scope);

  // finishObjectBrowserRowsLoad() is idempotent, but keep the default-filter /
  // viewport restores to a single run per load so the events-preferred-filter case
  // doesn't leave preserveObjectFilterScrollOnce latched across an extra call.
  let finished = false;
  const finishOnce = () => {
    if (finished) return;
    finished = true;
    finishObjectBrowserRowsLoad();
  };

  const cached = options?.allowCached ? getCachedObjectBrowserRowsForScaffold(request.scope) : undefined;
  if (cached) {
    // Restore the last-known rows when remounting this tab. The cached list is
    // authoritative for navigation restores, including entries older than the
    // freshness TTL; re-querying here makes every tab switch look like a refresh.
    // Explicit refresh and metadata invalidation still bypass this branch.
    applyObjectBrowserRows(cached.rows);
    finishOnce();
    // 行数/大小是随对象列表一起缓存的，直接返回缓存会让这两列一直停在上一次统计
    // （#10461）。对象列表本身仍按上面的约定不动，只把统计信息在后台补一次。
    if (cached.stale) void revalidateCachedObjectStatistics(request, cacheWriteToken);
    return;
  } else {
    // No scaffold: first load in this scope, cache invalidated by a DDL mutation,
    // or the caller wants a true reload. If the caller explicitly asked to keep the
    // current rows (same-instance refresh) and rows exist, refresh without blanking.
    const keepExisting = options?.preserveExistingRows && rows.value.length > 0;
    if (keepExisting) {
      scaffoldRefresh = true;
      refreshingObjects.value = true;
    } else {
      loadingObjects.value = true;
      rows.value = [];
    }
  }

  try {
    const load = props.connection.db_type === "mongodb" ? loadMongoObjectBrowserRows(request.scope.connectionId, request.scope.database) : loadSqlObjectBrowserRows(request);
    const nextRows = await objectBrowserRowsLoadGuard.wait(request.epoch, load, metadataLoadBudgetMs(props.connection.query_timeout_secs));
    if (!objectBrowserRowsLoadGuard.isCurrent(request)) return;
    applyObjectBrowserRows(nextRows);
    const cachedAt = cacheObjectBrowserRows(cacheWriteToken, nextRows);
    void loadObjectStatistics(request, cacheWriteToken, cachedAt);
  } catch (e: any) {
    if (!objectBrowserRowsLoadGuard.isCurrent(request)) return;
    // Keep visible rows on a background revalidate failure — surface a lightweight
    // banner rather than replacing the scaffold (or same-instance refresh) list.
    if (scaffoldRefresh) {
      scaffoldRefreshError.value = translateBackendError(t, e);
    } else {
      error.value = translateBackendError(t, e);
    }
  } finally {
    if (objectBrowserRowsLoadGuard.isCurrent(request)) {
      loadingObjects.value = false;
      refreshingObjects.value = false;
      finishOnce();
    }
  }
}

function objectPageAnchor(object: ObjectInfo): string {
  if (object.object_type === "INDEX") return JSON.stringify([object.schema, object.name, object.parent_schema, object.parent_name]);
  return exactOracleTriggerMetadata(object.trigger) ? tablePageRowAnchorKey(object.name, object.schema, undefined, object.trigger) : JSON.stringify([object.schema, object.name, object.object_type, object.signature]);
}

async function loadObjectPage(append: boolean, options?: { preserveExistingRows?: boolean }) {
  if (append && (loadingObjects.value || refreshingObjects.value || loadingMoreObjects.value || !hasMoreObjects.value)) return;
  const schema = exactIndexList.value ? indexParentSchema() : needsSchema.value ? objectListSchemaForConnection(props.connection, selectedSchema.value) : props.database;
  const request = objectBrowserRowsLoadGuard.start(objectBrowserRowsCacheScope(schema));
  const offset = append ? objectPageOffset : 0;
  const keepExisting = !append && options?.preserveExistingRows && rows.value.length > 0;
  let pageSize = keepExisting ? Math.max(objectPageSize.value, objectPageOffset) : objectPageSize.value;
  const nextAnchor = append ? objectPageNextAnchor : undefined;
  const filter = search.value.trim();
  const typeFilter = objectFilter.value;
  const exactIdentity = exactIndexList.value;
  const queryTypes = supportsSchemaIndexes.value && typeFilter === "all" ? sidebarObjectKindsForDatabase(effectiveDatabaseType.value).filter((type) => type !== "INDEX") : undefined;
  const objectTypes: Partial<Record<ObjectFilter, (SidebarObjectKind | "EVENT")[]>> = {
    tables: ["TABLE"],
    views: ["VIEW"],
    materializedViews: ["MATERIALIZED_VIEW"],
    procedures: ["PROCEDURE"],
    functions: ["FUNCTION"],
    triggers: ["TRIGGER"],
    events: ["EVENT"],
    sequences: ["SEQUENCE"],
    indexes: ["INDEX"],
    packages: ["PACKAGE", "PACKAGE_BODY"],
    types: ["TYPE", "TYPE_BODY"],
  };
  const isCurrent = () => objectBrowserRowsLoadGuard.isCurrent(request) && search.value.trim() === filter && objectFilter.value === typeFilter;
  error.value = "";
  scaffoldRefreshError.value = "";
  loadingObjects.value = !append && !keepExisting;
  refreshingObjects.value = !!keepExisting;
  loadingMoreObjects.value = append;
  if (!append && !keepExisting) {
    rows.value = [];
    hasMoreObjects.value = false;
    objectPageOffset = 0;
    objectPageNextAnchor = undefined;
  }
  try {
    if (parseSlashDelimitedRegexQuery(filter)) {
      error.value = t("objects.pagedRegexUnsupported");
      return;
    }
    const requestedTypes = queryTypes ?? objectTypes[typeFilter];
    const readOptions = oracleTriggerObjectReadOptions(props.connection, requestedTypes, request.scope.catalog);
    const fetchPage = (pageOffset: number, size: number) =>
      objectBrowserRowsLoadGuard.wait(
        request.epoch,
        exactIdentity
          ? api.listObjects(request.scope.connectionId, request.scope.database, request.scope.schema, objectTypes[typeFilter], filter || undefined, size + 1, pageOffset, request.scope.catalog, undefined, undefined, true)
          : readOptions
            ? api.listObjects(request.scope.connectionId, request.scope.database, request.scope.schema, requestedTypes, filter || undefined, size + 1, pageOffset, request.scope.catalog, undefined, undefined, readOptions)
            : api.listObjects(request.scope.connectionId, request.scope.database, request.scope.schema, requestedTypes, filter || undefined, size + 1, pageOffset, request.scope.catalog),
        metadataLoadBudgetMs(props.connection.query_timeout_secs),
      );
    let objects = await fetchPage(offset, pageSize);
    if (!isCurrent()) return;
    let replaceWindow = !append;
    if (append && nextAnchor && (!objects[0] || objectPageAnchor(objects[0]) !== nextAnchor)) {
      pageSize += offset;
      objects = await fetchPage(0, pageSize);
      if (!isCurrent()) return;
      replaceWindow = true;
    }
    const page = objects.slice(0, pageSize);
    const pageRows = buildObjectBrowserRows({
      objects: page.filter((object) => !supportsSchemaIndexes.value || typeFilter !== "all" || object.object_type !== "INDEX"),
      database: request.scope.database,
      fallbackSchema: request.scope.schema,
      rowSchema: connectionObjectTreeNodeSchema(props.connection, props.database, selectedSchema.value),
    });
    applyObjectBrowserRows(replaceWindow ? pageRows : [...rows.value, ...pageRows]);
    objectPageOffset = (replaceWindow ? 0 : offset) + page.length;
    hasMoreObjects.value = objects.length > pageSize;
    objectPageNextAnchor = hasMoreObjects.value ? objectPageAnchor(objects[pageSize]) : undefined;
  } catch (e: unknown) {
    if (!isCurrent()) return;
    if (append || keepExisting) scaffoldRefreshError.value = translateBackendError(t, e);
    else error.value = translateBackendError(t, e);
  } finally {
    if (isCurrent()) {
      loadingObjects.value = false;
      loadingMoreObjects.value = false;
      refreshingObjects.value = false;
      if (!append) finishObjectBrowserRowsLoad();
    }
  }
}

async function loadSqlObjectBrowserRows(request: ObjectBrowserRowsLoadHandle) {
  // Schema indexes use their dedicated exact, server-paged filter. Mixing an
  // unbounded exact subset into the legacy all view defeats both contracts.
  const types = supportsSchemaIndexes.value ? sidebarObjectKindsForDatabase(effectiveDatabaseType.value).filter((type) => type !== "INDEX") : undefined;
  const readOptions = oracleTriggerObjectReadOptions(props.connection, types, request.scope.catalog);
  const objects: ObjectInfo[] = await (readOptions
    ? api.listObjects(request.scope.connectionId, request.scope.database, request.scope.schema, types, undefined, undefined, undefined, request.scope.catalog, undefined, undefined, readOptions)
    : api.listObjects(request.scope.connectionId, request.scope.database, request.scope.schema, types, undefined, undefined, undefined, request.scope.catalog));
  return buildObjectBrowserRows({
    objects: objects.filter((object) => !supportsSchemaIndexes.value || object.object_type !== "INDEX"),
    database: request.scope.database,
    fallbackSchema: request.scope.schema,
    rowSchema: connectionObjectTreeNodeSchema(props.connection, props.database, selectedSchema.value),
  });
}

async function loadMongoObjectBrowserRows(connectionId: string, database: string) {
  const collections = await api.mongoListCollections(connectionId, database);
  return buildMongoObjectBrowserRows({ collections: visibleMongoCollections(collections), database });
}

async function loadObjectStatistics(request: ObjectBrowserRowsLoadHandle, cacheWriteToken: ObjectBrowserRowsCacheWriteToken, cachedAt: number | undefined) {
  if (!rows.value.some((row) => row.type === "TABLE")) return;
  try {
    const stats = await api.listObjectStatistics(request.scope.connectionId, request.scope.database, request.scope.schema);
    if (!objectBrowserRowsLoadGuard.isCurrent(request) || stats.length === 0) return;
    mergeObjectStatistics(stats, request.scope.schema, cacheWriteToken, cachedAt);
  } catch (e) {
    console.debug("[ObjectBrowser] table statistics unavailable", e);
  }
}

/**
 * Refreshes only the table statistics for rows restored from a stale cache
 * scaffold. The row list itself is intentionally left untouched, and failures
 * stay silent because the statistics are decorative.
 */
async function revalidateCachedObjectStatistics(request: ObjectBrowserRowsLoadHandle, cacheWriteToken: ObjectBrowserRowsCacheWriteToken) {
  await loadObjectStatistics(request, cacheWriteToken, undefined);
}

function mergeObjectStatistics(stats: ObjectStatistics[], fallbackSchema: string, cacheWriteToken: ObjectBrowserRowsCacheWriteToken, cachedAt: number | undefined) {
  const statsByKey = new Map(stats.map((stat) => [objectStatisticKey(stat.schema || fallbackSchema, stat.name), stat]));
  rows.value = rows.value.map((row) => {
    if (row.type !== "TABLE") return row;
    const stat = statsByKey.get(objectStatisticKey(row.schema || fallbackSchema, row.name));
    if (!stat) return row;
    return {
      ...row,
      estimatedRows: normalizeStatisticNumber(stat.estimated_rows),
      totalBytes: normalizeStatisticNumber(stat.total_bytes),
    };
  });
  cacheObjectBrowserRows(cacheWriteToken, rows.value, { cachedAt });
}

function objectStatisticKey(schema: string | undefined, name: string) {
  return `${schema || ""}\0${name}`.toLowerCase();
}

function normalizeStatisticNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function reload(options?: { allowCachedObjects?: boolean; contextEpoch?: number; preserveExistingRows?: boolean }) {
  const contextEpoch = options?.contextEpoch ?? schemaListLoadGuard.invalidate();
  // 对象列表只依赖本标签页绑定的 schema，而 schema 列表在部分引擎上可能很慢
  // （如达梦需要扫描庞大的 SYS.SYSOBJECTS，#8665）。这里让对象列表的加载与
  // listSchemas 并行进行，避免慢速 schema 列表让标签页长时间停在“没有找到对象”
  // 的空白态；若 schema 解析结果确实改变了目标 schema，随后按新 schema 重载。
  const schemaBeforeSchemas = selectedSchema.value;
  const schemasPromise = loadSchemas(contextEpoch).catch((e) => {
    // listSchemas 失败（如共享连接上 SET SCHEMA 后的二次元数据请求）时，
    // loadSchemas 不会触碰 selectedSchema，这里也不清空它：保留 props.schema
    // 或用户已选值，继续尝试加载对象列表（达梦走用户名回退），避免标签静默
    // 空白 (#8301)。对象列表若同样失败，loadObjects 自身的 catch 会展示错误。
    console.warn("[ObjectBrowser] loadSchemas failed, keeping selected schema for", props.connection.id, e);
    return false;
  });
  const parallelObjectLoad = needsSchema.value && selectedSchema.value ? loadObjects({ allowCached: options?.allowCachedObjects, preserveExistingRows: options?.preserveExistingRows }) : undefined;
  const schemasLoaded = await schemasPromise;
  await parallelObjectLoad;
  if (!schemaListLoadGuard.isEpochCurrent(contextEpoch)) return;
  if (parallelObjectLoad) {
    if (schemasLoaded && needsSchema.value && selectedSchema.value !== schemaBeforeSchemas) {
      await loadObjects({ allowCached: true });
    }
    return;
  }
  await loadObjects({ allowCached: options?.allowCachedObjects, preserveExistingRows: options?.preserveExistingRows });
}

useDatabaseBrowserMutation(({ connectionId, database, operation }) => {
  if (connectionId === props.connection.id && database === props.database && !props.catalog && operation !== "drop-database") refresh();
});

function refresh(): boolean {
  void reload({ preserveExistingRows: true });
  void refreshActiveTableInfo();
  return true;
}

function onSchemaChange(value: any) {
  selectedSchema.value = typeof value === "string" && value ? value : undefined;
  emit("schemaChange", selectedSchema.value);
  userHasSelectedFilter.value = false;
  objectFilter.value = initialObjectBrowserFilter();
  void loadObjects();
}

function filterCount(filter: ObjectFilter) {
  return objectSearchSummary.value.counts[filter];
}

function filterLabel(filter: ObjectFilter) {
  if (filter === "indexes") return usesServerObjectPaging.value ? t("tree.indexes") : `${t("tree.indexes")} ${filterCount(filter)}`;
  const key =
    filter === "tables"
      ? isMongodb.value
        ? "objects.collections"
        : "objects.tables"
      : filter === "views"
        ? "objects.views"
        : filter === "materializedViews"
          ? "tree.materializedViews"
          : filter === "procedures"
            ? "objects.procedures"
            : filter === "functions"
              ? "objects.functions"
              : filter === "triggers"
                ? "tree.triggers"
                : filter === "events"
                  ? "tree.events"
                  : filter === "sequences"
                    ? "objects.sequences"
                    : filter === "packages"
                      ? "objects.packages"
                      : filter === "types"
                        ? "tree.types"
                        : "objects.all";
  return usesServerObjectPaging.value ? t(key) : `${t(key)} ${filterCount(filter)}`;
}

function selectObjectFilter(filter: ObjectFilter) {
  if (filter === objectFilter.value) return;
  const wasServerPaged = usesServerObjectPaging.value;
  userHasSelectedFilter.value = true;
  objectFilter.value = filter;
  emit("filterChange", filter);
  if (wasServerPaged || usesServerObjectPaging.value) void loadObjects();
}

watch(
  () => props.selectedObjectFilter ?? props.initialObjectFilter,
  (filter) => {
    if (filter && (filter === "indexes" || objectFilter.value === "indexes")) selectObjectFilter(filter);
  },
);

function getSearchInput(): HTMLInputElement | null {
  return rootRef.value?.querySelector<HTMLInputElement>("[data-object-search-input]") ?? null;
}

function focusSearch(target: Element | null = null): boolean {
  const tableInfoPanel = target?.closest<HTMLElement>("[data-object-table-info-panel]");
  if (tableInfoPanel) {
    const input = tableInfoPanel.querySelector<HTMLInputElement>("[data-table-info-search]");
    if (input) {
      input.focus();
      input.select();
      return true;
    }
  }
  const input = getSearchInput();
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

function onSearchKeydown(event: KeyboardEvent) {
  if (!isCancelSearchShortcut(event)) return;
  event.preventDefault();
  clearObjectSearch();
}

function clearObjectSearch() {
  search.value = "";
  getSearchInput()?.focus();
}

function matchesRefreshScope(scope: { schema?: string; catalog?: string }): boolean {
  return (selectedSchema.value || "") === (scope.schema || "") && (props.catalog || "") === (scope.catalog || "");
}

defineExpose({ focusSearch, refresh, matchesRefreshScope });

onBeforeUnmount(() => {
  indexParentGuard.bump();
  objectBrowserUnmounted = true;
  invalidObjectsDialogGeneration++;
  invalidObjectSourceRequestGeneration++;
  clearTimeout(objectSearchTimer);
  sidePanelGuard.bump();
  objectBrowserRowsLoadGuard.invalidate();
  schemaListLoadGuard.invalidate();
  stopColumnResize?.();
});

watch(
  () => connectionStore.metadataGenerationFor?.(props.connection.id, props.database),
  () => {
    clearTimeout(objectSearchTimer);
    objectBrowserRowsLoadGuard.invalidate();
    schemaListLoadGuard.invalidate();
    closeSidePanel();
    selectedRowId.value = null;
    loadingSchemas.value = false;
    loadingObjects.value = false;
    loadingMoreObjects.value = false;
    refreshingObjects.value = false;
  },
);

watch(
  [() => props.connection.id, () => props.database, () => props.schema, () => props.catalog],
  async () => {
    objectBrowserRowsLoadGuard.invalidate();
    const contextEpoch = schemaListLoadGuard.invalidate();
    selectedSchema.value = props.schema;
    userHasSelectedFilter.value = false;
    objectFilter.value = initialObjectBrowserFilter();
    clearTableSelection();
    selectedRowId.value = null;
    // Close side panel and invalidate any pending source/table-info requests
    // so stale results from the old context don't overwrite new state.
    closeSidePanel();
    sourceRow.value = null;
    sourceContent.value = "";
    sourceError.value = "";
    sourceLoading.value = false;
    sourceEditing.value = false;
    sourceSaving.value = false;
    try {
      // 被动唤醒（挂载/切上下文）：用户显式关掉的连接交给缓存对象列表与「刷新」按钮，
      // 不在这里把它连回来。
      await connectionStore.ensureConnected(props.connection.id, { skipIfClosedByUser: true });
    } catch (e) {
      console.warn("[DBX] ensureConnected failed for", props.connection.id, e);
    }
    if (!schemaListLoadGuard.isEpochCurrent(contextEpoch)) return;
    void reload({ allowCachedObjects: true, contextEpoch });
  },
  { immediate: true },
);

// ---- CustomContextMenu helpers ----
watch(() => props.propertyRequest?.requestId, openRequestedProperties, { immediate: true, flush: "post" });

function exportDataSubmenu(item: ObjectBrowserRow): ContextMenuItem {
  const formats: ContextMenuItem[] = [
    { label: "CSV", action: () => exportData(item, "csv") },
    { label: "JSON", action: () => exportData(item, "json") },
  ];
  if (!isVictoriaMetrics.value && !mysqlDataCharsetEnabled(props.connection)) {
    formats.push({ label: "SQL INSERT", action: () => exportData(item, "sql", "source") });
    formats.push({ sidebarActionId: "contextMenu.standardSqlInsert", label: t("contextMenu.standardSqlInsert"), action: () => exportData(item, "sql", "standard") });
  }
  formats.push({ label: "XLSX", action: () => exportDataXlsx(item) });
  return {
    sidebarActionId: "contextMenu.exportData",
    label: t("contextMenu.exportData"),
    icon: Upload,
    children: formats,
  };
}

function objectBrowserTableClipboardMenuState(item: ObjectBrowserRow) {
  return tableClipboardMenuState(
    normalizedObjectBrowserTableClipboardEntries(),
    {
      connectionId: props.connection.id,
      database: props.database,
      schema: normalizeObjectBrowserTableClipboardSchema(item.schema || selectedSchema.value),
      tableName: item.name,
    },
    canTransferTableClipboard(),
  );
}

function tableClipboardMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  if (isVictoriaMetrics.value) return [];
  const copyItem: ContextMenuItem = { sidebarActionId: "contextMenu.copyTable", label: t("contextMenu.copyTable"), action: () => copySingleTableToClipboard(item), icon: Copy };
  const state = objectBrowserTableClipboardMenuState(item);
  if (state === "copy") return [copyItem];
  const pasteItem: ContextMenuItem = { sidebarActionId: "contextMenu.pasteTable", label: t("contextMenu.pasteTable"), action: openPasteTableDialog, icon: Clipboard };
  return state === "paste" ? [pasteItem] : [copyItem, pasteItem];
}

function isSelectedBatchTableContext(item: ObjectBrowserRow): boolean {
  return selectedTableCount.value > 1 && selectedTableIds.value.has(item.id);
}

function addToAiMenuItem(item: ObjectBrowserRow): ContextMenuItem {
  const useBatch = isSelectedBatchTableContext(item);
  const count = selectedTableCount.value;
  // Schema stays per-row: the consumer (App.vue addToAi) resolves the final
  // schema with its own fallback chain (table.schema || tab.schema — no
  // database fallback, mirroring the sidebar tree path). ObjectBrowser is a
  // single-schema view, but keeping row-level schemas makes the payload honest
  // and future-proof if multi-schema selection ever appears.
  const targets = useBatch ? selectedTableRows.value.map((row) => ({ name: row.name, schema: row.schema })) : [{ name: item.name, schema: item.schema }];
  return {
    sidebarActionId: "contextMenu.addToAi",
    label: useBatch ? t("contextMenu.addToAiMultiple", { count }) : t("contextMenu.addToAi"),
    action: () => emit("addToAi", targets),
    icon: Sparkles,
  };
}

function selectedBatchTableCountLabel(key: "batchDrop" | "batchTruncate" | "batchEmpty"): string {
  return t(`contextMenu.${key}`, { count: selectedTableCount.value });
}

function getTableMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  if (effectiveDatabaseType.value === "nebula") {
    return [
      { sidebarActionId: "contextMenu.viewData", label: t("contextMenu.viewData"), action: () => openViewData(item), icon: Table2 },
      { sidebarActionId: "contextMenu.viewDdl", label: t("contextMenu.viewDdl"), action: () => openTableInfo(item, "ddl"), icon: FileCode },
      { label: "", separator: true },
      { sidebarActionId: "contextMenu.copyName", label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
    ];
  }
  if (isVictoriaMetrics.value) {
    return [
      { sidebarActionId: "contextMenu.viewData", label: t("contextMenu.viewData"), action: () => openViewData(item), icon: Table2 },
      { sidebarActionId: "contextMenu.newQuery", label: t("contextMenu.newQuery"), action: () => openNewQuery(item), icon: TerminalSquare },
      ...(supportsAiAssistantContext(effectiveDatabaseType.value) ? [addToAiMenuItem(item)] : []),
      { label: "", separator: true },
      exportDataSubmenu(item),
      { label: "", separator: true },
      { sidebarActionId: "contextMenu.copyName", label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
    ];
  }
  const useBatchActions = isSelectedBatchTableContext(item);
  const moreActions: ContextMenuItem[] = [];
  if (supportsVacuumTable.value && (!useBatchActions || hasSelectedTablesOnly.value)) {
    moreActions.push({ sidebarActionId: "contextMenu.vacuumTable", label: t("contextMenu.vacuumTable"), action: () => requestVacuumTable(item), icon: Activity, variant: "destructive" as const });
  }
  if (supportsTruncateTable.value && (!useBatchActions || hasSelectedTablesOnly.value)) {
    moreActions.push({
      sidebarActionId: "contextMenu.truncateTable",
      label: useBatchActions ? selectedBatchTableCountLabel("batchTruncate") : t("contextMenu.truncateTable"),
      action: useBatchActions ? requestBatchTruncateTables : () => requestTruncateTable(item),
      icon: Scissors,
      variant: "destructive" as const,
    });
  }
  if (!useBatchActions || hasSelectedTablesOnly.value) {
    moreActions.push({
      sidebarActionId: "contextMenu.emptyTable",
      label: useBatchActions ? selectedBatchTableCountLabel("batchEmpty") : t("contextMenu.emptyTable"),
      action: useBatchActions ? requestBatchEmptyTables : () => requestEmptyTable(item),
      icon: Eraser,
      variant: "destructive" as const,
    });
  }
  moreActions.push({
    sidebarActionId: "contextMenu.dropTable",
    label: useBatchActions ? selectedBatchTableCountLabel("batchDrop") : t("contextMenu.dropTable"),
    action: useBatchActions ? requestBatchDropTables : () => requestDrop(item),
    icon: Trash2,
    variant: "destructive" as const,
  });
  return [
    { sidebarActionId: "contextMenu.viewData", label: t("contextMenu.viewData"), action: () => openViewData(item), icon: Table2 },
    {
      sidebarActionId: "contextMenu.viewDdl",
      label: t("contextMenu.viewDdl"),
      action: () => openTableInfo(item, "ddl"),
      icon: FileCode,
    },
    ...(canOpenStructureEditor.value ? [{ sidebarActionId: "contextMenu.editStructure", label: t("contextMenu.editStructure"), action: () => openStructureEditor(item), icon: PencilRuler }] : []),
    ...(canRename(item) ? [{ sidebarActionId: "contextMenu.renameObject", label: t("contextMenu.renameObject"), action: () => requestRename(item), icon: Pencil }] : []),
    { sidebarActionId: "contextMenu.newQuery", label: t("contextMenu.newQuery"), action: () => openNewQuery(item), icon: TerminalSquare },
    ...(supportsAiAssistantContext(effectiveDatabaseType.value) ? [addToAiMenuItem(item)] : []),
    ...(canOpenDiagram.value ? [{ sidebarActionId: "diagram.open", label: t("diagram.open"), action: () => openDiagram(item), icon: Network }] : []),
    ...(canOpenTableImport.value ? [{ sidebarActionId: "contextMenu.importData", label: t("contextMenu.importData"), action: () => openTableImport(item), icon: Download }] : []),
    { sidebarActionId: "dataCompare.title", label: t("dataCompare.title"), action: () => openDataCompare(item), icon: ArrowRightLeft },
    { label: "", separator: true },
    exportDataSubmenu(item),
    { sidebarActionId: "contextMenu.exportDatabase", label: t("contextMenu.exportDatabase"), action: () => openDatabaseExport(item), icon: Upload },
    { sidebarActionId: "contextMenu.exportStructure", label: t("contextMenu.exportStructure"), action: () => exportStructure(item), icon: FileCode },
    ...(canOpenDataDictionary.value ? [{ sidebarActionId: "dataDictionary.title", label: t("dataDictionary.title"), action: () => openDataDictionary(item), icon: FileText }] : []),
    { label: "", separator: true },
    { sidebarActionId: "contextMenu.duplicateStructure", label: t("contextMenu.duplicateStructure"), action: () => requestCopyAsNewTable(item), icon: CopyPlus },
    ...tableClipboardMenuItems(item),
    { label: "", separator: true },
    { sidebarActionId: "common.more", label: t("common.more"), icon: ListTree, children: moreActions },
    { label: "", separator: true },
    { sidebarActionId: "contextMenu.copyName", label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
  ];
}

function getViewMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  if (effectiveDatabaseType.value === "nebula") {
    return [
      { sidebarActionId: "contextMenu.viewData", label: t("contextMenu.viewData"), action: () => openViewData(item), icon: Table2 },
      { sidebarActionId: "contextMenu.viewDdl", label: t("contextMenu.viewDdl"), action: () => openTableInfo(item, "ddl"), icon: ScrollText },
      { label: "", separator: true },
      { sidebarActionId: "contextMenu.copyName", label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
    ];
  }
  return [
    { sidebarActionId: "contextMenu.viewData", label: t("contextMenu.viewData"), action: () => openViewData(item), icon: Table2 },
    { sidebarActionId: "contextMenu.editView", label: t("contextMenu.editView"), action: () => openSource(item), icon: PencilLine },
    { sidebarActionId: "contextMenu.viewSource", label: t("contextMenu.viewSource"), action: () => openSource(item), icon: Code2 },
    ...(effectiveDatabaseType.value === "dameng" && item.type === "VIEW" && buildDamengCompileViewSql({ schema: item.schema || selectedSchema.value, name: item.name })
      ? [{ sidebarActionId: "contextMenu.compileObject", label: t("contextMenu.compileObject"), action: () => compileDamengView(item), icon: Wrench }]
      : []),
    {
      sidebarActionId: "contextMenu.viewDdl",
      label: t("contextMenu.viewDdl"),
      action: () => openTableInfo(item, "ddl"),
      icon: ScrollText,
    },
    ...(canRename(item) ? [{ sidebarActionId: "contextMenu.renameObject", label: t("contextMenu.renameObject"), action: () => requestRename(item), icon: Pencil }] : []),
    { sidebarActionId: "contextMenu.newQuery", label: t("contextMenu.newQuery"), action: () => openNewQuery(item), icon: TerminalSquare },
    ...(canOpenDiagram.value ? [{ sidebarActionId: "diagram.open", label: t("diagram.open"), action: () => openDiagram(item), icon: Network }] : []),
    { label: "", separator: true },
    exportDataSubmenu(item),
    { sidebarActionId: "contextMenu.exportDatabase", label: t("contextMenu.exportDatabase"), action: () => openDatabaseExport(item), icon: Upload },
    { sidebarActionId: "contextMenu.exportStructure", label: t("contextMenu.exportStructure"), action: () => exportStructure(item), icon: FileCode },
    ...(canOpenDataDictionary.value ? [{ sidebarActionId: "dataDictionary.title", label: t("dataDictionary.title"), action: () => openDataDictionary(item), icon: FileText }] : []),
    { label: "", separator: true },
    {
      sidebarActionId: "contextMenu.dropView",
      label: t("contextMenu.dropView"),
      action: () => requestDrop(item),
      icon: Trash2,
      variant: "destructive" as const,
    },
    { label: "", separator: true },
    { sidebarActionId: "contextMenu.copyName", label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
  ];
}

function getProcFuncMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  return [
    ...(supportsPlDebugRoutine(effectiveDatabaseType.value)
      ? [
          {
            label: t("plDebug.start.title"),
            icon: Play,
            action: () => {
              void launchPlDebug({ connectionId: props.connection.id, database: props.database, databaseType: effectiveDatabaseType.value, schema: item.schema ?? selectedSchema.value, objectType: item.type, objectName: item.name, valid: item.valid });
            },
          },
        ]
      : []),
    ...(item.type === "PROCEDURE" ? [{ label: t("contextMenu.executeProcedure"), action: () => openProcedureExecution(item), icon: Play }] : []),
    ...(effectiveDatabaseType.value === "xugu" && buildXuguCompileSql({ objectType: item.type, schema: item.schema || selectedSchema.value, name: item.name }) ? [{ label: t("contextMenu.compileObject"), action: () => compileXuguObject(item), icon: Wrench }] : []),
    { sidebarActionId: "contextMenu.editObject", label: t("contextMenu.editObject"), action: () => openSource(item), icon: PencilLine },
    { sidebarActionId: "contextMenu.viewSource", label: t("contextMenu.viewSource"), action: () => openSource(item), icon: Code2 },
    ...(canRename(item) ? [{ label: t("contextMenu.renameObject"), action: () => requestRename(item), icon: Pencil }] : []),
    { label: "", separator: true },
    {
      label: item.type === "PROCEDURE" ? t("contextMenu.dropProcedure") : t("contextMenu.dropFunction"),
      action: () => requestDrop(item),
      icon: Trash2,
      variant: "destructive" as const,
    },
    { label: "", separator: true },
    { label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
  ];
}

function getTriggerMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  const metadata = exactOracleTriggerMetadata(item.trigger);
  if (!metadata) return getPackageMenuItems(item);
  const enabled = metadata.reads.enabled?.state === "available" ? item.trigger?.enabled : undefined;
  const databaseType = metadata.engine === "dm" ? "dameng" : metadata.engine;
  return [
    { sidebarActionId: "contextMenu.editObject", label: t("contextMenu.editObject"), action: () => openSource(item), icon: PencilLine },
    { sidebarActionId: "contextMenu.viewSource", label: t("contextMenu.viewSource"), action: () => openSource(item), icon: Code2 },
    { label: "", separator: true },
    ...(enabled !== true ? [{ label: t("contextMenu.enableTrigger"), action: () => runBrowserTriggerAction(item, "enable"), icon: Play, disabled: browserTriggerBusy.value }] : []),
    ...(enabled !== false ? [{ label: t("contextMenu.disableTrigger"), action: () => runBrowserTriggerAction(item, "disable"), icon: CircleX, disabled: browserTriggerBusy.value }] : []),
    ...(!oracleCompileUnsupportedReason(databaseType, "TRIGGER", { triggerProfile: metadata }) ? [{ label: t("contextMenu.compileObject"), action: () => runBrowserTriggerAction(item, "compile"), icon: Wrench, disabled: browserTriggerBusy.value }] : []),
    { label: "", separator: true },
    { label: t("contextMenu.dropTrigger"), action: () => requestDrop(item), icon: Trash2, variant: "destructive" as const, disabled: browserTriggerBusy.value },
    { label: "", separator: true },
    { label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
  ];
}

function getEventMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  return [
    { label: t("contextMenu.editObject"), action: () => openEventEditor(item), icon: PencilLine },
    { label: t("contextMenu.viewSource"), action: () => openSource(item), icon: Code2 },
    { label: "", separator: true },
    { label: t("contextMenu.dropObject"), action: () => requestDrop(item), icon: Trash2, variant: "destructive" as const },
    { label: "", separator: true },
    { label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
  ];
}

function getPackageMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  return [
    ...((effectiveDatabaseType.value === "oracle" || effectiveDatabaseType.value === "oceanbase-oracle") && (item.type === "PACKAGE" || item.type === "PACKAGE_BODY") ? [{ label: t("objects.packageSaveAsTitle"), action: () => requestPackageSaveAs(item), icon: CopyPlus }] : []),
    ...(effectiveDatabaseType.value === "xugu" && buildXuguCompileSql({ objectType: item.type, schema: item.schema || selectedSchema.value, name: item.name }) ? [{ label: t("contextMenu.compileObject"), action: () => compileXuguObject(item), icon: Wrench }] : []),
    { sidebarActionId: "contextMenu.editObject", label: t("contextMenu.editObject"), action: () => openSource(item), icon: PencilLine },
    { sidebarActionId: "contextMenu.viewSource", label: t("contextMenu.viewSource"), action: () => openSource(item), icon: Code2 },
    { label: "", separator: true },
    { label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
  ];
}

function getTypeMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const capabilities = customTypeCapabilities(effectiveDatabaseType.value);
  // Oracle-family types expose source alongside read-only TYPE details; Xugu
  // keeps its source entry for TYPE/TYPE_BODY rows.
  if (supportsTypeObjectSource(effectiveDatabaseType.value)) {
    items.push({ label: t("contextMenu.viewSource"), action: () => openSource(item), icon: Code2 });
  }
  if (supportsOracleFamilyTypeManagement(effectiveDatabaseType.value)) {
    items.push({ label: t("contextMenu.editObject"), action: () => openSourceTab(item), icon: PencilLine });
    items.push({ label: t("contextMenu.dropObject"), action: () => requestDrop(item), icon: Trash2, variant: "destructive" });
  }
  if (capabilities.details && item.type === "TYPE") {
    items.push({ label: t("contextMenu.viewDetails"), action: () => void openTypeInfo(item), icon: Info });
    if (capabilities.ddl) {
      items.push({ label: t("contextMenu.viewDdl"), action: () => openTypeDdl(item), icon: FileCode });
    }
  }
  // Only separate when an action precedes copy-name.
  if (items.length > 0) {
    items.push({ label: "", separator: true });
  }
  items.push({ label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy });
  return items;
}

function getObjectBrowserActionMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  if (item.type === "INDEX") {
    const target = schemaIndexIdentity(item);
    const writable = supportsSchemaIndexes.value && schemaIndexIsSameOwner(target) && !connectionIsEffectivelyReadOnly(props.connection);
    const multiple = selectedTableCount.value > 1 && selectedTableIds.value.has(item.id);
    return [
      ...(target ? [{ label: t("contextMenu.viewDetails"), action: () => void openTableInfo(item, "indexes"), icon: Info }] : [{ label: t("schemaIndex.parentUnavailable"), disabled: true }]),
      ...(writable
        ? [
            { label: t("contextMenu.editStructure"), action: () => openSchemaIndexEditor(item), icon: PencilRuler },
            { label: t(multiple ? "schemaIndex.editIndividually" : "contextMenu.dropIndex"), action: () => (multiple ? toast(t("schemaIndex.editIndividually"), 4000) : openSchemaIndexEditor(item, "delete")), icon: Trash2, variant: "destructive" as const },
          ]
        : []),
      { label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
      {
        label: t("grid.refresh"),
        action: () => {
          refresh();
        },
        icon: RefreshCw,
      },
    ];
  }
  if (isMongodb.value) {
    return [
      { label: t("contextMenu.viewData"), action: () => openViewData(item), icon: Table2 },
      { label: "", separator: true },
      { label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
    ];
  }
  if (item.type === "TABLE") return getTableMenuItems(item);
  if (item.type === "VIEW" || item.type === "MATERIALIZED_VIEW") return getViewMenuItems(item);
  if (item.type === "EVENT") return getEventMenuItems(item);
  if (item.type === "TYPE" || item.type === "TYPE_BODY") return getTypeMenuItems(item);
  if (item.type === "TRIGGER") return getTriggerMenuItems(item);
  if (isSourceOnlyObjectBrowserRow(item)) return getPackageMenuItems(item);
  return getProcFuncMenuItems(item);
}

function getObjectBrowserMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  const items = getObjectBrowserActionMenuItems(item);
  if (item.type === "TABLE" || item.type === "VIEW" || item.type === "MATERIALIZED_VIEW") {
    items.push(
      { label: "", separator: true },
      createLocateTabMenuItem({
        t,
        visible: true,
        onLocate: () => emit("locateTable", { tableName: item.name, schema: item.schema, tableType: objectBrowserOpenTableType(item), catalog: props.catalog }),
      }),
    );
  }
  return item.type === "TABLE" || item.type === "VIEW" || item.type === "MATERIALIZED_VIEW" ? presentMenu(items, item.type === "TABLE" ? "table" : "view") : items;
}
</script>

<template>
  <DangerConfirmDialog
    v-model:open="cloneDialogOpen"
    :title="t(cloneDialogState?.failure ? 'oceanbaseCloneDialog.failed' : 'oceanbaseCloneDialog.title')"
    :message="t(cloneDialogState?.failure ? 'oceanbaseCloneDialog.failedMessage' : 'oceanbaseCloneDialog.message')"
    :details-text="cloneDialogState?.summary"
    :details="cloneDialogState?.details"
    :details-label="t('oceanbaseCloneDialog.details')"
    :show-cancel="!cloneDialogState?.failure"
    :confirm-label="cloneDialogState?.failure ? t('oceanbaseCloneDialog.close') : undefined"
    :close-on-confirm="false"
    @confirm="cloneDialog.confirm"
  />
  <FirebirdObjectManager v-if="effectiveDatabaseType === 'firebird'" v-model:open="firebirdManagerOpen" :connection-id="connection.id" :database="database" />
  <ObjectSourceDialog
    v-if="triggerCreateContext"
    :key="JSON.stringify(triggerCreateContext)"
    ref="triggerCreateDialog"
    v-model:open="triggerCreateOpen"
    :connection-id="triggerCreateContext.connectionId"
    :database="triggerCreateContext.database"
    :catalog="triggerCreateContext.catalog"
    :schema="triggerCreateContext.schema"
    :execution-schema="triggerCreateContext.schema"
    :database-type="triggerCreateContext.databaseType"
    name="TRG_NEW"
    object-type="TRIGGER"
    :dialect="codeMirrorSqlDialect(triggerCreateContext.databaseType)"
    :format-dialect="sqlFormatDialectForDbType(triggerCreateContext.databaseType)"
    :create-trigger="{ scope: 'TABLE' }"
    initial-editing
    @saved="refreshCreatedTrigger"
  />
  <OracleInvalidObjectsDialog
    v-if="oracleInvalidObjectsSupported || invalidTriggerContext"
    :open="oracleInvalidObjectsOpen && (!invalidTriggerContext || sidePanelGuard.isFresh(invalidTriggerContext.originRevision))"
    :connection="connection"
    :database="database"
    :schema="selectedSchema || database"
    :trigger-context="invalidTriggerContext"
    @update:open="setOracleInvalidObjectsOpen"
    @open-source="openInvalidObjectSource"
    @compile-finished="refreshAfterInvalidObjectCompile"
    @trigger-result="
      (target, result, before, _tabId, revision) => {
        if (revision === undefined || sidePanelGuard.isFresh(revision)) mergeBrowserTriggerSnapshot(target, result.snapshot, before, !result.cancelled && result.steps.every((step) => step.state === 'committed'));
      }
    "
  />
  <div ref="rootRef" data-object-browser-root class="flex h-full min-h-0 min-w-0 flex-col bg-background outline-none" tabindex="0" @keydown="onObjectBrowserKeydown">
    <SidebarMenuPreferencesDialog v-if="sidebarMenuPreferences" v-model:open="sidebarMenuPreferencesOpen" :scope="sidebarMenuPreferences.scope" :items="sidebarMenuPreferences.items" />
    <div v-if="!isEventEditor" ref="toolbarRef" class="flex h-10 shrink-0 items-center gap-2 overflow-hidden border-b px-3">
      <Button v-if="effectiveDatabaseType === 'firebird'" variant="outline" size="sm" @click="firebirdManagerOpen = true">{{ t("tree.firebirdObjectManager") }}</Button>
      <Button v-if="canCreateSchemaIndex" data-create-schema-index variant="outline" size="sm" class="h-7 shrink-0 gap-1 px-2 text-xs" @click="createSchemaIndex"> <CopyPlus class="h-3.5 w-3.5" />{{ t("structureEditor.addIndex") }} </Button>
      <Button v-if="oracleInvalidObjectsSupported" variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="setOracleInvalidObjectsOpen(true)">{{ t("processList.oracleInvalidObjects.title") }}</Button>
      <div class="flex min-w-12 items-center gap-2">
        <span class="inline-flex max-w-[14rem] min-w-0 items-center rounded border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium truncate" :title="selectedSchema || props.database">
          {{ selectedSchema || props.database }}
        </span>
        <span v-if="selectedSchema && showDatabaseChip" class="inline-flex max-w-[14rem] min-w-0 items-center rounded border border-border bg-muted/30 px-2 py-0.5 text-xs text-muted-foreground truncate" :title="props.database">
          {{ props.database }}
        </span>
        <DatabaseActionsMenu :connection="connection" :database="database" :catalog="catalog" />
      </div>
      <div class="flex flex-1 items-center gap-2">
        <div class="relative min-w-[12rem] flex-1">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="search" data-object-search-input class="h-7 pl-8 pr-6 text-xs" :placeholder="isMongodb ? t('objects.searchCollections') : t('objects.search')" @keydown="onSearchKeydown" />
          <button v-if="search" type="button" class="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" :aria-label="t('common.clear')" @click="clearObjectSearch">
            <X class="h-3 w-3" />
          </button>
        </div>
        <div v-if="showObjectFilter && showInlineObjectFilter" data-object-filter-chips class="flex h-7 shrink-0 items-center rounded border bg-muted/20 p-0.5">
          <button
            v-for="filter in objectFilters"
            :key="filter"
            type="button"
            class="h-6 shrink-0 whitespace-nowrap rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            :class="{ 'bg-background text-foreground shadow-sm': objectFilter === filter }"
            @click="selectObjectFilter(filter)"
          >
            {{ filterLabel(filter) }}
          </button>
        </div>
        <span v-else-if="singleKindFilter && showInlineObjectFilter" data-object-filter-count class="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">{{ filterLabel(singleKindFilter) }}</span>
      </div>
      <SearchableSelect
        v-if="needsSchema"
        :model-value="selectedSchema || ''"
        :options="schemas"
        :placeholder="t('objects.schema')"
        :search-placeholder="t('editor.searchSchema')"
        :empty-text="t('grid.noSearchResults')"
        :loading-text="t('objects.loadingSchemas')"
        :loading="loadingSchemas"
        :disabled="loadingSchemas"
        trigger-variant="outline"
        trigger-class="h-7 w-36 max-w-36 px-2 text-xs font-normal"
        content-class="w-56"
        @update:model-value="onSchemaChange"
      />
      <Button v-if="canCreateOracleTrigger && objectFilter === 'triggers'" variant="outline" size="sm" class="h-7 shrink-0 px-2 text-xs" @click="openCreateOracleTrigger">{{ t("contextMenu.createTrigger") }}</Button>
      <!-- Sort selector -->
      <div v-if="showInlineSortAndView && !usesServerObjectPaging" class="flex h-7 shrink-0 items-center rounded border bg-muted/20 p-0.5">
        <select
          class="h-6 cursor-pointer appearance-none rounded-sm bg-transparent px-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus:text-foreground"
          :value="sortKey"
          :aria-label="t('objects.sortBy')"
          @change="onSortKeyChange(($event.target as HTMLSelectElement).value as ObjectBrowserSortKey)"
        >
          <option v-for="key in sortKeyOptions" :key="key" :value="key" class="bg-background text-foreground">
            {{ sortKeyLabel(key) }}
          </option>
        </select>
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground" :title="sortDirection === 'asc' ? t('objects.sortAsc') : t('objects.sortDesc')" @click="sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'">
          <ArrowUp v-if="sortDirection === 'asc'" class="h-3 w-3" />
          <ArrowDown v-else class="h-3 w-3" />
        </button>
      </div>
      <div v-if="showInlineSortAndView" class="flex h-7 shrink-0 items-center rounded border bg-muted/20 p-0.5">
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground" :class="{ 'bg-background text-foreground shadow-sm': isListView }" :title="t('objects.viewList')" @click="setViewMode('list')">
          <List class="h-3.5 w-3.5" />
        </button>
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground" :class="{ 'bg-background text-foreground shadow-sm': isGridView }" :title="t('objects.viewGrid')" @click="setViewMode('grid')">
          <LayoutGrid class="h-3.5 w-3.5" />
        </button>
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground" :class="{ 'bg-background text-foreground shadow-sm': isCompactView }" :title="t('objects.viewCompact')" @click="setViewMode('compact')">
          <Grid3X3 class="h-3.5 w-3.5" />
        </button>
        <select
          v-if="isCompactView"
          data-compact-width-select
          class="ml-1 h-6 shrink-0 cursor-pointer rounded-sm border-l bg-transparent px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          :value="compactCardWidth"
          :aria-label="t('objects.compactCardWidth')"
          :title="t('objects.compactCardWidth')"
          @change="setCompactCardWidth(normalizeObjectBrowserCompactWidth(Number(($event.target as HTMLSelectElement).value)))"
        >
          <option v-for="width in OBJECT_BROWSER_COMPACT_WIDTHS" :key="width" :value="width" class="bg-background text-foreground">{{ width }}px</option>
        </select>
      </div>
      <Button v-if="showInlineCheckboxToggle && supportsBatchTableActions" variant="ghost" size="icon" class="h-7 w-7" :class="{ 'text-primary': settingsStore.editorSettings.objectBrowserShowCheckbox }" :title="t('objects.toggleCheckbox')" @click="toggleCheckboxColumn">
        <CheckSquare v-if="settingsStore.editorSettings.objectBrowserShowCheckbox" class="h-3.5 w-3.5" />
        <Square v-else class="h-3.5 w-3.5" />
      </Button>
      <Button v-if="showInlineSidePanelToggle" variant="ghost" size="icon" class="h-7 w-7" :class="{ 'text-primary': isSidePanelOpen }" :title="isSidePanelOpen ? t('objects.closeDetailPanel') : t('objects.openDetailPanel')" @click="toggleSidePanel">
        <PanelRight class="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" class="h-7 w-7" :title="refreshTooltip" :disabled="loadingObjects" @click="refresh">
        <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loadingObjects || refreshingObjects }" />
      </Button>
      <Button v-if="canPasteTableClipboard()" variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="openPasteTableDialog">
        <Clipboard class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.pasteTableSelected") }}
      </Button>
      <ToolbarOverflowMenu v-if="showToolbarOverflow" :label="t('toolbar.moreActions')" button-class="h-7 w-7">
        <DropdownMenuSub v-if="!usesServerObjectPaging">
          <DropdownMenuSubTrigger>
            <ArrowDown class="h-3.5 w-3.5" />
            {{ t("objects.sortBy") }}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem v-for="key in sortKeyOptions" :key="key" @select="onSortKeyChange(key)">
              <Check v-if="sortKey === key" class="h-3.5 w-3.5" />
              {{ sortKeyLabel(key) }}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem v-if="!usesServerObjectPaging" @select="sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'">
          <ArrowUp v-if="sortDirection === 'asc'" class="h-3.5 w-3.5" />
          <ArrowDown v-else class="h-3.5 w-3.5" />
          {{ sortDirection === "asc" ? t("objects.sortDesc") : t("objects.sortAsc") }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem @select="setViewMode('list')">
          <List class="h-3.5 w-3.5" />
          {{ t("objects.viewList") }}
        </DropdownMenuItem>
        <DropdownMenuItem @select="setViewMode('grid')">
          <LayoutGrid class="h-3.5 w-3.5" />
          {{ t("objects.viewGrid") }}
        </DropdownMenuItem>
        <DropdownMenuItem @select="setViewMode('compact')">
          <Grid3X3 class="h-3.5 w-3.5" />
          {{ t("objects.viewCompact") }}
        </DropdownMenuItem>
        <DropdownMenuSub v-if="isCompactView">
          <DropdownMenuSubTrigger>{{ t("objects.compactCardWidth") }}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem v-for="width in OBJECT_BROWSER_COMPACT_WIDTHS" :key="width" @select="setCompactCardWidth(width)">
              <Check v-if="compactCardWidth === width" class="h-3.5 w-3.5" />
              {{ width }}px
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuCheckboxItem v-if="supportsBatchTableActions" :model-value="settingsStore.editorSettings.objectBrowserShowCheckbox" @select.prevent @update:model-value="toggleCheckboxColumn()">{{ t("objects.toggleCheckbox") }}</DropdownMenuCheckboxItem>
        <DropdownMenuItem @select="toggleSidePanel">
          <PanelRight class="h-3.5 w-3.5" />
          {{ isSidePanelOpen ? t("objects.closeDetailPanel") : t("objects.openDetailPanel") }}
        </DropdownMenuItem>
        <DropdownMenuCheckboxItem :model-value="settingsStore.editorSettings.objectBrowserAutoOpenDetailPanel !== false" @select.prevent @update:model-value="toggleAutoOpenDetailPanel()">{{ t("objects.autoOpenDetailPanel") }}</DropdownMenuCheckboxItem>
        <template v-if="showObjectFilter && toolbarTier >= 2">
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem v-for="filter in objectFilters" :key="filter" :model-value="objectFilter === filter" @select.prevent @update:model-value="selectObjectFilter(filter)">{{ filterLabel(filter) }} </DropdownMenuCheckboxItem>
        </template>
        <template v-else-if="singleKindFilter && toolbarTier >= 2">
          <DropdownMenuSeparator />
          <DropdownMenuLabel data-object-filter-count>{{ filterLabel(singleKindFilter) }}</DropdownMenuLabel>
        </template>
      </ToolbarOverflowMenu>
    </div>
    <div v-if="selectedTableCount > 0 && supportsBatchTableActions" class="flex h-9 shrink-0 items-center gap-2 overflow-x-auto border-b bg-muted/30 px-3 text-xs">
      <div class="min-w-0 flex-1 truncate text-muted-foreground">
        {{ t("objects.selectedTables", { count: selectedTableCount }) }}
      </div>
      <Button v-if="supportsBatchTableActions && !hasSelectedSchemaIndexes" variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="openBatchDatabaseExport">
        <Upload class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.exportSelected") }}
      </Button>
      <Button v-if="supportsBatchTableActions && !hasSelectedSchemaIndexes" variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="copySelectedTablesToClipboard">
        <Clipboard class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.copyTableSelected") }}
      </Button>
      <Button v-if="supportsBatchTableActions && supportsTruncateTable && hasSelectedTablesOnly" variant="ghost" size="sm" class="h-7 px-2 text-xs text-destructive" @click="requestBatchTruncateTables">
        <Scissors class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.truncateSelected") }}
      </Button>
      <Button v-if="supportsBatchTableActions && hasSelectedTablesOnly" variant="ghost" size="sm" class="h-7 px-2 text-xs text-destructive" @click="requestBatchEmptyTables">
        <Eraser class="mr-1.5 h-3.5 w-3.5" />
        {{ t("contextMenu.batchEmpty", { count: selectedTableCount }) }}
      </Button>
      <Button v-if="supportsBatchTableActions" variant="ghost" size="sm" class="h-7 px-2 text-xs text-destructive" @click="requestBatchDropTables">
        <Trash2 class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.dropSelected") }}
      </Button>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="clearTableSelection">
        <X class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.clearSelection") }}
      </Button>
    </div>

    <div v-if="scaffoldRefreshError" role="status" class="flex h-8 shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-3 text-xs text-destructive">
      <RefreshCw class="h-3 w-3 shrink-0" />
      <span class="min-w-0 truncate">{{ scaffoldRefreshError }}</span>
    </div>
    <div v-if="loadingObjects && !isSchemaIndexInfo" class="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" />
      {{ t("objects.loading") }}
    </div>
    <div v-else-if="error && !isSchemaIndexInfo" class="flex flex-1 items-center justify-center px-6 text-center text-sm text-destructive">
      {{ error }}
    </div>
    <div v-else-if="filteredRows.length === 0 && !isEventEditor && !isSchemaIndexInfo && !(usesServerObjectPaging && hasMoreObjects)" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {{ t("objects.empty") }}
    </div>
    <div v-else class="flex min-h-0 min-w-0 flex-1" :class="{ 'event-editor-layout': isEventEditor }">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <div v-if="isListView" class="object-browser-table flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div ref="objectListHeaderRef" class="relative h-7 shrink-0 overflow-hidden">
            <div class="grid h-7 items-center gap-3 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground" :style="{ gridTemplateColumns, minWidth: `${objectGridMinWidth}px` }">
              <div v-if="showCheckboxColumn" class="relative flex min-w-0 items-center">
                <button class="flex h-6 w-6 items-center justify-center rounded-sm hover:bg-accent" type="button" :disabled="visibleSelectableRows.length === 0" @click="toggleVisibleTableSelection">
                  <CheckSquare v-if="allVisibleTablesSelected" class="h-3.5 w-3.5 text-primary" />
                  <Square v-else class="h-3.5 w-3.5" />
                </button>
                <div class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary" @mousedown="onObjectColumnResizeStart('select', $event)" @dblclick="resetObjectColumnWidth('select', 34, $event)">
                  <GripVertical class="h-3 w-3" />
                </div>
              </div>
              <div v-if="isObjectColumnVisible('name')" class="relative flex min-w-0 items-center">
                <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" :disabled="usesServerObjectPaging" @click="toggleSort('name')">
                  <span class="truncate">{{ t("objects.name") }}</span>
                  <component :is="sortIconFor('name')" v-if="sortIconFor('name')" class="h-3 w-3 shrink-0" />
                </button>
                <div
                  v-if="!isLastVisibleObjectColumn('name')"
                  data-object-column-resize="name"
                  class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
                  @mousedown="onObjectColumnResizeStart('name', $event)"
                  @dblclick="resetObjectColumnWidth('name', 260, $event)"
                >
                  <GripVertical class="h-3 w-3" />
                </div>
              </div>
              <div v-if="isObjectColumnVisible('type')" class="relative flex min-w-0 items-center">
                <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" :disabled="usesServerObjectPaging" @click="toggleSort('type')">
                  <span class="truncate">{{ t("objects.type") }}</span>
                  <component :is="sortIconFor('type')" v-if="sortIconFor('type')" class="h-3 w-3 shrink-0" />
                </button>
                <div
                  v-if="!isLastVisibleObjectColumn('type')"
                  data-object-column-resize="type"
                  class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
                  @mousedown="onObjectColumnResizeStart('type', $event)"
                  @dblclick="resetObjectColumnWidth('type', 110, $event)"
                >
                  <GripVertical class="h-3 w-3" />
                </div>
              </div>
              <div v-if="showObjectRowStats && isObjectColumnVisible('estimatedRows')" class="relative flex min-w-0 items-center">
                <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" :disabled="usesServerObjectPaging" :title="t('objects.statisticsHint')" @click="toggleSort('estimatedRows')">
                  <span class="truncate">{{ objectRowsLabel }}</span>
                  <component :is="sortIconFor('estimatedRows')" v-if="sortIconFor('estimatedRows')" class="h-3 w-3 shrink-0" />
                </button>
                <div
                  v-if="!isLastVisibleObjectColumn('estimatedRows')"
                  data-object-column-resize="estimatedRows"
                  class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
                  @mousedown="onObjectColumnResizeStart('estimatedRows', $event)"
                  @dblclick="resetObjectColumnWidth('estimatedRows', 110, $event)"
                >
                  <GripVertical class="h-3 w-3" />
                </div>
              </div>
              <div v-if="showObjectSizeStats && isObjectColumnVisible('totalBytes')" class="relative flex min-w-0 items-center">
                <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" :disabled="usesServerObjectPaging" :title="t('objects.statisticsHint')" @click="toggleSort('totalBytes')">
                  <span class="truncate">{{ t("objects.size") }}</span>
                  <component :is="sortIconFor('totalBytes')" v-if="sortIconFor('totalBytes')" class="h-3 w-3 shrink-0" />
                </button>
                <div
                  v-if="!isLastVisibleObjectColumn('totalBytes')"
                  data-object-column-resize="totalBytes"
                  class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
                  @mousedown="onObjectColumnResizeStart('totalBytes', $event)"
                  @dblclick="resetObjectColumnWidth('totalBytes', 100, $event)"
                >
                  <GripVertical class="h-3 w-3" />
                </div>
              </div>
              <div v-if="hasCreatedAt && isObjectColumnVisible('created_at')" class="relative flex min-w-0 items-center">
                <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" :disabled="usesServerObjectPaging" @click="toggleSort('created_at')">
                  <span class="truncate">{{ t("objects.createdAt") }}</span>
                  <component :is="sortIconFor('created_at')" v-if="sortIconFor('created_at')" class="h-3 w-3 shrink-0" />
                </button>
                <div
                  v-if="!isLastVisibleObjectColumn('created_at')"
                  data-object-column-resize="created_at"
                  class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
                  @mousedown="onObjectColumnResizeStart('created_at', $event)"
                  @dblclick="resetObjectColumnWidth('created_at', 150, $event)"
                >
                  <GripVertical class="h-3 w-3" />
                </div>
              </div>
              <div v-if="hasUpdatedAt && isObjectColumnVisible('updated_at')" class="relative flex min-w-0 items-center">
                <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" :disabled="usesServerObjectPaging" @click="toggleSort('updated_at')">
                  <span class="truncate">{{ t("objects.updatedAt") }}</span>
                  <component :is="sortIconFor('updated_at')" v-if="sortIconFor('updated_at')" class="h-3 w-3 shrink-0" />
                </button>
                <div
                  v-if="!isLastVisibleObjectColumn('updated_at')"
                  data-object-column-resize="updated_at"
                  class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
                  @mousedown="onObjectColumnResizeStart('updated_at', $event)"
                  @dblclick="resetObjectColumnWidth('updated_at', 150, $event)"
                >
                  <GripVertical class="h-3 w-3" />
                </div>
              </div>
              <div v-if="isObjectColumnVisible('comment')" class="relative flex min-w-0 items-center">
                <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" :disabled="usesServerObjectPaging" @click="toggleSort('comment')">
                  <span class="truncate">{{ t("objects.comment") }}</span>
                  <component :is="sortIconFor('comment')" v-if="sortIconFor('comment')" class="h-3 w-3 shrink-0" />
                </button>
                <div
                  v-if="!isLastVisibleObjectColumn('comment')"
                  data-object-column-resize="comment"
                  class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
                  @mousedown="onObjectColumnResizeStart('comment', $event)"
                  @dblclick="resetObjectColumnWidth('comment', 260, $event)"
                >
                  <GripVertical class="h-3 w-3" />
                </div>
              </div>
            </div>
            <Popover>
              <PopoverTrigger as-child>
                <button type="button" class="absolute right-1 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" :title="t('objects.configureColumns')" :aria-label="t('objects.configureColumns')">
                  <Settings2 class="h-3.5 w-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" class="w-52 p-1">
                <div class="px-2 py-1.5 text-xs font-medium text-foreground">{{ t("objects.configureColumns") }}</div>
                <button v-for="column in objectColumnDefinitions" :key="column.key" type="button" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent" :disabled="column.key === 'name'" @click="toggleObjectColumnVisibility(column.key)">
                  <span class="flex h-4 w-4 items-center justify-center rounded border" :class="isObjectColumnVisible(column.key) ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-transparent'"><Check class="h-3 w-3 stroke-[3]" /></span>
                  <span class="truncate">{{ column.label }}</span>
                </button>
              </PopoverContent>
            </Popover>
          </div>
          <RecycleScroller ref="listScrollerRef" class="object-browser-scroller min-h-0 flex-1" :style="{ '--dbx-object-grid-min-width': `${objectGridMinWidth}px` }" :items="filteredRows" :item-size="34" :buffer="600" :skip-hover="true" key-field="id">
            <template #default="{ item }">
              <CustomContextMenu :items="() => getObjectBrowserMenuItems(item)" v-slot="{ onContextMenu, isOpen }">
                <div
                  class="grid h-[34px] cursor-default items-center gap-3 border-b px-3"
                  :class="{
                    'bg-accent text-accent-foreground': isOpen || sourceRow?.id === item.id || sidePanelRow?.id === item.id || selectedRowId === item.id || selectedTableIds.has(item.id),
                    'hover:bg-accent/40': !isOpen && sourceRow?.id !== item.id && sidePanelRow?.id !== item.id && selectedRowId !== item.id && !selectedTableIds.has(item.id),
                  }"
                  :style="{ gridTemplateColumns, boxShadow: (sidePanelRow?.id === item.id || selectedRowId === item.id) && !selectedTableIds.has(item.id) ? 'inset 3px 0 0 var(--primary)' : undefined }"
                  @click="onRowClick(item, $event)"
                  @contextmenu="onContextMenu"
                >
                  <button v-if="showCheckboxColumn" class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" type="button" @click.stop="toggleTableSelection(item)">
                    <CheckSquare v-if="selectedTableIds.has(item.id)" class="h-3.5 w-3.5 text-primary" />
                    <Square v-else class="h-3.5 w-3.5" />
                  </button>
                  <div class="flex min-w-0 items-center gap-2">
                    <span v-if="partitionRowDepth(item) > 0" :data-partition-depth="partitionRowDepth(item)" :style="{ width: `${partitionRowDepth(item) * PARTITION_TREE_INDENT_PX}px` }" class="h-5 shrink-0" aria-hidden="true" />
                    <button
                      v-if="item.partitionCount"
                      type="button"
                      class="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                      :aria-label="t('objects.partitions', { count: item.partitionCount })"
                      @click.stop="togglePartitionParent(item)"
                    >
                      <ChevronDown v-if="isPartitionParentExpanded(item)" class="h-3.5 w-3.5" />
                      <ChevronRight v-else class="h-3.5 w-3.5" />
                    </button>
                    <span v-else-if="item.partitionParentId" class="h-5 w-5 shrink-0" />
                    <span class="relative flex h-3.5 w-3.5 shrink-0" :class="{ 'overflow-visible': item.valid === false }">
                      <component :is="iconFor(item)" class="h-3.5 w-3.5 shrink-0" :class="iconClass(item.type)" />
                      <CircleX v-if="item.valid === false" data-invalid-object-indicator="true" class="pointer-events-none absolute -right-1 -bottom-1 h-2.5 w-2.5 rounded-full bg-background text-destructive stroke-[3]" aria-hidden="true" />
                    </span>
                    <span class="truncate text-[13px] font-medium text-foreground" :title="item.displayName">{{ item.displayName }}</span>
                    <span v-if="item.partitionCount" class="shrink-0 rounded border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                      {{ t("objects.partitions", { count: item.partitionCount }) }}
                    </span>
                  </div>
                  <div v-if="isObjectColumnVisible('type')" class="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
                    <span class="truncate">{{ typeLabel(item) }}</span>
                    <span v-if="item.valid != null" class="shrink-0 rounded border px-1 py-px text-[10px] font-medium" :class="item.valid ? 'border-emerald-500/30 text-emerald-600' : 'border-destructive/30 text-destructive'">
                      {{ t(item.valid ? "objects.validStatus" : "objects.invalidStatus") }}
                    </span>
                  </div>
                  <div v-if="showObjectRowStats && isObjectColumnVisible('estimatedRows')" class="truncate text-xs tabular-nums text-muted-foreground" :title="item.estimatedRows == null ? '' : formatObjectBrowserCount(item.estimatedRows)">
                    {{ formatObjectBrowserCount(item.estimatedRows) }}
                  </div>
                  <div v-if="showObjectSizeStats && isObjectColumnVisible('totalBytes')" class="truncate text-xs tabular-nums text-muted-foreground" :title="item.totalBytes == null ? '' : formatObjectBrowserBytes(item.totalBytes)">
                    {{ formatObjectBrowserBytes(item.totalBytes) }}
                  </div>
                  <div v-if="hasCreatedAt && isObjectColumnVisible('created_at')" class="truncate text-xs tabular-nums text-muted-foreground" :title="formatObjectBrowserTimestamp(item.created_at)">
                    {{ formatObjectBrowserTimestamp(item.created_at) }}
                  </div>
                  <div v-if="hasUpdatedAt && isObjectColumnVisible('updated_at')" class="truncate text-xs tabular-nums text-muted-foreground" :title="formatObjectBrowserTimestamp(item.updated_at)">
                    {{ formatObjectBrowserTimestamp(item.updated_at) }}
                  </div>
                  <div v-if="isObjectColumnVisible('comment')" class="truncate text-xs text-muted-foreground" :title="item.comment || ''">
                    {{ item.comment || "" }}
                  </div>
                </div>
              </CustomContextMenu>
            </template>
          </RecycleScroller>
        </div>
        <div v-else ref="gridContainerRef" class="object-browser-grid-wrapper min-h-0 flex-1 p-2" :class="{ 'p-1': isCompactView }">
          <RecycleScroller ref="gridScrollerRef" v-if="gridRows.length > 0" class="object-browser-grid-scroller h-full" :items="gridRows" :item-size="objectGridRowHeight" :buffer="600" :skip-hover="true" key-field="key">
            <template #default="{ item: row }">
              <div class="object-browser-grid-row" :style="{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, columnGap: `${isCompactView ? OBJECT_COMPACT_GAP : OBJECT_GRID_GAP}px`, height: `${objectGridRowHeight - (isCompactView ? OBJECT_COMPACT_GAP : OBJECT_GRID_GAP)}px` }">
                <CustomContextMenu v-for="item in row.cards" :key="item.id" :items="() => getObjectBrowserMenuItems(item)" v-slot="{ onContextMenu, isOpen }">
                  <div
                    v-if="isGridView"
                    class="relative flex h-full min-h-0 cursor-default flex-col items-center gap-1 rounded-lg border p-3 text-center transition-all"
                    :class="{
                      'border-primary bg-accent shadow-sm': isOpen || sourceRow?.id === item.id || sidePanelRow?.id === item.id || selectedRowId === item.id || selectedTableIds.has(item.id),
                      'bg-card hover:border-primary/40 hover:bg-accent/40 hover:shadow-sm': !isOpen && sourceRow?.id !== item.id && sidePanelRow?.id !== item.id && selectedRowId !== item.id && !selectedTableIds.has(item.id),
                    }"
                    :title="item.displayName"
                    @click="onRowClick(item, $event)"
                    @contextmenu="onContextMenu"
                  >
                    <button v-if="showCheckboxColumn" class="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" type="button" @click.stop="toggleTableSelection(item)">
                      <CheckSquare v-if="selectedTableIds.has(item.id)" class="h-3.5 w-3.5 text-primary" />
                      <Square v-else class="h-3.5 w-3.5" />
                    </button>
                    <div class="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full shadow-sm" :class="[iconBgClass(item.type), { 'overflow-visible': item.valid === false }]">
                      <component :is="iconFor(item)" class="h-6 w-6" :class="iconClass(item.type)" />
                      <CircleX v-if="item.valid === false" data-invalid-object-indicator="true" class="pointer-events-none absolute -right-0.5 -bottom-0.5 h-4 w-4 rounded-full bg-background text-destructive stroke-[3]" aria-hidden="true" />
                    </div>
                    <span class="w-full truncate text-sm font-medium leading-tight text-foreground">{{ item.displayName }}</span>
                    <div class="flex items-center gap-1.5">
                      <span class="text-xs text-muted-foreground">{{ typeLabel(item) }}</span>
                      <span v-if="item.valid != null" class="rounded border px-1 py-px text-[10px] font-medium" :class="item.valid ? 'border-emerald-500/30 text-emerald-600' : 'border-destructive/30 text-destructive'">
                        {{ t(item.valid ? "objects.validStatus" : "objects.invalidStatus") }}
                      </span>
                      <span v-if="showObjectRowStats && item.estimatedRows != null && item.estimatedRows > 0" class="object-browser-stat-badge object-browser-stat-badge-rows rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-primary">{{
                        formatObjectBrowserCount(item.estimatedRows)
                      }}</span>
                      <span v-if="showObjectSizeStats && item.totalBytes != null && item.totalBytes > 0" class="object-browser-stat-badge object-browser-stat-badge-bytes rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">{{
                        formatObjectBrowserBytes(item.totalBytes)
                      }}</span>
                    </div>
                    <!-- Always reserve timestamp/comment slots when the dataset has them so every card shares one height. -->
                    <div v-if="hasCreatedAt || hasUpdatedAt" class="flex min-h-[15px] items-center gap-1 text-[10px] leading-[15px] text-muted-foreground/70">
                      <span v-if="item.created_at?.trim()">{{ formatObjectBrowserTimestamp(item.created_at) }}</span>
                      <span v-if="item.created_at?.trim() && item.updated_at?.trim()">·</span>
                      <span v-if="item.updated_at?.trim()">{{ formatObjectBrowserTimestamp(item.updated_at) }}</span>
                    </div>
                    <div v-if="hasAnyComment" class="w-full truncate text-[10px] leading-[15px] text-muted-foreground/60" :title="item.comment?.trim() || undefined">
                      {{ item.comment?.trim() || "\u00A0" }}
                    </div>
                  </div>
                  <div
                    v-else
                    data-object-compact-card
                    class="flex h-full min-w-0 cursor-default items-center gap-1 rounded border px-1.5 text-[11px] text-foreground transition-colors"
                    :class="{
                      'border-primary bg-accent shadow-sm': isOpen || sourceRow?.id === item.id || sidePanelRow?.id === item.id || selectedRowId === item.id || selectedTableIds.has(item.id),
                      'bg-card hover:border-primary/40 hover:bg-accent/40': !isOpen && sourceRow?.id !== item.id && sidePanelRow?.id !== item.id && selectedRowId !== item.id && !selectedTableIds.has(item.id),
                    }"
                    :title="item.displayName"
                    @click="onRowClick(item, $event)"
                    @contextmenu="onContextMenu"
                  >
                    <button v-if="showCheckboxColumn" class="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" type="button" @click.stop="toggleTableSelection(item)">
                      <CheckSquare v-if="selectedTableIds.has(item.id)" class="h-3.5 w-3.5 text-primary" />
                      <Square v-else class="h-3.5 w-3.5" />
                    </button>
                    <component :is="iconFor(item)" class="h-3.5 w-3.5 shrink-0" :class="iconClass(item.type)" aria-hidden="true" />
                    <span class="min-w-0 truncate font-medium">{{ item.displayName }}</span>
                  </div>
                </CustomContextMenu>
              </div>
            </template>
          </RecycleScroller>
        </div>
        <div v-if="usesServerObjectPaging" class="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
          <span>{{ t("objects.pagedOrder", { count: nameFilteredRows.length }) }}</span>
          <Button v-if="hasMoreObjects" data-object-load-more variant="outline" size="sm" :disabled="loadingMoreObjects" @click="loadObjectPage(true)">
            <Loader2 v-if="loadingMoreObjects" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ t("tree.loadMore") }}
          </Button>
        </div>
      </div>
      <!-- Right-side panel: table info or source -->
      <div
        v-if="sidePanelRow || isEventEditor"
        :data-object-table-info-panel="sidePanelMode === 'table-info' ? '' : undefined"
        class="object-browser-side-panel relative flex min-h-0 min-w-0 shrink-0 flex-col border-l bg-background"
        :class="{ 'side-panel-resizing': isResizingSidePanel }"
        :style="{ width: `min(${sidePanelWidth}px, 100%)` }"
      >
        <div class="absolute left-0 top-0 bottom-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30" @mousedown.prevent="onSidePanelResizeStart" />
        <!-- Table info mode -->
        <template v-if="sidePanelMode === 'table-info'">
          <div class="flex items-center gap-2 px-3 py-1.5 border-b shrink-0 bg-muted/20 h-9">
            <TableProperties class="w-3.5 h-3.5 text-muted-foreground" />
            <span class="text-xs font-medium flex-1 min-w-0 truncate">{{ sidePanelRow?.name }}</span>
            <div v-if="tableInfoTab === 'ddl' && tableMetadataCapabilities.ddl" class="table-info-actions flex min-w-0 shrink-0 items-center gap-1">
              <Button variant="ghost" size="sm" class="table-info-action-button h-6 px-2 text-xs" :disabled="tableDdlLoading || !tableDdlLoaded" :title="t('grid.copyDdl')" :aria-label="t('grid.copyDdl')" @click="copyTableDdl">
                <Copy class="w-3 h-3" />
                <span class="table-info-action-label">{{ t("grid.copyDdl") }}</span>
              </Button>
              <Button variant="ghost" size="sm" class="table-info-action-button h-6 px-2 text-xs" :class="{ 'bg-accent': settingsStore.editorSettings.tableDdlWordWrap }" :title="t('settings.wordWrap')" :aria-label="t('settings.wordWrap')" @click="toggleTableDdlWordWrap">
                <WrapText class="w-3 h-3" />
                <span class="table-info-action-label">{{ t("settings.wordWrap") }}</span>
              </Button>
            </div>
            <Button v-if="canOpenTableStructureEditor" variant="ghost" size="sm" class="table-info-action-button h-6 px-2 text-xs" :title="t('contextMenu.editStructure')" :aria-label="t('contextMenu.editStructure')" @click="openTableStructureEditor">
              <PencilRuler class="w-3 h-3" />
              <span class="table-info-action-label">{{ t("contextMenu.editStructure") }}</span>
            </Button>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="closeSidePanel">
              <X class="w-3 h-3" />
            </Button>
          </div>
          <div class="grid border-b bg-background shrink-0" :style="tableInfoTabListStyle">
            <button
              v-for="tab in tableInfoTabs"
              :key="tab.id"
              class="h-9 min-w-0 px-1.5 text-[11px] border-b-2 transition-colors"
              :class="tableInfoTab === tab.id ? 'border-primary bg-gray-300/80 text-foreground dark:bg-gray-700/80' : 'border-transparent text-muted-foreground hover:bg-gray-200 hover:text-foreground dark:hover:bg-gray-800/50'"
              :title="tab.label"
              @click="selectTableInfoTab(tab.id)"
            >
              <component :is="tab.icon" class="mx-auto h-3.5 w-3.5" />
              <span class="block truncate">{{ tab.label }}</span>
            </button>
          </div>
          <div v-if="tableInfoTab !== 'relations'" class="flex items-center gap-1 px-2 py-1.5 border-b shrink-0 bg-background">
            <div class="relative min-w-0 flex-1">
              <Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input v-model="tableInfoSearchQuery" data-table-info-search :placeholder="t('grid.tableInfoSearch')" class="w-full h-7 pl-7 pr-6 text-xs bg-muted/50 rounded border border-border focus:outline-none focus:border-primary/50" @keydown.escape="tableInfoSearchQuery = ''" />
              <button v-if="tableInfoSearchQuery" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="tableInfoSearchQuery = ''">
                <X class="w-3 h-3" />
              </button>
            </div>
            <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" :disabled="activeTableInfoLoading" :title="t('structureEditor.refresh')" :aria-label="t('structureEditor.refresh')" @click="refreshActiveTableInfo">
              <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': activeTableInfoLoading }" />
            </Button>
          </div>
          <div v-if="tableInfoTab === 'ddl' && (effectiveDatabaseType === 'oracle' || effectiveDatabaseType === 'oceanbase-oracle')" class="border-b px-3 py-2">
            <DdlStorageToggle :database-type="effectiveDatabaseType" :disabled="tableDdlLoading" />
          </div>
          <p v-if="propertyFocus && (tableInfoTab === 'indexes' || tableInfoTab === 'relations')" class="break-all border-b px-3 py-2 font-mono text-sm text-muted-foreground">{{ propertyFocus.owner }}.{{ propertyFocus.name }}</p>
          <ObjectDependenciesPanel v-if="tableInfoTab === 'relations'" :target="dependencyTarget" v-model:section="tableRelationsSection" :include-source="false" @view-sql="viewRelationSql" @open-object="openRelationObject" />
          <div v-else-if="tableInfoTab === 'info'" class="flex-1 min-h-0 overflow-auto">
            <div v-if="tableOverviewLoading" class="h-full flex items-center justify-center">
              <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
            <div v-else-if="tableInfoSearchQuery && tableOverviewRows.length === 0" class="p-6 text-center text-xs text-muted-foreground">{{ t("grid.tableInfoNoResults") }}</div>
            <div v-else class="divide-y">
              <div v-for="row in tableOverviewRows" :key="row.label" class="flex items-baseline gap-3 px-3 py-2 text-xs">
                <span class="w-24 shrink-0 text-muted-foreground">{{ row.label }}</span>
                <span class="min-w-0 flex-1 select-text break-words font-mono text-[11px]" :title="row.value">{{ row.value }}</span>
              </div>
            </div>
          </div>
          <div v-else-if="tableInfoTab === 'columns'" data-table-info-columns class="flex-1 min-h-0 overflow-auto" tabindex="0" @keydown="onTableInfoColumnsKeydown" @copy="onTableInfoColumnsCopy">
            <div v-if="tableColumnsLoading" class="h-full flex items-center justify-center">
              <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
            <div v-else-if="tableInfoSearchQuery && filteredTableColumns.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoNoResults") }}
            </div>
            <table v-else class="w-full text-xs">
              <thead class="sticky top-0 bg-muted text-muted-foreground">
                <tr class="border-b">
                  <th class="text-left text-nowrap font-medium px-3 py-2 w-8">#</th>
                  <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("grid.columnName") }}</th>
                  <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("grid.columnType") }}</th>
                  <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("grid.tableInfoNullable") }}</th>
                  <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("structureEditor.defaultValue") }}</th>
                </tr>
              </thead>
              <tbody>
                <CustomContextMenu v-for="(column, index) in filteredTableColumns" :key="column.name" :items="tableInfoColumnContextMenuItems" v-slot="{ onContextMenu, isOpen }">
                  <tr
                    tabindex="0"
                    :data-table-info-column="column.name"
                    class="border-b cursor-default outline-none"
                    :class="selectedTableInfoColumns.includes(column.name) || isOpen ? 'bg-primary/15' : 'hover:bg-gray-200 dark:hover:bg-gray-800/30'"
                    :title="column.name"
                    @click="toggleTableInfoColumnSelection(column.name, $event)"
                    @contextmenu="onTableInfoColumnContextMenu(column.name, $event, onContextMenu)"
                  >
                    <td class="px-3 py-2 text-muted-foreground w-8">{{ index + 1 }}</td>
                    <td class="px-3 py-2 font-medium">
                      <span class="inline-flex items-center gap-1.5">
                        <KeyRound v-if="column.is_primary_key" class="h-3 w-3 text-amber-500" />
                        {{ column.name }}
                      </span>
                      <div v-if="column.comment" class="mt-0.5 text-[11px] text-muted-foreground truncate">
                        {{ column.comment }}
                      </div>
                    </td>
                    <td class="px-3 py-2 font-mono text-[11px] text-muted-foreground">{{ gaussdbMColumnType(column.data_type) }}</td>
                    <td class="px-3 py-2">{{ column.is_nullable ? "YES" : "NO" }}</td>
                    <td data-table-info-column-default class="max-w-56 px-3 py-2 font-mono text-[11px]" :class="{ 'text-muted-foreground/70': column.column_default == null }" :title="column.column_default ?? undefined">
                      <span class="block max-w-56 truncate">{{ tableColumnDefaultDisplayValue(column.column_default) }}</span>
                    </td>
                  </tr>
                </CustomContextMenu>
              </tbody>
            </table>
          </div>
          <div v-else-if="tableInfoTab === 'indexes'" class="flex-1 min-h-0 overflow-auto">
            <p v-if="sidePanelRow?.type === 'INDEX' && tableIndexesLoaded && !tableIndexesError && !tableIndexes.some(isInitialSchemaIndex)" class="border-b px-3 py-2 text-xs text-muted-foreground" data-schema-index-focus-unavailable>{{ t("schemaIndex.focusUnavailable") }}</p>
            <div v-if="tableIndexesLoading" class="h-full flex items-center justify-center">
              <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
            <div v-else-if="tableIndexesError" class="p-3 text-xs text-destructive">{{ tableIndexesError }}</div>
            <div v-else-if="tableInfoSearchQuery && filteredTableIndexes.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoNoResults") }}
            </div>
            <div v-else-if="tableIndexes.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoEmpty") }}
            </div>
            <div v-else class="divide-y">
              <div
                v-for="(index, ordinal) in filteredTableIndexes"
                :key="JSON.stringify([schemaIndexOwner(index), index.name, ordinal])"
                class="p-3 text-xs"
                :class="{ 'bg-primary/10 ring-1 ring-inset ring-primary/40': isInitialSchemaIndex(index) }"
                :data-schema-index-match="isInitialSchemaIndex(index) || undefined"
              >
                <div class="flex items-start gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="font-medium truncate">{{ index.name }}</div>
                    <div class="mt-1 flex flex-wrap gap-1">
                      <span v-if="index.is_primary" class="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600">PK</span>
                      <span v-if="index.is_unique" class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600">UNIQUE</span>
                      <span v-if="index.index_type" class="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{{ index.index_type }}</span>
                    </div>
                    <div class="mt-2 font-mono text-[11px] text-muted-foreground break-all">
                      {{ index.columns.map((column, columnIndex) => column + (index.key_directions?.[columnIndex]?.toUpperCase() === "DESC" ? " DESC" : "")).join(", ") }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-else-if="tableInfoTab === 'foreignKeys'" class="flex-1 min-h-0 overflow-auto">
            <div v-if="tableForeignKeysLoading" class="h-full flex items-center justify-center">
              <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
            <div v-else-if="tableInfoSearchQuery && filteredTableForeignKeys.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoNoResults") }}
            </div>
            <div v-else-if="tableForeignKeys.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoEmpty") }}
            </div>
            <div v-else class="divide-y">
              <div v-for="fk in filteredTableForeignKeys" :key="`${fk.name}:${fk.column}`" class="p-3 text-xs">
                <div class="font-medium truncate">{{ fk.name }}</div>
                <div class="mt-1 font-mono text-[11px] text-muted-foreground break-all">{{ fk.column }} -> {{ fk.ref_table }}.{{ fk.ref_column }}</div>
              </div>
            </div>
          </div>
          <div v-else-if="tableInfoTab === 'constraints'" class="flex-1 min-h-0 overflow-auto">
            <div v-if="tableConstraintsLoading" class="h-full flex items-center justify-center">
              <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
            <div v-else-if="tableConstraintsError" class="p-3 text-xs text-destructive">
              {{ tableConstraintsError }}
            </div>
            <div v-else-if="tableInfoSearchQuery && filteredTableConstraints.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoNoResults") }}
            </div>
            <div v-else-if="tableConstraintsForTab.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoEmpty") }}
            </div>
            <div v-else class="divide-y">
              <div v-for="constraint in filteredTableConstraints" :key="constraint.name" class="p-3 text-xs" :class="constraint.enabled === false ? 'opacity-60' : ''">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="font-medium truncate">{{ constraint.name }}</span>
                  <span class="rounded border px-1 py-px text-[10px] text-muted-foreground">{{ constraint.constraint_type }}</span>
                  <span class="rounded border px-1 py-px text-[10px] text-muted-foreground">{{ t(constraint.enabled === true ? "grid.tableInfoConstraintEnabled" : constraint.enabled === false ? "grid.tableInfoConstraintDisabled" : "grid.tableInfoConstraintEnabledUnknown") }}</span>
                  <span class="rounded border px-1 py-px text-[10px] text-muted-foreground">{{ t(constraint.valid === true ? "grid.tableInfoConstraintValidated" : constraint.valid === false ? "grid.tableInfoConstraintNotValidated" : "grid.tableInfoConstraintValidationUnknown") }}</span>
                </div>
                <div v-if="constraint.columns.length" class="mt-1 font-mono text-[11px] text-muted-foreground break-all">{{ constraint.columns.join(", ") }}</div>
                <div v-if="constraint.ref_table" class="mt-1 font-mono text-[11px] text-muted-foreground break-all">-> {{ constraint.ref_schema ? `${constraint.ref_schema}.` : "" }}{{ constraint.ref_table }}{{ constraint.ref_columns.length ? `(${constraint.ref_columns.join(", ")})` : "" }}</div>
                <div v-if="constraint.definition" class="mt-1 font-mono text-[11px] text-muted-foreground break-all whitespace-pre-wrap">{{ constraint.definition }}</div>
              </div>
            </div>
          </div>
          <div v-else-if="tableInfoTab === 'triggers'" class="flex-1 min-h-0 overflow-auto">
            <div v-if="tableTriggersLoading" class="h-full flex items-center justify-center">
              <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
            <div v-else-if="tableInfoSearchQuery && filteredTableTriggers.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoNoResults") }}
            </div>
            <div v-else-if="tableTriggers.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoEmpty") }}
            </div>
            <div v-else class="divide-y">
              <div v-for="trigger in filteredTableTriggers" :key="trigger.name" class="p-3 text-xs">
                <div class="font-medium truncate">{{ trigger.name }}</div>
                <div class="mt-1 text-[11px] text-muted-foreground">{{ trigger.timing }} {{ trigger.event }}</div>
              </div>
            </div>
          </div>
          <TablePartitionsPanel v-else-if="tableInfoTab === 'partitions'" :partitioning="tablePartitions" :loading="tablePartitionsLoading" :error="''" :search-query="tableInfoSearchQuery" />
          <pre
            v-else-if="tableInfoTab === 'ddl' && !tableDdlLoading"
            ref="tableInfoDdlPreRef"
            data-native-clipboard
            tabindex="0"
            class="flex-1 min-w-0 text-xs font-mono p-3 overflow-auto ddl-code leading-5 select-text outline-none"
            :class="settingsStore.editorSettings.tableDdlWordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
            v-html="filteredTableDdlContent"
            @keydown="onTableInfoDdlKeydown"
          ></pre>
          <div v-else class="flex-1 flex items-center justify-center">
            <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        </template>
        <!-- Type info mode (read-only user-defined type details) -->
        <template v-else-if="sidePanelMode === 'type-info'">
          <CustomTypeInfoPanel ref="sidePanelRef" :connection="props.connection" :database="props.database" :database-type="effectiveDatabaseType" :schema="sidePanelRow?.schema || selectedSchema || props.database" :name="sidePanelRow?.name || ''" :catalog="props.catalog" @close="closeSidePanel" />
        </template>
        <template v-else-if="sidePanelMode === 'event-editor'">
          <MySqlEventEditor :key="eventEditorKey" :connection="props.connection" :database="props.database" :schema="sidePanelRow?.schema || selectedSchema || props.database" :name="sidePanelRow?.name" :read-only="props.initialEventReadOnly" @saved="onEventSaved" @close="closeSidePanel" />
        </template>
        <!-- Source mode (views, procedures, functions, sequences) -->
        <template v-else>
          <div class="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
            <Code2 class="h-3.5 w-3.5 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ sourceTitle(sourceRow) }}</span>
            <span v-if="sourceRow?.valid != null" class="shrink-0 rounded border px-1 py-px text-[10px] font-medium" :class="sourceRow.valid ? 'border-emerald-500/30 text-emerald-600' : 'border-destructive/30 text-destructive'">
              {{ t(sourceRow.valid ? "objects.validStatus" : "objects.invalidStatus") }}
            </span>
            <Button v-if="sourceEditing && sourceSection === 'source'" variant="ghost" size="sm" class="h-6 px-2 text-xs" :disabled="sourceSaving || sourceLoading || !sourceDraft.trim()" @click="saveSource">
              <Loader2 v-if="sourceSaving" class="mr-1 h-3 w-3 animate-spin" />
              {{ t("objects.saveSource") }}
            </Button>
            <Button v-if="sourceEditing && sourceSection === 'source'" variant="ghost" size="sm" class="h-6 px-2 text-xs" :disabled="sourceSaving || sourceLoading" @click="cancelEditSource">
              {{ t("objects.cancelEdit") }}
            </Button>
            <Button v-if="!sourceEditing && sourceSection === 'source'" variant="ghost" size="icon" class="h-5 w-5" :disabled="!sourceContent" @click="copySource">
              <Copy class="h-3 w-3" />
            </Button>
            <Button v-if="!sourceEditing && sourceCanEdit && sourceSection === 'source'" variant="ghost" size="icon" class="h-5 w-5" :disabled="!sourceContent" @click="editSource">
              <PencilLine class="h-3 w-3" />
            </Button>
            <Button v-if="sourceSection === 'source'" variant="ghost" size="icon" class="h-5 w-5" :disabled="sourceLoading || sourceSaving" :title="t('structureEditor.refresh')" :aria-label="t('structureEditor.refresh')" @click="refreshActiveSource">
              <RefreshCw class="h-3 w-3" :class="{ 'animate-spin': sourceLoading }" />
            </Button>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="closeSource">
              <X class="h-3 w-3" />
            </Button>
          </div>
          <ObjectDependenciesPanel :target="sourceDependencyTarget" v-model:section="sourceSection" @view-sql="viewRelationSql" @open-object="openRelationObject">
            <OracleTriggerStatus
              :snapshot="sourceTriggerSnapshot"
              :result="sourceTriggerResult"
              :source-issue="sourceTriggerIssue"
              :busy="sourceLoading || sourceSaving"
              @action="runSourceTriggerAction"
              @parent="openSourceTriggerParent"
              @refresh="refreshActiveSource"
              @diagnostics="openBrowserTriggerDiagnostics"
            />
            <div v-if="sourceLoading && !sourceEditing" class="flex flex-1 items-center justify-center">
              <Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
            <div v-else-if="sourceError" class="flex flex-1 items-center justify-center px-4 text-sm text-destructive">
              {{ sourceError }}
            </div>
            <div v-else-if="sourceEditing" class="flex min-h-0 flex-1 flex-col" data-object-source-editor>
              <QueryEditor
                v-model="sourceDraft"
                class="min-h-0 flex-1"
                :connection-id="props.connection.id"
                :database="props.database"
                :schema="selectedSchema"
                :database-type="props.connection.db_type"
                :dialect="sourceDialect"
                :format-dialect="sourceFormatDialect"
                force-word-wrap
                @save="sourceSection === 'source' && saveSource()"
              />
            </div>
            <QueryEditor
              v-else
              :key="`source-preview-${sourceRow?.id}`"
              :model-value="sourceContent"
              class="min-h-0 flex-1"
              :connection-id="props.connection.id"
              :database="props.database"
              :schema="selectedSchema"
              :database-type="props.connection.db_type"
              :dialect="sourceDialect"
              :format-dialect="sourceFormatDialect"
              force-word-wrap
              read-only
              data-object-source-preview
            />
            <div v-if="sourceSaveError" class="shrink-0 whitespace-pre-wrap break-words border-t px-3 py-2 text-xs text-destructive">
              {{ sourceSaveError }}
            </div>
          </ObjectDependenciesPanel>
        </template>
      </div>
    </div>
  </div>

  <DangerConfirmDialog
    v-model:open="showDropConfirm"
    :title="dropConfirmTitle()"
    :message="dropConfirmMessage()"
    :sql="dropPreviewSql"
    :confirm-label="t('dangerDialog.deleteConfirm')"
    :close-on-confirm="!dropTarget || !usesExactTriggerDrop(dropTarget)"
    :confirm-disabled="!!dropTarget && usesExactTriggerDrop(dropTarget) && (!triggerDropPreview?.isCurrent() || browserTriggerBusy)"
    @confirm="confirmDrop"
  >
    <template #options>
      <p v-if="dropPreviewError" role="alert" class="mb-3 text-sm text-destructive">{{ dropPreviewError }}</p>
      <p v-if="triggerDropPreview" class="mb-3 text-sm text-muted-foreground">{{ t("oracleTrigger.executionSchema") }}: {{ triggerDropPreview.plan.target.executionSchema }}</p>
      <label v-if="canDropTargetCascade" class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <input v-model="dropTableCascade" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="refreshDropPreviewSql()" />
        <span class="grid gap-0.5">
          <span class="font-medium text-foreground">{{ t("contextMenu.dropTableCascade") }}</span>
          <span class="text-xs leading-5 text-muted-foreground">{{ t("contextMenu.dropTableCascadeHint") }}</span>
        </span>
      </label>
    </template>
  </DangerConfirmDialog>

  <DangerConfirmDialog
    v-model:open="showBatchDropConfirm"
    :title="batchDropConfirmTitle"
    :message="batchDropConfirmMessage"
    :sql="batchDropPreviewSql"
    :confirm-label="t('objects.dropSelected')"
    :loading="batchDropExecuting && !batchTriggerDropRequested"
    :confirm-disabled="batchTriggerDropRequested && (!batchTriggerDropPreview?.isCurrent() || browserTriggerBusy)"
    :close-on-confirm="false"
    @confirm="confirmBatchDropTables"
  >
    <template #options>
      <p v-if="batchDropPreviewError" role="alert" class="mb-3 text-sm text-destructive">{{ batchDropPreviewError }}</p>
      <p v-if="batchTriggerDropPreview" class="mb-3 text-sm text-muted-foreground">{{ t("oracleTrigger.executionSchema") }}: {{ batchTriggerDropPreview.plan.target.executionSchema }}</p>
      <div v-if="batchDropExecuting" class="mb-3 rounded-md border bg-muted/20 px-3 py-2.5">
        <div class="mb-1.5 flex items-center justify-between text-xs tabular-nums text-muted-foreground">
          <span>{{ batchDropProgress.completed }} / {{ batchDropProgress.total }}</span>
          <span>{{ batchDropProgressPercent }}%</span>
        </div>
        <div class="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" :aria-valuemin="0" :aria-valuemax="batchDropProgress.total" :aria-valuenow="batchDropProgress.completed">
          <div class="h-full bg-primary transition-[width] duration-200" :style="{ width: `${batchDropProgressPercent}%` }" />
        </div>
      </div>
      <label v-if="canBatchDropCascade" class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <input v-model="batchDropCascade" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="refreshBatchDropPreviewSql()" />
        <span class="grid gap-0.5">
          <span class="font-medium text-foreground">{{ t("contextMenu.dropTableCascade") }}</span>
          <span class="text-xs leading-5 text-muted-foreground">{{ t("contextMenu.dropTableCascadeHint") }}</span>
        </span>
      </label>
    </template>
  </DangerConfirmDialog>

  <DangerConfirmDialog
    v-model:open="showBatchTruncateConfirm"
    :title="t('objects.confirmBatchTruncateTitle')"
    :message="t('objects.confirmBatchTruncateMessage', { count: selectedTableCount })"
    :sql="batchTruncatePreviewSql"
    :confirm-label="t('objects.truncateSelected')"
    @confirm="confirmBatchTruncateTables"
  >
    <template v-if="canBatchTruncateCascade" #options>
      <label class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <input v-model="batchTruncateCascade" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="refreshBatchTruncatePreviewSql()" />
        <span class="grid gap-0.5">
          <span class="font-medium text-foreground">{{ t("contextMenu.truncateTableCascade") }}</span>
          <span class="text-xs leading-5 text-muted-foreground">{{ t("contextMenu.truncateTableCascadeHint") }}</span>
        </span>
      </label>
    </template>
  </DangerConfirmDialog>

  <DangerConfirmDialog
    v-model:open="showBatchEmptyConfirm"
    :title="t('contextMenu.confirmBatchEmptyTitle', { count: batchEmptyPlan.length })"
    :message="t('contextMenu.confirmBatchEmptyMessage', { count: batchEmptyPlan.length })"
    :sql="batchEmptyPreviewSql"
    :confirm-label="t('contextMenu.batchEmpty', { count: batchEmptyPlan.length })"
    @confirm="confirmBatchEmptyTables"
  />

  <OraclePackageSaveAsDialog
    :open="packageSaveAsOpen"
    :old-name="packageSaveAsTarget?.name || ''"
    :new-name="packageSaveAsName"
    :plan="packageSaveAsPlan || null"
    :drafts="packageSaveAsDrafts"
    :error="packageSaveAsError"
    :diagnostic="packageSaveAsDiagnostic"
    :loading="packageSaveAsLoading"
    :validating="packageSaveAsValidating"
    :executing="packageSaveAsExecuting"
    @update:open="packageSaveAsOpen = $event"
    @update:new-name="packageSaveAsName = $event"
    @edit="editPackageSaveAsDraft"
    @validate="validatePackageSaveAsDrafts"
    @reload="validatePackageSaveAsDrafts"
    @confirm="confirmPackageSaveAs"
  />
  <Dialog v-model:open="showIndexParentPicker">
    <DialogContent data-schema-index-parent-picker class="sm:max-w-[420px]">
      <DialogHeader
        ><DialogTitle>{{ t("structureEditor.addIndex") }}</DialogTitle></DialogHeader
      >
      <label class="grid gap-2 text-sm">
        {{ t("structureEditor.tableName") }}
        <SearchableSelect
          data-index-parent-table
          v-model="indexParentTable"
          :options="indexParentTables"
          :loading="indexParentLoading"
          :disabled="indexParentLoading"
          :placeholder="t('dataCompare.selectTable')"
          :search-placeholder="t('dataCompare.searchTable')"
          :empty-text="t('grid.noSearchResults')"
        />
      </label>
      <div v-if="indexParentError" role="alert" class="flex items-center gap-2 text-sm text-destructive">
        <span class="min-w-0 flex-1 break-words">{{ indexParentError }}</span>
        <Button variant="outline" size="sm" @click="loadIndexParentTables">{{ t("common.retry") }}</Button>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showIndexParentPicker = false">{{ t("common.cancel") }}</Button>
        <Button data-confirm-index-parent :disabled="indexParentLoading || !indexParentTables.includes(indexParentTable) || !!indexParentError" @click="confirmIndexParent">{{ t("common.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  <Dialog v-model:open="showRenameDialog">
    <DialogContent
      :class="(effectiveDatabaseType === 'oracle' || effectiveDatabaseType === 'oceanbase-oracle') && (renameTarget?.type === 'VIEW' || renameTarget?.type === 'PROCEDURE' || renameTarget?.type === 'FUNCTION' || renameTarget?.type === 'TABLE') ? 'sm:max-w-[min(90vw,900px)]' : 'sm:max-w-[420px]'"
    >
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.renameObjectTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <Input v-model="renameInput" :placeholder="t('contextMenu.renameObjectNamePlaceholder')" @keydown.enter.prevent="confirmRename" />
        <OracleViewRenamePreview
          v-if="effectiveDatabaseType === 'oceanbase-oracle' && renameTarget?.type === 'VIEW'"
          :plan="viewRenamePlan || null"
          :drafts="viewRenameDrafts"
          :loading="viewRenameLoading"
          :validating="viewRenameValidating"
          :executing="viewRenameExecuting"
          @edit="editViewRenameDraft"
          @validate="validateViewRenameDrafts()"
          @reload="validateViewRenameDrafts()"
        />
        <OracleRoutineRenamePreview
          v-else-if="(effectiveDatabaseType === 'oracle' || effectiveDatabaseType === 'oceanbase-oracle') && (renameTarget?.type === 'PROCEDURE' || renameTarget?.type === 'FUNCTION')"
          :plan="routineRenamePlan || null"
          :drafts="routineRenameDrafts"
          :loading="viewRenameLoading"
          :validating="viewRenameValidating"
          :executing="viewRenameExecuting"
          @edit="editRoutineRenameDraft"
          @validate="validateRoutineRenameDrafts"
          @reload="refreshRenamePreviewSql()"
        />
        <OracleTableRenamePreview
          v-else-if="(effectiveDatabaseType === 'oracle' || effectiveDatabaseType === 'oceanbase-oracle') && renameTarget?.type === 'TABLE'"
          :plan="tableRenamePlan || null"
          :drafts="tableRenameDrafts"
          :loading="viewRenameLoading"
          :validating="viewRenameValidating"
          :executing="viewRenameExecuting"
          @edit="editTableRenameDraft"
          @validate="validateTableRenameDrafts()"
          @reload="validateTableRenameDrafts()"
        />
        <pre v-else-if="renamePreviewSqlText" class="max-h-32 min-w-0 max-w-full overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap" v-html="highlight(renamePreviewSqlText)"></pre>
        <p v-if="renameError" class="min-w-0 max-w-full overflow-x-auto text-sm text-destructive">{{ renameError }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showRenameDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button
          :disabled="
            !renameInput.trim() ||
            renameInput.trim() === renameTarget?.name ||
            viewRenameExecuting ||
            ((effectiveDatabaseType === 'oracle' || effectiveDatabaseType === 'oceanbase-oracle') && renameTarget?.type === 'TABLE' && !tableRenamePlan?.executable) ||
            (effectiveDatabaseType === 'oceanbase-oracle' && renameTarget?.type === 'VIEW' && !viewRenamePlan?.executable) ||
            ((effectiveDatabaseType === 'oracle' || effectiveDatabaseType === 'oceanbase-oracle') && (renameTarget?.type === 'PROCEDURE' || renameTarget?.type === 'FUNCTION') && !routineRenamePlan?.executable)
          "
          @click="confirmRename"
        >
          {{ t("contextMenu.renameObject") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showCompileErrorDialog">
    <DialogContent class="sm:max-w-[560px]">
      <DialogHeader>
        <DialogTitle>{{ compileErrorTitle }}</DialogTitle>
      </DialogHeader>
      <pre class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-destructive/5 p-3 text-sm text-destructive">      {{ compileErrorMessage }}</pre>
      <DialogFooter>
        <Button v-if="browserTriggerFeedback" variant="outline" :disabled="browserTriggerBusy" @click="refreshBrowserTriggerFeedback">{{ t("oracleTrigger.verifyReadOnly") }}</Button>
        <Button @click="showCompileErrorDialog = false">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DangerConfirmDialog
    v-model:open="showVacuumConfirm"
    :title="t('contextMenu.vacuumTableTitle')"
    :message="t('contextMenu.vacuumTableMessage', { name: vacuumTarget?.name ?? '' })"
    :details-text="vacuumRiskMessage"
    :sql="vacuumPreviewSql"
    :confirm-label="vacuumExecuting ? t('contextMenu.vacuumTableRunning') : vacuumTableFull ? t('contextMenu.vacuumTableFullConfirm') : t('contextMenu.vacuumTable')"
    :loading="vacuumExecuting"
    :close-on-confirm="false"
    @confirm="confirmVacuumTable"
  >
    <template #options>
      <div class="mb-3 flex gap-3 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <label class="flex items-center gap-2" :title="t('contextMenu.vacuumTableAnalyzeHint')">
          <input v-model="vacuumTableAnalyze" :disabled="vacuumExecuting" type="checkbox" class="h-3.5 w-3.5 shrink-0 accent-primary" @change="refreshVacuumPreviewSql" />
          <span class="font-medium text-foreground">ANALYZE</span>
        </label>
        <label class="flex items-center gap-2" :title="t('contextMenu.vacuumTableFullHint')">
          <input v-model="vacuumTableFull" :disabled="vacuumExecuting" type="checkbox" class="h-3.5 w-3.5 shrink-0 accent-destructive" @change="refreshVacuumPreviewSql" />
          <span class="font-medium" :class="vacuumTableFull ? 'text-destructive' : 'text-foreground'">FULL</span>
        </label>
      </div>
    </template>
  </DangerConfirmDialog>

  <DangerConfirmDialog
    v-model:open="showTruncateConfirm"
    :title="t('contextMenu.confirmTruncateTableTitle')"
    :message="t('contextMenu.confirmTruncateTableMessage', { name: truncateTarget?.name ?? '' })"
    :sql="truncatePreviewSql"
    :confirm-label="t('contextMenu.truncateTable')"
    @confirm="confirmTruncateTable"
  >
    <template v-if="canTruncateTargetCascade" #options>
      <label class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <input v-model="truncateTableCascade" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="truncateTarget && refreshTruncatePreviewSql(truncateTarget)" />
        <span class="grid gap-0.5">
          <span class="font-medium text-foreground">{{ t("contextMenu.truncateTableCascade") }}</span>
          <span class="text-xs leading-5 text-muted-foreground">{{ t("contextMenu.truncateTableCascadeHint") }}</span>
        </span>
      </label>
    </template>
  </DangerConfirmDialog>

  <DangerConfirmDialog v-model:open="showEmptyConfirm" :title="t('contextMenu.confirmEmptyTableTitle')" :message="t('contextMenu.confirmEmptyTableMessage', { name: emptyTarget?.name ?? '' })" :sql="emptyPreviewSql" :confirm-label="t('contextMenu.emptyTable')" @confirm="confirmEmptyTable" />

  <ProcedureExecutionDialog
    v-if="procedureExecutionTarget"
    v-model:open="showProcedureExecutionConfirm"
    :connection-id="props.connection.id"
    :database="props.database"
    :database-type="props.connection.db_type"
    :schema="procedureExecutionTarget.schema || selectedSchema"
    :routine-name="procedureExecutionTarget.name"
    @open-sql="openProcedureExecutionSql"
    @execute="executeProcedureSql"
  />

  <Dialog v-model:open="showDuplicateDialog">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.duplicateNameTitle") }}</DialogTitle>
      </DialogHeader>
      <Input v-model="duplicateTableName" :placeholder="t('contextMenu.duplicateNamePlaceholder')" @keydown.enter.prevent="confirmDuplicateStructure" />
      <DialogFooter>
        <Button variant="outline" @click="showDuplicateDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!duplicateTableName.trim()" @click="confirmDuplicateStructure">
          {{ t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showPasteDialog">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ pasteTableFromClipboard ? (pasteTableEntries.length > 1 ? t("contextMenu.batchPasteTitle") : t("contextMenu.pasteTableConfirmTitle")) : t("contextMenu.duplicateNameTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-4">
        <div class="flex gap-2">
          <label class="flex items-center gap-1.5 text-sm cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': !pasteTableDataCopySupported }">
            <input v-model="pasteTableMode" type="radio" value="structure-and-data" class="accent-primary" :disabled="!pasteTableDataCopySupported" />
            {{ t("contextMenu.pasteOptionStructureAndData") }}
          </label>
          <label class="flex items-center gap-1.5 text-sm cursor-pointer">
            <input v-model="pasteTableMode" type="radio" value="structure-only" class="accent-primary" />
            {{ t("contextMenu.pasteOptionStructureOnly") }}
          </label>
          <label class="flex items-center gap-1.5 text-sm cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': !pasteTableDataCopySupported }">
            <input v-model="pasteTableMode" type="radio" value="data-only" class="accent-primary" :disabled="!pasteTableDataCopySupported" />
            {{ t("contextMenu.pasteOptionDataOnly") }}
          </label>
        </div>
        <div class="space-y-2 max-h-64 overflow-y-auto">
          <div v-for="(entry, idx) in pasteTableEntries" :key="idx" class="flex items-center gap-2">
            <span class="text-sm text-muted-foreground truncate min-w-0 flex-shrink basis-1/3" :title="entry.sourceName">{{ entry.sourceName }}</span>
            <span class="text-xs text-muted-foreground flex-shrink-0">&rarr;</span>
            <Input v-model="entry.targetName" class="flex-1 h-8 text-sm" :placeholder="t('contextMenu.duplicateNamePlaceholder')" />
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showPasteDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="pasteTableEntries.every((e) => !e.targetName.trim())" @click="confirmPasteTable">{{ t("dangerDialog.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.object-browser-table {
  scrollbar-width: thin;
}

.object-browser-scroller {
  will-change: scroll-position;
  contain: content;
  overflow-x: auto;
}

/* Keep the horizontal track discoverable when the platform uses overlay
   scrollbars, while leaving the native vertical scrollbar in place. */
.object-browser-scroller::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.object-browser-scroller::-webkit-scrollbar-track {
  background: transparent;
}

.object-browser-scroller::-webkit-scrollbar-thumb {
  border: 1px solid transparent;
  border-radius: 999px;
  background: rgba(82, 82, 82, 0.28);
  background: color-mix(in oklch, var(--foreground) 28%, transparent);
  background-clip: padding-box;
}

.object-browser-scroller:hover::-webkit-scrollbar-thumb {
  border: 0;
  background: rgba(82, 82, 82, 0.45);
  background: color-mix(in oklch, var(--foreground) 45%, transparent);
}

html.dbx-legacy-webview.dark .object-browser-scroller::-webkit-scrollbar-thumb {
  background: rgba(212, 212, 216, 0.28);
}

html.dbx-legacy-webview.dark .object-browser-scroller:hover::-webkit-scrollbar-thumb {
  background: rgba(212, 212, 216, 0.45);
}

/* The scroller itself stays viewport-width so its vertical scrollbar remains
   visible at the right edge; the row content inside scrolls horizontally past
   that width instead (issue #8885). */
.object-browser-scroller :deep(.vue-recycle-scroller__item-wrapper) {
  min-width: var(--dbx-object-grid-min-width, 0px);
}

.object-browser-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style paint;
}

.object-browser-grid-wrapper {
  scrollbar-width: thin;
}

.object-browser-grid-scroller {
  will-change: scroll-position;
  contain: content;
  scrollbar-width: thin;
}

.object-browser-grid-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style paint;
}

.object-browser-grid-row {
  display: grid;
  column-gap: 12px;
  /* Stretch so cards with/without comment share one border height in the row. */
  align-items: stretch;
}

.object-browser-icon-bg-table {
  background-color: rgba(34, 197, 94, 0.1);
}

.object-browser-icon-bg-view {
  background-color: rgba(168, 85, 247, 0.1);
}

.object-browser-icon-bg-procedure {
  background-color: rgba(59, 130, 246, 0.1);
}

.object-browser-icon-bg-function {
  background-color: rgba(245, 158, 11, 0.1);
}

.object-browser-icon-bg-sequence {
  background-color: rgba(16, 185, 129, 0.1);
}

.object-browser-icon-bg-package {
  background-color: rgba(6, 182, 212, 0.1);
}

.object-browser-stat-badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  line-height: 1rem;
  white-space: nowrap;
}

.object-browser-stat-badge-rows {
  color: var(--primary);
  background-color: rgba(23, 23, 23, 0.1);
}

.object-browser-stat-badge-bytes {
  color: var(--muted-foreground);
  background-color: var(--muted);
}

:global(.dark) .object-browser-stat-badge-rows {
  background-color: rgba(208, 208, 214, 0.12);
}

.side-panel-resizing {
  user-select: none;
  pointer-events: none;
}

.ddl-code {
  container-type: inline-size;
}

.object-browser-side-panel {
  container-type: inline-size;
}

.event-editor-layout > :first-child {
  display: none;
}

.event-editor-layout > .object-browser-side-panel {
  width: 100% !important;
  border-left: 0;
}

.table-info-action-button {
  gap: 0.25rem;
  max-width: 8rem;
  overflow: hidden;
  transition:
    max-width 180ms ease,
    padding-inline 180ms ease;
}

.table-info-action-label {
  min-width: 0;
  max-width: 6rem;
  overflow: hidden;
  white-space: nowrap;
  opacity: 1;
  transition:
    max-width 180ms ease,
    opacity 120ms ease;
}

@container (max-width: 360px) {
  .table-info-action-button {
    width: 1.5rem;
    max-width: 1.5rem;
    padding-inline: 0;
  }

  .table-info-action-label {
    max-width: 0;
    opacity: 0;
  }
}
</style>
