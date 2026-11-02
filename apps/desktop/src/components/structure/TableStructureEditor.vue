<script setup lang="ts">
import PostgresForeignTableOptionsEditor from "@/components/structure/PostgresForeignTableOptionsEditor.vue";
import { buildPostgresForeignTableOptions, emptyPostgresForeignTableDraft, restorePostgresForeignTableDraft, supportsPostgresForeignTableCreation } from "@/lib/table/postgresForeignTable";
import { Compartment } from "@codemirror/state";
import { keymap as codeMirrorKeymap } from "@codemirror/view";
import { getStarRocksCapabilities } from "@/lib/table/starrocksCapabilities";
import { starRocksAlterOptionsFromDdl, starRocksColumnDefinitionLocked, type StarRocksAlterOptions } from "@/lib/table/starrocksAlterOptions";
import { getColumnDefaultValuePresets } from "@/lib/table/columnDefaultPresets";
import { applyDdlStoragePreference } from "@/lib/sql/ddlStorage";
import { compactDdlSql } from "@/lib/sql/ddlCompact";
import { matchesIdentifierSearch } from "@/lib/sql/identifierSearch";
import DdlStorageToggle from "@/components/objects/DdlStorageToggle.vue";
import { exactOracleTriggerMetadata, oracleTriggerReadOptions } from "@/lib/database/oracleTriggerIdentity";
import { executeOracleTriggerStructurePlan, readOracleTriggerSource, verifyOracleTriggerDeletion, type OracleTriggerExecutionResult, type OracleTriggerSnapshot, type OracleTriggerTarget } from "@/lib/database/oracleTriggerPlan";
import { prepareOracleTriggerStructurePlan, reconcileOracleTriggerStructureDraft, type OracleTriggerStructurePlan } from "@/lib/database/oracleTriggerStructurePlan";
import { inspectExactOracleTriggerSource } from "@/lib/table/objectSourceLoad";
import StructureIndexColumnPicker from "./StructureIndexColumnPicker.vue";
import TableColumnPasteDialog from "./TableColumnPasteDialog.vue";
import { createPastedColumnDrafts, parseTableColumnDefinitions } from "@/lib/table/tableColumnDefinitionPaste";
import { resolveNextEditorToolbarTier, type EditorToolbarTier } from "@/lib/tabs/editorToolbarLayout";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { executeOceanbasePrimaryKeyPlan, readOceanbasePrimaryKeySnapshot, prepareOraclePrimaryKeyChange, OceanbasePrimaryKeyValidationError, type ExistingPrimaryKeyChange, type OceanbasePrimaryKeyPlan, type PrimaryKeyTarget } from "@/lib/database/oceanbasePrimaryKey";
import {
  executeOracleForeignKeyCreatePlan,
  executeOracleForeignKeyPlan,
  preflightOracleForeignKeyCreatePlan,
  prepareOracleForeignKeyCreatePlan,
  prepareOracleForeignKeyPlan,
  readOracleForeignKeyCreateResult,
  readOracleForeignKeyDefinitions,
  type OracleForeignKeyCreatePlan,
  type OracleForeignKeyCreateExecutionResult,
  type OracleForeignKeyPlan,
} from "@/lib/database/oracleForeignKeys";
import { executeOracleConstraintPlan, oracleConstraintDefinitionFromInfo, prepareOracleConstraintPlan, type OracleConstraintPlan, type OracleConstraintTarget } from "@/lib/database/oracleConstraints";
import { executeOracleIndexPlan, mergeOracleIndexDraftsAfterRefresh, oracleIndexSnapshotMatchesLoaded, oracleIndexSnapshotMatchesLoadedColumns, prepareOracleIndexPlan, type OracleIndexDefinition, type OracleIndexLoadBaseline, type OracleIndexPlan } from "@/lib/database/oracleIndexes";
import { readOracleIndexSnapshot } from "@/lib/database/oracleConstraints";

import { computed, defineAsyncComponent, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { RecycleScroller } from "vue-virtual-scroller";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  Copy,
  Database,
  Info,
  KeyRound,
  ListChevronsUpDown,
  Loader2,
  Maximize2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Rows3,
  Save,
  Search,
  Settings,
  SlidersHorizontal,
  SquareFunction,
  Trash2,
  UserRound,
  X,
} from "@lucide/vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SearchableSelect } from "@/components/ui/searchable-select";
import StarRocksAlterStatus from "@/components/structure/StarRocksAlterStatus.vue";
import StarRocksSortKeyEditor from "@/components/structure/StarRocksSortKeyEditor.vue";
import StarRocksLayoutCopyDialog from "@/components/structure/StarRocksLayoutCopyDialog.vue";
import StarRocksPhysicalOptionsEditor from "@/components/structure/StarRocksPhysicalOptionsEditor.vue";
import { buildStarRocksDialectOptions, emptyStarRocksPhysicalOptions, hasStarRocksPhysicalOptions, restoreStarRocksPhysicalOptions } from "@/lib/table/starrocksPhysicalOptions";
import TablePhysicalOptionsEditor from "@/components/structure/TablePhysicalOptionsEditor.vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { useQueryStore } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useSqlExecutionDangerStore } from "@/stores/sqlExecutionDangerStore";
import { matchesShortcut } from "@/lib/editor/keyboardShortcuts";
import { selectLineEndsDefaultShortcut, shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";
import { selectLineEnds } from "@/lib/editor/selectLineEnds";
import { useSettingsStore, type StructureEditorDensity } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { editorFontTheme, loadEditorTheme } from "@/lib/editor/editorThemes";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { useToast } from "@/composables/useToast";
import { fetchNamespaceOptionsForConnection, fetchCatalogNamespaceOptions, namespaceOptionsAreSchemas, normalizedQueryTabCatalog, selectedQueryCatalogName } from "@/composables/useDatabaseOptions";
import { schemaOptionsForConnection } from "@/composables/useSchemaOptions";
import { connectionIsDorisFamilyCatalogCapable, isSchemaAware } from "@/lib/database/databaseFeatureSupport";
import { useVerticalOverlayScrollbar } from "@/composables/useVerticalOverlayScrollbar";
import { type SqlHighlighter, createShikiSqlHighlighter } from "@/lib/sql/sqlHighlighter";
import { joinSqlStatementsForScript } from "@/lib/sql/sqlBatchScript";
import { applyDdlDatabaseQualifier, formatDdlForDisplay, formatGeneratedDdlIdentifierQuotes } from "@/lib/sql/ddlDisplay";
import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { copyToClipboard, eventTargetUsesNativeClipboard, isPlainClipboardShortcut } from "@/lib/common/clipboard";
import { formatTsv } from "@/lib/export/exportFormats";
import DataGridCopyColumnNamesDialog from "@/components/grid/DataGridCopyColumnNamesDialog.vue";
import { sqlFormatDialectForDbType, type SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import { queryTimeoutSecsForConcurrentIndex, queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";
import { isMacOS } from "@/lib/backend/platform";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { invalidateObjectDdl, invalidateObjectDdlCache, loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectMetadataCache, loadObjectMetadataFacet, type ObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { invalidateTableMetadataCache } from "@/lib/metadata/tableMetadataCache";
import {
  type BuildTableStructureChangeSqlOptions,
  type EditableStructureColumn,
  type EditableStructureForeignKey,
  type EditableStructureIndex,
  type EditableStructureTrigger,
  type MysqlTableCharsetChange,
  type OracleConstraintChange,
  type OracleConstraintDefinition,
  type TablePartitionBoundDraft,
  type TablePartitionOperation,
  type TablePartitionOperationKind,
  type TablePartitionSqlOptions,
} from "@/lib/table/tableStructureEditorSql";
import { buildMysqlAutoIncrementCounterStatement, canEditMysqlAutoIncrementCounter, refreshMysqlAutoIncrementCounterDraft, translateMysqlAutoIncrementWarning } from "@/lib/table/mysqlAutoIncrementCounter";
import { mysqlTableCollationSql, parseMysqlTableCharset } from "@/lib/table/mysqlTableCollation";
import { MYSQL_STORAGE_ENGINES_SQL, mysqlTableEngineSql, mysqlTableEngineSqlOption, parseMysqlTableEngineMetadata, refreshMysqlTableEngineDraft, supportsMysqlTableEngine } from "@/lib/table/mysqlTableEngine";
import { INCEPTOR_PHYSICAL_OPTIONS, buildInceptorCreateOptions, emptyTablePhysicalOptions, hasTablePhysicalOptions, pruneTablePhysicalOptions, restoreTablePhysicalOptions } from "@/lib/table/tablePhysicalOptions";
import { PRESET_FIELDS_TEMPLATE_ID, createTableColumnTemplateDrafts } from "@/lib/table/tableColumnTemplates";
import { getMysqlDataTypeHelp } from "@/lib/table/mysqlDataTypeHelp";
import { getPostgresDataTypeHelp, gaussdbMTypeDisplayName } from "@/lib/table/postgresDataTypeHelp";
import { getSqliteDataTypeHelp } from "@/lib/table/sqliteDataTypeHelp";
import { getTableMetadataCapabilities, firstStructureMetadataTab, isStructureMetadataTabSupported } from "@/lib/table/tableMetadataCapabilities";
import { constraintsForConstraintsTab } from "@/lib/table/constraintPresentation";
import { PARTITION_TREE_INDENT_PX, flattenPgPartitionNodes, pgPartitionBoundText, pgPartitionKindLabelKey, pgPartitionNodeBoundText, pgPartitionRowHint, splitPgPartitionBoundValues, visiblePgPartitionRows, type PgPartitionTreeRow } from "@/lib/table/pgPartitionPresentation";
import { formatBytes } from "@/lib/database/serverMetrics";
import { hasTableStructureRefreshWork, unloadedTableStructureRefreshScope, visibleTableStructureRefreshScope, type TableStructureRefreshScope } from "@/lib/table/tableStructureMetadataLoading";
import { canAddTableStructureColumn, getTableStructureCapabilities, hasLocalTableColumnOrderChange, isPhysicalTableColumnOrderChange, sanitizeStructureIndexesForCapabilities, supportsLocalTableColumnReorder } from "@/lib/table/tableStructureCapabilities";
import { sortStructureIndexesByColumns, type StructureIndexColumnSort } from "@/lib/table/structureIndexSort";
import { getConcurrentIndexAvailability, concurrentIndexNamesInStatements, normalizeUnsupportedConcurrentIndexes, type ConcurrentIndexAvailability } from "@/lib/table/concurrentIndexAvailability";
import { orderedColumnIndexes, uniqueDataGridColumnOrderKeys } from "@/lib/dataGrid/dataGridColumnOrder";
import { loadTableDataGridColumnOrder, notifyTableDataGridColumnOrderChanged, removeTableDataGridColumnOrder, saveTableDataGridColumnOrder, tableDataGridColumnOrderScopeKey } from "@/lib/dataGrid/dataGridColumnLayoutStorage";
import { codeMirrorSqlDialect, codeMirrorSqlDialectForConnection, connectionObjectTreeQuerySchema, connectionUsesDatabaseObjectTreeMode, tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { postgresListRolesSql, usersFromPostgresRolesResult } from "@/lib/database/databaseUserAdmin";
import type { CatalogInfo, ColumnInfo, ConnectionConfig, ConstraintInfo, PgPartitionKind, PgPartitionNode, PgTablePartitioning, TableInfo, TableInfoTab, TableStructureEditorDraft, TableStructureEditorTarget, TableStructureEditorViewport } from "@/types/database";
import {
  applyManticoreDdlColumnExtras,
  buildStructureTargetLabel,
  canEditStructuredTriggerDraft,
  canEditManticoreColumnProperties,
  cloneColumnDraftAsNew,
  combineDataTypeForDatabase,
  combineDataTypeForDatabaseWithLengthUnit,
  createCopiedColumnDrafts,
  createColumnDrafts,
  createForeignKeyDrafts,
  createIndexDrafts,
  createTriggerDrafts,
  dataTypeBaseInputValue,
  dataTypeLengthInputValue,
  dataTypeLengthUnitValue,
  defaultNewColumnDataType,
  filterStructureIndexColumnOptions,
  generateUniqueIndexName,
  generateUniqueShortIndexName,
  structureIndexKind,
  canIndexTypeHaveSpecialIssue,
  specialIndexColumnIssue,
  type StructureIndexKind,
  getColumnEditorControls,
  getDataTypeOptions,
  POSTGRES_GEOMETRY_TYPES,
  combinePostgresGeometryType,
  isPostgresGeometryDataType,
  postgresGeometrySridValue,
  postgresGeometryTypeValue,
  getDataTypeLengthUnitOptions,
  getDefaultLengthForType,
  hasExistingColumnTypeChange,
  isDataTypeLengthDisabled,
  isDamengIdentityCompatibleDataType,
  isMysqlEnumDataType,
  isMysqlCharacterDataType,
  isProtectedManticoreIdColumn,
  isSqlServerIdentityCompatibleDataType,
  mysqlEnumDataType,
  parseExtraToColumnExtra,
  parseMysqlGeneratedColumnExtra,
  rehydrateColumnDraftsFromMetadata,
  resolveInsertColumnIndex,
  restoreCharacterLengthUnitsAfterSave,
  sameStructureIndexType,
  supportsTableStructureExtendedProperties,
  structureColumnSelectionRange,
  isSyntheticContextMenuClick,
  resolveColumnSelectionActiveId,
  structureColumnCommentsForCopy,
  structureColumnNamesForCopy,
  tableStructureIdentifierComparisonKey,
  toColumnNames,
  copySourceColumnDetails,
  matchesCopySourceColumnSearch,
  foldCreatedTableName,
  draftColumnNameForSql,
} from "@/lib/table/tableStructureEditorState";
import { CREATE_DATABASE_CHARSET_OPTIONS, createDatabaseCollationOptionsForCharset, fallbackCreateDatabaseCharsetMetadata, normalizeCreateDatabaseCharsetKey, parseCreateDatabaseCharsetMetadata } from "@/lib/database/createDatabaseCharsetOptions";
import type { CreateDatabaseCharsetMetadata } from "@/lib/database/createDatabaseCharsetOptions";
import * as api from "@/lib/backend/api";
import { EditorView } from "@codemirror/view";

const ObjectSourceDialog = defineAsyncComponent(() => import("@/components/objects/ObjectSourceDialog.vue"));
const { t } = useI18n();
const { isDark, themePalette } = useTheme();
const store = useConnectionStore();
const productionSafetyStore = useProductionSafetyStore();
const queryStore = useQueryStore();
const historyStore = useHistoryStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const rootRef = ref<HTMLElement>();
const useColumnVirtualFlowMode = isTauriRuntime() && isMacOS();
type StructureScrollerRef =
  | HTMLElement
  | {
      $el?: HTMLElement;
      scrollToItem?: (index: number, options?: { align?: ScrollLogicalPosition }) => void;
      updateVisibleItems?: (itemsChanged: boolean, checkPositionDiff?: boolean) => void;
    };
const columnsScrollerRef = ref<StructureScrollerRef>();
const indexesScrollerRef = ref<StructureScrollerRef>();
const foreignKeysScrollerRef = ref<StructureScrollerRef>();
const constraintsScrollerRef = ref<StructureScrollerRef>();
const triggersScrollerRef = ref<StructureScrollerRef>();
const partitionsScrollerRef = ref<StructureScrollerRef>();
const ddlScrollerRef = ref<StructureScrollerRef>();
const structureHorizontalScrollbarTrackRef = ref<HTMLDivElement>();
const indexesTableRef = ref<HTMLElement | null>(null);
const structureVerticalScrollbarTrackRef = ref<HTMLElement | null>(null);
const structureVerticalScrollbarThumbRef = ref<HTMLElement | null>(null);
const structureHorizontalScrollbarThumbRef = ref<HTMLDivElement>();
const columnContextMenuTarget = shallowRef<EditableStructureColumn | null>(null);
const hasStructureHorizontalOverflow = ref(false);
const dynamicDataTypeOptionsCache = new Map<string, string[]>();

const sqlHighlighter = ref<SqlHighlighter>();
const SQL_PREVIEW_DEBOUNCE_MS = 300;
onMounted(async () => {
  sqlHighlighter.value = await createShikiSqlHighlighter({
    appearance: () => (isDark.value ? "dark" : "light"),
  });
});

const highlightedSql = computed(() => {
  if (!pendingStatements.value.length) return "";
  const sql = previewSqlText.value;
  return sqlHighlighter.value?.(sql) ?? sql;
});
const previewSqlText = computed(() => joinSqlStatementsForScript(pendingStatements.value, databaseType.value));

const props = defineProps<{
  connectionId: string;
  /** Result/draft ownership when a dispatched sequence outlives the visible tab. */
  originTabId?: string;
  database: string;
  catalog?: string;
  schema?: string;
  tableName: string;
  /** `view` loads `CREATE OR REPLACE VIEW` instead of table DDL. */
  tableType?: "table" | "view";
  initialTab?: TableInfoTab;
  initialTabRequestId?: number;
  initialTarget?: TableStructureEditorTarget;
  exactIdentity?: boolean;
  draft?: TableStructureEditorDraft;
}>();

const emit = defineEmits<{
  "update:draft": [draft: TableStructureEditorDraft | undefined, originTabId?: string];
  saved: [commentChanged: boolean, createdTableName?: string, originTabId?: string];
  close: [];
  openSettings: [initialTab?: string, initialSection?: string];
  /** Jump from the DDL view to the table's data tab (issue #6724). */
  viewData: [];
}>();

const activeTab = ref<TableInfoTab>("columns");

// DBX hides native scrollbars, so the columns/indexes tables only had the custom
// horizontal bar. Render the same overlay affordance vertically for whichever
// table tab is active; the bar occupies the tab panel's second grid column.
const activeStructureTableScrollerRef = computed<HTMLElement | null>(() => structureScrollerElement(activeTab.value === "indexes" ? indexesScrollerRef.value : columnsScrollerRef.value) ?? null);
const activeStructureTableContentRef = computed<HTMLElement | null>(() => {
  if (activeTab.value === "indexes") return indexesTableRef.value ?? null;
  const scroller = structureScrollerElement(columnsScrollerRef.value);
  return scroller?.querySelector<HTMLElement>(".vue-recycle-scroller__item-wrapper") ?? scroller ?? null;
});
const {
  hasOverflow: hasStructureVerticalOverflow,
  isScrolling: isStructureVerticalScrollbarScrolling,
  isDragging: isStructureVerticalScrollbarDragging,
  onScroll: onStructureVerticalScrollerScroll,
  onTrackPointerDown: onStructureVerticalScrollbarTrackPointerDown,
  onThumbPointerDown: onStructureVerticalScrollbarThumbPointerDown,
} = useVerticalOverlayScrollbar(activeStructureTableScrollerRef, activeStructureTableContentRef, structureVerticalScrollbarTrackRef, structureVerticalScrollbarThumbRef);
const loading = ref(false);
const saving = ref(false);
const postSaveRefreshing = ref(false);
const sqlPreviewLoading = ref(false);
const sqlPreviewPending = ref(false);
const indexesLoading = ref(false);
const foreignKeysLoading = ref(false);
const constraintsLoading = ref(false);
const triggersLoading = ref(false);
const rawDdlContent = ref("");
const ddlStorageIncluded = ref(settingsStore.editorSettings.includeDdlStorage);
const ddlCompacted = ref(settingsStore.editorSettings.compactDdlSql);
const ddlIndexesSeparated = ref(settingsStore.editorSettings.separateDdlIndexes);
const ddlContent = computed(() => {
  const sql = applyDdlStoragePreference(rawDdlContent.value, databaseType.value, !ddlStorageIncluded.value);
  return ddlCompacted.value ? compactDdlSql(sql, databaseType.value) : sql;
});
const ddlLoading = ref(false);
const ddlLoadError = ref("");
let ddlLoadRequestId = 0;
const ddlEditorContainer = ref<HTMLDivElement>();
const ddlSearchPanelRef = ref<InstanceType<typeof EditorSearchPanel>>();
const ddlSearchOpen = ref(false);
const ddlEditorView = shallowRef<EditorView | null>(null);
const ddlEditorShortcut = new Compartment();
const selectLineEndsShortcut = () => settingsStore.editorSettings?.shortcuts?.selectLineEnds ?? selectLineEndsDefaultShortcut();
let ddlEditorInitRequestId = 0;
let ddlEditorScrollCleanup: (() => void) | null = null;
const loadedMetadataFacets = new Set<ObjectMetadataFacet>();
let structureEditorReady = false;
const ddlFetched = ref(false);
let pendingDdlNavigation = false;
/** User-edited DDL script; `null` means untouched (the loaded DDL is shown verbatim). */
const ddlDraft = ref<string | null>(null);

/**
 * DDL is only editable for an existing table whose DDL actually loaded — the
 * create-table flow has no DDL tab, and an empty baseline only renders the
 * "no records" placeholder, which must never become executable text.
 */
const ddlEditingEnabled = computed(() => !isCreateMode.value && !ddlLoading.value && !ddlLoadError.value && !!ddlContent.value.trim());
const ddlDirty = computed(() => ddlDraft.value !== null && ddlDraft.value.trim() !== ddlContent.value.trim());
watch([() => settingsStore.editorSettings.includeDdlStorage, () => settingsStore.editorSettings.compactDdlSql, () => settingsStore.editorSettings.separateDdlIndexes, ddlDirty], ([include, compact, separate, dirty]) => {
  if (!dirty && (ddlStorageIncluded.value !== include || ddlCompacted.value !== compact || ddlIndexesSeparated.value !== separate)) {
    const indexesChanged = ddlIndexesSeparated.value !== separate;
    ddlDraft.value = null;
    ddlStorageIncluded.value = include;
    ddlCompacted.value = compact;
    ddlIndexesSeparated.value = separate;
    if (indexesChanged && (databaseType.value === "oracle" || databaseType.value === "oceanbase-oracle")) {
      destroyDdlEditor();
      ddlLoadRequestId++;
      ddlLoading.value = false;
      ddlLoadError.value = "";
      ddlFetched.value = false;
      if (structureEditorReady && activeTab.value === "ddl") void fetchDdl();
    }
  }
});

function ddlEditorDocument(): string {
  return ddlDraft.value ?? (ddlContent.value || t("structureEditor.emptyReadonly"));
}

/**
 * Formats fetched DDL through the shared read-only display pipeline for the
 * structure editor's DDL tab. The storage preference is not baked in: the
 * `ddlContent` computed re-filters on read so toggling it updates without a
 * reload.
 */
function formatStructureDdl(ddl: string): Promise<string> {
  return formatDdlForDisplay(
    ddl,
    {
      dialect: sqlFormatDialectForDbType(databaseType.value),
      databaseType: databaseType.value,
      database: props.database,
      catalog: props.catalog,
      includeDatabaseName: settingsStore.editorSettings.generateSqlIncludeDatabaseName,
      quoteIdentifiers: settingsStore.editorSettings.generateSqlQuoteIdentifiers,
    },
    settingsStore.editorSettings.sqlFormatter,
  );
}

function resetDdlDraft() {
  ddlDraft.value = null;
  updateDdlEditorContent(ddlEditorDocument());
}

/** Statements the edited DDL script will execute, split like the SQL editor does. */
function ddlDraftStatements(): string[] {
  const script = ddlDraft.value;
  if (!script) return [];
  return splitSqlStatementRanges(script, databaseType.value)
    .map((statement) => statement.sql.trim())
    .filter((statement) => statement.length > 0);
}

function destroyDdlEditor() {
  ddlEditorInitRequestId += 1;
  ddlEditorScrollCleanup?.();
  ddlEditorScrollCleanup = null;
  ddlEditorView.value?.destroy();
  ddlEditorView.value = null;
}

/** Set while we replace the document ourselves, so the listener below only records real user edits. */
let applyingDdlDocument = false;

function updateDdlEditorContent(content: string): boolean {
  const view = ddlEditorView.value;
  if (!view) return false;
  if (view.state.doc.toString() !== content) {
    applyingDdlDocument = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
    } finally {
      applyingDdlDocument = false;
    }
  }
  return true;
}

function observeDdlEditorScroll(view: EditorView) {
  ddlEditorScrollCleanup?.();
  const scrollDOM = view.scrollDOM;
  const onScroll = (event: Event) => onStructureContentScroll("ddl", event);
  scrollDOM.addEventListener("scroll", onScroll, { passive: true });
  ddlEditorScrollCleanup = () => scrollDOM.removeEventListener("scroll", onScroll);
}

watch(selectLineEndsShortcut, (shortcut) => {
  ddlEditorView.value?.dispatch({ effects: ddlEditorShortcut.reconfigure(codeMirrorKeymap.of([{ key: shortcutToCodeMirrorKey(shortcut), preventDefault: true, run: selectLineEnds }])) });
});

async function initDdlEditor(content: string) {
  const container = ddlEditorContainer.value;
  if (!container) return;

  const existingView = ddlEditorView.value;
  // Read-only is baked into the state, so a view built while the DDL was still
  // empty (placeholder text) can only be reused while its editability still
  // matches — otherwise the tab would stay stuck uneditable after real DDL
  // arrived, and rebuilding is the only way to swap the extension.
  if (existingView?.dom.parentElement === container && existingView.state.readOnly === !ddlEditingEnabled.value) {
    updateDdlEditorContent(content);
    existingView.focus();
    return;
  }
  if (existingView) destroyDdlEditor();

  const requestId = ++ddlEditorInitRequestId;
  const [{ EditorView, keymap }, { EditorState, Prec }, langSql, { basicSetup }, { search: cmSearch }] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("codemirror"), import("@codemirror/search")]);
  if (requestId !== ddlEditorInitRequestId || activeTab.value !== "ddl" || loading.value || ddlLoading.value || ddlEditorContainer.value !== container) return;

  const editorSettings = settingsStore.editorSettings;
  const themeExt = await loadEditorTheme(editorSettings.theme, isDark.value ? "dark" : "light", undefined, themePalette.value);
  if (requestId !== ddlEditorInitRequestId || activeTab.value !== "ddl" || loading.value || ddlLoading.value || ddlEditorContainer.value !== container) return;

  const fontExt = editorFontTheme(EditorView, editorSettings.fontSize, editorSettings.fontFamily, { fixedHeight: true, scrollable: true });
  const dialect = createDbxCodeMirrorSqlDialect(langSql, codeMirrorSqlDialectForConnection(connection.value), databaseType.value, connection.value?.driver_profile);
  const state = EditorState.create({
    doc: content,
    extensions: [
      cmSearch({
        top: true,
        createPanel: () => {
          const dom = document.createElement("span");
          dom.style.display = "none";
          return { dom };
        },
        scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: "center" }),
      }),
      basicSetup,
      EditorState.allowMultipleSelections.of(true),
      langSql.sql({ dialect }),
      themeExt,
      fontExt,
      ddlEditorShortcut.of(keymap.of([{ key: shortcutToCodeMirrorKey(selectLineEndsShortcut()), preventDefault: true, run: selectLineEnds }])),
      EditorView.domEventHandlers({
        keydown(event, eventView) {
          if (!matchesShortcut(event, selectLineEndsShortcut())) return false;
          event.preventDefault();
          return selectLineEnds(eventView);
        },
      }),
      Prec.highest(keymap.of([{ key: "Mod-f", run: () => ddlSearchPanelRef.value?.openSearch() ?? false, preventDefault: true }])),
      EditorView.theme({
        "&.cm-focused": { outline: "none" },
        ".cm-content": {
          cursor: "text",
          padding: "0.75rem",
          userSelect: "text",
          WebkitUserSelect: "text",
        },
        ".cm-line": {
          userSelect: "text",
          WebkitUserSelect: "text",
        },
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || applyingDdlDocument || !ddlEditingEnabled.value) return;
        ddlDraft.value = update.state.doc.toString();
      }),
      EditorState.readOnly.of(!ddlEditingEnabled.value),
    ],
  });
  const editorView = new EditorView({ state, parent: container });
  if (requestId !== ddlEditorInitRequestId || activeTab.value !== "ddl" || loading.value || ddlLoading.value || ddlEditorContainer.value !== container) {
    editorView.destroy();
    return;
  }
  ddlEditorView.value = editorView;
  observeDdlEditorScroll(editorView);
  editorView.focus();
  restoreStructureScrollPosition("ddl");
}

function scheduleDdlEditorInit() {
  void nextTick(() => {
    if (activeTab.value !== "ddl" || loading.value || ddlLoading.value) return;
    void initDdlEditor(ddlEditorDocument());
  });
}

/**
 * Applies the SQL generation preferences (database qualifier + identifier
 * quoting) to a DDL statement generated from the pending structure changes
 * before it is executed. Oracle folds bare identifiers to uppercase, so safe
 * quoted names are uppercased before their quotes are removed.
 */
function applyDdlGenerationPreferences(sql: string, dialect: SqlFormatDialect): string {
  const unqualified = applyDdlDatabaseQualifier(sql, dialect, databaseType.value, settingsStore.editorSettings.generateSqlIncludeDatabaseName, props.database, props.catalog);
  if (settingsStore.editorSettings.generateSqlQuoteIdentifiers) return unqualified;
  return formatGeneratedDdlIdentifierQuotes(unqualified, dialect, false, { preserveCaseSensitiveIdentifiers: tableStoresCaseSensitiveIdentifiers.value });
}

type StructureDdlRequest = {
  connectionId: string;
  queryTimeoutSecs?: number;
  database: string;
  schema: string;
  tableName: string;
  catalog?: string;
  objectType?: "VIEW";
  exactIdentity?: boolean;
};

function ddlRequest(): StructureDdlRequest {
  return {
    connectionId: props.connectionId,
    queryTimeoutSecs: store.getConfig(props.connectionId)?.query_timeout_secs,
    database: props.database,
    schema: metadataSchema.value,
    tableName: props.tableName,
    catalog: props.catalog,
    objectType: props.tableType === "view" ? "VIEW" : undefined,
    ...(props.exactIdentity ? { exactIdentity: true } : {}),
  };
}

function getStructureColumns(request: StructureDdlRequest) {
  return request.exactIdentity ? api.getColumns(request.connectionId, request.database, request.schema, request.tableName, request.catalog, undefined, undefined, true) : api.getColumns(request.connectionId, request.database, request.schema, request.tableName, request.catalog);
}

async function fetchDdl(force = false, options?: { preserveDraft?: boolean }) {
  if (!props.connectionId || !props.database || !props.tableName || (!force && ddlFetched.value) || !tableMetadataCapabilities.value.ddl) return;
  const initialDdlDraft = ddlDraft.value;
  const canReplaceDraft = () => !options?.preserveDraft || (!saving.value && !hasPendingStructureChanges() && !ddlDirty.value && !triggerStructureRecovery.value && ddlDraft.value === initialDdlDraft);
  if (!canReplaceDraft()) return;
  if (force) destroyDdlEditor();
  const request = ddlRequest();
  const separateIndexes = (databaseType.value === "oracle" || databaseType.value === "oceanbase-oracle") && ddlIndexesSeparated.value;
  const requestId = ++ddlLoadRequestId;
  const revision = store.connectionStateRevision(request.connectionId);
  const fingerprint = connection.value ? connectionConfigFingerprint(connection.value) : "";
  const current = () =>
    !primaryKeyUnmounted &&
    requestId === ddlLoadRequestId &&
    JSON.stringify(request) === JSON.stringify(ddlRequest()) &&
    separateIndexes === ((databaseType.value === "oracle" || databaseType.value === "oceanbase-oracle") && ddlIndexesSeparated.value) &&
    store.connectionStateRevision(request.connectionId) === revision &&
    (connection.value ? connectionConfigFingerprint(connection.value) : "") === fingerprint;
  ddlLoading.value = true;
  ddlLoadError.value = "";
  try {
    const { ddl } = await loadObjectDdl({ ...request, separateIndexes }, { force });
    const formatted = await formatStructureDdl(ddl);
    if (!current() || !canReplaceDraft()) return;
    if (options?.preserveDraft) ddlDraft.value = null;
    rawDdlContent.value = formatted;
    ddlFetched.value = true;
  } catch (e: any) {
    if (!current() || !canReplaceDraft()) return;
    ddlLoadError.value = String(e?.message || e);
    ddlFetched.value = false;
  } finally {
    if (current()) ddlLoading.value = false;
  }
}
const errorMessage = ref("");
const secondaryMetadataErrors = ref<Partial<Record<ObjectMetadataFacet, string>>>({});
const columns = ref<EditableStructureColumn[]>([]);
const starrocksStatusBusy = ref(false);
const starrocksStatusRevision = ref(0);
const starrocksSubmittedSql = ref<{ target: string; sql: string }>();
const starrocksStatusTarget = computed(() => JSON.stringify([props.connectionId, props.database, props.tableName, props.schema, props.catalog]));
const starrocksDraftDirty = computed(() => hasPendingStructureChanges() || ddlDirty.value);
const starrocksAlterContext = ref<StarRocksAlterOptions>();
const starrocksLayoutCopyOpen = ref(false);
const starrocksSortColumns = ref<string[]>();
const pendingStarRocksSort = computed(() => (starrocksSortColumns.value && starrocksAlterContext.value?.sortColumns && JSON.stringify(starrocksSortColumns.value) !== JSON.stringify(starrocksAlterContext.value.sortColumns) ? starrocksSortColumns.value : undefined));
async function authorizeStarRocksLayoutCopy(sql: string): Promise<boolean> {
  const config = store.getConfig(props.connectionId);
  const productionContext = productionContextForDatabase(config, props.database);
  return !productionContext.active || (await productionSafetyStore.requestConfirmation({ sql, connectionName: config?.name, database: props.database, productionDatabases: productionContext.databases, source: t("starrocksLayout.copyTitle") }));
}
const copyColumnsDialogOpen = ref(false);
const pasteColumnsDialogOpen = ref(false);
const copySourceConnectionId = ref("");
const copySourceDatabase = ref("");
const copySourceSchema = ref("");
const copySourceCatalog = ref("");
const copySourceDatabases = ref<string[]>([]);
const copySourceSchemas = ref<string[]>([]);
const copySourceCatalogs = ref<CatalogInfo[]>([]);
const copySourceScopeLoading = ref(false);
const copySourceScopeReady = ref(false);
let copySourceScopeRequestId = 0;
const copySourceTables = ref<TableInfo[]>([]);
const copySourceTableName = ref("");
const copySourceTableSearch = ref("");
const copySourceColumns = ref<ColumnInfo[]>([]);
const copySourceColumnSearch = ref("");
const selectedCopySourceColumnNames = ref<string[]>([]);
const copySourceTablesLoading = ref(false);
const copySourceTablesOffset = ref(0);
const copySourceTablesHasMore = ref(false);
const copySourceColumnsLoading = ref(false);
const copySourceError = ref("");
const COPY_SOURCE_TABLE_PAGE_SIZE = 100;
const COPY_SOURCE_TABLE_PAGE_PROBE_SIZE = COPY_SOURCE_TABLE_PAGE_SIZE + 2;
const COPY_SOURCE_TABLE_SEARCH_DEBOUNCE_MS = 250;
let copySourceTablesRequestId = 0;
let copySourceColumnsRequestId = 0;
let copySourceTableSearchTimer: ReturnType<typeof setTimeout> | undefined;
const indexes = ref<EditableStructureIndex[]>([]);
const indexColumnSort = ref<StructureIndexColumnSort | null>(null);
const displayedIndexes = computed(() => (indexColumnSort.value ? sortStructureIndexesByColumns(indexes.value, indexColumnSort.value) : indexes.value));

function toggleIndexColumnSort() {
  indexColumnSort.value = indexColumnSort.value === "asc" ? "desc" : indexColumnSort.value === "desc" ? null : "asc";
}
/** PostgreSQL partitioned parent (`relkind = 'p'`): `CREATE INDEX CONCURRENTLY`
 * is rejected by the server on such tables, so the option is disabled here and
 * the SQL builder refuses any concurrent request on it (fail closed). */
const isPartitionedParent = ref(false);
// True when the edited table is itself a member partition of another table.
const isTablePartition = ref(false);
// True when the edited table is a PostgreSQL foreign table (relkind = 'f').
// PostgreSQL requires `COMMENT ON FOREIGN TABLE` for these, so the SQL
// preview must know which form to generate.
const isForeignTable = ref(false);
// The partition-status probe has settled (success or failure), so the tab can
// be hidden without hiding it merely because the probe is still in flight.
const partitionStatusResolved = ref(false);

/**
 * Standalone partition-status probe for entry points that intentionally skip
 * `loadStructure` (opening directly on the DDL tab). It only decides whether the
 * Partitions tab is offered; the Concurrent-index normalization still runs from
 * `loadStructure` when an editable tab loads.
 */
let partitionTabProbeRequestId = 0;
async function probePartitionsTabVisibility() {
  if (!tableMetadataCapabilities.value.partitions || isCreateMode.value) {
    isPartitionedParent.value = false;
    isTablePartition.value = false;
    isForeignTable.value = false;
    partitionStatusResolved.value = true;
    return;
  }
  const connectionId = props.connectionId;
  const database = props.database;
  const tableName = props.tableName;
  if (!connectionId || !database || !tableName) {
    partitionStatusResolved.value = true;
    return;
  }
  const requestId = ++partitionTabProbeRequestId;
  try {
    const status = await api.getTablePartitionStatus(connectionId, database, metadataSchema.value, tableName);
    if (requestId !== partitionTabProbeRequestId) return;
    isPartitionedParent.value = status.isPartitionedParent;
    isTablePartition.value = status.isPartition;
    isForeignTable.value = status.isForeign;
    partitionStatusResolved.value = true;
  } catch {
    if (requestId !== partitionTabProbeRequestId) return;
    isPartitionedParent.value = false;
    isTablePartition.value = false;
    isForeignTable.value = false;
    // A failed probe leaves the concurrent-index availability unknown, so keep
    // the documented fail-closed behavior (disable Concurrent) instead of
    // assuming the table is a plain, non-partitioned one.
    partitionStatusKnown.value = false;
    partitionStatusResolved.value = true;
  }
}
/** Whether the last partition-status probe succeeded. When it cannot be
 * verified (probe failed), Concurrent is disabled — we must not assume a
 * non-partitioned table we could not check. */
const partitionStatusKnown = ref(true);
/** Set when a `concurrently: true` index draft had to be normalized away
 * because Concurrent availability became unknown/unsupported (partition probe
 * failure, partitioned parent, capability loss). While set, no SQL is
 * generated and Save stays blocked until the user re-verifies (the next
 * successful probe clears it) — a cleared flag must never silently degrade
 * into a blocking `CREATE INDEX`. */
const concurrentAvailabilityInvalidated = ref(false);
const pendingStatements = ref<string[]>([]);
const warnings = ref<string[]>([]);
function structureWarningText(warning: string): string {
  if (warning === "Table name is required.") return t("diagram.tableNameRequired");
  return translateMysqlAutoIncrementWarning(t, warning);
}
const sqliteSchemaRevision = ref<string>();
const foreignKeys = ref<EditableStructureForeignKey[]>([]);
const foreignKeyDefinitionBusy = ref(false);
const foreignKeyReferenceColumns = ref<Record<string, ColumnInfo[]>>({});
const foreignKeyReferenceListPrefix = `oracle-fk-columns-${uuid()}`;
const constraints = ref<ConstraintInfo[]>([]);
const constraintsLoaded = ref(false);
// Structured PostgreSQL partitioning view (partitioned parent, its descendant
// partitions, or a member partition's parent/bound). Read-only for now.
const partitioning = ref<PgTablePartitioning | null>(null);
const partitionsLoading = ref(false);
const partitionsError = ref("");
// Pending partition operations (not yet saved). Unlike columns/indexes these
// are explicit actions on the live catalog, so they are never diffed — they
// accumulate here until Save, then are cleared and the tree reloaded.
const partitionOperations = ref<TablePartitionOperation[]>([]);
// Create-mode partitioning declaration (`CREATE TABLE ... PARTITION BY ...`).
const createPartitioningEnabled = ref(false);
const createPartitioningKind = ref<PgPartitionKind>("range");
const createPartitioningColumns = ref<string[]>([]);
const createPartitioningExpression = ref("");

const partitionTreeRows = computed(() =>
  flattenPgPartitionNodes(partitioning.value?.partitions ?? [], {
    schema: metadataSchema.value,
    name: props.tableName || "",
  }),
);
// Folded parents, so a large partition hierarchy can be navigated by level.
const collapsedPartitionKeys = ref<Set<string>>(new Set());

function togglePartitionRow(key: string) {
  const next = new Set(collapsedPartitionKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedPartitionKeys.value = next;
}

watch(
  () => partitioning.value,
  () => {
    collapsedPartitionKeys.value = new Set();
  },
);

const partitionVisibleRows = computed(() => visiblePgPartitionRows(partitionTreeRows.value, collapsedPartitionKeys.value));
const partitionCreatableColumns = computed(() => columns.value.filter((column) => !column.markedForDrop && !!column.name.trim()).map((column) => column.name.trim()));

function partitionStrategyLabel(kind?: PgPartitionKind): string {
  const key = pgPartitionKindLabelKey(kind);
  return key ? t(key) : "";
}

// --- Partition maintenance -------------------------------------------------
const partitionDialogOpen = ref(false);
const partitionDialogMode = ref<TablePartitionOperationKind>("create");
const partitionDialogName = ref("");
const partitionDialogSchema = ref("");
const partitionDialogParentSchema = ref("");
const partitionDialogParentTable = ref("");
const partitionDialogBoundKind = ref<PgPartitionKind | "default">("range");
const partitionDialogRangeFrom = ref("");
const partitionDialogRangeTo = ref("");
const partitionDialogListValues = ref("");
const partitionDialogModulus = ref("2");
const partitionDialogRemainder = ref("0");
const partitionDialogConcurrently = ref(false);
const partitionDialogError = ref("");

const canManagePartitions = computed(() => {
  if (!tableMetadataCapabilities.value.partitions) return false;
  if (isCreateMode.value) return createPartitioningEnabled.value;
  return !!partitioning.value && (partitioning.value.isPartitioned || partitioning.value.isPartition);
});
const partitionSupportsConcurrentDetach = computed(() => databaseType.value === "postgres" && (partitioning.value?.serverVersionNum ?? 0) >= 140000 && !partitioning.value?.defaultPartition);
const partitionDialogNeedsBound = computed(() => partitionDialogMode.value === "create" || partitionDialogMode.value === "attach");

function resetPartitionDialog() {
  partitionDialogName.value = "";
  partitionDialogSchema.value = "";
  partitionDialogParentSchema.value = "";
  partitionDialogParentTable.value = "";
  partitionDialogBoundKind.value = isCreateMode.value ? createPartitioningKind.value : "range";
  partitionDialogRangeFrom.value = "";
  partitionDialogRangeTo.value = "";
  partitionDialogListValues.value = "";
  partitionDialogModulus.value = "2";
  partitionDialogRemainder.value = "0";
  partitionDialogConcurrently.value = false;
  partitionDialogError.value = "";
}

function openPartitionDialog(mode: TablePartitionOperationKind, boundKind?: PgPartitionKind) {
  resetPartitionDialog();
  partitionDialogMode.value = mode;
  partitionDialogBoundKind.value = boundKind ?? (isCreateMode.value ? createPartitioningKind.value : partitioning.value?.strategy) ?? "range";
  partitionDialogOpen.value = true;
}

function openPartitionRowOperation(mode: TablePartitionOperationKind, row: PgPartitionTreeRow) {
  openPartitionDialog(mode);
  partitionDialogName.value = row.node.name;
  partitionDialogSchema.value = row.node.schema;
  partitionDialogParentSchema.value = row.parentSchema ?? "";
  partitionDialogParentTable.value = row.parentName ?? "";
}

/** Detaching the partition currently being edited: the parent is not the
 * edited table, so it must be named explicitly. */
function openDetachSelfPartitionDialog() {
  openPartitionDialog("detach");
  partitionDialogName.value = props.tableName || "";
  partitionDialogSchema.value = metadataSchema.value;
  partitionDialogParentSchema.value = partitioning.value?.parentSchema ?? "";
  partitionDialogParentTable.value = partitioning.value?.parentTable ?? "";
}

/** `reportError` separates the confirm path (which surfaces validation
 * messages) from the live SQL preview (which stays quiet while the user is
 * still typing). */
function partitionDialogBound(reportError: boolean): TablePartitionBoundDraft | undefined {
  const kind = partitionDialogBoundKind.value;
  if (kind === "default") return { kind: "default" };
  if (kind === "range") {
    const from = splitPgPartitionBoundValues(partitionDialogRangeFrom.value);
    const to = splitPgPartitionBoundValues(partitionDialogRangeTo.value);
    if (!from.length || from.length !== to.length) {
      if (reportError) partitionDialogError.value = t("structureEditor.partitionRangeBoundInvalid");
      return undefined;
    }
    return { kind: "range", from, to };
  }
  if (kind === "list") {
    const values = splitPgPartitionBoundValues(partitionDialogListValues.value);
    if (!values.length) {
      if (reportError) partitionDialogError.value = t("structureEditor.partitionListBoundInvalid");
      return undefined;
    }
    return { kind: "list", values };
  }
  const modulus = Number.parseInt(partitionDialogModulus.value, 10);
  const remainder = Number.parseInt(partitionDialogRemainder.value, 10);
  if (!Number.isInteger(modulus) || modulus <= 0 || !Number.isInteger(remainder) || remainder < 0 || remainder >= modulus) {
    if (reportError) partitionDialogError.value = t("structureEditor.partitionHashBoundInvalid");
    return undefined;
  }
  return { kind: "hash", modulus, remainder };
}

function partitionDialogOperation(reportError: boolean, id: string): TablePartitionOperation | undefined {
  const mode = partitionDialogMode.value;
  const name = partitionDialogName.value.trim();
  if (!name) {
    if (reportError) partitionDialogError.value = t("structureEditor.partitionNameRequired");
    return undefined;
  }
  let bound: TablePartitionBoundDraft | undefined;
  if (partitionDialogNeedsBound.value) {
    bound = partitionDialogBound(reportError);
    if (!bound) return undefined;
  }
  return {
    id,
    kind: mode,
    parentSchema: partitionDialogParentSchema.value.trim(),
    parentTable: partitionDialogParentTable.value.trim(),
    schema: partitionDialogSchema.value.trim(),
    name,
    bound,
    concurrently: mode === "detach" && partitionDialogConcurrently.value && partitionSupportsConcurrentDetach.value,
  };
}

function confirmPartitionDialog() {
  partitionDialogError.value = "";
  const operation = partitionDialogOperation(true, `partition-op:${uuid()}`);
  if (!operation) return;
  partitionOperations.value = [...partitionOperations.value, operation];
  partitionDialogOpen.value = false;
  scheduleSqlPreviewRefresh();
  syncDraftToParent();
}

const partitionDialogSql = ref("");
const partitionDialogSqlWarnings = ref<string[]>([]);
let partitionDialogSqlTimer: ReturnType<typeof setTimeout> | undefined;
let partitionDialogSqlRequestId = 0;

/** Rebuilds the statement the dialog would queue, using the same backend
 * builder the save path uses, so the preview can never drift from execution. */
async function refreshPartitionDialogSql() {
  if (!partitionDialogOpen.value) {
    partitionDialogSql.value = "";
    partitionDialogSqlWarnings.value = [];
    return;
  }
  const operation = partitionDialogOperation(false, "partition-preview");
  if (!operation) {
    partitionDialogSql.value = "";
    partitionDialogSqlWarnings.value = [];
    return;
  }
  const requestId = ++partitionDialogSqlRequestId;
  try {
    const result = await api.buildTablePartitionOperationSql({ ...partitionSqlOptions(), operations: [operation] });
    if (requestId !== partitionDialogSqlRequestId) return;
    partitionDialogSql.value = result.statements.join("\n");
    partitionDialogSqlWarnings.value = result.warnings;
  } catch (error: any) {
    if (requestId !== partitionDialogSqlRequestId) return;
    partitionDialogSql.value = "";
    partitionDialogSqlWarnings.value = [error?.message || String(error)];
  }
}

function schedulePartitionDialogSqlRefresh() {
  if (partitionDialogSqlTimer) clearTimeout(partitionDialogSqlTimer);
  partitionDialogSqlTimer = setTimeout(() => {
    partitionDialogSqlTimer = undefined;
    void refreshPartitionDialogSql();
  }, 150);
}

function removePartitionOperation(id: string) {
  partitionOperations.value = partitionOperations.value.filter((operation) => operation.id !== id);
  scheduleSqlPreviewRefresh();
  syncDraftToParent();
}

watch(
  [
    partitionDialogOpen,
    partitionDialogMode,
    partitionDialogName,
    partitionDialogSchema,
    partitionDialogParentSchema,
    partitionDialogParentTable,
    partitionDialogBoundKind,
    partitionDialogRangeFrom,
    partitionDialogRangeTo,
    partitionDialogListValues,
    partitionDialogModulus,
    partitionDialogRemainder,
    partitionDialogConcurrently,
  ],
  () => schedulePartitionDialogSqlRefresh(),
  { flush: "post" },
);

function partitionOperationLabel(kind: TablePartitionOperationKind): string {
  switch (kind) {
    case "create":
      return t("structureEditor.partitionAdd");
    case "attach":
      return t("structureEditor.partitionAttach");
    case "detach":
      return t("structureEditor.partitionDetach");
    case "drop":
      return t("structureEditor.partitionDrop");
  }
}

function partitionOperationSummary(operation: TablePartitionOperation): string {
  return `${partitionOperationLabel(operation.kind)}: ${operation.name}`;
}

/** Size/count estimates live in the row's hover hint so the row stays two lines. */
function partitionRowHint(node: PgPartitionNode): string | undefined {
  return pgPartitionRowHint(node, t, formatBytes);
}
// The Constraints tab hides foreign keys when the dedicated Foreign Keys tab
// is also shown, mirroring DataGrid/ObjectBrowser.
const constraintsForTab = computed(() => constraintsForConstraintsTab(constraints.value, tableMetadataCapabilities.value.foreignKeys));
const triggers = ref<EditableStructureTrigger[]>([]);
const triggersLoaded = ref(false);
// Master-detail layout: the list shows one compact row per trigger and the
// selected trigger's editors render in the detail pane below (#8822).
const selectedTriggerId = ref<string | null>(null);
const selectedTrigger = computed(() => triggers.value.find((trigger) => trigger.id === selectedTriggerId.value) ?? null);
const triggerSourceOpen = ref(false);
const triggerSourceDialog = ref<InstanceType<typeof ObjectSourceDialog>>();
const triggerSourceTarget = shallowRef<{ draftId: string; loadedDraft: string; dirtyAtOpen: boolean; didWrite: boolean; tableKey: string; target: OracleTriggerTarget }>();
const triggerSourceRefreshRequired = ref(new Set<string>());
const triggerStructurePlan = shallowRef<OracleTriggerStructurePlan>();
const triggerStructureRecovery = ref<TableStructureEditorDraft["oracleTriggerStructureRecovery"]>();
let triggerStructureFingerprint = "";
const triggerStructureActive = ref(true);
let triggerStructureConfirmationScope: string | undefined;
function cancelTriggerStructureConfirmation() {
  if (!triggerStructureConfirmationScope) return;
  useSqlExecutionDangerStore().cancelScope(triggerStructureConfirmationScope);
  productionSafetyStore.cancelScope(triggerStructureConfirmationScope);
}
const triggerStructureKey = () => JSON.stringify([props.connectionId, props.database, props.catalog, props.schema, props.tableName]);
const triggerSourceKey = (target: Readonly<OracleTriggerTarget>) => JSON.stringify([target.connectionId, target.database, target.catalog, target.owner, target.name, target.executionSchema]);
let triggerBaselineRequest = 0;
watch(
  () => [triggerStructureKey(), selectedTrigger.value?.original] as const,
  async () => {
    const request = ++triggerBaselineRequest;
    const trigger = selectedTrigger.value;
    const metadata = exactOracleTriggerMetadata(trigger?.original);
    if (!trigger || !metadata || trigger.loadedOracleSource !== undefined) return;
    const key = triggerStructureKey();
    try {
      const loaded = await readOracleTriggerSource({ connectionId: props.connectionId, database: props.database, catalog: props.catalog, owner: metadata.owner, name: metadata.name, executionSchema: props.schema || metadataSchema.value! });
      if (request !== triggerBaselineRequest || key !== triggerStructureKey() || !triggers.value.includes(trigger)) return;
      if (!loaded.snapshot?.exists || loaded.snapshot.metadata.objectId !== metadata.objectId) throw new Error(t("oracleTrigger.reloadBaseline"));
      if (triggerChanged(trigger) && (trigger.name !== trigger.original!.name || trigger.statement !== trigger.original!.statement || trigger.timing !== trigger.original!.timing || trigger.event !== trigger.original!.event)) throw new Error(t("oracleTrigger.reloadBaseline"));
      const inspected = await inspectExactOracleTriggerSource(loaded.snapshot.raw, metadata.owner, metadata.name);
      if (request !== triggerBaselineRequest || key !== triggerStructureKey() || !triggers.value.includes(trigger)) return;
      trigger.loadedOracleSource = loaded.snapshot.raw.source;
      trigger.loadedOracleStructured = inspected.triggerSource.complete && inspected.triggerSource.prepared?.structuredEditable === true;
      syncDraftToParent();
    } catch (error) {
      if (request === triggerBaselineRequest && key === triggerStructureKey()) errorMessage.value = error instanceof Error ? error.message : String(error);
    }
  },
);
watch(triggerStructureKey, () => {
  triggerSourceOpen.value = false;
  triggerSourceRefreshRequired.value.clear();
});

function openTriggerFullSource(trigger: EditableStructureTrigger) {
  const metadata = exactOracleTriggerMetadata(trigger.original);
  if (!metadata || !oracleTriggerReadOptions(databaseType.value)) return;
  const next = { connectionId: props.connectionId, database: props.database, catalog: props.catalog, owner: metadata.owner, name: metadata.name, executionSchema: props.schema || metadataSchema.value };
  if (triggerSourceTarget.value && triggerSourceKey(triggerSourceTarget.value.target) !== triggerSourceKey(next) && triggerSourceDialog.value?.hasUnsavedDraft() && !window.confirm(t("objects.refreshDiscardConfirm"))) return;
  triggerSourceTarget.value = { draftId: trigger.id, loadedDraft: JSON.stringify(trigger), dirtyAtOpen: triggerChanged(trigger), didWrite: false, tableKey: triggerStructureKey(), target: next };
  triggerSourceOpen.value = true;
}

function mergeTriggerSourceSnapshot(snapshot: OracleTriggerSnapshot) {
  const context = triggerSourceTarget.value;
  if (!context || !context.didWrite || context.tableKey !== triggerStructureKey() || triggerSourceKey(snapshot.target) !== triggerSourceKey(context.target)) return;
  const index = triggers.value.findIndex((trigger) => trigger.id === context.draftId);
  if (index < 0) return;
  if (!snapshot.exists || !snapshot.raw.trigger || context.dirtyAtOpen || JSON.stringify(triggers.value[index]) !== context.loadedDraft) {
    triggerSourceRefreshRequired.value.add(context.draftId);
    errorMessage.value = `${context.target.owner}.${context.target.name}: ${t("oracleTrigger.reloadBaseline")}`;
    return;
  }
  const updated = { ...createTriggerDrafts([snapshot.raw.trigger])[0]!, id: context.draftId };
  triggers.value.splice(index, 1, updated);
  context.loadedDraft = JSON.stringify(updated);
  triggerSourceRefreshRequired.value.delete(context.draftId);
  scheduleSqlPreviewRefresh();
}

function recordTriggerSourceResult(target: Readonly<OracleTriggerTarget>, result: OracleTriggerExecutionResult) {
  const context = triggerSourceTarget.value;
  if (!context || context.tableKey !== triggerStructureKey() || triggerSourceKey(target) !== triggerSourceKey(context.target) || result.cancelled || !result.steps.some((step) => step.state !== "notExecuted")) return;
  context.didWrite = true;
  if (result.snapshot) mergeTriggerSourceSnapshot(result.snapshot);
  else {
    triggerSourceRefreshRequired.value.add(context.draftId);
    errorMessage.value = `${target.owner}.${target.name}: ${t("oracleTrigger.reloadBaseline")}`;
  }
}

async function reloadTriggerDraftAfterSource(trigger: EditableStructureTrigger) {
  const metadata = exactOracleTriggerMetadata(trigger.original);
  if (!metadata || (triggerChanged(trigger) && !window.confirm(t("oracleTrigger.refreshDraftConfirm")))) return;
  const key = triggerStructureKey();
  const previous = JSON.stringify(trigger);
  try {
    const loaded = await readOracleTriggerSource({ connectionId: props.connectionId, database: props.database, catalog: props.catalog, owner: metadata.owner, name: metadata.name, executionSchema: props.schema || metadataSchema.value });
    if (key !== triggerStructureKey()) return;
    const index = triggers.value.findIndex((item) => item.id === trigger.id);
    if (index < 0 || JSON.stringify(triggers.value[index]) !== previous) return;
    if (!loaded.snapshot?.exists || !loaded.snapshot.raw.trigger) throw new Error(loaded.identityError || t("oracleTrigger.reloadBaseline"));
    triggers.value.splice(index, 1, { ...createTriggerDrafts([loaded.snapshot.raw.trigger])[0]!, id: trigger.id });
    triggerSourceRefreshRequired.value.delete(trigger.id);
    errorMessage.value = "";
    scheduleSqlPreviewRefresh();
  } catch (error) {
    if (key === triggerStructureKey()) errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}
// Inline rename state: the list row itself stays a click-to-select target;
// the pencil button flips the name cell into an input (#8822 feedback).
const renamingTriggerId = ref<string | null>(null);

function startRenameTrigger(trigger: EditableStructureTrigger) {
  selectedTriggerId.value = trigger.id;
  renamingTriggerId.value = trigger.id;
}
watch(
  [triggers, selectedTriggerId],
  () => {
    if (triggers.value.length === 0) {
      if (selectedTriggerId.value !== null) selectedTriggerId.value = null;
      return;
    }
    if (!triggers.value.some((trigger) => trigger.id === selectedTriggerId.value)) {
      selectedTriggerId.value = triggers.value[0].id;
    }
  },
  { immediate: true },
);

function selectTrigger(trigger: EditableStructureTrigger) {
  selectedTriggerId.value = trigger.id;
}
const secondaryMetadataLoading = computed(() => indexesLoading.value || foreignKeysLoading.value || constraintsLoading.value || triggersLoading.value || partitionsLoading.value);

function sameList(left: string[] | null | undefined, right: string[] | null | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameText(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? "") === (right ?? "");
}

function columnChanged(column: EditableStructureColumn, index: number): boolean {
  if (!column.original || column.markedForDrop) return true;
  const original = column.original;
  return (
    isPhysicalTableColumnOrderChange(databaseType.value, connection.value?.db_type, column.originalPosition, index, structureCapabilities.value.reorderColumn ? starrocksAlterContext.value?.model : undefined) ||
    column.name !== original.name ||
    column.dataType !== original.data_type ||
    column.isNullable !== original.is_nullable ||
    !sameText(column.defaultValue, original.column_default) ||
    !sameText(column.comment, original.comment) ||
    column.isPrimaryKey !== original.is_primary_key ||
    !sameText(column.characterSet, original.character_set) ||
    !sameText(column.collation, original.collation) ||
    (showExtendedProperties.value && JSON.stringify(column.extra) !== JSON.stringify(parseExtraToColumnExtra(original.extra, databaseType.value)))
  );
}

function indexChanged(index: EditableStructureIndex): boolean {
  if (!index.original || index.oracleOriginalMissing || index.markedForDrop) return true;
  const original = index.original;
  return (
    index.name !== original.name ||
    !sameList(index.columns, original.columns) ||
    index.isUnique !== original.is_unique ||
    !sameText(index.filter, original.filter) ||
    !sameStructureIndexType(index.indexType, original.index_type) ||
    !sameList(index.includedColumns, original.included_columns) ||
    !sameText(index.comment, original.comment) ||
    !!index.concurrently
  );
}

function foreignKeyChanged(foreignKey: EditableStructureForeignKey): boolean {
  if (!foreignKey.original || foreignKey.markedForDrop) return true;
  if (foreignKey.oracleOriginal) {
    const original = foreignKey.oracleOriginal;
    return (
      foreignKey.name !== original.name ||
      JSON.stringify(foreignKey.columns) !== JSON.stringify(original.columns) ||
      foreignKey.refSchema !== original.refSchema ||
      foreignKey.refTable !== original.refTable ||
      JSON.stringify(foreignKey.refColumns) !== JSON.stringify(original.refColumns) ||
      (foreignKey.onDelete || "NO ACTION") !== original.onDelete ||
      JSON.stringify(foreignKey.oracleState) !== JSON.stringify(original.state)
    );
  }
  const original = foreignKey.original;
  return (
    foreignKey.name !== original.name ||
    foreignKey.column !== original.column ||
    !sameText(foreignKey.refSchema, original.ref_schema) ||
    foreignKey.refTable !== original.ref_table ||
    foreignKey.refColumn !== original.ref_column ||
    !sameText(foreignKey.onUpdate, original.on_update) ||
    !sameText(foreignKey.onDelete, original.on_delete)
  );
}

function oracleForeignKeyChanges() {
  return foreignKeys.value.filter(foreignKeyChanged).map((foreignKey) => {
    const original = foreignKey.oracleOriginal ?? null;
    const target = foreignKey.markedForDrop
      ? null
      : {
          name: foreignKey.name,
          columns: [...(foreignKey.columns ?? [])],
          refSchema: foreignKey.refSchema,
          refTable: foreignKey.refTable,
          refColumns: [...(foreignKey.refColumns ?? [])],
          onDelete: (foreignKey.onDelete || "NO ACTION") as "NO ACTION" | "CASCADE" | "SET NULL",
          state: { ...(foreignKey.oracleState ?? { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false }) },
        };
    return { original, target };
  });
}

function triggerChanged(trigger: EditableStructureTrigger): boolean {
  if (!trigger.original || trigger.markedForDrop) return true;
  const original = trigger.original;
  return trigger.name !== original.name || trigger.timing !== original.timing || trigger.event !== original.event || !sameText(trigger.statement, original.statement) || (trigger.enabled !== undefined && trigger.enabled !== original.enabled);
}

function captureStructureRefreshScope(): TableStructureRefreshScope {
  return {
    columns: columns.value.some(columnChanged) || !!pendingStarRocksSort.value,
    indexes: indexes.value.some(indexChanged),
    foreignKeys: foreignKeys.value.some(foreignKeyChanged),
    // Constraints have no editable draft of their own, but column/index/FK
    // saves can change what constraints exist (e.g. toggling a primary key),
    // so refresh the tab if it was ever loaded rather than leaving it stale.
    constraints: constraintsLoaded.value,
    triggers: triggers.value.some(triggerChanged),
    // Read-only tab with no editable draft; refresh it whenever it was loaded
    // so a save that rebuilds partitions can't leave stale rows behind.
    partitions: loadedMetadataFacets.has("partitions"),
    tableComment: tableComment.value !== originalTableComment.value,
  };
}

function isPlainModShortcut(event: KeyboardEvent, key: string): boolean {
  if (event.isComposing || event.altKey || event.shiftKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return event.key.toLowerCase() === key;
}

const structureDensityValues: StructureEditorDensity[] = ["compact", "standard", "comfortable"];
const STRUCTURE_COLUMNS_WIDTHS_STORAGE_KEY = "dbx-structure-editor-column-widths";
const STRUCTURE_INDEX_COLUMNS_WIDTHS_STORAGE_KEY = "dbx-structure-editor-index-column-widths";
const STRUCTURE_SQL_PREVIEW_COLLAPSED_STORAGE_KEY = "dbx-structure-editor-sql-preview-collapsed";
const FIELD_SHORTCUT_TOOLTIP_DELAY_MS = 500;
const STRUCTURE_COLUMN_VIRTUAL_BUFFER_PX = 320;
const STRUCTURE_COLUMN_VIRTUAL_PRERENDER_ROWS = 24;
const STRUCTURE_COLUMN_SCROLL_INTERACTION_DELAY_MS = 120;
const STRUCTURE_SCROLL_DRAFT_SYNC_DELAY_MS = 180;
const STRUCTURE_COLUMN_WIDTH_COUNT = 12;
const STRUCTURE_INDEX_COLUMN_WIDTH_COUNT = 9;
const PERSISTED_STRUCTURE_INDEX_COLUMN_WIDTHS = new Set([0, 1, 6]);
const structureDensityMetrics: Record<
  StructureEditorDensity,
  {
    columns: number[];
    indexes: number[];
    minColumnWidth: number;
    minLengthColumnWidth: number;
    minIndexColumnWidth: number;
    actionButtonWidth: number;
    fontSize: number;
    shellPadding: number;
    cellPaddingX: number;
    cellPaddingY: number;
    headerPaddingY: number;
    controlHeight: number;
    controlPaddingX: number;
    iconSize: number;
    checkboxSize: number;
    lineHeight: number;
  }
> = {
  compact: {
    columns: [28, 168, 136, 82, 60, 52, 108, 220, 80, 120, 144, 108],
    indexes: [280, 180, 60, 88, 124, 144, 120, 84, 70],
    minColumnWidth: 24,
    minLengthColumnWidth: 140,
    minIndexColumnWidth: 48,
    actionButtonWidth: 24,
    fontSize: 11,
    shellPadding: 10,
    cellPaddingX: 6,
    cellPaddingY: 4,
    headerPaddingY: 5,
    controlHeight: 24,
    controlPaddingX: 8,
    iconSize: 14,
    checkboxSize: 13,
    lineHeight: 1.35,
  },
  standard: {
    columns: [32, 200, 160, 104, 72, 64, 128, 260, 90, 140, 160, 136],
    indexes: [320, 224, 72, 108, 148, 180, 148, 100, 84],
    minColumnWidth: 28,
    minLengthColumnWidth: 156,
    minIndexColumnWidth: 60,
    actionButtonWidth: 28,
    fontSize: 12,
    shellPadding: 12,
    cellPaddingX: 8,
    cellPaddingY: 5,
    headerPaddingY: 7,
    controlHeight: 28,
    controlPaddingX: 10,
    iconSize: 15,
    checkboxSize: 14,
    lineHeight: 1.4,
  },
  comfortable: {
    columns: [36, 232, 188, 116, 84, 76, 152, 300, 100, 160, 188, 148],
    indexes: [360, 260, 84, 124, 176, 216, 176, 116, 104],
    minColumnWidth: 32,
    minLengthColumnWidth: 176,
    minIndexColumnWidth: 64,
    actionButtonWidth: 32,
    fontSize: 13,
    shellPadding: 16,
    cellPaddingX: 10,
    cellPaddingY: 7,
    headerPaddingY: 9,
    controlHeight: 32,
    controlPaddingX: 12,
    iconSize: 16,
    checkboxSize: 16,
    lineHeight: 1.5,
  },
};

function isStructureEditorDensity(value: unknown): value is StructureEditorDensity {
  return structureDensityValues.includes(value as StructureEditorDensity);
}

function metricsForDensity(density: StructureEditorDensity) {
  return structureDensityMetrics[density];
}

function normalizeStructureColumnWidths(value: unknown, density: StructureEditorDensity): number[] | null {
  if (!Array.isArray(value)) return null;
  let widths = value.map((item) => Number(item));
  if (widths.some((item) => !Number.isFinite(item))) return null;
  // Backward compatibility: pad old 11-column persisted layout to 12 by inserting
  // a default collation width at index 9.
  if (widths.length === STRUCTURE_COLUMN_WIDTH_COUNT - 1) {
    const defaultWidths = metricsForDensity(density).columns;
    widths = [...widths.slice(0, 9), defaultWidths[9], ...widths.slice(9)];
  }
  if (widths.length !== STRUCTURE_COLUMN_WIDTH_COUNT) return null;
  const minWidth = metricsForDensity(density).minColumnWidth;
  return widths.map((item) => Math.max(minWidth, item));
}

function normalizeStructureIndexColumnWidths(value: unknown, density: StructureEditorDensity): number[] | null {
  if (!Array.isArray(value) || value.length !== STRUCTURE_INDEX_COLUMN_WIDTH_COUNT) return null;
  const minWidth = metricsForDensity(density).minIndexColumnWidth;
  const widths = value.map((item) => Number(item));
  if (widths.some((item) => !Number.isFinite(item))) return null;
  return widths.map((item) => Math.max(minWidth, item));
}

function loadStructureWidthsByDensity(storageKey: string, density: StructureEditorDensity): unknown {
  const raw = safeLocalStorageGet(storageKey);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<StructureEditorDensity, unknown>>;
    return parsed?.[density];
  } catch {
    return undefined;
  }
}

function loadStructureColumnWidths(density: StructureEditorDensity): number[] {
  const fallback = [...metricsForDensity(density).columns];
  const stored = loadStructureWidthsByDensity(STRUCTURE_COLUMNS_WIDTHS_STORAGE_KEY, density);
  return normalizeStructureColumnWidths(stored, density) ?? fallback;
}

function loadStructureIndexColumnWidths(density: StructureEditorDensity): number[] {
  const fallback = [...metricsForDensity(density).indexes];
  const stored = normalizeStructureIndexColumnWidths(loadStructureWidthsByDensity(STRUCTURE_INDEX_COLUMNS_WIDTHS_STORAGE_KEY, density), density);
  if (!stored) return fallback;
  return fallback.map((width, index) => (PERSISTED_STRUCTURE_INDEX_COLUMN_WIDTHS.has(index) ? stored[index] : width));
}

function saveStructureWidthsByDensity(storageKey: string, density: StructureEditorDensity, widths: readonly number[]) {
  let payload: Partial<Record<StructureEditorDensity, number[]>> = {};
  const raw = safeLocalStorageGet(storageKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") payload = parsed;
    } catch {
      payload = {};
    }
  }
  payload[density] = [...widths];
  safeLocalStorageSet(storageKey, JSON.stringify(payload));
}

function saveStructureColumnWidths(density: StructureEditorDensity, widths: readonly number[]) {
  const normalized = normalizeStructureColumnWidths([...widths], density);
  if (!normalized) return;
  saveStructureWidthsByDensity(STRUCTURE_COLUMNS_WIDTHS_STORAGE_KEY, density, normalized);
}

function saveStructureIndexColumnWidths(density: StructureEditorDensity, widths: readonly number[]) {
  const normalized = normalizeStructureIndexColumnWidths([...widths], density);
  if (!normalized) return;
  const fallback = metricsForDensity(density).indexes;
  const stored = fallback.map((width, index) => (PERSISTED_STRUCTURE_INDEX_COLUMN_WIDTHS.has(index) ? normalized[index] : width));
  saveStructureWidthsByDensity(STRUCTURE_INDEX_COLUMNS_WIDTHS_STORAGE_KEY, density, stored);
}

function loadSqlPreviewCollapsed(): boolean {
  return safeLocalStorageGet(STRUCTURE_SQL_PREVIEW_COLLAPSED_STORAGE_KEY) === "true";
}

const structureDensity = computed(() => settingsStore.editorSettings.structureEditorDensity);
const localStructureDensity = ref<StructureEditorDensity>(structureDensity.value);
const structureDensityMetric = computed(() => metricsForDensity(localStructureDensity.value));
const structureDensityOptions = computed(() => [
  { value: "compact", label: t("structureEditor.densityCompact") },
  { value: "standard", label: t("structureEditor.densityStandard") },
  { value: "comfortable", label: t("structureEditor.densityComfortable") },
]);
const structureDensityStyle = computed(() => {
  const metric = structureDensityMetric.value;
  return {
    "--structure-font-size": `${metric.fontSize}px`,
    "--structure-shell-padding": `${metric.shellPadding}px`,
    "--structure-cell-px": `${metric.cellPaddingX}px`,
    "--structure-cell-py": `${metric.cellPaddingY}px`,
    "--structure-header-py": `${metric.headerPaddingY}px`,
    "--structure-control-height": `${metric.controlHeight}px`,
    "--structure-column-row-height": `${metric.controlHeight + metric.cellPaddingY * 2 + 1}px`,
    "--structure-control-px": `${metric.controlPaddingX}px`,
    "--structure-icon-size": `${metric.iconSize}px`,
    "--structure-checkbox-size": `${metric.checkboxSize}px`,
    "--structure-line-height": String(metric.lineHeight),
  };
});
const structureControlClass = "structure-grid-control h-[var(--structure-control-height)] min-w-0 rounded-[6px] px-[var(--structure-control-px)] py-0 text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25";
const structureMonoControlClass = `${structureControlClass} font-mono`;
const structureToolbarButtonClass = "h-[var(--structure-control-height)] gap-1 px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]";
const structureIconButtonClass = "h-[var(--structure-control-height)] w-[var(--structure-control-height)]";
const structureIconClass = "h-[var(--structure-icon-size)] w-[var(--structure-icon-size)]";
const structureCheckboxClass = "h-[var(--structure-checkbox-size)] w-[var(--structure-checkbox-size)]";
const structureHeaderCellClass = "relative min-w-0 overflow-hidden border-b border-r px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-left last:border-r-0";
const structureCellClass = "min-w-0 overflow-hidden border-b border-r px-[var(--structure-cell-px)] py-[var(--structure-cell-py)] last:border-r-0";
const structureLastCellClass = "min-w-0 overflow-hidden border-b px-[var(--structure-cell-px)] py-[var(--structure-cell-py)]";
const structurePropertyListClass = "flex w-max min-w-0 items-center gap-0 overflow-hidden";
const structurePropertyLabelClass = "flex min-w-0 items-center gap-1 whitespace-nowrap";
const structureActionButtonClass = `${structureIconButtonClass} shrink-0`;
const structureDensityMenuOpen = ref(false);
const structureDensityMenuRef = ref<HTMLElement>();
const structureToolbarRef = ref<HTMLElement>();
const structureToolbarTier = ref<EditorToolbarTier>(0);
let structureToolbarCondensedAtWidth = 0;
let structureToolbarRequiredWidths: Partial<Record<EditorToolbarTier, number>> = {};
let structureToolbarResizeObserver: ResizeObserver | undefined;
let structureToolbarMeasureRaf = 0;

function measureStructureToolbar() {
  const toolbar = structureToolbarRef.value;
  if (!toolbar || !toolbar.clientWidth) return;
  const tier = structureToolbarTier.value;
  const next = resolveNextEditorToolbarTier({
    tier,
    availableWidth: toolbar.clientWidth,
    contentWidth: toolbar.scrollWidth,
    condensedAtWidth: structureToolbarCondensedAtWidth,
    expandedTierRequiredWidths: structureToolbarRequiredWidths,
  });
  if (next > tier) {
    structureToolbarRequiredWidths[tier] = toolbar.scrollWidth;
    structureToolbarCondensedAtWidth = toolbar.clientWidth;
  }
  structureToolbarTier.value = next;
}

function scheduleStructureToolbarMeasurement() {
  if (structureToolbarMeasureRaf || !structureToolbarRef.value?.isConnected) return;
  structureToolbarMeasureRaf = requestAnimationFrame(() => {
    structureToolbarMeasureRaf = 0;
    measureStructureToolbar();
  });
}

function stopStructureToolbarObserver() {
  structureToolbarResizeObserver?.disconnect();
  structureToolbarResizeObserver = undefined;
  if (structureToolbarMeasureRaf) cancelAnimationFrame(structureToolbarMeasureRaf);
  structureToolbarMeasureRaf = 0;
}

function observeStructureToolbar() {
  stopStructureToolbarObserver();
  const toolbar = structureToolbarRef.value;
  if (!toolbar) return;
  if (typeof ResizeObserver !== "undefined") {
    structureToolbarResizeObserver = new ResizeObserver(scheduleStructureToolbarMeasurement);
    structureToolbarResizeObserver.observe(toolbar);
  }
  scheduleStructureToolbarMeasurement();
}

watch(structureToolbarRef, observeStructureToolbar, { flush: "post" });
// A tier changes the content's width even when the toolbar's box stays fixed.
watch(structureToolbarTier, () => void nextTick(scheduleStructureToolbarMeasurement));

function applyStructureDensityWidths(density: StructureEditorDensity) {
  colWidths.value = loadStructureColumnWidths(density);
  indexColWidths.value = loadStructureIndexColumnWidths(density);
}

function setStructureDensity(value: unknown) {
  if (!isStructureEditorDensity(value)) return;
  if (value === localStructureDensity.value) return;
  localStructureDensity.value = value;
}

function selectStructureDensity(value: unknown) {
  setStructureDensity(value);
  structureDensityMenuOpen.value = false;
}

function toggleStructureDensityMenu() {
  structureDensityMenuOpen.value = !structureDensityMenuOpen.value;
}

function focusStructureDensityOption(offset: number) {
  const currentIndex = structureDensityValues.indexOf(localStructureDensity.value);
  const nextIndex = (currentIndex + offset + structureDensityValues.length) % structureDensityValues.length;
  selectStructureDensity(structureDensityValues[nextIndex]);
}

function onStructureDensityKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    structureDensityMenuOpen.value = false;
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!structureDensityMenuOpen.value) {
      structureDensityMenuOpen.value = true;
      return;
    }
    focusStructureDensityOption(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!structureDensityMenuOpen.value) {
      structureDensityMenuOpen.value = true;
      return;
    }
    focusStructureDensityOption(-1);
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    structureDensityMenuOpen.value = !structureDensityMenuOpen.value;
  }
}

function onStructureDensityDocumentPointerdown(event: PointerEvent) {
  if (!structureDensityMenuOpen.value) return;
  const target = event.target;
  if (target instanceof Node && structureDensityMenuRef.value?.contains(target)) return;
  structureDensityMenuOpen.value = false;
}

function persistStructureDensity(density = localStructureDensity.value) {
  if (settingsStore.editorSettings.structureEditorDensity === density) return;
  settingsStore.updateEditorSettings({ structureEditorDensity: density });
}

const colWidths = ref(loadStructureColumnWidths(structureDensity.value));
const colResizing = ref<{ col: number; startX: number; startW: number } | null>(null);
const indexColWidths = ref(loadStructureIndexColumnWidths(structureDensity.value));
const resizing = ref<{ col: number; startX: number; startW: number } | null>(null);
const columnSearchInputRef = ref<InstanceType<typeof Input>>();
const columnSearchText = ref("");
const selectedColumnId = ref<string | null>(null);
// Multi-selection set (ctrl/shift-click) plus the shift-range anchor. The
// legacy `selectedColumnId` stays as the "active" column: it decides where
// new rows are inserted and which row copy/add operations anchor to.
const selectedColumnIds = ref<Set<string>>(new Set());
const columnSelectionAnchorId = ref<string | null>(null);
// The editable field rows have their own selection state for batch structure
// operations. Header selection is a separate mode so clipboard actions do not
// accidentally apply row copy/drop operations to the field rows.
const selectedStructureColumnKeys = ref<Set<string>>(new Set());
const structureColumnSelectionAnchorKey = ref<string | null>(null);
const highlightedColumnId = ref<string | null>(null);
const indexSearchInputRef = ref<InstanceType<typeof Input>>();
const indexSearchText = ref("");
const highlightedIndexId = ref<string | null>(null);
const sqlPreviewCollapsed = ref(loadSqlPreviewCollapsed());
let columnHighlightTimer: ReturnType<typeof window.setTimeout> | undefined;
let indexHighlightTimer: ReturnType<typeof window.setTimeout> | undefined;

watch(
  structureDensity,
  (density) => {
    if (density === localStructureDensity.value) return;
    localStructureDensity.value = density;
  },
  { flush: "sync" },
);

watch(localStructureDensity, (density, previousDensity) => {
  if (density === previousDensity) return;
  applyStructureDensityWidths(density);
  persistStructureDensity(density);
});

function onColResize(e: MouseEvent, col: number) {
  e.preventDefault();
  const widthIndex = columnWidthIndex(col);
  const minimumWidth = widthIndex === 3 && supportsCharacterLengthUnits.value ? structureDensityMetric.value.minLengthColumnWidth : structureDensityMetric.value.minColumnWidth;
  colResizing.value = { col: widthIndex, startX: e.clientX, startW: Math.max(colWidths.value[widthIndex] ?? minimumWidth, minimumWidth) };
  const onMove = (ev: MouseEvent) => {
    if (!colResizing.value) return;
    const delta = ev.clientX - colResizing.value.startX;
    colWidths.value[widthIndex] = Math.max(minimumWidth, colResizing.value.startW + delta);
  };
  const onUp = () => {
    colResizing.value = null;
    saveStructureColumnWidths(localStructureDensity.value, colWidths.value);
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onIndexColResize(e: MouseEvent, col: number) {
  e.preventDefault();
  resizing.value = { col, startX: e.clientX, startW: indexColWidths.value[col] };
  const onMove = (ev: MouseEvent) => {
    if (!resizing.value) return;
    const delta = ev.clientX - resizing.value.startX;
    indexColWidths.value[col] = Math.max(structureDensityMetric.value.minIndexColumnWidth, resizing.value.startW + delta);
  };
  const onUp = () => {
    resizing.value = null;
    if (PERSISTED_STRUCTURE_INDEX_COLUMN_WIDTHS.has(col)) {
      saveStructureIndexColumnWidths(localStructureDensity.value, indexColWidths.value);
    }
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

const connection = computed(() => (props.connectionId ? store.getConfig(props.connectionId) : undefined));
const databaseType = computed(() => tableStructureDatabaseTypeForConnection(connection.value));
const postgresForeignTable = ref(emptyPostgresForeignTableDraft());
const canCreateForeignTable = computed(() => !props.tableName && supportsPostgresForeignTableCreation(connection.value));
const isCreatingForeignTable = computed(() => canCreateForeignTable.value && postgresForeignTable.value.enabled);

function setCreateTableKind(kind: string) {
  const foreign = kind === "foreign";
  if (foreign && (columns.value.some((column) => !column.markedForDrop && (column.isPrimaryKey || column.extra.autoIncrement || column.extra.identity)) || indexes.value.some((index) => !index.markedForDrop) || foreignKeys.value.some((key) => !key.markedForDrop) || createPartitioningEnabled.value)) {
    toast(t("postgresForeignTable.removeUnsupported"));
    return;
  }
  postgresForeignTable.value.enabled = foreign;
}
const usesNativeMysqlIndexNames = computed(() => {
  const profile = connection.value?.driver_profile?.trim().toLowerCase();
  return databaseType.value === "mysql" && connection.value?.db_type === "mysql" && (!profile || profile === "mysql");
});
const supportsCharacterLengthUnits = computed(() => databaseType.value === "dameng" || databaseType.value === "oracle" || databaseType.value === "oceanbase-oracle");
const usesMysql8SafeDefaults = computed(() => databaseType.value === "mysql" && connection.value?.db_type === "mysql" && connection.value.driver_profile === "mysql");
const structureCapabilities = computed(() => getTableStructureCapabilities(databaseType.value, connection.value?.db_type, connection.value?.database_info?.productVersion, starrocksAlterContext.value?.model));
const tableMetadataCapabilities = computed(() => {
  const capabilities = getTableMetadataCapabilities(databaseType.value, { connectionType: connection.value?.db_type, exactIdentity: props.exactIdentity });
  return isCreatingForeignTable.value ? { ...capabilities, indexes: false, foreignKeys: false, constraints: false, partitions: false } : capabilities;
});
const structureDialect = computed(() => structureCapabilities.value.dialect);
const isTableCommentDisabled = computed(() => !structureCapabilities.value.comment || (!isCreateMode.value && databaseType.value === "starrocks" && !getStarRocksCapabilities(connection.value?.database_info?.productVersion).tableComment));
const dynamicDataTypeOptions = ref<string[]>([]);
const dataTypeOptions = computed(() => {
  const options = getDataTypeOptions(databaseType.value, dynamicDataTypeOptions.value, connection.value?.database_info?.productVersion);
  if (databaseType.value !== "oceanbase-oracle") return options;
  // JDBC may advertise Oracle types that OceanBase rejects.
  return options.filter((type) => !/^(?:nclob|long(?:\s+raw)?|bfile|boolean|vector)\s*(?:\(|$)/i.test(type.trim()));
});
const columnEditorControls = computed(() => getColumnEditorControls(databaseType.value));

const indexTypesByDb: Record<string, string[]> = {
  postgres: ["BTREE", "HASH", "GIST", "SPGIST", "GIN", "BRIN"],
  mysql: ["BTREE", "HASH", "FULLTEXT", "SPATIAL", "RTREE"],
  sqlserver: ["CLUSTERED", "NONCLUSTERED", "COLUMNSTORE", "NONCLUSTERED COLUMNSTORE", "XML", "SPATIAL"],
  oracle: ["NORMAL", "BITMAP", "FUNCTION-BASED NORMAL", "FUNCTION-BASED DOMAIN", "DOMAIN", "CLUSTER"],
  sqlite: ["BTREE"],
  "gaussdb-m": ["UBTREE"],
};
const indexTypeOptions = computed(() => {
  if (!structureCapabilities.value.indexType) return [];
  if (connection.value?.driver_profile?.toLowerCase() === "gaussdb-m") {
    return indexTypesByDb["gaussdb-m"];
  }
  return indexTypesByDb[structureDialect.value] ?? [];
});

interface DefaultValuePreset {
  label: string;
  value: string;
  dataType: string | null;
}

const defaultValuePresets = computed((): DefaultValuePreset[] => {
  const universal: DefaultValuePreset[] = [
    { label: "''", value: "''", dataType: "text" },
    { label: "NULL", value: "NULL", dataType: null },
    { label: "0", value: "0", dataType: "int" },
    { label: "1", value: "1", dataType: "int" },
  ];

  const dialectPresets: Record<string, DefaultValuePreset[]> = {
    mysql: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP", dataType: "timestamp" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE", dataType: "date" },
      { label: "CURRENT_TIME", value: "CURRENT_TIME", dataType: "time" },
    ],
    postgres: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP", dataType: "timestamp" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE", dataType: "date" },
      { label: "now()", value: "now()", dataType: "timestamp" },
      { label: "gen_random_uuid()", value: "gen_random_uuid()", dataType: "uuid" },
    ],
    sqlite: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP", dataType: "timestamp" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE", dataType: "date" },
      { label: "CURRENT_TIME", value: "CURRENT_TIME", dataType: "time" },
    ],
    duckdb: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP", dataType: "timestamp" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE", dataType: "date" },
    ],
    sqlserver: [
      { label: "GETDATE()", value: "GETDATE()", dataType: "datetime" },
      { label: "GETUTCDATE()", value: "GETUTCDATE()", dataType: "datetime" },
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP", dataType: "timestamp" },
      { label: "NEWID()", value: "NEWID()", dataType: "uuid" },
    ],
    oracle: [
      { label: "SYSDATE", value: "SYSDATE", dataType: "date" },
      { label: "SYSTIMESTAMP", value: "SYSTIMESTAMP", dataType: "timestamp" },
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP", dataType: "timestamp" },
    ],
    h2: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP", dataType: "timestamp" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE", dataType: "date" },
    ],
    clickhouse: [
      { label: "now()", value: "now()", dataType: "timestamp" },
      { label: "today()", value: "today()", dataType: "date" },
    ],
    informix: [
      { label: "CURRENT", value: "CURRENT", dataType: "timestamp" },
      { label: "TODAY", value: "TODAY", dataType: "date" },
    ],
  };

  return [...universal, ...(dialectPresets[structureDialect.value] ?? [])];
});
function columnDefaultValuePresets(column: EditableStructureColumn): DefaultValuePreset[] {
  if (databaseType.value !== "starrocks") return defaultValuePresets.value;
  return getColumnDefaultValuePresets(column, {
    databaseType: databaseType.value,
    dialect: structureDialect.value,
    serverVersion: connection.value?.database_info?.productVersion,
    unsetLabel: t("structureEditor.unsetDefault"),
    isCreateMode: isCreateMode.value,
  }).map((preset) => ({ ...preset, dataType: column.dataType }));
}

const showExtendedProperties = computed(() => supportsTableStructureExtendedProperties(databaseType.value));
const showCharacterSet = computed(() => structureDialect.value === "mysql" && databaseType.value !== "starrocks");

const serverCharsetMetadata = ref<CreateDatabaseCharsetMetadata>();
const charsetMetadataLoading = ref(false);
// The table's own default collation, used only to keep inherited charsets out of the
// generated DDL. Columns keep the real values MySQL reports so the pickers stay filled.
const mysqlTableDefaultCollation = ref("");
const mysqlTableCharset = ref("");
const originalMysqlTableCharset = ref("");
const mysqlTableCollation = ref("");
const originalMysqlTableCollation = ref("");
const mysqlTableCharsetChanged = computed(() => mysqlTableCharset.value.trim().toLowerCase() !== originalMysqlTableCharset.value.trim().toLowerCase() || mysqlTableCollation.value.trim().toLowerCase() !== originalMysqlTableCollation.value.trim().toLowerCase());

const mysqlTableCharsetChange = computed<MysqlTableCharsetChange | undefined>(() => {
  const profile = connection.value?.driver_profile?.trim().toLowerCase();
  if (isCreateMode.value || databaseType.value !== "mysql" || connection.value?.db_type !== "mysql" || (profile && profile !== "mysql") || !mysqlTableCharsetChanged.value) return undefined;
  const charset = mysqlTableCharset.value.trim();
  if (!charset) return undefined;
  return {
    charset,
    collation: mysqlTableCollation.value.trim() || undefined,
  };
});

const mysqlCharsetOptions = computed<string[]>(() => {
  const meta = serverCharsetMetadata.value;
  return meta ? meta.charsets : ([...CREATE_DATABASE_CHARSET_OPTIONS] as string[]);
});

function collationOptionsForCharset(charset: string): string[] {
  const meta = serverCharsetMetadata.value;
  if (meta) {
    return meta.collationsByCharset[normalizeCreateDatabaseCharsetKey(charset)] ?? [];
  }
  return createDatabaseCollationOptionsForCharset(charset);
}

async function loadCharsetMetadata() {
  if (charsetMetadataLoading.value || !showCharacterSet.value) return;
  charsetMetadataLoading.value = true;
  try {
    await store.ensureConnected(props.connectionId);
    const [charsetResult, collationResult] = await Promise.all([api.executeQuery(props.connectionId, props.database, "SHOW CHARACTER SET"), api.executeQuery(props.connectionId, props.database, "SHOW COLLATION")]);
    serverCharsetMetadata.value = parseCreateDatabaseCharsetMetadata(charsetResult, collationResult);
  } catch {
    serverCharsetMetadata.value = fallbackCreateDatabaseCharsetMetadata();
  } finally {
    charsetMetadataLoading.value = false;
  }
}

async function loadMysqlTableDefaultCollation() {
  if (!showCharacterSet.value || isCreateMode.value || !props.connectionId || !props.database || !props.tableName) {
    mysqlTableDefaultCollation.value = "";
    mysqlTableCharset.value = "";
    originalMysqlTableCharset.value = "";
    mysqlTableCollation.value = "";
    originalMysqlTableCollation.value = "";
    return;
  }
  const preserveEditedValues = mysqlTableCharsetChanged.value;
  try {
    await store.ensureConnected(props.connectionId);
    const result = await api.executeQuery(props.connectionId, props.database, mysqlTableCollationSql(props.database, props.tableName), undefined, undefined, { maxRows: 1 });
    const metadata = parseMysqlTableCharset(result);
    mysqlTableDefaultCollation.value = metadata.collation;
    originalMysqlTableCharset.value = metadata.charset;
    originalMysqlTableCollation.value = metadata.collation;
    if (!preserveEditedValues) {
      mysqlTableCharset.value = metadata.charset;
      mysqlTableCollation.value = metadata.collation;
    }
  } catch {
    // Optional metadata: without it the DDL just spells out the charset the column
    // already has, which is equivalent SQL — never block the editor on this lookup.
    mysqlTableDefaultCollation.value = "";
  }
}

function onMysqlTableCharsetChange(value: string) {
  mysqlTableCharset.value = value;
  const collationCharset = mysqlTableCollation.value.split("_", 1)[0]?.toLowerCase();
  if (mysqlTableCollation.value && collationCharset !== value.trim().toLowerCase()) {
    mysqlTableCollation.value = collationOptionsForCharset(value)[0] ?? "";
  }
}

function onCharsetChange(column: EditableStructureColumn, charset: string) {
  column.characterSet = charset;
  // If the collation is no longer valid for the new charset, clear it so the
  // server picks its default (COLLATE is only emitted when explicitly chosen).
  if (column.collation && !collationOptionsForCharset(charset).includes(column.collation)) {
    column.collation = "";
  }
}

function columnCharset(column: EditableStructureColumn): string {
  return column.characterSet ?? "";
}

function columnCollation(column: EditableStructureColumn): string {
  return column.collation ?? "";
}

const extendedPropertiesColumnIndex = 10;
// Widest extended-properties content seen so far. The column is last (no resize
// handle) and its controls differ per dialect/locale, so a fixed width clips them.
const extendedPropertiesContentWidth = ref(0);
const actionButtonGap = 2;
const columnOrdinalIndicatorGap = 4;
const columnOrdinalIndicatorTrailingChrome = 3;
const columnActionButtonCount = computed(() => (canShowColumnDragControls.value ? 3 : 2));
const columnOrdinalIndicatorWidth = computed(() => {
  const metric = structureDensityMetric.value;
  const digitCount = String(Math.max(1, columns.value.length)).length;
  // Reserve a full em per digit plus the primary-key icon, its gap, padding,
  // and divider. The indicator is shared by every row, so it must fit the
  // largest ordinal even when that row is a primary-key column.
  const iconCount = Math.max(1, ...columns.value.map((column) => columnIndexIndicators(column).length));
  const requiredWidth = metric.fontSize * digitCount + (metric.iconSize + columnOrdinalIndicatorGap) * iconCount + columnOrdinalIndicatorTrailingChrome;
  return Math.max(metric.columns[0], requiredWidth);
});
const columnActionsWidth = computed(() => {
  const metric = structureDensityMetric.value;
  const count = columnActionButtonCount.value;
  return columnOrdinalIndicatorWidth.value + metric.actionButtonWidth * count + actionButtonGap * count + metric.cellPaddingX * 2;
});
const visibleColumnIndexes = computed(() => colLabels.value.map((column) => column.widthIndex));
const visibleColWidths = computed(() =>
  colLabels.value.map((column) => {
    if (column.key === "actions") return columnActionsWidth.value;
    const width = colWidths.value[column.widthIndex] ?? structureDensityMetric.value.minColumnWidth;
    if (column.key === "extendedProperties") return Math.max(width, extendedPropertiesContentWidth.value);
    return column.key === "length" && supportsCharacterLengthUnits.value ? Math.max(width, structureDensityMetric.value.minLengthColumnWidth) : width;
  }),
);

function columnWidthIndex(visibleIndex: number) {
  return visibleColumnIndexes.value[visibleIndex] ?? visibleIndex;
}

const colLabels = computed(() => {
  const labels = [
    { key: "actions", label: t("structureEditor.actions"), widthIndex: 11 },
    { key: "name", label: t("structureEditor.columnName"), widthIndex: 1 },
    { key: "type", label: t("structureEditor.dataType"), widthIndex: 2 },
  ];
  if (columnEditorControls.value.length) labels.push({ key: "length", label: t("structureEditor.length"), widthIndex: 3 });
  if (columnEditorControls.value.nullable) labels.push({ key: "nullable", label: t("structureEditor.nullable"), widthIndex: 4 });
  if (columnEditorControls.value.primaryKey) labels.push({ key: "primaryKey", label: t("structureEditor.primaryKey"), widthIndex: 5 });
  if (columnEditorControls.value.defaultValue) labels.push({ key: "defaultValue", label: t("structureEditor.defaultValue"), widthIndex: 6 });
  if (columnEditorControls.value.comment) labels.push({ key: "comment", label: t("structureEditor.comment"), widthIndex: 7 });
  if (showCharacterSet.value) labels.push({ key: "characterSet", label: t("structureEditor.characterSet"), widthIndex: 8 });
  if (showCharacterSet.value) labels.push({ key: "collation", label: t("structureEditor.collation"), widthIndex: 9 });
  if (showExtendedProperties.value) {
    labels.push({ key: "extendedProperties", label: t("structureEditor.extendedProperties"), widthIndex: extendedPropertiesColumnIndex });
  }
  return labels;
});

const copyableStructureColumnLabels = computed(() => colLabels.value.filter((label) => label.key !== "actions"));

function structureColumnSelectionClass(key: string): string {
  return key !== "actions" && selectedStructureColumnKeys.value.has(key) ? "structure-grid-column-selected" : "";
}

function normalizedStructureDataType(dataType: string): string {
  return dataTypeBaseInputValue(databaseType.value, dataType)
    .replace(/["'`\[\]]/g, "")
    .trim()
    .toLowerCase();
}

function structureDataTypeToneClass(dataType: string): string {
  const type = normalizedStructureDataType(dataType);
  if (!type) return "structure-data-type-other";

  if (/^(?:bool|boolean)$/.test(type)) return "structure-data-type-boolean";
  if (/^(?:enum|set)(?:\b|$)/.test(type)) return "structure-data-type-enum";
  if (/^(?:json|jsonb|xml)\b/.test(type)) return "structure-data-type-json";
  if (/^(?:date|time|timestamp|timestamptz|datetime|smalldatetime|interval|year)\b/.test(type)) return "structure-data-type-temporal";
  if (/^(?:tinyblob|mediumblob|longblob|blob|binary|varbinary|bytea|image|raw|long raw)\b/.test(type)) return "structure-data-type-binary";
  if (/^(?:geometry|geometrycollection|geography|point|line|linestring|lseg|box|path|polygon|circle|multipoint|multilinestring|multipolygon)\b/.test(type)) return "structure-data-type-spatial";
  if (/^(?:number|numeric|decimal|dec|float|double|real|money|smallmoney)\b/.test(type)) return "structure-data-type-real";
  if (/^(?:tinyint|smallint|mediumint|int|integer|bigint|serial|bigserial|bit)\b/.test(type)) return "structure-data-type-numeric";
  if (/^(?:char|varchar|varchar2|nvarchar|nchar|text|tinytext|mediumtext|longtext|clob|nclob|string|uuid|uniqueidentifier)\b/.test(type)) return "structure-data-type-text";

  return "structure-data-type-other";
}

function structureDefaultValueToneClass(value: string | null | undefined, dataType: string | null): string {
  const text = value?.trim() ?? "";
  if (dataType === null || !text || /^null$/i.test(text)) return "structure-data-type-null";
  return structureDataTypeToneClass(dataType);
}

function structureColumnComparisonKey(name: string): string {
  return tableStructureIdentifierComparisonKey(name, databaseType.value, connection.value?.database_info);
}

const activeColumnByName = computed(() => {
  const map = new Map<string, EditableStructureColumn>();
  for (const item of columns.value) {
    if (!item.markedForDrop) map.set(item.name, item);
  }
  return map;
});

const activeColumnByComparisonKey = computed(() => {
  const map = new Map<string, EditableStructureColumn>();
  for (const item of columns.value) {
    if (item.markedForDrop) continue;
    if (item.name) map.set(structureColumnComparisonKey(item.name), item);
    if (item.original?.name) map.set(structureColumnComparisonKey(item.original.name), item);
  }
  return map;
});

const indexesByColumnComparisonKey = computed(() => {
  const map = new Map<string, EditableStructureIndex[]>();
  for (const index of indexes.value) {
    if (index.markedForDrop || index.isPrimary) continue;
    for (const name of index.columns) {
      const key = structureColumnComparisonKey(name);
      const list = map.get(key);
      if (list) list.push(index);
      else map.set(key, [index]);
    }
  }
  return map;
});

function indexContainsColumn(index: EditableStructureIndex, column: EditableStructureColumn): boolean {
  const names = [column.name, column.original?.name].filter((name): name is string => !!name).map(structureColumnComparisonKey);
  return index.columns.some((name) => names.includes(structureColumnComparisonKey(name)));
}

function columnIndexes(column: EditableStructureColumn): EditableStructureIndex[] {
  if (!column.name.trim() || column.markedForDrop) return [];
  const key1 = structureColumnComparisonKey(column.name);
  const key2 = column.original?.name ? structureColumnComparisonKey(column.original.name) : null;
  const list1 = indexesByColumnComparisonKey.value.get(key1) ?? [];
  if (!key2 || key1 === key2) return list1;
  const list2 = indexesByColumnComparisonKey.value.get(key2) ?? [];
  if (!list2.length) return list1;
  const set = new Set(list1);
  const result = [...list1];
  for (const idx of list2) {
    if (!set.has(idx)) {
      set.add(idx);
      result.push(idx);
    }
  }
  return result;
}

const indexKindOrder: StructureIndexKind[] = ["primary", "unique", "index", "fulltext", "spatial"];

function indexIconClass(kind: StructureIndexKind): string {
  return {
    primary: "text-amber-600 dark:text-amber-400",
    unique: "text-red-600 dark:text-red-400",
    index: "text-green-700 dark:text-green-300",
    fulltext: "text-purple-600 dark:text-purple-300",
    spatial: "text-cyan-700 dark:text-cyan-300",
  }[kind];
}

function columnIndexKind(column: EditableStructureColumn): StructureIndexKind | "none" {
  if (column.markedForDrop) return "none";
  if (column.isPrimaryKey) return "primary";
  const memberships = columnIndexes(column);
  return indexKindOrder.find((kind) => memberships.some((index) => structureIndexKind(index) === kind)) ?? "none";
}

function columnIndexIndicators(column: EditableStructureColumn): { kind: StructureIndexKind; title: string }[] {
  if (column.markedForDrop) return [];
  const memberships = columnIndexes(column);
  return indexKindOrder.flatMap((kind) => {
    const titles = memberships.filter((index) => structureIndexKind(index) === kind).map(indexTitle);
    if (kind === "primary" && column.isPrimaryKey)
      titles.unshift(
        `PRIMARY (${columns.value
          .filter((item) => item.isPrimaryKey && !item.markedForDrop)
          .map((item) => item.name)
          .join(", ")})`,
      );
    return titles.length ? [{ kind, title: titles.join("\n") }] : [];
  });
}

function indexTitle(index: EditableStructureIndex): string {
  return `${index.isPrimary ? "PRIMARY" : index.isUnique ? "UNIQUE" : index.indexType || "INDEX"} ${index.name} (${index.columns.join(", ")})`;
}

function columnIndexTitle(column: EditableStructureColumn): string {
  return columnIndexIndicators(column)
    .map((indicator) => indicator.title)
    .join("\n");
}

function structureColumnClipboardValue(column: EditableStructureColumn, key: string): string {
  switch (key) {
    case "name":
      return column.name;
    case "type":
      return gaussdbMDataTypeDisplayName(dataTypeBaseInputValue(databaseType.value, column.dataType));
    case "length": {
      if (isMysqlEnumDataType(databaseType.value, column.dataType)) return (column.enumValues ?? []).join(", ");
      if (isPostgresGeometryDataType(databaseType.value, column.dataType)) {
        return [postgresGeometryTypeValue(column.dataType), postgresGeometrySridValue(column.dataType)].filter(Boolean).join(", ");
      }
      return [dataTypeLengthInputValue(databaseType.value, column.dataType), dataTypeLengthUnitValue(databaseType.value, column.dataType)].filter(Boolean).join(" ");
    }
    case "nullable":
      return column.isNullable ? t("structureEditor.yes") : t("structureEditor.no");
    case "primaryKey":
      return column.isPrimaryKey ? t("structureEditor.yes") : t("structureEditor.no");
    case "defaultValue":
      return column.defaultValue;
    case "comment":
      return column.comment;
    case "characterSet":
      return columnCharset(column);
    case "collation":
      return columnCollation(column);
    case "extendedProperties":
      return Object.entries(column.extra)
        .filter(([, value]) => value !== undefined && value !== false && value !== "")
        .map(([name, value]) => `${name}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
        .join("; ");
    default:
      return "";
  }
}

function structureColumnClipboardText(): string {
  const labels = copyableStructureColumnLabels.value.filter((label) => selectedStructureColumnKeys.value.has(label.key));
  if (labels.length === 0) return "";
  const rows = columns.value.filter((column) => !column.markedForDrop).map((column) => labels.map((label) => structureColumnClipboardValue(column, label.key)));
  return formatTsv(
    labels.map((label) => label.label),
    rows,
    "",
  );
}

function setStructureColumnSelection(keys: Iterable<string>, anchorKey: string | null) {
  // Clears first: setColumnSelection also resets the header-column keys.
  clearColumnSelection();
  selectedStructureColumnKeys.value = new Set(keys);
  structureColumnSelectionAnchorKey.value = anchorKey;
}

function selectStructureColumnKey(key: string, event: MouseEvent) {
  if (key === "actions") return;
  const labels = copyableStructureColumnLabels.value;
  const index = labels.findIndex((label) => label.key === key);
  if (index < 0) return;

  if (event.shiftKey && structureColumnSelectionAnchorKey.value) {
    const anchorIndex = labels.findIndex((label) => label.key === structureColumnSelectionAnchorKey.value);
    if (anchorIndex >= 0) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      setStructureColumnSelection(
        labels.slice(start, end + 1).map((label) => label.key),
        structureColumnSelectionAnchorKey.value,
      );
      return;
    }
  }

  if (event.metaKey || event.ctrlKey) {
    const next = new Set(selectedStructureColumnKeys.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setStructureColumnSelection(next, key);
    return;
  }

  setStructureColumnSelection([key], key);
}

function selectAllStructureColumns() {
  const keys = copyableStructureColumnLabels.value.map((label) => label.key);
  if (keys.length > 0) setStructureColumnSelection(keys, keys[0] ?? null);
}

async function copySelectedStructureColumns() {
  const text = structureColumnClipboardText();
  if (!text) return;
  try {
    await copyToClipboard(text);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

watch(
  copyableStructureColumnLabels,
  (labels) => {
    const allowed = new Set(labels.map((label) => label.key));
    const next = [...selectedStructureColumnKeys.value].filter((key) => allowed.has(key));
    if (next.length !== selectedStructureColumnKeys.value.size) selectedStructureColumnKeys.value = new Set(next);
    if (structureColumnSelectionAnchorKey.value && !allowed.has(structureColumnSelectionAnchorKey.value)) structureColumnSelectionAnchorKey.value = next[0] ?? null;
  },
  { flush: "sync" },
);

const structureColumnRowHeight = computed(() => structureDensityMetric.value.controlHeight + structureDensityMetric.value.cellPaddingY * 2 + 1);
const columnTableWidth = computed(() => visibleColWidths.value.reduce((total, width) => total + width, 0));
function columnNeedsVariableGeometryHeight(column: EditableStructureColumn): boolean {
  return isPostgresGeometryDataType(databaseType.value, column.dataType) && !postgresGeometryTypeValue(column.dataType) && !!postgresGeometrySridValue(column.dataType);
}
const columnVirtualItemSize = computed(() => (columns.value.some(columnNeedsVariableGeometryHeight) ? null : structureColumnRowHeight.value));
const columnVirtualRows = computed(() => {
  const geometryHintHeight = Math.ceil(structureDensityMetric.value.fontSize * structureDensityMetric.value.lineHeight) + 2;
  return columns.value.map((column, index) => ({
    id: column.id,
    column,
    index,
    size: structureColumnRowHeight.value + (columnNeedsVariableGeometryHeight(column) ? geometryHintHeight : 0),
  }));
});
const indexColLabels = computed(() => [
  t("structureEditor.indexName"),
  t("structureEditor.indexColumns"),
  t("structureEditor.unique"),
  t("structureEditor.indexType"),
  t("structureEditor.includedColumns"),
  t("structureEditor.filter"),
  t("structureEditor.comment"),
  t("structureEditor.concurrent"),
  t("structureEditor.actions"),
]);
const filteredColumnRowIds = computed(() => {
  const query = columnSearchText.value.trim().toLowerCase();
  if (!query) return new Set<string>();
  return new Set(columns.value.filter((column) => columnMatchesSearch(column)).map((column) => column.id));
});
const columnSearchMatchCount = computed(() => (columnSearchText.value.trim() ? filteredColumnRowIds.value.size : 0));
const filteredIndexRowIds = computed(() => {
  const query = indexSearchText.value.trim().toLowerCase();
  if (!query) return new Set<string>();
  return new Set(indexes.value.filter((index) => indexMatchesSearch(index, query)).map((index) => index.id));
});
const indexSearchMatchCount = computed(() => (indexSearchText.value.trim() ? filteredIndexRowIds.value.size : 0));
const foreignKeyActionOptions = computed(() => (structureDialect.value === "sqlserver" ? ["", "CASCADE", "SET NULL", "NO ACTION"] : ["", "CASCADE", "SET NULL", "RESTRICT", "NO ACTION"]));
const triggerTimingOptions = computed(() => (databaseType.value === "sqlserver" ? ["AFTER", "INSTEAD OF"] : ["BEFORE", "AFTER"]));
const triggerEventOptions = ["INSERT", "UPDATE", "DELETE"];
const metadataSchema = computed(() => (props.exactIdentity ? (props.schema ?? "") : connectionObjectTreeQuerySchema(connection.value, props.database, props.schema)));
const refreshVersion = computed(() => (props.connectionId && props.tableName ? queryStore.tableStructureRefreshVersion(props.connectionId, props.database, props.schema, props.tableName, props.exactIdentity === true, props.catalog) : 0));
const isCreateMode = computed(() => !props.tableName);
// Hidden for an existing table that is not partitioned: the tab could only ever
// render an empty state. Create mode keeps it so partitioning can be declared.
const showPartitionsTab = computed(() => tableMetadataCapabilities.value.partitions && (isCreateMode.value || isPartitionedParent.value || isTablePartition.value));

/**
 * Whether the edited table already stores a lowercase or mixed-case identifier.
 * Oracle folds bare identifiers to uppercase, so dequoting such a name points at
 * a column that does not exist (`CNAME` instead of `"cName"`, ORA-00904) or
 * silently creates a differently-cased column for a newly added field (#9649).
 * Tables whose names are all in the dialect's default case keep the
 * PL/SQL-Developer-style folding requested in #8997.
 */
const tableStoresCaseSensitiveIdentifiers = computed(() => {
  if (isCreateMode.value) return false;
  const databaseInfo = connection.value?.database_info;
  const requiresQuotesForIdentity = (name: string | null | undefined) => !!name && tableStructureIdentifierComparisonKey(name, databaseType.value, databaseInfo).startsWith("quoted:");
  // 外键的引用侧（被引用 schema/表/列）与约束名一样进入生成的 REFERENCES
  // 子句，同样需要纳入大小写敏感扫描，否则会被折叠改写身份。
  const foreignKeyIdentifiers = foreignKeys.value.flatMap((foreignKey) => {
    const original = foreignKey.original;
    return original ? [original.name, original.ref_schema, original.ref_table, original.ref_column] : [];
  });
  return [props.tableName, ...columns.value.map((column) => column.original?.name), ...indexes.value.map((index) => index.original?.name), ...foreignKeyIdentifiers, ...triggers.value.map((trigger) => trigger.original?.name)].some(requiresQuotesForIdentity);
});
const usesSqliteRebuildStrategy = computed(() => !isCreateMode.value && structureCapabilities.value.alterStrategy === "sqlite-rebuild");
const hasSqliteTypeChange = computed(() => usesSqliteRebuildStrategy.value && hasExistingColumnTypeChange(columns.value));
const canAddColumn = computed(() => canAddTableStructureColumn(databaseType.value, isCreateMode.value) && (isCreateMode.value || databaseType.value !== "starrocks" || ["primary", "duplicate"].includes(starrocksAlterContext.value?.model ?? "")));
const canPasteColumns = computed(() => databaseType.value === "mysql" && canAddColumn.value && !loading.value && !saving.value);
const newTableName = ref("");
const tableComment = ref("");
const originalTableComment = ref("");
const mysqlAutoIncrementValue = ref<string>();
const originalMysqlAutoIncrementValue = ref<string>();
const mysqlAutoIncrementLoading = ref(false);
const mysqlAutoIncrementLoadError = ref("");
const mysqlTableEngine = ref("");
const originalMysqlTableEngine = ref("");
const physicalOptions = ref(emptyTablePhysicalOptions());
const starrocksPhysicalOptions = ref(emptyStarRocksPhysicalOptions());
watch(
  () => columns.value.filter((column) => !column.markedForDrop).map((column) => column.id),
  (ids) => {
    if (!isCreateMode.value) return;
    physicalOptions.value = pruneTablePhysicalOptions(physicalOptions.value, new Set(ids));
  },
);
const mysqlTableEngineOptions = ref<string[]>([]);
const mysqlTableEngineLoading = ref(false);
const mysqlTableEngineLoadError = ref("");
const tableOwner = ref("");
const originalTableOwner = ref("");
const tableOwnerLoading = ref(false);
const tableOwnerLoadError = ref("");
const tableOwnerRoles = ref<string[]>([]);
const tableOwnerRolesLoading = ref(false);
const tableOwnerRolesLoadError = ref("");
const supportsTableOwner = computed(() => !isCreateMode.value && databaseType.value === "postgres");
const primaryKeyName = ref("");
const existingPrimaryKeyDraft = ref<ExistingPrimaryKeyChange>();
const existingPrimaryKeyPlan = shallowRef<OceanbasePrimaryKeyPlan>();
const existingPrimaryKeySession = ref<{ revision: number; configFingerprint: string }>();
const existingOracleForeignKeyPlan = shallowRef<OracleForeignKeyPlan>();
const existingOracleForeignKeySession = ref<{ revision: number; configFingerprint: string }>();
const newOracleForeignKeyPlan = shallowRef<OracleForeignKeyCreatePlan>();
const newOracleForeignKeySession = ref<{ revision: number; configFingerprint: string; draftFingerprint: string }>();
const oracleForeignKeyBusy = ref(false);
const oracleConstraintDraft = ref<OracleConstraintChange>();
const oracleConstraintPlan = shallowRef<OracleConstraintPlan>();
const oracleConstraintSession = ref<{ revision: number; configFingerprint: string; draftFingerprint: string }>();
const oracleConstraintBusy = ref(false);
const oracleIndexPlan = shallowRef<OracleIndexPlan>();
const oracleIndexBusy = ref(false);
const oracleIndexEpoch = ref(0);
const oracleIndexReady = shallowRef<OracleIndexLoadBaseline>();
const oracleIndexRefreshGuard = ref<{ target: string; afterRequestId: number; completedCreates: OracleIndexDefinition[] }>();
const oracleIndexRefreshError = ref("");
const oracleIndexConfirmationScope = `structure-oracle-index:${uuid()}`;
const oracleConstraintConfirmationScope = `structure-oracle-constraint:${uuid()}`;
const oracleConstraintChanged = computed(() => !!oracleConstraintDraft.value && JSON.stringify(oracleConstraintDraft.value.original) !== JSON.stringify(oracleConstraintDraft.value.target));
const primaryKeyNewColumn = ref("");
const primaryKeyBusy = ref(false);
const primaryKeyResultOpen = ref(false);
const primaryKeyResultMessage = ref("");
const primaryKeyResultDetails = ref("");
const primaryKeyResultTitle = ref("oceanbasePrimaryKey.resultTitle");
const oracleForeignKeyCreateRecovery = ref<TableStructureEditorDraft["oracleForeignKeyCreateRecovery"]>();
let primaryKeyUnmounted = false;
const primaryKeyConfirmationScope = `structure-primary-key:${uuid()}`;
const oracleForeignKeyConfirmationScope = `structure-oracle-foreign-key:${uuid()}`;
onBeforeUnmount(() => {
  primaryKeyUnmounted = true;
  cancelTriggerStructureConfirmation();
  if (primaryKeyBusy.value) productionSafetyStore.cancelScope(primaryKeyConfirmationScope);
  if (saving.value) productionSafetyStore.cancelScope(oracleForeignKeyConfirmationScope);
  if (saving.value) productionSafetyStore.cancelScope(oracleConstraintConfirmationScope);
  if (saving.value) productionSafetyStore.cancelScope(oracleIndexConfirmationScope);
});
watch(
  () => [props.connectionId, props.database, props.schema, props.tableName, props.catalog, props.exactIdentity],
  () => {
    ddlLoadRequestId += 1;
    ddlLoading.value = false;
    tableCommentLoadRequestId += 1;
    tableCommentLoadPromise = null;
    invalidateOracleIndexReady();
    if (primaryKeyBusy.value) productionSafetyStore.cancelScope(primaryKeyConfirmationScope);
    if (saving.value) productionSafetyStore.cancelScope(oracleForeignKeyConfirmationScope);
    if (saving.value) productionSafetyStore.cancelScope(oracleConstraintConfirmationScope);
    if (saving.value) productionSafetyStore.cancelScope(oracleIndexConfirmationScope);
    existingPrimaryKeyDraft.value = undefined;
    existingPrimaryKeyPlan.value = undefined;
    existingPrimaryKeySession.value = undefined;
    existingOracleForeignKeyPlan.value = undefined;
    existingOracleForeignKeySession.value = undefined;
    newOracleForeignKeyPlan.value = undefined;
    newOracleForeignKeySession.value = undefined;
    oracleConstraintDraft.value = undefined;
    oracleConstraintPlan.value = undefined;
    oracleConstraintSession.value = undefined;
    oracleIndexPlan.value = undefined;
    oracleIndexRefreshGuard.value = undefined;
    oracleIndexRefreshError.value = "";
    if (primaryKeyBusy.value) saving.value = false;
  },
);
watch(
  () => [databaseType.value, props.connectionId ? store.connectionStateRevision(props.connectionId) : -1, props.connectionId && store.getConfig(props.connectionId) ? connectionConfigFingerprint(store.getConfig(props.connectionId)!) : ""],
  () => invalidateOracleIndexReady(),
);
const canEditExistingPrimaryKey = computed(() => !isCreateMode.value && (databaseType.value === "oracle" || databaseType.value === "oceanbase-oracle"));
const isOracleConstraintEditor = canEditExistingPrimaryKey;
const existingPrimaryKeyChanged = computed(() => !!existingPrimaryKeyDraft.value && JSON.stringify(existingPrimaryKeyDraft.value.columns) !== JSON.stringify(existingPrimaryKeyDraft.value.originalColumns));
const primaryKeyAvailableColumns = computed(() => columns.value.filter((column) => column.original && !column.markedForDrop && !existingPrimaryKeyDraft.value?.columns.includes(column.name)));
const currentPrimaryKeyIndex = computed(() => {
  const plan = existingPrimaryKeyPlan.value;
  if (!plan || JSON.stringify(plan.draft ?? plan.change) !== JSON.stringify(existingPrimaryKeyDraft.value) || JSON.stringify(plan.target) !== JSON.stringify(primaryKeyTarget())) return undefined;
  return plan.change.oracleIndex;
});

function primaryKeyTarget(): PrimaryKeyTarget {
  return { connectionId: props.connectionId, database: props.database, schema: metadataSchema.value, tableName: props.tableName, catalog: props.catalog, databaseType: databaseType.value === "oracle" ? "oracle" : "oceanbase-oracle" };
}

function oracleConstraintTarget(): OracleConstraintTarget {
  return { ...primaryKeyTarget(), schema: metadataSchema.value, databaseType: databaseType.value === "oracle" ? "oracle" : "oceanbase-oracle", ...(props.exactIdentity ? { exactIdentity: true } : {}) };
}

function oracleIndexTargetIdentity(target: OracleConstraintTarget): string {
  return JSON.stringify({ connectionId: target.connectionId, database: target.database, schema: target.schema, tableName: target.tableName, catalog: target.catalog, ...(target.exactIdentity ? { exactIdentity: true } : {}) });
}

function invalidateOracleIndexReady() {
  oracleIndexEpoch.value += 1;
  oracleIndexReady.value = undefined;
}

function oracleIndexLoadIsCurrent(requestId: number, targetIdentity: string, revision: number | undefined, configFingerprint: string) {
  const connectionId = props.connectionId;
  const config = connectionId ? store.getConfig(connectionId) : undefined;
  return (
    requestId === structureLoadRequestId &&
    targetIdentity === oracleIndexTargetIdentity(oracleConstraintTarget()) &&
    (revision === undefined || (store.connectionStateRevision(connectionId!) === revision && store.isCurrentConnectionStateRevision(connectionId!, revision))) &&
    (revision === undefined || (config ? connectionConfigFingerprint(config) : "") === configFingerprint)
  );
}

async function editOracleConstraint(info: ConstraintInfo) {
  if (!isOracleConstraintEditor.value || saving.value || oracleConstraintBusy.value || existingPrimaryKeyChanged.value || hasPendingStructureChanges(false, false)) return;
  const target = oracleConstraintTarget();
  const identity = JSON.stringify(target);
  try {
    await loadStructure(true, { columns: false, indexes: true, constraints: true, foreignKeys: false, triggers: false, partitions: false, tableComment: false }, true, { forceMetadata: true, blockSecondaryMetadata: true, preserveDraft: true });
    if (primaryKeyUnmounted || identity !== JSON.stringify(oracleConstraintTarget())) return;
    const current = constraints.value.find((item) => item.name === info.name && item.constraint_type === info.constraint_type);
    if (!current) throw new Error("Constraint metadata changed. Refresh the table definition.");
    const original = oracleConstraintDefinitionFromInfo(current, target);
    oracleConstraintDraft.value = { original, target: cloneDraftValue(original), ...(original.kind === "unique" ? { indexPolicy: target.databaseType === "oracle" ? ("keep" as const) : ("none" as const) } : {}) };
  } catch (error) {
    if (identity === JSON.stringify(oracleConstraintTarget())) errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function deleteOracleConstraint(info: ConstraintInfo) {
  if (!isOracleConstraintEditor.value || saving.value || oracleConstraintBusy.value || oracleConstraintDraft.value) return;
  try {
    const target = oracleConstraintTarget();
    const original = oracleConstraintDefinitionFromInfo(info, target);
    oracleConstraintDraft.value = { original, target: null, ...(original.kind === "unique" ? { indexPolicy: target.databaseType === "oracle" ? ("keep" as const) : ("none" as const) } : {}) };
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function addOracleConstraint(kind: "check" | "unique") {
  if (!isOracleConstraintEditor.value || saving.value || oracleConstraintBusy.value || hasPendingStructureChanges()) return;
  const prefix = kind === "check" ? "DBX_CHECK_" : "DBX_UNIQUE_";
  let suffix = 1;
  while (constraints.value.some((item) => item.name === `${prefix}${suffix}`)) suffix += 1;
  const name = `${prefix}${suffix}`;
  const state = { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false };
  const definition: OracleConstraintDefinition =
    kind === "check"
      ? { kind, definition: { name, expression: "", state } }
      : {
          kind,
          definition: {
            name,
            columns: [],
            state,
            relyRaw: "NULL",
            index: {
              owner: metadataSchema.value,
              name: "",
              tableOwner: metadataSchema.value,
              tableName: props.tableName,
              sharing: "exclusive",
              metadataComplete: false,
              indexType: "NORMAL",
              uniqueness: "UNIQUE",
              status: "VALID",
              partitioned: false,
              visibility: "VISIBLE",
              secondary: "N",
              columns: [],
              directions: [],
              keyIsExpression: [],
              includedColumns: [],
              newNameAvailable: false,
            },
          },
        };
  oracleConstraintDraft.value = { original: null, target: definition, ...(kind === "unique" && databaseType.value === "oceanbase-oracle" ? { indexPolicy: "none" as const } : {}) };
}

function cancelOracleConstraintEdit() {
  oracleConstraintDraft.value = undefined;
  oracleConstraintPlan.value = undefined;
  oracleConstraintSession.value = undefined;
  oracleIndexPlan.value = undefined;
  pendingStatements.value = [];
  warnings.value = [];
  syncDraftToParent();
}

function addOracleUniqueColumn(name: string) {
  const definition = oracleConstraintDraft.value?.target?.kind === "unique" ? oracleConstraintDraft.value.target.definition : undefined;
  if (definition && name && !definition.columns.includes(name)) definition.columns.push(name);
}

function canOpenPairedOracleConstraint(index: EditableStructureIndex): boolean {
  return isOracleConstraintEditor.value && tableMetadataCapabilities.value.constraints && index.isUnique && !!index.original;
}

async function editOracleUniqueConstraintForIndex(index: EditableStructureIndex) {
  if (!canOpenPairedOracleConstraint(index)) return;
  const target = oracleConstraintTarget();
  const identity = JSON.stringify(target);
  try {
    const fresh = await api.listConstraints(target.connectionId, target.database, target.schema, target.tableName, target.catalog, ...(target.exactIdentity ? ([true] as const) : []));
    if (primaryKeyUnmounted || identity !== JSON.stringify(oracleConstraintTarget())) return;
    const constraint = fresh.find((item) => item.constraint_type === "UNIQUE" && item.oracle_metadata?.metadataComplete && item.oracle_metadata.owner === target.schema && item.oracle_metadata.indexOwner === target.schema && item.oracle_metadata.indexName === index.original?.name);
    if (!constraint) throw new Error("This unique index has no uniquely paired constraint metadata.");
    activeTab.value = "constraints";
    await editOracleConstraint(constraint);
  } catch (error) {
    if (identity === JSON.stringify(oracleConstraintTarget())) errorMessage.value = error instanceof Error ? error.message : String(error);
  }
}

function moveOracleUniqueColumn(index: number, direction: number) {
  const columns = oracleConstraintDraft.value?.target?.kind === "unique" ? oracleConstraintDraft.value.target.definition.columns : undefined;
  if (!columns || index + direction < 0 || index + direction >= columns.length) return;
  const [column] = columns.splice(index, 1);
  columns.splice(index + direction, 0, column!);
}

function primaryKeyError(error: unknown): string {
  return error instanceof OceanbasePrimaryKeyValidationError ? t(`oceanbasePrimaryKey.${error.key}`, error.values) : error instanceof Error ? error.message : String(error);
}

async function editExistingPrimaryKey(constraint: ConstraintInfo, remove = false) {
  if (!canEditExistingPrimaryKey.value || saving.value || primaryKeyBusy.value) return;
  const target = JSON.stringify(primaryKeyTarget());
  await loadStructure(true, { columns: true, indexes: true, constraints: true, foreignKeys: false, triggers: false, partitions: false, tableComment: false }, true, { blockSecondaryMetadata: true, preserveDraft: true });
  if (primaryKeyUnmounted || target !== JSON.stringify(primaryKeyTarget())) return;
  const current = constraints.value.find((item) => item.name === constraint.name && item.constraint_type === "PRIMARY KEY");
  if (!current || !current.columns.length) {
    errorMessage.value = t("oceanbasePrimaryKey.incompleteMetadata");
    return;
  }
  existingPrimaryKeyDraft.value = { name: current.name, originalColumns: [...current.columns], columns: remove ? [] : [...current.columns] };
  if (databaseType.value === "oracle") existingPrimaryKeyDraft.value.oracleIndex = { policy: "keep", owner: metadataSchema.value, name: "" };
  primaryKeyNewColumn.value = "";
}

function moveExistingPrimaryKeyColumn(index: number, direction: number) {
  const draft = existingPrimaryKeyDraft.value;
  if (!draft || primaryKeyBusy.value || index + direction < 0 || index + direction >= draft.columns.length) return;
  const [name] = draft.columns.splice(index, 1);
  draft.columns.splice(index + direction, 0, name!);
}

function addExistingPrimaryKeyColumn() {
  if (primaryKeyBusy.value || !primaryKeyAvailableColumns.value.some((column) => column.name === primaryKeyNewColumn.value)) return;
  existingPrimaryKeyDraft.value?.columns.push(primaryKeyNewColumn.value);
  primaryKeyNewColumn.value = "";
}
// Mirrors Rust `supports_named_primary_key`: engines that persist a user-supplied
// PK constraint name. Other dialects ignore the symbol, so the field is hidden.
const canNamePrimaryKey = computed(() => {
  if (connection.value?.driver_profile?.toLowerCase() === "gaussdb-m") return true;
  const dialect = structureCapabilities.value.dialect;
  return dialect === "mysql" || dialect === "postgres" || dialect === "sqlserver" || dialect === "oracle";
});
/** Whether the draft will create a primary key that did not exist before
 * (matching the Rust builder's pure-add path; replacements never rename). */
const willCreateNewPrimaryKey = computed(() => {
  const active = columns.value.filter((column) => !column.markedForDrop);
  return active.some((column) => column.isPrimaryKey) && !active.some((column) => column.original?.is_primary_key);
});
const canEditPrimaryKeyName = computed(() => canNamePrimaryKey.value && willCreateNewPrimaryKey.value && (isCreateMode.value || structureCapabilities.value.addPrimaryKey));
const canEditMysqlAutoIncrement = computed(() => canEditMysqlAutoIncrementCounter(connection.value, isCreateMode.value, columns.value));
const canBuildMysqlAutoIncrement = computed(() => !isCreateMode.value && canEditMysqlAutoIncrement.value && !mysqlAutoIncrementLoading.value && !mysqlAutoIncrementLoadError.value && originalMysqlAutoIncrementValue.value !== undefined);
const supportsMysqlEngine = computed(() => supportsMysqlTableEngine(connection.value));
const hasPersistedMysqlAutoIncrementColumn = computed(() => columns.value.some((column) => !column.markedForDrop && (column.original?.extra ?? "").toLowerCase().includes("auto_increment")));
function isMysqlAutoIncrementCounterColumn(column: EditableStructureColumn): boolean {
  return canEditMysqlAutoIncrement.value && !column.markedForDrop && column.extra.autoIncrement === true;
}
function setMysqlAutoIncrement(column: EditableStructureColumn, checked: boolean) {
  column.extra.autoIncrement = checked;
  if (!isCreateMode.value && checked && originalMysqlAutoIncrementValue.value === undefined && !mysqlAutoIncrementLoading.value) {
    void loadMysqlAutoIncrementCounter(true);
  }
}

// MySQL generated columns (issue #11208). Tri-state mirrors the backend contract:
// `undefined` inherits the original definition, an empty expression removes the
// attribute, otherwise the clause renders from the edited values.
function hasOriginalMysqlGeneratedColumn(column: EditableStructureColumn): boolean {
  return structureDialect.value === "mysql" && !!column.original?.extra && !!parseMysqlGeneratedColumnExtra(column.original.extra);
}

function isMysqlGeneratedChecked(column: EditableStructureColumn): boolean {
  return structureDialect.value === "mysql" && column.extra.generated !== undefined;
}

function isMysqlGeneratedActive(column: EditableStructureColumn): boolean {
  return isMysqlGeneratedChecked(column) && (column.extra.generated?.expression.trim() ?? "") !== "";
}

function setMysqlGenerated(column: EditableStructureColumn, checked: boolean) {
  // Only manage the generated flag here. Conflicting attributes (DEFAULT,
  // AUTO_INCREMENT, ON UPDATE) stay in the draft: they are disabled in the UI
  // while generated, and stripped from the SQL payload only while the
  // generated attribute is active, so unchecking restores them untouched.
  if (checked) {
    // Re-checking after an accidental uncheck restores the original expression
    // and storage instead of starting from a blank VIRTUAL draft.
    const original = column.original?.extra ? parseMysqlGeneratedColumnExtra(column.original.extra) : undefined;
    column.extra.generated = original ? { ...original } : { expression: "", storage: "STORED" };
    return;
  }
  // Dropping the attribute must be explicit for a column that was generated,
  // otherwise `undefined` would inherit the original definition back.
  column.extra.generated = hasOriginalMysqlGeneratedColumn(column) ? { expression: "" } : undefined;
}

function updateMysqlGeneratedExpression(column: EditableStructureColumn, expression: string) {
  if (column.extra.generated) {
    column.extra.generated.expression = expression;
  }
}

function updateMysqlGeneratedStorage(column: EditableStructureColumn, storage: string) {
  if (column.extra.generated) {
    column.extra.generated.storage = storage === "STORED" ? "STORED" : "VIRTUAL";
  }
}
function isSqliteAutoIncrement(column: EditableStructureColumn): boolean {
  return structureDialect.value === "sqlite" && column.isPrimaryKey && isSqliteIntegerType(column.dataType) && column.extra.autoIncrement === true;
}
function canEditSqliteAutoIncrement(column: EditableStructureColumn): boolean {
  return structureDialect.value === "sqlite" && column.isPrimaryKey && isSqliteIntegerType(column.dataType) && !columns.value.some((candidate) => candidate !== column && candidate.isPrimaryKey && candidate.extra.autoIncrement);
}
function setSqliteAutoIncrement(column: EditableStructureColumn, checked: boolean) {
  column.extra.autoIncrement = checked;
}
function isSqliteIntegerType(dataType: string): boolean {
  return /^(integer|int|tinyint|smallint|mediumint|bigint)$/i.test(dataType.trim().split("(")[0]);
}
function onMysqlAutoIncrementInput(event: Event) {
  const input = event.target as HTMLInputElement;
  if (/^\d*$/.test(input.value)) {
    mysqlAutoIncrementValue.value = input.value;
    return;
  }
  input.value = mysqlAutoIncrementValue.value ?? "";
}
const tableOwnerOptions = computed(() => {
  const owner = tableOwner.value;
  if (!owner || tableOwnerRoles.value.includes(owner)) return tableOwnerRoles.value;
  return [owner, ...tableOwnerRoles.value];
});
const targetLabel = computed(() => buildStructureTargetLabel(connection.value?.name, props.database, props.schema, isCreateMode.value ? undefined : props.tableName));

function isManticoreTextColumn(column: EditableStructureColumn): boolean {
  if (databaseType.value !== "manticoresearch") return false;
  const baseType = dataTypeBaseInputValue(databaseType.value, column.dataType).trim().toLowerCase();
  return baseType === "text" || baseType === "string";
}

function isManticoreJsonColumn(column: EditableStructureColumn): boolean {
  if (databaseType.value !== "manticoresearch") return false;
  return dataTypeBaseInputValue(databaseType.value, column.dataType).trim().toLowerCase() === "json";
}

let sqlPreviewRequestId = 0;
let structureLoadRequestId = 0;
let structureMetadataRevalidationId = 0;
let tableCommentLoadRequestId = 0;
let tableCommentLoadPromise: Promise<void> | null = null;
let tableOwnerLoadRequestId = 0;
let tableOwnerRolesLoadRequestId = 0;
let mysqlAutoIncrementLoadRequestId = 0;
let mysqlTableEngineLoadRequestId = 0;
let dataTypeOptionsRequestId = 0;
let sqlPreviewDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let deferredSqlPreviewRefresh = false;
let keydownListenerRegistered = false;
let skipNextRefreshVersion = false;
let restoringDraft = false;
let syncingDraft = false;
let draftHydrated = false;
let lastAppliedInitialTabRequestId: number | undefined;
const hydratingRestoredDraft = ref(false);
const draftHydrationError = ref("");
let draftHydrationRequestId = 0;
let restoredDraftTarget = "";

function draftTargetIdentity() {
  return JSON.stringify([props.connectionId, props.database, metadataSchema.value, props.tableName, props.catalog, props.tableType, props.exactIdentity === true, databaseType.value]);
}

function invalidateDraftHydration() {
  draftHydrationRequestId++;
  hydratingRestoredDraft.value = false;
  clearSqlPreviewState();
}
let structureScrollDraftSyncTimer: ReturnType<typeof setTimeout> | undefined;
let structureColumnScrollingTimer: ReturnType<typeof setTimeout> | undefined;
let lastColumnVirtualRenderScrollTop = 0;
let lastSyncedDraft: TableStructureEditorDraft | undefined;
let structureHorizontalScrollbarThumbLeftPercent = 0;
let structureHorizontalScrollbarThumbWidthPercent = 100;
let structureHorizontalScrollbarResizeObserver: ResizeObserver | null = null;
let structureHorizontalScrollbarObserverGeneration = 0;
let structureHorizontalScrollbarPreviousUserSelect: string | null = null;
let structureHorizontalScrollbarDragState: {
  scroller: HTMLElement;
  trackRect: DOMRect;
  thumbOffsetPx: number;
  maxScrollLeft: number;
} | null = null;
// A context-menu target may arrive before metadata rows render, so search text
// and row scrolling are tracked separately for each request.
let appliedInitialTargetSearchKey = "";
let appliedInitialTargetScrollKey = "";
let lastAppliedInitialTargetRequestId: number | undefined;
let initialIndexTargetError: { key: string; message: string } | undefined;

function cloneDraftValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let structureScrollPositions: Partial<Record<TableInfoTab, TableStructureEditorViewport>> = {};

function structureScrollerElement(scroller: StructureScrollerRef | undefined): HTMLElement | undefined {
  if (!scroller) return undefined;
  if (scroller instanceof HTMLElement) return scroller;
  return scroller.$el instanceof HTMLElement ? scroller.$el : undefined;
}

function structureScrollerForTab(tab: TableInfoTab): HTMLElement | undefined {
  if (tab === "columns") return structureScrollerElement(columnsScrollerRef.value);
  if (tab === "indexes") return structureScrollerElement(indexesScrollerRef.value);
  if (tab === "foreignKeys") return structureScrollerElement(foreignKeysScrollerRef.value);
  if (tab === "constraints") return structureScrollerElement(constraintsScrollerRef.value);
  if (tab === "triggers") return structureScrollerElement(triggersScrollerRef.value);
  if (tab === "partitions") return structureScrollerElement(partitionsScrollerRef.value);
  if (tab === "ddl") return structureScrollerElement(ddlScrollerRef.value);
  return undefined;
}

function activeStructureHorizontalScroller(): HTMLElement | undefined {
  if (activeTab.value !== "columns" && activeTab.value !== "indexes") return undefined;
  return structureScrollerForTab(activeTab.value);
}

function applyStructureHorizontalScrollbarThumbStyle(): boolean {
  const thumb = structureHorizontalScrollbarThumbRef.value;
  if (!thumb) return false;
  thumb.style.width = `${structureHorizontalScrollbarThumbWidthPercent}%`;
  thumb.style.left = `${structureHorizontalScrollbarThumbLeftPercent}%`;
  return true;
}

function updateStructureHorizontalScrollbar(scroller = activeStructureHorizontalScroller()) {
  if (!scroller) {
    hasStructureHorizontalOverflow.value = false;
    return;
  }
  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const hasOverflow = maxScrollLeft > 1;
  hasStructureHorizontalOverflow.value = hasOverflow;
  const thumbWidth = scroller.scrollWidth > 0 ? Math.min(100, Math.max(6, (scroller.clientWidth / scroller.scrollWidth) * 100)) : 100;
  structureHorizontalScrollbarThumbWidthPercent = thumbWidth;
  structureHorizontalScrollbarThumbLeftPercent = maxScrollLeft > 0 ? (scroller.scrollLeft / maxScrollLeft) * Math.max(0, 100 - thumbWidth) : 0;
  if (!applyStructureHorizontalScrollbarThumbStyle() && hasOverflow) void nextTick(applyStructureHorizontalScrollbarThumbStyle);
}

function observeStructureHorizontalScroller() {
  const generation = ++structureHorizontalScrollbarObserverGeneration;
  structureHorizontalScrollbarResizeObserver?.disconnect();
  structureHorizontalScrollbarResizeObserver = null;
  const tab = activeTab.value;
  const refresh = () => {
    if (generation !== structureHorizontalScrollbarObserverGeneration || tab !== activeTab.value) return;
    const scroller = activeStructureHorizontalScroller();
    updateStructureHorizontalScrollbar(scroller);
    if (!scroller || typeof ResizeObserver === "undefined") return;
    structureHorizontalScrollbarResizeObserver = new ResizeObserver(() => {
      updateStructureHorizontalScrollbar(scroller);
    });
    structureHorizontalScrollbarResizeObserver.observe(scroller);
    for (const child of Array.from(scroller.children)) structureHorizontalScrollbarResizeObserver.observe(child);
  };
  // TabsContent mounts the newly active pane on the tick after the tab change.
  // Defer the measurement one additional tick so returning from a card tab
  // (for example, Triggers) can find the freshly mounted columns scroller.
  void nextTick(() => void nextTick(refresh));
}

function applyStructureHorizontalScrollbarDrag(clientX: number) {
  const dragState = structureHorizontalScrollbarDragState;
  if (!dragState) return;
  const thumbWidthPx = dragState.trackRect.width * (structureHorizontalScrollbarThumbWidthPercent / 100);
  const maxThumbLeftPx = Math.max(1, dragState.trackRect.width - thumbWidthPx);
  const thumbLeftPx = Math.min(maxThumbLeftPx, Math.max(0, clientX - dragState.trackRect.left - dragState.thumbOffsetPx));
  dragState.scroller.scrollLeft = (thumbLeftPx / maxThumbLeftPx) * dragState.maxScrollLeft;
  updateStructureHorizontalScrollbar(dragState.scroller);
}

function onStructureHorizontalScrollbarPointerMove(event: PointerEvent) {
  if (!structureHorizontalScrollbarDragState) return;
  event.preventDefault();
  applyStructureHorizontalScrollbarDrag(event.clientX);
}

function stopStructureHorizontalScrollbarDrag() {
  if (!structureHorizontalScrollbarDragState) return;
  structureHorizontalScrollbarDragState = null;
  structureHorizontalScrollbarTrackRef.value?.classList.remove("structure-horizontal-scrollbar--dragging");
  window.removeEventListener("pointermove", onStructureHorizontalScrollbarPointerMove, true);
  window.removeEventListener("pointerup", stopStructureHorizontalScrollbarDrag, true);
  window.removeEventListener("pointercancel", stopStructureHorizontalScrollbarDrag, true);
  document.body.style.userSelect = structureHorizontalScrollbarPreviousUserSelect ?? "";
  structureHorizontalScrollbarPreviousUserSelect = null;
}

function startStructureHorizontalScrollbarDrag(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return;
  const scroller = activeStructureHorizontalScroller();
  const track = structureHorizontalScrollbarTrackRef.value;
  if (!scroller || !track || !hasStructureHorizontalOverflow.value) return;
  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  if (maxScrollLeft <= 1) return;
  const trackRect = track.getBoundingClientRect();
  const thumbLeftPx = trackRect.width * (structureHorizontalScrollbarThumbLeftPercent / 100);
  const thumbWidthPx = trackRect.width * (structureHorizontalScrollbarThumbWidthPercent / 100);
  const pointerX = event.clientX - trackRect.left;
  structureHorizontalScrollbarDragState = {
    scroller,
    trackRect,
    thumbOffsetPx: pointerX >= thumbLeftPx && pointerX <= thumbLeftPx + thumbWidthPx ? pointerX - thumbLeftPx : thumbWidthPx / 2,
    maxScrollLeft,
  };
  track.classList.add("structure-horizontal-scrollbar--dragging");
  structureHorizontalScrollbarPreviousUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", onStructureHorizontalScrollbarPointerMove, true);
  window.addEventListener("pointerup", stopStructureHorizontalScrollbarDrag, true);
  window.addEventListener("pointercancel", stopStructureHorizontalScrollbarDrag, true);
  event.preventDefault();
  applyStructureHorizontalScrollbarDrag(event.clientX);
}

function restoreStructureScrollPosition(tab = activeTab.value) {
  const position = structureScrollPositions[tab];
  if (!position) return;
  nextTick(() => {
    if (tab === "ddl" && ddlEditorView.value) {
      ddlEditorView.value.scrollDOM.scrollTop = Math.max(0, position.scrollTop);
      ddlEditorView.value.scrollDOM.scrollLeft = Math.max(0, position.scrollLeft);
      return;
    }
    const scroller = structureScrollerForTab(tab);
    if (!scroller) return;
    scroller.scrollTop = Math.max(0, position.scrollTop);
    scroller.scrollLeft = Math.max(0, position.scrollLeft);
    if (tab === "columns" || tab === "indexes") updateStructureHorizontalScrollbar(scroller);
  });
}

function scheduleStructureScrollDraftSync() {
  if (structureScrollDraftSyncTimer) clearTimeout(structureScrollDraftSyncTimer);
  structureScrollDraftSyncTimer = setTimeout(() => {
    structureScrollDraftSyncTimer = undefined;
    syncStructureScrollDraftToParent();
  }, STRUCTURE_SCROLL_DRAFT_SYNC_DELAY_MS);
}

function flushStructureScrollDraftSync() {
  if (!structureScrollDraftSyncTimer) return;
  clearTimeout(structureScrollDraftSyncTimer);
  structureScrollDraftSyncTimer = undefined;
  syncStructureScrollDraftToParent();
}

function updateColumnVirtualRowsDuringScroll(scroller: HTMLElement) {
  const virtualScroller = columnsScrollerRef.value;
  if (!virtualScroller || virtualScroller instanceof HTMLElement || structureScrollerElement(virtualScroller) !== scroller) return;
  lastColumnVirtualRenderScrollTop = scroller.scrollTop;
  virtualScroller.updateVisibleItems?.(false, true);
}

function updateExtendedPropertiesContentWidth() {
  const scroller = structureScrollerElement(columnsScrollerRef.value);
  if (!scroller) return;
  const chromeWidth = structureDensityMetric.value.cellPaddingX * 2 + 1;
  let width = extendedPropertiesContentWidth.value;
  for (const content of scroller.querySelectorAll<HTMLElement>("[data-structure-extended-properties]")) {
    width = Math.max(width, content.offsetWidth + chromeWidth);
  }
  extendedPropertiesContentWidth.value = width;
}

function onColumnVirtualRowsUpdated() {
  const scroller = structureScrollerElement(columnsScrollerRef.value);
  if (scroller) lastColumnVirtualRenderScrollTop = scroller.scrollTop;
  void nextTick(updateExtendedPropertiesContentWidth);
}

function columnVirtualRowsNeedSynchronousUpdate(scroller: HTMLElement): boolean {
  return Math.abs(scroller.scrollTop - lastColumnVirtualRenderScrollTop) >= STRUCTURE_COLUMN_VIRTUAL_BUFFER_PX;
}

function markColumnVirtualScrollerScrolling(scroller: HTMLElement) {
  scroller.classList.add("is-scrolling");
  if (structureColumnScrollingTimer) clearTimeout(structureColumnScrollingTimer);
  structureColumnScrollingTimer = window.setTimeout(() => {
    structureColumnScrollingTimer = undefined;
    scroller.classList.remove("is-scrolling");
    updateColumnVirtualRowsDuringScroll(scroller);
  }, STRUCTURE_COLUMN_SCROLL_INTERACTION_DELAY_MS);
}

function onStructureContentScroll(tab: TableInfoTab, event: Event) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  if (tab === "columns") {
    markColumnVirtualScrollerScrolling(target);
    if (columnVirtualRowsNeedSynchronousUpdate(target)) updateColumnVirtualRowsDuringScroll(target);
  }
  if (tab === "columns" || tab === "indexes") {
    updateStructureHorizontalScrollbar(target);
    if (activeTab.value === tab) onStructureVerticalScrollerScroll();
  }
  const position: TableStructureEditorViewport = {
    scrollTop: Math.max(0, Math.round(target.scrollTop)),
    scrollLeft: Math.max(0, Math.round(target.scrollLeft)),
  };
  const previous = structureScrollPositions[tab];
  if (previous?.scrollTop === position.scrollTop && previous.scrollLeft === position.scrollLeft) return;
  structureScrollPositions[tab] = position;
  scheduleStructureScrollDraftSync();
}

function createCurrentDraft(initialized = true): TableStructureEditorDraft {
  return {
    dirty: !!triggerStructureRecovery.value || hasPendingStructureChanges() || ddlDirty.value,
    activeTab: activeTab.value as TableStructureEditorDraft["activeTab"],
    ddlDraft: ddlDraft.value,
    // Only carried alongside an actual edit: without a draft the baseline is
    // refetched, and copying every table's DDL into every draft is pure weight.
    ddlContent: ddlDraft.value === null ? undefined : ddlContent.value,
    rawDdlContent: ddlDraft.value === null ? undefined : rawDdlContent.value,
    includeDdlStorage: ddlStorageIncluded.value,
    compactDdlSql: ddlCompacted.value,
    separateDdlIndexes: ddlIndexesSeparated.value,
    newTableName: newTableName.value,
    tableComment: tableComment.value,
    originalTableComment: originalTableComment.value,
    mysqlAutoIncrementValue: mysqlAutoIncrementValue.value,
    originalMysqlAutoIncrementValue: originalMysqlAutoIncrementValue.value,
    mysqlTableEngine: mysqlTableEngine.value,
    originalMysqlTableEngine: originalMysqlTableEngine.value,
    mysqlTableCharset: mysqlTableCharset.value,
    originalMysqlTableCharset: originalMysqlTableCharset.value,
    mysqlTableCollation: mysqlTableCollation.value,
    originalMysqlTableCollation: originalMysqlTableCollation.value,
    physicalOptions: cloneDraftValue(physicalOptions.value),
    starrocksPhysicalOptions: cloneDraftValue(starrocksPhysicalOptions.value),
    postgresForeignTable: canCreateForeignTable.value ? cloneDraftValue(postgresForeignTable.value) : undefined,
    starrocksSortColumns: starrocksSortColumns.value ? [...starrocksSortColumns.value] : undefined,
    tableOwner: tableOwner.value,
    originalTableOwner: originalTableOwner.value,
    columns: cloneDraftValue(columns.value),
    indexes: cloneDraftValue(indexes.value),
    foreignKeys: cloneDraftValue(foreignKeys.value),
    constraints: cloneDraftValue(constraints.value),
    existingPrimaryKey: existingPrimaryKeyDraft.value ? cloneDraftValue(existingPrimaryKeyDraft.value) : undefined,
    oracleConstraintChange: oracleConstraintDraft.value ? cloneDraftValue(oracleConstraintDraft.value) : undefined,
    oracleForeignKeyCreateRecovery: oracleForeignKeyCreateRecovery.value ? cloneDraftValue(oracleForeignKeyCreateRecovery.value) : undefined,
    oracleTriggerStructureRecovery: triggerStructureRecovery.value ? cloneDraftValue(triggerStructureRecovery.value) : undefined,
    constraintsLoaded: constraintsLoaded.value,
    triggers: cloneDraftValue(triggers.value),
    triggersLoaded: triggersLoaded.value,
    partitionOperations: cloneDraftValue(partitionOperations.value),
    createPartitioningEnabled: createPartitioningEnabled.value,
    createPartitioningKind: createPartitioningKind.value,
    createPartitioningColumns: cloneDraftValue(createPartitioningColumns.value),
    createPartitioningExpression: createPartitioningExpression.value,
    loadedMetadataFacets: [...loadedMetadataFacets],
    scrollPositions: cloneDraftValue(structureScrollPositions),
    appliedInitialTabRequestId: lastAppliedInitialTabRequestId,
    appliedInitialTargetRequestId: lastAppliedInitialTargetRequestId,
    oracleIndexRecovery: oracleIndexRefreshGuard.value ? { target: oracleIndexRefreshGuard.value.target, completedCreates: cloneDraftValue(oracleIndexRefreshGuard.value.completedCreates), refreshError: oracleIndexRefreshError.value || undefined } : undefined,
    initialized,
  };
}

function emitDraftToParent(draft: TableStructureEditorDraft | undefined, originTabId?: string) {
  if (originTabId === undefined || originTabId === props.originTabId) lastSyncedDraft = draft;
  emit("update:draft", draft, originTabId);
}

function syncStructureScrollDraftToParent() {
  if ((!draftHydrated && restoredDraftTarget !== draftTargetIdentity()) || restoringDraft || syncingDraft) return;
  const draft = lastSyncedDraft ?? props.draft;
  if (!draft) {
    syncDraftToParent();
    return;
  }
  emitDraftToParent({
    ...draft,
    activeTab: activeTab.value as TableStructureEditorDraft["activeTab"],
    scrollPositions: cloneDraftValue(structureScrollPositions),
    appliedInitialTabRequestId: lastAppliedInitialTabRequestId,
  });
}

function syncDraftToParent() {
  if (structureScrollDraftSyncTimer) {
    clearTimeout(structureScrollDraftSyncTimer);
    structureScrollDraftSyncTimer = undefined;
  }
  if (!draftHydrated && restoredDraftTarget !== draftTargetIdentity()) return;
  if (restoringDraft || syncingDraft) return;
  syncingDraft = true;
  emitDraftToParent(createCurrentDraft());
  syncingDraft = false;
}

function restoreDraft(draft: TableStructureEditorDraft) {
  invalidateOracleIndexReady();
  lastSyncedDraft = draft;
  restoringDraft = true;
  draftHydrated = false;
  lastAppliedInitialTabRequestId = draft.appliedInitialTabRequestId;
  lastAppliedInitialTargetRequestId = draft.appliedInitialTargetRequestId;
  if (draft.oracleIndexRecovery?.target === oracleIndexTargetIdentity(oracleConstraintTarget())) {
    oracleIndexRefreshGuard.value = { ...cloneDraftValue(draft.oracleIndexRecovery), afterRequestId: -1 };
    oracleIndexRefreshError.value = draft.oracleIndexRecovery.refreshError ?? "";
  }
  activeTab.value = draft.activeTab || "columns";
  // Restore the DDL baseline alongside the edit, otherwise the restored script
  // would read as dirty (or clean) against the wrong reference text.
  if (draft.ddlContent) {
    rawDdlContent.value = draft.rawDdlContent ?? draft.ddlContent;
    ddlStorageIncluded.value = draft.includeDdlStorage ?? !(draft.excludeDdlStorage ?? false);
    ddlCompacted.value = draft.compactDdlSql ?? false;
    ddlIndexesSeparated.value = draft.separateDdlIndexes ?? false;
    ddlFetched.value = true;
  }
  ddlDraft.value = draft.ddlDraft ?? null;
  newTableName.value = draft.newTableName || "";
  postgresForeignTable.value = restorePostgresForeignTableDraft(draft.postgresForeignTable);
  tableComment.value = draft.tableComment || "";
  originalTableComment.value = draft.originalTableComment || "";
  mysqlAutoIncrementValue.value = draft.mysqlAutoIncrementValue;
  originalMysqlAutoIncrementValue.value = draft.originalMysqlAutoIncrementValue;
  mysqlTableEngine.value = draft.mysqlTableEngine || "";
  originalMysqlTableEngine.value = draft.originalMysqlTableEngine || "";
  mysqlTableCharset.value = draft.mysqlTableCharset || "";
  originalMysqlTableCharset.value = draft.originalMysqlTableCharset || "";
  mysqlTableCollation.value = draft.mysqlTableCollation || "";
  originalMysqlTableCollation.value = draft.originalMysqlTableCollation || "";
  tableOwner.value = draft.tableOwner || "";
  originalTableOwner.value = draft.originalTableOwner || "";
  columns.value = cloneDraftValue(draft.columns || []);
  physicalOptions.value = restoreTablePhysicalOptions(draft);
  starrocksPhysicalOptions.value = restoreStarRocksPhysicalOptions(draft.starrocksPhysicalOptions);
  starrocksSortColumns.value = draft.starrocksSortColumns ? [...draft.starrocksSortColumns] : undefined;
  // Existing-index edits never support Concurrent (the checkbox is disabled and
  // the core builder rejects the request), so a stale `concurrently: true`
  // saved in a restored draft must not be submitted or deadlock the save.
  indexes.value = cloneDraftValue(draft.indexes || []).map((index) => {
    if (index.original) index.concurrently = false;
    // Older drafts have no naming seed. Preserve their saved names until regeneration.
    if (index.autoNameColumn === undefined) {
      if (index.name) index.nameEdited = true;
      else index.nameEdited ??= false;
    }
    return index;
  });
  // Re-run the availability normalization against the current inputs (e.g. a
  // re-activated editor may already carry an unknown/unsupported partition
  // status): restored new-index Concurrent choices that became illegal are
  // normalized away with the same fail-closed invalidation as a probe failure.
  normalizeConcurrentIndexDraftsForCurrentAvailability();
  foreignKeys.value = cloneDraftValue(draft.foreignKeys || []);
  constraints.value = cloneDraftValue(draft.constraints || []);
  existingPrimaryKeyDraft.value = draft.existingPrimaryKey ? cloneDraftValue(draft.existingPrimaryKey) : undefined;
  oracleConstraintDraft.value = draft.oracleConstraintChange ? cloneDraftValue(draft.oracleConstraintChange) : undefined;
  oracleForeignKeyCreateRecovery.value = draft.oracleForeignKeyCreateRecovery ? cloneDraftValue(draft.oracleForeignKeyCreateRecovery) : undefined;
  triggerStructureRecovery.value = draft.oracleTriggerStructureRecovery ? cloneDraftValue(draft.oracleTriggerStructureRecovery) : undefined;
  if (oracleForeignKeyCreateRecovery.value) {
    primaryKeyResultTitle.value = "oracleForeignKey.resultTitle";
    primaryKeyResultMessage.value = `${metadataSchema.value}.${oracleForeignKeyCreateRecovery.value.tableName}: ${t("oracleForeignKey.createdTablePartial")}`;
    primaryKeyResultDetails.value = oracleForeignKeyCreateRecovery.value.details;
    primaryKeyResultOpen.value = true;
  }
  // Drafts created before constraint loading existed have no saved facet.
  constraintsLoaded.value = draft.constraintsLoaded ?? false;
  triggers.value = cloneDraftValue(draft.triggers || []);
  // Drafts created before lazy trigger loading always contained live trigger metadata.
  triggersLoaded.value = draft.triggersLoaded ?? true;
  partitionOperations.value = cloneDraftValue(draft.partitionOperations || []);
  createPartitioningEnabled.value = draft.createPartitioningEnabled ?? false;
  createPartitioningKind.value = draft.createPartitioningKind ?? "range";
  createPartitioningColumns.value = cloneDraftValue(draft.createPartitioningColumns || []);
  createPartitioningExpression.value = draft.createPartitioningExpression ?? "";
  loadedMetadataFacets.clear();
  if (draft.loadedMetadataFacets) {
    for (const facet of draft.loadedMetadataFacets) loadedMetadataFacets.add(facet);
  } else {
    const activeScope = visibleTableStructureRefreshScope(draft.activeTab || "columns");
    if (activeScope.columns) loadedMetadataFacets.add("columns");
    // Older field-tab drafts did not load indexes alongside columns.
    if (draft.activeTab === "indexes" || draft.indexes?.length) loadedMetadataFacets.add("indexes");
    if (activeScope.foreignKeys || draft.foreignKeys?.length) loadedMetadataFacets.add("foreign-keys");
    if (activeScope.constraints || constraintsLoaded.value) loadedMetadataFacets.add("constraints");
    if (activeScope.triggers || triggersLoaded.value) loadedMetadataFacets.add("triggers");
    if (activeScope.tableComment) loadedMetadataFacets.add("comment");
  }
  // Some older snapshots have incomplete facet flags but already contain index edits.
  if (indexes.value.length) loadedMetadataFacets.add("indexes");
  structureScrollPositions = cloneDraftValue(draft.scrollPositions || {});
  restoringDraft = false;
  restoredDraftTarget = draftTargetIdentity();
  draftHydrated = !needsColumnDraftMetadataHydration();
  restoreStructureScrollPosition();
}

function needsColumnDraftMetadataHydration() {
  return !isCreateMode.value && columns.value.some((column) => !column.original && !column.id.startsWith("new:") && !!column.name.trim());
}

async function hydrateRestoredDraftFromDatabase(force = false): Promise<boolean> {
  if (!needsColumnDraftMetadataHydration()) {
    if (draftHydrationError.value || hydratingRestoredDraft.value) {
      invalidateDraftHydration();
      draftHydrationError.value = "";
      markDraftHydratedAndSync();
      scheduleSqlPreviewRefresh();
    }
    return true;
  }
  if (hydratingRestoredDraft.value && !force) return false;
  const request = ddlRequest();
  if (!request.connectionId || !request.database || !request.tableName) return false;
  const identity = draftTargetIdentity();
  const dbType = databaseType.value;
  const requestId = ++draftHydrationRequestId;
  const config = store.getConfig(request.connectionId);
  const fingerprint = config ? connectionConfigFingerprint(config) : "";
  let revision: number | undefined;
  const current = () =>
    !primaryKeyUnmounted &&
    requestId === draftHydrationRequestId &&
    identity === draftTargetIdentity() &&
    (revision === undefined || store.connectionStateRevision(request.connectionId) === revision) &&
    (store.getConfig(request.connectionId) ? connectionConfigFingerprint(store.getConfig(request.connectionId)!) : "") === fingerprint;
  hydratingRestoredDraft.value = true;
  draftHydrationError.value = "";
  clearSqlPreviewState();
  scheduleSqlPreviewRefresh();
  let completed = false;
  try {
    await store.ensureConnected(request.connectionId);
    if (!current()) return false;
    revision = store.connectionStateRevision(request.connectionId);
    let { value: nextColumns } = await loadObjectMetadataFacet(request, "columns", () => getStructureColumns(request), { force });
    if (!current()) return false;
    let formattedDdl: string | undefined;
    if (dbType === "manticoresearch" && tableMetadataCapabilities.value.ddl) {
      try {
        const { ddl } = await loadObjectDdl(request);
        formattedDdl = await formatStructureDdl(ddl);
        nextColumns = applyManticoreDdlColumnExtras(nextColumns, ddl);
      } catch {
        /* ignore — Manticore column properties can still come from SHOW COLUMNS when available */
      }
    }
    if (!current()) return false;
    const candidate = rehydrateColumnDraftsFromMetadata(columns.value, nextColumns, dbType);
    if (candidate.some((column) => !column.original && !column.id.startsWith("new:") && !!column.name.trim())) throw new Error(t("oceanbasePrimaryKey.incompleteMetadata"));
    columns.value = candidate;
    if (formattedDdl !== undefined) {
      rawDdlContent.value = formattedDdl;
      ddlFetched.value = true;
    }
    markDraftHydratedAndSync();
    completed = true;
    return true;
  } catch (e: any) {
    if (current()) draftHydrationError.value = `${t("oceanbasePrimaryKey.incompleteMetadata")} ${e?.message || String(e)}`;
    return false;
  } finally {
    if (requestId === draftHydrationRequestId) {
      hydratingRestoredDraft.value = false;
      clearSqlPreviewState();
      if (completed || ddlDirty.value) scheduleSqlPreviewRefresh();
    }
  }
}

async function initializeRestoredDraftMetadata(identity: string, revalidateRestoredColumns = false) {
  const current = () => !primaryKeyUnmounted && identity === draftTargetIdentity();
  if (!current()) return;
  applyInitialStructureTarget();
  void loadMysqlAutoIncrementCounter(true);
  if (oracleIndexRefreshError.value) {
    await retryOracleIndexRefresh();
  } else if ((props.exactIdentity || oracleIndexRefreshGuard.value) && !isCreateMode.value) {
    await loadStructure(true, { columns: false, indexes: true, constraints: false, foreignKeys: false, triggers: false, partitions: false, tableComment: false }, true, { blockSecondaryMetadata: true, preserveDraft: true, forceMetadata: true });
  }
  if (!current()) return;
  await loadActiveTableStructureMetadataIfNeeded();
  if (current() && revalidateRestoredColumns) {
    void revalidateCachedStructureMetadata(structureLoadRequestId, { columns: true, tableComment: false }, undefined);
  }
}

function markDraftHydratedAndSync() {
  draftHydrated = true;
  syncDraftToParent();
}

function hasPendingStructureChanges(includeExistingPrimaryKey = true, includeOracleConstraint = true): boolean {
  if (includeExistingPrimaryKey && existingPrimaryKeyChanged.value) return true;
  if (includeOracleConstraint && oracleConstraintChanged.value) return true;
  if (isCreateMode.value) {
    return (
      !!newTableName.value.trim() ||
      isCreatingForeignTable.value ||
      !!tableComment.value.trim() ||
      mysqlTableEngine.value !== originalMysqlTableEngine.value ||
      hasTablePhysicalOptions(physicalOptions.value) ||
      (databaseType.value === "starrocks" && hasStarRocksPhysicalOptions(starrocksPhysicalOptions.value)) ||
      columns.value.length > 0 ||
      indexes.value.length > 0 ||
      foreignKeys.value.length > 0 ||
      triggers.value.length > 0 ||
      createPartitioningEnabled.value ||
      partitionOperations.value.length > 0
    );
  }
  const scope = captureStructureRefreshScope();
  return (
    scope.columns ||
    scope.indexes ||
    scope.foreignKeys ||
    scope.triggers ||
    scope.tableComment ||
    mysqlTableCharsetChanged.value ||
    partitionOperations.value.length > 0 ||
    mysqlTableEngine.value.toLowerCase() !== originalMysqlTableEngine.value.toLowerCase() ||
    (canBuildMysqlAutoIncrement.value && mysqlAutoIncrementValue.value !== originalMysqlAutoIncrementValue.value) ||
    (supportsTableOwner.value && tableOwner.value.trim() !== originalTableOwner.value.trim())
  );
}

function clearSqlPreviewState() {
  if (sqlPreviewDebounceTimer) {
    clearTimeout(sqlPreviewDebounceTimer);
    sqlPreviewDebounceTimer = undefined;
  }
  sqlPreviewRequestId++;
  deferredSqlPreviewRefresh = false;
  sqlPreviewLoading.value = false;
  sqlPreviewPending.value = false;
  pendingStatements.value = [];
  warnings.value = [];
  sqliteSchemaRevision.value = undefined;
  existingPrimaryKeyPlan.value = undefined;
  existingPrimaryKeySession.value = undefined;
  existingOracleForeignKeyPlan.value = undefined;
  existingOracleForeignKeySession.value = undefined;
  newOracleForeignKeyPlan.value = undefined;
  newOracleForeignKeySession.value = undefined;
  oracleConstraintPlan.value = undefined;
  oracleConstraintSession.value = undefined;
}

function dataTypeOptionsCacheKey(connectionId: string, database: string) {
  return `${connectionId}\u0000${database}`;
}

function mergeDataTypeOptions(primary: readonly string[], fallback: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const option of [...primary, ...fallback]) {
    const trimmed = option.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function mysqlDataTypeTooltip(option: string): string | undefined {
  if (databaseType.value !== "mysql") return undefined;
  const product = connection.value?.driver_profile === "mariadb" ? "mariadb" : connection.value?.driver_profile === "mysql" ? "mysql" : undefined;
  const help = getMysqlDataTypeHelp(option, { product });
  return help ? [help.key, ...(help.warningKeys ?? [])].map((key) => t(`structureEditor.mysqlDataTypeHelp.${key}`)).join("\n\n") : undefined;
}

function postgresDataTypeTooltip(option: string): string | undefined {
  if (databaseType.value !== "postgres") return undefined;
  const help = getPostgresDataTypeHelp(option);
  return help ? t(`structureEditor.postgresDataTypeHelp.${help.key}`) : undefined;
}

function sqliteDataTypeTooltip(option: string): string | undefined {
  if (databaseType.value !== "sqlite") return undefined;
  const help = getSqliteDataTypeHelp(option);
  return help ? t(`structureEditor.sqliteDataTypeHelp.${help.key}`) : undefined;
}

function dataTypeTooltip(option: string): string | undefined {
  if (databaseType.value === "mysql") return mysqlDataTypeTooltip(option);
  if (databaseType.value === "postgres") return postgresDataTypeTooltip(option);
  if (databaseType.value === "sqlite") return sqliteDataTypeTooltip(option);
  return undefined;
}

function gaussdbMDataTypeDisplayName(option: string): string {
  if (databaseType.value === "gaussdb") {
    const conn = connection.value;
    if (conn?.driver_profile?.toLowerCase() === "gaussdb-m") {
      return gaussdbMTypeDisplayName(option);
    }
  }
  return option;
}

async function loadDynamicDataTypeOptions() {
  const requestId = ++dataTypeOptionsRequestId;
  const connectionId = props.connectionId;
  const database = props.database;
  if (!connectionId || !database) {
    dynamicDataTypeOptions.value = [];
    return;
  }
  const cacheKey = dataTypeOptionsCacheKey(connectionId, database);
  const cached = dynamicDataTypeOptionsCache.get(cacheKey);
  if (cached) {
    dynamicDataTypeOptions.value = cached;
    return;
  }
  dynamicDataTypeOptions.value = [];
  try {
    await store.ensureConnected(connectionId);
    const options = await api.listDataTypes(connectionId, database);
    if (requestId !== dataTypeOptionsRequestId) return;
    const normalized = mergeDataTypeOptions(options, []);
    if (normalized.length > 0) {
      dynamicDataTypeOptionsCache.set(cacheKey, normalized);
      dynamicDataTypeOptions.value = normalized;
    } else {
      dynamicDataTypeOptions.value = [];
    }
  } catch {
    if (requestId === dataTypeOptionsRequestId) {
      dynamicDataTypeOptions.value = [];
    }
  }
}

function scheduleSqlPreviewRefresh() {
  if (sqlPreviewDebounceTimer) {
    clearTimeout(sqlPreviewDebounceTimer);
    sqlPreviewDebounceTimer = undefined;
  }
  sqlPreviewRequestId++;
  deferredSqlPreviewRefresh = false;
  // Existing StarRocks tables need their model metadata before definition
  // controls can be enabled, even when no column has been edited yet.
  const needsStarRocksAlterContext = !isCreateMode.value && databaseType.value === "starrocks" && !starrocksAlterContext.value;
  if (!hasPendingStructureChanges() && !ddlDirty.value && !needsStarRocksAlterContext) {
    pendingStatements.value = [];
    warnings.value = [];
    sqliteSchemaRevision.value = undefined;
    sqlPreviewLoading.value = false;
    sqlPreviewPending.value = false;
    return;
  }
  sqlPreviewPending.value = true;
  // An edited DDL script is previewed by splitting the text the user typed, so
  // none of the column-draft/metadata gates below apply to it — waiting on them
  // would leave the preview pending with nothing left to trigger it.
  if (!ddlDirty.value) {
    if (hydratingRestoredDraft.value || needsColumnDraftMetadataHydration() || draftHydrationError.value) {
      clearSqlPreviewState();
      sqlPreviewPending.value = hydratingRestoredDraft.value;
      return;
    }
    if (!isCreateMode.value && secondaryMetadataLoading.value) {
      deferredSqlPreviewRefresh = true;
      return;
    }
  }
  sqlPreviewDebounceTimer = setTimeout(() => {
    sqlPreviewDebounceTimer = undefined;
    void refreshSqlPreview();
  }, SQL_PREVIEW_DEBOUNCE_MS);
}

function structureChangeOptions(): BuildTableStructureChangeSqlOptions {
  return {
    databaseType: databaseType.value,
    driverProfile: connection.value?.driver_profile,
    schema: props.schema,
    tableName: isCreateMode.value ? newTableName.value.trim() : props.tableName || "",
    // User-entered names are normalized here so the preview and the executed
    // batch agree: MySQL rejects identifiers that end with a space (ERROR 1166),
    // while a metadata name the user never touched keeps its exact spelling.
    columns: columns.value.map((column) => {
      const normalized = {
        ...column,
        name: draftColumnNameForSql(column.name, column.original?.name),
        // Do not let a draft created by an older build submit properties that the
        // current database cannot represent (notably PostgreSQL-style identity on openGauss).
        ...(showExtendedProperties.value ? {} : { extra: {} }),
      };
      // MySQL generated columns cannot carry DEFAULT / AUTO_INCREMENT /
      // ON UPDATE CURRENT_TIMESTAMP; drop them from the payload only while the
      // generated attribute is active, so unchecking "virtual" leaves the
      // draft (and the diff) exactly as the user last saw it.
      if (isMysqlGeneratedActive(column) && normalized.extra) {
        const { autoIncrement: _autoIncrement, onUpdateCurrentTimestamp: _onUpdate, ...restExtra } = normalized.extra;
        normalized.extra = restExtra;
        normalized.defaultValue = "";
      }
      return normalized;
    }),
    indexes: sanitizeStructureIndexesForCapabilities(indexes.value, structureCapabilities.value),
    foreignKeys: foreignKeys.value,
    triggers: triggers.value.map((trigger) => {
      const metadata = exactOracleTriggerMetadata(trigger.original);
      const oracleExact =
        metadata?.parent && (metadata.scope === "TABLE" || metadata.scope === "VIEW")
          ? { owner: metadata.owner, parentType: metadata.scope }
          : !trigger.original && oracleTriggerReadOptions(databaseType.value) && metadataSchema.value
            ? (trigger.oracleExact ?? { owner: metadataSchema.value, parentType: props.tableType === "view" ? ("VIEW" as const) : ("TABLE" as const) })
            : undefined;
      return { ...trigger, oracleExact };
    }),
    tableComment: tableComment.value,
    originalTableComment: isCreateMode.value ? undefined : originalTableComment.value,
    mysqlAutoIncrementValue: isCreateMode.value && canEditMysqlAutoIncrement.value ? mysqlAutoIncrementValue.value || undefined : undefined,
    mysqlEngine: mysqlTableEngineSqlOption({ value: mysqlTableEngine.value, originalValue: originalMysqlTableEngine.value }, isCreateMode.value, supportsMysqlEngine.value && !mysqlTableEngineLoading.value && !mysqlTableEngineLoadError.value),
    transwarpCreate: isCreateMode.value && databaseType.value === "transwarp" ? buildInceptorCreateOptions(physicalOptions.value, columns.value) : undefined,
    tableCollation: mysqlTableDefaultCollation.value || undefined,
    partitioned: isPartitionedParent.value,
    foreignTable: isForeignTable.value,
    isGaussdbMMode: connection.value?.driver_profile?.toLowerCase() === "gaussdb-m",
    primaryKeyName: willCreateNewPrimaryKey.value ? primaryKeyName.value.trim() || undefined : undefined,
    primaryKeyChange: existingPrimaryKeyChanged.value ? cloneDraftValue(existingPrimaryKeyDraft.value) : undefined,
    oracleConstraintChanges: oracleConstraintChanged.value && oracleConstraintDraft.value ? [cloneDraftValue(oracleConstraintDraft.value)] : undefined,
  };
}

function partitionSqlOptions(): TablePartitionSqlOptions {
  return {
    databaseType: databaseType.value,
    driverProfile: connection.value?.driver_profile,
    // `metadataSchema` normalizes the fallback (database as schema, empty → public
    // on the backend), so DDL stays schema-qualified like every other statement.
    schema: metadataSchema.value,
    // Create mode has no table yet: the pending partition operations target the
    // new table's name.
    tableName: isCreateMode.value ? newTableName.value.trim() : props.tableName || "",
    operations: partitionOperations.value,
  };
}

async function refreshSqlPreview() {
  const requestId = ++sqlPreviewRequestId;
  triggerStructurePlan.value = undefined;
  existingPrimaryKeyPlan.value = undefined;
  existingPrimaryKeySession.value = undefined;
  oracleConstraintPlan.value = undefined;
  oracleConstraintSession.value = undefined;
  existingOracleForeignKeyPlan.value = undefined;
  existingOracleForeignKeySession.value = undefined;
  newOracleForeignKeyPlan.value = undefined;
  newOracleForeignKeySession.value = undefined;
  const indexWriteWarning = schemaIndexWriteWarning();
  if (indexWriteWarning) {
    pendingStatements.value = [];
    warnings.value = [indexWriteWarning];
    sqlPreviewLoading.value = false;
    sqlPreviewPending.value = false;
    return;
  }
  if (concurrentAvailabilityInvalidated.value) {
    // Availability gap in effect: never regenerate SQL here — doing so would
    // turn a lost Concurrent request into a silent blocking CREATE INDEX. Keep
    // the explicit error visible until a later probe re-verifies the table.
    pendingStatements.value = [];
    warnings.value = [t("structureEditor.concurrentUnavailableBlocksSave")];
    sqliteSchemaRevision.value = undefined;
    sqlPreviewLoading.value = false;
    sqlPreviewPending.value = false;
    return;
  }
  if (ddlDirty.value) {
    // An edited DDL script runs verbatim — it is never diffed against the
    // current structure — so it cannot be merged with the generated ALTERs.
    // Refuse to guess which one the user meant instead of executing both.
    const conflictsWithStructureDraft = hasPendingStructureChanges();
    pendingStatements.value = conflictsWithStructureDraft ? [] : ddlDraftStatements();
    warnings.value = conflictsWithStructureDraft ? [t("structureEditor.ddlEditConflictsWithStructure")] : [];
    sqliteSchemaRevision.value = undefined;
    sqlPreviewLoading.value = false;
    sqlPreviewPending.value = false;
    return;
  }
  if (hydratingRestoredDraft.value || needsColumnDraftMetadataHydration() || draftHydrationError.value) {
    clearSqlPreviewState();
    sqlPreviewPending.value = hydratingRestoredDraft.value;
    return;
  }
  if (!isCreateMode.value && databaseType.value === "starrocks") {
    try {
      const { ddl } = await loadObjectDdl(ddlRequest());
      starrocksAlterContext.value = starRocksAlterOptionsFromDdl(ddl, connection.value?.database_info?.productVersion);
      if (!starrocksSortColumns.value) starrocksSortColumns.value = [...(starrocksAlterContext.value.sortColumns ?? [])];
    } catch {
      starrocksAlterContext.value = starRocksAlterOptionsFromDdl("", connection.value?.database_info?.productVersion);
    }
  }
  if (requestId !== sqlPreviewRequestId) return;
  if (!hasPendingStructureChanges()) {
    pendingStatements.value = [];
    warnings.value = [];
    sqliteSchemaRevision.value = undefined;
    sqlPreviewLoading.value = false;
    sqlPreviewPending.value = false;
    return;
  }
  if (existingPrimaryKeyChanged.value) {
    sqlPreviewLoading.value = true;
    try {
      if (!canEditExistingPrimaryKey.value || hasPendingStructureChanges(false)) throw new OceanbasePrimaryKeyValidationError("mixedDraft");
      const target = primaryKeyTarget();
      const connectionRevision = store.connectionStateRevision(target.connectionId);
      const currentConfig = store.getConfig(target.connectionId);
      const configFingerprint = currentConfig ? connectionConfigFingerprint(currentConfig) : "";
      let change = cloneDraftValue(existingPrimaryKeyDraft.value!);
      const draft = cloneDraftValue(change);
      let snapshot: string;
      if (target.databaseType === "oracle") {
        const prepared = await prepareOraclePrimaryKeyChange(target, change);
        change = prepared.change;
        snapshot = prepared.snapshot;
      } else {
        snapshot = await readOceanbasePrimaryKeySnapshot(target, change);
      }
      if (requestId !== sqlPreviewRequestId) return;
      const result = await api.buildTableStructureChangeSql({ ...structureChangeOptions(), primaryKeyChange: change });
      if (requestId !== sqlPreviewRequestId) return;
      const latestConfig = store.getConfig(target.connectionId);
      if (store.connectionStateRevision(target.connectionId) !== connectionRevision || !store.isCurrentConnectionStateRevision(target.connectionId, connectionRevision) || (latestConfig ? connectionConfigFingerprint(latestConfig) : "") !== configFingerprint) {
        throw new Error(t("oceanbasePrimaryKey.refreshRequired"));
      }
      if (result.warnings.length) throw new Error(result.warnings.join("\n"));
      if (result.statements.length !== (change.columns.length ? 2 : 1)) throw new OceanbasePrimaryKeyValidationError("incompletePlan");
      existingPrimaryKeyPlan.value = { target, change, draft, snapshot, statements: [...result.statements] };
      existingPrimaryKeySession.value = { revision: connectionRevision, configFingerprint };
      pendingStatements.value = [...result.statements];
      warnings.value = [];
    } catch (error) {
      if (requestId !== sqlPreviewRequestId) return;
      pendingStatements.value = [];
      warnings.value = [primaryKeyError(error)];
    } finally {
      if (requestId === sqlPreviewRequestId) {
        sqlPreviewLoading.value = false;
        sqlPreviewPending.value = false;
      }
    }
    return;
  }
  if (oracleConstraintChanged.value && oracleConstraintDraft.value) {
    sqlPreviewLoading.value = true;
    const target = primaryKeyTarget() as OracleConstraintTarget;
    const revision = store.connectionStateRevision(target.connectionId);
    const config = store.getConfig(target.connectionId);
    const fingerprint = config ? connectionConfigFingerprint(config) : "";
    const connectionCurrent = () => {
      const currentConfig = store.getConfig(target.connectionId);
      return store.connectionStateRevision(target.connectionId) === revision && store.isCurrentConnectionStateRevision(target.connectionId, revision) && (currentConfig ? connectionConfigFingerprint(currentConfig) : "") === fingerprint;
    };
    const draftFingerprint = JSON.stringify(oracleConstraintDraft.value);
    try {
      if (!isOracleConstraintEditor.value || isCreateMode.value || existingPrimaryKeyChanged.value || hasPendingStructureChanges(false, false)) throw new Error("Apply CHECK/UNIQUE changes separately from other table structure drafts.");
      const plan = await prepareOracleConstraintPlan(target, structureChangeOptions(), cloneDraftValue(oracleConstraintDraft.value), connectionCurrent);
      if (requestId !== sqlPreviewRequestId || JSON.stringify(target) !== JSON.stringify(primaryKeyTarget()) || draftFingerprint !== JSON.stringify(oracleConstraintDraft.value)) return;
      const currentConfig = store.getConfig(target.connectionId);
      if (store.connectionStateRevision(target.connectionId) !== revision || (currentConfig ? connectionConfigFingerprint(currentConfig) : "") !== fingerprint) throw new Error("Connection changed while preparing the constraint plan. Refresh and preview again.");
      oracleConstraintPlan.value = plan;
      oracleConstraintSession.value = { revision, configFingerprint: fingerprint, draftFingerprint };
      pendingStatements.value = [...plan.statements];
      warnings.value = [];
    } catch (error) {
      if (requestId !== sqlPreviewRequestId) return;
      pendingStatements.value = [];
      warnings.value = [error instanceof Error ? error.message : String(error)];
    } finally {
      if (requestId === sqlPreviewRequestId) {
        sqlPreviewLoading.value = false;
        sqlPreviewPending.value = false;
      }
    }
    return;
  }
  const foreignKeyChanges = isOracleForeignKeyEditor.value ? oracleForeignKeyChanges() : [];
  if (isCreateMode.value && foreignKeyChanges.length) {
    sqlPreviewLoading.value = true;
    const target = { ...primaryKeyTarget(), schema: metadataSchema.value, tableName: newTableName.value.trim(), databaseType: databaseType.value === "oracle" ? ("oracle" as const) : ("oceanbase-oracle" as const) };
    const connectionRevision = store.connectionStateRevision(target.connectionId);
    const connectionConfig = store.getConfig(target.connectionId);
    const configFingerprint = connectionConfig ? connectionConfigFingerprint(connectionConfig) : "";
    const connectionCurrent = () => {
      const currentConfig = store.getConfig(target.connectionId);
      return store.connectionStateRevision(target.connectionId) === connectionRevision && store.isCurrentConnectionStateRevision(target.connectionId, connectionRevision) && (currentConfig ? connectionConfigFingerprint(currentConfig) : "") === configFingerprint;
    };
    try {
      const options = { ...structureChangeOptions(), oracleForeignKeyChanges: foreignKeyChanges };
      const partitioning = createPartitioningEnabled.value ? { kind: createPartitioningKind.value, columns: createPartitioningColumns.value, expression: createPartitioningExpression.value } : undefined;
      const plan = await prepareOracleForeignKeyCreatePlan(target, options, foreignKeyChanges, partitioning, connectionCurrent);
      if (requestId !== sqlPreviewRequestId || JSON.stringify(target) !== JSON.stringify({ ...primaryKeyTarget(), schema: metadataSchema.value, tableName: newTableName.value.trim(), databaseType: target.databaseType })) return;
      const currentConfig = store.getConfig(target.connectionId);
      if (store.connectionStateRevision(target.connectionId) !== connectionRevision || (currentConfig ? connectionConfigFingerprint(currentConfig) : "") !== configFingerprint) throw new Error(t("oracleForeignKey.refreshRequired"));
      if (options.triggers?.some((trigger) => trigger.oracleExact && triggerChanged(trigger)) && !plan.triggerOperations?.length) throw new Error("Update the trigger SQL provider before saving this table");
      if (plan.triggerOperations?.length) {
        const triggerPlan = await prepareOracleTriggerStructurePlan({
          target: {
            connectionId: target.connectionId,
            database: target.database,
            catalog: target.catalog,
            owner: target.schema,
            tableName: foldCreatedTableName(target.tableName, target.databaseType),
            executionSchema: props.schema || target.schema,
            parentType: "TABLE",
            databaseType: target.databaseType,
            newTable: true,
          },
          statements: plan.statements,
          operations: plan.triggerOperations,
          triggers: options.triggers!,
        });
        if (requestId !== sqlPreviewRequestId || !connectionCurrent()) return;
        triggerStructurePlan.value = triggerPlan;
        triggerStructureFingerprint = JSON.stringify(structureChangeOptions());
      }
      newOracleForeignKeyPlan.value = plan;
      newOracleForeignKeySession.value = { revision: connectionRevision, configFingerprint, draftFingerprint: JSON.stringify({ options: plan.options, changes: plan.changes, partitioning: plan.partitioning }) };
      pendingStatements.value = [...plan.statements];
      warnings.value = [];
    } catch (error) {
      if (requestId !== sqlPreviewRequestId) return;
      pendingStatements.value = [];
      warnings.value = [error instanceof Error ? error.message : String(error)];
    } finally {
      if (requestId === sqlPreviewRequestId) {
        sqlPreviewLoading.value = false;
        sqlPreviewPending.value = false;
      }
    }
    return;
  }
  if (foreignKeyChanges.length) {
    sqlPreviewLoading.value = true;
    const target = { ...primaryKeyTarget(), schema: metadataSchema.value, tableName: props.tableName || "", databaseType: databaseType.value === "oracle" ? ("oracle" as const) : ("oceanbase-oracle" as const) };
    const connectionRevision = store.connectionStateRevision(target.connectionId);
    const connectionConfig = store.getConfig(target.connectionId);
    const configFingerprint = connectionConfig ? connectionConfigFingerprint(connectionConfig) : "";
    const connectionCurrent = () => {
      const currentConfig = store.getConfig(target.connectionId);
      return store.connectionStateRevision(target.connectionId) === connectionRevision && store.isCurrentConnectionStateRevision(target.connectionId, connectionRevision) && (currentConfig ? connectionConfigFingerprint(currentConfig) : "") === configFingerprint;
    };
    try {
      const plan = await prepareOracleForeignKeyPlan(target, structureChangeOptions(), foreignKeyChanges, connectionCurrent);
      if (requestId !== sqlPreviewRequestId || JSON.stringify(target) !== JSON.stringify(primaryKeyTarget())) return;
      const currentConfig = store.getConfig(target.connectionId);
      if (store.connectionStateRevision(target.connectionId) !== connectionRevision || (currentConfig ? connectionConfigFingerprint(currentConfig) : "") !== configFingerprint) throw new Error(t("oracleForeignKey.refreshRequired"));
      existingOracleForeignKeyPlan.value = plan;
      existingOracleForeignKeySession.value = { revision: connectionRevision, configFingerprint };
      pendingStatements.value = [...plan.statements];
      warnings.value = [];
    } catch (error) {
      if (requestId !== sqlPreviewRequestId) return;
      pendingStatements.value = [];
      warnings.value = [error instanceof Error ? error.message : String(error)];
    } finally {
      if (requestId === sqlPreviewRequestId) {
        sqlPreviewLoading.value = false;
        sqlPreviewPending.value = false;
      }
    }
    return;
  }
  const indexWarnings = indexes.value
    .filter((index) => !index.markedForDrop && needsIndexColumnValidation(index))
    .flatMap((index) => {
      const issue = indexColumnsIssue(index);
      return issue ? [`${index.name || t("structureEditor.addIndex")}: ${t(`structureEditor.${issue}`)}`] : [];
    });
  if (indexWarnings.length) {
    pendingStatements.value = [];
    warnings.value = indexWarnings;
    sqliteSchemaRevision.value = undefined;
    sqlPreviewLoading.value = false;
    sqlPreviewPending.value = false;
    return;
  }
  if (pendingStarRocksSort.value && (columns.value.some(columnChanged) || tableComment.value !== originalTableComment.value || indexes.value.some(indexChanged) || foreignKeys.value.some(foreignKeyChanged) || triggers.value.some(triggerChanged))) {
    pendingStatements.value = [];
    warnings.value = [t("starrocksLayout.sortSaveSeparately")];
    sqlPreviewLoading.value = false;
    sqlPreviewPending.value = false;
    return;
  }
  // Layer B: a stale `concurrently: true` whose availability is no longer
  // enabled must never reach the SQL builder, even if normalization was
  // skipped (race, restored draft, non-UI caller).
  const blockingConcurrentWarning = concurrentIndexBlockingWarning();
  if (blockingConcurrentWarning) {
    pendingStatements.value = [];
    warnings.value = [blockingConcurrentWarning];
    sqliteSchemaRevision.value = undefined;
    sqlPreviewLoading.value = false;
    sqlPreviewPending.value = false;
    return;
  }
  sqlPreviewLoading.value = true;
  const options = structureChangeOptions();
  const tableCharsetChange = mysqlTableCharsetChange.value;
  const partitionResultPromise = partitionOperations.value.length > 0 ? api.buildTablePartitionOperationSql(partitionSqlOptions()) : Promise.resolve({ statements: [], warnings: [] });
  try {
    const [result, ownerResult, mysqlAutoIncrementStatement, partitionResult] = await Promise.all([
      isCreateMode.value
        ? createPartitioningEnabled.value
          ? api.buildCreatePartitionedTableSql({ options, partitioning: { kind: createPartitioningKind.value, columns: createPartitioningColumns.value, expression: createPartitioningExpression.value } })
          : api.buildCreateTableSql(
              options,
              connection.value?.database_info?.productVersion,
              isCreatingForeignTable.value ? { postgresForeignTable: buildPostgresForeignTableOptions(postgresForeignTable.value) } : databaseType.value === "starrocks" ? buildStarRocksDialectOptions(starrocksPhysicalOptions.value) : undefined,
            )
        : hasSqliteTypeChange.value
          ? api.previewSqliteTableStructureChange(props.connectionId, props.database, options)
          : databaseType.value === "starrocks"
            ? api.buildTableStructureChangeSql(options, { ...starrocksAlterContext.value!, reorderColumns: false, positionColumnOrder: structureCapabilities.value.reorderColumn, sortColumnNames: pendingStarRocksSort.value })
            : tableCharsetChange
              ? api.buildTableStructureChangeSql(options, undefined, tableCharsetChange)
              : api.buildTableStructureChangeSql(options),
      supportsTableOwner.value
        ? api.buildTableOwnerChangeSql({
            databaseType: databaseType.value,
            schema: metadataSchema.value,
            tableName: props.tableName || "",
            owner: tableOwner.value,
            originalOwner: originalTableOwner.value,
          })
        : Promise.resolve({ statements: [], warnings: [] }),
      buildMysqlAutoIncrementCounterStatement({
        enabled: canBuildMysqlAutoIncrement.value,
        originalValue: originalMysqlAutoIncrementValue.value,
        value: mysqlAutoIncrementValue.value,
        databaseType: databaseType.value,
        driverProfile: connection.value?.driver_profile,
        schema: props.schema || props.database,
        tableName: props.tableName || "",
        buildSql: api.buildMysqlAutoIncrementSql,
      }),
      partitionResultPromise,
    ]);
    if (requestId !== sqlPreviewRequestId) return;
    const statements = [...result.statements, ...ownerResult.statements, ...(mysqlAutoIncrementStatement ? [mysqlAutoIncrementStatement] : []), ...partitionResult.statements];
    // SQLite type-change apply regenerates this revision-checked plan, so its preview must stay byte-for-byte aligned.
    const triggerOperations = "triggerOperations" in result ? result.triggerOperations : undefined;
    const exactChanges = options.triggers?.some((trigger) => trigger.oracleExact && triggerChanged(trigger));
    if (exactChanges && !result.warnings.length && !("oracleTriggerContract" in result && result.oracleTriggerContract === 1) && !triggerOperations?.length) throw new Error("Update the trigger SQL provider and regenerate the table preview; exact trigger operations are missing");
    const exactStatement = (index: number) => triggerOperations?.some((operation) => index >= operation.statementIndex && index < operation.statementIndex + operation.statementCount);
    const actualStatements = hasSqliteTypeChange.value ? statements : statements.map((statement, index) => (exactStatement(index) ? statement : applyDdlGenerationPreferences(statement, sqlFormatDialectForDbType(databaseType.value))));
    if (triggerOperations?.length && !result.warnings.length) {
      const plan = await prepareOracleTriggerStructurePlan({
        target: {
          connectionId: props.connectionId,
          database: props.database,
          catalog: props.catalog,
          owner: metadataSchema.value!,
          tableName: isCreateMode.value ? foldCreatedTableName(newTableName.value, databaseType.value) : props.tableName!,
          executionSchema: props.schema || metadataSchema.value!,
          parentType: props.tableType === "view" ? "VIEW" : "TABLE",
          databaseType: databaseType.value as "oracle" | "oceanbase-oracle" | "dameng",
          newTable: isCreateMode.value,
        },
        statements: actualStatements,
        operations: triggerOperations,
        triggers: options.triggers!,
      });
      if (requestId !== sqlPreviewRequestId) return;
      triggerStructurePlan.value = plan;
      triggerStructureFingerprint = JSON.stringify(structureChangeOptions());
    }
    pendingStatements.value = actualStatements;
    warnings.value = [...result.warnings, ...ownerResult.warnings, ...partitionResult.warnings];
    sqliteSchemaRevision.value = "schemaRevision" in result && typeof result.schemaRevision === "string" ? result.schemaRevision : undefined;
  } catch (e: any) {
    if (requestId !== sqlPreviewRequestId) return;
    pendingStatements.value = [];
    warnings.value = [e?.message || String(e)];
    sqliteSchemaRevision.value = undefined;
  } finally {
    if (requestId === sqlPreviewRequestId) {
      sqlPreviewLoading.value = false;
      sqlPreviewPending.value = false;
    }
  }
}

const canApply = computed(
  () =>
    !loading.value &&
    !saving.value &&
    !primaryKeyBusy.value &&
    !oracleForeignKeyBusy.value &&
    !oracleConstraintBusy.value &&
    (databaseType.value !== "starrocks" || !starrocksStatusBusy.value) &&
    !postSaveRefreshing.value &&
    !oracleIndexRefreshError.value &&
    !secondaryMetadataLoading.value &&
    !mysqlTableEngineLoading.value &&
    !sqlPreviewLoading.value &&
    !sqlPreviewPending.value &&
    !triggerStructureRecovery.value &&
    (ddlDirty.value || (!hydratingRestoredDraft.value && !needsColumnDraftMetadataHydration() && !draftHydrationError.value)) &&
    pendingStatements.value.length > 0 &&
    warnings.value.length === 0 &&
    !concurrentAvailabilityInvalidated.value &&
    !(isCreateMode.value && oracleForeignKeyCreateRecovery.value?.uncertainSteps.includes("CREATE")) &&
    (!hasSqliteTypeChange.value || !!sqliteSchemaRevision.value) &&
    !!props.connectionId &&
    (isCreateMode.value ? !!newTableName.value.trim() : !!props.tableName),
);

function clearDraft() {
  draftHydrated = false;
  emitDraftToParent(undefined);
}

function resetState() {
  triggerStructurePlan.value = undefined;
  triggerStructureRecovery.value = undefined;
  invalidateDraftHydration();
  restoredDraftTarget = "";
  draftHydrationError.value = "";
  invalidateOracleIndexReady();
  loading.value = false;
  saving.value = false;
  postSaveRefreshing.value = false;
  sqlPreviewLoading.value = false;
  sqlPreviewPending.value = false;
  indexesLoading.value = false;
  foreignKeysLoading.value = false;
  constraintsLoading.value = false;
  triggersLoading.value = false;
  partitionsLoading.value = false;
  partitionsError.value = "";
  errorMessage.value = "";
  oracleIndexRefreshError.value = "";
  oracleIndexRefreshGuard.value = undefined;
  lastAppliedInitialTargetRequestId = undefined;
  secondaryMetadataErrors.value = {};
  isPartitionedParent.value = false;
  isTablePartition.value = false;
  isForeignTable.value = false;
  partitionStatusResolved.value = false;
  partitionStatusKnown.value = true;
  concurrentAvailabilityInvalidated.value = false;
  columns.value = [];
  indexes.value = [];
  pendingStatements.value = [];
  warnings.value = [];
  sqliteSchemaRevision.value = undefined;
  foreignKeys.value = [];
  constraints.value = [];
  existingPrimaryKeyDraft.value = undefined;
  existingPrimaryKeyPlan.value = undefined;
  existingPrimaryKeySession.value = undefined;
  existingOracleForeignKeyPlan.value = undefined;
  existingOracleForeignKeySession.value = undefined;
  newOracleForeignKeyPlan.value = undefined;
  newOracleForeignKeySession.value = undefined;
  oracleConstraintDraft.value = undefined;
  oracleConstraintPlan.value = undefined;
  oracleConstraintSession.value = undefined;
  primaryKeyNewColumn.value = "";
  constraintsLoaded.value = false;
  partitioning.value = null;
  triggers.value = [];
  triggersLoaded.value = false;
  partitionOperations.value = [];
  createPartitioningEnabled.value = false;
  createPartitioningKind.value = "range";
  createPartitioningColumns.value = [];
  createPartitioningExpression.value = "";
  clearColumnSelection();
  rawDdlContent.value = "";
  ddlDraft.value = null;
  ddlFetched.value = false;
  pendingDdlNavigation = false;
  loadedMetadataFacets.clear();
  newTableName.value = "";
  postgresForeignTable.value = emptyPostgresForeignTableDraft();
  tableComment.value = "";
  originalTableComment.value = "";
  mysqlAutoIncrementValue.value = undefined;
  originalMysqlAutoIncrementValue.value = undefined;
  mysqlAutoIncrementLoadRequestId += 1;
  mysqlAutoIncrementLoading.value = false;
  mysqlAutoIncrementLoadError.value = "";
  mysqlTableEngine.value = "";
  originalMysqlTableEngine.value = "";
  mysqlTableCharset.value = "";
  originalMysqlTableCharset.value = "";
  mysqlTableCollation.value = "";
  originalMysqlTableCollation.value = "";
  physicalOptions.value = emptyTablePhysicalOptions();
  starrocksPhysicalOptions.value = emptyStarRocksPhysicalOptions();
  starrocksAlterContext.value = undefined;
  starrocksSortColumns.value = undefined;
  mysqlTableEngineOptions.value = [];
  mysqlTableEngineLoadRequestId += 1;
  mysqlTableEngineLoading.value = false;
  mysqlTableEngineLoadError.value = "";
  mysqlTableDefaultCollation.value = "";
  tableOwner.value = "";
  originalTableOwner.value = "";
  tableOwnerLoadRequestId += 1;
  tableOwnerLoading.value = false;
  tableOwnerLoadError.value = "";
  tableOwnerRoles.value = [];
  tableOwnerRolesLoadRequestId += 1;
  tableOwnerRolesLoading.value = false;
  tableOwnerRolesLoadError.value = "";
  columnSearchText.value = "";
  highlightedColumnId.value = null;
  indexSearchText.value = "";
  highlightedIndexId.value = null;
  appliedInitialTargetSearchKey = "";
  appliedInitialTargetScrollKey = "";
  initialIndexTargetError = undefined;
  localColumnOrderNoticeShown.value = false;
}

async function reloadStructureFromDatabase() {
  if (isCreateMode.value) return;
  if (oracleIndexRefreshError.value) return retryOracleIndexRefresh();
  if (needsColumnDraftMetadataHydration() || draftHydrationError.value) {
    const identity = draftTargetIdentity();
    if (await hydrateRestoredDraftFromDatabase(true)) await initializeRestoredDraftMetadata(identity);
    return;
  }
  invalidateDraftHydration();
  draftHydrated = false;
  if (activeTab.value !== "triggers") {
    triggers.value = [];
    triggersLoaded.value = false;
  }
  if (activeTab.value !== "constraints") {
    constraints.value = [];
    constraintsLoaded.value = false;
  }
  if (activeTab.value !== "partitions") {
    partitioning.value = null;
  }
  // Refreshing from the database discards every other draft; pending partition
  // operations must not survive it and still be applied on save.
  partitionOperations.value = [];
  starrocksAlterContext.value = undefined;
  starrocksSortColumns.value = undefined;
  const refreshDdl = activeTab.value === "ddl";
  const preserveOracleIndexDraft = oracleIndexRefreshGuard.value?.target === oracleIndexTargetIdentity(oracleConstraintTarget());
  const metadataMatch = { connectionId: props.connectionId, database: props.database, schema: metadataSchema.value, tableName: props.tableName };
  invalidateTableMetadataCache(metadataMatch);
  await invalidateObjectDdl(ddlRequest());
  loadedMetadataFacets.clear();
  // Reloading from the database discards drafts (triggers/constraints above do
  // the same), so an edited DDL script must not survive as a stale overlay.
  ddlDraft.value = null;
  if (refreshDdl) {
    ddlFetched.value = false;
    await Promise.all([fetchDdl(true), loadVisibleTableComment(true), loadTableOwner(true), loadTableOwnerRoles(), loadMysqlTableEngine(true)]);
    markDraftHydratedAndSync();
  } else {
    await Promise.all([loadStructure(false, visibleTableStructureRefreshScope(activeTab.value), true, { blockSecondaryMetadata: true, forceDdl: true, forceMetadata: true, preserveDraft: preserveOracleIndexDraft }), loadTableOwner(true), loadTableOwnerRoles(), loadMysqlTableEngine(true)]);
    if (preserveOracleIndexDraft) {
      markDraftHydratedAndSync();
      await refreshSqlPreview();
    }
  }
}

function setSecondaryMetadataLoading(scope: TableStructureRefreshScope, value: boolean) {
  if (scope.indexes && tableMetadataCapabilities.value.indexes) indexesLoading.value = value;
  if (scope.foreignKeys && tableMetadataCapabilities.value.foreignKeys) foreignKeysLoading.value = value;
  if (scope.constraints && tableMetadataCapabilities.value.constraints) constraintsLoading.value = value;
  if (scope.triggers && tableMetadataCapabilities.value.triggers) triggersLoading.value = value;
  if (scope.partitions && tableMetadataCapabilities.value.partitions) partitionsLoading.value = value;
}

function withRequiredPostgresPrimaryKeyMetadata(scope: TableStructureRefreshScope): TableStructureRefreshScope {
  if (isCreateMode.value || databaseType.value !== "postgres") return scope;
  const needsPrimaryKeyMetadata = scope.columns || (activeTab.value === "columns" && !loadedMetadataFacets.has("indexes"));
  return needsPrimaryKeyMetadata && !scope.indexes ? { ...scope, indexes: true } : scope;
}

async function fetchTableCommentValue(connectionId: string, database: string, schema: string, tableName: string, catalog?: string): Promise<string | undefined> {
  try {
    return (await api.getTableComment(connectionId, database, schema, tableName, catalog)) || "";
  } catch {
    try {
      const tables = await api.listTables(connectionId, database, schema, undefined, undefined, undefined, undefined, catalog);
      const table = tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase() && t.table_type !== "VIEW");
      return table ? table.comment || "" : undefined;
    } catch {
      return undefined;
    }
  }
}

function loadCachedTableComment(request: StructureDdlRequest, force = false): Promise<{ value: string | undefined; cacheStatus: "memory" | "disk" | "remote" }> {
  return loadObjectMetadataFacet(
    request,
    "comment",
    () => (request.exactIdentity ? api.getTableComment(request.connectionId, request.database, request.schema, request.tableName, request.catalog, true).then((value) => value ?? "") : fetchTableCommentValue(request.connectionId, request.database, request.schema, request.tableName, request.catalog)),
    { force },
  );
}

async function loadVisibleTableComment(force = false, preserveDraft = false) {
  const connectionId = props.connectionId;
  const database = props.database;
  const schema = metadataSchema.value;
  const tableName = props.tableName;
  const catalog = props.catalog;
  const exactIdentity = props.exactIdentity === true;
  if (!structureCapabilities.value.comment || !connectionId || !database || !tableName) return;
  if (!force && loadedMetadataFacets.has("comment")) return;
  if (!force && tableCommentLoadPromise) return tableCommentLoadPromise;

  const requestId = ++tableCommentLoadRequestId;
  const loadPromise = (async () => {
    try {
      await store.ensureConnected(connectionId);
      const revision = store.connectionStateRevision(connectionId);
      const fingerprint = store.getConfig(connectionId) ? connectionConfigFingerprint(store.getConfig(connectionId)!) : "";
      const { value } = await loadCachedTableComment({ connectionId, database, schema, tableName, catalog, queryTimeoutSecs: store.getConfig(connectionId)?.query_timeout_secs, ...(exactIdentity ? { exactIdentity: true } : {}) }, force);
      if (requestId !== tableCommentLoadRequestId) return;
      if (exactIdentity !== (props.exactIdentity === true) || revision !== store.connectionStateRevision(connectionId) || fingerprint !== (store.getConfig(connectionId) ? connectionConfigFingerprint(store.getConfig(connectionId)!) : "")) return;
      if (connectionId !== props.connectionId || database !== props.database || schema !== metadataSchema.value || tableName !== props.tableName || (catalog || "") !== (props.catalog || "")) return;
      if (value === undefined) return;
      const hasCommentDraft = tableComment.value !== originalTableComment.value;
      originalTableComment.value = value;
      if (!preserveDraft || !hasCommentDraft) tableComment.value = value;
      loadedMetadataFacets.add("comment");
    } catch (error) {
      if (requestId === tableCommentLoadRequestId) console.warn("[DBX][structure-editor:comment-metadata-failed]", error);
    }
  })();
  tableCommentLoadPromise = loadPromise;
  try {
    await loadPromise;
  } finally {
    if (tableCommentLoadPromise === loadPromise) tableCommentLoadPromise = null;
  }
}

async function loadMysqlAutoIncrementCounter(preserveDraft = false) {
  // Creation drafts own their counter; there is no server table to refresh.
  if (isCreateMode.value) return;
  const requestId = ++mysqlAutoIncrementLoadRequestId;
  if (!canEditMysqlAutoIncrement.value || !props.connectionId || !props.database || !props.tableName) {
    mysqlAutoIncrementValue.value = undefined;
    originalMysqlAutoIncrementValue.value = undefined;
    mysqlAutoIncrementLoading.value = false;
    mysqlAutoIncrementLoadError.value = "";
    return;
  }
  mysqlAutoIncrementLoading.value = true;
  mysqlAutoIncrementLoadError.value = "";
  try {
    await store.ensureConnected(props.connectionId);
    const value = await api.getMysqlTableAutoIncrement(props.connectionId, props.database, props.tableName);
    if (requestId !== mysqlAutoIncrementLoadRequestId) return;
    const server = value === null && !hasPersistedMysqlAutoIncrementColumn.value ? "" : value;
    const draft = refreshMysqlAutoIncrementCounterDraft(server, { value: mysqlAutoIncrementValue.value, originalValue: originalMysqlAutoIncrementValue.value }, preserveDraft);
    originalMysqlAutoIncrementValue.value = draft.originalValue;
    mysqlAutoIncrementValue.value = draft.value;
  } catch (error: any) {
    if (requestId !== mysqlAutoIncrementLoadRequestId) return;
    mysqlAutoIncrementLoadError.value = error?.message || String(error);
  } finally {
    if (requestId === mysqlAutoIncrementLoadRequestId) mysqlAutoIncrementLoading.value = false;
  }
}

async function loadMysqlTableEngine(preserveDraft = false) {
  const requestId = ++mysqlTableEngineLoadRequestId;
  const connectionId = props.connectionId;
  const database = props.database;
  if (!supportsMysqlEngine.value || !connectionId || !database) {
    mysqlTableEngine.value = "";
    originalMysqlTableEngine.value = "";
    mysqlTableEngineOptions.value = [];
    mysqlTableEngineLoading.value = false;
    mysqlTableEngineLoadError.value = "";
    return;
  }

  mysqlTableEngineLoading.value = true;
  mysqlTableEngineLoadError.value = "";
  try {
    await store.ensureConnected(connectionId);
    const [enginesResult, tableResult] = await Promise.all([
      api.executeQuery(connectionId, database, MYSQL_STORAGE_ENGINES_SQL, undefined, undefined, { maxRows: 100 }),
      isCreateMode.value || !props.tableName ? Promise.resolve(undefined) : api.executeQuery(connectionId, database, mysqlTableEngineSql(database, props.tableName), undefined, undefined, { maxRows: 1 }),
    ]);
    if (requestId !== mysqlTableEngineLoadRequestId) return;
    const metadata = parseMysqlTableEngineMetadata(enginesResult, tableResult);
    const draft = refreshMysqlTableEngineDraft(metadata, { value: mysqlTableEngine.value, originalValue: originalMysqlTableEngine.value }, isCreateMode.value, preserveDraft);
    const options = [...metadata.engines];
    if (draft.value && !options.some((option) => option.toLowerCase() === draft.value.toLowerCase())) options.unshift(draft.value);
    mysqlTableEngineOptions.value = options;
    mysqlTableEngine.value = draft.value;
    originalMysqlTableEngine.value = draft.originalValue;
  } catch (error: any) {
    if (requestId !== mysqlTableEngineLoadRequestId) return;
    mysqlTableEngineLoadError.value = error?.message || String(error);
  } finally {
    if (requestId === mysqlTableEngineLoadRequestId) mysqlTableEngineLoading.value = false;
  }
}

async function loadTableOwner(force = false, preserveDraft = false) {
  const connectionId = props.connectionId;
  const database = props.database;
  const schema = metadataSchema.value;
  const tableName = props.tableName;
  const catalog = props.catalog;
  if (!supportsTableOwner.value || !connectionId || !database || !schema || !tableName) return;
  const requestId = ++tableOwnerLoadRequestId;
  tableOwnerLoading.value = true;
  tableOwnerLoadError.value = "";
  try {
    await store.ensureConnected(connectionId);
    const result = await loadObjectMetadataFacet({ connectionId, database, schema, tableName, catalog, queryTimeoutSecs: store.getConfig(connectionId)?.query_timeout_secs }, "owner", () => api.getTableOwner(connectionId, database, schema, tableName), { force });
    if (requestId !== tableOwnerLoadRequestId) return;
    const owner = result.value || "";
    originalTableOwner.value = owner;
    if (!preserveDraft) tableOwner.value = owner;
    loadedMetadataFacets.add("owner");
  } catch (error: any) {
    if (requestId !== tableOwnerLoadRequestId) return;
    tableOwnerLoadError.value = error?.message || String(error);
  } finally {
    if (requestId === tableOwnerLoadRequestId) tableOwnerLoading.value = false;
  }
}

async function loadTableOwnerRoles() {
  const connectionId = props.connectionId;
  const database = props.database;
  if (!supportsTableOwner.value || !connectionId || !database) return;
  const requestId = ++tableOwnerRolesLoadRequestId;
  tableOwnerRolesLoading.value = true;
  tableOwnerRolesLoadError.value = "";
  try {
    await store.ensureConnected(connectionId);
    const result = await api.executeQuery(connectionId, database, postgresListRolesSql(), undefined, undefined, { maxRows: 5000 });
    if (requestId !== tableOwnerRolesLoadRequestId) return;
    tableOwnerRoles.value = [
      ...new Set(
        usersFromPostgresRolesResult(result)
          .map((role) => role.user)
          .filter(Boolean),
      ),
    ];
  } catch (error: any) {
    if (requestId !== tableOwnerRolesLoadRequestId) return;
    tableOwnerRoles.value = [];
    tableOwnerRolesLoadError.value = error?.message || String(error);
  } finally {
    if (requestId === tableOwnerRolesLoadRequestId) tableOwnerRolesLoading.value = false;
  }
}

async function loadStructure(
  silent = false,
  scope: TableStructureRefreshScope = visibleTableStructureRefreshScope(activeTab.value),
  showErrors = true,
  options: { blockSecondaryMetadata?: boolean; preserveDraft?: boolean; characterLengthUnitsAfterSave?: ReadonlyMap<string, string>; forceDdl?: boolean; forceMetadata?: boolean } = {},
) {
  const connectionId = props.connectionId;
  const database = props.database;
  const catalog = props.catalog;
  const schema = metadataSchema.value;
  const tableName = props.tableName;
  if (!connectionId || !database || !tableName) return;
  const oracleIndexContext = !isCreateMode.value && (databaseType.value === "oracle" || databaseType.value === "oceanbase-oracle");
  const needsOracleIndexBaseline = oracleIndexContext && scope.indexes;
  const effectiveScope = withRequiredPostgresPrimaryKeyMetadata(needsOracleIndexBaseline || (props.exactIdentity && scope.indexes) ? { ...scope, columns: true, indexes: true } : scope);
  if (oracleIndexContext && (scope.columns || scope.indexes)) invalidateOracleIndexReady();
  let loadEpoch = oracleIndexEpoch.value;
  const requestId = ++structureLoadRequestId;
  const loadTargetIdentity = oracleIndexTargetIdentity(oracleConstraintTarget());
  let loadConnectionRevision: number | undefined;
  let loadConfigFingerprint = "";
  if (!silent) loading.value = true;
  setSecondaryMetadataLoading(effectiveScope, true);
  errorMessage.value = "";
  secondaryMetadataErrors.value = {};
  partitionsError.value = "";
  let secondaryMetadataScheduled = false;
  let loadedSuccessfully = false;
  let columnsServedFromCache = false;
  let commentServedFromCache = false;
  let appliedColumnsSignature: string | undefined;
  try {
    await store.ensureConnected(connectionId);
    loadConnectionRevision = store.connectionStateRevision(connectionId);
    const loadConnection = store.getConfig(connectionId);
    loadConfigFingerprint = loadConnection ? connectionConfigFingerprint(loadConnection) : "";
    loadEpoch = oracleIndexEpoch.value;
    if (requestId !== structureLoadRequestId || loadTargetIdentity !== oracleIndexTargetIdentity(oracleConstraintTarget())) return;

    const metadataRequest = ddlRequest();
    const forceMetadata = options.forceMetadata === true || needsOracleIndexBaseline;
    const partitionStatusPromise =
      tableMetadataCapabilities.value.partitions && !isCreateMode.value
        ? api
            .getTablePartitionStatus(connectionId, database, schema, tableName)
            // No reactive mutation inside the catch: a stale request must not
            // overwrite a newer probe's result (the structureLoadRequestId
            // guard below decides). Fail closed — without a verified partition
            // status we cannot rule out a partitioned parent, so Concurrent is
            // treated as unavailable until a later reload re-runs the probe.
            .then((status) => ({ known: true, status }))
            .catch(() => ({ known: false, status: { isPartitionedParent: false, isPartition: false, isForeign: false } }))
        : Promise.resolve({ known: true, status: { isPartitionedParent: false, isPartition: false, isForeign: false } });
    const columnsLoad = effectiveScope.columns ? loadObjectMetadataFacet(metadataRequest, "columns", () => getStructureColumns(metadataRequest), { force: forceMetadata }) : undefined;
    const columnsPromise = columnsLoad
      ? columnsLoad.then((result) => {
          columnsServedFromCache = result.cacheStatus !== "remote";
          return result.value;
        })
      : Promise.resolve(undefined);
    const indexesPromise = effectiveScope.indexes
      ? tableMetadataCapabilities.value.indexes
        ? loadObjectMetadataFacet(metadataRequest, "indexes", () => api.listIndexes(connectionId, database, schema, tableName, catalog, ...(metadataRequest.exactIdentity ? ([true] as const) : [])), { force: forceMetadata }).then((result) => result.value)
        : Promise.resolve([])
      : Promise.resolve(undefined);
    const foreignKeysPromise = effectiveScope.foreignKeys
      ? tableMetadataCapabilities.value.foreignKeys
        ? loadObjectMetadataFacet(metadataRequest, "foreign-keys", () => api.listForeignKeys(connectionId, database, schema, tableName, catalog, ...(metadataRequest.exactIdentity ? ([true] as const) : [])), { force: forceMetadata }).then((result) => result.value)
        : Promise.resolve([])
      : Promise.resolve(undefined);
    const constraintsPromise = effectiveScope.constraints
      ? tableMetadataCapabilities.value.constraints
        ? loadObjectMetadataFacet(metadataRequest, "constraints", () => api.listConstraints(connectionId, database, schema, tableName, catalog, ...(metadataRequest.exactIdentity ? ([true] as const) : [])), { force: forceMetadata }).then((result) => result.value)
        : Promise.resolve([])
      : Promise.resolve(undefined);
    const triggersPromise = effectiveScope.triggers
      ? tableMetadataCapabilities.value.triggers
        ? loadObjectMetadataFacet(
            { ...metadataRequest, ...(oracleTriggerReadOptions(databaseType.value) ? { oracleTriggerContract: 1 as const } : {}) },
            "triggers",
            () => api.listTriggers(connectionId, database, schema, tableName, catalog, oracleTriggerReadOptions(databaseType.value, catalog) ?? (metadataRequest.exactIdentity || undefined)),
            {
              force: forceMetadata,
            },
          ).then((result) => result.value)
        : Promise.resolve([])
      : Promise.resolve(undefined);
    // Partition metadata is a live catalog read (not persisted), so it is
    // fetched directly rather than through the object metadata cache.
    // Create mode has no catalog entry to read; the Partitions tab edits a
    // local `PARTITION BY` declaration instead.
    const partitioningPromise = effectiveScope.partitions && !isCreateMode.value ? (tableMetadataCapabilities.value.partitions ? api.getTablePartitioning(connectionId, database, schema, tableName) : Promise.resolve(undefined)) : Promise.resolve(undefined);
    const tableCommentLoad = effectiveScope.tableComment && structureCapabilities.value.comment ? loadCachedTableComment(metadataRequest, forceMetadata) : undefined;
    const tableCommentPromise = tableCommentLoad
      ? tableCommentLoad.then((result) => {
          commentServedFromCache = result.cacheStatus !== "remote";
          return result.value;
        })
      : Promise.resolve(undefined);
    const secondaryMetadataResultsPromise = Promise.allSettled([indexesPromise, foreignKeysPromise, constraintsPromise, triggersPromise, partitioningPromise]);

    let nextColumns = await columnsPromise;
    if (!oracleIndexLoadIsCurrent(requestId, loadTargetIdentity, loadConnectionRevision, loadConfigFingerprint)) return;
    if (nextColumns) {
      if (databaseType.value === "manticoresearch" && tableMetadataCapabilities.value.ddl) {
        try {
          const { ddl } = await loadObjectDdl({ connectionId, database, schema, tableName, catalog, queryTimeoutSecs: store.getConfig(connectionId)?.query_timeout_secs }, { force: options.forceDdl });
          rawDdlContent.value = await formatStructureDdl(ddl);
          ddlFetched.value = true;
          nextColumns = applyManticoreDdlColumnExtras(nextColumns, ddl);
        } catch {
          /* ignore — Manticore column properties can still come from SHOW COLUMNS when available */
        }
      }
      if (!oracleIndexLoadIsCurrent(requestId, loadTargetIdentity, loadConnectionRevision, loadConfigFingerprint)) return;
      // Load live charset/collation metadata from the MySQL server so the column
      // editor shows the correct options for the server version.
      void loadCharsetMetadata();
      void loadMysqlTableDefaultCollation();
      const retainOracleColumns = (oracleIndexContext || props.exactIdentity) && options.preserveDraft === true && !scope.columns;
      if (!retainOracleColumns) {
        const nextColumnDrafts = createColumnDrafts(nextColumns, databaseType.value);
        const hydratedColumnDrafts = supportsCharacterLengthUnits.value && options.characterLengthUnitsAfterSave ? restoreCharacterLengthUnitsAfterSave(databaseType.value, nextColumnDrafts, options.characterLengthUnitsAfterSave) : nextColumnDrafts;
        columns.value = applyStoredLocalColumnOrder(hydratedColumnDrafts);
      }
      appliedColumnsSignature = JSON.stringify(nextColumns);
      loadedMetadataFacets.add("columns");
      if (!options.preserveDraft) clearColumnSelection();
    }

    // Loading missing index metadata must not rebase a restored column counter again.
    if (!options.preserveDraft || effectiveScope.columns) await loadMysqlAutoIncrementCounter(options.preserveDraft === true);

    const nextTableComment = await tableCommentPromise;
    if (nextTableComment !== undefined) {
      const retainCommentDraft = options.preserveDraft && tableComment.value !== originalTableComment.value;
      originalTableComment.value = nextTableComment;
      if (!retainCommentDraft) tableComment.value = nextTableComment;
      loadedMetadataFacets.add("comment");
    }
    const partitionStatus = await partitionStatusPromise;
    if (requestId === structureLoadRequestId) {
      partitionStatusKnown.value = partitionStatus.known;
      isPartitionedParent.value = partitionStatus.status.isPartitionedParent;
      isTablePartition.value = partitionStatus.status.isPartition;
      isForeignTable.value = partitionStatus.status.isForeign;
      partitionStatusResolved.value = true;
      // Availability inputs changed: fail closed while the status is unknown,
      // but preserve the user's Concurrent intent so a later successful probe
      // can regenerate the same SQL. Definitive unsupported states still clear
      // the flag. A partitioned parent or unknown status keeps Save blocked.
      normalizeConcurrentIndexDraftsForCurrentAvailability();
      if (partitionStatus.known && !partitionStatus.status.isPartitionedParent && structureCapabilities.value.indexConcurrent && structureCapabilities.value.createIndex && concurrentAvailabilityInvalidated.value) {
        concurrentAvailabilityInvalidated.value = false;
        scheduleSqlPreviewRefresh();
      }
    }
    const applySecondaryMetadata = async () => {
      const [indexesResult, foreignKeysResult, constraintsResult, triggersResult, partitioningResult] = await secondaryMetadataResultsPromise;
      if (!oracleIndexLoadIsCurrent(requestId, loadTargetIdentity, loadConnectionRevision, loadConfigFingerprint)) return;

      type SecondaryMetadataResult = { facet: ObjectMetadataFacet; result: PromiseSettledResult<unknown> };
      const secondaryResults: SecondaryMetadataResult[] = [
        { facet: "indexes", result: indexesResult },
        { facet: "foreign-keys", result: foreignKeysResult },
        { facet: "constraints", result: constraintsResult },
        { facet: "triggers", result: triggersResult },
      ];
      const failedFacets = secondaryResults.filter((entry): entry is { facet: ObjectMetadataFacet; result: PromiseRejectedResult } => entry.result.status === "rejected");
      for (const { facet, result } of failedFacets) {
        console.warn(`[DBX][structure-editor:${facet}-metadata-failed]`, result.reason);
      }
      if (showErrors && failedFacets.length > 0) {
        for (const { facet, result } of failedFacets) {
          secondaryMetadataErrors.value[facet] = result.reason?.message || String(result.reason);
        }
      }

      const nextIndexes = indexesResult.status === "fulfilled" ? indexesResult.value : undefined;
      const nextForeignKeys = foreignKeysResult.status === "fulfilled" ? foreignKeysResult.value : undefined;
      const nextConstraints = constraintsResult.status === "fulfilled" ? constraintsResult.value : undefined;
      const nextTriggers = triggersResult.status === "fulfilled" ? triggersResult.value : undefined;
      if (nextIndexes) {
        // An empty lazy load changes no draft data and should not trigger another save.
        const indexRefreshGuard = oracleIndexRefreshGuard.value;
        if (options.preserveDraft && (props.exactIdentity || indexRefreshGuard?.target === loadTargetIdentity)) {
          indexes.value = mergeOracleIndexDraftsAfterRefresh(indexes.value, nextIndexes, indexRefreshGuard?.target === loadTargetIdentity ? indexRefreshGuard.completedCreates : []);
        } else if (nextIndexes.length || indexes.value.length) {
          indexes.value = createIndexDrafts(nextIndexes);
        }
        loadedMetadataFacets.add("indexes");
      }
      if (nextForeignKeys) {
        foreignKeys.value = createForeignKeyDrafts(nextForeignKeys, databaseType.value);
        const recovery = oracleForeignKeyCreateRecovery.value;
        if (recovery?.tableExists && (databaseType.value === "oracle" || databaseType.value === "oceanbase-oracle")) {
          const pending = recovery.remaining
            .filter((definition) => !foreignKeys.value.some((foreignKey) => foreignKey.name === definition.name))
            .map((definition) => ({
              id: `oracle-create-recovery:${definition.name}`,
              name: definition.name,
              column: definition.columns[0] || "",
              refSchema: definition.refSchema,
              refTable: definition.refTable,
              refColumn: definition.refColumns[0] || "",
              columns: [...definition.columns],
              refColumns: [...definition.refColumns],
              oracleState: { ...definition.state },
              onUpdate: "NO ACTION",
              onDelete: definition.onDelete,
              markedForDrop: false,
            }));
          foreignKeys.value.push(...pending);
        }
        loadedMetadataFacets.add("foreign-keys");
      }
      if (nextConstraints) {
        constraints.value = nextConstraints;
        constraintsLoaded.value = true;
        loadedMetadataFacets.add("constraints");
      }
      if (nextTriggers) {
        triggers.value = createTriggerDrafts(nextTriggers);
        triggersLoaded.value = true;
        loadedMetadataFacets.add("triggers");
      }
      if (partitioningResult.status === "fulfilled" && partitioningResult.value !== undefined) {
        partitioning.value = partitioningResult.value;
        loadedMetadataFacets.add("partitions");
      } else if (partitioningResult.status === "rejected") {
        console.warn("[DBX][structure-editor:partitions-metadata-failed]", partitioningResult.reason);
        if (showErrors) partitionsError.value = partitioningResult.reason?.message || String(partitioningResult.reason);
        // Mark the facet loaded even on failure: the tab-activation watcher
        // only refetches unloaded facets, so leaving it unloaded would retry in
        // a loop. The toolbar Refresh clears the facet and retries explicitly.
        loadedMetadataFacets.add("partitions");
      }
    };

    secondaryMetadataScheduled = true;
    const secondaryMetadataPromise = applySecondaryMetadata()
      .catch((error) => {
        console.warn("[DBX][structure-editor:secondary-metadata-failed]", error);
      })
      .finally(() => {
        if (oracleIndexLoadIsCurrent(requestId, loadTargetIdentity, loadConnectionRevision, loadConfigFingerprint)) setSecondaryMetadataLoading(effectiveScope, false);
      });
    if (options.blockSecondaryMetadata || needsOracleIndexBaseline) {
      await secondaryMetadataPromise;
    }
    if (needsOracleIndexBaseline && !secondaryMetadataErrors.value.indexes && oracleIndexLoadIsCurrent(requestId, loadTargetIdentity, loadConnectionRevision, loadConfigFingerprint) && oracleIndexEpoch.value === loadEpoch) {
      try {
        const target = oracleConstraintTarget();
        const snapshot = await readOracleIndexSnapshot(target);
        if (oracleIndexLoadIsCurrent(requestId, loadTargetIdentity, loadConnectionRevision, loadConfigFingerprint) && oracleIndexEpoch.value === loadEpoch) {
          const loadedColumns = nextColumns ?? columns.value.flatMap((column) => (column.original ? [column.original] : []));
          if (oracleIndexSnapshotMatchesLoaded(snapshot, target, indexes.value) && oracleIndexSnapshotMatchesLoadedColumns(snapshot, loadedColumns)) {
            oracleIndexReady.value = {
              snapshot,
              epoch: loadEpoch,
              targetIdentity: loadTargetIdentity,
              requestId,
              connectionRevision: loadConnectionRevision!,
              configFingerprint: loadConfigFingerprint,
              columnsFingerprint: JSON.stringify(columns.value),
              indexesFingerprint: JSON.stringify(snapshot.indexes),
            };
            if (oracleIndexRefreshGuard.value?.target === loadTargetIdentity && requestId > oracleIndexRefreshGuard.value.afterRequestId) oracleIndexRefreshGuard.value = undefined;
          }
        }
      } catch (error) {
        if (oracleIndexLoadIsCurrent(requestId, loadTargetIdentity, loadConnectionRevision, loadConfigFingerprint)) {
          secondaryMetadataErrors.value.indexes = error instanceof Error ? error.message : String(error);
        }
      }
    }
    loadedSuccessfully = true;
    // Cache-served structure metadata can be stale when another session rebuilt
    // the table (#8816): the cache is only invalidated by in-app mutations.
    // Revalidate in the background. Manticore columns are re-derived from the
    // DDL locally, so leave those to the explicit refresh.
    const manticoreDerivesColumnsFromDdl = databaseType.value === "manticoresearch" && tableMetadataCapabilities.value.ddl;
    if (!forceMetadata && !manticoreDerivesColumnsFromDdl && (columnsServedFromCache || commentServedFromCache)) {
      void revalidateCachedStructureMetadata(requestId, { columns: columnsServedFromCache, tableComment: commentServedFromCache }, appliedColumnsSignature);
    }
  } catch (e: any) {
    if (oracleIndexLoadIsCurrent(requestId, loadTargetIdentity, loadConnectionRevision, loadConfigFingerprint)) {
      if (showErrors) {
        errorMessage.value = e?.message || String(e);
      } else {
        console.warn("[DBX][structure-editor:refresh-failed]", e);
      }
    }
    return { error: e?.message || String(e) };
  } finally {
    if (!secondaryMetadataScheduled && requestId === structureLoadRequestId) {
      setSecondaryMetadataLoading(effectiveScope, false);
    }
    if (!silent && requestId === structureLoadRequestId) loading.value = false;
    if (!options.preserveDraft && loadedSuccessfully && oracleIndexLoadIsCurrent(requestId, loadTargetIdentity, loadConnectionRevision, loadConfigFingerprint)) {
      markDraftHydratedAndSync();
    }
  }
}

/** Re-fetch structure facets that were served from the metadata cache and apply
 * them while the drafts they feed are still clean: reopening the editor after
 * another session rebuilt the table must not keep showing the old columns
 * (#8816). User edits stay untouched and remain refreshable from the toolbar. */
async function revalidateCachedStructureMetadata(loadRequestId: number, scope: { columns: boolean; tableComment: boolean }, appliedColumnsSignature: string | undefined) {
  const connectionId = props.connectionId;
  const database = props.database;
  const catalog = props.catalog;
  const schema = metadataSchema.value;
  const tableName = props.tableName;
  if (!connectionId || !database || !tableName) return;
  if (scope.columns && (databaseType.value === "oracle" || databaseType.value === "oceanbase-oracle")) invalidateOracleIndexReady();
  const revalidationId = ++structureMetadataRevalidationId;
  const exactIdentity = props.exactIdentity === true;
  const metadataRequest = { connectionId, database, schema, tableName, catalog, queryTimeoutSecs: store.getConfig(connectionId)?.query_timeout_secs, ...(exactIdentity ? { exactIdentity: true } : {}) };
  let revalidationConnectionRevision: number | undefined;
  let revalidationConfigFingerprint = "";
  const isCurrent = () =>
    revalidationId === structureMetadataRevalidationId &&
    loadRequestId === structureLoadRequestId &&
    connectionId === props.connectionId &&
    database === props.database &&
    schema === metadataSchema.value &&
    exactIdentity === (props.exactIdentity === true) &&
    tableName === props.tableName &&
    (catalog || "") === (props.catalog || "") &&
    (revalidationConnectionRevision === undefined ||
      (store.connectionStateRevision(connectionId) === revalidationConnectionRevision &&
        store.isCurrentConnectionStateRevision(connectionId, revalidationConnectionRevision) &&
        (store.getConfig(connectionId) ? connectionConfigFingerprint(store.getConfig(connectionId)!) : "") === revalidationConfigFingerprint));
  try {
    await store.ensureConnected(connectionId);
    revalidationConnectionRevision = store.connectionStateRevision(connectionId);
    const revalidationConfig = store.getConfig(connectionId);
    revalidationConfigFingerprint = revalidationConfig ? connectionConfigFingerprint(revalidationConfig) : "";
    // Force alone only clears this facet's own key; the web backend keeps its
    // own backend-columns/backend-comment entries under the same table prefix
    // and would serve them to the forced re-fetch. Drop the whole table scope
    // first, the same thing an explicit "Refresh Structure" does.
    await invalidateObjectMetadataCache({ connectionId, database, schema, tableName });
    if (!isCurrent()) return;
    const columnsPromise = scope.columns ? loadObjectMetadataFacet(metadataRequest, "columns", () => getStructureColumns(metadataRequest), { force: true }) : Promise.resolve(undefined);
    const commentPromise = scope.tableComment ? loadCachedTableComment(metadataRequest, true) : Promise.resolve(undefined);
    // allSettled so a failing comment re-fetch cannot swallow a valid columns
    // fix (and vice versa); each failure is logged on its own.
    const [columnsResult, commentResult] = await Promise.allSettled([columnsPromise, commentPromise] as const);
    // A newer load or revalidation supersedes this one.
    if (!isCurrent()) return;
    if (columnsResult.status === "rejected") console.warn("[DBX][structure-editor:columns-metadata-revalidation-failed]", columnsResult.reason);
    if (commentResult.status === "rejected") console.warn("[DBX][structure-editor:comment-metadata-revalidation-failed]", commentResult.reason);

    let applied = false;
    const nextColumns = columnsResult.status === "fulfilled" ? columnsResult.value?.value : undefined;
    if (nextColumns && !captureStructureRefreshScope().columns && JSON.stringify(nextColumns) !== appliedColumnsSignature) {
      columns.value = applyStoredLocalColumnOrder(createColumnDrafts(nextColumns, databaseType.value));
      scheduleSqlPreviewRefresh();
      applied = true;
    }
    const nextComment = commentResult.status === "fulfilled" ? commentResult.value?.value : undefined;
    if (nextComment !== undefined && tableComment.value === originalTableComment.value && nextComment !== originalTableComment.value) {
      originalTableComment.value = nextComment;
      tableComment.value = nextComment;
      applied = true;
    }
    if (applied) syncDraftToParent();
  } catch (e) {
    if (isCurrent()) console.warn("[DBX][structure-editor:metadata-revalidation-failed]", e);
  }
}

async function refreshStructureAfterSave(scope: TableStructureRefreshScope, characterLengthUnitsAfterSave: ReadonlyMap<string, string>) {
  try {
    await Promise.all([loadStructure(true, scope, false, { blockSecondaryMetadata: true, characterLengthUnitsAfterSave }), loadTableOwner(true), loadMysqlTableEngine(false)]);
  } catch (e) {
    console.warn("[DBX][structure-editor:post-save-refresh-failed]", e);
  } finally {
    postSaveRefreshing.value = false;
    if (mysqlAutoIncrementValue.value !== originalMysqlAutoIncrementValue.value) scheduleSqlPreviewRefresh();
    if (activeTab.value === "ddl") void fetchDdl(true);
  }
}

function renderedColumnRow(index: number): HTMLElement | undefined {
  return rootRef.value?.querySelector<HTMLElement>(`[data-column-row-index="${index}"]`) ?? undefined;
}

async function scrollColumnRowIntoView(index: number, block: ScrollLogicalPosition = "nearest"): Promise<HTMLElement | undefined> {
  await nextTick();
  let row = renderedColumnRow(index);
  if (!row) {
    const virtualScroller = columnsScrollerRef.value;
    if (virtualScroller && !(virtualScroller instanceof HTMLElement)) virtualScroller.scrollToItem?.(index, { align: block });
    await nextTick();
    row = renderedColumnRow(index);
  }
  row?.scrollIntoView({ block, inline: "nearest" });
  return row;
}

async function focusColumnNameInput(columnId: string) {
  const index = columns.value.findIndex((column) => column.id === columnId);
  if (index < 0) return;
  const row = await scrollColumnRowIntoView(index);
  const input = row?.querySelector<HTMLInputElement>("[data-column-name-input]");
  input?.focus();
  input?.select();
}

function columnIsSelectable(column: EditableStructureColumn): boolean {
  return !column.markedForDrop && columns.value.some((item) => item.id === column.id);
}

/**
 * Replace the whole selection state (set + active + shift anchor) atomically.
 * Header-column selection and row selection are exclusive modes, so any row
 * selection also clears the header-column keys, mirroring how
 * `setStructureColumnSelection` clears the row selection.
 */
function setColumnSelection(ids: Iterable<string>, activeId: string | null, anchorId: string | null) {
  selectedColumnIds.value = new Set(ids);
  selectedColumnId.value = activeId;
  columnSelectionAnchorId.value = anchorId;
  selectedStructureColumnKeys.value = new Set();
  structureColumnSelectionAnchorKey.value = null;
}

function clearColumnSelection() {
  setColumnSelection([], null, null);
}

function selectSingleColumn(column: EditableStructureColumn) {
  setColumnSelection([column.id], column.id, column.id);
}

/** Ctrl/Cmd-click: toggle the row in the set and move the anchor to it. */
function toggleColumnSelection(column: EditableStructureColumn) {
  const next = new Set(selectedColumnIds.value);
  if (next.has(column.id)) next.delete(column.id);
  else next.add(column.id);
  setColumnSelection(next, resolveColumnSelectionActiveId(columns.value, next, column.id), column.id);
}

/** Shift-click: select the visible range between the anchor and this row; the anchor stays put. */
function selectColumnRangeFromAnchor(column: EditableStructureColumn) {
  const anchorId = columnSelectionAnchorId.value && columns.value.some((item) => item.id === columnSelectionAnchorId.value && !item.markedForDrop) ? columnSelectionAnchorId.value : column.id;
  setColumnSelection(structureColumnSelectionRange(columns.value, anchorId, column.id), column.id, anchorId);
}

// A mouse-driven click first triggers focusin (focus moves into the row's
// inputs) before click. While a pointer selection is in flight, focusin must
// not reset an in-progress ctrl/shift multi-selection; the flag is cleared on
// click and on any mouseup as a fallback.
let columnPointerSelectionActive = false;
let columnContextMenuButton: number | null = null;
let columnContextMenuCtrlKey = false;

function onColumnRowMouseDown(event: MouseEvent) {
  columnPointerSelectionActive = true;
  if (event.button === 0) {
    columnContextMenuButton = null;
    columnContextMenuCtrlKey = false;
  } else {
    columnContextMenuButton = event.button;
    columnContextMenuCtrlKey = event.ctrlKey;
  }
}

function onColumnSelectionPointerUp() {
  columnPointerSelectionActive = false;
}

function onColumnRowClick(column: EditableStructureColumn, event: MouseEvent) {
  if (isSyntheticContextMenuClick(columnContextMenuButton, columnContextMenuCtrlKey, event.button)) {
    columnContextMenuButton = null;
    columnContextMenuCtrlKey = false;
    columnPointerSelectionActive = false;
    return;
  }
  columnContextMenuButton = null;
  columnContextMenuCtrlKey = false;
  columnPointerSelectionActive = false;
  if (!columnIsSelectable(column)) return;
  if (event.shiftKey) {
    selectColumnRangeFromAnchor(column);
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    toggleColumnSelection(column);
    return;
  }
  selectSingleColumn(column);
}

function onColumnRowActivate(column: EditableStructureColumn) {
  // focusin path (keyboard Tab into row inputs); mouse clicks are handled by onColumnRowClick.
  if (columnPointerSelectionActive) return;
  if (!columnIsSelectable(column)) return;
  selectSingleColumn(column);
}

const copySourceConnection = computed(() => store.getConfig(copySourceConnectionId.value));
function isCompatibleCopyConnection(config: ConnectionConfig): boolean {
  const sourceType = tableStructureDatabaseTypeForConnection(config);
  // Unknown JDBC dialects cannot be assumed compatible across connections.
  return config.id === props.connectionId || (!!sourceType && sourceType !== "jdbc" && sourceType === databaseType.value);
}
const copySourceConnections = computed(() => store.connections.filter(isCompatibleCopyConnection));
const copySourceCompatible = computed(() => !!copySourceConnection.value && isCompatibleCopyConnection(copySourceConnection.value));
const copySourceRootSchemaMode = computed(() => namespaceOptionsAreSchemas(copySourceConnection.value));
const copySourceHasSchema = computed(() => !copySourceRootSchemaMode.value && !connectionUsesDatabaseObjectTreeMode(copySourceConnection.value) && isSchemaAware(tableStructureDatabaseTypeForConnection(copySourceConnection.value)));
const copySourceMetadataSchema = computed(() => connectionObjectTreeQuerySchema(copySourceConnection.value, copySourceDatabase.value, copySourceSchema.value));
const copySourceTargetCatalog = computed(() => normalizedQueryTabCatalog(copySourceCatalogs.value, copySourceCatalog.value));

function resetCopySourceTables() {
  clearCopySourceTableSearchTimer();
  ++copySourceTablesRequestId;
  copySourceTablesLoading.value = false;
  copySourceTables.value = [];
  copySourceTablesOffset.value = 0;
  copySourceTablesHasMore.value = false;
  clearCopySourceTableSelection();
}

// Explicit cascade steps keep stale namespace requests from restoring old selections.
async function changeCopySourceScope(level: "connection" | "catalog" | "database" | "schema", value: string, prefill = false) {
  const requestId = ++copySourceScopeRequestId;
  resetCopySourceTables();
  copySourceTableSearch.value = "";
  copySourceError.value = "";
  copySourceScopeReady.value = false;
  copySourceScopeLoading.value = true;
  if (level === "connection") {
    copySourceConnectionId.value = value;
    copySourceCatalog.value = "";
    copySourceCatalogs.value = [];
  }
  if (level === "catalog") copySourceCatalog.value = value;
  if (level === "connection" || level === "catalog") {
    copySourceDatabase.value = "";
    copySourceDatabases.value = [];
  }
  if (level === "database") copySourceDatabase.value = value;
  if (level !== "schema") {
    copySourceSchema.value = "";
    copySourceSchemas.value = [];
  } else copySourceSchema.value = value;
  const config = copySourceConnection.value;
  const current = () => requestId === copySourceScopeRequestId && copyColumnsDialogOpen.value;
  try {
    if (!config || !isCompatibleCopyConnection(config)) return;
    await store.ensureConnected(config.id, { activate: false });
    if (!current() || !copySourceCompatible.value) return;
    if (level === "connection" && connectionIsDorisFamilyCatalogCapable(config)) {
      const catalogs = await api.listDorisCatalogs(config.id);
      if (!current()) return;
      copySourceCatalogs.value = catalogs;
      copySourceCatalog.value = selectedQueryCatalogName(catalogs, prefill ? props.catalog : undefined);
      if (!copySourceCatalog.value) return;
    }
    if (level === "connection" || level === "catalog") {
      const catalog = copySourceTargetCatalog.value;
      const databases = catalog ? await fetchCatalogNamespaceOptions(config.id, catalog, config) : await fetchNamespaceOptionsForConnection(config.id, config);
      if (!current()) return;
      copySourceDatabases.value = databases;
      const preferred = prefill ? props.database : namespaceOptionsAreSchemas(config) ? config.username : config.database;
      copySourceDatabase.value = databases.includes(preferred || "") ? preferred || "" : (databases[0] ?? "");
    }
    if (!copySourceDatabases.value.includes(copySourceDatabase.value)) return;
    if (copySourceRootSchemaMode.value) {
      // Oracle/Dameng expose their owner as the namespace immediately below a connection.
      copySourceSchema.value = copySourceDatabase.value;
    } else if (copySourceHasSchema.value && level !== "schema") {
      const database = copySourceDatabase.value;
      const schemas = await api.listSchemas(config.id, database);
      if (!current()) return;
      copySourceSchemas.value = schemaOptionsForConnection(schemas, config, database);
      const preferred = prefill ? metadataSchema.value : "";
      copySourceSchema.value = copySourceSchemas.value.includes(preferred) ? preferred : (copySourceSchemas.value[0] ?? "");
    }
    if (copySourceHasSchema.value && !copySourceSchemas.value.includes(copySourceSchema.value)) return;
    // Preserve explicit metadata scope for an unknown JDBC driver on the current connection.
    if (prefill && !copySourceRootSchemaMode.value && !copySourceHasSchema.value) copySourceSchema.value = props.schema || "";
    copySourceScopeReady.value = true;
  } catch (error: any) {
    if (current()) copySourceError.value = error?.message || String(error);
  } finally {
    if (current()) copySourceScopeLoading.value = false;
  }
  if (current() && copySourceScopeReady.value) await loadCopySourceTables();
}

function normalizedColumnSearch(value: string): string {
  return value.trim().toLowerCase();
}

const copyableSourceColumns = computed(() => {
  const databaseInfo = connection.value?.database_info;
  const existingNames = new Set(columns.value.filter((column) => !column.markedForDrop).map((column) => tableStructureIdentifierComparisonKey(column.name, databaseType.value, databaseInfo)));
  return copySourceColumns.value.map((column) => ({
    column,
    details: copySourceColumnDetails(column, databaseType.value),
    alreadyExists: existingNames.has(tableStructureIdentifierComparisonKey(column.name, databaseType.value, databaseInfo)),
  }));
});

const filteredCopyableSourceColumns = computed(() => {
  if (!normalizedColumnSearch(copySourceColumnSearch.value)) return copyableSourceColumns.value;
  return copyableSourceColumns.value.filter(({ column }) => matchesCopySourceColumnSearch(column, copySourceColumnSearch.value, databaseType.value));
});

const copyableSourceColumnNames = computed(() => copyableSourceColumns.value.filter(({ alreadyExists }) => !alreadyExists).map(({ column }) => column.name));
const selectedCopySourceColumns = computed(() => {
  const selected = new Set(selectedCopySourceColumnNames.value);
  return copyableSourceColumns.value.filter(({ column, alreadyExists }) => !alreadyExists && selected.has(column.name)).map(({ column }) => column);
});
const allCopyableSourceColumnsSelected = computed(() => copyableSourceColumnNames.value.length > 0 && copyableSourceColumnNames.value.every((name) => selectedCopySourceColumnNames.value.includes(name)));
const copySourceTablesHasPreviousPage = computed(() => copySourceTablesOffset.value > 0);

function clearCopySourceTableSearchTimer() {
  if (copySourceTableSearchTimer === undefined) return;
  clearTimeout(copySourceTableSearchTimer);
  copySourceTableSearchTimer = undefined;
}

function isCopySourceTable(table: TableInfo): boolean {
  const databaseInfo = connection.value?.database_info;
  const sameNamespace =
    copySourceConnectionId.value === props.connectionId && copySourceDatabase.value === props.database && copySourceMetadataSchema.value === metadataSchema.value && (copySourceTargetCatalog.value || "") === (normalizedQueryTabCatalog(copySourceCatalogs.value, props.catalog || "") || "");
  return isCreateMode.value || !sameNamespace || tableStructureIdentifierComparisonKey(table.name, databaseType.value, databaseInfo) !== tableStructureIdentifierComparisonKey(props.tableName, databaseType.value, databaseInfo);
}

function clearCopySourceTableSelection() {
  copySourceTableName.value = "";
  copySourceColumns.value = [];
  copySourceColumnSearch.value = "";
  selectedCopySourceColumnNames.value = [];
  copySourceColumnsRequestId++;
  copySourceColumnsLoading.value = false;
}

async function loadCopySourceTables(offset = 0) {
  if (!copyColumnsDialogOpen.value || !copySourceScopeReady.value || !copySourceCompatible.value || copySourceScopeLoading.value) return;
  clearCopySourceTableSelection();
  const requestId = ++copySourceTablesRequestId;
  copySourceTablesLoading.value = true;
  copySourceError.value = "";
  try {
    const tables = await api.listTables(copySourceConnectionId.value, copySourceDatabase.value, copySourceMetadataSchema.value, copySourceTableSearch.value.trim() || undefined, COPY_SOURCE_TABLE_PAGE_PROBE_SIZE, offset, ["TABLE"], copySourceTargetCatalog.value);
    if (requestId !== copySourceTablesRequestId) return;
    copySourceTables.value = tables.slice(0, COPY_SOURCE_TABLE_PAGE_SIZE).filter(isCopySourceTable);
    copySourceTablesOffset.value = offset;
    // The current table is excluded locally. Probe the next two rows so its
    // presence immediately after a full page does not create an empty next page.
    copySourceTablesHasMore.value = tables.slice(COPY_SOURCE_TABLE_PAGE_SIZE).some(isCopySourceTable);
  } catch (error: any) {
    if (requestId !== copySourceTablesRequestId) return;
    copySourceTables.value = [];
    copySourceTablesHasMore.value = false;
    copySourceError.value = error?.message || String(error);
  } finally {
    if (requestId === copySourceTablesRequestId) copySourceTablesLoading.value = false;
  }
}

function updateCopySourceTableSearch(value: string | number) {
  copySourceTableSearch.value = String(value);
  // Invalidate any in-flight load and restart the debounce, but keep the
  // current list visible until the new results land to avoid a blank flicker.
  clearCopySourceTableSearchTimer();
  ++copySourceTablesRequestId;
  copySourceTableSearchTimer = setTimeout(() => {
    copySourceTableSearchTimer = undefined;
    void loadCopySourceTables();
  }, COPY_SOURCE_TABLE_SEARCH_DEBOUNCE_MS);
}

watch(
  copyColumnsDialogOpen,
  (open) => {
    if (open) return;
    ++copySourceScopeRequestId;
    copySourceScopeReady.value = false;
    copySourceScopeLoading.value = false;
    resetCopySourceTables();
  },
  { flush: "sync" },
);

watch(
  () => [props.connectionId, props.database, props.schema, props.catalog, props.tableName],
  () => {
    copyColumnsDialogOpen.value = false;
  },
  { flush: "sync" },
);

async function openCopyColumnsDialog() {
  if (!canAddColumn.value || !props.connectionId || !props.database) return;
  copyColumnsDialogOpen.value = true;
  await changeCopySourceScope("connection", props.connectionId, true);
}

async function loadCopySourceColumns(tableName: string) {
  if (!copySourceScopeReady.value || !copySourceCompatible.value || copySourceScopeLoading.value || copySourceTablesLoading.value) return;
  clearCopySourceTableSelection();
  copySourceTableName.value = tableName;
  copySourceError.value = "";
  if (!tableName) return;
  const requestId = ++copySourceColumnsRequestId;
  copySourceColumnsLoading.value = true;
  try {
    const sourceColumns = await api.getColumns(copySourceConnectionId.value, copySourceDatabase.value, copySourceMetadataSchema.value, tableName, copySourceTargetCatalog.value);
    if (requestId !== copySourceColumnsRequestId) return;
    copySourceColumns.value = sourceColumns;
    selectedCopySourceColumnNames.value = copyableSourceColumns.value.filter(({ alreadyExists }) => !alreadyExists).map(({ column }) => column.name);
  } catch (error: any) {
    if (requestId !== copySourceColumnsRequestId) return;
    copySourceError.value = error?.message || String(error);
  } finally {
    if (requestId === copySourceColumnsRequestId) copySourceColumnsLoading.value = false;
  }
}

function toggleCopySourceColumns() {
  selectedCopySourceColumnNames.value = allCopyableSourceColumnsSelected.value ? [] : [...copyableSourceColumnNames.value];
}

function applyPastedColumns(text: string) {
  if (!pasteColumnsDialogOpen.value || !canPasteColumns.value || activeTab.value !== "columns") return;
  // Revalidate at commit time, including names of drop-marked columns. Import
  // must never implicitly replace a field or use a stale dialog preview.
  const result = parseTableColumnDefinitions(
    text,
    columns.value.map((column) => column.name),
  );
  if (result.diagnostics.length || !result.columns.length) return;
  const drafts = createPastedColumnDrafts(result.columns, uuid);
  columns.value.splice(resolveInsertColumnIndex(columns.value, selectedColumnId.value), 0, ...drafts);
  selectSingleColumn(drafts[drafts.length - 1]);
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder(false);
  pasteColumnsDialogOpen.value = false;
}

function applyCopiedColumns() {
  if (!canAddColumn.value || !copySourceCompatible.value || !copySourceScopeReady.value || copySourceScopeLoading.value || copySourceTablesLoading.value || copySourceColumnsLoading.value || copySourceError.value) return;
  const names = new Set(columns.value.filter((column) => !column.markedForDrop).map((column) => tableStructureIdentifierComparisonKey(column.name, databaseType.value, connection.value?.database_info)));
  const sourceColumns = selectedCopySourceColumns.value.filter((column) => {
    const key = tableStructureIdentifierComparisonKey(column.name, databaseType.value, connection.value?.database_info);
    if (names.has(key)) return false;
    names.add(key);
    return true;
  });
  const copiedColumns = createCopiedColumnDrafts(sourceColumns, databaseType.value, uuid);
  if (!copiedColumns.length) return;
  const insertAt = resolveInsertColumnIndex(columns.value, selectedColumnId.value);
  columns.value.splice(insertAt, 0, ...copiedColumns);
  const lastCopiedColumn = copiedColumns[copiedColumns.length - 1];
  if (lastCopiedColumn) selectSingleColumn(lastCopiedColumn);
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder(false);
  copyColumnsDialogOpen.value = false;
}

async function copyColumn(column: EditableStructureColumn) {
  if (!canAddColumn.value || column.markedForDrop) return;
  const sourceIndex = columns.value.findIndex((item) => item.id === column.id);
  if (sourceIndex < 0) return;
  const copiedColumn = cloneColumnDraftAsNew(column, uuid);
  columns.value.splice(sourceIndex + 1, 0, copiedColumn);
  selectSingleColumn(copiedColumn);
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder(false);
  await focusColumnNameInput(copiedColumn.id);
}

async function addColumn(afterColumn?: EditableStructureColumn) {
  if (!canAddColumn.value) return;
  activeTab.value = "columns";
  const dataType = defaultNewColumnDataType(databaseType.value, dataTypeOptions.value);
  const column: EditableStructureColumn = {
    id: `new:${uuid()}`,
    name: "",
    dataType,
    enumValues: [],
    isNullable: true,
    defaultValue: "",
    comment: "",
    isPrimaryKey: false,
    characterSet: "",
    collation: "",
    extra: {},
    markedForDrop: false,
  };
  const sourceIndex = afterColumn ? columns.value.findIndex((item) => item.id === afterColumn.id) : -1;
  const insertAt = sourceIndex >= 0 ? sourceIndex + 1 : resolveInsertColumnIndex(columns.value, selectedColumnId.value);
  columns.value.splice(insertAt, 0, column);
  selectSingleColumn(column);
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder(false);
  await focusColumnNameInput(column.id);
}

function applyColumnTemplate(templateId: string) {
  if (!canAddColumn.value) return;
  activeTab.value = "columns";
  const templateColumns = createTableColumnTemplateDrafts({
    templateId,
    databaseType: databaseType.value,
    columnNames: settingsStore.editorSettings.tableColumnTemplateFields,
    existingColumnNames: columns.value.map((column) => column.name),
    createId: uuid,
  });
  if (!templateColumns.length) return;
  if (isCreatingForeignTable.value) {
    for (const column of templateColumns) {
      column.isPrimaryKey = false;
      column.extra.autoIncrement = false;
      column.extra.identity = undefined;
    }
  }
  const insertAt = resolveInsertColumnIndex(columns.value, selectedColumnId.value);
  columns.value.splice(insertAt, 0, ...templateColumns);
  const lastTemplateColumn = templateColumns[templateColumns.length - 1];
  if (lastTemplateColumn) selectSingleColumn(lastTemplateColumn);
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder(false);
}

function removeNewColumn(column: EditableStructureColumn) {
  columns.value = columns.value.filter((item) => item.id !== column.id);
  if (selectedColumnIds.value.has(column.id)) {
    const next = new Set(selectedColumnIds.value);
    next.delete(column.id);
    selectedColumnIds.value = next;
  }
  if (selectedColumnId.value === column.id) selectedColumnId.value = null;
  if (columnSelectionAnchorId.value === column.id) columnSelectionAnchorId.value = null;
}

type ColumnDragState = {
  columnId: string;
  sourceIndex: number;
  insertionIndex: number | null;
};

const columnDragState = ref<ColumnDragState | null>(null);
const localColumnOrderNoticeShown = ref(false);
let columnDragPreviousBodyUserSelect = "";
let columnDragPreviousBodyCursor = "";
let columnDragTracking = false;

function canDragColumn(index: number): boolean {
  if (loading.value || saving.value) return false;
  if (!Number.isInteger(index) || index < 0 || index >= columns.value.length) return false;
  const column = columns.value[index];
  if (!column || column.markedForDrop) return false;
  return canShowColumnDragControls.value;
}

function canDropColumnAt(sourceIndex: number, insertionIndex: number): boolean {
  if (!canDragColumn(sourceIndex)) return false;
  if (!Number.isInteger(insertionIndex) || insertionIndex < 0 || insertionIndex > columns.value.length) return false;
  if (insertionIndex === sourceIndex || insertionIndex === sourceIndex + 1) return false;
  const sourceColumn = columns.value[sourceIndex];
  if (!sourceColumn) return false;
  const crossedColumns = insertionIndex < sourceIndex ? columns.value.slice(insertionIndex, sourceIndex) : columns.value.slice(sourceIndex + 1, insertionIndex);
  if (crossedColumns.some((column) => column.markedForDrop)) return false;
  if (!isCreateMode.value && databaseType.value === "starrocks" && structureCapabilities.value.reorderColumn) {
    const reordered = [...columns.value];
    reordered.splice(sourceIndex, 1);
    reordered.splice(insertionIndex > sourceIndex ? insertionIndex - 1 : insertionIndex, 0, sourceColumn);
    const keys = new Set(starrocksAlterContext.value?.keyColumns.map((name) => name.toLowerCase()) ?? []);
    let sawValue = false;
    for (const column of reordered) {
      if (column.markedForDrop) continue;
      if (keys.has(column.original?.name.toLowerCase() ?? "")) {
        if (sawValue) return false;
      } else {
        sawValue = true;
      }
    }
  }
  if (canShowColumnDragControls.value) return true;
  if (sourceColumn.original) return false;
  return crossedColumns.every((column) => !column.original);
}

const usesLocalTableColumnOrder = computed(() => !isCreateMode.value && (databaseType.value === "starrocks" ? !!starrocksAlterContext.value?.model && starrocksAlterContext.value.model !== "duplicate" : supportsLocalTableColumnReorder(databaseType.value, connection.value?.db_type)));
const canShowColumnDragControls = computed(() => isCreateMode.value || structureCapabilities.value.reorderColumn || usesLocalTableColumnOrder.value);

function localTableColumnOrderScopeKey(): string {
  return tableDataGridColumnOrderScopeKey({
    connectionId: props.connectionId,
    database: props.database,
    schema: props.schema,
    tableName: props.tableName,
  });
}

function localColumnOrderKeys(items: readonly EditableStructureColumn[]): string[] {
  return uniqueDataGridColumnOrderKeys(items.map((column) => column.name));
}

const hasLocalColumnOrderChange = computed(() => {
  if (!usesLocalTableColumnOrder.value) return false;
  return hasLocalTableColumnOrderChange(columns.value);
});

function applyStoredLocalColumnOrder(items: EditableStructureColumn[]): EditableStructureColumn[] {
  if (!usesLocalTableColumnOrder.value) return items;
  const orderedKeys = loadTableDataGridColumnOrder(localTableColumnOrderScopeKey());
  if (!orderedKeys.length) return items;
  const columnKeys = uniqueDataGridColumnOrderKeys(items.map((column) => column.name));
  const indexes = orderedColumnIndexes({
    availableIndexes: items.map((_, index) => index),
    columnKeys,
    orderedKeys,
  });
  return indexes.map((index) => items[index]).filter((column): column is EditableStructureColumn => !!column);
}

function persistLocalColumnOrder(showNotice = true) {
  if (!usesLocalTableColumnOrder.value) return;
  const scopeKey = localTableColumnOrderScopeKey();
  if (hasLocalColumnOrderChange.value) {
    saveTableDataGridColumnOrder(scopeKey, localColumnOrderKeys(columns.value));
  } else {
    removeTableDataGridColumnOrder(scopeKey);
  }
  notifyTableDataGridColumnOrderChanged(scopeKey);
  if (!showNotice || localColumnOrderNoticeShown.value) return;
  localColumnOrderNoticeShown.value = true;
  toast(t("structureEditor.localColumnOrderNotice"), 4000);
}

function isSqlServerIdentityChecked(column: EditableStructureColumn): boolean {
  return !!column.extra.autoIncrement || !!column.extra.identity;
}

function canEditSqlServerIdentity(column: EditableStructureColumn): boolean {
  return !column.original && !column.markedForDrop && isSqlServerIdentityCompatibleDataType(column.dataType);
}

function clearSqlServerIdentity(column: EditableStructureColumn) {
  column.extra.autoIncrement = false;
  column.extra.identity = undefined;
}

function syncSqlServerIdentityForDataType(column: EditableStructureColumn) {
  if (databaseType.value !== "sqlserver") return;
  if (!isSqlServerIdentityChecked(column)) return;
  if (isSqlServerIdentityCompatibleDataType(column.dataType)) return;
  clearSqlServerIdentity(column);
}

function ensureSqlServerIdentity(column: EditableStructureColumn) {
  column.extra.autoIncrement = true;
  column.extra.identity = {
    seed: column.extra.identity?.seed ?? 1,
    increment: column.extra.identity?.increment ?? 1,
  };
}

function setSqlServerIdentity(column: EditableStructureColumn, checked: boolean) {
  if (!canEditSqlServerIdentity(column)) return;
  if (checked) {
    ensureSqlServerIdentity(column);
    column.isNullable = false;
  } else {
    clearSqlServerIdentity(column);
  }
}

function parseOptionalNumberInput(value: string | number): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function updateSqlServerIdentitySeed(column: EditableStructureColumn, value: string | number) {
  if (!canEditSqlServerIdentity(column)) return;
  ensureSqlServerIdentity(column);
  column.extra.identity!.seed = parseOptionalNumberInput(value);
}

function updateSqlServerIdentityIncrement(column: EditableStructureColumn, value: string | number) {
  if (!canEditSqlServerIdentity(column)) return;
  ensureSqlServerIdentity(column);
  column.extra.identity!.increment = parseOptionalNumberInput(value);
}

function isDamengIdentityChecked(column: EditableStructureColumn): boolean {
  return !!column.extra.autoIncrement || !!column.extra.identity;
}

function originalHasDamengIdentity(column: EditableStructureColumn): boolean {
  return column.original?.extra?.toLowerCase().includes("identity") ?? false;
}

function canEditDamengIdentity(column: EditableStructureColumn): boolean {
  if (column.markedForDrop || !isDamengIdentityCompatibleDataType(column.dataType)) return false;
  // DM8 permits only one identity column per table, so prevent creating an invalid draft in the editor.
  return isDamengIdentityChecked(column) || !columns.value.some((candidate) => candidate !== column && !candidate.markedForDrop && isDamengIdentityChecked(candidate));
}

function canEditDamengIdentityParameters(column: EditableStructureColumn): boolean {
  return canEditDamengIdentity(column) && !originalHasDamengIdentity(column);
}

function clearDamengIdentity(column: EditableStructureColumn) {
  column.extra.autoIncrement = false;
  column.extra.identity = undefined;
}

function syncDamengIdentityForDataType(column: EditableStructureColumn) {
  if (databaseType.value !== "dameng") return;
  if (!isDamengIdentityChecked(column)) return;
  if (isDamengIdentityCompatibleDataType(column.dataType)) return;
  clearDamengIdentity(column);
}

function ensureDamengIdentity(column: EditableStructureColumn) {
  const originalIdentity = parseExtraToColumnExtra(column.original?.extra, "dameng").identity;
  column.extra.autoIncrement = true;
  column.extra.identity = {
    seed: column.extra.identity?.seed ?? originalIdentity?.seed ?? 1,
    increment: column.extra.identity?.increment ?? originalIdentity?.increment ?? 1,
  };
}

function setDamengIdentity(column: EditableStructureColumn, checked: boolean) {
  if (!canEditDamengIdentity(column)) return;
  if (checked) {
    ensureDamengIdentity(column);
    column.isNullable = false;
  } else {
    clearDamengIdentity(column);
  }
}

function updateDamengIdentitySeed(column: EditableStructureColumn, value: string | number) {
  if (!canEditDamengIdentityParameters(column)) return;
  ensureDamengIdentity(column);
  column.extra.identity!.seed = parseOptionalNumberInput(value);
}

function updateDamengIdentityIncrement(column: EditableStructureColumn, value: string | number) {
  if (!canEditDamengIdentityParameters(column)) return;
  ensureDamengIdentity(column);
  column.extra.identity!.increment = parseOptionalNumberInput(value);
}

function updateColumnDataType(column: EditableStructureColumn, baseType: string) {
  if (isMysqlEnumDataType(databaseType.value, baseType)) {
    if (!column.enumValues?.length) column.enumValues = [""];
    column.dataType = mysqlEnumDataType(column.enumValues);
  } else {
    column.dataType = combineDataTypeForDatabase(databaseType.value, baseType, getDefaultLengthForType(databaseType.value, baseType, { omitMysqlDeprecatedDefaults: usesMysql8SafeDefaults.value }));
  }
  syncSqlServerIdentityForDataType(column);
  syncDamengIdentityForDataType(column);
  // Clear charset/collation when switching to a non-character MySQL type
  if (showCharacterSet.value && !isMysqlCharacterDataType(column.dataType)) {
    column.characterSet = "";
    column.collation = "";
  }
}

function updateMysqlEnumValue(column: EditableStructureColumn, index: number, value: string | number) {
  if (!column.enumValues || index < 0 || index >= column.enumValues.length) return;
  column.enumValues[index] = String(value);
  column.dataType = mysqlEnumDataType(column.enumValues);
}

function addMysqlEnumValue(column: EditableStructureColumn) {
  column.enumValues ??= [];
  column.enumValues.push("");
  column.dataType = mysqlEnumDataType(column.enumValues);
}

function removeMysqlEnumValue(column: EditableStructureColumn, index: number) {
  if (!column.enumValues || column.enumValues.length <= 1) return;
  column.enumValues.splice(index, 1);
  column.dataType = mysqlEnumDataType(column.enumValues);
}

function updateColumnDataTypeLength(column: EditableStructureColumn, value: string | number) {
  const baseType = dataTypeBaseInputValue(databaseType.value, column.dataType);
  column.dataType = combineDataTypeForDatabaseWithLengthUnit(databaseType.value, baseType, String(value), dataTypeLengthUnitValue(databaseType.value, column.dataType));
  syncSqlServerIdentityForDataType(column);
  syncDamengIdentityForDataType(column);
}

function updatePostgresGeometryColumn(column: EditableStructureColumn, geomType: string, srid: string) {
  const baseType = dataTypeBaseInputValue(databaseType.value, column.dataType);
  column.dataType = combinePostgresGeometryType(baseType, geomType, srid);
}

function updateColumnDataTypeLengthUnit(column: EditableStructureColumn, value: unknown) {
  const baseType = dataTypeBaseInputValue(databaseType.value, column.dataType);
  const unit = value === "__default" ? "" : String(value ?? "");
  column.dataType = combineDataTypeForDatabaseWithLengthUnit(databaseType.value, baseType, dataTypeLengthInputValue(databaseType.value, column.dataType), unit);
  syncSqlServerIdentityForDataType(column);
  syncDamengIdentityForDataType(column);
}

function moveColumnTo(index: number, insertionIndex: number) {
  if (!canDropColumnAt(index, insertionIndex)) return;
  const nextColumns = [...columns.value];
  const [column] = nextColumns.splice(index, 1);
  if (!column) return;
  const adjustedInsertionIndex = insertionIndex > index ? insertionIndex - 1 : insertionIndex;
  nextColumns.splice(adjustedInsertionIndex, 0, column);
  columns.value = nextColumns;
  persistLocalColumnOrder();
}

function onColumnDragPointerDown(index: number, event: PointerEvent) {
  if (event.button !== 0 || !canDragColumn(index)) return;
  const column = columns.value[index];
  if (!column) return;
  event.preventDefault();
  event.stopPropagation();
  columnDragState.value = {
    columnId: column.id,
    sourceIndex: index,
    insertionIndex: null,
  };
  columnDragPreviousBodyUserSelect = document.body.style.userSelect;
  columnDragPreviousBodyCursor = document.body.style.cursor;
  columnDragTracking = true;
  document.body.style.userSelect = "none";
  document.body.style.cursor = "grabbing";
  updateColumnDragInsertion(event.clientY);
  window.addEventListener("pointermove", onColumnDragPointerMove, true);
  window.addEventListener("pointerup", onColumnDragPointerUp, true);
  window.addEventListener("pointercancel", onColumnDragPointerCancel, true);
}

function onColumnDragPointerMove(event: PointerEvent) {
  if (!columnDragState.value) return;
  event.preventDefault();
  updateColumnDragInsertion(event.clientY);
}

function onColumnDragPointerUp(event: PointerEvent) {
  event.preventDefault();
  const state = columnDragState.value;
  stopColumnDragTracking();
  if (state && state.insertionIndex !== null && canDropColumnAt(state.sourceIndex, state.insertionIndex)) {
    moveColumnTo(state.sourceIndex, state.insertionIndex);
  }
  columnDragState.value = null;
}

function onColumnDragPointerCancel() {
  stopColumnDragTracking();
  columnDragState.value = null;
}

function stopColumnDragTracking() {
  if (!columnDragTracking) return;
  columnDragTracking = false;
  window.removeEventListener("pointermove", onColumnDragPointerMove, true);
  window.removeEventListener("pointerup", onColumnDragPointerUp, true);
  window.removeEventListener("pointercancel", onColumnDragPointerCancel, true);
  document.body.style.userSelect = columnDragPreviousBodyUserSelect;
  document.body.style.cursor = columnDragPreviousBodyCursor;
}

function updateColumnDragInsertion(clientY: number) {
  const state = columnDragState.value;
  if (!state) return;
  const insertionIndex = columnDragInsertionIndexFromPoint(clientY);
  state.insertionIndex = insertionIndex !== null && canDropColumnAt(state.sourceIndex, insertionIndex) ? insertionIndex : null;
}

function columnDragInsertionIndexFromPoint(clientY: number): number | null {
  const rows = Array.from(rootRef.value?.querySelectorAll<HTMLElement>("[data-column-row-index]") ?? []);
  if (!rows.length) return null;
  const firstRect = rows[0].getBoundingClientRect();
  const firstIndex = Number(rows[0].dataset.columnRowIndex);
  if (clientY < firstRect.top) return Number.isInteger(firstIndex) ? firstIndex : 0;
  for (const row of rows) {
    const rowIndex = Number(row.dataset.columnRowIndex);
    if (!Number.isInteger(rowIndex)) continue;
    const rect = row.getBoundingClientRect();
    if (clientY <= rect.bottom) {
      return clientY > rect.top + rect.height / 2 ? rowIndex + 1 : rowIndex;
    }
  }
  const lastIndex = Number(rows[rows.length - 1]?.dataset.columnRowIndex);
  return Number.isInteger(lastIndex) ? lastIndex + 1 : rows.length;
}

function onColumnDragStart(index: number, event: DragEvent) {
  if (!canDragColumn(index)) {
    event.preventDefault();
    return;
  }
  const column = columns.value[index];
  if (!column) return;
  columnDragState.value = {
    columnId: column.id,
    sourceIndex: index,
    insertionIndex: null,
  };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", column.name || column.id);
  }
}

function onColumnDragOver(index: number, event: DragEvent) {
  const state = columnDragState.value;
  if (!state || columns.value[index]?.markedForDrop) return;
  const insertionIndex = columnDragInsertionIndex(index, event);
  if (!canDropColumnAt(state.sourceIndex, insertionIndex)) return;
  event.preventDefault();
  state.insertionIndex = insertionIndex;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function onColumnDrop(index: number, event: DragEvent) {
  const state = columnDragState.value;
  if (!state) return;
  event.preventDefault();
  moveColumnTo(state.sourceIndex, columnDragInsertionIndex(index, event));
  columnDragState.value = null;
}

function onColumnDragEnd() {
  columnDragState.value = null;
}

function columnRowClass(column: EditableStructureColumn, index: number) {
  const dragState = columnDragState.value;
  const isSearchMatch = filteredColumnRowIds.value.has(column.id);
  const isSelected = selectedColumnIds.value.has(column.id) && !column.markedForDrop;
  const kind = columnIndexKind(column);
  return {
    "bg-destructive/5 opacity-60": column.markedForDrop,
    "structure-column-primary-key": kind === "primary",
    "structure-column-unique-key": kind === "unique",
    "structure-column-index-key": kind === "index",
    "structure-column-fulltext-key": kind === "fulltext",
    "structure-column-spatial-key": kind === "spatial",
    "structure-column-search-match": isSearchMatch,
    // Reuse the existing search-current highlight for the active/selected row.
    "structure-column-search-current": highlightedColumnId.value === column.id || isSelected,
    "opacity-55": dragState?.columnId === column.id,
    "bg-primary/5": dragState && (dragState.insertionIndex === index || dragState.insertionIndex === index + 1),
    "[&>td]:border-t-2 [&>td]:border-t-primary": dragState?.insertionIndex === index,
    "[&>td]:border-b-2 [&>td]:border-b-primary": dragState?.insertionIndex === index + 1,
  };
}

function columnMatchesSearch(column: EditableStructureColumn): boolean {
  const query = columnSearchText.value.trim().toLowerCase();
  if (!query) return false;
  return [column.name, column.comment].some((value) => columnFieldMatchesSearch(value));
}

function columnFieldMatchesSearch(value: string | null | undefined): boolean {
  const query = columnSearchText.value.trim().toLowerCase();
  return !!query && matchesIdentifierSearch(String(value ?? ""), query);
}

function columnSearchFieldClass(column: EditableStructureColumn, value: string | null | undefined) {
  const matches = columnFieldMatchesSearch(value);
  return {
    "!border-primary/60 !bg-primary/10": matches,
    "!border-primary !ring-2 !ring-primary/30": matches && highlightedColumnId.value === column.id,
  };
}

function focusColumnSearch() {
  activeTab.value = "columns";
  void nextTick(() => {
    const input = columnSearchInputRef.value?.$el as HTMLInputElement | undefined;
    input?.focus();
    input?.select();
  });
}

function scrollToColumnSearchMatch(direction: 1 | -1 = 1) {
  const query = columnSearchText.value.trim();
  if (!query) {
    focusColumnSearch();
    return;
  }
  const matches = columns.value.map((column, index) => ({ column, index })).filter(({ column }) => columnMatchesSearch(column));
  if (!matches.length) return;
  const currentIndex = highlightedColumnId.value ? matches.findIndex(({ column }) => column.id === highlightedColumnId.value) : -1;
  const nextMatch = matches[(currentIndex + direction + matches.length) % matches.length] ?? matches[0];
  highlightedColumnId.value = nextMatch.column.id;
  void scrollColumnRowIntoView(nextMatch.index, "center");
  if (columnHighlightTimer) window.clearTimeout(columnHighlightTimer);
  columnHighlightTimer = window.setTimeout(() => {
    highlightedColumnId.value = null;
  }, 1800);
}

function onColumnSearchKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  scrollToColumnSearchMatch(event.shiftKey ? -1 : 1);
}

function indexMatchesSearch(index: EditableStructureIndex, searchQuery = indexSearchText.value.trim().toLowerCase()): boolean {
  if (!searchQuery) return false;
  return [index.name, toColumnNames(index.columns), index.includedColumns.join(", "), index.indexType, index.filter, index.comment].some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(searchQuery),
  );
}

function indexFieldMatchesSearch(value: string | null | undefined): boolean {
  const query = indexSearchText.value.trim().toLowerCase();
  return (
    !!query &&
    String(value ?? "")
      .toLowerCase()
      .includes(query)
  );
}

function indexRowClass(index: EditableStructureIndex) {
  const isSearchMatch = filteredIndexRowIds.value.has(index.id);
  const kind = structureIndexKind(index);
  return {
    "bg-destructive/5 opacity-60": index.markedForDrop,
    "structure-index-primary-key": kind === "primary",
    "structure-index-unique-key": kind === "unique",
    "structure-index-normal-key": kind === "index",
    "structure-index-fulltext-key": kind === "fulltext",
    "structure-index-spatial-key": kind === "spatial",
    "structure-column-search-match": isSearchMatch,
    "structure-column-search-current": highlightedIndexId.value === index.id,
  };
}

function indexSearchFieldClass(index: EditableStructureIndex, value: string | null | undefined) {
  const matches = indexFieldMatchesSearch(value);
  return {
    "!border-primary/60 !bg-primary/10": matches,
    "!border-primary !ring-2 !ring-primary/30": matches && highlightedIndexId.value === index.id,
  };
}

function focusIndexSearch() {
  activeTab.value = "indexes";
  void nextTick(() => {
    const input = indexSearchInputRef.value?.$el as HTMLInputElement | undefined;
    input?.focus();
    input?.select();
  });
}

function focusSearch(): boolean {
  if (activeTab.value === "columns") {
    focusColumnSearch();
    return true;
  }
  if (activeTab.value === "indexes") {
    focusIndexSearch();
    return true;
  }
  if (activeTab.value === "ddl") {
    ddlSearchPanelRef.value?.openSearch();
    return true;
  }
  return false;
}

function scrollToIndexSearchMatch(direction: 1 | -1 = 1) {
  const query = indexSearchText.value.trim();
  if (!query) {
    focusIndexSearch();
    return;
  }
  const rows = Array.from(rootRef.value?.querySelectorAll<HTMLElement>("[data-index-row-index]") ?? []);
  // DOM rows render in displayedIndexes order, which differs from indexes.value
  // once the column-list sort is active.
  const matches = displayedIndexes.value.map((index, rowIndex) => ({ index, rowIndex })).filter(({ index }) => indexMatchesSearch(index));
  if (!matches.length) return;
  const currentIndex = highlightedIndexId.value ? matches.findIndex(({ index }) => index.id === highlightedIndexId.value) : -1;
  const nextMatch = matches[(currentIndex + direction + matches.length) % matches.length] ?? matches[0];
  highlightedIndexId.value = nextMatch.index.id;
  rows[nextMatch.rowIndex]?.scrollIntoView({ block: "center", inline: "nearest" });
  if (indexHighlightTimer) window.clearTimeout(indexHighlightTimer);
  indexHighlightTimer = window.setTimeout(() => {
    highlightedIndexId.value = null;
  }, 1800);
}

function onIndexSearchKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  scrollToIndexSearchMatch(event.shiftKey ? -1 : 1);
}

function columnDragInsertionIndex(index: number, event: DragEvent): number {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return index;
  const rect = target.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2 ? index + 1 : index;
}

function toggleDropColumn(column: EditableStructureColumn) {
  if (!canDropColumn(column)) return;
  column.markedForDrop = !column.markedForDrop;
  if (column.markedForDrop) {
    // A dropped row is no longer selectable: keep the multi-selection consistent.
    if (selectedColumnIds.value.has(column.id)) {
      const next = new Set(selectedColumnIds.value);
      next.delete(column.id);
      selectedColumnIds.value = next;
    }
    if (selectedColumnId.value === column.id) selectedColumnId.value = null;
    if (columnSelectionAnchorId.value === column.id) columnSelectionAnchorId.value = null;
  }
}

/** Selected columns in visible row order (dropped rows are not selectable). */
function selectedColumnsInOrder(): EditableStructureColumn[] {
  const ids = selectedColumnIds.value;
  if (!ids.size) return [];
  return columns.value.filter((column) => ids.has(column.id) && !column.markedForDrop);
}

/**
 * Batch copy: clone each source row and insert every copy right after its own
 * source, preserving relative order (same behavior as the row copy button,
 * applied to each target).
 */
async function copyColumnRows(targets: EditableStructureColumn[]) {
  if (!canAddColumn.value) return;
  const sources = targets.filter((column) => !column.markedForDrop);
  if (!sources.length) return;
  const copiedIds: string[] = [];
  // Insert from bottom to top so earlier inserts do not shift later source indexes.
  for (let index = sources.length - 1; index >= 0; index--) {
    const sourceIndex = columns.value.findIndex((item) => item.id === sources[index].id);
    if (sourceIndex < 0) continue;
    const copiedColumn = cloneColumnDraftAsNew(sources[index], uuid);
    columns.value.splice(sourceIndex + 1, 0, copiedColumn);
    copiedIds.unshift(copiedColumn.id);
  }
  const lastCopiedId = copiedIds[copiedIds.length - 1];
  if (!lastCopiedId) return;
  setColumnSelection(copiedIds, lastCopiedId, lastCopiedId);
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder(false);
  await focusColumnNameInput(lastCopiedId);
}

/** Batch drop: new rows are removed outright, existing rows are marked for drop. */
function dropOrRemoveColumns(targets: EditableStructureColumn[]) {
  for (const column of targets) {
    if (column.original) {
      if (!column.markedForDrop) toggleDropColumn(column);
    } else {
      removeNewColumn(column);
    }
  }
}

/**
 * Context menu for a column row. When the right-clicked row is part of the
 * multi-selection the actions apply to the whole selection; otherwise they
 * apply to that row only (same convention as the object browser).
 */
function columnContextMenuItems(column: EditableStructureColumn): ContextMenuItem[] {
  if (column.markedForDrop) {
    return [{ label: t("structureEditor.restore"), icon: RefreshCw, disabled: !canDropColumn(column), action: () => toggleDropColumn(column) }];
  }
  const isBatchContext = selectedColumnIds.value.has(column.id) && selectedColumnIds.value.size > 1;
  const targets = isBatchContext ? selectedColumnsInOrder() : [column];
  const count = targets.length;
  const allDroppable = targets.every((item) => !item.original || canDropColumn(item));
  return [
    ...columnIndexContextMenuItems(targets),
    {
      label: isBatchContext ? t("structureEditor.copySelectedColumns", { count }) : t("structureEditor.copyColumn"),
      icon: Copy,
      disabled: !canAddColumn.value,
      action: () => void copyColumnRows(targets),
    },
    {
      label: isBatchContext ? t("structureEditor.dropSelectedColumns", { count }) : column.original ? t("structureEditor.drop") : t("structureEditor.remove"),
      icon: Trash2,
      variant: "destructive",
      disabled: !allDroppable,
      action: () => dropOrRemoveColumns(targets),
    },
  ];
}

/**
 * The delete control is icon-only and swaps between three actions, so its
 * tooltip has to name the action instead of only showing the shortcut (#9870).
 */
function deleteColumnActionLabel(column: EditableStructureColumn): string {
  if (!column.original) {
    return t("structureEditor.remove");
  }
  return column.markedForDrop ? t("structureEditor.restore") : t("structureEditor.drop");
}

function activeColumnContextMenuItems(): ContextMenuItem[] {
  const column = columnContextMenuTarget.value;
  return column ? columnContextMenuItems(column) : [];
}

function openColumnContextMenu(event: MouseEvent, column: EditableStructureColumn, openContextMenu: (event: MouseEvent, itemsOverride?: ContextMenuItem[]) => void) {
  const items = columnContextMenuItems(column);
  columnContextMenuTarget.value = column;
  openContextMenu(event, items);
}

function clearColumnContextMenuTarget() {
  columnContextMenuTarget.value = null;
}

function canUseColumnIndexActions(targets: EditableStructureColumn[]): boolean {
  return !loading.value && !saving.value && !indexesLoading.value && !secondaryMetadataErrors.value.indexes && (isCreateMode.value || loadedMetadataFacets.has("indexes")) && targets.length > 0 && targets.every((column) => columnIsSelectable(column) && !!column.name.trim());
}

function setColumnsPrimaryKey(targets: EditableStructureColumn[]) {
  if (!canUseColumnIndexActions(targets) || targets.some(isPrimaryKeyDisabled)) return;
  for (const column of targets) {
    column.isPrimaryKey = true;
    column.isNullable = false;
  }
  sqlPreviewCollapsed.value = false;
}

function createIndexFromColumns(targets: EditableStructureColumn[], isUnique: boolean, indexType = "") {
  if (!canUseColumnIndexActions(targets) || !structureCapabilities.value.createIndex || specialIndexColumnIssue(structureDialect.value, indexType, targets, isUnique)) return;
  const index = newIndexDraft();
  index.columns = targets.map((column) => column.name.trim());
  index.isUnique = isUnique;
  index.indexType = indexType;
  refreshAutoIndexName(index);
  indexes.value.push(index);
  sqlPreviewCollapsed.value = false;
}

function addColumnsToIndex(index: EditableStructureIndex, targets: EditableStructureColumn[]) {
  if (!canUseColumnIndexActions(targets) || !canEditIndexDraft(index) || !canAddColumnsToIndex(index, targets)) return;
  for (const column of targets) {
    if (indexContainsColumn(index, column)) continue;
    // Operator classes are positional; preserve existing entries when extending a key.
    index.columnOpclasses = index.columns.map((_, position) => index.columnOpclasses?.[position] ?? null);
    index.columns.push(column.name.trim());
    index.columnOpclasses.push(null);
    index.includedColumns = index.includedColumns.filter((name) => structureColumnComparisonKey(name) !== structureColumnComparisonKey(column.name));
  }
  refreshAutoIndexName(index);
  sqlPreviewCollapsed.value = false;
}

function columnIndexContextMenuItems(targets: EditableStructureColumn[]): ContextMenuItem[] {
  if (!tableMetadataCapabilities.value.indexes) return [];
  const disabled = () => !canUseColumnIndexActions(targets);
  const primaryColumns = columns.value.filter((column) => column.isPrimaryKey && !column.markedForDrop);
  const createItems: ContextMenuItem[] = [
    {
      label: t("structureEditor.createPrimaryIndex"),
      icon: KeyRound,
      iconClass: "text-amber-600 dark:text-amber-400",
      disabled: () => disabled() || primaryColumns.length > 0 || targets.some(isPrimaryKeyDisabled),
      action: () => setColumnsPrimaryKey(targets),
    },
    ...([false, true] as const).map((unique): ContextMenuItem => ({
      label: t(unique ? "structureEditor.createUniqueIndex" : "structureEditor.createNormalIndex"),
      icon: KeyRound,
      iconClass: indexIconClass(unique ? "unique" : "index"),
      disabled: () =>
        disabled() ||
        !structureCapabilities.value.createIndex ||
        indexes.value.some(
          (index) =>
            !index.markedForDrop &&
            !index.isPrimary &&
            index.isUnique === unique &&
            !index.filter &&
            (!index.indexType || index.indexType.toUpperCase() === "BTREE") &&
            index.columns.length === targets.length &&
            index.columns.every((name, position) => structureColumnComparisonKey(name) === structureColumnComparisonKey(targets[position].name)),
        ),
      action: () => createIndexFromColumns(targets, unique),
    })),
    ...["FULLTEXT", "SPATIAL"]
      .filter((type) => indexTypeOptions.value.includes(type))
      .map((type): ContextMenuItem => ({
        label: t(type === "FULLTEXT" ? "structureEditor.createFulltextIndex" : "structureEditor.createSpatialIndex"),
        icon: KeyRound,
        iconClass: indexIconClass(type === "FULLTEXT" ? "fulltext" : "spatial"),
        disabled: () => disabled() || !structureCapabilities.value.createIndex || !!specialIndexColumnIssue(structureDialect.value, type, targets),
        action: () => createIndexFromColumns(targets, false, type),
      })),
  ];
  const addItems: ContextMenuItem[] = indexes.value
    .filter((index) => !index.markedForDrop && !index.isPrimary)
    .map((index) => ({
      label: `${index.name || t("structureEditor.addIndex")} (${index.columns.join(", ")})`,
      icon: KeyRound,
      iconClass: indexIconClass(structureIndexKind(index)),
      disabled: () => disabled() || !canEditIndexDraft(index) || !canAddColumnsToIndex(index, targets) || targets.every((column) => indexContainsColumn(index, column)),
      action: () => addColumnsToIndex(index, targets),
    }));
  if (primaryColumns.length)
    addItems.unshift({
      label: `PRIMARY (${primaryColumns.map((column) => column.name).join(", ")})`,
      icon: KeyRound,
      iconClass: "text-amber-600 dark:text-amber-400",
      disabled: () => disabled() || targets.every((column) => column.isPrimaryKey) || targets.some(isPrimaryKeyDisabled),
      action: () => setColumnsPrimaryKey(targets),
    });
  return [
    { label: targets.length > 1 ? t("structureEditor.createCompositeIndex", { count: targets.length }) : t("structureEditor.createColumnIndex"), icon: Plus, disabled, children: createItems },
    { label: t("structureEditor.addColumnsToIndex"), icon: KeyRound, disabled: () => disabled() || !addItems.length, children: addItems },
    {
      label: t("structureEditor.manageIndexes"),
      icon: Settings,
      action: () => {
        activeTab.value = "indexes";
      },
    },
    { label: "", separator: true },
  ];
}

function isColumnNameDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || (!!column.original && !structureCapabilities.value.renameColumn);
}

/** Mirror in the input what the DDL builder does with the name, so the field the
 * user sees matches the statement that will run. */
function commitColumnNameInput(column: EditableStructureColumn) {
  const normalized = draftColumnNameForSql(column.name, column.original?.name);
  if (normalized !== column.name) column.name = normalized;
}

function isColumnTypeDisabled(column: EditableStructureColumn): boolean {
  if (databaseType.value === "starrocks" && starRocksColumnDefinitionLocked(column, starrocksAlterContext.value)) return true;
  return column.markedForDrop || (!!column.original && !structureCapabilities.value.alterType);
}

function isColumnLengthDisabled(column: EditableStructureColumn): boolean {
  if (isColumnTypeDisabled(column)) {
    return true;
  }
  const baseType = dataTypeBaseInputValue(databaseType.value, column.dataType).trim().toLowerCase();
  return isDataTypeLengthDisabled(databaseType.value, baseType);
}

function columnLengthUnitOptions(column: EditableStructureColumn) {
  return getDataTypeLengthUnitOptions(databaseType.value, column.dataType);
}

function isColumnLengthUnitDisabled(column: EditableStructureColumn): boolean {
  return isColumnLengthDisabled(column) || !dataTypeLengthInputValue(databaseType.value, column.dataType).trim();
}

function isColumnNullableDisabled(column: EditableStructureColumn): boolean {
  if (databaseType.value === "starrocks" && (starRocksColumnDefinitionLocked(column, starrocksAlterContext.value) || column.original?.is_nullable)) return true;
  return column.markedForDrop || column.isPrimaryKey || (!!column.original && !structureCapabilities.value.alterNullability);
}

function isColumnDefaultDisabled(column: EditableStructureColumn): boolean {
  if (databaseType.value === "starrocks" && starRocksColumnDefinitionLocked(column, starrocksAlterContext.value)) return true;
  return column.markedForDrop || (!!column.original && !structureCapabilities.value.alterDefault) || isMysqlGeneratedActive(column);
}

function isColumnCommentDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || !structureCapabilities.value.comment;
}

function isColumnCharsetDisabled(column: EditableStructureColumn): boolean {
  if (column.markedForDrop) return true;
  if (!showCharacterSet.value) return true;
  return !isMysqlCharacterDataType(column.dataType);
}

function isPrimaryKeyDisabled(column: EditableStructureColumn): boolean {
  if (isCreatingForeignTable.value) return true;
  if (column.markedForDrop) return true;
  if (isCreateMode.value || structureCapabilities.value.alterPrimaryKey) return false;
  if (!structureCapabilities.value.addPrimaryKey) return true;
  return columns.value.some((candidate) => candidate.original?.is_primary_key);
}

function canDropColumn(column: EditableStructureColumn): boolean {
  if (databaseType.value === "starrocks" && (starRocksColumnDefinitionLocked(column, starrocksAlterContext.value) || starrocksAlterContext.value?.keyColumns.some((name) => name.toLowerCase() === column.original?.name.toLowerCase()))) return false;
  return !!column.original && !column.isPrimaryKey && !isProtectedManticoreIdColumn(databaseType.value, column.original.name) && structureCapabilities.value.dropColumn;
}

function isManticoreColumnPropertyDisabled(column: EditableStructureColumn): boolean {
  return !canEditManticoreColumnProperties(databaseType.value, !!column.original) || column.markedForDrop;
}

function newIndexDraft(): EditableStructureIndex {
  return {
    id: `new:${uuid()}`,
    name: "",
    columns: [],
    nameEdited: false,
    isUnique: false,
    isPrimary: false,
    filter: "",
    indexType: "",
    includedColumns: [],
    comment: "",
    concurrently: false,
    columnOpclasses: [],
    markedForDrop: false,
  };
}

function addIndex() {
  if (!structureCapabilities.value.createIndex || indexesLoading.value) return;
  activeTab.value = "indexes";
  const draft = newIndexDraft();
  indexes.value.push(draft);
  void nextTick(() => {
    // The sorted DOM order is not the insertion order; focus the row belonging
    // to this draft instead of the last rendered new-index row.
    const row = Array.from(rootRef.value?.querySelectorAll<HTMLElement>("[data-index-row-id]") ?? []).find((candidate) => candidate.dataset.indexRowId === draft.id);
    const input = row?.querySelector<HTMLInputElement>("[data-index-name-input]");
    row?.scrollIntoView({ block: "nearest" });
    input?.focus();
    input?.select();
  });
  return draft;
}

function structureIndexTableName(): string {
  return (isCreateMode.value ? newTableName.value : props.tableName).trim();
}

function existingIndexNamesForDraft(index: EditableStructureIndex): string[] {
  return indexes.value.filter((item) => item.id !== index.id && !item.markedForDrop).map((item) => item.name);
}

function generatedIndexNameForDraft(index: EditableStructureIndex): string {
  const firstColumn = index.autoNameColumn ?? index.columns[0] ?? "";
  const existingNames = existingIndexNamesForDraft(index);
  if (usesNativeMysqlIndexNames.value) return generateUniqueShortIndexName(firstColumn, existingNames, { ...index, maxLength: 64 });
  // Index names can be schema-wide outside MySQL. Retain the original table-qualified rule.
  const name = generateUniqueIndexName(structureIndexTableName(), firstColumn ? [firstColumn] : [], existingNames);
  return connection.value?.driver_profile?.toLowerCase() === "gaussdb-m" ? name.toLowerCase() : name;
}

function refreshAutoIndexName(index: EditableStructureIndex, typeChanged = false) {
  if (index.original || index.nameEdited !== false) return;
  index.autoNameColumn ??= index.columns[0];
  if (index.name && !typeChanged) return;
  index.name = generatedIndexNameForDraft(index);
}

function regenerateIndexName(index: EditableStructureIndex) {
  if (!canEditIndexDraft(index) || !index.columns.length) return;
  index.autoNameColumn = index.columns[0];
  index.name = generatedIndexNameForDraft(index);
  index.nameEdited = !!index.original;
}

function onIndexNameInput(index: EditableStructureIndex, value: string | number) {
  index.name = String(value ?? "");
  index.nameEdited = true;
}

const availableColumnNames = computed(() =>
  columns.value
    .filter((c) => !c.markedForDrop)
    .map((c) => c.name)
    .filter(Boolean),
);

const defaultIndexColumnOptions = computed(() => {
  return availableColumnNames.value.map((name) => {
    const column = activeColumnByName.value.get(name);
    return { name, dataType: column?.dataType ?? "", disabled: false };
  });
});

function indexColumnPickerOptions(index: EditableStructureIndex, included = false) {
  const selected = included ? index.includedColumns : index.columns;
  const isSpecial = !included && canIndexTypeHaveSpecialIssue(structureDialect.value, index.indexType);
  const availableSet = new Set(availableColumnNames.value);
  const hasUnavailableSelected = selected.some((name) => name.trim() && !availableSet.has(name));

  if (!isSpecial && !hasUnavailableSelected) {
    return defaultIndexColumnOptions.value;
  }

  return filterStructureIndexColumnOptions(availableColumnNames.value, selected).map((name) => {
    const column = activeColumnByName.value.get(name);
    return { name, dataType: column?.dataType ?? "", disabled: !included && !canToggleIndexColumn(index, name) };
  });
}

function toggleIndexColumn(index: EditableStructureIndex, col: string) {
  if (!canEditIndexDraft(index) || !canToggleIndexColumn(index, col)) return;
  const i = index.columns.indexOf(col);
  index.columnOpclasses = index.columns.map((_, position) => index.columnOpclasses?.[position] ?? null);
  if (i >= 0) {
    index.columns.splice(i, 1);
    index.columnOpclasses.splice(i, 1);
  } else {
    index.columns.push(col);
    index.columnOpclasses.push(null);
  }
  refreshAutoIndexName(index);
}

function indexColumnsIssue(index: EditableStructureIndex, names = index.columns, indexType = index.indexType, isUnique = index.isUnique) {
  if (!canIndexTypeHaveSpecialIssue(structureDialect.value, indexType)) return null;
  const fields = names.flatMap((name) => {
    const column = activeColumnByComparisonKey.value.get(structureColumnComparisonKey(name));
    return column ? [column] : [];
  });
  return specialIndexColumnIssue(structureDialect.value, indexType, fields, isUnique);
}

function needsIndexColumnValidation(index: EditableStructureIndex): boolean {
  if (indexChanged(index)) return true;
  // Untouched server metadata must not block unrelated edits under newer UI rules.
  return columns.value.some((column) => indexContainsColumn(index, column) && (!column.original || column.markedForDrop || column.dataType !== column.original.data_type || column.isNullable !== column.original.is_nullable));
}

function canToggleIndexColumn(index: EditableStructureIndex, name: string): boolean {
  if (!canIndexTypeHaveSpecialIssue(structureDialect.value, index.indexType)) return true;
  return index.columns.includes(name) || !indexColumnsIssue(index, [...index.columns, name]);
}

function canAddColumnsToIndex(index: EditableStructureIndex, targets: EditableStructureColumn[]): boolean {
  const names = [...index.columns, ...targets.filter((column) => !indexContainsColumn(index, column)).map((column) => column.name.trim())];
  return !indexColumnsIssue(index, names);
}

function onIndexUniqueChange(index: EditableStructureIndex, unique: boolean) {
  if (!canEditIndexDraft(index) || indexColumnsIssue(index, index.columns, index.indexType, unique)) return;
  index.isUnique = unique;
  refreshAutoIndexName(index, true);
}

function onIndexTypeChange(index: EditableStructureIndex, value: unknown) {
  const type = String(value ?? "");
  if (!canEditIndexDraft(index) || indexColumnsIssue(index, index.columns, type, false)) return;
  index.indexType = type;
  if (structureIndexKind({ indexType: type }) === "fulltext" || structureIndexKind({ indexType: type }) === "spatial") index.isUnique = false;
  refreshAutoIndexName(index, true);
}

function toggleIncludedColumn(index: EditableStructureIndex, col: string) {
  if (!structureCapabilities.value.indexInclude) return;
  const i = index.includedColumns.indexOf(col);
  if (i >= 0) index.includedColumns.splice(i, 1);
  else index.includedColumns.push(col);
}

function removeNewIndex(index: EditableStructureIndex) {
  indexes.value = indexes.value.filter((item) => item.id !== index.id);
}

function toggleDropIndex(index: EditableStructureIndex) {
  if (!canDropIndex(index)) return;
  index.markedForDrop = !index.markedForDrop;
}

function canEditIndexDraft(index: EditableStructureIndex): boolean {
  if (indexesLoading.value) return false;
  if (schemaIndexDraftIsReadOnly(index)) return false;
  if (index.markedForDrop || index.isPrimary) return false;
  if (!index.original) return structureCapabilities.value.createIndex;
  return structureCapabilities.value.rebuildIndex && structureCapabilities.value.createIndex && structureCapabilities.value.dropIndex;
}

/**
 * Whether the Concurrent checkbox is actionable for this index draft.
 *
 * Plan A scope guard (PR #6361 review): concurrent builds apply only to newly
 * created indexes on non-partitioned tables. Editing an existing index would
 * require a `DROP INDEX CONCURRENTLY` + `CREATE INDEX CONCURRENTLY` replace
 * flow (not implemented yet), PostgreSQL rejects `CREATE INDEX CONCURRENTLY`
 * on partitioned parents, and an unverifiable partition status fails closed —
 * all of those disable the checkbox here. The core SQL builder enforces the
 * same scope as a hard error, so this is only the first layer.
 */
function concurrentIndexAvailability(index: EditableStructureIndex): ConcurrentIndexAvailability {
  if (indexesLoading.value) return { enabled: false, reason: "unknown" };
  return concurrentIndexAvailabilityState(index);
}

/** Same decision as [`concurrentIndexAvailability`], independent of the
 * indexes-loading flag — state-normalization runs while metadata may still be
 * in flight, and must decide on the availability inputs alone. */
function concurrentIndexAvailabilityState(index: EditableStructureIndex): ConcurrentIndexAvailability {
  return getConcurrentIndexAvailability({
    hasOriginal: !!index.original,
    isPrimary: index.isPrimary,
    markedForDrop: index.markedForDrop,
    isPartitionedParent: isPartitionedParent.value,
    partitionStatusKnown: partitionStatusKnown.value,
    supportsIndexConcurrent: structureCapabilities.value.indexConcurrent,
    supportsCreateIndex: structureCapabilities.value.createIndex,
  });
}

/**
 * Layer A — invalidate `concurrently: true` drafts whenever Concurrent becomes
 * unavailable. Transiently unknown partition status preserves the flag so a
 * later successful probe can recover the user's intent; definitive unsupported
 * states clear it. In both cases, empty pending SQL and keep Save blocked until
 * availability is verified again.
 */
function normalizeConcurrentIndexDraftsForCurrentAvailability(): boolean {
  // Engines that cannot express Concurrent (non-PostgreSQL dialects) ignore a
  // stale flag in the core builder and render no checkbox; blocking the save
  // there would only trap a draft carried over from a PostgreSQL session.
  if (!structureCapabilities.value.indexConcurrent) return false;
  const { indexes: normalized, invalidatedIds } = normalizeUnsupportedConcurrentIndexes(indexes.value, concurrentIndexAvailabilityState);
  if (invalidatedIds.length === 0) return false;
  indexes.value = normalized;
  concurrentAvailabilityInvalidated.value = true;
  pendingStatements.value = [];
  warnings.value = [t("structureEditor.concurrentUnavailableBlocksSave")];
  sqlPreviewLoading.value = false;
  sqlPreviewPending.value = false;
  errorMessage.value = t("structureEditor.concurrentUnavailableBlocksSave");
  return true;
}

/** Layer B — a `concurrently: true` draft whose availability is no longer
 * enabled must never reach the SQL builder or the execute path. Returns the
 * blocking message, or null when the request stays legal. */
function concurrentIndexBlockingWarning(): string | null {
  // Non-concurrent-capable engines cannot express the request in SQL; the core
  // builder ignores the flag, so there is no stale-concurrent hazard to block.
  if (!structureCapabilities.value.indexConcurrent) return null;
  const stale = indexes.value.find((index) => index.concurrently && !concurrentIndexAvailability(index).enabled);
  return stale ? t("structureEditor.concurrentUnavailableBlocksSave") : null;
}

function canEditIndexConcurrent(index: EditableStructureIndex): boolean {
  return concurrentIndexAvailability(index).enabled;
}

function concurrentIndexCellTitle(index: EditableStructureIndex): string {
  switch (concurrentIndexAvailability(index).reason) {
    case "existing":
      return t("structureEditor.concurrentExistingIndexTooltip");
    case "partitioned":
      return t("structureEditor.concurrentPartitionedTooltip");
    case "unknown":
      return t("structureEditor.concurrentUnavailableTooltip");
    default:
      return t("structureEditor.concurrentTooltip");
  }
}

function canEditIndexFilter(index: EditableStructureIndex): boolean {
  return canEditIndexDraft(index) && structureCapabilities.value.indexFilter;
}

function canEditIndexComment(index: EditableStructureIndex): boolean {
  return canEditIndexDraft(index) && structureCapabilities.value.indexComment;
}

function canDropIndex(index: EditableStructureIndex): boolean {
  if (indexesLoading.value) return false;
  if (schemaIndexDraftIsReadOnly(index)) return false;
  return !!index.original && !index.isPrimary && structureCapabilities.value.dropIndex;
}

function schemaIndexDraftIsReadOnly(index: EditableStructureIndex): boolean {
  return props.exactIdentity === true && !!index.original && (index.original.owner == null || index.original.owner !== metadataSchema.value);
}

function schemaIndexWriteWarning(): string | undefined {
  const blocked = indexes.value.find((index) => schemaIndexDraftIsReadOnly(index) && indexChanged(index));
  if (!blocked) return undefined;
  return blocked.original?.owner == null ? t("schemaIndex.targetMissing", { name: blocked.original?.name }) : t("schemaIndex.crossOwnerReadOnly", { owner: blocked.original.owner, name: blocked.original.name });
}

const isOracleForeignKeyEditor = computed(() => databaseType.value === "oracle" || databaseType.value === "oceanbase-oracle");
const canEditForeignKeys = computed(() => (isOracleForeignKeyEditor.value ? true : structureCapabilities.value.foreignKey));
const canEditTriggers = computed(() => structureDialect.value === "mysql" || structureDialect.value === "oracle" || structureDialect.value === "sqlserver");
const isOracleTriggerEditor = computed(() => structureDialect.value === "oracle");
const isSqlServerTriggerEditor = computed(() => structureDialect.value === "sqlserver");
const supportsTriggerEnableToggle = computed(() => isOracleTriggerEditor.value || isSqlServerTriggerEditor.value);

function generatedForeignKeyName(column = ""): string {
  const table = structureIndexTableName() || "table";
  const suffix = column || "column";
  const base = `fk_${table}_${suffix}`
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const taken = new Set(foreignKeys.value.map((item) => item.name.trim().toLowerCase()).filter(Boolean));
  if (!taken.has(base.toLowerCase())) return base;
  for (let counter = 2; counter < 10_000; counter++) {
    const candidate = `${base}_${counter}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

function addForeignKey() {
  if (!canEditForeignKeys.value || foreignKeysLoading.value) return;
  activeTab.value = "foreignKeys";
  foreignKeys.value.push({
    id: `new:${uuid()}`,
    name: generatedForeignKeyName(),
    column: "",
    refSchema: "",
    refTable: "",
    refColumn: "",
    ...(isOracleForeignKeyEditor.value ? { columns: [""], refColumns: [""], oracleState: { enabled: true, validated: true, deferrable: false, initiallyDeferred: false, rely: false } } : {}),
    onUpdate: "",
    onDelete: "",
    markedForDrop: false,
  });
}

function removeNewForeignKey(foreignKey: EditableStructureForeignKey) {
  foreignKeys.value = foreignKeys.value.filter((item) => item.id !== foreignKey.id);
}

function toggleDropForeignKey(foreignKey: EditableStructureForeignKey) {
  if (foreignKeysLoading.value || !foreignKey.original) return;
  if (isOracleForeignKeyEditor.value && (!foreignKey.oracleOriginal || foreignKeyDefinitionBusy.value || saving.value)) return;
  foreignKey.markedForDrop = !foreignKey.markedForDrop;
}

function canEditForeignKeyDraft(foreignKey: EditableStructureForeignKey): boolean {
  if (isOracleForeignKeyEditor.value) return !foreignKeysLoading.value && !foreignKeyDefinitionBusy.value && !saving.value && !foreignKey.markedForDrop && (!foreignKey.original || !!foreignKey.oracleOriginal);
  return !foreignKeysLoading.value && canEditForeignKeys.value && !foreignKey.markedForDrop;
}

async function editOracleForeignKey(foreignKey: EditableStructureForeignKey) {
  if (!isOracleForeignKeyEditor.value || foreignKeyDefinitionBusy.value || saving.value || foreignKeysLoading.value || !foreignKey.original) return;
  const target = { ...primaryKeyTarget(), databaseType: databaseType.value === "oracle" ? ("oracle" as const) : ("oceanbase-oracle" as const) };
  const identity = JSON.stringify(target);
  foreignKeyDefinitionBusy.value = true;
  try {
    const definitions = await readOracleForeignKeyDefinitions(target);
    if (primaryKeyUnmounted || identity !== JSON.stringify(primaryKeyTarget()) || !foreignKeys.value.includes(foreignKey)) return;
    const definition = definitions.find((key) => key.name === foreignKey.original!.name);
    if (!definition) throw new Error(t("oceanbasePrimaryKey.incompleteMetadata"));
    foreignKey.name = definition.name;
    foreignKey.columns = [...definition.columns];
    foreignKey.refColumns = [...definition.refColumns];
    foreignKey.column = definition.columns.join(", ");
    foreignKey.refColumn = definition.refColumns.join(", ");
    foreignKey.refSchema = definition.refSchema;
    foreignKey.refTable = definition.refTable;
    foreignKey.onDelete = definition.onDelete;
    foreignKey.onUpdate = "";
    foreignKey.oracleState = { ...definition.state };
    foreignKey.oracleOriginal = cloneDraftValue(definition);
    foreignKey.original = { ...foreignKey.original, name: definition.name, column: foreignKey.column, ref_column: foreignKey.refColumn, ref_schema: definition.refSchema, ref_table: definition.refTable, on_delete: definition.onDelete, on_update: "" };
    void loadOracleForeignKeyReferenceColumns(foreignKey);
  } catch (error) {
    if (!primaryKeyUnmounted && identity === JSON.stringify(primaryKeyTarget()) && foreignKeys.value.includes(foreignKey)) errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    foreignKeyDefinitionBusy.value = false;
  }
}

function syncForeignKeyPairText(foreignKey: EditableStructureForeignKey) {
  foreignKey.column = foreignKey.columns?.join(", ") ?? "";
  foreignKey.refColumn = foreignKey.refColumns?.join(", ") ?? "";
}

function foreignKeyReferenceListId(foreignKey: EditableStructureForeignKey) {
  return `${foreignKeyReferenceListPrefix}-${foreignKey.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function setOracleForeignKeyPair(foreignKey: EditableStructureForeignKey, position: number, value: unknown, local: boolean) {
  if (!canEditForeignKeyDraft(foreignKey)) return;
  const list = local ? foreignKey.columns : foreignKey.refColumns;
  if (!list || position < 0 || position >= list.length) return;
  list[position] = String(value ?? "");
  syncForeignKeyPairText(foreignKey);
}

function moveOracleForeignKeyPair(foreignKey: EditableStructureForeignKey, position: number, direction: number) {
  if (!canEditForeignKeyDraft(foreignKey) || !foreignKey.columns || !foreignKey.refColumns || position + direction < 0 || position + direction >= foreignKey.columns.length) return;
  for (const list of [foreignKey.columns, foreignKey.refColumns]) {
    const [name] = list.splice(position, 1);
    list.splice(position + direction, 0, name!);
  }
  syncForeignKeyPairText(foreignKey);
}

function addOracleForeignKeyPair(foreignKey: EditableStructureForeignKey) {
  if (!canEditForeignKeyDraft(foreignKey)) return;
  foreignKey.columns?.push("");
  foreignKey.refColumns?.push("");
  syncForeignKeyPairText(foreignKey);
}

function removeOracleForeignKeyPair(foreignKey: EditableStructureForeignKey, position: number) {
  if (!canEditForeignKeyDraft(foreignKey)) return;
  foreignKey.columns?.splice(position, 1);
  foreignKey.refColumns?.splice(position, 1);
  syncForeignKeyPairText(foreignKey);
}

function setOracleForeignKeyTarget(foreignKey: EditableStructureForeignKey, value: unknown, schema: boolean) {
  if (!canEditForeignKeyDraft(foreignKey)) return;
  const next = String(value ?? "");
  if (next === (schema ? foreignKey.refSchema : foreignKey.refTable)) return;
  if (schema) foreignKey.refSchema = next;
  else foreignKey.refTable = next;
  foreignKey.refColumns = foreignKey.columns?.map(() => "");
  foreignKeyReferenceColumns.value[foreignKey.id] = [];
  syncForeignKeyPairText(foreignKey);
  void loadOracleForeignKeyReferenceColumns(foreignKey);
}

async function loadOracleForeignKeyReferenceColumns(foreignKey: EditableStructureForeignKey) {
  const target = primaryKeyTarget();
  const parent = { schema: foreignKey.refSchema, table: foreignKey.refTable };
  if (!parent.schema || !parent.table) return;
  const current = () => !primaryKeyUnmounted && JSON.stringify(target) === JSON.stringify(primaryKeyTarget()) && foreignKeys.value.includes(foreignKey) && foreignKey.refSchema === parent.schema && foreignKey.refTable === parent.table;
  try {
    const choices = await api.getColumns(target.connectionId, target.database, parent.schema, parent.table, target.catalog);
    if (current()) foreignKeyReferenceColumns.value[foreignKey.id] = choices;
  } catch {
    // Parent columns can be invisible under column-level REFERENCES grants.
    // Keep exact-name entry available; write preflight decides admissibility.
    if (current()) foreignKeyReferenceColumns.value[foreignKey.id] = [];
  }
}

function setOracleForeignKeyState(foreignKey: EditableStructureForeignKey, key: "enabled" | "validated" | "deferrable" | "initiallyDeferred" | "rely", value: boolean) {
  if (!canEditForeignKeyDraft(foreignKey) || !foreignKey.oracleState) return;
  if ((key === "deferrable" || key === "initiallyDeferred") && databaseType.value !== "oracle") return;
  if (key === "initiallyDeferred" && value && !foreignKey.oracleState.deferrable) return;
  foreignKey.oracleState[key] = value;
  if (!foreignKey.oracleState.deferrable) foreignKey.oracleState.initiallyDeferred = false;
  if (foreignKey.oracleState.validated) foreignKey.oracleState.rely = false;
}

function addTrigger() {
  if (!canEditTriggers.value || triggersLoading.value) return;
  activeTab.value = "triggers";
  const draft: EditableStructureTrigger = {
    id: `new:${uuid()}`,
    name: "",
    timing: isOracleTriggerEditor.value ? "BEFORE EACH ROW" : isSqlServerTriggerEditor.value ? "AFTER" : "BEFORE",
    event: "INSERT",
    statement: isOracleTriggerEditor.value ? "BEGIN\n  NULL;\nEND" : isSqlServerTriggerEditor.value ? "BEGIN\n  SET NOCOUNT ON;\nEND" : "BEGIN\n  \nEND",
    enabled: true,
    markedForDrop: false,
  };
  triggers.value.push(draft);
  selectedTriggerId.value = draft.id;
}

function removeNewTrigger(trigger: EditableStructureTrigger) {
  triggers.value = triggers.value.filter((item) => item.id !== trigger.id);
}

function toggleDropTrigger(trigger: EditableStructureTrigger) {
  if (triggersLoading.value || !trigger.original) return;
  trigger.markedForDrop = !trigger.markedForDrop;
}

function canEditTriggerDraft(trigger: EditableStructureTrigger): boolean {
  return canToggleTriggerEnabled(trigger) && (!exactOracleTriggerMetadata(trigger.original) || trigger.loadedOracleSource !== undefined) && canEditStructuredTriggerDraft(databaseType.value, trigger);
}

// ALTER TRIGGER ... ENABLE/DISABLE leaves the source untouched, so it stays available for
// triggers whose source the structured form cannot rebuild.
function canToggleTriggerEnabled(trigger: EditableStructureTrigger): boolean {
  return !triggersLoading.value && canEditTriggers.value && !trigger.markedForDrop && !triggerSourceRefreshRequired.value.has(trigger.id);
}

function primarySqlOperation(sql: string): string {
  const statement = sql
    .split(";")
    .map((part) => part.trim())
    .find(Boolean);
  return statement?.match(/^([a-z]+)/i)?.[1]?.toUpperCase() || "SQL";
}

async function recordStructureHistory(sql: string, start: number, success: boolean, result?: { affected_rows?: number }, error?: string, target?: StructureDdlRequest) {
  const connection = store.getConfig(target?.connectionId ?? props.connectionId);
  try {
    await historyStore.add({
      connection_id: target?.connectionId ?? props.connectionId,
      connection_name: connection?.name || "",
      database: target?.database ?? props.database,
      sql,
      execution_time_ms: Date.now() - start,
      success,
      error,
      activity_kind: "schema_change",
      operation: !target && hasSqliteTypeChange.value ? "ALTER TABLE" : primarySqlOperation(sql),
      target: target?.tableName ?? (isCreateMode.value ? newTableName.value.trim() : props.tableName),
      affected_rows: success ? result?.affected_rows : undefined,
    });
  } catch (e) {
    console.warn("[DBX][structure-history:save-failed]", e);
  }
}

const copyColumnNamesDialogOpen = ref(false);
// Fields marked for drop no longer exist after saving, so they are excluded.
const copyableStructureColumnNames = computed(() => structureColumnNamesForCopy(columns.value));
const copyableStructureColumnComments = computed(() => structureColumnCommentsForCopy(columns.value));

async function copyColumnNamesText(text: string) {
  try {
    await copyToClipboard(text);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copyPreviewSql() {
  if (sqlPreviewPending.value || sqlPreviewLoading.value || !previewSqlText.value.trim()) return;
  try {
    await copyToClipboard(previewSqlText.value);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copyDdlContent() {
  if (ddlLoading.value || ddlLoadError.value) return;
  // Copy what the editor actually shows, so an edited script is not silently
  // replaced by the database's original DDL.
  const ddl = ddlDraft.value ?? ddlContent.value;
  if (!ddl.trim()) return;
  try {
    await copyToClipboard(ddl);
    toast(t("contextMenu.ddlCopied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function toggleSqlPreviewCollapsed() {
  sqlPreviewCollapsed.value = !sqlPreviewCollapsed.value;
  safeLocalStorageSet(STRUCTURE_SQL_PREVIEW_COLLAPSED_STORAGE_KEY, String(sqlPreviewCollapsed.value));
}

async function applyExistingPrimaryKey(): Promise<boolean> {
  if (primaryKeyBusy.value || !existingPrimaryKeyPlan.value) return false;
  const plan = cloneDraftValue(existingPrimaryKeyPlan.value);
  const plannedSession = existingPrimaryKeySession.value;
  if (!plannedSession) return false;
  const identity = JSON.stringify(plan.target);
  const draft = JSON.stringify(plan.draft ?? plan.change);
  const connectionAtStart = store.getConfig(plan.target.connectionId);
  const sameTarget = () => !primaryKeyUnmounted && identity === JSON.stringify(primaryKeyTarget());
  const connectionCurrent = () =>
    store.connectionStateRevision(plan.target.connectionId) === plannedSession.revision &&
    store.isCurrentConnectionStateRevision(plan.target.connectionId, plannedSession.revision) &&
    (store.getConfig(plan.target.connectionId) ? connectionConfigFingerprint(store.getConfig(plan.target.connectionId)!) : "") === plannedSession.configFingerprint;
  const canStart = () => sameTarget() && connectionCurrent() && draft === JSON.stringify(existingPrimaryKeyDraft.value) && !hasPendingStructureChanges(false) && !ddlDirty.value;
  if (!canStart()) {
    if (sameTarget() && !connectionCurrent()) {
      existingPrimaryKeyPlan.value = undefined;
      existingPrimaryKeySession.value = undefined;
      pendingStatements.value = [];
      warnings.value = [t("oceanbasePrimaryKey.refreshRequired")];
    }
    return false;
  }
  primaryKeyBusy.value = true;
  saving.value = true;
  const startedAt = Date.now();
  try {
    const protection = productionContextForDatabase(connectionAtStart, plan.target.database);
    if (protection.active) {
      const accepted = await productionSafetyStore.requestConfirmation({
        sql: plan.statements.join("\n"),
        connectionName: connectionAtStart?.name,
        database: plan.target.database,
        productionDatabases: protection.databases,
        source: t("production.sourceStructure"),
        scopeId: primaryKeyConfirmationScope,
      });
      if (!accepted || !canStart()) {
        if (sameTarget() && !connectionCurrent()) {
          existingPrimaryKeyPlan.value = undefined;
          existingPrimaryKeySession.value = undefined;
          pendingStatements.value = [];
          warnings.value = [t("oceanbasePrimaryKey.refreshRequired")];
        }
        return false;
      }
    }
    const timeout = queryTimeoutSecsForConnection(connectionAtStart, settingsStore.editorSettings.globalQueryTimeoutSecs);
    const result = await executeOceanbasePrimaryKeyPlan(plan, timeout, { canStart, connectionCurrent });
    if (!result) {
      if (sameTarget() && !connectionCurrent()) {
        existingPrimaryKeyPlan.value = undefined;
        existingPrimaryKeySession.value = undefined;
        pendingStatements.value = [];
        warnings.value = [t("oceanbasePrimaryKey.refreshRequired")];
      }
      return false;
    }
    const completed = result.steps.every((step) => step.state === "committed");
    let details = result.steps.map((step, index) => `${index + 1}. ${t(`oceanbasePrimaryKey.${step.state}`)}\n${step.sql}${step.error ? `\n${step.error}` : ""}`).join("\n\n");
    if (result.indexStates?.length) details += `\n\n${result.indexStates.map((index) => `${index.name}: ${t(`oceanbasePrimaryKey.${index.state}`)}`).join("\n")}`;
    for (const step of result.steps.filter((item) => item.state !== "notExecuted")) {
      try {
        await historyStore.add({
          connection_id: plan.target.connectionId,
          connection_name: connectionAtStart?.name || "",
          database: plan.target.database,
          sql: step.sql,
          execution_time_ms: Date.now() - startedAt,
          success: step.state === "committed",
          error: step.state === "committed" ? undefined : `${t(`oceanbasePrimaryKey.${step.state}`)}: ${step.error || ""}`,
          activity_kind: "schema_change",
          operation: "ALTER TABLE",
          target: plan.target.tableName,
        });
      } catch (error) {
        console.warn("[DBX][structure-history:save-failed]", error);
      }
    }
    if (connectionCurrent()) {
      try {
        invalidateTableMetadataCache(plan.target);
        await invalidateObjectMetadataCache(plan.target);
        await invalidateObjectDdl(plan.target);
      } catch (error) {
        result.readbackError = [result.readbackError, primaryKeyError(error)].filter(Boolean).join("\n");
      }
    }
    if (sameTarget()) {
      existingPrimaryKeyPlan.value = undefined;
      existingPrimaryKeySession.value = undefined;
      pendingStatements.value = [];
      if (completed && !result.readbackError && connectionCurrent()) {
        existingPrimaryKeyDraft.value = undefined;
        loadedMetadataFacets.clear();
        ddlFetched.value = false;
        rawDdlContent.value = "";
        const refresh = await loadStructure(true, { columns: true, indexes: true, constraints: true, foreignKeys: false, triggers: false, partitions: false, tableComment: false }, true, { forceMetadata: true, blockSecondaryMetadata: true });
        if (refresh?.error) result.readbackError = refresh.error;
        if (sameTarget()) {
          const refreshErrors = [errorMessage.value, ...Object.values(secondaryMetadataErrors.value)].filter(Boolean);
          if (refreshErrors.length) result.readbackError = refreshErrors.join("\n");
          emit("saved", false);
        }
      } else {
        warnings.value = [t("oceanbasePrimaryKey.refreshRequired")];
      }
      syncDraftToParent();
    }
    const succeeded = completed && !result.readbackError && connectionCurrent();
    if (succeeded) {
      toast(t("structureEditor.saved"), 2500);
      if (!result.recoverySql) return true;
    }
    if (result.readbackError) details += `\n\n${t("oceanbasePrimaryKey.readbackFailed")}: ${result.readbackError === "definitionChanged" ? t("oceanbasePrimaryKey.definitionChanged") : result.readbackError}`;
    if (result.recoverySql) details += `\n\n${t("oceanbasePrimaryKey.recoveryNotice")}\n${result.recoverySql}`;
    primaryKeyResultTitle.value = "oceanbasePrimaryKey.resultTitle";
    primaryKeyResultMessage.value = `${plan.target.schema}.${plan.target.tableName}: ${t(succeeded ? "structureEditor.saved" : "oceanbasePrimaryKey.executionFailed")}`;
    primaryKeyResultDetails.value = details;
    if (!primaryKeyUnmounted) primaryKeyResultOpen.value = true;
    else toast(primaryKeyResultMessage.value, 10000);
    return succeeded;
  } catch (error) {
    if (sameTarget()) errorMessage.value = primaryKeyError(error);
    return false;
  } finally {
    primaryKeyBusy.value = false;
    saving.value = false;
  }
}

async function applyOracleForeignKeyPlan(): Promise<boolean> {
  if (oracleForeignKeyBusy.value || !existingOracleForeignKeyPlan.value) return false;
  const plan = cloneDraftValue(existingOracleForeignKeyPlan.value);
  const plannedSession = existingOracleForeignKeySession.value;
  if (!plannedSession) return false;
  const identity = JSON.stringify(plan.target);
  const changes = JSON.stringify(oracleForeignKeyChanges());
  const connectionAtStart = store.getConfig(plan.target.connectionId);
  const sameTarget = () => !primaryKeyUnmounted && identity === JSON.stringify(primaryKeyTarget());
  const connectionCurrent = () =>
    store.connectionStateRevision(plan.target.connectionId) === plannedSession.revision &&
    store.isCurrentConnectionStateRevision(plan.target.connectionId, plannedSession.revision) &&
    (store.getConfig(plan.target.connectionId) ? connectionConfigFingerprint(store.getConfig(plan.target.connectionId)!) : "") === plannedSession.configFingerprint;
  const noOtherDrafts = () => {
    const scope = captureStructureRefreshScope();
    return !scope.columns && !scope.indexes && !scope.triggers && !scope.tableComment && !partitionOperations.value.length && !existingPrimaryKeyChanged.value && !ddlDirty.value;
  };
  const canStart = () => sameTarget() && changes === JSON.stringify(oracleForeignKeyChanges()) && noOtherDrafts();
  const stillCurrent = () => canStart() && connectionCurrent();
  if (!stillCurrent()) return false;
  oracleForeignKeyBusy.value = true;
  saving.value = true;
  const startedAt = Date.now();
  let refreshError = "";
  try {
    const protection = productionContextForDatabase(connectionAtStart, plan.target.database);
    if (protection.active) {
      const accepted = await productionSafetyStore.requestConfirmation({
        sql: plan.statements.join("\n"),
        connectionName: connectionAtStart?.name,
        database: plan.target.database,
        productionDatabases: protection.databases,
        source: t("production.sourceStructure"),
        scopeId: oracleForeignKeyConfirmationScope,
      });
      if (!accepted || !stillCurrent()) return false;
    }
    const timeout = queryTimeoutSecsForConnection(connectionAtStart, settingsStore.editorSettings.globalQueryTimeoutSecs);
    const result = await executeOracleForeignKeyPlan(plan, timeout, { canStart, connectionCurrent });
    if (!result) return false;
    const completed = result.steps.every((step) => step.state === "committed");
    let details = result.steps.map((step, index) => `${index + 1}. ${t(`oceanbasePrimaryKey.${step.state}`)}\n${step.sql}${step.error ? `\n${step.error}` : ""}`).join("\n\n");
    if (result.recoverySql?.length) details += `\n\n${t("oracleForeignKey.recoveryNotice")}\n${result.recoverySql.join("\n")}`;
    for (const step of result.steps.filter((item) => item.state !== "notExecuted")) {
      try {
        await historyStore.add({
          connection_id: plan.target.connectionId,
          connection_name: connectionAtStart?.name || "",
          database: plan.target.database,
          sql: step.sql,
          execution_time_ms: Date.now() - startedAt,
          success: step.state === "committed",
          error: step.state === "committed" ? undefined : `${t(`oceanbasePrimaryKey.${step.state}`)}: ${step.error || ""}`,
          activity_kind: "schema_change",
          operation: "ALTER TABLE",
          target: plan.target.tableName,
        });
      } catch (error) {
        console.warn("[DBX][structure-history:save-failed]", error);
      }
    }
    if (!sameTarget() || !connectionCurrent()) return false;
    if (result.steps.some((step) => step.state !== "notExecuted")) {
      try {
        const affected = new Map([[JSON.stringify([plan.target.schema, plan.target.tableName]), { ...plan.target }]]);
        for (const change of plan.changes) {
          for (const definition of [change.original, change.target]) {
            if (definition) affected.set(JSON.stringify([definition.refSchema, definition.refTable]), { ...plan.target, schema: definition.refSchema, tableName: definition.refTable });
          }
        }
        for (const object of affected.values()) {
          invalidateTableMetadataCache(object);
          await invalidateObjectMetadataCache(object);
          if (!sameTarget() || !connectionCurrent()) return false;
          await invalidateObjectDdl(object);
          if (!sameTarget() || !connectionCurrent()) return false;
        }
      } catch (error) {
        refreshError = error instanceof Error ? error.message : String(error);
      }
    }
    if (sameTarget() && connectionCurrent()) {
      existingOracleForeignKeyPlan.value = undefined;
      existingOracleForeignKeySession.value = undefined;
      pendingStatements.value = [];
      if (completed && !result.readbackError && !refreshError) {
        oracleForeignKeyCreateRecovery.value = undefined;
        loadedMetadataFacets.clear();
        ddlFetched.value = false;
        rawDdlContent.value = "";
        const refresh = await loadStructure(true, { columns: false, indexes: false, constraints: false, foreignKeys: true, triggers: false, partitions: false, tableComment: false }, true, { forceMetadata: true, blockSecondaryMetadata: true });
        if (!sameTarget() || !connectionCurrent()) return false;
        if (refresh?.error) refreshError = refresh.error;
        if (!refreshError && sameTarget()) emit("saved", false);
        syncDraftToParent();
      } else {
        warnings.value = [t("oracleForeignKey.refreshRequired")];
      }
      syncDraftToParent();
    }
    if (!sameTarget() || !connectionCurrent()) return false;
    const readbackError = [result.readbackError, refreshError].filter(Boolean).join("\n");
    const succeeded = completed && !readbackError;
    if (succeeded) toast(t("structureEditor.saved"), 2500);
    if (readbackError) details += `\n\n${t("oracleForeignKey.readbackFailed")}: ${readbackError}`;
    if (!succeeded || result.recoverySql?.length) {
      primaryKeyResultTitle.value = "oracleForeignKey.resultTitle";
      primaryKeyResultMessage.value = `${plan.target.schema}.${plan.target.tableName}: ${t(succeeded ? "structureEditor.saved" : "oracleForeignKey.executionFailed")}`;
      primaryKeyResultDetails.value = details;
      if (!primaryKeyUnmounted) primaryKeyResultOpen.value = true;
      else toast(primaryKeyResultMessage.value, 10000);
    }
    return succeeded;
  } catch (error) {
    if (sameTarget() && connectionCurrent()) errorMessage.value = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    oracleForeignKeyBusy.value = false;
    saving.value = false;
  }
}

async function applyOracleConstraintPlan(): Promise<boolean> {
  if (oracleConstraintBusy.value || !oracleConstraintPlan.value || !oracleConstraintSession.value || !oracleConstraintDraft.value) return false;
  const plan = cloneDraftValue(oracleConstraintPlan.value);
  const session = oracleConstraintSession.value;
  const draft = JSON.stringify(oracleConstraintDraft.value);
  const connection = store.getConfig(plan.target.connectionId);
  const sameTarget = () => !primaryKeyUnmounted && JSON.stringify(oracleConstraintTarget()) === JSON.stringify(plan.target);
  const connectionCurrent = () =>
    store.connectionStateRevision(plan.target.connectionId) === session.revision &&
    store.isCurrentConnectionStateRevision(plan.target.connectionId, session.revision) &&
    (store.getConfig(plan.target.connectionId) ? connectionConfigFingerprint(store.getConfig(plan.target.connectionId)!) : "") === session.configFingerprint;
  const canStart = () => sameTarget() && draft === JSON.stringify(oracleConstraintDraft.value) && !hasPendingStructureChanges(false, false) && !ddlDirty.value;
  const stillCurrent = () => canStart() && connectionCurrent();
  if (!stillCurrent() || session.draftFingerprint !== draft) return false;
  oracleConstraintBusy.value = true;
  saving.value = true;
  const startedAt = Date.now();
  try {
    const protection = productionContextForDatabase(connection, plan.target.database);
    if (protection.active) {
      const accepted = await productionSafetyStore.requestConfirmation({
        sql: plan.statements.join("\n"),
        connectionName: connection?.name,
        database: plan.target.database,
        productionDatabases: protection.databases,
        source: t("production.sourceStructure"),
        scopeId: oracleConstraintConfirmationScope,
      });
      if (!accepted || !stillCurrent()) return false;
    }
    const timeout = queryTimeoutSecsForConnection(connection, settingsStore.editorSettings.globalQueryTimeoutSecs);
    const result = await executeOracleConstraintPlan(plan, timeout, { canStart, connectionCurrent });
    if (!result) return false;
    const completed = result.steps.length > 0 && result.steps.every((step) => step.state === "committed") && !result.readbackError;
    for (const step of result.steps.filter((item) => item.state !== "notExecuted")) {
      try {
        await historyStore.add({
          connection_id: plan.target.connectionId,
          connection_name: connection?.name || "",
          database: plan.target.database,
          sql: step.sql,
          execution_time_ms: Date.now() - startedAt,
          success: step.state === "committed",
          error: step.state === "committed" ? undefined : `${step.state}: ${step.error || ""}`,
          activity_kind: "schema_change",
          operation: "ALTER TABLE",
          target: plan.target.tableName,
        });
      } catch (error) {
        console.warn("[DBX][structure-history:save-failed]", error);
      }
    }
    if (!sameTarget() || !connectionCurrent()) return false;
    if (result.steps.some((step) => step.state !== "notExecuted")) {
      invalidateTableMetadataCache(plan.target);
      await invalidateObjectMetadataCache(plan.target);
      if (!sameTarget() || !connectionCurrent()) return false;
      await invalidateObjectDdl(plan.target);
      if (!sameTarget() || !connectionCurrent()) return false;
      loadedMetadataFacets.clear();
    }
    if (sameTarget() && connectionCurrent()) {
      oracleConstraintPlan.value = undefined;
      oracleConstraintSession.value = undefined;
      pendingStatements.value = [];
      if (completed) {
        const refresh = await loadStructure(true, { columns: false, indexes: true, constraints: true, foreignKeys: false, triggers: false, partitions: false, tableComment: false }, true, { forceMetadata: true, blockSecondaryMetadata: true, preserveDraft: true });
        if (!sameTarget() || !connectionCurrent()) return false;
        if (refresh?.error) result.readbackError = refresh.error;
        oracleConstraintDraft.value = undefined;
        if (!result.readbackError) {
          syncDraftToParent();
          emit("saved", false);
          toast(t("structureEditor.saved"), 2500);
        }
      }
    }
    if (!completed || result.readbackError) {
      primaryKeyResultTitle.value = "oracleStructureResult.resultTitle";
      primaryKeyResultMessage.value = `${plan.target.schema}.${plan.target.tableName}: ${result.readbackError || t("oracleStructureResult.executionFailed")}`;
      primaryKeyResultDetails.value = result.steps.map((step, index) => `${index + 1}. ${step.state}\n${step.sql}${step.error ? `\n${step.error}` : ""}`).join("\n\n");
      if (result.recoverySql) primaryKeyResultDetails.value += `\n\n${t("oracleStructureResult.recoveryNotice")}\n${result.recoverySql}`;
      if (!primaryKeyUnmounted) primaryKeyResultOpen.value = true;
    }
    return completed && !result.readbackError;
  } catch (error) {
    if (sameTarget() && connectionCurrent()) errorMessage.value = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    oracleConstraintBusy.value = false;
    saving.value = false;
  }
}

function oracleIndexOnlyChange(): boolean {
  if (isCreateMode.value || ddlDirty.value || oracleConstraintChanged.value || existingPrimaryKeyChanged.value) return false;
  const scope = captureStructureRefreshScope();
  if (!scope.indexes || scope.columns || scope.foreignKeys || scope.triggers || scope.tableComment || partitionOperations.value.length) return false;
  return pendingStatements.value.length > 0 && pendingStatements.value.every((sql) => /^\s*(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX)\b/i.test(sql));
}

async function applyOracleIndexPlan(): Promise<boolean> {
  const target = oracleConstraintTarget();
  const statements = [...pendingStatements.value];
  const draftFingerprint = JSON.stringify(indexes.value);
  const columnsFingerprint = JSON.stringify(columns.value);
  const baseline = oracleIndexReady.value;
  const connectionAtStart = store.getConfig(target.connectionId);
  const revision = store.connectionStateRevision(target.connectionId);
  const configFingerprint = connectionAtStart ? connectionConfigFingerprint(connectionAtStart) : "";
  if (!baseline || baseline.epoch !== oracleIndexEpoch.value || baseline.targetIdentity !== oracleIndexTargetIdentity(target) || baseline.connectionRevision !== revision || baseline.configFingerprint !== configFingerprint || baseline.columnsFingerprint !== columnsFingerprint) {
    errorMessage.value = "Index metadata is not ready for a safe save. Refresh the complete table structure and preview again.";
    return false;
  }
  const saveSessionCurrent = () =>
    !primaryKeyUnmounted &&
    JSON.stringify(target) === JSON.stringify(oracleConstraintTarget()) &&
    JSON.stringify(statements) === JSON.stringify(pendingStatements.value) &&
    draftFingerprint === JSON.stringify(indexes.value) &&
    columnsFingerprint === JSON.stringify(columns.value) &&
    oracleIndexOnlyChange() &&
    store.connectionStateRevision(target.connectionId) === revision &&
    store.isCurrentConnectionStateRevision(target.connectionId, revision) &&
    (store.getConfig(target.connectionId) ? connectionConfigFingerprint(store.getConfig(target.connectionId)!) : "") === configFingerprint;
  const stillCurrent = () => saveSessionCurrent() && oracleIndexReady.value === baseline && oracleIndexEpoch.value === baseline.epoch;
  if (oracleIndexBusy.value || !oracleIndexOnlyChange() || !stillCurrent()) return false;
  oracleIndexBusy.value = true;
  saving.value = true;
  const startedAt = Date.now();
  try {
    const plan = await prepareOracleIndexPlan(target, statements, cloneDraftValue(indexes.value), {
      baseline,
      columnsFingerprint,
      indexesFingerprint: baseline.indexesFingerprint,
    });
    if (!stillCurrent()) return false;
    oracleIndexPlan.value = plan;
    const protection = productionContextForDatabase(connectionAtStart, target.database);
    if (protection.active) {
      const accepted = await productionSafetyStore.requestConfirmation({
        sql: statements.join("\n"),
        connectionName: connectionAtStart?.name,
        database: target.database,
        productionDatabases: protection.databases,
        source: t("production.sourceStructure"),
        scopeId: oracleIndexConfirmationScope,
      });
      if (!accepted || !stillCurrent()) return false;
    }
    const timeout = queryTimeoutSecsForConnection(connectionAtStart, settingsStore.editorSettings.globalQueryTimeoutSecs);
    const result = await executeOracleIndexPlan(plan, timeout, stillCurrent);
    if (!result) return false;
    const attemptedSteps = result.steps.some((step) => step.state !== "notExecuted");
    if (attemptedSteps) invalidateOracleIndexReady();
    for (const step of result.steps.filter((item) => item.state !== "notExecuted")) {
      try {
        await historyStore.add({
          connection_id: target.connectionId,
          connection_name: connectionAtStart?.name || "",
          database: target.database,
          sql: step.sql,
          execution_time_ms: Date.now() - startedAt,
          success: step.state === "committed",
          error: step.state === "committed" ? undefined : `${step.state}: ${step.error || ""}`,
          activity_kind: "schema_change",
          operation: step.sql.startsWith("CREATE") ? "CREATE INDEX" : "DROP INDEX",
          target: target.tableName,
        });
      } catch (error) {
        console.warn("[DBX][structure-history:save-failed]", error);
      }
    }
    const complete = result.steps.length > 0 && result.steps.every((step) => step.state === "committed") && !result.readbackError;
    let refreshError = "";
    const contextStillCurrent = () =>
      !primaryKeyUnmounted &&
      JSON.stringify(target) === JSON.stringify(oracleConstraintTarget()) &&
      store.connectionStateRevision(target.connectionId) === revision &&
      (store.getConfig(target.connectionId) ? connectionConfigFingerprint(store.getConfig(target.connectionId)!) : "") === configFingerprint;
    if (attemptedSteps) {
      const completedCreates = plan.mutations.flatMap((mutation, index) => {
        if (mutation.operation !== "CREATE" || result.steps[index]?.state !== "committed") return [];
        const created = mutation.expectedAfter.find((item) => item.name === mutation.name);
        return created ? [created] : [];
      });
      const recovery = { target: oracleIndexTargetIdentity(target), afterRequestId: structureLoadRequestId, completedCreates };
      if (contextStillCurrent()) {
        oracleIndexRefreshGuard.value = recovery;
        // Already attempted SQL is never left queued for another Apply.
        pendingStatements.value = [];
        oracleIndexPlan.value = undefined;
      }
      if (complete && contextStillCurrent()) {
        refreshError = await refreshOracleIndexMetadata(target, recovery);
      } else {
        refreshError = await refreshSchemaIndexLists(target);
        invalidateTableMetadataCache(target);
        try {
          await invalidateObjectDdlCache(target);
        } catch (error) {
          refreshError = [refreshError, error instanceof Error ? error.message : String(error)].filter(Boolean).join("\n");
        }
      }
      if (complete && contextStillCurrent()) {
        skipNextRefreshVersion = true;
        emit("saved", false);
        void nextTick(() => {
          skipNextRefreshVersion = false;
        });
      }
      if (contextStillCurrent()) syncDraftToParent();
    }
    if ((!complete || refreshError) && !primaryKeyUnmounted) {
      primaryKeyResultTitle.value = "oracleStructureResult.resultTitle";
      primaryKeyResultMessage.value = `${target.schema}.${target.tableName}: ${t(complete ? "oracleStructureResult.appliedRefreshPending" : "oracleStructureResult.executionFailed")}`;
      primaryKeyResultDetails.value = result.steps.map((step, index) => `${index + 1}. ${step.state}\n${step.sql}${step.error ? `\n${step.error}` : ""}`).join("\n\n");
      if (result.readbackError) primaryKeyResultDetails.value += `\n\n${t("oracleStructureResult.readbackFailed")}: ${result.readbackError}`;
      if (refreshError) primaryKeyResultDetails.value += `\n\n${t("oracleStructureResult.refreshPending")}: ${refreshError}`;
      if (!primaryKeyUnmounted) primaryKeyResultOpen.value = true;
    }
    return complete;
  } catch (error) {
    if (saveSessionCurrent()) {
      pendingStatements.value = [];
      oracleIndexPlan.value = undefined;
      errorMessage.value = error instanceof Error ? error.message : String(error);
    }
    return false;
  } finally {
    oracleIndexBusy.value = false;
    saving.value = false;
  }
}

async function refreshSchemaIndexLists(target: Pick<StructureDdlRequest, "connectionId" | "database" | "schema" | "catalog">): Promise<string> {
  const scope = { connectionId: target.connectionId, database: target.database, schema: target.schema, catalog: target.catalog };
  invalidateObjectBrowserRowsCache({ connectionId: target.connectionId, database: target.database, schema: target.schema });
  let error = "";
  try {
    await store.refreshObjectListTreeNode(target.connectionId, target.database, target.schema, target.catalog, true);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  window.dispatchEvent(new CustomEvent("dbx-refresh-object-browser", { detail: scope }));
  return error;
}

async function refreshOracleIndexMetadata(target: OracleConstraintTarget, recovery: NonNullable<typeof oracleIndexRefreshGuard.value>): Promise<string> {
  const revision = store.connectionStateRevision(target.connectionId);
  const config = store.getConfig(target.connectionId);
  const fingerprint = config ? connectionConfigFingerprint(config) : "";
  const current = () =>
    !primaryKeyUnmounted && recovery.target === oracleIndexTargetIdentity(oracleConstraintTarget()) && store.connectionStateRevision(target.connectionId) === revision && (store.getConfig(target.connectionId) ? connectionConfigFingerprint(store.getConfig(target.connectionId)!) : "") === fingerprint;
  const errors: string[] = [];
  try {
    invalidateTableMetadataCache(target);
    await invalidateObjectDdlCache(target, { strict: true });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const listError = await refreshSchemaIndexLists(target);
  if (listError) errors.push(listError);
  if (!current()) return errors.join("\n");
  const expectedRequestId = structureLoadRequestId + 1;
  loadedMetadataFacets.clear();
  const refresh = await loadStructure(true, { columns: false, indexes: true, constraints: false, foreignKeys: false, triggers: false, partitions: false, tableComment: true }, true, { forceMetadata: true, blockSecondaryMetadata: true, preserveDraft: true });
  if (!current()) return errors.join("\n");
  const baseline = oracleIndexReady.value;
  if (
    !baseline ||
    baseline.requestId !== structureLoadRequestId ||
    baseline.requestId < expectedRequestId ||
    baseline.epoch !== oracleIndexEpoch.value ||
    baseline.targetIdentity !== recovery.target ||
    baseline.connectionRevision !== revision ||
    baseline.configFingerprint !== fingerprint ||
    secondaryMetadataErrors.value.indexes ||
    errorMessage.value ||
    (structureCapabilities.value.comment && !loadedMetadataFacets.has("comment"))
  ) {
    errors.push(refresh?.error || secondaryMetadataErrors.value.indexes || errorMessage.value || "Index refresh did not publish a current complete baseline after DDL.");
  }
  oracleIndexRefreshError.value = errors.join("\n");
  oracleIndexRefreshGuard.value = errors.length ? recovery : undefined;
  if (errors.length) errorMessage.value = "";
  markDraftHydratedAndSync();
  await refreshSqlPreview();
  return oracleIndexRefreshError.value;
}

async function retryOracleIndexRefresh() {
  const recovery = oracleIndexRefreshGuard.value;
  if (!recovery || recovery.target !== oracleIndexTargetIdentity(oracleConstraintTarget()) || saving.value || postSaveRefreshing.value) return;
  postSaveRefreshing.value = true;
  try {
    await refreshOracleIndexMetadata(oracleConstraintTarget(), recovery);
  } finally {
    postSaveRefreshing.value = false;
  }
}

async function applyOracleForeignKeyCreatePlan(): Promise<boolean> {
  if (oracleForeignKeyBusy.value || !newOracleForeignKeyPlan.value || !newOracleForeignKeySession.value) return false;
  const plan = cloneDraftValue(newOracleForeignKeyPlan.value);
  const plannedSession = newOracleForeignKeySession.value;
  const identity = JSON.stringify(plan.target);
  const changes = JSON.stringify(oracleForeignKeyChanges());
  const connectionAtStart = store.getConfig(plan.target.connectionId);
  const sameTarget = () => !primaryKeyUnmounted && identity === JSON.stringify({ ...primaryKeyTarget(), schema: metadataSchema.value, tableName: newTableName.value.trim(), databaseType: plan.target.databaseType });
  const connectionCurrent = () =>
    store.connectionStateRevision(plan.target.connectionId) === plannedSession.revision &&
    store.isCurrentConnectionStateRevision(plan.target.connectionId, plannedSession.revision) &&
    (store.getConfig(plan.target.connectionId) ? connectionConfigFingerprint(store.getConfig(plan.target.connectionId)!) : "") === plannedSession.configFingerprint;
  const currentOptions = () => ({ ...structureChangeOptions(), schema: metadataSchema.value, tableName: newTableName.value.trim(), foreignKeys: [], oracleForeignKeyChanges: oracleForeignKeyChanges() });
  const currentPartitioning = () => (createPartitioningEnabled.value ? { kind: createPartitioningKind.value, columns: createPartitioningColumns.value, expression: createPartitioningExpression.value } : undefined);
  const canStart = () => sameTarget() && changes === JSON.stringify(oracleForeignKeyChanges()) && JSON.stringify({ options: currentOptions(), changes: oracleForeignKeyChanges(), partitioning: currentPartitioning() }) === plannedSession.draftFingerprint && isCreateMode.value;
  const stillCurrent = () => canStart() && connectionCurrent();
  if (!stillCurrent()) return false;
  if (triggerStructurePlan.value)
    return applyTriggerStructure({
      preflight: async () => {
        if (!(await preflightOracleForeignKeyCreatePlan(plan, canStart, connectionCurrent))) throw new Error(t("oracleForeignKey.refreshRequired"));
      },
      readback: async (steps) => {
        const read = await readOracleForeignKeyCreateResult(plan, steps, connectionCurrent);
        if (read.readbackError) throw new Error(read.readbackError);
      },
    });
  oracleForeignKeyBusy.value = true;
  saving.value = true;
  const startedAt = Date.now();
  try {
    const protection = productionContextForDatabase(connectionAtStart, plan.target.database);
    if (protection.active) {
      const accepted = await productionSafetyStore.requestConfirmation({
        sql: plan.statements.join("\n"),
        connectionName: connectionAtStart?.name,
        database: plan.target.database,
        productionDatabases: protection.databases,
        source: t("production.sourceStructure"),
        scopeId: oracleForeignKeyConfirmationScope,
      });
      if (!accepted || !stillCurrent()) return false;
    }
    const timeout = queryTimeoutSecsForConnection(connectionAtStart, settingsStore.editorSettings.globalQueryTimeoutSecs);
    const result = await executeOracleForeignKeyCreatePlan(plan, timeout, { canStart, connectionCurrent });
    if (!result) return false;
    for (const step of result.steps.filter((item) => item.state !== "notExecuted")) {
      try {
        await historyStore.add({
          connection_id: plan.target.connectionId,
          connection_name: connectionAtStart?.name || "",
          database: plan.target.database,
          sql: step.sql,
          execution_time_ms: Date.now() - startedAt,
          success: step.state === "committed",
          error: step.state === "committed" ? undefined : `${t(`oceanbasePrimaryKey.${step.state}`)}: ${step.error || ""}`,
          activity_kind: "schema_change",
          operation: step.sql.startsWith("CREATE ") ? "CREATE TABLE" : "ALTER TABLE",
          target: plan.target.tableName,
        });
      } catch (error) {
        console.warn("[DBX][structure-history:save-failed]", error);
      }
    }
    if (!connectionCurrent()) return false;
    const created = result.steps[0]?.state === "committed" || result.tableExists === true;
    const issues = [
      ...result.steps.filter((step) => step.state === "rejected" || step.state === "unknown").map((step) => `${step.state}: ${step.error || step.sql}`),
      ...(result.readbackError ? [result.readbackError] : []),
      ...(result.steps.some((step) => step.state === "notExecuted") ? [t("oracleForeignKey.executionFailed")] : []),
    ];
    if (created) {
      const stepDetails = result.steps.map((step, index) => `${index + 1}. ${t(`oceanbasePrimaryKey.${step.state}`)}: ${step.sql}${step.error ? `\n${step.error}` : ""}`).join("\n");
      const details = [
        t("oracleForeignKey.createdTablePartial"),
        `${plan.target.schema}.${foldCreatedTableName(plan.target.tableName, plan.target.databaseType)}`,
        stepDetails,
        ...(result.readbackError ? [`${t("oracleForeignKey.readbackFailed")}: ${result.readbackError}`] : []),
        ...(issues.length ? [t("oracleForeignKey.createRecoveryNotice")] : []),
      ]
        .filter(Boolean)
        .join("\n\n");
      const createdName = foldCreatedTableName(plan.target.tableName, plan.target.databaseType);
      for (const object of [{ ...plan.target, tableName: createdName }, ...plan.changes.map((change) => ({ ...plan.target, schema: change.target!.refSchema, tableName: change.target!.refTable }))]) {
        invalidateTableMetadataCache(object);
        await invalidateObjectMetadataCache(object);
        await invalidateObjectDdl(object);
      }
      if (!sameTarget()) {
        toast(`${t("oracleForeignKey.executionFailed")}\n${details}`, 10000);
        return false;
      }
      if (!connectionCurrent()) return false;
      newOracleForeignKeyPlan.value = undefined;
      newOracleForeignKeySession.value = undefined;
      pendingStatements.value = [];
      warnings.value = [];
      const fkSteps = result.steps.filter((step) => step.sql.includes("FOREIGN KEY"));
      const sameDefinition = (actual: NonNullable<(typeof plan.changes)[number]["target"]>, expected: NonNullable<(typeof plan.changes)[number]["target"]>) => {
        const fold = (name: string) => (plan.target.databaseType === "oracle" ? foldCreatedTableName(name, plan.target.databaseType) : name);
        const selfReference = fold(expected.refSchema) === fold(plan.target.schema) && fold(expected.refTable) === fold(plan.target.tableName);
        return (
          JSON.stringify(actual) ===
          JSON.stringify({
            ...expected,
            name: fold(expected.name),
            columns: expected.columns.map(fold),
            ...(selfReference ? { refSchema: fold(expected.refSchema), refTable: fold(expected.refTable), refColumns: expected.refColumns.map(fold) } : {}),
          })
        );
      };
      const remaining = plan.changes.flatMap((change, index) => {
        const step = fkSteps[index];
        const target = change.target!;
        const exists = result.readbackDefinitions?.some((definition) => sameDefinition(definition, target));
        if (exists || (step?.state !== "rejected" && step?.state !== "notExecuted")) return [];
        const fold = (name: string) => foldCreatedTableName(name, plan.target.databaseType);
        const selfReference = fold(target.refSchema) === fold(plan.target.schema) && fold(target.refTable) === fold(plan.target.tableName);
        return [
          {
            ...target,
            name: fold(target.name),
            columns: target.columns.map(fold),
            ...(selfReference ? { refSchema: fold(target.refSchema), refTable: fold(target.refTable), refColumns: target.refColumns.map(fold) } : {}),
          },
        ];
      });
      const uncertainSteps = result.steps.filter((step) => step.state === "unknown").map((step) => (step.sql.startsWith("CREATE TABLE") ? "CREATE" : step.sql));
      if (issues.length) {
        const recovery = { tableName: createdName, tableExists: true, details, remaining, uncertainSteps };
        oracleForeignKeyCreateRecovery.value = recovery;
        const recoveryDraft = {
          ...createCurrentDraft(),
          dirty: remaining.length > 0,
          activeTab: "foreignKeys" as TableStructureEditorDraft["activeTab"],
          newTableName: "",
          tableComment: tableComment.value,
          originalTableComment: tableComment.value,
          columns: [],
          indexes: [],
          foreignKeys: [],
          constraints: [],
          constraintsLoaded: false,
          triggers: [],
          triggersLoaded: false,
          partitionOperations: [],
          createPartitioningEnabled: false,
          createPartitioningColumns: [],
          createPartitioningExpression: "",
          loadedMetadataFacets: [],
          existingPrimaryKey: undefined,
          oracleConstraintChange: undefined,
          oracleForeignKeyCreateRecovery: recovery,
          ddlDraft: null,
        } satisfies TableStructureEditorDraft;
        emitDraftToParent(recoveryDraft);
        emit("saved", false, createdName);
        primaryKeyResultDetails.value = details;
        primaryKeyResultTitle.value = "oracleForeignKey.resultTitle";
        primaryKeyResultMessage.value = `${plan.target.schema}.${createdName}: ${t("oracleForeignKey.createdTablePartial")}`;
        if (!primaryKeyUnmounted) primaryKeyResultOpen.value = true;
        else toast(`${primaryKeyResultMessage.value}\n${details}`, 10000);
        return false;
      }
      primaryKeyResultDetails.value = details;
      oracleForeignKeyCreateRecovery.value = undefined;
      clearDraft();
      emit("saved", tableComment.value !== originalTableComment.value, createdName);
      toast(t("structureEditor.created"), 2500);
      return issues.length === 0;
    }
    if (sameTarget() && connectionCurrent()) {
      errorMessage.value = issues.join("\n") || t("oracleForeignKey.executionFailed");
      newOracleForeignKeyPlan.value = undefined;
      newOracleForeignKeySession.value = undefined;
      pendingStatements.value = [];
      if (result.steps[0]?.state === "unknown") {
        const recovery = {
          tableName: foldCreatedTableName(plan.target.tableName, plan.target.databaseType),
          tableExists: false,
          details: [...issues, ...result.steps.map((step) => `${step.state}: ${step.sql}${step.error ? `\n${step.error}` : ""}`)].join("\n\n"),
          remaining: [],
          uncertainSteps: ["CREATE"],
        };
        oracleForeignKeyCreateRecovery.value = recovery;
        emitDraftToParent({ ...createCurrentDraft(), oracleForeignKeyCreateRecovery: recovery });
        primaryKeyResultTitle.value = "oracleForeignKey.resultTitle";
        primaryKeyResultMessage.value = `${plan.target.schema}.${recovery.tableName}: ${t("oracleForeignKey.readbackFailed")}`;
        primaryKeyResultDetails.value = recovery.details;
        primaryKeyResultOpen.value = true;
      }
    }
    return false;
  } catch (error) {
    if (sameTarget() && connectionCurrent()) errorMessage.value = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    oracleForeignKeyBusy.value = false;
    saving.value = false;
  }
}

async function reconcileTriggerStructure(): Promise<void> {
  const recovery = triggerStructureRecovery.value;
  if (!recovery || saving.value || !window.confirm(t("oracleTrigger.reconcileConfirm"))) return;
  const key = triggerStructureKey();
  const draft = createCurrentDraft();
  const fingerprint = JSON.stringify(structureChangeOptions());
  const target = recovery.target;
  const config = store.getConfig(target.connectionId);
  const revision = store.connectionStateRevision(target.connectionId);
  const configFingerprint = config ? connectionConfigFingerprint(config) : "";
  const current = () =>
    key === triggerStructureKey() &&
    !primaryKeyUnmounted &&
    fingerprint === JSON.stringify(structureChangeOptions()) &&
    store.isCurrentConnectionStateRevision(target.connectionId, revision) &&
    store.connectionStateRevision(target.connectionId) === revision &&
    (store.getConfig(target.connectionId) ? connectionConfigFingerprint(store.getConfig(target.connectionId)!) : "") === configFingerprint;
  const changed = {
    columns: new Set(columns.value.filter(columnChanged).map((item) => item.id)),
    indexes: new Set(indexes.value.filter(indexChanged).map((item) => item.id)),
    foreignKeys: new Set(foreignKeys.value.filter(foreignKeyChanged).map((item) => item.id)),
    triggers: new Set(triggers.value.filter(triggerChanged).map((item) => item.id)),
  };
  saving.value = true;
  try {
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const identity = await api.executeQuery(
      target.connectionId,
      target.database,
      `SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, TO_CHAR(OBJECT_ID) AS OBJECT_ID FROM ALL_OBJECTS WHERE OWNER = ${literal(target.owner)} AND OBJECT_NAME = ${literal(target.tableName)} AND OBJECT_TYPE = ${literal(target.parentType)}`,
      target.executionSchema,
      undefined,
      { catalog: target.catalog, maxRows: 2 },
    );
    if (identity.execution_error || identity.truncated || identity.has_more || identity.rows.length > 1) throw new Error(identity.error?.detail || t("oracleTrigger.reloadBaseline"));
    if (!identity.rows.length && target.newTable) {
      // A newly confirmed plain CREATE can be prepared again only after this explicit read.
      if (!current()) return;
      triggerStructureRecovery.value = undefined;
      syncDraftToParent();
      scheduleSqlPreviewRefresh();
      return;
    }
    const row = identity.rows[0];
    if (row?.length !== 4 || row[0] !== target.owner || row[1] !== target.tableName || row[2] !== target.parentType || typeof row[3] !== "string" || !row[3]) throw new Error(t("oracleTrigger.reloadBaseline"));
    const [nextColumns, nextIndexes, nextKeys, nextTriggers, nextConstraints, nextComment] = await Promise.all([
      changed.columns.size || target.newTable ? api.getColumns(target.connectionId, target.database, target.owner, target.tableName, target.catalog) : Promise.resolve(draft.columns.flatMap((item) => (item.original ? [item.original] : []))),
      changed.indexes.size || (target.newTable && draft.indexes.length) ? api.listIndexes(target.connectionId, target.database, target.owner, target.tableName, target.catalog) : Promise.resolve(draft.indexes.flatMap((item) => (item.original ? [item.original] : []))),
      changed.foreignKeys.size || (target.newTable && draft.foreignKeys.length) ? api.listForeignKeys(target.connectionId, target.database, target.owner, target.tableName, target.catalog) : Promise.resolve(draft.foreignKeys.flatMap((item) => (item.original ? [item.original] : []))),
      api.listTriggers(target.connectionId, target.database, target.owner, target.tableName, target.catalog, { identityMode: "exact" }),
      changed.columns.size && draft.constraintsLoaded ? api.listConstraints(target.connectionId, target.database, target.owner, target.tableName, target.catalog) : Promise.resolve(draft.constraints ?? []),
      target.newTable || draft.tableComment !== draft.originalTableComment ? api.getTableComment(target.connectionId, target.database, target.owner, target.tableName, target.catalog) : Promise.resolve(draft.originalTableComment),
    ]);
    if (nextTriggers.some((trigger) => !exactOracleTriggerMetadata(trigger))) throw new Error(t("oracleTrigger.reloadBaseline"));
    for (const trigger of draft.triggers.filter((item) => item.markedForDrop && item.original && !nextTriggers.some((next) => next.oracle_metadata?.owner === item.original!.oracle_metadata?.owner && next.name === item.original!.name))) {
      const metadata = exactOracleTriggerMetadata(trigger.original);
      if (metadata) await verifyOracleTriggerDeletion({ connectionId: target.connectionId, database: target.database, catalog: target.catalog, owner: metadata.owner, name: metadata.name, executionSchema: target.executionSchema });
    }
    if (!current()) return;
    const next = reconcileOracleTriggerStructureDraft(draft, { columns: nextColumns, indexes: nextIndexes, foreignKeys: nextKeys, triggers: nextTriggers, constraints: nextConstraints, comment: nextComment ?? "" }, changed, target.databaseType);
    for (const trigger of next.triggers.filter((item) => changed.triggers.has(item.id) && item.original)) {
      const metadata = exactOracleTriggerMetadata(trigger.original);
      if (!metadata) throw new Error(t("oracleTrigger.reloadBaseline"));
      const loaded = await readOracleTriggerSource({ connectionId: target.connectionId, database: target.database, catalog: target.catalog, owner: metadata.owner, name: metadata.name, executionSchema: target.executionSchema });
      if (!loaded.snapshot?.exists || loaded.snapshot.metadata.objectId !== metadata.objectId || loaded.snapshot.raw.trigger?.statement !== trigger.original!.statement || loaded.snapshot.raw.trigger?.enabled !== trigger.original!.enabled) throw new Error(t("oracleTrigger.reloadBaseline"));
      const inspected = await inspectExactOracleTriggerSource(loaded.snapshot.raw, metadata.owner, metadata.name);
      trigger.loadedOracleSource = loaded.snapshot.raw.source;
      trigger.loadedOracleStructured = inspected.triggerSource.complete && inspected.triggerSource.prepared?.structuredEditable === true;
    }
    if (!current()) return;
    restoreDraft(next);
    triggerSourceRefreshRequired.value.clear();
    errorMessage.value = "";
    syncDraftToParent();
    if (target.newTable) {
      emitDraftToParent({ ...next, newTableName: "" });
      emit("saved", false, target.tableName);
    } else scheduleSqlPreviewRefresh();
  } catch (error) {
    if (key === triggerStructureKey()) errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}

async function applyTriggerStructure(validation?: { preflight: () => Promise<void>; readback: (steps: OracleForeignKeyCreateExecutionResult["steps"]) => Promise<void> }): Promise<boolean> {
  const plan = triggerStructurePlan.value;
  if (!plan || triggerStructureRecovery.value) return false;
  const targetKey = triggerStructureKey();
  const originTabId = props.originTabId;
  const fingerprint = triggerStructureFingerprint;
  const current = () => !primaryKeyUnmounted && triggerStructureActive.value && targetKey === triggerStructureKey() && fingerprint === JSON.stringify(structureChangeOptions());
  const danger = useSqlExecutionDangerStore();
  const scopeId = `structure-trigger:${uuid()}`;
  triggerStructureConfirmationScope = scopeId;
  const stop = watch(
    current,
    (value) => {
      if (!value) cancelTriggerStructureConfirmation();
    },
    { flush: "sync" },
  );
  const started = Date.now();
  const submittedDraft = createCurrentDraft();
  const refreshScope = captureStructureRefreshScope();
  saving.value = true;
  try {
    const confirmed =
      current() &&
      (await danger.requestConfirmation({
        sql: plan.statements.join("\n\n"),
        kind: "sql",
        scopeId,
        connectionName: connection.value?.name,
        database: plan.target.database,
        databaseType: plan.target.databaseType,
        targets: [
          `${plan.target.owner}.${plan.target.tableName}`,
          ...plan.groups.map((group) => `TRIGGER ${group.operation.owner}.${group.operation.name}`),
          `${t("oracleTrigger.executionSchema")}: ${plan.target.executionSchema}`,
          ...(plan.statements.length > 1 ? [t("oracleTrigger.nonAtomic")] : []),
        ],
      }));
    const result = await executeOracleTriggerStructurePlan(plan, {
      confirmed,
      confirmationScope: scopeId,
      isCurrent: current,
      timeoutSecs: queryTimeoutSecsForConnection(store.getConfig(plan.target.connectionId), settingsStore.editorSettings.globalQueryTimeoutSecs),
      preflight: validation?.preflight,
    });
    if (result.cancelled) return false;
    let complete = result.steps.every((step) => step.state === "committed" && step.trigger?.verification !== "invalid");
    let details = result.steps.map((step) => `${step.statementIndex + 1}. ${step.state}: ${step.sql}${step.error ? `\n${step.error}` : ""}`).join("\n\n");
    // Preserve the submitted draft and attempted indexes before any refresh or UI navigation.
    if (result.steps.some((step) => step.state !== "notExecuted")) {
      const recovery = { target: { ...plan.target }, steps: cloneDraftValue(result.steps), details };
      if (targetKey === triggerStructureKey()) triggerStructureRecovery.value = recovery;
      emitDraftToParent({ ...(targetKey === triggerStructureKey() ? createCurrentDraft() : submittedDraft), dirty: true, oracleTriggerStructureRecovery: recovery }, originTabId);
      if (targetKey !== triggerStructureKey()) toast(`${plan.target.owner}.${plan.target.tableName}\n${details}`, 10000);
    }
    if (complete && validation) {
      try {
        await validation.readback(result.steps);
      } catch (error) {
        complete = false;
        details += `\n\n${error instanceof Error ? error.message : String(error)}`;
        if (targetKey === triggerStructureKey() && triggerStructureRecovery.value) {
          triggerStructureRecovery.value.details = details;
          syncDraftToParent();
        }
      }
    }
    await recordStructureHistory(plan.statements.join("\n\n"), started, complete, undefined, complete ? undefined : details);
    if (targetKey !== triggerStructureKey()) return false;
    if (!complete || !current()) {
      errorMessage.value = t("oracleTrigger.reloadBaseline");
      primaryKeyResultDetails.value = details;
      primaryKeyResultTitle.value = "oracleStructureResult.resultTitle";
      primaryKeyResultMessage.value = `${plan.target.owner}.${plan.target.tableName}: ${t("oracleTrigger.reloadBaseline")}`;
      primaryKeyResultOpen.value = true;
      return false;
    }
    if (plan.target.newTable) {
      triggerStructureRecovery.value = undefined;
      clearDraft();
      emit("saved", tableComment.value !== originalTableComment.value, plan.target.tableName, originTabId);
    } else {
      const metadataMatch = { connectionId: plan.target.connectionId, database: plan.target.database, catalog: plan.target.catalog, schema: plan.target.owner, tableName: plan.target.tableName };
      invalidateTableMetadataCache(metadataMatch);
      await invalidateObjectMetadataCache(metadataMatch);
      await invalidateObjectDdl(metadataMatch);
      saving.value = false;
      postSaveRefreshing.value = true;
      skipNextRefreshVersion = true;
      emit("saved", tableComment.value !== originalTableComment.value, undefined, originTabId);
      const refresh = await loadStructure(true, refreshScope, false, { blockSecondaryMetadata: true });
      postSaveRefreshing.value = false;
      if (refresh?.error) {
        const recovery = triggerStructureRecovery.value;
        restoreDraft({ ...submittedDraft, dirty: true, oracleTriggerStructureRecovery: recovery });
        errorMessage.value = refresh.error;
        return false;
      }
      triggerStructureRecovery.value = undefined;
      syncDraftToParent();
    }
    toast(t(plan.target.newTable ? "structureEditor.created" : "structureEditor.saved"), 4000);
    return true;
  } catch (error) {
    if (targetKey === triggerStructureKey()) errorMessage.value = error instanceof Error ? error.message : String(error);
    return false;
  } finally {
    stop();
    danger.cancelScope(scopeId);
    productionSafetyStore.cancelScope(scopeId);
    if (triggerStructureConfirmationScope === scopeId) triggerStructureConfirmationScope = undefined;
    saving.value = false;
  }
}

async function applyChanges() {
  const indexWriteWarning = schemaIndexWriteWarning();
  if (indexWriteWarning) {
    errorMessage.value = indexWriteWarning;
    return false;
  }
  if (!canApply.value || !props.connectionId || !props.database) return false;
  if (oracleIndexRefreshGuard.value?.target === oracleIndexTargetIdentity(oracleConstraintTarget())) {
    errorMessage.value = "Index execution may have changed the database. Refresh index metadata before applying again.";
    return false;
  }
  const oracleIndexMutation = !isCreateMode.value && (databaseType.value === "oracle" || databaseType.value === "oceanbase-oracle") && indexes.value.some(indexChanged);
  if (oracleIndexMutation && !oracleIndexOnlyChange()) {
    errorMessage.value = t("oracleIndex.mixedDraft");
    return false;
  }
  if (existingPrimaryKeyChanged.value) return applyExistingPrimaryKey();
  if (oracleConstraintPlan.value) return applyOracleConstraintPlan();
  if (oracleIndexMutation) return applyOracleIndexPlan();
  if (newOracleForeignKeyPlan.value) return applyOracleForeignKeyCreatePlan();
  if (existingOracleForeignKeyPlan.value) return applyOracleForeignKeyPlan();
  if (triggerSourceRefreshRequired.value.size) {
    errorMessage.value = t("oracleTrigger.reloadBaseline");
    return false;
  }
  // Layer B runtime guard: a stale `concurrently: true` whose availability is
  // no longer enabled must never be executed — reject the save with an
  // explicit error even if normalization was skipped (race / non-UI caller).
  const blockingConcurrentWarning = concurrentIndexBlockingWarning() ?? (concurrentAvailabilityInvalidated.value ? t("structureEditor.concurrentUnavailableBlocksSave") : null);
  if (blockingConcurrentWarning) {
    errorMessage.value = blockingConcurrentWarning;
    return false;
  }
  if (triggerStructureRecovery.value) {
    errorMessage.value = t("oracleTrigger.reloadBaseline");
    return false;
  }
  if (triggerStructurePlan.value) return applyTriggerStructure();
  const sql = previewSqlText.value;
  const submittedStarRocksTarget = starrocksStatusTarget.value;
  const connection = store.getConfig(props.connectionId);
  const exactTarget = props.exactIdentity ? ddlRequest() : undefined;
  const exactRevision = store.connectionStateRevision(props.connectionId);
  const exactConfig = connection ? connectionConfigFingerprint(connection) : "";
  const exactDraft = JSON.stringify(structureChangeOptions());
  const submittedStatements = [...pendingStatements.value];
  const exactContextCurrent = () =>
    !exactTarget ||
    (!primaryKeyUnmounted &&
      JSON.stringify(ddlRequest()) === JSON.stringify(exactTarget) &&
      store.connectionStateRevision(exactTarget.connectionId) === exactRevision &&
      (store.getConfig(exactTarget.connectionId) ? connectionConfigFingerprint(store.getConfig(exactTarget.connectionId)!) : "") === exactConfig);
  const exactDraftCurrent = () => exactContextCurrent() && (!exactTarget || (sql === previewSqlText.value && exactDraft === JSON.stringify(structureChangeOptions())));
  const productionContext = productionContextForDatabase(connection, props.database);
  if (productionContext.active) {
    const confirmed = await productionSafetyStore.requestConfirmation({
      sql,
      connectionName: connection?.name,
      database: props.database,
      productionDatabases: productionContext.databases,
      source: t("production.sourceStructure"),
    });
    if (!confirmed) return false;
  }
  if (!exactDraftCurrent()) return false;
  saving.value = true;
  if (databaseType.value === "starrocks") starrocksSubmittedSql.value = undefined;
  errorMessage.value = "";
  // A hand-written DDL script can change anything about the table, and the
  // structure draft it was applied from is clean, so the change-derived scope
  // would be empty: reload every facet instead of leaving the tabs stale.
  const refreshScope = ddlDirty.value ? { columns: true, indexes: true, foreignKeys: true, constraints: true, triggers: true, partitions: true, tableComment: true } : captureStructureRefreshScope();
  if (!ddlDirty.value && mysqlTableCharsetChanged.value) refreshScope.columns = true;
  const starrocksPhysicalOrderChanged = !ddlDirty.value && databaseType.value === "starrocks" && structureCapabilities.value.reorderColumn && columns.value.some((column, index) => column.original && column.originalPosition !== index);
  // Plan A guard: concurrent builds only run with a long-enough query timeout
  // (a cancelled build leaves an INVALID index behind), and are blocked
  // up-front when a same-name INVALID index already exists.
  const hasConcurrentIndexBuild = pendingStatements.value.some((statement) => statement.includes("CONCURRENTLY"));
  // Partition DDL (create parent + initial partitions, attach/detach/drop
  // chains, ...) must land atomically: a mid-batch failure would otherwise
  // leave a half-created hierarchy behind. CONCURRENTLY statements cannot run
  // inside a transaction block, so their presence keeps the batch on the
  // auto-commit path (the core also refuses that combination).
  const partitionDdlPending = partitionOperations.value.length > 0 || (isCreateMode.value && createPartitioningEnabled.value);
  const useTransaction = !hasConcurrentIndexBuild && partitionDdlPending;
  if (hasConcurrentIndexBuild && !isCreateMode.value && databaseType.value === "postgres" && props.tableName) {
    const concurrentIndexNames = concurrentIndexNamesInStatements(pendingStatements.value);
    if (concurrentIndexNames.length > 0) {
      try {
        const invalidIndexes = await api.listInvalidIndexes(props.connectionId, props.database, metadataSchema.value, props.tableName);
        const blocked = concurrentIndexNames.filter((name) => invalidIndexes.includes(name));
        if (blocked.length > 0) {
          errorMessage.value = t("structureEditor.invalidIndexBlocksSave", { indexNames: blocked.join(", ") });
          saving.value = false;
          return false;
        }
      } catch {
        // Metadata probe failure must not block the save; the failure-time
        // hint below still surfaces leftovers if the build errors out.
      }
    }
  }
  const characterLengthUnitsAfterSave = new Map<string, string>();
  if (supportsCharacterLengthUnits.value) {
    for (const column of columns.value) {
      if (!column.markedForDrop && dataTypeLengthUnitValue(databaseType.value, column.dataType)) {
        characterLengthUnitsAfterSave.set(column.name.trim().toLowerCase(), column.dataType);
      }
    }
  }
  const startedAt = Date.now();
  // Concurrent batches get at least the dedicated 30-minute floor while
  // preserving an unlimited setting (0) and any larger configured timeout;
  // non-concurrent batches keep the configured timeout unchanged.
  const configuredTimeoutSecs = queryTimeoutSecsForConnection(connection, settingsStore.editorSettings.globalQueryTimeoutSecs);
  const executionTimeoutSecs = queryTimeoutSecsForConcurrentIndex(configuredTimeoutSecs, hasConcurrentIndexBuild);
  let exactIndexSubmitted = false;
  try {
    // An edited DDL script is always executed as the batch it previews as; the
    // SQLite rebuild path would rebuild from the structure draft instead.
    if (!exactDraftCurrent()) return false;
    exactIndexSubmitted = !!exactTarget && refreshScope.indexes;
    const result =
      hasSqliteTypeChange.value && !ddlDirty.value
        ? await api.applySqliteTableStructureChange(props.connectionId, props.database, structureChangeOptions(), sqliteSchemaRevision.value!)
        : await api.executeBatch(exactTarget?.connectionId ?? props.connectionId, exactTarget?.database ?? props.database, exactTarget ? submittedStatements : pendingStatements.value, exactTarget?.schema ?? props.schema, executionTimeoutSecs, useTransaction);
    if (databaseType.value === "starrocks") starrocksSubmittedSql.value = { target: submittedStarRocksTarget, sql };
    await recordStructureHistory(sql, startedAt, true, result, undefined, exactTarget);
    if (!exactContextCurrent()) return true;
    if (!isCreateMode.value && props.tableName) {
      const metadataMatch = { connectionId: props.connectionId, database: props.database, schema: metadataSchema.value, tableName: props.tableName };
      invalidateTableMetadataCache(metadataMatch);
      await invalidateObjectMetadataCache(metadataMatch);
      await invalidateObjectDdl(ddlRequest());
      loadedMetadataFacets.clear();
    }
    toast(t(isCreateMode.value ? "structureEditor.created" : databaseType.value === "starrocks" && refreshScope.columns ? "starrocksLayout.alterSubmitted" : "structureEditor.saved"), 4000);
    sqlPreviewPending.value = false;
    sqlPreviewLoading.value = false;
    pendingStatements.value = [];
    warnings.value = [];
    sqliteSchemaRevision.value = undefined;
    // Partition operations are applied in place; drop them now so the reload
    // below reflects the new catalog state instead of replaying them.
    partitionOperations.value = [];
    if (databaseType.value === "starrocks") {
      starrocksAlterContext.value = undefined;
      starrocksSortColumns.value = undefined;
    }
    ddlFetched.value = false;
    rawDdlContent.value = "";
    ddlDraft.value = null;
    if (isCreateMode.value) {
      clearDraft();
      // The created tab must query the name the server actually stored: plain
      // Oracle names are created unquoted and stored upper-folded, plain
      // Informix-family names lower-folded, and every quoted name keeps its
      // exact spelling — mirror the DDL generator's quoting rule here.
      emit("saved", tableComment.value !== originalTableComment.value, foldCreatedTableName(newTableName.value, databaseType.value));
    } else {
      // An old local-only preference must not mask the newly submitted schema order.
      if (starrocksPhysicalOrderChanged) {
        const scopeKey = localTableColumnOrderScopeKey();
        removeTableDataGridColumnOrder(scopeKey);
        notifyTableDataGridColumnOrderChanged(scopeKey);
      }
      // Refresh persisted keys after successful renames/additions before metadata reloads.
      persistLocalColumnOrder(false);
      saving.value = false;
      postSaveRefreshing.value = true;
      skipNextRefreshVersion = true;
      emit("saved", tableComment.value !== originalTableComment.value);
      await refreshStructureAfterSave(refreshScope, characterLengthUnitsAfterSave);
    }
    return true;
  } catch (e: any) {
    const rawMessage = e?.message || String(e);
    if (!exactContextCurrent()) {
      await recordStructureHistory(sql, startedAt, false, undefined, rawMessage, exactTarget);
      return false;
    }
    // A cancelled/errored concurrent build leaves a same-name INVALID index
    // behind; surface that so retries are not silently doomed.
    const invalidIndexHint = hasConcurrentIndexBuild && /already exists/i.test(rawMessage) ? `\n\n${t("structureEditor.invalidIndexRetryHint")}` : "";
    const starrocksSchemaChangeBusy = databaseType.value === "starrocks" && /a schema change operation is in progress on the table\b/i.test(rawMessage);
    errorMessage.value = starrocksSchemaChangeBusy ? t("starrocksLayout.schemaChangeBusy", { table: props.tableName }) : `${rawMessage}${invalidIndexHint}`;
    await recordStructureHistory(sql, startedAt, false, undefined, starrocksSchemaChangeBusy ? rawMessage : errorMessage.value, exactTarget);
    return false;
  } finally {
    saving.value = false;
    if (exactIndexSubmitted && exactTarget) {
      const error = await refreshSchemaIndexLists(exactTarget);
      if (error && exactContextCurrent()) toast(error, 5000);
    }
    if (databaseType.value === "starrocks") starrocksStatusRevision.value++;
  }
}

async function onStarRocksAlterCompleted() {
  if (saving.value || loading.value || starrocksDraftDirty.value) return;
  const requestId = structureLoadRequestId;
  const target = JSON.stringify([props.connectionId, props.database, props.tableName, props.schema, props.catalog]);
  const metadataRequest = { connectionId: props.connectionId, database: props.database, schema: metadataSchema.value, tableName: props.tableName!, catalog: props.catalog };
  try {
    invalidateTableMetadataCache(metadataRequest);
    await Promise.all([invalidateObjectMetadataCache(metadataRequest), invalidateObjectDdl(ddlRequest())]);
    const [nextColumns, ddlResult] = await Promise.all([api.getColumns(props.connectionId, props.database, metadataSchema.value, props.tableName!, props.catalog), loadObjectDdl(ddlRequest(), { force: true })]);
    const formatted = await formatStructureDdl(ddlResult.ddl);
    // Editing while the fetch is in flight must preserve the new draft.
    if (requestId !== structureLoadRequestId || target !== JSON.stringify([props.connectionId, props.database, props.tableName, props.schema, props.catalog]) || saving.value || loading.value || starrocksDraftDirty.value) return;
    columns.value = applyStoredLocalColumnOrder(createColumnDrafts(nextColumns, databaseType.value));
    starrocksAlterContext.value = starRocksAlterOptionsFromDdl(ddlResult.ddl, connection.value?.database_info?.productVersion);
    starrocksSortColumns.value = [...(starrocksAlterContext.value.sortColumns ?? [])];
    rawDdlContent.value = formatted;
    ddlFetched.value = true;
    scheduleSqlPreviewRefresh();
    syncDraftToParent();
    skipNextRefreshVersion = true;
    emit("saved", false);
  } catch {
    toast(t("starrocksStatus.structureRefreshFailed"), 5000);
  }
}

defineExpose({ applyChanges, focusSearch });

function addItemForActiveTab(): boolean {
  if (activeTab.value === "columns" && canAddColumn.value) {
    void addColumn();
    return true;
  }
  if (activeTab.value === "indexes" && structureCapabilities.value.createIndex) {
    addIndex();
    return true;
  }
  if (activeTab.value === "foreignKeys" && canEditForeignKeys.value) {
    addForeignKey();
    return true;
  }
  if (activeTab.value === "triggers" && canEditTriggers.value && !triggersLoading.value) {
    addTrigger();
    return true;
  }
  return false;
}

function focusedEditableColumn(eventTarget: EventTarget | null): EditableStructureColumn | undefined {
  if (!(eventTarget instanceof HTMLInputElement || eventTarget instanceof HTMLTextAreaElement) || eventTarget.disabled || eventTarget.readOnly) return;
  const row = eventTarget.closest<HTMLElement>("[data-column-id]");
  const columnId = row?.dataset.columnId;
  if (!columnId) return;
  return columns.value.find((column) => column.id === columnId && !column.markedForDrop);
}

function isShiftEnterShortcut(event: KeyboardEvent): boolean {
  return !event.isComposing && event.key === "Enter" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

function isPlainStructureRefreshShortcut(event: KeyboardEvent): boolean {
  return !event.isComposing && !event.repeat && event.key === "F5" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

function isPlainModDeleteShortcut(event: KeyboardEvent): boolean {
  if (isPlainModShortcut(event, "delete")) return true;
  if (!event.metaKey || event.ctrlKey || !isPlainModShortcut(event, "backspace")) return false;
  // ⌘⌫ is macOS "delete to beginning of line" while editing text; only treat it as a
  // field delete when the focused input is empty so normal text editing keeps working.
  const target = event.target;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value === "" : true;
}

function onStructureEditorKeydown(event: KeyboardEvent) {
  // Desktop blocks F5 before this bubble listener and marks it defaultPrevented.
  // Handle the shortcut first so that guard still refreshes the open table (#11850).
  if (isPlainStructureRefreshShortcut(event)) {
    // Only react when the keypress originates inside this editor: the listener is
    // window-level and every activated structure editor registers one, so without
    // this check a plain F5 typed into another editor group (where F5 is the global
    // refresh-data shortcut) would silently discard THIS editor's unsaved drafts.
    const target = event.target;
    if (!(target instanceof Element) || !rootRef.value?.contains(target)) return;
    if (target.closest('[role="dialog"], [role="alertdialog"]')) return;
    if (isCreateMode.value) return;
    event.preventDefault();
    event.stopPropagation();
    if (!loading.value && !saving.value && !ddlLoading.value) void reloadStructureFromDatabase();
    return;
  }
  if (event.defaultPrevented) return;
  if (activeTab.value === "columns" && !eventTargetUsesNativeClipboard(event)) {
    if (isPlainClipboardShortcut(event, "a")) {
      event.preventDefault();
      event.stopPropagation();
      selectAllStructureColumns();
      return;
    }
    if (isPlainClipboardShortcut(event, "c") && selectedStructureColumnKeys.value.size > 0) {
      event.preventDefault();
      event.stopPropagation();
      void copySelectedStructureColumns();
      return;
    }
  }
  const focusedColumn = activeTab.value === "columns" ? focusedEditableColumn(event.target) : undefined;
  if (focusedColumn && isShiftEnterShortcut(event) && canAddColumn.value) {
    event.preventDefault();
    event.stopPropagation();
    void addColumn(focusedColumn);
    return;
  }
  if (focusedColumn && isPlainModShortcut(event, "d") && canAddColumn.value) {
    event.preventDefault();
    event.stopPropagation();
    void copyColumn(focusedColumn);
    return;
  }
  if (focusedColumn && isPlainModDeleteShortcut(event) && (!focusedColumn.original || canDropColumn(focusedColumn))) {
    event.preventDefault();
    event.stopPropagation();
    if (focusedColumn.original) toggleDropColumn(focusedColumn);
    else removeNewColumn(focusedColumn);
    return;
  }
  if (isPlainModShortcut(event, "f")) {
    if (focusSearch()) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  if (isPlainModShortcut(event, "s")) {
    event.preventDefault();
    event.stopPropagation();
    void applyChanges();
    return;
  }
  if (isPlainModShortcut(event, "n")) {
    event.preventDefault();
    event.stopPropagation();
    addItemForActiveTab();
  }
}

function registerStructureEditorShortcuts() {
  if (keydownListenerRegistered) return;
  keydownListenerRegistered = true;
  window.addEventListener("keydown", onStructureEditorKeydown);
  document.addEventListener("pointerdown", onStructureDensityDocumentPointerdown, true);
  document.addEventListener("mouseup", onColumnSelectionPointerUp);
}

function unregisterStructureEditorShortcuts() {
  if (!keydownListenerRegistered) return;
  keydownListenerRegistered = false;
  window.removeEventListener("keydown", onStructureEditorKeydown);
  document.removeEventListener("pointerdown", onStructureDensityDocumentPointerdown, true);
  document.removeEventListener("mouseup", onColumnSelectionPointerUp);
}

onMounted(() => {
  resetState();
  // With an initialized draft the restore below owns the tab (plus any
  // unconsumed initial tab); applying the stale initial tab first would only
  // flash the wrong facet and kick its metadata load (#8419).
  if (!props.draft?.initialized) applyInitialStructureTab();
  applyInitialStructureTarget();
  registerStructureEditorShortcuts();
  void loadDynamicDataTypeOptions();
  if (props.draft?.initialized) {
    restoreDraft(props.draft);
    // A restored draft owns its saved tab unless navigation explicitly requested another one.
    applyPendingInitialStructureTab();
    applyInitialStructureTarget();
  }
  structureEditorReady = true;
  observeStructureHorizontalScroller();
  void loadTableOwner(false, props.draft?.tableOwner !== undefined);
  void loadTableOwnerRoles();
  void loadMysqlTableEngine(props.draft?.mysqlTableEngine !== undefined);
  if (props.draft && props.draft.mysqlTableCollation === undefined && !isCreateMode.value) {
    // Drafts written before table-level charset support already mark the columns
    // facet as loaded, so the normal structure load would skip this lookup.
    void loadCharsetMetadata();
    void loadMysqlTableDefaultCollation();
  }
  if (props.draft?.initialized) {
    // A clean persisted editor snapshot is not a live schema cache. After an
    // MCP DDL, restoring its loaded-facet flags would otherwise bypass the
    // invalidated backend cache entirely. Legacy/dirty drafts remain intact.
    const revalidateRestoredColumns = props.draft.dirty === false && !isCreateMode.value && loadedMetadataFacets.has("columns") && !(databaseType.value === "manticoresearch" && tableMetadataCapabilities.value.ddl);
    const restoredIdentity = draftTargetIdentity();
    void hydrateRestoredDraftFromDatabase().then((completed) => {
      if (completed) return initializeRestoredDraftMetadata(restoredIdentity, revalidateRestoredColumns);
    });
  } else if (isCreateMode.value) {
    markDraftHydratedAndSync();
  } else if (activeTab.value === "ddl") {
    void loadActiveTableStructureMetadataIfNeeded().then(markDraftHydratedAndSync);
  } else {
    void loadStructure(false, visibleTableStructureRefreshScope(activeTab.value), true, { blockSecondaryMetadata: true }).then(() => applyInitialStructureTarget());
  }
});

onActivated(() => {
  triggerStructureActive.value = true;
  registerStructureEditorShortcuts();
  observeStructureToolbar();
  observeStructureHorizontalScroller();
  void loadDynamicDataTypeOptions();
  if (supportsTableOwner.value && !loadedMetadataFacets.has("owner")) void loadTableOwner(false, props.draft?.tableOwner !== undefined);
  if (supportsTableOwner.value && !tableOwnerRolesLoading.value && tableOwnerRoles.value.length === 0 && !tableOwnerRolesLoadError.value) void loadTableOwnerRoles();
  if (supportsMysqlEngine.value && !mysqlTableEngineLoading.value && mysqlTableEngineOptions.value.length === 0 && !mysqlTableEngineLoadError.value) {
    void loadMysqlTableEngine(props.draft?.mysqlTableEngine !== undefined);
  }
  if (props.draft?.initialized && !draftHydrated) {
    if (restoredDraftTarget !== draftTargetIdentity()) restoreDraft(props.draft);
    applyInitialStructureTarget();
    const restoredIdentity = draftTargetIdentity();
    void hydrateRestoredDraftFromDatabase().then((completed) => {
      if (completed) return initializeRestoredDraftMetadata(restoredIdentity);
    });
  }
  restoreStructureScrollPosition();
  if (activeTab.value === "ddl") scheduleDdlEditorInit();
});
onDeactivated(() => {
  triggerStructureActive.value = false;
  cancelTriggerStructureConfirmation();
  stopStructureToolbarObserver();
  copyColumnsDialogOpen.value = false;
  pasteColumnsDialogOpen.value = false;
  flushStructureScrollDraftSync();
  if (structureColumnScrollingTimer) clearTimeout(structureColumnScrollingTimer);
  structureColumnScrollingTimer = undefined;
  unregisterStructureEditorShortcuts();
  structureHorizontalScrollbarObserverGeneration += 1;
  structureHorizontalScrollbarResizeObserver?.disconnect();
  structureHorizontalScrollbarResizeObserver = null;
  stopStructureHorizontalScrollbarDrag();
  destroyDdlEditor();
});
onBeforeUnmount(() => {
  invalidateDraftHydration();
  stopStructureToolbarObserver();
  ++copySourceScopeRequestId;
  resetCopySourceTables();
  structureLoadRequestId++;
  flushStructureScrollDraftSync();
  if (structureColumnScrollingTimer) clearTimeout(structureColumnScrollingTimer);
  structureColumnScrollingTimer = undefined;
  clearCopySourceTableSearchTimer();
  if (partitionDialogSqlTimer) clearTimeout(partitionDialogSqlTimer);
  stopColumnDragTracking();
  stopStructureHorizontalScrollbarDrag();
  structureHorizontalScrollbarObserverGeneration += 1;
  structureHorizontalScrollbarResizeObserver?.disconnect();
  unregisterStructureEditorShortcuts();
  destroyDdlEditor();
  clearSqlPreviewState();
  if (columnHighlightTimer) window.clearTimeout(columnHighlightTimer);
  if (indexHighlightTimer) window.clearTimeout(indexHighlightTimer);
  persistStructureDensity();
});

function localFirstStructureMetadataTab(capabilities = tableMetadataCapabilities.value) {
  return firstStructureMetadataTab(capabilities, isCreateMode.value);
}

function localIsStructureMetadataTabSupported(tab: TableInfoTab, capabilities = tableMetadataCapabilities.value) {
  return isStructureMetadataTabSupported(tab, capabilities, isCreateMode.value);
}

function resolveStructureMetadataTab(tab: TableInfoTab | undefined, capabilities = tableMetadataCapabilities.value): TableInfoTab {
  if (tab && localIsStructureMetadataTabSupported(tab, capabilities)) return tab;
  return localFirstStructureMetadataTab(capabilities);
}

function applyInitialStructureTab(useDefault = true) {
  if (props.initialTab) {
    const nextTab = resolveStructureMetadataTab(props.initialTab);
    if (nextTab === "ddl" && (props.initialTabRequestId === undefined || props.initialTabRequestId !== lastAppliedInitialTabRequestId)) pendingDdlNavigation = true;
    activeTab.value = nextTab;
    lastAppliedInitialTabRequestId = props.initialTabRequestId;
    if (structureEditorReady && pendingDdlNavigation) void loadActiveTableStructureMetadataIfNeeded();
  } else if (useDefault) {
    activeTab.value = resolveStructureMetadataTab(undefined);
  }
}

// The tab's structureInitialTab stays populated after it was consumed once
// (e.g. the side panel opened the editor on its foreign-keys facet). Replaying
// it on every remount would override the draft-restored tab the user last
// selected, so an initial tab only applies again when navigation bumped the
// request id (#8419).
function applyPendingInitialStructureTab() {
  if (!props.initialTab) return;
  if (props.initialTabRequestId !== undefined && props.initialTabRequestId === lastAppliedInitialTabRequestId) return;
  applyInitialStructureTab(false);
}

function initialTargetKey(target: TableStructureEditorTarget): string {
  return JSON.stringify([props.initialTabRequestId ?? 0, props.exactIdentity === true, target.kind, target.owner, target.name, target.action]);
}

function applyInitialStructureTarget() {
  const target = props.initialTarget;
  if (props.exactIdentity && target?.kind === "index") {
    const key = initialTargetKey(target);
    if (initialIndexTargetError && initialIndexTargetError.key !== key) {
      if (errorMessage.value === initialIndexTargetError.message) errorMessage.value = "";
      initialIndexTargetError = undefined;
    }
    if (appliedInitialTargetScrollKey === key || (target.action && props.initialTabRequestId !== undefined && props.initialTabRequestId === lastAppliedInitialTargetRequestId)) return;
    activeTab.value = resolveStructureMetadataTab("indexes");
    if (loading.value || indexesLoading.value || !loadedMetadataFacets.has("columns") || !loadedMetadataFacets.has("indexes") || errorMessage.value || secondaryMetadataErrors.value.indexes) return;
    if (target.action === "create") {
      if (!structureCapabilities.value.createIndex) return;
      if (isOracleConstraintEditor.value && !oracleIndexReady.value) return;
      appliedInitialTargetScrollKey = key;
      lastAppliedInitialTargetRequestId = props.initialTabRequestId;
      addIndex();
      syncDraftToParent();
      return;
    }
    const matches = typeof target.owner === "string" ? indexes.value.filter((index) => index.original?.owner === target.owner && index.original?.name === target.name) : [];
    if (matches.length !== 1) {
      initialIndexTargetError = { key, message: t("schemaIndex.targetMissing", { name: target.name }) };
      errorMessage.value = initialIndexTargetError.message;
      return;
    }
    initialIndexTargetError = undefined;
    const index = matches[0]!;
    appliedInitialTargetScrollKey = key;
    lastAppliedInitialTargetRequestId = props.initialTabRequestId;
    indexSearchText.value = "";
    highlightedIndexId.value = index.id;
    if (target.action === "delete" && canDropIndex(index)) index.markedForDrop = true;
    syncDraftToParent();
    void nextTick(() => {
      if (!props.initialTarget || initialTargetKey(props.initialTarget) !== key) return;
      const row = Array.from(rootRef.value?.querySelectorAll<HTMLElement>("[data-index-row-id]") ?? []).find((candidate) => candidate.dataset.indexRowId === index.id);
      row?.scrollIntoView({ block: "nearest" });
    });
    return;
  }
  const targetName = target?.name.trim();
  if (!target || !targetName) return;

  const key = initialTargetKey(target);
  if (appliedInitialTargetSearchKey !== key) {
    if (target.kind === "column") {
      activeTab.value = resolveStructureMetadataTab("columns");
      columnSearchText.value = targetName;
      highlightedColumnId.value = null;
    } else {
      activeTab.value = resolveStructureMetadataTab("indexes");
      indexSearchText.value = targetName;
      highlightedIndexId.value = null;
    }
    appliedInitialTargetSearchKey = key;
  }

  if (appliedInitialTargetScrollKey === key) return;
  const hasMatch = target.kind === "column" ? columns.value.some((column) => columnMatchesSearch(column)) : indexes.value.some((index) => indexMatchesSearch(index));
  if (!hasMatch) return;
  appliedInitialTargetScrollKey = key;
  void nextTick(() => {
    if (target.kind === "column") {
      scrollToColumnSearchMatch(1);
    } else {
      scrollToIndexSearchMatch(1);
    }
  });
}

watch(tableMetadataCapabilities, (capabilities) => {
  if (!localIsStructureMetadataTabSupported(activeTab.value, capabilities)) activeTab.value = localFirstStructureMetadataTab(capabilities);
});

// The Partitions tab vanishes for a non-partitioned table, so an active (or
// navigation-requested) partitions tab must fall back once the probe settles.
watch([activeTab, partitionStatusResolved, isPartitionedParent, isTablePartition], () => {
  if (activeTab.value !== "partitions" || isCreateMode.value || !partitionStatusResolved.value) return;
  if (isPartitionedParent.value || isTablePartition.value) return;
  activeTab.value = localFirstStructureMetadataTab();
});

watch(structureCapabilities, () => {
  // Capability loss (e.g. PostgreSQL < 11 without concurrent index support)
  // invalidates any selected Concurrent flag the same way a probe failure
  // does; the normalization is idempotent and no-ops while availability stays
  // enabled.
  normalizeConcurrentIndexDraftsForCurrentAvailability();
});

watch([() => props.initialTab, () => props.initialTabRequestId, () => props.initialTarget], () => {
  if (props.initialTab) applyInitialStructureTab();
  applyInitialStructureTarget();
});

watch([columns, indexes, indexesLoading, loading, oracleIndexReady], () => {
  applyInitialStructureTarget();
});

watch([() => props.connectionId, () => props.database, databaseType], () => {
  void loadDynamicDataTypeOptions();
});

watch(draftTargetIdentity, () => {
  invalidateDraftHydration();
  restoredDraftTarget = "";
  draftHydrationError.value = "";
});

watch([() => props.connectionId, () => props.database, () => props.schema, () => props.catalog, () => props.tableName, databaseType, activeTab], () => {
  pasteColumnsDialogOpen.value = false;
});

watch(() => connection.value?.database_info?.productVersion, scheduleSqlPreviewRefresh);

watch(
  [
    isCreateMode,
    () => props.connectionId,
    () => props.database,
    databaseType,
    () => props.schema,
    () => props.tableName,
    newTableName,
    tableComment,
    originalTableComment,
    mysqlAutoIncrementValue,
    originalMysqlAutoIncrementValue,
    mysqlAutoIncrementLoading,
    mysqlAutoIncrementLoadError,
    mysqlTableEngine,
    originalMysqlTableEngine,
    physicalOptions,
    starrocksPhysicalOptions,
    postgresForeignTable,
    starrocksSortColumns,
    mysqlTableEngineLoading,
    mysqlTableEngineLoadError,
    mysqlTableDefaultCollation,
    mysqlTableCharset,
    originalMysqlTableCharset,
    mysqlTableCollation,
    originalMysqlTableCollation,
    tableOwner,
    ddlDraft,
    existingPrimaryKeyDraft,
    oracleConstraintDraft,
    columns,
    indexes,
    foreignKeys,
    triggers,
    partitionOperations,
    createPartitioningEnabled,
    createPartitioningKind,
    createPartitioningColumns,
    createPartitioningExpression,
  ],
  () => {
    scheduleSqlPreviewRefresh();
    syncDraftToParent();
  },
  { deep: true, immediate: true },
);

watch(activeTab, () => {
  stopStructureHorizontalScrollbarDrag();
  if (activeTab.value !== "ddl") destroyDdlEditor();
  clearColumnSelection();
  highlightedColumnId.value = null;
  highlightedIndexId.value = null;
  restoreStructureScrollPosition();
  syncDraftToParent();
});

watch([activeTab, loading, indexesLoading, visibleColWidths, indexColWidths], observeStructureHorizontalScroller, { deep: true, flush: "post", immediate: true });

// Tab availability, density and translations all change the space the actions
// need. Re-measure the full layout instead of keeping widths from another view.
watch([activeTab, isCreateMode, databaseType, tableMetadataCapabilities, showPartitionsTab, localStructureDensity, structureDensityOptions], () => {
  structureToolbarRequiredWidths = {};
  structureToolbarCondensedAtWidth = 0;
  structureToolbarTier.value = 0;
  void nextTick(scheduleStructureToolbarMeasurement);
});

// Font sizes change with density, so start measuring again instead of keeping a stale maximum.
watch(localStructureDensity, () => {
  extendedPropertiesContentWidth.value = 0;
});
watch([columns, localStructureDensity], updateExtendedPropertiesContentWidth, { deep: true, flush: "post" });

watch(
  columns,
  (items) => {
    const existingIds = new Set(items.map((column) => column.id));
    if (selectedColumnId.value && !existingIds.has(selectedColumnId.value)) {
      selectedColumnId.value = null;
    }
    if (columnSelectionAnchorId.value && !existingIds.has(columnSelectionAnchorId.value)) {
      columnSelectionAnchorId.value = null;
    }
    const prunedIds = [...selectedColumnIds.value].filter((id) => existingIds.has(id));
    if (prunedIds.length !== selectedColumnIds.value.size) {
      selectedColumnIds.value = new Set(prunedIds);
    }
  },
  { deep: false },
);

watch(secondaryMetadataLoading, (value) => {
  if (value || !deferredSqlPreviewRefresh) return;
  scheduleSqlPreviewRefresh();
});

watch(refreshVersion, (version, previous) => {
  if (version === previous || !version || isCreateMode.value) return;
  if (skipNextRefreshVersion) {
    skipNextRefreshVersion = false;
    return;
  }
  if (activeTab.value !== "triggers") {
    triggers.value = [];
    triggersLoaded.value = false;
  }
  if (activeTab.value !== "constraints") {
    constraints.value = [];
    constraintsLoaded.value = false;
  }
  if (activeTab.value !== "partitions") {
    partitioning.value = null;
    loadedMetadataFacets.delete("partitions");
  }
  void loadStructure(true, visibleTableStructureRefreshScope(activeTab.value), true, { preserveDraft: props.exactIdentity === true });
});

async function loadActiveTableStructureMetadataIfNeeded() {
  if (!structureEditorReady || isCreateMode.value) return;
  if (activeTab.value === "ddl") {
    // Explicit navigation refreshes a clean editor; ordinary tab switches keep its baseline.
    const refreshNavigation = pendingDdlNavigation;
    pendingDdlNavigation = false;
    const ddl = ddlLoading.value ? Promise.resolve() : refreshNavigation ? fetchDdl(true, { preserveDraft: true }) : fetchDdl();
    await Promise.all([ddl, loadVisibleTableComment(false, true), probePartitionsTabVisibility()]);
    return;
  }
  if (loading.value || secondaryMetadataLoading.value) return;
  const scope = withRequiredPostgresPrimaryKeyMetadata(unloadedTableStructureRefreshScope(activeTab.value, loadedMetadataFacets));
  if (!hasTableStructureRefreshWork(scope)) return;
  await loadStructure(true, scope, true, { blockSecondaryMetadata: true, preserveDraft: true });
  applyInitialStructureTarget();
}

watch([activeTab, loading, secondaryMetadataLoading], () => void loadActiveTableStructureMetadataIfNeeded(), { flush: "sync" });

watch([activeTab, loading, ddlLoading, ddlContent], ([tab, structureIsLoading, ddlIsLoading]) => {
  if (tab === "ddl" && !structureIsLoading && !ddlIsLoading) scheduleDdlEditorInit();
});

// The DDL pane lives in a reka-ui TabsContent that stays mounted across tab
// switches via force-mount (see the TabsContent in the template), so the
// historical "revisit renders blank" race is closed at the mount level. Two
// windows remain for this watch: the pane still mounts one tick *after* the
// tab becomes active (Presence flips asynchronously), so a single `nextTick`
// guess (scheduleDdlEditorInit) can run before the container exists; and the
// loading branch swaps the container node. Drive creation off the container
// ref itself, like useDataGridCellDetail/DataGrid do for their editors.
watch(
  ddlEditorContainer,
  (container) => {
    if (!container) {
      // The container only goes away on real unmount or when the loading
      // branch swaps it out: drop the view rather than leaving it attached
      // to a detached node.
      destroyDdlEditor();
      return;
    }
    if (activeTab.value !== "ddl" || loading.value || ddlLoading.value) return;
    void initDdlEditor(ddlEditorDocument());
  },
  { flush: "post" },
);
</script>

<template>
  <div ref="rootRef" class="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-[var(--structure-shell-padding)] text-[length:var(--structure-font-size)]" :data-structure-density="localStructureDensity" :style="structureDensityStyle">
    <ObjectSourceDialog
      v-if="triggerSourceTarget"
      :key="JSON.stringify(triggerSourceTarget.target)"
      ref="triggerSourceDialog"
      v-model:open="triggerSourceOpen"
      :connection-id="triggerSourceTarget.target.connectionId"
      :database="triggerSourceTarget.target.database"
      :catalog="triggerSourceTarget.target.catalog"
      :schema="triggerSourceTarget.target.owner"
      :execution-schema="triggerSourceTarget.target.executionSchema"
      :name="triggerSourceTarget.target.name"
      object-type="TRIGGER"
      trigger-identity-mode="exact"
      :database-type="databaseType"
      :dialect="codeMirrorSqlDialect(databaseType)"
      :format-dialect="sqlFormatDialectForDbType(databaseType)"
      initial-editing
      @trigger-read="mergeTriggerSourceSnapshot"
      @trigger-result="recordTriggerSourceResult"
    />
    <DangerConfirmDialog v-model:open="primaryKeyResultOpen" :title="t(primaryKeyResultTitle)" :message="primaryKeyResultMessage" :confirm-label="t('common.close')">
      <template #options>
        <details class="rounded border p-2 text-xs">
          <summary class="cursor-pointer">{{ t("oceanbasePrimaryKey.details") }}</summary>
          <Button variant="ghost" size="sm" @click="copyColumnNamesText(primaryKeyResultDetails)">{{ t("dangerDialog.copyFullText") }}</Button>
          <pre data-native-clipboard class="max-h-72 overflow-auto whitespace-pre-wrap break-all">{{ primaryKeyResultDetails }}</pre>
        </details>
      </template>
    </DangerConfirmDialog>
    <StarRocksLayoutCopyDialog
      v-if="!isCreateMode && databaseType === 'starrocks' && props.tableName"
      v-model:open="starrocksLayoutCopyOpen"
      :connection-id="props.connectionId"
      :database="props.database"
      :schema="props.schema"
      :catalog="props.catalog"
      :table-name="props.tableName"
      :server-version="connection?.database_info?.productVersion"
      :timeout-secs="queryTimeoutSecsForConnection(connection, settingsStore.editorSettings.globalQueryTimeoutSecs)"
      :authorize="authorizeStarRocksLayoutCopy"
      @created="emit('saved', false)"
    />
    <div class="flex shrink-0 items-center gap-2 rounded-md border bg-muted/20 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]">
      <Database :class="[structureIconClass, 'text-muted-foreground']" />
      <span class="min-w-0 flex-1 truncate font-medium">{{ targetLabel || t("editor.noDatabase") }}</span>
      <Badge variant="outline">{{ connection?.driver_label || databaseType }}</Badge>
      <Button v-if="!isCreateMode" variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="loading || saving || ddlLoading" :title="t('structureEditor.refresh') + ' (F5)'" aria-keyshortcuts="F5" data-refresh-structure-shortcut @click="reloadStructureFromDatabase">
        <RefreshCw :class="structureIconClass" />
        {{ t("structureEditor.refresh") }}
      </Button>
    </div>

    <StarRocksAlterStatus
      v-if="!isCreateMode && databaseType === 'starrocks' && props.tableName"
      :connection-id="props.connectionId"
      :database="props.database"
      :table-name="props.tableName"
      :schema="metadataSchema"
      :catalog="props.catalog"
      :paused="saving || loading || postSaveRefreshing"
      :revision="starrocksStatusRevision"
      :dirty="starrocksDraftDirty"
      :submitted-sql="starrocksSubmittedSql?.target === starrocksStatusTarget ? starrocksSubmittedSql.sql : undefined"
      @busy="starrocksStatusBusy = $event"
      @completed="onStarRocksAlterCompleted"
    />

    <div v-if="isCreateMode" class="flex shrink-0 items-center gap-2">
      <template v-if="canCreateForeignTable">
        <label class="shrink-0 font-medium text-muted-foreground">{{ t("postgresForeignTable.tableKind") }}</label>
        <Select :model-value="isCreatingForeignTable ? 'foreign' : 'table'" :disabled="saving" @update:model-value="setCreateTableKind(String($event))">
          <SelectTrigger data-create-table-kind class="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="table">{{ t("postgresForeignTable.regularTable") }}</SelectItem>
            <SelectItem value="foreign">{{ t("postgresForeignTable.foreignTable") }}</SelectItem>
          </SelectContent>
        </Select>
      </template>
      <label class="shrink-0 font-medium text-muted-foreground">{{ t("structureEditor.tableName") }}</label>
      <Input v-model="newTableName" :placeholder="t('contextMenu.duplicateNamePlaceholder')" :class="[structureControlClass, 'max-w-[220px]']" />
    </div>

    <PostgresForeignTableOptionsEditor v-if="isCreatingForeignTable" v-model="postgresForeignTable" :connection-id="props.connectionId" :database="props.database" :catalog="props.catalog" :disabled="saving" />

    <div class="flex shrink-0 items-center gap-2">
      <label class="shrink-0 font-medium text-muted-foreground">{{ t("structureEditor.comment") }}</label>
      <Input v-model="tableComment" :placeholder="t('structureEditor.tableCommentPlaceholder')" :class="[structureControlClass, 'max-w-[320px]']" :disabled="isTableCommentDisabled" data-table-comment-input />
      <Tooltip v-if="isTableCommentDisabled">
        <TooltipTrigger as-child>
          <Info :class="[structureIconClass, 'shrink-0 text-muted-foreground']" />
        </TooltipTrigger>
        <TooltipContent>{{ t("structureEditor.tableCommentUnsupported") }}</TooltipContent>
      </Tooltip>
    </div>

    <div v-if="canEditPrimaryKeyName" class="flex shrink-0 items-center gap-2">
      <label class="shrink-0 font-medium text-muted-foreground">{{ t("structureEditor.primaryKeyName") }}</label>
      <Input v-model="primaryKeyName" :placeholder="t('structureEditor.primaryKeyNamePlaceholder')" :class="[structureControlClass, 'max-w-[320px]']" :disabled="saving || loading" data-primary-key-name-input />
    </div>

    <div v-if="supportsMysqlEngine" class="flex shrink-0 items-center gap-2">
      <label class="shrink-0 font-medium text-muted-foreground">{{ t("structureEditor.mysqlTableEngine") }}</label>
      <SearchableSelect
        v-model="mysqlTableEngine"
        :options="mysqlTableEngineOptions"
        :placeholder="t('structureEditor.mysqlTableEnginePlaceholder')"
        :search-placeholder="t('structureEditor.mysqlTableEngineSearchPlaceholder')"
        :empty-text="t('structureEditor.mysqlTableEngineEmpty')"
        :loading-text="t('common.loading')"
        :loading="mysqlTableEngineLoading"
        :disabled="mysqlTableEngineLoading || !!mysqlTableEngineLoadError || saving"
        :trigger-class="[structureMonoControlClass, 'w-[220px] max-w-[220px]']"
        data-mysql-table-engine-select
      />
      <Loader2 v-if="mysqlTableEngineLoading" :class="[structureIconClass, 'animate-spin text-muted-foreground']" />
      <Tooltip v-else-if="mysqlTableEngineLoadError">
        <TooltipTrigger as-child>
          <AlertTriangle :class="[structureIconClass, 'shrink-0 text-destructive']" />
        </TooltipTrigger>
        <TooltipContent>{{ t("structureEditor.mysqlTableEngineLoadFailed", { message: mysqlTableEngineLoadError }) }}</TooltipContent>
      </Tooltip>
    </div>

    <div v-if="supportsMysqlEngine && !isCreateMode" class="flex shrink-0 items-center gap-2">
      <label class="shrink-0 font-medium text-muted-foreground">{{ t("structureEditor.characterSet") }}</label>
      <SearchableSelect
        :model-value="mysqlTableCharset"
        :options="mysqlCharsetOptions"
        :placeholder="t('structureEditor.charsetPlaceholder')"
        :search-placeholder="t('structureEditor.charsetPlaceholder')"
        :empty-text="t('structureEditor.noMatchingType')"
        :allow-custom="true"
        :loading="charsetMetadataLoading"
        :loading-text="t('common.loading')"
        :disabled="charsetMetadataLoading || saving"
        :trigger-class="[structureMonoControlClass, 'w-[180px] max-w-[180px]']"
        data-mysql-table-charset-select
        @update:model-value="onMysqlTableCharsetChange"
      />
    </div>

    <div v-if="supportsMysqlEngine && !isCreateMode" class="flex shrink-0 items-center gap-2">
      <label class="shrink-0 font-medium text-muted-foreground">{{ t("structureEditor.collation") }}</label>
      <SearchableSelect
        v-model="mysqlTableCollation"
        :options="collationOptionsForCharset(mysqlTableCharset)"
        :placeholder="t('structureEditor.collationPlaceholder')"
        :search-placeholder="t('structureEditor.collationPlaceholder')"
        :empty-text="t('structureEditor.noMatchingType')"
        :allow-custom="true"
        :disabled="charsetMetadataLoading || saving"
        :trigger-class="[structureMonoControlClass, 'w-[220px] max-w-[220px]']"
        data-mysql-table-collation-select
      />
    </div>

    <TablePhysicalOptionsEditor v-if="isCreateMode && databaseType === 'transwarp'" v-model="physicalOptions" :config="INCEPTOR_PHYSICAL_OPTIONS" :columns="columns.filter((column) => !column.markedForDrop && !!column.name.trim())" :disabled="saving" />

    <div v-if="supportsTableOwner" class="flex shrink-0 items-center gap-2">
      <label class="flex shrink-0 items-center gap-1 font-medium text-muted-foreground">
        <UserRound :class="structureIconClass" />
        {{ t("structureEditor.owner") }}
      </label>
      <SearchableSelect
        v-model="tableOwner"
        :options="tableOwnerOptions"
        :placeholder="t('structureEditor.ownerPlaceholder')"
        :search-placeholder="t('structureEditor.ownerSearchPlaceholder')"
        :empty-text="t('structureEditor.ownerRolesEmpty')"
        :loading-text="t('common.loading')"
        :loading="tableOwnerRolesLoading"
        :allow-custom="true"
        :trim-custom="false"
        :disabled="tableOwnerLoading || !!tableOwnerLoadError"
        :trigger-class="[structureMonoControlClass, 'w-[220px] max-w-[220px]']"
        data-owner-select
      />
      <Loader2 v-if="tableOwnerLoading" :class="[structureIconClass, 'animate-spin text-muted-foreground']" />
      <Tooltip v-else-if="tableOwnerLoadError">
        <TooltipTrigger as-child>
          <AlertTriangle :class="[structureIconClass, 'shrink-0 text-destructive']" />
        </TooltipTrigger>
        <TooltipContent>{{ t("structureEditor.ownerLoadFailed", { message: tableOwnerLoadError }) }}</TooltipContent>
      </Tooltip>
      <Tooltip v-else-if="tableOwnerRolesLoadError">
        <TooltipTrigger as-child>
          <AlertTriangle :class="[structureIconClass, 'shrink-0 text-amber-500']" />
        </TooltipTrigger>
        <TooltipContent>{{ t("structureEditor.ownerRolesLoadFailed", { message: tableOwnerRolesLoadError }) }}</TooltipContent>
      </Tooltip>
    </div>

    <div v-if="loading" class="flex min-h-0 flex-1 items-center justify-center gap-2 text-[length:var(--structure-font-size)] text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" />
      {{ t("common.loading") }}
    </div>

    <div v-else class="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      <div class="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border">
        <Tabs v-model="activeTab" class="structure-tabs h-full min-h-0">
          <div
            ref="structureToolbarRef"
            class="structure-toolbar col-start-1 row-start-1 flex min-w-0 shrink-0 items-center justify-between gap-2 border-b px-2 py-[var(--structure-header-py)]"
            :class="{ 'structure-toolbar--compact': structureToolbarTier >= 1, 'structure-toolbar--icons': structureToolbarTier >= 2, 'structure-toolbar--wrap': structureToolbarTier >= 3 }"
          >
            <TabsList class="structure-toolbar-tabs shrink-0">
              <TabsTrigger v-if="tableMetadataCapabilities.ddl && !isCreateMode" value="ddl">
                DDL
                <span v-if="ddlDirty" class="ml-1 h-1.5 w-1.5 rounded-full bg-primary" :title="t('structureEditor.ddlEditNotice')" data-ddl-dirty-indicator></span>
              </TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.columns" value="columns">{{ t("structureEditor.columns") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.indexes" value="indexes">{{ t("structureEditor.indexes") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.foreignKeys" value="foreignKeys">{{ t("structureEditor.foreignKeys") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.constraints" value="constraints">{{ t("structureEditor.constraints") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.triggers" value="triggers">{{ t("structureEditor.triggers") }}</TabsTrigger>
              <TabsTrigger v-if="showPartitionsTab" value="partitions">{{ t("structureEditor.partitions") }}</TabsTrigger>
            </TabsList>
            <div class="structure-toolbar-actions flex shrink-0 items-center gap-1.5">
              <Button v-if="!isCreateMode" size="sm" variant="outline" :class="[structureToolbarButtonClass, 'structure-toolbar-action structure-toolbar-secondary']" :title="t('contextMenu.viewData')" :aria-label="t('contextMenu.viewData')" data-structure-view-data @click="emit('viewData')">
                <Rows3 :class="structureIconClass" />
                <span class="structure-toolbar-label">{{ t("contextMenu.viewData") }}</span>
              </Button>
              <div class="flex items-center gap-1.5">
                <SlidersHorizontal :class="[structureIconClass, 'text-muted-foreground']" />
                <div ref="structureDensityMenuRef" class="relative">
                  <button
                    type="button"
                    class="grid h-[var(--structure-control-height)] min-w-[76px] grid-cols-[1fr_var(--structure-control-height)] items-center rounded-[6px] border bg-background pl-[var(--structure-control-px)] text-[length:var(--structure-font-size)] outline-none hover:bg-muted focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25"
                    :aria-label="t('structureEditor.density')"
                    :aria-expanded="structureDensityMenuOpen"
                    aria-haspopup="listbox"
                    @click="toggleStructureDensityMenu"
                    @keydown="onStructureDensityKeydown"
                  >
                    <span class="min-w-0 text-center truncate">{{ structureDensityOptions.find((option) => option.value === localStructureDensity)?.label }}</span>
                    <span class="flex h-full items-center justify-center">
                      <ChevronDown :class="[structureIconClass, 'shrink-0 opacity-50']" />
                    </span>
                  </button>
                  <div v-if="structureDensityMenuOpen" class="absolute right-0 top-[calc(100%+4px)] z-50 min-w-full rounded-[6px] bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10" role="listbox" :aria-label="t('structureEditor.density')">
                    <button
                      v-for="option in structureDensityOptions"
                      :key="option.value"
                      type="button"
                      class="flex h-7 w-full items-center rounded-[6px] px-1.5 text-left text-[length:var(--structure-font-size)] outline-none hover:bg-accent hover:text-accent-foreground"
                      :class="option.value === localStructureDensity ? 'bg-accent text-accent-foreground' : ''"
                      role="option"
                      :aria-selected="option.value === localStructureDensity"
                      @click="selectStructureDensity(option.value)"
                    >
                      {{ option.label }}
                    </button>
                  </div>
                </div>
              </div>
              <div v-if="activeTab === 'columns'" class="structure-toolbar-search relative flex w-40 shrink-0 items-center">
                <Search :class="[structureIconClass, 'pointer-events-none absolute left-2 text-muted-foreground']" />
                <Input
                  ref="columnSearchInputRef"
                  v-model="columnSearchText"
                  :placeholder="t('structureEditor.searchColumns')"
                  :class="[structureControlClass, 'pl-7 pr-14 text-[length:var(--structure-font-size)] placeholder:text-[length:var(--structure-font-size)]']"
                  @keydown="onColumnSearchKeydown"
                />
                <button
                  v-if="columnSearchText"
                  type="button"
                  class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 text-[length:var(--structure-font-size)] text-muted-foreground hover:bg-muted hover:text-foreground"
                  :title="t('structureEditor.nextColumnMatch')"
                  @click="scrollToColumnSearchMatch(1)"
                >
                  {{ columnSearchMatchCount }}
                </button>
              </div>
              <Tooltip v-if="activeTab === 'columns'" :delay-duration="FIELD_SHORTCUT_TOOLTIP_DELAY_MS" data-add-column-shortcut-tooltip>
                <TooltipTrigger as-child>
                  <Button size="sm" :class="[structureToolbarButtonClass, 'structure-toolbar-action']" :disabled="!canAddColumn" :title="t('structureEditor.addColumn')" :aria-label="t('structureEditor.addColumn')" @click="addColumn">
                    <Plus :class="structureIconClass" />
                    <span class="structure-toolbar-label">{{ t("structureEditor.addColumn") }}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" class="font-mono font-medium" data-add-column-shortcut-content>Shift+Enter</TooltipContent>
              </Tooltip>
              <Button
                v-if="activeTab === 'columns' && !isCreateMode && databaseType === 'starrocks'"
                variant="outline"
                size="sm"
                :class="[structureToolbarButtonClass, 'structure-toolbar-action structure-toolbar-secondary']"
                :disabled="loading || saving || hasPendingStructureChanges() || ddlDirty"
                :title="hasPendingStructureChanges() || ddlDirty ? t('starrocksLayout.copySaveFirst') : t('starrocksLayout.copyButton')"
                :aria-label="t('starrocksLayout.copyButton')"
                @click="starrocksLayoutCopyOpen = true"
                data-starrocks-layout-copy-button
              >
                <SlidersHorizontal :class="structureIconClass" /><span class="structure-toolbar-label">{{ t("starrocksLayout.copyButton") }}</span>
              </Button>
              <Button
                v-if="activeTab === 'columns'"
                size="sm"
                variant="outline"
                :class="[structureToolbarButtonClass, 'structure-toolbar-action structure-toolbar-secondary']"
                :disabled="!canAddColumn"
                :title="t('structureEditor.copyColumns')"
                :aria-label="t('structureEditor.copyColumns')"
                @click="openCopyColumnsDialog"
              >
                <Copy :class="structureIconClass" />
                <span class="structure-toolbar-label">{{ t("structureEditor.copyColumns") }}</span>
              </Button>
              <Button
                v-if="activeTab === 'columns' && databaseType === 'mysql'"
                size="sm"
                variant="outline"
                :class="[structureToolbarButtonClass, 'structure-toolbar-action structure-toolbar-secondary']"
                :disabled="!canPasteColumns"
                :title="t('tableColumnPaste.title')"
                :aria-label="t('tableColumnPaste.title')"
                data-column-paste-button
                @click="pasteColumnsDialogOpen = true"
              >
                <ClipboardList :class="structureIconClass" />
                <span class="structure-toolbar-label">{{ t("tableColumnPaste.title") }}</span>
              </Button>
              <Button
                v-if="activeTab === 'columns'"
                size="sm"
                variant="outline"
                :class="[structureToolbarButtonClass, 'structure-toolbar-action structure-toolbar-secondary']"
                :disabled="copyableStructureColumnNames.length === 0"
                :title="t('grid.copyColumnNames')"
                :aria-label="t('grid.copyColumnNames')"
                @click="copyColumnNamesDialogOpen = true"
              >
                <Rows3 :class="structureIconClass" />
                <span class="structure-toolbar-label">{{ t("grid.copyColumnNames") }}</span>
              </Button>
              <Button
                v-if="activeTab === 'columns'"
                size="sm"
                variant="outline"
                :class="[structureToolbarButtonClass, 'structure-toolbar-action structure-toolbar-secondary']"
                :disabled="!canAddColumn"
                :title="t('structureEditor.columnTemplates')"
                :aria-label="t('structureEditor.columnTemplates')"
                @click="applyColumnTemplate(PRESET_FIELDS_TEMPLATE_ID)"
              >
                <Plus :class="structureIconClass" />
                <span class="structure-toolbar-label">{{ t("structureEditor.columnTemplates") }}</span>
              </Button>
              <Tooltip v-if="activeTab === 'columns'">
                <TooltipTrigger as-child>
                  <Button size="sm" variant="ghost" :class="structureToolbarButtonClass" :disabled="!canAddColumn" :aria-label="t('structureEditor.configureColumnTemplates')" @click="emit('openSettings', 'data', 'tableColumnTemplates')">
                    <Settings :class="structureIconClass" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{{ t("structureEditor.configureColumnTemplates") }}</TooltipContent>
              </Tooltip>
              <div v-if="activeTab === 'indexes'" class="structure-toolbar-search relative flex w-40 shrink-0 items-center">
                <Search :class="[structureIconClass, 'pointer-events-none absolute left-2 text-muted-foreground']" />
                <Input ref="indexSearchInputRef" v-model="indexSearchText" :placeholder="t('structureEditor.searchIndexes')" :class="[structureControlClass, 'pl-7 pr-14 text-[length:var(--structure-font-size)] placeholder:text-[length:var(--structure-font-size)]']" @keydown="onIndexSearchKeydown" />
                <button
                  v-if="indexSearchText"
                  type="button"
                  class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 text-[length:var(--structure-font-size)] text-muted-foreground hover:bg-muted hover:text-foreground"
                  :title="t('structureEditor.nextIndexMatch')"
                  @click="scrollToIndexSearchMatch(1)"
                >
                  {{ indexSearchMatchCount }}
                </button>
              </div>
              <Button v-if="activeTab === 'indexes'" size="sm" :class="[structureToolbarButtonClass, 'structure-toolbar-action']" :disabled="!structureCapabilities.createIndex || indexesLoading" :title="t('structureEditor.addIndex')" :aria-label="t('structureEditor.addIndex')" @click="addIndex">
                <Plus :class="structureIconClass" />
                <span class="structure-toolbar-label">{{ t("structureEditor.addIndex") }}</span>
              </Button>
              <Button
                v-if="activeTab === 'foreignKeys'"
                size="sm"
                :class="[structureToolbarButtonClass, 'structure-toolbar-action']"
                :disabled="!canEditForeignKeys || foreignKeysLoading"
                :title="t('structureEditor.addForeignKey')"
                :aria-label="t('structureEditor.addForeignKey')"
                @click="addForeignKey"
              >
                <Plus :class="structureIconClass" />
                <span class="structure-toolbar-label">{{ t("structureEditor.addForeignKey") }}</span>
              </Button>
              <template v-if="activeTab === 'constraints' && isOracleConstraintEditor">
                <Button
                  size="sm"
                  :class="[structureToolbarButtonClass, 'structure-toolbar-action']"
                  :disabled="saving || oracleConstraintBusy || !!oracleConstraintDraft"
                  :title="t('structureEditor.addCheckConstraint')"
                  :aria-label="t('structureEditor.addCheckConstraint')"
                  @click="addOracleConstraint('check')"
                  ><Plus :class="structureIconClass" /><span class="structure-toolbar-label">{{ t("structureEditor.addCheckConstraint") }}</span></Button
                >
                <Button
                  size="sm"
                  :class="[structureToolbarButtonClass, 'structure-toolbar-action']"
                  :disabled="saving || oracleConstraintBusy || !!oracleConstraintDraft"
                  :title="t('structureEditor.addUniqueConstraint')"
                  :aria-label="t('structureEditor.addUniqueConstraint')"
                  @click="addOracleConstraint('unique')"
                  ><Plus :class="structureIconClass" /><span class="structure-toolbar-label">{{ t("structureEditor.addUniqueConstraint") }}</span></Button
                >
              </template>
              <Button v-if="activeTab === 'triggers'" size="sm" :class="[structureToolbarButtonClass, 'structure-toolbar-action']" :disabled="!canEditTriggers || triggersLoading" :title="t('structureEditor.addTrigger')" :aria-label="t('structureEditor.addTrigger')" @click="addTrigger">
                <Plus :class="structureIconClass" />
                <span class="structure-toolbar-label">{{ t("structureEditor.addTrigger") }}</span>
              </Button>
            </div>
          </div>

          <TabsContent v-if="tableMetadataCapabilities.columns" value="columns" class="col-start-1 row-start-2 m-0 min-h-0 flex-1 overflow-hidden p-0">
            <CustomContextMenu :items="activeColumnContextMenuItems" @close="clearColumnContextMenuTarget" v-slot="columnContextMenuSlot">
              <RecycleScroller
                ref="columnsScrollerRef"
                class="structure-column-virtual-scroller structure-table-scroller h-full overflow-auto"
                :style="{
                  '--structure-column-table-width': columnTableWidth + 'px',
                  '--structure-column-row-height': structureColumnRowHeight + 'px',
                }"
                :items="columnVirtualRows"
                :item-size="columnVirtualItemSize"
                :min-item-size="structureColumnRowHeight"
                size-field="size"
                :buffer="STRUCTURE_COLUMN_VIRTUAL_BUFFER_PX"
                :prerender="STRUCTURE_COLUMN_VIRTUAL_PRERENDER_ROWS"
                :emit-update="true"
                :flow-mode="useColumnVirtualFlowMode"
                :skip-hover="true"
                key-field="id"
                item-class="structure-column-virtual-row"
                list-class="structure-column-virtual-list"
                @scroll.passive="onStructureContentScroll('columns', $event)"
                @update="onColumnVirtualRowsUpdated"
              >
                <template #before>
                  <table class="structure-column-virtual-header-table border-separate border-spacing-0 text-[length:var(--structure-font-size)] leading-[var(--structure-line-height)]">
                    <colgroup>
                      <col v-for="(width, index) in visibleColWidths" :key="index" :style="{ width: width + 'px' }" />
                    </colgroup>
                    <thead class="bg-background">
                      <tr>
                        <th
                          v-for="(columnLabel, i) in colLabels"
                          :key="columnLabel.key"
                          :class="[structureHeaderCellClass, 'bg-background select-none', { 'text-center': columnLabel.key === 'primaryKey' || columnLabel.key === 'nullable' }]"
                          :data-column-selected="columnLabel.key === 'actions' ? undefined : selectedStructureColumnKeys.has(columnLabel.key)"
                          :style="{
                            width: visibleColWidths[i] + 'px',
                            minWidth: visibleColWidths[i] + 'px',
                          }"
                          @click="selectStructureColumnKey(columnLabel.key, $event)"
                        >
                          <template v-if="columnLabel.key === 'actions'">
                            <div class="flex min-w-0 items-center">
                              <span class="shrink-0 border-r pr-0.5 text-center text-muted-foreground" :style="{ width: columnOrdinalIndicatorWidth + 'px' }">#</span>
                              <span class="min-w-0 flex-1 pl-0.5 text-center">{{ columnLabel.label }}</span>
                            </div>
                          </template>
                          <template v-else>{{ columnLabel.label }}</template>
                          <div
                            v-if="columnLabel.key !== 'actions' && i < colLabels.length - 1"
                            class="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30"
                            :class="colResizing?.col === columnWidthIndex(i) ? 'bg-primary/30' : ''"
                            @mousedown="onColResize($event, i)"
                            @click.stop
                          />
                        </th>
                      </tr>
                    </thead>
                  </table>
                </template>
                <template #default="{ item: { column, index, size }, active }">
                  <table class="structure-column-virtual-row-table border-separate border-spacing-0 text-[length:var(--structure-font-size)] leading-[var(--structure-line-height)]" :style="{ height: (size || structureColumnRowHeight) + 'px' }">
                    <colgroup>
                      <col v-for="(width, columnIndex) in visibleColWidths" :key="columnIndex" :style="{ width: width + 'px' }" />
                    </colgroup>
                    <tbody class="structure-edit-grid">
                      <tr
                        :class="[columnRowClass(column, index), { 'structure-column-search-current': columnContextMenuSlot.isOpen && columnContextMenuTarget?.id === column.id && !column.markedForDrop && !selectedColumnIds.has(column.id) }]"
                        :data-new-column-row="!column.original ? 'true' : undefined"
                        :data-column-row-index="index"
                        :data-column-id="column.id"
                        :data-column-row-active="active ? 'true' : 'false'"
                        :style="{ height: (size || structureColumnRowHeight) + 'px' }"
                        @mousedown="onColumnRowMouseDown($event)"
                        @click="onColumnRowClick(column, $event)"
                        @focusin="onColumnRowActivate(column)"
                        @contextmenu="openColumnContextMenu($event, column, columnContextMenuSlot.onContextMenu)"
                        @dragover="onColumnDragOver(index, $event)"
                        @drop="onColumnDrop(index, $event)"
                      >
                        <td :class="[structureCellClass, structureColumnSelectionClass('actions')]">
                          <div class="flex min-w-0 items-center">
                            <div class="flex shrink-0 items-center justify-center gap-1 border-r pr-0.5 text-muted-foreground" :style="{ width: columnOrdinalIndicatorWidth + 'px' }">
                              <span class="tabular-nums">{{ index + 1 }}</span>
                              <KeyRound v-for="indicator in columnIndexIndicators(column)" :key="indicator.kind" :class="[structureIconClass, indexIconClass(indicator.kind), 'shrink-0']" :title="indicator.title" :aria-label="indicator.title" :data-index-kind="indicator.kind" />
                            </div>
                            <div class="flex min-w-0 items-center gap-0.5 pl-0.5">
                              <Button
                                v-if="canShowColumnDragControls"
                                type="button"
                                variant="ghost"
                                size="icon"
                                :class="[structureActionButtonClass, canDragColumn(index) ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed', hasLocalColumnOrderChange ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary' : '']"
                                :disabled="!canDragColumn(index)"
                                :title="t('structureEditor.dragColumn')"
                                :aria-label="t('structureEditor.dragColumn')"
                                :draggable="canDragColumn(index)"
                                @pointerdown="onColumnDragPointerDown(index, $event)"
                                @dragstart="onColumnDragStart(index, $event)"
                                @dragend="onColumnDragEnd"
                              >
                                <ListChevronsUpDown :class="structureIconClass" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                :class="structureActionButtonClass"
                                :disabled="!canAddColumn || column.markedForDrop"
                                :aria-label="t('structureEditor.copyColumn')"
                                aria-keyshortcuts="Control+D Meta+D"
                                :title="t('structureEditor.copyColumn') + ' ⌘/Ctrl+D'"
                                data-copy-column-shortcut-button
                                @click.stop="copyColumn(column)"
                              >
                                <Copy :class="structureIconClass" />
                              </Button>
                              <Button
                                v-if="column.original"
                                variant="ghost"
                                size="icon"
                                :class="structureActionButtonClass"
                                :disabled="!canDropColumn(column)"
                                :aria-label="column.markedForDrop ? t('structureEditor.restore') : t('structureEditor.drop')"
                                :aria-keyshortcuts="column.markedForDrop ? undefined : 'Control+Delete Meta+Delete'"
                                :title="deleteColumnActionLabel(column) + (column.markedForDrop ? '' : ' ⌘/Ctrl+Del')"
                                data-delete-column-shortcut-button
                                @click.stop="toggleDropColumn(column)"
                              >
                                <RefreshCw v-if="column.markedForDrop" :class="structureIconClass" />
                                <Trash2 v-else :class="structureIconClass" />
                              </Button>
                              <Button
                                v-else
                                variant="ghost"
                                size="icon"
                                :class="structureActionButtonClass"
                                :aria-label="t('structureEditor.remove')"
                                aria-keyshortcuts="Control+Delete Meta+Delete"
                                :title="t('structureEditor.remove') + ' ⌘/Ctrl+Del'"
                                data-delete-column-shortcut-button
                                @click.stop="removeNewColumn(column)"
                              >
                                <X :class="structureIconClass" />
                              </Button>
                            </div>
                          </div>
                        </td>
                        <td :class="[structureCellClass, structureColumnSelectionClass('name')]" :title="[column.name, columnIndexTitle(column)].filter(Boolean).join('\n') || undefined">
                          <Input v-model="column.name" :class="[structureControlClass, columnSearchFieldClass(column, column.name)]" :disabled="isColumnNameDisabled(column)" data-column-name-input @blur="commitColumnNameInput(column)" />
                        </td>
                        <td :class="[structureCellClass, 'structure-column-data-type', structureDataTypeToneClass(column.dataType), structureColumnSelectionClass('type')]" :title="gaussdbMDataTypeDisplayName(column.dataType) || undefined">
                          <SearchableSelect
                            v-if="!isColumnTypeDisabled(column)"
                            :model-value="dataTypeBaseInputValue(databaseType, column.dataType)"
                            :options="dataTypeOptions"
                            :placeholder="t('structureEditor.typePlaceholder')"
                            :search-placeholder="t('structureEditor.typePlaceholder')"
                            :empty-text="t('structureEditor.noMatchingType')"
                            :loading-text="t('common.loading')"
                            :allow-custom="true"
                            :option-tooltip="dataTypeTooltip"
                            :display-name="gaussdbMDataTypeDisplayName"
                            :trigger-class="[structureMonoControlClass, 'w-full']"
                            @update:model-value="(v: string) => updateColumnDataType(column, v)"
                          >
                            <template #option-label="{ option, label }">
                              <span :class="['structure-data-type-option block truncate font-mono', structureDataTypeToneClass(option)]">{{ label }}</span>
                            </template>
                            <template #custom-option-label="{ value }">
                              <span :class="['structure-data-type-option block truncate font-mono', structureDataTypeToneClass(value)]">{{ value }}</span>
                            </template>
                          </SearchableSelect>
                          <Input v-else :model-value="gaussdbMDataTypeDisplayName(dataTypeBaseInputValue(databaseType, column.dataType))" :class="[structureMonoControlClass, 'w-full']" disabled />
                        </td>
                        <td v-if="columnEditorControls.length" :class="[structureCellClass, structureColumnSelectionClass('length')]" :title="structureColumnClipboardValue(column, 'length') || undefined">
                          <Popover v-if="isMysqlEnumDataType(databaseType, column.dataType)">
                            <PopoverTrigger as-child>
                              <Button variant="outline" size="sm" :class="[structureMonoControlClass, 'w-full justify-between px-2']" :disabled="isColumnTypeDisabled(column)">
                                <span>{{ t("structureEditor.enumValueCount", { count: column.enumValues?.length ?? 0 }) }}</span>
                                <ListChevronsUpDown :class="structureIconClass" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent class="w-80 p-3" align="start">
                              <div class="mb-2 flex items-center justify-between gap-2">
                                <span class="text-sm font-medium">{{ t("structureEditor.enumValues") }}</span>
                                <Button variant="outline" size="sm" class="h-7 px-2" @click="addMysqlEnumValue(column)">
                                  <Plus class="mr-1 h-3.5 w-3.5" />
                                  {{ t("structureEditor.addEnumValue") }}
                                </Button>
                              </div>
                              <div class="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                                <div v-for="(value, valueIndex) in column.enumValues" :key="valueIndex" class="flex items-center gap-1.5">
                                  <Input :model-value="value" :class="structureMonoControlClass" :placeholder="t('structureEditor.enumValuePlaceholder')" @update:model-value="updateMysqlEnumValue(column, Number(valueIndex), $event)" />
                                  <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" :disabled="(column.enumValues?.length ?? 0) <= 1" :title="t('structureEditor.removeEnumValue')" @click="removeMysqlEnumValue(column, Number(valueIndex))">
                                    <Trash2 class="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                          <div v-else-if="isPostgresGeometryDataType(databaseType, column.dataType)" class="flex min-w-0 flex-col gap-0.5">
                            <div class="flex min-w-0 items-center gap-1" :title="t('structureEditor.geometrySridHint')">
                              <SearchableSelect
                                :model-value="postgresGeometryTypeValue(column.dataType)"
                                :options="[...POSTGRES_GEOMETRY_TYPES]"
                                :allow-custom="true"
                                :clearable="true"
                                :placeholder="t('structureEditor.geometryTypePlaceholder')"
                                :search-placeholder="t('structureEditor.geometryTypePlaceholder')"
                                :empty-text="t('structureEditor.noMatchingType')"
                                :trigger-class="[structureMonoControlClass, 'min-w-0 flex-1']"
                                :disabled="isColumnTypeDisabled(column)"
                                @update:model-value="(v: string) => updatePostgresGeometryColumn(column, v, postgresGeometrySridValue(column.dataType))"
                              />
                              <Input
                                :model-value="postgresGeometrySridValue(column.dataType)"
                                :class="[structureMonoControlClass, 'w-20 shrink-0']"
                                type="number"
                                min="0"
                                max="999999"
                                :placeholder="t('structureEditor.sridPlaceholder')"
                                :disabled="isColumnTypeDisabled(column)"
                                @update:model-value="(v: string | number) => updatePostgresGeometryColumn(column, postgresGeometryTypeValue(column.dataType), String(v))"
                              />
                            </div>
                            <!-- The virtual row reserves exactly one line for this hint, so it must not wrap (#13835). -->
                            <p v-if="!postgresGeometryTypeValue(column.dataType) && postgresGeometrySridValue(column.dataType)" class="truncate text-[length:var(--structure-font-size)] text-muted-foreground leading-tight" :title="t('structureEditor.geometryEmptyTypeHint')">
                              {{ t("structureEditor.geometryEmptyTypeHint") }}
                            </p>
                          </div>
                          <div v-else class="flex min-w-0 items-center gap-1">
                            <Input :model-value="dataTypeLengthInputValue(databaseType, column.dataType)" :class="[structureMonoControlClass, 'min-w-0 flex-1']" :disabled="isColumnLengthDisabled(column)" @update:model-value="updateColumnDataTypeLength(column, $event)" />
                            <Select v-if="columnLengthUnitOptions(column).length" :model-value="dataTypeLengthUnitValue(databaseType, column.dataType) || '__default'" :disabled="isColumnLengthUnitDisabled(column)" @update:model-value="updateColumnDataTypeLengthUnit(column, $event)">
                              <SelectTrigger
                                :aria-label="t('structureEditor.lengthUnit')"
                                :title="t('structureEditor.lengthUnit')"
                                size="sm"
                                class="structure-grid-control h-[var(--structure-control-height)] w-16 shrink-0 rounded-[6px] px-[var(--structure-control-px)] py-0 font-mono text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25"
                              >
                                <SelectValue :placeholder="t('structureEditor.unitPlaceholder')" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__default">{{ t("structureEditor.defaultAction") }}</SelectItem>
                                <SelectItem v-for="unit in columnLengthUnitOptions(column)" :key="unit" :value="unit">{{ unit }}</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </td>
                        <td v-if="columnEditorControls.nullable" :class="[structureCellClass, 'text-center', structureColumnSelectionClass('nullable')]">
                          <input v-model="column.isNullable" type="checkbox" :class="structureCheckboxClass" :disabled="isColumnNullableDisabled(column)" :aria-label="t('structureEditor.nullable')" />
                        </td>
                        <td v-if="columnEditorControls.primaryKey" :class="[structureCellClass, 'text-center', structureColumnSelectionClass('primaryKey')]">
                          <input
                            v-model="column.isPrimaryKey"
                            type="checkbox"
                            :class="structureCheckboxClass"
                            :disabled="isPrimaryKeyDisabled(column)"
                            :aria-label="t('structureEditor.primaryKey')"
                            @change="
                              () => {
                                if (column.isPrimaryKey) column.isNullable = false;
                              }
                            "
                          />
                        </td>
                        <td v-if="columnEditorControls.defaultValue" :class="[structureCellClass, 'structure-column-default-value', structureDefaultValueToneClass(column.defaultValue, column.dataType), structureColumnSelectionClass('defaultValue')]" :title="column.defaultValue || undefined">
                          <div class="flex min-w-0 items-center gap-1">
                            <Input v-model="column.defaultValue" :class="[structureMonoControlClass, 'flex-1']" :disabled="isColumnDefaultDisabled(column)" />
                            <DropdownMenu>
                              <DropdownMenuTrigger as-child>
                                <Button variant="ghost" size="icon" :class="[structureIconButtonClass, 'shrink-0']" :disabled="isColumnDefaultDisabled(column)" :aria-label="t('structureEditor.defaultValuePresets')" :title="t('structureEditor.defaultValuePresets')">
                                  <ChevronDown :class="structureIconClass" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" class="max-h-56 w-max min-w-36 max-w-[calc(100vw-1rem)] overflow-y-auto">
                                <DropdownMenuItem v-for="preset in columnDefaultValuePresets(column)" :key="preset.value" @click="column.defaultValue = preset.value">
                                  <code :class="['structure-data-type-option block truncate font-mono text-[length:var(--structure-font-size)]', structureDefaultValueToneClass(preset.value, preset.dataType)]">{{ preset.label }}</code>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </td>
                        <td v-if="columnEditorControls.comment" :class="[structureCellClass, structureColumnSelectionClass('comment')]" :title="column.comment || undefined">
                          <div class="flex min-w-0 items-center gap-1">
                            <Input v-model="column.comment" :class="[structureControlClass, 'flex-1', columnSearchFieldClass(column, column.comment)]" :disabled="isColumnCommentDisabled(column)" />
                            <Popover>
                              <PopoverTrigger as-child>
                                <Button variant="ghost" size="icon" :class="[structureIconButtonClass, 'shrink-0']" :disabled="isColumnCommentDisabled(column)" :aria-label="t('structureEditor.editComment')" :title="t('structureEditor.editComment')">
                                  <Maximize2 :class="structureIconClass" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent align="end" class="w-[420px] p-2.5">
                                <div class="mb-2 flex items-center justify-between gap-2">
                                  <span class="min-w-0 truncate text-xs font-medium">
                                    {{ t("structureEditor.editComment") }}
                                  </span>
                                  <span class="max-w-44 truncate font-mono text-[length:var(--structure-font-size)] text-muted-foreground">
                                    {{ column.name || t("structureEditor.columnName") }}
                                  </span>
                                </div>
                                <textarea
                                  v-model="column.comment"
                                  class="min-h-36 w-full resize-y rounded-[6px] border bg-background px-[var(--structure-control-px)] py-[var(--structure-cell-py)] text-[length:var(--structure-font-size)] leading-5 outline-none focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50"
                                  :placeholder="t('structureEditor.commentPlaceholder')"
                                  :disabled="isColumnCommentDisabled(column)"
                                />
                              </PopoverContent>
                            </Popover>
                          </div>
                        </td>
                        <td v-if="showCharacterSet" :class="[structureCellClass, structureColumnSelectionClass('characterSet')]" :title="columnCharset(column) || undefined">
                          <SearchableSelect
                            :model-value="columnCharset(column)"
                            :options="mysqlCharsetOptions"
                            :placeholder="t('structureEditor.charsetPlaceholder')"
                            :search-placeholder="t('structureEditor.charsetPlaceholder')"
                            :empty-text="t('structureEditor.noMatchingType')"
                            :allow-custom="true"
                            :disabled="isColumnCharsetDisabled(column)"
                            :trigger-class="[structureMonoControlClass, 'w-full']"
                            @update:model-value="(v: string) => onCharsetChange(column, v)"
                          />
                        </td>
                        <td v-if="showCharacterSet" :class="[structureCellClass, structureColumnSelectionClass('collation')]" :title="columnCollation(column) || undefined">
                          <SearchableSelect
                            :model-value="columnCollation(column)"
                            :options="collationOptionsForCharset(columnCharset(column))"
                            :placeholder="t('structureEditor.collationPlaceholder')"
                            :search-placeholder="t('structureEditor.collationPlaceholder')"
                            :empty-text="t('structureEditor.noMatchingType')"
                            :allow-custom="true"
                            :disabled="isColumnCharsetDisabled(column)"
                            :trigger-class="[structureMonoControlClass, 'w-full']"
                            @update:model-value="(v: string) => (column.collation = v)"
                          />
                        </td>
                        <td v-if="showExtendedProperties" :class="[structureCellClass, structureColumnSelectionClass('extendedProperties')]">
                          <div :class="structurePropertyListClass" data-structure-extended-properties>
                            <!-- Manticore Search: character data type properties -->
                            <template v-if="databaseType === 'manticoresearch'">
                              <template v-if="isManticoreTextColumn(column)">
                                <label :class="structurePropertyLabelClass" title="indexed">
                                  <input :checked="!!column.extra.manticoreIndexed" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="isManticoreColumnPropertyDisabled(column)" @change="column.extra.manticoreIndexed = ($event.target as HTMLInputElement).checked" />
                                  <span class="min-w-0 truncate">indexed</span>
                                </label>
                                <label :class="structurePropertyLabelClass" title="stored">
                                  <input :checked="!!column.extra.manticoreStored" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="isManticoreColumnPropertyDisabled(column)" @change="column.extra.manticoreStored = ($event.target as HTMLInputElement).checked" />
                                  <span class="min-w-0 truncate">stored</span>
                                </label>
                                <label :class="structurePropertyLabelClass" title="attribute">
                                  <input :checked="!!column.extra.manticoreAttribute" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="isManticoreColumnPropertyDisabled(column)" @change="column.extra.manticoreAttribute = ($event.target as HTMLInputElement).checked" />
                                  <span class="min-w-0 truncate">attribute</span>
                                </label>
                              </template>
                              <template v-else-if="isManticoreJsonColumn(column)">
                                <label :class="structurePropertyLabelClass" title="secondary_index">
                                  <input
                                    :checked="!!column.extra.manticoreSecondaryIndex"
                                    type="checkbox"
                                    :class="[structureCheckboxClass, 'shrink-0']"
                                    :disabled="isManticoreColumnPropertyDisabled(column)"
                                    @change="column.extra.manticoreSecondaryIndex = ($event.target as HTMLInputElement).checked"
                                  />
                                  <span class="min-w-0 truncate">secondary_index</span>
                                </label>
                              </template>
                            </template>
                            <!-- MySQL: AUTO_INCREMENT + ON UPDATE CURRENT_TIMESTAMP -->
                            <template v-else-if="structureDialect === 'sqlite'">
                              <label :class="[structurePropertyLabelClass, 'shrink-0 pr-1']" :title="t('structureEditor.autoIncrement')">
                                <input :checked="isSqliteAutoIncrement(column)" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="!canEditSqliteAutoIncrement(column)" @change="setSqliteAutoIncrement(column, ($event.target as HTMLInputElement).checked)" />
                                <span>{{ t("structureEditor.autoIncrement") }}</span>
                              </label>
                            </template>
                            <template v-else-if="structureDialect === 'mysql'">
                              <label :class="[structurePropertyLabelClass, 'shrink-0 pr-1']" :title="t('structureEditor.virtual')">
                                <input :checked="isMysqlGeneratedChecked(column)" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" @change="setMysqlGenerated(column, ($event.target as HTMLInputElement).checked)" />
                                <span>{{ t("structureEditor.virtual") }}</span>
                              </label>
                              <Popover v-if="isMysqlGeneratedChecked(column)">
                                <PopoverTrigger as-child>
                                  <Button variant="ghost" size="icon" :class="[structureIconButtonClass, 'mr-1 shrink-0']" :title="t('structureEditor.generatedExpression')" :aria-label="t('structureEditor.generatedExpression')" data-mysql-generated-expression-trigger>
                                    <SquareFunction :class="structureIconClass" />
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent align="start" class="w-96 space-y-2 p-3">
                                  <label class="block text-xs font-medium text-foreground">{{ t("structureEditor.generatedExpression") }}</label>
                                  <Input
                                    :model-value="column.extra.generated?.expression ?? ''"
                                    class="w-full font-mono"
                                    :placeholder="t('structureEditor.generatedExpressionPlaceholder')"
                                    data-mysql-generated-expression
                                    :aria-label="t('structureEditor.generatedExpression')"
                                    @update:model-value="(v) => updateMysqlGeneratedExpression(column, String(v ?? ''))"
                                  />
                                  <p v-if="!isMysqlGeneratedActive(column)" class="text-xs text-destructive">{{ t("structureEditor.generatedExpressionEmptyHint") }}</p>
                                  <div class="flex items-center gap-2">
                                    <label class="text-xs text-muted-foreground">{{ t("structureEditor.generatedStorage") }}</label>
                                    <Select :model-value="column.extra.generated?.storage ?? 'VIRTUAL'" @update:model-value="(v) => updateMysqlGeneratedStorage(column, String(v ?? 'VIRTUAL'))">
                                      <SelectTrigger class="h-[var(--structure-control-height)] w-28 rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="VIRTUAL">{{ t("structureEditor.generatedStorageVirtual") }}</SelectItem>
                                        <SelectItem value="STORED">{{ t("structureEditor.generatedStorageStored") }}</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <p class="text-xs leading-5 text-muted-foreground">{{ t("structureEditor.generatedExpressionHint") }}</p>
                                </PopoverContent>
                              </Popover>
                              <label :class="[structurePropertyLabelClass, 'shrink-0 pr-1']" :title="t('structureEditor.autoIncrement')">
                                <input :checked="column.extra.autoIncrement" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="isMysqlGeneratedActive(column)" @change="setMysqlAutoIncrement(column, ($event.target as HTMLInputElement).checked)" />
                                <span>{{ t("structureEditor.autoIncrement") }}</span>
                              </label>
                              <Popover v-if="isMysqlAutoIncrementCounterColumn(column)">
                                <PopoverTrigger as-child>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    :class="[structureIconButtonClass, 'mr-1 shrink-0']"
                                    :title="t(isCreateMode ? 'structureEditor.editMysqlAutoIncrementStartValue' : 'structureEditor.editMysqlAutoIncrementValue', { value: mysqlAutoIncrementValue || '—' })"
                                    :aria-label="t(isCreateMode ? 'structureEditor.editMysqlAutoIncrementStartValue' : 'structureEditor.editMysqlAutoIncrementValue', { value: mysqlAutoIncrementValue || '—' })"
                                    data-mysql-auto-increment-editor-trigger
                                  >
                                    <Loader2 v-if="mysqlAutoIncrementLoading" :class="[structureIconClass, 'animate-spin text-muted-foreground']" />
                                    <AlertTriangle v-else-if="mysqlAutoIncrementLoadError" :class="[structureIconClass, 'text-destructive']" />
                                    <Pencil v-else :class="structureIconClass" />
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent align="start" class="w-80 space-y-2 p-3">
                                  <label class="block text-xs font-medium text-foreground">{{ t(isCreateMode ? "structureEditor.mysqlAutoIncrementStartValue" : "structureEditor.mysqlAutoIncrementNextValue") }}</label>
                                  <Input
                                    :model-value="mysqlAutoIncrementValue"
                                    inputmode="numeric"
                                    pattern="[0-9]*"
                                    autocomplete="off"
                                    data-mysql-auto-increment-counter
                                    :aria-label="t(isCreateMode ? 'structureEditor.mysqlAutoIncrementStartValue' : 'structureEditor.mysqlAutoIncrementNextValue')"
                                    :placeholder="isCreateMode ? '1' : mysqlAutoIncrementLoading ? t('common.loading') : '—'"
                                    :title="mysqlAutoIncrementLoadError || undefined"
                                    class="w-full font-mono"
                                    :disabled="(!isCreateMode && (mysqlAutoIncrementLoading || !!mysqlAutoIncrementLoadError || originalMysqlAutoIncrementValue === undefined)) || saving"
                                    @input.capture="onMysqlAutoIncrementInput"
                                  />
                                  <p v-if="mysqlAutoIncrementLoadError" class="text-xs text-destructive">{{ mysqlAutoIncrementLoadError }}</p>
                                  <p class="text-xs leading-5 text-muted-foreground">{{ t(isCreateMode ? "structureEditor.mysqlAutoIncrementStartHint" : "contextMenu.mysqlAutoIncrementNonemptyHint") }}</p>
                                </PopoverContent>
                              </Popover>
                              <label :class="[structurePropertyLabelClass, 'shrink-0']" :title="t('structureEditor.onUpdateCurrentTimestamp')">
                                <input v-model="column.extra.onUpdateCurrentTimestamp" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="isMysqlGeneratedActive(column)" />
                                <span>{{ t("structureEditor.onUpdateCurrentTimestamp") }}</span>
                              </label>
                            </template>
                            <!-- Dameng: IDENTITY -->
                            <template v-else-if="databaseType === 'dameng'">
                              <label :class="structurePropertyLabelClass" :title="t('structureEditor.identity')">
                                <input :checked="isDamengIdentityChecked(column)" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="!canEditDamengIdentity(column)" @change="setDamengIdentity(column, ($event.target as HTMLInputElement).checked)" />
                                <span class="min-w-0 truncate">{{ t("structureEditor.autoIncrement") }}</span>
                              </label>
                              <template v-if="isDamengIdentityChecked(column)">
                                <Input
                                  :model-value="column.extra.identity?.seed?.toString() ?? '1'"
                                  type="number"
                                  :class="[structureControlClass, 'w-14']"
                                  :placeholder="t('structureEditor.identitySeed')"
                                  :disabled="!canEditDamengIdentityParameters(column)"
                                  @update:model-value="(v) => updateDamengIdentitySeed(column, v)"
                                />
                                <Input
                                  :model-value="column.extra.identity?.increment?.toString() ?? '1'"
                                  type="number"
                                  :class="[structureControlClass, 'w-14']"
                                  :placeholder="t('structureEditor.identityIncrement')"
                                  :disabled="!canEditDamengIdentityParameters(column)"
                                  @update:model-value="(v) => updateDamengIdentityIncrement(column, v)"
                                />
                              </template>
                            </template>
                            <!-- PostgreSQL: IDENTITY -->
                            <template v-else-if="structureDialect === 'postgres'">
                              <Select
                                :model-value="column.extra.identity?.generation ?? 'none'"
                                :disabled="isCreatingForeignTable"
                                @update:model-value="
                                  (value: any) => {
                                    const generation = String(value ?? '');
                                    if (generation && generation !== 'none') {
                                      column.extra.identity = {
                                        ...column.extra.identity,
                                        generation: generation as 'BY DEFAULT' | 'ALWAYS',
                                      };
                                    } else {
                                      column.extra.identity = undefined;
                                    }
                                  }
                                "
                              >
                                <SelectTrigger size="sm" class="structure-grid-control h-[var(--structure-control-height)] w-28 rounded-[6px] px-[var(--structure-control-px)] py-0 text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="none">{{ t("structureEditor.no") }}</SelectItem>
                                  <SelectItem value="BY DEFAULT">BY DEFAULT</SelectItem>
                                  <SelectItem value="ALWAYS">ALWAYS</SelectItem>
                                </SelectContent>
                              </Select>
                              <template v-if="column.extra.identity?.generation">
                                <Input
                                  :model-value="column.extra.identity.seed?.toString() ?? ''"
                                  type="number"
                                  :class="[structureControlClass, 'w-14']"
                                  :placeholder="t('structureEditor.identitySeed')"
                                  @update:model-value="
                                    (v) => {
                                      if (column.extra.identity) {
                                        column.extra.identity.seed = v ? Number(v) : undefined;
                                      }
                                    }
                                  "
                                />
                                <Input
                                  :model-value="column.extra.identity.increment?.toString() ?? ''"
                                  type="number"
                                  :class="[structureControlClass, 'w-14']"
                                  :placeholder="t('structureEditor.identityIncrement')"
                                  @update:model-value="
                                    (v) => {
                                      if (column.extra.identity) {
                                        column.extra.identity.increment = v ? Number(v) : undefined;
                                      }
                                    }
                                  "
                                />
                              </template>
                            </template>
                            <!-- SQL Server: IDENTITY -->
                            <template v-else-if="structureDialect === 'sqlserver'">
                              <label :class="structurePropertyLabelClass" :title="canEditSqlServerIdentity(column) || isSqlServerIdentityChecked(column) ? t('structureEditor.identity') : t('structureEditor.sqlServerIdentityTypeHint')">
                                <input :checked="isSqlServerIdentityChecked(column)" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="!canEditSqlServerIdentity(column)" @change="setSqlServerIdentity(column, ($event.target as HTMLInputElement).checked)" />
                                <span class="min-w-0 truncate">{{ t("structureEditor.autoIncrement") }}</span>
                              </label>
                              <template v-if="isSqlServerIdentityChecked(column)">
                                <Input
                                  :model-value="column.extra.identity?.seed?.toString() ?? '1'"
                                  type="number"
                                  :class="[structureControlClass, 'w-14']"
                                  :placeholder="t('structureEditor.identitySeed')"
                                  :disabled="!canEditSqlServerIdentity(column)"
                                  @update:model-value="(v) => updateSqlServerIdentitySeed(column, v)"
                                />
                                <Input
                                  :model-value="column.extra.identity?.increment?.toString() ?? '1'"
                                  type="number"
                                  :class="[structureControlClass, 'w-14']"
                                  :placeholder="t('structureEditor.identityIncrement')"
                                  :disabled="!canEditSqlServerIdentity(column)"
                                  @update:model-value="(v) => updateSqlServerIdentityIncrement(column, v)"
                                />
                              </template>
                            </template>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </template>
              </RecycleScroller>
            </CustomContextMenu>
          </TabsContent>

          <TabsContent ref="indexesScrollerRef" v-if="tableMetadataCapabilities.indexes" value="indexes" class="col-start-1 row-start-2 structure-table-scroller m-0 min-h-0 flex-1 overflow-auto p-0" @scroll.passive="onStructureContentScroll('indexes', $event)">
            <div v-if="indexesLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="secondaryMetadataErrors.indexes" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {{ secondaryMetadataErrors.indexes }}
            </div>
            <table v-else ref="indexesTableRef" class="structure-edit-grid border-separate border-spacing-0 text-[length:var(--structure-font-size)] leading-[var(--structure-line-height)]" :style="{ minWidth: indexColWidths.reduce((a, w) => a + w, 0) + 'px' }">
              <thead class="sticky top-0 z-10 bg-background">
                <tr>
                  <th
                    v-for="(label, i) in indexColLabels"
                    :key="i"
                    :class="[structureHeaderCellClass, { 'text-center': i === 2 || i === 7, 'cursor-pointer select-none': i === 1 }]"
                    :aria-sort="i === 1 ? (indexColumnSort === 'asc' ? 'ascending' : indexColumnSort === 'desc' ? 'descending' : 'none') : undefined"
                    :style="{
                      width: indexColWidths[i] + 'px',
                      minWidth: indexColWidths[i] + 'px',
                    }"
                    @click="i === 1 && toggleIndexColumnSort()"
                  >
                    <span class="inline-flex items-center gap-1">
                      {{ label }}
                      <span v-if="i === 1" class="text-[10px] text-muted-foreground">{{ indexColumnSort === "asc" ? "▲" : indexColumnSort === "desc" ? "▼" : "↕" }}</span>
                    </span>
                    <div v-if="i < indexColLabels.length - 1" class="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30" :class="resizing?.col === i ? 'bg-primary/30' : ''" @mousedown="onIndexColResize($event, i)" @click.stop />
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(index, rowIndex) in displayedIndexes" :key="index.id" :class="indexRowClass(index)" :data-index-row-id="index.id" :data-new-index-row="!index.original ? 'true' : undefined" :data-index-row-index="rowIndex">
                  <td :class="[structureCellClass, 'structure-index-name']">
                    <div class="flex min-w-0 items-center gap-1">
                      <KeyRound :class="[structureIconClass, 'structure-column-key-icon shrink-0']" :title="index.isPrimary ? 'PRIMARY' : index.isUnique ? 'UNIQUE' : index.indexType || 'INDEX'" />
                      <Input
                        :model-value="index.name"
                        :class="[structureControlClass, 'flex-1', { 'disabled:opacity-100': index.isPrimary }, indexSearchFieldClass(index, index.name)]"
                        :title="index.name"
                        :disabled="!canEditIndexDraft(index)"
                        data-index-name-input
                        @update:model-value="(value: string | number) => onIndexNameInput(index, value)"
                      />
                      <Button
                        v-if="canOpenPairedOracleConstraint(index)"
                        variant="ghost"
                        size="icon"
                        :disabled="saving || oracleConstraintBusy || !!oracleConstraintDraft"
                        :aria-label="`Edit unique constraint ${index.name}`"
                        :data-paired-unique-constraint="index.name"
                        @click="editOracleUniqueConstraintForIndex(index)"
                        >{{ t("common.edit") }}</Button
                      >
                      <LightTooltip v-if="!index.isPrimary" :text="t('structureEditor.regenerateIndexName')" side="top" nowrap>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          :class="[structureActionButtonClass, 'shrink-0']"
                          :disabled="!canEditIndexDraft(index) || !index.columns.length"
                          :aria-label="t('structureEditor.regenerateIndexName')"
                          data-regenerate-index-name
                          @click="regenerateIndexName(index)"
                        >
                          <RefreshCw :class="structureIconClass" />
                        </Button>
                      </LightTooltip>
                    </div>
                  </td>
                  <td :class="[structureCellClass, 'overflow-hidden']">
                    <StructureIndexColumnPicker v-if="canEditIndexDraft(index)" :selected="index.columns" :options="indexColumnPickerOptions(index)" :placeholder="t('structureEditor.indexColumnsPlaceholder')" :trigger-class="structureMonoControlClass" @toggle="toggleIndexColumn(index, $event)">
                      <template #type="{ column }">
                        <span :class="[structureDataTypeToneClass(column.dataType), 'structure-data-type-option']">{{ column.dataType }}</span>
                      </template>
                    </StructureIndexColumnPicker>
                    <span v-else class="font-mono text-[length:var(--structure-font-size)] text-muted-foreground">{{ toColumnNames(index.columns) }}</span>
                  </td>
                  <td :class="[structureCellClass, 'text-center']">
                    <input
                      :checked="index.isUnique"
                      type="checkbox"
                      :class="structureCheckboxClass"
                      :disabled="!canEditIndexDraft(index) || !!indexColumnsIssue(index, index.columns, index.indexType, true)"
                      data-index-unique
                      :aria-label="t('structureEditor.unique')"
                      @change="onIndexUniqueChange(index, ($event.target as HTMLInputElement).checked)"
                    />
                  </td>
                  <td :class="structureCellClass">
                    <Select v-if="indexTypeOptions.length > 0" :model-value="index.indexType || 'BTREE'" :disabled="!canEditIndexDraft(index)" data-index-type @update:model-value="(value: unknown) => onIndexTypeChange(index, value)">
                      <SelectTrigger
                        size="sm"
                        class="structure-grid-control h-[var(--structure-control-height)] w-full rounded-[6px] px-[var(--structure-control-px)] py-0 font-mono text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="opt in indexTypeOptions" :key="opt" :value="opt" :disabled="!!indexColumnsIssue(index, index.columns, opt, false)">{{ opt }}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input v-else :model-value="index.indexType" :class="structureMonoControlClass" placeholder="BTREE" :disabled="!canEditIndexDraft(index) || !structureCapabilities.indexType" @update:model-value="(value: unknown) => onIndexTypeChange(index, value)" />
                  </td>
                  <td :class="[structureCellClass, 'overflow-hidden']">
                    <StructureIndexColumnPicker
                      v-if="canEditIndexDraft(index) && structureCapabilities.indexInclude"
                      :selected="index.includedColumns"
                      :options="indexColumnPickerOptions(index, true)"
                      :placeholder="t('structureEditor.includedColumnsPlaceholder')"
                      :trigger-class="structureMonoControlClass"
                      @toggle="toggleIncludedColumn(index, $event)"
                    >
                      <template #type="{ column }">
                        <span :class="[structureDataTypeToneClass(column.dataType), 'structure-data-type-option']">{{ column.dataType }}</span>
                      </template>
                    </StructureIndexColumnPicker>
                    <span v-else class="text-[length:var(--structure-font-size)] text-muted-foreground">{{ index.includedColumns.join(", ") }}</span>
                  </td>
                  <td :class="structureCellClass">
                    <Input v-model="index.filter" :class="[structureMonoControlClass, indexSearchFieldClass(index, index.filter)]" :placeholder="index.original?.filter || ''" :disabled="!canEditIndexFilter(index)" />
                  </td>
                  <td :class="structureCellClass">
                    <Input v-model="index.comment" :class="[structureControlClass, indexSearchFieldClass(index, index.comment)]" :disabled="!canEditIndexComment(index)" />
                  </td>
                  <td :class="[structureCellClass, 'text-center']">
                    <label v-if="structureCapabilities.indexConcurrent" class="inline-flex items-center justify-center" :title="concurrentIndexCellTitle(index)">
                      <input v-model="index.concurrently" type="checkbox" :class="structureCheckboxClass" :disabled="!canEditIndexConcurrent(index)" :aria-label="t('structureEditor.concurrent')" />
                    </label>
                    <span v-else class="text-[length:var(--structure-font-size)] text-muted-foreground">—</span>
                  </td>
                  <td :class="structureLastCellClass">
                    <Badge v-if="index.isPrimary" variant="outline">{{ t("structureEditor.primary") }}</Badge>
                    <Button v-else-if="index.original" variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="!canDropIndex(index)" @click="toggleDropIndex(index)">
                      <Trash2 :class="structureIconClass" />
                      {{ index.markedForDrop ? t("structureEditor.restore") : t("structureEditor.drop") }}
                    </Button>
                    <Button v-else variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="removeNewIndex(index)">
                      <X :class="structureIconClass" />
                      {{ t("structureEditor.remove") }}
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </TabsContent>

          <div v-if="hasStructureHorizontalOverflow && (activeTab === 'columns' || activeTab === 'indexes')" ref="structureHorizontalScrollbarTrackRef" class="structure-horizontal-scrollbar col-start-1 row-start-3" @pointerdown="startStructureHorizontalScrollbarDrag">
            <div ref="structureHorizontalScrollbarThumbRef" class="structure-horizontal-scrollbar__thumb" />
          </div>

          <div
            v-if="hasStructureVerticalOverflow && (activeTab === 'columns' || activeTab === 'indexes')"
            ref="structureVerticalScrollbarTrackRef"
            class="structure-vertical-scrollbar col-start-2 row-start-2"
            :class="{ 'structure-vertical-scrollbar--scrolling': isStructureVerticalScrollbarScrolling, 'structure-vertical-scrollbar--dragging': isStructureVerticalScrollbarDragging }"
            @pointerdown="onStructureVerticalScrollbarTrackPointerDown"
          >
            <div ref="structureVerticalScrollbarThumbRef" class="structure-vertical-scrollbar__thumb" @pointerdown.stop="onStructureVerticalScrollbarThumbPointerDown" />
          </div>

          <TabsContent
            ref="foreignKeysScrollerRef"
            v-if="tableMetadataCapabilities.foreignKeys"
            value="foreignKeys"
            class="col-start-1 row-start-2 structure-card-scroller m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]"
            @scroll.passive="onStructureContentScroll('foreignKeys', $event)"
          >
            <div v-if="foreignKeysLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="secondaryMetadataErrors['foreign-keys']" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {{ secondaryMetadataErrors["foreign-keys"] }}
            </div>
            <div v-else-if="foreignKeys.length === 0" class="py-10 text-center text-muted-foreground">
              {{ t("structureEditor.emptyReadonly") }}
            </div>
            <div v-else class="space-y-1.5">
              <div v-for="fk in foreignKeys" :key="fk.id" class="rounded-md border px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]" :class="fk.markedForDrop ? 'bg-destructive/5 opacity-60' : ''">
                <div class="grid grid-cols-[minmax(110px,1fr)_minmax(110px,1fr)_minmax(110px,1fr)_minmax(90px,0.8fr)_minmax(90px,0.8fr)_auto] gap-1.5">
                  <Input v-model="fk.name" :class="structureControlClass" :placeholder="t('structureEditor.foreignKeyName')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-if="!isOracleForeignKeyEditor" v-model="fk.column" :class="structureControlClass" :placeholder="t('structureEditor.columnName')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-if="!isOracleForeignKeyEditor" v-model="fk.refTable" :class="structureControlClass" :placeholder="t('structureEditor.referencedTable')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-else :model-value="fk.refTable" :class="structureControlClass" :placeholder="t('structureEditor.referencedTable')" :disabled="!canEditForeignKeyDraft(fk)" @update:model-value="(value) => setOracleForeignKeyTarget(fk, value, false)" />
                  <Input v-if="!isOracleForeignKeyEditor" v-model="fk.refColumn" :class="structureControlClass" :placeholder="t('structureEditor.referencedColumn')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-if="!isOracleForeignKeyEditor" v-model="fk.refSchema" :class="structureControlClass" :placeholder="t('structureEditor.referencedSchema')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-else :model-value="fk.refSchema" :class="structureControlClass" :placeholder="t('structureEditor.referencedSchema')" :disabled="!canEditForeignKeyDraft(fk)" @update:model-value="(value) => setOracleForeignKeyTarget(fk, value, true)" />
                  <div class="flex items-center justify-end gap-1">
                    <Button v-if="isOracleForeignKeyEditor && fk.original && !fk.oracleOriginal" data-oracle-foreign-key-edit variant="ghost" size="sm" :disabled="foreignKeyDefinitionBusy || foreignKeysLoading || saving" @click="editOracleForeignKey(fk)">{{ t("common.edit") }}</Button>
                    <Button v-if="fk.original" variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="isOracleForeignKeyEditor && (!fk.oracleOriginal || foreignKeyDefinitionBusy || saving)" @click="toggleDropForeignKey(fk)">
                      <Trash2 :class="structureIconClass" />
                      {{ fk.markedForDrop ? t("structureEditor.restore") : t("structureEditor.drop") }}
                    </Button>
                    <Button v-else variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="removeNewForeignKey(fk)">
                      <X :class="structureIconClass" />
                      {{ t("structureEditor.remove") }}
                    </Button>
                  </div>
                </div>
                <div v-if="isOracleForeignKeyEditor" class="mt-1.5 space-y-1">
                  <div v-for="(column, position) in fk.columns" :key="position" data-oracle-foreign-key-pair class="flex items-center gap-1">
                    <Select :model-value="column || undefined" :disabled="!canEditForeignKeyDraft(fk)" @update:model-value="(value) => setOracleForeignKeyPair(fk, position, value, true)">
                      <SelectTrigger class="min-w-0 flex-1"><SelectValue :placeholder="t('structureEditor.columnName')" /></SelectTrigger>
                      <SelectContent
                        ><SelectItem v-for="source in columns.filter((item) => !item.markedForDrop)" :key="source.id" :value="source.name">{{ source.name }}</SelectItem></SelectContent
                      >
                    </Select>
                    <Input
                      :model-value="fk.refColumns?.[position] ?? ''"
                      :list="foreignKeyReferenceListId(fk)"
                      data-oracle-foreign-key-reference
                      :placeholder="t('structureEditor.referencedColumn')"
                      :disabled="!canEditForeignKeyDraft(fk)"
                      @update:model-value="(value) => setOracleForeignKeyPair(fk, position, value, false)"
                    />
                    <Button variant="ghost" size="icon-xs" data-oracle-foreign-key-up :title="t('oceanbasePrimaryKey.moveUp')" :disabled="!canEditForeignKeyDraft(fk) || position === 0" @click="moveOracleForeignKeyPair(fk, position, -1)"><ChevronUp class="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon-xs" data-oracle-foreign-key-down :title="t('oceanbasePrimaryKey.moveDown')" :disabled="!canEditForeignKeyDraft(fk) || position === (fk.columns?.length ?? 0) - 1" @click="moveOracleForeignKeyPair(fk, position, 1)"
                      ><ChevronDown class="h-4 w-4"
                    /></Button>
                    <Button variant="ghost" size="icon-xs" :title="t('common.delete')" :disabled="!canEditForeignKeyDraft(fk)" @click="removeOracleForeignKeyPair(fk, position)"><X class="h-4 w-4" /></Button>
                  </div>
                  <Button variant="outline" size="sm" :disabled="!canEditForeignKeyDraft(fk)" @click="addOracleForeignKeyPair(fk)">{{ t("structureEditor.addColumn") }}</Button>
                  <datalist :id="foreignKeyReferenceListId(fk)"><option v-for="choice in foreignKeyReferenceColumns[fk.id] ?? []" :key="choice.name" :value="choice.name" /></datalist>
                  <div v-if="fk.oracleState" class="flex flex-wrap gap-3" data-oracle-foreign-key-state>
                    <label class="flex items-center gap-1"
                      ><input type="checkbox" data-oracle-foreign-key-enabled :class="structureCheckboxClass" :checked="fk.oracleState.enabled" :disabled="!canEditForeignKeyDraft(fk)" @change="setOracleForeignKeyState(fk, 'enabled', ($event.target as HTMLInputElement).checked)" />{{
                        t("grid.tableInfoConstraintEnabled")
                      }}</label
                    >
                    <label class="flex items-center gap-1"
                      ><input type="checkbox" data-oracle-foreign-key-validated :class="structureCheckboxClass" :checked="fk.oracleState.validated" :disabled="!canEditForeignKeyDraft(fk)" @change="setOracleForeignKeyState(fk, 'validated', ($event.target as HTMLInputElement).checked)" />{{
                        t("grid.tableInfoConstraintValidated")
                      }}</label
                    >
                    <label class="flex items-center gap-1"
                      ><input
                        type="checkbox"
                        data-oracle-foreign-key-deferrable
                        :class="structureCheckboxClass"
                        :checked="fk.oracleState.deferrable"
                        :disabled="!canEditForeignKeyDraft(fk) || databaseType !== 'oracle'"
                        @change="setOracleForeignKeyState(fk, 'deferrable', ($event.target as HTMLInputElement).checked)"
                      />DEFERRABLE</label
                    >
                    <label class="flex items-center gap-1"
                      ><input
                        type="checkbox"
                        data-oracle-foreign-key-deferred
                        :class="structureCheckboxClass"
                        :checked="fk.oracleState.initiallyDeferred"
                        :disabled="!canEditForeignKeyDraft(fk) || databaseType !== 'oracle' || !fk.oracleState.deferrable"
                        @change="setOracleForeignKeyState(fk, 'initiallyDeferred', ($event.target as HTMLInputElement).checked)"
                      />INITIALLY DEFERRED</label
                    >
                    <label class="flex items-center gap-1"
                      ><input
                        type="checkbox"
                        data-oracle-foreign-key-rely
                        :class="structureCheckboxClass"
                        :checked="fk.oracleState.rely"
                        :disabled="!canEditForeignKeyDraft(fk) || fk.oracleState.validated"
                        @change="setOracleForeignKeyState(fk, 'rely', ($event.target as HTMLInputElement).checked)"
                      />RELY</label
                    >
                  </div>
                </div>
                <div class="mt-1.5 grid grid-cols-[minmax(110px,0.5fr)_minmax(110px,0.5fr)_1fr] gap-1.5">
                  <Select :model-value="fk.onDelete || '__default'" :disabled="!canEditForeignKeyDraft(fk)" @update:model-value="(v: any) => (fk.onDelete = String(v === '__default' ? '' : (v ?? '')))">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                      <SelectValue :placeholder="t('structureEditor.onDelete')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="action in isOracleForeignKeyEditor ? ['', 'CASCADE', 'SET NULL', 'NO ACTION'] : foreignKeyActionOptions" :key="`delete-${action || 'default'}`" :value="action || '__default'">{{ action || t("structureEditor.defaultAction") }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select v-if="!isOracleForeignKeyEditor" :model-value="fk.onUpdate || '__default'" :disabled="!canEditForeignKeyDraft(fk)" @update:model-value="(v: any) => (fk.onUpdate = String(v === '__default' ? '' : (v ?? '')))">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                      <SelectValue :placeholder="t('structureEditor.onUpdate')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="action in foreignKeyActionOptions" :key="`update-${action || 'default'}`" :value="action || '__default'">{{ action || t("structureEditor.defaultAction") }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <div class="truncate font-mono text-muted-foreground">{{ fk.column }} -> {{ fk.refSchema ? `${fk.refSchema}.` : "" }}{{ fk.refTable }}.{{ fk.refColumn }}</div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent
            ref="constraintsScrollerRef"
            v-if="tableMetadataCapabilities.constraints"
            value="constraints"
            class="col-start-1 row-start-2 structure-card-scroller m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]"
            @scroll.passive="onStructureContentScroll('constraints', $event)"
          >
            <div v-if="constraintsLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="secondaryMetadataErrors.constraints" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {{ secondaryMetadataErrors.constraints }}
            </div>
            <div v-else-if="constraintsForTab.length === 0" class="py-10 text-center text-muted-foreground">
              {{ t("structureEditor.emptyReadonly") }}
            </div>
            <div v-else class="space-y-1.5">
              <div
                v-for="constraint in constraintsForTab"
                :key="constraint.name"
                class="rounded-md border px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]"
                :class="constraint.enabled === false && existingPrimaryKeyDraft?.name !== constraint.name ? 'opacity-60' : ''"
              >
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="font-mono font-medium">{{ constraint.name }}</span>
                  <Badge variant="outline" class="shrink-0">{{ constraint.constraint_type }}</Badge>
                  <Badge variant="outline" class="shrink-0 text-muted-foreground">{{ t(constraint.enabled === true ? "grid.tableInfoConstraintEnabled" : constraint.enabled === false ? "structureEditor.constraintDisabled" : "grid.tableInfoConstraintEnabledUnknown") }}</Badge>
                  <Badge variant="outline" class="shrink-0 text-muted-foreground">{{ t(constraint.valid === true ? "grid.tableInfoConstraintValidated" : constraint.valid === false ? "structureEditor.constraintNotValidated" : "grid.tableInfoConstraintValidationUnknown") }}</Badge>
                  <template v-if="canEditExistingPrimaryKey && constraint.constraint_type === 'PRIMARY KEY'">
                    <Button variant="ghost" size="sm" :disabled="loading || saving || primaryKeyBusy" @click="editExistingPrimaryKey(constraint)">{{ t("common.edit") }}</Button>
                    <Button variant="ghost" size="sm" :disabled="loading || saving || primaryKeyBusy" @click="editExistingPrimaryKey(constraint, true)">{{ t("common.delete") }}</Button>
                  </template>
                  <template v-if="isOracleConstraintEditor && ['CHECK', 'UNIQUE'].includes(constraint.constraint_type)">
                    <Button variant="ghost" size="sm" :disabled="loading || saving || oracleConstraintBusy || !!oracleConstraintDraft" :aria-label="`Edit constraint ${constraint.name}`" :data-constraint-edit="constraint.name" @click="editOracleConstraint(constraint)">{{ t("common.edit") }}</Button>
                    <Button variant="ghost" size="sm" :disabled="loading || saving || oracleConstraintBusy || !!oracleConstraintDraft" :aria-label="`Delete constraint ${constraint.name}`" :data-constraint-delete="constraint.name" @click="deleteOracleConstraint(constraint)">{{
                      t("common.delete")
                    }}</Button>
                  </template>
                </div>
                <div v-if="oracleConstraintDraft?.original?.definition.name === constraint.name" class="mt-2 space-y-2" data-oracle-constraint-editor :data-constraint-editor="constraint.name">
                  <template v-if="oracleConstraintDraft.target?.kind === 'check'">
                    <Input v-model="oracleConstraintDraft.target.definition.name" :placeholder="t('structureEditor.constraintName')" :disabled="oracleConstraintBusy" />
                    <textarea v-model="oracleConstraintDraft.target.definition.expression" :placeholder="t('structureEditor.checkExpression')" :disabled="oracleConstraintBusy" class="min-h-20 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm" />
                    <div class="flex flex-wrap gap-3 text-sm">
                      <label class="flex items-center gap-1"><input v-model="oracleConstraintDraft.target.definition.state.enabled" type="checkbox" :disabled="oracleConstraintBusy" />{{ t("grid.tableInfoConstraintEnabled") }}</label
                      ><label class="flex items-center gap-1"><input v-model="oracleConstraintDraft.target.definition.state.validated" type="checkbox" :disabled="oracleConstraintBusy" />{{ t("grid.tableInfoConstraintValidated") }}</label>
                    </div>
                  </template>
                  <template v-else-if="oracleConstraintDraft.target?.kind === 'unique'">
                    <Input v-model="oracleConstraintDraft.target.definition.name" :placeholder="t('structureEditor.constraintName')" :disabled="oracleConstraintBusy" />
                    <div v-if="databaseType === 'oracle'" class="space-y-1 rounded border p-2" data-oracle-unique-index-policy>
                      <span>{{ t("oceanbasePrimaryKey.indexPolicy") }}</span>
                      <p v-if="oracleConstraintDraft.original?.kind === 'unique'" class="break-all font-mono text-xs">
                        {{ oracleConstraintDraft.original.definition.index.name ? `${oracleConstraintDraft.original.definition.index.owner}.${oracleConstraintDraft.original.definition.index.name}` : t("oceanbasePrimaryKey.noIndex") }}
                      </p>
                      <Select v-model="oracleConstraintDraft.indexPolicy" :disabled="oracleConstraintBusy">
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="keep">{{ t("oceanbasePrimaryKey.keepIndex") }}</SelectItem>
                          <SelectItem value="drop">{{ t("oceanbasePrimaryKey.dropIndex") }}</SelectItem>
                        </SelectContent>
                      </Select>
                      <p v-if="oracleConstraintDraft.indexPolicy === 'keep'" class="text-xs text-muted-foreground">{{ t("oceanbasePrimaryKey.preserveState") }}</p>
                    </div>
                    <div v-for="(name, position) in oracleConstraintDraft.target.definition.columns" :key="`${name}-${position}`" class="flex items-center gap-1">
                      <span class="min-w-0 flex-1 truncate font-mono">{{ position + 1 }}. {{ name }}</span>
                      <Button variant="ghost" size="icon-xs" :title="t('oceanbasePrimaryKey.moveUp')" :disabled="oracleConstraintBusy || position === 0" @click="moveOracleUniqueColumn(position, -1)"><ChevronUp class="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon-xs" :title="t('oceanbasePrimaryKey.moveDown')" :disabled="oracleConstraintBusy || position === oracleConstraintDraft.target.definition.columns.length - 1" @click="moveOracleUniqueColumn(position, 1)"><ChevronDown class="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon-xs" :title="t('common.delete')" :disabled="oracleConstraintBusy" @click="oracleConstraintDraft.target.definition.columns.splice(position, 1)"><X class="h-4 w-4" /></Button>
                    </div>
                    <Select :disabled="oracleConstraintBusy" @update:model-value="(value: any) => addOracleUniqueColumn(String(value || ''))">
                      <SelectTrigger><SelectValue :placeholder="t('structureEditor.addColumn')" /></SelectTrigger>
                      <SelectContent
                        ><SelectItem v-for="column in columns.filter((item) => !item.markedForDrop && oracleConstraintDraft?.target?.kind === 'unique' && !oracleConstraintDraft.target.definition.columns.includes(item.name))" :key="column.id" :value="column.name">{{
                          column.name
                        }}</SelectItem></SelectContent
                      >
                    </Select>
                    <div class="flex flex-wrap gap-3 text-sm">
                      <label class="flex items-center gap-1"><input v-model="oracleConstraintDraft.target.definition.state.enabled" type="checkbox" :disabled="oracleConstraintBusy" />{{ t("grid.tableInfoConstraintEnabled") }}</label
                      ><label class="flex items-center gap-1"><input v-model="oracleConstraintDraft.target.definition.state.validated" type="checkbox" :disabled="oracleConstraintBusy" />{{ t("grid.tableInfoConstraintValidated") }}</label>
                    </div>
                  </template>
                  <div class="flex gap-2">
                    <Button size="sm" variant="ghost" :disabled="oracleConstraintBusy" @click="cancelOracleConstraintEdit">{{ t("common.cancel") }}</Button>
                    <span v-if="oracleConstraintPlan" class="text-xs text-muted-foreground">{{ t("structureEditor.previewReady") }}</span>
                  </div>
                  <p v-for="notice in oracleConstraintPlan?.notices" :key="notice" class="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs">{{ t(notice) }}</p>
                </div>
                <div v-if="existingPrimaryKeyDraft?.name === constraint.name" class="mt-2 space-y-2" data-existing-primary-key-editor>
                  <div v-for="(name, position) in existingPrimaryKeyDraft.columns" :key="name" class="flex items-center gap-1">
                    <span class="min-w-0 flex-1 truncate font-mono">{{ position + 1 }}. {{ name }}</span>
                    <Button variant="ghost" size="icon-xs" :title="t('oceanbasePrimaryKey.moveUp')" :disabled="primaryKeyBusy || position === 0" @click="moveExistingPrimaryKeyColumn(position, -1)"><ChevronUp class="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon-xs" :title="t('oceanbasePrimaryKey.moveDown')" :disabled="primaryKeyBusy || position === existingPrimaryKeyDraft.columns.length - 1" @click="moveExistingPrimaryKeyColumn(position, 1)"><ChevronDown class="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon-xs" :title="t('common.delete')" :disabled="primaryKeyBusy" @click="existingPrimaryKeyDraft.columns.splice(position, 1)"><X class="h-4 w-4" /></Button>
                  </div>
                  <p v-if="!existingPrimaryKeyDraft.columns.length" class="text-destructive">{{ t("oceanbasePrimaryKey.removeKey") }}</p>
                  <div class="flex items-center gap-2">
                    <Select v-model="primaryKeyNewColumn" :disabled="primaryKeyBusy || !primaryKeyAvailableColumns.length">
                      <SelectTrigger class="h-7 min-w-0 flex-1"><SelectValue :placeholder="t('structureEditor.addColumn')" /></SelectTrigger>
                      <SelectContent
                        ><SelectItem v-for="column in primaryKeyAvailableColumns" :key="column.id" :value="column.name">{{ column.name }}</SelectItem></SelectContent
                      >
                    </Select>
                    <Button variant="outline" size="sm" :disabled="primaryKeyBusy || !primaryKeyNewColumn" @click="addExistingPrimaryKeyColumn">{{ t("structureEditor.addColumn") }}</Button>
                    <Button variant="ghost" size="sm" :disabled="primaryKeyBusy" @click="existingPrimaryKeyDraft = undefined">{{ t("common.cancel") }}</Button>
                  </div>
                  <div v-if="existingPrimaryKeyDraft.oracleIndex" class="space-y-1">
                    <span>{{ t("oceanbasePrimaryKey.indexPolicy") }}</span>
                    <p v-if="currentPrimaryKeyIndex?.policy === 'none'" data-primary-key-index-identity class="text-xs">{{ t("oceanbasePrimaryKey.noIndex") }}</p>
                    <p v-else-if="currentPrimaryKeyIndex" data-primary-key-index-identity class="break-all font-mono text-xs">{{ currentPrimaryKeyIndex.owner }}.{{ currentPrimaryKeyIndex.name }}</p>
                    <Select v-if="currentPrimaryKeyIndex?.policy !== 'none'" v-model="existingPrimaryKeyDraft.oracleIndex.policy" :disabled="primaryKeyBusy">
                      <SelectTrigger :aria-label="t('oceanbasePrimaryKey.indexPolicy')"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="keep">{{ t("oceanbasePrimaryKey.keepIndex") }}</SelectItem>
                        <SelectItem value="drop">{{ t("oceanbasePrimaryKey.dropIndex") }}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p class="text-xs text-muted-foreground">{{ t("oceanbasePrimaryKey.preserveState") }}</p>
                  </div>
                  <p v-if="existingPrimaryKeyChanged" class="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
                    {{ t(currentPrimaryKeyIndex?.policy === "none" ? "oceanbasePrimaryKey.noIndexImpact" : existingPrimaryKeyDraft.oracleIndex ? "oceanbasePrimaryKey.oracleImpact" : "oceanbasePrimaryKey.impact") }}
                  </p>
                </div>
                <div v-if="constraint.columns.length" class="mt-1 truncate font-mono text-muted-foreground">{{ constraint.columns.join(", ") }}</div>
                <div v-if="constraint.ref_table" class="mt-1 truncate font-mono text-muted-foreground">-> {{ constraint.ref_schema ? `${constraint.ref_schema}.` : "" }}{{ constraint.ref_table }}{{ constraint.ref_columns.length ? `(${constraint.ref_columns.join(", ")})` : "" }}</div>
                <div v-if="constraint.definition" class="mt-1 whitespace-pre-wrap break-words font-mono text-muted-foreground">{{ constraint.definition }}</div>
              </div>
            </div>
            <div v-if="oracleConstraintDraft && !oracleConstraintDraft.original" class="mt-2 rounded-md border p-3" data-oracle-constraint-editor data-constraint-editor="new">
              <template v-if="oracleConstraintDraft.target?.kind === 'check'">
                <Input v-model="oracleConstraintDraft.target.definition.name" :placeholder="t('structureEditor.constraintName')" :disabled="oracleConstraintBusy" />
                <textarea v-model="oracleConstraintDraft.target.definition.expression" :placeholder="t('structureEditor.checkExpression')" :disabled="oracleConstraintBusy" class="mt-2 min-h-20 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm" />
                <div class="flex flex-wrap gap-3 text-sm">
                  <label class="flex items-center gap-1"><input v-model="oracleConstraintDraft.target.definition.state.enabled" type="checkbox" :disabled="oracleConstraintBusy" />{{ t("grid.tableInfoConstraintEnabled") }}</label
                  ><label class="flex items-center gap-1"><input v-model="oracleConstraintDraft.target.definition.state.validated" type="checkbox" :disabled="oracleConstraintBusy" />{{ t("grid.tableInfoConstraintValidated") }}</label>
                </div>
              </template>
              <template v-else-if="oracleConstraintDraft.target?.kind === 'unique'">
                <Input v-model="oracleConstraintDraft.target.definition.name" :placeholder="t('structureEditor.constraintName')" :disabled="oracleConstraintBusy" />
                <div v-if="databaseType === 'oracle'" class="space-y-1 rounded border p-2" data-oracle-unique-index-policy>
                  <span>{{ t("oceanbasePrimaryKey.indexPolicy") }}</span>
                  <Select v-model="oracleConstraintDraft.indexPolicy" :disabled="oracleConstraintBusy">
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="keep">{{ t("oceanbasePrimaryKey.keepIndex") }}</SelectItem>
                      <SelectItem value="drop">{{ t("oceanbasePrimaryKey.dropIndex") }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div v-for="(name, position) in oracleConstraintDraft.target.definition.columns" :key="`${name}-${position}`" class="flex items-center gap-1">
                  <span class="min-w-0 flex-1 truncate font-mono">{{ position + 1 }}. {{ name }}</span>
                  <Button variant="ghost" size="icon-xs" :disabled="oracleConstraintBusy" @click="oracleConstraintDraft.target.kind === 'unique' && oracleConstraintDraft.target.definition.columns.splice(position, 1)"><X class="h-4 w-4" /></Button>
                </div>
                <Select :disabled="oracleConstraintBusy" @update:model-value="(value: any) => addOracleUniqueColumn(String(value || ''))"
                  ><SelectTrigger><SelectValue :placeholder="t('structureEditor.addColumn')" /></SelectTrigger
                  ><SelectContent
                    ><SelectItem v-for="column in columns.filter((item) => !item.markedForDrop && oracleConstraintDraft?.target?.kind === 'unique' && !oracleConstraintDraft.target.definition.columns.includes(item.name))" :key="column.id" :value="column.name">{{
                      column.name
                    }}</SelectItem></SelectContent
                  ></Select
                >
                <div class="flex flex-wrap gap-3 text-sm">
                  <label class="flex items-center gap-1"><input v-model="oracleConstraintDraft.target.definition.state.enabled" type="checkbox" :disabled="oracleConstraintBusy" />{{ t("grid.tableInfoConstraintEnabled") }}</label
                  ><label class="flex items-center gap-1"><input v-model="oracleConstraintDraft.target.definition.state.validated" type="checkbox" :disabled="oracleConstraintBusy" />{{ t("grid.tableInfoConstraintValidated") }}</label>
                </div>
              </template>
              <Button variant="ghost" size="sm" :disabled="oracleConstraintBusy" @click="cancelOracleConstraintEdit">{{ t("common.cancel") }}</Button>
              <p v-for="notice in oracleConstraintPlan?.notices" :key="notice" class="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs">{{ t(notice) }}</p>
            </div>
          </TabsContent>

          <TabsContent ref="triggersScrollerRef" v-if="tableMetadataCapabilities.triggers" value="triggers" class="col-start-1 row-start-2 structure-card-scroller m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('triggers', $event)">
            <div v-if="triggersLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="secondaryMetadataErrors.triggers" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {{ secondaryMetadataErrors.triggers }}
            </div>
            <div v-else-if="triggers.length === 0" class="py-10 text-center text-muted-foreground">
              {{ t("structureEditor.emptyReadonly") }}
            </div>
            <div v-else class="flex h-full min-h-0 flex-col gap-1.5">
              <!-- Trigger list (master): compact rows with inline timing/event editors -->
              <div class="min-h-24 shrink-0 overflow-auto rounded-md border" :class="selectedTrigger ? 'max-h-[45%]' : 'max-h-full'">
                <div
                  v-for="trigger in triggers"
                  :key="trigger.id"
                  class="flex w-full cursor-pointer items-center gap-1.5 border-b px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-left text-[length:var(--structure-font-size)] last:border-b-0 hover:bg-accent/40"
                  :class="[trigger.id === selectedTriggerId ? 'bg-accent text-accent-foreground' : '', trigger.markedForDrop ? 'bg-destructive/5 opacity-60' : '']"
                  @click="selectTrigger(trigger)"
                >
                  <span v-if="exactOracleTriggerMetadata(trigger.original)" class="max-w-[35%] truncate whitespace-pre font-mono text-muted-foreground" :title="trigger.original?.oracle_metadata?.owner">{{ trigger.original?.oracle_metadata?.owner }}.</span>
                  <template v-if="renamingTriggerId === trigger.id">
                    <Input
                      v-model="trigger.name"
                      class="h-[var(--structure-control-height)] min-w-0 flex-1 rounded-[6px] px-[var(--structure-control-px)] font-mono"
                      :placeholder="t('structureEditor.triggerName')"
                      :disabled="!canEditTriggerDraft(trigger)"
                      @click.stop
                      @keydown.enter.prevent="renamingTriggerId = null"
                      @keydown.escape.prevent="renamingTriggerId = null"
                      @blur="renamingTriggerId = null"
                    />
                  </template>
                  <span v-else class="min-w-0 flex-1 truncate font-mono" :class="trigger.name ? '' : 'italic text-muted-foreground'" :title="trigger.name || t('structureEditor.triggerName')">{{ trigger.name || t("structureEditor.triggerName") }}</span>
                  <Button v-if="renamingTriggerId === trigger.id" variant="ghost" size="sm" :class="structureToolbarButtonClass" :title="t('structureEditor.triggerName')" @click.stop="renamingTriggerId = null">
                    <Check :class="structureIconClass" />
                  </Button>
                  <Button v-else variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="!canEditTriggerDraft(trigger)" :title="t('structureEditor.triggerName')" @click.stop="startRenameTrigger(trigger)">
                    <Pencil :class="structureIconClass" />
                  </Button>
                  <Input v-if="isOracleTriggerEditor" v-model="trigger.timing" class="h-[var(--structure-control-height)] w-28 shrink-0 rounded-[6px] px-[var(--structure-control-px)]" :disabled="!canEditTriggerDraft(trigger)" @click.stop />
                  <Select v-else v-model="trigger.timing" :disabled="!canEditTriggerDraft(trigger)">
                    <SelectTrigger class="w-28 shrink-0" @click.stop>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="timing in triggerTimingOptions" :key="timing" :value="timing">{{ timing }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input v-if="isOracleTriggerEditor || isSqlServerTriggerEditor" v-model="trigger.event" class="h-[var(--structure-control-height)] w-28 shrink-0 rounded-[6px] px-[var(--structure-control-px)]" :disabled="!canEditTriggerDraft(trigger)" @click.stop />
                  <Select v-else v-model="trigger.event" :disabled="!canEditTriggerDraft(trigger)">
                    <SelectTrigger class="w-24 shrink-0" @click.stop>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="event in triggerEventOptions" :key="event" :value="event">{{ event }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    v-if="supportsTriggerEnableToggle && trigger.enabled !== undefined"
                    variant="outline"
                    size="sm"
                    :class="['h-[var(--structure-control-height)] shrink-0 px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]', !trigger.enabled ? 'text-muted-foreground' : '']"
                    :disabled="!canToggleTriggerEnabled(trigger)"
                    @click.stop="trigger.enabled = !trigger.enabled"
                  >
                    {{ trigger.enabled ? t("damengJobAdmin.enabled") : t("damengJobAdmin.disabled") }}
                  </Button>
                  <Badge v-else-if="trigger.enabled !== undefined && trigger.enabled !== null" variant="outline" class="shrink-0 text-[length:var(--structure-font-size)]">
                    {{ trigger.enabled ? t("damengJobAdmin.enabled") : t("damengJobAdmin.disabled") }}
                  </Badge>
                  <Button v-if="trigger.original" variant="ghost" size="sm" :class="structureToolbarButtonClass" @click.stop="toggleDropTrigger(trigger)">
                    <Trash2 :class="structureIconClass" />
                    {{ trigger.markedForDrop ? t("structureEditor.restore") : t("structureEditor.drop") }}
                  </Button>
                  <Button v-else variant="ghost" size="sm" :class="structureToolbarButtonClass" @click.stop="removeNewTrigger(trigger)">
                    <X :class="structureIconClass" />
                    {{ t("structureEditor.remove") }}
                  </Button>
                </div>
              </div>
              <!-- Statement editor (detail): title + SQL sized to its content -->
              <div v-if="selectedTrigger" class="flex min-h-0 flex-1 flex-col rounded-md border px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]" :class="selectedTrigger.markedForDrop ? 'bg-destructive/5 opacity-60' : ''">
                <div class="flex min-w-0 items-center gap-1.5 font-mono font-medium" :title="selectedTrigger.name">
                  <span v-if="exactOracleTriggerMetadata(selectedTrigger.original)" class="max-w-[35%] truncate whitespace-pre text-muted-foreground" :title="selectedTrigger.original?.oracle_metadata?.owner">{{ selectedTrigger.original?.oracle_metadata?.owner }}.</span>
                  <span class="truncate">{{ selectedTrigger.name || t("structureEditor.triggerName") }}</span>
                  <span v-if="exactOracleTriggerMetadata(selectedTrigger.original)" class="text-sm font-normal">{{
                    selectedTrigger.original?.oracle_metadata?.reads.validity?.state === "available" && typeof selectedTrigger.original?.valid === "boolean" ? (selectedTrigger.original.valid ? "VALID" : "INVALID") : t("oracleTrigger.unknown")
                  }}</span>
                  <Button v-if="exactOracleTriggerMetadata(selectedTrigger.original)" variant="outline" size="sm" class="ml-auto shrink-0 font-sans" :disabled="saving || triggersLoading" @click="openTriggerFullSource(selectedTrigger)">{{ t("oracleTrigger.editFullSource") }}</Button>
                  <Button v-if="triggerSourceRefreshRequired.has(selectedTrigger.id)" variant="outline" size="sm" class="shrink-0 font-sans" :disabled="saving || triggersLoading" @click="reloadTriggerDraftAfterSource(selectedTrigger)">{{ t("oracleTrigger.refreshDraft") }}</Button>
                </div>
                <textarea
                  v-model="selectedTrigger.statement"
                  class="mt-1.5 min-h-0 w-full flex-1 resize-none overflow-auto rounded-[6px] border bg-background px-[var(--structure-control-px)] py-[var(--structure-cell-py)] font-mono text-[length:var(--structure-font-size)] leading-5 outline-none focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50"
                  :placeholder="t('structureEditor.triggerStatement')"
                  :disabled="!canEditTriggerDraft(selectedTrigger)"
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent ref="partitionsScrollerRef" v-if="showPartitionsTab" value="partitions" class="col-start-1 row-start-2 structure-card-scroller m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('partitions', $event)">
            <div v-if="isCreateMode" class="space-y-3">
              <label class="flex items-center gap-2 text-[length:var(--structure-font-size)]">
                <input v-model="createPartitioningEnabled" type="checkbox" />
                {{ t("structureEditor.partitionEnable") }}
              </label>
              <template v-if="createPartitioningEnabled">
                <div class="space-y-1">
                  <label class="text-sm">{{ t("structureEditor.partitionKind") }}</label>
                  <Select v-model="createPartitioningKind">
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="range">{{ t("structureEditor.partitionKindRange") }}</SelectItem>
                      <SelectItem value="list">{{ t("structureEditor.partitionKindList") }}</SelectItem>
                      <SelectItem value="hash">{{ t("structureEditor.partitionKindHash") }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="space-y-1">
                  <label class="text-sm">{{ t("structureEditor.partitionKeyColumns") }}</label>
                  <div class="flex flex-wrap gap-3">
                    <label v-for="column in partitionCreatableColumns" :key="column" class="flex items-center gap-1 text-sm">
                      <input v-model="createPartitioningColumns" type="checkbox" :value="column" :disabled="!!createPartitioningExpression.trim()" />
                      <span class="font-mono">{{ column }}</span>
                    </label>
                  </div>
                  <p v-if="partitionCreatableColumns.length === 0" class="text-sm text-muted-foreground">{{ t("structureEditor.partitionKeyNoColumns") }}</p>
                </div>
                <div class="space-y-1">
                  <label class="text-sm">{{ t("structureEditor.partitionKeyExpression") }}</label>
                  <Input v-model="createPartitioningExpression" class="font-mono" placeholder="date_trunc('month', ts)" />
                </div>
                <div class="flex items-center justify-between">
                  <span class="text-[length:var(--structure-font-size)] font-medium">{{ t("structureEditor.partitionInitialPartitions") }}</span>
                  <Button variant="outline" size="sm" :class="structureToolbarButtonClass" @click="openPartitionDialog('create', createPartitioningKind)">
                    <Plus :class="[structureIconClass, 'mr-1']" />
                    {{ t("structureEditor.partitionAdd") }}
                  </Button>
                </div>
                <div v-if="partitionOperations.length" class="rounded-md border border-primary/40 bg-primary/5 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]">
                  <div v-for="operation in partitionOperations" :key="operation.id" class="flex items-center justify-between gap-2 py-0.5">
                    <span class="truncate font-mono">{{ partitionOperationSummary(operation) }}</span>
                    <Button variant="ghost" size="sm" :class="structureIconButtonClass" :title="t('structureEditor.partitionRemoveOperation')" @click="removePartitionOperation(operation.id)">
                      <Trash2 :class="structureIconClass" />
                    </Button>
                  </div>
                </div>
                <p v-else class="text-sm text-muted-foreground">{{ t("structureEditor.partitionInitialPartitionsEmpty") }}</p>
              </template>
            </div>
            <template v-else>
              <div v-if="partitionsLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
                <Loader2 class="h-4 w-4 animate-spin" />
                {{ t("common.loading") }}
              </div>
              <div v-else-if="partitionsError" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {{ partitionsError }}
              </div>
              <div v-else-if="!partitioning || (!partitioning.isPartitioned && !partitioning.isPartition)" class="py-10 text-center text-muted-foreground">
                {{ t("structureEditor.partitionsEmpty") }}
              </div>
              <div v-else class="space-y-2">
                <div class="rounded-md border px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex flex-wrap items-center gap-1.5">
                      <Badge v-if="partitioning.isPartitioned" variant="outline">{{ partitionStrategyLabel(partitioning.strategy) }}</Badge>
                      <Badge v-else variant="outline">{{ t("structureEditor.partitionMemberBadge") }}</Badge>
                      <span v-if="partitioning.keyDefinition" class="truncate font-mono">{{ partitioning.keyDefinition }}</span>
                    </div>
                    <div v-if="canManagePartitions" class="flex shrink-0 items-center gap-1.5">
                      <Button v-if="partitioning.isPartitioned" variant="outline" size="sm" :class="structureToolbarButtonClass" @click="openPartitionDialog('create')">
                        <Plus :class="[structureIconClass, 'mr-1']" />
                        {{ t("structureEditor.partitionAdd") }}
                      </Button>
                      <Button v-if="partitioning.isPartitioned" variant="outline" size="sm" :class="structureToolbarButtonClass" @click="openPartitionDialog('attach')">
                        <ListChevronsUpDown :class="[structureIconClass, 'mr-1']" />
                        {{ t("structureEditor.partitionAttach") }}
                      </Button>
                      <Button v-if="partitioning.isPartition" variant="outline" size="sm" :class="structureToolbarButtonClass" @click="openDetachSelfPartitionDialog">
                        <X :class="[structureIconClass, 'mr-1']" />
                        {{ t("structureEditor.partitionDetachSelf") }}
                      </Button>
                    </div>
                  </div>
                  <div v-if="partitioning.parent" class="mt-1 truncate font-mono text-muted-foreground">{{ t("structureEditor.partitionsParent") }}: {{ partitioning.parent }}</div>
                  <div v-if="partitioning.ownBound" class="mt-1 truncate font-mono text-muted-foreground">{{ t("structureEditor.partitionsOwnBound") }}: {{ pgPartitionBoundText(partitioning.ownBound) }}</div>
                  <div v-if="partitioning.defaultPartition" class="mt-1 truncate font-mono text-muted-foreground">{{ t("structureEditor.partitionsDefault") }}: {{ partitioning.defaultPartition }}</div>
                </div>
                <div v-if="partitionOperations.length" class="rounded-md border border-primary/40 bg-primary/5 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]">
                  <div class="mb-1 font-medium">{{ t("structureEditor.partitionPendingOperations") }}</div>
                  <div v-for="operation in partitionOperations" :key="operation.id" class="flex items-center justify-between gap-2 py-0.5">
                    <span class="truncate font-mono">{{ partitionOperationSummary(operation) }}</span>
                    <Button variant="ghost" size="sm" :class="structureIconButtonClass" :title="t('structureEditor.partitionRemoveOperation')" @click="removePartitionOperation(operation.id)">
                      <Trash2 :class="structureIconClass" />
                    </Button>
                  </div>
                </div>
                <div v-if="partitionTreeRows.length === 0" class="py-10 text-center text-muted-foreground">
                  {{ t("structureEditor.partitionsEmptyChildren") }}
                </div>
                <div v-if="partitionTreeRows.length > 0" class="divide-y overflow-hidden rounded-md border">
                  <div v-for="row in partitionVisibleRows" :key="row.key" :title="partitionRowHint(row.node)" class="flex items-start gap-1 px-[var(--structure-cell-px)] py-1.5 text-[length:var(--structure-font-size)]">
                    <span :data-partition-depth="row.depth" :style="{ width: `${row.depth * PARTITION_TREE_INDENT_PX}px` }" class="shrink-0 self-stretch" aria-hidden="true"></span>
                    <button
                      v-if="row.node.children.length"
                      type="button"
                      class="mt-px h-4 w-4 shrink-0 self-start text-muted-foreground transition-colors hover:text-foreground"
                      :aria-label="collapsedPartitionKeys.has(row.key) ? t('structureEditor.partitionExpand') : t('structureEditor.partitionCollapse')"
                      :title="collapsedPartitionKeys.has(row.key) ? t('structureEditor.partitionExpand') : t('structureEditor.partitionCollapse')"
                      @click="togglePartitionRow(row.key)"
                    >
                      <ChevronRight v-if="collapsedPartitionKeys.has(row.key)" :class="structureIconClass" />
                      <ChevronDown v-else :class="structureIconClass" />
                    </button>
                    <span v-else class="mt-px h-4 w-4 shrink-0 self-start" aria-hidden="true"></span>
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center justify-between gap-1.5">
                        <div class="flex flex-wrap items-center gap-1.5">
                          <span class="font-mono font-medium">{{ row.node.name }}</span>
                          <Badge v-if="row.node.children.length" variant="outline" class="text-muted-foreground">{{ t("structureEditor.partitionChildCount", { count: row.node.children.length }) }}</Badge>
                          <Badge v-if="row.depth > 0" variant="outline" class="border-dashed text-muted-foreground">{{ t("structureEditor.partitionSubPartitionBadge") }}</Badge>
                          <Badge v-if="row.node.strategy" variant="outline">{{ partitionStrategyLabel(row.node.strategy) }}</Badge>
                          <Badge v-if="row.node.bound?.kind === 'default'" variant="outline" class="text-muted-foreground">{{ t("structureEditor.partitionBoundDefault") }}</Badge>
                        </div>
                        <div v-if="canManagePartitions && partitioning.isPartitioned" class="flex shrink-0 items-center gap-0.5">
                          <Button variant="ghost" size="sm" :class="structureIconButtonClass" :title="t('structureEditor.partitionDetach')" @click="openPartitionRowOperation('detach', row)">
                            <X :class="structureIconClass" />
                          </Button>
                          <Button variant="ghost" size="sm" :class="structureIconButtonClass" :title="t('structureEditor.partitionDrop')" @click="openPartitionRowOperation('drop', row)">
                            <Trash2 :class="structureIconClass" />
                          </Button>
                        </div>
                      </div>
                      <div v-if="pgPartitionNodeBoundText(row.node)" class="mt-0.5 truncate font-mono text-muted-foreground">{{ pgPartitionNodeBoundText(row.node) }}</div>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </TabsContent>

          <TabsContent
            ref="ddlScrollerRef"
            v-if="tableMetadataCapabilities.ddl"
            value="ddl"
            force-mount
            class="col-start-1 row-start-2 structure-card-scroller relative m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)] data-[state=inactive]:hidden"
            @scroll.passive="onStructureContentScroll('ddl', $event)"
          >
            <div v-if="ddlLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <template v-else>
              <div v-if="(ddlContent || ddlLoadError) && !ddlSearchOpen" class="absolute right-3 top-3 z-10 flex items-center gap-1.5">
                <DdlStorageToggle :database-type="databaseType" :disabled="ddlDirty" :preferences="{ includeDdlStorage: ddlStorageIncluded, compactDdlSql: ddlCompacted, separateDdlIndexes: ddlIndexesSeparated }" />
                <Button v-if="ddlDirty" variant="outline" size="sm" class="h-7 gap-1 px-2" :title="t('structureEditor.resetDdl')" @click="resetDdlDraft">
                  <RotateCcw class="h-3.5 w-3.5" />
                  {{ t("structureEditor.resetDdl") }}
                </Button>
                <Button variant="outline" size="sm" class="h-7 gap-1 px-2" :disabled="!!ddlLoadError" :title="t('grid.copyDdl')" @click="copyDdlContent">
                  <Copy class="h-3.5 w-3.5" />
                  {{ t("grid.copyDdl") }}
                </Button>
              </div>
              <p v-if="ddlLoadError" role="alert" class="pt-10 text-sm text-destructive">{{ ddlLoadError }}</p>
              <div v-else ref="ddlEditorContainer" class="structure-ddl-editor h-full min-h-full min-w-0 w-full"></div>
              <EditorSearchPanel v-if="ddlEditorView && !ddlLoadError" ref="ddlSearchPanelRef" :view="ddlEditorView" @open="ddlSearchOpen = true" @close="ddlSearchOpen = false" />
            </template>
          </TabsContent>
        </Tabs>
      </div>

      <p v-if="!isCreateMode && databaseType === 'starrocks'" class="shrink-0 px-3 py-2 text-xs text-muted-foreground">
        {{ t("starrocksLayout.alterHint") }} {{ t(structureCapabilities.reorderColumn ? "starrocksLayout.reorderHint" : starrocksAlterContext?.model === "primary" ? "starrocksLayout.localReorderHint" : "starrocksLayout.reorderMetadataHint") }}
      </p>
      <StarRocksSortKeyEditor v-if="!isCreateMode && databaseType === 'starrocks' && activeTab === 'columns' && starrocksSortColumns" v-model="starrocksSortColumns" :context="starrocksAlterContext" :columns="columns" :disabled="saving || loading" />
      <StarRocksPhysicalOptionsEditor v-if="isCreateMode && databaseType === 'starrocks'" v-model="starrocksPhysicalOptions" :columns="columns" :server-version="connection?.database_info?.productVersion" :disabled="saving" />

      <div :class="['flex min-w-0 shrink-0 flex-col overflow-hidden rounded-md border', sqlPreviewCollapsed ? '' : 'h-[28%] min-h-40 max-h-64']">
        <div class="flex shrink-0 items-center justify-between border-b px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)] font-medium">
          <div class="flex items-center gap-1.5">
            <span>{{ t("structureEditor.sqlPreview") }}</span>
            <Badge v-if="!saving && pendingStatements.length && warnings.length === 0" variant="outline" :class="['h-4 px-1 text-[10px]', sqlPreviewPending || sqlPreviewLoading ? 'invisible' : '']" :aria-hidden="sqlPreviewPending || sqlPreviewLoading">
              <Check class="h-3 w-3" />
              {{ t("structureEditor.ready") }}
            </Badge>
          </div>
          <div class="flex items-center gap-1.5">
            <Button
              variant="ghost"
              :class="structureIconButtonClass"
              :aria-label="sqlPreviewCollapsed ? t('structureEditor.expandSqlPreview') : t('structureEditor.collapseSqlPreview')"
              :title="sqlPreviewCollapsed ? t('structureEditor.expandSqlPreview') : t('structureEditor.collapseSqlPreview')"
              @click="toggleSqlPreviewCollapsed"
            >
              <ChevronUp v-if="sqlPreviewCollapsed" :class="structureIconClass" />
              <ChevronDown v-else :class="structureIconClass" />
            </Button>
            <Button variant="ghost" :class="structureToolbarButtonClass" :disabled="sqlPreviewPending || sqlPreviewLoading || !previewSqlText.trim()" @click="copyPreviewSql">
              <Copy :class="[structureIconClass, 'mr-1']" />
              {{ t("structureEditor.copySql") }}
            </Button>
            <Badge variant="secondary" class="min-w-6 justify-center tabular-nums">
              <Loader2 v-if="(sqlPreviewPending || sqlPreviewLoading) && !pendingStatements.length" class="h-3 w-3 animate-spin" />
              <span v-else>{{ pendingStatements.length }}</span>
            </Badge>
          </div>
        </div>
        <div v-if="!sqlPreviewCollapsed" class="min-h-0 flex-1 overflow-auto p-2.5" :aria-busy="sqlPreviewPending || sqlPreviewLoading">
          <div v-if="ddlDirty" class="mb-2 flex gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-[var(--structure-cell-px)] py-[var(--structure-cell-py)] text-[length:var(--structure-font-size)] text-primary">
            <Info :class="[structureIconClass, 'mt-0.5 shrink-0']" />
            <span>{{ t("structureEditor.ddlEditNotice") }}</span>
          </div>
          <div v-if="hasSqliteTypeChange" class="mb-2 flex gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-[var(--structure-cell-px)] py-[var(--structure-cell-py)] text-[length:var(--structure-font-size)] text-primary">
            <Info :class="[structureIconClass, 'mt-0.5 shrink-0']" />
            <span>{{ t("structureEditor.sqliteRebuildNotice") }}</span>
          </div>
          <div v-if="warnings.length" class="mb-2 space-y-1">
            <div v-for="warning in warnings" :key="warning" class="flex gap-1.5 rounded-md border border-yellow-300/40 bg-yellow-500/10 px-[var(--structure-cell-px)] py-[var(--structure-cell-py)] text-[length:var(--structure-font-size)] text-yellow-700 dark:text-yellow-300">
              <AlertTriangle :class="[structureIconClass, 'mt-0.5 shrink-0']" />
              <span>{{ structureWarningText(warning) }}</span>
            </div>
          </div>
          <pre v-if="pendingStatements.length" class="select-text whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2.5 font-mono text-[calc(var(--structure-font-size)+1px)] leading-5" v-html="highlightedSql" />
          <div v-else-if="sqlPreviewPending || sqlPreviewLoading" class="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
          </div>
          <div v-else class="flex h-full items-center justify-center text-[length:var(--structure-font-size)] text-muted-foreground">
            {{ t("structureEditor.noChanges") }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="oracleIndexRefreshError" data-oracle-index-refresh-warning role="status" class="flex shrink-0 items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]">
      <div class="min-w-0 flex-1">
        <p>{{ t("oracleStructureResult.appliedRefreshPending") }}</p>
        <p class="break-words text-muted-foreground">{{ oracleIndexRefreshError }}</p>
      </div>
      <Button data-retry-oracle-index-refresh variant="outline" size="sm" :disabled="saving || postSaveRefreshing" @click="retryOracleIndexRefresh">{{ t("common.retry") }}</Button>
    </div>
    <div v-if="errorMessage || draftHydrationError" class="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)] text-destructive">
      {{ errorMessage || draftHydrationError }}
    </div>

    <div v-if="triggerStructureRecovery" class="flex shrink-0 items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm" role="status">
      <span class="min-w-0 flex-1">{{ t("oracleTrigger.reloadBaseline") }}</span>
      <Button variant="outline" size="sm" :disabled="saving || loading" @click="reconcileTriggerStructure">{{ t("oracleTrigger.reconcileStructure") }}</Button>
    </div>

    <div class="flex shrink-0 items-center justify-end gap-2">
      <Button :class="structureToolbarButtonClass" :disabled="!canApply" @click="applyChanges">
        <Loader2 v-if="saving" :class="[structureIconClass, 'mr-1.5 animate-spin']" />
        <Save v-else :class="[structureIconClass, 'mr-1.5']" />
        {{ t("structureEditor.apply") }}
      </Button>
    </div>

    <DataGridCopyColumnNamesDialog v-model:open="copyColumnNamesDialogOpen" :column-names="copyableStructureColumnNames" :database-type="databaseType" :column-comments="copyableStructureColumnComments" @copy="copyColumnNamesText" />
    <TableColumnPasteDialog v-model:open="pasteColumnsDialogOpen" :disabled="!canPasteColumns" :existing-names="columns.map((column) => column.name)" @import="applyPastedColumns" />
    <Dialog v-model:open="copyColumnsDialogOpen">
      <DialogContent class="max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ t("structureEditor.copyColumnsTitle") }}</DialogTitle>
        </DialogHeader>

        <div class="max-h-[65vh] space-y-3 overflow-y-auto">
          <p class="text-xs text-muted-foreground">{{ t("structureEditor.copyColumnsSameTypeOnly") }}</p>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-1.5 text-sm font-medium">
              <label id="copy-source-connection-label">{{ t("structureEditor.copyColumnsSourceConnection") }}</label>
              <SearchableSelect
                :model-value="copySourceConnectionId"
                :options="copySourceConnections.map((config) => config.id)"
                :placeholder="t('structureEditor.copyColumnsSourceConnection')"
                :search-placeholder="t('structureEditor.copyColumnsSourceConnection')"
                :empty-text="t('common.noResults')"
                aria-labelledby="copy-source-connection-label"
                trigger-class="h-8 w-full justify-between text-xs"
                :display-name="(id: string) => store.getConfig(id)?.name || id"
                @update:model-value="(value: string) => changeCopySourceScope('connection', value)"
              />
            </div>
            <div v-if="copySourceCatalogs.length > 0" class="grid gap-1.5 text-sm font-medium">
              <label id="copy-source-catalog-label">{{ t("structureEditor.copyColumnsSourceCatalog") }}</label>
              <SearchableSelect
                :model-value="copySourceCatalog"
                :options="copySourceCatalogs.map((catalog) => catalog.name)"
                :placeholder="t('structureEditor.copyColumnsSourceCatalog')"
                :search-placeholder="t('structureEditor.copyColumnsSourceCatalog')"
                :empty-text="t('common.noResults')"
                aria-labelledby="copy-source-catalog-label"
                trigger-class="h-8 w-full justify-between text-xs"
                :disabled="copySourceScopeLoading || !copySourceCatalogs.length"
                @update:model-value="(value: string) => changeCopySourceScope('catalog', value)"
              />
            </div>
            <div class="grid gap-1.5 text-sm font-medium">
              <label id="copy-source-database-label">{{ t(copySourceRootSchemaMode ? "structureEditor.copyColumnsSourceSchema" : "structureEditor.copyColumnsSourceDatabase") }}</label>
              <SearchableSelect
                :model-value="copySourceDatabase"
                :options="copySourceDatabases"
                :placeholder="t(copySourceRootSchemaMode ? 'structureEditor.copyColumnsSourceSchema' : 'structureEditor.copyColumnsSourceDatabase')"
                :search-placeholder="t(copySourceRootSchemaMode ? 'structureEditor.copyColumnsSourceSchema' : 'structureEditor.copyColumnsSourceDatabase')"
                :empty-text="t('common.noResults')"
                aria-labelledby="copy-source-database-label"
                trigger-class="h-8 w-full justify-between text-xs"
                :disabled="copySourceScopeLoading || !copySourceDatabases.length"
                @update:model-value="(value: string) => changeCopySourceScope('database', value)"
              />
            </div>
            <div v-if="copySourceHasSchema" class="grid gap-1.5 text-sm font-medium">
              <label id="copy-source-schema-label">{{ t("structureEditor.copyColumnsSourceSchema") }}</label>
              <SearchableSelect
                :model-value="copySourceSchema"
                :options="copySourceSchemas"
                :placeholder="t('structureEditor.copyColumnsSourceSchema')"
                :search-placeholder="t('structureEditor.copyColumnsSourceSchema')"
                :empty-text="t('common.noResults')"
                aria-labelledby="copy-source-schema-label"
                trigger-class="h-8 w-full justify-between text-xs"
                :disabled="copySourceScopeLoading || !copySourceSchemas.length"
                @update:model-value="(value: string) => changeCopySourceScope('schema', value)"
              />
            </div>
          </div>
          <div class="grid gap-1.5 text-sm font-medium">
            <label for="copy-source-table-search">{{ t("structureEditor.copyColumnsSourceTable") }}</label>
            <Input id="copy-source-table-search" :disabled="!copySourceScopeReady || copySourceScopeLoading" :model-value="copySourceTableSearch" :placeholder="t('structureEditor.copyColumnsSearchSourceTables')" @update:model-value="updateCopySourceTableSearch" />
          </div>

          <div v-if="copySourceScopeLoading || copySourceTablesLoading" class="flex items-center gap-2 py-5 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
            {{ t("common.loading") }}
          </div>
          <div v-else-if="copySourceError" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {{ copySourceError }}
          </div>
          <div v-else-if="!copySourceScopeReady" class="rounded-md border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
            {{ t("common.noResults") }}
          </div>
          <div v-else-if="copySourceTables.length === 0" class="rounded-md border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
            {{ copySourceTableSearch ? t("structureEditor.copyColumnsNoMatchingSourceTables") : t("structureEditor.copyColumnsNoSourceTables") }}
          </div>
          <template v-else>
            <div class="max-h-52 overflow-y-auto rounded-md border" :aria-label="t('structureEditor.copyColumnsSourceTable')">
              <button
                v-for="table in copySourceTables"
                :key="table.name"
                type="button"
                :aria-pressed="table.name === copySourceTableName"
                :class="['flex h-9 w-full items-center px-3 text-left font-mono text-sm hover:bg-muted/50 focus-visible:bg-muted focus-visible:outline-none', table.name === copySourceTableName ? 'bg-muted' : '']"
                @click="loadCopySourceColumns(table.name)"
              >
                <span class="truncate" :title="table.name">{{ table.name }}</span>
              </button>
            </div>
            <div v-if="copySourceTablesHasPreviousPage || copySourceTablesHasMore" class="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="icon"
                class="h-7 w-7"
                :disabled="copySourceTablesLoading || !copySourceTablesHasPreviousPage"
                :title="t('structureEditor.copyColumnsPreviousSourceTablePage')"
                :aria-label="t('structureEditor.copyColumnsPreviousSourceTablePage')"
                @click="loadCopySourceTables(Math.max(0, copySourceTablesOffset - COPY_SOURCE_TABLE_PAGE_SIZE))"
              >
                <ChevronLeft class="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="h-7 w-7"
                :disabled="copySourceTablesLoading || !copySourceTablesHasMore"
                :title="t('structureEditor.copyColumnsNextSourceTablePage')"
                :aria-label="t('structureEditor.copyColumnsNextSourceTablePage')"
                @click="loadCopySourceTables(copySourceTablesOffset + COPY_SOURCE_TABLE_PAGE_SIZE)"
              >
                <ChevronRight class="h-4 w-4" />
              </Button>
            </div>
          </template>
          <template v-if="copySourceTableName">
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium">{{ t("structureEditor.copyColumnsSelectFields") }}</span>
              <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="copySourceColumnsLoading || copyableSourceColumnNames.length === 0" @click="toggleCopySourceColumns">
                {{ allCopyableSourceColumnsSelected ? t("structureEditor.copyColumnsClearSelection") : t("structureEditor.copyColumnsSelectAll") }}
              </Button>
            </div>
            <Input v-model="copySourceColumnSearch" :placeholder="t('structureEditor.copyColumnsSearchFields')" />
            <div v-if="copySourceColumnsLoading" class="flex items-center gap-2 py-5 text-sm text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="copySourceColumns.length === 0" class="rounded-md border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
              {{ t("structureEditor.copyColumnsNoFields") }}
            </div>
            <div v-else-if="filteredCopyableSourceColumns.length === 0" class="rounded-md border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
              {{ t("structureEditor.copyColumnsNoMatchingFields") }}
            </div>
            <div v-else class="max-h-72 overflow-y-auto rounded-md border">
              <label v-for="{ column, details, alreadyExists } in filteredCopyableSourceColumns" :key="column.name" class="flex cursor-pointer items-start gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-muted/50" :class="alreadyExists ? 'cursor-not-allowed opacity-60' : ''">
                <input v-model="selectedCopySourceColumnNames" type="checkbox" :value="column.name" :disabled="alreadyExists" class="mt-0.5 size-4 shrink-0 rounded border-input" />
                <span class="min-w-0 flex-1">
                  <span class="flex min-w-0 items-center gap-2">
                    <span class="min-w-0 flex-1 truncate font-mono text-sm">{{ column.name }}</span>
                    <span class="shrink-0 text-xs text-muted-foreground">{{ column.data_type }}</span>
                  </span>
                  <span v-if="(columnEditorControls.defaultValue && details.defaultValue) || (columnEditorControls.comment && details.comment)" class="mt-0.5 flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
                    <span v-if="columnEditorControls.defaultValue && details.defaultValue" class="min-w-0 truncate" :title="`${t('structureEditor.defaultValue')}: ${details.defaultValue}`">{{ t("structureEditor.defaultValue") }}: {{ details.defaultValue }}</span>
                    <span v-if="columnEditorControls.comment && details.comment" class="min-w-0 truncate" :title="`${t('structureEditor.comment')}: ${details.comment}`">{{ t("structureEditor.comment") }}: {{ details.comment }}</span>
                  </span>
                </span>
                <Badge v-if="alreadyExists" variant="secondary" class="shrink-0 text-[10px]">{{ t("structureEditor.copyColumnsAlreadyExists") }}</Badge>
              </label>
            </div>
          </template>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="copyColumnsDialogOpen = false">{{ t("structureEditor.copyColumnsCancel") }}</Button>
          <Button :disabled="!canAddColumn || !copySourceCompatible || !copySourceScopeReady || copySourceScopeLoading || copySourceTablesLoading || copySourceColumnsLoading || !!copySourceError || selectedCopySourceColumns.length === 0" @click="applyCopiedColumns">
            {{ t("structureEditor.copyColumnsApply", { count: selectedCopySourceColumns.length }) }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="partitionDialogOpen">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ partitionOperationLabel(partitionDialogMode) }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-3">
          <div class="space-y-1">
            <label class="text-sm">{{ t("structureEditor.partitionName") }}</label>
            <Input v-model="partitionDialogName" class="font-mono" :disabled="partitionDialogMode === 'detach' || partitionDialogMode === 'drop'" :placeholder="t('structureEditor.partitionNamePlaceholder')" />
          </div>
          <template v-if="partitionDialogNeedsBound">
            <div class="space-y-1">
              <label class="text-sm">{{ t("structureEditor.partitionBoundKind") }}</label>
              <Select v-model="partitionDialogBoundKind">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="range">{{ t("structureEditor.partitionKindRange") }}</SelectItem>
                  <SelectItem value="list">{{ t("structureEditor.partitionKindList") }}</SelectItem>
                  <SelectItem value="hash">{{ t("structureEditor.partitionKindHash") }}</SelectItem>
                  <SelectItem value="default">{{ t("structureEditor.partitionBoundDefault") }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <template v-if="partitionDialogBoundKind === 'range'">
              <div class="space-y-1">
                <label class="text-sm">{{ t("structureEditor.partitionBoundFrom") }}</label>
                <Input v-model="partitionDialogRangeFrom" class="font-mono" placeholder="MINVALUE / '2025-01-01'" />
              </div>
              <div class="space-y-1">
                <label class="text-sm">{{ t("structureEditor.partitionBoundTo") }}</label>
                <Input v-model="partitionDialogRangeTo" class="font-mono" placeholder="'2026-01-01' / MAXVALUE" />
              </div>
            </template>
            <div v-else-if="partitionDialogBoundKind === 'list'" class="space-y-1">
              <label class="text-sm">{{ t("structureEditor.partitionBoundValues") }}</label>
              <Input v-model="partitionDialogListValues" class="font-mono" placeholder="1, 2, 3" />
            </div>
            <div v-else-if="partitionDialogBoundKind === 'hash'" class="grid grid-cols-2 gap-2">
              <div class="space-y-1">
                <label class="text-sm">{{ t("structureEditor.partitionBoundModulus") }}</label>
                <Input v-model="partitionDialogModulus" class="font-mono" inputmode="numeric" />
              </div>
              <div class="space-y-1">
                <label class="text-sm">{{ t("structureEditor.partitionBoundRemainder") }}</label>
                <Input v-model="partitionDialogRemainder" class="font-mono" inputmode="numeric" />
              </div>
            </div>
          </template>
          <label v-else-if="partitionDialogMode === 'detach' && partitionSupportsConcurrentDetach" class="flex items-center gap-2 text-sm">
            <input v-model="partitionDialogConcurrently" type="checkbox" />
            {{ t("structureEditor.partitionDetachConcurrently") }}
          </label>
          <p v-if="partitionDialogMode === 'detach'" class="text-sm text-muted-foreground">{{ t("structureEditor.partitionDetachWarning") }}</p>
          <p v-if="partitionDialogMode === 'drop'" class="text-sm text-destructive">{{ t("structureEditor.partitionDropWarning") }}</p>
          <div v-if="partitionDialogSql || partitionDialogSqlWarnings.length" class="space-y-1">
            <span class="text-sm text-muted-foreground">{{ t("structureEditor.partitionSqlPreview") }}</span>
            <pre v-if="partitionDialogSql" class="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 text-xs font-mono whitespace-pre-wrap break-all">{{ partitionDialogSql }}</pre>
            <p v-for="warning in partitionDialogSqlWarnings" :key="warning" class="text-xs text-destructive">{{ warning }}</p>
          </div>
          <p v-if="partitionDialogError" class="text-sm text-destructive">{{ partitionDialogError }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="partitionDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :variant="partitionDialogMode === 'drop' ? 'destructive' : 'default'" @click="confirmPartitionDialog">{{ t("common.confirm") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.structure-grid-column-selected {
  background-color: color-mix(in oklab, var(--primary) 14%, transparent) !important;
}

.structure-grid-column-selected :deep(input),
.structure-grid-column-selected :deep(button) {
  background-color: color-mix(in oklab, var(--primary) 10%, var(--background)) !important;
}

.structure-ddl-editor :deep(.cm-editor) {
  min-height: 100%;
  background: transparent;
}

.structure-ddl-editor :deep(.cm-content),
.structure-ddl-editor :deep(.cm-line) {
  cursor: text;
  user-select: text !important;
  -webkit-user-select: text !important;
}

.structure-ddl-editor :deep(.cm-selectionBackground),
.structure-ddl-editor :deep(.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground) {
  background: var(--dbx-editor-selection-background, rgba(59, 130, 246, 0.35)) !important;
}

.structure-ddl-editor :deep(.cm-content ::selection) {
  background: var(--dbx-editor-selection-background, rgba(59, 130, 246, 0.35)) !important;
}

/* DDL (CodeMirror) scrollbars match the grid scroller style. */
.structure-ddl-editor :deep(.cm-scroller::-webkit-scrollbar) {
  width: 10px;
  height: 10px;
}

.structure-ddl-editor :deep(.cm-scroller::-webkit-scrollbar-track) {
  background: transparent;
}

.structure-ddl-editor :deep(.cm-scroller::-webkit-scrollbar-thumb) {
  background: rgba(82, 82, 82, 0.3);
  background: color-mix(in oklab, var(--foreground) 30%, transparent);
  border: 3px solid transparent;
  background-clip: padding-box;
  border-radius: 999px;
}

.structure-ddl-editor :deep(.cm-scroller::-webkit-scrollbar-thumb:hover) {
  background: rgba(82, 82, 82, 0.48);
  background: color-mix(in oklab, var(--foreground) 48%, transparent);
  border-width: 2px;
  background-clip: padding-box;
}

.structure-table-scroller {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

/* Tab panel layout: toolbar, scrollable content and the custom horizontal bar
   stack in the first column, while the custom vertical bar occupies the second
   column of the content row. */
.structure-tabs {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: auto minmax(0, 1fr) auto;
}

/* Keep the primary action labelled for as long as the measured row fits. */
.structure-toolbar--compact .structure-toolbar-secondary,
.structure-toolbar--icons .structure-toolbar-action {
  width: var(--structure-control-height);
  padding-inline: 0;
  gap: 0;
}

.structure-toolbar--compact .structure-toolbar-secondary .structure-toolbar-label,
.structure-toolbar--icons .structure-toolbar-action .structure-toolbar-label {
  display: none;
}

.structure-toolbar--icons .structure-toolbar-search {
  width: 7rem;
}

/* Very small split panes still expose every action after labels are removed. */
.structure-toolbar--wrap {
  flex-wrap: wrap;
}

.structure-toolbar--wrap .structure-toolbar-tabs {
  height: auto;
  max-width: 100%;
  flex-wrap: wrap;
}

.structure-toolbar--wrap .structure-toolbar-actions {
  max-width: 100%;
  margin-left: auto;
  flex-wrap: wrap;
}

/* Both native scrollbars are replaced: the horizontal one by
   `.structure-horizontal-scrollbar`, the vertical one by
   `.structure-vertical-scrollbar`. */
.structure-table-scroller::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* Foreign keys / constraints / triggers card lists: both scrollbars match. */
.structure-card-scroller::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.structure-card-scroller::-webkit-scrollbar-track {
  background: transparent;
}

.structure-card-scroller::-webkit-scrollbar-thumb {
  background: rgba(82, 82, 82, 0.3);
  background: color-mix(in oklab, var(--foreground) 30%, transparent);
  border: 3px solid transparent;
  background-clip: padding-box;
  border-radius: 999px;
}

.structure-card-scroller::-webkit-scrollbar-thumb:hover {
  background: rgba(82, 82, 82, 0.48);
  background: color-mix(in oklab, var(--foreground) 48%, transparent);
  border-width: 2px;
  background-clip: padding-box;
}

.structure-table-scroller::-webkit-scrollbar-track {
  background: transparent;
}

.structure-table-scroller::-webkit-scrollbar-thumb {
  background: rgba(82, 82, 82, 0.3);
  background: color-mix(in oklab, var(--foreground) 30%, transparent);
  border: 3px solid transparent;
  background-clip: padding-box;
  border-radius: 999px;
}

.structure-table-scroller::-webkit-scrollbar-thumb:hover {
  background: rgba(82, 82, 82, 0.48);
  background: color-mix(in oklab, var(--foreground) 48%, transparent);
  border-width: 2px;
  background-clip: padding-box;
}

.structure-column-virtual-scroller {
  overflow-anchor: none;
  overscroll-behavior: none;
  will-change: scroll-position;
  contain: layout style paint;
}

.structure-column-virtual-scroller :deep(.vue-recycle-scroller__slot) {
  position: sticky;
  top: 0;
  z-index: 10;
  min-width: var(--structure-column-table-width);
  background: var(--background);
}

.structure-column-virtual-scroller :deep(.structure-column-virtual-list) {
  min-width: var(--structure-column-table-width);
  overflow: visible;
}

.structure-column-virtual-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style paint;
}

.structure-column-virtual-scroller.is-scrolling :deep(.vue-recycle-scroller__item-view) {
  pointer-events: none;
}

.structure-column-virtual-scroller.is-scrolling :deep(.structure-column-virtual-row *) {
  transition: none !important;
}

.structure-column-virtual-scroller :deep(.structure-column-virtual-row) {
  width: 100%;
  min-width: var(--structure-column-table-width);
  min-height: var(--structure-column-row-height);
  box-sizing: border-box;
}

.structure-column-virtual-scroller :deep(.structure-column-virtual-header-table),
.structure-column-virtual-scroller :deep(.structure-column-virtual-row-table) {
  /* Fill wide panes while retaining the configured column widths on overflow.
     Header and virtual rows must use the same fixed table layout. */
  width: 100%;
  min-width: var(--structure-column-table-width);
  table-layout: fixed;
  box-sizing: border-box;
}

.structure-column-virtual-scroller :deep(.structure-column-virtual-row-table) {
  height: 100%;
}

.structure-column-virtual-scroller :deep(.structure-column-virtual-row-table tr) {
  height: 100%;
  box-sizing: border-box;
}

.structure-column-virtual-scroller :deep(.structure-column-virtual-row-table td) {
  height: var(--structure-column-row-height);
  box-sizing: border-box;
  vertical-align: middle;
}

.structure-vertical-scrollbar {
  position: relative;
  width: 10px;
  cursor: default;
  touch-action: none;
}

.structure-vertical-scrollbar__thumb {
  position: absolute;
  left: 3px;
  width: 4px;
  min-height: 24px;
  border-radius: 999px;
  background: rgba(82, 82, 82, 0.3);
  background: color-mix(in oklab, var(--foreground) 30%, transparent);
  transition:
    left 120ms ease,
    width 120ms ease,
    background-color 120ms ease;
}

.structure-vertical-scrollbar:hover .structure-vertical-scrollbar__thumb,
.structure-vertical-scrollbar--dragging .structure-vertical-scrollbar__thumb {
  left: 2px;
  width: 6px;
  background: rgba(82, 82, 82, 0.48);
  background: color-mix(in oklab, var(--foreground) 48%, transparent);
}

.structure-horizontal-scrollbar {
  position: relative;
  height: 10px;
  flex-shrink: 0;
  cursor: pointer;
  touch-action: none;
  background: transparent;
}

.structure-horizontal-scrollbar__thumb {
  position: absolute;
  top: 3px;
  height: 4px;
  min-width: 24px;
  border-radius: 999px;
  background: rgba(82, 82, 82, 0.3);
  background: color-mix(in oklab, var(--foreground) 30%, transparent);
  transition:
    top 120ms ease,
    height 120ms ease,
    background-color 120ms ease;
}

.structure-horizontal-scrollbar:hover .structure-horizontal-scrollbar__thumb,
.structure-horizontal-scrollbar--dragging .structure-horizontal-scrollbar__thumb {
  top: 2px;
  height: 6px;
  background: rgba(82, 82, 82, 0.48);
  background: color-mix(in oklab, var(--foreground) 48%, transparent);
}

/* Editable values behave like grid cells, not a row of independent pill controls. */
.structure-edit-grid :deep(.structure-grid-control) {
  height: var(--structure-control-height);
  min-height: var(--structure-control-height);
  max-height: var(--structure-control-height);
  padding-top: 0;
  padding-bottom: 0;
  border-color: transparent;
  border-radius: 0;
  background-color: transparent;
  box-shadow: none;
}

.structure-edit-grid :deep(.structure-grid-control[data-slot="select-trigger"]) {
  height: var(--structure-control-height);
  min-height: var(--structure-control-height);
  max-height: var(--structure-control-height);
  padding-top: 0;
  padding-bottom: 0;
}

.structure-edit-grid > tbody > tr > td:hover,
.structure-edit-grid > tr > td:hover {
  background-color: color-mix(in oklab, var(--muted) 36%, transparent);
}

.structure-edit-grid > tbody > tr > td:focus-within,
.structure-edit-grid > tr > td:focus-within {
  background-color: color-mix(in oklab, var(--primary) 7%, transparent);
  outline: 1px solid color-mix(in oklab, var(--primary) 55%, transparent);
  outline-offset: -1px;
}

.structure-edit-grid > tbody > tr > td:focus-within :deep(.structure-grid-control),
.structure-edit-grid > tr > td:focus-within :deep(.structure-grid-control) {
  border-color: transparent;
  background-color: transparent;
  box-shadow: none;
}

.structure-column-primary-key,
.structure-index-primary-key {
  --structure-key-color: #d97706;
}

.structure-column-unique-key,
.structure-index-unique-key {
  --structure-key-color: #dc2626;
}

.structure-column-index-key,
.structure-index-normal-key {
  --structure-key-color: #15803d;
}

.structure-column-fulltext-key,
.structure-index-fulltext-key {
  --structure-key-color: #9333ea;
}

.structure-column-spatial-key,
.structure-index-spatial-key {
  --structure-key-color: #0e7490;
}

.structure-column-key-icon {
  color: var(--structure-key-color);
}

.structure-column-primary-key > td:first-child,
.structure-column-unique-key > td:first-child,
.structure-column-index-key > td:first-child,
.structure-column-fulltext-key > td:first-child,
.structure-column-spatial-key > td:first-child {
  box-shadow: inset 3px 0 0 var(--structure-key-color);
}

.structure-column-primary-key > td:nth-child(2) :deep(.structure-grid-control),
.structure-column-unique-key > td:nth-child(2) :deep(.structure-grid-control),
.structure-column-index-key > td:nth-child(2) :deep(.structure-grid-control),
.structure-column-fulltext-key > td:nth-child(2) :deep(.structure-grid-control),
.structure-column-spatial-key > td:nth-child(2) :deep(.structure-grid-control),
.structure-index-name :deep(.structure-grid-control) {
  color: var(--structure-key-color);
  font-weight: 600;
}

.structure-column-data-type,
.structure-column-default-value,
.structure-data-type-option {
  --structure-type-color: var(--muted-foreground);
}

.structure-data-type-option {
  color: var(--structure-type-color);
  font-weight: 500;
}

.structure-data-type-numeric,
.structure-data-type-boolean {
  --structure-type-color: #2563eb;
}

.structure-data-type-real {
  --structure-type-color: #6366d1;
}

.structure-data-type-text,
.structure-data-type-json {
  --structure-type-color: #15803d;
}

.structure-data-type-temporal {
  --structure-type-color: #b45309;
}

.structure-data-type-binary {
  --structure-type-color: #9333b8;
}

.structure-data-type-enum,
.structure-data-type-other {
  --structure-type-color: #737323;
}

.structure-data-type-spatial {
  --structure-type-color: #0e7490;
}

.structure-data-type-null {
  --structure-type-color: var(--muted-foreground);
}

.dark .structure-column-primary-key,
.dark .structure-index-primary-key {
  --structure-key-color: #fbbf24;
}

.dark .structure-column-unique-key,
.dark .structure-index-unique-key {
  --structure-key-color: #f87171;
}

.dark .structure-column-index-key,
.dark .structure-index-normal-key {
  --structure-key-color: #86efac;
}

.dark .structure-column-fulltext-key,
.dark .structure-index-fulltext-key {
  --structure-key-color: #d8b4fe;
}

.dark .structure-column-spatial-key,
.dark .structure-index-spatial-key {
  --structure-key-color: #67e8f9;
}

.dark .structure-data-type-numeric,
.dark .structure-data-type-boolean {
  --structure-type-color: #93c5fd;
}

.dark .structure-data-type-real {
  --structure-type-color: #a5b4fc;
}

.dark .structure-data-type-text,
.dark .structure-data-type-json {
  --structure-type-color: #86efac;
}

.dark .structure-data-type-temporal {
  --structure-type-color: #fcd34d;
}

.dark .structure-data-type-binary {
  --structure-type-color: #d8b4fe;
}

.dark .structure-data-type-enum,
.dark .structure-data-type-other {
  --structure-type-color: #d4d486;
}

.dark .structure-data-type-spatial {
  --structure-type-color: #67e8f9;
}

.structure-column-data-type :deep(.structure-grid-control),
.structure-column-default-value :deep(.structure-grid-control) {
  color: var(--structure-type-color);
  font-weight: 500;
}

/* --primary is rgb/oklch; use color-mix like DataGrid, not channel-based hsl wrappers. */
.structure-column-search-match > td:first-child {
  box-shadow: inset 3px 0 0 color-mix(in oklab, var(--primary) 55%, transparent);
}

.structure-column-search-current > td {
  background-color: color-mix(in oklab, var(--primary) 8%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, var(--primary) 55%, transparent),
    inset 0 -1px 0 color-mix(in oklab, var(--primary) 55%, transparent);
}

.structure-column-search-current > td:first-child {
  box-shadow:
    inset 3px 0 0 var(--primary),
    inset 0 1px 0 color-mix(in oklab, var(--primary) 55%, transparent),
    inset 0 -1px 0 color-mix(in oklab, var(--primary) 55%, transparent);
}
</style>

<style>
/* Non-scoped so the scrollbar pseudo-elements on CodeMirror's cm-scroller actually match in WebView2.
   Matches the grid / card scroller scrollbar style (10px track, 4px thumb, 6px on hover). */
.structure-ddl-editor .cm-scroller::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.structure-ddl-editor .cm-scroller::-webkit-scrollbar-track {
  background: transparent;
}

.structure-ddl-editor .cm-scroller::-webkit-scrollbar-thumb {
  background: rgba(82, 82, 82, 0.3);
  background: color-mix(in oklab, var(--foreground) 30%, transparent);
  border: 3px solid transparent;
  background-clip: padding-box;
  border-radius: 999px;
}

.structure-ddl-editor .cm-scroller::-webkit-scrollbar-thumb:hover {
  background: rgba(82, 82, 82, 0.48);
  background: color-mix(in oklab, var(--foreground) 48%, transparent);
  border-width: 2px;
  background-clip: padding-box;
}

html.dbx-legacy-webview.dark .structure-ddl-editor .cm-scroller::-webkit-scrollbar-thumb,
html.dbx-legacy-webview.dark .structure-card-scroller::-webkit-scrollbar-thumb,
html.dbx-legacy-webview.dark .structure-table-scroller::-webkit-scrollbar-thumb,
html.dbx-legacy-webview.dark .structure-horizontal-scrollbar__thumb,
html.dbx-legacy-webview.dark .structure-vertical-scrollbar__thumb {
  background: rgba(212, 212, 216, 0.3);
}

html.dbx-legacy-webview.dark .structure-ddl-editor .cm-scroller::-webkit-scrollbar-thumb:hover,
html.dbx-legacy-webview.dark .structure-card-scroller::-webkit-scrollbar-thumb:hover,
html.dbx-legacy-webview.dark .structure-table-scroller::-webkit-scrollbar-thumb:hover,
html.dbx-legacy-webview.dark .structure-horizontal-scrollbar:hover .structure-horizontal-scrollbar__thumb,
html.dbx-legacy-webview.dark .structure-horizontal-scrollbar--dragging .structure-horizontal-scrollbar__thumb,
html.dbx-legacy-webview.dark .structure-vertical-scrollbar:hover .structure-vertical-scrollbar__thumb,
html.dbx-legacy-webview.dark .structure-vertical-scrollbar--dragging .structure-vertical-scrollbar__thumb {
  background: rgba(212, 212, 216, 0.48);
}
</style>
