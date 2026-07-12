<script lang="ts">
type CachedStructuredFilterRule = {
  id: string;
  columnName: string;
  mode: "equals" | "not-equals" | "is-null" | "is-not-null" | "like" | "not-like" | "less-than" | "greater-than";
  rawValue: string;
  conjunction: "AND" | "OR";
  disabled?: boolean;
};
type StructuredFilterCacheState = {
  scopeKey: string;
  manualWhereInput: string;
  rules: CachedStructuredFilterRule[];
  appliedWhereInput: string;
};
const structuredFilterStateCache = new Map<string, StructuredFilterCacheState>();
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, onActivated, onDeactivated, ref, shallowRef, useSlots, watch, defineAsyncComponent, type Component, type CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import {
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Upload,
  Plus,
  Trash2,
  Save,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  Inbox,
  SearchX,
  Code2,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  X,
  Undo2,
  WrapText,
  Info,
  Rows3,
  RefreshCcw,
  RotateCcw,
  Pencil,
  Filter,
  SquareDashed,
  Check,
  CopyPlus,
  KeyRound,
  Link2,
  ListTree,
  Maximize2,
  PanelBottom,
  PanelRight,
  TableProperties,
  Database,
  Columns3,
  Columns3Cog,
  Timer,
} from "@lucide/vue";
import { Button } from "@/components/ui/button";
import QueryLoadingState from "@/components/common/QueryLoadingState.vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import LightDropdownMenu from "@/components/ui/LightDropdownMenu.vue";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ImagePreviewDialog from "@/components/grid/ImagePreviewDialog.vue";
import TemporalCellEditor from "@/components/grid/TemporalCellEditor.vue";
import EnumCellEditor from "@/components/grid/EnumCellEditor.vue";
import type { QueryResult, ColumnInfo, DatabaseType, ForeignKeyInfo, IndexInfo, TriggerInfo, TableInfoTab } from "@/types/database";
import * as api from "@/lib/backend/api";
import { formatElapsedSeconds } from "@/lib/common/elapsedTime";
import { dataGridCellDisplayText, dataGridCellEditorText } from "@/lib/dataGrid/dataGridCellCoercion";
import { createColumnDrafts } from "@/lib/table/tableStructureEditorState";
import type { BuildSingleColumnAlterSqlOptions } from "@/lib/table/tableStructureEditorSql";
import { buildTableSelectSql, quoteTableIdentifier } from "@/lib/table/tableSelectSql";
import { uuid } from "@/lib/common/utils";
import { compactHeaderColumnType, resolveHeaderColumnType } from "@/lib/dataGrid/dataGridColumnType";
import {
  canDeleteExistingTdengineRows,
  canEditExistingTableRows,
  canInsertTableRows,
  canUseKeylessRowPredicate,
  hasCompleteTdengineRowIdentity,
  hiveTablePropertiesIndicateTransactional,
  isClickHouseExistingRowReadonlyColumn,
  isHiddenGridColumn,
  isTdengineExistingRowReadonlyColumn,
  usesSyntheticRowIdKey,
} from "@/lib/table/tableEditing";
import { buildDataGridColumnDistinctValuesSql, buildDataGridContextFilterCondition, buildDataGridCountSql, buildHiveTablePropertiesSql, type DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import {
  buildVisibleTransposeRows,
  averageTransposeRecordWidth,
  calculateTransposeRecordWidth,
  defaultTransposeRecordWidth,
  minTransposeFieldWidth,
  minTransposeRecordWidth,
  nextAppendedTransposeState,
  nextContextTransposeState,
  nextKeyboardTransposeState,
  nextTransposeState,
  nextTransposeStateForRecordCount,
  transposeRecordIndexesForMode,
  transposeRecordWidthsForDensity,
  transposeFieldWidth,
  transposeScrollLeftForRecord,
  visibleTransposeRecordWindow,
} from "@/lib/dataGrid/dataGridTranspose";
import { canApplyGridSelectionValue, canDeleteGridRowItem, canEditGridCellDetail, matchesRowStatusFilter, shouldShowQuickEntryDraftRow, type RowStatus, type RowStatusFilter } from "@/lib/dataGrid/gridRowStatus";
import { displayCellValue, firstLineCellDisplayValue, type CellValue } from "@/lib/dataGrid/cellValue";
import { getApplicablePreviewActions } from "@/lib/dataGrid/resultPreviewRegistry";
import "@/lib/dataGrid/geometryMapPreview";
import { BINARY_CELL_DOWNLOAD_MODES, binaryCellDisplayText, binaryCellDownloadFileName, binaryCellDownloadPayload, canDownloadBinaryCellValue, downloadBinaryCellPayload, isBinaryCellColumnType, parseBinaryCellBytes, type BinaryCellDownloadMode } from "@/lib/dataGrid/binaryCellDownload";
import { buildBinaryHexViewRows } from "@/lib/dataGrid/binaryHexViewer";
import { canFormatCellDetailJson, cellDetailEditorText, compactJsonText, defaultCellDetailTab, formatJsonText, isGeometryColumnType, linkedCellDetailTarget, looksLikeJsonContainerText, valueEditorActions, visibleCellDetailTabs, type CellDetailTab } from "@/lib/dataGrid/cellDetailPresentation";
import { renderWktOnCanvas, isHexGeometry } from "@/lib/dataGrid/geometryPreview";
import {
  buildDataGridCellDetail,
  buildDataGridColumnDetail,
  buildDataGridRowDetail,
  CELL_DETAIL_VALUE_PREVIEW_MAX_LENGTH,
  dataGridColumnDetailJson,
  dataGridColumnDetailTsv,
  dataGridRowDetailJson,
  dataGridRowDetailTsv,
  filterDataGridDetailFields,
  type DataGridCellDetail,
} from "@/lib/dataGrid/dataGridDetail";
import { applyColumnFormatter, buildColumnFormatterKey, normalizeColumnFormatter, resolveColumnFormatter, type ColumnFormatterConfig, type DateTimeFormatterUnit, DateTimePatterns } from "@/lib/dataGrid/columnFormatter";
import { temporalCellEditorConfig, type TemporalCellEditorConfig } from "@/lib/dataGrid/dataGridTemporalEditor";
import { isCancelSearchShortcut, isCopyCurrentRowShortcut, isDeleteCurrentRowShortcut, isFocusSearchShortcut, isModRShortcut, isSaveShortcut, isToggleTransposeShortcut } from "@/lib/editor/keyboardShortcuts";
import { dataGridHeaderContentWidth, scrollbarGutterWidth } from "@/lib/dataGrid/dataGridScrollGutter";
import { canGoNextDataGridPage } from "@/lib/dataGrid/dataGridPagination";
import { dataGridBottomScrollTop, dataGridScrollPosition, isDataGridAtScrollBottom, isDataGridNearScrollBottom, shouldCheckInfiniteScrollAfterScroll, type DataGridScrollPosition } from "@/lib/dataGrid/dataGridInfiniteScroll";
import { CANVAS_DATA_GRID_ROW_HEIGHT, drawCanvasDataGrid } from "@/lib/dataGrid/canvasDataGridRenderer";
import { dataGridSaveActionMode, dataGridSaveToolbarState } from "@/lib/dataGrid/dataGridSaveUi";
import type { QueryEditabilityReason } from "@/lib/sql/sqlAnalysis";
import { EDITOR_FONT_FAMILY_CSS_VAR } from "@/lib/editor/editorThemes";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { appendColumnValueFilterCondition, buildColumnValueFilterCondition, buildColumnValuesFilterCondition, combineWhereInputs, filterModeNeedsValue, parseFilterValue } from "@/lib/dataGrid/dataGridColumnFilter";
import { clampSearchSplitWidth } from "@/lib/dataGrid/dataGridSearchSplit";
import { MAX_RESULT_PAGE_SIZE, MIN_RESULT_PAGE_SIZE, normalizeResultPageSize, resultPageSizeMenuOptions } from "@/lib/dataGrid/paginationPageSize";
import { allNullColumnIndexes, filterColumnVisibilityOptions, hiddenColumnIndexesWithAllNullColumns, invertedHiddenColumnIndexes, nextHiddenColumnIndexes, removeAutoHiddenColumnIndexes, visibleColumnIndexesForFilter } from "@/lib/dataGrid/dataGridColumnVisibility";
import { buildDataGridColumnLookupItems, filterDataGridColumnLookupItems } from "@/lib/dataGrid/dataGridColumnLookup";
import { columnOrderKeysForIndexes, isDefaultColumnOrder, moveVisibleColumnIndex, orderedColumnIndexes, uniqueDataGridColumnOrderKeys } from "@/lib/dataGrid/dataGridColumnOrder";
import {
  dataGridColumnLayoutScopeKey,
  loadDataGridColumnOrder,
  loadTableDataGridColumnOrder,
  notifyTableDataGridColumnOrderChanged,
  removeDataGridColumnOrder,
  removeTableDataGridColumnOrder,
  saveDataGridColumnOrder,
  saveTableDataGridColumnOrder,
  TABLE_DATA_GRID_COLUMN_ORDER_CHANGED_EVENT,
  tableDataGridColumnOrderScopeKey,
  type TableDataGridColumnOrderChangedDetail,
} from "@/lib/dataGrid/dataGridColumnLayoutStorage";
import { parseClipboardTable, summarizeSelection } from "@/lib/dataGrid/gridSelection";
import { columnHeaderCanvasPointerDisabled, columnHeaderClickShouldBeSuppressed, columnHeaderPreviewOffsetForColumn, columnHeaderTooltipDisabled } from "@/lib/dataGrid/dataGridColumnHeaderInteraction";

import { useToast } from "@/composables/useToast";
import { useDataGridExport } from "@/composables/useDataGridExport";
import { eventTargetAllowsNativeClipboard, isPlainClipboardShortcut, readTextFromClipboard } from "@/lib/common/clipboard";
import ExportProgressDialog from "@/components/export/ExportProgressDialog.vue";
import { DATA_GRID_ROW_NUM_WIDTH, useDataGridColumnResize } from "@/composables/useDataGridColumnResize";
import { useDataGridSelection } from "@/composables/useDataGridSelection";
import { useDataGridEditor } from "@/composables/useDataGridEditor";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { useCellDetailEditor, type UseCellDetailEditorReturn } from "@/composables/useCellDetailEditor";
import { useTheme } from "@/composables/useTheme";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { DataGridSortDirection, DataGridSortMode } from "@/lib/dataGrid/dataGridSort";
import { DATA_GRID_COMPACT_TOPBAR_WIDTH, type DataGridReloadIntent } from "@/lib/dataGrid/dataGridToolbar";
import { getTableMetadataCapabilities } from "@/lib/table/tableMetadataCapabilities";
import { getTableStructureCapabilities } from "@/lib/table/tableStructureCapabilities";
import { supportsTableStructureEditing } from "@/lib/database/databaseCapabilities";
import { forgetDataGridConditionHistory, loadDataGridConditionHistory, rememberDataGridConditionHistory } from "@/lib/dataGrid/dataGridConditionHistory";
import { getDataGridConditionSuggestionPosition } from "@/lib/dataGrid/dataGridConditionSuggestionPosition";
import { caretPositionInsideInsertedSqlSingleQuotes, insertedSqlSingleQuoteAtCaret } from "@/lib/sql/sqlQuoteCaret";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { isMacOS } from "@/lib/backend/platform";
import { appendDebugLog, isDebugLoggingEnabled } from "@/lib/backend/debugLog";
import { formatShortcut } from "@/lib/editor/shortcutRegistry";
import { SearchableSelect } from "@/components/ui/searchable-select";

const SqlPreviewPanel = defineAsyncComponent(() => import("@/components/editor/SqlPreviewPanel.vue"));
const FORMATTED_JSON_EDIT_WARNING_COUNT_STORAGE_KEY = "dbx-cell-detail-formatted-json-edit-warning-count";
const FORMATTED_JSON_EDIT_WARNING_MAX_COUNT = 3;

const { t } = useI18n();
const slots = useSlots();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const tableFontSize = computed(() => settingsStore.editorSettings.tableFontSize);
const { isDark, themePalette } = useTheme();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();
const binaryCellDownloadMenuItems = computed(() =>
  BINARY_CELL_DOWNLOAD_MODES.map((mode) => ({
    label: t(`grid.binaryDownload.${mode}`),
    value: mode,
  })),
);

interface PreparedCopyValue {
  key: string;
  text: string;
  loading: boolean;
  ready: boolean;
}

type ConditionSuggestion = {
  value: string;
  kind: "column" | "history";
};

type SortMenuValue = "local-asc" | "local-desc" | "database-asc" | "database-desc" | "clear";

interface DataGridProps {
  result: QueryResult;
  sql?: string;
  editable?: boolean;
  databaseType?: DatabaseType;
  connectionId?: string;
  database?: string;
  executionDatabase?: string;
  schema?: string;
  context?: "results" | "table-data";
  sourceColumns?: Array<string | undefined>;
  initialWhereInput?: string;
  initialOrderByInput?: string;
  sortColumn?: string;
  sortColumnIndex?: number;
  sortDirection?: DataGridSortDirection;
  sortMode?: DataGridSortMode;
  tableMeta?: {
    catalog?: string;
    schema?: string;
    tableName: string;
    tableType?: string;
    columns: ColumnInfo[];
    primaryKeys: string[];
  };
  tableInfoTab?: TableInfoTab;
  pageOffset?: number;
  pageLimit?: number;
  countSql?: string;
  totalRowCount?: number;
  totalRowCountLoading?: boolean;
  loading?: boolean;
  cacheKey?: string;
  onExecuteSql?: (sql: string) => Promise<void>;
  fullExportResult?: (onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void) => Promise<QueryResult | undefined>;
  queryResultExportRequest?: (options: { exportId: string; filePath: string; format: "csv" | "xlsx" }) => Promise<api.QueryResultExportRequest | undefined>;
  allExportResults?: Array<{ sheetName: string; result: QueryResult }>;
  exportFileBaseName?: string;
  customSaveHandler?: import("@/composables/useDataGridEditor").CustomSaveHandler;
  queryEditabilityReason?: QueryEditabilityReason;
  allowInsertRows?: boolean;
  allowDeleteRows?: boolean;
}

const props = withDefaults(defineProps<DataGridProps>(), {
  // Vue casts absent Boolean props to false unless the default is explicitly
  // undefined; omitted row-action limits must keep normal table-data editing.
  allowInsertRows: undefined,
  allowDeleteRows: undefined,
});

const dataGridTraceId = uuid().slice(0, 8);
const dataGridCreatedAt = performance.now();
const dataGridElapsed = () => `${Math.round(performance.now() - dataGridCreatedAt)}ms`;
const isMac = isMacOS();
const shortcutMod = isMac ? "Cmd" : "Ctrl";
const saveShortcutLabel = computed(() => formatShortcut(settingsStore.editorSettings.shortcuts.saveSql));
const AUTO_REFRESH_INTERVAL_OPTIONS = [5, 10, 30, 60, 300];

function logDataGridTiming(message: string, payload?: Record<string, unknown>) {
  appendDebugLog("info", message, payload);
}

const emit = defineEmits<{
  reload: [sql?: string, searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number, intent?: DataGridReloadIntent];
  paginate: [offset: number, limit: number, whereInput?: string, orderBy?: string];
  sort: [column: string, columnIndex: number, direction: "asc" | "desc" | null, whereInput?: string, mode?: DataGridSortMode];
  "update:whereInput": [value: string];
  "update:orderByInput": [value: string];
}>();

const autoRefreshIntervalSeconds = ref(10);
const autoRefreshEnabled = ref(false);
let autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
const autoRefreshLabel = computed(() => (autoRefreshEnabled.value ? t("tabs.autoRefreshEvery", { seconds: autoRefreshIntervalSeconds.value }) : t("tabs.autoRefresh")));

if (isDebugLoggingEnabled()) {
  logDataGridTiming("[DBX][DataGrid:setup]", {
    traceId: dataGridTraceId,
    cacheKey: props.cacheKey,
    rowCount: props.result.rows.length,
    columnCount: props.result.columns.length,
    backendMs: props.result.execution_time_ms,
    loading: props.loading,
  });
}

const transposeRowIndex = ref<number | null>(null);
const showTranspose = ref(false);
const multiRowTranspose = ref(false);
const preserveTransposeOnNextResult = ref(false);

watch(
  () => props.result,
  (result) => {
    if (!isDebugLoggingEnabled()) return;
    const startedAt = performance.now();
    logDataGridTiming("[DBX][DataGrid:result:prop]", {
      traceId: dataGridTraceId,
      cacheKey: props.cacheKey,
      rowCount: result.rows.length,
      columnCount: result.columns.length,
      backendMs: result.execution_time_ms,
      loading: props.loading,
      elapsedSinceSetup: dataGridElapsed(),
    });

    nextTick(() => {
      logDataGridTiming("[DBX][DataGrid:result:nextTick]", {
        traceId: dataGridTraceId,
        cacheKey: props.cacheKey,
        elapsed: `${Math.round(performance.now() - startedAt)}ms`,
        loading: props.loading,
      });
      requestAnimationFrame(() => {
        logDataGridTiming("[DBX][DataGrid:result:first-frame]", {
          traceId: dataGridTraceId,
          cacheKey: props.cacheKey,
          elapsed: `${Math.round(performance.now() - startedAt)}ms`,
          loading: props.loading,
        });
      });
    });
  },
  { immediate: true },
);

const hasData = computed(() => props.result.columns.length > 0);

const columnTypeMap = computed(() => {
  const map = new Map<string, string>();
  if (props.tableMeta?.columns) {
    for (const col of props.tableMeta.columns) {
      const typeName = shortTypeName(col.data_type);
      // Add precision for numeric/decimal types
      if (col.numeric_precision != null && ["numeric", "decimal"].includes(col.data_type.toLowerCase())) {
        const scale = col.numeric_scale ?? 0;
        map.set(col.name, `${typeName}(${col.numeric_precision},${scale})`);
      } else {
        map.set(col.name, typeName);
      }
    }
  }
  return map;
});
const resolvedConnectionConfig = computed(() => connectionStore.getConfig(props.connectionId ?? ""));
const resolvedDatabaseType = computed(() => props.databaseType ?? effectiveDatabaseTypeForConnection(resolvedConnectionConfig.value));
const tableStructureCapabilities = computed(() => getTableStructureCapabilities(resolvedDatabaseType.value, resolvedConnectionConfig.value?.db_type));

const columnCommentMap = computed(() => {
  const map = new Map<string, string>();
  if (props.tableMeta?.columns) {
    for (const col of props.tableMeta.columns) {
      if (col.comment) map.set(col.name, col.comment);
    }
    for (const col of props.tableMeta.columns) {
      if (!col.comment) continue;
      const normalizedName = col.name.toLowerCase();
      if (!map.has(normalizedName)) map.set(normalizedName, col.comment);
    }
  }
  return map;
});
const dataGridTopbarWidth = ref(0);
const showColumnCommentsInHeader = computed(() => settingsStore.editorSettings.showColumnCommentsInHeader);
const showColumnTypesInHeader = computed(() => settingsStore.editorSettings.showColumnTypesInHeader);
const compactColumnHeaderActions = computed(() => settingsStore.editorSettings.compactColumnHeaderActions);
const dataGridRenderMode = computed(() => settingsStore.editorSettings.dataGridRenderMode);
const dataGridSearchMode = computed(() => settingsStore.editorSettings.dataGridSearchMode);
const compactDataGridToolbar = computed(() => dataGridTopbarWidth.value > 0 && dataGridTopbarWidth.value < DATA_GRID_COMPACT_TOPBAR_WIDTH);
const infiniteScrollEnabled = computed(() => settingsStore.editorSettings.infiniteScroll);
const infiniteScrollMaxRows = computed(() => settingsStore.editorSettings.infiniteScrollMaxRows);
const expandedCellEditor = ref<{ rowId: number; col: number } | null>(null);

function headerColumnComment(column: string): string {
  if (!showColumnCommentsInHeader.value) return "";
  return columnCommentMap.value.get(column) || "";
}

function headerColumnType(column: string, actualColIdx: number): string {
  if (!showColumnTypesInHeader.value) return "";
  const resolved = resolveHeaderColumnType({
    tableColumnType: columnTypeMap.value.get(column),
    resultColumnTypes: props.result.column_types,
    actualColIdx,
  });
  return resolved ? shortTypeName(compactHeaderColumnType(resolved)) : "";
}

function shortTypeName(t: string): string {
  const s = t.toLowerCase();
  if (s === "character varying") return "varchar";
  if (s === "character") return "char";
  if (s === "double precision") return "double";
  if (s === "timestamp without time zone") return "timestamp";
  if (s === "timestamp with time zone") return "timestamptz";
  if (s === "time without time zone") return "time";
  if (s === "time with time zone") return "timetz";
  if (s === "boolean") return "bool";
  if (s === "integer") return "int";
  if (s === "smallint") return "int2";
  if (s === "real") return "float4";
  return t;
}

function headerColumnSortable(actualColIdx: number): boolean {
  const resolved = props.result.column_sortables?.[actualColIdx];
  return resolved !== undefined ? resolved : true;
}

function columnIsSorted(column: string, columnIndex: number): boolean {
  return sortCol.value === column && sortColIndex.value === columnIndex;
}

function sortMenuItems(column: string, columnIndex: number) {
  return [
    {
      label: t("grid.sortDatabaseAscending"),
      value: "database-asc",
      icon: Database,
      checked: columnIsSorted(column, columnIndex) && sortDir.value === "asc" && sortMode.value === "database",
    },
    {
      label: t("grid.sortDatabaseDescending"),
      value: "database-desc",
      icon: Database,
      checked: columnIsSorted(column, columnIndex) && sortDir.value === "desc" && sortMode.value === "database",
    },
    {
      label: t("grid.sortCurrentPageAscending"),
      value: "local-asc",
      icon: ArrowUp,
      checked: columnIsSorted(column, columnIndex) && sortDir.value === "asc" && sortMode.value === "local",
      separatorBefore: true,
    },
    {
      label: t("grid.sortCurrentPageDescending"),
      value: "local-desc",
      icon: ArrowDown,
      checked: columnIsSorted(column, columnIndex) && sortDir.value === "desc" && sortMode.value === "local",
    },
    {
      label: t("grid.clearSort"),
      value: "clear",
      icon: ArrowUpDown,
      disabled: !columnIsSorted(column, columnIndex),
      separatorBefore: true,
    },
  ];
}

function selectedSortMenuValue(column: string, columnIndex: number): SortMenuValue | undefined {
  return columnIsSorted(column, columnIndex) ? (`${sortMode.value}-${sortDir.value}` as SortMenuValue) : undefined;
}

function typeColorClass(t: string): string {
  // Strip precision/scale suffix like (20,6)
  const base = t.replace(/\(.*\)$/, "").toLowerCase();
  if (["int", "int2", "int4", "int8", "smallint", "bigint", "integer", "serial", "bigserial", "tinyint", "mediumint"].includes(base)) return "text-blue-500";
  // number: Oracle/Dameng NUMBER；binary_float/binary_double: Oracle IEEE 浮点
  if (["float4", "float8", "double", "decimal", "numeric", "real", "float", "money", "number", "binary_float", "binary_double", "dec"].includes(base)) return "text-cyan-500";
  // varchar2/nvarchar2/long: Oracle/Dameng 字符类型（LONG 在 Oracle 中是变长字符）
  if (["varchar", "varchar2", "nvarchar2", "text", "char", "character varying", "character", "string", "nvarchar", "nchar", "ntext", "longtext", "mediumtext", "tinytext", "clob", "long"].includes(base)) return "text-green-500";
  if (["bool", "boolean", "bit"].includes(base)) return "text-orange-500";
  if (["timestamp", "timestamptz", "datetime", "date", "time", "timetz", "datetime2", "smalldatetime"].includes(base)) return "text-purple-500";
  // xmltype: Oracle XMLType
  if (["json", "jsonb", "xml", "xmltype", "array"].includes(base)) return "text-pink-500";
  if (["uuid", "uniqueidentifier"].includes(base)) return "text-amber-500";
  // raw/long raw/bfile: Oracle 二进制
  if (["bytea", "blob", "binary", "varbinary", "image", "raw", "long raw", "bfile"].includes(base)) return "text-red-400";
  // sdo_geometry: Oracle Spatial
  if (["geometry", "geography", "sdo_geometry"].includes(base)) return "text-emerald-500";
  return "text-muted-foreground";
}
const contextCell = ref<{ rowId: number; rowIndex: number; col: number } | null>(null);
const contextHeaderColumn = ref<string | null>(null);
const contextHeaderColumnIndex = ref<number | null>(null);
const bulkEditDialogOpen = ref(false);
const bulkEditValue = ref("");
const detailCell = ref<{ rowIndex: number; col: number } | null>(null);
const hoveredDetailCell = ref<{ rowIndex: number; col: number } | null>(null);
const quickDownloadMenuCell = ref<{ rowIndex: number; col: number } | null>(null);
const showCellDetail = ref(false);
const showMongoJsonPreview = ref(false);
const activeCellDetailTab = ref<CellDetailTab>(defaultCellDetailTab());
const cellDetailDialogOpen = ref(false);
const cellDetailDialogTarget = ref<{ rowIndex: number; col: number } | null>(null);
const rowDetailDialogOpen = ref(false);
const rowDetailDialogRowId = ref<number | null>(null);
const columnDetailDialogOpen = ref(false);
const columnDetailDialogColumnIndex = ref<number | null>(null);
const rowDetailSearch = ref("");
const columnDetailSearch = ref("");
const isResizingDetail = ref(false);
const imagePreviewOpen = ref(false);
const imagePreviewSrc = ref("");
const imagePreviewTitle = ref("");
const sideGeometryPreviewOpen = ref(false);
const dialogGeometryPreviewOpen = ref(false);
const sideGeometryCanvas = ref<HTMLCanvasElement | null>(null);
const dialogGeometryCanvas = ref<HTMLCanvasElement | null>(null);
const previewDialogOpen = ref(false);
const previewDialogConfig = shallowRef<{ component: any; props: Record<string, any> } | null>(null);
const transposeScrollRef = ref<HTMLElement | { $el?: HTMLElement }>();
const transposeScrollLeft = ref(0);
const transposeViewportWidth = ref(0);
const sortCol = ref<string | null>(null);
const sortColIndex = ref<number | null>(null);
const sortDir = ref<DataGridSortDirection>("asc");
const sortMode = ref<DataGridSortMode>("database");
const searchText = ref("");
const deferredClientSearchText = ref("");
const searchOverlayVisible = ref(false);
const currentMatchIndex = ref(-1);
let _searchTimer: ReturnType<typeof setTimeout> | undefined;

const searchSuggestions = ref<string[]>([]);
const suggestionIndex = ref(-1);
const searchInputRef = ref<HTMLInputElement>();
const measureRef = ref<HTMLSpanElement>();
const suggestionLeft = ref(0);

const whereSuggestions = ref<ConditionSuggestion[]>([]);
const whereSuggestionIndex = ref(-1);
const whereHistoryMenuOpen = ref(false);
const whereFilterInputRef = ref<HTMLTextAreaElement>();
const whereFilterOverlayRef = ref<HTMLTextAreaElement>();
const whereConditionPaneRef = ref<HTMLDivElement>();
const whereConditionControlRef = ref<HTMLDivElement>();
const whereSuggestionDropdownRef = ref<HTMLDivElement>();
const whereSuggestionPosition = ref({ left: 0, top: 0, width: 180 });
const whereConditionRendered = ref(false);
const whereConditionExpanded = ref(false);
const whereConditionHeight = ref(28);
const whereConditionRect = ref({ left: 0, top: 0, width: 0, height: 28 });
const whereConditionScrollTop = ref(0);
const whereConditionImmediateHeight = ref(false);
let whereConditionCollapseTimer: ReturnType<typeof setTimeout> | undefined;
let suppressNextWhereWatchResize = false;

const orderBySuggestions = ref<ConditionSuggestion[]>([]);
const orderBySuggestionIndex = ref(-1);
const orderByHistoryMenuOpen = ref(false);
const orderByInputRef = ref<HTMLTextAreaElement>();
const orderByOverlayRef = ref<HTMLTextAreaElement>();
const orderByConditionPaneRef = ref<HTMLDivElement>();
const orderByConditionControlRef = ref<HTMLDivElement>();
const orderBySuggestionDropdownRef = ref<HTMLDivElement>();
const orderBySuggestionPosition = ref({ left: 0, top: 0, width: 180 });
const orderByConditionRendered = ref(false);
const orderByConditionExpanded = ref(false);
const orderByConditionHeight = ref(28);
const orderByConditionRect = ref({ left: 0, top: 0, width: 0, height: 28 });
const orderByConditionScrollTop = ref(0);
const orderByConditionImmediateHeight = ref(false);
let orderByConditionCollapseTimer: ReturnType<typeof setTimeout> | undefined;
let suppressNextOrderByWatchResize = false;
const conditionHistoryPreview = ref<{ value: string; left: number; top: number; maxWidth: number; arrowTop: number; side: "left" | "right" } | null>(null);

const orderByInput = ref(props.initialOrderByInput ?? "");
const hasOrderByInput = computed(() => orderByInput.value.trim().length > 0);
const whereFilterInput = ref(props.initialWhereInput ?? "");
let previousWhereFilterInputValue = whereFilterInput.value;
let suppressWhereHistoryOnNextEmptyInput = false;
let suppressOrderByHistoryOnNextEmptyInput = false;
const hasWhereFilterInput = computed(() => whereFilterInput.value.trim().length > 0);
const conditionHistoryScope = computed(() => ({
  connectionId: props.connectionId,
  database: props.database,
  schema: props.tableMeta?.schema ?? props.schema,
  tableName: props.tableMeta?.tableName,
}));
const searchSplitContainerRef = ref<HTMLDivElement>();
const searchSplitWhereWidth = ref<number | null>(null);
const isResizingSearchSplit = ref(false);
let searchSplitStartX = 0;
let searchSplitStartWidth = 0;

const whereSearchPaneStyle = computed(() => {
  if (searchSplitWhereWidth.value == null) return {};
  return {
    flex: `0 0 ${searchSplitWhereWidth.value}px`,
  };
});

const whereSuggestionStyle = computed(() => ({
  left: `${whereSuggestionPosition.value.left}px`,
  top: `${whereSuggestionPosition.value.top}px`,
  width: `${whereSuggestionPosition.value.width}px`,
}));
const showWhereSuggestionDropdown = computed(() => whereSuggestions.value.length > 0 || whereHistoryMenuOpen.value);
const whereHistoryEmptyText = computed(() => (whereFilterInput.value.trim() ? t("grid.conditionHistoryNoMatches") : t("grid.conditionHistoryEmpty")));

const orderBySuggestionStyle = computed(() => ({
  left: `${orderBySuggestionPosition.value.left}px`,
  top: `${orderBySuggestionPosition.value.top}px`,
  width: `${orderBySuggestionPosition.value.width}px`,
}));
const showOrderBySuggestionDropdown = computed(() => orderBySuggestions.value.length > 0 || orderByHistoryMenuOpen.value);
const orderByHistoryEmptyText = computed(() => (orderByInput.value.trim() ? t("grid.conditionHistoryNoMatches") : t("grid.conditionHistoryEmpty")));
const conditionHistoryPreviewStyle = computed<CSSProperties>(() => {
  const preview = conditionHistoryPreview.value;
  if (!preview) return {};
  return {
    left: `${preview.left}px`,
    maxWidth: `${preview.maxWidth}px`,
    top: `${preview.top}px`,
  };
});
const conditionHistoryPreviewArrowStyle = computed<CSSProperties>(() => {
  const preview = conditionHistoryPreview.value;
  if (!preview) return {};
  return {
    top: `${preview.arrowTop}px`,
  };
});

type ConditionInputKind = "where" | "orderBy";
const CONDITION_EXPANDED_MAX_HEIGHT = 260;

function conditionInputRef(kind: ConditionInputKind) {
  return kind === "where" ? whereFilterInputRef.value : orderByInputRef.value;
}

function conditionOverlayRef(kind: ConditionInputKind) {
  return kind === "where" ? whereFilterOverlayRef.value : orderByOverlayRef.value;
}

function conditionPaneRef(kind: ConditionInputKind) {
  return kind === "where" ? whereConditionPaneRef.value : orderByConditionPaneRef.value;
}

function conditionControlRef(kind: ConditionInputKind) {
  return kind === "where" ? whereConditionControlRef.value : orderByConditionControlRef.value;
}

function conditionEditorRef(kind: ConditionInputKind) {
  return conditionOverlayRef(kind) ?? conditionInputRef(kind);
}

function conditionInputTextWidth(input: HTMLTextAreaElement): number {
  const probe = document.createElement("span");
  const style = window.getComputedStyle(input);
  probe.textContent = input.value || input.placeholder || "";
  probe.style.cssText = `
    position: fixed;
    left: -9999px;
    top: -9999px;
    visibility: hidden;
    white-space: pre;
    font: ${style.font};
    font-size: ${style.fontSize};
    font-family: ${style.fontFamily};
    font-weight: ${style.fontWeight};
    letter-spacing: ${style.letterSpacing};
  `;
  document.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

function conditionInputShouldExpand(input: HTMLTextAreaElement): boolean {
  return input.value.length > 0 && conditionInputTextWidth(input) > input.clientWidth + 1;
}

function conditionInputContentHeight(input: HTMLTextAreaElement): number {
  const probe = document.createElement("div");
  const style = window.getComputedStyle(input);
  probe.textContent = input.value || input.placeholder || "";
  probe.style.cssText = `
    position: fixed;
    left: -9999px;
    top: -9999px;
    visibility: hidden;
    box-sizing: border-box;
    width: ${input.clientWidth}px;
    min-height: 0;
    padding: ${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft};
    border: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: ${style.font};
    font-size: ${style.fontSize};
    font-family: ${style.fontFamily};
    font-weight: ${style.fontWeight};
    line-height: ${style.lineHeight};
    letter-spacing: ${style.letterSpacing};
    text-indent: ${style.textIndent};
  `;
  document.body.appendChild(probe);
  const height = probe.scrollHeight;
  probe.remove();
  return height;
}

function conditionExpandedHeight(input: HTMLTextAreaElement): number {
  const style = window.getComputedStyle(input);
  const lineHeight = Number.parseFloat(style.lineHeight) || 24;
  const inputRect = input.getBoundingClientRect();
  const pane = input.parentElement;
  const paneRect = pane?.getBoundingClientRect();
  const verticalInset = paneRect ? Math.max(0, inputRect.top - paneRect.top) + Math.max(0, paneRect.bottom - inputRect.bottom) : 0;
  const minimumHeight = Math.max(56, lineHeight * 2.5);
  const availableHeight = Math.max(minimumHeight, window.innerHeight - input.getBoundingClientRect().top - 12);
  const contentHeight = conditionInputContentHeight(input);
  return Math.min(Math.max(minimumHeight, contentHeight + verticalInset), Math.min(CONDITION_EXPANDED_MAX_HEIGHT, availableHeight));
}

function conditionCaretTop(input: HTMLTextAreaElement, caretIndex: number): number {
  const probe = document.createElement("div");
  const style = window.getComputedStyle(input);
  const textBeforeCaret = input.value.slice(0, caretIndex);
  probe.textContent = textBeforeCaret || " ";
  probe.style.cssText = `
    position: fixed;
    left: -9999px;
    top: -9999px;
    visibility: hidden;
    box-sizing: border-box;
    width: ${input.clientWidth}px;
    min-height: 0;
    padding: ${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft};
    border: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: ${style.font};
    font-size: ${style.fontSize};
    font-family: ${style.fontFamily};
    font-weight: ${style.fontWeight};
    line-height: ${style.lineHeight};
    letter-spacing: ${style.letterSpacing};
    text-indent: ${style.textIndent};
  `;
  document.body.appendChild(probe);
  const lineHeight = Number.parseFloat(style.lineHeight) || 24;
  const top = Math.max(0, probe.scrollHeight - lineHeight);
  probe.remove();
  return top;
}

function setConditionScrollTop(kind: ConditionInputKind, scrollTop: number) {
  if (kind === "where") {
    whereConditionScrollTop.value = scrollTop;
  } else {
    orderByConditionScrollTop.value = scrollTop;
  }
}

function scrollConditionCaretIntoView(kind: ConditionInputKind, input: HTMLTextAreaElement, caretIndex: number) {
  const caretTop = conditionCaretTop(input, caretIndex);
  const lineHeight = Number.parseFloat(window.getComputedStyle(input).lineHeight) || 24;
  const topPadding = lineHeight * 0.5;
  const maxScrollTop = Math.max(0, input.scrollHeight - input.clientHeight);
  input.scrollTop = Math.min(Math.max(0, caretTop - topPadding), maxScrollTop);
  setConditionScrollTop(kind, input.scrollTop);
}

function conditionCollapsedHeight(kind: ConditionInputKind) {
  const pane = conditionPaneRef(kind) ?? conditionControlRef(kind);
  return pane ? pane.getBoundingClientRect().height : 28;
}

function clearConditionCollapseTimer(kind: ConditionInputKind) {
  if (kind === "where") {
    if (whereConditionCollapseTimer) clearTimeout(whereConditionCollapseTimer);
    whereConditionCollapseTimer = undefined;
  } else {
    if (orderByConditionCollapseTimer) clearTimeout(orderByConditionCollapseTimer);
    orderByConditionCollapseTimer = undefined;
  }
}

function conditionPaneRendered(kind: ConditionInputKind) {
  return kind === "where" ? whereConditionRendered.value : orderByConditionRendered.value;
}

function setConditionRendered(kind: ConditionInputKind, rendered: boolean) {
  if (kind === "where") {
    whereConditionRendered.value = rendered;
  } else {
    orderByConditionRendered.value = rendered;
  }
}

function conditionPaneExpanded(kind: ConditionInputKind) {
  return kind === "where" ? whereConditionExpanded.value : orderByConditionExpanded.value;
}

function setConditionExpandedState(kind: ConditionInputKind, expanded: boolean) {
  if (kind === "where") {
    whereConditionExpanded.value = expanded;
  } else {
    orderByConditionExpanded.value = expanded;
  }
}

function queueConditionPaneRemoval(kind: ConditionInputKind) {
  clearConditionCollapseTimer(kind);
  const timer = setTimeout(() => {
    if (!conditionPaneExpanded(kind)) setConditionRendered(kind, false);
  }, 160);
  if (kind === "where") {
    whereConditionCollapseTimer = timer;
  } else {
    orderByConditionCollapseTimer = timer;
  }
}

function setConditionExpanded(kind: ConditionInputKind, expanded: boolean) {
  if (expanded) {
    const wasRendered = conditionPaneRendered(kind);
    clearConditionCollapseTimer(kind);
    setConditionRendered(kind, true);
    if (wasRendered) {
      setConditionExpandedState(kind, true);
    } else {
      setConditionExpandedState(kind, false);
      requestAnimationFrame(() => requestAnimationFrame(() => setConditionExpandedState(kind, true)));
    }
    return;
  }
  setConditionExpandedState(kind, false);
  queueConditionPaneRemoval(kind);
}

function setConditionHeight(kind: ConditionInputKind, height: number) {
  if (kind === "where") {
    whereConditionHeight.value = height;
  } else {
    orderByConditionHeight.value = height;
  }
}

function setConditionRect(kind: ConditionInputKind, rect: DOMRect) {
  const nextRect = {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
  if (kind === "where") {
    whereConditionRect.value = nextRect;
  } else {
    orderByConditionRect.value = nextRect;
  }
}

function conditionInputInsets(kind: ConditionInputKind) {
  const pane = conditionPaneRef(kind);
  const input = conditionInputRef(kind);
  const control = conditionControlRef(kind);
  if (!pane || !input) {
    return { controlsTop: 3, inputTop: 3, prefix: 0, suffix: 0 };
  }
  const paneRect = pane.getBoundingClientRect();
  const inputRect = input.getBoundingClientRect();
  const controlRect = control?.getBoundingClientRect();
  const paneStyle = window.getComputedStyle(pane);
  const paddingLeft = Number.parseFloat(paneStyle.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(paneStyle.paddingRight) || 0;
  return {
    controlsTop: Math.max(0, (controlRect?.top ?? inputRect.top) - paneRect.top),
    inputTop: Math.max(0, inputRect.top - paneRect.top),
    prefix: Math.max(0, inputRect.left - paneRect.left - paddingLeft),
    suffix: Math.max(28, paneRect.right - inputRect.right - paddingRight),
  };
}

function conditionPaneStyle(kind: ConditionInputKind): CSSProperties {
  const rendered = conditionPaneRendered(kind);
  const expanded = conditionPaneExpanded(kind);
  const height = kind === "where" ? whereConditionHeight.value : orderByConditionHeight.value;
  const immediateHeight = kind === "where" ? whereConditionImmediateHeight.value : orderByConditionImmediateHeight.value;
  if (!rendered) return {};
  const rect = kind === "where" ? whereConditionRect.value : orderByConditionRect.value;
  const collapsedHeight = rect.height || 28;
  const insets = conditionInputInsets(kind);
  return {
    "--data-grid-condition-controls-top": `${insets.controlsTop}px`,
    "--data-grid-condition-input-top": `${insets.inputTop}px`,
    "--data-grid-condition-prefix-indent": `${insets.prefix}px`,
    "--data-grid-condition-suffix-width": `${insets.suffix}px`,
    height: `${expanded ? height : collapsedHeight}px`,
    left: `${rect.left}px`,
    pointerEvents: expanded ? "auto" : "none",
    top: `${rect.top}px`,
    transition: immediateHeight ? "box-shadow 150ms ease" : undefined,
    width: `${rect.width}px`,
  };
}

function conditionTopbarOverlayStyle(kind: ConditionInputKind): CSSProperties {
  const scrollTop = kind === "where" ? whereConditionScrollTop.value : orderByConditionScrollTop.value;
  return {
    transform: `translateY(${-scrollTop}px)`,
  };
}

function focusConditionOverlay(kind: ConditionInputKind, source: HTMLTextAreaElement) {
  window.setTimeout(() => {
    const overlay = conditionOverlayRef(kind);
    if (!overlay) return;
    const start = source.selectionStart ?? source.value.length;
    const end = source.selectionEnd ?? start;
    overlay.focus();
    overlay.setSelectionRange(start, end);
    scrollConditionCaretIntoView(kind, overlay, start);
    requestAnimationFrame(() => scrollConditionCaretIntoView(kind, overlay, start));
    updateConditionSuggestionPosition(kind);
  }, 0);
}

function focusConditionInput(kind: ConditionInputKind, source: HTMLTextAreaElement) {
  const input = conditionInputRef(kind);
  if (!input) return;
  const start = source.selectionStart ?? source.value.length;
  const end = source.selectionEnd ?? start;
  nextTick(() => {
    input.focus();
    input.setSelectionRange(start, end);
    updateConditionSuggestionPosition(kind);
  });
}

function onConditionOverlayScroll(kind: ConditionInputKind, event: Event) {
  const input = event.target instanceof HTMLTextAreaElement ? event.target : null;
  if (!input) return;
  setConditionScrollTop(kind, input.scrollTop);
}

function resetConditionOverlayScrollIfContentFits(kind: ConditionInputKind) {
  requestAnimationFrame(() => {
    const overlay = conditionOverlayRef(kind);
    const pane = overlay?.parentElement;
    if (!overlay || !pane || overlay.scrollHeight > overlay.clientHeight + 1 || pane.getBoundingClientRect().height >= CONDITION_EXPANDED_MAX_HEIGHT - 1) return;
    overlay.scrollTop = 0;
    setConditionScrollTop(kind, 0);
  });
}

function onConditionOverlayClick(kind: ConditionInputKind) {
  if (kind === "where") {
    if (whereHistoryMenuOpen.value) {
      dismissWhereSuggestions();
      return;
    }
    updateWhereSuggestionPosition();
  } else {
    if (orderByHistoryMenuOpen.value) {
      dismissOrderBySuggestions();
      return;
    }
    updateOrderBySuggestionPosition();
  }
}

function resizeConditionInput(kind: ConditionInputKind, options: { focusOverlay?: boolean; expandFromFocus?: boolean; immediateHeight?: boolean } = {}) {
  nextTick(() => {
    const input = conditionInputRef(kind);
    if (!input) return;
    const editor = conditionEditorRef(kind) ?? input;
    const focused = document.activeElement === input || document.activeElement === conditionOverlayRef(kind);
    const expanded = focused && conditionInputShouldExpand(input) && (options.expandFromFocus || document.activeElement === conditionOverlayRef(kind));
    const shouldRestoreInputFocus = !expanded && document.activeElement === conditionOverlayRef(kind);
    if (shouldRestoreInputFocus && editor instanceof HTMLTextAreaElement) focusConditionInput(kind, editor);
    if (expanded) setConditionRect(kind, (conditionPaneRef(kind) ?? conditionControlRef(kind) ?? input).getBoundingClientRect());
    setConditionExpanded(kind, expanded);
    requestAnimationFrame(() => {
      if (!expanded) {
        if (kind === "where") whereConditionImmediateHeight.value = false;
        else orderByConditionImmediateHeight.value = false;
        setConditionHeight(kind, conditionCollapsedHeight(kind));
        return;
      }
      if (options.immediateHeight) {
        if (kind === "where") whereConditionImmediateHeight.value = true;
        else orderByConditionImmediateHeight.value = true;
      }
      setConditionHeight(kind, conditionExpandedHeight(editor));
      if (options.immediateHeight) {
        requestAnimationFrame(() => {
          if (kind === "where") whereConditionImmediateHeight.value = false;
          else orderByConditionImmediateHeight.value = false;
        });
      }
      updateConditionSuggestionPosition(kind);
      if (options.focusOverlay && document.activeElement === input) focusConditionOverlay(kind, input);
      else resetConditionOverlayScrollIfContentFits(kind);
    });
  });
}

function onConditionInputClick(kind: ConditionInputKind) {
  if (kind === "where" && showWhereSuggestionDropdown.value) {
    dismissWhereSuggestions();
    resizeConditionInput(kind, { expandFromFocus: true, focusOverlay: true });
    return;
  }
  if (kind === "orderBy" && showOrderBySuggestionDropdown.value) {
    dismissOrderBySuggestions();
    resizeConditionInput(kind, { expandFromFocus: true, focusOverlay: true });
    return;
  }
  updateConditionSuggestionPosition(kind);
  resizeConditionInput(kind, { expandFromFocus: true, focusOverlay: true });
}

function collapseConditionInput(kind: ConditionInputKind) {
  setConditionExpanded(kind, false);
  setConditionHeight(kind, conditionCollapsedHeight(kind));
  setConditionScrollTop(kind, 0);
}

function collapseConditionInputAfterBlur(kind: ConditionInputKind) {
  window.setTimeout(() => {
    const input = conditionInputRef(kind);
    const overlay = conditionOverlayRef(kind);
    if (document.activeElement === input || document.activeElement === overlay) return;
    collapseConditionInput(kind);
  }, 0);
}

function resizeFocusedConditionInputs() {
  resizeConditionInput("where");
  resizeConditionInput("orderBy");
}

function normalizeConditionInputValue(value: string) {
  return value.replace(/\s*\r?\n\s*/g, " ");
}

function updateConditionSuggestionPosition(kind: ConditionInputKind) {
  if (kind === "where") {
    updateWhereSuggestionPosition();
  } else {
    updateOrderBySuggestionPosition();
  }
}

function showConditionHistoryPreview(value: string, event: MouseEvent) {
  const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!target) return;
  const textElement = target.querySelector<HTMLElement>("[data-condition-history-text]");
  if (!textElement || textElement.scrollWidth <= textElement.clientWidth + 1) {
    hideConditionHistoryPreview();
    return;
  }
  const rect = target.getBoundingClientRect();
  const gap = 10;
  const minWidth = 280;
  const preferredWidth = 560;
  const availableRight = window.innerWidth - rect.right - gap - 8;
  const availableLeft = rect.left - gap - 8;
  const placeRight = availableRight >= minWidth || availableRight >= availableLeft;
  const maxWidth = Math.max(minWidth, Math.min(preferredWidth, placeRight ? availableRight : availableLeft));
  const left = placeRight ? rect.right + gap : Math.max(8, rect.left - gap - maxWidth);
  const estimatedHeight = Math.min(260, Math.max(56, Math.ceil(value.length / 58) * 18 + 24));
  const top = Math.min(Math.max(8, rect.top), Math.max(8, window.innerHeight - estimatedHeight - 8));
  const arrowTop = Math.min(Math.max(14, rect.top + rect.height / 2 - top), estimatedHeight - 14);
  conditionHistoryPreview.value = { value, left, top, maxWidth, arrowTop, side: placeRight ? "left" : "right" };
}

function hideConditionHistoryPreview() {
  conditionHistoryPreview.value = null;
}

type LocalFilterMode = "local" | "server";
type LocalFilterOption = {
  key: string;
  label: string;
  count: number | null;
  value: CellValue;
};

type LocalColumnFilterDraft = {
  columnIndex: number;
  values: Set<string>;
  mode: LocalFilterMode;
  touched: boolean;
};

type FilterMode = DataGridContextFilterMode;

type StructuredFilterRule = {
  id: string;
  columnName: string;
  mode: FilterMode;
  rawValue: string;
  conjunction: "AND" | "OR";
  disabled?: boolean;
};

const localColumnFilters = ref<Record<number, Set<string>>>({});
const localFilterOpenColumn = ref<number | null>(null);
const headerActionMenuOpenColumn = ref<number | null>(null);
const headerSortMenuOpenColumn = ref<number | null>(null);
const headerPanelDismissGuardUntil = ref(0);
const localFilterSearch = ref("");
const localFilterDraft = ref<LocalColumnFilterDraft | null>(null);
const SERVER_COLUMN_FILTER_LIMIT = 1000;
const SERVER_COLUMN_FILTER_DEBOUNCE_MS = 300;
const serverFilterLoading = ref(false);
const serverFilterError = ref("");
const serverFilterOptions = ref<LocalFilterOption[]>([]);
const serverFilterLimited = ref(false);
const serverFilterValueByKey = ref<Map<string, CellValue>>(new Map());
let serverFilterRequestId = 0;
let serverFilterSearchTimer: ReturnType<typeof window.setTimeout> | undefined;
const filterBuilderOpen = ref(false);
const filterBuilderColumnSearch = ref("");
const filterModeOptions: Array<{ value: FilterMode; labelKey: string }> = [
  { value: "equals", labelKey: "grid.filterBuilderEquals" },
  { value: "not-equals", labelKey: "grid.filterBuilderNotEquals" },
  { value: "like", labelKey: "grid.filterBuilderContains" },
  { value: "not-like", labelKey: "grid.filterBuilderNotContains" },
  { value: "greater-than", labelKey: "grid.filterBuilderGreaterThan" },
  { value: "less-than", labelKey: "grid.filterBuilderLessThan" },
  { value: "is-null", labelKey: "grid.filterBuilderIsNull" },
  { value: "is-not-null", labelKey: "grid.filterBuilderIsNotNull" },
];
const filterBuilderColumns = computed(() => props.tableMeta?.columns ?? []);
const filterBuilderColumnOptions = computed(() => filterBuilderColumns.value.map((column) => column.name));
const filteredFilterBuilderColumnOptions = computed(() => {
  const query = filterBuilderColumnSearch.value.trim().toLowerCase();
  if (!query) return filterBuilderColumnOptions.value;
  return filterBuilderColumnOptions.value.filter((columnName) => columnName.toLowerCase().includes(query));
});
const filterBuilderColumnSearchNavigationKeys = new Set(["Escape", "Tab", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
const structuredFilterCacheKey = computed(() => props.cacheKey || [props.connectionId ?? "", props.database ?? "", props.context ?? "", props.tableMeta?.schema ?? "", props.tableMeta?.tableName ?? ""].join("\u0001"));
const structuredFilterScopeKey = computed(() => [props.connectionId ?? "", props.database ?? "", props.schema ?? "", props.context ?? "", props.tableMeta?.schema ?? "", props.tableMeta?.tableName ?? "", filterBuilderColumnOptions.value.join("\0")].join("\u0001"));
const structuredFilterRules = ref<StructuredFilterRule[]>([]);
const appliedStructuredWhereInput = ref("");
const structuredFilterCount = computed(() => structuredFilterRules.value.filter((rule) => !rule.disabled && !!rule.columnName && (!filterModeNeedsValue(rule.mode) || rule.rawValue.trim().length > 0)).length);
const hasStructuredFilters = computed(() => !!combineWhereInputs(undefined, appliedStructuredWhereInput.value));
const formatterOpenColumn = ref<number | null>(null);
type FormatterDraftKind = Exclude<ColumnFormatterConfig["kind"], "custom-ref">;
const CUSTOM_FORMATTER_NEW = "__new";
const formatterKind = ref<FormatterDraftKind>("datetime");
const formatterDateUnit = ref<DateTimeFormatterUnit>("auto");
const formatterDatetimePattern = ref<string>("YYYY-MM-DD HH:mm:ss");
const formatterJsonPath = ref("$.user.name");
const formatterMaskPrefix = ref(4);
const formatterMaskSuffix = ref(4);
const formatterCustomId = ref(CUSTOM_FORMATTER_NEW);
const formatterCustomName = ref("");
const formatterCustomTemplate = ref("${value}");

const savedCustomFormatters = computed(() => {
  return Object.values(settingsStore.editorSettings.customColumnFormatters).sort((a, b) => a.name.localeCompare(b.name));
});

function localFilterKey(value: CellValue): string {
  if (value === null) return "__dbx_null__";
  if (typeof value === "boolean") return `bool:${value}`;
  if (typeof value === "number") return `num:${value}`;
  return `str:${String(value)}`;
}

function localFilterLabel(value: CellValue, columnIndex: number): string {
  return value === null ? "NULL" : formatCellCached(value, columnIndex);
}

function localFilterActive(colIdx: number): boolean {
  return !!localColumnFilters.value[colIdx]?.size;
}

const localFilterCount = computed(() => Object.values(localColumnFilters.value).filter((values) => values.size).length);
const hasLocalColumnFilters = computed(() => localFilterCount.value > 0);
const filterButtonCount = computed(() => structuredFilterCount.value + localFilterCount.value);
const filterButtonActive = computed(() => hasStructuredFilters.value || hasLocalColumnFilters.value);
const localFilterSummaries = computed(() =>
  Object.entries(localColumnFilters.value)
    .filter(([, selected]) => selected.size > 0)
    .map(([columnIndexText, selected]) => {
      const columnIndex = Number(columnIndexText);
      const labelByKey = new Map(buildLocalFilterOptions(columnIndex).map((option) => [option.key, option.label]));
      const values = [...selected].map((key) => labelByKey.get(key) ?? key);
      return {
        columnIndex,
        columnName: props.result.columns[columnIndex] ?? `#${columnIndex + 1}`,
        values: values.slice(0, 3),
        hiddenValueCount: Math.max(0, values.length - 3),
      };
    }),
);

function rowMatchesLocalColumnFilters(data: CellValue[]): boolean {
  const activeEntries = Object.entries(localColumnFilters.value).filter(([, selected]) => selected.size > 0);
  if (activeEntries.length === 0) return true;
  return activeEntries.every(([columnIndex, selected]) => selected.has(localFilterKey(data[Number(columnIndex)] ?? null)));
}

const localFilteredRows = computed(() => {
  const rows = props.result.rows;
  const indices: number[] = [];
  if (!hasLocalColumnFilters.value) {
    for (let i = 0; i < rows.length; i++) indices.push(i);
    return indices;
  }
  for (let i = 0; i < rows.length; i++) {
    if (rowMatchesLocalColumnFilters(rowDataWithChanges(rows[i], i))) {
      indices.push(i);
    }
  }
  return indices;
});

function buildLocalFilterOptions(columnIndex: number): LocalFilterOption[] {
  const byKey = new Map<string, LocalFilterOption>();
  const addValue = (value: CellValue) => {
    const key = localFilterKey(value);
    const current = byKey.get(key);
    if (current) {
      current.count = (current.count ?? 0) + 1;
    } else {
      byKey.set(key, { key, label: localFilterLabel(value, columnIndex), count: 1, value });
    }
  };

  for (const [sourceIndex, row] of props.result.rows.entries()) {
    addValue(rowDataWithChanges(row, sourceIndex)[columnIndex] ?? null);
  }
  for (const row of newRows.value) {
    addValue(row[columnIndex] ?? null);
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.value === null && b.value !== null) return -1;
    if (a.value !== null && b.value === null) return 1;
    return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" });
  });
}

const localFilterAllOptions = computed(() => {
  if (localFilterDraft.value?.mode === "server") return serverFilterOptions.value;
  const columnIndex = localFilterDraft.value?.columnIndex;
  if (columnIndex === undefined) return [];
  return buildLocalFilterOptions(columnIndex);
});

const localFilterOptions = computed(() => {
  if (localFilterDraft.value?.mode === "server") return serverFilterOptions.value;
  const query = localFilterSearch.value.trim().toLowerCase();
  return localFilterAllOptions.value.filter((option) => !query || option.label.toLowerCase().includes(query)).slice(0, 500);
});

const localFilterAllVisibleSelected = computed(() => {
  const draft = localFilterDraft.value;
  if (!draft || localFilterOptions.value.length === 0) return false;
  return localFilterOptions.value.every((option) => draft.values.has(option.key));
});

const localFilterTypedValue = computed(() => localFilterSearch.value.trim());

const localFilterDraftIsAllSelected = computed(() => {
  const draft = localFilterDraft.value;
  if (!draft) return false;
  const allKeys = localFilterAllOptions.value.map((option) => option.key);
  return allKeys.length > 0 && allKeys.every((key) => draft.values.has(key));
});

const canApplyTypedLocalFilterValue = computed(() => {
  const draft = localFilterDraft.value;
  const typed = localFilterTypedValue.value;
  if (!draft || !typed || !canUseWhereSearch.value) return false;
  const normalized = typed.toLowerCase();
  return !localFilterAllOptions.value.some((option) => option.label.toLowerCase() === normalized);
});

function openLocalFilter(colIdx: number, requestedMode: LocalFilterMode = "local") {
  localFilterSearch.value = "";
  const mode: LocalFilterMode = requestedMode === "server" && canUseServerColumnFilter.value ? "server" : "local";
  const allKeys = mode === "server" ? [] : buildLocalFilterOptions(colIdx).map((option) => option.key);
  localFilterDraft.value = {
    columnIndex: colIdx,
    values: new Set(mode === "server" ? allKeys : (localColumnFilters.value[colIdx] ?? allKeys)),
    mode,
    touched: false,
  };
  localFilterOpenColumn.value = colIdx;
  if (mode === "server") {
    resetServerFilterState();
    void loadServerFilterValues(colIdx, "");
  } else {
    resetServerFilterState();
  }
}

function resetServerFilterState() {
  serverFilterRequestId++;
  if (serverFilterSearchTimer !== undefined) {
    window.clearTimeout(serverFilterSearchTimer);
    serverFilterSearchTimer = undefined;
  }
  serverFilterLoading.value = false;
  serverFilterError.value = "";
  serverFilterOptions.value = [];
  serverFilterLimited.value = false;
  serverFilterValueByKey.value = new Map();
}

function serverFilterOptionFromRow(row: QueryResult["rows"][number], columnIndex: number): LocalFilterOption {
  const value = (row[0] ?? null) as CellValue;
  const countValue = Number(row[1]);
  const count = Number.isFinite(countValue) ? countValue : null;
  return {
    key: localFilterKey(value),
    label: localFilterLabel(value, columnIndex),
    count,
    value,
  };
}

function serverFilterOptionsFromResult(result: QueryResult, columnIndex: number): LocalFilterOption[] {
  const byKey = new Map<string, LocalFilterOption>();
  for (const row of result.rows) {
    const option = serverFilterOptionFromRow(row, columnIndex);
    const current = byKey.get(option.key);
    if (current) {
      current.count = (current.count ?? 0) + (option.count ?? 0);
    } else {
      byKey.set(option.key, option);
    }
  }
  return [...byKey.values()];
}

function syncServerFilterDraft(columnIndex: number, options: LocalFilterOption[]) {
  const draft = localFilterDraft.value;
  if (!draft || draft.mode !== "server" || draft.columnIndex !== columnIndex) return;
  if (draft.touched) return;
  localFilterDraft.value = {
    ...draft,
    values: new Set(options.map((option) => option.key)),
  };
}

async function loadServerFilterValues(columnIndex: number, searchValue: string) {
  if (!canUseServerColumnFilter.value || !props.connectionId) return;
  const columnName = props.result.columns[columnIndex];
  if (!columnName) return;
  const requestId = ++serverFilterRequestId;
  serverFilterLoading.value = true;
  serverFilterError.value = "";
  serverFilterLimited.value = false;
  try {
    const tableMeta = await waitForTableMeta();
    if (!tableMeta) return;
    const columnInfo = tableMeta.columns.find((column) => column.name === columnName);
    const sql = await buildDataGridColumnDistinctValuesSql({
      databaseType: resolvedDatabaseType.value,
      catalog: tableMeta.catalog,
      schema: tableMeta.schema,
      tableName: tableMeta.tableName,
      columnName,
      columnInfo,
      whereInput: currentWhereInput(),
      searchValue: searchValue.trim() || undefined,
      limit: SERVER_COLUMN_FILTER_LIMIT,
      includeCounts: true,
    });
    const result = await api.executeQuery(props.connectionId, props.executionDatabase ?? props.database ?? "", sql, tableMeta.schema ?? props.schema, undefined, {
      maxRows: SERVER_COLUMN_FILTER_LIMIT,
      fetchSize: SERVER_COLUMN_FILTER_LIMIT,
      pageSize: SERVER_COLUMN_FILTER_LIMIT,
    });
    if (requestId !== serverFilterRequestId || localFilterOpenColumn.value !== columnIndex) return;
    const options = serverFilterOptionsFromResult(result, columnIndex);
    const nextValueByKey = new Map(serverFilterValueByKey.value);
    for (const option of options) nextValueByKey.set(option.key, option.value);
    serverFilterValueByKey.value = nextValueByKey;
    serverFilterOptions.value = options;
    serverFilterLimited.value = result.truncated === true || result.rows.length >= SERVER_COLUMN_FILTER_LIMIT;
    syncServerFilterDraft(columnIndex, options);
  } catch (e: any) {
    if (requestId !== serverFilterRequestId) return;
    serverFilterOptions.value = [];
    serverFilterError.value = String(e?.message || e);
  } finally {
    if (requestId === serverFilterRequestId) {
      serverFilterLoading.value = false;
    }
  }
}

function guardHeaderPanelDismiss() {
  headerPanelDismissGuardUntil.value = Date.now() + 350;
}

function shouldIgnoreHeaderPanelClose(columnIndex: number, openColumn: number | null): boolean {
  return compactColumnHeaderActions.value && openColumn === columnIndex && Date.now() < headerPanelDismissGuardUntil.value;
}

function openCompactLocalFilter(colIdx: number, mode: LocalFilterMode = "local") {
  headerActionMenuOpenColumn.value = null;
  guardHeaderPanelDismiss();
  nextTick(() => {
    window.setTimeout(() => {
      guardHeaderPanelDismiss();
      openLocalFilter(colIdx, mode);
    }, 0);
  });
}

function compactColumnActionMenuItems(columnName: string) {
  return [
    {
      label: t("grid.columnFormatter"),
      value: "formatter",
      icon: Code2,
      disabled: !formatterKeyForColumn(columnName),
    },
    {
      label: t("grid.localFilter"),
      value: "localFilter",
      icon: Filter,
    },
    ...(canUseServerColumnFilter.value
      ? [
          {
            label: t("grid.databaseValueFilter"),
            value: "serverFilter",
            icon: Database,
          },
        ]
      : []),
  ];
}

function columnFilterPanelTitle(columnName: string): string {
  return localFilterDraft.value?.mode === "server" ? t("grid.databaseValueFilterFor", { column: columnName }) : t("grid.localFilterFor", { column: columnName });
}

function selectCompactColumnAction(value: string, columnIndex: number) {
  if (value === "formatter") {
    openCompactColumnFormatter(columnIndex);
  } else if (value === "localFilter") {
    openCompactLocalFilter(columnIndex, "local");
  } else if (value === "serverFilter") {
    openCompactLocalFilter(columnIndex, "server");
  }
}

function handleLocalFilterOpenChange(value: boolean, columnIndex: number) {
  if (value) {
    openLocalFilter(columnIndex, "local");
  } else if (!shouldIgnoreHeaderPanelClose(columnIndex, localFilterOpenColumn.value)) {
    closeLocalFilter();
  }
}

function closeLocalFilter() {
  localFilterOpenColumn.value = null;
  localFilterDraft.value = null;
  localFilterSearch.value = "";
  resetServerFilterState();
}

function formatterKeyForColumn(column: string): string | null {
  if (!props.connectionId || !props.tableMeta) return null;
  return buildColumnFormatterKey({
    connectionId: props.connectionId,
    database: props.database,
    schema: props.tableMeta.schema,
    tableName: props.tableMeta.tableName,
    column,
  });
}

function columnFormatter(columnIndex: number): ColumnFormatterConfig | undefined {
  const column = props.result.columns[columnIndex];
  if (!column) return undefined;
  const key = formatterKeyForColumn(column);
  return key ? resolveColumnFormatter(settingsStore.editorSettings.columnFormatters[key], settingsStore.editorSettings.customColumnFormatters) : undefined;
}

function savedColumnFormatter(columnIndex: number): ColumnFormatterConfig | undefined {
  const column = props.result.columns[columnIndex];
  if (!column) return undefined;
  const key = formatterKeyForColumn(column);
  return key ? settingsStore.editorSettings.columnFormatters[key] : undefined;
}

function columnHasFormatter(columnIndex: number): boolean {
  return !!columnFormatter(columnIndex);
}

function currentFormatterDraft(): ColumnFormatterConfig {
  if (formatterKind.value === "json-path") {
    return { kind: "json-path", path: formatterJsonPath.value.trim() || "$" };
  }
  if (formatterKind.value === "mask") {
    return {
      kind: "mask",
      prefix: Math.max(0, Math.floor(Number(formatterMaskPrefix.value) || 0)),
      suffix: Math.max(0, Math.floor(Number(formatterMaskSuffix.value) || 0)),
    };
  }
  if (formatterKind.value === "custom-template") {
    return { kind: "custom-template", template: formatterCustomTemplate.value.trim() || "${value}" };
  }
  return { kind: "datetime", unit: formatterDateUnit.value, pattern: formatterDatetimePattern.value };
}

function loadFormatterDraft(formatter: ColumnFormatterConfig | undefined) {
  const draft = formatter ?? { kind: "datetime", unit: "auto" as const, pattern: "YYYY-MM-DD HH:mm:ss" as const };
  formatterKind.value = draft.kind === "custom-ref" ? "custom-template" : draft.kind;
  if (draft.kind === "datetime") {
    formatterDateUnit.value = draft.unit;
    formatterDatetimePattern.value = draft.pattern;
  } else if (draft.kind === "json-path") {
    formatterJsonPath.value = draft.path;
  } else if (draft.kind === "mask") {
    formatterMaskPrefix.value = draft.prefix;
    formatterMaskSuffix.value = draft.suffix;
  } else if (draft.kind === "custom-ref") {
    const saved = settingsStore.editorSettings.customColumnFormatters[draft.formatterId];
    formatterCustomId.value = saved ? saved.id : CUSTOM_FORMATTER_NEW;
    formatterCustomName.value = saved?.name ?? "";
    formatterCustomTemplate.value = saved?.template ?? "${value}";
  } else if (draft.kind === "custom-template") {
    formatterCustomId.value = CUSTOM_FORMATTER_NEW;
    formatterCustomName.value = "";
    formatterCustomTemplate.value = draft.template;
  }
}

function openColumnFormatter(columnIndex: number) {
  loadFormatterDraft(savedColumnFormatter(columnIndex));
  formatterOpenColumn.value = columnIndex;
}

function openCompactColumnFormatter(columnIndex: number) {
  headerActionMenuOpenColumn.value = null;
  guardHeaderPanelDismiss();
  nextTick(() => {
    window.setTimeout(() => {
      guardHeaderPanelDismiss();
      openColumnFormatter(columnIndex);
    }, 0);
  });
}

function closeColumnFormatter() {
  formatterOpenColumn.value = null;
}

function handleColumnFormatterOpenChange(value: boolean, columnIndex: number) {
  if (value) {
    openColumnFormatter(columnIndex);
  } else if (!shouldIgnoreHeaderPanelClose(columnIndex, formatterOpenColumn.value)) {
    closeColumnFormatter();
  }
}

function saveColumnFormatter(columnIndex: number) {
  const column = props.result.columns[columnIndex];
  const key = column ? formatterKeyForColumn(column) : null;
  if (!key) return;
  let formatter = currentFormatterDraft();
  if (formatterKind.value === "custom-template" && formatterCustomName.value.trim()) {
    const id = formatterCustomId.value === CUSTOM_FORMATTER_NEW ? createCustomFormatterId() : formatterCustomId.value;
    const saved = settingsStore.upsertCustomColumnFormatter({
      id,
      name: formatterCustomName.value,
      template: formatterCustomTemplate.value,
    });
    if (saved) formatter = { kind: "custom-ref", formatterId: saved.id };
  }
  settingsStore.updateColumnFormatter(key, formatter);
  closeColumnFormatter();
}

function clearColumnFormatter(columnIndex: number) {
  const column = props.result.columns[columnIndex];
  const key = column ? formatterKeyForColumn(column) : null;
  if (!key) return;
  settingsStore.updateColumnFormatter(key, undefined);
  closeColumnFormatter();
}

function formatterDraftIsSavable(): boolean {
  return !!normalizeColumnFormatter(currentFormatterDraft());
}

function selectCustomFormatter(value: string) {
  formatterCustomId.value = value;
  if (value === CUSTOM_FORMATTER_NEW) {
    formatterCustomName.value = "";
    formatterCustomTemplate.value = "${value}";
    return;
  }
  const saved = settingsStore.editorSettings.customColumnFormatters[value];
  if (!saved) return;
  formatterCustomName.value = saved.name;
  formatterCustomTemplate.value = saved.template;
}

function createCustomFormatterId(): string {
  return `fmt_${uuid()}`;
}

function formatterPreviewRows(columnIndex: number) {
  const formatter = resolveColumnFormatter(currentFormatterDraft(), settingsStore.editorSettings.customColumnFormatters);
  return displayRowRefs.value.slice(0, 5).map((_, index) => {
    const item = displayItemAt(index);
    const value = item?.data[columnIndex] ?? null;
    return {
      index: index + 1,
      raw: displayCellValue(value),
      formatted: applyColumnFormatter(value, formatter),
    };
  });
}

function toggleLocalFilterValue(key: string) {
  const draft = localFilterDraft.value;
  if (!draft) return;
  const next = new Set(draft.values);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  localFilterDraft.value = { ...draft, values: next, touched: true };
}

function toggleAllLocalFilterOptions() {
  const draft = localFilterDraft.value;
  if (!draft) return;
  const visibleKeys = localFilterOptions.value.map((option) => option.key);
  const next = new Set(draft.values);
  if (localFilterAllVisibleSelected.value) {
    visibleKeys.forEach((key) => next.delete(key));
  } else {
    visibleKeys.forEach((key) => next.add(key));
  }
  localFilterDraft.value = { ...draft, values: next, touched: true };
}

async function applyLocalFilter() {
  const draft = localFilterDraft.value;
  if (!draft) return;
  if (draft.mode === "server") {
    await applyServerColumnFilter(draft);
    return;
  }
  if (canApplyTypedLocalFilterValue.value && localFilterDraftIsAllSelected.value && localFilterOptions.value.length === 0) {
    await applyTypedLocalFilterValue();
    return;
  }
  const allKeys = new Set(localFilterAllOptions.value.map((option) => option.key));
  const next = { ...localColumnFilters.value };
  let selected = draft.values;
  if (localFilterSearch.value.trim()) {
    const visibleKeys = new Set(localFilterOptions.value.map((o) => o.key));
    selected = new Set([...draft.values].filter((k) => visibleKeys.has(k)));
  }
  if (selected.size === 0 || selected.size === allKeys.size) {
    delete next[draft.columnIndex];
  } else {
    next[draft.columnIndex] = new Set(selected);
  }
  localColumnFilters.value = next;
  closeLocalFilter();
  resetGridVerticalScroll();
}

async function applyServerColumnFilter(draft: LocalColumnFilterDraft) {
  if (!draft.touched && !localFilterSearch.value.trim()) {
    closeLocalFilter();
    return;
  }
  if (canApplyTypedLocalFilterValue.value && serverFilterOptions.value.length === 0) {
    await applyTypedLocalFilterValue();
    return;
  }
  const columnName = props.result.columns[draft.columnIndex];
  if (!columnName) return;
  const values = [...draft.values].flatMap((key) => {
    if (!serverFilterValueByKey.value.has(key)) return [];
    return [serverFilterValueByKey.value.get(key)!];
  });
  if (values.length === 0) {
    closeLocalFilter();
    return;
  }
  const condition = await buildColumnValuesFilterCondition({
    databaseType: resolvedDatabaseType.value,
    columnName,
    columnInfo: props.tableMeta?.columns.find((column) => column.name === columnName),
    values,
  });
  if (!condition) return;
  const next = { ...localColumnFilters.value };
  delete next[draft.columnIndex];
  localColumnFilters.value = next;
  whereFilterInput.value = appendColumnValueFilterCondition(whereFilterInput.value, condition);
  closeLocalFilter();
  await applyWhereFilter();
}

async function applyTypedLocalFilterValue() {
  const draft = localFilterDraft.value;
  if (!draft) return;
  const columnName = props.result.columns[draft.columnIndex];
  if (!columnName) return;
  const condition = await buildColumnValueFilterCondition({
    databaseType: resolvedDatabaseType.value,
    columnName,
    columnInfo: props.tableMeta?.columns.find((column) => column.name === columnName),
    rawValue: localFilterTypedValue.value,
  });
  if (!condition) return;
  const next = { ...localColumnFilters.value };
  delete next[draft.columnIndex];
  localColumnFilters.value = next;
  whereFilterInput.value = appendColumnValueFilterCondition(whereFilterInput.value, condition);
  closeLocalFilter();
  await applyWhereFilter();
}

function clearLocalFilter(colIdx?: number) {
  if (colIdx === undefined) {
    localColumnFilters.value = {};
  } else {
    const next = { ...localColumnFilters.value };
    delete next[colIdx];
    localColumnFilters.value = next;
  }
  closeLocalFilter();
  resetGridVerticalScroll();
}

watch(localFilterSearch, (value) => {
  const draft = localFilterDraft.value;
  if (!draft || draft.mode !== "server" || localFilterOpenColumn.value !== draft.columnIndex) return;
  if (serverFilterSearchTimer !== undefined) {
    window.clearTimeout(serverFilterSearchTimer);
  }
  serverFilterSearchTimer = window.setTimeout(() => {
    void loadServerFilterValues(draft.columnIndex, value);
  }, SERVER_COLUMN_FILTER_DEBOUNCE_MS);
});

function defaultStructuredFilterRule(): StructuredFilterRule {
  return {
    id: uuid(),
    columnName: filterBuilderColumnOptions.value[0] ?? "",
    mode: "equals",
    rawValue: "",
    conjunction: "AND",
  };
}

function cloneStructuredFilterRules(rules: StructuredFilterRule[]): StructuredFilterRule[] {
  return rules.map((rule) => ({ ...rule }));
}

function cachedStructuredFilterState(): StructuredFilterCacheState | undefined {
  const cached = structuredFilterStateCache.get(structuredFilterCacheKey.value);
  return cached?.scopeKey === structuredFilterScopeKey.value ? cached : undefined;
}

async function buildStructuredWhereFromRules(rules: StructuredFilterRule[]): Promise<string> {
  const rulesWithConditions = (
    await Promise.all(
      rules.map(async (rule) => {
        if (rule.disabled) return { rule, condition: null };
        if (!rule.columnName) return { rule, condition: null };
        if (filterModeNeedsValue(rule.mode) && !rule.rawValue.trim()) return { rule, condition: null };
        const columnInfo = filterBuilderColumns.value.find((column) => column.name === rule.columnName);
        return {
          rule,
          condition:
            (await buildDataGridContextFilterCondition({
              databaseType: resolvedDatabaseType.value,
              columnName: rule.columnName,
              columnInfo,
              mode: rule.mode,
              value: filterModeNeedsValue(rule.mode) ? parseFilterValue(rule.rawValue, columnInfo) : null,
            })) ?? null,
        };
      }),
    )
  ).filter((item): item is { rule: StructuredFilterRule; condition: string } => !!item.condition);

  return buildGroupedWhere(
    rulesWithConditions.map((item) => item.condition),
    rulesWithConditions.map((item) => item.rule),
  );
}

function persistStructuredFilterState() {
  structuredFilterStateCache.set(structuredFilterCacheKey.value, {
    scopeKey: structuredFilterScopeKey.value,
    manualWhereInput: whereFilterInput.value,
    rules: cloneStructuredFilterRules(structuredFilterRules.value),
    appliedWhereInput: appliedStructuredWhereInput.value,
  });
}

function loadStructuredFilterStateForScope() {
  const cached = cachedStructuredFilterState();
  if (cached) {
    const cacheKey = structuredFilterCacheKey.value;
    const scopeKey = structuredFilterScopeKey.value;
    structuredFilterRules.value = cloneStructuredFilterRules(cached.rules);
    whereFilterInput.value = cached.manualWhereInput;
    appliedStructuredWhereInput.value = "";
    void buildStructuredWhereFromRules(structuredFilterRules.value).then((whereInput) => {
      if (structuredFilterCacheKey.value !== cacheKey || structuredFilterScopeKey.value !== scopeKey) return;
      appliedStructuredWhereInput.value = whereInput;
      nextTick(() => emit("update:whereInput", currentWhereInput() ?? ""));
    });
    return;
  }
  appliedStructuredWhereInput.value = "";
  structuredFilterRules.value = filterBuilderColumnOptions.value.length > 0 ? [defaultStructuredFilterRule()] : [];
  persistStructuredFilterState();
}

function ensureStructuredFilterRule() {
  if (structuredFilterRules.value.length === 0 && filterBuilderColumnOptions.value.length > 0) {
    structuredFilterRules.value = [defaultStructuredFilterRule()];
  }
}

function openStructuredFilterFromExpandedWhere() {
  collapseConditionInput("where");
  ensureStructuredFilterRule();
  filterBuilderOpen.value = true;
}

function addStructuredFilterRule() {
  ensureStructuredFilterRule();
  structuredFilterRules.value = [...structuredFilterRules.value, defaultStructuredFilterRule()];
}

function removeStructuredFilterRule(ruleId: string) {
  structuredFilterRules.value = structuredFilterRules.value.filter((rule) => rule.id !== ruleId);
  if (structuredFilterRules.value.length === 0) {
    appliedStructuredWhereInput.value = "";
  }
}

function updateStructuredFilterRule(ruleId: string, patch: Partial<StructuredFilterRule>) {
  structuredFilterRules.value = structuredFilterRules.value.map((rule) => {
    if (rule.id !== ruleId) return rule;
    const next = { ...rule, ...patch };
    if (!filterModeNeedsValue(next.mode)) next.rawValue = "";
    return next;
  });
}

function updateStructuredFilterRuleColumn(ruleId: string, columnName: string) {
  updateStructuredFilterRule(ruleId, { columnName });
  filterBuilderColumnSearch.value = "";
}

function handleFilterBuilderColumnSearchKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.key === "Process") {
    event.stopPropagation();
    return;
  }
  if (filterBuilderColumnSearchNavigationKeys.has(event.key)) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete") {
    // Let text editing stay in the search box without breaking Select navigation keys.
    event.stopPropagation();
  }
}

function resetStructuredFilters() {
  appliedStructuredWhereInput.value = "";
  structuredFilterRules.value = filterBuilderColumnOptions.value.length > 0 ? [defaultStructuredFilterRule()] : [];
}

async function clearAllFilters() {
  whereFilterInput.value = "";
  resetStructuredFilters();
  clearLocalFilter();
  if (canUseWhereSearch.value) await applyWhereFilter();
}

function buildGroupedWhere(conditions: string[], rules: StructuredFilterRule[]): string {
  if (conditions.length === 0) return "";
  if (conditions.length === 1) return conditions[0];

  const groups: { conditions: string[]; conjunction: string }[] = [];
  let current = { conditions: [conditions[0]], conjunction: "AND" };

  for (let i = 1; i < conditions.length; i++) {
    const conj = rules[i].conjunction;
    if (conj !== current.conjunction) {
      groups.push(current);
      current = { conditions: [conditions[i]], conjunction: conj };
    } else {
      current.conditions.push(conditions[i]);
    }
  }
  groups.push(current);

  if (groups.length === 1) {
    const g = groups[0];
    return g.conditions.length > 1 ? `(${g.conditions.join(` ${g.conjunction} `)})` : g.conditions[0];
  }

  const groupClauses = groups.map((g) => {
    const inner = g.conditions.join(` ${g.conjunction} `);
    return g.conditions.length > 1 ? `(${inner})` : inner;
  });

  let result = groupClauses[0];
  for (let i = 1; i < groupClauses.length; i++) {
    result = `(${result}) ${groups[i].conjunction} (${groupClauses[i]})`;
  }
  return result;
}

async function applyStructuredFilters() {
  if (!canUseWhereSearch.value) return;
  appliedStructuredWhereInput.value = await buildStructuredWhereFromRules(structuredFilterRules.value);
  filterBuilderOpen.value = false;
  await applyWhereFilter();
}

watch([structuredFilterCacheKey, structuredFilterScopeKey], loadStructuredFilterStateForScope, { immediate: true });

watch(filterBuilderOpen, (open) => {
  if (!open) filterBuilderColumnSearch.value = "";
});

watch(
  [structuredFilterRules, appliedStructuredWhereInput],
  () => {
    const columns = filterBuilderColumnOptions.value;
    if (columns.length > 0 && structuredFilterRules.value.some((rule) => !columns.includes(rule.columnName))) {
      structuredFilterRules.value = structuredFilterRules.value.map((rule) => (columns.includes(rule.columnName) ? rule : { ...rule, columnName: columns[0] ?? "" }));
      return;
    }
    persistStructuredFilterState();
  },
  { deep: true },
);

function updateSuggestionPosition() {
  nextTick(() => {
    const input = searchInputRef.value;
    const measure = measureRef.value;
    if (!input || !measure) return;
    const cursorPos = input.selectionStart ?? 0;
    measure.textContent = searchText.value.slice(0, cursorPos);
    suggestionLeft.value = measure.getBoundingClientRect().width;
  });
}

watch(searchText, (val) => {
  searchSuggestions.value = [];
  if (!props.tableMeta?.columns?.length) return;

  const trimmed = val.trim();
  if (trimmed.length === 0) return;

  const lastToken = trimmed.split(/[\s,()><=!&|]+/).pop() || "";
  if (lastToken.length > 0) {
    const tl = lastToken.toLowerCase();
    searchSuggestions.value = props.tableMeta.columns
      .map((c) => c.name)
      .filter((n) => n.toLowerCase().startsWith(tl) && n.toLowerCase() !== tl)
      .slice(0, 8);
    suggestionIndex.value = 0;
    updateSuggestionPosition();
  }
});

function acceptSuggestion() {
  const idx = suggestionIndex.value;
  if (idx < 0 || idx >= searchSuggestions.value.length) return;
  const sug = searchSuggestions.value[idx];

  const lastWordMatch = searchText.value.match(/([^\s,()><=!&|]+)$/);
  if (lastWordMatch) {
    const lastWord = lastWordMatch[1];
    const prefix = searchText.value.slice(0, -lastWord.length);
    searchText.value = prefix + sug;
  }
  searchSuggestions.value = [];
  suggestionIndex.value = -1;
  searchInputRef.value?.focus();
}

function dismissSuggestions() {
  searchSuggestions.value = [];
  suggestionIndex.value = -1;
}

function navigateSuggestion(delta: number) {
  if (searchSuggestions.value.length === 0) return;
  suggestionIndex.value = Math.min(Math.max(suggestionIndex.value + delta, 0), searchSuggestions.value.length - 1);
}

function focusSearch(): boolean {
  searchOverlayVisible.value = true;
  nextTick(() => {
    const input = searchInputRef.value;
    if (!input) return;
    input.focus();
    input.select();
    updateSuggestionPosition();
  });
  return true;
}

function closeSearch() {
  searchOverlayVisible.value = false;
  searchText.value = "";
  searchSuggestions.value = [];
}

const PAIRS: Record<string, string> = { "'": "'", '"': '"', "(": ")" };

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key in PAIRS && !e.ctrlKey && !e.metaKey) {
    const input = e.target as HTMLInputElement;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    const close = PAIRS[e.key];

    if (start !== end) {
      // Wrap selection: 'text' → 'text'
      e.preventDefault();
      const selected = searchText.value.slice(start, end);
      searchText.value = searchText.value.slice(0, start) + e.key + selected + close + searchText.value.slice(end);
      nextTick(() => {
        input.setSelectionRange(start + 1 + selected.length, start + 1 + selected.length);
      });
      suggestionIndex.value = -1;
      return;
    }

    if (e.key === close && searchText.value[start] === close) {
      // Cursor before matching close char → skip over it (only for quotes)
      e.preventDefault();
      input.setSelectionRange(start + 1, start + 1);
      return;
    }

    e.preventDefault();
    searchText.value = searchText.value.slice(0, start) + e.key + close + searchText.value.slice(end);
    nextTick(() => {
      input.setSelectionRange(start + 1, start + 1);
    });
    suggestionIndex.value = -1;
    return;
  }

  if (searchSuggestions.value.length > 0) {
    if (e.key === "Tab") {
      e.preventDefault();
      acceptSuggestion();
      return;
    }
    if (isCancelSearchShortcut(e)) {
      e.preventDefault();
      dismissSuggestions();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateSuggestion(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateSuggestion(-1);
      return;
    }
  }
  if (isCancelSearchShortcut(e)) {
    e.preventDefault();
    closeSearch();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    navigateMatch(e.shiftKey ? -1 : 1);
  }
}

// --- WHERE filter input suggestions ---
function updateWhereSuggestionPosition() {
  nextTick(() => {
    const input = conditionEditorRef("where");
    if (!input) return;
    const inputRect = input.getBoundingClientRect();
    whereSuggestionPosition.value = getDataGridConditionSuggestionPosition(inputRect, { viewportWidth: window.innerWidth });
  });
}

function acceptWhereSuggestion() {
  const idx = whereSuggestionIndex.value;
  if (idx < 0 || idx >= whereSuggestions.value.length) return;
  const sug = whereSuggestions.value[idx];
  if (sug.kind === "history") {
    whereFilterInput.value = sug.value;
    whereSuggestions.value = [];
    whereSuggestionIndex.value = -1;
    whereHistoryMenuOpen.value = false;
    conditionEditorRef("where")?.focus();
    return;
  }
  const lastWordMatch = whereFilterInput.value.match(/([^\s,()><=!&|]+)$/);
  if (lastWordMatch) {
    const lastWord = lastWordMatch[1];
    const prefix = whereFilterInput.value.slice(0, -lastWord.length);
    whereFilterInput.value = prefix + sug.value;
  }
  whereSuggestions.value = [];
  whereSuggestionIndex.value = -1;
  whereHistoryMenuOpen.value = false;
  conditionEditorRef("where")?.focus();
}

function dismissWhereSuggestions() {
  whereSuggestions.value = [];
  whereSuggestionIndex.value = -1;
  whereHistoryMenuOpen.value = false;
  hideConditionHistoryPreview();
}

function eventTargetInside(event: Event, ...elements: Array<HTMLElement | undefined>): boolean {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const target = event.target instanceof Node ? event.target : null;
  return elements.some((element) => element && (path.includes(element) || (target ? element.contains(target) : false)));
}

function onConditionSuggestionDocumentPointerDown(event: PointerEvent) {
  const whereExpandedPane = whereFilterOverlayRef.value?.parentElement ?? undefined;
  const orderByExpandedPane = orderByOverlayRef.value?.parentElement ?? undefined;
  if (!eventTargetInside(event, whereFilterInputRef.value, whereFilterOverlayRef.value, whereConditionPaneRef.value, whereExpandedPane, whereSuggestionDropdownRef.value)) {
    dismissWhereSuggestions();
  }
  if (!eventTargetInside(event, orderByInputRef.value, orderByOverlayRef.value, orderByConditionPaneRef.value, orderByExpandedPane, orderBySuggestionDropdownRef.value)) {
    dismissOrderBySuggestions();
  }
}

function navigateWhereSuggestion(delta: number) {
  if (whereSuggestions.value.length === 0) return;
  if (whereSuggestionIndex.value < 0) {
    whereSuggestionIndex.value = delta > 0 ? 0 : whereSuggestions.value.length - 1;
    return;
  }
  whereSuggestionIndex.value = Math.min(Math.max(whereSuggestionIndex.value + delta, 0), whereSuggestions.value.length - 1);
}

function openWhereHistoryMenu() {
  if (showWhereSuggestionDropdown.value) {
    dismissWhereSuggestions();
    return;
  }
  conditionEditorRef("where")?.focus();
  whereHistoryMenuOpen.value = true;
  const history = loadDataGridConditionHistory("where", conditionHistoryScope.value);
  whereSuggestions.value = history.map((value) => ({ value, kind: "history" }));
  whereSuggestionIndex.value = -1;
  updateWhereSuggestionPosition();
}

function clearWhereFilterInput() {
  suppressWhereHistoryOnNextEmptyInput = true;
  whereFilterInput.value = "";
  dismissWhereSuggestions();
  void applyWhereFilter();
}

function deleteWhereHistorySuggestion(value: string) {
  const history = forgetDataGridConditionHistory("where", conditionHistoryScope.value, value);
  whereSuggestions.value = history.map((item) => ({ value: item, kind: "history" }));
  whereSuggestionIndex.value = whereSuggestions.value.length ? Math.min(whereSuggestionIndex.value, whereSuggestions.value.length - 1) : -1;
  whereHistoryMenuOpen.value = true;
  updateWhereSuggestionPosition();
}

function onWhereFilterInput(event: Event) {
  const input = event.target instanceof HTMLTextAreaElement ? event.target : null;
  if (!input) return;
  suppressNextWhereWatchResize = true;
  const nextValue = normalizeConditionInputValue(input.value);
  if (nextValue !== input.value) {
    whereFilterInput.value = nextValue;
    previousWhereFilterInputValue = nextValue;
    nextTick(() => input.setSelectionRange(nextValue.length, nextValue.length));
    resizeConditionInput("where", { expandFromFocus: true, focusOverlay: true, immediateHeight: true });
    return;
  }
  if (
    insertedSqlSingleQuoteAtCaret({
      previousValue: previousWhereFilterInputValue,
      nextValue,
      selectionStart: input.selectionStart,
    })
  ) {
    const caret = input.selectionStart ?? nextValue.length;
    const pairedValue = `${nextValue.slice(0, caret)}'${nextValue.slice(caret)}`;
    whereFilterInput.value = pairedValue;
    previousWhereFilterInputValue = pairedValue;
    nextTick(() => input.setSelectionRange(caret, caret));
    resizeConditionInput("where", { expandFromFocus: true, focusOverlay: true, immediateHeight: true });
    return;
  }
  const nextCaret = caretPositionInsideInsertedSqlSingleQuotes({
    previousValue: previousWhereFilterInputValue,
    nextValue,
    selectionStart: input.selectionStart,
  });
  previousWhereFilterInputValue = nextValue;
  resizeConditionInput("where", { expandFromFocus: true, focusOverlay: true, immediateHeight: true });
  if (nextCaret == null) return;
  nextTick(() => input.setSelectionRange(nextCaret, nextCaret));
}

watch(whereFilterInput, (val) => {
  emit("update:whereInput", currentWhereInput() ?? "");
  persistStructuredFilterState();
  previousWhereFilterInputValue = val;
  if (suppressNextWhereWatchResize) {
    suppressNextWhereWatchResize = false;
  } else {
    resizeConditionInput("where");
  }
  whereSuggestions.value = [];
  whereHistoryMenuOpen.value = false;
  const trimmed = val.trim();
  if (trimmed.length === 0) {
    if (suppressWhereHistoryOnNextEmptyInput) {
      suppressWhereHistoryOnNextEmptyInput = false;
    }
    return;
  }
  suppressWhereHistoryOnNextEmptyInput = false;
  if (!props.tableMeta?.columns?.length) return;
  const lastToken = trimmed.split(/[\s,()><=!&|]+/).pop() || "";
  if (lastToken.length > 0) {
    const tl = lastToken.toLowerCase();
    whereSuggestions.value = props.tableMeta.columns
      .map((c) => c.name)
      .filter((n) => n.toLowerCase().startsWith(tl) && n.toLowerCase() !== tl)
      .slice(0, 8)
      .map((value) => ({ value, kind: "column" }));
    whereSuggestionIndex.value = 0;
    updateWhereSuggestionPosition();
  }
});

function onWhereFilterKeydown(e: KeyboardEvent) {
  if (e.key in PAIRS && !e.ctrlKey && !e.metaKey) {
    const input = e.target as HTMLTextAreaElement;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    const close = PAIRS[e.key];
    if (start !== end) {
      e.preventDefault();
      const selected = whereFilterInput.value.slice(start, end);
      whereFilterInput.value = whereFilterInput.value.slice(0, start) + e.key + selected + close + whereFilterInput.value.slice(end);
      nextTick(() => {
        input.setSelectionRange(start + 1 + selected.length, start + 1 + selected.length);
      });
      whereSuggestionIndex.value = -1;
      return;
    }
    if (e.key === close && whereFilterInput.value[start] === close) {
      e.preventDefault();
      input.setSelectionRange(start + 1, start + 1);
      return;
    }
    e.preventDefault();
    whereFilterInput.value = whereFilterInput.value.slice(0, start) + e.key + close + whereFilterInput.value.slice(end);
    nextTick(() => {
      input.setSelectionRange(start + 1, start + 1);
    });
    whereSuggestionIndex.value = -1;
    return;
  }
  if (whereSuggestions.value.length > 0) {
    if (e.key === "Tab") {
      e.preventDefault();
      acceptWhereSuggestion();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dismissWhereSuggestions();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateWhereSuggestion(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateWhereSuggestion(-1);
      return;
    }
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (whereSuggestions.value.length > 0 && whereSuggestionIndex.value >= 0) {
      acceptWhereSuggestion();
      return;
    }
    applyWhereFilter();
  }
}

// --- ORDER BY input suggestions ---
function updateOrderBySuggestionPosition() {
  nextTick(() => {
    const input = conditionEditorRef("orderBy");
    if (!input) return;
    const inputRect = input.getBoundingClientRect();
    orderBySuggestionPosition.value = getDataGridConditionSuggestionPosition(inputRect, { viewportWidth: window.innerWidth });
  });
}

function acceptOrderBySuggestion() {
  const idx = orderBySuggestionIndex.value;
  if (idx < 0 || idx >= orderBySuggestions.value.length) return;
  const sug = orderBySuggestions.value[idx];
  if (sug.kind === "history") {
    orderByInput.value = sug.value;
    orderBySuggestions.value = [];
    orderBySuggestionIndex.value = -1;
    orderByHistoryMenuOpen.value = false;
    conditionEditorRef("orderBy")?.focus();
    return;
  }
  const lastWordMatch = orderByInput.value.match(/([^\s,()]+)$/);
  if (lastWordMatch) {
    const lastWord = lastWordMatch[1];
    const prefix = orderByInput.value.slice(0, -lastWord.length);
    orderByInput.value = prefix + sug.value;
  }
  orderBySuggestions.value = [];
  orderBySuggestionIndex.value = -1;
  orderByHistoryMenuOpen.value = false;
  conditionEditorRef("orderBy")?.focus();
}

function dismissOrderBySuggestions() {
  orderBySuggestions.value = [];
  orderBySuggestionIndex.value = -1;
  orderByHistoryMenuOpen.value = false;
  hideConditionHistoryPreview();
}

function navigateOrderBySuggestion(delta: number) {
  if (orderBySuggestions.value.length === 0) return;
  if (orderBySuggestionIndex.value < 0) {
    orderBySuggestionIndex.value = delta > 0 ? 0 : orderBySuggestions.value.length - 1;
    return;
  }
  orderBySuggestionIndex.value = Math.min(Math.max(orderBySuggestionIndex.value + delta, 0), orderBySuggestions.value.length - 1);
}

function openOrderByHistoryMenu() {
  if (showOrderBySuggestionDropdown.value) {
    dismissOrderBySuggestions();
    return;
  }
  conditionEditorRef("orderBy")?.focus();
  orderByHistoryMenuOpen.value = true;
  const history = loadDataGridConditionHistory("orderBy", conditionHistoryScope.value);
  orderBySuggestions.value = history.map((value) => ({ value, kind: "history" }));
  orderBySuggestionIndex.value = -1;
  updateOrderBySuggestionPosition();
}

function clearOrderByInput() {
  suppressOrderByHistoryOnNextEmptyInput = true;
  orderByInput.value = "";
  dismissOrderBySuggestions();
  void applyOrderBySearch();
}

function deleteOrderByHistorySuggestion(value: string) {
  const history = forgetDataGridConditionHistory("orderBy", conditionHistoryScope.value, value);
  orderBySuggestions.value = history.map((item) => ({ value: item, kind: "history" }));
  orderBySuggestionIndex.value = orderBySuggestions.value.length ? Math.min(orderBySuggestionIndex.value, orderBySuggestions.value.length - 1) : -1;
  orderByHistoryMenuOpen.value = true;
  updateOrderBySuggestionPosition();
}

watch(orderByInput, (val) => {
  emit("update:orderByInput", val);
  if (suppressNextOrderByWatchResize) {
    suppressNextOrderByWatchResize = false;
  } else {
    resizeConditionInput("orderBy");
  }
  orderBySuggestions.value = [];
  orderByHistoryMenuOpen.value = false;
  const trimmed = val.trim();
  if (trimmed.length === 0) {
    if (suppressOrderByHistoryOnNextEmptyInput) {
      suppressOrderByHistoryOnNextEmptyInput = false;
    }
    return;
  }
  suppressOrderByHistoryOnNextEmptyInput = false;
  if (!props.tableMeta?.columns?.length) return;
  const lastToken = trimmed.split(/[\s,()]+/).pop() || "";
  if (lastToken.length > 0 && !["asc", "desc"].includes(lastToken.toLowerCase())) {
    const tl = lastToken.toLowerCase();
    orderBySuggestions.value = props.tableMeta.columns
      .map((c) => c.name)
      .filter((n) => n.toLowerCase().startsWith(tl) && n.toLowerCase() !== tl)
      .slice(0, 8)
      .map((value) => ({ value, kind: "column" }));
    orderBySuggestionIndex.value = 0;
    updateOrderBySuggestionPosition();
  }
});

function onOrderByInput(event: Event) {
  const input = event.target instanceof HTMLTextAreaElement ? event.target : null;
  if (!input) return;
  suppressNextOrderByWatchResize = true;
  const nextValue = normalizeConditionInputValue(input.value);
  if (nextValue !== input.value) {
    orderByInput.value = nextValue;
    nextTick(() => input.setSelectionRange(nextValue.length, nextValue.length));
  }
  resizeConditionInput("orderBy", { expandFromFocus: true, focusOverlay: true, immediateHeight: true });
}

function onOrderByKeydown(e: KeyboardEvent) {
  if (orderBySuggestions.value.length > 0) {
    if (e.key === "Tab") {
      e.preventDefault();
      acceptOrderBySuggestion();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      dismissOrderBySuggestions();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateOrderBySuggestion(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateOrderBySuggestion(-1);
      return;
    }
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (orderBySuggestions.value.length > 0 && orderBySuggestionIndex.value >= 0) {
      acceptOrderBySuggestion();
      return;
    }
    applyOrderBySearch();
  }
}

const isApplyingWhere = ref(false);
const rowStatusFilter = ref<RowStatusFilter>("all");
const gridRef = ref<HTMLDivElement>();
const dataGridTopbarRef = ref<HTMLDivElement>();
const headerRef = ref<HTMLDivElement>();
const gridScrollbarGutter = ref(0);
const gridHorizontalScrollbarTrackRef = ref<HTMLDivElement>();
const gridHorizontalScrollbarThumbRef = ref<HTMLDivElement>();
const gridVerticalScrollbarTrackRef = ref<HTMLDivElement>();
const gridVerticalScrollbarThumbRef = ref<HTMLDivElement>();
const hasGridHorizontalOverflow = ref(false);
const hasGridVerticalOverflow = ref(false);
let gridHorizontalScrollbarThumbLeftPercent = 0;
let gridHorizontalScrollbarThumbWidthPercent = 100;
let gridVerticalScrollbarThumbTopPercent = 0;
let gridVerticalScrollbarThumbHeightPercent = 100;
let gridHorizontalScrollbarFrame = 0;
let gridHorizontalScrollbarDragFrame = 0;
let gridHorizontalScrollbarPendingClientX = 0;
let gridVerticalScrollbarDragFrame = 0;
let gridVerticalScrollbarPendingClientY = 0;
let gridHorizontalScrollbarResizeObserver: ResizeObserver | null = null;
let dataGridTopbarResizeObserver: ResizeObserver | null = null;
let cellEditResizeObserver: ResizeObserver | null = null;
let resetCellEditTextareaScrollOnResize = false;
let gridHorizontalScrollbarDragState: {
  scroller: HTMLElement;
  trackRect: DOMRect;
  thumbOffsetPx: number;
  maxScrollLeft: number;
} | null = null;
let gridVerticalScrollbarDragState: {
  scroller: HTMLElement;
  trackRect: DOMRect;
  thumbOffsetPx: number;
  maxScrollTop: number;
} | null = null;
const GRID_HORIZONTAL_SCROLLBAR_DRAGGING_CLASS = "data-grid-horizontal-scrollbar--dragging";
const GRID_VERTICAL_SCROLLBAR_DRAGGING_CLASS = "data-grid-vertical-scrollbar--dragging";
const hiddenColumnIndexes = ref<Set<number>>(new Set());
const nullColumnsHidden = ref(false);
const autoHiddenNullColumnIndexes = ref<Set<number>>(new Set());
const highlightedColumnIndex = ref<number | null>(null);
let highlightedColumnTimer = 0;

const goToColumnOpen = ref(false);
const goToColumnSearch = ref("");
const columnOrderKeys = computed(() => uniqueDataGridColumnOrderKeys(props.result.columns, props.sourceColumns));
const columnLayoutScopeKey = computed(() =>
  dataGridColumnLayoutScopeKey({
    connectionId: props.connectionId,
    database: props.database,
    schema: props.schema,
    context: props.context,
    tableSchema: props.tableMeta?.schema,
    tableName: props.tableMeta?.tableName,
    sql: props.sql,
    columns: props.result.columns,
    sourceColumns: props.sourceColumns,
  }),
);
const tableColumnOrderScopeKey = computed(() => {
  if (props.context !== "table-data" || !props.connectionId || !props.database || !props.tableMeta?.tableName) return "";
  return tableDataGridColumnOrderScopeKey({
    connectionId: props.connectionId,
    database: props.database,
    schema: props.tableMeta.schema,
    tableName: props.tableMeta.tableName,
  });
});
const persistedColumnOrderKeys = ref<string[]>([]);
const displayableColumnIndexes = computed(() =>
  props.result.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column, index }) => !props.result.hidden_column_indexes?.includes(index) && !isHiddenGridColumn(props.databaseType, column, props.tableMeta?.primaryKeys ?? [], props.tableMeta?.tableType))
    .map(({ index }) => index),
);
const goToColumnItems = computed(() =>
  buildDataGridColumnLookupItems({
    columns: props.result.columns,
    sourceColumns: props.sourceColumns,
    displayableIndexes: displayableColumnIndexes.value,
    commentByColumn: columnCommentMap.value,
  }),
);
const filteredGoToColumns = computed(() => {
  return filterDataGridColumnLookupItems(goToColumnItems.value, goToColumnSearch.value);
});
const orderedDisplayableColumnIndexes = computed(() =>
  orderedColumnIndexes({
    availableIndexes: displayableColumnIndexes.value,
    columnKeys: columnOrderKeys.value,
    orderedKeys: persistedColumnOrderKeys.value,
  }),
);
const visibleColumnIndexes = computed(() => visibleColumnIndexesForFilter(orderedDisplayableColumnIndexes.value, hiddenColumnIndexes.value));
const visibleColumns = computed(() => visibleColumnIndexes.value.map((index) => props.result.columns[index]));
const visibleSourceColumns = computed(() => {
  if (!props.sourceColumns || props.sourceColumns.length !== props.result.columns.length) return undefined;
  return visibleColumnIndexes.value.map((index) => props.sourceColumns?.[index]);
});
const tableColumnTypesByName = computed(() => {
  const map = new Map<string, string>();
  for (const column of props.tableMeta?.columns ?? []) {
    map.set(column.name.toLocaleLowerCase(), column.data_type);
  }
  return map;
});
const visibleColumnTypes = computed(() =>
  visibleColumnIndexes.value.map((index) => {
    const resultColumn = props.result.columns[index]?.toLocaleLowerCase();
    const sourceColumn = props.sourceColumns?.[index]?.toLocaleLowerCase();
    return (sourceColumn ? tableColumnTypesByName.value.get(sourceColumn) : undefined) || (resultColumn ? tableColumnTypesByName.value.get(resultColumn) : undefined) || props.result.column_types?.[index];
  }),
);
const visibleColumnCount = computed(() => visibleColumnIndexes.value.length);

/** Preview actions from the result preview registry for the current result. */
const previewActions = computed(() => {
  if (!props.result) return [];
  return getApplicablePreviewActions(props.result);
});
const displayableColumnCount = computed(() => displayableColumnIndexes.value.length);
const hiddenColumnCount = computed(() => displayableColumnCount.value - visibleColumnCount.value);
const hasCustomColumnOrder = computed(() => !isDefaultColumnOrder(displayableColumnIndexes.value, orderedDisplayableColumnIndexes.value));
const allNullColumnIndexesForResult = computed(() => allNullColumnIndexes(props.result.rows, displayableColumnIndexes.value));
const allNullColumnCount = computed(() => allNullColumnIndexesForResult.value.length);
const canToggleAllNullColumns = computed(() => nullColumnsHidden.value || (allNullColumnCount.value > 0 && displayableColumnCount.value > 1));
function filteredColumnVisibilityOptions(query: string) {
  const displayable = new Set(displayableColumnIndexes.value);
  return filterColumnVisibilityOptions(props.result.columns, query, { sourceColumns: props.sourceColumns, commentByColumn: columnCommentMap.value }).filter((option) => displayable.has(option.index));
}
function isColumnVisible(columnIndex: number): boolean {
  return !hiddenColumnIndexes.value.has(columnIndex);
}
function toggleColumnVisibility(columnIndex: number) {
  hiddenColumnIndexes.value = nextHiddenColumnIndexes({
    columnIndex,
    hiddenIndexes: hiddenColumnIndexes.value,
    totalColumns: displayableColumnCount.value,
  });
}
function showAllColumns() {
  hiddenColumnIndexes.value = new Set();
}
function invertColumnVisibility() {
  hiddenColumnIndexes.value = invertedHiddenColumnIndexes(displayableColumnIndexes.value, hiddenColumnIndexes.value);
}
function loadColumnOrder() {
  const tableOrder = tableColumnOrderScopeKey.value ? loadTableDataGridColumnOrder(tableColumnOrderScopeKey.value) : [];
  persistedColumnOrderKeys.value = tableOrder.length ? tableOrder : loadDataGridColumnOrder(columnLayoutScopeKey.value, columnOrderKeys.value);
}
function onTableDataGridColumnOrderChanged(event: Event) {
  if (!(event instanceof CustomEvent)) return;
  const detail = event.detail as TableDataGridColumnOrderChangedDetail | undefined;
  if (!detail || detail.scopeKey !== tableColumnOrderScopeKey.value) return;
  loadColumnOrder();
  nextTick(refreshGridScrollerMetrics);
}
function persistColumnOrder(indexes: number[]) {
  const tableScopeKey = tableColumnOrderScopeKey.value;
  if (isDefaultColumnOrder(displayableColumnIndexes.value, indexes)) {
    removeDataGridColumnOrder(columnLayoutScopeKey.value);
    if (tableScopeKey) {
      removeTableDataGridColumnOrder(tableScopeKey);
      notifyTableDataGridColumnOrderChanged(tableScopeKey);
    }
    persistedColumnOrderKeys.value = [];
    return;
  }
  const keys = columnOrderKeysForIndexes(indexes, columnOrderKeys.value);
  persistedColumnOrderKeys.value = keys;
  saveDataGridColumnOrder(columnLayoutScopeKey.value, columnOrderKeys.value, keys);
  if (tableScopeKey) {
    saveTableDataGridColumnOrder(tableScopeKey, keys);
    notifyTableDataGridColumnOrderChanged(tableScopeKey);
  }
}
function resetColumnOrder() {
  removeDataGridColumnOrder(columnLayoutScopeKey.value);
  const tableScopeKey = tableColumnOrderScopeKey.value;
  if (tableScopeKey) {
    removeTableDataGridColumnOrder(tableScopeKey);
    notifyTableDataGridColumnOrderChanged(tableScopeKey);
  }
  persistedColumnOrderKeys.value = [];
  nextTick(refreshGridScrollerMetrics);
}
function showAllNullColumns() {
  hiddenColumnIndexes.value = removeAutoHiddenColumnIndexes(hiddenColumnIndexes.value, autoHiddenNullColumnIndexes.value);
  autoHiddenNullColumnIndexes.value = new Set();
  nullColumnsHidden.value = false;
}
function hideAllNullColumns() {
  const next = hiddenColumnIndexesWithAllNullColumns({
    availableIndexes: displayableColumnIndexes.value,
    hiddenIndexes: hiddenColumnIndexes.value,
    allNullIndexes: new Set(allNullColumnIndexesForResult.value),
  });
  hiddenColumnIndexes.value = next.hiddenIndexes;
  autoHiddenNullColumnIndexes.value = next.autoHiddenIndexes;
  nullColumnsHidden.value = next.autoHiddenIndexes.size > 0;
}
function toggleAllNullColumns() {
  if (nullColumnsHidden.value) {
    showAllNullColumns();
  } else {
    hideAllNullColumns();
  }
}
watch(allNullColumnIndexesForResult, () => {
  if (!nullColumnsHidden.value) return;
  hiddenColumnIndexes.value = removeAutoHiddenColumnIndexes(hiddenColumnIndexes.value, autoHiddenNullColumnIndexes.value);
  autoHiddenNullColumnIndexes.value = new Set();
  hideAllNullColumns();
});
watch([columnLayoutScopeKey, tableColumnOrderScopeKey], loadColumnOrder, { immediate: true });
const firstVisibleColumnIndex = computed(() => visibleColumnIndexes.value[0] ?? 0);
function actualColumnIndex(visibleColumnIndex: number): number {
  return visibleColumnIndexes.value[visibleColumnIndex] ?? visibleColumnIndex;
}
function scrollToColumn(columnIndex: number) {
  goToColumnOpen.value = false;
  goToColumnSearch.value = "";
  scrollToColumnIndex(columnIndex);
  gridRef.value?.focus();
}

function onGoToColumnKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    goToColumnOpen.value = false;
    goToColumnSearch.value = "";
  }
}

watch(goToColumnOpen, (open) => {
  if (!open) goToColumnSearch.value = "";
});

function matchesTableInfoColumn(resultColumn: string, sourceColumn: string | undefined, columnName: string): boolean {
  const target = columnName.toLocaleLowerCase();
  return resultColumn.toLocaleLowerCase() === target || sourceColumn?.toLocaleLowerCase() === target;
}
function scrollToTableInfoColumn(columnName: string) {
  const columnIndex = props.result.columns.findIndex((column, index) => matchesTableInfoColumn(column, props.sourceColumns?.[index], columnName));
  scrollToColumnIndex(columnIndex);
}
function scrollToColumnIndex(columnIndex: number) {
  if (columnIndex < 0 || !displayableColumnIndexes.value.includes(columnIndex)) return;

  if (hiddenColumnIndexes.value.has(columnIndex)) {
    hiddenColumnIndexes.value.delete(columnIndex);
    hiddenColumnIndexes.value = new Set(hiddenColumnIndexes.value);
  }

  highlightedColumnIndex.value = columnIndex;
  clearTimeout(highlightedColumnTimer);
  highlightedColumnTimer = window.setTimeout(() => {
    highlightedColumnIndex.value = null;
  }, 1400);

  nextTick(() => {
    const visibleColIdx = visibleColumnIndexes.value.indexOf(columnIndex);
    const scroller = gridRef.value?.querySelector<HTMLElement>(".data-grid-scroller");
    if (visibleColIdx < 0 || !scroller) return;

    const targetLeft = Math.max(0, columnContentOffsetLeft(visibleColIdx) - scroller.clientWidth / 2 + (renderedColumnWidths.value[visibleColIdx] ?? 0) / 2);
    scroller.scrollLeft = targetLeft;
    updateGridHorizontalViewport(scroller);
    if (headerRef.value) {
      headerRef.value.scrollLeft = scroller.scrollLeft;
    }
  });
}

// --- Column resize composable ---
const columnWidthDensity = computed(() => settingsStore.editorSettings.columnWidthDensity);
const { initColumnWidths, onResizeStart, autoFitColumn, renderedColumnWidths, totalWidth, columnVars, getIsResizing } = useDataGridColumnResize({
  columns: visibleColumns,
  sourceRows: computed(() => props.result.rows),
  columnIndexes: visibleColumnIndexes,
  density: columnWidthDensity,
  compactColumnHeaderActions,
});
const gridStyle = computed(() => ({
  ...columnVars.value,
  "--header-total-w": dataGridHeaderContentWidth("var(--total-w)", gridScrollbarGutter.value),
  "--grid-scrollbar-gutter": `${gridScrollbarGutter.value}px`,
  [EDITOR_FONT_FAMILY_CSS_VAR]: settingsStore.editorSettings.fontFamily,
  "--dbx-table-font-size": `${tableFontSize.value}px`,
}));
const gridHorizontalScrollLeft = ref(0);
const gridViewportWidth = ref(0);
const renderedColumnOffsets = computed(() => {
  const widths = renderedColumnWidths.value;
  const offsets = Array.from({ length: widths.length + 1 }, () => 0);
  offsets[0] = 0;
  for (let index = 0; index < widths.length; index++) {
    offsets[index + 1] = offsets[index] + (widths[index] ?? 0);
  }
  return offsets;
});

function updateGridHorizontalViewport(element: HTMLElement) {
  const nextScrollLeft = element.scrollLeft;
  const nextViewportWidth = element.clientWidth;
  const horizontalChanged = gridHorizontalScrollLeft.value !== nextScrollLeft || gridViewportWidth.value !== nextViewportWidth;
  if (gridHorizontalScrollLeft.value !== nextScrollLeft) gridHorizontalScrollLeft.value = nextScrollLeft;
  if (gridViewportWidth.value !== nextViewportWidth) gridViewportWidth.value = nextViewportWidth;
  if (horizontalChanged) updateGridHorizontalScrollbar(element);
  updateGridVerticalScrollbar(element);
}

function gridScrollerElement(): HTMLElement | null {
  return gridRef.value?.querySelector<HTMLElement>(".data-grid-scroller") ?? null;
}

function updateGridHorizontalScrollbar(element: HTMLElement | null = gridScrollerElement()) {
  if (!element) {
    setGridHorizontalOverflow(false);
    gridHorizontalScrollbarThumbLeftPercent = 0;
    gridHorizontalScrollbarThumbWidthPercent = 100;
    applyGridHorizontalScrollbarThumbStyle();
    return;
  }

  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  setGridHorizontalOverflow(maxScrollLeft > 1);

  const rawThumbWidth = element.scrollWidth > 0 ? (element.clientWidth / element.scrollWidth) * 100 : 100;
  const thumbWidth = Math.min(100, Math.max(6, rawThumbWidth));
  const thumbTravel = Math.max(0, 100 - thumbWidth);
  gridHorizontalScrollbarThumbWidthPercent = thumbWidth;
  gridHorizontalScrollbarThumbLeftPercent = maxScrollLeft > 0 ? (element.scrollLeft / maxScrollLeft) * thumbTravel : 0;
  if (!applyGridHorizontalScrollbarThumbStyle() && hasGridHorizontalOverflow.value) {
    nextTick(applyGridHorizontalScrollbarThumbStyle);
  }
}

function updateGridVerticalScrollbar(element: HTMLElement | null = gridScrollerElement()) {
  if (!element) {
    setGridVerticalOverflow(false);
    gridVerticalScrollbarThumbTopPercent = 0;
    gridVerticalScrollbarThumbHeightPercent = 100;
    applyGridVerticalScrollbarThumbStyle();
    return;
  }

  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  setGridVerticalOverflow(maxScrollTop > 1);

  const rawThumbHeight = element.scrollHeight > 0 ? (element.clientHeight / element.scrollHeight) * 100 : 100;
  const thumbHeight = Math.min(100, Math.max(6, rawThumbHeight));
  const thumbTravel = Math.max(0, 100 - thumbHeight);
  gridVerticalScrollbarThumbHeightPercent = thumbHeight;
  gridVerticalScrollbarThumbTopPercent = maxScrollTop > 0 ? (element.scrollTop / maxScrollTop) * thumbTravel : 0;
  if (!applyGridVerticalScrollbarThumbStyle() && hasGridVerticalOverflow.value) {
    nextTick(applyGridVerticalScrollbarThumbStyle);
  }
}

function setGridHorizontalOverflow(overflow: boolean) {
  if (hasGridHorizontalOverflow.value === overflow) return;
  const scroller = gridScrollerElement();
  const preserveBottom = overflow && !!scroller && isDataGridAtScrollBottom(scroller);
  hasGridHorizontalOverflow.value = overflow;
  if (!overflow) return;
  nextTick(() => {
    applyGridHorizontalScrollbarThumbStyle();
    if (!preserveBottom || gridScrollerElement() !== scroller) return;
    // The custom horizontal scrollbar changes the scrollable geometry after render;
    // restore bottom anchoring through the normal handlers so every grid mode stays synchronized.
    scroller.scrollTop = dataGridBottomScrollTop(scroller);
    if (useCanvasGridRows.value) {
      onCanvasScroll({ target: scroller } as unknown as Event);
    } else {
      onScrollerScroll({ target: scroller } as unknown as Event);
    }
  });
}

function setGridVerticalOverflow(overflow: boolean) {
  if (hasGridVerticalOverflow.value === overflow) return;
  hasGridVerticalOverflow.value = overflow;
  if (overflow) nextTick(applyGridVerticalScrollbarThumbStyle);
}

function applyGridHorizontalScrollbarThumbStyle(): boolean {
  const thumb = gridHorizontalScrollbarThumbRef.value;
  if (!thumb) return false;
  // Scroll thumb position changes on every drag frame; update it outside Vue's
  // render path so large result grids do not re-render while the user drags.
  thumb.style.width = `${gridHorizontalScrollbarThumbWidthPercent}%`;
  thumb.style.left = `${gridHorizontalScrollbarThumbLeftPercent}%`;
  return true;
}

function applyGridVerticalScrollbarThumbStyle(): boolean {
  const thumb = gridVerticalScrollbarThumbRef.value;
  if (!thumb) return false;
  thumb.style.height = `${gridVerticalScrollbarThumbHeightPercent}%`;
  thumb.style.top = `${gridVerticalScrollbarThumbTopPercent}%`;
  return true;
}

function setGridHorizontalScrollbarDragging(dragging: boolean) {
  gridHorizontalScrollbarTrackRef.value?.classList.toggle(GRID_HORIZONTAL_SCROLLBAR_DRAGGING_CLASS, dragging);
}

function setGridVerticalScrollbarDragging(dragging: boolean) {
  gridVerticalScrollbarTrackRef.value?.classList.toggle(GRID_VERTICAL_SCROLLBAR_DRAGGING_CLASS, dragging);
}

function scheduleGridHorizontalScrollbarUpdate() {
  if (gridHorizontalScrollbarFrame) return;
  const update = () => {
    gridHorizontalScrollbarFrame = 0;
    updateGridHorizontalScrollbar();
    updateGridVerticalScrollbar();
  };
  if (typeof requestAnimationFrame === "function") {
    gridHorizontalScrollbarFrame = requestAnimationFrame(update);
  } else {
    window.setTimeout(update, 0);
  }
}

function observeGridHorizontalScrollbarScroller() {
  gridHorizontalScrollbarResizeObserver?.disconnect();
  gridHorizontalScrollbarResizeObserver = null;
  const scroller = gridScrollerElement();
  if (scroller && typeof ResizeObserver !== "undefined") {
    gridHorizontalScrollbarResizeObserver = new ResizeObserver(scheduleGridHorizontalScrollbarUpdate);
    gridHorizontalScrollbarResizeObserver.observe(scroller);
    for (const child of Array.from(scroller.children)) {
      gridHorizontalScrollbarResizeObserver.observe(child);
    }
  }
  scheduleGridHorizontalScrollbarUpdate();
}

function updateDataGridTopbarWidth() {
  dataGridTopbarWidth.value = dataGridTopbarRef.value?.clientWidth ?? 0;
}

function observeDataGridTopbarWidth() {
  dataGridTopbarResizeObserver?.disconnect();
  dataGridTopbarResizeObserver = null;
  const topbar = dataGridTopbarRef.value;
  updateDataGridTopbarWidth();
  if (topbar && typeof ResizeObserver !== "undefined") {
    dataGridTopbarResizeObserver = new ResizeObserver(updateDataGridTopbarWidth);
    dataGridTopbarResizeObserver.observe(topbar);
  }
}

function applyPendingGridHorizontalScrollbarDrag() {
  gridHorizontalScrollbarDragFrame = 0;
  const dragState = gridHorizontalScrollbarDragState;
  if (!dragState) return;

  const thumbWidthPx = dragState.trackRect.width * (gridHorizontalScrollbarThumbWidthPercent / 100);
  const maxThumbLeftPx = Math.max(1, dragState.trackRect.width - thumbWidthPx);
  const thumbLeftPx = Math.min(maxThumbLeftPx, Math.max(0, gridHorizontalScrollbarPendingClientX - dragState.trackRect.left - dragState.thumbOffsetPx));
  const scroller = dragState.scroller;
  const nextScrollLeft = (thumbLeftPx / maxThumbLeftPx) * dragState.maxScrollLeft;
  if (Math.abs(scroller.scrollLeft - nextScrollLeft) < 0.5) return;
  scroller.scrollLeft = nextScrollLeft;
  updateGridHorizontalViewport(scroller);
  if (headerRef.value) headerRef.value.scrollLeft = scroller.scrollLeft;
  if (useCanvasGridRows.value) {
    drawCanvasGridNow();
  }
}

function scheduleGridHorizontalScrollbarDrag(clientX: number) {
  gridHorizontalScrollbarPendingClientX = clientX;
  if (gridHorizontalScrollbarDragFrame) return;
  // Pointermove can fire faster than paint; keep expensive canvas/layout work to one frame.
  gridHorizontalScrollbarDragFrame = requestAnimationFrame(applyPendingGridHorizontalScrollbarDrag);
}

function flushGridHorizontalScrollbarDrag() {
  if (!gridHorizontalScrollbarDragFrame) return;
  cancelAnimationFrame(gridHorizontalScrollbarDragFrame);
  applyPendingGridHorizontalScrollbarDrag();
}

function onGridHorizontalScrollbarPointerMove(event: PointerEvent) {
  if (!gridHorizontalScrollbarDragState) return;
  event.preventDefault();
  scheduleGridHorizontalScrollbarDrag(event.clientX);
}

function stopGridHorizontalScrollbarDrag() {
  if (!gridHorizontalScrollbarDragState) return;
  flushGridHorizontalScrollbarDrag();
  gridHorizontalScrollbarDragState = null;
  setGridHorizontalScrollbarDragging(false);
  window.removeEventListener("pointermove", onGridHorizontalScrollbarPointerMove, true);
  window.removeEventListener("pointerup", stopGridHorizontalScrollbarDrag, true);
  window.removeEventListener("pointercancel", stopGridHorizontalScrollbarDrag, true);
  document.body.style.userSelect = "";
}

function stopGridVerticalScrollbarDrag() {
  if (!gridVerticalScrollbarDragState) return;
  flushGridVerticalScrollbarDrag();
  gridVerticalScrollbarDragState = null;
  setGridVerticalScrollbarDragging(false);
  window.removeEventListener("pointermove", onGridVerticalScrollbarPointerMove, true);
  window.removeEventListener("pointerup", stopGridVerticalScrollbarDrag, true);
  window.removeEventListener("pointercancel", stopGridVerticalScrollbarDrag, true);
  document.body.style.userSelect = "";
}

function startGridHorizontalScrollbarDrag(event: PointerEvent) {
  const scroller = gridScrollerElement();
  const track = gridHorizontalScrollbarTrackRef.value;
  if (!scroller || !track || !hasGridHorizontalOverflow.value) return;

  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  if (maxScrollLeft <= 1) return;
  const trackRect = track.getBoundingClientRect();
  const thumbLeftPx = trackRect.width * (gridHorizontalScrollbarThumbLeftPercent / 100);
  const thumbWidthPx = trackRect.width * (gridHorizontalScrollbarThumbWidthPercent / 100);
  const pointerX = event.clientX - trackRect.left;
  const pointerInsideThumb = pointerX >= thumbLeftPx && pointerX <= thumbLeftPx + thumbWidthPx;

  gridHorizontalScrollbarDragState = {
    scroller,
    trackRect,
    thumbOffsetPx: pointerInsideThumb ? pointerX - thumbLeftPx : thumbWidthPx / 2,
    maxScrollLeft,
  };
  setGridHorizontalScrollbarDragging(true);
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", onGridHorizontalScrollbarPointerMove, true);
  window.addEventListener("pointerup", stopGridHorizontalScrollbarDrag, true);
  window.addEventListener("pointercancel", stopGridHorizontalScrollbarDrag, true);
  event.preventDefault();
  scheduleGridHorizontalScrollbarDrag(event.clientX);
}

function applyPendingGridVerticalScrollbarDrag() {
  gridVerticalScrollbarDragFrame = 0;
  const dragState = gridVerticalScrollbarDragState;
  if (!dragState) return;

  const thumbHeightPx = dragState.trackRect.height * (gridVerticalScrollbarThumbHeightPercent / 100);
  const maxThumbTopPx = Math.max(1, dragState.trackRect.height - thumbHeightPx);
  const thumbTopPx = Math.min(maxThumbTopPx, Math.max(0, gridVerticalScrollbarPendingClientY - dragState.trackRect.top - dragState.thumbOffsetPx));
  const scroller = dragState.scroller;
  const nextScrollTop = (thumbTopPx / maxThumbTopPx) * dragState.maxScrollTop;
  if (Math.abs(scroller.scrollTop - nextScrollTop) < 0.5) return;
  scroller.scrollTop = nextScrollTop;
  updateGridVerticalScrollbar(scroller);
  if (useCanvasGridRows.value) {
    canvasScrollTop.value = scroller.scrollTop;
    drawCanvasGridNow();
  }
}

function scheduleGridVerticalScrollbarDrag(clientY: number) {
  gridVerticalScrollbarPendingClientY = clientY;
  if (gridVerticalScrollbarDragFrame) return;
  // Match horizontal dragging: coalesce pointermove bursts to one canvas/layout update per frame.
  gridVerticalScrollbarDragFrame = requestAnimationFrame(applyPendingGridVerticalScrollbarDrag);
}

function flushGridVerticalScrollbarDrag() {
  if (!gridVerticalScrollbarDragFrame) return;
  cancelAnimationFrame(gridVerticalScrollbarDragFrame);
  applyPendingGridVerticalScrollbarDrag();
}

function onGridVerticalScrollbarPointerMove(event: PointerEvent) {
  if (!gridVerticalScrollbarDragState) return;
  event.preventDefault();
  scheduleGridVerticalScrollbarDrag(event.clientY);
}

function startGridVerticalScrollbarDrag(event: PointerEvent) {
  const scroller = gridScrollerElement();
  const track = gridVerticalScrollbarTrackRef.value;
  if (!scroller || !track || !hasGridVerticalOverflow.value) return;

  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (maxScrollTop <= 1) return;
  const trackRect = track.getBoundingClientRect();
  const thumbTopPx = trackRect.height * (gridVerticalScrollbarThumbTopPercent / 100);
  const thumbHeightPx = trackRect.height * (gridVerticalScrollbarThumbHeightPercent / 100);
  const pointerY = event.clientY - trackRect.top;
  const pointerInsideThumb = pointerY >= thumbTopPx && pointerY <= thumbTopPx + thumbHeightPx;

  gridVerticalScrollbarDragState = {
    scroller,
    trackRect,
    thumbOffsetPx: pointerInsideThumb ? pointerY - thumbTopPx : thumbHeightPx / 2,
    maxScrollTop,
  };
  setGridVerticalScrollbarDragging(true);
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", onGridVerticalScrollbarPointerMove, true);
  window.addEventListener("pointerup", stopGridVerticalScrollbarDrag, true);
  window.addEventListener("pointercancel", stopGridVerticalScrollbarDrag, true);
  event.preventDefault();
  scheduleGridVerticalScrollbarDrag(event.clientY);
}

function updateGridScrollbarGutter(element: HTMLElement) {
  gridScrollbarGutter.value = scrollbarGutterWidth(element);
}

function refreshGridScrollerMetrics() {
  const scrollerEl = gridRef.value?.querySelector<HTMLElement>(".data-grid-scroller");
  if (!scrollerEl) return;
  updateGridScrollbarGutter(scrollerEl);
  updateGridHorizontalViewport(scrollerEl);
  rememberInfiniteScrollPosition(scrollerEl);
  if (headerRef.value) {
    headerRef.value.scrollLeft = scrollerEl.scrollLeft;
  }
  observeGridHorizontalScrollbarScroller();
}

function syncHeaderScroll(e: Event) {
  const target = e.target as HTMLElement;
  updateGridScrollbarGutter(target);
  updateGridHorizontalViewport(target);
  if (headerRef.value) {
    headerRef.value.scrollLeft = target.scrollLeft;
  }
}

const HORIZONTAL_COLUMN_BUFFER_PX = 900;

interface RenderedGridColumn {
  visibleColIdx: number;
  actualColIdx: number;
  name: string;
}

interface HorizontalColumnWindow {
  start: number;
  end: number;
  beforeWidth: number;
  afterWidth: number;
}

function getHorizontalColumnWindow(): HorizontalColumnWindow {
  const widths = renderedColumnWidths.value;
  const offsets = renderedColumnOffsets.value;
  const totalColumns = visibleColumnIndexes.value.length;
  if (totalColumns === 0 || widths.length === 0) {
    return { start: 0, end: 0, beforeWidth: 0, afterWidth: 0 };
  }

  const viewportStart = Math.max(0, gridHorizontalScrollLeft.value - DATA_GRID_ROW_NUM_WIDTH - HORIZONTAL_COLUMN_BUFFER_PX);
  const viewportEnd = Math.max(gridViewportWidth.value, 1) + Math.max(0, gridHorizontalScrollLeft.value - DATA_GRID_ROW_NUM_WIDTH) + HORIZONTAL_COLUMN_BUFFER_PX;
  let low = 0;
  let high = totalColumns - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((offsets[mid + 1] ?? 0) < viewportStart) low = mid + 1;
    else high = mid;
  }
  const start = low;
  const offset = offsets[start] ?? 0;

  let end = start;
  while (end < totalColumns && (offsets[end] ?? 0) < viewportEnd) {
    end++;
  }
  const visibleWidth = offsets[end] ?? offset;

  const columnsWidth = offsets[totalColumns] ?? 0;
  return {
    start,
    end,
    beforeWidth: offset,
    afterWidth: Math.max(0, columnsWidth - visibleWidth),
  };
}

const horizontalColumnWindow = computed(getHorizontalColumnWindow);

const renderedGridColumns = computed<RenderedGridColumn[]>(() => {
  const window = horizontalColumnWindow.value;
  const columns: RenderedGridColumn[] = [];
  for (let visibleColIdx = window.start; visibleColIdx < window.end; visibleColIdx++) {
    const actualColIdx = visibleColumnIndexes.value[visibleColIdx];
    if (actualColIdx === undefined) continue;
    columns.push({
      visibleColIdx,
      actualColIdx,
      name: props.result.columns[actualColIdx] ?? "",
    });
  }
  return columns;
});

function renderedColumnStyle(visibleColIdx: number) {
  return { width: `var(--col-w-${visibleColIdx})` };
}

type ColumnHeaderDragState = {
  sourceVisibleIndex: number;
  targetVisibleIndex: number;
  startX: number;
  startY: number;
  currentX: number;
  columnRects: { visibleIndex: number; left: number; width: number }[];
  dragging: boolean;
};
const columnHeaderDragState = ref<ColumnHeaderDragState | null>(null);
const columnHeaderResizeActive = ref(false);
let columnHeaderDragClickGuardUntil = 0;
let columnHeaderSuppressNextClick = false;
let columnHeaderSuppressClickTimer = 0;
let columnHeaderDragFrame = 0;
let columnHeaderPendingClientX = 0;
let columnHeaderResizeListenersCleanup: (() => void) | null = null;

const columnHeaderTooltipsDisabled = computed(() =>
  columnHeaderTooltipDisabled({
    columnDragActive: columnHeaderDragState.value !== null,
    columnResizeActive: columnHeaderResizeActive.value,
  }),
);

function columnHeaderPointerInteractionActive(): boolean {
  return columnHeaderCanvasPointerDisabled({
    columnDragActive: columnHeaderDragState.value !== null,
    columnResizeActive: columnHeaderResizeActive.value,
  });
}

function finishColumnHeaderResizeInteraction() {
  clearColumnHeaderResizeListeners();
  requestAnimationFrame(() => {
    columnHeaderResizeActive.value = false;
  });
}

function clearColumnHeaderResizeListeners() {
  if (!columnHeaderResizeListenersCleanup) return;
  columnHeaderResizeListenersCleanup();
  columnHeaderResizeListenersCleanup = null;
}

function clearColumnHeaderClickGuard() {
  columnHeaderSuppressNextClick = false;
  columnHeaderDragClickGuardUntil = 0;
  if (columnHeaderSuppressClickTimer) {
    window.clearTimeout(columnHeaderSuppressClickTimer);
    columnHeaderSuppressClickTimer = 0;
  }
}

function armColumnHeaderClickGuard() {
  clearColumnHeaderClickGuard();
  columnHeaderSuppressNextClick = true;
  columnHeaderDragClickGuardUntil = Date.now() + 800;
  columnHeaderSuppressClickTimer = window.setTimeout(() => {
    clearColumnHeaderClickGuard();
  }, 800);
}

function startColumnHeaderResize(visibleColIdx: number, event: MouseEvent) {
  // Browser hover state can stick to multiple header cells during pointer drags,
  // so keep header tooltips closed until the resize gesture has fully settled.
  clearColumnHeaderResizeListeners();
  columnHeaderResizeActive.value = true;
  armColumnHeaderClickGuard();
  onCanvasMouseLeave();
  const finishResize = () => {
    armColumnHeaderClickGuard();
    finishColumnHeaderResizeInteraction();
  };
  columnHeaderResizeListenersCleanup = () => {
    window.removeEventListener("mouseup", finishResize, true);
    window.removeEventListener("blur", finishResize, true);
  };
  window.addEventListener("mouseup", finishResize, true);
  window.addEventListener("blur", finishResize, true);
  onResizeStart(visibleColIdx, event);
}

function columnHeaderInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest("button, input, textarea, select, [contenteditable='true'], [role='button'], [data-column-resize-handle]");
}

function columnHeaderDropTargetVisibleIndex(clientX: number): number {
  const state = columnHeaderDragState.value;
  if (!state || state.columnRects.length === 0) return state?.sourceVisibleIndex ?? 0;
  for (const rect of state.columnRects) {
    const visibleIndex = rect.visibleIndex;
    if (!Number.isFinite(visibleIndex)) continue;
    if (clientX < rect.left + rect.width / 2) return visibleIndex;
  }
  return visibleColumnIndexes.value.length;
}

function applyColumnHeaderDragPreview() {
  columnHeaderDragFrame = 0;
  const state = columnHeaderDragState.value;
  if (!state?.dragging) return;
  state.currentX = columnHeaderPendingClientX;
  state.targetVisibleIndex = columnHeaderDropTargetVisibleIndex(columnHeaderPendingClientX);
  if (useCanvasGridRows.value) scheduleCanvasDraw();
}

function scheduleColumnHeaderDragPreview(clientX: number) {
  columnHeaderPendingClientX = clientX;
  if (columnHeaderDragFrame) return;
  columnHeaderDragFrame = requestAnimationFrame(applyColumnHeaderDragPreview);
}

function flushColumnHeaderDragPreview() {
  if (columnHeaderDragFrame) cancelAnimationFrame(columnHeaderDragFrame);
  applyColumnHeaderDragPreview();
}

function cancelColumnHeaderDragPreview() {
  if (!columnHeaderDragFrame) return;
  cancelAnimationFrame(columnHeaderDragFrame);
  columnHeaderDragFrame = 0;
}

function columnHeaderLayoutRects(): { visibleIndex: number; left: number; width: number }[] {
  const header = headerRef.value;
  return Array.from(header?.querySelectorAll<HTMLElement>("[data-visible-col-index]") ?? [])
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        visibleIndex: Number(element.dataset.visibleColIndex),
        left: rect.left,
        width: rect.width,
      };
    })
    .filter((rect) => Number.isFinite(rect.visibleIndex));
}

function stopColumnHeaderDrag(commit: boolean) {
  const state = columnHeaderDragState.value;
  if (!state) return;
  const hadCanvasPreview = useCanvasGridRows.value && state.dragging;
  window.removeEventListener("pointermove", onColumnHeaderPointerMove, true);
  window.removeEventListener("pointerup", onColumnHeaderPointerUp, true);
  window.removeEventListener("pointercancel", onColumnHeaderPointerCancel, true);
  cancelColumnHeaderDragPreview();
  document.body.style.userSelect = "";
  columnHeaderDragState.value = null;
  if (hadCanvasPreview) scheduleCanvasDraw();
  if (state.dragging) armColumnHeaderClickGuard();
  if (!commit || !state.dragging || state.sourceVisibleIndex === state.targetVisibleIndex) return;
  const next = moveVisibleColumnIndex({
    orderedIndexes: orderedDisplayableColumnIndexes.value,
    hiddenIndexes: hiddenColumnIndexes.value,
    fromVisibleIndex: state.sourceVisibleIndex,
    toVisibleIndex: state.targetVisibleIndex,
  });
  persistColumnOrder(next);
  nextTick(refreshGridScrollerMetrics);
}

function onColumnHeaderPointerMove(event: PointerEvent) {
  const state = columnHeaderDragState.value;
  if (!state) return;
  const moved = Math.abs(event.clientX - state.startX) > 5 || Math.abs(event.clientY - state.startY) > 5;
  if (!state.dragging && moved) {
    state.dragging = true;
    document.body.style.userSelect = "none";
    onCanvasMouseLeave();
  }
  if (!state.dragging) return;
  event.preventDefault();
  scheduleColumnHeaderDragPreview(event.clientX);
}

function onColumnHeaderPointerUp(event: PointerEvent) {
  columnHeaderPendingClientX = event.clientX;
  flushColumnHeaderDragPreview();
  stopColumnHeaderDrag(true);
}

function onColumnHeaderPointerCancel() {
  stopColumnHeaderDrag(false);
}

function startColumnHeaderDrag(visibleColIdx: number, event: PointerEvent) {
  if (event.button !== 0 || getIsResizing() || columnHeaderInteractiveTarget(event.target)) return;
  columnHeaderDragState.value = {
    sourceVisibleIndex: visibleColIdx,
    targetVisibleIndex: visibleColIdx,
    startX: event.clientX,
    startY: event.clientY,
    currentX: event.clientX,
    columnRects: columnHeaderLayoutRects(),
    dragging: false,
  };
  columnHeaderPendingClientX = event.clientX;
  window.addEventListener("pointermove", onColumnHeaderPointerMove, true);
  window.addEventListener("pointerup", onColumnHeaderPointerUp, true);
  window.addEventListener("pointercancel", onColumnHeaderPointerCancel, true);
}

function suppressHeaderClickIfNeeded(event: MouseEvent): boolean {
  if (
    !columnHeaderClickShouldBeSuppressed({
      now: Date.now(),
      guardUntil: columnHeaderDragClickGuardUntil,
      suppressNextClick: columnHeaderSuppressNextClick,
    })
  ) {
    return false;
  }
  clearColumnHeaderClickGuard();
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  return true;
}

function onHeaderClickCapture(event: MouseEvent) {
  suppressHeaderClickIfNeeded(event);
}

function onHeaderClick(visibleColIdx: number, event: MouseEvent) {
  if (suppressHeaderClickIfNeeded(event)) return;
  selectColumn(visibleColIdx, event);
}

function columnHeaderDragClass(visibleColIdx: number) {
  const state = columnHeaderDragState.value;
  return {
    "z-30 shadow-lg ring-1 ring-primary/40 bg-background dark:bg-muted pointer-events-none": state?.dragging && state.sourceVisibleIndex === visibleColIdx,
  };
}

function columnHeaderPreviewOffset(visibleColIdx: number): number {
  const state = columnHeaderDragState.value;
  if (!state) return 0;
  return columnHeaderPreviewOffsetForColumn({
    columnDragActive: state.dragging,
    visibleColIdx,
    sourceVisibleIndex: state.sourceVisibleIndex,
    targetVisibleIndex: state.targetVisibleIndex,
    startX: state.startX,
    currentX: state.currentX,
    sourceWidth: renderedColumnWidths.value[state.sourceVisibleIndex] ?? 0,
  });
}

function columnHeaderStyle(visibleColIdx: number) {
  const style = renderedColumnStyle(visibleColIdx);
  const offset = columnHeaderPreviewOffset(visibleColIdx);
  if (!offset) return style;
  return {
    ...style,
    transform: `translateX(${offset}px)`,
    transition: columnHeaderDragState.value?.sourceVisibleIndex === visibleColIdx ? undefined : "transform 120ms ease-out",
  };
}

const columnHeaderPreviewOffsets = computed(() => renderedColumnWidths.value.map((_, visibleColIdx) => columnHeaderPreviewOffset(visibleColIdx)));
const columnHeaderPreviewSourceVisibleIndex = computed(() => {
  const state = columnHeaderDragState.value;
  return state?.dragging ? state.sourceVisibleIndex : null;
});

function columnContentOffsetLeft(visibleColIdx: number): number {
  return DATA_GRID_ROW_NUM_WIDTH + (renderedColumnOffsets.value[visibleColIdx] ?? 0);
}

let scrollingTimer = 0;
const isScrolling = ref(false);
let infiniteScrollPositions = new WeakMap<HTMLElement, DataGridScrollPosition>();

function updateDomGridVisibleItemsDuringScroll(scroller: HTMLElement) {
  if (useCanvasGridRows.value || scroller !== gridScrollerElement()) return;
  (scrollerRef.value as { updateVisibleItems?: (itemsChanged: boolean, checkPositionDiff?: boolean) => void } | null)?.updateVisibleItems?.(false, true);
}

function markGridScrolling() {
  if (!isScrolling.value) isScrolling.value = true;
  clearTimeout(scrollingTimer);
  scrollingTimer = window.setTimeout(() => {
    const scroller = gridScrollerElement();
    if (scroller) updateDomGridVisibleItemsDuringScroll(scroller);
    isScrolling.value = false;
  }, 120);
}

function rememberInfiniteScrollPosition(scroller: HTMLElement) {
  infiniteScrollPositions.set(scroller, dataGridScrollPosition(scroller.scrollTop, scroller.scrollLeft));
}

function maybeCheckInfiniteScroll(scroller: HTMLElement) {
  const current = dataGridScrollPosition(scroller.scrollTop, scroller.scrollLeft);
  const previous = infiniteScrollPositions.get(scroller);
  infiniteScrollPositions.set(scroller, current);
  if (shouldCheckInfiniteScrollAfterScroll(previous, current)) {
    checkInfiniteScroll(scroller);
  }
}

function clampGridScrollerBounds(scroller: HTMLElement) {
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const nextTop = Math.max(0, Math.min(maxTop, scroller.scrollTop));
  const nextLeft = Math.max(0, Math.min(maxLeft, scroller.scrollLeft));
  if (nextTop !== scroller.scrollTop) scroller.scrollTop = nextTop;
  if (nextLeft !== scroller.scrollLeft) scroller.scrollLeft = nextLeft;
}

function onScrollerScroll(e: Event) {
  const target = e.target;
  if (target instanceof HTMLElement) {
    clampGridScrollerBounds(target);
    updateDomGridVisibleItemsDuringScroll(target);
    syncHeaderScroll(e);
    recordScrollPosition({ top: target.scrollTop, left: target.scrollLeft });
    maybeCheckInfiniteScroll(target);
  } else {
    syncHeaderScroll(e);
  }
  markGridScrolling();
}

watch(isScrolling, (scrolling) => {
  if (scrolling) {
    hoveredDetailCell.value = null;
    quickDownloadMenuCell.value = null;
  }
});

initColumnWidths();
watch(
  () => visibleColumns.value.length,
  () => initColumnWidths(),
);
watch(
  () => [visibleColumnCount.value, renderedColumnWidths.value.length],
  () => {
    nextTick(refreshGridScrollerMetrics);
  },
);
const localFilterScopeKey = computed(() =>
  [
    props.connectionId ?? "",
    props.database ?? "",
    props.schema ?? "",
    props.context ?? "",
    props.tableMeta?.schema ?? "",
    props.tableMeta?.tableName ?? "",
    props.tableMeta ? "" : (props.sql ?? ""),
    props.result.columns.join("\0"),
    (props.sourceColumns ?? []).map((column) => column ?? "").join("\0"),
  ].join("\u0001"),
);
watch(
  () => localFilterScopeKey.value,
  () => {
    localColumnFilters.value = {};
    hiddenColumnIndexes.value = new Set();
    nullColumnsHidden.value = false;
    autoHiddenNullColumnIndexes.value = new Set();
    closeLocalFilter();
  },
);

// --- Pagination ---
const pageSize = ref(normalizeResultPageSize(settingsStore.editorSettings.pageSize));
const currentPage = ref(1);
const pageSizeOptions = computed(() => resultPageSizeMenuOptions(pageSize.value));
const customPageSizeInput = ref(String(pageSize.value));
const infiniteScrollLoading = ref(false);
const isInfiniteScrollPaginating = ref(false);
let lastInfiniteScrollPage = 0;
let infiniteScrollCheckScheduled = false;
let infiniteScrollAllLoaded = false;
// Tracks whether the current loading cycle was triggered by a refresh/rollback
// (as opposed to a normal paginate). Used to decide whether to auto-redirect
// when the current page no longer exists after data was deleted.
const isRefreshingData = ref(false);
watch(pageSize, (value) => {
  customPageSizeInput.value = String(value);
});
watch(
  () => settingsStore.editorSettings.pageSize,
  (value) => {
    pageSize.value = normalizeResultPageSize(value, pageSize.value);
  },
);
watch(
  () => infiniteScrollEnabled.value,
  (enabled, prevEnabled) => {
    // Switched between paginated and infinite scroll: reset to first page
    if (enabled !== prevEnabled) {
      resetInfiniteScrollState();
      emit("paginate", 0, pageSize.value, currentWhereInput(), currentOrderBy());
    }
  },
);
watch(
  () => [props.pageOffset, props.pageLimit],
  ([offset, limit]) => {
    if (typeof offset !== "number" || typeof limit !== "number" || limit <= 0) return;
    // Skip resetting pagination state during infinite scroll pagination
    if (isInfiniteScrollPaginating.value) return;
    const normalizedLimit = normalizeResultPageSize(limit);
    pageSize.value = normalizedLimit;
    currentPage.value = Math.floor(offset / normalizedLimit) + 1;
  },
  { immediate: true },
);
// Clear infinite-scroll loading when the parent finishes loading new data
watch(
  () => props.loading,
  (loading, prevLoading) => {
    if (prevLoading && !loading && infiniteScrollLoading.value) {
      infiniteScrollLoading.value = false;
      isInfiniteScrollPaginating.value = false;
      // Detect if the backend returned no new data for this page
      const expectedRows = currentPage.value * pageSize.value;
      if (props.result.rows.length < expectedRows) {
        infiniteScrollAllLoaded = true;
      }
    }
  },
);
const manualTotalRowCount = ref<number | undefined>(undefined);
const manualTotalRowCountLoading = ref(false);
const showTruncationWarning = computed(() => props.result.truncated === true && typeof props.pageLimit !== "number" && props.result.has_more !== true);
const isResultsContext = computed(() => props.context === "results");
// affected_rows reported by the backend can be larger than the rows we
// actually have in memory — e.g. ES auto-pages SELECT * on a big index and
// reports the index's true match count. Surface that in the status bar so
// the user sees the real total, but do NOT use it to unlock pagination:
// we don't have those rows, so letting the user page into them would just
// show blank screens.
const inferredBackendTotalRowCount = computed(() => {
  const affected = props.result.affected_rows;
  if (typeof affected !== "number" || !Number.isFinite(affected)) return undefined;
  if (affected <= props.result.rows.length) return undefined;
  return affected;
});
const serverKnownTotalRowCount = computed(() => props.totalRowCount ?? manualTotalRowCount.value);
const displayedTotalRowCount = computed(() => serverKnownTotalRowCount.value ?? inferredBackendTotalRowCount.value);
// Only a server-confirmed total drives pagination — an inferred total means
// rows exist that we never fetched, so navigation must stay inside rows.length.
const hasKnownTotalRowCount = computed(() => typeof serverKnownTotalRowCount.value === "number" && serverKnownTotalRowCount.value >= 0);
// When context=results and the caller hasn't configured server-side
// pagination (no pageLimit), the backend handed us every row up-front and
// rowCount IS the total. Without this hint, the "page is full → assume more"
// fallback in canGoNextDataGridPage lets the user keep clicking next forever.
const allRowsLoaded = computed(() => isResultsContext.value && props.pageLimit === undefined);
// True when the in-memory result already holds the complete result set (results
// context, no server-side pagination, not truncated, no further pages). Used to
// skip re-executing the query on export and instead write the local rows.
const hasCompleteLocalResult = computed(() => !!props.result && allRowsLoaded.value && props.result.truncated !== true && props.result.has_more !== true);
const canGoNextPage = computed(() => {
  return canGoNextDataGridPage({
    hasMore: props.result.has_more,
    rowCount: props.result.rows.length,
    pageSize: pageSize.value,
    pageOffset: props.pageOffset,
    currentPage: currentPage.value,
    totalRowCount: hasKnownTotalRowCount.value ? displayedTotalRowCount.value : undefined,
    allRowsLoaded: allRowsLoaded.value,
  });
});
const canJumpLastPage = computed(() => canGoNextPage.value && (hasKnownTotalRowCount.value || allRowsLoaded.value || !!props.tableMeta || !!props.countSql));
const totalRowCountBusy = computed(() => props.totalRowCountLoading === true || manualTotalRowCountLoading.value);
const canCalculateTotalRowCount = computed(() => !!props.connectionId && (!!props.tableMeta || !!props.countSql));
// When a refresh/rollback completes and the current page exceeds the last
// available page (e.g. data was deleted while viewing), auto-navigate to the
// last available page instead of showing an empty page.
watch(
  () => props.loading,
  (loading, prevLoading) => {
    // Only act when loading completes (transitions from true to false)
    // and the completion was triggered by a refresh/rollback.
    if (!loading && prevLoading && isRefreshingData.value) {
      isRefreshingData.value = false;
      const total = displayedTotalRowCount.value;
      if (!total || total <= 0) return;
      const lastPageNum = Math.max(1, Math.ceil(total / pageSize.value));
      if (currentPage.value <= lastPageNum) return;
      currentPage.value = lastPageNum;
      resetGridVerticalScroll(true);
      emit("paginate", (lastPageNum - 1) * pageSize.value, pageSize.value, currentWhereInput(), currentOrderBy());
    }
  },
);
const showQueryEditReadOnlyBadge = computed(() => isResultsContext.value && hasData.value && !props.editable && !!props.queryEditabilityReason);
const queryEditReadOnlyReason = computed(() => (props.queryEditabilityReason ? t(`grid.queryEditUnsupported.${props.queryEditabilityReason}`) : ""));
const showKeylessEditWarning = computed(() => !!props.editable && !!props.tableMeta && canUseKeylessRowPredicate(props.databaseType, props.tableMeta.primaryKeys ?? []));
const canShowWhereSearch = computed(() => !!props.onExecuteSql && !isResultsContext.value);
const canUseWhereSearch = computed(() => !!props.tableMeta && !!props.onExecuteSql && !isResultsContext.value);
const canUseServerColumnFilter = computed(() => canUseWhereSearch.value && !!props.connectionId && !!props.tableMeta);
type DataGridTableMeta = NonNullable<typeof props.tableMeta>;
const hiveTableTransactional = ref<boolean | undefined>(undefined);
const resultSourceColumns = computed(() => props.result.columns.map((column, index) => props.sourceColumns?.[index] ?? column));
const canEditExistingRows = computed(
  () => !!props.customSaveHandler || (canEditExistingTableRows(props.databaseType, hiveTableTransactional.value, props.tableMeta?.primaryKeys ?? []) && hasCompleteTdengineRowIdentity(props.databaseType, props.tableMeta?.primaryKeys ?? [], resultSourceColumns.value)),
);
const customReadonlyColumns = computed(() => new Set((props.customSaveHandler?.readonlyColumns ?? []).map((column) => column.toLowerCase())));
const hasDataGridSaveTarget = computed(() => !!props.tableMeta || !!props.customSaveHandler);
const hasDataGridInsertTarget = computed(() => {
  if (props.allowInsertRows === false) return false;
  const handler = props.customSaveHandler;
  if (handler) return handler.supportsInsert === true || handler.canInsert === true;
  return !!props.tableMeta && canInsertTableRows(props.databaseType);
});
const canInsertRows = computed(() => !!props.editable && hasDataGridInsertTarget.value);
const canDeleteRows = computed(() => props.allowDeleteRows !== false && (!props.customSaveHandler || props.customSaveHandler.canDelete !== false));
const canDeleteExistingRows = computed(() => !!props.customSaveHandler || canDeleteExistingTdengineRows(props.databaseType, props.tableMeta?.primaryKeys ?? []));
watch(
  () => [props.databaseType, props.connectionId, props.database, props.tableMeta?.schema, props.tableMeta?.tableName],
  async () => {
    if (props.databaseType !== "hive" || !props.connectionId || !props.database || !props.tableMeta) {
      hiveTableTransactional.value = undefined;
      return;
    }
    try {
      const sql = await buildHiveTablePropertiesSql({
        schema: props.tableMeta.schema,
        tableName: props.tableMeta.tableName,
        propertyName: "transactional",
      });
      const result = await api.executeQuery(props.connectionId, props.database, sql, props.tableMeta.schema);
      hiveTableTransactional.value = hiveTablePropertiesIndicateTransactional(result);
    } catch {
      hiveTableTransactional.value = false;
    }
  },
  { immediate: true },
);
const clientSearchText = computed(() => (searchText.value.trim() ? searchText.value : ""));
watch(clientSearchText, (value) => {
  clearTimeout(_searchTimer);
  const q = value.trim().toLowerCase();
  if (!q) {
    deferredClientSearchText.value = "";
    return;
  }
  _searchTimer = setTimeout(() => {
    deferredClientSearchText.value = q;
  }, 150);
});

function currentWhereInput(): string | undefined {
  return combineWhereInputs(whereFilterInput.value, appliedStructuredWhereInput.value);
}

function currentOrderBy(): string | undefined {
  return orderByInput.value.trim() || (sortCol.value ? `${queryColumnRef(sortCol.value)} ${sortDir.value.toUpperCase()}` : undefined);
}

watch(
  () => [props.countSql ?? "", props.tableMeta?.schema ?? "", props.tableMeta?.tableName ?? "", currentWhereInput() ?? "", props.database ?? "", props.connectionId ?? "", props.result],
  () => {
    manualTotalRowCount.value = undefined;
    // Reset infinite-scroll allLoaded when query context changes
    infiniteScrollAllLoaded = false;
  },
);

function syncOrderByInputWithSort(column: string | null, direction: "asc" | "desc" | null) {
  const nextOrderByInput = column && direction ? `${queryColumnRef(column)} ${direction.toUpperCase()}` : "";
  orderByInput.value = nextOrderByInput;
  emit("update:orderByInput", nextOrderByInput);
}

watch(
  () => [props.sortColumn, props.sortColumnIndex, props.sortDirection, props.sortMode] as const,
  ([column, columnIndex, direction, mode], previous) => {
    const wasControlledSort = !!previous?.[0] && !!previous?.[2];
    const isControlledSort = !!column && !!direction;
    sortCol.value = column && direction ? column : null;
    sortColIndex.value = typeof columnIndex === "number" && direction ? columnIndex : null;
    sortDir.value = direction ?? "asc";
    sortMode.value = mode ?? "database";
    if (isControlledSort && sortMode.value === "database") {
      syncOrderByInputWithSort(sortCol.value, sortDir.value);
    } else if (wasControlledSort) {
      syncOrderByInputWithSort(null, null);
    }
  },
  { immediate: true },
);

function firstPage() {
  if (currentPage.value <= 1) return;
  currentPage.value = 1;
  lastInfiniteScrollPage = 0;
  resetGridVerticalScroll(true);
  emit("paginate", 0, pageSize.value, currentWhereInput(), currentOrderBy());
}
function prevPage() {
  if (currentPage.value <= 1) return;
  currentPage.value--;
  resetGridVerticalScroll(true);
  emit("paginate", (currentPage.value - 1) * pageSize.value, pageSize.value, currentWhereInput(), currentOrderBy());
}
function nextPage() {
  if (!canGoNextPage.value) return;
  currentPage.value++;
  resetGridVerticalScroll(true);
  emit("paginate", (currentPage.value - 1) * pageSize.value, pageSize.value, currentWhereInput(), currentOrderBy());
}

function infiniteScrollNextPage() {
  if (infiniteScrollLoading.value || props.loading) return;
  const nextPageNum = currentPage.value + 1;
  const cumulativeLimit = nextPageNum * pageSize.value;
  if (cumulativeLimit > infiniteScrollMaxRows.value) return;
  // Stop if we already know all data is loaded
  if (infiniteScrollAllLoaded) return;
  // Skip if we already have this many rows loaded (e.g. cached data)
  if (props.result.rows.length >= cumulativeLimit) {
    currentPage.value = nextPageNum;
    return;
  }
  infiniteScrollLoading.value = true;
  isInfiniteScrollPaginating.value = true;
  currentPage.value = nextPageNum;
  // Load cumulative data (all rows up to current page) to append instead of replace
  emit("paginate", 0, cumulativeLimit, currentWhereInput(), currentOrderBy());
}
function checkInfiniteScroll(scroller: HTMLElement) {
  if (!infiniteScrollEnabled.value || infiniteScrollLoading.value || props.loading) return;
  if (infiniteScrollAllLoaded) return;
  if (infiniteScrollCheckScheduled) return;
  infiniteScrollCheckScheduled = true;
  requestAnimationFrame(() => {
    infiniteScrollCheckScheduled = false;
    // Only trigger when near bottom AND page has changed since last trigger
    if (isDataGridNearScrollBottom(scroller) && currentPage.value !== lastInfiniteScrollPage) {
      lastInfiniteScrollPage = currentPage.value;
      infiniteScrollNextPage();
    }
  });
}

function changePageSize(size: number) {
  const normalizedSize = normalizeResultPageSize(size);
  pageSize.value = normalizedSize;
  settingsStore.updateEditorSettings({ pageSize: normalizedSize });
  currentPage.value = 1;
  lastInfiniteScrollPage = 0;
  infiniteScrollAllLoaded = false;
  infiniteScrollPositions = new WeakMap();
  resetGridVerticalScroll(true);
  emit("paginate", 0, normalizedSize, currentWhereInput(), currentOrderBy());
}

function applyCustomPageSize() {
  changePageSize(normalizeResultPageSize(customPageSizeInput.value, pageSize.value));
}

async function lastPage() {
  if (infiniteScrollEnabled.value) return;
  if (hasKnownTotalRowCount.value) {
    const total = displayedTotalRowCount.value ?? 0;
    if (total <= 0) return;
    const lastPageNum = Math.ceil(total / pageSize.value);
    if (lastPageNum <= currentPage.value) return;
    currentPage.value = lastPageNum;
    resetGridVerticalScroll(true);
    emit("paginate", (lastPageNum - 1) * pageSize.value, pageSize.value, currentWhereInput(), currentOrderBy());
    return;
  }
  if (allRowsLoaded.value) {
    const total = props.result.rows.length;
    if (total <= 0) return;
    const lastPageNum = Math.ceil(total / pageSize.value);
    if (lastPageNum <= currentPage.value) return;
    currentPage.value = lastPageNum;
    resetGridVerticalScroll(true);
    return;
  }
  if (!props.connectionId) return;
  const countTarget = await buildCurrentCountTarget();
  const sql = countTarget?.sql;
  if (!sql) return;
  try {
    const result = await api.executeQuery(props.connectionId, props.executionDatabase ?? props.database ?? "", sql, countTarget.schema);
    const total = Number(result.rows?.[0]?.[0] ?? 0);
    if (total <= 0) return;
    const lastPageNum = Math.ceil(total / pageSize.value);
    if (lastPageNum <= currentPage.value) return;
    currentPage.value = lastPageNum;
    resetGridVerticalScroll(true);
    emit("paginate", (lastPageNum - 1) * pageSize.value, pageSize.value, currentWhereInput(), currentOrderBy());
  } catch {
    // COUNT query failed — ignore silently
  }
}

async function buildCurrentCountTarget(): Promise<{ sql: string; schema?: string } | undefined> {
  if (props.countSql) return { sql: props.countSql, schema: props.schema };
  if (props.tableMeta) {
    const sql = await buildDataGridCountSql({
      databaseType: props.databaseType,
      catalog: props.tableMeta.catalog,
      schema: props.tableMeta.schema,
      tableName: props.tableMeta.tableName,
      whereInput: currentWhereInput(),
    });
    return { sql, schema: props.context === "table-data" ? undefined : (props.tableMeta.schema ?? props.schema) };
  }
  return undefined;
}

async function calculateTotalRowCount() {
  if (!props.connectionId || manualTotalRowCountLoading.value) return;
  manualTotalRowCountLoading.value = true;
  try {
    const countTarget = await buildCurrentCountTarget();
    if (!countTarget?.sql) return;
    const result = await api.executeQuery(props.connectionId, props.executionDatabase ?? props.database ?? "", countTarget.sql, countTarget.schema);
    const total = Number(result.rows?.[0]?.[0] ?? 0);
    if (Number.isFinite(total) && total >= 0) {
      manualTotalRowCount.value = total;
    }
  } catch (e: any) {
    toast(t("grid.calculateTotalRowsFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    manualTotalRowCountLoading.value = false;
  }
}

// --- Editing (composable) ---

interface RowItem {
  id: number;
  displayIndex: number;
  sourceIndex?: number;
  newIndex?: number;
  data: CellValue[];
  isNew: boolean;
  isDraft?: boolean;
  isDeleted: boolean;
  isDirtyCol: boolean[];
  status: RowStatus;
}

type DisplayRowRef =
  | {
      id: number;
      displayIndex: number;
      sourceIndex: number;
      isNew: false;
      isDeleted: boolean;
      status: RowStatus;
    }
  | {
      id: number;
      displayIndex: number;
      newIndex: number;
      isNew: true;
      isDeleted: false;
      status: RowStatus;
    }
  | {
      id: number;
      displayIndex: number;
      isNew: false;
      isDraft: true;
      isDeleted: false;
      status: RowStatus;
    };

const editor = useDataGridEditor({
  result: computed(() => props.result),
  editable: computed(() => props.editable),
  databaseType: computed(() => props.databaseType),
  connectionId: computed(() => props.connectionId),
  database: computed(() => props.executionDatabase ?? props.database),
  tableMeta: computed(() => props.tableMeta),
  sourceColumns: computed(() => props.sourceColumns),
  canEditExistingRows,
  onExecuteSql: computed(() => props.onExecuteSql),
  customSaveHandler: computed(() => props.customSaveHandler),
  sql: computed(() => props.sql),
  searchText,
  whereFilterInput,
  currentWhereInput: computed(() => currentWhereInput()),
  orderByInput,
  rowStatusFilter,
  dataGridQuickEntryEnabled: computed(() => settingsStore.editorSettings.dataGridQuickEntry),
  initialEditColumn: firstVisibleColumnIndex,
  getRowItem,
  pageSize,
  currentPage,
  cacheKey: computed(() => props.cacheKey),
  emit,
});

const {
  editingCell,
  editValue,
  scrollerRef,
  dirtyRows,
  newRows,
  deletedRows,
  quickEntryDraftRow,
  quickEntryDraftRowId,
  pendingChangesVersion,
  pendingChangeCount,
  hasPendingChanges,
  transactionActive,
  isSaving,
  saveError,
  useTransaction,
  exitTransaction,
  startEdit,
  commitEdit,
  commitEditAndMaybeAutoSave,
  commitEditFromBlur,
  applyCellValue,
  restoreCellValue,
  cancelEdit,
  onEditKeydown,
  addRow: addEditorRow,
  cloneRow,
  showDeleteRowConfirm,
  requestDeleteRow,
  confirmDeleteRow,
  restoreRow,
  restoreRows,
  pendingDeleteRowIds,
  requestDeleteRows,
  cloneRows,
  saveChanges,
  discardChanges,
  canUndoPendingChange,
  canRedoPendingChange,
  undoPendingChange,
  redoPendingChange,
  rowDataWithChanges,
  ensureQuickEntryDraftRow,
  isSavingNewRow,
  canEditColumn,
  resetGridVerticalScroll,
  getResetScrollAfterResult,
  clearResetScrollAfterResult,
  cleanupFrames,
  recordScrollPosition,
  isPreviewLoading,
  previewChanges,
} = editor;
const pendingQuickEntryDraftCellFocus = ref<{ rowId: number; col: number } | null>(null);

const showSqlPreview = ref(false);
const previewSqlText = ref("");

let previewRefreshTimer: ReturnType<typeof setTimeout> | null = null;

async function refreshPreviewSql() {
  if (!showSqlPreview.value) return;
  const stmts = await previewChanges();
  if (showSqlPreview.value) {
    previewSqlText.value = stmts.join("\n");
  }
}

function schedulePreviewRefresh() {
  if (!showSqlPreview.value) return;
  if (pendingChangeCount.value === 0) {
    // Keep the panel visible so undo/redo results are explicit in the SQL preview area.
    previewSqlText.value = "";
    return;
  }
  if (previewRefreshTimer) clearTimeout(previewRefreshTimer);
  previewRefreshTimer = setTimeout(() => {
    previewRefreshTimer = null;
    void refreshPreviewSql();
  }, 500);
}

async function openSqlPreview() {
  const stmts = await previewChanges();
  previewSqlText.value = stmts.join("\n");
  if (stmts.length > 0) {
    showSqlPreview.value = true;
  }
}

function closeSqlPreview() {
  showSqlPreview.value = false;
  if (previewRefreshTimer) {
    clearTimeout(previewRefreshTimer);
    previewRefreshTimer = null;
  }
}

// Watch for edits — auto-refresh preview when panel is open
watch([pendingChangeCount, pendingChangesVersion], () => {
  schedulePreviewRefresh();
});

const saveActionMode = computed(() =>
  dataGridSaveActionMode({
    pendingChangeCount: pendingChangeCount.value,
    useTransaction: !!useTransaction.value,
  }),
);
const saveToolbarState = computed(() =>
  dataGridSaveToolbarState({
    editable: props.editable,
    hasSaveTarget: hasDataGridSaveTarget.value,
    hasPendingChanges: hasPendingChanges.value,
    isSaving: isSaving.value,
  }),
);
const hasSearchBarSlot = computed(() => !!slots["search-bar"]);
const hasResultToolbarLeadingSlot = computed(() => !!slots["result-toolbar-leading"]);
const hasResultToolbarActionsSlot = computed(() => !!slots["result-toolbar-actions"]);
const quickEntryEnabled = computed(() => settingsStore.editorSettings.dataGridQuickEntry);
const showQuickEntryDraftRow = computed(() =>
  shouldShowQuickEntryDraftRow({
    editable: !!props.editable,
    hasInsertTarget: hasDataGridInsertTarget.value,
    quickEntryEnabled: quickEntryEnabled.value,
    rowStatusFilter: rowStatusFilter.value,
    hasPendingChanges: hasPendingChanges.value,
  }),
);
const showDataGridTopbar = computed(
  () =>
    (useTransaction.value && !!props.editable && hasDataGridSaveTarget.value) ||
    hasLocalColumnFilters.value ||
    canShowWhereSearch.value ||
    hasSearchBarSlot.value ||
    hasResultToolbarLeadingSlot.value ||
    hasResultToolbarActionsSlot.value ||
    showQueryEditReadOnlyBadge.value ||
    props.context !== "results" ||
    (!!props.editable && hasDataGridSaveTarget.value) ||
    transactionActive.value ||
    saveToolbarState.value.showActions,
);

function canEditRowItem(item: RowItem | undefined): boolean {
  return !!props.editable && !!item && !item.isDeleted && (item.isNew || item.isDraft || canEditExistingRows.value);
}

function canEditCellItem(item: RowItem | undefined, columnIndex: number): boolean {
  if (!canEditRowItem(item) || !canEditColumn(columnIndex)) return false;
  if (isSavingNewRow(item)) return false;
  const column = props.result.columns[columnIndex] ?? "";
  if (customReadonlyColumns.value.has(column.toLowerCase())) return false;
  if (!item?.isNew && !item?.isDraft) {
    const sourceColumn = props.sourceColumns?.[columnIndex] ?? column;
    if (isClickHouseExistingRowReadonlyColumn(props.databaseType, sourceColumn, props.tableMeta?.primaryKeys ?? [], props.tableMeta?.columns ?? [])) return false;
    if (isTdengineExistingRowReadonlyColumn(props.databaseType, column, props.tableMeta?.columns ?? [])) return false;
  }
  return true;
}

function cellUsesExpandedEditor(rowId: number | undefined, columnIndex: number): boolean {
  return !!expandedCellEditor.value && expandedCellEditor.value.rowId === rowId && expandedCellEditor.value.col === columnIndex;
}

function startCellEdit(rowId: number, columnIndex: number, expanded: boolean) {
  expandedCellEditor.value = expanded ? { rowId, col: columnIndex } : null;
  startEdit(rowId, columnIndex);
}

function startDomCellEdit(rowId: number, columnIndex: number, displayText: string, event: MouseEvent) {
  const item = getRowItem(rowId);
  const editText = item ? cellEditorTextForValue(item.data[columnIndex], columnIndex) : displayText;
  startCellEdit(rowId, columnIndex, cellEditContentNeedsExpandedEditor({ displayText, editText, target: event.currentTarget }));
}

function cellEditContentNeedsExpandedEditor(options: { displayText: string; editText: string; target: EventTarget | null }): boolean {
  const text = options.editText || options.displayText;
  if (text.includes("\n") || text.includes("\r")) return true;
  if (text.length > options.displayText.length) return true;
  return cellTextOverflowsElement(options.displayText, options.target);
}

function cellEditorTextForValue(value: CellValue | undefined, columnIndex: number): string {
  return dataGridCellEditorText({
    value: value ?? null,
    databaseType: props.databaseType,
    columnInfo: tableColumnForGridColumn(columnIndex),
  });
}

function cellTextOverflowsElement(text: string, target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(target);
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
  const paddingRight = Number.parseFloat(style.paddingRight) || 0;
  const availableWidth = Math.max(0, target.clientWidth - paddingLeft - paddingRight - 2);
  return measureCellTextWidth(text, style.font) > availableWidth;
}

function measureCellTextWidth(text: string, font: string): number {
  const canvas = canvasRef.value ?? document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return 0;
  context.save();
  context.font = font;
  const width = context.measureText(text).width;
  context.restore();
  return width;
}

function tableColumnForGridColumn(columnIndex: number): ColumnInfo | undefined {
  const columnName = props.sourceColumns?.[columnIndex] ?? props.result.columns[columnIndex];
  if (!columnName) return undefined;
  return props.tableMeta?.columns.find((column) => column.name.toLowerCase() === columnName.toLowerCase());
}

function resultColumnInfoForGridColumn(columnIndex: number): Pick<ColumnInfo, "data_type"> | undefined {
  const dataType = props.result.column_types?.[columnIndex]?.trim();
  return dataType ? { data_type: dataType } : undefined;
}

function temporalEditorConfigForColumn(columnIndex: number): TemporalCellEditorConfig | undefined {
  return temporalCellEditorConfig(tableColumnForGridColumn(columnIndex), props.databaseType);
}

function enumValuesForGridColumn(columnIndex: number): string[] {
  return tableColumnForGridColumn(columnIndex)?.enum_values ?? [];
}

function isEnumGridColumn(columnIndex: number): boolean {
  return (tableColumnForGridColumn(columnIndex)?.enum_values?.length ?? 0) > 0;
}

function isEnumGridColumnNullable(columnIndex: number): boolean {
  return tableColumnForGridColumn(columnIndex)?.is_nullable ?? false;
}

function isEnumEditorInitialNull(rowId: number | undefined, columnIndex: number): boolean {
  if (rowId === undefined) return false;
  return getRowItem(rowId)?.data[columnIndex] === null;
}

function cellEditInputModeForColumn(columnIndex: number): "decimal" | "numeric" | undefined {
  const dataType = normalizedColumnDataType(tableColumnForGridColumn(columnIndex));
  if (isIntegerColumnType(dataType)) return "numeric";
  if (isDecimalColumnType(dataType)) return "decimal";
  return undefined;
}

function normalizedColumnDataType(column: ColumnInfo | undefined): string {
  return (column?.data_type ?? "").trim().toLowerCase();
}

function isIntegerColumnType(dataType: string): boolean {
  return /^(tinyint|smallint|mediumint|int|integer|bigint|serial|smallserial|bigserial|int2|int4|int8|uint|uint8|uint16|uint32|uint64)\b/.test(dataType);
}

function isDecimalColumnType(dataType: string): boolean {
  return /^(decimal|numeric|number|float|double|real|money|smallmoney|dec|fixed)\b/.test(dataType);
}

function canDeleteRowItem(item: RowItem | undefined): boolean {
  if (!item) return false;
  return canDeleteGridRowItem({
    editable: !!props.editable && canDeleteRows.value,
    isDraft: !!item.isDraft,
    isDeleted: item.isDeleted,
    isNew: item.isNew,
    canEditExistingRows: canEditExistingRows.value && canDeleteExistingRows.value,
    isSavingNewRow: isSavingNewRow(item),
  });
}

function resetInfiniteScrollState() {
  currentPage.value = 1;
  lastInfiniteScrollPage = 0;
  infiniteScrollAllLoaded = false;
  isInfiniteScrollPaginating.value = false;
  infiniteScrollLoading.value = false;
  infiniteScrollPositions = new WeakMap();
  resetGridVerticalScroll(true);
}

async function onToolbarRefresh() {
  if (transactionActive.value) {
    discardChanges();
  }
  // Reset infinite scroll state on refresh
  if (infiniteScrollEnabled.value) {
    resetInfiniteScrollState();
  }
  preserveTransposeOnNextResult.value = showTranspose.value;
  isRefreshingData.value = true;
  emit("reload", props.sql, searchText.value, currentWhereInput(), currentOrderBy(), pageSize.value, (currentPage.value - 1) * pageSize.value, "refresh");
}

function stopAutoRefreshTimer() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = undefined;
}

function runAutoRefreshTick() {
  if (!autoRefreshEnabled.value || !canAutoRefresh.value) return;
  void onToolbarRefresh();
}

function restartAutoRefreshTimer() {
  stopAutoRefreshTimer();
  if (!autoRefreshEnabled.value) return;
  autoRefreshTimer = setInterval(runAutoRefreshTick, autoRefreshIntervalSeconds.value * 1000);
}

function setAutoRefreshInterval(seconds: number) {
  autoRefreshIntervalSeconds.value = seconds;
  if (autoRefreshEnabled.value) restartAutoRefreshTimer();
}

function toggleAutoRefresh() {
  autoRefreshEnabled.value = !autoRefreshEnabled.value;
  if (autoRefreshEnabled.value) {
    restartAutoRefreshTimer();
  } else {
    stopAutoRefreshTimer();
  }
}

async function onToolbarCommit() {
  await saveChanges();
}

function onToolbarRollback() {
  preserveTransposeOnNextResult.value = showTranspose.value;
  discardChanges();
  // Reset infinite scroll state on rollback
  if (infiniteScrollEnabled.value) {
    resetInfiniteScrollState();
  }
  isRefreshingData.value = true;
  emit("reload", props.sql, searchText.value, currentWhereInput(), currentOrderBy(), pageSize.value, (currentPage.value - 1) * pageSize.value);
}

function addRow() {
  if (!canInsertRows.value) return;
  addEditorRow();
  focusAppendedTransposeRecord();
}

const sortedRows = computed(() => {
  let indices = localFilteredRows.value;
  const q = deferredClientSearchText.value;
  if (q && dataGridSearchMode.value === "filter") {
    // Preserve the legacy Ctrl+F behavior when the user chooses row filtering.
    const rows = props.result.rows;
    indices = indices.filter((sourceIndex) => {
      const data = rows[sourceIndex];
      return data.some((cell, columnIndex) => cell !== null && formatCellCached(cell, columnIndex).toLowerCase().includes(q));
    });
  }
  return indices;
});

const cleanDirtyColumns = computed(() => Object.freeze(Array(props.result.columns.length).fill(false)) as boolean[]);

function dirtyColumnsForRow(dirty: Map<number, CellValue> | undefined, columnCount: number): boolean[] {
  if (!dirty?.size) return cleanDirtyColumns.value;
  const flags = Array(columnCount).fill(false) as boolean[];
  for (const colIdx of dirty.keys()) {
    if (colIdx >= 0 && colIdx < columnCount) flags[colIdx] = true;
  }
  return flags;
}

const displayRowRefs = computed<DisplayRowRef[]>(() => {
  const refs: DisplayRowRef[] = [];
  for (const sourceIndex of sortedRows.value) {
    const dirty = dirtyRows.value.get(sourceIndex);
    const isDeleted = deletedRows.value.has(sourceIndex);
    const status: RowStatus = isDeleted ? "deleted" : dirty?.size ? "edited" : "clean";
    const isActiveEditingRow = quickEntryEnabled.value && editingCell.value?.rowId === sourceIndex;
    if (matchesRowStatusFilter(status, rowStatusFilter.value) || isActiveEditingRow) {
      refs.push({ id: sourceIndex, displayIndex: refs.length, sourceIndex, isNew: false, isDeleted, status });
    }
  }
  newRows.value.forEach((row, i) => {
    if (!rowMatchesLocalColumnFilters(row)) return;
    const status: RowStatus = "new";
    if (!matchesRowStatusFilter(status, rowStatusFilter.value)) return;
    refs.push({
      id: -(i + 1),
      displayIndex: refs.length,
      newIndex: i,
      isNew: true,
      isDeleted: false,
      status,
    });
  });
  if (showQuickEntryDraftRow.value) {
    ensureQuickEntryDraftRow();
    refs.push({
      id: quickEntryDraftRowId,
      displayIndex: refs.length,
      isNew: false,
      isDraft: true,
      isDeleted: false,
      status: "draft",
    });
  }
  return refs;
});

const displayRowCount = computed(() => displayRowRefs.value.length);

const displayRowIndexByIdLookup = computed(() => {
  const lookup = new Map<number, number>();
  displayRowRefs.value.forEach((ref, index) => {
    lookup.set(ref.id, index);
  });
  return lookup;
});

function rowItemFromDisplayRef(ref: DisplayRowRef): RowItem {
  if (ref.isNew) {
    return {
      ...ref,
      data: newRows.value[ref.newIndex] ?? cleanDirtyColumns.value.map(() => null),
      isDirtyCol: cleanDirtyColumns.value,
    };
  }
  if (!("sourceIndex" in ref)) {
    ensureQuickEntryDraftRow();
    return {
      ...ref,
      data: quickEntryDraftRow.value,
      isDirtyCol: cleanDirtyColumns.value,
    };
  }
  const row = props.result.rows[ref.sourceIndex] ?? [];
  const dirty = dirtyRows.value.get(ref.sourceIndex);
  return {
    ...ref,
    data: rowDataWithChanges(row, ref.sourceIndex),
    isDirtyCol: dirtyColumnsForRow(dirty, props.result.columns.length),
  };
}

function displayItemAt(rowIndex: number): RowItem | undefined {
  const ref = displayRowRefs.value[rowIndex];
  return ref ? rowItemFromDisplayRef(ref) : undefined;
}

function displayRowIndexById(rowId: number): number {
  // Multi-row actions call getRowItem for each selected row; keep that lookup O(1).
  return displayRowIndexByIdLookup.value.get(rowId) ?? -1;
}

const displayItems = computed<RowItem[]>(() => displayRowRefs.value.map(rowItemFromDisplayRef));

watch(
  () => displayRowCount.value,
  (length) => {
    const shouldLogTiming = isDebugLoggingEnabled();
    const startedAt = shouldLogTiming ? performance.now() : 0;
    if (shouldLogTiming) {
      logDataGridTiming("[DBX][DataGrid:display-items:ready]", {
        traceId: dataGridTraceId,
        cacheKey: props.cacheKey,
        displayItemCount: length,
        sourceRowCount: props.result.rows.length,
        elapsedSinceSetup: dataGridElapsed(),
      });
    }
    nextTick(() => {
      const scrollerEl = gridRef.value?.querySelector<HTMLElement>(".data-grid-scroller");
      if (scrollerEl) {
        updateGridScrollbarGutter(scrollerEl);
        updateGridHorizontalViewport(scrollerEl);
      }
      if (!shouldLogTiming) return;
      requestAnimationFrame(() => {
        const renderedRows = gridRef.value?.querySelectorAll(".vue-recycle-scroller__item-view").length;
        logDataGridTiming("[DBX][DataGrid:display-items:first-frame]", {
          traceId: dataGridTraceId,
          cacheKey: props.cacheKey,
          displayItemCount: length,
          renderedRows,
          elapsed: `${Math.round(performance.now() - startedAt)}ms`,
          elapsedSinceSetup: dataGridElapsed(),
          loading: props.loading,
        });
      });
    });
  },
  { immediate: true },
);

interface SearchMatch {
  kind: "cell" | "column";
  displayRow: number; // -1 for column matches
  col: number;
}

const searchMatches = computed<SearchMatch[]>(() => {
  const q = deferredClientSearchText.value;
  if (!q) return [];
  const lowered = q.toLowerCase();
  const items = displayItems.value;
  const matches: SearchMatch[] = [];

  // Column name matches (navigate first)
  for (let c = 0; c < props.result.columns.length; c++) {
    if (props.result.columns[c].toLowerCase().includes(lowered)) {
      matches.push({ kind: "column", displayRow: -1, col: c });
    }
  }

  // Cell value matches
  for (let r = 0; r < items.length; r++) {
    const data = items[r].data;
    for (let c = 0; c < data.length; c++) {
      if (data[c] !== null && formatCellCached(data[c], c).toLowerCase().includes(lowered)) {
        matches.push({ kind: "cell", displayRow: r, col: c });
      }
    }
  }
  return matches;
});

const searchMatchSet = computed(() => {
  const set = new Set<string>();
  for (const m of searchMatches.value) {
    set.add(`${m.kind}:${m.displayRow}:${m.col}`);
  }
  return set;
});

const currentSearchMatch = computed(() => {
  const idx = currentMatchIndex.value;
  if (idx < 0 || idx >= searchMatches.value.length) return null;
  return searchMatches.value[idx] ?? null;
});

watch(searchMatches, (matches) => {
  currentMatchIndex.value = matches.length > 0 ? 0 : -1;
  if (matches.length > 0) nextTick(scrollToCurrentMatch);
});

function cellIsSearchMatch(displayRow: number, col: number): boolean {
  if (isScrolling.value) return false;
  return searchMatchSet.value.has(`cell:${displayRow}:${col}`);
}

function cellIsCurrentMatch(displayRow: number, col: number): boolean {
  if (isScrolling.value) return false;
  const m = currentSearchMatch.value;
  if (!m) return false;
  return m.kind === "cell" && m.displayRow === displayRow && m.col === col;
}

// Transpose view renders fields as rows; a column-name match (displayRow = -1)
// maps to the field row header at the field's column index.
function transposeHeaderIsSearchMatch(fieldIndex: number): boolean {
  if (isScrolling.value) return false;
  return searchMatchSet.value.has(`column:-1:${fieldIndex}`);
}

function transposeHeaderIsCurrentMatch(fieldIndex: number): boolean {
  if (isScrolling.value) return false;
  const m = currentSearchMatch.value;
  if (!m) return false;
  return m.kind === "column" && m.col === fieldIndex;
}

function navigateMatch(delta: number) {
  const total = searchMatches.value.length;
  if (total === 0) return;
  currentMatchIndex.value = (currentMatchIndex.value + delta + total) % total;
  scrollToCurrentMatch();
}

function scrollToCurrentMatch() {
  const idx = currentMatchIndex.value;
  if (idx < 0 || idx >= searchMatches.value.length) return;
  const match = searchMatches.value[idx];
  if (showTranspose.value) {
    scrollTransposeMatchIntoView(match);
    return;
  }
  const visibleColIdx = visibleColumnIndexes.value.indexOf(match.col);
  if (visibleColIdx >= 0) scrollGridColumnIntoView(visibleColIdx);
  if (match.kind === "column") {
    // Scroll to top so the column header is visible
    const scrollEl = gridRef.value;
    if (scrollEl) scrollEl.scrollTop = 0;
    if (useCanvasGridRows.value) {
      const scroller = canvasScrollerElement();
      if (scroller) scroller.scrollTop = 0;
    }
    return;
  }
  const scrollEl = gridRef.value;
  if (!scrollEl) return;
  if (useCanvasGridRows.value) {
    const scroller = canvasScrollerElement();
    if (!scroller) return;
    const targetTop = Math.max(0, match.displayRow * CANVAS_DATA_GRID_ROW_HEIGHT - (scroller.clientHeight - CANVAS_DATA_GRID_ROW_HEIGHT) / 2);
    scroller.scrollTop = targetTop;
    syncCanvasViewport();
    return;
  }
  const rowEl = scrollEl.querySelector(`[data-row-index="${match.displayRow}"]`) as HTMLElement | null;
  if (rowEl) rowEl.scrollIntoView({ block: "center" });
}

// In transpose view records are columns (horizontal) and fields are rows
// (vertical). Bring the matched record column into the horizontal viewport and
// the matched field row into the vertical viewport.
function scrollTransposeMatchIntoView(match: SearchMatch) {
  nextTick(() => {
    const scroller = transposeScrollRef.value;
    // Both match kinds use `col` as the field (transpose row) index: cell
    // matches store the field/value index, column-name matches store the field.
    const fieldIndex = match.col;
    if (scroller && !(scroller instanceof HTMLElement)) {
      // RecycleScroller component instance exposes scrollToItem via vue-virtual-scroller.
      (scroller as { scrollToItem?: (index: number) => void }).scrollToItem?.(fieldIndex);
    } else if (scroller instanceof HTMLElement) {
      scroller.scrollTop = fieldIndex * 30;
    }
    if (match.kind === "cell") {
      scrollTransposeRecordIntoView(match.displayRow);
    }
  });
}

function getRowItem(rowId: number): RowItem | undefined {
  const rowIndex = displayRowIndexById(rowId);
  return rowIndex >= 0 ? displayItemAt(rowIndex) : undefined;
}

function visibleRowData(row: CellValue[]): CellValue[] {
  return visibleColumnIndexes.value.map((index) => row[index]);
}

function visibleDirtyColumns(row: boolean[]): boolean[] {
  return visibleColumnIndexes.value.map((index) => row[index] ?? false);
}

const visibleDisplayItems = computed<RowItem[]>(() =>
  displayItems.value.map((item) => ({
    ...item,
    data: visibleRowData(item.data),
    isDirtyCol: visibleDirtyColumns(item.isDirtyCol),
  })),
);
const exportContextCell = computed(() => {
  if (!contextCell.value) return null;
  const visibleCol = visibleColumnIndexes.value.indexOf(contextCell.value.col);
  return { ...contextCell.value, col: visibleCol };
});

const deleteRowDetails = computed(() => (props.tableMeta?.tableName ? t("dangerDialog.deleteRowDetails", { table: props.tableMeta.tableName }) : t("dangerDialog.deleteRowDetailsNoTable")));

const hasVisibleRows = computed(() => displayRowCount.value > 0);
const hasActiveFilter = computed(() => (dataGridSearchMode.value === "filter" && !!deferredClientSearchText.value) || rowStatusFilter.value !== "all" || hasLocalColumnFilters.value);
const emptyTitle = computed(() => (hasActiveFilter.value ? t("grid.noFilteredRows") : t("grid.noRows")));
const emptyDescription = computed(() => (hasActiveFilter.value ? t("grid.noFilteredRowsDescription") : t("grid.noRowsDescription")));
watch(
  () => [hasVisibleRows.value, props.result.columns.length] as const,
  () => {
    nextTick(refreshGridScrollerMetrics);
  },
  { immediate: true },
);
const isErrorResult = computed(() => props.result.columns.length === 1 && props.result.columns[0] === "Error" && props.result.rows.length > 0);
const errorMessage = computed(() => (isErrorResult.value ? String(props.result.rows[0]?.[0] ?? "") : ""));
// --- Selection composable ---
const selection = useDataGridSelection({
  columns: visibleColumns,
  displayItems: visibleDisplayItems,
  editingCell,
  showTranspose,
  transposeRowIndex,
  gridRef,
  getScrollElement: dataGridSelectionScroller,
  cellFromClientPoint: dataGridCellFromClientPoint,
});

const {
  isSelectingAll,
  selectedRange,
  selectedCells,
  selectedCellCount,
  hasCellSelection,
  clearCellSelection,
  selectSingleCell,
  selectRow,
  selectColumn,
  selectAllCells,
  extendCellSelectionTo,
  finishCellSelection,
  extendCellSelection,
  cellIsSelected,
  columnIsSelected,
  selectedRangeStart,
  selectedRowIds,
  selectedColumnIndexes,
  hasRowSelection,
  selectedRowCount,
  hasColumnSelection,
  clearRowSelection,
  handleRowClick,
  handleDataCellMousedown,
  isRowSelected,
} = selection;

const multiRowCount = computed(() => {
  if (hasRowSelection.value) return selectedRowCount.value;
  const range = selectedRange.value;
  if (range && range.startRow !== range.endRow) return range.endRow - range.startRow + 1;
  return 1;
});

const selectionSummary = computed(() => (hasCellSelection.value ? summarizeSelection(selectedCells.value) : null));
const selectionSummarySumText = computed(() => {
  const summary = selectionSummary.value;
  if (!summary) return "0";
  const sum = Object.is(summary.sum, -0) ? 0 : summary.sum;
  return Number.isInteger(sum) ? String(sum) : sum.toLocaleString(undefined, { maximumFractionDigits: 12 });
});

const isMultiRow = computed(() => multiRowCount.value > 1);

function onCellMouseenter(rowIndex: number, visibleColIdx: number, actualColIdx: number) {
  if (!isScrolling.value) hoveredDetailCell.value = { rowIndex, col: actualColIdx };
  extendCellSelection(rowIndex, visibleColIdx);
}

function onCellMouseleave(rowIndex: number, actualColIdx: number) {
  if (isScrolling.value) return;
  if (hoveredDetailCell.value?.rowIndex === rowIndex && hoveredDetailCell.value.col === actualColIdx) {
    hoveredDetailCell.value = null;
  }
}

function quickDownloadMenuOpenFor(rowIndex: number, actualColIdx: number): boolean {
  return quickDownloadMenuCell.value?.rowIndex === rowIndex && quickDownloadMenuCell.value.col === actualColIdx;
}

function handleQuickDownloadMenuOpenChange(open: boolean, rowIndex: number, actualColIdx: number) {
  if (open) {
    quickDownloadMenuCell.value = { rowIndex, col: actualColIdx };
    hoveredDetailCell.value = { rowIndex, col: actualColIdx };
    return;
  }
  if (quickDownloadMenuOpenFor(rowIndex, actualColIdx)) {
    quickDownloadMenuCell.value = null;
  }
}

function cellDetailButtonVisible(rowIndex: number, actualColIdx: number) {
  if (isScrolling.value) return false;
  return (hoveredDetailCell.value?.rowIndex === rowIndex && hoveredDetailCell.value.col === actualColIdx) || quickDownloadMenuOpenFor(rowIndex, actualColIdx) || (showCellDetail.value && detailCell.value?.rowIndex === rowIndex && detailCell.value.col === actualColIdx);
}

function affectedRowIds(): number[] {
  if (hasRowSelection.value && selectedRowCount.value > 0) {
    return [...selectedRowIds.value].filter((rowId) => !getRowItem(rowId)?.isDraft);
  }
  const range = selectedRange.value;
  if (range && range.startRow !== range.endRow) {
    return displayRowRefs.value
      .slice(range.startRow, range.endRow + 1)
      .filter((ref) => !("isDraft" in ref && ref.isDraft))
      .map((ref) => ref.id);
  }
  return [];
}

function deletableRowIds(rowIds: number[]): number[] {
  return rowIds.filter((rowId) => canDeleteRowItem(getRowItem(rowId)));
}

function exportSelectedRowsCsv() {
  const rowIds = affectedRowIds();
  if (rowIds.length === 0) return;
  return exportCsv(rowIds);
}

function exportSelectedRowsXlsx() {
  const rowIds = affectedRowIds();
  if (rowIds.length === 0) return;
  return exportXlsx(rowIds);
}

function exportSelectedRowsJson() {
  const rowIds = affectedRowIds();
  if (rowIds.length === 0) return;
  return exportJson(rowIds);
}

function exportSelectedRowsMarkdown() {
  const rowIds = affectedRowIds();
  if (rowIds.length === 0) return;
  return exportMarkdown(rowIds);
}

function exportSelectedRowsSql() {
  const rowIds = affectedRowIds();
  if (rowIds.length === 0) return;
  return exportSql(rowIds);
}

function executePreviewAction(action: { execute: (ctx: any) => any }) {
  const config = action.execute({
    result: props.result,
    selectedRowIds: affectedRowIds(),
    displayRowRefs: displayRowRefs.value.filter((ref) => "sourceIndex" in ref),
  });
  if (config) {
    previewDialogConfig.value = config;
    previewDialogOpen.value = true;
  }
}

function isRowActive(index: number): boolean {
  const item = displayItemAt(index);
  if (item && isRowSelected(item.id)) return true;
  const range = selectedRange.value;
  if (!range) return false;
  const coversAllVisibleRows = range.startRow === 0 && range.endRow >= displayRowCount.value - 1;
  const coversAllVisibleColumns = range.startCol === 0 && range.endCol >= visibleColumnCount.value - 1;
  if (coversAllVisibleRows && !coversAllVisibleColumns) return false;
  return index >= range.startRow && index <= range.endRow;
}

const contextRowItem = computed(() => (contextCell.value ? getRowItem(contextCell.value.rowId) : undefined));
const contextColumn = computed(() => {
  if (!contextCell.value || contextCell.value.col < 0) return null;
  return props.result.columns[contextCell.value.col] ?? null;
});
const contextCellValue = computed<CellValue | null>(() => {
  if (!contextCell.value || contextCell.value.col < 0) return null;
  return contextRowItem.value?.data[contextCell.value.col] ?? null;
});
const contextCellDetail = computed(() => {
  const cell = contextCell.value;
  if (!cell || cell.col < 0) return null;
  return cellDetailFor(cell.rowIndex, cell.col);
});
function cellDetailFor(rowIndex: number, columnIndex: number): DataGridCellDetail | null {
  const item = displayItemAt(rowIndex);
  if (!item) return null;
  return buildDataGridCellDetail({
    rowIndex,
    rowId: item.id,
    row: item.data,
    columns: props.result.columns,
    columnIndex,
    typeByColumn: columnTypeMap.value,
    resultColumnTypes: props.result.column_types,
    commentByColumn: columnCommentMap.value,
    displayValue: (value, index) => formatCellCached(value, index),
    isEditable: canEditGridCellDetail({ canEditCell: canEditCellItem(item, columnIndex), isDraft: !!item.isDraft }),
  });
}

const activeCellDetail = computed(() => {
  const cell = detailCell.value;
  return cell ? cellDetailFor(cell.rowIndex, cell.col) : null;
});

const canShowMongoJsonPreview = computed(() => props.databaseType === "mongodb" && !!props.result.mongo_documents && props.result.mongo_documents.length === props.result.rows.length);
const mongoJsonPreviewOpen = computed(() => showMongoJsonPreview.value && canShowMongoJsonPreview.value);
const activeMongoJsonDocument = computed(() => {
  if (!mongoJsonPreviewOpen.value) return undefined;
  const selectedCell = currentSelectedCellPosition();
  if (!selectedCell) return undefined;
  const item = displayItemAt(selectedCell.rowIndex);
  return item?.sourceIndex === undefined ? undefined : props.result.mongo_documents?.[item.sourceIndex];
});
const mongoJsonPreviewFullText = computed(() => {
  const document = activeMongoJsonDocument.value;
  if (document === undefined) return "";
  try {
    return JSON.stringify(document, null, 2) ?? "";
  } catch {
    return "";
  }
});
const mongoJsonPreviewText = computed(() => mongoJsonPreviewFullText.value.slice(0, CELL_DETAIL_VALUE_PREVIEW_MAX_LENGTH));
const mongoJsonPreviewTruncated = computed(() => mongoJsonPreviewText.value.length < mongoJsonPreviewFullText.value.length);
const mongoJsonPreviewUsesCodeEditor = computed(() => !!mongoJsonPreviewText.value && !mongoJsonPreviewTruncated.value);

watch(canShowMongoJsonPreview, (available) => {
  if (!available) showMongoJsonPreview.value = false;
});

// Result-set switches remount the grid, but re-executing the same result set
// keeps this component alive. Clear the ephemeral preview before fresh query
// data arrives so it cannot retain a stale row selection or drawer state.
watch(
  () => props.loading,
  (loading) => {
    if (loading) showMongoJsonPreview.value = false;
  },
);

const dialogCellDetail = computed(() => {
  const target = cellDetailDialogTarget.value;
  return target ? cellDetailFor(target.rowIndex, target.col) : null;
});

const cellDetailJsonFormatted = computed(() => settingsStore.editorSettings.cellDetailJsonFormatted);
const sideDetailJsonView = computed(() => cellDetailJsonFormatted.value && !!activeCellDetail.value?.formattedJson);
const cellDetailJsonView = computed(() => cellDetailJsonFormatted.value && !!dialogCellDetail.value?.formattedJson);

const rowDetail = computed(() => {
  if (rowDetailDialogRowId.value === null) return null;
  const item = getRowItem(rowDetailDialogRowId.value);
  if (!item) return null;
  return buildDataGridRowDetail({
    rowIndex: item.displayIndex,
    rowId: item.id,
    row: item.data,
    columns: props.result.columns,
    columnIndexes: visibleColumnIndexes.value,
    typeByColumn: columnTypeMap.value,
    resultColumnTypes: props.result.column_types,
    commentByColumn: columnCommentMap.value,
    displayValue: (value, index) => formatCellCached(value, index),
    isEditableColumn: (columnIndex) => canEditGridCellDetail({ canEditCell: canEditCellItem(item, columnIndex), isDraft: !!item.isDraft }),
  });
});

const columnDetail = computed(() => {
  if (columnDetailDialogColumnIndex.value === null) return null;
  const columnIndex = columnDetailDialogColumnIndex.value;
  return buildDataGridColumnDetail({
    rows: displayItems.value
      .filter((item) => !item.isDraft)
      .map((item) => ({
        rowIndex: item.displayIndex,
        rowId: item.id,
        row: item.data,
        isEditable: canEditGridCellDetail({ canEditCell: canEditCellItem(item, columnIndex), isDraft: !!item.isDraft }),
      })),
    columns: props.result.columns,
    columnIndex,
    typeByColumn: columnTypeMap.value,
    resultColumnTypes: props.result.column_types,
    commentByColumn: columnCommentMap.value,
    displayValue: (value, index) => formatCellCached(value, index),
  });
});

const filteredRowDetailFields = computed(() => (rowDetail.value ? filterDataGridDetailFields(rowDetail.value.fields, rowDetailSearch.value) : []));

const filteredColumnDetailFields = computed(() => (columnDetail.value ? filterDataGridDetailFields(columnDetail.value.fields, columnDetailSearch.value) : []));

watch(cellDetailDialogOpen, (open) => {
  if (!open) cellDetailDialogTarget.value = null;
});

watch(rowDetailDialogOpen, (open) => {
  if (!open) {
    rowDetailDialogRowId.value = null;
    rowDetailSearch.value = "";
  }
});

watch(columnDetailDialogOpen, (open) => {
  if (!open) {
    columnDetailDialogColumnIndex.value = null;
    columnDetailSearch.value = "";
  }
});

watch(sideGeometryPreviewOpen, async (open) => {
  if (open) {
    await nextTick();
    const canvas = sideGeometryCanvas.value;
    const detail = activeCellDetail.value;
    if (canvas && detail && detail.value !== null) {
      renderWktOnCanvas(canvas, String(detail.value));
    }
  }
});

watch(dialogGeometryPreviewOpen, async (open) => {
  if (open) {
    await nextTick();
    const canvas = dialogGeometryCanvas.value;
    const detail = dialogCellDetail.value;
    if (canvas && detail && detail.value !== null) {
      renderWktOnCanvas(canvas, String(detail.value));
    }
  }
});

const activeCellDetailTabs = computed(() => {
  const detail = activeCellDetail.value;
  return visibleCellDetailTabs({
    isEditable: !!detail?.isEditable,
    hasBinaryHexViewer: isBinaryCellColumnType(detail?.type),
  });
});

const activeBinaryHexBytes = computed(() => {
  if (activeCellDetailTab.value !== "hexViewer") return null;
  const detail = activeCellDetail.value;
  return detail ? parseBinaryCellBytes(detail.value, detail.type) : null;
});

const activeBinaryHexRows = computed(() => (activeBinaryHexBytes.value ? buildBinaryHexViewRows(activeBinaryHexBytes.value) : []));
const activeBinaryHexByteCount = computed(() => activeBinaryHexBytes.value?.length ?? 0);

const activeCellDetailTabsGridClass = computed(() => {
  const count = activeCellDetailTabs.value.length;
  if (count >= 3) return "grid-cols-3";
  if (count === 2) return "grid-cols-2";
  return "grid-cols-1";
});

watch(activeCellDetailTabs, (tabs) => {
  if (!tabs.includes(activeCellDetailTab.value)) {
    activeCellDetailTab.value = defaultCellDetailTab();
  }
});

watch(activeCellDetailTab, (tab) => {
  if (tab === "valueEditor") {
    startDetailEdit();
  } else {
    resetDetailEdit();
  }
});

const activeValueEditorActions = computed(() => {
  const detail = activeCellDetail.value;
  return valueEditorActions({
    canSetNull: !!detail?.isEditable && detail.value !== null,
    canFormatJson: !!detail?.isEditable && canFormatCellDetailJson(detail.value, detail.type),
  });
});

const detailSqlConditionCopy = ref<PreparedCopyValue>({
  key: "",
  text: "",
  loading: false,
  ready: false,
});

const detailSqlConditionKey = computed(() => {
  const detail = activeCellDetail.value;
  if (!detail) return "";
  return JSON.stringify({
    databaseType: props.databaseType ?? null,
    column: detail.column,
    value: detail.value,
    type: detail.type,
    schema: props.tableMeta?.schema ?? null,
    tableName: props.tableMeta?.tableName ?? null,
  });
});

function canCopyPreparedDetailSqlCondition(): boolean {
  return detailSqlConditionCopy.value.ready && detailSqlConditionCopy.value.key === detailSqlConditionKey.value;
}

async function prefetchDetailSqlCondition() {
  const detail = activeCellDetail.value;
  const key = detailSqlConditionKey.value;
  if (!detail || !key) {
    detailSqlConditionCopy.value = {
      key: "",
      text: "",
      loading: false,
      ready: false,
    };
    return;
  }
  const current = detailSqlConditionCopy.value;
  if ((current.loading || current.ready) && current.key === key) return;

  detailSqlConditionCopy.value = {
    key,
    text: "",
    loading: true,
    ready: false,
  };

  try {
    const condition = await buildDataGridContextFilterCondition({
      databaseType: resolvedDatabaseType.value,
      columnName: detail.column,
      columnInfo: props.tableMeta?.columns.find((column) => column.name === detail.column),
      mode: "equals",
      value: detail.value,
    });
    if (detailSqlConditionCopy.value.key !== key) return;
    detailSqlConditionCopy.value = {
      key,
      text: condition ?? "",
      loading: false,
      ready: !!condition,
    };
  } catch {
    if (detailSqlConditionCopy.value.key !== key) return;
    detailSqlConditionCopy.value = {
      key,
      text: "",
      loading: false,
      ready: false,
    };
  }
}

watch(activeCellDetail, (detail) => {
  void prefetchDetailSqlCondition();
  if (activeCellDetailTab.value !== "valueEditor") return;
  if (!detail?.isEditable) {
    resetDetailEdit();
    return;
  }
  detailEditValue.value = dataGridCellEditorText({
    value: detail.value,
    databaseType: props.databaseType,
    columnInfo: tableColumnForGridColumn(detail.colIndex),
  });
  syncEditorFromDetailEdit();
  isEditingDetail.value = true;
});

const detailEditValue = ref("");
const isEditingDetail = ref(false);
const detailTemporalEditorConfig = computed(() => {
  const detail = activeCellDetail.value;
  return detail ? temporalEditorConfigForColumn(detail.colIndex) : undefined;
});
const sideDetailPrioritizesValue = computed(() => !cellDetailPanelIsBottom.value && !isEditingDetail.value && !!activeCellDetail.value?.formattedJson);
const sideDetailValueFillsHeight = computed(() => cellDetailPanelIsBottom.value || isEditingDetail.value || (!cellDetailPanelIsBottom.value && !activeCellDetail.value?.imagePreviewUrl));
const sideJsonPreviewText = computed(() => {
  const detail = activeCellDetail.value;
  if (!detail?.formattedJson) return "";
  return sideDetailJsonView.value ? detail.formattedJson : detail.rawValuePreview;
});
const canCompactDetailJson = computed(() => {
  const detail = activeCellDetail.value;
  return !!detail && isEditingDetail.value && canFormatCellDetailJson(detailEditValue.value, detail.type);
});
const showCompactDetailJson = computed(() => {
  const detail = activeCellDetail.value;
  if (!detail || !isEditingDetail.value) return false;
  return !!detail.formattedJson || looksLikeJsonContainerText(detailEditValue.value);
});

// CodeMirror-based cell detail editors
const detailsEditorContainer = ref<HTMLElement>();
const valueEditorContainer = ref<HTMLElement>();
const sideJsonPreviewContainer = ref<HTMLElement>();
const dialogJsonPreviewContainer = ref<HTMLElement>();
const mongoJsonPreviewContainer = ref<HTMLElement>();
let detailsDetailEditor: UseCellDetailEditorReturn | null = null;
let valueDetailEditor: UseCellDetailEditorReturn | null = null;
let sideJsonPreviewEditor: UseCellDetailEditorReturn | null = null;
let dialogJsonPreviewEditor: UseCellDetailEditorReturn | null = null;
let mongoJsonPreviewEditor: UseCellDetailEditorReturn | null = null;

const editorThemeAccessor = () => settingsStore.editorSettings.theme;
const editorAppAppearance = () => (isDark.value ? "dark" : "light") as import("@/lib/app/appTheme").AppThemeAppearance;
const editorAppPalette = () => themePalette.value;
const editorFontSize = () => settingsStore.editorSettings.fontSize;
const editorFontFamily = () => settingsStore.editorSettings.fontFamily;
const SIDE_DETAIL_EDITOR_MIN_HEIGHT = 160;
const SIDE_DETAIL_EDITOR_MAX_HEIGHT = 360;
const SIDE_DETAIL_EDITOR_LINE_HEIGHT = 20;
const SIDE_DETAIL_EDITOR_SOFT_WRAP_CHARS = 48;
const sideDetailEditorStyle = computed(() => {
  if (cellDetailPanelIsBottom.value || isEditingDetail.value) return undefined;
  const lines = detailEditValue.value.split(/\r\n|\r|\n/).reduce((total, line) => total + Math.max(1, Math.ceil(line.length / SIDE_DETAIL_EDITOR_SOFT_WRAP_CHARS)), 0);
  const height = Math.min(SIDE_DETAIL_EDITOR_MAX_HEIGHT, Math.max(SIDE_DETAIL_EDITOR_MIN_HEIGHT, lines * SIDE_DETAIL_EDITOR_LINE_HEIGHT + 28));
  return { height: `${height}px` };
});

function getDetailEditor(): UseCellDetailEditorReturn | null {
  return activeCellDetailTab.value === "valueEditor" ? valueDetailEditor : detailsDetailEditor;
}

watch(detailsEditorContainer, async (el) => {
  if (el && !detailsDetailEditor) {
    detailsDetailEditor = useCellDetailEditor({
      onChange: (v) => {
        detailEditValue.value = v;
      },
      onEscape: () => cancelDetailEdit(),
      editorTheme: editorThemeAccessor,
      appAppearance: editorAppAppearance,
      appPalette: editorAppPalette,
      fontSize: editorFontSize,
      fontFamily: editorFontFamily,
    });
    await detailsDetailEditor.create(el, detailEditValue.value, activeCellDetail.value?.type);
  } else if (!el && detailsDetailEditor) {
    detailsDetailEditor.destroy();
    detailsDetailEditor = null;
  }
});

watch(valueEditorContainer, async (el) => {
  if (el && !valueDetailEditor) {
    valueDetailEditor = useCellDetailEditor({
      onChange: (v) => {
        detailEditValue.value = v;
      },
      onEscape: () => restoreDetailOriginalValue(),
      onBlur: () => commitValueEditorEdit(),
      editorTheme: editorThemeAccessor,
      appAppearance: editorAppAppearance,
      appPalette: editorAppPalette,
      fontSize: editorFontSize,
      fontFamily: editorFontFamily,
    });
    await valueDetailEditor.create(el, detailEditValue.value, activeCellDetail.value?.type);
  } else if (!el && valueDetailEditor) {
    valueDetailEditor.destroy();
    valueDetailEditor = null;
  }
});

watch(sideJsonPreviewContainer, async (el) => {
  if (el && !sideJsonPreviewEditor) {
    sideJsonPreviewEditor = useCellDetailEditor({
      language: "json",
      readOnly: true,
      editorTheme: editorThemeAccessor,
      appAppearance: editorAppAppearance,
      appPalette: editorAppPalette,
      fontSize: editorFontSize,
      fontFamily: editorFontFamily,
    });
    await sideJsonPreviewEditor.create(el, sideJsonPreviewText.value, "json");
  } else if (!el && sideJsonPreviewEditor) {
    sideJsonPreviewEditor.destroy();
    sideJsonPreviewEditor = null;
  }
});

watch(dialogJsonPreviewContainer, async (el) => {
  if (el && !dialogJsonPreviewEditor) {
    dialogJsonPreviewEditor = useCellDetailEditor({
      language: "json",
      readOnly: true,
      editorTheme: editorThemeAccessor,
      appAppearance: editorAppAppearance,
      appPalette: editorAppPalette,
      fontSize: editorFontSize,
      fontFamily: editorFontFamily,
    });
    await dialogJsonPreviewEditor.create(el, dialogCellDetail.value?.formattedJson ?? "", "json");
  } else if (!el && dialogJsonPreviewEditor) {
    dialogJsonPreviewEditor.destroy();
    dialogJsonPreviewEditor = null;
  }
});

watch(mongoJsonPreviewContainer, async (el) => {
  if (el && !mongoJsonPreviewEditor) {
    mongoJsonPreviewEditor = useCellDetailEditor({
      language: "json",
      readOnly: true,
      editorTheme: editorThemeAccessor,
      appAppearance: editorAppAppearance,
      appPalette: editorAppPalette,
      fontSize: editorFontSize,
      fontFamily: editorFontFamily,
    });
    await mongoJsonPreviewEditor.create(el, mongoJsonPreviewText.value, "json");
  } else if (!el && mongoJsonPreviewEditor) {
    mongoJsonPreviewEditor.destroy();
    mongoJsonPreviewEditor = null;
  }
});

watch(sideJsonPreviewText, (value) => {
  sideJsonPreviewEditor?.setValue(value, "json");
});

watch(mongoJsonPreviewText, (value) => {
  mongoJsonPreviewEditor?.setValue(value, "json");
});

watch(
  () => dialogCellDetail.value?.formattedJson ?? "",
  (value) => {
    dialogJsonPreviewEditor?.setValue(value, "json");
  },
);

function resetDetailEdit() {
  isEditingDetail.value = false;
  detailEditValue.value = "";
}

function closeCellDetails() {
  resetDetailEdit();
  showCellDetail.value = false;
  detailCell.value = null;
}

function toggleMongoJsonPreview() {
  if (!canShowMongoJsonPreview.value) return;
  showMongoJsonPreview.value = !showMongoJsonPreview.value;
  if (showMongoJsonPreview.value) closeCellDetails();
}

function closeMongoJsonPreview() {
  showMongoJsonPreview.value = false;
}

function copyMongoJsonPreview() {
  if (mongoJsonPreviewFullText.value) copyText(mongoJsonPreviewFullText.value);
}

function cellDetailEditText(detail: DataGridCellDetail): string {
  if (sideDetailJsonView.value && detail.formattedJson) return detail.formattedJson;
  return dataGridCellEditorText({
    value: detail.value,
    databaseType: props.databaseType,
    columnInfo: tableColumnForGridColumn(detail.colIndex),
  });
}

function warnFormattedJsonEditIfNeeded(detail: DataGridCellDetail, force = false) {
  if (!force && (!sideDetailJsonView.value || !detail.formattedJson)) return;
  const count = Number(safeLocalStorageGet(FORMATTED_JSON_EDIT_WARNING_COUNT_STORAGE_KEY)) || 0;
  if (count >= FORMATTED_JSON_EDIT_WARNING_MAX_COUNT) return;
  toast(t("grid.formattedJsonEditWarning"), 6000);
  safeLocalStorageSet(FORMATTED_JSON_EDIT_WARNING_COUNT_STORAGE_KEY, String(count + 1));
}

function toggleCellDetailJsonFormatted() {
  settingsStore.updateEditorSettings({ cellDetailJsonFormatted: !cellDetailJsonFormatted.value });
}

function startDetailEdit() {
  const detail = activeCellDetail.value;
  if (!detail || !detail.isEditable) return;
  warnFormattedJsonEditIfNeeded(detail);
  detailEditValue.value = cellDetailEditText(detail);
  isEditingDetail.value = true;
}

function commitDetailEdit() {
  const detail = activeCellDetail.value;
  if (!detail || !isEditingDetail.value) return;
  isEditingDetail.value = false;

  const item = getRowItem(detail.rowId);
  if (!item || item.isDeleted) return;
  applyCellValue(detail.rowId, detail.colIndex, detailEditValue.value);
  detailCell.value = detailCell.value ? { ...detailCell.value } : null;
}

function cancelDetailEdit() {
  resetDetailEdit();
}

function syncEditorFromDetailEdit() {
  const editor = getDetailEditor();
  if (editor) {
    editor.setValue(detailEditValue.value, activeCellDetail.value?.type);
  }
}

function cancelValueEditorEdit() {
  const detail = activeCellDetail.value;
  if (!detail || !detail.isEditable) return;
  detailEditValue.value = dataGridCellEditorText({
    value: detail.value,
    databaseType: props.databaseType,
    columnInfo: tableColumnForGridColumn(detail.colIndex),
  });
  syncEditorFromDetailEdit();
  isEditingDetail.value = true;
}

function commitValueEditorEdit() {
  commitDetailEdit();
  if (activeCellDetailTab.value === "valueEditor") {
    isEditingDetail.value = true;
  }
}

function restoreDetailOriginalValue() {
  const detail = activeCellDetail.value;
  if (!detail || !detail.isEditable) return;

  const item = getRowItem(detail.rowId);
  if (!item || item.isDeleted) return;

  let restoredValue: CellValue = null;

  if (!item.isNew && item.sourceIndex !== undefined) {
    restoredValue = props.result.rows[item.sourceIndex]?.[detail.colIndex] ?? null;
  }
  restoreCellValue(detail.rowId, detail.colIndex);

  detailEditValue.value = dataGridCellEditorText({
    value: restoredValue,
    databaseType: props.databaseType,
    columnInfo: tableColumnForGridColumn(detail.colIndex),
  });
  syncEditorFromDetailEdit();
  isEditingDetail.value = activeCellDetailTab.value === "valueEditor";
  detailCell.value = { ...detailCell.value! };
}

function setValueEditorNull() {
  setDetailNull();
  detailEditValue.value = cellDetailEditorText(null);
  syncEditorFromDetailEdit();
  isEditingDetail.value = activeCellDetailTab.value === "valueEditor";
}

function formatValueEditorJson() {
  const detail = activeCellDetail.value;
  if (!detail || !canFormatCellDetailJson(detailEditValue.value, detail.type)) return;
  detailEditValue.value = formatJsonText(detailEditValue.value) ?? detailEditValue.value;
  syncEditorFromDetailEdit();
  warnFormattedJsonEditIfNeeded(detail, true);
}

function compactDetailJson() {
  const detail = activeCellDetail.value;
  if (!detail || !canFormatCellDetailJson(detailEditValue.value, detail.type)) return;
  detailEditValue.value = compactJsonText(detailEditValue.value) ?? detailEditValue.value;
  syncEditorFromDetailEdit();
}

function setDetailNull() {
  const detail = activeCellDetail.value;
  if (!detail || !detail.isEditable) return;

  const item = getRowItem(detail.rowId);
  if (!item || item.isDeleted) return;

  applyCellValue(detail.rowId, detail.colIndex, null);
  resetDetailEdit();
  detailCell.value = { ...detailCell.value! };
}

function applyColumnSort(column: string, columnIndex: number, direction: "asc" | "desc" | null, mode: DataGridSortMode = "database") {
  if (getIsResizing()) return;
  currentPage.value = 1;
  resetGridVerticalScroll(true);
  if (direction) {
    sortCol.value = column;
    sortColIndex.value = columnIndex;
    sortDir.value = direction;
    sortMode.value = mode;
    if (mode === "database") {
      syncOrderByInputWithSort(column, direction);
    } else {
      syncOrderByInputWithSort(null, null);
    }
  } else {
    sortCol.value = null;
    sortColIndex.value = null;
    sortDir.value = "asc";
    sortMode.value = "database";
    syncOrderByInputWithSort(null, null);
  }
  emit("sort", column, columnIndex, direction, currentWhereInput(), mode);
}

function selectHeaderSort(value: string, column: string, columnIndex: number) {
  if (value === "clear") {
    applyColumnSort(column, columnIndex, null, sortMode.value);
    return;
  }
  const [mode, direction] = value.split("-") as [DataGridSortMode, DataGridSortDirection];
  applyColumnSort(column, columnIndex, direction, mode);
}

function applyContextSort(direction: "asc" | "desc" | null, mode: DataGridSortMode = "database") {
  if (!contextColumn.value || !contextCell.value) return;
  applyColumnSort(contextColumn.value, contextCell.value.col, direction, mode);
}

async function contextFilterCondition(mode: FilterMode): Promise<string | null> {
  if (!contextColumn.value) return null;
  return (
    (await buildDataGridContextFilterCondition({
      databaseType: resolvedDatabaseType.value,
      columnName: contextColumn.value,
      columnInfo: props.tableMeta?.columns.find((column) => column.name === contextColumn.value),
      mode,
      value: contextCellValue.value,
    })) ?? null
  );
}

async function applyContextFilter(mode: FilterMode) {
  if (!canUseWhereSearch.value) return;
  const condition = await contextFilterCondition(mode);
  if (!condition) return;
  const existing = whereFilterInput.value.trim();
  whereFilterInput.value = existing ? `(${existing}) AND (${condition})` : condition;
  await applyWhereFilter();
}

async function clearContextFilter() {
  await clearAllFilters();
}

function waitForTableMeta(timeoutMs = 2500): Promise<DataGridTableMeta | null> {
  if (props.tableMeta) return Promise.resolve(props.tableMeta);
  return new Promise((resolve) => {
    let stop: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      stop?.();
      resolve(null);
    }, timeoutMs);
    stop = watch(
      () => props.tableMeta,
      (tableMeta) => {
        if (!tableMeta) return;
        window.clearTimeout(timer);
        stop?.();
        resolve(tableMeta);
      },
      { flush: "sync" },
    );
  });
}

async function applyOrderBySearch() {
  if (!props.onExecuteSql) return;
  const orderByClause = orderByInput.value.trim() || undefined;
  emit("update:orderByInput", orderByInput.value);
  if (orderByClause) rememberDataGridConditionHistory("orderBy", conditionHistoryScope.value, orderByClause);
  isApplyingWhere.value = true;
  saveError.value = "";
  currentPage.value = 1;
  sortCol.value = null;
  sortColIndex.value = null;
  sortDir.value = "asc";
  try {
    const tableMeta = await waitForTableMeta();
    if (!tableMeta) return;
    const sql = await buildTableSelectSql({
      databaseType: resolvedDatabaseType.value,
      catalog: tableMeta.catalog,
      schema: tableMeta.schema,
      tableName: tableMeta.tableName,
      tableType: tableMeta.tableType,
      columns: tableMeta.columns.map((column) => column.name),
      primaryKeys: tableMeta.primaryKeys,
      orderBy: orderByClause,
      limit: pageSize.value,
      whereInput: currentWhereInput(),
      includeRowId: usesSyntheticRowIdKey(resolvedDatabaseType.value, tableMeta.primaryKeys, tableMeta.tableType),
    });
    await props.onExecuteSql(sql);
  } catch (e: any) {
    saveError.value = String(e?.message || e);
  } finally {
    isApplyingWhere.value = false;
  }
}

async function applyWhereFilter() {
  if (!props.onExecuteSql) return;
  const whereInput = currentWhereInput();
  if (whereInput) rememberDataGridConditionHistory("where", conditionHistoryScope.value, whereInput);
  isApplyingWhere.value = true;
  saveError.value = "";
  currentPage.value = 1;
  emit("update:whereInput", whereInput ?? "");
  try {
    const tableMeta = await waitForTableMeta();
    if (!tableMeta) return;
    const sql = await buildTableSelectSql({
      databaseType: resolvedDatabaseType.value,
      catalog: tableMeta.catalog,
      schema: tableMeta.schema,
      tableName: tableMeta.tableName,
      tableType: tableMeta.tableType,
      columns: tableMeta.columns.map((column) => column.name),
      primaryKeys: tableMeta.primaryKeys,
      orderBy: orderByInput.value.trim() || (sortCol.value ? `${queryColumnRef(sortCol.value)} ${sortDir.value.toUpperCase()}` : undefined),
      limit: pageSize.value,
      whereInput,
      includeRowId: usesSyntheticRowIdKey(resolvedDatabaseType.value, tableMeta.primaryKeys, tableMeta.tableType),
    });
    await props.onExecuteSql(sql);
  } catch (e: any) {
    saveError.value = String(e?.message || e);
  } finally {
    isApplyingWhere.value = false;
  }
}

const CELL_DISPLAY_MAX_LENGTH = 256;
const CELL_FORMAT_CACHE_LIMIT = 20_000;
const CELL_FORMAT_CACHE_PRUNE_COUNT = 5_000;

const resolvedColumnFormatters = computed(() => props.result.columns.map((_, columnIndex) => columnFormatter(columnIndex)));
const columnFormatterSignatures = computed(() => resolvedColumnFormatters.value.map(formatterSignature));
const primitiveCellFormatCache = new Map<string, string>();
let objectCellFormatCache = new WeakMap<object, Map<number, string>>();

function formatterSignature(formatter: ColumnFormatterConfig | undefined): string {
  return formatter ? JSON.stringify(formatter) : "";
}

function clearCellFormatCache() {
  primitiveCellFormatCache.clear();
  objectCellFormatCache = new WeakMap<object, Map<number, string>>();
}

function rememberPrimitiveCellFormat(key: string, display: string): string {
  primitiveCellFormatCache.set(key, display);
  if (primitiveCellFormatCache.size > CELL_FORMAT_CACHE_LIMIT) {
    let removed = 0;
    for (const cacheKey of primitiveCellFormatCache.keys()) {
      primitiveCellFormatCache.delete(cacheKey);
      removed++;
      if (removed >= CELL_FORMAT_CACHE_PRUNE_COUNT) break;
    }
  }
  return display;
}

function primitiveCellFormatKey(value: CellValue, columnIndex?: number): string {
  return `${columnIndex ?? -1}\u0000${typeof value}\u0000${String(value)}`;
}

function formatCell(value: CellValue, columnIndex?: number): string {
  const formatter = columnIndex === undefined ? undefined : resolvedColumnFormatters.value[columnIndex];
  const columnName = columnIndex === undefined ? undefined : props.result.columns[columnIndex];
  const columnInfo = columnIndex === undefined ? undefined : tableColumnForGridColumn(columnIndex);
  const displayColumnInfo = columnInfo ?? (columnIndex === undefined ? undefined : resultColumnInfoForGridColumn(columnIndex));
  const arrayDisplay = formatter ? undefined : dataGridCellDisplayText({ value, databaseType: props.databaseType, columnInfo: displayColumnInfo });
  if (arrayDisplay !== undefined) return arrayDisplay;
  const binaryDisplay = formatter ? null : binaryCellDisplayText(value, columnInfo?.data_type ?? (columnName ? columnTypeMap.value.get(columnName) : undefined));
  if (binaryDisplay) return binaryDisplay;
  const s = applyColumnFormatter(value, formatter);
  return s.length > CELL_DISPLAY_MAX_LENGTH ? s.slice(0, CELL_DISPLAY_MAX_LENGTH) : s;
}

function formatCellCached(value: CellValue, columnIndex?: number): string {
  if (value !== null && typeof (value as unknown) === "object") {
    const objectValue = value as unknown as object;
    const cacheColumn = columnIndex ?? -1;
    const columnCache = objectCellFormatCache.get(objectValue);
    const cached = columnCache?.get(cacheColumn);
    if (cached !== undefined) return cached;

    const display = formatCell(value, columnIndex);
    if (columnCache) {
      columnCache.set(cacheColumn, display);
    } else {
      objectCellFormatCache.set(objectValue, new Map([[cacheColumn, display]]));
    }
    return display;
  }

  const key = primitiveCellFormatKey(value, columnIndex);
  const cached = primitiveCellFormatCache.get(key);
  if (cached !== undefined) return cached;
  return rememberPrimitiveCellFormat(key, formatCell(value, columnIndex));
}

function rowNumberText(item: RowItem | undefined): string {
  if (!item) return "";
  if (item.isDraft) return "*";
  return String(infiniteScrollEnabled.value ? item.displayIndex + 1 : item.displayIndex + 1 + (currentPage.value - 1) * pageSize.value);
}

function draftCellPlaceholder(item: RowItem | undefined, columnIndex: number): string | null {
  return item?.isDraft && item.data[columnIndex] === null ? t("grid.quickEntryDraftPlaceholder") : null;
}

function columnTypeCacheSignature(): string {
  const resultTypes = props.result.column_types?.join("\u0000") ?? "";
  const tableTypes = props.tableMeta?.columns?.map((column) => `${column.name}:${column.data_type}`).join("\u0000") ?? "";
  return `${resultTypes}\u0001${tableTypes}`;
}

watch(() => [props.result.columns.join("\u0000"), columnFormatterSignatures.value.join("\u0000"), columnTypeCacheSignature()], clearCellFormatCache);

function quoteIdent(name: string): string {
  return quoteTableIdentifier(props.databaseType, name);
}

function queryColumnRef(name: string): string {
  const quoted = quoteIdent(name);
  return props.databaseType === "neo4j" ? `n.${quoted}` : quoted;
}

function isNull(value: unknown): boolean {
  return value === null;
}

function rowNumberStatusClass(item: RowItem): string {
  if (item.status === "draft") {
    return "border-muted-foreground/20 bg-muted/20 font-semibold text-muted-foreground";
  }
  if (item.status === "new") {
    return "border-emerald-500/40 bg-emerald-500/15 font-semibold text-emerald-700 dark:text-emerald-300";
  }
  if (item.status === "edited") {
    return "border-amber-500/40 bg-amber-500/15 font-semibold text-amber-700 dark:text-amber-300";
  }
  if (item.status === "deleted") {
    return "border-destructive/40 bg-destructive/15 font-semibold text-destructive line-through";
  }
  return "text-muted-foreground";
}

function rowCellsUseSelectionVisual(rowId: number): boolean {
  return hasRowSelection.value && isRowSelected(rowId) && !hasCellSelection.value;
}

function dataGridRowStyle(item: RowItem): CSSProperties {
  const dark = isDark.value || (typeof document !== "undefined" && document.documentElement.classList.contains("dark"));
  const rowBg = item.isDeleted
    ? dark
      ? "rgb(55, 31, 32)"
      : "rgb(255, 244, 244)"
    : item.isNew
      ? dark
        ? "rgb(51, 51, 55)"
        : "rgb(243, 243, 243)"
      : item.isDraft
        ? dark
          ? "rgb(51, 51, 55)"
          : "rgb(243, 243, 243)"
        : item.displayIndex % 2 === 1
          ? dark
            ? "rgb(32, 32, 34)"
            : "rgb(248, 248, 248)"
          : dark
            ? "rgb(19, 20, 22)"
            : "rgb(255, 255, 255)";
  const rowNumberBg =
    item.status === "new"
      ? dark
        ? "rgb(33, 45, 40)"
        : "rgb(219, 244, 233)"
      : item.status === "edited"
        ? dark
          ? "rgb(48, 41, 28)"
          : "rgb(253, 241, 219)"
        : item.status === "deleted"
          ? dark
            ? "rgb(55, 31, 32)"
            : "rgb(255, 244, 244)"
          : isRowActive(item.displayIndex) && !item.isDeleted
            ? dark
              ? "rgb(66, 67, 70)"
              : "rgb(226, 226, 226)"
            : dark
              ? "rgb(35, 37, 42)"
              : "rgb(255, 255, 255)";
  return {
    "--data-grid-cell-bg": rowBg,
    "--data-grid-row-number-bg": rowNumberBg,
    "--data-grid-cell-selected-bg": dark ? "rgb(66, 67, 70)" : "rgb(226, 226, 226)",
    "--data-grid-cell-selected-dirty-bg": dark ? "rgb(94, 75, 26)" : "rgb(244, 229, 186)",
    "--data-grid-cell-selected-border": dark ? "rgb(170, 170, 175)" : "rgb(90, 90, 90)",
    "--data-grid-row-number-active-bg": dark ? "rgb(66, 67, 70)" : "rgb(232, 232, 232)",
    "--data-grid-row-number-selected-bg": dark ? "rgb(66, 67, 70)" : "rgb(226, 226, 226)",
  } as CSSProperties;
}

const canvasRef = ref<HTMLCanvasElement>();
const canvasOverlayRef = ref<HTMLElement>();
const canvasViewportWidth = ref(0);
const canvasViewportHeight = ref(0);
const canvasScrollTop = ref(0);
const canvasHoverCell = ref<{ rowIndex: number; visibleColIdx: number } | null>(null);
const canvasDevicePixelRatio = ref(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1);
const canvasBackingPixelRatio = computed(() => Math.min(4, Math.max(1, canvasDevicePixelRatio.value * settingsStore.editorSettings.uiScale)));
const useCanvasGridRows = computed(() => dataGridRenderMode.value === "canvas");
const canvasContentHeight = computed(() => Math.max(1, displayRowCount.value * CANVAS_DATA_GRID_ROW_HEIGHT));
// Clamp the sticky canvas/overlay to the content width. A viewport-wide sticky surface inflates the
// scroller's scrollWidth up to clientWidth, so with few columns it sits right on the overflow threshold
// and the custom horizontal scrollbar flickers while the pane shrinks (canvas width lags clientWidth).
const canvasSurfaceWidth = computed(() => {
  const total = totalWidth.value;
  const vw = canvasViewportWidth.value;
  if (total <= 0) return Math.max(0, vw);
  if (vw <= 0) return total;
  return Math.min(vw, total);
});
const canvasRenderStyleKey = computed(() => `${settingsStore.editorSettings.theme}:${settingsStore.editorSettings.uiScale}:${canvasBackingPixelRatio.value}:${isDark.value}:${themePalette.value}:${settingsStore.editorSettings.fontFamily}:${tableFontSize.value}`);
const CANVAS_MOUSE_WHEEL_SCROLL_MULTIPLIER = 1.5;
const CANVAS_TRACKPAD_DELTA_THRESHOLD = 40;
let canvasResizeObserver: ResizeObserver | null = null;
let canvasPixelRatioMediaQuery: MediaQueryList | null = null;
let canvasPixelRatioMediaQueryCleanup: (() => void) | null = null;
let canvasPixelRatioFrame = 0;
let canvasDrawFrame = 0;
let dataGridIsActive = true;

watch(
  () => [totalWidth.value, displayRowCount.value, useCanvasGridRows.value, props.result.columns.join("\u0000")],
  () => {
    nextTick(() => {
      refreshGridScrollerMetrics();
      observeGridHorizontalScrollbarScroller();
    });
  },
  { flush: "post" },
);

function canvasScrollerElement(): HTMLElement | null {
  const scroller = scrollerRef.value;
  if (!scroller) return null;
  if (scroller instanceof HTMLElement) return scroller;
  if (scroller.$el instanceof HTMLElement) return scroller.$el;
  if (scroller.el instanceof HTMLElement) return scroller.el;
  if (scroller.el?.value instanceof HTMLElement) return scroller.el.value;
  return null;
}

function dataGridSelectionScroller(): HTMLElement | null {
  if (showTranspose.value) return null;
  return canvasScrollerElement();
}

function dataGridCellFromClientPoint(clientX: number, clientY: number): { rowIndex: number; colIndex: number } | null {
  const scroller = dataGridSelectionScroller();
  if (!scroller) return null;
  const rect = scroller.getBoundingClientRect();
  const clampedX = Math.min(rect.right - 1, Math.max(rect.left + DATA_GRID_ROW_NUM_WIDTH + 1, clientX));
  const clampedY = Math.min(rect.bottom - 1, Math.max(rect.top + 1, clientY));

  if (useCanvasGridRows.value) {
    const rowIndex = Math.floor((scroller.scrollTop + clampedY - rect.top) / CANVAS_DATA_GRID_ROW_HEIGHT);
    const visibleColIdx = canvasColumnAt(scroller.scrollLeft + clampedX - rect.left - DATA_GRID_ROW_NUM_WIDTH);
    if (rowIndex < 0 || rowIndex >= displayRowCount.value || visibleColIdx < 0) return null;
    const item = displayItemAt(rowIndex);
    return item ? { rowIndex: item.displayIndex, colIndex: visibleColIdx } : null;
  }

  const target = document.elementFromPoint(clampedX, clampedY);
  const cell = target instanceof Element ? target.closest<HTMLElement>("[data-row-index] [data-visible-col-index]") : null;
  const row = cell?.closest<HTMLElement>("[data-row-index]");
  const rowIndex = Number(row?.dataset.rowIndex);
  const colIndex = Number(cell?.dataset.visibleColIndex);
  if (!Number.isInteger(rowIndex) || !Number.isInteger(colIndex)) return null;
  return { rowIndex, colIndex };
}

function syncCanvasViewport() {
  if (!dataGridIsActive) return;
  const scroller = canvasScrollerElement();
  if (!scroller) return;
  canvasViewportWidth.value = scroller.clientWidth;
  canvasViewportHeight.value = scroller.clientHeight;
  canvasScrollTop.value = scroller.scrollTop;
  updateGridScrollbarGutter(scroller);
  updateGridHorizontalViewport(scroller);
  drawCanvasGridNow();
}

function currentCanvasDevicePixelRatio(): number {
  return typeof window === "undefined" ? 1 : Math.max(1, window.devicePixelRatio || 1);
}

function scheduleCanvasPixelRatioRefresh() {
  if (!dataGridIsActive || canvasPixelRatioFrame) return;
  canvasPixelRatioFrame = requestAnimationFrame(() => {
    canvasPixelRatioFrame = 0;
    const next = currentCanvasDevicePixelRatio();
    if (Math.abs(next - canvasDevicePixelRatio.value) > 0.001) {
      canvasDevicePixelRatio.value = next;
      attachCanvasPixelRatioWatcher();
    }
    syncCanvasViewport();
  });
}

function attachCanvasPixelRatioWatcher() {
  canvasPixelRatioMediaQueryCleanup?.();
  canvasPixelRatioMediaQueryCleanup = null;
  canvasPixelRatioMediaQuery = null;
  if (!dataGridIsActive || !useCanvasGridRows.value || typeof window === "undefined" || !window.matchMedia) return;

  const ratio = currentCanvasDevicePixelRatio();
  canvasDevicePixelRatio.value = ratio;
  canvasPixelRatioMediaQuery = window.matchMedia(`(resolution: ${ratio}dppx)`);
  const onChange = () => scheduleCanvasPixelRatioRefresh();
  canvasPixelRatioMediaQuery.addEventListener("change", onChange);
  canvasPixelRatioMediaQueryCleanup = () => {
    canvasPixelRatioMediaQuery?.removeEventListener("change", onChange);
  };
}

function attachCanvasResizeObserver() {
  canvasResizeObserver?.disconnect();
  canvasResizeObserver = null;
  if (!dataGridIsActive) return;
  if (!useCanvasGridRows.value) return;
  const scroller = canvasScrollerElement();
  if (!scroller) return;
  attachCanvasPixelRatioWatcher();
  syncCanvasViewport();
  if (typeof ResizeObserver === "undefined") return;
  canvasResizeObserver = new ResizeObserver(syncCanvasViewport);
  canvasResizeObserver.observe(scroller);
}

function scheduleCanvasDraw() {
  if (!dataGridIsActive) return;
  if (!useCanvasGridRows.value || canvasDrawFrame) return;
  canvasDrawFrame = requestAnimationFrame(() => {
    canvasDrawFrame = 0;
    drawCanvasGrid();
  });
}

function drawCanvasGridNow() {
  if (!useCanvasGridRows.value) return;
  if (canvasDrawFrame) {
    cancelAnimationFrame(canvasDrawFrame);
    canvasDrawFrame = 0;
  }
  drawCanvasGrid();
}

function canvasColumnAt(contentX: number): number {
  const offsets = renderedColumnOffsets.value;
  const totalColumns = renderedColumnWidths.value.length;
  if (contentX < 0 || totalColumns === 0 || contentX >= (offsets[totalColumns] ?? 0)) return -1;
  let low = 0;
  let high = totalColumns - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if ((offsets[mid + 1] ?? 0) <= contentX) low = mid + 1;
    else high = mid;
  }
  return low;
}

function canvasHitTest(event: MouseEvent): { rowIndex: number; visibleColIdx: number; rowNumber: boolean } | null {
  const canvas = canvasRef.value;
  const scroller = canvasScrollerElement();
  if (!canvas || !scroller) return null;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const rowIndex = Math.floor((scroller.scrollTop + y) / CANVAS_DATA_GRID_ROW_HEIGHT);
  if (rowIndex < 0 || rowIndex >= displayRowCount.value) return null;
  if (x < DATA_GRID_ROW_NUM_WIDTH) return { rowIndex, visibleColIdx: -1, rowNumber: true };
  const visibleColIdx = canvasColumnAt(scroller.scrollLeft + x - DATA_GRID_ROW_NUM_WIDTH);
  if (visibleColIdx < 0) return null;
  return { rowIndex, visibleColIdx, rowNumber: false };
}

function onCanvasScroll(event: Event) {
  const target = event.target;
  const scroller = target instanceof HTMLElement ? target : canvasScrollerElement();
  if (!scroller) return;

  const scrollTop = scroller.scrollTop;
  const scrollLeft = scroller.scrollLeft;
  const viewportWidth = scroller.clientWidth;
  const viewportHeight = scroller.clientHeight;
  const scrollTopChanged = canvasScrollTop.value !== scrollTop;
  const viewportHeightChanged = canvasViewportHeight.value !== viewportHeight;
  const scrollLeftChanged = gridHorizontalScrollLeft.value !== scrollLeft;
  const viewportWidthChanged = gridViewportWidth.value !== viewportWidth || canvasViewportWidth.value !== viewportWidth;

  if (canvasScrollTop.value !== scrollTop) canvasScrollTop.value = scrollTop;
  if (canvasViewportWidth.value !== viewportWidth) canvasViewportWidth.value = viewportWidth;
  if (canvasViewportHeight.value !== viewportHeight) canvasViewportHeight.value = viewportHeight;
  if (scrollLeftChanged || viewportWidthChanged) {
    gridHorizontalScrollLeft.value = scrollLeft;
    gridViewportWidth.value = viewportWidth;
    updateGridHorizontalScrollbar(scroller);
  }
  if (scrollTopChanged || viewportHeightChanged) {
    updateGridVerticalScrollbar(scroller);
    maybeCheckInfiniteScroll(scroller);
  }
  if (viewportWidthChanged || viewportHeightChanged) {
    const gutter = scrollbarGutterWidth(scroller);
    if (gridScrollbarGutter.value !== gutter) gridScrollbarGutter.value = gutter;
  }
  if (headerRef.value && headerRef.value.scrollLeft !== scrollLeft) headerRef.value.scrollLeft = scrollLeft;
  recordScrollPosition({ top: scrollTop, left: scrollLeft });
  markGridScrolling();
  scheduleCanvasDraw();
}

function canvasWheelDeltaToPixels(delta: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * CANVAS_DATA_GRID_ROW_HEIGHT;
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * pageSize;
  return delta;
}

function shouldAccelerateCanvasWheel(event: WheelEvent): boolean {
  if (event.ctrlKey || event.metaKey) return false;
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return true;
  return event.shiftKey && Math.abs(event.deltaY) > Math.abs(event.deltaX) && Math.abs(event.deltaY) >= CANVAS_TRACKPAD_DELTA_THRESHOLD;
}

function onCanvasWheel(event: WheelEvent) {
  if (!shouldAccelerateCanvasWheel(event)) return;
  const scroller = canvasScrollerElement();
  if (!scroller) return;

  const verticalDelta = canvasWheelDeltaToPixels(event.deltaY, event.deltaMode, scroller.clientHeight);
  const horizontalDelta = canvasWheelDeltaToPixels(event.deltaX, event.deltaMode, scroller.clientWidth);
  const shiftedHorizontalDelta = event.shiftKey && Math.abs(verticalDelta) > Math.abs(horizontalDelta) ? verticalDelta : 0;
  const nextTop = shiftedHorizontalDelta === 0 ? Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + verticalDelta * CANVAS_MOUSE_WHEEL_SCROLL_MULTIPLIER)) : scroller.scrollTop;
  const nextLeft = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, scroller.scrollLeft + (horizontalDelta + shiftedHorizontalDelta) * CANVAS_MOUSE_WHEEL_SCROLL_MULTIPLIER));

  if (nextTop === scroller.scrollTop && nextLeft === scroller.scrollLeft) return;
  event.preventDefault();
  scroller.scrollTop = nextTop;
  scroller.scrollLeft = nextLeft;
  onCanvasScroll({ target: scroller } as unknown as Event);
}

function onDomGridWheel(event: WheelEvent) {
  if (event.ctrlKey || event.metaKey) return;
  const scroller = event.currentTarget instanceof HTMLElement ? event.currentTarget : gridScrollerElement();
  if (!scroller) return;

  const verticalDelta = canvasWheelDeltaToPixels(event.deltaY, event.deltaMode, scroller.clientHeight);
  const horizontalDelta = canvasWheelDeltaToPixels(event.deltaX, event.deltaMode, scroller.clientWidth);
  const shiftedHorizontalDelta = event.shiftKey && Math.abs(verticalDelta) > Math.abs(horizontalDelta) ? verticalDelta : 0;
  const effectiveVerticalDelta = shiftedHorizontalDelta === 0 ? verticalDelta : 0;
  const effectiveHorizontalDelta = horizontalDelta + shiftedHorizontalDelta;
  if (effectiveVerticalDelta === 0 && effectiveHorizontalDelta === 0) return;

  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const nextTop = Math.max(0, Math.min(maxTop, scroller.scrollTop + effectiveVerticalDelta));
  const nextLeft = Math.max(0, Math.min(maxLeft, scroller.scrollLeft + effectiveHorizontalDelta));
  // Let an outer scroll container handle wheel input once the grid reaches its boundary.
  if (nextTop === scroller.scrollTop && nextLeft === scroller.scrollLeft) return;
  event.preventDefault();
  event.stopPropagation();

  scroller.scrollTop = nextTop;
  scroller.scrollLeft = nextLeft;
  onScrollerScroll({ target: scroller } as unknown as Event);
}

function onCanvasMouseMove(event: MouseEvent) {
  if (columnHeaderPointerInteractionActive()) {
    if (canvasRef.value) canvasRef.value.style.cursor = "default";
    onCanvasMouseLeave();
    return;
  }
  const hit = canvasHitTest(event);
  const hitItem = hit ? displayItemAt(hit.rowIndex) : undefined;
  const next = hit && hitItem ? { rowIndex: hitItem.displayIndex, visibleColIdx: hit.rowNumber ? -1 : hit.visibleColIdx } : null;
  const actualColIdx = next ? visibleColumnIndexes.value[next.visibleColIdx] : undefined;
  if (canvasRef.value) {
    canvasRef.value.style.cursor = hit?.rowNumber ? "default" : hitItem && actualColIdx !== undefined && canEditCellItem(hitItem, actualColIdx) ? "text" : "cell";
  }
  if (next?.rowIndex === canvasHoverCell.value?.rowIndex && next?.visibleColIdx === canvasHoverCell.value?.visibleColIdx) {
    return;
  }
  const previous = canvasHoverCell.value;
  if (previous) {
    const previousActualColIdx = visibleColumnIndexes.value[previous.visibleColIdx];
    if (previousActualColIdx !== undefined) onCellMouseleave(previous.rowIndex, previousActualColIdx);
  }
  canvasHoverCell.value = next;
  if (next && actualColIdx !== undefined) onCellMouseenter(next.rowIndex, next.visibleColIdx, actualColIdx);
  scheduleCanvasDraw();
}

function onCanvasMouseLeave(event?: MouseEvent) {
  const relatedTarget = event?.relatedTarget;
  if (relatedTarget instanceof Node && canvasOverlayRef.value?.contains(relatedTarget)) return;
  const previous = canvasHoverCell.value;
  if (previous) {
    const previousActualColIdx = visibleColumnIndexes.value[previous.visibleColIdx];
    if (previousActualColIdx !== undefined) onCellMouseleave(previous.rowIndex, previousActualColIdx);
  }
  canvasHoverCell.value = null;
  scheduleCanvasDraw();
}

function keepCanvasDetailHover() {
  const cell = canvasDetailButtonCell.value;
  if (!cell) return;
  canvasHoverCell.value = { rowIndex: cell.rowIndex, visibleColIdx: cell.visibleColIdx };
  hoveredDetailCell.value = { rowIndex: cell.rowIndex, col: cell.actualColIdx };
  scheduleCanvasDraw();
}

function clearCanvasDetailHover(event?: MouseEvent) {
  const relatedTarget = event?.relatedTarget;
  if (relatedTarget instanceof Node && (canvasOverlayRef.value?.contains(relatedTarget) || canvasRef.value?.contains(relatedTarget))) {
    return;
  }
  onCanvasMouseLeave();
}

function onCanvasMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  const hit = canvasHitTest(event);
  if (!hit) {
    commitHiddenCanvasEditBeforeCellInteraction();
    return;
  }
  const item = displayItemAt(hit.rowIndex);
  const actualColIdx = hit.rowNumber ? undefined : visibleColumnIndexes.value[hit.visibleColIdx];
  if (item && actualColIdx !== undefined) prepareDataCellMouseDown(item, actualColIdx);
  commitHiddenCanvasEditBeforeCellInteraction();
  if (!item) return;
  if (hit.rowNumber) {
    handleRowClick(item.displayIndex, item.id, event);
  } else {
    handleDataCellMousedown(item.displayIndex, hit.visibleColIdx, item.id, event);
  }
  gridRef.value?.focus({ preventScroll: true });
  scheduleCanvasDraw();
}

function onCanvasContext(event: MouseEvent) {
  commitHiddenCanvasEditBeforeCellInteraction();
  const hit = canvasHitTest(event);
  if (!hit) return;
  const item = displayItemAt(hit.rowIndex);
  if (!item) return;
  if (hit.rowNumber) {
    onRowContext(item.id, item.displayIndex);
    return;
  }
  const actualColIdx = visibleColumnIndexes.value[hit.visibleColIdx];
  if (actualColIdx === undefined) return;
  onCellContext(item.id, item.displayIndex, actualColIdx, hit.visibleColIdx, event);
}

function onCanvasDblClick(event: MouseEvent) {
  const hit = canvasHitTest(event);
  if (!hit) return;
  if (hit.rowNumber) {
    const item = displayItemAt(hit.rowIndex);
    if (item) toggleTranspose(item.displayIndex);
    return;
  }
  const item = displayItemAt(hit.rowIndex);
  const actualColIdx = visibleColumnIndexes.value[hit.visibleColIdx];
  if (!item || actualColIdx === undefined || !canEditCellItem(item, actualColIdx)) return;
  startCellEdit(item.id, actualColIdx, canvasCellContentOverflows(item, actualColIdx, hit.visibleColIdx));
}

function canvasCellContentOverflows(item: RowItem, actualColIdx: number, visibleColIdx: number): boolean {
  const cellWidth = renderedColumnWidths.value[visibleColIdx] ?? 0;
  if (cellWidth <= 0) return false;
  const displayText = formatCellCached(item.data[actualColIdx], actualColIdx);
  const editText = cellEditorTextForValue(item.data[actualColIdx], actualColIdx);
  if (editText.includes("\n") || editText.includes("\r") || editText.length > displayText.length) return true;
  const textWidth = measureCellTextWidth(displayText, `400 13px ${settingsStore.editorSettings.fontFamily}`);
  return textWidth > Math.max(0, cellWidth - 24);
}

function canvasCellViewportRect(rowIndex: number, visibleColIdx: number) {
  const widths = renderedColumnWidths.value;
  const colWidth = widths[visibleColIdx];
  if (colWidth === undefined) return null;
  const left = DATA_GRID_ROW_NUM_WIDTH + (renderedColumnOffsets.value[visibleColIdx] ?? 0) - gridHorizontalScrollLeft.value;
  return {
    left,
    top: rowIndex * CANVAS_DATA_GRID_ROW_HEIGHT - canvasScrollTop.value,
    width: colWidth,
    height: CANVAS_DATA_GRID_ROW_HEIGHT,
  };
}

function canvasEditingCellViewportRect() {
  const editing = editingCell.value;
  if (!editing || !useCanvasGridRows.value) return null;
  const rowIndex = displayRowIndexById(editing.rowId);
  const visibleColIdx = visibleColumnIndexes.value.indexOf(editing.col);
  if (rowIndex < 0 || visibleColIdx < 0) return null;
  return canvasCellViewportRect(rowIndex, visibleColIdx);
}

function canvasEditingCellIsVisible() {
  const rect = canvasEditingCellViewportRect();
  if (!rect) return false;
  const viewportWidth = canvasEffectiveViewportWidth();
  const viewportHeight = canvasEffectiveViewportHeight();
  const clippedLeft = Math.max(DATA_GRID_ROW_NUM_WIDTH, rect.left);
  const clippedRight = viewportWidth > 0 ? Math.min(viewportWidth, rect.left + rect.width) : rect.left + rect.width;
  return rect.top + rect.height > 0 && rect.top < viewportHeight && clippedRight - clippedLeft > 0;
}

function commitHiddenCanvasEditBeforeCellInteraction() {
  if (!editingCell.value || !useCanvasGridRows.value) return;
  if (canvasEditingCellIsVisible()) return;
  void commitEditFromCellBlur();
}

const canvasEditingCell = computed(() => {
  const editing = editingCell.value;
  if (!editing || !useCanvasGridRows.value) return null;
  const rowIndex = displayRowIndexById(editing.rowId);
  const visibleColIdx = visibleColumnIndexes.value.indexOf(editing.col);
  if (rowIndex < 0 || visibleColIdx < 0) return null;
  const rect = canvasCellViewportRect(rowIndex, visibleColIdx);
  if (!rect) return null;
  return { rowId: editing.rowId, rowIndex, visibleColIdx, actualColIdx: editing.col, rect };
});

function canvasEffectiveViewportWidth(): number {
  return canvasViewportWidth.value || canvasScrollerElement()?.clientWidth || 0;
}

function canvasEffectiveViewportHeight(): number {
  return canvasViewportHeight.value || canvasScrollerElement()?.clientHeight || 0;
}

const canvasOverlayStyle = computed(() => {
  const vh = canvasEffectiveViewportHeight();
  return {
    width: `${canvasSurfaceWidth.value}px`,
    height: `${vh}px`,
    marginTop: `-${vh}px`,
  };
});

const canvasEditingCellStyle = computed(() => {
  const cell = canvasEditingCell.value;
  if (!cell) return {};
  const viewportWidth = canvasEffectiveViewportWidth();
  const clippedLeft = Math.max(DATA_GRID_ROW_NUM_WIDTH, cell.rect.left);
  const clippedRight = viewportWidth > 0 ? Math.min(viewportWidth, cell.rect.left + cell.rect.width) : cell.rect.left + cell.rect.width;
  return {
    left: `${clippedLeft}px`,
    top: `${cell.rect.top}px`,
    width: `${Math.max(0, clippedRight - clippedLeft)}px`,
    height: `${cell.rect.height}px`,
  };
});

const canvasDetailButtonCell = computed(() => {
  if (!useCanvasGridRows.value || isScrolling.value) return null;
  const target = hoveredDetailCell.value ?? quickDownloadMenuCell.value ?? (showCellDetail.value ? detailCell.value : null);
  if (!target || !cellDetailButtonVisible(target.rowIndex, target.col)) return null;
  const editing = editingCell.value;
  if (editing && editing.rowId === displayItems.value[target.rowIndex]?.id && editing.col === target.col) return null;
  const visibleColIdx = visibleColumnIndexes.value.indexOf(target.col);
  if (visibleColIdx < 0) return null;
  const rect = canvasCellViewportRect(target.rowIndex, visibleColIdx);
  if (!rect) return null;
  const viewportWidth = canvasEffectiveViewportWidth();
  const viewportHeight = canvasEffectiveViewportHeight();
  const visibleLeft = Math.max(DATA_GRID_ROW_NUM_WIDTH, rect.left);
  const visibleRight = viewportWidth > 0 ? Math.min(viewportWidth, rect.left + rect.width) : rect.left + rect.width;
  const canQuickDownload = canQuickDownloadCellValue(target.rowIndex, target.col);
  const minWidth = canQuickDownload ? 46 : 24;
  if (rect.top < 0 || rect.top > viewportHeight - 1 || visibleRight - visibleLeft < minWidth) return null;
  return { rowIndex: target.rowIndex, visibleColIdx, actualColIdx: target.col, rect, canQuickDownload };
});

const canvasDetailButtonStyle = computed(() => {
  const cell = canvasDetailButtonCell.value;
  if (!cell) return {};
  const actionWidth = cell.canQuickDownload ? 44 : 22;
  const edgeGap = 6;
  return {
    left: `${Math.max(DATA_GRID_ROW_NUM_WIDTH, cell.rect.left + cell.rect.width - actionWidth - edgeGap)}px`,
    top: `${cell.rect.top + 2}px`,
  };
});

function drawCanvasGrid() {
  const canvas = canvasRef.value;
  const scroller = canvasScrollerElement();
  if (!canvas || !scroller || !useCanvasGridRows.value) return;

  drawCanvasDataGrid({
    canvas,
    scroller,
    width: Math.max(1, canvasSurfaceWidth.value || scroller.clientWidth),
    height: Math.max(1, canvasViewportHeight.value || scroller.clientHeight),
    pixelRatio: canvasBackingPixelRatio.value,
    isDark: isDark.value,
    styleKey: canvasRenderStyleKey.value,
    rowCount: displayRowCount.value,
    rowAt: displayItemAt,
    renderedColumnWidths: renderedColumnWidths.value,
    renderedColumnOffsets: renderedColumnOffsets.value,
    columnPreviewOffsets: columnHeaderPreviewOffsets.value,
    columnPreviewSourceVisibleIndex: columnHeaderPreviewSourceVisibleIndex.value,
    visibleColumnIndexes: visibleColumnIndexes.value,
    rowNumberWidth: DATA_GRID_ROW_NUM_WIDTH,
    hoverCell: canvasHoverCell.value,
    isScrolling: isScrolling.value,
    editingCell: editingCell.value,
    searchMatchKeys: searchMatchSet.value,
    currentSearchMatch: currentSearchMatch.value,
    formatCell: formatCellCached,
    draftCellPlaceholder: t("grid.quickEntryDraftPlaceholder"),
    isRowActive,
    rowCellsUseSelectionVisual,
    cellIsSelected,
    cellCanHover: canEditCellItem,
    infiniteScrollEnabled: infiniteScrollEnabled.value,
    pageSize: pageSize.value,
    currentPage: currentPage.value,
  });
}

watch(
  [useCanvasGridRows, hasVisibleRows],
  () => {
    // When an empty table gets its first pending row, the canvas scroller is created by
    // the v-if branch after the original mount-time observer attempt has already no-op'd.
    // Reattach after that branch mounts so the canvas/overlay get real viewport dimensions.
    nextTick(attachCanvasResizeObserver);
  },
  { immediate: true },
);
watch(showDataGridTopbar, () => nextTick(observeDataGridTopbarWidth), { immediate: true });
watch(
  [
    displayRowRefs,
    renderedColumnWidths,
    visibleColumnIndexes,
    selectedRange,
    selectedRowIds,
    hasCellSelection,
    hasRowSelection,
    isSelectingAll,
    searchMatchSet,
    currentSearchMatch,
    isDark,
    canvasRenderStyleKey,
    canvasDevicePixelRatio,
    canvasBackingPixelRatio,
    isScrolling,
    hoveredDetailCell,
    detailCell,
    showCellDetail,
    editingCell,
    // Pending edit structures can contain large nested cell maps; the editor
    // version ref gives the canvas a cheap invalidation signal without a deep watch.
    pendingChangesVersion,
  ],
  scheduleCanvasDraw,
);

function pauseCanvasGridWork() {
  dataGridIsActive = false;
  canvasResizeObserver?.disconnect();
  canvasResizeObserver = null;
  disconnectCellEditResizeObserver();
  dataGridTopbarResizeObserver?.disconnect();
  dataGridTopbarResizeObserver = null;
  canvasPixelRatioMediaQueryCleanup?.();
  canvasPixelRatioMediaQueryCleanup = null;
  canvasPixelRatioMediaQuery = null;
  if (canvasPixelRatioFrame) {
    cancelAnimationFrame(canvasPixelRatioFrame);
    canvasPixelRatioFrame = 0;
  }
  if (canvasDrawFrame) {
    cancelAnimationFrame(canvasDrawFrame);
    canvasDrawFrame = 0;
  }
}

function resumeCanvasGridWork() {
  dataGridIsActive = true;
  nextTick(() => {
    attachCanvasResizeObserver();
    observeDataGridTopbarWidth();
    refreshGridScrollerMetrics();
    observeGridHorizontalScrollbarScroller();
  });
}

onMounted(resumeCanvasGridWork);
onActivated(resumeCanvasGridWork);
onMounted(() => {
  if (typeof window === "undefined") return;
  window.addEventListener("resize", scheduleCanvasPixelRatioRefresh);
  window.addEventListener("resize", resizeFocusedConditionInputs);
  window.visualViewport?.addEventListener("resize", scheduleCanvasPixelRatioRefresh);
  window.visualViewport?.addEventListener("resize", resizeFocusedConditionInputs);
  window.addEventListener("dbx:ui-scale-applied", scheduleCanvasPixelRatioRefresh);
  window.addEventListener("dbx:ui-scale-applied", resizeFocusedConditionInputs);
  window.addEventListener(TABLE_DATA_GRID_COLUMN_ORDER_CHANGED_EVENT, onTableDataGridColumnOrderChanged);
  document.addEventListener("pointerdown", onConditionSuggestionDocumentPointerDown, true);
});
onDeactivated(pauseCanvasGridWork);
onUnmounted(() => {
  pauseCanvasGridWork();
  clearConditionCollapseTimer("where");
  clearConditionCollapseTimer("orderBy");
  gridHorizontalScrollbarResizeObserver?.disconnect();
  dataGridTopbarResizeObserver?.disconnect();
  disconnectCellEditResizeObserver();
  stopColumnHeaderDrag(false);
  stopGridHorizontalScrollbarDrag();
  stopGridVerticalScrollbarDrag();
  if (gridHorizontalScrollbarFrame && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(gridHorizontalScrollbarFrame);
  }
  if (gridVerticalScrollbarDragFrame && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(gridVerticalScrollbarDragFrame);
  }
  if (typeof window === "undefined") return;
  window.removeEventListener("resize", scheduleCanvasPixelRatioRefresh);
  window.removeEventListener("resize", resizeFocusedConditionInputs);
  window.visualViewport?.removeEventListener("resize", scheduleCanvasPixelRatioRefresh);
  window.visualViewport?.removeEventListener("resize", resizeFocusedConditionInputs);
  window.removeEventListener("dbx:ui-scale-applied", scheduleCanvasPixelRatioRefresh);
  window.removeEventListener("dbx:ui-scale-applied", resizeFocusedConditionInputs);
  window.removeEventListener(TABLE_DATA_GRID_COLUMN_ORDER_CHANGED_EVENT, onTableDataGridColumnOrderChanged);
  document.removeEventListener("pointerdown", onConditionSuggestionDocumentPointerDown, true);
});

function setRowStatusFilter(value: string) {
  rowStatusFilter.value = value as RowStatusFilter;
}

// --- Export progress dialog state ---
const exportProgressDialog = ref(false);
const exportProgressState = ref({
  title: "",
  tableName: "",
  format: "csv" as string,
  rowsExported: 0,
  totalRows: null as number | null,
  status: "",
  errorMessage: null as string | null,
});
const exportCancelHandler = ref<(() => Promise<void>) | null>(null);

async function cancelActiveExport() {
  await exportCancelHandler.value?.();
}

// --- Export composable ---
const {
  copyText,
  copyCell,
  copyRow,
  copyRowAsInsert,
  copyRowAsInsertWithoutPrimaryKeys,
  prefetchRowAsInsertStatement,
  canCopyRowAsInsert,
  prefetchRowAsUpdateStatement,
  copyRowAsUpdate,
  canCopyRowAsInsertWithoutPrimaryKeys,
  canCopyRowAsUpdate,
  copyAll,
  copySelectionTsv,
  copySelectionTsvWithHeaders,
  copySelectionCsv,
  copySelectionJson,
  copySelectionSqlInList,
  copySelectedRowsTsv,
  copySelectedRowsTsvWithHeaders,
  copyColumnNames,
  exportCsv,
  exportCurrentPageCsv,
  exportJson,
  exportCurrentPageJson,
  exportMarkdown,
  exportCurrentPageMarkdown,
  exportXlsx,
  exportCurrentPageXlsx,
  exportAllResultsXlsx,
  exportSql,
  exportCurrentPageSql,
  copySql,
} = useDataGridExport({
  columns: visibleColumns,
  displayItems: visibleDisplayItems,
  sql: computed(() => props.sql),
  tableMeta: computed(() => (props.tableMeta ? { ...props.tableMeta } : undefined)),
  copyInsertTargetLabel: computed(() => props.tableMeta?.tableName ?? props.customSaveHandler?.targetLabel),
  databaseType: computed(() => props.databaseType),
  connectionId: computed(() => props.connectionId),
  database: computed(() => props.executionDatabase ?? props.database),
  context: computed(() => props.context),
  sourceColumns: visibleSourceColumns,
  columnTypes: visibleColumnTypes,
  whereInput: computed(() => currentWhereInput()),
  orderBy: computed(() => currentOrderBy()),
  exportBatchSize: computed(() => settingsStore.editorSettings.exportBatchSize),
  hasCellSelection,
  selectedCells,
  selectedRange,
  contextCell: exportContextCell,
  getRowItem: (rowId: number) => visibleDisplayItems.value.find((item) => item.id === rowId),
  selectedRowIds,
  hasRowSelection,
  fullExportResult: props.fullExportResult,
  queryResultExportRequest: props.queryResultExportRequest,
  hasCompleteLocalResult,
  completeLocalResult: computed(() => (hasCompleteLocalResult.value ? props.result : undefined)),
  allExportResults: computed(() => props.allExportResults),
  currentResultLabel: computed(() => props.result.sourceLabel),
  exportFileBaseName: computed(() => props.exportFileBaseName),
  exportProgressDialog,
  exportProgressState,
  exportCancelHandler,
});

const canAutoRefresh = computed(() => !isSaving.value && !props.loading);

const pageSizeMenuItems = computed(() =>
  pageSizeOptions.value.map((size) => ({
    value: String(size),
    label: `${size} ${t("grid.rowsPerPageShort")}`,
  })),
);

const exportMenuItems = computed(() => {
  const hasFullResultExport = !!props.fullExportResult;
  const allResultItems = (props.allExportResults?.length ?? 0) > 1 ? [{ value: "all-results-xlsx", label: t("grid.exportAllResultsXlsx"), separatorBefore: true }] : [];
  const selectedItems = isMultiRow.value
    ? [
        { value: "selected-csv", label: t("grid.exportSelectedRowsCsv"), separatorBefore: true },
        { value: "selected-xlsx", label: t("grid.exportSelectedRowsXlsx") },
        { value: "selected-json", label: t("grid.exportSelectedRowsJson") },
        { value: "selected-markdown", label: t("grid.exportSelectedRowsMarkdown") },
        { value: "selected-sql", label: t("grid.exportSelectedRowsSql") },
      ]
    : [];

  if (!hasFullResultExport) {
    return [{ value: "csv", label: t("grid.exportCsv") }, { value: "xlsx", label: t("grid.exportXlsx") }, { value: "json", label: t("grid.exportJson") }, { value: "markdown", label: t("grid.exportMarkdown") }, { value: "sql", label: t("grid.exportSql") }, ...allResultItems, ...selectedItems];
  }

  return [
    { value: "page-csv", label: t("grid.exportCurrentPageCsv") },
    { value: "page-xlsx", label: t("grid.exportCurrentPageXlsx") },
    { value: "page-json", label: t("grid.exportCurrentPageJson") },
    { value: "page-markdown", label: t("grid.exportCurrentPageMarkdown") },
    { value: "page-sql", label: t("grid.exportCurrentPageSql") },
    { value: "csv", label: t("grid.exportCurrentResultCsv"), separatorBefore: true },
    { value: "xlsx", label: t("grid.exportCurrentResultXlsx") },
    { value: "json", label: t("grid.exportCurrentResultJson") },
    { value: "markdown", label: t("grid.exportCurrentResultMarkdown") },
    { value: "sql", label: t("grid.exportCurrentResultSql") },
    ...allResultItems,
    ...selectedItems,
  ];
});

function selectPageSizeMenuItem(value: string) {
  changePageSize(Number(value));
}

function selectExportMenuItem(value: string) {
  const actions: Record<string, () => void> = {
    "page-csv": exportCurrentPageCsv,
    "page-xlsx": exportCurrentPageXlsx,
    "page-json": exportCurrentPageJson,
    "page-markdown": exportCurrentPageMarkdown,
    "page-sql": exportCurrentPageSql,
    csv: exportCsv,
    xlsx: exportXlsx,
    "all-results-xlsx": exportAllResultsXlsx,
    json: exportJson,
    markdown: exportMarkdown,
    sql: exportSql,
    "selected-csv": exportSelectedRowsCsv,
    "selected-xlsx": exportSelectedRowsXlsx,
    "selected-json": exportSelectedRowsJson,
    "selected-markdown": exportSelectedRowsMarkdown,
    "selected-sql": exportSelectedRowsSql,
  };
  actions[value]?.();
}

// --- Cell selection and detail ---
function showCellDetails(rowIndex: number, colIndex: number) {
  closeMongoJsonPreview();
  resetDetailEdit();
  detailCell.value = { rowIndex, col: colIndex };
  activeCellDetailTab.value = defaultCellDetailTab();
  showCellDetail.value = true;
}

function showCellDetailsForVisibleCell(rowIndex: number, visibleColIdx: number, actualColIdx: number) {
  clearRowSelection();
  selectSingleCell(rowIndex, visibleColIdx);
  showCellDetails(rowIndex, actualColIdx);
}

function openCellDetailDialog(rowIndex: number, columnIndex: number) {
  cellDetailDialogTarget.value = { rowIndex, col: columnIndex };
  cellDetailDialogOpen.value = true;
}

function openColumnDetailDialog(columnIndex: number) {
  if (!props.result.columns[columnIndex]) return;
  columnDetailDialogColumnIndex.value = columnIndex;
  columnDetailDialogOpen.value = true;
}

function openContextCellDetailDialog() {
  const cell = contextCell.value;
  if (!cell || cell.col < 0) return;
  openCellDetailDialog(cell.rowIndex, cell.col);
}

function openContextColumnDetailDialog() {
  const cell = contextCell.value;
  if (cell && cell.col >= 0) {
    openColumnDetailDialog(cell.col);
    return;
  }
  if (contextHeaderColumnIndex.value === null) return;
  openColumnDetailDialog(contextHeaderColumnIndex.value);
}

function openActiveCellDetailDialog() {
  const detail = activeCellDetail.value;
  if (!detail) return;
  openCellDetailDialog(detail.rowNumber - 1, detail.colIndex);
}

function openActiveColumnDetailDialog() {
  const detail = activeCellDetail.value;
  if (!detail) return;
  openColumnDetailDialog(detail.colIndex);
}

function openRowDetailDialog(rowId: number) {
  rowDetailDialogRowId.value = rowId;
  rowDetailDialogOpen.value = true;
}

function openContextRowDetailDialog() {
  const cell = contextCell.value;
  if (!cell) return;
  openRowDetailDialog(cell.rowId);
}

function openActiveRowDetailDialog() {
  const detail = activeCellDetail.value;
  if (!detail) return;
  openRowDetailDialog(detail.rowId);
}

function closeDetailDialogs() {
  cellDetailDialogOpen.value = false;
  cellDetailDialogTarget.value = null;
  rowDetailDialogOpen.value = false;
  rowDetailDialogRowId.value = null;
  columnDetailDialogOpen.value = false;
  columnDetailDialogColumnIndex.value = null;
}

function transposeCellIsSelected(rowIndex: number, actualColIdx: number) {
  const visibleColIdx = visibleColumnIndexes.value.indexOf(actualColIdx);
  return visibleColIdx >= 0 && cellIsSelected(rowIndex, visibleColIdx);
}

function onTransposeCellMouseenter(rowIndex: number, actualColIdx: number) {
  if (isScrolling.value) return;
  hoveredDetailCell.value = { rowIndex, col: actualColIdx };
}

function selectTransposeCell(rowIndex: number, actualColIdx: number, event: MouseEvent) {
  const visibleColIdx = visibleColumnIndexes.value.indexOf(actualColIdx);
  if (visibleColIdx < 0) return;
  contextHeaderColumn.value = null;
  contextHeaderColumnIndex.value = null;
  clearRowSelection();
  if (event.shiftKey || event.metaKey || event.ctrlKey) {
    extendCellSelectionTo(rowIndex, visibleColIdx);
  } else {
    selectSingleCell(rowIndex, visibleColIdx);
  }
  transposeRowIndex.value = rowIndex;
  gridRef.value?.focus({ preventScroll: true });
}

function showTransposeCellDetails(rowIndex: number, actualColIdx: number) {
  const visibleColIdx = visibleColumnIndexes.value.indexOf(actualColIdx);
  if (visibleColIdx < 0) return;
  contextHeaderColumn.value = null;
  contextHeaderColumnIndex.value = null;
  clearRowSelection();
  selectSingleCell(rowIndex, visibleColIdx);
  transposeRowIndex.value = rowIndex;
  showCellDetails(rowIndex, actualColIdx);
  gridRef.value?.focus({ preventScroll: true });
}

function onTransposeCellContext(rowIndex: number, actualColIdx: number, event: MouseEvent) {
  selectTransposeCell(rowIndex, actualColIdx, event);
  const item = displayItemAt(rowIndex);
  contextCell.value = item ? { rowId: item.id, rowIndex, col: actualColIdx } : null;
  void prefetchCopyStatements();
}

watch([selectedRange, showCellDetail, isEditingDetail], () => {
  const selectedCell = currentSelectedCellPosition();
  const target = linkedCellDetailTarget({
    isOpen: showCellDetail.value,
    isEditing: isEditingDetail.value && activeCellDetailTab.value !== "valueEditor",
    selectedCell: selectedCell ? { rowIndex: selectedCell.rowIndex, visibleColIndex: selectedCell.colIndex } : null,
    actualColumnIndex,
  });
  if (!target) return;
  detailCell.value = target;
});

function openImagePreview(src: string, title: string) {
  imagePreviewSrc.value = src;
  imagePreviewTitle.value = title;
  imagePreviewOpen.value = true;
}

function onDrawerContextMenu(event: MouseEvent) {
  event.stopPropagation();
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable='true'], [role='textbox']")) return;
  event.preventDefault();
}

function clipboardShortcut(event: KeyboardEvent, key: string): boolean {
  return isPlainClipboardShortcut(event, key);
}

let lastPasteEventAt = 0;

async function pasteClipboardIntoSelection() {
  if (!props.editable) return;
  const text = await readTextFromClipboard();
  pasteTextIntoSelection(text);
}

function pasteTextIntoSelection(text: string): boolean {
  const rows = parseClipboardTable(text);
  const allowDraftSelectionValue = selectedRangeTargetsOnlyDraftRow();

  if (rows.length === 1 && rows[0]?.length === 1 && fillSelectionWithValue(rows[0][0])) {
    toast(t("grid.pasted"));
    return true;
  }

  const start = pasteStartCell();
  if (!start) return false;
  let applied = false;
  rows.forEach((row, rowOffset) => {
    const item = displayItemAt(start.rowIndex + rowOffset);
    if (!item) return;
    row.forEach((value, colOffset) => {
      const visibleCol = start.colIndex + colOffset;
      if (visibleCol >= visibleColumns.value.length) return;
      applied = applyVisibleSelectedCellValue(item, visibleCol, value, allowDraftSelectionValue) || applied;
    });
  });
  if (applied) toast(t("grid.pasted"));
  return applied;
}

function onGridPaste(event: ClipboardEvent) {
  if (!props.editable || (!selectedRange.value && !hasColumnSelection.value)) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, [contenteditable='true'], [role='textbox']")) return;
  const text = event.clipboardData?.getData("text/plain");
  if (text === undefined) return;
  event.preventDefault();
  lastPasteEventAt = Date.now();
  pasteTextIntoSelection(text);
}

function pasteStartCell() {
  const start = selectedRangeStart();
  if (start) return start;
  if (!hasColumnSelection.value) return null;
  const firstCol = selectedVisibleColumnIndexes()[0];
  return firstCol === undefined ? null : { rowIndex: 0, colIndex: firstCol };
}

function selectedVisibleColumnIndexes(): number[] {
  return [...selectedColumnIndexes.value].filter((index) => index >= 0 && index < visibleColumns.value.length).sort((a, b) => a - b);
}

function applyVisibleCellValue(item: RowItem, visibleCol: number, value: string | null): boolean {
  const actualCol = actualColumnIndex(visibleCol);
  if (!canEditCellItem(item, actualCol)) return false;
  applyCellValue(item.id, actualCol, value);
  return true;
}

function applyVisibleSelectedCellValue(item: RowItem, visibleCol: number, value: string | null, allowDraft = selectedRangeTargetsOnlyDraftRow()): boolean {
  if (!canApplyGridSelectionValue({ isDraft: !!item.isDraft, allowDraft })) return false;
  return applyVisibleCellValue(item, visibleCol, value);
}

function selectedRangeTargetsOnlyDraftRow(): boolean {
  const range = selectedRange.value;
  if (!range) return false;
  if (range.startRow !== range.endRow) return false;
  return displayItemAt(range.startRow)?.isDraft === true;
}

function fillSelectionWithValue(value: string | null): boolean {
  const range = selectedRange.value;
  let applied = false;
  const allowDraftSelectionValue = selectedRangeTargetsOnlyDraftRow();
  if (range) {
    for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex++) {
      const item = displayItemAt(rowIndex);
      if (!item) continue;
      for (let visibleCol = range.startCol; visibleCol <= range.endCol; visibleCol++) {
        applied = applyVisibleSelectedCellValue(item, visibleCol, value, allowDraftSelectionValue) || applied;
      }
    }
    return applied;
  }

  if (!hasColumnSelection.value) return false;
  const visibleColumnIndexes = selectedVisibleColumnIndexes();
  if (!visibleColumnIndexes.length) return false;
  for (let rowIndex = 0; rowIndex < displayRowCount.value; rowIndex++) {
    const item = displayItemAt(rowIndex);
    if (!item) continue;
    for (const visibleCol of visibleColumnIndexes) {
      applied = applyVisibleSelectedCellValue(item, visibleCol, value) || applied;
    }
  }
  return applied;
}

function selectionHasEditableCells(): boolean {
  const range = selectedRange.value;
  if (range) {
    for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex++) {
      const item = displayItemAt(rowIndex);
      if (!item) continue;
      for (let visibleCol = range.startCol; visibleCol <= range.endCol; visibleCol++) {
        if (canEditCellItem(item, actualColumnIndex(visibleCol))) return true;
      }
    }
    return false;
  }

  if (!hasColumnSelection.value) return false;
  const visibleColumnIndexes = selectedVisibleColumnIndexes();
  for (let rowIndex = 0; rowIndex < displayRowCount.value; rowIndex++) {
    const item = displayItemAt(rowIndex);
    if (!item) continue;
    for (const visibleCol of visibleColumnIndexes) {
      if (canEditCellItem(item, actualColumnIndex(visibleCol))) return true;
    }
  }
  return false;
}

function openBulkEditDialog() {
  if (!props.editable || !selectionHasEditableCells()) return;
  bulkEditValue.value = "";
  bulkEditDialogOpen.value = true;
}

function applyBulkEditValue() {
  // Empty input sets the selected cells to SQL NULL (the placeholder hints "Value, or NULL").
  const value = bulkEditValue.value === "" ? null : bulkEditValue.value;
  if (!fillSelectionWithValue(value)) return;
  bulkEditDialogOpen.value = false;
}

function cutSelection() {
  if (!props.editable || !selectedRange.value) return;
  copySelectionTsv();
  const range = selectedRange.value;
  const allowDraftSelectionValue = selectedRangeTargetsOnlyDraftRow();
  for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex++) {
    const item = displayItemAt(rowIndex);
    if (!item) continue;
    for (let visibleCol = range.startCol; visibleCol <= range.endCol; visibleCol++) {
      applyVisibleSelectedCellValue(item, visibleCol, null, allowDraftSelectionValue);
    }
  }
}

function currentSelectedCellPosition() {
  const range = selectedRange.value;
  if (!range) return null;
  return { rowIndex: range.startRow, colIndex: range.startCol };
}

function scrollCellIntoView(rowIndex: number, colIndex: number) {
  nextTick(() => {
    scrollGridColumnIntoView(colIndex);
    if (useCanvasGridRows.value) {
      scrollCanvasRowIntoView(rowIndex, "nearest");
      return;
    }
    nextTick(() => {
      const rowEl = gridRef.value?.querySelector<HTMLElement>(`[data-row-index="${rowIndex}"]`);
      const cellEl = rowEl?.querySelector<HTMLElement>(`[data-visible-col-index="${colIndex}"]`);
      (cellEl ?? rowEl)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  });
}

function scrollGridColumnIntoView(visibleColIdx: number) {
  const scroller = gridRef.value?.querySelector<HTMLElement>(".data-grid-scroller");
  if (!scroller) return;
  const colLeft = columnContentOffsetLeft(visibleColIdx);
  const colRight = colLeft + (renderedColumnWidths.value[visibleColIdx] ?? 0);
  const viewportLeft = scroller.scrollLeft + DATA_GRID_ROW_NUM_WIDTH;
  const viewportRight = scroller.scrollLeft + scroller.clientWidth;

  if (colLeft < viewportLeft) {
    scroller.scrollLeft = Math.max(0, colLeft - DATA_GRID_ROW_NUM_WIDTH);
  } else if (colRight > viewportRight) {
    scroller.scrollLeft = Math.max(0, colRight - scroller.clientWidth);
  }

  updateGridHorizontalViewport(scroller);
  if (headerRef.value) headerRef.value.scrollLeft = scroller.scrollLeft;
  if (useCanvasGridRows.value) syncCanvasViewport();
}

function scrollCanvasRowIntoView(rowIndex: number, block: "nearest" | "start") {
  const target = Math.max(0, Math.min(displayRowCount.value - 1, rowIndex));
  const scroller = canvasScrollerElement();
  if (!scroller) return;
  const rowTop = target * CANVAS_DATA_GRID_ROW_HEIGHT;
  const rowBottom = rowTop + CANVAS_DATA_GRID_ROW_HEIGHT;
  if (block === "start" || rowTop < scroller.scrollTop) {
    scroller.scrollTop = rowTop;
  } else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = Math.max(0, rowBottom - scroller.clientHeight);
  }
  syncCanvasViewport();
}

function scrollGridRowIntoView(rowIndex: number) {
  const target = Math.max(0, Math.min(displayRowCount.value - 1, rowIndex));
  nextTick(() => {
    if (useCanvasGridRows.value) {
      scrollCanvasRowIntoView(target, "start");
      return;
    }
    const scroller = scrollerRef.value;
    if (scroller && !(scroller instanceof HTMLElement)) {
      scroller.scrollToItem?.(target);
      scroller.scrollToPosition?.(target * 26);
    } else if (scroller instanceof HTMLElement) {
      scroller.scrollTop = target * 26;
    }
    requestAnimationFrame(() => {
      const rowEl = gridRef.value?.querySelector<HTMLElement>(`[data-row-index="${target}"]`);
      rowEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  });
}

function currentTransposeRequestedRowIndex(): number {
  const position = currentSelectedCellPosition();
  if (position) return position.rowIndex;
  if (transposeRowIndex.value !== null) return transposeRowIndex.value;
  return 0;
}

function toggleKeyboardTranspose(): boolean {
  if (displayRowCount.value === 0) return false;
  const requestedRowIndex = currentTransposeRequestedRowIndex();
  const next = nextKeyboardTransposeState({
    showTranspose: showTranspose.value,
    transposeRowIndex: transposeRowIndex.value,
    requestedRowIndex,
    rowIds: displayRowRefs.value.map((ref) => ref.id),
    selectedRowIds: selectedRowIds.value,
    selectedRange: selectedRange.value,
  });
  showTranspose.value = next.showTranspose;
  transposeRowIndex.value = next.transposeRowIndex;
  if (next.showTranspose) {
    closeCellDetails();
    nextTick(updateTransposeViewport);
    if (next.transposeRowIndex !== null) scrollTransposeRecordIntoView(next.transposeRowIndex);
  } else {
    scrollGridRowIntoView(requestedRowIndex);
  }
  return true;
}

function moveSelectedCell(rowDelta: number, colDelta: number): boolean {
  const position = currentSelectedCellPosition();
  if (!position || editingCell.value || displayRowCount.value === 0 || visibleColumnIndexes.value.length === 0) return false;
  const rowIndex = Math.max(0, Math.min(displayRowCount.value - 1, position.rowIndex + rowDelta));
  const colIndex = Math.max(0, Math.min(visibleColumnIndexes.value.length - 1, position.colIndex + colDelta));
  selectSingleCell(rowIndex, colIndex);
  clearRowSelection();
  if (showTranspose.value) transposeRowIndex.value = rowIndex;
  scrollCellIntoView(rowIndex, colIndex);
  return true;
}

function editSelectedCell(): boolean {
  const position = currentSelectedCellPosition();
  if (!position || editingCell.value) return false;
  const item = displayItemAt(position.rowIndex);
  const actualColIndex = actualColumnIndex(position.colIndex);
  if (!item || !canEditCellItem(item, actualColIndex)) return false;
  startEdit(item.id, actualColIndex);
  return true;
}

function selectedOrCurrentRowIds(): number[] {
  const affected = affectedRowIds();
  if (affected.length > 0) return affected;
  const position = currentSelectedCellPosition();
  if (!position) return [];
  const item = displayItemAt(position.rowIndex);
  return item ? [item.id] : [];
}

function copyCurrentRow(): boolean {
  if (!canInsertRows.value) return false;
  const rowIds = selectedOrCurrentRowIds().filter((rowId) => !getRowItem(rowId)?.isDraft);
  if (rowIds.length === 0) return false;
  if (rowIds.length === 1) {
    cloneRow(rowIds[0]);
    return true;
  }
  cloneRows(rowIds);
  return true;
}

function deleteCurrentRow(): boolean {
  const rowIds = selectedOrCurrentRowIds();
  if (rowIds.length === 0) return false;

  const targetRowIds = deletableRowIds(rowIds);
  if (targetRowIds.length === 0) return false;
  if (targetRowIds.length === 1) {
    requestDeleteRow(targetRowIds[0]);
    return true;
  }
  requestDeleteRows(targetRowIds);
  return true;
}

function commitGridEdit(value?: string | null) {
  void commitEditAndMaybeAutoSave(value === undefined ? undefined : { explicitValue: value }).finally(() => nextTick(() => gridRef.value?.focus({ preventScroll: true })));
}

async function commitEditFromCellBlur() {
  const target = pendingQuickEntryDraftCellFocus.value;
  pendingQuickEntryDraftCellFocus.value = null;
  if (target && editingCell.value?.rowId === quickEntryDraftRowId && target.rowId === quickEntryDraftRowId) {
    await commitEditFromBlur({ promoteDraft: false });
    nextTick(() => {
      const item = getRowItem(target.rowId);
      if (item && canEditCellItem(item, target.col)) startEdit(target.rowId, target.col);
    });
    return;
  }
  await commitEditFromBlur();
}

function prepareDataCellMouseDown(item: RowItem, actualColIdx: number) {
  const editing = editingCell.value;
  if (editing?.rowId === quickEntryDraftRowId && item.isDraft && item.id === quickEntryDraftRowId && editing.col !== actualColIdx) {
    pendingQuickEntryDraftCellFocus.value = { rowId: item.id, col: actualColIdx };
  } else {
    pendingQuickEntryDraftCellFocus.value = null;
  }
}

function prepareTransposeCellMouseDown(rowIndex: number, actualColIdx: number) {
  const item = displayItemAt(rowIndex);
  if (item) prepareDataCellMouseDown(item, actualColIdx);
}

async function saveGridChangesFromShortcut() {
  if (!saveToolbarState.value.showActions || saveToolbarState.value.actionsDisabled) return false;
  await onToolbarCommit();
  return true;
}

async function onCellEditKeydown(event: KeyboardEvent) {
  if (isSaveShortcut(event, settingsStore.editorSettings.shortcuts)) {
    event.preventDefault();
    event.stopPropagation();
    commitEdit();
    await nextTick();
    if (await saveGridChangesFromShortcut()) {
      gridRef.value?.focus({ preventScroll: true });
    }
    return;
  }
  onEditKeydown(event);
}

function undoGridChange(): boolean {
  if (editingCell.value || !canUndoPendingChange.value) return false;
  undoPendingChange();
  return true;
}

function redoGridChange(): boolean {
  if (editingCell.value || !canRedoPendingChange.value) return false;
  redoPendingChange();
  return true;
}

function openCellDetailSearch(): boolean {
  return getDetailEditor()?.openSearch() ?? false;
}

async function onGridKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;

  if (isFocusSearchShortcut(event)) {
    event.preventDefault();
    focusSearch();
    return;
  }
  if (isModRShortcut(event)) {
    event.preventDefault();
    event.stopPropagation();
    await onToolbarRefresh();
    return;
  }
  if (eventTargetAllowsNativeClipboard(event)) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
    const handled = event.shiftKey ? redoGridChange() : undoGridChange();
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  if (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "y") {
    if (redoGridChange()) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "n") {
    if (props.editable && hasDataGridInsertTarget.value && canInsertRows.value) {
      event.preventDefault();
      event.stopPropagation();
      addRow();
    }
    return;
  }
  if (isSaveShortcut(event, settingsStore.editorSettings.shortcuts)) {
    if (await saveGridChangesFromShortcut()) {
      event.preventDefault();
      event.stopPropagation();
    }
    return;
  }
  if (isCopyCurrentRowShortcut(event, settingsStore.editorSettings.shortcuts) && copyCurrentRow()) {
    event.preventDefault();
    return;
  }
  if (isDeleteCurrentRowShortcut(event, settingsStore.editorSettings.shortcuts) && deleteCurrentRow()) {
    event.preventDefault();
    return;
  }
  if (isToggleTransposeShortcut(event, settingsStore.editorSettings.shortcuts) && toggleKeyboardTranspose()) {
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowLeft" && moveTransposeRecordSelection(-1)) {
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowRight" && moveTransposeRecordSelection(1)) {
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowUp" && moveSelectedCell(-1, 0)) {
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowDown" && moveSelectedCell(1, 0)) {
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowLeft" && moveSelectedCell(0, -1)) {
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowRight" && moveSelectedCell(0, 1)) {
    event.preventDefault();
    return;
  }
  if (event.key === "Enter" && editSelectedCell()) {
    event.preventDefault();
    return;
  }
  if (clipboardShortcut(event, "c")) {
    if (!hasCellSelection.value && !hasRowSelection.value) return;
    event.preventDefault();
    if (isTransposeMode.value && hasRowSelection.value) {
      copyRow();
      return;
    }
    if (hasCellSelection.value) {
      copySelectionTsv();
    } else {
      copySelectedRowsTsv();
    }
    return;
  }
  if (clipboardShortcut(event, "a")) {
    if (!hasData.value) return;
    event.preventDefault();
    selectAllCells();
    return;
  }
  if (clipboardShortcut(event, "x")) {
    if (!props.editable || !selectedRange.value) return;
    event.preventDefault();
    cutSelection();
    return;
  }
  if (clipboardShortcut(event, "v")) {
    if (!props.editable || (!selectedRange.value && !hasColumnSelection.value)) return;
    const keydownAt = Date.now();
    window.setTimeout(() => {
      if (lastPasteEventAt >= keydownAt) return;
      pasteClipboardIntoSelection().catch((e) => toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000));
    }, 50);
    return;
  }
}

function copyDetailValue() {
  const detail = activeCellDetail.value;
  if (!detail) return;
  const text = detail.value === null ? "" : displayCellValue(detail.value);
  copyText(text);
}

function copyDetailFormattedJson() {
  const detail = activeCellDetail.value;
  if (!detail?.formattedJson) return;
  copyText(detail.formattedJson);
}

function copyDetailCurrentValue() {
  if (sideDetailJsonView.value && activeCellDetail.value?.formattedJson) {
    copyDetailFormattedJson();
  } else {
    copyDetailValue();
  }
}

function copyDetailColumnName() {
  if (!activeCellDetail.value) return;
  copyText(activeCellDetail.value.column);
}

function canDownloadDetailBinaryValue(detail: DataGridCellDetail | null): boolean {
  return !!detail && canDownloadBinaryCellValue(detail.value, detail.type);
}

function canQuickDownloadCellValue(rowIndex: number, columnIndex: number): boolean {
  return canDownloadDetailBinaryValue(cellDetailFor(rowIndex, columnIndex));
}

function downloadCellBinaryValue(rowIndex: number, columnIndex: number, mode: BinaryCellDownloadMode) {
  void downloadDetailBinaryValue(cellDetailFor(rowIndex, columnIndex), mode);
}

async function downloadDetailBinaryValue(detail: DataGridCellDetail | null, mode: BinaryCellDownloadMode) {
  if (!detail || !canDownloadDetailBinaryValue(detail)) return;
  try {
    const payload = binaryCellDownloadPayload(detail.value, mode, detail.type);
    const fileName = binaryCellDownloadFileName({
      column: detail.column,
      rowNumber: detail.rowNumber,
      mode,
      extension: payload.extension,
    });
    const result = await downloadBinaryCellPayload(payload, fileName);
    if (result.kind === "saved" && result.path) {
      toast(t("grid.downloadSaved", { path: result.path }));
    } else if (result.kind === "browser-download") {
      toast(t("grid.downloadStarted", { fileName: result.fileName ?? fileName }));
    }
  } catch (e: any) {
    toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
  }
}

function binaryDownloadSubmenu(detail: DataGridCellDetail | null): ContextMenuItem | null {
  if (!canDownloadDetailBinaryValue(detail)) return null;
  return {
    label: t("grid.downloadBinaryValue"),
    icon: Upload,
    children: BINARY_CELL_DOWNLOAD_MODES.map((mode) => ({
      label: t(`grid.binaryDownload.${mode}`),
      action: () => {
        void downloadDetailBinaryValue(detail, mode);
      },
    })),
  };
}

async function copyDetailSqlCondition() {
  if (!canCopyPreparedDetailSqlCondition()) return;
  copyText(detailSqlConditionCopy.value.text);
}

function copyDialogCellValue() {
  const detail = dialogCellDetail.value;
  if (!detail) return;
  copyText(detail.value === null ? "" : displayCellValue(detail.value));
}

function copyDialogCellFormattedJson() {
  const detail = dialogCellDetail.value;
  if (!detail?.formattedJson) return;
  copyText(detail.formattedJson);
}

function copyDialogCellCurrentValue() {
  if (cellDetailJsonView.value && dialogCellDetail.value?.formattedJson) {
    copyDialogCellFormattedJson();
  } else {
    copyDialogCellValue();
  }
}

function copyDialogCellColumnName() {
  const detail = dialogCellDetail.value;
  if (!detail) return;
  copyText(detail.column);
}

async function openDialogCellInSidePanel() {
  const detail = dialogCellDetail.value;
  if (!detail) return;
  showCellDetails(detail.rowNumber - 1, detail.colIndex);
  cellDetailDialogOpen.value = false;
  await nextTick();
  if (detail.isEditable) startDetailEdit();
}

function copyRowDetailJson() {
  const detail = rowDetail.value;
  if (!detail) return;
  copyText(dataGridRowDetailJson(detail));
}

function copyRowDetailTsv() {
  const detail = rowDetail.value;
  if (!detail) return;
  copyText(dataGridRowDetailTsv(detail));
}

function copyRowDetailFieldValue(field: DataGridCellDetail) {
  copyText(field.value === null ? "" : displayCellValue(field.value));
}

function copyColumnDetailJson() {
  const detail = columnDetail.value;
  if (!detail) return;
  copyText(dataGridColumnDetailJson(detail));
}

function copyColumnDetailTsv() {
  const detail = columnDetail.value;
  if (!detail) return;
  copyText(dataGridColumnDetailTsv(detail));
}

function copyColumnDetailColumnName() {
  const detail = columnDetail.value;
  if (!detail) return;
  copyText(detail.column);
}

function copyColumnDetailFieldValue(field: DataGridCellDetail) {
  copyText(field.value === null ? "" : displayCellValue(field.value));
}

const transposeRecordWidths = ref<number[]>([]);
const transposeManualRecordWidthIndexes = ref(new Set<number>());

function calcTransposeRecordWidth(recordIndex: number): number {
  const item = displayItemAt(recordIndex);
  if (!item) return defaultTransposeRecordWidth(columnWidthDensity.value);
  return calculateTransposeRecordWidth(item.data, columnWidthDensity.value);
}

function getTransposeRecordWidth(recordIndex: number): number {
  return transposeRecordWidths.value[recordIndex] ?? defaultTransposeRecordWidth(columnWidthDensity.value);
}

function ensureTransposeRecordWidths(count: number) {
  if (transposeRecordWidths.value.length === count) return;
  transposeManualRecordWidthIndexes.value = new Set([...transposeManualRecordWidthIndexes.value].filter((index) => index < count));
  transposeRecordWidths.value = transposeRecordWidthsForDensity({
    records: Array.from({ length: count }, (_, index) => displayItemAt(index)?.data ?? []),
    density: columnWidthDensity.value,
    previousWidths: transposeRecordWidths.value,
    manualWidthIndexes: transposeManualRecordWidthIndexes.value,
  });
}

function estimatedTransposeRecordWidth(): number {
  return averageTransposeRecordWidth(transposeRecordWidths.value, columnWidthDensity.value);
}

watch(
  () => displayRowCount.value,
  (count) => ensureTransposeRecordWidths(count),
);
watch(columnWidthDensity, () => {
  // Explicit pixel widths are user overrides; only auto-sized columns follow density changes.
  transposeRecordWidths.value = transposeRecordWidthsForDensity({
    records: Array.from({ length: displayRowCount.value }, (_, index) => displayItemAt(index)?.data ?? []),
    density: columnWidthDensity.value,
    previousWidths: transposeRecordWidths.value,
    manualWidthIndexes: transposeManualRecordWidthIndexes.value,
  });
  nextTick(updateTransposeViewport);
});
const transposePinnedWidthOverride = ref<number | null>(null);
const transposePinnedWidth = computed(() => transposePinnedWidthOverride.value ?? transposeFieldWidth(visibleColumns.value, { density: columnWidthDensity.value }));

const transposeRecordWindow = computed(() =>
  visibleTransposeRecordWindow({
    totalRecords: displayRowCount.value,
    scrollLeft: transposeScrollLeft.value,
    viewportWidth: transposeViewportWidth.value,
    pinnedWidth: transposePinnedWidth.value,
    recordWidth: estimatedTransposeRecordWidth(),
    overscan: 2,
  }),
);
const visibleTransposeRecordIndexes = computed(() => {
  const window = transposeRecordWindow.value;
  return Array.from({ length: window.end - window.start }, (_, offset) => window.start + offset);
});
const activeTransposeRecordIndexes = computed(() =>
  transposeRecordIndexesForMode({
    multiRow: multiRowTranspose.value,
    activeRecordIndex: transposeRowIndex.value,
    totalRecords: displayRowCount.value,
    visibleRecordIndexes: visibleTransposeRecordIndexes.value,
  }),
);
const transposeBeforeSpacerWidth = computed(() => (multiRowTranspose.value ? transposeRecordWindow.value.beforeWidth : 0));
const transposeAfterSpacerWidth = computed(() => (multiRowTranspose.value ? transposeRecordWindow.value.afterWidth : 0));
const transposeRows = computed(() => {
  return buildVisibleTransposeRows({
    columns: visibleColumns.value,
    records: displayRowRefs.value.map((_, index) => displayItemAt(index)?.data ?? []),
    recordIndexes: activeTransposeRecordIndexes.value,
    valueIndexes: visibleColumnIndexes.value,
    typeByColumn: columnTypeMap.value,
    displayValue: (value, _column, index) => formatCellCached(value, visibleColumnIndexes.value[index]),
  });
});
const isTransposeMode = computed(() => showTranspose.value && transposeRows.value.length > 0);
const transposeTotalWidth = computed(() => {
  const recordIndexes = multiRowTranspose.value ? Array.from({ length: displayRowCount.value }, (_, i) => i) : activeTransposeRecordIndexes.value;
  return transposePinnedWidth.value + recordIndexes.reduce((sum, i) => sum + getTransposeRecordWidth(i), 0);
});

function transposeScrollElement(): HTMLElement | undefined {
  const raw = transposeScrollRef.value;
  if (!raw) return undefined;
  return raw instanceof HTMLElement ? raw : raw.$el;
}

function updateTransposeViewport() {
  const el = transposeScrollElement();
  if (!el) return;
  transposeScrollLeft.value = el.scrollLeft;
  transposeViewportWidth.value = el.clientWidth;
}

function onTransposeScroll() {
  updateTransposeViewport();
  const el = transposeScrollElement();
  recordScrollPosition(el ? { top: el.scrollTop, left: el.scrollLeft } : undefined);
  markGridScrolling();
}

function scrollTransposeRecordIntoView(rowIndex: number) {
  nextTick(() => {
    const el = transposeScrollElement();
    if (!el) return;
    el.scrollLeft = transposeScrollLeftForRecord({
      recordIndex: rowIndex,
      totalRecords: displayRowCount.value,
      viewportWidth: el.clientWidth,
      pinnedWidth: transposePinnedWidth.value,
      recordWidth: estimatedTransposeRecordWidth(),
    });
    updateTransposeViewport();
  });
}

function setMultiRowTranspose(value: boolean) {
  multiRowTranspose.value = value;
  if (!showTranspose.value) return;
  nextTick(updateTransposeViewport);
  if (value && transposeRowIndex.value !== null) {
    scrollTransposeRecordIntoView(transposeRowIndex.value);
  } else {
    nextTick(() => {
      const el = transposeScrollElement();
      if (!el) return;
      el.scrollLeft = 0;
      updateTransposeViewport();
    });
  }
}

function toggleMultiRowTranspose() {
  setMultiRowTranspose(!multiRowTranspose.value);
}

function applyTransposeState(next: { showTranspose: boolean; transposeRowIndex: number | null }) {
  showTranspose.value = next.showTranspose;
  transposeRowIndex.value = next.transposeRowIndex;
  if (next.showTranspose) {
    nextTick(updateTransposeViewport);
    if (next.transposeRowIndex !== null) scrollTransposeRecordIntoView(next.transposeRowIndex);
  }
}

function focusAppendedTransposeRecord() {
  if (!showTranspose.value) return;
  nextTick(() => {
    applyTransposeState(nextAppendedTransposeState(true, displayRowCount.value));
  });
}

function onTransposePinnedResizeStart(event: MouseEvent) {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = transposePinnedWidth.value;
  const onMove = (e: MouseEvent) => {
    transposePinnedWidthOverride.value = Math.max(minTransposeFieldWidth(columnWidthDensity.value), startWidth + e.clientX - startX);
    updateTransposeViewport();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onTransposeRecordResizeStart(recordIndex: number, event: MouseEvent) {
  event.preventDefault();
  ensureTransposeRecordWidths(displayRowCount.value);
  const startX = event.clientX;
  const startWidth = getTransposeRecordWidth(recordIndex);
  const onMove = (e: MouseEvent) => {
    const next = [...transposeRecordWidths.value];
    next[recordIndex] = Math.max(minTransposeRecordWidth(columnWidthDensity.value), startWidth + e.clientX - startX);
    transposeRecordWidths.value = next;
    transposeManualRecordWidthIndexes.value = new Set(transposeManualRecordWidthIndexes.value).add(recordIndex);
    updateTransposeViewport();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function autoFitTransposeRecord(recordIndex: number) {
  ensureTransposeRecordWidths(displayRowCount.value);
  const manualIndexes = new Set(transposeManualRecordWidthIndexes.value);
  manualIndexes.delete(recordIndex);
  transposeManualRecordWidthIndexes.value = manualIndexes;
  const next = [...transposeRecordWidths.value];
  next[recordIndex] = calcTransposeRecordWidth(recordIndex);
  transposeRecordWidths.value = next;
}

function currentTransposeViewportRowIndex(): number {
  if (displayRowCount.value === 0) return 0;
  const rowIndex = transposeRowIndex.value ?? transposeRecordWindow.value.start;
  return Math.max(0, Math.min(displayRowCount.value - 1, rowIndex));
}

function closeTranspose(scrollToCurrentRecord = true) {
  const rowIndex = currentTransposeViewportRowIndex();
  showTranspose.value = false;
  transposeRowIndex.value = null;
  if (scrollToCurrentRecord) scrollGridRowIntoView(rowIndex);
}

function openContextTranspose() {
  if (showTranspose.value) {
    closeTranspose();
    return;
  }
  if (!contextCell.value) return;
  const next = nextContextTransposeState({
    showTranspose: showTranspose.value,
    transposeRowIndex: transposeRowIndex.value,
    requestedRowIndex: contextCell.value.rowIndex,
    rowIds: displayRowRefs.value.map((ref) => ref.id),
    selectedRowIds: selectedRowIds.value,
    selectedRange: selectedRange.value,
  });
  transposeRowIndex.value = next.transposeRowIndex;
  showTranspose.value = next.showTranspose;
  if (next.showTranspose) {
    closeCellDetails();
    nextTick(updateTransposeViewport);
    if (next.transposeRowIndex !== null) scrollTransposeRecordIntoView(next.transposeRowIndex);
  }
}

function toggleTranspose(rowIndex: number) {
  const next = nextTransposeState(showTranspose.value, transposeRowIndex.value, rowIndex);
  transposeRowIndex.value = next.transposeRowIndex;
  showTranspose.value = next.showTranspose;
  if (next.showTranspose) {
    closeCellDetails();
    nextTick(updateTransposeViewport);
    if (next.transposeRowIndex !== null) scrollTransposeRecordIntoView(next.transposeRowIndex);
  } else {
    scrollGridRowIntoView(rowIndex);
  }
}

function selectTransposeRecord(rowIndex: number, event?: MouseEvent) {
  if (rowIndex < 0 || rowIndex >= displayRowCount.value) return;
  transposeRowIndex.value = rowIndex;
  contextHeaderColumn.value = null;
  contextHeaderColumnIndex.value = null;
  const item = displayItemAt(rowIndex);
  if (item) {
    if (event) {
      handleRowClick(rowIndex, item.id, event);
    } else {
      selectedRowIds.value = new Set([item.id]);
      selection.lastClickedRowIndex.value = rowIndex;
      selectRow(rowIndex);
    }
    contextCell.value = { rowId: item.id, rowIndex, col: -1 };
    void prefetchCopyStatements();
  }
  gridRef.value?.focus({ preventScroll: true });
}

function transposeRecordIsSelected(rowIndex: number): boolean {
  const item = displayItemAt(rowIndex);
  return !!item && isRowSelected(item.id);
}

function transposeRecordUsesSelectionVisual(rowIndex: number): boolean {
  return hasRowSelection.value && transposeRecordIsSelected(rowIndex);
}

function transposeRecordUsesActiveHighlight(rowIndex: number): boolean {
  return transposeRowIndex.value === rowIndex;
}

function transposeRecordUsesFramedHeader(rowIndex: number): boolean {
  return hasRowSelection.value && transposeRecordIsSelected(rowIndex) && !hasCellSelection.value;
}

function moveTransposeRecordSelection(delta: number): boolean {
  if (!isTransposeMode.value || displayRowCount.value === 0) return false;
  const current = transposeRowIndex.value ?? 0;
  const next = Math.max(0, Math.min(displayRowCount.value - 1, current + delta));
  transposeRowIndex.value = next;
  scrollTransposeRecordIntoView(next);
  return true;
}

function transposeNav(delta: number) {
  moveTransposeRecordSelection(delta);
}

watch(isTransposeMode, (active) => {
  if (active) nextTick(updateTransposeViewport);
});

watch(
  () => props.result,
  () => {
    const shouldPreserveTranspose = preserveTransposeOnNextResult.value;
    preserveTransposeOnNextResult.value = false;
    if (getResetScrollAfterResult()) {
      clearResetScrollAfterResult();
      resetGridVerticalScroll();
    }
    clearCellSelection();
    clearRowSelection();
    closeCellDetails();
    closeDetailDialogs();
    if (shouldPreserveTranspose) {
      applyTransposeState(nextTransposeStateForRecordCount(showTranspose.value, transposeRowIndex.value, displayRowCount.value));
    } else {
      closeTranspose(false);
    }
    exitTransaction();
  },
);

// --- Context menu handlers ---
function onHeaderContext(col: string, columnIndex: number) {
  contextCell.value = null;
  const visibleColIdx = visibleColumnIndexes.value.indexOf(columnIndex);
  if (visibleColIdx >= 0 && !columnIsSelected(visibleColIdx)) {
    selectColumn(visibleColIdx);
  }
  contextHeaderColumn.value = col;
  contextHeaderColumnIndex.value = columnIndex;
}
async function copyHeaderColumn() {
  if (!contextHeaderColumn.value) return;
  await copyText(contextHeaderColumn.value);
}

const canCopyAlterColumnSql = computed(() => {
  if (!contextHeaderColumn.value || !props.tableMeta?.columns) return false;
  if (tableStructureCapabilities.value.alterStrategy !== "direct") return false;
  return props.tableMeta.columns.some((c) => c.name.toLowerCase() === contextHeaderColumn.value!.toLowerCase());
});

async function copyAlterColumnSql() {
  if (!contextHeaderColumn.value) return;
  const colName = contextHeaderColumn.value;
  const columnInfo = props.tableMeta?.columns.find((c) => c.name.toLowerCase() === colName.toLowerCase());
  if (!columnInfo) return;

  const [draft] = createColumnDrafts([columnInfo], props.databaseType);
  draft.original = { ...columnInfo };
  draft.original.data_type = "";
  draft.original.is_nullable = !columnInfo.is_nullable;
  draft.original.column_default = null;
  draft.original.comment = null;
  draft.original.extra = null;

  const options: BuildSingleColumnAlterSqlOptions = {
    databaseType: props.databaseType,
    schema: props.tableMeta?.schema,
    tableName: props.tableMeta!.tableName,
    column: draft,
  };

  const sqlPromise = api.buildSingleColumnAlterSql(options).then((result) => {
    const sql = result.statements.join("\n");
    if (!sql) throw new Error(t("grid.noAlterSqlAvailable"));
    return { sql, warnings: result.warnings };
  });

  try {
    const item = new ClipboardItem({
      "text/plain": sqlPromise.then(({ sql }) => new Blob([sql], { type: "text/plain" })),
    });
    await navigator.clipboard.write([item]);
    const { warnings } = await sqlPromise;
    if (warnings.length > 0) {
      toast(t("grid.alterSqlCopiedWithWarnings", { count: warnings.length }), 3000);
    } else {
      toast(t("grid.alterSqlCopied"), 2000);
    }
  } catch (e: any) {
    toast(t("grid.copyAlterSqlFailed", { message: e?.message || String(e) }), 5000);
  }
}
function clearNativeTextSelection() {
  window.getSelection()?.removeAllRanges();
}

function onCellContext(rowId: number, rowIndex: number, colIdx: number, visibleColIdx: number, event?: MouseEvent) {
  event?.preventDefault();
  clearNativeTextSelection();
  contextHeaderColumn.value = null;
  contextHeaderColumnIndex.value = null;
  contextCell.value = { rowId, rowIndex, col: colIdx };
  if (hasRowSelection.value && isRowSelected(rowId)) {
    void prefetchCopyStatements();
    return;
  }
  clearRowSelection();
  if (!cellIsSelected(rowIndex, visibleColIdx)) {
    selectSingleCell(rowIndex, visibleColIdx);
  }
  void prefetchCopyStatements();
}

function onCellEditTextareaInput(event: Event) {
  resetCellEditTextareaScrollOnResize = false;
  const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement | null;
  if (input instanceof HTMLTextAreaElement) {
    resizeCellEditTextareaElement(input);
    scheduleCellEditTextareaResize(input);
  }
}

function onCellEditTextareaPaste(event: ClipboardEvent) {
  const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement | null;
  if (input instanceof HTMLTextAreaElement) scheduleCellEditTextareaResize(input);
}

function resizeCellEditTextareaElement(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;
  const textareaRect = textarea.getBoundingClientRect();
  const visibleBottom = cellEditVisibleBottom(textarea);
  const availableHeight = Math.max(36, Math.floor(visibleBottom - textareaRect.top - 10));
  const metrics = cellEditTextMetrics(textarea);
  const maxVisibleHeight = Math.ceil(metrics.lineHeight * 9.5 + metrics.verticalChrome);
  const maxHeight = Math.min(maxVisibleHeight, availableHeight);
  const naturalHeight = cellEditNaturalHeight(textarea, metrics);
  const targetMinHeight = Math.max(64, Math.min(naturalHeight, 120));
  const minHeight = Math.min(targetMinHeight, maxHeight);
  textarea.style.setProperty("--cell-edit-min-height", `${minHeight}px`);
  textarea.style.setProperty("--cell-edit-max-height", `${maxHeight}px`);
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight))}px`;
  if (resetCellEditTextareaScrollOnResize) {
    textarea.scrollTop = 0;
    textarea.setSelectionRange?.(0, 0);
  }
}

function cellEditTextMetrics(textarea: HTMLTextAreaElement): { lineHeight: number; verticalChrome: number } {
  const computedStyle = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 18;
  const paddingTop = Number.parseFloat(computedStyle.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(computedStyle.paddingBottom) || 0;
  const borderTop = Number.parseFloat(computedStyle.borderTopWidth) || 0;
  const borderBottom = Number.parseFloat(computedStyle.borderBottomWidth) || 0;
  return { lineHeight, verticalChrome: paddingTop + paddingBottom + borderTop + borderBottom };
}

function cellEditNaturalHeight(textarea: HTMLTextAreaElement, metrics = cellEditTextMetrics(textarea)): number {
  const lines = Math.max(1, textarea.value.split(/\r\n|\r|\n/).length);
  return Math.ceil(lines * metrics.lineHeight + metrics.verticalChrome);
}

function cellEditScrollerElement(textarea: HTMLTextAreaElement): HTMLElement | null {
  return textarea.closest(".data-grid-scroller, .transpose-grid-scroller") as HTMLElement | null;
}

function cellEditVisibleBottom(textarea: HTMLTextAreaElement): number {
  const bottoms: number[] = [];
  const scroller = cellEditScrollerElement(textarea);
  const root = gridRef.value;
  if (scroller) bottoms.push(scroller.getBoundingClientRect().bottom);
  if (root) bottoms.push(root.getBoundingClientRect().bottom);
  if (typeof window !== "undefined") bottoms.push(window.innerHeight);

  if (cellDetailPanelIsBottom.value && showCellDetail.value) {
    const detailPanel = root?.querySelector<HTMLElement>("[data-cell-detail-panel]");
    if (detailPanel) bottoms.push(detailPanel.getBoundingClientRect().top);
  }

  return Math.min(...bottoms.filter((bottom) => Number.isFinite(bottom)));
}

function scheduleCellEditTextareaResize(textarea: HTMLTextAreaElement | null) {
  if (!textarea || typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => {
    resizeCellEditTextareaElement(textarea);
    requestAnimationFrame(() => resizeCellEditTextareaElement(textarea));
  });
}

function resizeActiveCellEditTextarea() {
  const textarea = gridRef.value?.querySelector<HTMLTextAreaElement>(".cell-edit-input--expanded");
  resizeCellEditTextareaElement(textarea ?? null);
}

function disconnectCellEditResizeObserver() {
  cellEditResizeObserver?.disconnect();
  cellEditResizeObserver = null;
}

function observeCellEditResizeBounds() {
  disconnectCellEditResizeObserver();
  if (!editingCell.value || typeof ResizeObserver === "undefined") return;
  const textarea = gridRef.value?.querySelector<HTMLTextAreaElement>(".cell-edit-input--expanded");
  const scroller = textarea ? cellEditScrollerElement(textarea) : null;
  if (!textarea || !scroller) return;
  cellEditResizeObserver = new ResizeObserver(scheduleActiveCellEditTextareaResize);
  cellEditResizeObserver.observe(scroller);
  cellEditResizeObserver.observe(textarea);
  if (gridRef.value) cellEditResizeObserver.observe(gridRef.value);
}

function scheduleActiveCellEditTextareaResize() {
  nextTick(() => {
    resizeActiveCellEditTextarea();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        resizeActiveCellEditTextarea();
        requestAnimationFrame(resizeActiveCellEditTextarea);
      });
    }
  });
}

watch(editingCell, (cell) => {
  resetCellEditTextareaScrollOnResize = !!cell;
  scheduleActiveCellEditTextareaResize();
  if (cell) nextTick(observeCellEditResizeBounds);
  else {
    resetCellEditTextareaScrollOnResize = false;
    expandedCellEditor.value = null;
    disconnectCellEditResizeObserver();
  }
});
watch(editValue, scheduleActiveCellEditTextareaResize);

function onRowContext(rowId: number, rowIndex: number) {
  contextHeaderColumn.value = null;
  contextHeaderColumnIndex.value = null;
  contextCell.value = { rowId, rowIndex, col: -1 };
  if (!isRowSelected(rowId)) {
    clearCellSelection();
    selectedRowIds.value = new Set([rowId]);
    selection.lastClickedRowIndex.value = rowIndex;
  }
  void prefetchCopyStatements();
}

async function prefetchCopyStatements() {
  await prefetchRowAsInsertStatement(false);
  if (isMultiRow.value) {
    await prefetchRowAsInsertStatement(false, "row-by-row");
  }
  if (canCopyRowAsInsertWithoutPrimaryKeys.value) {
    await prefetchRowAsInsertStatement(true);
    if (isMultiRow.value) {
      await prefetchRowAsInsertStatement(true, "row-by-row");
    }
  }
  if (canCopyRowAsUpdate.value) {
    await prefetchRowAsUpdateStatement();
  }
}

const sqlOneLiner = computed(() => props.sql?.replace(/\s+/g, " ").trim() || "");

type TableInfoTabItem = { id: TableInfoTab; label: string; icon: Component; count?: number };

const TABLE_INFO_DRAWER_MIN_WIDTH = 240;
const CELL_DETAIL_PANEL_MIN_HEIGHT = 180;
const CELL_DETAIL_PANEL_MIN_WIDTH = 260;
const CELL_DETAIL_PANEL_MAX_HEIGHT = 520;
const CELL_DETAIL_TABLE_HEADER_HEIGHT = 28;
const CELL_DETAIL_TABLE_MIN_VISIBLE_ROWS = 1.5;
const CELL_DETAIL_TABLE_HORIZONTAL_SCROLLBAR_HEIGHT = 10;
const CELL_DETAIL_TABLE_MIN_VISIBLE_HEIGHT = Math.ceil(CELL_DETAIL_TABLE_HEADER_HEIGHT + CANVAS_DATA_GRID_ROW_HEIGHT * CELL_DETAIL_TABLE_MIN_VISIBLE_ROWS + CELL_DETAIL_TABLE_HORIZONTAL_SCROLLBAR_HEIGHT);
const DRAWER_MAX_WIDTH = 900;
const MONGO_JSON_PREVIEW_DEFAULT_WIDTH = 420;
function clampCellDetailPanelSize(value: number, layout = cellDetailPanelLayout.value): number {
  const min = layout === "bottom" ? CELL_DETAIL_PANEL_MIN_HEIGHT : CELL_DETAIL_PANEL_MIN_WIDTH;
  const max = layout === "bottom" ? CELL_DETAIL_PANEL_MAX_HEIGHT : DRAWER_MAX_WIDTH;
  return Math.min(Math.max(value, min), max);
}
// Table info drawers are tied to a single grid instance. Keeping this state
// module-global leaks the drawer into other kept-alive tabs.
const showTableInfo = ref(false);
const activeTableInfoTab = ref<TableInfoTab>("ddl");
const ddlContent = ref("");
const ddlPreRef = ref<HTMLPreElement | null>(null);
function onDdlKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "a") {
    e.preventDefault();
    const el = ddlPreRef.value;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}
const ddlLoading = ref(false);
const ddlWidth = ref(settingsStore.editorSettings.tableInfoDrawerWidth);
const detailPanelHeight = ref(settingsStore.editorSettings.cellDetailDrawerWidth);
const mongoJsonPreviewWidth = ref(MONGO_JSON_PREVIEW_DEFAULT_WIDTH);
const ddlWrap = ref(true);
const isResizingDdl = ref(false);
const isResizingMongoJsonPreview = ref(false);
let ddlResizeStartX = 0;
let ddlResizeStartWidth = 0;
let detailResizeStartY = 0;
let detailResizeStartHeight = 0;
let mongoJsonPreviewResizeStartX = 0;
let mongoJsonPreviewResizeStartWidth = 0;
const indexes = ref<IndexInfo[]>([]);
const indexesLoaded = ref(false);
const indexesLoading = ref(false);
const indexesError = ref("");
const showDropMongoIndexConfirm = ref(false);
const dropMongoIndexLoading = ref(false);
const pendingDropMongoIndex = ref<IndexInfo | null>(null);
const showDropAllMongoIndexesConfirm = ref(false);
const dropAllMongoIndexesLoading = ref(false);
const foreignKeys = ref<ForeignKeyInfo[]>([]);
const foreignKeysLoaded = ref(false);
const foreignKeysLoading = ref(false);
const foreignKeysError = ref("");
const triggers = ref<TriggerInfo[]>([]);
const triggersLoaded = ref(false);
const triggersLoading = ref(false);
const triggersError = ref("");
const searchQuery = ref("");
const cellDetailPanelLayout = computed(() => settingsStore.editorSettings.cellDetailPanelLayout);
const cellDetailPanelIsBottom = computed(() => cellDetailPanelLayout.value === "bottom");

watch([showCellDetail, showTableInfo], () => {
  if (useCanvasGridRows.value) nextTick(syncCanvasViewport);
});

watch(activeTableInfoTab, () => {
  searchQuery.value = "";
});

watch([activeTableInfoTab, ddlLoading], ([tab, loading]) => {
  if (tab === "ddl" && !loading) {
    void nextTick(() => {
      ddlPreRef.value?.focus();
    });
  }
});

watch(
  () => settingsStore.editorSettings.tableInfoDrawerWidth,
  (width) => {
    if (!isResizingDdl.value) ddlWidth.value = width;
  },
);

watch(
  () => settingsStore.editorSettings.cellDetailDrawerWidth,
  (height) => {
    if (!isResizingDetail.value) detailPanelHeight.value = clampCellDetailPanelSize(height);
    scheduleActiveCellEditTextareaResize();
  },
);

watch(cellDetailPanelLayout, (layout) => {
  if (!isResizingDetail.value) detailPanelHeight.value = clampCellDetailPanelSize(detailPanelHeight.value, layout);
  scheduleActiveCellEditTextareaResize();
});

watch([showCellDetail, activeCellDetail, cellDetailPanelIsBottom, detailPanelHeight], scheduleActiveCellEditTextareaResize);

const ddlDrawerStyle = computed(() => ({
  width: `${ddlWidth.value}px`,
}));

const detailPanelStyle = computed(() =>
  cellDetailPanelIsBottom.value
    ? {
        height: "100%",
      }
    : { width: `${detailPanelHeight.value}px` },
);

const mongoJsonPreviewStyle = computed(() => ({
  width: `${mongoJsonPreviewWidth.value}px`,
}));

const contentGridStyle = computed(() =>
  cellDetailPanelIsBottom.value && showCellDetail.value && activeCellDetail.value
    ? {
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gridTemplateRows: `minmax(${CELL_DETAIL_TABLE_MIN_VISIBLE_HEIGHT}px, 1fr) minmax(0, min(${detailPanelHeight.value}px, 70vh, ${CELL_DETAIL_PANEL_MAX_HEIGHT}px, calc(100% - ${CELL_DETAIL_TABLE_MIN_VISIBLE_HEIGHT}px)))`,
      }
    : {
        gridTemplateColumns: "minmax(0, 1fr) auto auto",
        gridTemplateRows: "minmax(0, 1fr)",
      },
);

function toggleCellDetailPanelLayout() {
  const nextLayout = cellDetailPanelIsBottom.value ? "right" : "bottom";
  const nextSize = clampCellDetailPanelSize(detailPanelHeight.value, nextLayout);
  detailPanelHeight.value = nextSize;
  settingsStore.updateEditorSettings({
    ...(nextLayout === "right" ? { cellDetailDrawerWidth: nextSize } : {}),
    cellDetailPanelLayout: nextLayout,
  });
}

const tableMetadataCapabilities = computed(() => getTableMetadataCapabilities(props.databaseType));
const canOpenTableStructureEditor = computed(() => !!props.connectionId && !!props.database && !!props.tableMeta?.tableName && supportsTableStructureEditing(resolvedDatabaseType.value));
const mongoConnectionConfig = resolvedConnectionConfig;
const canManageMongoIndexes = computed(() => resolvedDatabaseType.value === "mongodb" && !!props.connectionId && !!props.database && !!props.tableMeta?.tableName && mongoConnectionConfig.value?.db_type === "mongodb" && mongoConnectionConfig.value?.driver_profile !== "mongodb-legacy");
const tableInfoTabs = computed(() => {
  const tabs: TableInfoTabItem[] = [];
  if (tableMetadataCapabilities.value.ddl) {
    tabs.push({ id: "ddl", label: "DDL", icon: Code2 });
  }
  if (tableMetadataCapabilities.value.columns) {
    tabs.push({
      id: "columns",
      label: t("grid.tableInfoColumns"),
      icon: ListTree,
      count: props.tableMeta?.columns.length,
    });
  }
  if (tableMetadataCapabilities.value.indexes) {
    tabs.push({ id: "indexes", label: t("grid.tableInfoIndexes"), icon: KeyRound, count: indexes.value.length });
  }
  if (tableMetadataCapabilities.value.foreignKeys) {
    tabs.push({
      id: "foreignKeys",
      label: t("grid.tableInfoForeignKeys"),
      icon: Link2,
      count: foreignKeys.value.length,
    });
  }
  if (tableMetadataCapabilities.value.triggers) {
    tabs.push({ id: "triggers", label: t("grid.tableInfoTriggers"), icon: RotateCcw, count: triggers.value.length });
  }
  return tabs;
});
const tableInfoTabListStyle = computed(() => ({
  gridTemplateColumns: `repeat(${tableInfoTabs.value.length}, minmax(0, 1fr))`,
}));

async function toggleTableInfo(tab: TableInfoTab = activeTableInfoTab.value) {
  if (showTableInfo.value && activeTableInfoTab.value === tab) {
    showTableInfo.value = false;
    return;
  }
  showTableInfo.value = true;
  await selectTableInfoTab(tab);
}

async function selectTableInfoTab(tab: TableInfoTab) {
  const nextTab = tableInfoTabs.value.some((item) => item.id === tab) ? tab : tableInfoTabs.value[0]?.id;
  if (!nextTab) return;
  activeTableInfoTab.value = nextTab;
  if (nextTab === "ddl") await fetchDdl();
  else if (nextTab === "indexes") await fetchIndexes();
  else if (nextTab === "foreignKeys") await fetchForeignKeys();
  else if (nextTab === "triggers") await fetchTriggers();
}

watch(
  () => [props.tableInfoTab, props.connectionId, props.database, props.tableMeta?.catalog, props.tableMeta?.schema, props.tableMeta?.tableName] as const,
  ([tab]) => {
    if (tab) void selectTableInfoTab(tab);
  },
  { immediate: true },
);

async function fetchDdl() {
  if (!props.connectionId || !props.tableMeta) return;
  showTableInfo.value = true;
  ddlLoading.value = true;
  try {
    ddlContent.value = await api.getTableDdl(props.connectionId, props.database || "", props.tableMeta.schema || props.database || "", props.tableMeta.tableName, undefined, props.tableMeta.catalog);
  } catch (e: any) {
    ddlContent.value = `-- Error: ${e}`;
  } finally {
    ddlLoading.value = false;
  }
}

async function fetchIndexes() {
  if (!props.connectionId || !props.tableMeta || indexesLoaded.value || indexesLoading.value) return;
  indexesLoading.value = true;
  indexesError.value = "";
  try {
    indexes.value = await api.listIndexes(props.connectionId, props.database || "", props.tableMeta.schema || props.database || "", props.tableMeta.tableName, props.tableMeta.catalog);
    indexesLoaded.value = true;
  } catch (e: any) {
    indexesError.value = String(e?.message || e);
  } finally {
    indexesLoading.value = false;
  }
}

async function reloadIndexes() {
  indexesLoaded.value = false;
  await fetchIndexes();
}

async function fetchForeignKeys() {
  if (!props.connectionId || !props.tableMeta || foreignKeysLoaded.value || foreignKeysLoading.value) return;
  foreignKeysLoading.value = true;
  foreignKeysError.value = "";
  try {
    foreignKeys.value = await api.listForeignKeys(props.connectionId, props.database || "", props.tableMeta.schema || props.database || "", props.tableMeta.tableName, props.tableMeta.catalog);
    foreignKeysLoaded.value = true;
  } catch (e: any) {
    foreignKeysError.value = String(e?.message || e);
  } finally {
    foreignKeysLoading.value = false;
  }
}

async function fetchTriggers() {
  if (!props.connectionId || !props.tableMeta || triggersLoaded.value || triggersLoading.value) return;
  triggersLoading.value = true;
  triggersError.value = "";
  try {
    triggers.value = await api.listTriggers(props.connectionId, props.database || "", props.tableMeta.schema || props.database || "", props.tableMeta.tableName, props.tableMeta.catalog);
    triggersLoaded.value = true;
  } catch (e: any) {
    triggersError.value = String(e?.message || e);
  } finally {
    triggersLoading.value = false;
  }
}

watch(
  () => [props.connectionId, props.database, props.tableMeta?.catalog, props.tableMeta?.schema, props.tableMeta?.tableName],
  () => {
    ddlContent.value = "";
    indexes.value = [];
    indexesLoaded.value = false;
    indexesError.value = "";
    foreignKeys.value = [];
    foreignKeysLoaded.value = false;
    foreignKeysError.value = "";
    triggers.value = [];
    triggersLoaded.value = false;
    triggersError.value = "";
    if (showTableInfo.value) selectTableInfoTab(activeTableInfoTab.value);
  },
);

if (showTableInfo.value && props.tableMeta && props.connectionId) {
  selectTableInfoTab(activeTableInfoTab.value);
}

function copyDdl() {
  copyText(ddlContent.value);
}

function openTableStructureEditor() {
  if (!props.connectionId || !props.database || !props.tableMeta?.tableName || !canOpenTableStructureEditor.value) return;
  queryStore.openTableStructure(props.connectionId, props.database, props.tableMeta.schema, props.tableMeta.tableName, activeTableInfoTab.value);
}

function toggleDdlWrap() {
  ddlWrap.value = !ddlWrap.value;
}

function searchSplitContainerWidth(): number {
  return searchSplitContainerRef.value?.getBoundingClientRect().width ?? 0;
}

function onSearchSplitResizeStart(event: MouseEvent) {
  const containerWidth = searchSplitContainerWidth();
  if (containerWidth <= 0) return;
  event.preventDefault();
  isResizingSearchSplit.value = true;
  searchSplitStartX = event.clientX;
  searchSplitStartWidth = clampSearchSplitWidth({
    containerWidth,
    desiredWidth: searchSplitWhereWidth.value ?? undefined,
  });
  searchSplitWhereWidth.value = searchSplitStartWidth;
  document.body.classList.add("select-none", "cursor-col-resize");
  window.addEventListener("mousemove", onSearchSplitResizeMove);
  window.addEventListener("mouseup", onSearchSplitResizeEnd);
}

function onSearchSplitResizeMove(event: MouseEvent) {
  if (!isResizingSearchSplit.value) return;
  const containerWidth = searchSplitContainerWidth();
  if (containerWidth <= 0) return;
  searchSplitWhereWidth.value = clampSearchSplitWidth({
    containerWidth,
    desiredWidth: searchSplitStartWidth + event.clientX - searchSplitStartX,
  });
  resizeFocusedConditionInputs();
}

function onSearchSplitResizeEnd() {
  isResizingSearchSplit.value = false;
  document.body.classList.remove("select-none", "cursor-col-resize");
  window.removeEventListener("mousemove", onSearchSplitResizeMove);
  window.removeEventListener("mouseup", onSearchSplitResizeEnd);
}

function resetSearchSplitWidth() {
  const containerWidth = searchSplitContainerWidth();
  searchSplitWhereWidth.value = containerWidth > 0 ? clampSearchSplitWidth({ containerWidth }) : null;
  resizeFocusedConditionInputs();
}

function onDataGridTopbarFixedActionWheel(event: WheelEvent) {
  if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
  event.preventDefault();
  event.stopPropagation();
}

function onConditionInputWheel(event: WheelEvent) {
  const input = event.currentTarget instanceof HTMLTextAreaElement ? event.currentTarget : null;
  if (!input || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
  input.scrollLeft += event.deltaX;
  event.preventDefault();
  event.stopPropagation();
}

function onDdlResizeStart(event: MouseEvent) {
  isResizingDdl.value = true;
  ddlResizeStartX = event.clientX;
  ddlResizeStartWidth = ddlWidth.value;
  document.body.classList.add("select-none", "cursor-col-resize");
  window.addEventListener("mousemove", onDdlResizeMove);
  window.addEventListener("mouseup", onDdlResizeEnd);
}

function onDdlResizeMove(event: MouseEvent) {
  if (!isResizingDdl.value) return;
  const nextWidth = ddlResizeStartWidth + ddlResizeStartX - event.clientX;
  ddlWidth.value = Math.min(Math.max(nextWidth, TABLE_INFO_DRAWER_MIN_WIDTH), DRAWER_MAX_WIDTH);
}

function onDdlResizeEnd() {
  if (isResizingDdl.value) {
    settingsStore.updateEditorSettings({ tableInfoDrawerWidth: ddlWidth.value });
  }
  isResizingDdl.value = false;
  document.body.classList.remove("select-none", "cursor-col-resize");
  window.removeEventListener("mousemove", onDdlResizeMove);
  window.removeEventListener("mouseup", onDdlResizeEnd);
}

function onDetailResizeStart(event: MouseEvent) {
  isResizingDetail.value = true;
  // 底部布局拖顶部边缘(垂直/clientY),右侧布局拖左边缘(水平/clientX)
  detailResizeStartY = cellDetailPanelIsBottom.value ? event.clientY : event.clientX;
  detailResizeStartHeight = detailPanelHeight.value;
  document.body.classList.add("select-none", cellDetailPanelIsBottom.value ? "cursor-row-resize" : "cursor-col-resize");
  window.addEventListener("mousemove", onDetailResizeMove);
  window.addEventListener("mouseup", onDetailResizeEnd);
}

function onDetailResizeMove(event: MouseEvent) {
  if (!isResizingDetail.value) return;
  const pos = cellDetailPanelIsBottom.value ? event.clientY : event.clientX;
  const nextSize = detailResizeStartHeight + detailResizeStartY - pos;
  detailPanelHeight.value = clampCellDetailPanelSize(nextSize);
}

function onDetailResizeEnd() {
  if (isResizingDetail.value) {
    settingsStore.updateEditorSettings({ cellDetailDrawerWidth: detailPanelHeight.value });
  }
  isResizingDetail.value = false;
  document.body.classList.remove("select-none", "cursor-row-resize", "cursor-col-resize");
  window.removeEventListener("mousemove", onDetailResizeMove);
  window.removeEventListener("mouseup", onDetailResizeEnd);
}

function onMongoJsonPreviewResizeStart(event: MouseEvent) {
  isResizingMongoJsonPreview.value = true;
  mongoJsonPreviewResizeStartX = event.clientX;
  mongoJsonPreviewResizeStartWidth = mongoJsonPreviewWidth.value;
  document.body.classList.add("select-none", "cursor-col-resize");
  window.addEventListener("mousemove", onMongoJsonPreviewResizeMove);
  window.addEventListener("mouseup", onMongoJsonPreviewResizeEnd);
}

function onMongoJsonPreviewResizeMove(event: MouseEvent) {
  if (!isResizingMongoJsonPreview.value) return;
  mongoJsonPreviewWidth.value = clampCellDetailPanelSize(mongoJsonPreviewResizeStartWidth + mongoJsonPreviewResizeStartX - event.clientX, "right");
}

function onMongoJsonPreviewResizeEnd() {
  isResizingMongoJsonPreview.value = false;
  document.body.classList.remove("select-none", "cursor-col-resize");
  window.removeEventListener("mousemove", onMongoJsonPreviewResizeMove);
  window.removeEventListener("mouseup", onMongoJsonPreviewResizeEnd);
}

const loadingElapsed = ref(0);
let _loadingFrame: number | undefined;
let _loadingStart = 0;

function stopLoadingElapsedTimer() {
  if (_loadingFrame !== undefined) {
    window.cancelAnimationFrame(_loadingFrame);
    _loadingFrame = undefined;
  }
}

function startLoadingElapsedTimer() {
  stopLoadingElapsedTimer();
  if (!dataGridIsActive || !props.loading) return;
  _loadingStart = Date.now();
  loadingElapsed.value = 0;
  const updateOnNextFrame = () => {
    if (!dataGridIsActive || !props.loading) return;
    loadingElapsed.value = Date.now() - _loadingStart;
    _loadingFrame = window.requestAnimationFrame(updateOnNextFrame);
  };
  _loadingFrame = window.requestAnimationFrame(updateOnNextFrame);
}

watch(
  () => props.loading,
  (isLoading) => {
    stopLoadingElapsedTimer();
    if (isDebugLoggingEnabled()) {
      logDataGridTiming(isLoading ? "[DBX][DataGrid:loading:start]" : "[DBX][DataGrid:loading:stop]", {
        traceId: dataGridTraceId,
        cacheKey: props.cacheKey,
        elapsedSinceSetup: dataGridElapsed(),
      });
    }
    if (isLoading) {
      startLoadingElapsedTimer();
    } else {
      if (isDebugLoggingEnabled()) {
        nextTick(() => {
          requestAnimationFrame(() => {
            logDataGridTiming("[DBX][DataGrid:loading:stop:first-frame]", {
              traceId: dataGridTraceId,
              cacheKey: props.cacheKey,
              elapsedSinceSetup: dataGridElapsed(),
            });
          });
        });
      }
    }
  },
);

onActivated(() => {
  startLoadingElapsedTimer();
  restartAutoRefreshTimer();
});
onDeactivated(() => {
  stopLoadingElapsedTimer();
  stopAutoRefreshTimer();
});

onUnmounted(() => {
  cleanupFrames();
  stopAutoRefreshTimer();
  cancelColumnHeaderDragPreview();
  clearColumnHeaderResizeListeners();
  clearColumnHeaderClickGuard();
  columnHeaderResizeActive.value = false;
  onSearchSplitResizeEnd();
  onDdlResizeEnd();
  onDetailResizeEnd();
  onMongoJsonPreviewResizeEnd();
  finishCellSelection();
  clearTimeout(highlightedColumnTimer);
  clearTimeout(_searchTimer);
  if (serverFilterSearchTimer !== undefined) {
    window.clearTimeout(serverFilterSearchTimer);
  }
  stopLoadingElapsedTimer();
});

const filteredColumns = computed(() => {
  if (!searchQuery.value) return props.tableMeta?.columns ?? [];
  const q = searchQuery.value.toLowerCase();
  return (props.tableMeta?.columns ?? []).filter((c) => c.name.toLowerCase().includes(q) || c.data_type.toLowerCase().includes(q));
});

const filteredIndexes = computed(() => {
  if (!searchQuery.value) return indexes.value;
  const q = searchQuery.value.toLowerCase();
  return indexes.value.filter((i) => i.name.toLowerCase().includes(q) || i.columns.some((c) => c.toLowerCase().includes(q)));
});

const droppableMongoIndexes = computed(() => indexes.value.filter((index) => !index.is_primary));
const dropMongoIndexConfirmMessage = computed(() =>
  pendingDropMongoIndex.value
    ? t("contextMenu.confirmDropMongoIndexMessage", {
        name: pendingDropMongoIndex.value.name,
        collection: props.tableMeta?.tableName || "",
      })
    : "",
);
const dropAllMongoIndexesConfirmMessage = computed(() => t("contextMenu.confirmDropMongoAllIndexesMessage", { name: props.tableMeta?.tableName || "" }));
const dropAllMongoIndexesConfirmDetails = computed(() => t("contextMenu.confirmDropMongoAllIndexesDetails"));
const dropMongoIndexPreview = computed(() => (pendingDropMongoIndex.value ? `db.getCollection(${JSON.stringify(props.tableMeta?.tableName || "")}).dropIndex(${JSON.stringify(pendingDropMongoIndex.value.name)})` : ""));
const dropAllMongoIndexesPreview = computed(() => `db.getCollection(${JSON.stringify(props.tableMeta?.tableName || "")}).dropIndexes()`);

function requestDropMongoIndex(index: IndexInfo) {
  pendingDropMongoIndex.value = index;
  showDropMongoIndexConfirm.value = true;
}

function requestDropAllMongoIndexes() {
  showDropAllMongoIndexesConfirm.value = true;
}

async function confirmDropMongoIndex() {
  if (!props.connectionId || !props.database || !props.tableMeta?.tableName || !pendingDropMongoIndex.value || dropMongoIndexLoading.value) return;
  dropMongoIndexLoading.value = true;
  try {
    await connectionStore.ensureConnected(props.connectionId);
    await api.mongoDropIndexes(props.connectionId, props.database, props.tableMeta.tableName, JSON.stringify(pendingDropMongoIndex.value.name), true);
    toast(t("contextMenu.dropTableChildObjectSuccess", { name: pendingDropMongoIndex.value.name }), 3000);
    showDropMongoIndexConfirm.value = false;
    pendingDropMongoIndex.value = null;
    await reloadIndexes();
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    dropMongoIndexLoading.value = false;
  }
}

async function confirmDropAllMongoIndexes() {
  if (!props.connectionId || !props.database || !props.tableMeta?.tableName || dropAllMongoIndexesLoading.value) return;
  dropAllMongoIndexesLoading.value = true;
  try {
    await connectionStore.ensureConnected(props.connectionId);
    const result = await api.mongoDropIndexes(props.connectionId, props.database, props.tableMeta.tableName, undefined, false);
    toast(t("contextMenu.dropAllIndexesSuccess", { count: result.dropped_names.length, name: props.tableMeta.tableName }), 3000);
    showDropAllMongoIndexesConfirm.value = false;
    await reloadIndexes();
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    dropAllMongoIndexesLoading.value = false;
  }
}

const filteredForeignKeys = computed(() => {
  if (!searchQuery.value) return foreignKeys.value;
  const q = searchQuery.value.toLowerCase();
  return foreignKeys.value.filter((fk) => fk.name.toLowerCase().includes(q) || fk.column.toLowerCase().includes(q) || fk.ref_table.toLowerCase().includes(q) || fk.ref_column.toLowerCase().includes(q));
});

const filteredTriggers = computed(() => {
  if (!searchQuery.value) return triggers.value;
  const q = searchQuery.value.toLowerCase();
  return triggers.value.filter((t) => t.name.toLowerCase().includes(q));
});

const filteredDdlContent = computed(() => {
  if (!ddlContent.value) return "";
  const html = highlight(ddlContent.value);
  if (!searchQuery.value) return html;

  const escaped = searchQuery.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  // Match only text between > and < (text nodes), then replace the search term within those spans
  return html.replace(/>([^<]*)</g, (_, text) => {
    return `>${text.replace(regex, "<mark>$1</mark>")}<`;
  });
});

defineExpose({
  useTransaction,
  transactionActive,
  isSaving,
  onToolbarRefresh,
  onToolbarCommit,
  onToolbarRollback,
  showDdl: showTableInfo,
  toggleDdl: toggleTableInfo,
  showTableInfo,
  toggleTableInfo,
  multiRowTranspose,
  setMultiRowTranspose,
  toggleMultiRowTranspose,
  focusSearch,
  visibleColumnCount,
  displayableColumnCount,
  hiddenColumnCount,
  filteredColumnVisibilityOptions,
  isColumnVisible,
  toggleColumnVisibility,
  showAllColumns,
  invertColumnVisibility,
  hasCustomColumnOrder,
  resetColumnOrder,
  nullColumnsHidden,
  allNullColumnCount,
  canToggleAllNullColumns,
  toggleAllNullColumns,
  openCellDetailSearch,
  exportCsv,
  exportJson,
  exportSql,
  exportXlsx,
});

// ---- CustomContextMenu ----

function rowActionLabels() {
  return {
    clone: isMultiRow.value ? t("grid.cloneRows", { count: multiRowCount.value }) : t("grid.cloneRow"),
    restore: isMultiRow.value ? t("grid.restoreRows", { count: multiRowCount.value }) : t("grid.restoreRow"),
    delete: isMultiRow.value ? t("grid.deleteRows", { count: multiRowCount.value }) : t("grid.deleteRow"),
  };
}

function copyRowLabels() {
  const count = multiRowCount.value;
  return {
    row: isMultiRow.value ? t("grid.copyRows", { count }) : t("grid.copyRow"),
    insert: isMultiRow.value ? t("grid.copyRowsInsert", { count }) : t("grid.copyRowInsert"),
    insertMerged: t("grid.copyRowsInsertMerged", { count }),
    insertRowByRow: t("grid.copyRowsInsertRowByRow", { count }),
    insertNoPk: isMultiRow.value ? t("grid.copyRowsInsertWithoutPrimaryKeys", { count }) : t("grid.copyRowInsertWithoutPrimaryKeys"),
    insertNoPkMerged: t("grid.copyRowsInsertWithoutPrimaryKeysMerged", { count }),
    insertNoPkRowByRow: t("grid.copyRowsInsertWithoutPrimaryKeysRowByRow", { count }),
    update: isMultiRow.value ? t("grid.copyRowsUpdate", { count }) : t("grid.copyRowUpdate"),
  };
}

function filterSubmenu(): ContextMenuItem {
  return {
    label: t("grid.filter"),
    icon: Filter,
    children: [
      { label: t("grid.filterByValue"), action: () => applyContextFilter("equals") },
      { label: t("grid.filterExcludeValue"), action: () => applyContextFilter("not-equals") },
      { label: t("grid.filterLike"), action: () => applyContextFilter("like") },
      { label: t("grid.filterNotLike"), action: () => applyContextFilter("not-like") },
      { label: t("grid.filterLessThan"), action: () => applyContextFilter("less-than") },
      { label: t("grid.filterGreaterThan"), action: () => applyContextFilter("greater-than") },
      { label: "", separator: true },
      { label: t("grid.filterIsNull"), action: () => applyContextFilter("is-null") },
      { label: t("grid.filterIsNotNull"), action: () => applyContextFilter("is-not-null") },
      { label: "", separator: true },
      { label: t("grid.clearFilter"), action: clearContextFilter },
    ],
  };
}

function copySubmenu(): ContextMenuItem {
  const labels = copyRowLabels();
  const items: ContextMenuItem[] = [];
  if (contextColumn.value) {
    items.push({ label: t("grid.copyCell"), action: copyCell });
  }
  items.push({ label: labels.row, action: copyRow });
  if (hasRowSelection.value && selectedRowCount.value > 0) {
    const singleRowSelected = selectedRowCount.value === 1;
    items.push({ label: singleRowSelected ? t("grid.copySelectedRowTsv") : t("grid.copySelectedRowsTsv", { count: selectedRowCount.value }), action: copySelectedRowsTsv });
    items.push({ label: singleRowSelected ? t("grid.copySelectedRowTsvWithHeaders") : t("grid.copySelectedRowsTsvWithHeaders", { count: selectedRowCount.value }), action: copySelectedRowsTsvWithHeaders });
  }
  if (isMultiRow.value) {
    items.push({ label: labels.insertMerged, action: () => copyRowAsInsert("merged"), disabled: !canCopyRowAsInsert.value });
    items.push({ label: labels.insertRowByRow, action: () => copyRowAsInsert("row-by-row"), disabled: !canCopyRowAsInsert.value });
  } else {
    items.push({ label: labels.insert, action: () => copyRowAsInsert(), disabled: !canCopyRowAsInsert.value });
  }
  if (canCopyRowAsInsertWithoutPrimaryKeys.value) {
    if (isMultiRow.value) {
      items.push({
        label: labels.insertNoPkMerged,
        action: () => copyRowAsInsertWithoutPrimaryKeys("merged"),
      });
      items.push({
        label: labels.insertNoPkRowByRow,
        action: () => copyRowAsInsertWithoutPrimaryKeys("row-by-row"),
      });
    } else {
      items.push({
        label: labels.insertNoPk,
        action: () => copyRowAsInsertWithoutPrimaryKeys(),
      });
    }
  }
  if (canCopyRowAsUpdate.value) {
    items.push({ label: labels.update, action: copyRowAsUpdate });
  }
  items.push({ label: t("grid.copyAll"), action: copyAll });
  items.push({ label: t("grid.copyColumnNames"), action: copyColumnNames });
  return { label: t("grid.copy"), icon: Copy, children: items };
}

function selectionSubmenu(): ContextMenuItem {
  return {
    label: t("grid.selection"),
    icon: SquareDashed,
    children: [
      { label: t("grid.copySelectionTsv"), action: copySelectionTsv },
      { label: t("grid.copySelectionTsvWithHeaders"), action: copySelectionTsvWithHeaders },
      { label: t("grid.copySelectionCsv"), action: copySelectionCsv },
      { label: t("grid.copySelectionJson"), action: copySelectionJson },
      { label: t("grid.copySelectionSql"), action: copySelectionSqlInList },
      { label: "", separator: true },
      { label: t("grid.clearSelection"), action: clearCellSelection },
    ],
  };
}

function exportSubmenu(): ContextMenuItem {
  const items: ContextMenuItem[] = [
    { label: t("grid.exportCsv"), action: exportCsv },
    { label: t("grid.exportXlsx"), action: exportXlsx },
    { label: t("grid.exportJson"), action: exportJson },
    { label: t("grid.exportMarkdown"), action: exportMarkdown },
    { label: t("grid.exportSql"), action: exportSql },
  ];
  if (isMultiRow.value) {
    items.push(
      { label: "", separator: true },
      { label: t("grid.exportSelectedRowsCsv"), action: exportSelectedRowsCsv },
      { label: t("grid.exportSelectedRowsXlsx"), action: exportSelectedRowsXlsx },
      { label: t("grid.exportSelectedRowsJson"), action: exportSelectedRowsJson },
      { label: t("grid.exportSelectedRowsMarkdown"), action: exportSelectedRowsMarkdown },
      { label: t("grid.exportSelectedRowsSql"), action: exportSelectedRowsSql },
    );
  }
  return { label: t("grid.export"), icon: Upload, children: items };
}

const gridContextMenuItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = [];

  // 1. Copy column name
  if (contextHeaderColumn.value) {
    items.push({ label: t("grid.copyColumnName"), action: copyHeaderColumn, icon: Copy });
    items.push({ label: t("grid.copyColumnNames"), action: copyColumnNames, icon: Copy });
    items.push({
      label: t("grid.openColumnDetailsDialog"),
      action: openContextColumnDetailDialog,
      icon: TableProperties,
    });
    if (canCopyAlterColumnSql.value) {
      items.push({ label: t("grid.copyAlterColumnSql"), action: copyAlterColumnSql, icon: Copy });
    }
  }

  // 2. Column sort & filter
  if (contextColumn.value) {
    items.push(
      { label: t("grid.sortDatabaseAscending"), action: () => applyContextSort("asc", "database"), icon: Database },
      { label: t("grid.sortDatabaseDescending"), action: () => applyContextSort("desc", "database"), icon: Database },
      { label: "", separator: true },
      { label: t("grid.sortCurrentPageAscending"), action: () => applyContextSort("asc", "local"), icon: ArrowUp },
      { label: t("grid.sortCurrentPageDescending"), action: () => applyContextSort("desc", "local"), icon: ArrowDown },
    );
    if (sortCol.value) {
      items.push({ label: t("grid.clearSort"), action: () => applyContextSort(null, sortMode.value), icon: ArrowUpDown });
    }
    if (canUseWhereSearch.value) {
      items.push({ label: "", separator: true });
      items.push(filterSubmenu());
    }
    items.push({ label: "", separator: true });
  }

  // 3. Detail dialogs
  if (contextCell.value) {
    if (contextColumn.value) {
      items.push({ label: t("grid.openCellDetailsDialog"), action: openContextCellDetailDialog, icon: Maximize2 });
      const downloadItem = binaryDownloadSubmenu(contextCellDetail.value);
      if (downloadItem) items.push(downloadItem);
      items.push({
        label: t("grid.openColumnDetailsDialog"),
        action: openContextColumnDetailDialog,
        icon: TableProperties,
      });
    }
    items.push({ label: t("grid.openRowDetailsDialog"), action: openContextRowDetailDialog, icon: ListTree });
    items.push({ label: "", separator: true });
  }

  // 4. Copy submenu
  if (!contextHeaderColumn.value) {
    items.push(copySubmenu());
  }

  if (props.editable && hasCellSelection.value) {
    items.push({
      label: t("grid.bulkEditSelection"),
      action: openBulkEditDialog,
      disabled: !selectionHasEditableCells(),
      icon: Pencil,
    });
  }

  // 5. Transpose
  if (contextCell.value) {
    items.push({ label: t("grid.transpose"), action: openContextTranspose, icon: Rows3 });
  }

  // 6. Selection submenu
  if (hasCellSelection.value) {
    items.push(selectionSubmenu());
  }

  // 7. Row actions
  if (props.editable && contextRowItem.value) {
    const labels = rowActionLabels();
    items.push({ label: "", separator: true });
    if (canInsertRows.value && !contextRowItem.value.isDraft) {
      items.push({
        label: labels.clone,
        action: () => (isMultiRow.value ? cloneRows(affectedRowIds()) : cloneRow(contextRowItem.value!.id)),
        icon: CopyPlus,
      });
    }
    if (contextRowItem.value.isDeleted) {
      items.push({
        label: labels.restore,
        action: () => (isMultiRow.value ? restoreRows(affectedRowIds()) : restoreRow(contextRowItem.value!.id)),
        icon: Undo2,
      });
    } else if (canDeleteRowItem(contextRowItem.value)) {
      items.push({
        label: labels.delete,
        action: () => (isMultiRow.value ? requestDeleteRows(deletableRowIds(affectedRowIds())) : requestDeleteRow(contextRowItem.value!.id)),
        icon: Trash2,
        variant: "destructive" as const,
      });
    }
    items.push({ label: "", separator: true });
  }

  // 8. Export submenu
  items.push(exportSubmenu());

  // 9. Preview actions from registry (e.g. geometry map preview)
  if (!contextHeaderColumn.value && contextCell.value) {
    const colType = props.result.column_types?.[contextCell.value.col];
    if (colType && isGeometryColumnType(colType)) {
      const actions = previewActions.value;
      if (actions.length > 0) {
        items.push({ label: "", separator: true });
        for (const action of actions) {
          items.push({
            label: t("grid.layerPreview"),
            action: () => executePreviewAction(action),
            icon: action.icon,
          });
        }
      }
    }
  }

  return items;
});
</script>

<template>
  <div ref="gridRef" data-grid-root class="h-full flex flex-col overflow-hidden outline-none" :class="{ 'data-grid--editing-cell': !!editingCell, 'data-grid--dark': isDark }" :style="gridStyle" tabindex="0" @keydown="onGridKeydown" @paste="onGridPaste">
    <CustomContextMenu :items="gridContextMenuItems" v-slot="{ onContextMenu }">
      <div v-if="hasData || canShowWhereSearch" class="flex-1 flex flex-col overflow-hidden" @contextmenu="onContextMenu">
        <!-- Search bar -->
        <div ref="dataGridTopbarRef" v-if="showDataGridTopbar" class="data-grid-topbar-shell shrink-0 flex min-w-0 border-b bg-muted/20">
          <div v-if="hasResultToolbarLeadingSlot" class="flex shrink-0 items-center border-r">
            <slot name="result-toolbar-leading" :compact="compactDataGridToolbar" />
          </div>
          <div
            class="data-grid-topbar-scroll min-w-0 flex-1 overflow-x-hidden"
            @scroll="
              updateWhereSuggestionPosition();
              updateOrderBySuggestionPosition();
            "
          >
            <div class="data-grid-topbar flex items-stretch relative" :class="{ 'data-grid-topbar--compact': compactDataGridToolbar }">
              <div v-if="useTransaction && editable && hasDataGridSaveTarget" class="flex items-center px-2 py-0.5 border-r shrink-0">
                <Select :model-value="rowStatusFilter" @update:model-value="(value: any) => setRowStatusFilter(String(value))">
                  <SelectTrigger class="h-5 max-w-28 border-0 bg-transparent px-0 py-0 text-xs font-medium text-foreground/70 shadow-none focus-visible:ring-0 data-[state=open]:text-foreground [&_svg]:size-3">
                    <SelectValue :placeholder="t('grid.filterRows')" />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="all">{{ t("grid.filterAllRows") }}</SelectItem>
                    <SelectItem value="changed">{{ t("grid.filterChangedRows") }}</SelectItem>
                    <SelectItem value="edited">{{ t("grid.statusEdited") }}</SelectItem>
                    <SelectItem value="new">{{ t("grid.statusNew") }}</SelectItem>
                    <SelectItem value="deleted">{{ t("grid.statusDeleted") }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <template v-if="hasLocalColumnFilters && !canShowWhereSearch && !hasSearchBarSlot">
                <div class="flex items-center gap-1 px-2 py-0.5 min-w-0">
                  <button type="button" class="flex shrink-0 items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/15" :title="t('grid.clearLocalFilters')" @click="clearLocalFilter()">
                    <Filter class="h-3 w-3" />
                    {{ localFilterCount }}
                    <X class="h-3 w-3" />
                  </button>
                </div>
              </template>
              <template v-if="canShowWhereSearch">
                <div ref="searchSplitContainerRef" class="flex flex-1 min-w-0">
                  <div ref="whereConditionPaneRef" class="flex flex-1 items-center gap-1 px-2 py-0.5 min-w-0 relative" :class="{ 'border-l': useTransaction && editable && hasDataGridSaveTarget }" :style="whereSearchPaneStyle">
                    <Popover v-model:open="filterBuilderOpen">
                      <PopoverTrigger as-child>
                        <button
                          type="button"
                          class="relative flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[11px] font-medium transition-colors"
                          :class="filterButtonActive ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground'"
                          :disabled="!canUseWhereSearch"
                          @click="ensureStructuredFilterRule"
                        >
                          <Filter class="h-3 w-3" />
                          <span v-if="filterButtonCount" class="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-none text-primary-foreground">
                            {{ filterButtonCount }}
                          </span>
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="start" class="w-[380px] max-w-[calc(100vw-24px)] gap-3 p-3">
                        <div class="flex items-center justify-between gap-3">
                          <div class="text-xs font-medium text-foreground">{{ t("grid.filter") }}</div>
                          <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="addStructuredFilterRule">
                            <Plus class="mr-1 h-3.5 w-3.5" />
                            {{ t("grid.filterBuilderAddRule") }}
                          </Button>
                        </div>

                        <div v-if="hasLocalColumnFilters" class="space-y-2 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2">
                          <div class="flex items-center justify-between gap-3">
                            <div class="flex min-w-0 items-center gap-2 text-xs font-medium text-primary">
                              <Filter class="h-3.5 w-3.5 shrink-0" />
                              <span class="truncate">{{ t("grid.localFiltersActive", { count: localFilterCount }) }}</span>
                            </div>
                            <Button variant="ghost" size="sm" class="h-7 shrink-0 px-2 text-xs" @click="clearLocalFilter()">
                              <X class="mr-1 h-3.5 w-3.5" />
                              {{ t("grid.clearLocalFiltersShort") }}
                            </Button>
                          </div>
                          <div class="space-y-1">
                            <div v-for="summary in localFilterSummaries" :key="summary.columnIndex" class="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)_auto] items-center gap-2 rounded border border-primary/10 bg-background/70 px-2 py-1 text-xs">
                              <span class="truncate font-medium text-foreground" :title="summary.columnName">
                                {{ summary.columnName }}
                              </span>
                              <span class="min-w-0 truncate font-mono text-muted-foreground">
                                <template v-for="(value, valueIndex) in summary.values" :key="valueIndex">
                                  <span v-if="valueIndex > 0">, </span>
                                  <span>{{ value }}</span>
                                </template>
                                <span v-if="summary.hiddenValueCount">
                                  {{ t("grid.localFilterMoreValues", { count: summary.hiddenValueCount }) }}
                                </span>
                              </span>
                              <Button variant="ghost" size="icon" class="h-6 w-6 text-muted-foreground hover:text-destructive" :title="t('grid.clearFilter')" @click="clearLocalFilter(summary.columnIndex)">
                                <X class="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        </div>

                        <div v-if="structuredFilterRules.length" class="space-y-2">
                          <template v-for="(rule, index) in structuredFilterRules" :key="rule.id">
                            <div v-if="index > 0" class="flex justify-center">
                              <Button
                                variant="ghost"
                                size="sm"
                                class="h-6 px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                                @click="
                                  updateStructuredFilterRule(rule.id, {
                                    conjunction: rule.conjunction === 'AND' ? 'OR' : 'AND',
                                  })
                                "
                              >
                                {{ rule.conjunction }}
                              </Button>
                            </div>
                            <div class="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-2">
                              <Select :model-value="rule.columnName" :disabled="rule.disabled" :class="rule.disabled ? 'opacity-45' : ''" @update:model-value="(value: any) => updateStructuredFilterRuleColumn(rule.id, String(value))">
                                <SelectTrigger class="h-8 w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate">
                                  <SelectValue :placeholder="t('grid.filterBuilderColumn')" />
                                </SelectTrigger>
                                <SelectContent position="popper" class="max-h-72" :hide-scroll-buttons="true">
                                  <SelectItem v-for="columnName in filteredFilterBuilderColumnOptions" :key="columnName" :value="columnName">
                                    {{ columnName }}
                                  </SelectItem>
                                  <div v-if="filteredFilterBuilderColumnOptions.length === 0" class="px-2 py-2 text-xs text-muted-foreground">
                                    {{ t("grid.filterBuilderNoMatchingColumns") }}
                                  </div>
                                  <div class="sticky bottom-0 mt-1 flex items-center gap-1.5 border-t bg-popover px-2 py-1.5">
                                    <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                    <input
                                      v-model="filterBuilderColumnSearch"
                                      autocapitalize="off"
                                      autocomplete="off"
                                      autocorrect="off"
                                      spellcheck="false"
                                      class="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                                      :placeholder="t('grid.filterBuilderSearchColumns')"
                                      @click.stop
                                      @keydown="handleFilterBuilderColumnSearchKeydown"
                                      @pointerdown.stop
                                    />
                                  </div>
                                </SelectContent>
                              </Select>

                              <Select :model-value="rule.mode" :disabled="rule.disabled" :class="rule.disabled ? 'opacity-45' : ''" @update:model-value="(value: any) => updateStructuredFilterRule(rule.id, { mode: value as FilterMode })">
                                <SelectTrigger class="h-8 w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent position="popper">
                                  <SelectItem v-for="option in filterModeOptions" :key="option.value" :value="option.value">
                                    {{ t(option.labelKey) }}
                                  </SelectItem>
                                </SelectContent>
                              </Select>

                              <Input
                                v-if="filterModeNeedsValue(rule.mode)"
                                :model-value="rule.rawValue"
                                class="h-8 min-w-0 text-xs"
                                :class="rule.disabled ? 'opacity-45' : ''"
                                :disabled="rule.disabled"
                                :placeholder="t('grid.filterBuilderValue')"
                                @update:model-value="(value) => updateStructuredFilterRule(rule.id, { rawValue: String(value ?? '') })"
                                @keydown.enter.prevent="applyStructuredFilters"
                              />
                              <div v-else class="flex h-8 min-w-0 items-center overflow-hidden rounded-md border border-dashed px-2 text-xs text-muted-foreground" :class="rule.disabled ? 'opacity-45' : ''">
                                <span class="truncate">{{ t("grid.filterBuilderNoValue") }}</span>
                              </div>

                              <div class="flex items-center gap-1">
                                <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground" @click="updateStructuredFilterRule(rule.id, { disabled: !rule.disabled })">
                                  <EyeOff v-if="rule.disabled" class="h-3.5 w-3.5" />
                                  <Eye v-else class="h-3.5 w-3.5" />
                                </Button>
                                <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive" :disabled="structuredFilterRules.length === 1" @click="removeStructuredFilterRule(rule.id)">
                                  <Trash2 class="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          </template>
                        </div>

                        <div v-else class="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                          {{ t("grid.filterBuilderEmpty") }}
                        </div>

                        <div class="flex items-center justify-between gap-2 pt-1">
                          <Button variant="ghost" size="sm" class="h-8 px-2 text-xs" @click="clearAllFilters">
                            {{ t("grid.clearFilter") }}
                          </Button>
                          <div class="flex items-center gap-2">
                            <Button variant="ghost" size="sm" class="h-8 px-2 text-xs" @click="resetStructuredFilters">
                              {{ t("grid.resetFilterBuilder") }}
                            </Button>
                            <Button size="sm" class="h-8 px-3 text-xs" @click="applyStructuredFilters">
                              {{ t("grid.applyFilter") }}
                            </Button>
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                    <div ref="whereConditionControlRef" class="flex min-w-0 flex-1 items-center gap-1">
                      <span class="data-grid-topbar-condition-label data-grid-topbar-condition-label--where" :class="{ 'data-grid-topbar-condition-label--compact': compactDataGridToolbar }">WHERE</span>
                      <div class="relative h-6 min-w-0 flex-1 overflow-hidden">
                        <textarea
                          ref="whereFilterInputRef"
                          v-model="whereFilterInput"
                          wrap="off"
                          rows="1"
                          autocapitalize="off"
                          autocorrect="off"
                          spellcheck="false"
                          class="data-grid-topbar-condition-input data-grid-topbar-condition-input--where absolute inset-x-0 top-0 h-6 min-w-0 resize-none bg-transparent outline-none"
                          :class="{ 'data-grid-topbar-condition-input--compact': compactDataGridToolbar }"
                          style="height: 24px"
                          placeholder="WHERE"
                          @input="onWhereFilterInput"
                          @keydown="onWhereFilterKeydown"
                          @focus="resizeConditionInput('where')"
                          @click="onConditionInputClick('where')"
                          @wheel="onConditionInputWheel"
                          @blur="
                            dismissWhereSuggestions();
                            collapseConditionInputAfterBlur('where');
                          "
                        />
                      </div>
                      <button class="text-muted-foreground hover:text-foreground shrink-0" type="button" @mousedown.prevent="openWhereHistoryMenu">
                        <ChevronDown class="w-3 h-3" />
                      </button>
                      <button v-if="hasWhereFilterInput" class="text-muted-foreground hover:text-foreground shrink-0" @click="clearWhereFilterInput">
                        <X class="w-3 h-3" />
                      </button>
                    </div>
                    <Teleport to="body">
                      <div v-if="whereConditionRendered" class="data-grid-topbar-condition-pane--expanded flex min-w-0 items-start gap-1" :class="{ 'border-l': useTransaction && editable && hasDataGridSaveTarget }" :style="conditionPaneStyle('where')">
                        <textarea
                          ref="whereFilterOverlayRef"
                          v-model="whereFilterInput"
                          wrap="soft"
                          rows="1"
                          autocapitalize="off"
                          autocorrect="off"
                          spellcheck="false"
                          class="data-grid-topbar-condition-input data-grid-topbar-condition-input--where data-grid-topbar-condition-input--expanded absolute resize-none outline-none"
                          :class="{ 'data-grid-topbar-condition-input--compact': compactDataGridToolbar }"
                          placeholder="WHERE"
                          @input="onWhereFilterInput"
                          @keydown="onWhereFilterKeydown"
                          @focus="resizeConditionInput('where')"
                          @click="onConditionOverlayClick('where')"
                          @scroll="onConditionOverlayScroll('where', $event)"
                          @blur="
                            dismissWhereSuggestions();
                            collapseConditionInputAfterBlur('where');
                          "
                        />
                        <div class="data-grid-topbar-condition-floating-controls pointer-events-none absolute inset-x-2 z-[1] flex h-6 min-w-0 items-center gap-1" :style="conditionTopbarOverlayStyle('where')">
                          <button
                            type="button"
                            class="data-grid-topbar-condition-icon-control pointer-events-auto relative flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[11px] font-medium transition-colors"
                            :class="filterButtonActive ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground'"
                            :disabled="!canUseWhereSearch"
                            @mousedown.prevent
                            @click="openStructuredFilterFromExpandedWhere"
                          >
                            <Filter class="h-3 w-3" />
                            <span v-if="filterButtonCount" class="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-none text-primary-foreground">
                              {{ filterButtonCount }}
                            </span>
                          </button>
                          <span class="data-grid-topbar-condition-label data-grid-topbar-condition-label--where" :class="{ 'data-grid-topbar-condition-label--compact': compactDataGridToolbar }">WHERE</span>
                          <div class="min-w-0 flex-1" />
                          <button class="data-grid-topbar-condition-icon-control pointer-events-auto text-muted-foreground hover:text-foreground shrink-0" type="button" @mousedown.prevent="openWhereHistoryMenu">
                            <ChevronDown class="w-3 h-3" />
                          </button>
                          <button v-if="hasWhereFilterInput" class="data-grid-topbar-condition-icon-control pointer-events-auto text-muted-foreground hover:text-foreground shrink-0" @click="clearWhereFilterInput">
                            <X class="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </Teleport>
                    <!-- WHERE suggestion dropdown -->
                    <Teleport to="body">
                      <div v-if="showWhereSuggestionDropdown" ref="whereSuggestionDropdownRef" class="fixed z-[90] min-w-[180px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md" :style="whereSuggestionStyle">
                        <div
                          v-for="(sug, idx) in whereSuggestions"
                          :key="`${sug.kind}:${sug.value}`"
                          class="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs cursor-pointer"
                          :class="idx === whereSuggestionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-gray-200 dark:hover:bg-gray-800'"
                          @mousedown.prevent="
                            whereSuggestionIndex = idx;
                            acceptWhereSuggestion();
                          "
                          @mouseenter="
                            whereSuggestionIndex = idx;
                            sug.kind === 'history' ? showConditionHistoryPreview(sug.value, $event) : hideConditionHistoryPreview();
                          "
                          @mouseleave="hideConditionHistoryPreview"
                        >
                          <Search class="w-3 h-3 mr-2 text-muted-foreground shrink-0" />
                          <span data-condition-history-text class="min-w-0 flex-1 truncate font-mono">{{ sug.value }}</span>
                          <button v-if="sug.kind === 'history'" class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" type="button" @mousedown.stop.prevent="deleteWhereHistorySuggestion(sug.value)">
                            <X class="h-3 w-3" />
                          </button>
                        </div>
                        <div v-if="whereSuggestions.length === 0" class="px-3 py-2 text-xs text-muted-foreground">
                          {{ whereHistoryEmptyText }}
                        </div>
                      </div>
                    </Teleport>
                  </div>
                  <button
                    type="button"
                    class="group relative flex w-2 shrink-0 cursor-col-resize items-center justify-center border-l border-r border-border/80 bg-muted/15 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                    aria-label="Resize WHERE and ORDER BY"
                    @mousedown="onSearchSplitResizeStart"
                    @dblclick.stop="resetSearchSplitWidth"
                  >
                    <span class="h-5 w-px bg-border group-hover:bg-primary/60" />
                  </button>
                  <div ref="orderByConditionPaneRef" class="flex flex-1 items-center gap-1 px-2 py-0.5 border-r min-w-0 relative">
                    <div ref="orderByConditionControlRef" class="flex min-w-0 flex-1 items-center gap-1">
                      <span class="data-grid-topbar-condition-label data-grid-topbar-condition-label--order" :class="{ 'data-grid-topbar-condition-label--compact': compactDataGridToolbar }">ORDER BY</span>
                      <div class="relative h-6 min-w-0 flex-1 overflow-hidden">
                        <textarea
                          ref="orderByInputRef"
                          v-model="orderByInput"
                          wrap="off"
                          rows="1"
                          autocapitalize="off"
                          autocorrect="off"
                          spellcheck="false"
                          class="data-grid-topbar-condition-input data-grid-topbar-condition-input--order absolute inset-x-0 top-0 h-6 min-w-0 resize-none bg-transparent outline-none"
                          :class="{ 'data-grid-topbar-condition-input--compact': compactDataGridToolbar }"
                          style="height: 24px"
                          placeholder="ORDER BY"
                          @input="onOrderByInput"
                          @keydown="onOrderByKeydown"
                          @focus="resizeConditionInput('orderBy')"
                          @click="onConditionInputClick('orderBy')"
                          @wheel="onConditionInputWheel"
                          @blur="
                            dismissOrderBySuggestions();
                            collapseConditionInputAfterBlur('orderBy');
                          "
                        />
                      </div>
                      <button class="text-muted-foreground hover:text-foreground shrink-0" type="button" @mousedown.prevent="openOrderByHistoryMenu">
                        <ChevronDown class="w-3 h-3" />
                      </button>
                      <button v-if="hasOrderByInput" class="text-muted-foreground hover:text-foreground shrink-0" @click="clearOrderByInput">
                        <X class="w-3 h-3" />
                      </button>
                    </div>
                    <Teleport to="body">
                      <div v-if="orderByConditionRendered" class="data-grid-topbar-condition-pane--expanded flex min-w-0 items-start gap-1 border-r" :style="conditionPaneStyle('orderBy')">
                        <textarea
                          ref="orderByOverlayRef"
                          v-model="orderByInput"
                          wrap="soft"
                          rows="1"
                          autocapitalize="off"
                          autocorrect="off"
                          spellcheck="false"
                          class="data-grid-topbar-condition-input data-grid-topbar-condition-input--order data-grid-topbar-condition-input--expanded absolute resize-none outline-none"
                          :class="{ 'data-grid-topbar-condition-input--compact': compactDataGridToolbar }"
                          placeholder="ORDER BY"
                          @input="onOrderByInput"
                          @keydown="onOrderByKeydown"
                          @focus="resizeConditionInput('orderBy')"
                          @click="onConditionOverlayClick('orderBy')"
                          @scroll="onConditionOverlayScroll('orderBy', $event)"
                          @blur="
                            dismissOrderBySuggestions();
                            collapseConditionInputAfterBlur('orderBy');
                          "
                        />
                        <div class="data-grid-topbar-condition-floating-controls pointer-events-none absolute inset-x-2 z-[1] flex h-6 min-w-0 items-center gap-1" :style="conditionTopbarOverlayStyle('orderBy')">
                          <span class="data-grid-topbar-condition-label data-grid-topbar-condition-label--order" :class="{ 'data-grid-topbar-condition-label--compact': compactDataGridToolbar }">ORDER BY</span>
                          <div class="min-w-0 flex-1" />
                          <button class="data-grid-topbar-condition-icon-control pointer-events-auto text-muted-foreground hover:text-foreground shrink-0" type="button" @mousedown.prevent="openOrderByHistoryMenu">
                            <ChevronDown class="w-3 h-3" />
                          </button>
                          <button v-if="hasOrderByInput" class="data-grid-topbar-condition-icon-control pointer-events-auto text-muted-foreground hover:text-foreground shrink-0" @click="clearOrderByInput">
                            <X class="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </Teleport>
                    <!-- ORDER BY suggestion dropdown -->
                    <Teleport to="body">
                      <div v-if="showOrderBySuggestionDropdown" ref="orderBySuggestionDropdownRef" class="fixed z-[90] min-w-[180px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md" :style="orderBySuggestionStyle">
                        <div
                          v-for="(sug, idx) in orderBySuggestions"
                          :key="`${sug.kind}:${sug.value}`"
                          class="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs cursor-pointer"
                          :class="idx === orderBySuggestionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-gray-200 dark:hover:bg-gray-800'"
                          @mousedown.prevent="
                            orderBySuggestionIndex = idx;
                            acceptOrderBySuggestion();
                          "
                          @mouseenter="
                            orderBySuggestionIndex = idx;
                            sug.kind === 'history' ? showConditionHistoryPreview(sug.value, $event) : hideConditionHistoryPreview();
                          "
                          @mouseleave="hideConditionHistoryPreview"
                        >
                          <Search class="w-3 h-3 mr-2 text-muted-foreground shrink-0" />
                          <span data-condition-history-text class="min-w-0 flex-1 truncate font-mono">{{ sug.value }}</span>
                          <button v-if="sug.kind === 'history'" class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" type="button" @mousedown.stop.prevent="deleteOrderByHistorySuggestion(sug.value)">
                            <X class="h-3 w-3" />
                          </button>
                        </div>
                        <div v-if="orderBySuggestions.length === 0" class="px-3 py-2 text-xs text-muted-foreground">
                          {{ orderByHistoryEmptyText }}
                        </div>
                      </div>
                    </Teleport>
                    <Teleport to="body">
                      <div v-if="conditionHistoryPreview" class="pointer-events-none fixed z-[140] rounded-md bg-foreground shadow-xl" :style="conditionHistoryPreviewStyle">
                        <span class="absolute h-3 w-3 rotate-45 bg-foreground" :class="conditionHistoryPreview.side === 'left' ? '-left-1.5' : '-right-1.5'" :style="conditionHistoryPreviewArrowStyle" />
                        <div class="max-h-[min(320px,calc(100vh-16px))] overflow-auto rounded-md px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-background">
                          {{ conditionHistoryPreview.value }}
                        </div>
                      </div>
                    </Teleport>
                  </div>
                </div>
              </template>

              <slot name="search-bar" :local-filter-count="localFilterCount" :has-local-column-filters="hasLocalColumnFilters" :local-filter-summaries="localFilterSummaries" :clear-local-filter="clearLocalFilter" />
            </div>
          </div>

          <div class="flex shrink-0 items-center gap-1 px-1 ml-auto" @wheel="onDataGridTopbarFixedActionWheel">
            <slot v-if="hasResultToolbarActionsSlot" name="result-toolbar-actions" :compact="compactDataGridToolbar" />
            <Tooltip v-if="showQueryEditReadOnlyBadge">
              <TooltipTrigger as-child>
                <div class="flex h-5 items-center gap-1 rounded border border-muted-foreground/30 bg-muted/60 px-1.5 text-xs font-medium text-muted-foreground">
                  {{ t("grid.queryEditReadOnly") }}
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" class="max-w-sm">
                {{ queryEditReadOnlyReason }}
              </TooltipContent>
            </Tooltip>
            <Tooltip v-if="showKeylessEditWarning">
              <TooltipTrigger as-child>
                <div class="flex h-5 items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
                  <KeyRound class="h-3 w-3" />
                  {{ t("grid.keylessEditWarning") }}
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" class="max-w-sm">
                {{ t("grid.keylessEditWarningHint") }}
              </TooltipContent>
            </Tooltip>
            <Tooltip v-if="canShowMongoJsonPreview">
              <TooltipTrigger as-child>
                <Button
                  variant="ghost"
                  size="sm"
                  :class="['data-grid-topbar-action-button h-5 shrink-0 text-xs px-1.5', compactDataGridToolbar ? 'data-grid-topbar-action-button--compact' : '', mongoJsonPreviewOpen ? 'text-primary bg-primary/10 hover:bg-primary/15' : '']"
                  :aria-pressed="mongoJsonPreviewOpen"
                  @click="toggleMongoJsonPreview"
                >
                  <Code2 class="data-grid-topbar-action-icon w-3 h-3" />
                  <span class="data-grid-topbar-action-label" :class="{ 'data-grid-topbar-action-label--compact': compactDataGridToolbar }">{{ t("grid.mongoJsonPreview") }}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{{ t("grid.mongoJsonPreview") }}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger as-child>
                <Button variant="ghost" size="sm" :class="['data-grid-topbar-action-button h-5 shrink-0 text-xs px-1.5', compactDataGridToolbar ? 'data-grid-topbar-action-button--compact' : '', isSaving ? '' : '']" :disabled="isSaving" @click="onToolbarRefresh">
                  <Loader2 v-if="loading" class="data-grid-topbar-action-icon w-3 h-3 animate-spin" />
                  <RefreshCcw v-else class="data-grid-topbar-action-icon w-3 h-3" />
                  <span class="data-grid-topbar-action-label" :class="{ 'data-grid-topbar-action-label--compact': compactDataGridToolbar }">{{ t("grid.refresh") }}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{{ t("grid.refresh") }} ({{ shortcutMod }}+R)</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button
                  variant="ghost"
                  size="sm"
                  :class="['data-grid-topbar-action-button h-5 shrink-0 text-xs px-1.5', compactDataGridToolbar ? 'data-grid-topbar-action-button--compact' : '', autoRefreshEnabled ? 'text-primary bg-primary/10 hover:bg-primary/15' : 'text-muted-foreground hover:text-foreground']"
                  :title="autoRefreshLabel"
                  :aria-label="autoRefreshLabel"
                  :aria-pressed="autoRefreshEnabled"
                >
                  <Timer class="data-grid-topbar-action-icon w-3 h-3" />
                  <span class="data-grid-topbar-action-label" :class="{ 'data-grid-topbar-action-label--compact': compactDataGridToolbar }">{{ autoRefreshEnabled ? `${autoRefreshIntervalSeconds}s` : t("tabs.autoRefreshShort") }}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-40">
                <DropdownMenuItem class="gap-2" @select="toggleAutoRefresh">
                  <Check v-if="autoRefreshEnabled" class="h-3.5 w-3.5" />
                  <span v-else class="h-3.5 w-3.5" />
                  {{ autoRefreshEnabled ? t("tabs.stopAutoRefresh") : t("tabs.startAutoRefresh") }}
                </DropdownMenuItem>
                <DropdownMenuItem v-for="seconds in AUTO_REFRESH_INTERVAL_OPTIONS" :key="seconds" class="gap-2" @select="setAutoRefreshInterval(seconds)">
                  <Check v-if="autoRefreshIntervalSeconds === seconds" class="h-3.5 w-3.5" />
                  <span v-else class="h-3.5 w-3.5" />
                  {{ t("tabs.autoRefreshEvery", { seconds }) }}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip v-if="props.result.columns.length">
              <TooltipTrigger as-child>
                <Popover v-model:open="goToColumnOpen">
                  <PopoverTrigger as-child>
                    <Button variant="ghost" size="sm" :class="['data-grid-topbar-action-button h-5 shrink-0 text-xs px-1.5', compactDataGridToolbar ? 'data-grid-topbar-action-button--compact' : '', goToColumnOpen ? 'text-primary bg-primary/10' : '']">
                      <Columns3 class="data-grid-topbar-action-icon w-3 h-3" />
                      <span class="data-grid-topbar-action-label" :class="{ 'data-grid-topbar-action-label--compact': compactDataGridToolbar }">{{ t("grid.goToColumn") }}</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" class="w-56 p-2" @keydown="onGoToColumnKeydown">
                    <div class="relative mb-1">
                      <Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <input v-model="goToColumnSearch" :placeholder="t('grid.searchColumn')" class="h-8 w-full rounded-md border bg-transparent pl-7 pr-6 text-xs outline-none focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25" />
                      <button v-if="goToColumnSearch" type="button" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="goToColumnSearch = ''">
                        <X class="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <div class="max-h-56 overflow-auto rounded border">
                      <button v-for="column in filteredGoToColumns" :key="column.index" type="button" class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground" @click="scrollToColumn(column.index)">
                        <span class="min-w-0 truncate">{{ column.name }}</span>
                        <span class="shrink-0 font-mono text-[10px] text-muted-foreground">#{{ column.index + 1 }}</span>
                        <span v-if="column.comment" class="col-span-2 min-w-0 truncate text-[11px] leading-4 text-muted-foreground" :title="column.comment">{{ column.comment }}</span>
                      </button>
                      <div v-if="!filteredGoToColumns.length" class="px-2 py-3 text-center text-xs text-muted-foreground">{{ t("grid.noColumnsFound") }}</div>
                    </div>
                  </PopoverContent>
                </Popover>
              </TooltipTrigger>
              <TooltipContent side="bottom">{{ t("grid.goToColumn") }}</TooltipContent>
            </Tooltip>
            <Tooltip v-if="editable && hasDataGridInsertTarget && canInsertRows">
              <TooltipTrigger as-child>
                <Button variant="ghost" size="sm" :class="['data-grid-topbar-action-button h-5 shrink-0 text-xs px-1.5', compactDataGridToolbar ? 'data-grid-topbar-action-button--compact' : '']" @click="addRow">
                  <Plus class="data-grid-topbar-action-icon w-3 h-3" />
                  <span class="data-grid-topbar-action-label" :class="{ 'data-grid-topbar-action-label--compact': compactDataGridToolbar }">{{ t("grid.addRow") }}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{{ t("grid.addRow") }} ({{ shortcutMod }}+N)</TooltipContent>
            </Tooltip>
            <template v-if="saveToolbarState.showActions">
              <Tooltip v-if="pendingChangeCount > 0">
                <TooltipTrigger as-child>
                  <Button
                    variant="ghost"
                    size="sm"
                    :class="['data-grid-topbar-action-button h-5 shrink-0 text-xs px-1.5 text-sky-600 hover:bg-sky-500/10 hover:text-sky-700', compactDataGridToolbar ? 'data-grid-topbar-action-button--compact' : '']"
                    :disabled="isPreviewLoading"
                    @click="openSqlPreview"
                  >
                    <Loader2 v-if="isPreviewLoading" class="data-grid-topbar-action-icon w-3 h-3 animate-spin" />
                    <Eye v-else class="data-grid-topbar-action-icon w-3 h-3" />
                    <span class="data-grid-topbar-action-label" :class="{ 'data-grid-topbar-action-label--compact': compactDataGridToolbar }">{{ t("toolbar.previewSql") }}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" class="max-w-sm">
                  {{ t("toolbar.previewSql") }}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button
                    variant="default"
                    size="sm"
                    :class="['data-grid-topbar-action-button data-grid-topbar-action-button--commit relative h-5 shrink-0 text-xs px-1.5', compactDataGridToolbar ? 'data-grid-topbar-action-button--compact' : '']"
                    :disabled="saveToolbarState.actionsDisabled"
                    @click="onToolbarCommit"
                  >
                    <Loader2 v-if="isSaving" class="data-grid-topbar-action-icon w-3 h-3 animate-spin" />
                    <Save v-else-if="compactDataGridToolbar || pendingChangeCount === 0" class="data-grid-topbar-action-icon w-3 h-3" />
                    <span
                      v-if="pendingChangeCount > 0"
                      :class="
                        compactDataGridToolbar
                          ? 'absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-300 px-1 text-[9px] font-semibold leading-none text-amber-950 shadow-[0_0_0_1px_rgba(120,53,15,0.16)] dark:bg-amber-400 dark:text-amber-950'
                          : 'mr-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-300 px-1 text-[9px] font-semibold leading-none text-amber-950 shadow-[0_0_0_1px_rgba(120,53,15,0.16)] dark:bg-amber-400 dark:text-amber-950'
                      "
                    >
                      {{ pendingChangeCount }}
                    </span>
                    <span class="data-grid-topbar-action-label" :class="{ 'data-grid-topbar-action-label--compact': compactDataGridToolbar }">{{ t(saveActionMode.labelKey, { count: pendingChangeCount }) }}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" class="max-w-sm"> {{ t(saveActionMode.tooltipKey, { count: pendingChangeCount }) }} ({{ saveShortcutLabel }}) </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button
                    variant="outline"
                    size="sm"
                    :class="['data-grid-topbar-action-button h-5 shrink-0 text-xs px-1.5', compactDataGridToolbar ? 'data-grid-topbar-action-button--compact' : '']"
                    :disabled="saveToolbarState.actionsDisabled"
                    @click="useTransaction ? onToolbarRollback() : discardChanges()"
                  >
                    <RotateCcw class="data-grid-topbar-action-icon w-3 h-3" />
                    <span class="data-grid-topbar-action-label" :class="{ 'data-grid-topbar-action-label--compact': compactDataGridToolbar }">{{ t(saveActionMode.secondaryActionKey) }}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{{ t(saveActionMode.secondaryActionKey) }}</TooltipContent>
              </Tooltip>
            </template>
          </div>
        </div>
        <!-- Truncation warning banner -->
        <div v-if="showTruncationWarning" class="shrink-0 px-3 py-1 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
          <span>{{ t("grid.truncatedHint", { count: pageSize }) }}</span>
        </div>
        <!-- Content area: table + side/bottom detail panes -->
        <div class="flex-1 grid min-h-0 overflow-hidden" :style="contentGridStyle">
          <div class="col-start-1 row-start-1 flex flex-col min-w-0 overflow-hidden relative">
            <!-- Search overlay (Ctrl+F) -->
            <Transition enter-active-class="transition-opacity duration-150" leave-active-class="transition-opacity duration-100" enter-from-class="opacity-0" leave-to-class="opacity-0">
              <div v-if="searchOverlayVisible" class="absolute top-1 right-2 z-20 flex items-center gap-1 px-2 py-1 bg-background border rounded-md shadow-md">
                <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <input
                  ref="searchInputRef"
                  v-model="searchText"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  class="w-48 h-5 min-w-0 text-xs bg-transparent outline-none placeholder:text-muted-foreground"
                  :placeholder="t('grid.search')"
                  @keydown="onSearchKeydown"
                  @click="updateSuggestionPosition"
                />
                <span ref="measureRef" class="invisible absolute left-0 top-0 text-xs whitespace-pre pointer-events-none" aria-hidden="true" />
                <div v-if="searchSuggestions.length > 0" class="absolute top-full right-0 mt-0.5 z-50 min-w-[180px] rounded-md border bg-popover text-popover-foreground shadow-md">
                  <div
                    v-for="(sug, idx) in searchSuggestions"
                    :key="sug"
                    class="flex items-center px-3 py-1.5 text-xs cursor-pointer"
                    :class="idx === suggestionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-gray-200 dark:hover:bg-gray-800'"
                    @mousedown.prevent="
                      suggestionIndex = idx;
                      acceptSuggestion();
                    "
                    @mouseenter="suggestionIndex = idx"
                  >
                    <Search class="w-3 h-3 mr-2 text-muted-foreground shrink-0" />
                    <span>{{ sug }}</span>
                  </div>
                </div>
                <span v-if="searchMatches.length > 0" class="text-xs text-muted-foreground shrink-0"> {{ currentMatchIndex + 1 }}/{{ searchMatches.length }} </span>
                <span v-else-if="deferredClientSearchText" class="text-xs text-muted-foreground shrink-0"> 0 </span>
                <button class="text-muted-foreground hover:text-foreground shrink-0" @click="closeSearch">
                  <X class="w-3.5 h-3.5" />
                </button>
              </div>
            </Transition>
            <ErrorBanner v-if="isErrorResult" variant="centered" :message="errorMessage">
              <template #actions>
                <slot name="error-actions" :error-message="errorMessage" />
              </template>
            </ErrorBanner>
            <div v-else-if="isTransposeMode" class="flex-1 flex flex-col min-h-0 overflow-hidden">
              <div class="h-8 flex items-center gap-2 px-3 border-y shrink-0 bg-muted/20">
                <Rows3 class="w-3.5 h-3.5 text-muted-foreground" />
                <span class="text-xs font-medium">{{ t("grid.transpose") }}</span>
                <span class="text-xs text-muted-foreground"> {{ t("grid.rowNumber") }} {{ (transposeRowIndex ?? 0) + 1 }} </span>
                <span class="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {{ multiRowTranspose ? t("grid.transposeMultiRow") : t("grid.transposeSingleRow") }}
                </span>
                <span class="flex-1" />
                <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="transposeRowIndex === 0" @click="transposeNav(-1)">
                  <ChevronLeft class="w-3 h-3" />
                </Button>
                <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="transposeRowIndex === displayItems.length - 1" @click="transposeNav(1)">
                  <ChevronRight class="w-3 h-3" />
                </Button>
                <Button variant="ghost" size="icon" class="h-5 w-5" @click="closeTranspose">
                  <X class="w-3 h-3" />
                </Button>
              </div>
              <RecycleScroller
                ref="transposeScrollRef"
                class="transpose-grid-scroller flex-1 min-h-0 overflow-auto overscroll-none bg-background"
                :class="{ 'is-scrolling': isScrolling }"
                :style="{
                  '--transpose-total-w': `${transposeTotalWidth}px`,
                  '--transpose-field-w': `${transposePinnedWidth}px`,
                }"
                :items="transposeRows"
                :item-size="30"
                :buffer="400"
                key-field="id"
                @scroll="onTransposeScroll"
              >
                <template #before>
                  <div class="data-grid-transpose-header data-grid-header-shell sticky top-0 z-20 flex h-7 border-b border-border font-semibold text-muted-foreground" :style="{ width: `${transposeTotalWidth}px` }">
                    <div class="data-grid-header-cell sticky left-0 z-30 shrink-0 border-r border-border px-3 py-1.5 truncate relative" :style="{ width: `${transposePinnedWidth}px` }">
                      {{ t("grid.columnName") }}
                      <div class="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30" @mousedown.stop="onTransposePinnedResizeStart" />
                    </div>
                    <div class="shrink-0" :style="{ width: `${transposeBeforeSpacerWidth}px` }" />
                    <div
                      v-for="recordIndex in activeTransposeRecordIndexes"
                      :key="`transpose-head-${recordIndex}`"
                      class="shrink-0 border-r border-border px-2 py-1.5 text-center tabular-nums relative"
                      :class="{
                        'transpose-record-header-selected text-primary font-semibold': transposeRecordUsesFramedHeader(recordIndex),
                        'transpose-record-header-active text-primary': transposeRecordUsesActiveHighlight(recordIndex) && !transposeRecordUsesFramedHeader(recordIndex),
                        'data-grid-header-cell': !transposeRecordUsesActiveHighlight(recordIndex) && !transposeRecordUsesFramedHeader(recordIndex),
                      }"
                      :style="{ width: `${getTransposeRecordWidth(recordIndex)}px` }"
                      @click="selectTransposeRecord(recordIndex, $event)"
                      @contextmenu="selectTransposeRecord(recordIndex, $event)"
                    >
                      {{ rowNumberText(displayItems[recordIndex]) }}
                      <div class="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30" @mousedown.stop="onTransposeRecordResizeStart(recordIndex, $event)" @dblclick.stop="autoFitTransposeRecord(recordIndex)" />
                    </div>
                    <div class="shrink-0" :style="{ width: `${transposeAfterSpacerWidth}px` }" />
                  </div>
                </template>
                <template #default="{ item, index }">
                  <div class="data-grid-transpose-row flex border-b border-border/60" :style="{ height: '30px', width: `${transposeTotalWidth}px` }">
                    <div
                      class="sticky left-0 z-10 flex shrink-0 items-center border-r border-border bg-background px-3 py-0 font-medium truncate"
                      :class="{
                        'bg-yellow-200/60 dark:bg-yellow-500/20': transposeHeaderIsSearchMatch(visibleColumnIndexes[index]),
                        'ring-2 ring-inset ring-yellow-500 bg-yellow-300/60 dark:bg-yellow-500/40': transposeHeaderIsCurrentMatch(visibleColumnIndexes[index]),
                      }"
                      :style="{ width: `${transposePinnedWidth}px` }"
                      :title="item.column"
                    >
                      {{ item.column }}
                    </div>
                    <div class="shrink-0" :style="{ width: `${transposeBeforeSpacerWidth}px` }" />
                    <div
                      v-for="cell in item.values"
                      :key="`${item.id}:${cell.recordIndex}`"
                      class="relative flex shrink-0 items-center border-r border-border/70 px-2 py-0 font-mono truncate"
                      :class="{
                        'text-muted-foreground italic': cell.isNull,
                        'cell-selected': transposeCellIsSelected(cell.recordIndex, cell.valueIndex) && !displayItems[cell.recordIndex]?.isDirtyCol[cell.valueIndex],
                        'cell-selected-dirty': transposeCellIsSelected(cell.recordIndex, cell.valueIndex) && displayItems[cell.recordIndex]?.isDirtyCol[cell.valueIndex],
                        'row-cell-selected': transposeRecordUsesSelectionVisual(cell.recordIndex) && !transposeCellIsSelected(cell.recordIndex, cell.valueIndex) && !displayItems[cell.recordIndex]?.isDirtyCol[cell.valueIndex],
                        'row-cell-selected-dirty': transposeRecordUsesSelectionVisual(cell.recordIndex) && !transposeCellIsSelected(cell.recordIndex, cell.valueIndex) && displayItems[cell.recordIndex]?.isDirtyCol[cell.valueIndex],
                        'bg-primary/15': transposeRecordUsesActiveHighlight(cell.recordIndex) && !transposeRecordUsesSelectionVisual(cell.recordIndex) && !displayItems[cell.recordIndex]?.isDirtyCol[cell.valueIndex] && !transposeCellIsSelected(cell.recordIndex, cell.valueIndex),
                        'bg-yellow-500/10 cell-dirty': displayItems[cell.recordIndex]?.isDirtyCol[cell.valueIndex],
                        'bg-yellow-200/60 dark:bg-yellow-500/20': cellIsSearchMatch(cell.recordIndex, cell.valueIndex),
                        'ring-2 ring-inset ring-yellow-500 bg-yellow-300/60 dark:bg-yellow-500/40': cellIsCurrentMatch(cell.recordIndex, cell.valueIndex),
                        'cursor-text': !isScrolling && canEditCellItem(displayItems[cell.recordIndex], cell.valueIndex),
                        'hover:bg-gray-200 dark:hover:bg-gray-800':
                          !isScrolling && canEditCellItem(displayItems[cell.recordIndex], cell.valueIndex) && !transposeRecordUsesSelectionVisual(cell.recordIndex) && !transposeRecordUsesActiveHighlight(cell.recordIndex) && !transposeCellIsSelected(cell.recordIndex, cell.valueIndex),
                      }"
                      :style="{ width: `${getTransposeRecordWidth(cell.recordIndex)}px` }"
                      :title="cell.display"
                      @mousedown="prepareTransposeCellMouseDown(cell.recordIndex, cell.valueIndex)"
                      @click="selectTransposeCell(cell.recordIndex, cell.valueIndex, $event)"
                      @mouseenter="onTransposeCellMouseenter(cell.recordIndex, cell.valueIndex)"
                      @mouseleave="onCellMouseleave(cell.recordIndex, cell.valueIndex)"
                      @contextmenu="onTransposeCellContext(cell.recordIndex, cell.valueIndex, $event)"
                      @dblclick.stop="canEditCellItem(displayItems[cell.recordIndex], cell.valueIndex) && startDomCellEdit(displayItems[cell.recordIndex].id, cell.valueIndex, cell.display, $event)"
                    >
                      <template v-if="editingCell?.rowId === displayItems[cell.recordIndex]?.id && editingCell?.col === cell.valueIndex">
                        <TemporalCellEditor
                          v-if="temporalEditorConfigForColumn(cell.valueIndex)"
                          v-model="editValue"
                          :kind="temporalEditorConfigForColumn(cell.valueIndex)!.kind"
                          :fraction-precision="temporalEditorConfigForColumn(cell.valueIndex)!.fractionPrecision"
                          cell-layout="transpose"
                          @cancel="cancelEdit"
                          @commit="commitGridEdit"
                        />
                        <EnumCellEditor
                          v-else-if="isEnumGridColumn(cell.valueIndex)"
                          v-model="editValue"
                          :values="enumValuesForGridColumn(cell.valueIndex)"
                          :nullable="isEnumGridColumnNullable(cell.valueIndex)"
                          :initial-null="isEnumEditorInitialNull(displayItems[cell.recordIndex]?.id, cell.valueIndex)"
                          cell-layout="transpose"
                          @cancel="cancelEdit"
                          @commit="commitGridEdit"
                        />
                        <textarea
                          v-else-if="cellUsesExpandedEditor(displayItems[cell.recordIndex]?.id, cell.valueIndex)"
                          v-model="editValue"
                          data-expanded-cell-editor="true"
                          rows="1"
                          :inputmode="cellEditInputModeForColumn(cell.valueIndex)"
                          autocapitalize="off"
                          autocorrect="off"
                          spellcheck="false"
                          class="cell-edit-input cell-edit-input--expanded absolute left-0 top-0 min-h-full bg-background px-1.5 py-1 leading-[18px] outline-none z-10"
                          @blur="commitEditFromCellBlur"
                          @click.stop
                          @focus="onCellEditTextareaInput"
                          @input="onCellEditTextareaInput"
                          @keydown.stop="onCellEditKeydown"
                          @paste.stop="onCellEditTextareaPaste"
                        />
                        <input
                          v-else
                          v-model="editValue"
                          :inputmode="cellEditInputModeForColumn(cell.valueIndex)"
                          autocapitalize="off"
                          autocorrect="off"
                          spellcheck="false"
                          class="cell-edit-input absolute inset-0 bg-background border-2 border-primary px-1.5 py-0 leading-[26px] outline-none z-10"
                          @blur="commitEditFromCellBlur"
                          @click.stop
                          @input="onCellEditTextareaInput"
                          @keydown.stop="onCellEditKeydown"
                          @paste.stop="onCellEditTextareaPaste"
                        />
                      </template>
                      <template v-else>
                        <template v-if="draftCellPlaceholder(displayItems[cell.recordIndex], cell.valueIndex)">
                          <span class="text-muted-foreground/70 italic">{{ draftCellPlaceholder(displayItems[cell.recordIndex], cell.valueIndex) }}</span>
                        </template>
                        <template v-else>{{ firstLineCellDisplayValue(cell.display) }}</template>
                        <div v-if="cellDetailButtonVisible(cell.recordIndex, cell.valueIndex)" class="absolute right-2 top-0.5 flex items-center gap-1">
                          <LightDropdownMenu
                            v-if="canQuickDownloadCellValue(cell.recordIndex, cell.valueIndex)"
                            :items="binaryCellDownloadMenuItems"
                            :open="quickDownloadMenuOpenFor(cell.recordIndex, cell.valueIndex)"
                            align="end"
                            content-class="w-44"
                            :match-trigger-width="false"
                            @update:open="(value: boolean) => handleQuickDownloadMenuOpenChange(value, cell.recordIndex, cell.valueIndex)"
                            @select="(mode: string) => downloadCellBinaryValue(cell.recordIndex, cell.valueIndex, mode as BinaryCellDownloadMode)"
                          >
                            <template #trigger="{ open, toggle }">
                              <button class="flex h-5 w-5 items-center justify-center rounded bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border hover:text-foreground" :title="t('grid.downloadBinaryValue')" :aria-expanded="open" @mousedown.stop @click.stop="toggle">
                                <Upload class="h-3 w-3" />
                              </button>
                            </template>
                          </LightDropdownMenu>
                          <button
                            class="flex h-5 w-5 items-center justify-center rounded bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border hover:text-foreground"
                            :title="t('grid.cellDetails')"
                            @mousedown.stop
                            @click.stop="showTransposeCellDetails(cell.recordIndex, cell.valueIndex)"
                          >
                            <Info class="h-3 w-3" />
                          </button>
                        </div>
                      </template>
                    </div>
                    <div class="shrink-0" :style="{ width: `${transposeAfterSpacerWidth}px` }" />
                  </div>
                </template>
              </RecycleScroller>
            </div>
            <template v-else>
              <!-- Sticky header -->
              <div ref="headerRef" class="data-grid-header-shell shrink-0 z-10 w-full border-y border-border overflow-hidden">
                <div class="data-grid-header-row flex w-(--header-total-w) font-semibold text-foreground">
                  <div
                    class="data-grid-header-cell shrink-0 px-2 py-1.5 border-r w-(--row-num-w) border-border text-center text-muted-foreground select-none cursor-default hover:bg-gray-200 dark:hover:bg-gray-800 sticky left-0 z-20"
                    :class="{ 'data-grid-header-cell--selected outline outline-primary -outline-offset-1': isSelectingAll }"
                    @click="selectAllCells"
                  >
                    #
                  </div>
                  <div class="shrink-0" :style="{ width: `${horizontalColumnWindow.beforeWidth}px` }" />
                  <LightTooltip v-for="col in renderedGridColumns" :key="`${col.name}-${col.actualColIdx}`" :text="col.name" side="bottom" :side-offset="4" :disabled="columnHeaderTooltipsDisabled">
                    <div
                      class="data-grid-header-cell shrink-0 px-2 py-1.5 border-r border-border whitespace-nowrap hover:bg-gray-200 dark:hover:bg-gray-800 select-none relative overflow-hidden"
                      :class="{
                        'data-grid-header-cell--selected outline outline-primary -outline-offset-1': highlightedColumnIndex === col.actualColIdx || columnIsSelected(col.visibleColIdx),
                        'bg-amber-500/20 ring-1 ring-inset ring-amber-500/40': currentSearchMatch?.kind === 'column' && currentSearchMatch.col === col.actualColIdx,
                        ...columnHeaderDragClass(col.visibleColIdx),
                      }"
                      :style="columnHeaderStyle(col.visibleColIdx)"
                      :data-grid-column-index="col.actualColIdx"
                      :data-visible-col-index="col.visibleColIdx"
                      @pointerdown="startColumnHeaderDrag(col.visibleColIdx, $event)"
                      @click.capture="onHeaderClickCapture"
                      @click="onHeaderClick(col.visibleColIdx, $event)"
                      @contextmenu="onHeaderContext(col.name, col.actualColIdx)"
                    >
                      <span class="flex min-w-0 items-center gap-1 overflow-hidden">
                        <span class="flex min-w-0 flex-1 flex-col overflow-hidden">
                          <span class="min-w-0 truncate leading-4">
                            {{ col.name }}
                          </span>
                          <span v-if="headerColumnType(col.name, col.actualColIdx)" class="min-w-0 truncate text-[10px] font-normal leading-3" :class="typeColorClass(headerColumnType(col.name, col.actualColIdx))" :title="headerColumnType(col.name, col.actualColIdx)">
                            {{ headerColumnType(col.name, col.actualColIdx) }}
                          </span>
                          <span v-if="headerColumnComment(col.name)" class="min-w-0 truncate text-[10px] font-normal leading-3 text-muted-foreground" :title="headerColumnComment(col.name)">
                            {{ headerColumnComment(col.name) }}
                          </span>
                        </span>
                        <span class="flex shrink-0 items-center gap-1" :class="{ 'flex-col !gap-0': columnWidthDensity === 'compact' }">
                          <LightDropdownMenu
                            v-if="headerColumnSortable(col.actualColIdx)"
                            :items="sortMenuItems(col.name, col.actualColIdx)"
                            :open="headerSortMenuOpenColumn === col.actualColIdx"
                            :selected-value="selectedSortMenuValue(col.name, col.actualColIdx)"
                            align="end"
                            content-class="w-max min-w-28 p-0.5"
                            item-class="gap-1 px-1.5 py-0.5 text-xs"
                            item-icon-class="h-3 w-3"
                            :match-trigger-width="false"
                            @update:open="(value: boolean) => (headerSortMenuOpenColumn = value ? col.actualColIdx : null)"
                            @select="(value: string) => selectHeaderSort(value, col.name, col.actualColIdx)"
                          >
                            <template #trigger="{ open, toggle }">
                              <button
                                type="button"
                                class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-800 hover:text-foreground"
                                :class="columnIsSorted(col.name, col.actualColIdx) ? 'text-primary opacity-100' : 'opacity-80'"
                                :title="t('grid.sort')"
                                :aria-expanded="open"
                                @mousedown.stop
                                @click.stop="toggle"
                              >
                                <ArrowUp v-if="columnIsSorted(col.name, col.actualColIdx) && sortDir === 'asc'" class="h-3 w-3 shrink-0" />
                                <ArrowDown v-else-if="columnIsSorted(col.name, col.actualColIdx) && sortDir === 'desc'" class="h-3 w-3 shrink-0" />
                                <ArrowUpDown v-else class="h-3 w-3 shrink-0" />
                              </button>
                            </template>
                          </LightDropdownMenu>
                          <LightDropdownMenu
                            v-if="compactColumnHeaderActions"
                            :items="compactColumnActionMenuItems(col.name)"
                            :open="headerActionMenuOpenColumn === col.actualColIdx"
                            align="end"
                            content-class="w-max min-w-28 max-w-48 p-0.5"
                            item-class="gap-1 px-1.5 py-0.5 text-xs"
                            item-icon-class="h-3 w-3"
                            :match-trigger-width="false"
                            @update:open="(value: boolean) => (headerActionMenuOpenColumn = value ? col.actualColIdx : null)"
                            @select="(value: string) => selectCompactColumnAction(value, col.actualColIdx)"
                          >
                            <template #trigger="{ open, toggle }">
                              <button
                                type="button"
                                class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-800 hover:text-foreground"
                                :class="columnHasFormatter(col.actualColIdx) || localFilterActive(col.actualColIdx) ? 'text-primary opacity-90' : 'opacity-80'"
                                :title="t('grid.columnActions')"
                                :aria-expanded="open"
                                @click.stop="toggle"
                              >
                                <ChevronDown class="h-3 w-3" />
                              </button>
                            </template>
                          </LightDropdownMenu>
                          <Popover :open="formatterOpenColumn === col.actualColIdx" @update:open="(value: boolean) => handleColumnFormatterOpenChange(value, col.actualColIdx)">
                            <PopoverAnchor v-if="compactColumnHeaderActions" as-child>
                              <span class="pointer-events-none absolute right-3 top-1/2 h-px w-px -translate-y-1/2" />
                            </PopoverAnchor>
                            <PopoverTrigger v-else as-child>
                              <button
                                type="button"
                                class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-800 hover:text-foreground"
                                :class="columnHasFormatter(col.actualColIdx) ? 'text-primary opacity-100' : 'opacity-80'"
                                :disabled="!formatterKeyForColumn(col.name)"
                                :title="t('grid.columnFormatter')"
                                @click.stop
                              >
                                <Code2 class="h-3.5 w-3.5" />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent align="start" side="bottom" class="w-[420px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-xl" @click.stop @keydown.stop>
                              <div class="border-b bg-muted/40 px-3 py-2">
                                <div class="text-sm font-semibold">
                                  {{ t("grid.columnFormatterFor", { column: col.name }) }}
                                </div>
                                <div class="mt-0.5 text-[11px] text-muted-foreground">
                                  {{ t("grid.columnFormatterHint") }}
                                </div>
                              </div>
                              <div class="space-y-3 p-3">
                                <div class="space-y-1.5">
                                  <div class="text-xs font-medium text-muted-foreground">
                                    {{ t("grid.formatterType") }}
                                  </div>
                                  <Select :model-value="formatterKind" @update:model-value="(value: any) => (formatterKind = value)">
                                    <SelectTrigger class="h-8 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="datetime">{{ t("grid.formatterDatetime") }}</SelectItem>
                                      <SelectItem value="json-path">{{ t("grid.formatterJsonPath") }}</SelectItem>
                                      <SelectItem value="mask">{{ t("grid.formatterMask") }}</SelectItem>
                                      <SelectItem value="custom-template">{{ t("grid.formatterCustomTemplate") }}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div v-if="formatterKind === 'datetime'" class="flex gap-2">
                                  <div class="space-y-1.5">
                                    <div class="text-xs font-medium text-muted-foreground">
                                      {{ t("grid.formatterTimestampUnit") }}
                                    </div>
                                    <Select :model-value="formatterDateUnit" @update:model-value="(value: any) => (formatterDateUnit = value)">
                                      <SelectTrigger class="h-8 text-xs">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="auto">{{ t("grid.formatterUnitAuto") }}</SelectItem>
                                        <SelectItem value="seconds">{{ t("grid.formatterUnitSeconds") }}</SelectItem>
                                        <SelectItem value="milliseconds">{{ t("grid.formatterUnitMilliseconds") }}</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div class="space-y-1.5 flex-1">
                                    <div class="text-xs font-medium text-muted-foreground">
                                      {{ t("grid.formatterDatetimePattern") }}
                                    </div>
                                    <SearchableSelect
                                      :model-value="formatterDatetimePattern"
                                      :options="DateTimePatterns"
                                      :placeholder="t('grid.formatterDatetimePatternPlaceholder')"
                                      :search-placeholder="t('grid.formatterDatetimePatternPlaceholder')"
                                      :empty-text="t('grid.formatterDatetimePatternEmpty')"
                                      :loading-text="t('common.loading')"
                                      :allow-custom="true"
                                      :trigger-class="['border border-input h-8 w-72 pl-2.5 text-xs']"
                                      content-class="w-72"
                                      item-class="h-auto min-h-8 px-2 py-1.5 text-xs"
                                      @update:model-value="(value: any) => (formatterDatetimePattern = value)"
                                    />
                                  </div>
                                </div>

                                <div v-else-if="formatterKind === 'json-path'" class="space-y-1.5">
                                  <div class="text-xs font-medium text-muted-foreground">
                                    {{ t("grid.formatterJsonPathInput") }}
                                  </div>
                                  <input v-model="formatterJsonPath" autocapitalize="off" autocorrect="off" spellcheck="false" class="h-8 w-full rounded border bg-background px-2 font-mono text-xs outline-none focus:border-primary" placeholder="$.user.name" />
                                </div>

                                <div v-else-if="formatterKind === 'mask'" class="grid grid-cols-2 gap-2">
                                  <label class="space-y-1.5">
                                    <span class="text-xs font-medium text-muted-foreground">
                                      {{ t("grid.formatterMaskPrefix") }}
                                    </span>
                                    <input v-model.number="formatterMaskPrefix" type="number" min="0" class="h-8 w-full rounded border bg-background px-2 text-xs outline-none focus:border-primary" />
                                  </label>
                                  <label class="space-y-1.5">
                                    <span class="text-xs font-medium text-muted-foreground">
                                      {{ t("grid.formatterMaskSuffix") }}
                                    </span>
                                    <input v-model.number="formatterMaskSuffix" type="number" min="0" class="h-8 w-full rounded border bg-background px-2 text-xs outline-none focus:border-primary" />
                                  </label>
                                </div>

                                <div v-else class="space-y-2">
                                  <div v-if="savedCustomFormatters.length" class="space-y-1.5">
                                    <div class="text-xs font-medium text-muted-foreground">
                                      {{ t("grid.formatterSavedCustom") }}
                                    </div>
                                    <Select :model-value="formatterCustomId" @update:model-value="(value: any) => selectCustomFormatter(String(value))">
                                      <SelectTrigger class="h-8 text-xs">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem :value="CUSTOM_FORMATTER_NEW">{{ t("grid.formatterNewCustom") }}</SelectItem>
                                        <SelectItem v-for="formatter in savedCustomFormatters" :key="formatter.id" :value="formatter.id">
                                          {{ formatter.name }}
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <label class="block space-y-1.5">
                                    <span class="text-xs font-medium text-muted-foreground">
                                      {{ t("grid.formatterCustomName") }}
                                    </span>
                                    <input v-model="formatterCustomName" class="h-8 w-full rounded border bg-background px-2 text-xs outline-none focus:border-primary" :placeholder="t('grid.formatterCustomNamePlaceholder')" />
                                  </label>
                                  <label class="block space-y-1.5">
                                    <span class="text-xs font-medium text-muted-foreground">
                                      {{ t("grid.formatterCustomTemplateInput") }}
                                    </span>
                                    <input v-model="formatterCustomTemplate" autocapitalize="off" autocorrect="off" spellcheck="false" class="h-8 w-full rounded border bg-background px-2 font-mono text-xs outline-none focus:border-primary" placeholder="ID-${value}" />
                                  </label>
                                  <div class="text-[11px] leading-4 text-muted-foreground">
                                    {{ t("grid.formatterCustomTemplateHint") }}
                                  </div>
                                </div>

                                <div class="space-y-1.5">
                                  <div class="text-xs font-medium text-muted-foreground">
                                    {{ t("grid.formatterPreview") }}
                                  </div>
                                  <div class="max-h-40 overflow-auto rounded border bg-muted/20">
                                    <div v-for="row in formatterPreviewRows(col.actualColIdx)" :key="row.index" class="grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b px-2 py-1.5 text-[11px] last:border-b-0">
                                      <span class="text-muted-foreground">{{ row.index }}</span>
                                      <span class="truncate font-mono text-muted-foreground">{{ row.raw }}</span>
                                      <span class="truncate font-mono">{{ row.formatted }}</span>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              <div class="flex items-center justify-between gap-2 border-t bg-muted/30 px-3 py-2">
                                <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="!columnHasFormatter(col.actualColIdx)" @click="clearColumnFormatter(col.actualColIdx)">
                                  {{ t("grid.clearFormatter") }}
                                </Button>
                                <div class="flex items-center gap-2">
                                  <Button variant="outline" size="sm" class="h-7 px-2 text-xs" @click="closeColumnFormatter">
                                    {{ t("dangerDialog.cancel") }}
                                  </Button>
                                  <Button size="sm" class="h-7 px-2 text-xs" :disabled="!formatterDraftIsSavable()" @click="saveColumnFormatter(col.actualColIdx)">
                                    {{ t("grid.saveFormatter") }}
                                  </Button>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                          <Popover :open="localFilterOpenColumn === col.actualColIdx" @update:open="(value: boolean) => handleLocalFilterOpenChange(value, col.actualColIdx)">
                            <PopoverAnchor v-if="compactColumnHeaderActions" as-child>
                              <span class="pointer-events-none absolute right-3 top-1/2 h-px w-px -translate-y-1/2" />
                            </PopoverAnchor>
                            <PopoverTrigger v-else as-child>
                              <button
                                type="button"
                                class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-800 hover:text-foreground"
                                :class="localFilterActive(col.actualColIdx) ? 'text-primary opacity-100' : 'opacity-80'"
                                :title="t('grid.localFilter')"
                                @click.stop
                              >
                                <Filter class="h-3.5 w-3.5" />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent align="start" side="bottom" class="w-[300px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-xl" @click.stop @keydown.stop>
                              <div class="border-b bg-muted/40 px-2 py-1.5 text-center text-xs font-semibold">
                                {{ columnFilterPanelTitle(col.name) }}
                              </div>
                              <div class="flex items-center gap-1.5 border-b px-2 py-1.5">
                                <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <input v-model="localFilterSearch" autocapitalize="off" autocorrect="off" spellcheck="false" class="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" :placeholder="t('grid.searchValues')" />
                              </div>
                              <div class="grid grid-cols-[1.75rem_minmax(0,1fr)_3.5rem] border-b bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground">
                                <button type="button" class="flex h-4 w-4 items-center justify-center rounded border" :class="localFilterAllVisibleSelected ? 'border-blue-600 bg-blue-600 text-white' : 'border-border bg-background text-foreground/70'" @click="toggleAllLocalFilterOptions">
                                  <Check v-if="localFilterAllVisibleSelected" class="h-3 w-3 stroke-[3]" />
                                </button>
                                <span>{{ t("grid.value") }}</span>
                                <span class="text-right">{{ t("grid.count") }}</span>
                              </div>
                              <div v-if="localFilterDraft?.mode === 'server' && (serverFilterLoading || serverFilterError || serverFilterLimited)" class="flex items-center gap-1.5 border-b px-2 py-1 text-[11px] text-muted-foreground">
                                <Loader2 v-if="serverFilterLoading" class="h-3 w-3 animate-spin" />
                                <span class="min-w-0 truncate">
                                  <template v-if="serverFilterLoading">{{ t("grid.loadingValues") }}</template>
                                  <template v-else-if="serverFilterError">{{ serverFilterError }}</template>
                                  <template v-else>{{ t("grid.serverValuesLimited", { count: SERVER_COLUMN_FILTER_LIMIT }) }}</template>
                                </span>
                              </div>
                              <div class="max-h-72 overflow-auto py-0.5">
                                <button v-for="option in localFilterOptions" :key="option.key" type="button" class="grid w-full grid-cols-[1.75rem_minmax(0,1fr)_3.5rem] items-center px-2 py-1 text-left text-xs hover:bg-accent" @click="toggleLocalFilterValue(option.key)">
                                  <span class="flex h-4 w-4 items-center justify-center rounded border" :class="localFilterDraft?.values.has(option.key) ? 'border-blue-600 bg-blue-600 text-white' : 'border-border bg-background text-foreground/70'">
                                    <Check v-if="localFilterDraft?.values.has(option.key)" class="h-3 w-3 stroke-[3]" />
                                  </span>
                                  <span class="truncate font-mono" :class="{ 'italic text-muted-foreground': option.value === null }">
                                    {{ option.label }}
                                  </span>
                                  <span class="text-right tabular-nums text-muted-foreground text-xs">{{ option.count ?? "" }}</span>
                                </button>
                                <div v-if="localFilterDraft?.mode === 'local' && localFilterAllOptions.length > localFilterOptions.length" class="px-2 py-0.5 text-center text-[10px] text-muted-foreground">
                                  {{
                                    t("grid.moreValues", {
                                      count: localFilterAllOptions.length - localFilterOptions.length,
                                    })
                                  }}
                                </div>
                                <button v-if="canApplyTypedLocalFilterValue" type="button" class="grid w-full grid-cols-[1.75rem_minmax(0,1fr)] items-center px-2 py-1 text-left text-xs text-primary hover:bg-accent" @click="applyTypedLocalFilterValue">
                                  <Search class="h-3.5 w-3.5" />
                                  <span class="truncate font-mono">
                                    {{ t("grid.filterTypedValue", { value: localFilterTypedValue }) }}
                                  </span>
                                </button>
                                <div v-if="localFilterOptions.length === 0 && !canApplyTypedLocalFilterValue && !serverFilterLoading" class="px-2 py-6 text-center text-xs text-muted-foreground">
                                  {{ t("grid.noSearchResults") }}
                                </div>
                              </div>
                              <div class="flex items-center justify-between gap-2 border-t bg-muted/40 px-2 py-1.5">
                                <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="clearLocalFilter(col.actualColIdx)">
                                  {{ t("grid.clearFilter") }}
                                </Button>
                                <div class="flex items-center gap-2">
                                  <Button variant="outline" size="sm" class="h-7 px-2 text-xs" @click="closeLocalFilter">
                                    {{ t("dangerDialog.cancel") }}
                                  </Button>
                                  <Button size="sm" class="h-7 px-2 text-xs" @click="applyLocalFilter">
                                    {{ t("grid.applyFilter") }}
                                  </Button>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                          <button
                            v-if="!compactColumnHeaderActions && canUseServerColumnFilter"
                            type="button"
                            class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-800 hover:text-foreground"
                            :class="localFilterOpenColumn === col.actualColIdx && localFilterDraft?.mode === 'server' ? 'text-primary opacity-100' : 'opacity-80'"
                            :title="t('grid.databaseValueFilter')"
                            @click.stop="openLocalFilter(col.actualColIdx, 'server')"
                          >
                            <Database class="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </span>
                      <div data-column-resize-handle class="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30" @mousedown.stop="startColumnHeaderResize(col.visibleColIdx, $event)" @click.stop.prevent @dblclick.stop="autoFitColumn(col.visibleColIdx)" />
                    </div>
                    <template #content>
                      <div class="grid min-w-56 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 px-3 py-2">
                        <span class="text-background/70">{{ t("grid.columnName") }}</span>
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="min-w-0 flex-1 truncate font-mono">{{ col.name }}</span>
                          <button type="button" class="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-background/10" :title="t('grid.copyColumnName')" @click.stop="copyText(col.name)">
                            <Copy class="h-3 w-3" />
                          </button>
                        </span>
                        <template v-if="columnTypeMap.get(col.name)">
                          <span class="text-background/70">{{ t("grid.columnType") }}</span>
                          <span :class="typeColorClass(columnTypeMap.get(col.name)!)">{{ columnTypeMap.get(col.name) }}</span>
                        </template>
                        <template v-if="columnCommentMap.get(col.name)">
                          <span class="text-background/70">{{ t("grid.columnComment") }}</span>
                          <span>{{ columnCommentMap.get(col.name) }}</span>
                        </template>
                      </div>
                    </template>
                  </LightTooltip>
                  <div class="shrink-0" :style="{ width: `${horizontalColumnWindow.afterWidth}px` }" />
                  <div v-if="gridScrollbarGutter > 0" class="shrink-0 border-l border-border w-(--grid-scrollbar-gutter)" />
                </div>
              </div>

              <div v-if="!hasVisibleRows" class="relative min-h-0 flex-1">
                <div class="data-grid-scroller h-full overflow-x-auto overflow-y-hidden overscroll-none" :class="{ 'is-scrolling': isScrolling }" @scroll="onScrollerScroll" @wheel="onDomGridWheel">
                  <div class="h-full min-h-[220px]" :style="{ width: 'max(100%, var(--total-w))' }" />
                </div>
                <div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                  <component :is="hasActiveFilter ? SearchX : Inbox" class="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
                  <div class="space-y-1">
                    <div class="text-sm font-medium text-foreground">{{ emptyTitle }}</div>
                    <div class="text-xs">{{ emptyDescription }}</div>
                  </div>
                </div>
              </div>

              <div
                v-else-if="useCanvasGridRows"
                ref="scrollerRef"
                class="data-grid-scroller canvas-grid-scroller flex-1 overflow-auto overscroll-none relative"
                :class="{ 'is-scrolling': isScrolling, 'has-horizontal-scrollbar': hasGridHorizontalOverflow }"
                @scroll="onCanvasScroll"
                @wheel="onCanvasWheel"
              >
                <div class="relative" :style="{ width: `${totalWidth}px`, height: `${canvasContentHeight}px` }">
                  <canvas
                    ref="canvasRef"
                    class="canvas-grid-surface dbx-data-grid-font-family sticky left-0 top-0 z-0 block font-normal"
                    :style="{ width: `${canvasSurfaceWidth}px`, height: `${canvasViewportHeight}px` }"
                    @mousemove="onCanvasMouseMove"
                    @mouseleave="onCanvasMouseLeave"
                    @mousedown="onCanvasMouseDown"
                    @contextmenu="onCanvasContext"
                    @dblclick="onCanvasDblClick"
                  />
                  <div ref="canvasOverlayRef" class="canvas-grid-overlay dbx-data-grid-font-family sticky left-0 top-0 z-10 overflow-visible" :style="canvasOverlayStyle">
                    <div v-if="canvasEditingCell" class="absolute pointer-events-auto z-20 tabular-nums" :style="canvasEditingCellStyle" @mousedown.stop @click.stop>
                      <TemporalCellEditor
                        v-if="temporalEditorConfigForColumn(canvasEditingCell.actualColIdx)"
                        v-model="editValue"
                        :kind="temporalEditorConfigForColumn(canvasEditingCell.actualColIdx)!.kind"
                        :fraction-precision="temporalEditorConfigForColumn(canvasEditingCell.actualColIdx)!.fractionPrecision"
                        @cancel="cancelEdit"
                        @commit="commitGridEdit"
                      />
                      <EnumCellEditor
                        v-else-if="isEnumGridColumn(canvasEditingCell.actualColIdx)"
                        v-model="editValue"
                        :values="enumValuesForGridColumn(canvasEditingCell.actualColIdx)"
                        :nullable="isEnumGridColumnNullable(canvasEditingCell.actualColIdx)"
                        :initial-null="isEnumEditorInitialNull(canvasEditingCell.rowId, canvasEditingCell.actualColIdx)"
                        @cancel="cancelEdit"
                        @commit="commitGridEdit"
                      />
                      <textarea
                        v-else-if="cellUsesExpandedEditor(canvasEditingCell.rowId, canvasEditingCell.actualColIdx)"
                        v-model="editValue"
                        data-expanded-cell-editor="true"
                        rows="1"
                        :inputmode="cellEditInputModeForColumn(canvasEditingCell.actualColIdx)"
                        autocapitalize="off"
                        autocorrect="off"
                        spellcheck="false"
                        class="cell-edit-input cell-edit-input--expanded absolute left-0 top-0 min-h-full bg-background px-2.5 py-1 leading-[18px] outline-none z-10"
                        @blur="commitEditFromCellBlur"
                        @click.stop
                        @focus="onCellEditTextareaInput"
                        @input="onCellEditTextareaInput"
                        @keydown.stop="onCellEditKeydown"
                        @paste.stop="onCellEditTextareaPaste"
                      />
                      <input
                        v-else
                        v-model="editValue"
                        :inputmode="cellEditInputModeForColumn(canvasEditingCell.actualColIdx)"
                        autocapitalize="off"
                        autocorrect="off"
                        spellcheck="false"
                        class="cell-edit-input absolute inset-0 bg-background border-2 border-primary px-2.5 py-0 leading-[22px] outline-none z-10"
                        @blur="commitEditFromCellBlur"
                        @click.stop
                        @input="onCellEditTextareaInput"
                        @keydown.stop="onCellEditKeydown"
                        @paste.stop="onCellEditTextareaPaste"
                      />
                    </div>
                    <div v-if="canvasDetailButtonCell" class="absolute pointer-events-auto z-20 flex items-center gap-1" :style="canvasDetailButtonStyle" @mouseenter="keepCanvasDetailHover" @mouseleave="clearCanvasDetailHover">
                      <LightDropdownMenu
                        v-if="canvasDetailButtonCell.canQuickDownload"
                        :items="binaryCellDownloadMenuItems"
                        :open="quickDownloadMenuOpenFor(canvasDetailButtonCell.rowIndex, canvasDetailButtonCell.actualColIdx)"
                        align="end"
                        content-class="w-44"
                        :match-trigger-width="false"
                        @update:open="(value: boolean) => handleQuickDownloadMenuOpenChange(value, canvasDetailButtonCell!.rowIndex, canvasDetailButtonCell!.actualColIdx)"
                        @select="(mode: string) => downloadCellBinaryValue(canvasDetailButtonCell!.rowIndex, canvasDetailButtonCell!.actualColIdx, mode as BinaryCellDownloadMode)"
                      >
                        <template #trigger="{ open, toggle }">
                          <button class="flex h-5 w-5 items-center justify-center rounded bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border hover:text-foreground" :title="t('grid.downloadBinaryValue')" :aria-expanded="open" @mousedown.stop @click.stop="toggle">
                            <Upload class="h-3 w-3" />
                          </button>
                        </template>
                      </LightDropdownMenu>
                      <button
                        class="flex h-5 w-5 items-center justify-center rounded bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border hover:text-foreground"
                        :title="t('grid.cellDetails')"
                        @mousedown.stop
                        @click.stop="showCellDetailsForVisibleCell(canvasDetailButtonCell.rowIndex, canvasDetailButtonCell.visibleColIdx, canvasDetailButtonCell.actualColIdx)"
                      >
                        <Info class="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                </div>
                <!-- Infinite scroll loading indicator for Canvas -->
                <div v-if="infiniteScrollEnabled && infiniteScrollLoading" class="absolute bottom-0 left-0 right-0 flex items-center justify-center py-2 text-xs text-muted-foreground bg-background/80 backdrop-blur-sm z-10">
                  <Loader2 class="w-3 h-3 animate-spin mr-1" />
                  {{ t("grid.loadingMore") }}
                </div>
              </div>

              <!-- Virtual scrolled rows -->
              <RecycleScroller
                v-else-if="hasVisibleRows"
                ref="scrollerRef"
                class="data-grid-scroller dbx-data-grid-font-family flex-1 overflow-x-auto overscroll-none"
                :class="{ 'is-scrolling': isScrolling, 'has-horizontal-scrollbar': hasGridHorizontalOverflow }"
                :items="displayItems"
                :item-size="26"
                :buffer="600"
                :skip-hover="true"
                key-field="id"
                @scroll="onScrollerScroll"
                @wheel="onDomGridWheel"
              >
                <template #default="{ item }">
                  <div
                    class="data-grid-row flex border-b border-border h-6.5 w-(--total-w)"
                    :class="{
                      'data-grid-row--deleted opacity-70': item.isDeleted,
                      'data-grid-row--new': item.isNew && !isRowActive(item.displayIndex),
                      'data-grid-row--draft': item.isDraft && !isRowActive(item.displayIndex),
                      'data-grid-row--striped': !item.isNew && !item.isDraft && !item.isDeleted && !isRowActive(item.displayIndex) && item.displayIndex % 2 === 1,
                      'active-row': isRowActive(item.displayIndex) && !item.isDeleted,
                      'relative z-20 overflow-visible': editingCell?.rowId === item.id,
                    }"
                    :style="dataGridRowStyle(item)"
                    :data-row-index="item.displayIndex"
                  >
                    <div
                      class="data-grid-row-number w-(--row-num-w) shrink-0 px-2 py-1 border-r text-center select-none cursor-default sticky left-0 z-10"
                      :class="rowNumberStatusClass(item)"
                      @click="handleRowClick(item.displayIndex, item.id, $event)"
                      @dblclick.stop="toggleTranspose(item.displayIndex)"
                      @contextmenu="onRowContext(item.id, item.displayIndex)"
                    >
                      {{ rowNumberText(item) }}
                    </div>
                    <div class="shrink-0" :style="{ width: `${horizontalColumnWindow.beforeWidth}px` }" />
                    <div
                      v-for="col in renderedGridColumns"
                      :key="col.actualColIdx"
                      class="data-grid-cell group/cell shrink-0 px-3 py-1 border-r border-border whitespace-nowrap overflow-hidden text-ellipsis relative select-none inline-block items-center tabular-nums"
                      :style="renderedColumnStyle(col.visibleColIdx)"
                      :class="{
                        'text-muted-foreground italic': isNull(item.data[col.actualColIdx]),
                        'bg-yellow-500/10 cell-dirty': item.isDirtyCol[col.actualColIdx],
                        'cell-selected': cellIsSelected(item.displayIndex, col.visibleColIdx) && !item.isDirtyCol[col.actualColIdx],
                        'cell-selected-dirty': cellIsSelected(item.displayIndex, col.visibleColIdx) && item.isDirtyCol[col.actualColIdx],
                        'row-cell-selected': rowCellsUseSelectionVisual(item.id) && !cellIsSelected(item.displayIndex, col.visibleColIdx) && !item.isDirtyCol[col.actualColIdx],
                        'row-cell-selected-dirty': rowCellsUseSelectionVisual(item.id) && !cellIsSelected(item.displayIndex, col.visibleColIdx) && item.isDirtyCol[col.actualColIdx],
                        'cell-search-match': cellIsSearchMatch(item.displayIndex, col.actualColIdx),
                        'cell-current-search-match': cellIsCurrentMatch(item.displayIndex, col.actualColIdx),
                        'bg-yellow-200/60 dark:bg-yellow-500/20': cellIsSearchMatch(item.displayIndex, col.actualColIdx),
                        'ring-2 ring-inset ring-yellow-500 bg-yellow-300/60 dark:bg-yellow-500/40': cellIsCurrentMatch(item.displayIndex, col.actualColIdx),
                        'tabular-nums': typeof item.data[col.actualColIdx] === 'number',
                        'cursor-text hover:bg-gray-200 dark:hover:bg-gray-800': !isScrolling && canEditCellItem(item, col.actualColIdx),
                        'line-through': item.isDeleted,
                        'overflow-visible z-20 border-r-transparent': editingCell?.rowId === item.id && editingCell?.col === col.actualColIdx,
                        'overflow-hidden': !(editingCell?.rowId === item.id && editingCell?.col === col.actualColIdx),
                      }"
                      @mousedown="
                        prepareDataCellMouseDown(item, col.actualColIdx);
                        handleDataCellMousedown(item.displayIndex, col.visibleColIdx, item.id, $event);
                      "
                      @mouseenter="onCellMouseenter(item.displayIndex, col.visibleColIdx, col.actualColIdx)"
                      @mouseleave="onCellMouseleave(item.displayIndex, col.actualColIdx)"
                      @dblclick="canEditCellItem(item, col.actualColIdx) && startDomCellEdit(item.id, col.actualColIdx, formatCellCached(item.data[col.actualColIdx], col.actualColIdx), $event)"
                      :data-visible-col-index="col.visibleColIdx"
                      @contextmenu="onCellContext(item.id, item.displayIndex, col.actualColIdx, col.visibleColIdx, $event)"
                    >
                      <template v-if="editingCell?.rowId === item.id && editingCell?.col === col.actualColIdx">
                        <TemporalCellEditor
                          v-if="temporalEditorConfigForColumn(col.actualColIdx)"
                          v-model="editValue"
                          :kind="temporalEditorConfigForColumn(col.actualColIdx)!.kind"
                          :fraction-precision="temporalEditorConfigForColumn(col.actualColIdx)!.fractionPrecision"
                          @cancel="cancelEdit"
                          @commit="commitGridEdit"
                        />
                        <EnumCellEditor
                          v-else-if="isEnumGridColumn(col.actualColIdx)"
                          v-model="editValue"
                          :values="enumValuesForGridColumn(col.actualColIdx)"
                          :nullable="isEnumGridColumnNullable(col.actualColIdx)"
                          :initial-null="isEnumEditorInitialNull(item.id, col.actualColIdx)"
                          @cancel="cancelEdit"
                          @commit="commitGridEdit"
                        />
                        <textarea
                          v-else-if="cellUsesExpandedEditor(item.id, col.actualColIdx)"
                          v-model="editValue"
                          data-expanded-cell-editor="true"
                          rows="1"
                          :inputmode="cellEditInputModeForColumn(col.actualColIdx)"
                          autocapitalize="off"
                          autocorrect="off"
                          spellcheck="false"
                          class="cell-edit-input cell-edit-input--expanded absolute left-0 top-0 min-h-full bg-background px-2.5 py-1 leading-[18px] outline-none z-10"
                          @blur="commitEditFromCellBlur"
                          @click.stop
                          @focus="onCellEditTextareaInput"
                          @input="onCellEditTextareaInput"
                          @keydown.stop="onCellEditKeydown"
                          @paste.stop="onCellEditTextareaPaste"
                        />
                        <input
                          v-else
                          v-model="editValue"
                          :inputmode="cellEditInputModeForColumn(col.actualColIdx)"
                          autocapitalize="off"
                          autocorrect="off"
                          spellcheck="false"
                          class="cell-edit-input absolute inset-0 bg-background border-2 border-primary px-2.5 py-0 leading-[22px] outline-none z-10"
                          @blur="commitEditFromCellBlur"
                          @click.stop
                          @input="onCellEditTextareaInput"
                          @keydown.stop="onCellEditKeydown"
                          @paste.stop="onCellEditTextareaPaste"
                        />
                      </template>
                      <template v-else>
                        <template v-if="draftCellPlaceholder(item, col.actualColIdx)">
                          <span class="text-muted-foreground/70 italic">{{ draftCellPlaceholder(item, col.actualColIdx) }}</span>
                        </template>
                        <template v-else>{{ firstLineCellDisplayValue(formatCellCached(item.data[col.actualColIdx], col.actualColIdx)) }}</template>
                        <div v-if="cellDetailButtonVisible(item.displayIndex, col.actualColIdx)" class="absolute right-2 top-0.5 flex items-center gap-1">
                          <LightDropdownMenu
                            v-if="canQuickDownloadCellValue(item.displayIndex, col.actualColIdx)"
                            :items="binaryCellDownloadMenuItems"
                            :open="quickDownloadMenuOpenFor(item.displayIndex, col.actualColIdx)"
                            align="end"
                            content-class="w-44"
                            :match-trigger-width="false"
                            @update:open="(value: boolean) => handleQuickDownloadMenuOpenChange(value, item.displayIndex, col.actualColIdx)"
                            @select="(mode: string) => downloadCellBinaryValue(item.displayIndex, col.actualColIdx, mode as BinaryCellDownloadMode)"
                          >
                            <template #trigger="{ open, toggle }">
                              <button class="flex h-5 w-5 items-center justify-center rounded bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border hover:text-foreground" :title="t('grid.downloadBinaryValue')" :aria-expanded="open" @mousedown.stop @click.stop="toggle">
                                <Upload class="h-3 w-3" />
                              </button>
                            </template>
                          </LightDropdownMenu>
                          <button
                            class="flex h-5 w-5 items-center justify-center rounded bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border hover:text-foreground"
                            :title="t('grid.cellDetails')"
                            @mousedown.stop
                            @click.stop="showCellDetailsForVisibleCell(item.displayIndex, col.visibleColIdx, col.actualColIdx)"
                          >
                            <Info class="h-3 w-3" />
                          </button>
                        </div>
                      </template>
                    </div>
                    <div class="shrink-0" :style="{ width: `${horizontalColumnWindow.afterWidth}px` }" />
                  </div>
                </template>
              </RecycleScroller>
              <!-- Infinite scroll loading indicator for RecycleScroller -->
              <div v-if="infiniteScrollEnabled && infiniteScrollLoading && !loading" class="flex items-center justify-center py-2 text-xs text-muted-foreground">
                <Loader2 class="w-3 h-3 animate-spin mr-1" />
                {{ t("grid.loadingMore") }}
              </div>
              <div v-if="hasGridHorizontalOverflow" ref="gridHorizontalScrollbarTrackRef" class="data-grid-horizontal-scrollbar" @pointerdown="startGridHorizontalScrollbarDrag">
                <div ref="gridHorizontalScrollbarThumbRef" class="data-grid-horizontal-scrollbar__thumb" />
              </div>
              <div v-if="hasGridVerticalOverflow" ref="gridVerticalScrollbarTrackRef" class="data-grid-vertical-scrollbar" @pointerdown="startGridVerticalScrollbarDrag">
                <div ref="gridVerticalScrollbarThumbRef" class="data-grid-vertical-scrollbar__thumb" />
              </div>
              <div v-if="loading" class="absolute inset-0 z-20 bg-background/50 flex items-center justify-center">
                <div class="flex items-center gap-2 px-3 py-1.5 rounded-md bg-background border shadow-sm text-xs text-muted-foreground">
                  <Loader2 class="w-3.5 h-3.5 animate-spin" />
                  <span>{{ formatElapsedSeconds(loadingElapsed) }}s</span>
                </div>
              </div>
            </template>
          </div>
          <!-- Table Info Drawer -->
          <div v-if="showTableInfo" class="table-info-drawer relative col-start-2 row-start-1 border-l flex flex-col bg-background min-w-0" :class="[{ 'row-span-2': cellDetailPanelIsBottom }, { 'ddl-drawer-resizing': isResizingDdl }]" :style="ddlDrawerStyle" @contextmenu="onDrawerContextMenu">
            <div class="absolute left-0 top-0 bottom-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30" @mousedown.prevent="onDdlResizeStart" />
            <div class="flex items-center gap-2 px-3 py-1.5 border-b shrink-0 bg-muted/20 h-9">
              <TableProperties class="w-3.5 h-3.5 text-muted-foreground" />
              <span class="text-xs font-medium flex-1 min-w-0 truncate">{{ tableMeta?.tableName }}</span>
              <div v-if="activeTableInfoTab === 'ddl'" class="table-info-actions flex min-w-0 shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" class="table-info-action-button h-6 px-2 text-xs" :title="t('grid.copyDdl')" :aria-label="t('grid.copyDdl')" @click="copyDdl">
                  <Copy class="w-3 h-3" />
                  <span class="table-info-action-label">{{ t("grid.copyDdl") }}</span>
                </Button>
                <Button variant="ghost" size="icon" class="h-6 w-6" :class="{ 'bg-accent': ddlWrap }" @click="toggleDdlWrap">
                  <WrapText class="w-3 h-3" />
                </Button>
              </div>
              <div v-else-if="activeTableInfoTab === 'indexes' && canManageMongoIndexes" class="table-info-actions flex min-w-0 shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" class="table-info-action-button h-6 px-2 text-xs text-destructive hover:text-destructive" :disabled="indexesLoading || dropAllMongoIndexesLoading || droppableMongoIndexes.length === 0" @click="requestDropAllMongoIndexes">
                  <Trash2 class="w-3 h-3" />
                  <span class="table-info-action-label">{{ t("contextMenu.dropAllIndexes") }}</span>
                </Button>
              </div>
              <Button v-if="canOpenTableStructureEditor" variant="ghost" size="sm" class="table-info-action-button h-6 px-2 text-xs" :title="t('contextMenu.editStructure')" :aria-label="t('contextMenu.editStructure')" @click="openTableStructureEditor">
                <Columns3Cog class="w-3 h-3" />
                <span class="table-info-action-label">{{ t("contextMenu.editStructure") }}</span>
              </Button>
              <Button variant="ghost" size="icon" class="h-5 w-5" @click="showTableInfo = false">
                <X class="w-3 h-3" />
              </Button>
            </div>
            <div class="grid border-b bg-background shrink-0" :style="tableInfoTabListStyle">
              <button
                v-for="tab in tableInfoTabs"
                :key="tab.id"
                class="h-9 min-w-0 px-1.5 text-[11px] border-b-2 transition-colors"
                :class="activeTableInfoTab === tab.id ? 'border-primary bg-gray-300/80 text-foreground dark:bg-gray-700/80' : 'border-transparent text-muted-foreground hover:bg-gray-200 hover:text-foreground dark:hover:bg-gray-800/50'"
                :title="tab.label"
                @click="selectTableInfoTab(tab.id)"
              >
                <component :is="tab.icon" class="mx-auto h-3.5 w-3.5" />
                <span class="block truncate">{{ tab.label }}</span>
              </button>
            </div>

            <div class="px-2 py-1.5 border-b shrink-0 bg-background">
              <div class="relative">
                <Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input v-model="searchQuery" :placeholder="t('grid.tableInfoSearch')" class="w-full h-7 pl-7 pr-6 text-xs bg-muted/50 rounded border border-border focus:outline-none focus:border-primary/50" @keydown.escape="searchQuery = ''" />
                <button v-if="searchQuery" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="searchQuery = ''">
                  <X class="w-3 h-3" />
                </button>
              </div>
            </div>

            <div v-if="activeTableInfoTab === 'columns'" class="flex-1 min-h-0 overflow-auto">
              <div v-if="searchQuery && filteredColumns.length === 0" class="p-6 text-center text-xs text-muted-foreground">
                {{ t("grid.tableInfoNoResults") }}
              </div>
              <table v-else class="w-full text-xs">
                <thead class="sticky top-0 bg-muted text-muted-foreground">
                  <tr class="border-b">
                    <th class="text-left text-nowrap font-medium px-3 py-2 w-8">#</th>
                    <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("grid.columnName") }}</th>
                    <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("grid.columnType") }}</th>
                    <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("grid.tableInfoNullable") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(column, index) in filteredColumns"
                    :key="column.name"
                    class="border-b cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-800/30"
                    role="button"
                    tabindex="0"
                    :title="column.name"
                    @click="scrollToTableInfoColumn(column.name)"
                    @keydown.enter.prevent="scrollToTableInfoColumn(column.name)"
                    @keydown.space.prevent="scrollToTableInfoColumn(column.name)"
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
                    <td class="px-3 py-2 font-mono text-[11px] text-muted-foreground">{{ column.data_type }}</td>
                    <td class="px-3 py-2">{{ column.is_nullable ? "YES" : "NO" }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div v-else-if="activeTableInfoTab === 'indexes'" class="flex-1 min-h-0 overflow-auto">
              <div v-if="indexesLoading" class="h-full flex items-center justify-center">
                <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
              <div v-else-if="indexesError" class="p-3 text-xs text-destructive">{{ indexesError }}</div>
              <div v-else-if="searchQuery && filteredIndexes.length === 0" class="p-6 text-center text-xs text-muted-foreground">
                {{ t("grid.tableInfoNoResults") }}
              </div>
              <div v-else-if="indexes.length === 0" class="p-6 text-center text-xs text-muted-foreground">
                {{ t("grid.tableInfoEmpty") }}
              </div>
              <div v-else class="divide-y">
                <div v-for="index in filteredIndexes" :key="index.name" class="p-3 text-xs">
                  <div class="flex items-start gap-2">
                    <div class="min-w-0 flex-1">
                      <div class="font-medium truncate">{{ index.name }}</div>
                      <div class="mt-1 flex flex-wrap gap-1">
                        <span v-if="index.is_primary" class="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600">PK</span>
                        <span v-if="index.is_unique" class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600">UNIQUE</span>
                        <span v-if="index.index_type" class="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{{ index.index_type }}</span>
                      </div>
                      <div class="mt-2 font-mono text-[11px] text-muted-foreground break-all">
                        {{ index.columns.join(", ") }}
                      </div>
                    </div>
                    <Button v-if="canManageMongoIndexes && !index.is_primary" variant="ghost" size="sm" class="h-7 shrink-0 px-2 text-[11px] text-destructive hover:text-destructive" @click="requestDropMongoIndex(index)">
                      <Trash2 class="mr-1 h-3 w-3" />
                      {{ t("contextMenu.dropIndex") }}
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <div v-else-if="activeTableInfoTab === 'foreignKeys'" class="flex-1 min-h-0 overflow-auto">
              <div v-if="foreignKeysLoading" class="h-full flex items-center justify-center">
                <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
              <div v-else-if="foreignKeysError" class="p-3 text-xs text-destructive">{{ foreignKeysError }}</div>
              <div v-else-if="searchQuery && filteredForeignKeys.length === 0" class="p-6 text-center text-xs text-muted-foreground">
                {{ t("grid.tableInfoNoResults") }}
              </div>
              <div v-else-if="foreignKeys.length === 0" class="p-6 text-center text-xs text-muted-foreground">
                {{ t("grid.tableInfoEmpty") }}
              </div>
              <div v-else class="divide-y">
                <div v-for="fk in filteredForeignKeys" :key="`${fk.name}:${fk.column}`" class="p-3 text-xs">
                  <div class="font-medium truncate">{{ fk.name }}</div>
                  <div class="mt-1 font-mono text-[11px] text-muted-foreground break-all">{{ fk.column }} -> {{ fk.ref_table }}.{{ fk.ref_column }}</div>
                </div>
              </div>
            </div>

            <div v-else-if="activeTableInfoTab === 'triggers'" class="flex-1 min-h-0 overflow-auto">
              <div v-if="triggersLoading" class="h-full flex items-center justify-center">
                <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
              <div v-else-if="triggersError" class="p-3 text-xs text-destructive">{{ triggersError }}</div>
              <div v-else-if="searchQuery && filteredTriggers.length === 0" class="p-6 text-center text-xs text-muted-foreground">
                {{ t("grid.tableInfoNoResults") }}
              </div>
              <div v-else-if="triggers.length === 0" class="p-6 text-center text-xs text-muted-foreground">
                {{ t("grid.tableInfoEmpty") }}
              </div>
              <div v-else class="divide-y">
                <div v-for="trigger in filteredTriggers" :key="trigger.name" class="p-3 text-xs">
                  <div class="font-medium truncate">{{ trigger.name }}</div>
                  <div class="mt-1 text-[11px] text-muted-foreground">{{ trigger.timing }} {{ trigger.event }}</div>
                </div>
              </div>
            </div>

            <pre
              v-else-if="activeTableInfoTab === 'ddl' && !ddlLoading"
              ref="ddlPreRef"
              data-native-clipboard
              tabindex="0"
              class="flex-1 min-w-0 text-xs font-mono p-3 overflow-auto ddl-code leading-5 select-text outline-none"
              :class="ddlWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
              v-html="filteredDdlContent"
              @keydown="onDdlKeydown"
            ></pre>
            <div v-else class="flex-1 flex items-center justify-center">
              <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          </div>
          <!-- Cell Detail Drawer -->
          <div
            v-if="showCellDetail && activeCellDetail"
            class="relative flex flex-col bg-background min-w-0"
            :class="[cellDetailPanelIsBottom ? 'col-start-1 row-start-2 border-t' : 'col-start-3 row-start-1 border-l', { 'detail-drawer-resizing': isResizingDetail }]"
            :style="detailPanelStyle"
            @contextmenu="onDrawerContextMenu"
          >
            <div v-if="!cellDetailPanelIsBottom" class="absolute left-0 top-0 bottom-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30" @mousedown.prevent="onDetailResizeStart" />
            <div v-else class="absolute left-0 right-0 top-0 z-20 h-1.5 -translate-y-1/2 cursor-row-resize hover:bg-primary/30" @mousedown.prevent="onDetailResizeStart" />
            <div class="h-9 flex items-center gap-2 px-3 border-b shrink-0 bg-muted/20">
              <Info class="w-3.5 h-3.5 text-muted-foreground" />
              <span class="text-xs font-medium flex-1 min-w-0 truncate">{{ t("grid.cellDetails") }}</span>
              <Button variant="ghost" size="icon" class="h-5 w-5" :title="cellDetailPanelIsBottom ? t('grid.cellDetailLayoutRight') : t('grid.cellDetailLayoutBottom')" @click="toggleCellDetailPanelLayout">
                <PanelRight v-if="cellDetailPanelIsBottom" class="w-3 h-3" />
                <PanelBottom v-else class="w-3 h-3" />
              </Button>
              <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.openCellDetailsDialog')" @click="openActiveCellDetailDialog">
                <Maximize2 class="w-3 h-3" />
              </Button>
              <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.openRowDetailsDialog')" @click="openActiveRowDetailDialog">
                <ListTree class="w-3 h-3" />
              </Button>
              <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.openColumnDetailsDialog')" @click="openActiveColumnDetailDialog">
                <TableProperties class="w-3 h-3" />
              </Button>
              <Button variant="ghost" size="icon" class="h-5 w-5" @click="closeCellDetails">
                <X class="w-3 h-3" />
              </Button>
            </div>

            <Tabs v-model="activeCellDetailTab" class="flex-1 min-h-0 gap-0">
              <div class="shrink-0 border-b px-3 py-2">
                <TabsList class="grid h-7 w-full p-0.5" :class="activeCellDetailTabsGridClass">
                  <TabsTrigger value="details" class="h-6 text-xs">{{ t("grid.cellDetails") }}</TabsTrigger>
                  <TabsTrigger v-if="activeCellDetailTabs.includes('hexViewer')" value="hexViewer" class="h-6 text-xs">
                    {{ t("grid.hexViewer") }}
                  </TabsTrigger>
                  <TabsTrigger v-if="activeCellDetailTabs.includes('valueEditor')" value="valueEditor" class="h-6 text-xs">
                    {{ t("grid.valueEditor") }}
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="details" class="m-0 min-h-0 flex-1 flex flex-col">
                <div data-native-clipboard class="flex-1 min-h-0 overflow-auto px-3 pt-3 text-xs" :class="[sideDetailValueFillsHeight ? 'flex flex-col gap-3' : 'space-y-3', isEditingDetail && !cellDetailPanelIsBottom ? 'pb-1' : 'pb-3']">
                  <div v-if="cellDetailPanelIsBottom" class="grid grid-cols-[minmax(180px,1.6fr)_repeat(4,minmax(74px,0.55fr))_minmax(160px,1fr)] gap-3 rounded border bg-muted/20 p-2">
                    <div class="min-w-0 space-y-1">
                      <div class="text-muted-foreground">{{ t("grid.columnName") }}</div>
                      <div class="truncate font-medium" :title="activeCellDetail.column">
                        {{ activeCellDetail.column }}
                      </div>
                    </div>
                    <div class="space-y-1">
                      <div class="text-muted-foreground">{{ t("grid.rowNumber") }}</div>
                      <div>{{ activeCellDetail.rowNumber }}</div>
                    </div>
                    <div class="min-w-0 space-y-1">
                      <div class="text-muted-foreground">{{ t("grid.columnType") }}</div>
                      <div class="truncate" :class="activeCellDetail.type ? typeColorClass(activeCellDetail.type) : 'text-muted-foreground'" :title="activeCellDetail.type || '-'">
                        {{ activeCellDetail.type || "-" }}
                      </div>
                    </div>
                    <div class="space-y-1">
                      <div class="text-muted-foreground">{{ t("grid.nullValue") }}</div>
                      <div>{{ activeCellDetail.value === null ? "true" : "false" }}</div>
                    </div>
                    <div class="space-y-1">
                      <div class="text-muted-foreground">{{ t("grid.valueLength") }}</div>
                      <div>{{ activeCellDetail.length }}</div>
                    </div>
                    <div class="min-w-0 space-y-1">
                      <div class="text-muted-foreground">{{ t("grid.columnComment") }}</div>
                      <div class="truncate" :title="activeCellDetail.comment || t('grid.noComment')">
                        {{ activeCellDetail.comment || t("grid.noComment") }}
                      </div>
                    </div>
                  </div>
                  <template v-else-if="!isEditingDetail && !sideDetailPrioritizesValue">
                    <div class="space-y-1">
                      <div class="text-muted-foreground">{{ t("grid.columnName") }}</div>
                      <div class="font-medium break-all">{{ activeCellDetail.column }}</div>
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                      <div class="space-y-1">
                        <div class="text-muted-foreground">{{ t("grid.rowNumber") }}</div>
                        <div>{{ activeCellDetail.rowNumber }}</div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-muted-foreground">{{ t("grid.columnType") }}</div>
                        <div :class="activeCellDetail.type ? typeColorClass(activeCellDetail.type) : 'text-muted-foreground'">
                          {{ activeCellDetail.type || "-" }}
                        </div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-muted-foreground">{{ t("grid.nullValue") }}</div>
                        <div>{{ activeCellDetail.value === null ? "true" : "false" }}</div>
                      </div>
                      <div class="space-y-1">
                        <div class="text-muted-foreground">{{ t("grid.valueLength") }}</div>
                        <div>{{ activeCellDetail.length }}</div>
                      </div>
                    </div>
                    <div class="space-y-1">
                      <div class="text-muted-foreground">{{ t("grid.columnComment") }}</div>
                      <div class="whitespace-pre-wrap break-words">
                        {{ activeCellDetail.comment || t("grid.noComment") }}
                      </div>
                    </div>
                  </template>
                  <div class="space-y-1" :class="[{ 'min-h-0 flex flex-col': sideDetailValueFillsHeight }, sideDetailValueFillsHeight && !(activeCellDetail.imagePreviewUrl && !isEditingDetail) ? 'flex-1' : '', activeCellDetail.imagePreviewUrl && !isEditingDetail ? 'shrink-0' : '']">
                    <div class="flex min-h-5 items-center justify-between gap-2">
                      <div class="text-muted-foreground">{{ t("grid.cellValue") }}</div>
                      <div class="flex items-center gap-1">
                        <Button v-if="showCompactDetailJson" variant="ghost" size="sm" class="h-5 gap-1 px-1.5 text-xs" :disabled="!canCompactDetailJson" :title="t('grid.compactJson')" @click="compactDetailJson">
                          <Code2 class="h-3 w-3" />
                          {{ t("grid.compactJson") }}
                        </Button>
                        <Button v-if="!isEditingDetail && activeCellDetail.formattedJson" :variant="sideDetailJsonView ? 'secondary' : 'ghost'" size="sm" class="h-5 gap-1 px-1.5 text-xs" :title="t('grid.formattedJson')" @click="toggleCellDetailJsonFormatted">
                          <Code2 class="h-3 w-3" />
                          {{ t("grid.formattedJson") }}
                        </Button>
                        <Button v-if="!isEditingDetail && activeCellDetail.isEditable" variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.editValue')" @click="startDetailEdit">
                          <Pencil class="h-3 w-3" />
                        </Button>
                        <Button v-if="!isEditingDetail" variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.copyValue')" @click="copyDetailCurrentValue">
                          <Copy class="h-3 w-3" />
                        </Button>
                        <DropdownMenu v-if="!isEditingDetail && canDownloadDetailBinaryValue(activeCellDetail)">
                          <DropdownMenuTrigger as-child>
                            <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.downloadBinaryValue')">
                              <Upload class="h-3 w-3" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" class="w-44">
                            <DropdownMenuItem v-for="mode in BINARY_CELL_DOWNLOAD_MODES" :key="mode" @click="downloadDetailBinaryValue(activeCellDetail, mode)">
                              {{ t(`grid.binaryDownload.${mode}`) }}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <!-- Skip hex fallback from backend (unsupported geometry types like TIN/Triangle) -->
                        <Popover v-if="isGeometryColumnType(activeCellDetail.type) && activeCellDetail.value !== null && !isEditingDetail && !isHexGeometry(activeCellDetail.value as string)" v-model:open="sideGeometryPreviewOpen">
                          <PopoverTrigger as-child>
                            <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('grid.geometryPreview')">
                              <Eye class="h-3 w-3" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent class="w-auto p-1.5" align="end">
                            <canvas v-show="sideGeometryPreviewOpen" ref="sideGeometryCanvas" width="400" height="280" class="block rounded" />
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>
                    <div v-if="activeCellDetail.imagePreviewUrl && !isEditingDetail" class="shrink-0 space-y-1.5">
                      <div class="text-muted-foreground">{{ t("grid.imagePreview") }}</div>
                      <a :href="activeCellDetail.imagePreviewUrl" role="button" class="flex overflow-hidden rounded border bg-muted/20" :class="cellDetailPanelIsBottom ? 'max-h-28' : 'max-h-40'" @click.prevent="openImagePreview(activeCellDetail.imagePreviewUrl, activeCellDetail.column)">
                        <img :src="activeCellDetail.imagePreviewUrl" :alt="activeCellDetail.column" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="max-h-full w-full object-contain" />
                      </a>
                    </div>
                    <template v-if="isEditingDetail">
                      <div class="min-h-0 flex-1" :style="sideDetailEditorStyle">
                        <TemporalCellEditor
                          v-if="detailTemporalEditorConfig"
                          v-model="detailEditValue"
                          :kind="detailTemporalEditorConfig.kind"
                          :fraction-precision="detailTemporalEditorConfig.fractionPrecision"
                          variant="inline"
                          :commit-on-close="false"
                          @cancel="cancelDetailEdit"
                          @commit="commitDetailEdit"
                        />
                        <div v-else ref="detailsEditorContainer" data-cell-detail-editor-root class="min-h-0 h-full w-full rounded border overflow-hidden" />
                      </div>
                      <div v-if="!cellDetailPanelIsBottom" class="flex shrink-0 gap-1 py-0.5">
                        <Button size="sm" class="h-6 text-xs" @click="commitDetailEdit">
                          {{ t("dangerDialog.confirm") }}
                        </Button>
                        <Button variant="outline" size="sm" class="h-6 text-xs" @click="cancelDetailEdit">
                          {{ t("dangerDialog.cancel") }}
                        </Button>
                      </div>
                    </template>
                    <div
                      v-else-if="activeCellDetail.formattedJson"
                      ref="sideJsonPreviewContainer"
                      data-cell-detail-editor-root
                      class="overflow-hidden rounded border bg-muted/20 p-2"
                      :class="[{ 'cursor-text': activeCellDetail.isEditable }, sideDetailValueFillsHeight ? 'min-h-0 flex-1' : 'h-72 max-h-[42vh]']"
                      @dblclick.capture="startDetailEdit"
                    />
                    <pre
                      v-else
                      class="overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-words cursor-pointer hover:border-primary/50"
                      :class="[{ 'cursor-text': activeCellDetail.isEditable }, cellDetailPanelIsBottom && activeCellDetail.imagePreviewUrl ? 'min-h-24 max-h-32 shrink-0' : '', sideDetailValueFillsHeight && !activeCellDetail.imagePreviewUrl ? 'min-h-0 flex-1' : '']"
                      @dblclick="startDetailEdit"
                      >{{ activeCellDetail.rawValuePreview }}</pre
                    >
                    <div v-if="activeCellDetail.isValuePreviewTruncated && !sideDetailJsonView" class="text-[11px] text-muted-foreground">
                      {{
                        t("grid.largeValuePreviewHint", {
                          count: activeCellDetail.rawValuePreview.length,
                        })
                      }}
                    </div>
                  </div>
                </div>

                <div class="border-t flex gap-1 overflow-hidden bg-background p-1.5" :class="cellDetailPanelIsBottom ? 'shrink-0 items-center' : 'shrink-0 flex-col'">
                  <div v-if="isEditingDetail && cellDetailPanelIsBottom" class="flex shrink-0 gap-1 mr-auto">
                    <Button size="sm" class="h-6 text-xs" @click="commitDetailEdit">
                      {{ t("dangerDialog.confirm") }}
                    </Button>
                    <Button variant="outline" size="sm" class="h-6 text-xs" @click="cancelDetailEdit">
                      {{ t("dangerDialog.cancel") }}
                    </Button>
                  </div>
                  <div class="flex gap-1" :class="cellDetailPanelIsBottom ? 'ml-auto shrink-0 justify-end' : 'flex-col'">
                    <Button v-if="activeCellDetail.isEditable && activeCellDetail.value !== null" variant="ghost" size="sm" class="h-6 justify-start text-xs" @click="setDetailNull"> <X class="w-3 h-3 mr-2" /> {{ t("grid.setNull") }} </Button>
                    <Button variant="ghost" size="sm" class="h-6 justify-start text-xs" @click="copyDetailColumnName"> <Copy class="w-3 h-3 mr-2" /> {{ t("grid.copyColumnName") }} </Button>
                    <Button variant="ghost" size="sm" class="h-6 justify-start text-xs" :disabled="!canCopyPreparedDetailSqlCondition()" @click="copyDetailSqlCondition"> <Code2 class="w-3 h-3 mr-2" /> {{ t("grid.copySqlCondition") }} </Button>
                  </div>
                </div>
              </TabsContent>

              <TabsContent v-if="activeCellDetailTabs.includes('hexViewer')" value="hexViewer" class="m-0 min-h-0 flex-1 flex flex-col p-3 text-xs">
                <div class="mb-2 min-w-0 shrink-0">
                  <div class="font-medium">{{ t("grid.hexViewer") }}</div>
                  <div class="text-[11px] text-muted-foreground">{{ t("grid.hexViewerByteCount", { count: activeBinaryHexByteCount }) }}</div>
                </div>
                <div class="min-h-0 flex-1 overflow-auto rounded border bg-muted/20 font-mono text-[11px]">
                  <div class="sticky top-0 grid grid-cols-[5.5rem_minmax(24rem,1fr)_8rem] gap-3 border-b bg-muted px-2 py-1 font-semibold text-muted-foreground">
                    <div>{{ t("grid.hexViewerOffset") }}</div>
                    <div>{{ t("grid.hexViewerHex") }}</div>
                    <div>{{ t("grid.hexViewerAscii") }}</div>
                  </div>
                  <div v-for="row in activeBinaryHexRows" :key="row.offset" class="grid grid-cols-[5.5rem_minmax(24rem,1fr)_8rem] gap-3 border-b border-border/50 px-2 py-1 last:border-b-0">
                    <div class="select-all text-muted-foreground">{{ row.offset }}</div>
                    <div class="select-all whitespace-pre">{{ row.hex }}</div>
                    <div class="select-all whitespace-pre">{{ row.ascii }}</div>
                  </div>
                  <div v-if="activeBinaryHexRows.length === 0" class="px-2 py-6 text-center font-sans text-muted-foreground">
                    {{ t("grid.hexViewerEmpty") }}
                  </div>
                </div>
              </TabsContent>

              <TabsContent v-if="activeCellDetailTabs.includes('valueEditor')" value="valueEditor" class="m-0 min-h-0 flex-1 flex flex-col p-3 text-xs">
                <div class="flex min-h-0 flex-1 flex-col">
                  <TemporalCellEditor
                    v-if="detailTemporalEditorConfig"
                    v-model="detailEditValue"
                    :kind="detailTemporalEditorConfig.kind"
                    :fraction-precision="detailTemporalEditorConfig.fractionPrecision"
                    variant="inline"
                    :commit-on-close="false"
                    @cancel="cancelValueEditorEdit"
                    @commit="commitValueEditorEdit"
                  />
                  <div v-else ref="valueEditorContainer" data-cell-detail-editor-root class="min-h-0 flex-1 w-full rounded border overflow-auto" />
                </div>
                <div class="flex gap-1 mt-2 shrink-0">
                  <Button v-if="activeValueEditorActions.includes('formatJson')" variant="outline" size="sm" class="h-6 text-xs" @mousedown.prevent @click="formatValueEditorJson">
                    {{ t("grid.formatJson") }}
                  </Button>
                  <Button v-if="activeValueEditorActions.includes('setNull')" variant="outline" size="sm" class="h-6 text-xs" @mousedown.prevent @click="setValueEditorNull">
                    {{ t("grid.setNull") }}
                  </Button>
                  <Button v-if="activeValueEditorActions.includes('restoreOriginal')" variant="outline" size="sm" class="h-6 text-xs" @mousedown.prevent @click="restoreDetailOriginalValue">
                    {{ t("grid.restoreOriginalValue") }}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </div>
          <!-- MongoDB document JSON preview -->
          <div v-else-if="mongoJsonPreviewOpen" class="relative col-start-3 row-start-1 flex min-w-0 flex-col border-l bg-background" :class="{ 'detail-drawer-resizing': isResizingMongoJsonPreview }" :style="mongoJsonPreviewStyle" @contextmenu="onDrawerContextMenu">
            <div class="absolute bottom-0 left-0 top-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30" @mousedown.prevent="onMongoJsonPreviewResizeStart" />
            <div class="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
              <Code2 class="h-3.5 w-3.5 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ t("grid.mongoJsonPreview") }}</span>
              <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!mongoJsonPreviewFullText" :title="t('grid.copyJson')" @click="copyMongoJsonPreview">
                <Copy class="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon" class="h-5 w-5" @click="closeMongoJsonPreview">
                <X class="h-3 w-3" />
              </Button>
            </div>
            <div v-if="mongoJsonPreviewText" class="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
              <div v-if="mongoJsonPreviewUsesCodeEditor" ref="mongoJsonPreviewContainer" data-cell-detail-editor-root class="min-h-0 flex-1 overflow-hidden" />
              <template v-else>
                <pre class="min-h-0 flex-1 overflow-auto rounded border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap break-words">{{ mongoJsonPreviewText }}</pre>
                <div class="mt-1 text-[11px] text-muted-foreground">{{ t("grid.largeValuePreviewHint", { count: mongoJsonPreviewText.length }) }}</div>
              </template>
            </div>
            <div v-else class="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
              {{ t("grid.mongoJsonPreviewEmpty") }}
            </div>
          </div>
        </div>
      </div>
    </CustomContextMenu>
    <QueryLoadingState v-if="!hasData && loading" class="flex-1 min-h-0" />
    <div v-else-if="!hasData" class="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      {{ t("grid.querySuccess") }}
    </div>

    <!-- Error bar -->
    <ErrorBanner v-if="saveError" :message="saveError" copy-mode="label" dismissible @dismiss="saveError = ''" />

    <!-- Bottom status bar -->
    <div v-if="!isErrorResult" class="grid grid-cols-[max-content_minmax(0,1fr)_max-content] items-center gap-2 px-3 py-1 border-t text-xs text-muted-foreground bg-muted/30 shrink-0">
      <div class="flex min-w-0 items-center gap-2 overflow-hidden">
        <span v-if="hasData" class="shrink-0">
          {{ t("grid.totalRows", { count: result.rows.length }) }}
          <span v-if="typeof displayedTotalRowCount === 'number' && displayedTotalRowCount >= 0" class="text-muted-foreground/70">{{ t("grid.totalRowCount", { count: displayedTotalRowCount }) }}</span>
          <span v-else-if="totalRowCountBusy" class="text-muted-foreground/70">
            {{ t("grid.totalRowCountLoading") }}
          </span>
          <button v-else-if="canCalculateTotalRowCount" type="button" class="text-muted-foreground/70 hover:text-foreground hover:underline underline-offset-2 disabled:pointer-events-none" :disabled="manualTotalRowCountLoading" @click="calculateTotalRowCount">
            {{ t("grid.calculateTotalRowsInline") }}
          </button>
        </span>
        <span v-if="showTruncationWarning" class="shrink-0 text-amber-500 text-xs">(truncated)</span>
        <span v-if="!hasData" class="shrink-0">{{ t("grid.rowsAffected", { count: result.affected_rows }) }}</span>
        <span class="shrink-0">{{ result.execution_time_ms }}ms</span>

        <template v-if="editable && hasDataGridSaveTarget">
          <span v-if="hasPendingChanges" class="shrink-0 text-foreground">
            {{ t("grid.pendingChanges", { count: pendingChangeCount }) }}
          </span>
        </template>
      </div>

      <Tooltip v-if="sqlOneLiner">
        <TooltipTrigger as-child>
          <span class="min-w-0 max-w-full justify-self-center truncate opacity-60 cursor-pointer hover:opacity-100" @click="copySql">
            {{ sqlOneLiner }}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" class="max-w-md">
          <pre class="text-xs font-mono whitespace-pre-wrap">{{ props.sql }}</pre>
        </TooltipContent>
      </Tooltip>
      <span v-else class="min-w-0" />

      <div class="flex min-w-max items-center justify-end gap-1">
        <div v-if="selectionSummary" class="flex shrink-0 items-center gap-3 tabular-nums">
          <span class="shrink-0">{{ t("grid.selectionSum", { value: selectionSummarySumText }) }}</span>
          <div class="flex shrink-0 items-center gap-1">
            <span class="shrink-0">{{ t("grid.selectionCells", { count: selectionSummary.cellCount }) }}</span>
            <span class="shrink-0">{{ t("grid.rows", { count: selectionSummary.rowCount }) }}</span>
          </div>
        </div>
        <Loader2 v-if="loading" class="w-3 h-3 animate-spin text-muted-foreground" />
        <template v-if="infiniteScrollEnabled">
          <span v-if="infiniteScrollAllLoaded" class="text-xs text-muted-foreground shrink-0">
            {{ t("grid.allLoaded") }}
          </span>
        </template>
        <template v-if="!infiniteScrollEnabled">
          <LightDropdown
            :model-value="String(pageSize)"
            :items="pageSizeMenuItems"
            :trigger-label="`${pageSize}${t('grid.rowsPerPageShort')}`"
            trigger-class="inline-flex h-5 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
            content-class="w-36"
            :highlight-selected="false"
            check-position="none"
            align="end"
            @update:model-value="selectPageSizeMenuItem"
          >
            <div class="bg-border -mx-1 my-1 h-px" />
            <div class="text-muted-foreground px-1.5 py-1 text-xs">{{ t("grid.customRowsPerPage") }}</div>
            <div class="flex items-center gap-1 px-1.5 pb-1" @click.stop @keydown.stop>
              <Input
                v-model="customPageSizeInput"
                type="number"
                inputmode="numeric"
                :min="MIN_RESULT_PAGE_SIZE"
                :max="MAX_RESULT_PAGE_SIZE"
                class="h-6 w-20 px-1.5 text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                @keydown.enter.prevent.stop="applyCustomPageSize"
              />
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button variant="outline" size="icon" class="h-6 w-6 shrink-0" :aria-label="t('grid.applyPageSize')" @click.stop="applyCustomPageSize">
                    <Check class="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{{ t("grid.applyPageSize") }}</TooltipContent>
              </Tooltip>
            </div>
          </LightDropdown>
          <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="currentPage <= 1" @click="firstPage">
            <ChevronsLeft class="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="currentPage <= 1" @click="prevPage">
            <ChevronLeft class="h-3 w-3" />
          </Button>
          <span class="shrink-0 tabular-nums">{{ currentPage }}</span>
          <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="!canGoNextPage" @click="nextPage">
            <ChevronRight class="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :disabled="!canJumpLastPage" @click="lastPage">
            <ChevronsRight class="h-3 w-3" />
          </Button>
        </template>
        <LightDropdown
          model-value=""
          :items="exportMenuItems"
          :aria-label="t('grid.export')"
          :trigger-icon="Upload"
          :trigger-label="t('grid.export')"
          trigger-class="inline-flex h-6 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2 text-foreground/80 hover:bg-accent hover:text-accent-foreground"
          trigger-icon-class="h-3.5 w-3.5"
          :show-trigger-label="true"
          :show-chevron="true"
          :highlight-selected="false"
          check-position="none"
          align="end"
          @update:model-value="selectExportMenuItem"
        />
      </div>
    </div>

    <Dialog v-model:open="cellDetailDialogOpen">
      <DialogContent v-if="dialogCellDetail" class="sm:max-w-[840px] max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader class="shrink-0 pr-8">
          <DialogTitle class="flex min-w-0 items-center gap-2 text-sm">
            <Info class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 truncate">{{ t("grid.cellDetails") }}</span>
          </DialogTitle>
        </DialogHeader>

        <div class="min-h-0 flex-1 overflow-auto pr-1 text-xs space-y-4">
          <div class="grid gap-3 rounded border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-4">
            <div class="space-y-1">
              <div class="text-muted-foreground">{{ t("grid.columnName") }}</div>
              <div class="font-medium break-all">{{ dialogCellDetail.column }}</div>
            </div>
            <div class="space-y-1">
              <div class="text-muted-foreground">{{ t("grid.rowNumber") }}</div>
              <div>{{ dialogCellDetail.rowNumber }}</div>
            </div>
            <div class="space-y-1">
              <div class="text-muted-foreground">{{ t("grid.columnType") }}</div>
              <div :class="dialogCellDetail.type ? typeColorClass(dialogCellDetail.type) : 'text-muted-foreground'">
                {{ dialogCellDetail.type || "-" }}
              </div>
            </div>
            <div class="space-y-1">
              <div class="text-muted-foreground">{{ t("grid.valueLength") }}</div>
              <div>{{ dialogCellDetail.length }}</div>
            </div>
          </div>

          <div class="space-y-1">
            <div class="text-muted-foreground">{{ t("grid.columnComment") }}</div>
            <div class="whitespace-pre-wrap break-words">
              {{ dialogCellDetail.comment || t("grid.noComment") }}
            </div>
          </div>

          <div class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <div class="text-muted-foreground">{{ t("grid.cellValue") }}</div>
              <div class="flex items-center gap-1">
                <Button v-if="dialogCellDetail.formattedJson" :variant="cellDetailJsonView ? 'secondary' : 'ghost'" size="sm" class="h-6 gap-1 px-2 text-xs" :title="t('grid.formattedJson')" @click="toggleCellDetailJsonFormatted">
                  <Code2 class="h-3 w-3" />
                  {{ t("grid.formattedJson") }}
                </Button>
                <Button v-if="dialogCellDetail.isEditable" variant="ghost" size="icon" class="h-6 w-6" :title="t('grid.editValue')" @click="openDialogCellInSidePanel">
                  <Pencil class="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('grid.copyValue')" @click="copyDialogCellCurrentValue">
                  <Copy class="h-3 w-3" />
                </Button>
                <DropdownMenu v-if="canDownloadDetailBinaryValue(dialogCellDetail)">
                  <DropdownMenuTrigger as-child>
                    <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('grid.downloadBinaryValue')">
                      <Upload class="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" class="w-44">
                    <DropdownMenuItem v-for="mode in BINARY_CELL_DOWNLOAD_MODES" :key="mode" @click="downloadDetailBinaryValue(dialogCellDetail, mode)">
                      {{ t(`grid.binaryDownload.${mode}`) }}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <!-- Skip hex fallback from backend (unsupported geometry types like TIN/Triangle) -->
                <Popover v-if="isGeometryColumnType(dialogCellDetail.type) && dialogCellDetail.value !== null && !isHexGeometry(dialogCellDetail.value as string)" v-model:open="dialogGeometryPreviewOpen">
                  <PopoverTrigger as-child>
                    <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('grid.geometryPreview')">
                      <Eye class="h-3 w-3" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent class="w-auto p-1.5" align="end">
                    <canvas v-show="dialogGeometryPreviewOpen" ref="dialogGeometryCanvas" width="400" height="280" class="block rounded" />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            <a v-if="dialogCellDetail.imagePreviewUrl" :href="dialogCellDetail.imagePreviewUrl" role="button" class="block max-h-72 overflow-hidden rounded border bg-muted/20" @click.prevent="openImagePreview(dialogCellDetail.imagePreviewUrl, dialogCellDetail.column)">
              <img :src="dialogCellDetail.imagePreviewUrl" :alt="dialogCellDetail.column" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="max-h-72 w-full object-contain" />
            </a>
            <div v-if="cellDetailJsonView && dialogCellDetail.formattedJson" ref="dialogJsonPreviewContainer" data-cell-detail-editor-root class="h-[44vh] min-h-60 overflow-hidden rounded border bg-muted/20 p-3" />
            <pre v-else class="max-h-[44vh] overflow-auto rounded border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap break-words" :class="{ 'italic text-muted-foreground': dialogCellDetail.value === null }">{{ dialogCellDetail.rawValuePreview }}</pre>
            <div v-if="dialogCellDetail.isValuePreviewTruncated && !cellDetailJsonView" class="text-[11px] text-muted-foreground">
              {{ t("grid.largeValuePreviewHint", { count: dialogCellDetail.rawValuePreview.length }) }}
            </div>
          </div>
        </div>

        <DialogFooter class="shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex flex-wrap gap-2"></div>
          <Button variant="ghost" size="sm" class="h-7 text-xs" @click="copyDialogCellColumnName"> <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyColumnName") }} </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="rowDetailDialogOpen">
      <DialogContent v-if="rowDetail" class="sm:max-w-[960px] max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader class="shrink-0 pr-8">
          <DialogTitle class="flex min-w-0 items-center gap-2 text-sm">
            <ListTree class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 truncate">{{ t("grid.rowDetailsFor", { row: rowDetail.rowNumber }) }}</span>
          </DialogTitle>
        </DialogHeader>

        <div class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span class="whitespace-nowrap">{{ t("grid.columnsCount", { count: rowDetail.fields.length }) }}</span>
          <div class="relative ml-auto w-56 max-w-full">
            <Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="rowDetailSearch" :placeholder="t('grid.detailSearchPlaceholder')" class="h-7 pl-7 text-xs" />
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-auto rounded border">
          <table class="w-full min-w-[640px] text-xs">
            <thead class="sticky top-0 z-10 bg-muted text-muted-foreground">
              <tr class="border-b">
                <th class="w-16 px-3 py-2 text-left font-medium">{{ t("grid.fieldIndex") }}</th>
                <th class="w-56 px-3 py-2 text-left font-medium">{{ t("grid.columnName") }}</th>
                <th class="px-3 py-2 text-left font-medium">{{ t("grid.cellValue") }}</th>
                <th class="w-10 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(field, fieldIndex) in filteredRowDetailFields" :key="`${field.colIndex}:${field.column}`" class="border-b align-top last:border-b-0">
                <td class="px-3 py-2 text-muted-foreground tabular-nums">{{ fieldIndex + 1 }}</td>
                <td class="px-3 py-2">
                  <div class="font-medium break-words">{{ field.column }}</div>
                  <div :class="field.type ? typeColorClass(field.type) : 'text-muted-foreground'" class="mt-1 text-[11px]">
                    {{ field.type || "-" }}
                  </div>
                  <div v-if="field.comment" class="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap">
                    {{ field.comment }}
                  </div>
                </td>
                <td class="w-full max-w-0 px-3 py-2">
                  <div class="mb-1 text-[11px] text-muted-foreground">
                    {{ field.value === null ? t("grid.nullValue") : t("grid.valueLength") }}:
                    {{ field.value === null ? "true" : field.length }}
                  </div>
                  <a v-if="field.imagePreviewUrl" :href="field.imagePreviewUrl" role="button" class="mb-2 block max-h-48 overflow-hidden rounded border bg-muted/20" @click.prevent="openImagePreview(field.imagePreviewUrl, field.column)">
                    <img :src="field.imagePreviewUrl" :alt="field.column" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="max-h-48 w-full object-contain" />
                  </a>
                  <pre class="max-h-44 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-words" :class="{ 'italic text-muted-foreground': field.value === null }">{{ field.rawValuePreview }}</pre>
                  <div v-if="field.isValuePreviewTruncated" class="mt-1 text-[11px] text-muted-foreground">
                    {{ t("grid.largeValuePreviewHint", { count: field.rawValuePreview.length }) }}
                  </div>
                  <div v-if="field.formattedJson" class="mt-2 space-y-1">
                    <div class="text-muted-foreground">{{ t("grid.formattedJson") }}</div>
                    <pre class="max-h-44 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-words">{{ field.formattedJson }}</pre>
                  </div>
                </td>
                <td class="px-2 py-2">
                  <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('grid.copyValue')" @click="copyRowDetailFieldValue(field)">
                    <Copy class="h-3 w-3" />
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="rowDetailSearch && !filteredRowDetailFields.length" class="px-3 py-6 text-center text-xs text-muted-foreground">
            {{ t("grid.detailSearchNoMatch") }}
          </div>
        </div>

        <DialogFooter class="shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyRowDetailJson"> <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyRow") }} </Button>
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyRowDetailTsv"> <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyRowTsv") }} </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="columnDetailDialogOpen">
      <DialogContent v-if="columnDetail" class="sm:max-w-[900px] max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader class="shrink-0 pr-8">
          <DialogTitle class="flex min-w-0 items-center gap-2 text-sm">
            <TableProperties class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 truncate">{{ t("grid.columnDetailsFor", { column: columnDetail.column }) }}</span>
          </DialogTitle>
        </DialogHeader>

        <div class="grid shrink-0 gap-3 rounded border bg-muted/20 p-3 text-xs sm:grid-cols-3">
          <div class="space-y-1">
            <div class="text-muted-foreground">{{ t("grid.columnName") }}</div>
            <div class="font-medium break-all">{{ columnDetail.column }}</div>
          </div>
          <div class="space-y-1">
            <div class="text-muted-foreground">{{ t("grid.columnType") }}</div>
            <div :class="columnDetail.type ? typeColorClass(columnDetail.type) : 'text-muted-foreground'">
              {{ columnDetail.type || "-" }}
            </div>
          </div>
          <div class="space-y-1">
            <div class="text-muted-foreground">{{ t("grid.rowCount") }}</div>
            <div>{{ columnDetail.fields.length }}</div>
          </div>
          <div class="space-y-1 sm:col-span-3">
            <div class="text-muted-foreground">{{ t("grid.columnComment") }}</div>
            <div class="whitespace-pre-wrap break-words">
              {{ columnDetail.comment || t("grid.noComment") }}
            </div>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span class="whitespace-nowrap">{{ t("grid.rowCount") }}: {{ columnDetail.fields.length }}</span>
          <div class="relative ml-auto w-56 max-w-full">
            <Search class="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="columnDetailSearch" :placeholder="t('grid.detailSearchPlaceholder')" class="h-7 pl-7 text-xs" />
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-auto rounded border">
          <table class="w-full min-w-[500px] text-xs">
            <thead class="sticky top-0 z-10 bg-muted text-muted-foreground">
              <tr class="border-b">
                <th class="w-24 px-3 py-2 text-left font-medium">{{ t("grid.rowNumber") }}</th>
                <th class="px-3 py-2 text-left font-medium">{{ t("grid.cellValue") }}</th>
                <th class="w-10 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="field in filteredColumnDetailFields" :key="`${field.rowId}:${field.colIndex}`" class="border-b align-top last:border-b-0">
                <td class="px-3 py-2 tabular-nums">{{ field.rowNumber }}</td>
                <td class="w-full max-w-0 px-3 py-2">
                  <div class="mb-1 text-[11px] text-muted-foreground">
                    {{ field.value === null ? t("grid.nullValue") : t("grid.valueLength") }}:
                    {{ field.value === null ? "true" : field.length }}
                  </div>
                  <a v-if="field.imagePreviewUrl" :href="field.imagePreviewUrl" role="button" class="mb-2 block max-h-40 overflow-hidden rounded border bg-muted/20" @click.prevent="openImagePreview(field.imagePreviewUrl, field.column)">
                    <img :src="field.imagePreviewUrl" :alt="field.column" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="max-h-40 w-full object-contain" />
                  </a>
                  <pre class="max-h-36 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-words" :class="{ 'italic text-muted-foreground': field.value === null }">{{ field.rawValuePreview }}</pre>
                  <div v-if="field.isValuePreviewTruncated" class="mt-1 text-[11px] text-muted-foreground">
                    {{ t("grid.largeValuePreviewHint", { count: field.rawValuePreview.length }) }}
                  </div>
                  <div v-if="field.formattedJson" class="mt-2 space-y-1">
                    <div class="text-muted-foreground">{{ t("grid.formattedJson") }}</div>
                    <pre class="max-h-36 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-words">{{ field.formattedJson }}</pre>
                  </div>
                </td>
                <td class="px-2 py-2">
                  <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('grid.copyValue')" @click="copyColumnDetailFieldValue(field)">
                    <Copy class="h-3 w-3" />
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="columnDetailSearch && !filteredColumnDetailFields.length" class="px-3 py-6 text-center text-xs text-muted-foreground">
            {{ t("grid.detailSearchNoMatch") }}
          </div>
        </div>

        <DialogFooter class="shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyColumnDetailJson"> <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyColumnValues") }} </Button>
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyColumnDetailTsv"> <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyColumnTsv") }} </Button>
          </div>
          <Button variant="ghost" size="sm" class="h-7 text-xs" @click="copyColumnDetailColumnName"> <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyColumnName") }} </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="bulkEditDialogOpen">
      <DialogContent class="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ t("grid.bulkEditTitle") }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-2">
          <p class="text-sm text-muted-foreground">
            {{ t("grid.bulkEditDescription", { count: selectedCellCount }) }}
          </p>
          <textarea
            v-model="bulkEditValue"
            autocapitalize="off"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            rows="5"
            class="min-h-24 w-full min-w-0 resize-y rounded-[6px] border border-input bg-transparent px-2.5 py-1.5 text-base outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
            :placeholder="t('grid.bulkEditValuePlaceholder')"
            @keydown.ctrl.enter.prevent="applyBulkEditValue"
            @keydown.meta.enter.prevent="applyBulkEditValue"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" @click="bulkEditDialogOpen = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button @click="applyBulkEditValue">{{ t("grid.applyBulkEdit") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- SQL Preview panel for pending data changes -->
    <div v-if="showSqlPreview" class="h-52 shrink-0 border-t">
      <SqlPreviewPanel :sql="previewSqlText" :loading="isPreviewLoading" :can-undo="canUndoPendingChange" :can-redo="canRedoPendingChange" @undo="undoGridChange" @redo="redoGridChange" @close="closeSqlPreview" />
    </div>

    <DangerConfirmDialog
      v-model:open="showDeleteRowConfirm"
      :message="pendingDeleteRowIds.length > 1 ? t('dangerDialog.deleteRowsMessage', { count: pendingDeleteRowIds.length }) : t('dangerDialog.deleteRowMessage')"
      :details="deleteRowDetails"
      :confirm-label="pendingDeleteRowIds.length > 1 ? t('grid.deleteRows', { count: pendingDeleteRowIds.length }) : t('grid.deleteRow')"
      @confirm="confirmDeleteRow"
    />
    <DangerConfirmDialog
      v-model:open="showDropMongoIndexConfirm"
      :title="t('contextMenu.confirmDropIndexTitle')"
      :message="dropMongoIndexConfirmMessage"
      :details="dropMongoIndexPreview"
      :confirm-label="t('contextMenu.dropIndex')"
      :loading="dropMongoIndexLoading"
      :close-on-confirm="false"
      @confirm="confirmDropMongoIndex"
    />
    <DangerConfirmDialog
      v-model:open="showDropAllMongoIndexesConfirm"
      :title="t('contextMenu.dropAllIndexes')"
      :message="dropAllMongoIndexesConfirmMessage"
      :details-text="dropAllMongoIndexesConfirmDetails"
      :sql="dropAllMongoIndexesPreview"
      :confirm-label="t('contextMenu.dropAllIndexes')"
      :loading="dropAllMongoIndexesLoading"
      :close-on-confirm="false"
      @confirm="confirmDropAllMongoIndexes"
    />
    <ImagePreviewDialog v-model:open="imagePreviewOpen" :src="imagePreviewSrc" :title="imagePreviewTitle" />
    <component v-if="previewDialogOpen && previewDialogConfig" :is="previewDialogConfig.component" v-model:open="previewDialogOpen" v-bind="previewDialogConfig.props" />
    <ExportProgressDialog v-model:open="exportProgressDialog" v-bind="exportProgressState" :disable-cancel="!exportCancelHandler" @cancel="cancelActiveExport" />
  </div>
</template>

<style scoped>
@reference "../../styles/globals.css";

[data-grid-root] {
  --data-grid-row-muted-bg: rgb(248, 248, 248);
  --data-grid-row-new-bg: rgb(243, 243, 243);
  --data-grid-row-deleted-bg: rgb(255, 244, 244);
  --data-grid-cell-active-bg: rgb(232, 232, 232);
  --data-grid-cell-dirty-bg: rgb(255, 248, 230);
  --data-grid-cell-selected-bg: rgb(226, 226, 226);
  --data-grid-cell-selected-dirty-bg: rgb(244, 229, 186);
  --data-grid-cell-selected-border: rgb(90, 90, 90);
  --data-grid-cell-hover-bg: rgb(245, 245, 245);
  --data-grid-cell-search-bg: rgb(253, 245, 184);
  --data-grid-cell-current-search-bg: rgba(253, 224, 71, 0.52);
  --data-grid-cell-current-search-border: rgba(234, 179, 8, 0.82);
  --data-grid-row-number-default-bg: rgb(255, 255, 255);
  --data-grid-row-number-new-bg: rgb(219, 244, 233);
  --data-grid-row-number-edited-bg: rgb(253, 241, 219);
  --data-grid-row-number-deleted-bg: rgb(255, 244, 244);
  --data-grid-row-number-active-bg: rgb(232, 232, 232);
  --data-grid-row-number-selected-bg: rgb(226, 226, 226);
  --data-grid-scrollbar-thumb: color-mix(in oklch, var(--foreground) 30%, transparent);
  --data-grid-scrollbar-thumb-hover: color-mix(in oklch, var(--foreground) 48%, transparent);
  --data-grid-scrollbar-track: transparent;
  background-color: rgb(255, 255, 255);
}

[data-grid-root].data-grid--dark,
:global(.dark) [data-grid-root] {
  --data-grid-row-muted-bg: rgb(32, 32, 34);
  --data-grid-row-new-bg: rgb(51, 51, 55);
  --data-grid-row-deleted-bg: rgb(55, 31, 32);
  --data-grid-cell-active-bg: rgb(64, 64, 64);
  --data-grid-cell-dirty-bg: rgb(94, 75, 26);
  --data-grid-cell-selected-bg: rgb(66, 67, 70);
  --data-grid-cell-selected-dirty-bg: rgb(94, 75, 26);
  --data-grid-cell-selected-border: rgb(170, 170, 175);
  --data-grid-cell-hover-bg: rgb(46, 47, 51);
  --data-grid-cell-search-bg: rgb(72, 57, 8);
  --data-grid-cell-current-search-bg: rgb(116, 87, 0);
  --data-grid-cell-current-search-border: rgb(239, 177, 0);
  --data-grid-row-number-default-bg: rgb(35, 37, 42);
  --data-grid-row-number-new-bg: rgb(33, 45, 40);
  --data-grid-row-number-edited-bg: rgb(48, 41, 28);
  --data-grid-row-number-deleted-bg: rgb(55, 31, 32);
  --data-grid-row-number-active-bg: rgb(64, 64, 64);
  --data-grid-row-number-selected-bg: rgb(66, 67, 70);
  --data-grid-scrollbar-thumb: rgb(82, 82, 91);
  --data-grid-scrollbar-thumb-hover: rgb(113, 113, 122);
  --data-grid-scrollbar-track: rgb(24, 24, 27);
  background-color: rgb(19, 20, 22);
}

@supports (background: color-mix(in oklab, white 50%, transparent)) {
  [data-grid-root] {
    --data-grid-row-muted-bg: color-mix(in oklab, var(--muted) 30%, transparent);
    --data-grid-row-new-bg: color-mix(in oklab, var(--primary) 5%, transparent);
    --data-grid-row-deleted-bg: color-mix(in oklab, var(--destructive) 5%, transparent);
    --data-grid-cell-active-bg: color-mix(in oklab, var(--primary) 15%, transparent);
    --data-grid-cell-dirty-bg: color-mix(in oklab, rgb(240 177 0) 10%, transparent);
    --data-grid-cell-selected-bg: color-mix(in oklab, var(--primary) 25%, transparent);
    --data-grid-cell-selected-dirty-bg: color-mix(in oklab, rgb(234 181 50) 30%, color-mix(in oklab, var(--primary) 18%, transparent));
    --data-grid-cell-selected-border: color-mix(in oklab, var(--primary) 70%, transparent);
    --data-grid-cell-hover-bg: color-mix(in oklab, var(--accent) 50%, transparent);
    --data-grid-row-number-new-bg: color-mix(in oklab, rgb(16 185 129) 15%, var(--background));
    --data-grid-row-number-edited-bg: color-mix(in oklab, rgb(245 158 11) 15%, var(--background));
    --data-grid-row-number-deleted-bg: color-mix(in oklab, var(--destructive) 15%, var(--background));
    --data-grid-row-number-active-bg: color-mix(in oklab, var(--primary) 15%, var(--background));
    --data-grid-row-number-selected-bg: color-mix(in oklab, var(--primary) 25%, var(--background));
  }
}

.data-grid-header-shell,
.data-grid-header-cell {
  background-color: rgb(239, 239, 239);
}

[data-grid-root].data-grid--dark .data-grid-header-shell,
[data-grid-root].data-grid--dark .data-grid-header-cell,
:global(.dark) [data-grid-root] .data-grid-header-shell,
:global(.dark) [data-grid-root] .data-grid-header-cell {
  background-color: rgb(32, 32, 34) !important;
}

[data-grid-root].data-grid--dark .data-grid-header-row,
:global(.dark) [data-grid-root] .data-grid-header-row {
  color: rgb(215, 215, 219);
}

[data-grid-root].data-grid--dark .data-grid-header-cell:hover,
:global(.dark) [data-grid-root] .data-grid-header-cell:hover {
  background-color: rgb(46, 47, 51) !important;
}

.data-grid-header-cell--selected {
  background-color: rgb(209, 213, 219) !important;
}

:global(.dark) [data-grid-root] {
  --data-grid-cell-selected-bg: rgb(66, 67, 70);
  --data-grid-cell-selected-dirty-bg: rgb(94, 75, 26);
  --data-grid-cell-selected-border: rgb(170, 170, 175);
  --data-grid-row-number-selected-bg: rgb(66, 67, 70);
}

[data-grid-root].data-grid--dark .data-grid-header-cell--selected,
[data-grid-root].data-grid--dark .transpose-record-header-selected,
[data-grid-root].data-grid--dark .transpose-record-header-active,
:global(.dark) [data-grid-root] .data-grid-header-cell--selected,
:global(.dark) [data-grid-root] .transpose-record-header-selected,
:global(.dark) [data-grid-root] .transpose-record-header-active {
  background-color: rgb(66, 67, 70) !important;
  color: rgb(244, 244, 245) !important;
}

.data-grid-row {
  background-color: var(--data-grid-cell-bg);
}

.data-grid-cell {
  background-color: var(--data-grid-cell-bg);
}

.data-grid-row-number {
  background-color: var(--data-grid-row-number-bg);
}

.data-grid-row--striped {
  background-color: var(--data-grid-cell-bg);
}

.data-grid-row--draft,
.data-grid-row--new {
  background-color: var(--data-grid-cell-bg);
}

.data-grid-row--deleted {
  background-color: var(--data-grid-cell-bg);
}

:global(.dark) [data-grid-root] .data-grid-row {
  background-color: var(--data-grid-cell-bg) !important;
}

:global(.dark) [data-grid-root] .data-grid-row--striped {
  background-color: var(--data-grid-cell-bg) !important;
}

:global(.dark) [data-grid-root] .data-grid-row--draft,
:global(.dark) [data-grid-root] .data-grid-row--new {
  background-color: var(--data-grid-cell-bg) !important;
}

:global(.dark) [data-grid-root] .data-grid-row--deleted {
  background-color: var(--data-grid-cell-bg) !important;
}

.data-grid-topbar {
  --data-grid-topbar-transition-duration: 340ms;
  --data-grid-topbar-transition-easing: cubic-bezier(0.22, 1, 0.36, 1);
  --data-grid-condition-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  width: 100%;
  min-width: 0;
  transition: min-width var(--data-grid-topbar-transition-duration) var(--data-grid-topbar-transition-easing);
}

.data-grid-topbar-shell {
  background-color: color-mix(in oklab, var(--muted) 20%, transparent);
}

[data-grid-root].data-grid--dark .data-grid-topbar-shell {
  background-color: rgb(24, 24, 27) !important;
}

[data-grid-root].data-grid--dark .data-grid-topbar,
[data-grid-root].data-grid--dark .data-grid-topbar-scroll {
  background-color: rgb(24, 24, 27) !important;
}

[data-grid-root].data-grid--dark .data-grid-topbar [class*="bg-muted/"],
[data-grid-root].data-grid--dark .data-grid-topbar [class*="bg-background/"] {
  background-color: rgb(31, 31, 35) !important;
}

[data-grid-root].data-grid--dark .data-grid-topbar [class*="hover:bg-accent"]:hover {
  background-color: rgb(46, 47, 51) !important;
}

.data-grid-topbar--compact {
  min-width: 0;
}

.data-grid-topbar-condition-label {
  display: inline-flex;
  flex-shrink: 0;
  max-width: 5rem;
  overflow: hidden;
  white-space: nowrap;
  font-family: var(--data-grid-condition-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.5rem;
  user-select: none;
  opacity: 1;
  transform: translateX(0);
  transition:
    max-width var(--data-grid-topbar-transition-duration) var(--data-grid-topbar-transition-easing),
    opacity 240ms ease 60ms,
    transform var(--data-grid-topbar-transition-duration) var(--data-grid-topbar-transition-easing),
    color 240ms ease;
}

.data-grid-topbar-condition-label--where {
  color: rgb(37 99 235);
}

.data-grid-topbar-condition-label--order {
  color: rgb(234 88 12);
}

:global(.dark) [data-grid-root] .data-grid-topbar-condition-label--where {
  color: rgb(96 165 250);
}

:global(.dark) [data-grid-root] .data-grid-topbar-condition-label--order {
  color: rgb(251 146 60);
}

.data-grid-topbar-condition-label--compact {
  max-width: 0;
  opacity: 0;
  transform: translateX(-4px);
}

.data-grid-topbar-condition-input,
.data-grid-topbar-condition-measure {
  font-family: var(--data-grid-condition-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
  font-size: 0.875rem;
  line-height: 1.5rem;
  font-variant-ligatures: none;
  font-feature-settings:
    "liga" 0,
    "calt" 0;
}

.data-grid-topbar-condition-input {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  padding: 0 0.125rem;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: pre;
  border: 0;
  border-radius: 0;
  appearance: none;
  scrollbar-width: none;
}

[data-grid-root].data-grid--dark .data-grid-topbar-condition-input {
  color: rgb(244, 244, 245);
  background-color: transparent !important;
}

.data-grid-topbar-condition-input::-webkit-scrollbar {
  display: none;
}

.data-grid-topbar-condition-icon-control {
  align-self: center;
  margin-top: 0;
}

.data-grid-topbar-condition-floating-controls {
  top: var(--data-grid-condition-controls-top);
  will-change: transform;
}

.data-grid-topbar-condition-pane--expanded {
  --data-grid-condition-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  position: fixed;
  z-index: 80;
  right: auto;
  bottom: auto;
  box-sizing: border-box;
  padding: 0.1875rem 0.5rem 0.1875rem 0.5rem;
  overflow: hidden;
  background: color-mix(in oklab, var(--background) 96%, var(--muted) 4%);
  box-shadow:
    inset 0 -1px 0 var(--border),
    0 8px 16px rgb(15 23 42 / 8%);
  transition:
    height 150ms ease,
    box-shadow 150ms ease;
  --data-grid-expanded-scrollbar-offset: 8px;
  --data-grid-condition-controls-top: 0.125rem;
  --data-grid-condition-input-top: 0.125rem;
  --data-grid-condition-prefix-indent: 0px;
  --data-grid-condition-suffix-width: 0px;
}

[data-grid-root].data-grid--dark .data-grid-topbar-condition-pane--expanded {
  background: rgb(24, 24, 27) !important;
  color: rgb(244, 244, 245);
  box-shadow:
    inset 0 -1px 0 rgb(63, 63, 70),
    0 8px 16px rgb(0 0 0 / 32%);
}

.data-grid-topbar-condition-input--expanded {
  top: var(--data-grid-condition-input-top);
  right: 0.5rem;
  bottom: 0.125rem;
  left: 0.5rem;
  height: auto;
  line-height: 1.5rem;
  margin-left: 0;
  width: calc(100% - 1rem + var(--data-grid-expanded-scrollbar-offset));
  max-width: none;
  margin-right: calc(-1 * var(--data-grid-expanded-scrollbar-offset));
  padding: 0 calc(var(--data-grid-condition-suffix-width) + 0.5rem) 0.0625rem 0.125rem;
  text-indent: var(--data-grid-condition-prefix-indent);
  overflow-x: hidden;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border: 0;
  border-radius: 0;
  background: transparent;
  scrollbar-width: thin;
}

.data-grid-topbar-condition-input--expanded::-webkit-scrollbar {
  display: initial;
  width: 8px;
}

.data-grid-topbar-condition-input::placeholder {
  color: transparent;
  transition: color 240ms ease;
}

.data-grid-topbar-condition-input--where.data-grid-topbar-condition-input--compact::placeholder {
  color: rgb(59 130 246 / 70%);
}

.data-grid-topbar-condition-input--order.data-grid-topbar-condition-input--compact::placeholder {
  color: rgb(249 115 22 / 70%);
}

:global(.dark) [data-grid-root] .data-grid-topbar-condition-input--where.data-grid-topbar-condition-input--compact::placeholder {
  color: rgb(147 197 253 / 70%);
}

:global(.dark) [data-grid-root] .data-grid-topbar-condition-input--order.data-grid-topbar-condition-input--compact::placeholder {
  color: rgb(253 186 116 / 70%);
}

.data-grid-topbar-action-button {
  align-items: center;
  justify-content: center;
  max-width: 9rem;
  min-width: 1.25rem;
  gap: 0;
  line-height: 1;
  overflow: hidden;
  transition:
    max-width var(--data-grid-topbar-transition-duration) var(--data-grid-topbar-transition-easing),
    min-width var(--data-grid-topbar-transition-duration) var(--data-grid-topbar-transition-easing),
    padding-inline var(--data-grid-topbar-transition-duration) var(--data-grid-topbar-transition-easing),
    color 220ms ease,
    background-color 220ms ease,
    border-color 220ms ease;
}

.data-grid-topbar-action-button--compact {
  max-width: 1.25rem;
  min-width: 1.25rem;
  padding-inline: 0;
}

.data-grid-topbar-action-button--commit.data-grid-topbar-action-button--compact {
  overflow: visible;
}

.data-grid-topbar-action-icon {
  display: block;
  align-self: center;
  flex-shrink: 0;
  transition:
    margin-inline-end var(--data-grid-topbar-transition-duration) var(--data-grid-topbar-transition-easing),
    transform var(--data-grid-topbar-transition-duration) var(--data-grid-topbar-transition-easing);
}

.data-grid-topbar-action-button:not(.data-grid-topbar-action-button--compact) .data-grid-topbar-action-icon {
  margin-inline-end: 0.25rem;
}

.data-grid-scroller,
.data-grid-header-row,
.data-grid-transpose-header,
.data-grid-transpose-row {
  font-size: var(--dbx-table-font-size, 13px);
}

.data-grid-topbar-action-button--compact .data-grid-topbar-action-icon {
  margin-inline-end: 0;
  transform: scale(0.96);
}

.data-grid-topbar-action-label {
  display: inline-flex;
  align-items: center;
  height: 1rem;
  max-width: 8rem;
  overflow: hidden;
  white-space: nowrap;
  line-height: 1;
  opacity: 1;
  transform: translateX(0);
  transition:
    max-width var(--data-grid-topbar-transition-duration) var(--data-grid-topbar-transition-easing),
    opacity 240ms ease 60ms,
    transform var(--data-grid-topbar-transition-duration) var(--data-grid-topbar-transition-easing);
}

.data-grid-topbar-action-label--compact {
  max-width: 0;
  opacity: 0;
  transform: translateX(-4px);
}

.data-grid-topbar-scroll {
  scrollbar-width: none;
  scrollbar-gutter: auto;
}

.data-grid-topbar-scroll::-webkit-scrollbar {
  display: none;
}

.data-grid-scroller {
  overflow-anchor: none;
  overscroll-behavior: none;
  overscroll-behavior-x: none;
  overscroll-behavior-y: none;
  scrollbar-gutter: stable;
  will-change: scroll-position;
  contain: layout style paint;
  scrollbar-width: none;
}

.data-grid-scroller::-webkit-scrollbar {
  display: none;
}

.canvas-grid-scroller.has-horizontal-scrollbar {
  margin-bottom: 10px;
  box-shadow: 0 10px 0 0 rgb(255, 255, 255);
}

.canvas-grid-scroller {
  background-color: rgb(255, 255, 255);
}

[data-grid-root].data-grid--dark .canvas-grid-scroller,
:global(.dark) [data-grid-root] .canvas-grid-scroller {
  background-color: rgb(19, 20, 22) !important;
}

[data-grid-root].data-grid--dark .canvas-grid-scroller.has-horizontal-scrollbar,
:global(.dark) [data-grid-root] .canvas-grid-scroller.has-horizontal-scrollbar {
  box-shadow: 0 10px 0 0 rgb(19, 20, 22);
}

.data-grid-scroller.has-horizontal-scrollbar:not(.canvas-grid-scroller) {
  padding-bottom: 10px;
}

.data-grid-scroller:not(.canvas-grid-scroller) {
  background-color: rgb(255, 255, 255);
}

[data-grid-root].data-grid--dark .data-grid-scroller:not(.canvas-grid-scroller),
:global(.dark) [data-grid-root] .data-grid-scroller:not(.canvas-grid-scroller) {
  background-color: rgb(19, 20, 22) !important;
}

.data-grid-scroller:not(.canvas-grid-scroller) :deep(.vue-recycle-scroller__item-wrapper),
.data-grid-scroller:not(.canvas-grid-scroller) :deep(.vue-recycle-scroller__item-view) {
  background-color: rgb(255, 255, 255);
}

[data-grid-root].data-grid--dark .data-grid-scroller:not(.canvas-grid-scroller) :deep(.vue-recycle-scroller__item-wrapper),
[data-grid-root].data-grid--dark .data-grid-scroller:not(.canvas-grid-scroller) :deep(.vue-recycle-scroller__item-view),
:global(.dark) [data-grid-root] .data-grid-scroller:not(.canvas-grid-scroller) :deep(.vue-recycle-scroller__item-wrapper),
:global(.dark) [data-grid-root] .data-grid-scroller:not(.canvas-grid-scroller) :deep(.vue-recycle-scroller__item-view) {
  background-color: rgb(19, 20, 22) !important;
}

.data-grid-scroller :deep(.vue-recycle-scroller__item-wrapper) {
  min-width: var(--total-w);
  overflow: visible;
}

[data-grid-root].data-grid--dark .data-grid-scroller :deep(.vue-recycle-scroller__item-wrapper),
[data-grid-root].data-grid--dark .data-grid-scroller :deep(.vue-recycle-scroller__item-view) {
  background-color: rgb(19, 20, 22) !important;
}

.data-grid-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style paint;
}

[data-grid-root].data-grid--editing-cell .data-grid-scroller :deep(.vue-recycle-scroller__item-view),
[data-grid-root].data-grid--editing-cell .transpose-grid-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style;
  overflow: visible;
}

[data-grid-root] .data-grid-scroller :deep(.vue-recycle-scroller__item-view:has(.cell-edit-input--expanded)),
[data-grid-root] .transpose-grid-scroller :deep(.vue-recycle-scroller__item-view:has(.cell-edit-input--expanded)) {
  z-index: 80 !important;
  overflow: visible;
}

.data-grid-scroller.is-scrolling :deep(.vue-recycle-scroller__item-view) {
  pointer-events: none;
}

.data-grid-horizontal-scrollbar {
  position: absolute;
  inset-inline: calc(var(--row-num-w) + 8px) 4px;
  bottom: 0;
  z-index: 30;
  height: 10px;
  cursor: pointer;
  touch-action: none;
  background-color: rgb(255, 255, 255);
}

[data-grid-root].data-grid--dark .data-grid-horizontal-scrollbar,
:global(.dark) [data-grid-root] .data-grid-horizontal-scrollbar {
  background-color: rgb(19, 20, 22) !important;
}

.data-grid-horizontal-scrollbar::before {
  content: "";
  position: absolute;
  inset-inline: 0;
  top: 4px;
  height: 2px;
  border-radius: 999px;
  background: var(--data-grid-scrollbar-track);
}

.data-grid-horizontal-scrollbar__thumb {
  position: absolute;
  top: 3px;
  height: 4px;
  min-width: 24px;
  border-radius: 999px;
  background: var(--data-grid-scrollbar-thumb);
  transition:
    height 120ms ease,
    background-color 120ms ease,
    top 120ms ease;
}

.data-grid-horizontal-scrollbar:hover .data-grid-horizontal-scrollbar__thumb,
.data-grid-horizontal-scrollbar--dragging .data-grid-horizontal-scrollbar__thumb {
  top: 2px;
  height: 6px;
  background: var(--data-grid-scrollbar-thumb-hover);
}

.data-grid-vertical-scrollbar {
  position: absolute;
  top: 10px;
  right: 2px;
  bottom: 14px;
  z-index: 30;
  width: 10px;
  cursor: pointer;
  touch-action: none;
}

:global(.dark) [data-grid-root] .data-grid-vertical-scrollbar {
  background-color: rgb(19, 20, 22);
}

.data-grid-vertical-scrollbar__thumb {
  position: absolute;
  left: 3px;
  width: 4px;
  min-height: 24px;
  border-radius: 999px;
  background: var(--data-grid-scrollbar-thumb);
  transition:
    background-color 120ms ease,
    left 120ms ease,
    width 120ms ease;
}

.data-grid-vertical-scrollbar:hover .data-grid-vertical-scrollbar__thumb,
.data-grid-vertical-scrollbar--dragging .data-grid-vertical-scrollbar__thumb {
  left: 2px;
  width: 6px;
  background: var(--data-grid-scrollbar-thumb-hover);
}

.canvas-grid-surface {
  cursor: cell;
  font-family: var(--dbx-data-grid-font-family);
  font-size: var(--dbx-table-font-size, 13px);
  font-weight: 400;
  line-height: 1rem;
  outline: none;
}

.cell-edit-input {
  font-family: inherit;
  font-size: var(--dbx-table-font-size, 13px);
}

.cell-edit-input--expanded {
  left: 7px;
  width: calc(100% - 14px);
  min-height: var(--cell-edit-min-height, 54px);
  max-height: var(--cell-edit-max-height, calc(9.5lh + 10px));
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in oklab, var(--foreground) 24%, transparent) transparent;
  resize: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background-color: var(--background);
  background-color: color-mix(in oklab, var(--background) 96%, var(--primary) 4%);
  border: 1px solid color-mix(in oklab, var(--primary) 62%, var(--border));
  border-radius: 6px;
  z-index: 90;
  box-shadow:
    0 28px 72px rgb(0 0 0 / 34%),
    0 12px 30px rgb(0 0 0 / 24%),
    0 3px 10px rgb(0 0 0 / 18%),
    0 0 0 1px var(--background),
    inset 0 0 0 1px color-mix(in oklab, var(--background) 70%, transparent);
}

:global(.dark) .cell-edit-input--expanded {
  box-shadow:
    0 0 0 1px color-mix(in oklab, var(--foreground) 26%, transparent),
    0 0 34px color-mix(in oklab, var(--foreground) 24%, transparent),
    0 0 70px color-mix(in oklab, var(--foreground) 14%, transparent),
    0 24px 64px rgb(0 0 0 / 42%),
    inset 0 0 0 1px color-mix(in oklab, var(--background) 58%, transparent);
}

.cell-edit-input--expanded::-webkit-scrollbar {
  width: 4px;
}

.cell-edit-input--expanded::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in oklab, var(--foreground) 24%, transparent);
}

.cell-edit-input--expanded:hover::-webkit-scrollbar-thumb,
.cell-edit-input--expanded:focus::-webkit-scrollbar-thumb {
  background: color-mix(in oklab, var(--foreground) 42%, transparent);
}

.cell-edit-input--expanded:hover::-webkit-scrollbar,
.cell-edit-input--expanded:focus::-webkit-scrollbar {
  width: 6px;
}

.canvas-grid-overlay {
  pointer-events: none;
}

.transpose-grid-scroller {
  overflow-anchor: none;
  scrollbar-gutter: stable;
  will-change: scroll-position;
}

.transpose-grid-scroller :deep(.vue-recycle-scroller__item-wrapper) {
  min-width: var(--transpose-total-w);
  overflow: visible;
}

.transpose-grid-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style paint;
}

.transpose-grid-scroller.is-scrolling :deep(.vue-recycle-scroller__item-view) {
  pointer-events: none;
}

.ddl-drawer-resizing {
  transition: none;
}

.table-info-drawer {
  container-type: inline-size;
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

.detail-drawer-resizing {
  transition: none;
}

.row-cell-selected {
  background-color: var(--data-grid-cell-selected-bg) !important;
  outline: 1px solid var(--data-grid-cell-selected-border);
  outline-offset: -1px;
}

.cell-dirty {
  background-color: var(--data-grid-cell-dirty-bg) !important;
}

.cell-search-match {
  background-color: var(--data-grid-cell-search-bg) !important;
}

.cell-current-search-match {
  background-color: var(--data-grid-cell-current-search-bg) !important;
  box-shadow: inset 0 0 0 2px var(--data-grid-cell-current-search-border);
}

.transpose-record-header-selected {
  background-color: var(--data-grid-row-number-selected-bg);
  outline: 1px solid var(--data-grid-cell-selected-border);
  outline-offset: -1px;
}

.transpose-record-header-active {
  background-color: var(--data-grid-row-number-selected-bg);
}

.cell-selected-dirty {
  background-color: var(--data-grid-cell-selected-dirty-bg) !important;
  outline: 1px solid var(--data-grid-cell-selected-border);
  outline-offset: -1px;
}

.row-cell-selected-dirty {
  background-color: var(--data-grid-cell-selected-dirty-bg) !important;
  outline: 1px solid var(--data-grid-cell-selected-border);
  outline-offset: -1px;
}

.data-grid-row-number.bg-emerald-500\/15 {
  background-color: var(--data-grid-row-number-new-bg);
}

.data-grid-row-number.bg-amber-500\/15 {
  background-color: var(--data-grid-row-number-edited-bg);
}

.data-grid-row-number.bg-destructive\/15 {
  background-color: var(--data-grid-row-number-deleted-bg);
}

.active-row > .data-grid-row-number {
  background-color: var(--data-grid-row-number-active-bg) !important;
}

.cell-selected {
  color: hsl(var(--foreground));
  background-color: var(--data-grid-cell-selected-bg) !important;
}

.cell-selected {
  @apply outline outline-primary -outline-offset-1;
}

:global(.dark) [data-grid-root] .cell-selected,
:global(.dark) [data-grid-root] .row-cell-selected {
  color: rgb(244, 244, 245) !important;
  background-color: rgb(66, 67, 70) !important;
}

:global(.dark) [data-grid-root] .cell-selected-dirty,
:global(.dark) [data-grid-root] .row-cell-selected-dirty {
  background-color: rgb(94, 75, 26) !important;
}

:global(.dark) [data-grid-root] .cell-selected,
:global(.dark) [data-grid-root] .row-cell-selected,
:global(.dark) [data-grid-root] .cell-selected-dirty,
:global(.dark) [data-grid-root] .row-cell-selected-dirty {
  outline-color: rgb(170, 170, 175) !important;
}

.ddl-code :deep(.ddl-kw) {
  color: rgb(39 132 213);
  color: oklch(0.6 0.15 250);
  font-weight: 600;
}

.ddl-code :deep(.ddl-ident) {
  color: rgb(58 168 91);
  color: oklch(0.65 0.15 150);
}

.ddl-code :deep(.ddl-str) {
  color: rgb(213 111 44);
  color: oklch(0.65 0.15 50);
}
</style>
