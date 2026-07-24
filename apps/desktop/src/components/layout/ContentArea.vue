<script setup lang="ts">
import { computed, ref, defineAsyncComponent, watch, nextTick, onMounted, onUnmounted } from "vue";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { appendDebugLog, isDebugLoggingEnabled } from "@/lib/backend/debugLog";
import { canReloadUnavailableDataTab } from "@/lib/table/tableDataRefresh";
import type { CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Columns3, Columns3Cog, EyeOff, Loader2, Search, TableProperties, ChevronDown, ChevronUp, Inbox, RefreshCcw, Wrench, Toolbox, Database, Download, Upload, X, Pin, Rows3, SquareDashed, Minus, Plus, ShieldAlert } from "@lucide/vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuPortal } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import ColumnInfoPanel from "@/components/editor/ColumnInfoPanel.vue";
import QueryLoadingState from "@/components/common/QueryLoadingState.vue";
import QueryErrorActions from "@/components/common/QueryErrorActions.vue";
import QueryResultToolbarActions from "@/components/layout/QueryResultToolbarActions.vue";
import QueryResultViewSwitcher from "@/components/layout/QueryResultViewSwitcher.vue";
import DataGridFontFamilyControl from "@/components/grid/DataGridFontFamilyControl.vue";
import type { ColumnInfo } from "@/components/editor/ColumnInfoPanel.vue";
let dataGridComponentPromise: Promise<typeof import("@/components/grid/DataGrid.vue")> | undefined;
function loadDataGridComponent() {
  if (!dataGridComponentPromise) {
    dataGridComponentPromise = (async () => {
      const shouldLogTiming = isDebugLoggingEnabled();
      const startedAt = shouldLogTiming ? performance.now() : 0;
      if (shouldLogTiming) appendDebugLog("info", "[DBX][DataGrid:load:start]");
      const component = await import("@/components/grid/DataGrid.vue");
      if (shouldLogTiming) appendDebugLog("info", "[DBX][DataGrid:load:done]", { elapsed: `${Math.round(performance.now() - startedAt)}ms` });
      return component;
    })();
  }
  return dataGridComponentPromise;
}

function preloadDataGridComponent() {
  void loadDataGridComponent();
}

const DataGrid = defineAsyncComponent(loadDataGridComponent);
const RedisKeyBrowser = defineAsyncComponent(() => import("@/components/redis/RedisKeyBrowser.vue"));
const RedisDashboard = defineAsyncComponent(() => import("@/components/redis/RedisDashboard.vue"));
const EtcdKeyBrowser = defineAsyncComponent(() => import("@/components/etcd/EtcdKeyBrowser.vue"));
const ZooKeeperKeyBrowser = defineAsyncComponent(() => import("@/components/zookeeper/ZooKeeperKeyBrowser.vue"));
const DocumentBrowser = defineAsyncComponent(() => import("@/components/document/DocumentBrowser.vue"));
const MongoGridFsBrowser = defineAsyncComponent(() => import("@/components/document/MongoGridFsBrowser.vue"));
const MongoBucketBrowser = defineAsyncComponent(() => import("@/components/document/MongoBucketBrowser.vue"));
const VectorBrowser = defineAsyncComponent(() => import("@/components/vector/VectorBrowser.vue"));
const ElasticsearchJsonResponsePanel = defineAsyncComponent(() => import("@/components/common/ElasticsearchJsonResponsePanel.vue"));
const MqAdminConsole = defineAsyncComponent(() => import("@/components/mq/MqAdminConsole.vue"));
const NacosAdminConsole = defineAsyncComponent(() => import("@/components/nacos/NacosAdminConsole.vue"));
const ObjectBrowser = defineAsyncComponent(() => import("@/components/objects/ObjectBrowser.vue"));
const TableStructureEditor = defineAsyncComponent(() => import("@/components/structure/TableStructureEditor.vue"));
const DatabaseUserAdmin = defineAsyncComponent(() => import("@/components/admin/DatabaseUserAdmin.vue"));
const ProcessListPanel = defineAsyncComponent(() => import("@/components/admin/ProcessListPanel.vue"));
const MySqlDashboard = defineAsyncComponent(() => import("@/components/admin/MySqlDashboard.vue"));
const PostgresDashboard = defineAsyncComponent(() => import("@/components/admin/PostgresDashboard.vue"));
const DamengJobAdmin = defineAsyncComponent(() => import("@/components/admin/DamengJobAdmin.vue"));
const ExplainPlanViewer = defineAsyncComponent(() => import("@/components/explain/ExplainPlanViewer.vue"));
const QueryChart = defineAsyncComponent(() => import("@/components/chart/QueryChart.vue"));
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { TABLE_FONT_SIZE_MAX, TABLE_FONT_SIZE_MIN, useSettingsStore, type DataGridSearchMode } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { canCancelQueryExecution, queryExecutionLabelKey } from "@/lib/sql/queryExecutionState";
import { databaseDisplayNameForTab, executionSummaryItems, queryResultExecutionSql, resultGridCacheKey, resultRunItems, resultSourceRange, resultSqlForGrid, statementExecutionMarkers, tabularResultItems } from "@/lib/tabs/tabPresentation";
import { defaultQueryResultArchiveFileName } from "@/lib/query/queryResultArchive";
import { saveQueryResultArchiveFile } from "@/lib/query/queryResultArchiveFile";
import { isTableDataEditable } from "@/lib/table/tableEditing";
import { tableMetaForDataTab } from "@/lib/table/tableDataTabMeta";
import { dataTabExecutionDatabase } from "@/lib/table/dataTabExecutionDatabase";
import { formatShortcut } from "@/lib/editor/shortcutRegistry";
import { codeMirrorSqlDialect, codeMirrorSqlDialectForConnection, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { chartableColumnIndexes } from "@/lib/dataGrid/chartData";
import { elasticsearchJsonResponseForResult } from "@/lib/elasticsearch/elasticsearchJsonResponse";
import * as api from "@/lib/backend/api";
import { applyMongoGridChangesToDocument, buildMongoUpdateDocument, formatMongoShellLiteral, serializeMongoDocumentId, type MongoInputValue } from "@/lib/mongo/mongoDocumentValues";
import type { SqlExecutionOverride } from "@/lib/sql/sqlExecutionTarget";
import type { DataGridSortMode } from "@/lib/dataGrid/dataGridSort";
import { DATA_GRID_COMPACT_TOPBAR_WIDTH, type DataGridReloadIntent } from "@/lib/dataGrid/dataGridToolbar";
import { useTabScroll } from "@/composables/useTabScroll";
import { formatElapsedSeconds } from "@/lib/common/elapsedTime";
import type { CustomSaveHandler } from "@/composables/useDataGridEditor";
import type { QueryTab, ConnectionConfig, TableInfoTab, TreeNode, VectorCollectionMeta, ObjectBrowserViewport } from "@/types/database";
import type { SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";
import { sqlFormatDialectForDbType, type SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import { productionContextForDatabase } from "@/lib/database/productionSafety";

type DataGridHandle = {
  onToolbarRefresh: () => Promise<void> | void;
  focusSearch: () => boolean;
  openCellDetailSearch: () => boolean;
  visibleColumnCount: number;
  displayableColumnCount: number;
  hiddenColumnCount: number;
  filteredColumnVisibilityOptions: (search: string) => Array<{ index: number; column: string; comment?: string }>;
  isColumnVisible: (columnIndex: number) => boolean;
  toggleColumnVisibility: (columnIndex: number) => void;
  showAllColumns: () => void;
  invertColumnVisibility: () => void;
  hasCustomColumnOrder: boolean;
  resetColumnOrder: () => void;
  nullColumnsHidden: boolean;
  allNullColumnCount: number;
  canToggleAllNullColumns: boolean;
  toggleAllNullColumns: () => void;
  showDdl: boolean;
  toggleDdl: (tab?: TableInfoTab) => void;
  multiRowTranspose: boolean;
  setMultiRowTranspose: (value: boolean) => void;
  exportCsv: () => Promise<void>;
  exportJson: () => Promise<void>;
  exportSql: () => Promise<void>;
  exportXlsx: () => Promise<void>;
};

type SearchableBrowserHandle = {
  focusSearch: () => boolean;
  refresh?: () => boolean;
  insertCommand?: (command: string) => Promise<boolean>;
  executeCommand?: (command: string) => Promise<boolean>;
};

const props = defineProps<{
  activeTab: QueryTab;
  activeConnection?: ConnectionConfig;
  executableSql: string;
  activeOutputView: "result" | "summary" | "explain" | "chart";
  formatSqlRequest: { id: number; tabId: string } | null;
  compressSqlRequest: { id: number; tabId: string } | null;
  selectedSql: string;
  cursorPos: number;
  blockDangerousRedisCommands: boolean;
}>();

const emit = defineEmits<{
  "update:activeOutputView": [value: "result" | "summary" | "explain" | "chart"];
  fixWithAi: [errorMessage: string];
  sendSelectionToAi: [sql: string];
  execute: [sqlOverride?: SqlExecutionOverride];
  saveSql: [];
  cancel: [];
  explain: [];
  editorUpdate: [tabId: string, value: string];
  editorSelectionChange: [value: string];
  editorCursorChange: [pos: number];
  editorViewportChange: [tabId: string, viewport: { scrollTop: number; scrollLeft: number }];
  editorSelectionStateChange: [tabId: string, selection: { anchor: number; head: number }];
  formatError: [];
  reload: [sql?: string, searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number, intent?: DataGridReloadIntent];
  paginate: [offset: number, limit: number, whereInput?: string, orderBy?: string];
  sort: [column: string, columnIndex: number, direction: "asc" | "desc" | null, whereInput?: string, mode?: DataGridSortMode];
  executeSql: [sql: string];
  clickTable: [target: SqlObjectNavigationTarget];
  viewTableData: [target: SqlObjectNavigationTarget];
  viewTableDdl: [target: SqlObjectNavigationTarget];
  editTableStructure: [target: SqlObjectNavigationTarget];
  openObjectSource: [target: SqlObjectNavigationTarget, initialEditing: boolean];
  openObjectTable: [target: { tableName: string; schema?: string; tableType?: string; catalog?: string }];
  objectSchemaChange: [schema: string | undefined];
  objectBrowserViewportChange: [tabId: string, viewport: ObjectBrowserViewport];
  structureEditorSaved: [commentChanged: boolean];
  structureEditorClose: [];
  openSettings: [initialTab?: string, initialSection?: string];
  openConnectionSettings: [connectionId: string, initialTab: "advanced"];
}>();

const { t, locale } = useI18n();
const queryStore = useQueryStore();
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const DEFAULT_QUERY_RESULTS_PANE_SIZE = 68;

onMounted(() => {
  const preload = () => preloadDataGridComponent();
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(preload, { timeout: 1500 });
  } else {
    setTimeout(preload, 300);
  }
  window.addEventListener("dbx-refresh-active-kv-browser", onRefreshActiveKvBrowser);
});

watch(
  () => [props.activeTab.mode, !!props.activeTab.result] as const,
  ([mode, hasResult]) => {
    if (mode === "data" || hasResult) preloadDataGridComponent();
  },
  { immediate: true },
);

// Column info panel state
const showColumnInfo = ref(false);
const columnInfoColumns = ref<ColumnInfo[]>([]);
const columnInfoLoading = ref(false);
const columnInfoError = ref<string | undefined>(undefined);
const dataGridRef = ref<DataGridHandle>();
const queryEditorRef = ref<InstanceType<typeof QueryEditor>>();
const tableStructureEditorRef = ref<{ applyChanges: () => Promise<boolean> }>();
const standaloneResultToolbarRef = ref<HTMLElement | null>(null);
const standaloneResultToolbarWidth = ref(0);
const resultTabsScrollerRef = ref<HTMLElement | null>(null);
const columnVisibilitySearch = ref("");
const columnVisibilityOptions = computed(() => dataGridRef.value?.filteredColumnVisibilityOptions(columnVisibilitySearch.value) ?? []);
const dataGridRenderMode = computed(() => settingsStore.editorSettings.dataGridRenderMode);
const dataGridSearchMode = computed(() => settingsStore.editorSettings.dataGridSearchMode);
const columnWidthDensity = computed(() => settingsStore.editorSettings.columnWidthDensity);
const tableFontSize = computed(() => settingsStore.editorSettings.tableFontSize);
const redisKeyBrowserRef = ref<SearchableBrowserHandle>();
const documentBrowserRef = ref<SearchableBrowserHandle>();

const etcdKeyBrowserRef = ref<SearchableBrowserHandle>();
const zookeeperKeyBrowserRef = ref<SearchableBrowserHandle>();
const objectBrowserRef = ref<SearchableBrowserHandle>();
const activeTableMeta = computed(() => props.activeTab.tableMeta);
const activeDataTabTableMeta = computed(() => tableMetaForDataTab(props.activeTab));
const activeEffectiveDatabaseType = computed(() => effectiveDatabaseTypeForConnection(props.activeConnection));
const activeDataTabExecutionDatabase = computed(() => dataTabExecutionDatabase(props.activeConnection, props.activeTab.database, activeDataTabTableMeta.value?.catalog));
const activeProductionContext = computed(() => productionContextForDatabase(props.activeConnection, props.activeTab.database));
const productionWatermarkText = computed(() => (locale.value.startsWith("zh") ? "生产环境" : "PROD"));
const productionSessionDetail = computed(() => {
  if (!activeProductionContext.value.active) return "";
  if (activeProductionContext.value.reason === "connection") return t("production.connection");
  return activeProductionContext.value.databases.join(", ") || t("production.databases");
});

function findNodeInTree(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findNodeInTree(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

function setDataGridRenderMode(value: "canvas" | "dom") {
  settingsStore.updateEditorSettings({ dataGridRenderMode: value });
}

function setDataGridSearchMode(value: DataGridSearchMode) {
  settingsStore.updateEditorSettings({ dataGridSearchMode: value });
}

function setColumnWidthDensity(value: "compact" | "standard" | "comfortable") {
  settingsStore.updateEditorSettings({ columnWidthDensity: value });
}

function setTableFontSize(value: number) {
  settingsStore.updateEditorSettings({ tableFontSize: value });
}

function decreaseTableFontSize() {
  setTableFontSize(tableFontSize.value - 1);
}

function increaseTableFontSize() {
  setTableFontSize(tableFontSize.value + 1);
}

const activeTabDimension = computed(() => {
  const tab = props.activeTab;
  if (!tab.connectionId || tab.mode !== "vector") return undefined;
  const isMilvus = connectionStore.getConfig(tab.connectionId)?.db_type === "milvus";
  const suffix = isMilvus && tab.database ? `${tab.database}:${tab.sql}` : tab.sql;
  const nodeId = `${tab.connectionId}:__vector_collection:${suffix}`;
  const meta = findNodeInTree(connectionStore.treeNodes, nodeId)?.meta;
  return meta && "dimension" in meta ? (meta as VectorCollectionMeta).dimension : undefined;
});

const activeSqlFormatDialect = computed<SqlFormatDialect>(() => sqlFormatDialectForDbType(activeEffectiveDatabaseType.value));

const editorDialect = computed<"mysql" | "postgres" | "sqlserver">(() => codeMirrorSqlDialect(activeEffectiveDatabaseType.value));
const editorSyntaxDialect = computed<"mysql" | "postgres" | "sqlserver">(() => codeMirrorSqlDialectForConnection(props.activeConnection));

const shortcutModifier = computed(() => (navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl"));

const modRKeys = computed(() =>
  formatShortcut("Mod+R")
    .split("+")
    .map((key) => (key === "Cmd" ? "⌘" : key)),
);

const {
  hasTabOverflow: hasResultTabOverflow,
  scrollThumbLeftPercent: resultTabsThumbLeftPercent,
  scrollThumbWidthPercent: resultTabsThumbWidthPercent,
  isScrollbarDragging: isResultTabsScrollbarDragging,
  updateScrollButtons: updateResultTabsScrollbar,
  onTabsWheel: onResultTabsWheel,
  startScrollbarDrag: startResultTabsScrollbarDrag,
} = useTabScroll(resultTabsScrollerRef);

const resultTabsScrollerStyle: CSSProperties = {
  msOverflowStyle: "none",
  scrollbarWidth: "none",
  WebkitOverflowScrolling: "touch",
};

const resultTabsScrollbarThumbStyle = computed<CSSProperties>(() => ({
  insetInlineStart: `${resultTabsThumbLeftPercent.value}%`,
  width: `${resultTabsThumbWidthPercent.value}%`,
}));

const hasNumericData = computed(() => {
  const r = props.activeTab.result;
  if (!r || r.rows.length === 0) return false;
  return chartableColumnIndexes(r).length > 0;
});

const activeQueryError = computed(() => {
  const result = props.activeTab.result;
  if (!result?.columns.includes("Error")) return "";
  return String(result.rows[0]?.[0] ?? "");
});
const hasQueryOutput = computed(
  () =>
    !!props.activeTab.result || props.activeTab.resultEvicted === true || !!props.activeTab.explainPlan || !!props.activeTab.explainError || !!props.activeTab.explainTableResult || !!props.activeTab.explainTableError || props.activeTab.isExecuting === true || props.activeTab.isExplaining === true,
);
const visibleResultItems = computed(() => tabularResultItems(props.activeTab.results ?? (props.activeTab.result ? [props.activeTab.result] : undefined)));
const tabularResults = computed(() => tabularResultItems(props.activeTab.results));
const allResultExportSheets = computed(() =>
  tabularResults.value.map((item) => ({
    sheetName: item.label || t("tabs.resultN", { n: item.n }),
    result: item.result,
    sql: item.index === props.activeTab.activeResultIndex ? queryResultExecutionSql(props.activeTab) : item.result.sourceStatement,
  })),
);
const resultRuns = computed(() => resultRunItems(props.activeTab));
const activeResultRunItem = computed(() => resultRuns.value.find((run) => run.active));
const activeResultGridCacheKey = computed(() => resultGridCacheKey(props.activeTab));
const activeResultSql = computed(() => resultSqlForGrid(props.activeTab));
const activeResultExportSql = computed(() => queryResultExecutionSql(props.activeTab));
const activeStatementExecutionMarkers = computed(() =>
  statementExecutionMarkers(
    props.activeTab.sql,
    props.activeTab.results ?? (props.activeTab.result ? [props.activeTab.result] : undefined),
    activeEffectiveDatabaseType.value,
    props.activeTab.resultBaseSql || props.activeTab.lastExecutedSql || props.activeTab.sql,
    props.activeTab.resultEditorFingerprint ?? "",
  ),
);
const activeElasticsearchJsonResponse = computed(() => elasticsearchJsonResponseForResult(activeEffectiveDatabaseType.value, activeResultSql.value, props.activeTab.result));
const resultArchiveExporting = ref(false);
const canExportResultArchive = computed(() => props.activeTab.mode === "query" && (!!props.activeTab.result || !!props.activeTab.results?.length || !!props.activeTab.resultRuns?.length));
const resultAutoSave = computed(() => props.activeTab.resultAutoSave === true);
const showResultRunSelector = computed(() => resultAutoSave.value && resultRuns.value.length > 0);
watch(
  () => visibleResultItems.value.map((item) => item.index).join(","),
  () => {
    nextTick(updateResultTabsScrollbar);
  },
);
const summaryItems = computed(() => executionSummaryItems(props.activeTab));
const hasExecutionSummary = computed(() => summaryItems.value.length > 0 || props.activeTab.isExecuting);
const hasTabularResult = computed(() => {
  if (props.activeTab.result?.columns.length) return true;
  return visibleResultItems.value.length > 0;
});
const canShowResultOutput = computed(() => hasTabularResult.value || props.activeTab.isExecuting);
const canShowExplainOutput = computed(() => !!props.activeTab.explainPlan || !!props.activeTab.explainError || !!props.activeTab.explainTableResult || !!props.activeTab.explainTableError || props.activeTab.isExplaining === true);
const showStandaloneResultToolbar = computed(() => activeElasticsearchJsonResponse.value || props.activeOutputView !== "result" || !props.activeTab.result || !hasTabularResult.value);
const standaloneResultToolbarCompact = computed(() => standaloneResultToolbarWidth.value > 0 && standaloneResultToolbarWidth.value < DATA_GRID_COMPACT_TOPBAR_WIDTH);
let standaloneResultToolbarResizeObserver: ResizeObserver | undefined;

function observeStandaloneResultToolbar() {
  standaloneResultToolbarResizeObserver?.disconnect();
  standaloneResultToolbarResizeObserver = undefined;
  const toolbar = standaloneResultToolbarRef.value;
  standaloneResultToolbarWidth.value = toolbar?.clientWidth ?? 0;
  if (toolbar && typeof ResizeObserver !== "undefined") {
    standaloneResultToolbarResizeObserver = new ResizeObserver(() => {
      standaloneResultToolbarWidth.value = toolbar.clientWidth;
    });
    standaloneResultToolbarResizeObserver.observe(toolbar);
  }
}

watch(standaloneResultToolbarRef, observeStandaloneResultToolbar, { flush: "post" });
type MongoQueryGridChanges = {
  dirtyRows: Map<number, Map<number, MongoInputValue>>;
  deletedRows: Set<number>;
  newRows: MongoInputValue[][];
  columns: string[];
  rows: MongoInputValue[][];
};
function mongoCollectionExpression(collection: string): string {
  return `db.getCollection(${JSON.stringify(collection)})`;
}
function mongoQueryResultDocumentId(rowIdx: number, fallback: unknown): unknown {
  const document = props.activeTab.result?.mongo_documents?.[rowIdx];
  if (!document || typeof document !== "object" || Array.isArray(document)) return fallback;
  return (document as Record<string, unknown>)._id ?? fallback;
}
const mongoQueryResultSaveHandler = computed<CustomSaveHandler | undefined>(() => {
  const tab = props.activeTab;
  const target = tab.mongoEditTarget;
  if (tab.mode !== "query" || activeEffectiveDatabaseType.value !== "mongodb" || !target || !tab.connectionId || !tab.database || !tab.result) return undefined;
  if (!tab.result.columns.includes(target.idColumn)) return undefined;

  const save: CustomSaveHandler["save"] = async (changes: MongoQueryGridChanges) => {
    if (changes.newRows.length > 0 || changes.deletedRows.size > 0) {
      throw new Error("MongoDB query result editing only supports updating existing rows.");
    }
    const idColIdx = changes.columns.indexOf(target.idColumn);
    if (idColIdx < 0) throw new Error("No _id column");
    for (const [rowIdx, dirtyCols] of changes.dirtyRows) {
      const row = changes.rows[rowIdx];
      const id = row?.[idColIdx];
      if (id === null || id === undefined || String(id).trim() === "") continue;
      const updateDoc = buildMongoUpdateDocument(dirtyCols, changes.columns, tab.result?.mongo_documents?.[rowIdx]);
      if (Object.keys(updateDoc).length === 0) continue;
      await api.mongoUpdateDocument(tab.connectionId, tab.database, target.collection, serializeMongoDocumentId(mongoQueryResultDocumentId(rowIdx, id)), JSON.stringify(updateDoc));
    }
  };

  const preview: CustomSaveHandler["preview"] = async (changes: MongoQueryGridChanges) => {
    const idColIdx = changes.columns.indexOf(target.idColumn);
    if (idColIdx < 0) return [];
    const stmts: string[] = [];
    for (const [rowIdx, dirtyCols] of changes.dirtyRows) {
      const row = changes.rows[rowIdx];
      const id = row?.[idColIdx];
      if (id === null || id === undefined || String(id).trim() === "") continue;
      const updateDoc = buildMongoUpdateDocument(dirtyCols, changes.columns, tab.result?.mongo_documents?.[rowIdx]);
      if (Object.keys(updateDoc).length === 0) continue;
      stmts.push(`${mongoCollectionExpression(target.collection)}.updateOne({_id: ${formatMongoShellLiteral(mongoQueryResultDocumentId(rowIdx, id))}}, ${formatMongoShellLiteral(updateDoc)})`);
    }
    return stmts;
  };

  const applySavedChanges: NonNullable<CustomSaveHandler["applySavedChanges"]> = ({ dirtyRows, columns }) => {
    const documents = tab.result?.mongo_documents;
    if (!documents) return;

    // Replace the raw array only after every backend update succeeds, keeping
    // the grid and JSON preview atomic when a multi-row save partially fails.
    const replacements = new Map<unknown, unknown>();
    tab.result!.mongo_documents = documents.map((document, rowIdx) => {
      const changes = dirtyRows.get(rowIdx);
      if (!changes) return document;
      const updated = applyMongoGridChangesToDocument(document, changes, columns);
      replacements.set(document, updated);
      return updated;
    });
    if (tab.resultLocalSortOriginalMongoDocuments) {
      tab.resultLocalSortOriginalMongoDocuments = tab.resultLocalSortOriginalMongoDocuments.map((document) => replacements.get(document) ?? document);
    }
  };

  return { save, preview, applySavedChanges, canInsert: false, canDelete: false, supportsInsert: false, readonlyColumns: [target.idColumn], targetLabel: target.collection };
});
const resultsPaneOpen = ref(false);
const resultsPaneSize = ref(Number(safeLocalStorageGet("dbx-results-pane-size")) || DEFAULT_QUERY_RESULTS_PANE_SIZE);
const editorPaneSize = computed(() => (resultsPaneOpen.value ? 100 - resultsPaneSize.value : 100));
const queryRunningElapsed = ref(0);

function onResultsResized(payload: { panes: { size: number }[] }) {
  const resultsPane = payload.panes[1];
  if (resultsPane?.size != null && resultsPane.size >= 20 && resultsPane.size <= 85) {
    resultsPaneSize.value = resultsPane.size;
    safeLocalStorageSet("dbx-results-pane-size", String(resultsPane.size));
  }
}
let queryRunningElapsedFrame: number | undefined;

function stopQueryRunningElapsedTimer() {
  if (queryRunningElapsedFrame !== undefined) {
    window.cancelAnimationFrame(queryRunningElapsedFrame);
    queryRunningElapsedFrame = undefined;
  }
}

function updateQueryRunningElapsed() {
  const startedAt = props.activeTab.queryExecutionStartedAt;
  queryRunningElapsed.value = props.activeTab.isExecuting && startedAt ? Math.max(0, Date.now() - startedAt) : 0;
}

function startQueryRunningElapsedTimer() {
  stopQueryRunningElapsedTimer();
  updateQueryRunningElapsed();
  if (!props.activeTab.isExecuting || !props.activeTab.queryExecutionStartedAt) return;
  const updateOnNextFrame = () => {
    updateQueryRunningElapsed();
    if (props.activeTab.isExecuting && props.activeTab.queryExecutionStartedAt) {
      queryRunningElapsedFrame = window.requestAnimationFrame(updateOnNextFrame);
    }
  };
  queryRunningElapsedFrame = window.requestAnimationFrame(updateOnNextFrame);
}

const queryRunningElapsedSeconds = computed(() => formatElapsedSeconds(queryRunningElapsed.value));

watch(() => [props.activeTab.id, props.activeTab.isExecuting, props.activeTab.queryExecutionStartedAt] as const, startQueryRunningElapsedTimer, { immediate: true });

onUnmounted(() => {
  stopQueryRunningElapsedTimer();
  standaloneResultToolbarResizeObserver?.disconnect();
  window.removeEventListener("dbx-refresh-active-kv-browser", onRefreshActiveKvBrowser);
});

watch(
  hasQueryOutput,
  (hasOutput) => {
    resultsPaneOpen.value = hasOutput ? true : false;
  },
  { immediate: true },
);

watch(
  () => props.activeTab.id,
  () => {
    resultsPaneOpen.value = hasQueryOutput.value;
  },
);

watch(
  () => [props.activeTab.id, props.activeTab.result, props.activeTab.results, props.activeTab.isExecuting] as const,
  () => {
    if (props.activeTab.isExecuting) return;
    if (hasExecutionSummary.value && !hasTabularResult.value && props.activeOutputView === "result") {
      emit("update:activeOutputView", "summary");
    }
  },
  { immediate: true },
);

watch(
  () => [props.activeTab.isExecuting, props.activeTab.isExplaining],
  ([isExecuting, isExplaining]) => {
    if (isExecuting || isExplaining) resultsPaneOpen.value = true;
  },
);

watch(
  () => props.activeTab.result,
  (result) => {
    if (!result) return;
    if (!isDebugLoggingEnabled()) return;
    const startedAt = performance.now();
    appendDebugLog("info", "[DBX][ContentArea:result:observed]", {
      tabId: props.activeTab.id,
      rowCount: result.rows.length,
      columnCount: result.columns.length,
      backendMs: result.execution_time_ms,
      isExecuting: props.activeTab.isExecuting,
    });
    nextTick(() => {
      appendDebugLog("info", "[DBX][ContentArea:result:nextTick]", {
        tabId: props.activeTab.id,
        elapsed: `${Math.round(performance.now() - startedAt)}ms`,
        isExecuting: props.activeTab.isExecuting,
      });
      requestAnimationFrame(() => {
        appendDebugLog("info", "[DBX][ContentArea:result:first-frame]", {
          tabId: props.activeTab.id,
          elapsed: `${Math.round(performance.now() - startedAt)}ms`,
          isExecuting: props.activeTab.isExecuting,
        });
      });
    });
  },
);

watch(
  () => props.activeTab.isExecuting,
  (isExecuting, wasExecuting) => {
    if (!isExecuting && wasExecuting) {
      nextTick(() => {
        requestAnimationFrame(() => {
          queryEditorRef.value?.scrollCursorIntoView();
        });
      });
    }
  },
);

// Table toolbox handlers
function handleTableImport() {
  const tab = props.activeTab;
  if (!tab.tableMeta || !tab.connectionId) return;
  connectionStore.tableImportSource = {
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.tableMeta.schema,
    tableName: tab.tableMeta.tableName,
  };
}

function handleTableDataGenerate() {
  const tab = props.activeTab;
  if (!tab.tableMeta || !tab.connectionId) return;
  connectionStore.tableDataGenerateSource = {
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.tableMeta.schema,
    tableName: tab.tableMeta.tableName,
  };
}

// Column info panel handlers
async function onHandleClickColumn(matchedCols: Array<{ name: string; table: string; schema?: string }>, errorMsg?: string) {
  if (!props.activeTab.connectionId || !props.activeTab.database) return;

  // If error or no columns, silently ignore — don't show the panel
  if (errorMsg || matchedCols.length === 0) return;

  columnInfoLoading.value = true;
  columnInfoError.value = undefined;

  try {
    // Fetch full column details from API
    const apiModule = await import("@/lib/backend/api");
    const results: ColumnInfo[] = [];

    for (const matchedCol of matchedCols) {
      const querySchema = matchedCol.schema || props.activeTab.database || "";
      try {
        const fullColumns = await apiModule.getColumns(props.activeTab.connectionId, props.activeTab.database, querySchema, matchedCol.table);
        for (const col of fullColumns) {
          if (col.name === matchedCol.name) {
            results.push({
              name: col.name,
              table: matchedCol.table,
              dataType: col.data_type,
              isNullable: col.is_nullable,
              columnDefault: col.column_default,
              isPrimaryKey: col.is_primary_key,
              comment: col.comment,
              extra: col.extra,
            });
          }
        }
      } catch {
        // Skip tables that fail
      }
    }

    columnInfoColumns.value = results;
  } catch (e: any) {
    // Silently ignore errors
    console.error("[DBX] Failed to fetch column info:", e);
    return;
  } finally {
    columnInfoLoading.value = false;
    showColumnInfo.value = true;
  }
}

function closeColumnInfo() {
  showColumnInfo.value = false;
  columnInfoColumns.value = [];
  columnInfoError.value = undefined;
}

function onHandleClickTable(target: SqlObjectNavigationTarget) {
  emit("clickTable", target);
}

function onHandleViewTableData(target: SqlObjectNavigationTarget) {
  emit("viewTableData", target);
}

function onHandleViewTableDdl(target: SqlObjectNavigationTarget) {
  emit("viewTableDdl", target);
}

function onHandleEditTableStructure(target: SqlObjectNavigationTarget) {
  emit("editTableStructure", target);
}

function onHandleOpenObjectSource(target: SqlObjectNavigationTarget, initialEditing: boolean) {
  emit("openObjectSource", target, initialEditing);
}

function onHandleCloseColumnPanel() {
  showColumnInfo.value = false;
  columnInfoColumns.value = [];
  columnInfoError.value = undefined;
}

function focusSearch(): boolean {
  if (props.activeTab.mode === "mongo") return documentBrowserRef.value?.focusSearch() ?? false;
  if (props.activeTab.mode === "redis") return redisKeyBrowserRef.value?.focusSearch() ?? false;
  if (props.activeTab.mode === "etcd") return etcdKeyBrowserRef.value?.focusSearch() ?? false;
  if (props.activeTab.mode === "zookeeper") return zookeeperKeyBrowserRef.value?.focusSearch() ?? false;
  if (props.activeTab.mode === "objects") return objectBrowserRef.value?.focusSearch() ?? false;
  if (props.activeTab.mode === "query") return queryEditorRef.value?.openSearch() ?? false;
  return dataGridRef.value?.focusSearch() ?? false;
}

function refreshQueryEditorCompletionCache(): boolean {
  if (props.activeTab.mode !== "query" || !queryEditorRef.value) return false;
  queryEditorRef.value.refreshCompletionCache();
  return true;
}

function refreshData(): boolean {
  // Reuse ObjectBrowser's reload path so schema reloads and stale object-response guards stay intact.
  if (props.activeTab.mode === "objects") return objectBrowserRef.value?.refresh?.() ?? false;
  if (props.activeTab.mode === "etcd") return etcdKeyBrowserRef.value?.refresh?.() ?? false;
  if (props.activeTab.mode === "zookeeper") return zookeeperKeyBrowserRef.value?.refresh?.() ?? false;
  // Restored data tabs intentionally omit row data, so refresh must work before DataGrid mounts.
  if (canReloadUnavailableDataTab(props.activeTab)) {
    emit("reload");
    return true;
  }
  if (activeElasticsearchJsonResponse.value) {
    // Match DataGrid's toolbar refresh intent so multi-result runs are
    // refreshed as a group instead of replacing them with the active result.
    emit("reload", activeResultSql.value, undefined, undefined, undefined, undefined, undefined, "refresh");
    return true;
  }
  if (!dataGridRef.value) return false;
  void dataGridRef.value.onToolbarRefresh();
  return true;
}

function onRefreshActiveKvBrowser(event: Event) {
  const detail = (event as CustomEvent<{ mode?: string; connectionId?: string }>).detail;
  if (!detail || props.activeTab.mode !== detail.mode || props.activeTab.connectionId !== detail.connectionId) return;
  void nextTick(() => refreshData());
}

async function exportResultArchive() {
  if (resultArchiveExporting.value) return;
  resultArchiveExporting.value = true;
  try {
    const bytes = await queryStore.exportResultArchive(props.activeTab.id);
    if (!bytes) {
      toast(t("tabs.resultArchiveUnavailable"), 4000);
      return;
    }
    const saved = await saveQueryResultArchiveFile(defaultQueryResultArchiveFileName(props.activeTab.title), bytes);
    if (saved) toast(t("tabs.resultArchiveExported"), 2500);
  } catch (error: any) {
    toast(t("tabs.resultArchiveExportFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    resultArchiveExporting.value = false;
  }
}

async function removeResultRun(runId: string) {
  const removedActiveRun = props.activeTab.activeResultRunId === runId;
  const removed = await queryStore.removeResultRun(props.activeTab.id, runId);
  if (removed && removedActiveRun) emit("update:activeOutputView", "result");
}

async function selectResultRun(runId: string) {
  if (!(await queryStore.setActiveResultRun(props.activeTab.id, runId))) {
    toast(t("tabs.missingResultRun"), 4000);
    return;
  }
  emit("update:activeOutputView", "result");
}

function toggleResultAutoSave() {
  const enabled = queryStore.toggleResultAutoSave(props.activeTab.id);
  toast(t(enabled ? "tabs.autoKeepResultsEnabled" : "tabs.autoKeepResultsDisabled"), 2500);
}

function selectResultItem(item: (typeof visibleResultItems.value)[number]) {
  queryStore.setActiveResultIndex(props.activeTab.id, item.index);
  emit("update:activeOutputView", "result");
  nextTick(() => {
    queryEditorRef.value?.previewStatementRange(resultSourceRange(props.activeTab.sql, item.result, item.index, activeEffectiveDatabaseType.value) ?? null);
  });
}

function handleModRTarget(target: Element): boolean {
  if (target.closest("[data-query-editor-root]")) return queryEditorRef.value?.openReplace() ?? false;
  if (target.closest("[data-cell-detail-editor-root]")) return dataGridRef.value?.openCellDetailSearch() ?? false;
  if (target.closest("[data-grid-root], [data-elasticsearch-json-response-root]")) return refreshData();
  if (canReloadUnavailableDataTab(props.activeTab)) return refreshData();
  return false;
}

function requestQueryEditorExecute() {
  return queryEditorRef.value?.requestExecute();
}

function pasteClipboardAsSqlInCondition() {
  return queryEditorRef.value?.pasteClipboardAsSqlInCondition();
}

function applyTableStructureChanges() {
  return tableStructureEditorRef.value?.applyChanges() ?? Promise.resolve(false);
}

async function insertRedisCommand(command: string): Promise<boolean> {
  if (props.activeTab.mode !== "redis") return false;
  return (await redisKeyBrowserRef.value?.insertCommand?.(command)) ?? false;
}

async function executeRedisCommand(command: string): Promise<boolean> {
  if (props.activeTab.mode !== "redis") return false;
  return (await redisKeyBrowserRef.value?.executeCommand?.(command)) ?? false;
}

defineExpose({ focusSearch, refreshData, refreshQueryEditorCompletionCache, handleModRTarget, requestQueryEditorExecute, pasteClipboardAsSqlInCondition, applyTableStructureChanges, insertRedisCommand, executeRedisCommand });
</script>

<template>
  <div class="production-session-shell flex flex-col flex-1 min-h-0" :class="{ 'production-session-shell--active': activeProductionContext.active }">
    <div v-if="activeProductionContext.active" class="production-session-strip flex h-7 shrink-0 items-center gap-2 border-b border-red-500/35 bg-red-500/10 px-3 text-xs font-semibold text-red-800 shadow-[inset_0_1px_0_rgb(239_68_68_/_0.28)] dark:text-red-200">
      <ShieldAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span class="font-mono uppercase tracking-normal">{{ t("production.title") }}</span>
      <span v-if="productionSessionDetail" class="min-w-0 truncate rounded-md border border-red-500/25 bg-background/65 px-1.5 py-0.5 font-medium text-red-700 dark:text-red-200">{{ productionSessionDetail }}</span>
    </div>
    <!-- Query mode: editor + results -->
    <template v-if="activeTab.mode === 'query'">
      <Splitpanes horizontal class="query-output-splitpanes flex-1 min-h-0 overflow-hidden" @resized="onResultsResized">
        <Pane class="min-h-0" :size="editorPaneSize" :min-size="resultsPaneOpen ? 15 : 100">
          <div class="h-full flex flex-col relative">
            <div v-if="activeProductionContext.active" class="production-watermark pointer-events-none absolute inset-0 z-10 grid select-none" aria-hidden="true">
              <span v-for="index in 4" :key="index" class="production-watermark__label whitespace-nowrap font-mono text-6xl font-extrabold text-red-700/[0.12] dark:text-red-200/[0.1]">{{ productionWatermarkText }}</span>
            </div>
            <QueryEditor
              ref="queryEditorRef"
              class="relative z-0 flex-1"
              auto-focus
              :model-value="activeTab.sql"
              :connection-id="activeTab.connectionId"
              :database="activeTab.database"
              :schema="activeTab.schema"
              :client-session-id="activeTab.id"
              :completion-context-version="activeTab.completionContextVersion"
              :database-type="activeEffectiveDatabaseType"
              :dialect="editorDialect"
              :syntax-dialect="editorSyntaxDialect"
              :format-dialect="activeSqlFormatDialect"
              :format-request-id="formatSqlRequest?.tabId === activeTab.id ? formatSqlRequest.id : undefined"
              :compress-request-id="compressSqlRequest?.tabId === activeTab.id ? compressSqlRequest.id : undefined"
              :execution-error="activeQueryError"
              :execution-error-sql="activeTab.lastExecutedSql"
              :statement-execution-markers="activeStatementExecutionMarkers"
              :initial-viewport="activeTab.editorViewport"
              :initial-selection="activeTab.editorSelection"
              @update:model-value="emit('editorUpdate', activeTab.id, $event)"
              @selection-change="emit('editorSelectionChange', $event)"
              @send-selection-to-ai="emit('sendSelectionToAi', $event)"
              @cursor-change="emit('editorCursorChange', $event)"
              @viewport-change="emit('editorViewportChange', activeTab.id, $event)"
              @selection-state-change="emit('editorSelectionStateChange', activeTab.id, $event)"
              @format-error="emit('formatError')"
              @execute="emit('execute', $event)"
              @save="emit('saveSql')"
              @click-table="onHandleClickTable"
              @view-table-data="onHandleViewTableData"
              @edit-table-structure="onHandleEditTableStructure"
              @view-table-ddl="onHandleViewTableDdl"
              @open-object-source="onHandleOpenObjectSource"
              @click-column="onHandleClickColumn"
              @close-column-panel="onHandleCloseColumnPanel"
            />
            <ColumnInfoPanel v-if="showColumnInfo" :columns="columnInfoColumns" :loading="columnInfoLoading" :error="columnInfoError" @close="closeColumnInfo" />
            <Button v-if="hasQueryOutput && !resultsPaneOpen" variant="secondary" size="sm" class="absolute bottom-3 right-3 z-20 h-7 gap-1.5 rounded-full border bg-background/95 px-3 text-xs shadow-lg hover:bg-accent" @click="resultsPaneOpen = true">
              <ChevronUp class="h-3.5 w-3.5" />
              {{ t("editor.showResultsPane") }}
            </Button>
          </div>
        </Pane>
        <Pane v-if="resultsPaneOpen" class="min-h-0" :size="resultsPaneSize" :min-size="20">
          <div class="h-full flex flex-col">
            <div v-if="hasQueryOutput" class="flex h-10 shrink-0 items-center gap-1 border-b bg-muted/20 px-2">
              <Button
                v-if="activeTab.mode === 'query' && activeTab.result"
                variant="ghost"
                size="icon"
                class="h-6 w-7 shrink-0"
                :class="resultAutoSave ? 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
                :title="resultAutoSave ? t('tabs.autoKeepResultsEnabled') : t('tabs.autoKeepResults')"
                :aria-label="resultAutoSave ? t('tabs.autoKeepResultsEnabled') : t('tabs.autoKeepResults')"
                :aria-pressed="resultAutoSave"
                @click="toggleResultAutoSave"
              >
                <Pin class="h-3.5 w-3.5" :class="{ 'fill-current': resultAutoSave }" />
              </Button>
              <template v-if="showResultRunSelector">
                <span class="mx-1 h-4 w-px shrink-0 bg-border" />
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button variant="ghost" size="sm" class="h-6 shrink-0 gap-1 px-2 text-xs">
                      {{ activeResultRunItem ? t("tabs.runN", { n: activeResultRunItem.sequence }) : t("tabs.resultRuns") }}
                      <ChevronDown class="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" class="w-48">
                    <DropdownMenuItem v-for="run in resultRuns" :key="run.id" class="flex items-center gap-2 pr-1" @select="selectResultRun(run.id)">
                      <Check v-if="run.active" class="h-3.5 w-3.5 shrink-0" />
                      <span v-else class="h-3.5 w-3.5 shrink-0" />
                      <span class="min-w-0 flex-1 truncate">{{ t("tabs.runN", { n: run.sequence }) }}</span>
                      <button
                        type="button"
                        class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                        :title="t('tabs.removeRun', { n: run.sequence })"
                        :aria-label="t('tabs.removeRun', { n: run.sequence })"
                        @click.stop.prevent="removeResultRun(run.id)"
                      >
                        <X class="h-3 w-3" />
                      </button>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </template>
              <template v-if="visibleResultItems.length > 0">
                <span class="mx-1 h-4 w-px shrink-0 bg-border" />
                <div class="relative min-w-0 flex-1 self-stretch">
                  <div v-if="hasResultTabOverflow" class="result-tab-scrollbar" :class="{ 'result-tab-scrollbar--dragging': isResultTabsScrollbarDragging }" @pointerdown="startResultTabsScrollbarDrag">
                    <div class="result-tab-scrollbar__thumb" :style="resultTabsScrollbarThumbStyle" />
                  </div>
                  <div ref="resultTabsScrollerRef" class="result-tab-scroll flex h-full items-center gap-1 overflow-x-auto overflow-y-hidden px-1" :style="resultTabsScrollerStyle" @scroll="updateResultTabsScrollbar" @wheel="onResultTabsWheel">
                    <LightTooltip v-for="item in visibleResultItems" :key="item.index" :text="item.label || item.title || t('tabs.resultN', { n: item.n })" :disabled="!item.labelTruncated && !(!item.label && item.title)" :delay="150" :close-delay="0" nowrap>
                      <Button size="sm" :variant="activeOutputView === 'result' && (activeTab.activeResultIndex ?? 0) === item.index ? 'default' : 'ghost'" class="h-6 min-w-0 max-w-48 shrink-0 px-2 text-xs" :aria-label="item.label || t('tabs.resultN', { n: item.n })" @click="selectResultItem(item)">
                        <span class="block min-w-0 max-w-44 whitespace-nowrap">{{ item.displayLabel || item.label || t("tabs.resultN", { n: item.n }) }}</span>
                      </Button>
                    </LightTooltip>
                  </div>
                </div>
              </template>
              <div class="ml-auto flex shrink-0 items-center gap-1">
                <Popover v-if="activeOutputView === 'result' && activeTab.result && hasTabularResult && !activeElasticsearchJsonResponse">
                  <PopoverTrigger as-child>
                    <Button variant="ghost" size="icon" class="h-6 w-7 shrink-0 text-foreground hover:bg-accent" :title="t('grid.viewOptions')" :aria-label="t('grid.viewOptions')">
                      <Wrench class="h-4 w-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" class="w-max min-w-44 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-md border bg-popover p-0 text-popover-foreground shadow-xl" @click.stop @keydown.stop>
                    <div class="border-b bg-muted/40 px-3 py-2">
                      <div class="text-xs font-semibold">{{ t("grid.viewOptions") }}</div>
                    </div>
                    <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                      <div class="min-w-0 flex items-center gap-2 font-medium">
                        <SquareDashed class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span>{{ t("grid.renderMode") }}</span>
                      </div>
                      <LightTooltip :text="t('grid.renderModeHint')" side="left" :side-offset="6" :delay="0" :open-on-focus="false">
                        <div class="grid w-32 grid-cols-2 rounded-md border bg-muted/40 p-0.5">
                          <button
                            type="button"
                            class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                            :class="dataGridRenderMode === 'canvas' ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                            @click="setDataGridRenderMode('canvas')"
                          >
                            {{ t("grid.canvasRenderMode") }}
                          </button>
                          <button
                            type="button"
                            class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                            :class="dataGridRenderMode === 'dom' ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                            @click="setDataGridRenderMode('dom')"
                          >
                            {{ t("grid.domRenderMode") }}
                          </button>
                        </div>
                      </LightTooltip>
                    </div>
                    <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                      <div class="min-w-0 flex items-center gap-2 font-medium">
                        <Columns3Cog class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span>{{ t("grid.columnWidth") }}</span>
                      </div>
                      <div class="grid w-48 grid-cols-3 rounded-md border bg-muted/40 p-0.5">
                        <button
                          v-for="density in ['compact', 'standard', 'comfortable'] as const"
                          :key="density"
                          type="button"
                          class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-1.5 text-xs transition-colors"
                          :class="columnWidthDensity === density ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                          @click="setColumnWidthDensity(density)"
                        >
                          {{ t(`grid.columnWidth${density.charAt(0).toUpperCase()}${density.slice(1)}`) }}
                        </button>
                      </div>
                    </div>
                    <DataGridFontFamilyControl />
                    <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                      <div class="min-w-0 flex items-center gap-2 font-medium">
                        <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[11px] font-semibold text-muted-foreground">A</span>
                        <span>{{ t("grid.tableFontSize") }}</span>
                      </div>
                      <div class="flex h-6 w-32 items-center rounded-md border bg-muted/40 p-0.5">
                        <button
                          type="button"
                          class="flex h-5 w-8 items-center justify-center rounded-[5px] bg-background text-foreground shadow-sm transition-colors hover:text-foreground disabled:pointer-events-none disabled:bg-muted/40 disabled:text-muted-foreground disabled:opacity-50 disabled:shadow-none"
                          :disabled="tableFontSize <= TABLE_FONT_SIZE_MIN"
                          :aria-label="t('common.decrease')"
                          @click="decreaseTableFontSize"
                        >
                          <Minus class="h-3.5 w-3.5" />
                        </button>
                        <span class="flex-1 text-center text-xs font-semibold tabular-nums">{{ tableFontSize }}</span>
                        <button
                          type="button"
                          class="flex h-5 w-8 items-center justify-center rounded-[5px] bg-background text-foreground shadow-sm transition-colors hover:text-foreground disabled:pointer-events-none disabled:bg-muted/40 disabled:text-muted-foreground disabled:opacity-50 disabled:shadow-none"
                          :disabled="tableFontSize >= TABLE_FONT_SIZE_MAX"
                          :aria-label="t('common.increase')"
                          @click="increaseTableFontSize"
                        >
                          <Plus class="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                      <div class="min-w-0 flex items-center gap-2 font-medium">
                        <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span>{{ t("grid.searchMode") }}</span>
                      </div>
                      <LightTooltip :text="t('grid.searchModeHint')" side="left" :side-offset="6" :delay="0" :open-on-focus="false">
                        <div class="grid w-32 grid-cols-2 rounded-md border bg-muted/40 p-0.5">
                          <button
                            type="button"
                            class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                            :class="dataGridSearchMode === 'filter' ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                            @click="setDataGridSearchMode('filter')"
                          >
                            {{ t("grid.searchModeFilter") }}
                          </button>
                          <button
                            type="button"
                            class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                            :class="dataGridSearchMode === 'highlight' ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                            @click="setDataGridSearchMode('highlight')"
                          >
                            {{ t("grid.searchModeHighlight") }}
                          </button>
                        </div>
                      </LightTooltip>
                    </div>
                    <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                      <div class="min-w-0 flex items-center gap-2 font-medium">
                        <Rows3 class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span>{{ t("grid.transposeMultiRowToggle") }}</span>
                      </div>
                      <LightTooltip :text="t('grid.transposeMultiRowHint')" side="left" :side-offset="6" :delay="0" :open-on-focus="false">
                        <div class="grid w-32 grid-cols-2 rounded-md border bg-muted/40 p-0.5">
                          <button
                            type="button"
                            class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                            :class="!dataGridRef?.multiRowTranspose ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                            @click="dataGridRef?.setMultiRowTranspose(false)"
                          >
                            {{ t("grid.transposeSingleRow") }}
                          </button>
                          <button
                            type="button"
                            class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                            :class="dataGridRef?.multiRowTranspose ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                            @click="dataGridRef?.setMultiRowTranspose(true)"
                          >
                            {{ t("grid.transposeMultiRow") }}
                          </button>
                        </div>
                      </LightTooltip>
                    </div>
                    <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs" :class="{ 'opacity-60': !dataGridRef?.canToggleAllNullColumns }">
                      <span class="min-w-0 flex items-center gap-2 font-medium">
                        <EyeOff class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        {{ t("grid.hideNullColumns") }}
                        <span v-if="(dataGridRef?.allNullColumnCount ?? 0) > 0" class="text-muted-foreground tabular-nums"> ({{ dataGridRef?.allNullColumnCount }}) </span>
                      </span>
                      <Switch size="sm" :model-value="!!dataGridRef?.nullColumnsHidden" :disabled="!dataGridRef?.canToggleAllNullColumns" :aria-label="t('grid.hideNullColumns')" @update:model-value="dataGridRef?.toggleAllNullColumns()" />
                    </div>
                  </PopoverContent>
                </Popover>
                <LightTooltip :text="t('editor.hideResultsPane')" side="bottom" :delay="0" :close-delay="0" nowrap>
                  <Button variant="ghost" size="icon" class="h-6 w-7 shrink-0 text-muted-foreground hover:text-foreground" :title="t('editor.hideResultsPane')" :aria-label="t('editor.hideResultsPane')" @click="resultsPaneOpen = false">
                    <ChevronDown class="h-3.5 w-3.5" />
                  </Button>
                </LightTooltip>
              </div>
            </div>

            <!-- Keep this height in sync with the embedded result toolbar. -->
            <div v-if="hasQueryOutput && showStandaloneResultToolbar" ref="standaloneResultToolbarRef" class="flex h-8 shrink-0 items-center border-b bg-muted/20">
              <QueryResultViewSwitcher
                :active-view="activeOutputView"
                :can-show-result="canShowResultOutput"
                :can-show-summary="hasExecutionSummary"
                :can-show-chart="hasNumericData && !activeElasticsearchJsonResponse"
                :compact="standaloneResultToolbarCompact"
                @select-view="emit('update:activeOutputView', $event)"
              />
              <QueryResultToolbarActions
                class="ml-auto"
                :active-view="activeOutputView"
                :can-show-explain="canShowExplainOutput"
                :can-export-archive="canExportResultArchive"
                :archive-exporting="resultArchiveExporting"
                :compact="standaloneResultToolbarCompact"
                @select-explain="emit('update:activeOutputView', 'explain')"
                @export-archive="exportResultArchive"
              />
            </div>

            <ExplainPlanViewer
              v-if="activeOutputView === 'explain'"
              class="flex-1 min-h-0"
              :plan="activeTab.explainPlan"
              :error="activeTab.explainError"
              :loading="activeTab.isExplaining"
              :source-sql="activeTab.lastExplainedSql"
              :explain-sql="activeTab.explainSql"
              :table-result="activeTab.explainTableResult"
              :table-error="activeTab.explainTableError"
            />

            <QueryChart v-else-if="activeOutputView === 'chart' && activeTab.result && !activeElasticsearchJsonResponse" class="flex-1 min-h-0" :result="activeTab.result" />

            <div v-else-if="activeOutputView === 'summary'" class="flex-1 min-h-0 overflow-auto bg-background">
              <div v-if="activeTab.isExecuting" class="flex h-full items-center justify-center text-sm text-muted-foreground">
                <Loader2 class="mr-2 h-4 w-4 animate-spin" />
                {{ t("executionSummary.executing") }}
              </div>
              <div v-else-if="summaryItems.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">
                {{ t("executionSummary.empty") }}
              </div>
              <div v-else>
                <div class="overflow-hidden border-b">
                  <div class="grid grid-cols-[4rem_1fr_8rem_8rem_7rem] border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                    <div>{{ t("executionSummary.statement") }}</div>
                    <div>{{ t("executionSummary.type") }}</div>
                    <div class="text-right">{{ t("executionSummary.rows") }}</div>
                    <div class="text-right">{{ t("executionSummary.affected") }}</div>
                    <div class="text-right">{{ t("executionSummary.time") }}</div>
                  </div>
                  <div v-for="item in summaryItems" :key="item.index" class="grid grid-cols-[4rem_1fr_8rem_8rem_7rem] items-center border-b px-3 py-2 text-xs last:border-b-0">
                    <div class="font-mono text-muted-foreground">#{{ item.index + 1 }}</div>
                    <div class="flex min-w-0 items-center gap-2">
                      <span class="inline-flex h-5 items-center rounded-full border px-2 text-[10px]" :class="item.isError ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'">
                        {{ item.isError ? t("executionSummary.error") : t("executionSummary.success") }}
                      </span>
                      <span class="truncate">
                        {{ item.hasTabularResult ? t("executionSummary.returnedTable", { count: item.returnedColumns }) : t("executionSummary.noTable") }}
                      </span>
                    </div>
                    <div class="text-right tabular-nums">{{ item.returnedRows.toLocaleString() }}</div>
                    <div class="text-right tabular-nums">{{ item.affectedRows.toLocaleString() }}</div>
                    <div class="text-right tabular-nums">{{ item.executionTimeMs }}ms</div>
                  </div>
                </div>
              </div>
            </div>

            <template v-else>
              <ElasticsearchJsonResponsePanel v-if="activeElasticsearchJsonResponse" class="flex-1 min-h-0" :status="activeElasticsearchJsonResponse.status" :body="activeElasticsearchJsonResponse.body" />
              <DataGrid
                v-else-if="activeTab.result && hasTabularResult"
                ref="dataGridRef"
                :key="activeResultGridCacheKey"
                :cache-key="activeResultGridCacheKey"
                class="flex-1 min-h-0"
                :result="activeTab.result"
                :sort-column="activeTab.resultSortColumn"
                :sort-column-index="activeTab.resultSortColumnIndex"
                :sort-direction="activeTab.resultSortDirection"
                :sort-mode="activeTab.resultSortMode"
                :initial-order-by-input="activeTab.orderByInput"
                :sql="activeResultSql"
                :export-sql="activeResultExportSql"
                :loading="activeTab.isExecuting"
                :editable="!!activeTab.queryAnalysis || !!mongoQueryResultSaveHandler"
                :source-columns="activeTab.querySourceColumns"
                :custom-save-handler="mongoQueryResultSaveHandler"
                :query-editability-reason="activeTab.queryEditabilityReason"
                :allow-insert-rows="activeTab.queryAnalysis?.allowInsert !== false && activeTab.queryAnalysis?.allowInsertDelete !== false"
                :allow-delete-rows="activeTab.queryAnalysis?.allowInsertDelete !== false"
                context="results"
                :auto-transpose-single-row="settingsStore.editorSettings.dataGridAutoTransposeSingleRow"
                :database-type="activeEffectiveDatabaseType"
                :connection-id="activeTab.connectionId"
                :database="activeTab.database"
                :schema="activeTab.schema"
                :table-meta="activeTab.tableMeta"
                :table-info-tab="activeTab.tableInfoTab"
                :page-offset="activeTab.resultPageOffset"
                :page-limit="activeTab.resultPageLimit"
                :count-sql="activeTab.resultCountSql"
                :total-row-count="activeTab.resultTotalRowCount"
                :total-row-count-loading="activeTab.resultTotalRowCountLoading"
                :on-execute-sql="async (sql: string) => emit('executeSql', sql)"
                :full-export-result="(onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void) => queryStore.fetchTabResultForExport(activeTab.id, onProgress)"
                :query-result-export-request="(options: { exportId: string; filePath: string; format: 'csv' | 'xlsx' | 'txt'; includeSqlSheet?: boolean }) => queryStore.buildQueryResultExportRequest(activeTab.id, options)"
                :all-export-results="allResultExportSheets"
                :export-file-base-name="activeTab.title"
                @update:order-by-input="(v: string) => (activeTab.orderByInput = v)"
                @reload="(sql?: string, searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number, intent?: DataGridReloadIntent) => emit('reload', sql, searchText, whereInput, orderBy, limit, offset, intent)"
                @paginate="(offset: number, limit: number, whereInput?: string, orderBy?: string) => emit('paginate', offset, limit, whereInput, orderBy)"
                @sort="(column: string, columnIndex: number, direction: 'asc' | 'desc' | null, whereInput?: string, mode?: DataGridSortMode) => emit('sort', column, columnIndex, direction, whereInput, mode)"
              >
                <template #result-toolbar-leading="{ compact }">
                  <QueryResultViewSwitcher :active-view="activeOutputView" :can-show-result="canShowResultOutput" :can-show-summary="hasExecutionSummary" :can-show-chart="hasNumericData && !activeElasticsearchJsonResponse" :compact="compact" @select-view="emit('update:activeOutputView', $event)" />
                </template>
                <template #result-toolbar-actions="{ compact }">
                  <QueryResultToolbarActions
                    :active-view="activeOutputView"
                    :can-show-explain="canShowExplainOutput"
                    :can-export-archive="canExportResultArchive"
                    :archive-exporting="resultArchiveExporting"
                    :compact="compact"
                    @select-explain="emit('update:activeOutputView', 'explain')"
                    @export-archive="exportResultArchive"
                  />
                </template>
                <template v-if="activeTab.result?.columns.includes('Error')" #error-actions="{ errorMessage }">
                  <QueryErrorActions :error-message="String(errorMessage)" :connection-id="activeTab.connectionId" @change-query-timeout="activeTab.connectionId && emit('openConnectionSettings', activeTab.connectionId, 'advanced')" @fix-with-ai="(message) => emit('fixWithAi', message)" />
                </template>
              </DataGrid>
              <QueryLoadingState
                v-else-if="!activeTab.result && activeTab.isExecuting"
                class="flex-1 min-h-0"
                :label-key="queryExecutionLabelKey(activeTab)"
                :elapsed-seconds="queryRunningElapsedSeconds"
                show-cancel
                :cancel-disabled="!canCancelQueryExecution(activeTab)"
                :cancelling="activeTab.isCancelling"
                @cancel="emit('cancel')"
              />
              <div v-else-if="activeTab.resultEvicted && activeTab.resultCacheState === 'missing'" class="flex flex-1 min-h-0 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                <div>{{ t("editor.cachedResultUnavailable") }}</div>
                <Button v-if="(activeTab.lastExecutedSql ?? activeTab.sql)?.trim()" variant="secondary" size="sm" @click="queryStore.reloadEvictedTab(activeTab.id, { reexecuteOnMissing: true })">
                  {{ t("editor.reexecuteQuery") }}
                </Button>
              </div>
              <div v-else-if="!activeTab.result" class="flex-1 min-h-0 flex flex-col items-center justify-center gap-1 text-muted-foreground text-sm">
                <div>{{ t("editor.pressToExecute", { mod: shortcutModifier }) }}</div>
                <div>{{ t("editor.pressToSaveSql", { mod: shortcutModifier }) }}</div>
              </div>
            </template>
          </div>
        </Pane>
      </Splitpanes>
    </template>

    <!-- Data mode: full-height grid -->
    <template v-else-if="activeTab.mode === 'data'">
      <div class="flex-1 min-h-0 flex flex-col">
        <div class="h-9 shrink-0 border-b bg-background/80 px-3 flex items-center gap-2 text-xs">
          <span v-if="activeConnection?.name?.trim()" data-data-header-connection class="inline-flex max-w-48 min-w-0 items-center truncate rounded border border-border bg-muted/30 px-2 py-0.5 text-muted-foreground" :title="activeConnection.name">
            {{ activeConnection.name }}
          </span>
          <span class="inline-flex max-w-48 min-w-0 items-center truncate rounded border border-border bg-muted/50 px-2 py-0.5 font-medium">
            {{ activeTab.tableMeta?.tableName || activeTab.title }}
          </span>
          <span class="inline-flex max-w-56 min-w-0 items-center truncate rounded border border-border bg-muted/30 px-2 py-0.5 text-muted-foreground">
            <template v-if="activeTab.tableMeta?.schema">{{ activeTab.tableMeta.schema }}@</template>{{ databaseDisplayNameForTab(activeTab.connectionId, activeTab.database, t) }}
          </span>
          <span v-if="activeTab.mode === 'data' && activeTab.tableMeta" class="inline-flex shrink-0 items-center rounded border border-border bg-muted/30 px-2 py-0.5 font-medium text-muted-foreground tabular-nums"> {{ activeTab.tableMeta.columns.length }} {{ t("tree.columns") }} </span>
          <span class="ml-auto" />
          <Popover v-if="activeTab.result?.columns.length">
            <PopoverTrigger as-child>
              <Button variant="ghost" size="sm" class="h-5 text-xs px-1.5 shrink-0" :class="{ 'bg-accent text-foreground': (dataGridRef?.hiddenColumnCount ?? 0) > 0 }">
                <Columns3 class="h-3.5 w-3.5" />
                {{ t("grid.columnVisibility") }}
                <span v-if="(dataGridRef?.hiddenColumnCount ?? 0) > 0" class="tabular-nums"> {{ dataGridRef?.visibleColumnCount }}/{{ dataGridRef?.displayableColumnCount }} </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" class="w-64 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-md border bg-popover p-0 text-popover-foreground shadow-xl" @click.stop @keydown.stop>
              <div class="border-b bg-muted/40 px-2 py-1.5">
                <div class="flex items-center justify-between gap-2">
                  <div class="text-xs font-semibold">{{ t("grid.columnVisibility") }}</div>
                  <div class="text-[10px] text-muted-foreground tabular-nums">{{ dataGridRef?.visibleColumnCount ?? 0 }}/{{ dataGridRef?.displayableColumnCount ?? 0 }}</div>
                </div>
              </div>
              <div class="flex items-center gap-1.5 border-b px-2 py-1.5">
                <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input v-model="columnVisibilitySearch" autocapitalize="off" autocorrect="off" spellcheck="false" class="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" :placeholder="t('grid.searchColumns')" />
              </div>
              <div class="max-h-72 overflow-auto py-0.5">
                <button v-for="option in columnVisibilityOptions" :key="`${option.index}:${option.column}`" type="button" class="grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-center px-2 py-1 text-left text-xs hover:bg-accent" @click="dataGridRef?.toggleColumnVisibility(option.index)">
                  <span class="flex h-4 w-4 items-center justify-center rounded border" :class="dataGridRef?.isColumnVisible(option.index) ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-transparent'">
                    <Check class="h-3 w-3 stroke-[3]" />
                  </span>
                  <span class="min-w-0">
                    <span class="block truncate font-mono text-xs" :title="option.column">{{ option.column }}</span>
                    <span v-if="option.comment" class="block truncate text-[11px] leading-4 text-muted-foreground" :title="option.comment">{{ option.comment }}</span>
                  </span>
                </button>
                <div v-if="columnVisibilityOptions.length === 0" class="px-2 py-6 text-center text-xs text-muted-foreground">
                  {{ t("grid.noSearchResults") }}
                </div>
              </div>
              <div class="flex flex-col gap-1 border-t bg-muted/30 px-2 py-1.5">
                <span class="text-[11px] leading-4 text-muted-foreground">{{ t("grid.columnVisibilityHint") }}</span>
                <div class="flex items-center justify-end gap-1">
                  <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="(dataGridRef?.displayableColumnCount ?? 0) <= 1" @click="dataGridRef?.invertColumnVisibility()">
                    {{ t("grid.invertColumnVisibility") }}
                  </Button>
                  <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="!dataGridRef?.hasCustomColumnOrder" @click="dataGridRef?.resetColumnOrder()">
                    {{ t("grid.resetColumnOrder") }}
                  </Button>
                  <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="(dataGridRef?.hiddenColumnCount ?? 0) === 0" @click="dataGridRef?.showAllColumns()">
                    {{ t("grid.showAllColumns") }}
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <Button v-if="activeTab.result && activeTab.tableMeta && activeTab.connectionId" variant="ghost" size="sm" class="h-5 text-xs px-1.5 shrink-0" :class="{ 'bg-accent': dataGridRef?.showDdl }" @click="dataGridRef?.toggleDdl()"
            ><TableProperties class="h-3.5 w-3.5" />{{ t("grid.tableInfo") }}</Button
          >
          <DropdownMenu v-if="activeTab.result && activeTab.tableMeta && activeTab.connectionId">
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="sm" class="h-5 text-xs px-1.5 shrink-0" :title="t('tableToolbox.title')"><Toolbox class="h-3.5 w-3.5" />{{ t("tableToolbox.title") }}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-max min-w-44 gap-0 overflow-hidden rounded-md border bg-popover p-0 text-popover-foreground shadow-xl">
              <div class="border-b bg-muted/40 px-3 py-2">
                <div class="text-xs font-semibold">{{ t("tableToolbox.title") }}</div>
              </div>
              <div class="p-1">
                <DropdownMenuItem class="gap-2" @click="handleTableDataGenerate">
                  <Database class="h-4 w-4" />
                  {{ t("tableToolbox.generateData") }}
                </DropdownMenuItem>
                <DropdownMenuItem class="gap-2" @click="handleTableImport">
                  <Download class="h-4 w-4" />
                  {{ t("tableToolbox.importData") }}
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger class="gap-2">
                    <Upload class="h-4 w-4" />
                    {{ t("tableToolbox.exportData") }}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuPortal>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem @click="dataGridRef?.exportCsv()"> CSV </DropdownMenuItem>
                      <DropdownMenuItem @click="dataGridRef?.exportJson()"> JSON </DropdownMenuItem>
                      <DropdownMenuItem @click="dataGridRef?.exportSql()"> SQL INSERT </DropdownMenuItem>
                      <DropdownMenuItem @click="dataGridRef?.exportXlsx()"> XLSX </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuPortal>
                </DropdownMenuSub>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover v-if="activeTab.result?.columns.length">
            <PopoverTrigger as-child>
              <Button variant="ghost" size="icon" class="h-6 w-7 shrink-0 text-foreground hover:bg-accent" :title="t('grid.viewOptions')" :aria-label="t('grid.viewOptions')">
                <Wrench class="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" class="w-max min-w-44 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-md border bg-popover p-0 text-popover-foreground shadow-xl" @click.stop @keydown.stop>
              <div class="border-b bg-muted/40 px-3 py-2">
                <div class="text-xs font-semibold">{{ t("grid.viewOptions") }}</div>
              </div>
              <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <div class="min-w-0 flex items-center gap-2 font-medium">
                  <SquareDashed class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span>{{ t("grid.renderMode") }}</span>
                </div>
                <LightTooltip :text="t('grid.renderModeHint')" side="left" :side-offset="6" :delay="0" :open-on-focus="false">
                  <div class="grid w-32 grid-cols-2 rounded-md border bg-muted/40 p-0.5">
                    <button
                      type="button"
                      class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                      :class="dataGridRenderMode === 'canvas' ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                      @click="setDataGridRenderMode('canvas')"
                    >
                      {{ t("grid.canvasRenderMode") }}
                    </button>
                    <button
                      type="button"
                      class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                      :class="dataGridRenderMode === 'dom' ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                      @click="setDataGridRenderMode('dom')"
                    >
                      {{ t("grid.domRenderMode") }}
                    </button>
                  </div>
                </LightTooltip>
              </div>
              <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <div class="min-w-0 flex items-center gap-2 font-medium">
                  <Columns3Cog class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span>{{ t("grid.columnWidth") }}</span>
                </div>
                <div class="grid w-48 grid-cols-3 rounded-md border bg-muted/40 p-0.5">
                  <button
                    v-for="density in ['compact', 'standard', 'comfortable'] as const"
                    :key="density"
                    type="button"
                    class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-1.5 text-xs transition-colors"
                    :class="columnWidthDensity === density ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                    @click="setColumnWidthDensity(density)"
                  >
                    {{ t(`grid.columnWidth${density.charAt(0).toUpperCase()}${density.slice(1)}`) }}
                  </button>
                </div>
              </div>
              <DataGridFontFamilyControl />
              <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <div class="min-w-0 flex items-center gap-2 font-medium">
                  <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[11px] font-semibold text-muted-foreground">A</span>
                  <span>{{ t("grid.tableFontSize") }}</span>
                </div>
                <div class="flex h-6 w-32 items-center rounded-md border bg-muted/40 p-0.5">
                  <button
                    type="button"
                    class="flex h-5 w-8 items-center justify-center rounded-[5px] bg-background text-foreground shadow-sm transition-colors hover:text-foreground disabled:pointer-events-none disabled:bg-muted/40 disabled:text-muted-foreground disabled:opacity-50 disabled:shadow-none"
                    :disabled="tableFontSize <= TABLE_FONT_SIZE_MIN"
                    :aria-label="t('common.decrease')"
                    @click="decreaseTableFontSize"
                  >
                    <Minus class="h-3.5 w-3.5" />
                  </button>
                  <span class="flex-1 text-center text-xs font-semibold tabular-nums">{{ tableFontSize }}</span>
                  <button
                    type="button"
                    class="flex h-5 w-8 items-center justify-center rounded-[5px] bg-background text-foreground shadow-sm transition-colors hover:text-foreground disabled:pointer-events-none disabled:bg-muted/40 disabled:text-muted-foreground disabled:opacity-50 disabled:shadow-none"
                    :disabled="tableFontSize >= TABLE_FONT_SIZE_MAX"
                    :aria-label="t('common.increase')"
                    @click="increaseTableFontSize"
                  >
                    <Plus class="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <div class="min-w-0 flex items-center gap-2 font-medium">
                  <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span>{{ t("grid.searchMode") }}</span>
                </div>
                <LightTooltip :text="t('grid.searchModeHint')" side="left" :side-offset="6" :delay="0" :open-on-focus="false">
                  <div class="grid w-32 grid-cols-2 rounded-md border bg-muted/40 p-0.5">
                    <button
                      type="button"
                      class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                      :class="dataGridSearchMode === 'filter' ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                      @click="setDataGridSearchMode('filter')"
                    >
                      {{ t("grid.searchModeFilter") }}
                    </button>
                    <button
                      type="button"
                      class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                      :class="dataGridSearchMode === 'highlight' ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                      @click="setDataGridSearchMode('highlight')"
                    >
                      {{ t("grid.searchModeHighlight") }}
                    </button>
                  </div>
                </LightTooltip>
              </div>
              <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <div class="min-w-0 flex items-center gap-2 font-medium">
                  <Rows3 class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span>{{ t("grid.transposeMultiRowToggle") }}</span>
                </div>
                <LightTooltip :text="t('grid.transposeMultiRowHint')" side="left" :side-offset="6" :delay="0" :open-on-focus="false">
                  <div class="grid w-32 grid-cols-2 rounded-md border bg-muted/40 p-0.5">
                    <button
                      type="button"
                      class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                      :class="!dataGridRef?.multiRowTranspose ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                      @click="dataGridRef?.setMultiRowTranspose(false)"
                    >
                      {{ t("grid.transposeSingleRow") }}
                    </button>
                    <button
                      type="button"
                      class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                      :class="dataGridRef?.multiRowTranspose ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                      @click="dataGridRef?.setMultiRowTranspose(true)"
                    >
                      {{ t("grid.transposeMultiRow") }}
                    </button>
                  </div>
                </LightTooltip>
              </div>
              <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs" :class="{ 'opacity-60': !dataGridRef?.canToggleAllNullColumns }">
                <span class="min-w-0 flex items-center gap-2 font-medium">
                  <EyeOff class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {{ t("grid.hideNullColumns") }}
                  <span v-if="(dataGridRef?.allNullColumnCount ?? 0) > 0" class="text-muted-foreground tabular-nums"> ({{ dataGridRef?.allNullColumnCount }}) </span>
                </span>
                <Switch size="sm" :model-value="!!dataGridRef?.nullColumnsHidden" :disabled="!dataGridRef?.canToggleAllNullColumns" :aria-label="t('grid.hideNullColumns')" @update:model-value="dataGridRef?.toggleAllNullColumns()" />
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <DataGrid
          v-if="activeTab.result"
          ref="dataGridRef"
          class="flex-1 min-h-0"
          :key="activeTab.id"
          :cache-key="activeTab.id"
          :result="activeTab.result"
          :sort-column="activeTab.resultSortColumn"
          :sort-column-index="activeTab.resultSortColumnIndex"
          :sort-direction="activeTab.resultSortDirection"
          :sort-mode="activeTab.resultSortMode"
          :initial-order-by-input="activeTab.orderByInput"
          :sql="activeTab.sql"
          :loading="activeTab.isExecuting"
          :editable="!activeTab.tableMetaPending && isTableDataEditable(activeEffectiveDatabaseType, activeTableMeta?.primaryKeys ?? [], activeTableMeta?.tableType)"
          context="table-data"
          :initial-where-input="activeTab.whereInput"
          :database-type="activeEffectiveDatabaseType"
          :connection-id="activeTab.connectionId"
          :database="activeTab.database"
          :execution-database="activeDataTabExecutionDatabase"
          :table-meta="activeDataTabTableMeta"
          :table-info-tab="activeTab.tableInfoTab"
          :page-offset="activeTab.resultPageOffset"
          :page-limit="activeTab.resultPageLimit"
          :total-row-count="activeTab.resultTotalRowCount"
          :total-row-count-loading="activeTab.resultTotalRowCountLoading"
          :on-execute-sql="async (sql: string) => emit('executeSql', sql)"
          :full-export-result="(onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void) => queryStore.fetchTabResultForExport(activeTab.id, onProgress)"
          :export-file-base-name="activeTab.title"
          @update:where-input="(v: string) => (activeTab.whereInput = v)"
          @update:order-by-input="(v: string) => (activeTab.orderByInput = v)"
          @reload="(sql?: string, searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number, intent?: DataGridReloadIntent) => emit('reload', sql, searchText, whereInput, orderBy, limit, offset, intent)"
          @paginate="(offset: number, limit: number, whereInput?: string, orderBy?: string) => emit('paginate', offset, limit, whereInput, orderBy)"
          @sort="(column: string, columnIndex: number, direction: 'asc' | 'desc' | null, whereInput?: string, mode?: DataGridSortMode) => emit('sort', column, columnIndex, direction, whereInput, mode)"
        >
          <template v-if="activeTab.result?.columns.includes('Error')" #error-actions="{ errorMessage }">
            <QueryErrorActions :error-message="String(errorMessage)" :connection-id="activeTab.connectionId" @change-query-timeout="activeTab.connectionId && emit('openConnectionSettings', activeTab.connectionId, 'advanced')" @fix-with-ai="(message) => emit('fixWithAi', message)" />
          </template>
        </DataGrid>
        <QueryLoadingState v-else-if="activeTab.isExecuting" class="h-full" :label-key="queryExecutionLabelKey(activeTab)" :elapsed-seconds="queryRunningElapsedSeconds" show-cancel :cancel-disabled="!canCancelQueryExecution(activeTab)" :cancelling="activeTab.isCancelling" @cancel="emit('cancel')" />
        <div v-else class="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
          <Inbox class="h-8 w-8 opacity-60" />
          <div>{{ t("grid.dataUnavailable") }}</div>
          <div class="text-xs text-muted-foreground/70 inline-flex items-center gap-1">
            <span>{{ t("grid.dataUnavailableHintPrefix") }}</span>
            <kbd v-for="key in modRKeys" :key="key" class="min-w-5 rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 text-center font-mono text-[12px] leading-none text-muted-foreground shadow-xs">{{ key }}</kbd>
            <span>{{ t("grid.dataUnavailableHintSuffix") }}</span>
          </div>
          <Button variant="outline" size="sm" class="h-7 gap-1.5" @click="emit('reload')">
            <RefreshCcw class="h-3.5 w-3.5" />
            {{ t("grid.refresh") }}
          </Button>
        </div>
      </div>
    </template>

    <!-- Redis mode: key browser -->
    <template v-else-if="activeTab.mode === 'redis'">
      <div class="flex-1 min-h-0">
        <RedisKeyBrowser ref="redisKeyBrowserRef" :key="activeTab.id" :connection-id="activeTab.connectionId" :db="Number(activeTab.database)" :block-dangerous-redis-commands="props.blockDangerousRedisCommands" />
      </div>
    </template>

    <!-- Redis Dashboard: instance info -->
    <template v-else-if="activeTab.mode === 'redis-dashboard'">
      <div class="flex-1 min-h-0">
        <RedisDashboard :key="activeTab.id" :connection-id="activeTab.connectionId" />
      </div>
    </template>

    <!-- etcd mode: key browser -->
    <template v-else-if="activeTab.mode === 'etcd'">
      <div class="flex-1 min-h-0">
        <EtcdKeyBrowser ref="etcdKeyBrowserRef" :key="activeTab.id" :connection-id="activeTab.connectionId" />
      </div>
    </template>

    <!-- ZooKeeper mode: znode browser -->
    <template v-else-if="activeTab.mode === 'zookeeper'">
      <div class="flex-1 min-h-0">
        <ZooKeeperKeyBrowser ref="zookeeperKeyBrowserRef" :key="activeTab.id" :connection-id="activeTab.connectionId" />
      </div>
    </template>

    <!-- Document mode: MongoDB collections and Elasticsearch indices -->
    <template v-else-if="activeTab.mode === 'mongo'">
      <div class="flex-1 min-h-0">
        <DocumentBrowser ref="documentBrowserRef" :key="activeTab.id" :connection-id="activeTab.connectionId" :database="activeTab.database" :collection="activeTab.sql" :database-type="activeEffectiveDatabaseType" />
      </div>
    </template>

    <template v-else-if="activeTab.mode === 'mongo-gridfs'">
      <div class="flex-1 min-h-0">
        <MongoGridFsBrowser :key="activeTab.id" :connection-id="activeTab.connectionId" :database="activeTab.database" />
      </div>
    </template>

    <template v-else-if="activeTab.mode === 'mongo-bucket'">
      <div class="flex-1 min-h-0">
        <MongoBucketBrowser :key="activeTab.id" :connection-id="activeTab.connectionId" :database="activeTab.database" :bucket="activeTab.mongoBucket?.bucketName || activeTab.sql" />
      </div>
    </template>

    <!-- Vector mode: Qdrant and Milvus collections -->
    <template v-else-if="activeTab.mode === 'vector'">
      <div class="flex-1 min-h-0">
        <VectorBrowser :key="activeTab.id" :connection-id="activeTab.connectionId" :database="activeTab.database" :collection="activeTab.sql" :collection-label="activeTab.title" :database-type="activeEffectiveDatabaseType" :dimension="activeTabDimension" />
      </div>
    </template>

    <template v-else-if="activeTab.mode === 'mq'">
      <div class="flex-1 min-h-0">
        <MqAdminConsole :key="activeTab.id" :connection-id="activeTab.connectionId" :initial-tenant="activeTab.mqTenant" :initial-tab="activeTab.mqInitialTab" :read-only="activeConnection?.read_only ?? false" />
      </div>
    </template>

    <template v-else-if="activeTab.mode === 'nacos'">
      <div class="flex-1 min-h-0">
        <NacosAdminConsole :key="activeTab.id" :connection-id="activeTab.connectionId" :namespace="activeTab.nacosNamespace" :namespace-name="activeTab.nacosNamespaceName" :read-only="activeConnection?.read_only ?? false" />
      </div>
    </template>

    <!-- Objects mode: virtualized database object browser -->
    <template v-else-if="activeTab.mode === 'objects' && activeConnection">
      <div class="min-w-0 flex-1 min-h-0">
        <ObjectBrowser
          ref="objectBrowserRef"
          :key="`${activeTab.id}-${activeTab.objectBrowser?.schema || ''}`"
          :connection="activeConnection"
          :database="activeTab.database"
          :catalog="activeTab.objectBrowser?.catalog"
          :schema="activeTab.objectBrowser?.schema"
          :viewport="activeTab.objectBrowser?.viewport"
          @open-table="emit('openObjectTable', $event)"
          @schema-change="emit('objectSchemaChange', $event)"
          @viewport-change="emit('objectBrowserViewportChange', activeTab.id, $event)"
        />
      </div>
    </template>

    <!-- Structure mode: table structure editor -->
    <template v-else-if="activeTab.mode === 'structure'">
      <TableStructureEditor
        ref="tableStructureEditorRef"
        :key="activeTab.id"
        :connection-id="activeTab.connectionId"
        :database="activeTab.database"
        :catalog="activeTab.catalog"
        :schema="activeTab.schema"
        :table-name="activeTab.structureTableName || ''"
        :initial-tab="activeTab.structureInitialTab"
        :initial-tab-request-id="activeTab.structureInitialTabRequestId"
        :initial-target="activeTab.structureInitialTarget"
        :draft="activeTab.structureDraft"
        @update:draft="(draft) => (activeTab.structureDraft = draft)"
        @saved="(commentChanged) => emit('structureEditorSaved', commentChanged)"
        @close="emit('structureEditorClose')"
        @open-settings="(initialTab, initialSection) => emit('openSettings', initialTab, initialSection)"
      />
    </template>

    <template v-else-if="activeTab.mode === 'users' && activeConnection">
      <DatabaseUserAdmin :key="activeTab.id" :connection="activeConnection" />
    </template>

    <template v-else-if="activeTab.mode === 'processlist' && activeConnection">
      <ProcessListPanel :key="activeTab.id" :connection="activeConnection" />
    </template>

    <template v-else-if="activeTab.mode === 'mysql-dashboard'">
      <div class="min-h-0 flex-1">
        <MySqlDashboard :key="activeTab.id" :connection-id="activeTab.connectionId" />
      </div>
    </template>

    <template v-else-if="activeTab.mode === 'postgres-dashboard'">
      <div class="min-h-0 flex-1">
        <PostgresDashboard :key="activeTab.id" :connection-id="activeTab.connectionId" />
      </div>
    </template>

    <template v-else-if="activeTab.mode === 'dameng-jobs' && activeConnection">
      <DamengJobAdmin :key="activeTab.id" :connection="activeConnection" />
    </template>
  </div>
</template>

<style scoped>
.query-output-splitpanes {
  isolation: isolate;
}

.production-session-shell--active {
  box-shadow: inset 3px 0 0 color-mix(in oklch, var(--destructive) 78%, transparent);
}

.production-session-strip {
  background-image: linear-gradient(90deg, color-mix(in oklch, var(--destructive) 14%, transparent), color-mix(in oklch, var(--destructive) 7%, transparent));
}

.query-output-splitpanes :deep(> .splitpanes__splitter) {
  z-index: 1;
  flex: 0 0 3px;
}

.production-watermark {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 3rem;
  overflow: hidden;
  padding: 3rem 2.5rem;
}

.production-watermark__label {
  align-self: center;
  justify-self: center;
  transform: rotate(-22deg);
}

@media (max-width: 700px) {
  .production-watermark {
    grid-template-columns: 1fr;
    gap: 1.5rem;
    padding-inline: 1rem;
  }
}

.result-tab-scroll::-webkit-scrollbar {
  display: none;
}

.result-tab-scrollbar {
  position: absolute;
  inset-inline: 0.5rem;
  bottom: 2px;
  z-index: 20;
  height: 8px;
  cursor: pointer;
  touch-action: none;
}

.result-tab-scrollbar::before {
  content: "";
  position: absolute;
  inset-inline: 0;
  top: 3px;
  height: 2px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--foreground) 10%, transparent);
}

.result-tab-scrollbar__thumb {
  position: absolute;
  top: 2px;
  height: 4px;
  min-width: 20px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--foreground) 38%, transparent);
  transition:
    height 120ms ease,
    background-color 120ms ease,
    top 120ms ease;
}

.result-tab-scrollbar:hover .result-tab-scrollbar__thumb,
.result-tab-scrollbar--dragging .result-tab-scrollbar__thumb {
  top: 1px;
  height: 6px;
  background: color-mix(in oklch, var(--foreground) 58%, transparent);
}
</style>
