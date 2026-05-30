<script lang="ts">
import { ref } from "vue";
const globalDdlOpen = ref(false);
</script>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import {
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Download,
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
  Loader2,
  X,
  Undo2,
  WrapText,
  Info,
  Rows3,
  TriangleAlert,
  RefreshCcw,
  RotateCcw,
  Pencil,
  Filter,
  FileDown,
  SquareDashed,
  Check,
  CopyPlus,
  KeyRound,
  Link2,
  ListTree,
  Maximize2,
  TableProperties,
  LockKeyhole,
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ImagePreviewDialog from "@/components/grid/ImagePreviewDialog.vue";
import TemporalCellEditor from "@/components/grid/TemporalCellEditor.vue";
import type { QueryResult, ColumnInfo, DatabaseType, ForeignKeyInfo, IndexInfo, TriggerInfo } from "@/types/database";
import * as api from "@/lib/api";
import { createColumnDrafts } from "@/lib/tableStructureEditorState";
import type { BuildSingleColumnAlterSqlOptions } from "@/lib/tableStructureEditorSql";
import { buildTableSelectSql, quoteTableIdentifier } from "@/lib/tableSelectSql";
import { uuid } from "@/lib/utils";
import {
  canEditExistingTableRows,
  hiveTablePropertiesIndicateTransactional,
  isHiddenGridColumn,
  isTdengineExistingRowReadonlyColumn,
  usesSyntheticRowIdKey,
} from "@/lib/tableEditing";
import {
  buildDataGridContextFilterCondition,
  buildDataGridCountSql,
  buildHiveTablePropertiesSql,
  type DataGridContextFilterMode,
} from "@/lib/dataGridSql";
import {
  buildVisibleTransposeRows,
  nextAppendedTransposeState,
  nextContextTransposeState,
  nextKeyboardTransposeState,
  nextTransposeState,
  nextTransposeStateForRecordCount,
  transposeFieldWidth,
  transposeScrollLeftForRecord,
  visibleTransposeRecordWindow,
} from "@/lib/dataGridTranspose";
import { matchesRowStatusFilter, type RowStatus, type RowStatusFilter } from "@/lib/gridRowStatus";
import { displayCellValue, type CellValue } from "@/lib/cellValue";
import {
  canFormatCellDetailJson,
  cellDetailEditorText,
  defaultCellDetailTab,
  formatJsonText,
  linkedCellDetailTarget,
  valueEditorActions,
  visibleCellDetailTabs,
  type CellDetailTab,
} from "@/lib/cellDetailPresentation";
import {
  buildDataGridCellDetail,
  buildDataGridColumnDetail,
  buildDataGridRowDetail,
  dataGridColumnDetailJson,
  dataGridColumnDetailTsv,
  dataGridRowDetailJson,
  dataGridRowDetailTsv,
  type DataGridCellDetail,
} from "@/lib/dataGridDetail";
import {
  applyColumnFormatter,
  buildColumnFormatterKey,
  normalizeColumnFormatter,
  resolveColumnFormatter,
  type ColumnFormatterConfig,
  type DateTimeFormatterUnit,
} from "@/lib/columnFormatter";
import { temporalCellEditorKind, type TemporalCellEditorKind } from "@/lib/dataGridTemporalEditor";
import {
  isCancelSearchShortcut,
  isCopyCurrentRowShortcut,
  isDeleteCurrentRowShortcut,
  isFocusSearchShortcut,
  isModRShortcut,
  isToggleTransposeShortcut,
} from "@/lib/keyboardShortcuts";
import { dataGridHeaderContentWidth, scrollbarGutterWidth } from "@/lib/dataGridScrollGutter";
import { dataGridSaveActionMode, dataGridSaveToolbarState } from "@/lib/dataGridSaveUi";
import {
  appendColumnValueFilterCondition,
  buildColumnValueFilterCondition,
  combineWhereInputs,
  filterModeNeedsValue,
  parseFilterValue,
} from "@/lib/dataGridColumnFilter";
import { clampSearchSplitWidth } from "@/lib/dataGridSearchSplit";
import {
  MAX_RESULT_PAGE_SIZE,
  MIN_RESULT_PAGE_SIZE,
  normalizeResultPageSize,
  resultPageSizeMenuOptions,
} from "@/lib/paginationPageSize";
import {
  filterColumnVisibilityOptions,
  invertedHiddenColumnIndexes,
  nextHiddenColumnIndexes,
  visibleColumnIndexesForFilter,
} from "@/lib/dataGridColumnVisibility";

import { useToast } from "@/composables/useToast";
import { useDataGridExport } from "@/composables/useDataGridExport";
import { useDataGridColumnResize } from "@/composables/useDataGridColumnResize";
import { useDataGridSelection } from "@/composables/useDataGridSelection";
import { useDataGridEditor } from "@/composables/useDataGridEditor";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { useCellDetailEditor, type UseCellDetailEditorReturn } from "@/composables/useCellDetailEditor";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { isDark } = useTheme();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();

interface PreparedCopyValue {
  key: string;
  text: string;
  loading: boolean;
  ready: boolean;
}

const props = defineProps<{
  result: QueryResult;
  sql?: string;
  editable?: boolean;
  databaseType?: DatabaseType;
  connectionId?: string;
  database?: string;
  schema?: string;
  context?: "results" | "table-data";
  sourceColumns?: Array<string | undefined>;
  queryEditabilityReason?: string;
  initialWhereInput?: string;
  tableMeta?: {
    schema?: string;
    tableName: string;
    columns: ColumnInfo[];
    primaryKeys: string[];
  };
  pageOffset?: number;
  pageLimit?: number;
  countSql?: string;
  totalRowCount?: number;
  loading?: boolean;
  cacheKey?: string;
  onExecuteSql?: (sql: string) => Promise<void>;
  customSave?: (changes: {
    dirtyRows: Map<number, Map<number, string | number | boolean | null>>;
    newRows: (string | number | boolean | null)[][];
    deletedRows: Set<number>;
    columns: string[];
    rows: (string | number | boolean | null)[][];
  }) => Promise<void>;
}>();

const emit = defineEmits<{
  reload: [sql?: string, searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number];
  paginate: [offset: number, limit: number, whereInput?: string, orderBy?: string];
  sort: [column: string, columnIndex: number, direction: "asc" | "desc" | null, whereInput?: string];
  "update:whereInput": [value: string];
}>();

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

const columnCommentMap = computed(() => {
  const map = new Map<string, string>();
  if (props.tableMeta?.columns) {
    for (const col of props.tableMeta.columns) {
      if (col.comment) map.set(col.name, col.comment);
    }
  }
  return map;
});
const showColumnCommentsInHeader = computed(() => settingsStore.editorSettings.showColumnCommentsInHeader);
const compactColumnHeaderActions = computed(() => settingsStore.editorSettings.compactColumnHeaderActions);

function headerColumnComment(column: string): string {
  if (!showColumnCommentsInHeader.value) return "";
  return columnCommentMap.value.get(column) || "";
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

function typeColorClass(t: string): string {
  // Strip precision/scale suffix like (20,6)
  const base = t.replace(/\(.*\)$/, "").toLowerCase();
  if (
    [
      "int",
      "int2",
      "int4",
      "int8",
      "smallint",
      "bigint",
      "integer",
      "serial",
      "bigserial",
      "tinyint",
      "mediumint",
    ].includes(base)
  )
    return "text-blue-500";
  if (["float4", "float8", "double", "decimal", "numeric", "real", "float", "money"].includes(base))
    return "text-cyan-500";
  if (
    [
      "varchar",
      "text",
      "char",
      "character varying",
      "character",
      "string",
      "nvarchar",
      "nchar",
      "ntext",
      "longtext",
      "mediumtext",
      "tinytext",
      "clob",
    ].includes(base)
  )
    return "text-green-500";
  if (["bool", "boolean", "bit"].includes(base)) return "text-orange-500";
  if (["timestamp", "timestamptz", "datetime", "date", "time", "timetz", "datetime2", "smalldatetime"].includes(base))
    return "text-purple-500";
  if (["json", "jsonb", "xml", "array"].includes(base)) return "text-pink-500";
  if (["uuid", "uniqueidentifier"].includes(base)) return "text-amber-500";
  if (["bytea", "blob", "binary", "varbinary", "image"].includes(base)) return "text-red-400";
  return "text-muted-foreground";
}
const contextCell = ref<{ rowId: number; rowIndex: number; col: number } | null>(null);
const contextHeaderColumn = ref<string | null>(null);
const contextHeaderColumnIndex = ref<number | null>(null);
const detailCell = ref<{ rowIndex: number; col: number } | null>(null);
const hoveredDetailCell = ref<{ rowIndex: number; col: number } | null>(null);
const showCellDetail = ref(false);
const activeCellDetailTab = ref<CellDetailTab>(defaultCellDetailTab());
const cellDetailDialogOpen = ref(false);
const cellDetailDialogTarget = ref<{ rowIndex: number; col: number } | null>(null);
const rowDetailDialogOpen = ref(false);
const rowDetailDialogRowId = ref<number | null>(null);
const columnDetailDialogOpen = ref(false);
const columnDetailDialogColumnIndex = ref<number | null>(null);
const detailWidth = ref(320);
const isResizingDetail = ref(false);
const imagePreviewOpen = ref(false);
const imagePreviewSrc = ref("");
const imagePreviewTitle = ref("");
const transposeRowIndex = ref<number | null>(null);
const showTranspose = ref(false);
const preserveTransposeOnNextResult = ref(false);
const transposeScrollRef = ref<HTMLElement | { $el?: HTMLElement }>();
const transposeScrollLeft = ref(0);
const transposeViewportWidth = ref(0);
const sortCol = ref<string | null>(null);
const sortColIndex = ref<number | null>(null);
const sortDir = ref<"asc" | "desc">("asc");
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

const whereSuggestions = ref<string[]>([]);
const whereSuggestionIndex = ref(-1);
const whereFilterInputRef = ref<HTMLInputElement>();
const whereMeasureRef = ref<HTMLSpanElement>();
const whereSuggestionLeft = ref(0);
const whereSuggestionPosition = ref({ left: 0, top: 0 });

const orderBySuggestions = ref<string[]>([]);
const orderBySuggestionIndex = ref(-1);
const orderByInputRef = ref<HTMLInputElement>();
const orderByMeasureRef = ref<HTMLSpanElement>();
const orderBySuggestionLeft = ref(0);
const orderBySuggestionPosition = ref({ left: 0, top: 0 });

const orderByInput = ref("");
const hasOrderByInput = computed(() => orderByInput.value.trim().length > 0);
const whereFilterInput = ref(props.initialWhereInput ?? "");
const hasWhereFilterInput = computed(() => whereFilterInput.value.trim().length > 0);
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
}));

const orderBySuggestionStyle = computed(() => ({
  left: `${orderBySuggestionPosition.value.left}px`,
  top: `${orderBySuggestionPosition.value.top}px`,
}));

type LocalColumnFilterDraft = {
  columnIndex: number;
  values: Set<string>;
};

type FilterMode = DataGridContextFilterMode;

type StructuredFilterRule = {
  id: string;
  columnName: string;
  mode: FilterMode;
  rawValue: string;
  conjunction: "AND" | "OR";
};

const localColumnFilters = ref<Record<number, Set<string>>>({});
const localFilterOpenColumn = ref<number | null>(null);
const headerActionMenuOpenColumn = ref<number | null>(null);
const headerPanelDismissGuardUntil = ref(0);
const localFilterSearch = ref("");
const localFilterDraft = ref<LocalColumnFilterDraft | null>(null);
const filterBuilderOpen = ref(false);
const structuredFilterRules = ref<StructuredFilterRule[]>([]);
const appliedStructuredWhereInput = ref("");
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
const structuredFilterCount = computed(
  () =>
    structuredFilterRules.value.filter(
      (rule) => !!rule.columnName && (!filterModeNeedsValue(rule.mode) || rule.rawValue.trim().length > 0),
    ).length,
);
const hasStructuredFilters = computed(() => !!combineWhereInputs(undefined, appliedStructuredWhereInput.value));
const formatterOpenColumn = ref<number | null>(null);
type FormatterDraftKind = Exclude<ColumnFormatterConfig["kind"], "custom-ref">;
const CUSTOM_FORMATTER_NEW = "__new";
const formatterKind = ref<FormatterDraftKind>("datetime");
const formatterDateUnit = ref<DateTimeFormatterUnit>("auto");
const formatterJsonPath = ref("$.user.name");
const formatterMaskPrefix = ref(4);
const formatterMaskSuffix = ref(4);
const formatterCustomId = ref(CUSTOM_FORMATTER_NEW);
const formatterCustomName = ref("");
const formatterCustomTemplate = ref("${value}");

const savedCustomFormatters = computed(() => {
  return Object.values(settingsStore.editorSettings.customColumnFormatters).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
});

function localFilterKey(value: CellValue): string {
  if (value === null) return "__dbx_null__";
  if (typeof value === "boolean") return `bool:${value}`;
  if (typeof value === "number") return `num:${value}`;
  return `str:${String(value)}`;
}

function localFilterLabel(value: CellValue, columnIndex: number): string {
  return value === null ? "NULL" : formatCell(value, columnIndex);
}

function localFilterActive(colIdx: number): boolean {
  return !!localColumnFilters.value[colIdx]?.size;
}

const localFilterCount = computed(() => Object.values(localColumnFilters.value).filter((values) => values.size).length);
const hasLocalColumnFilters = computed(() => localFilterCount.value > 0);

function rowMatchesLocalColumnFilters(data: CellValue[]): boolean {
  const activeEntries = Object.entries(localColumnFilters.value).filter(([, selected]) => selected.size > 0);
  if (activeEntries.length === 0) return true;
  return activeEntries.every(([columnIndex, selected]) =>
    selected.has(localFilterKey(data[Number(columnIndex)] ?? null)),
  );
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

function buildLocalFilterOptions(columnIndex: number) {
  const byKey = new Map<string, { key: string; label: string; count: number; value: CellValue }>();
  const addValue = (value: CellValue) => {
    const key = localFilterKey(value);
    const current = byKey.get(key);
    if (current) {
      current.count += 1;
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
  const columnIndex = localFilterDraft.value?.columnIndex;
  if (columnIndex === undefined) return [];
  return buildLocalFilterOptions(columnIndex);
});

const localFilterOptions = computed(() => {
  const query = localFilterSearch.value.trim().toLowerCase();
  return localFilterAllOptions.value
    .filter((option) => !query || option.label.toLowerCase().includes(query))
    .slice(0, 500);
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

function openLocalFilter(colIdx: number) {
  localFilterSearch.value = "";
  const allKeys = buildLocalFilterOptions(colIdx).map((option) => option.key);
  localFilterDraft.value = {
    columnIndex: colIdx,
    values: new Set(localColumnFilters.value[colIdx] ?? allKeys),
  };
  localFilterOpenColumn.value = colIdx;
}

function guardHeaderPanelDismiss() {
  headerPanelDismissGuardUntil.value = Date.now() + 350;
}

function shouldIgnoreHeaderPanelClose(columnIndex: number, openColumn: number | null): boolean {
  return (
    compactColumnHeaderActions.value && openColumn === columnIndex && Date.now() < headerPanelDismissGuardUntil.value
  );
}

function openCompactLocalFilter(colIdx: number) {
  headerActionMenuOpenColumn.value = null;
  guardHeaderPanelDismiss();
  nextTick(() => {
    window.setTimeout(() => {
      guardHeaderPanelDismiss();
      openLocalFilter(colIdx);
    }, 0);
  });
}

function handleLocalFilterOpenChange(value: boolean, columnIndex: number) {
  if (value) {
    openLocalFilter(columnIndex);
  } else if (!shouldIgnoreHeaderPanelClose(columnIndex, localFilterOpenColumn.value)) {
    closeLocalFilter();
  }
}

function closeLocalFilter() {
  localFilterOpenColumn.value = null;
  localFilterDraft.value = null;
  localFilterSearch.value = "";
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
  return key
    ? resolveColumnFormatter(
        settingsStore.editorSettings.columnFormatters[key],
        settingsStore.editorSettings.customColumnFormatters,
      )
    : undefined;
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
  return { kind: "datetime", unit: formatterDateUnit.value };
}

function loadFormatterDraft(formatter: ColumnFormatterConfig | undefined) {
  const draft = formatter ?? { kind: "datetime", unit: "auto" as const };
  formatterKind.value = draft.kind === "custom-ref" ? "custom-template" : draft.kind;
  if (draft.kind === "datetime") {
    formatterDateUnit.value = draft.unit;
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
  const formatter = resolveColumnFormatter(
    currentFormatterDraft(),
    settingsStore.editorSettings.customColumnFormatters,
  );
  return displayItems.value.slice(0, 5).map((item, index) => {
    const value = item.data[columnIndex] ?? null;
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
  localFilterDraft.value = { ...draft, values: next };
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
  localFilterDraft.value = { ...draft, values: next };
}

async function applyLocalFilter() {
  const draft = localFilterDraft.value;
  if (!draft) return;
  if (
    canApplyTypedLocalFilterValue.value &&
    localFilterDraftIsAllSelected.value &&
    localFilterOptions.value.length === 0
  ) {
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

async function applyTypedLocalFilterValue() {
  const draft = localFilterDraft.value;
  if (!draft) return;
  const columnName = props.result.columns[draft.columnIndex];
  if (!columnName) return;
  const condition = await buildColumnValueFilterCondition({
    databaseType: props.databaseType,
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

function defaultStructuredFilterRule(): StructuredFilterRule {
  return {
    id: uuid(),
    columnName: filterBuilderColumnOptions.value[0] ?? "",
    mode: "equals",
    rawValue: "",
    conjunction: "AND",
  };
}

function ensureStructuredFilterRule() {
  if (structuredFilterRules.value.length === 0 && filterBuilderColumnOptions.value.length > 0) {
    structuredFilterRules.value = [defaultStructuredFilterRule()];
  }
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

function resetStructuredFilters() {
  appliedStructuredWhereInput.value = "";
  structuredFilterRules.value = filterBuilderColumnOptions.value.length > 0 ? [defaultStructuredFilterRule()] : [];
}

async function clearAllFilters() {
  if (!canUseWhereSearch.value) return;
  whereFilterInput.value = "";
  resetStructuredFilters();
  await applyWhereFilter();
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
  const rulesWithConditions = (
    await Promise.all(
      structuredFilterRules.value.map(async (rule) => {
        if (!rule.columnName) return { rule, condition: null };
        if (filterModeNeedsValue(rule.mode) && !rule.rawValue.trim()) return { rule, condition: null };
        const columnInfo = filterBuilderColumns.value.find((column) => column.name === rule.columnName);
        return {
          rule,
          condition:
            (await buildDataGridContextFilterCondition({
              databaseType: props.databaseType,
              columnName: rule.columnName,
              columnInfo,
              mode: rule.mode,
              value: filterModeNeedsValue(rule.mode) ? parseFilterValue(rule.rawValue, columnInfo) : null,
            })) ?? null,
        };
      }),
    )
  ).filter((item): item is { rule: StructuredFilterRule; condition: string } => !!item.condition);

  appliedStructuredWhereInput.value = buildGroupedWhere(
    rulesWithConditions.map((item) => item.condition),
    rulesWithConditions.map((item) => item.rule),
  );
  filterBuilderOpen.value = false;
  await applyWhereFilter();
}

watch(
  filterBuilderColumnOptions,
  (columns) => {
    if (columns.length === 0) {
      structuredFilterRules.value = [];
      appliedStructuredWhereInput.value = "";
      return;
    }
    if (structuredFilterRules.value.length === 0) {
      structuredFilterRules.value = [defaultStructuredFilterRule()];
      return;
    }
    structuredFilterRules.value = structuredFilterRules.value.map((rule) =>
      columns.includes(rule.columnName) ? rule : { ...rule, columnName: columns[0] ?? "" },
    );
  },
  { immediate: true },
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
    const input = whereFilterInputRef.value;
    const measure = whereMeasureRef.value;
    if (!input || !measure) return;
    const cursorPos = input.selectionStart ?? 0;
    measure.textContent = whereFilterInput.value.slice(0, cursorPos);
    whereSuggestionLeft.value = measure.getBoundingClientRect().width;
    const inputRect = input.getBoundingClientRect();
    whereSuggestionPosition.value = {
      left: Math.max(0, Math.min(inputRect.left + whereSuggestionLeft.value, window.innerWidth - 180)),
      top: inputRect.bottom + 2,
    };
  });
}

function acceptWhereSuggestion() {
  const idx = whereSuggestionIndex.value;
  if (idx < 0 || idx >= whereSuggestions.value.length) return;
  const sug = whereSuggestions.value[idx];
  const lastWordMatch = whereFilterInput.value.match(/([^\s,()><=!&|]+)$/);
  if (lastWordMatch) {
    const lastWord = lastWordMatch[1];
    const prefix = whereFilterInput.value.slice(0, -lastWord.length);
    whereFilterInput.value = prefix + sug;
  }
  whereSuggestions.value = [];
  whereSuggestionIndex.value = -1;
  whereFilterInputRef.value?.focus();
}

function dismissWhereSuggestions() {
  whereSuggestions.value = [];
  whereSuggestionIndex.value = -1;
}

function navigateWhereSuggestion(delta: number) {
  if (whereSuggestions.value.length === 0) return;
  whereSuggestionIndex.value = Math.min(
    Math.max(whereSuggestionIndex.value + delta, 0),
    whereSuggestions.value.length - 1,
  );
}

watch(whereFilterInput, (val) => {
  emit("update:whereInput", val);
  whereSuggestions.value = [];
  if (!props.tableMeta?.columns?.length) return;
  const trimmed = val.trim();
  if (trimmed.length === 0) return;
  const lastToken = trimmed.split(/[\s,()><=!&|]+/).pop() || "";
  if (lastToken.length > 0) {
    const tl = lastToken.toLowerCase();
    whereSuggestions.value = props.tableMeta.columns
      .map((c) => c.name)
      .filter((n) => n.toLowerCase().startsWith(tl) && n.toLowerCase() !== tl)
      .slice(0, 8);
    whereSuggestionIndex.value = 0;
    updateWhereSuggestionPosition();
  }
});

function onWhereFilterKeydown(e: KeyboardEvent) {
  if (e.key in PAIRS && !e.ctrlKey && !e.metaKey) {
    const input = e.target as HTMLInputElement;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    const close = PAIRS[e.key];
    if (start !== end) {
      e.preventDefault();
      const selected = whereFilterInput.value.slice(start, end);
      whereFilterInput.value =
        whereFilterInput.value.slice(0, start) + e.key + selected + close + whereFilterInput.value.slice(end);
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
    if (whereSuggestions.value.length > 0) {
      acceptWhereSuggestion();
      return;
    }
    applyWhereFilter();
  }
}

// --- ORDER BY input suggestions ---
function updateOrderBySuggestionPosition() {
  nextTick(() => {
    const input = orderByInputRef.value;
    const measure = orderByMeasureRef.value;
    if (!input || !measure) return;
    const cursorPos = input.selectionStart ?? 0;
    measure.textContent = orderByInput.value.slice(0, cursorPos);
    orderBySuggestionLeft.value = measure.getBoundingClientRect().width;
    const inputRect = input.getBoundingClientRect();
    orderBySuggestionPosition.value = {
      left: Math.max(0, Math.min(inputRect.left + orderBySuggestionLeft.value, window.innerWidth - 180)),
      top: inputRect.bottom + 2,
    };
  });
}

function acceptOrderBySuggestion() {
  const idx = orderBySuggestionIndex.value;
  if (idx < 0 || idx >= orderBySuggestions.value.length) return;
  const sug = orderBySuggestions.value[idx];
  const lastWordMatch = orderByInput.value.match(/([^\s,()]+)$/);
  if (lastWordMatch) {
    const lastWord = lastWordMatch[1];
    const prefix = orderByInput.value.slice(0, -lastWord.length);
    orderByInput.value = prefix + sug;
  }
  orderBySuggestions.value = [];
  orderBySuggestionIndex.value = -1;
  orderByInputRef.value?.focus();
}

function dismissOrderBySuggestions() {
  orderBySuggestions.value = [];
  orderBySuggestionIndex.value = -1;
}

function navigateOrderBySuggestion(delta: number) {
  if (orderBySuggestions.value.length === 0) return;
  orderBySuggestionIndex.value = Math.min(
    Math.max(orderBySuggestionIndex.value + delta, 0),
    orderBySuggestions.value.length - 1,
  );
}

watch(orderByInput, (val) => {
  orderBySuggestions.value = [];
  if (!props.tableMeta?.columns?.length) return;
  const trimmed = val.trim();
  if (trimmed.length === 0) return;
  const lastToken = trimmed.split(/[\s,()]+/).pop() || "";
  if (lastToken.length > 0 && !["asc", "desc"].includes(lastToken.toLowerCase())) {
    const tl = lastToken.toLowerCase();
    orderBySuggestions.value = props.tableMeta.columns
      .map((c) => c.name)
      .filter((n) => n.toLowerCase().startsWith(tl) && n.toLowerCase() !== tl)
      .slice(0, 8);
    orderBySuggestionIndex.value = 0;
    updateOrderBySuggestionPosition();
  }
});

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
    if (orderBySuggestions.value.length > 0) {
      acceptOrderBySuggestion();
      return;
    }
    applyOrderBySearch();
  }
}

const isApplyingWhere = ref(false);
const rowStatusFilter = ref<RowStatusFilter>("all");
const gridRef = ref<HTMLDivElement>();
const headerRef = ref<HTMLDivElement>();
const gridScrollbarGutter = ref(0);
const hiddenColumnIndexes = ref<Set<number>>(new Set());
const highlightedColumnIndex = ref<number | null>(null);
let highlightedColumnTimer = 0;
const displayableColumnIndexes = computed(() =>
  props.result.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !isHiddenGridColumn(props.databaseType, column, props.tableMeta?.primaryKeys ?? []))
    .map(({ index }) => index),
);
const visibleColumnIndexes = computed(() =>
  visibleColumnIndexesForFilter(displayableColumnIndexes.value, hiddenColumnIndexes.value),
);
const visibleColumns = computed(() => visibleColumnIndexes.value.map((index) => props.result.columns[index]));
const visibleSourceColumns = computed(() => {
  if (!props.sourceColumns || props.sourceColumns.length !== props.result.columns.length) return undefined;
  return visibleColumnIndexes.value.map((index) => props.sourceColumns?.[index]);
});
const visibleColumnCount = computed(() => visibleColumnIndexes.value.length);
const displayableColumnCount = computed(() => displayableColumnIndexes.value.length);
const hiddenColumnCount = computed(() => displayableColumnCount.value - visibleColumnCount.value);
function filteredColumnVisibilityOptions(query: string) {
  const displayable = new Set(displayableColumnIndexes.value);
  return filterColumnVisibilityOptions(props.result.columns, query).filter((option) => displayable.has(option.index));
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
const firstVisibleColumnIndex = computed(() => visibleColumnIndexes.value[0] ?? 0);
function actualColumnIndex(visibleColumnIndex: number): number {
  return visibleColumnIndexes.value[visibleColumnIndex] ?? visibleColumnIndex;
}
function matchesTableInfoColumn(resultColumn: string, sourceColumn: string | undefined, columnName: string): boolean {
  const target = columnName.toLocaleLowerCase();
  return resultColumn.toLocaleLowerCase() === target || sourceColumn?.toLocaleLowerCase() === target;
}
function scrollToTableInfoColumn(columnName: string) {
  const columnIndex = props.result.columns.findIndex((column, index) =>
    matchesTableInfoColumn(column, props.sourceColumns?.[index], columnName),
  );
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
    const headerCell = headerRef.value?.querySelector<HTMLElement>(`[data-grid-column-index="${columnIndex}"]`);
    if (visibleColIdx < 0 || !scroller || !headerCell) return;

    const targetLeft = Math.max(0, headerCell.offsetLeft - scroller.clientWidth / 2 + headerCell.offsetWidth / 2);
    scroller.scrollLeft = targetLeft;
    if (headerRef.value) {
      headerRef.value.scrollLeft = scroller.scrollLeft;
    }
  });
}

// --- Column resize composable ---
const { initColumnWidths, onResizeStart, autoFitColumn, columnVars, getIsResizing } = useDataGridColumnResize({
  columns: visibleColumns,
  sourceRows: computed(() => props.result.rows),
  columnIndexes: visibleColumnIndexes,
  gridRef,
});
const gridStyle = computed(() => ({
  ...columnVars.value,
  "--header-total-w": dataGridHeaderContentWidth("var(--total-w)", gridScrollbarGutter.value),
  "--grid-scrollbar-gutter": `${gridScrollbarGutter.value}px`,
}));
function updateGridScrollbarGutter(element: HTMLElement) {
  gridScrollbarGutter.value = scrollbarGutterWidth(element);
}
function syncHeaderScroll(e: Event) {
  updateGridScrollbarGutter(e.target as HTMLElement);
  if (headerRef.value) {
    headerRef.value.scrollLeft = (e.target as HTMLElement).scrollLeft;
  }
}

let scrollingTimer = 0;
const isScrolling = ref(false);
function onScrollerScroll(e: Event) {
  syncHeaderScroll(e);
  if (!isScrolling.value) isScrolling.value = true;
  clearTimeout(scrollingTimer);
  scrollingTimer = window.setTimeout(() => {
    isScrolling.value = false;
  }, 120);
}

initColumnWidths();
watch(() => visibleColumns.value.length, initColumnWidths);
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
    closeLocalFilter();
  },
);

// --- Pagination ---
const pageSize = ref(normalizeResultPageSize(settingsStore.editorSettings.pageSize));
const currentPage = ref(1);
const pageSizeOptions = computed(() => resultPageSizeMenuOptions(pageSize.value));
const customPageSizeInput = ref(String(pageSize.value));
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
  () => [props.pageOffset, props.pageLimit],
  ([offset, limit]) => {
    if (typeof offset !== "number" || typeof limit !== "number" || limit <= 0) return;
    const normalizedLimit = normalizeResultPageSize(limit);
    pageSize.value = normalizedLimit;
    currentPage.value = Math.floor(offset / normalizedLimit) + 1;
  },
);
const canGoNextPage = computed(() => props.result.has_more === true || props.result.rows.length >= pageSize.value);
const canJumpLastPage = computed(() => canGoNextPage.value && (!!props.tableMeta || !!props.countSql));
const showTruncationWarning = computed(
  () => props.result.truncated === true && typeof props.pageLimit !== "number" && props.result.has_more !== true,
);
const isResultsContext = computed(() => props.context === "results");
const resultEditStatus = computed(() => {
  if (!isResultsContext.value || !hasData.value) return null;
  if (props.editable && props.tableMeta) return "editable";
  if (props.queryEditabilityReason) return "readonly";
  return null;
});
const queryEditabilityHint = computed(() => {
  const reason = props.queryEditabilityReason;
  return reason ? t(`grid.queryEditUnsupported.${reason}`) : "";
});
const canUseWhereSearch = computed(() => !!props.tableMeta && !!props.onExecuteSql && !isResultsContext.value);
const tableUsesSyntheticRowId = computed(() =>
  usesSyntheticRowIdKey(props.databaseType, props.tableMeta?.primaryKeys ?? []),
);
const hiveTableTransactional = ref<boolean | undefined>(undefined);
const canEditExistingRows = computed(
  () =>
    !!props.customSave ||
    canEditExistingTableRows(props.databaseType, hiveTableTransactional.value, props.tableMeta?.primaryKeys ?? []),
);
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
  return (
    orderByInput.value.trim() ||
    (sortCol.value ? `${queryColumnRef(sortCol.value)} ${sortDir.value.toUpperCase()}` : undefined)
  );
}

function syncOrderByInputWithSort(column: string | null, direction: "asc" | "desc" | null) {
  orderByInput.value = column && direction ? `${queryColumnRef(column)} ${direction.toUpperCase()}` : "";
}

function firstPage() {
  if (currentPage.value <= 1) return;
  currentPage.value = 1;
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
function changePageSize(size: number) {
  const normalizedSize = normalizeResultPageSize(size);
  pageSize.value = normalizedSize;
  settingsStore.updateEditorSettings({ pageSize: normalizedSize });
  currentPage.value = 1;
  resetGridVerticalScroll(true);
  emit("paginate", 0, normalizedSize, currentWhereInput(), currentOrderBy());
}

function applyCustomPageSize() {
  changePageSize(normalizeResultPageSize(customPageSizeInput.value, pageSize.value));
}

async function lastPage() {
  if (!props.connectionId) return;
  let sql = props.countSql;
  let schema = props.schema;
  if (props.tableMeta) {
    sql = await buildDataGridCountSql({
      databaseType: props.databaseType,
      schema: props.tableMeta.schema,
      tableName: props.tableMeta.tableName,
      whereInput: currentWhereInput(),
    });
    schema = props.tableMeta.schema;
  }
  if (!sql) return;
  try {
    const result = await api.executeQuery(props.connectionId, props.database ?? "", sql, schema);
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

// --- Editing (composable) ---

interface RowItem {
  id: number;
  displayIndex: number;
  sourceIndex?: number;
  newIndex?: number;
  data: CellValue[];
  isNew: boolean;
  isDeleted: boolean;
  isDirtyCol: boolean[];
  status: RowStatus;
}

const editor = useDataGridEditor({
  result: computed(() => props.result),
  editable: computed(() => props.editable),
  databaseType: computed(() => props.databaseType),
  connectionId: computed(() => props.connectionId),
  database: computed(() => props.database),
  tableMeta: computed(() => props.tableMeta),
  sourceColumns: computed(() => props.sourceColumns),
  canEditExistingRows,
  onExecuteSql: computed(() => props.onExecuteSql),
  customSave: computed(() => props.customSave),
  sql: computed(() => props.sql),
  searchText,
  whereFilterInput,
  orderByInput,
  rowStatusFilter,
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
  pendingChangeCount,
  hasPendingChanges,
  transactionActive,
  isSaving,
  saveError,
  useTransaction,
  enterTransaction,
  exitTransaction,
  startEdit,
  commitEdit,
  applyCellValue,
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
  rowDataWithChanges,
  coerceCellValue,
  canEditColumn,
  resetGridVerticalScroll,
  getResetScrollAfterResult,
  clearResetScrollAfterResult,
  cleanupFrames,
} = editor;

const saveActionMode = computed(() =>
  dataGridSaveActionMode({
    pendingChangeCount: pendingChangeCount.value,
    useTransaction: !!useTransaction.value,
  }),
);
const saveToolbarState = computed(() =>
  dataGridSaveToolbarState({
    editable: props.editable,
    hasSaveTarget: !!props.tableMeta || !!props.customSave,
    hasPendingChanges: hasPendingChanges.value,
    isSaving: isSaving.value,
  }),
);

function canEditRowItem(item: RowItem | undefined): boolean {
  return !!props.editable && !!item && !item.isDeleted && (item.isNew || canEditExistingRows.value);
}

function canEditCellItem(item: RowItem | undefined, columnIndex: number): boolean {
  if (!canEditRowItem(item) || !canEditColumn(columnIndex)) return false;
  if (!item?.isNew) {
    const column = props.result.columns[columnIndex] ?? "";
    if (isTdengineExistingRowReadonlyColumn(props.databaseType, column, props.tableMeta?.columns ?? [])) return false;
  }
  return true;
}

function tableColumnForGridColumn(columnIndex: number): ColumnInfo | undefined {
  const columnName = props.sourceColumns?.[columnIndex] ?? props.result.columns[columnIndex];
  if (!columnName) return undefined;
  return props.tableMeta?.columns.find((column) => column.name.toLowerCase() === columnName.toLowerCase());
}

function temporalEditorKindForColumn(columnIndex: number): TemporalCellEditorKind | undefined {
  return temporalCellEditorKind(tableColumnForGridColumn(columnIndex)?.data_type, props.databaseType);
}

function canDeleteRowItem(item: RowItem | undefined): boolean {
  return !!props.editable && !!item && !item.isDeleted && (item.isNew || canEditExistingRows.value);
}

async function onToolbarRefresh() {
  if (transactionActive.value) {
    discardChanges();
  }
  emit(
    "reload",
    props.sql,
    searchText.value,
    whereFilterInput.value.trim() || undefined,
    currentOrderBy(),
    pageSize.value,
    (currentPage.value - 1) * pageSize.value,
  );
}

async function onToolbarCommit() {
  await saveChanges();
}

function onToolbarRollback() {
  preserveTransposeOnNextResult.value = showTranspose.value;
  discardChanges();
  emit(
    "reload",
    props.sql,
    searchText.value,
    whereFilterInput.value.trim() || undefined,
    currentOrderBy(),
    pageSize.value,
    (currentPage.value - 1) * pageSize.value,
  );
}

function addRow() {
  addEditorRow();
  focusAppendedTransposeRecord();
}

const sortedRows = computed(() => {
  let indices = localFilteredRows.value;
  const q = deferredClientSearchText.value;
  if (q) {
    const rows = props.result.rows;
    indices = indices.filter((sourceIndex) => {
      const data = rows[sourceIndex];
      return data.some((cell, columnIndex) => cell !== null && formatCell(cell, columnIndex).toLowerCase().includes(q));
    });
  }
  return indices;
});

const displayItems = computed<RowItem[]>(() => {
  const cols = props.result.columns;
  const rows = props.result.rows;
  const items: Omit<RowItem, "displayIndex">[] = sortedRows.value.map((sourceIndex) => {
    const row = rows[sourceIndex];
    const dirty = dirtyRows.value.get(sourceIndex);
    const data = rowDataWithChanges(row, sourceIndex);
    const isDirtyCol = row.map((_, colIdx) => dirty?.has(colIdx) ?? false);
    const isDeleted = deletedRows.value.has(sourceIndex);
    const status: RowStatus = isDeleted ? "deleted" : dirty ? "edited" : "clean";
    return { id: sourceIndex, sourceIndex, data, isNew: false, isDeleted, isDirtyCol, status };
  });
  newRows.value.forEach((row, i) => {
    if (!rowMatchesLocalColumnFilters(row)) return;
    items.push({
      id: -(i + 1),
      newIndex: i,
      data: row,
      isNew: true,
      isDeleted: false,
      isDirtyCol: cols.map(() => false),
      status: "new",
    });
  });
  return items
    .filter((item) => matchesRowStatusFilter(item.status, rowStatusFilter.value))
    .map((item, displayIndex) => ({ ...item, displayIndex }));
});

watch(
  () => displayItems.value.length,
  () => {
    nextTick(() => {
      const scrollerEl = gridRef.value?.querySelector<HTMLElement>(".data-grid-scroller");
      if (scrollerEl) updateGridScrollbarGutter(scrollerEl);
    });
  },
);

interface SearchMatch {
  displayRow: number;
  col: number;
}

const searchMatches = computed<SearchMatch[]>(() => {
  const q = deferredClientSearchText.value;
  if (!q) return [];
  const items = displayItems.value;
  const matches: SearchMatch[] = [];
  for (let r = 0; r < items.length; r++) {
    const data = items[r].data;
    for (let c = 0; c < data.length; c++) {
      if (data[c] !== null && formatCell(data[c], c).toLowerCase().includes(q)) {
        matches.push({ displayRow: r, col: c });
      }
    }
  }
  return matches;
});

const searchMatchSet = computed(() => {
  const set = new Set<string>();
  for (const m of searchMatches.value) {
    set.add(`${m.displayRow}:${m.col}`);
  }
  return set;
});

watch(searchMatches, (matches) => {
  currentMatchIndex.value = matches.length > 0 ? 0 : -1;
});

function cellIsSearchMatch(displayRow: number, col: number): boolean {
  return searchMatchSet.value.has(`${displayRow}:${col}`);
}

function cellIsCurrentMatch(displayRow: number, col: number): boolean {
  const idx = currentMatchIndex.value;
  if (idx < 0 || idx >= searchMatches.value.length) return false;
  const m = searchMatches.value[idx];
  return m.displayRow === displayRow && m.col === col;
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
  const scrollEl = gridRef.value;
  if (!scrollEl) return;
  const rowEl = scrollEl.querySelector(`[data-row-index="${match.displayRow}"]`) as HTMLElement | null;
  if (rowEl) rowEl.scrollIntoView({ block: "center" });
}

function getRowItem(rowId: number): RowItem | undefined {
  return displayItems.value.find((item) => item.id === rowId);
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

const deleteRowDetails = computed(() =>
  props.tableMeta?.tableName
    ? t("dangerDialog.deleteRowDetails", { table: props.tableMeta.tableName })
    : t("dangerDialog.deleteRowDetailsNoTable"),
);

const hasVisibleRows = computed(() => displayItems.value.length > 0);
const hasActiveFilter = computed(
  () => !!deferredClientSearchText.value || rowStatusFilter.value !== "all" || hasLocalColumnFilters.value,
);
const emptyTitle = computed(() => (hasActiveFilter.value ? t("grid.noFilteredRows") : t("grid.noRows")));
const emptyDescription = computed(() =>
  hasActiveFilter.value ? t("grid.noFilteredRowsDescription") : t("grid.noRowsDescription"),
);
const isErrorResult = computed(
  () => props.result.columns.length === 1 && props.result.columns[0] === "Error" && props.result.rows.length > 0,
);
const errorMessage = computed(() => (isErrorResult.value ? String(props.result.rows[0]?.[0] ?? "") : ""));
// --- Selection composable ---
const selection = useDataGridSelection({
  columns: visibleColumns,
  displayItems: visibleDisplayItems,
  editingCell,
  showTranspose,
  transposeRowIndex,
  gridRef,
});

const {
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
  hasRowSelection,
  selectedRowCount,
  clearRowSelection,
  handleRowClick,
  handleDataCellMousedown,
  isRowSelected,
} = selection;

const selectionSummary = computed(() => {
  if (hasRowSelection.value) return t("grid.selectedRows", { count: selectedRowCount.value });
  return t("grid.selectedCells", { count: selectedCellCount.value });
});

const multiRowCount = computed(() => {
  if (hasRowSelection.value) return selectedRowCount.value;
  const range = selectedRange.value;
  if (range && range.startRow !== range.endRow) return range.endRow - range.startRow + 1;
  return 1;
});

const isMultiRow = computed(() => multiRowCount.value > 1);

function onCellMouseenter(rowIndex: number, visibleColIdx: number, actualColIdx: number) {
  hoveredDetailCell.value = { rowIndex, col: actualColIdx };
  extendCellSelection(rowIndex, visibleColIdx);
}

function onCellMouseleave(rowIndex: number, actualColIdx: number) {
  if (hoveredDetailCell.value?.rowIndex === rowIndex && hoveredDetailCell.value.col === actualColIdx) {
    hoveredDetailCell.value = null;
  }
}

function cellDetailButtonVisible(rowIndex: number, actualColIdx: number) {
  return (
    (hoveredDetailCell.value?.rowIndex === rowIndex && hoveredDetailCell.value.col === actualColIdx) ||
    (showCellDetail.value && detailCell.value?.rowIndex === rowIndex && detailCell.value.col === actualColIdx)
  );
}

function affectedRowIds(): number[] {
  if (hasRowSelection.value && selectedRowCount.value > 0) {
    return [...selectedRowIds.value];
  }
  const range = selectedRange.value;
  if (range && range.startRow !== range.endRow) {
    return displayItems.value.slice(range.startRow, range.endRow + 1).map((item) => item.id);
  }
  return [];
}

function exportSelectedRowsCsv() {
  return exportCsv(affectedRowIds());
}

function exportSelectedRowsXlsx() {
  return exportXlsx(affectedRowIds());
}

function exportSelectedRowsJson() {
  return exportJson(affectedRowIds());
}

function exportSelectedRowsMarkdown() {
  return exportMarkdown(affectedRowIds());
}

function isRowActive(index: number): boolean {
  const item = displayItems.value[index];
  if (item && isRowSelected(item.id)) return true;
  const range = selectedRange.value;
  if (!range) return false;
  const coversAllVisibleRows = range.startRow === 0 && range.endRow >= displayItems.value.length - 1;
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
function cellDetailFor(rowIndex: number, columnIndex: number): DataGridCellDetail | null {
  const item = displayItems.value[rowIndex];
  if (!item) return null;
  return buildDataGridCellDetail({
    rowIndex,
    rowId: item.id,
    row: item.data,
    columns: props.result.columns,
    columnIndex,
    typeByColumn: columnTypeMap.value,
    commentByColumn: columnCommentMap.value,
    displayValue: (value, index) => formatCell(value, index),
    isEditable: canEditCellItem(item, columnIndex),
  });
}

const activeCellDetail = computed(() => {
  const cell = detailCell.value;
  return cell ? cellDetailFor(cell.rowIndex, cell.col) : null;
});

const dialogCellDetail = computed(() => {
  const target = cellDetailDialogTarget.value;
  return target ? cellDetailFor(target.rowIndex, target.col) : null;
});

const rowDetail = computed(() => {
  if (rowDetailDialogRowId.value === null) return null;
  const item = getRowItem(rowDetailDialogRowId.value);
  if (!item) return null;
  return buildDataGridRowDetail({
    rowIndex: item.displayIndex,
    rowId: item.id,
    row: item.data,
    columns: props.result.columns,
    columnIndexes: displayableColumnIndexes.value,
    typeByColumn: columnTypeMap.value,
    commentByColumn: columnCommentMap.value,
    displayValue: (value, index) => formatCell(value, index),
    isEditableColumn: (columnIndex) => canEditCellItem(item, columnIndex),
  });
});

const columnDetail = computed(() => {
  if (columnDetailDialogColumnIndex.value === null) return null;
  const columnIndex = columnDetailDialogColumnIndex.value;
  return buildDataGridColumnDetail({
    rows: displayItems.value.map((item) => ({
      rowIndex: item.displayIndex,
      rowId: item.id,
      row: item.data,
      isEditable: canEditCellItem(item, columnIndex),
    })),
    columns: props.result.columns,
    columnIndex,
    typeByColumn: columnTypeMap.value,
    commentByColumn: columnCommentMap.value,
    displayValue: (value, index) => formatCell(value, index),
  });
});

watch(cellDetailDialogOpen, (open) => {
  if (!open) cellDetailDialogTarget.value = null;
});

watch(rowDetailDialogOpen, (open) => {
  if (!open) rowDetailDialogRowId.value = null;
});

watch(columnDetailDialogOpen, (open) => {
  if (!open) columnDetailDialogColumnIndex.value = null;
});

const activeCellDetailTabs = computed(() => {
  const detail = activeCellDetail.value;
  return visibleCellDetailTabs({ isEditable: !!detail?.isEditable });
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
      databaseType: props.databaseType,
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
  detailEditValue.value = cellDetailEditorText(detail.value, detail.type);
  syncEditorFromDetailEdit();
  isEditingDetail.value = true;
});

const detailEditValue = ref("");
const isEditingDetail = ref(false);
const detailTemporalEditorKind = computed(() => {
  const detail = activeCellDetail.value;
  return detail ? temporalEditorKindForColumn(detail.colIndex) : undefined;
});

// CodeMirror-based cell detail editors
const detailsEditorContainer = ref<HTMLElement>();
const valueEditorContainer = ref<HTMLElement>();
let detailsDetailEditor: UseCellDetailEditorReturn | null = null;
let valueDetailEditor: UseCellDetailEditorReturn | null = null;

const editorThemeAccessor = () => settingsStore.editorSettings.theme;
const editorAppAppearance = () => (isDark.value ? "dark" : "light") as import("@/lib/appTheme").AppThemeAppearance;
const editorFontSize = () => settingsStore.editorSettings.fontSize;
const editorFontFamily = () => settingsStore.editorSettings.fontFamily;

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
      fontSize: editorFontSize,
      fontFamily: editorFontFamily,
    });
    await valueDetailEditor.create(el, detailEditValue.value, activeCellDetail.value?.type);
  } else if (!el && valueDetailEditor) {
    valueDetailEditor.destroy();
    valueDetailEditor = null;
  }
});

function resetDetailEdit() {
  isEditingDetail.value = false;
  detailEditValue.value = "";
}

function closeCellDetails() {
  resetDetailEdit();
  showCellDetail.value = false;
  detailCell.value = null;
}

function startDetailEdit() {
  const detail = activeCellDetail.value;
  if (!detail || !detail.isEditable) return;
  detailEditValue.value = cellDetailEditorText(detail.value, detail.type);
  isEditingDetail.value = true;
}

function commitDetailEdit() {
  const detail = activeCellDetail.value;
  if (!detail || !isEditingDetail.value) return;
  isEditingDetail.value = false;

  const item = getRowItem(detail.rowId);
  if (!item || item.isDeleted) return;

  if (item.isNew && item.newIndex !== undefined) {
    const oldVal = newRows.value[item.newIndex]?.[detail.colIndex];
    newRows.value[item.newIndex][detail.colIndex] = coerceCellValue(detailEditValue.value, oldVal);
    return;
  }

  if (item.sourceIndex === undefined) return;
  if (!canEditExistingRows.value) return;

  const oldVal = props.result.rows[item.sourceIndex]?.[detail.colIndex];
  const newVal = coerceCellValue(detailEditValue.value, oldVal);
  if (newVal !== oldVal) {
    if (!dirtyRows.value.has(item.sourceIndex)) dirtyRows.value.set(item.sourceIndex, new Map());
    dirtyRows.value.get(item.sourceIndex)!.set(detail.colIndex, newVal);
    if (useTransaction.value && !transactionActive.value) {
      enterTransaction();
    }
  } else {
    const rowChanges = dirtyRows.value.get(item.sourceIndex);
    rowChanges?.delete(detail.colIndex);
    if (rowChanges?.size === 0) dirtyRows.value.delete(item.sourceIndex);
  }
  dirtyRows.value = new Map(dirtyRows.value);
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
  detailEditValue.value = cellDetailEditorText(detail.value, detail.type);
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

  if (item.isNew && item.newIndex !== undefined) {
    newRows.value[item.newIndex][detail.colIndex] = null;
    newRows.value = [...newRows.value];
  } else if (item.sourceIndex !== undefined) {
    restoredValue = props.result.rows[item.sourceIndex]?.[detail.colIndex] ?? null;
    const rowChanges = dirtyRows.value.get(item.sourceIndex);
    rowChanges?.delete(detail.colIndex);
    if (rowChanges?.size === 0) dirtyRows.value.delete(item.sourceIndex);
    dirtyRows.value = new Map(dirtyRows.value);
  }

  detailEditValue.value = cellDetailEditorText(restoredValue, detail.type);
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
}

function setDetailNull() {
  const detail = activeCellDetail.value;
  if (!detail || !detail.isEditable) return;

  const item = getRowItem(detail.rowId);
  if (!item || item.isDeleted) return;

  if (item.isNew && item.newIndex !== undefined) {
    newRows.value[item.newIndex][detail.colIndex] = null;
    newRows.value = [...newRows.value];
    resetDetailEdit();
    detailCell.value = { ...detailCell.value! };
    return;
  }

  if (item.sourceIndex === undefined) return;
  if (!canEditExistingRows.value) return;
  if (!dirtyRows.value.has(item.sourceIndex)) dirtyRows.value.set(item.sourceIndex, new Map());
  dirtyRows.value.get(item.sourceIndex)!.set(detail.colIndex, null);
  dirtyRows.value = new Map(dirtyRows.value);
  if (useTransaction.value && !transactionActive.value) {
    enterTransaction();
  }
  resetDetailEdit();
  detailCell.value = { ...detailCell.value! };
}

function toggleSort(colName: string, colIdx: number) {
  if (getIsResizing()) return;
  currentPage.value = 1;
  resetGridVerticalScroll(true);
  if (sortCol.value === colName && sortColIndex.value === colIdx) {
    if (sortDir.value === "asc") {
      sortDir.value = "desc";
      syncOrderByInputWithSort(colName, "desc");
      emit("sort", colName, colIdx, "desc", currentWhereInput());
    } else {
      sortCol.value = null;
      sortColIndex.value = null;
      sortDir.value = "asc";
      syncOrderByInputWithSort(null, null);
      emit("sort", colName, colIdx, null, currentWhereInput());
    }
  } else {
    sortCol.value = colName;
    sortColIndex.value = colIdx;
    sortDir.value = "asc";
    syncOrderByInputWithSort(colName, "asc");
    emit("sort", colName, colIdx, "asc", currentWhereInput());
  }
}

function applyContextSort(direction: "asc" | "desc" | null) {
  if (!contextColumn.value || !contextCell.value) return;
  const column = contextColumn.value;
  const columnIndex = contextCell.value.col;
  currentPage.value = 1;
  if (direction) {
    sortCol.value = column;
    sortColIndex.value = columnIndex;
    sortDir.value = direction;
    syncOrderByInputWithSort(column, direction);
  } else {
    sortCol.value = null;
    sortColIndex.value = null;
    sortDir.value = "asc";
    syncOrderByInputWithSort(null, null);
  }
  emit("sort", column, columnIndex, direction, currentWhereInput());
}

async function contextFilterCondition(mode: FilterMode): Promise<string | null> {
  if (!contextColumn.value) return null;
  return (
    (await buildDataGridContextFilterCondition({
      databaseType: props.databaseType,
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

async function applyOrderBySearch() {
  if (!props.tableMeta || !props.onExecuteSql) return;
  const orderByClause = orderByInput.value.trim() || undefined;
  isApplyingWhere.value = true;
  saveError.value = "";
  currentPage.value = 1;
  sortCol.value = null;
  sortColIndex.value = null;
  sortDir.value = "asc";
  try {
    const sql = await buildTableSelectSql({
      databaseType: props.databaseType,
      schema: props.tableMeta.schema,
      tableName: props.tableMeta.tableName,
      columns: props.tableMeta.columns.map((column) => column.name),
      primaryKeys: props.tableMeta.primaryKeys,
      orderBy: orderByClause,
      limit: pageSize.value,
      whereInput: currentWhereInput(),
      includeRowId: tableUsesSyntheticRowId.value,
    });
    await props.onExecuteSql(sql);
  } catch (e: any) {
    saveError.value = String(e?.message || e);
  } finally {
    isApplyingWhere.value = false;
  }
}

async function applyWhereFilter() {
  if (!props.tableMeta || !props.onExecuteSql) return;
  isApplyingWhere.value = true;
  saveError.value = "";
  currentPage.value = 1;
  try {
    const sql = await buildTableSelectSql({
      databaseType: props.databaseType,
      schema: props.tableMeta.schema,
      tableName: props.tableMeta.tableName,
      columns: props.tableMeta.columns.map((column) => column.name),
      primaryKeys: props.tableMeta.primaryKeys,
      orderBy:
        orderByInput.value.trim() ||
        (sortCol.value ? `${queryColumnRef(sortCol.value)} ${sortDir.value.toUpperCase()}` : undefined),
      limit: pageSize.value,
      whereInput: currentWhereInput(),
      includeRowId: tableUsesSyntheticRowId.value,
    });
    await props.onExecuteSql(sql);
  } catch (e: any) {
    saveError.value = String(e?.message || e);
  } finally {
    isApplyingWhere.value = false;
  }
}

const CELL_DISPLAY_MAX_LENGTH = 256;

function formatCell(value: CellValue, columnIndex?: number): string {
  const formatter = columnIndex === undefined ? undefined : columnFormatter(columnIndex);
  const s = applyColumnFormatter(value, formatter);
  return s.length > CELL_DISPLAY_MAX_LENGTH ? s.slice(0, CELL_DISPLAY_MAX_LENGTH) : s;
}

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

function setRowStatusFilter(value: string) {
  rowStatusFilter.value = value as RowStatusFilter;
}

// --- Export composable ---
const {
  copyText,
  copyCell,
  copyRow,
  copyRowAsInsert,
  copyRowAsInsertWithoutPrimaryKeys,
  prefetchRowAsInsertStatement,
  canCopyPreparedInsert,
  prefetchRowAsUpdateStatement,
  canCopyPreparedUpdate,
  copyRowAsUpdate,
  canCopyRowAsInsertWithoutPrimaryKeys,
  canCopyRowAsUpdate,
  copyAll,
  copySelectionTsv,
  copySelectionCsv,
  copySelectionJson,
  copySelectionSqlInList,
  copySelectedRowsTsv,
  exportCsv,
  exportJson,
  exportMarkdown,
  exportXlsx,
  copySql,
} = useDataGridExport({
  columns: visibleColumns,
  displayItems: visibleDisplayItems,
  sql: computed(() => props.sql),
  tableMeta: computed(() => (props.tableMeta ? { ...props.tableMeta } : undefined)),
  databaseType: computed(() => props.databaseType),
  sourceColumns: visibleSourceColumns,
  hasCellSelection,
  selectedCells,
  selectedRange,
  contextCell: exportContextCell,
  getRowItem: (rowId: number) => visibleDisplayItems.value.find((item) => item.id === rowId),
  selectedRowIds,
  hasRowSelection,
});

const pageSizeMenuItems = computed(() =>
  pageSizeOptions.value.map((size) => ({
    value: String(size),
    label: `${size} ${t("grid.rowsPerPageShort")}`,
  })),
);

const exportMenuItems = computed(() => [
  { value: "csv", label: t("grid.exportCsv") },
  { value: "xlsx", label: t("grid.exportXlsx") },
  { value: "json", label: t("grid.exportJson") },
  { value: "markdown", label: t("grid.exportMarkdown") },
  ...(isMultiRow.value
    ? [
        { value: "selected-csv", label: t("grid.exportSelectedRowsCsv"), separatorBefore: true },
        { value: "selected-xlsx", label: t("grid.exportSelectedRowsXlsx") },
        { value: "selected-json", label: t("grid.exportSelectedRowsJson") },
        { value: "selected-markdown", label: t("grid.exportSelectedRowsMarkdown") },
      ]
    : []),
]);

function selectPageSizeMenuItem(value: string) {
  changePageSize(Number(value));
}

function selectExportMenuItem(value: string) {
  const actions: Record<string, () => void> = {
    csv: exportCsv,
    xlsx: exportXlsx,
    json: exportJson,
    markdown: exportMarkdown,
    "selected-csv": exportSelectedRowsCsv,
    "selected-xlsx": exportSelectedRowsXlsx,
    "selected-json": exportSelectedRowsJson,
    "selected-markdown": exportSelectedRowsMarkdown,
  };
  actions[value]?.();
}

// --- Cell selection and detail ---
function showCellDetails(rowIndex: number, colIndex: number) {
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
  showCellDetails(rowIndex, actualColIdx);
  gridRef.value?.focus({ preventScroll: true });
}

function onTransposeCellContext(rowIndex: number, actualColIdx: number, event: MouseEvent) {
  selectTransposeCell(rowIndex, actualColIdx, event);
  const item = displayItems.value[rowIndex];
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

function eventTargetAllowsNativeClipboard(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target?.closest("input, textarea, [contenteditable='true'], [role='textbox']");
}

function clipboardShortcut(event: KeyboardEvent, key: string): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === key;
}

function parseClipboardTable(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
  if (!normalized) return [[""]];
  return normalized.split("\n").map((row) => row.split("\t"));
}

async function pasteClipboardIntoSelection() {
  if (!props.editable) return;
  const start = selectedRangeStart();
  if (!start) return;

  const text = await navigator.clipboard.readText();
  const rows = parseClipboardTable(text);
  rows.forEach((row, rowOffset) => {
    const item = displayItems.value[start.rowIndex + rowOffset];
    if (!item) return;
    row.forEach((value, colOffset) => {
      const visibleCol = start.colIndex + colOffset;
      if (visibleCol >= visibleColumns.value.length) return;
      applyCellValue(item.id, actualColumnIndex(visibleCol), value);
    });
  });
  toast(t("grid.pasted"));
}

function cutSelection() {
  if (!props.editable || !selectedRange.value) return;
  copySelectionTsv();
  const range = selectedRange.value;
  for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex++) {
    const item = displayItems.value[rowIndex];
    if (!item) continue;
    for (let visibleCol = range.startCol; visibleCol <= range.endCol; visibleCol++) {
      applyCellValue(item.id, actualColumnIndex(visibleCol), null);
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
    const rowEl = gridRef.value?.querySelector<HTMLElement>(`[data-row-index="${rowIndex}"]`);
    const cellEl = rowEl?.querySelector<HTMLElement>(`[data-visible-col-index="${colIndex}"]`);
    (cellEl ?? rowEl)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function scrollGridRowIntoView(rowIndex: number) {
  const target = Math.max(0, Math.min(displayItems.value.length - 1, rowIndex));
  nextTick(() => {
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
  if (displayItems.value.length === 0) return false;
  const requestedRowIndex = currentTransposeRequestedRowIndex();
  const next = nextKeyboardTransposeState({
    showTranspose: showTranspose.value,
    transposeRowIndex: transposeRowIndex.value,
    requestedRowIndex,
    rowIds: displayItems.value.map((item) => item.id),
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
  if (!position || editingCell.value || displayItems.value.length === 0 || visibleColumnIndexes.value.length === 0)
    return false;
  const rowIndex = Math.max(0, Math.min(displayItems.value.length - 1, position.rowIndex + rowDelta));
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
  const item = displayItems.value[position.rowIndex];
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
  const item = displayItems.value[position.rowIndex];
  return item ? [item.id] : [];
}

function copyCurrentRow(): boolean {
  const rowIds = selectedOrCurrentRowIds();
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

  const deletableRowIds = rowIds.filter((rowId) => canDeleteRowItem(getRowItem(rowId)));
  if (deletableRowIds.length === 0) return false;
  if (deletableRowIds.length === 1) {
    requestDeleteRow(deletableRowIds[0]);
    return true;
  }
  requestDeleteRows(deletableRowIds);
  return true;
}

function commitGridEdit() {
  commitEdit();
  nextTick(() => gridRef.value?.focus({ preventScroll: true }));
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
    if (!props.editable || !selectedRange.value) return;
    event.preventDefault();
    await pasteClipboardIntoSelection();
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

function copyDetailColumnName() {
  if (!activeCellDetail.value) return;
  copyText(activeCellDetail.value.column);
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

function copyDialogCellColumnName() {
  const detail = dialogCellDetail.value;
  if (!detail) return;
  copyText(detail.column);
}

function openDialogCellInSidePanel() {
  const detail = dialogCellDetail.value;
  if (!detail) return;
  showCellDetails(detail.rowNumber - 1, detail.colIndex);
  cellDetailDialogOpen.value = false;
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

const TRANSPOSE_RECORD_DEFAULT_WIDTH = 168;
const TRANSPOSE_RECORD_MIN_WIDTH = 96;
const TRANSPOSE_PINNED_MIN_WIDTH = 104;
const transposeRecordWidths = ref<number[]>([]);

function calcTransposeRecordWidth(recordIndex: number): number {
  const item = displayItems.value[recordIndex];
  if (!item) return TRANSPOSE_RECORD_DEFAULT_WIDTH;
  let maxWidth = TRANSPOSE_RECORD_MIN_WIDTH;
  const charWidth = 8;
  const padding = 28;
  for (const value of item.data) {
    const text = value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    const displayLen = Math.min(text.length, 60);
    const width = displayLen * charWidth + padding;
    if (width > maxWidth) maxWidth = width;
  }
  return Math.max(TRANSPOSE_RECORD_MIN_WIDTH, Math.min(400, Math.round(maxWidth)));
}

function getTransposeRecordWidth(recordIndex: number): number {
  return transposeRecordWidths.value[recordIndex] ?? TRANSPOSE_RECORD_DEFAULT_WIDTH;
}

function ensureTransposeRecordWidths(count: number) {
  if (transposeRecordWidths.value.length !== count) {
    const prev = transposeRecordWidths.value;
    const next = new Array(count);
    for (let i = 0; i < count; i++) {
      next[i] = i < prev.length ? prev[i] : calcTransposeRecordWidth(i);
    }
    transposeRecordWidths.value = next;
  }
}

function estimatedTransposeRecordWidth(): number {
  const widths = transposeRecordWidths.value;
  if (widths.length === 0) return TRANSPOSE_RECORD_DEFAULT_WIDTH;
  return widths.reduce((sum, w) => sum + w, 0) / widths.length;
}

watch(
  () => displayItems.value.length,
  (count) => ensureTransposeRecordWidths(count),
);
const transposePinnedWidthOverride = ref<number | null>(null);
const transposePinnedWidth = computed(
  () => transposePinnedWidthOverride.value ?? transposeFieldWidth(visibleColumns.value),
);

const transposeRecordWindow = computed(() =>
  visibleTransposeRecordWindow({
    totalRecords: displayItems.value.length,
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
const transposeRows = computed(() => {
  return buildVisibleTransposeRows({
    columns: visibleColumns.value,
    records: displayItems.value.map((item) => item.data),
    recordIndexes: visibleTransposeRecordIndexes.value,
    valueIndexes: visibleColumnIndexes.value,
    typeByColumn: columnTypeMap.value,
    displayValue: (value, _column, index) => formatCell(value, visibleColumnIndexes.value[index]),
  });
});
const isTransposeMode = computed(() => showTranspose.value && transposeRows.value.length > 0);
const transposeTotalWidth = computed(
  () => transposePinnedWidth.value + displayItems.value.reduce((sum, _, i) => sum + getTransposeRecordWidth(i), 0),
);

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
}

function scrollTransposeRecordIntoView(rowIndex: number) {
  nextTick(() => {
    const el = transposeScrollElement();
    if (!el) return;
    el.scrollLeft = transposeScrollLeftForRecord({
      recordIndex: rowIndex,
      totalRecords: displayItems.value.length,
      viewportWidth: el.clientWidth,
      pinnedWidth: transposePinnedWidth.value,
      recordWidth: estimatedTransposeRecordWidth(),
    });
    updateTransposeViewport();
  });
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
    applyTransposeState(nextAppendedTransposeState(true, displayItems.value.length));
  });
}

function onTransposePinnedResizeStart(event: MouseEvent) {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = transposePinnedWidth.value;
  const onMove = (e: MouseEvent) => {
    transposePinnedWidthOverride.value = Math.max(TRANSPOSE_PINNED_MIN_WIDTH, startWidth + e.clientX - startX);
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
  ensureTransposeRecordWidths(displayItems.value.length);
  const startX = event.clientX;
  const startWidth = getTransposeRecordWidth(recordIndex);
  const onMove = (e: MouseEvent) => {
    const next = [...transposeRecordWidths.value];
    next[recordIndex] = Math.max(TRANSPOSE_RECORD_MIN_WIDTH, startWidth + e.clientX - startX);
    transposeRecordWidths.value = next;
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
  ensureTransposeRecordWidths(displayItems.value.length);
  const next = [...transposeRecordWidths.value];
  next[recordIndex] = calcTransposeRecordWidth(recordIndex);
  transposeRecordWidths.value = next;
}

function currentTransposeViewportRowIndex(): number {
  if (displayItems.value.length === 0) return 0;
  const rowIndex = transposeRowIndex.value ?? transposeRecordWindow.value.start;
  return Math.max(0, Math.min(displayItems.value.length - 1, rowIndex));
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
    rowIds: displayItems.value.map((item) => item.id),
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
  if (rowIndex < 0 || rowIndex >= displayItems.value.length) return;
  transposeRowIndex.value = rowIndex;
  contextHeaderColumn.value = null;
  contextHeaderColumnIndex.value = null;
  const item = displayItems.value[rowIndex];
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
  const item = displayItems.value[rowIndex];
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
  if (!isTransposeMode.value || displayItems.value.length === 0) return false;
  const current = transposeRowIndex.value ?? 0;
  const next = Math.max(0, Math.min(displayItems.value.length - 1, current + delta));
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
      applyTransposeState(
        nextTransposeStateForRecordCount(showTranspose.value, transposeRowIndex.value, displayItems.value.length),
      );
    } else {
      closeTranspose(false);
    }
    exitTransaction();
  },
);

// --- Context menu handlers ---
function onHeaderContext(col: string, columnIndex: number) {
  contextCell.value = null;
  clearCellSelection();
  clearRowSelection();
  contextHeaderColumn.value = col;
  contextHeaderColumnIndex.value = columnIndex;
}
async function copyHeaderColumn() {
  if (!contextHeaderColumn.value) return;
  await copyText(contextHeaderColumn.value);
}

const canCopyAlterColumnSql = computed(() => {
  if (!contextHeaderColumn.value || !props.tableMeta?.columns) return false;
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
function onCellContext(rowId: number, rowIndex: number, colIdx: number, visibleColIdx: number) {
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
  if (canCopyRowAsInsertWithoutPrimaryKeys.value) {
    await prefetchRowAsInsertStatement(true);
  }
  if (canCopyRowAsUpdate.value) {
    await prefetchRowAsUpdateStatement();
  }
}

const sqlOneLiner = computed(() => props.sql?.replace(/\s+/g, " ").trim() || "");

type TableInfoTab = "columns" | "indexes" | "foreignKeys" | "triggers" | "ddl";

const showTableInfo = globalDdlOpen;
const activeTableInfoTab = ref<TableInfoTab>("columns");
const ddlContent = ref("");
const ddlLoading = ref(false);
const ddlWidth = ref(320);
const ddlWrap = ref(true);
const isResizingDdl = ref(false);
let ddlResizeStartX = 0;
let ddlResizeStartWidth = 0;
let detailResizeStartX = 0;
let detailResizeStartWidth = 0;
const indexes = ref<IndexInfo[]>([]);
const indexesLoaded = ref(false);
const indexesLoading = ref(false);
const indexesError = ref("");
const foreignKeys = ref<ForeignKeyInfo[]>([]);
const foreignKeysLoaded = ref(false);
const foreignKeysLoading = ref(false);
const foreignKeysError = ref("");
const triggers = ref<TriggerInfo[]>([]);
const triggersLoaded = ref(false);
const triggersLoading = ref(false);
const triggersError = ref("");
const searchQuery = ref("");

watch(activeTableInfoTab, () => {
  searchQuery.value = "";
});

const ddlDrawerStyle = computed(() => ({
  width: `${ddlWidth.value}px`,
}));

const detailDrawerStyle = computed(() => ({
  width: `${detailWidth.value}px`,
}));

const tableInfoTabs = computed(
  () =>
    [
      {
        id: "columns" as const,
        label: t("grid.tableInfoColumns"),
        icon: ListTree,
        count: props.tableMeta?.columns.length,
      },
      { id: "indexes" as const, label: t("grid.tableInfoIndexes"), icon: KeyRound, count: indexes.value.length },
      {
        id: "foreignKeys" as const,
        label: t("grid.tableInfoForeignKeys"),
        icon: Link2,
        count: foreignKeys.value.length,
      },
      { id: "triggers" as const, label: t("grid.tableInfoTriggers"), icon: RotateCcw, count: triggers.value.length },
      { id: "ddl" as const, label: "DDL", icon: Code2 },
    ] satisfies Array<{ id: TableInfoTab; label: string; icon: Component; count?: number }>,
);

async function toggleTableInfo(tab: TableInfoTab = activeTableInfoTab.value) {
  if (showTableInfo.value && activeTableInfoTab.value === tab) {
    showTableInfo.value = false;
    return;
  }
  showTableInfo.value = true;
  await selectTableInfoTab(tab);
}

async function selectTableInfoTab(tab: TableInfoTab) {
  activeTableInfoTab.value = tab;
  if (tab === "ddl") await fetchDdl();
  else if (tab === "indexes") await fetchIndexes();
  else if (tab === "foreignKeys") await fetchForeignKeys();
  else if (tab === "triggers") await fetchTriggers();
}

async function fetchDdl() {
  if (!props.connectionId || !props.tableMeta) return;
  showTableInfo.value = true;
  ddlLoading.value = true;
  try {
    ddlContent.value = await api.getTableDdl(
      props.connectionId,
      props.database || "",
      props.tableMeta.schema || props.database || "",
      props.tableMeta.tableName,
    );
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
    indexes.value = await api.listIndexes(
      props.connectionId,
      props.database || "",
      props.tableMeta.schema || props.database || "",
      props.tableMeta.tableName,
    );
    indexesLoaded.value = true;
  } catch (e: any) {
    indexesError.value = String(e?.message || e);
  } finally {
    indexesLoading.value = false;
  }
}

async function fetchForeignKeys() {
  if (!props.connectionId || !props.tableMeta || foreignKeysLoaded.value || foreignKeysLoading.value) return;
  foreignKeysLoading.value = true;
  foreignKeysError.value = "";
  try {
    foreignKeys.value = await api.listForeignKeys(
      props.connectionId,
      props.database || "",
      props.tableMeta.schema || props.database || "",
      props.tableMeta.tableName,
    );
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
    triggers.value = await api.listTriggers(
      props.connectionId,
      props.database || "",
      props.tableMeta.schema || props.database || "",
      props.tableMeta.tableName,
    );
    triggersLoaded.value = true;
  } catch (e: any) {
    triggersError.value = String(e?.message || e);
  } finally {
    triggersLoading.value = false;
  }
}

watch(
  () => [props.connectionId, props.database, props.tableMeta?.schema, props.tableMeta?.tableName],
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
  ddlWidth.value = Math.min(Math.max(nextWidth, 240), 900);
}

function onDdlResizeEnd() {
  isResizingDdl.value = false;
  document.body.classList.remove("select-none", "cursor-col-resize");
  window.removeEventListener("mousemove", onDdlResizeMove);
  window.removeEventListener("mouseup", onDdlResizeEnd);
}

function onDetailResizeStart(event: MouseEvent) {
  isResizingDetail.value = true;
  detailResizeStartX = event.clientX;
  detailResizeStartWidth = detailWidth.value;
  document.body.classList.add("select-none", "cursor-col-resize");
  window.addEventListener("mousemove", onDetailResizeMove);
  window.addEventListener("mouseup", onDetailResizeEnd);
}

function onDetailResizeMove(event: MouseEvent) {
  if (!isResizingDetail.value) return;
  const nextWidth = detailResizeStartWidth + detailResizeStartX - event.clientX;
  detailWidth.value = Math.min(Math.max(nextWidth, 260), 900);
}

function onDetailResizeEnd() {
  isResizingDetail.value = false;
  document.body.classList.remove("select-none", "cursor-col-resize");
  window.removeEventListener("mousemove", onDetailResizeMove);
  window.removeEventListener("mouseup", onDetailResizeEnd);
}

const loadingElapsed = ref(0);
let _loadingTimer: ReturnType<typeof setInterval> | undefined;
let _loadingStart = 0;

watch(
  () => props.loading,
  (isLoading) => {
    clearInterval(_loadingTimer);
    if (isLoading) {
      _loadingStart = Date.now();
      loadingElapsed.value = 0;
      _loadingTimer = setInterval(() => {
        loadingElapsed.value = Date.now() - _loadingStart;
      }, 100);
    }
  },
);

onUnmounted(() => {
  cleanupFrames();
  onSearchSplitResizeEnd();
  onDdlResizeEnd();
  onDetailResizeEnd();
  finishCellSelection();
  clearTimeout(highlightedColumnTimer);
  clearTimeout(_searchTimer);
  clearInterval(_loadingTimer);
});

const filteredColumns = computed(() => {
  if (!searchQuery.value) return props.tableMeta?.columns ?? [];
  const q = searchQuery.value.toLowerCase();
  return (props.tableMeta?.columns ?? []).filter(
    (c) => c.name.toLowerCase().includes(q) || c.data_type.toLowerCase().includes(q),
  );
});

const filteredIndexes = computed(() => {
  if (!searchQuery.value) return indexes.value;
  const q = searchQuery.value.toLowerCase();
  return indexes.value.filter(
    (i) => i.name.toLowerCase().includes(q) || i.columns.some((c) => c.toLowerCase().includes(q)),
  );
});

const filteredForeignKeys = computed(() => {
  if (!searchQuery.value) return foreignKeys.value;
  const q = searchQuery.value.toLowerCase();
  return foreignKeys.value.filter(
    (fk) =>
      fk.name.toLowerCase().includes(q) ||
      fk.column.toLowerCase().includes(q) ||
      fk.ref_table.toLowerCase().includes(q) ||
      fk.ref_column.toLowerCase().includes(q),
  );
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
  focusSearch,
  visibleColumnCount,
  displayableColumnCount,
  hiddenColumnCount,
  filteredColumnVisibilityOptions,
  isColumnVisible,
  toggleColumnVisibility,
  showAllColumns,
  invertColumnVisibility,
  openCellDetailSearch,
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
    insertNoPk: isMultiRow.value
      ? t("grid.copyRowsInsertWithoutPrimaryKeys", { count })
      : t("grid.copyRowInsertWithoutPrimaryKeys"),
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
  items.push({ label: labels.insert, action: copyRowAsInsert, disabled: !canCopyPreparedInsert(false) });
  if (canCopyRowAsInsertWithoutPrimaryKeys.value) {
    items.push({
      label: labels.insertNoPk,
      action: copyRowAsInsertWithoutPrimaryKeys,
      disabled: !canCopyPreparedInsert(true),
    });
  }
  if (canCopyRowAsUpdate.value) {
    items.push({ label: labels.update, action: copyRowAsUpdate, disabled: !canCopyPreparedUpdate() });
  }
  items.push({ label: t("grid.copyAll"), action: copyAll });
  return { label: t("grid.copy"), icon: Copy, children: items };
}

function selectionSubmenu(): ContextMenuItem {
  return {
    label: t("grid.selection"),
    icon: SquareDashed,
    children: [
      { label: t("grid.copySelectionTsv"), action: copySelectionTsv },
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
  ];
  if (isMultiRow.value) {
    items.push(
      { label: "", separator: true },
      { label: t("grid.exportSelectedRowsCsv"), action: exportSelectedRowsCsv },
      { label: t("grid.exportSelectedRowsXlsx"), action: exportSelectedRowsXlsx },
      { label: t("grid.exportSelectedRowsJson"), action: exportSelectedRowsJson },
      { label: t("grid.exportSelectedRowsMarkdown"), action: exportSelectedRowsMarkdown },
    );
  }
  return { label: t("grid.export"), icon: FileDown, children: items };
}

const gridContextMenuItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = [];

  // 1. Copy column name
  if (contextHeaderColumn.value) {
    items.push({ label: t("grid.copyColumnName"), action: copyHeaderColumn, icon: Copy });
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
      { label: t("grid.sortAscending"), action: () => applyContextSort("asc"), icon: ArrowUp },
      { label: t("grid.sortDescending"), action: () => applyContextSort("desc"), icon: ArrowDown },
    );
    if (sortCol.value) {
      items.push({ label: t("grid.clearSort"), action: () => applyContextSort(null), icon: ArrowUpDown });
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
    items.push({
      label: labels.clone,
      action: () => (isMultiRow.value ? cloneRows(affectedRowIds()) : cloneRow(contextRowItem.value!.id)),
      icon: CopyPlus,
    });
    if (contextRowItem.value.isDeleted) {
      items.push({
        label: labels.restore,
        action: () => (isMultiRow.value ? restoreRows(affectedRowIds()) : restoreRow(contextRowItem.value!.id)),
        icon: Undo2,
      });
    } else if (canDeleteRowItem(contextRowItem.value)) {
      items.push({
        label: labels.delete,
        action: () =>
          isMultiRow.value ? requestDeleteRows(affectedRowIds()) : requestDeleteRow(contextRowItem.value!.id),
        icon: Trash2,
        variant: "destructive" as const,
      });
    }
    items.push({ label: "", separator: true });
  }

  // 8. Export submenu
  items.push(exportSubmenu());

  return items;
});
</script>

<template>
  <div
    ref="gridRef"
    data-grid-root
    class="h-full flex flex-col overflow-hidden outline-none"
    :style="gridStyle"
    tabindex="0"
    @keydown="onGridKeydown"
  >
    <CustomContextMenu :items="gridContextMenuItems" v-slot="{ onContextMenu }">
      <div
        v-if="hasData || canUseWhereSearch"
        class="flex-1 flex flex-col overflow-hidden"
        @contextmenu="onContextMenu"
      >
        <!-- Search bar -->
        <div
          class="data-grid-topbar-scroll shrink-0 overflow-x-auto border-b bg-muted/20"
          @scroll="
            updateWhereSuggestionPosition();
            updateOrderBySuggestionPosition();
          "
        >
          <div class="data-grid-topbar flex items-stretch relative">
            <div
              v-if="useTransaction && editable && (tableMeta || customSave)"
              class="flex items-center px-2 py-0.5 border-r shrink-0"
            >
              <Select
                :model-value="rowStatusFilter"
                @update:model-value="(value: any) => setRowStatusFilter(String(value))"
              >
                <SelectTrigger
                  class="h-5 max-w-28 border-0 bg-transparent px-0 py-0 text-xs font-medium text-foreground/70 shadow-none focus-visible:ring-0 data-[state=open]:text-foreground [&_svg]:size-3"
                >
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
            <template v-if="hasLocalColumnFilters">
              <div class="flex items-center gap-1 px-2 py-0.5 min-w-0">
                <button
                  type="button"
                  class="flex shrink-0 items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/15"
                  :title="t('grid.clearLocalFilters')"
                  @click="clearLocalFilter()"
                >
                  <Filter class="h-3 w-3" />
                  {{ localFilterCount }}
                  <X class="h-3 w-3" />
                </button>
              </div>
            </template>

            <template v-if="canUseWhereSearch">
              <div ref="searchSplitContainerRef" class="flex flex-1 min-w-0">
                <div
                  class="flex flex-1 items-center gap-1 px-2 py-0.5 border-l min-w-0 relative"
                  :style="whereSearchPaneStyle"
                >
                  <Popover v-model:open="filterBuilderOpen">
                    <PopoverTrigger as-child>
                      <button
                        type="button"
                        class="relative flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[11px] font-medium transition-colors"
                        :class="
                          hasStructuredFilters
                            ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15'
                            : 'border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground'
                        "
                        @click="ensureStructuredFilterRule"
                      >
                        <Filter class="h-3 w-3" />
                        <span
                          v-if="structuredFilterCount"
                          class="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-none text-primary-foreground"
                        >
                          {{ structuredFilterCount }}
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
                          <div
                            class="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-2"
                          >
                            <Select
                              :model-value="rule.columnName"
                              @update:model-value="
                                (value: any) => updateStructuredFilterRule(rule.id, { columnName: String(value) })
                              "
                            >
                              <SelectTrigger class="h-8 min-w-0 text-xs">
                                <SelectValue :placeholder="t('grid.filterBuilderColumn')" />
                              </SelectTrigger>
                              <SelectContent position="popper">
                                <SelectItem
                                  v-for="columnName in filterBuilderColumnOptions"
                                  :key="columnName"
                                  :value="columnName"
                                >
                                  {{ columnName }}
                                </SelectItem>
                              </SelectContent>
                            </Select>

                            <Select
                              :model-value="rule.mode"
                              @update:model-value="
                                (value: any) => updateStructuredFilterRule(rule.id, { mode: value as FilterMode })
                              "
                            >
                              <SelectTrigger class="h-8 min-w-0 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent position="popper">
                                <SelectItem
                                  v-for="option in filterModeOptions"
                                  :key="option.value"
                                  :value="option.value"
                                >
                                  {{ t(option.labelKey) }}
                                </SelectItem>
                              </SelectContent>
                            </Select>

                            <Input
                              v-if="filterModeNeedsValue(rule.mode)"
                              :model-value="rule.rawValue"
                              class="h-8 min-w-0 text-xs"
                              :placeholder="t('grid.filterBuilderValue')"
                              @update:model-value="
                                (value) => updateStructuredFilterRule(rule.id, { rawValue: String(value ?? '') })
                              "
                              @keydown.enter.prevent="applyStructuredFilters"
                            />
                            <div
                              v-else
                              class="flex h-8 items-center rounded-md border border-dashed px-2 text-xs text-muted-foreground"
                            >
                              {{ t("grid.filterBuilderNoValue") }}
                            </div>

                            <Button
                              variant="ghost"
                              size="icon"
                              class="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                              :disabled="structuredFilterRules.length === 1"
                              @click="removeStructuredFilterRule(rule.id)"
                            >
                              <Trash2 class="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </template>
                      </div>

                      <div
                        v-else
                        class="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground"
                      >
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
                  <span class="text-blue-600 dark:text-blue-400 text-xs font-medium select-none shrink-0">WHERE</span>
                  <input
                    ref="whereFilterInputRef"
                    v-model="whereFilterInput"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck="false"
                    class="flex-1 h-5 min-w-0 text-xs bg-transparent outline-none placeholder:text-muted-foreground/60"
                    placeholder=""
                    @keydown="onWhereFilterKeydown"
                    @click="updateWhereSuggestionPosition"
                    @blur="dismissWhereSuggestions"
                  />
                  <span
                    ref="whereMeasureRef"
                    class="invisible absolute left-0 top-0 text-xs whitespace-pre pointer-events-none"
                    aria-hidden="true"
                  />
                  <!-- WHERE suggestion dropdown -->
                  <Teleport to="body">
                    <div
                      v-if="whereSuggestions.length > 0"
                      class="fixed z-50 min-w-[180px] rounded-md border bg-popover text-popover-foreground shadow-md"
                      :style="whereSuggestionStyle"
                    >
                      <div
                        v-for="(sug, idx) in whereSuggestions"
                        :key="sug"
                        class="flex items-center px-3 py-1.5 text-xs cursor-pointer"
                        :class="
                          idx === whereSuggestionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                        "
                        @mousedown.prevent="
                          whereSuggestionIndex = idx;
                          acceptWhereSuggestion();
                        "
                        @mouseenter="whereSuggestionIndex = idx"
                      >
                        <Search class="w-3 h-3 mr-2 text-muted-foreground shrink-0" />
                        <span>{{ sug }}</span>
                      </div>
                    </div>
                  </Teleport>
                  <button
                    v-if="hasWhereFilterInput"
                    class="text-muted-foreground hover:text-foreground shrink-0"
                    @click="
                      whereFilterInput = '';
                      applyWhereFilter();
                    "
                  >
                    <X class="w-3 h-3" />
                  </button>
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
                <div class="flex flex-1 items-center gap-1 px-2 py-0.5 border-r min-w-0 relative">
                  <span class="text-orange-600 dark:text-orange-400 text-xs font-medium select-none shrink-0"
                    >ORDER BY</span
                  >
                  <input
                    ref="orderByInputRef"
                    v-model="orderByInput"
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck="false"
                    class="flex-1 h-5 min-w-0 text-xs bg-transparent outline-none placeholder:text-muted-foreground/60"
                    placeholder=""
                    @keydown="onOrderByKeydown"
                    @click="updateOrderBySuggestionPosition"
                    @blur="dismissOrderBySuggestions"
                  />
                  <span
                    ref="orderByMeasureRef"
                    class="invisible absolute left-0 top-0 text-xs whitespace-pre pointer-events-none"
                    aria-hidden="true"
                  />
                  <!-- ORDER BY suggestion dropdown -->
                  <Teleport to="body">
                    <div
                      v-if="orderBySuggestions.length > 0"
                      class="fixed z-50 min-w-[180px] rounded-md border bg-popover text-popover-foreground shadow-md"
                      :style="orderBySuggestionStyle"
                    >
                      <div
                        v-for="(sug, idx) in orderBySuggestions"
                        :key="sug"
                        class="flex items-center px-3 py-1.5 text-xs cursor-pointer"
                        :class="
                          idx === orderBySuggestionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                        "
                        @mousedown.prevent="
                          orderBySuggestionIndex = idx;
                          acceptOrderBySuggestion();
                        "
                        @mouseenter="orderBySuggestionIndex = idx"
                      >
                        <Search class="w-3 h-3 mr-2 text-muted-foreground shrink-0" />
                        <span>{{ sug }}</span>
                      </div>
                    </div>
                  </Teleport>
                  <button
                    v-if="hasOrderByInput"
                    class="text-muted-foreground hover:text-foreground shrink-0"
                    @click="
                      orderByInput = '';
                      applyOrderBySearch();
                    "
                  >
                    <X class="w-3 h-3" />
                  </button>
                </div>
              </div>
            </template>

            <slot name="search-bar" />

            <div class="flex shrink-0 items-center gap-1 px-1 ml-auto">
              <Tooltip v-if="resultEditStatus === 'editable'">
                <TooltipTrigger as-child>
                  <div
                    class="flex h-5 items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300"
                  >
                    {{ t("grid.queryEditReady") }}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" class="max-w-sm">
                  {{ t("grid.queryEditReadyHint", { table: tableMeta?.tableName }) }}
                </TooltipContent>
              </Tooltip>
              <Tooltip v-else-if="resultEditStatus === 'readonly' && queryEditabilityHint">
                <TooltipTrigger as-child>
                  <div
                    class="flex h-5 items-center gap-1 rounded border border-border bg-background px-1.5 text-xs font-medium text-muted-foreground"
                  >
                    <LockKeyhole class="h-3 w-3" />
                    {{ t("grid.queryEditReadOnly") }}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" class="max-w-sm">
                  {{ queryEditabilityHint }}
                </TooltipContent>
              </Tooltip>
              <Button
                variant="ghost"
                size="sm"
                class="h-5 text-xs px-1.5 shrink-0"
                :disabled="isSaving"
                @click="onToolbarRefresh"
              >
                <Loader2 v-if="loading" class="w-3 h-3 mr-1 animate-spin" />
                <RefreshCcw v-else class="w-3 h-3 mr-1" />
                {{ t("grid.refresh") }}
              </Button>
              <Button
                v-if="editable && (tableMeta || customSave)"
                variant="ghost"
                size="sm"
                class="h-5 text-xs px-1.5 shrink-0"
                @click="addRow"
              >
                <Plus class="w-3 h-3 mr-1" /> {{ t("grid.addRow") }}
              </Button>
              <span
                v-if="transactionActive"
                class="flex shrink-0 items-center gap-1 px-1 text-xs text-emerald-600 dark:text-emerald-400"
              >
                <span class="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {{ t("grid.transactionActive") }}
              </span>
              <template v-if="saveToolbarState.showActions">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      variant="default"
                      size="sm"
                      class="h-5 text-xs px-1.5 shrink-0"
                      :disabled="saveToolbarState.actionsDisabled"
                      @click="onToolbarCommit"
                    >
                      <Loader2 v-if="isSaving" class="w-3 h-3 mr-1 animate-spin" />
                      <Save v-else class="w-3 h-3 mr-1" />
                      {{ t(saveActionMode.labelKey, { count: pendingChangeCount }) }}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" class="max-w-sm">
                    {{ t(saveActionMode.tooltipKey, { count: pendingChangeCount }) }}
                  </TooltipContent>
                </Tooltip>
                <Button
                  variant="outline"
                  size="sm"
                  class="h-5 text-xs px-1.5 shrink-0"
                  :disabled="saveToolbarState.actionsDisabled"
                  @click="useTransaction ? onToolbarRollback() : discardChanges()"
                >
                  <RotateCcw class="w-3 h-3 mr-1" />
                  {{ t(saveActionMode.secondaryActionKey) }}
                </Button>
              </template>
            </div>
          </div>
        </div>
        <!-- Truncation warning banner -->
        <div
          v-if="showTruncationWarning"
          class="shrink-0 px-3 py-1 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5"
        >
          <span>{{ t("grid.truncatedHint", { count: pageSize }) }}</span>
        </div>
        <!-- Content area: table + DDL drawer -->
        <div class="flex-1 flex min-h-0 overflow-hidden">
          <div class="flex-1 flex flex-col min-w-0 overflow-hidden relative">
            <!-- Search overlay (Ctrl+F) -->
            <Transition
              enter-active-class="transition-opacity duration-150"
              leave-active-class="transition-opacity duration-100"
              enter-from-class="opacity-0"
              leave-to-class="opacity-0"
            >
              <div
                v-if="searchOverlayVisible"
                class="absolute top-1 right-2 z-20 flex items-center gap-1 px-2 py-1 bg-background border rounded-md shadow-md"
              >
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
                <span
                  ref="measureRef"
                  class="invisible absolute left-0 top-0 text-xs whitespace-pre pointer-events-none"
                  aria-hidden="true"
                />
                <div
                  v-if="searchSuggestions.length > 0"
                  class="absolute top-full right-0 mt-0.5 z-50 min-w-[180px] rounded-md border bg-popover text-popover-foreground shadow-md"
                >
                  <div
                    v-for="(sug, idx) in searchSuggestions"
                    :key="sug"
                    class="flex items-center px-3 py-1.5 text-xs cursor-pointer"
                    :class="idx === suggestionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'"
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
                <span v-if="searchMatches.length > 0" class="text-xs text-muted-foreground shrink-0">
                  {{ currentMatchIndex + 1 }}/{{ searchMatches.length }}
                </span>
                <span v-else-if="deferredClientSearchText" class="text-xs text-muted-foreground shrink-0"> 0 </span>
                <button class="text-muted-foreground hover:text-foreground shrink-0" @click="closeSearch">
                  <X class="w-3.5 h-3.5" />
                </button>
              </div>
            </Transition>
            <div v-if="isTransposeMode" class="flex-1 flex flex-col min-h-0 overflow-hidden">
              <div class="h-8 flex items-center gap-2 px-3 border-y shrink-0 bg-muted/20">
                <Rows3 class="w-3.5 h-3.5 text-muted-foreground" />
                <span class="text-xs font-medium">{{ t("grid.transpose") }}</span>
                <span class="text-xs text-muted-foreground">
                  {{ t("grid.rowNumber") }} {{ (transposeRowIndex ?? 0) + 1 }}
                </span>
                <span class="flex-1" />
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5"
                  :disabled="transposeRowIndex === 0"
                  @click="transposeNav(-1)"
                >
                  <ChevronLeft class="w-3 h-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5"
                  :disabled="transposeRowIndex === displayItems.length - 1"
                  @click="transposeNav(1)"
                >
                  <ChevronRight class="w-3 h-3" />
                </Button>
                <Button variant="ghost" size="icon" class="h-5 w-5" @click="closeTranspose">
                  <X class="w-3 h-3" />
                </Button>
              </div>
              <RecycleScroller
                ref="transposeScrollRef"
                class="transpose-grid-scroller flex-1 min-h-0 overflow-auto overscroll-none bg-background"
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
                  <div
                    class="sticky top-0 z-20 flex h-7 border-b border-border bg-[rgb(239_239_239)] text-xs font-semibold text-muted-foreground dark:bg-muted"
                    :style="{ width: `${transposeTotalWidth}px` }"
                  >
                    <div
                      class="sticky left-0 z-30 shrink-0 border-r border-border px-3 py-1.5 bg-[rgb(239_239_239)] truncate dark:bg-muted relative"
                      :style="{ width: `${transposePinnedWidth}px` }"
                    >
                      {{ t("grid.columnName") }}
                      <div
                        class="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30"
                        @mousedown.stop="onTransposePinnedResizeStart"
                      />
                    </div>
                    <div class="shrink-0" :style="{ width: `${transposeRecordWindow.beforeWidth}px` }" />
                    <div
                      v-for="recordIndex in visibleTransposeRecordIndexes"
                      :key="`transpose-head-${recordIndex}`"
                      class="shrink-0 border-r border-border px-2 py-1.5 text-center tabular-nums relative"
                      :class="{
                        'transpose-record-header-selected text-primary font-semibold':
                          transposeRecordUsesFramedHeader(recordIndex),
                        'transpose-record-header-active text-primary':
                          transposeRecordUsesActiveHighlight(recordIndex) &&
                          !transposeRecordUsesFramedHeader(recordIndex),
                        'bg-[rgb(239_239_239)] dark:bg-muted':
                          !transposeRecordUsesActiveHighlight(recordIndex) &&
                          !transposeRecordUsesFramedHeader(recordIndex),
                      }"
                      :style="{ width: `${getTransposeRecordWidth(recordIndex)}px` }"
                      @click="selectTransposeRecord(recordIndex, $event)"
                      @contextmenu="selectTransposeRecord(recordIndex, $event)"
                    >
                      {{ recordIndex + 1 }}
                      <div
                        class="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30"
                        @mousedown.stop="onTransposeRecordResizeStart(recordIndex, $event)"
                        @dblclick.stop="autoFitTransposeRecord(recordIndex)"
                      />
                    </div>
                    <div class="shrink-0" :style="{ width: `${transposeRecordWindow.afterWidth}px` }" />
                  </div>
                </template>
                <template #default="{ item }">
                  <div
                    class="flex border-b border-border/60 text-xs"
                    :style="{ height: '30px', width: `${transposeTotalWidth}px` }"
                  >
                    <div
                      class="sticky left-0 z-10 shrink-0 border-r border-border bg-background px-3 py-1.5 font-medium truncate"
                      :style="{ width: `${transposePinnedWidth}px` }"
                      :title="item.column"
                    >
                      {{ item.column }}
                    </div>
                    <div class="shrink-0" :style="{ width: `${transposeRecordWindow.beforeWidth}px` }" />
                    <div
                      v-for="cell in item.values"
                      :key="`${item.id}:${cell.recordIndex}`"
                      class="relative shrink-0 border-r border-border/70 px-2 py-1.5 font-mono truncate"
                      :class="{
                        'text-muted-foreground italic': cell.isNull,
                        'cell-selected':
                          transposeCellIsSelected(cell.recordIndex, cell.valueIndex) &&
                          !displayItems[cell.recordIndex]?.isDirtyCol[cell.valueIndex],
                        'cell-selected-dirty':
                          transposeCellIsSelected(cell.recordIndex, cell.valueIndex) &&
                          displayItems[cell.recordIndex]?.isDirtyCol[cell.valueIndex],
                        'row-cell-selected':
                          transposeRecordUsesSelectionVisual(cell.recordIndex) &&
                          !transposeCellIsSelected(cell.recordIndex, cell.valueIndex) &&
                          !displayItems[cell.recordIndex]?.isDirtyCol[cell.valueIndex],
                        'row-cell-selected-dirty':
                          transposeRecordUsesSelectionVisual(cell.recordIndex) &&
                          !transposeCellIsSelected(cell.recordIndex, cell.valueIndex) &&
                          displayItems[cell.recordIndex]?.isDirtyCol[cell.valueIndex],
                        'bg-primary/15':
                          transposeRecordUsesActiveHighlight(cell.recordIndex) &&
                          !transposeRecordUsesSelectionVisual(cell.recordIndex) &&
                          !displayItems[cell.recordIndex]?.isDirtyCol[cell.valueIndex] &&
                          !transposeCellIsSelected(cell.recordIndex, cell.valueIndex),
                        'bg-yellow-500/10 cell-dirty': displayItems[cell.recordIndex]?.isDirtyCol[cell.valueIndex],
                        'cursor-text': canEditCellItem(displayItems[cell.recordIndex], cell.valueIndex),
                        'hover:bg-accent/50':
                          canEditCellItem(displayItems[cell.recordIndex], cell.valueIndex) &&
                          !transposeRecordUsesSelectionVisual(cell.recordIndex) &&
                          !transposeRecordUsesActiveHighlight(cell.recordIndex) &&
                          !transposeCellIsSelected(cell.recordIndex, cell.valueIndex),
                      }"
                      :style="{ width: `${getTransposeRecordWidth(cell.recordIndex)}px` }"
                      :title="cell.display"
                      @click="selectTransposeCell(cell.recordIndex, cell.valueIndex, $event)"
                      @mouseenter="onTransposeCellMouseenter(cell.recordIndex, cell.valueIndex)"
                      @mouseleave="onCellMouseleave(cell.recordIndex, cell.valueIndex)"
                      @contextmenu="onTransposeCellContext(cell.recordIndex, cell.valueIndex, $event)"
                      @dblclick.stop="
                        canEditCellItem(displayItems[cell.recordIndex], cell.valueIndex) &&
                        startEdit(displayItems[cell.recordIndex].id, cell.valueIndex)
                      "
                    >
                      <template
                        v-if="
                          editingCell?.rowId === displayItems[cell.recordIndex]?.id &&
                          editingCell?.col === cell.valueIndex
                        "
                      >
                        <TemporalCellEditor
                          v-if="temporalEditorKindForColumn(cell.valueIndex)"
                          v-model="editValue"
                          :kind="temporalEditorKindForColumn(cell.valueIndex)!"
                          @cancel="cancelEdit"
                          @commit="commitGridEdit"
                        />
                        <input
                          v-else
                          v-model="editValue"
                          autocapitalize="off"
                          autocorrect="off"
                          spellcheck="false"
                          class="cell-edit-input absolute inset-0 bg-background border-2 border-primary px-2 py-0.5 text-xs outline-none z-10"
                          @blur="commitEdit"
                          @click.stop
                          @keydown.stop="onEditKeydown"
                        />
                      </template>
                      <template v-else>
                        {{ cell.display }}
                        <button
                          v-if="cellDetailButtonVisible(cell.recordIndex, cell.valueIndex)"
                          class="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border hover:text-foreground"
                          :title="t('grid.cellDetails')"
                          @mousedown.stop
                          @click.stop="showCellDetails(cell.recordIndex, cell.valueIndex)"
                        >
                          <Info class="h-3 w-3" />
                        </button>
                      </template>
                    </div>
                    <div class="shrink-0" :style="{ width: `${transposeRecordWindow.afterWidth}px` }" />
                  </div>
                </template>
              </RecycleScroller>
            </div>
            <template v-else>
              <!-- Sticky header -->
              <div
                ref="headerRef"
                class="shrink-0 bg-[rgb(239_239_239)] dark:bg-muted/60 z-10 border-y border-border overflow-hidden"
              >
                <div class="flex text-xs font-semibold text-foreground" :style="{ width: 'var(--header-total-w)' }">
                  <div
                    class="shrink-0 px-2 py-1.5 border-r border-border text-center text-muted-foreground select-none cursor-pointer hover:bg-accent/60 sticky left-0 z-20 bg-[rgb(239_239_239)] dark:bg-[#2d2d2d]"
                    :style="{ width: 'var(--row-num-w)' }"
                    @click="selectAllCells"
                  >
                    #
                  </div>
                  <Tooltip v-for="(col, colIdx) in visibleColumns" :key="`${col}-${actualColumnIndex(colIdx)}`">
                    <TooltipTrigger as-child>
                      <div
                        class="shrink-0 px-2 py-1.5 border-r border-border whitespace-nowrap hover:bg-accent/60 select-none relative overflow-hidden"
                        :class="{
                          'bg-primary/15 ring-1 ring-inset ring-primary/40':
                            highlightedColumnIndex === actualColumnIndex(colIdx) || columnIsSelected(colIdx),
                        }"
                        :style="{ width: `var(--col-w-${colIdx})` }"
                        :data-grid-column-index="actualColumnIndex(colIdx)"
                        @click="selectColumn(colIdx, $event)"
                        @contextmenu="onHeaderContext(col, actualColumnIndex(colIdx))"
                      >
                        <span class="flex min-w-0 items-center gap-1 overflow-hidden">
                          <span class="flex min-w-0 flex-1 flex-col overflow-hidden">
                            <span class="min-w-0 truncate leading-4">
                              {{ col }}
                            </span>
                            <span
                              v-if="headerColumnComment(col)"
                              class="min-w-0 truncate text-[10px] font-normal leading-3 text-muted-foreground"
                              :title="headerColumnComment(col)"
                            >
                              {{ headerColumnComment(col) }}
                            </span>
                          </span>
                          <button
                            type="button"
                            class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                            :class="
                              sortCol === col && sortColIndex === actualColumnIndex(colIdx)
                                ? 'text-primary opacity-100'
                                : 'opacity-80'
                            "
                            :title="t('grid.sort')"
                            @click.stop="toggleSort(col, actualColumnIndex(colIdx))"
                          >
                            <ArrowUp
                              v-if="sortCol === col && sortColIndex === actualColumnIndex(colIdx) && sortDir === 'asc'"
                              class="h-3 w-3 shrink-0"
                            />
                            <ArrowDown
                              v-else-if="
                                sortCol === col && sortColIndex === actualColumnIndex(colIdx) && sortDir === 'desc'
                              "
                              class="h-3 w-3 shrink-0"
                            />
                            <ArrowUpDown v-else class="h-3 w-3 shrink-0" />
                          </button>
                          <DropdownMenu
                            v-if="compactColumnHeaderActions"
                            :open="headerActionMenuOpenColumn === actualColumnIndex(colIdx)"
                            @update:open="
                              (value: boolean) =>
                                (headerActionMenuOpenColumn = value ? actualColumnIndex(colIdx) : null)
                            "
                          >
                            <DropdownMenuTrigger as-child>
                              <button
                                type="button"
                                class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                :class="
                                  columnHasFormatter(actualColumnIndex(colIdx)) ||
                                  localFilterActive(actualColumnIndex(colIdx))
                                    ? 'text-primary opacity-90'
                                    : 'opacity-80'
                                "
                                :title="t('grid.columnActions')"
                                @click.stop
                              >
                                <ChevronDown class="h-3 w-3" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              class="w-max min-w-28 max-w-48 p-0.5"
                              @click.stop
                              @keydown.stop
                            >
                              <DropdownMenuItem
                                class="gap-1 px-1.5 py-0.5 text-xs"
                                :disabled="!formatterKeyForColumn(col)"
                                @select.prevent="openCompactColumnFormatter(actualColumnIndex(colIdx))"
                              >
                                <Code2 class="h-3 w-3" />
                                {{ t("grid.columnFormatter") }}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                class="gap-1 px-1.5 py-0.5 text-xs"
                                @select.prevent="openCompactLocalFilter(actualColumnIndex(colIdx))"
                              >
                                <Filter class="h-3 w-3" />
                                {{ t("grid.localFilter") }}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                          <Popover
                            :open="formatterOpenColumn === actualColumnIndex(colIdx)"
                            @update:open="
                              (value: boolean) => handleColumnFormatterOpenChange(value, actualColumnIndex(colIdx))
                            "
                          >
                            <PopoverAnchor v-if="compactColumnHeaderActions" as-child>
                              <span class="pointer-events-none absolute right-3 top-1/2 h-px w-px -translate-y-1/2" />
                            </PopoverAnchor>
                            <PopoverTrigger v-else as-child>
                              <button
                                type="button"
                                class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                :class="
                                  columnHasFormatter(actualColumnIndex(colIdx))
                                    ? 'text-primary opacity-100'
                                    : 'opacity-80'
                                "
                                :disabled="!formatterKeyForColumn(col)"
                                :title="t('grid.columnFormatter')"
                                @click.stop
                              >
                                <Code2 class="h-3.5 w-3.5" />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent
                              align="start"
                              side="bottom"
                              class="w-[380px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-xl"
                              @click.stop
                              @keydown.stop
                            >
                              <div class="border-b bg-muted/40 px-3 py-2">
                                <div class="text-sm font-semibold">
                                  {{ t("grid.columnFormatterFor", { column: col }) }}
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
                                  <Select
                                    :model-value="formatterKind"
                                    @update:model-value="(value: any) => (formatterKind = value)"
                                  >
                                    <SelectTrigger class="h-8 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="datetime">{{ t("grid.formatterDatetime") }}</SelectItem>
                                      <SelectItem value="json-path">{{ t("grid.formatterJsonPath") }}</SelectItem>
                                      <SelectItem value="mask">{{ t("grid.formatterMask") }}</SelectItem>
                                      <SelectItem value="custom-template">{{
                                        t("grid.formatterCustomTemplate")
                                      }}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div v-if="formatterKind === 'datetime'" class="space-y-1.5">
                                  <div class="text-xs font-medium text-muted-foreground">
                                    {{ t("grid.formatterTimestampUnit") }}
                                  </div>
                                  <Select
                                    :model-value="formatterDateUnit"
                                    @update:model-value="(value: any) => (formatterDateUnit = value)"
                                  >
                                    <SelectTrigger class="h-8 text-xs">
                                      <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="auto">{{ t("grid.formatterUnitAuto") }}</SelectItem>
                                      <SelectItem value="seconds">{{ t("grid.formatterUnitSeconds") }}</SelectItem>
                                      <SelectItem value="milliseconds">{{
                                        t("grid.formatterUnitMilliseconds")
                                      }}</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div v-else-if="formatterKind === 'json-path'" class="space-y-1.5">
                                  <div class="text-xs font-medium text-muted-foreground">
                                    {{ t("grid.formatterJsonPathInput") }}
                                  </div>
                                  <input
                                    v-model="formatterJsonPath"
                                    autocapitalize="off"
                                    autocorrect="off"
                                    spellcheck="false"
                                    class="h-8 w-full rounded border bg-background px-2 font-mono text-xs outline-none focus:border-primary"
                                    placeholder="$.user.name"
                                  />
                                </div>

                                <div v-else-if="formatterKind === 'mask'" class="grid grid-cols-2 gap-2">
                                  <label class="space-y-1.5">
                                    <span class="text-xs font-medium text-muted-foreground">
                                      {{ t("grid.formatterMaskPrefix") }}
                                    </span>
                                    <input
                                      v-model.number="formatterMaskPrefix"
                                      type="number"
                                      min="0"
                                      class="h-8 w-full rounded border bg-background px-2 text-xs outline-none focus:border-primary"
                                    />
                                  </label>
                                  <label class="space-y-1.5">
                                    <span class="text-xs font-medium text-muted-foreground">
                                      {{ t("grid.formatterMaskSuffix") }}
                                    </span>
                                    <input
                                      v-model.number="formatterMaskSuffix"
                                      type="number"
                                      min="0"
                                      class="h-8 w-full rounded border bg-background px-2 text-xs outline-none focus:border-primary"
                                    />
                                  </label>
                                </div>

                                <div v-else class="space-y-2">
                                  <div v-if="savedCustomFormatters.length" class="space-y-1.5">
                                    <div class="text-xs font-medium text-muted-foreground">
                                      {{ t("grid.formatterSavedCustom") }}
                                    </div>
                                    <Select
                                      :model-value="formatterCustomId"
                                      @update:model-value="(value: any) => selectCustomFormatter(String(value))"
                                    >
                                      <SelectTrigger class="h-8 text-xs">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem :value="CUSTOM_FORMATTER_NEW">{{
                                          t("grid.formatterNewCustom")
                                        }}</SelectItem>
                                        <SelectItem
                                          v-for="formatter in savedCustomFormatters"
                                          :key="formatter.id"
                                          :value="formatter.id"
                                        >
                                          {{ formatter.name }}
                                        </SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <label class="block space-y-1.5">
                                    <span class="text-xs font-medium text-muted-foreground">
                                      {{ t("grid.formatterCustomName") }}
                                    </span>
                                    <input
                                      v-model="formatterCustomName"
                                      class="h-8 w-full rounded border bg-background px-2 text-xs outline-none focus:border-primary"
                                      :placeholder="t('grid.formatterCustomNamePlaceholder')"
                                    />
                                  </label>
                                  <label class="block space-y-1.5">
                                    <span class="text-xs font-medium text-muted-foreground">
                                      {{ t("grid.formatterCustomTemplateInput") }}
                                    </span>
                                    <input
                                      v-model="formatterCustomTemplate"
                                      autocapitalize="off"
                                      autocorrect="off"
                                      spellcheck="false"
                                      class="h-8 w-full rounded border bg-background px-2 font-mono text-xs outline-none focus:border-primary"
                                      placeholder="ID-${value}"
                                    />
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
                                    <div
                                      v-for="row in formatterPreviewRows(actualColumnIndex(colIdx))"
                                      :key="row.index"
                                      class="grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b px-2 py-1.5 text-[11px] last:border-b-0"
                                    >
                                      <span class="text-muted-foreground">{{ row.index }}</span>
                                      <span class="truncate font-mono text-muted-foreground">{{ row.raw }}</span>
                                      <span class="truncate font-mono">{{ row.formatted }}</span>
                                    </div>
                                  </div>
                                </div>
                              </div>

                              <div class="flex items-center justify-between gap-2 border-t bg-muted/30 px-3 py-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  class="h-7 px-2 text-xs"
                                  :disabled="!columnHasFormatter(actualColumnIndex(colIdx))"
                                  @click="clearColumnFormatter(actualColumnIndex(colIdx))"
                                >
                                  {{ t("grid.clearFormatter") }}
                                </Button>
                                <div class="flex items-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    class="h-7 px-2 text-xs"
                                    @click="closeColumnFormatter"
                                  >
                                    {{ t("dangerDialog.cancel") }}
                                  </Button>
                                  <Button
                                    size="sm"
                                    class="h-7 px-2 text-xs"
                                    :disabled="!formatterDraftIsSavable()"
                                    @click="saveColumnFormatter(actualColumnIndex(colIdx))"
                                  >
                                    {{ t("grid.saveFormatter") }}
                                  </Button>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                          <Popover
                            :open="localFilterOpenColumn === actualColumnIndex(colIdx)"
                            @update:open="
                              (value: boolean) => handleLocalFilterOpenChange(value, actualColumnIndex(colIdx))
                            "
                          >
                            <PopoverAnchor v-if="compactColumnHeaderActions" as-child>
                              <span class="pointer-events-none absolute right-3 top-1/2 h-px w-px -translate-y-1/2" />
                            </PopoverAnchor>
                            <PopoverTrigger v-else as-child>
                              <button
                                type="button"
                                class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                :class="
                                  localFilterActive(actualColumnIndex(colIdx))
                                    ? 'text-primary opacity-100'
                                    : 'opacity-80'
                                "
                                :title="t('grid.localFilter')"
                                @click.stop
                              >
                                <Filter class="h-3.5 w-3.5" />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent
                              align="start"
                              side="bottom"
                              class="w-[300px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-xl"
                              @click.stop
                              @keydown.stop
                            >
                              <div class="border-b bg-muted/40 px-2 py-1.5 text-center text-xs font-semibold">
                                {{ t("grid.localFilterFor", { column: col }) }}
                              </div>
                              <div class="flex items-center gap-1.5 border-b px-2 py-1.5">
                                <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <input
                                  v-model="localFilterSearch"
                                  autocapitalize="off"
                                  autocorrect="off"
                                  spellcheck="false"
                                  class="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                                  :placeholder="t('grid.searchValues')"
                                />
                              </div>
                              <div
                                class="grid grid-cols-[1.75rem_minmax(0,1fr)_3.5rem] border-b bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground"
                              >
                                <button
                                  type="button"
                                  class="flex h-4 w-4 items-center justify-center rounded border"
                                  :class="
                                    localFilterAllVisibleSelected
                                      ? 'border-blue-600 bg-blue-600 text-white'
                                      : 'border-border bg-background text-foreground/70'
                                  "
                                  @click="toggleAllLocalFilterOptions"
                                >
                                  <Check v-if="localFilterAllVisibleSelected" class="h-3 w-3 stroke-[3]" />
                                </button>
                                <span>{{ t("grid.value") }}</span>
                                <span class="text-right">{{ t("grid.count") }}</span>
                              </div>
                              <div class="max-h-72 overflow-auto py-0.5">
                                <button
                                  v-for="option in localFilterOptions"
                                  :key="option.key"
                                  type="button"
                                  class="grid w-full grid-cols-[1.75rem_minmax(0,1fr)_3.5rem] items-center px-2 py-1 text-left text-xs hover:bg-accent"
                                  @click="toggleLocalFilterValue(option.key)"
                                >
                                  <span
                                    class="flex h-4 w-4 items-center justify-center rounded border"
                                    :class="
                                      localFilterDraft?.values.has(option.key)
                                        ? 'border-blue-600 bg-blue-600 text-white'
                                        : 'border-border bg-background text-foreground/70'
                                    "
                                  >
                                    <Check v-if="localFilterDraft?.values.has(option.key)" class="h-3 w-3 stroke-[3]" />
                                  </span>
                                  <span
                                    class="truncate font-mono"
                                    :class="{ 'italic text-muted-foreground': option.value === null }"
                                  >
                                    {{ option.label }}
                                  </span>
                                  <span class="text-right tabular-nums text-muted-foreground text-xs">{{
                                    option.count
                                  }}</span>
                                </button>
                                <div
                                  v-if="localFilterAllOptions.length > localFilterOptions.length"
                                  class="px-2 py-0.5 text-center text-[10px] text-muted-foreground"
                                >
                                  {{
                                    t("grid.moreValues", {
                                      count: localFilterAllOptions.length - localFilterOptions.length,
                                    })
                                  }}
                                </div>
                                <button
                                  v-if="canApplyTypedLocalFilterValue"
                                  type="button"
                                  class="grid w-full grid-cols-[1.75rem_minmax(0,1fr)] items-center px-2 py-1 text-left text-xs text-primary hover:bg-accent"
                                  @click="applyTypedLocalFilterValue"
                                >
                                  <Search class="h-3.5 w-3.5" />
                                  <span class="truncate font-mono">
                                    {{ t("grid.filterTypedValue", { value: localFilterTypedValue }) }}
                                  </span>
                                </button>
                                <div
                                  v-if="localFilterOptions.length === 0 && !canApplyTypedLocalFilterValue"
                                  class="px-2 py-6 text-center text-xs text-muted-foreground"
                                >
                                  {{ t("grid.noSearchResults") }}
                                </div>
                              </div>
                              <div class="flex items-center justify-between gap-2 border-t bg-muted/40 px-2 py-1.5">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  class="h-7 px-2 text-xs"
                                  @click="clearLocalFilter(actualColumnIndex(colIdx))"
                                >
                                  {{ t("grid.clearFilter") }}
                                </Button>
                                <div class="flex items-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    class="h-7 px-2 text-xs"
                                    @click="closeLocalFilter"
                                  >
                                    {{ t("dangerDialog.cancel") }}
                                  </Button>
                                  <Button size="sm" class="h-7 px-2 text-xs" @click="applyLocalFilter">
                                    {{ t("grid.applyFilter") }}
                                  </Button>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        </span>
                        <div
                          class="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30"
                          @mousedown.stop="onResizeStart(colIdx, $event)"
                          @dblclick.stop="autoFitColumn(colIdx)"
                        />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      class="grid min-w-56 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs"
                    >
                      <span class="text-background/70">{{ t("grid.columnName") }}</span>
                      <span class="flex min-w-0 items-center gap-2">
                        <span class="min-w-0 flex-1 truncate font-mono">{{ col }}</span>
                        <button
                          type="button"
                          class="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-background/10"
                          :title="t('grid.copyColumnName')"
                          @click.stop="copyText(col)"
                        >
                          <Copy class="h-3 w-3" />
                        </button>
                      </span>
                      <template v-if="columnTypeMap.get(col)">
                        <span class="text-background/70">{{ t("grid.columnType") }}</span>
                        <span :class="typeColorClass(columnTypeMap.get(col)!)">{{ columnTypeMap.get(col) }}</span>
                      </template>
                      <template v-if="columnCommentMap.get(col)">
                        <span class="text-background/70">{{ t("grid.columnComment") }}</span>
                        <span>{{ columnCommentMap.get(col) }}</span>
                      </template>
                    </TooltipContent>
                  </Tooltip>
                  <div
                    v-if="gridScrollbarGutter > 0"
                    class="shrink-0 border-l border-border"
                    :style="{ width: 'var(--grid-scrollbar-gutter)' }"
                  />
                </div>
              </div>

              <div
                v-if="isErrorResult"
                class="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center text-destructive"
              >
                <TriangleAlert class="h-8 w-8 text-destructive/50" aria-hidden="true" />
                <div class="space-y-1">
                  <div class="text-sm font-medium">{{ t("grid.queryError") }}</div>
                  <div class="text-xs max-w-lg break-all text-destructive/80">{{ errorMessage }}</div>
                </div>
              </div>

              <div
                v-else-if="!hasVisibleRows"
                class="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground"
              >
                <component
                  :is="hasActiveFilter ? SearchX : Inbox"
                  class="h-8 w-8 text-muted-foreground/50"
                  aria-hidden="true"
                />
                <div class="space-y-1">
                  <div class="text-sm font-medium text-foreground">{{ emptyTitle }}</div>
                  <div class="text-xs">{{ emptyDescription }}</div>
                </div>
              </div>

              <!-- Virtual scrolled rows -->
              <RecycleScroller
                v-else
                ref="scrollerRef"
                class="data-grid-scroller flex-1 overflow-x-auto overscroll-none"
                :class="{ 'is-scrolling': isScrolling }"
                :items="displayItems"
                :item-size="26"
                :buffer="600"
                :skip-hover="true"
                key-field="id"
                @scroll="onScrollerScroll"
              >
                <template #default="{ item }">
                  <div
                    class="flex text-xs border-b border-border"
                    :class="{
                      'bg-destructive/5 opacity-70': item.isDeleted,
                      'bg-primary/5': item.isNew && !isRowActive(item.displayIndex),
                      'bg-muted/30':
                        !item.isNew &&
                        !item.isDeleted &&
                        !isRowActive(item.displayIndex) &&
                        item.displayIndex % 2 === 1,
                      'active-row': isRowActive(item.displayIndex) && !item.isDeleted,
                    }"
                    :style="{ height: '26px', width: 'var(--total-w)' }"
                    :data-row-index="item.displayIndex"
                  >
                    <div
                      class="shrink-0 px-2 py-1 border-r border-border text-center select-none cursor-default hover:bg-accent/50 sticky left-0 z-10 bg-[rgb(255_255_255)] dark:bg-[rgb(15_15_15)]"
                      :class="[
                        rowNumberStatusClass(item),
                        {
                          'text-primary font-semibold !bg-primary/25':
                            isRowSelected(item.id) &&
                            item.status !== 'new' &&
                            item.status !== 'edited' &&
                            item.status !== 'deleted',
                        },
                      ]"
                      :style="{ width: 'var(--row-num-w)' }"
                      @click="handleRowClick(item.displayIndex, item.id, $event)"
                      @dblclick.stop="toggleTranspose(item.displayIndex)"
                      @contextmenu="onRowContext(item.id, item.displayIndex)"
                    >
                      {{ item.displayIndex + 1 }}
                    </div>
                    <div
                      v-for="(actualColIdx, visibleColIdx) in visibleColumnIndexes"
                      :key="actualColIdx"
                      class="group/cell shrink-0 px-3 py-1 border-r border-border whitespace-nowrap overflow-hidden text-ellipsis relative select-none"
                      :style="{ width: `var(--col-w-${visibleColIdx})` }"
                      :class="{
                        'text-muted-foreground italic': isNull(item.data[actualColIdx]),
                        'bg-yellow-500/10 cell-dirty': item.isDirtyCol[actualColIdx],
                        'cell-selected':
                          cellIsSelected(item.displayIndex, visibleColIdx) && !item.isDirtyCol[actualColIdx],
                        'cell-selected-dirty':
                          cellIsSelected(item.displayIndex, visibleColIdx) && item.isDirtyCol[actualColIdx],
                        'row-cell-selected':
                          rowCellsUseSelectionVisual(item.id) &&
                          !cellIsSelected(item.displayIndex, visibleColIdx) &&
                          !item.isDirtyCol[actualColIdx],
                        'row-cell-selected-dirty':
                          rowCellsUseSelectionVisual(item.id) &&
                          !cellIsSelected(item.displayIndex, visibleColIdx) &&
                          item.isDirtyCol[actualColIdx],
                        'bg-yellow-200/60 dark:bg-yellow-500/20': cellIsSearchMatch(item.displayIndex, actualColIdx),
                        'ring-2 ring-inset ring-yellow-500 bg-yellow-300/60 dark:bg-yellow-500/40': cellIsCurrentMatch(
                          item.displayIndex,
                          actualColIdx,
                        ),
                        'tabular-nums': typeof item.data[actualColIdx] === 'number',
                        'cursor-text hover:bg-accent/50': canEditCellItem(item, actualColIdx),
                        'line-through': item.isDeleted,
                      }"
                      @mousedown="handleDataCellMousedown(item.displayIndex, visibleColIdx, item.id, $event)"
                      @mouseenter="onCellMouseenter(item.displayIndex, visibleColIdx, actualColIdx)"
                      @mouseleave="onCellMouseleave(item.displayIndex, actualColIdx)"
                      @dblclick="canEditCellItem(item, actualColIdx) && startEdit(item.id, actualColIdx)"
                      :data-visible-col-index="visibleColIdx"
                      @contextmenu="onCellContext(item.id, item.displayIndex, actualColIdx, visibleColIdx)"
                    >
                      <template v-if="editingCell?.rowId === item.id && editingCell?.col === actualColIdx">
                        <TemporalCellEditor
                          v-if="temporalEditorKindForColumn(actualColIdx)"
                          v-model="editValue"
                          :kind="temporalEditorKindForColumn(actualColIdx)!"
                          @cancel="cancelEdit"
                          @commit="commitGridEdit"
                        />
                        <input
                          v-else
                          v-model="editValue"
                          autocapitalize="off"
                          autocorrect="off"
                          spellcheck="false"
                          class="cell-edit-input absolute inset-0 bg-background border-2 border-primary px-2 py-0.5 text-xs outline-none z-10"
                          @blur="commitEdit"
                          @click.stop
                          @keydown.stop="onEditKeydown"
                        />
                      </template>
                      <template v-else>
                        {{ formatCell(item.data[actualColIdx], actualColIdx) }}
                        <button
                          v-if="cellDetailButtonVisible(item.displayIndex, actualColIdx)"
                          class="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border hover:text-foreground"
                          :title="t('grid.cellDetails')"
                          @mousedown.stop
                          @click.stop="showCellDetailsForVisibleCell(item.displayIndex, visibleColIdx, actualColIdx)"
                        >
                          <Info class="h-3 w-3" />
                        </button>
                      </template>
                    </div>
                  </div>
                </template>
              </RecycleScroller>
              <div v-if="loading" class="absolute inset-0 z-20 bg-background/50 flex items-center justify-center">
                <div
                  class="flex items-center gap-2 px-3 py-1.5 rounded-md bg-background border shadow-sm text-xs text-muted-foreground"
                >
                  <Loader2 class="w-3.5 h-3.5 animate-spin" />
                  <span>{{ (loadingElapsed / 1000).toFixed(1) }}s</span>
                </div>
              </div>
            </template>
          </div>
          <!-- Table Info Drawer -->
          <div
            v-if="showTableInfo"
            class="relative shrink-0 border-l flex flex-col bg-background min-w-0"
            :class="{ 'ddl-drawer-resizing': isResizingDdl }"
            :style="ddlDrawerStyle"
          >
            <div
              class="absolute left-0 top-0 bottom-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30"
              @mousedown.prevent="onDdlResizeStart"
            />
            <div class="flex items-center gap-2 px-3 py-1.5 border-b shrink-0 bg-muted/20">
              <TableProperties class="w-3.5 h-3.5 text-muted-foreground" />
              <span class="text-xs font-medium flex-1 min-w-0 truncate">{{ tableMeta?.tableName }}</span>
              <Button v-if="activeTableInfoTab === 'ddl'" variant="ghost" size="icon" class="h-5 w-5" @click="copyDdl">
                <Copy class="w-3 h-3" />
              </Button>
              <Button
                v-if="activeTableInfoTab === 'ddl'"
                variant="ghost"
                size="icon"
                class="h-5 w-5"
                :class="{ 'bg-accent': ddlWrap }"
                @click="toggleDdlWrap"
              >
                <WrapText class="w-3 h-3" />
              </Button>
              <Button variant="ghost" size="icon" class="h-5 w-5" @click="showTableInfo = false">
                <X class="w-3 h-3" />
              </Button>
            </div>
            <div class="grid grid-cols-5 border-b bg-background shrink-0">
              <button
                v-for="tab in tableInfoTabs"
                :key="tab.id"
                class="h-9 min-w-0 px-1.5 text-[11px] text-muted-foreground border-b-2 border-transparent hover:bg-muted/50 hover:text-foreground"
                :class="{ 'border-primary text-foreground bg-muted/40': activeTableInfoTab === tab.id }"
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
                <input
                  v-model="searchQuery"
                  :placeholder="t('grid.tableInfoSearch')"
                  class="w-full h-7 pl-7 pr-6 text-xs bg-muted/50 rounded border border-border focus:outline-none focus:border-primary/50"
                  @keydown.escape="searchQuery = ''"
                />
                <button
                  v-if="searchQuery"
                  class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  @click="searchQuery = ''"
                >
                  <X class="w-3 h-3" />
                </button>
              </div>
            </div>

            <div v-if="activeTableInfoTab === 'columns'" class="flex-1 min-h-0 overflow-auto">
              <div
                v-if="searchQuery && filteredColumns.length === 0"
                class="p-6 text-center text-xs text-muted-foreground"
              >
                {{ t("grid.tableInfoNoResults") }}
              </div>
              <table v-else class="w-full text-xs">
                <thead class="sticky top-0 bg-muted/80 backdrop-blur text-muted-foreground">
                  <tr class="border-b">
                    <th class="text-left font-medium px-3 py-2">{{ t("grid.columnName") }}</th>
                    <th class="text-left font-medium px-3 py-2">{{ t("grid.columnType") }}</th>
                    <th class="text-left font-medium px-3 py-2">{{ t("grid.tableInfoNullable") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="column in filteredColumns"
                    :key="column.name"
                    class="border-b cursor-pointer hover:bg-muted/30"
                    role="button"
                    tabindex="0"
                    :title="column.name"
                    @click="scrollToTableInfoColumn(column.name)"
                    @keydown.enter.prevent="scrollToTableInfoColumn(column.name)"
                    @keydown.space.prevent="scrollToTableInfoColumn(column.name)"
                  >
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
              <div
                v-else-if="searchQuery && filteredIndexes.length === 0"
                class="p-6 text-center text-xs text-muted-foreground"
              >
                {{ t("grid.tableInfoNoResults") }}
              </div>
              <div v-else-if="indexes.length === 0" class="p-6 text-center text-xs text-muted-foreground">
                {{ t("grid.tableInfoEmpty") }}
              </div>
              <div v-else class="divide-y">
                <div v-for="index in filteredIndexes" :key="index.name" class="p-3 text-xs">
                  <div class="font-medium truncate">{{ index.name }}</div>
                  <div class="mt-1 flex flex-wrap gap-1">
                    <span v-if="index.is_primary" class="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600">PK</span>
                    <span v-if="index.is_unique" class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600"
                      >UNIQUE</span
                    >
                    <span v-if="index.index_type" class="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{{
                      index.index_type
                    }}</span>
                  </div>
                  <div class="mt-2 font-mono text-[11px] text-muted-foreground break-all">
                    {{ index.columns.join(", ") }}
                  </div>
                </div>
              </div>
            </div>

            <div v-else-if="activeTableInfoTab === 'foreignKeys'" class="flex-1 min-h-0 overflow-auto">
              <div v-if="foreignKeysLoading" class="h-full flex items-center justify-center">
                <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
              <div v-else-if="foreignKeysError" class="p-3 text-xs text-destructive">{{ foreignKeysError }}</div>
              <div
                v-else-if="searchQuery && filteredForeignKeys.length === 0"
                class="p-6 text-center text-xs text-muted-foreground"
              >
                {{ t("grid.tableInfoNoResults") }}
              </div>
              <div v-else-if="foreignKeys.length === 0" class="p-6 text-center text-xs text-muted-foreground">
                {{ t("grid.tableInfoEmpty") }}
              </div>
              <div v-else class="divide-y">
                <div v-for="fk in filteredForeignKeys" :key="`${fk.name}:${fk.column}`" class="p-3 text-xs">
                  <div class="font-medium truncate">{{ fk.name }}</div>
                  <div class="mt-1 font-mono text-[11px] text-muted-foreground break-all">
                    {{ fk.column }} -> {{ fk.ref_table }}.{{ fk.ref_column }}
                  </div>
                </div>
              </div>
            </div>

            <div v-else-if="activeTableInfoTab === 'triggers'" class="flex-1 min-h-0 overflow-auto">
              <div v-if="triggersLoading" class="h-full flex items-center justify-center">
                <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
              <div v-else-if="triggersError" class="p-3 text-xs text-destructive">{{ triggersError }}</div>
              <div
                v-else-if="searchQuery && filteredTriggers.length === 0"
                class="p-6 text-center text-xs text-muted-foreground"
              >
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
              class="flex-1 min-w-0 text-xs font-mono p-3 overflow-auto ddl-code leading-5 select-text"
              :class="ddlWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
              v-html="filteredDdlContent"
            ></pre>
            <div v-else class="flex-1 flex items-center justify-center">
              <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          </div>
          <!-- Cell Detail Drawer -->
          <div
            v-if="showCellDetail && activeCellDetail"
            class="relative shrink-0 border-l flex flex-col bg-background min-w-0"
            :class="{ 'detail-drawer-resizing': isResizingDetail }"
            :style="detailDrawerStyle"
          >
            <div
              class="absolute left-0 top-0 bottom-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30"
              @mousedown.prevent="onDetailResizeStart"
            />
            <div class="h-9 flex items-center gap-2 px-3 border-b shrink-0 bg-muted/20">
              <Info class="w-3.5 h-3.5 text-muted-foreground" />
              <span class="text-xs font-medium flex-1 min-w-0 truncate">{{ t("grid.cellDetails") }}</span>
              <Button
                variant="ghost"
                size="icon"
                class="h-5 w-5"
                :title="t('grid.openCellDetailsDialog')"
                @click="openActiveCellDetailDialog"
              >
                <Maximize2 class="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="h-5 w-5"
                :title="t('grid.openRowDetailsDialog')"
                @click="openActiveRowDetailDialog"
              >
                <ListTree class="w-3 h-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="h-5 w-5"
                :title="t('grid.openColumnDetailsDialog')"
                @click="openActiveColumnDetailDialog"
              >
                <TableProperties class="w-3 h-3" />
              </Button>
              <Button variant="ghost" size="icon" class="h-5 w-5" @click="closeCellDetails">
                <X class="w-3 h-3" />
              </Button>
            </div>

            <Tabs v-model="activeCellDetailTab" class="flex-1 min-h-0 gap-0">
              <div class="shrink-0 border-b px-3 py-2">
                <TabsList
                  class="grid h-7 w-full p-0.5"
                  :class="activeCellDetailTabs.length > 1 ? 'grid-cols-2' : 'grid-cols-1'"
                >
                  <TabsTrigger value="details" class="h-6 text-xs">{{ t("grid.cellDetails") }}</TabsTrigger>
                  <TabsTrigger
                    v-if="activeCellDetailTabs.includes('valueEditor')"
                    value="valueEditor"
                    class="h-6 text-xs"
                  >
                    {{ t("grid.valueEditor") }}
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="details" class="m-0 min-h-0 flex-1 flex flex-col">
                <div class="flex-1 min-h-0 overflow-auto p-3 text-xs space-y-3">
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
                      <div
                        :class="activeCellDetail.type ? typeColorClass(activeCellDetail.type) : 'text-muted-foreground'"
                      >
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
                  <div class="space-y-1">
                    <div class="text-muted-foreground">{{ t("grid.cellValue") }}</div>
                    <div v-if="activeCellDetail.imagePreviewUrl && !isEditingDetail" class="space-y-1.5">
                      <div class="text-muted-foreground">{{ t("grid.imagePreview") }}</div>
                      <a
                        :href="activeCellDetail.imagePreviewUrl"
                        role="button"
                        class="block overflow-hidden rounded border bg-muted/20"
                        @click.prevent="openImagePreview(activeCellDetail.imagePreviewUrl, activeCellDetail.column)"
                      >
                        <img
                          :src="activeCellDetail.imagePreviewUrl"
                          :alt="activeCellDetail.column"
                          loading="lazy"
                          decoding="async"
                          referrerpolicy="no-referrer"
                          class="max-h-72 w-full object-contain"
                        />
                      </a>
                    </div>
                    <template v-if="isEditingDetail">
                      <TemporalCellEditor
                        v-if="detailTemporalEditorKind"
                        v-model="detailEditValue"
                        :kind="detailTemporalEditorKind"
                        variant="inline"
                        :commit-on-close="false"
                        @cancel="cancelDetailEdit"
                        @commit="commitDetailEdit"
                      />
                      <div
                        v-else
                        ref="detailsEditorContainer"
                        data-cell-detail-editor-root
                        class="w-full h-40 rounded border overflow-hidden"
                      />
                      <div class="flex gap-1 mt-1">
                        <Button size="sm" class="h-6 text-xs" @click="commitDetailEdit">
                          {{ t("dangerDialog.confirm") }}
                        </Button>
                        <Button variant="outline" size="sm" class="h-6 text-xs" @click="cancelDetailEdit">
                          {{ t("dangerDialog.cancel") }}
                        </Button>
                      </div>
                    </template>
                    <pre
                      v-else
                      class="max-h-56 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre cursor-pointer hover:border-primary/50"
                      :class="{ 'cursor-text': activeCellDetail.isEditable }"
                      @dblclick="startDetailEdit"
                      >{{ activeCellDetail.displayValue }}</pre
                    >
                  </div>
                  <div v-if="activeCellDetail.displayValue !== activeCellDetail.rawValue" class="space-y-1">
                    <div class="text-muted-foreground">{{ t("grid.rawValue") }}</div>
                    <pre
                      class="max-h-40 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-words"
                      >{{ activeCellDetail.rawValue }}</pre
                    >
                  </div>
                  <div v-if="activeCellDetail.formattedJson" class="mt-2 space-y-1">
                    <div class="flex items-center justify-between gap-2">
                      <div class="text-muted-foreground">{{ t("grid.formattedJson") }}</div>
                      <Button
                        variant="ghost"
                        size="sm"
                        class="h-6 px-2 text-xs"
                        :title="t('grid.copyValue')"
                        @click="copyDetailFormattedJson"
                      >
                        <Copy class="h-3 w-3" />
                      </Button>
                    </div>
                    <pre
                      class="max-h-72 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-words"
                      >{{ activeCellDetail.formattedJson }}</pre
                    >
                  </div>
                </div>

                <div class="border-t p-2 grid grid-cols-1 gap-1">
                  <Button
                    v-if="activeCellDetail.isEditable && !isEditingDetail"
                    variant="ghost"
                    size="sm"
                    class="h-7 justify-start text-xs"
                    @click="startDetailEdit"
                  >
                    <Pencil class="w-3 h-3 mr-2" /> {{ t("grid.editValue") }}
                  </Button>
                  <Button
                    v-if="activeCellDetail.isEditable && activeCellDetail.value !== null"
                    variant="ghost"
                    size="sm"
                    class="h-7 justify-start text-xs"
                    @click="setDetailNull"
                  >
                    <X class="w-3 h-3 mr-2" /> {{ t("grid.setNull") }}
                  </Button>
                  <Button variant="ghost" size="sm" class="h-7 justify-start text-xs" @click="copyDetailValue">
                    <Copy class="w-3 h-3 mr-2" /> {{ t("grid.copyValue") }}
                  </Button>
                  <Button variant="ghost" size="sm" class="h-7 justify-start text-xs" @click="copyDetailColumnName">
                    <Copy class="w-3 h-3 mr-2" /> {{ t("grid.copyColumnName") }}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-7 justify-start text-xs"
                    :disabled="!canCopyPreparedDetailSqlCondition()"
                    @click="copyDetailSqlCondition"
                  >
                    <Code2 class="w-3 h-3 mr-2" /> {{ t("grid.copySqlCondition") }}
                  </Button>
                </div>
              </TabsContent>

              <TabsContent
                v-if="activeCellDetailTabs.includes('valueEditor')"
                value="valueEditor"
                class="m-0 min-h-0 flex-1 flex flex-col p-3 text-xs"
              >
                <div class="flex min-h-0 flex-1 flex-col">
                  <TemporalCellEditor
                    v-if="detailTemporalEditorKind"
                    v-model="detailEditValue"
                    :kind="detailTemporalEditorKind"
                    variant="inline"
                    :commit-on-close="false"
                    @cancel="cancelValueEditorEdit"
                    @commit="commitValueEditorEdit"
                  />
                  <div
                    v-else
                    ref="valueEditorContainer"
                    data-cell-detail-editor-root
                    class="min-h-0 flex-1 w-full rounded border overflow-auto"
                  />
                </div>
                <div class="flex gap-1 mt-2 shrink-0">
                  <Button
                    v-if="activeValueEditorActions.includes('formatJson')"
                    variant="outline"
                    size="sm"
                    class="h-6 text-xs"
                    @mousedown.prevent
                    @click="formatValueEditorJson"
                  >
                    {{ t("grid.formatJson") }}
                  </Button>
                  <Button
                    v-if="activeValueEditorActions.includes('setNull')"
                    variant="outline"
                    size="sm"
                    class="h-6 text-xs"
                    @mousedown.prevent
                    @click="setValueEditorNull"
                  >
                    {{ t("grid.setNull") }}
                  </Button>
                  <Button
                    v-if="activeValueEditorActions.includes('restoreOriginal')"
                    variant="outline"
                    size="sm"
                    class="h-6 text-xs"
                    @mousedown.prevent
                    @click="restoreDetailOriginalValue"
                  >
                    {{ t("grid.restoreOriginalValue") }}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>
    </CustomContextMenu>
    <div v-if="!hasData" class="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      {{ t("grid.querySuccess") }}
    </div>

    <!-- Error bar -->
    <div
      v-if="saveError"
      class="px-3 py-1.5 border-t bg-destructive/10 text-destructive text-xs shrink-0 flex items-center gap-2"
    >
      <span class="flex-1">{{ saveError }}</span>
      <button class="hover:underline" @click="saveError = ''">{{ t("grid.dismiss") }}</button>
    </div>

    <!-- Bottom status bar -->
    <div class="flex items-center gap-2 px-3 py-1 border-t text-xs text-muted-foreground bg-muted/30 shrink-0">
      <span v-if="hasData">
        {{ t("grid.totalRows", { count: result.rows.length }) }}
        <span v-if="typeof totalRowCount === 'number' && totalRowCount > 0" class="text-muted-foreground/70">{{
          t("grid.totalRowCount", { count: totalRowCount })
        }}</span>
      </span>
      <span v-if="showTruncationWarning" class="text-amber-500 text-xs ml-1">(truncated)</span>
      <span v-if="!hasData">{{ t("grid.rowsAffected", { count: result.affected_rows }) }}</span>
      <span>{{ result.execution_time_ms }}ms</span>
      <span v-if="selectedRowCount > 0 || hasCellSelection" class="text-foreground">{{ selectionSummary }}</span>

      <template v-if="editable && (tableMeta || customSave)">
        <span v-if="hasPendingChanges" class="ml-2 text-foreground">
          {{ t("grid.pendingChanges", { count: pendingChangeCount }) }}
        </span>
      </template>

      <span class="ml-auto flex items-center gap-1">
        <Loader2 v-if="loading" class="w-3 h-3 animate-spin text-muted-foreground" />
        <LightDropdown
          :model-value="String(pageSize)"
          :items="pageSizeMenuItems"
          :trigger-label="`${pageSize}${t('grid.rowsPerPageShort')}`"
          trigger-class="inline-flex h-5 items-center justify-center rounded-md px-1.5 text-xs hover:bg-accent hover:text-accent-foreground"
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
                <Button
                  variant="outline"
                  size="icon"
                  class="h-6 w-6 shrink-0"
                  :aria-label="t('grid.applyPageSize')"
                  @click.stop="applyCustomPageSize"
                >
                  <Check class="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{{ t("grid.applyPageSize") }}</TooltipContent>
            </Tooltip>
          </div>
        </LightDropdown>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="currentPage <= 1" @click="firstPage">
          <ChevronsLeft class="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="currentPage <= 1" @click="prevPage">
          <ChevronLeft class="h-3 w-3" />
        </Button>
        <span>{{ currentPage }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!canGoNextPage" @click="nextPage">
          <ChevronRight class="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!canJumpLastPage" @click="lastPage">
          <ChevronsRight class="h-3 w-3" />
        </Button>
      </span>

      <LightDropdown
        model-value=""
        :items="exportMenuItems"
        :aria-label="t('grid.export')"
        :trigger-icon="Download"
        trigger-class="inline-flex h-5 w-5 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
        trigger-icon-class="h-3 w-3"
        :show-trigger-label="false"
        :show-chevron="false"
        :highlight-selected="false"
        check-position="none"
        align="end"
        @update:model-value="selectExportMenuItem"
      />

      <Tooltip v-if="sqlOneLiner">
        <TooltipTrigger as-child>
          <span class="truncate max-w-[30%] opacity-60 cursor-pointer hover:opacity-100" @click="copySql">
            {{ sqlOneLiner }}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" class="max-w-md">
          <pre class="text-xs font-mono whitespace-pre-wrap">{{ props.sql }}</pre>
        </TooltipContent>
      </Tooltip>
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
            <div class="text-muted-foreground">{{ t("grid.cellValue") }}</div>
            <a
              v-if="dialogCellDetail.imagePreviewUrl"
              :href="dialogCellDetail.imagePreviewUrl"
              role="button"
              class="block max-h-72 overflow-hidden rounded border bg-muted/20"
              @click.prevent="openImagePreview(dialogCellDetail.imagePreviewUrl, dialogCellDetail.column)"
            >
              <img
                :src="dialogCellDetail.imagePreviewUrl"
                :alt="dialogCellDetail.column"
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
                class="max-h-72 w-full object-contain"
              />
            </a>
            <pre
              class="max-h-[44vh] overflow-auto rounded border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap break-words"
              :class="{ 'italic text-muted-foreground': dialogCellDetail.value === null }"
              >{{ dialogCellDetail.rawValue }}</pre
            >
          </div>

          <div v-if="dialogCellDetail.displayValue !== dialogCellDetail.rawValue" class="space-y-1">
            <div class="text-muted-foreground">{{ t("grid.formattedValue") }}</div>
            <pre class="max-h-40 overflow-auto rounded border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap">{{
              dialogCellDetail.displayValue
            }}</pre>
          </div>

          <div v-if="dialogCellDetail.formattedJson" class="space-y-1">
            <div class="flex items-center justify-between gap-2">
              <div class="text-muted-foreground">{{ t("grid.formattedJson") }}</div>
              <Button
                variant="ghost"
                size="sm"
                class="h-6 px-2 text-xs"
                :title="t('grid.copyValue')"
                @click="copyDialogCellFormattedJson"
              >
                <Copy class="h-3 w-3" />
              </Button>
            </div>
            <pre
              class="max-h-[44vh] overflow-auto rounded border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap"
              >{{ dialogCellDetail.formattedJson }}</pre
            >
          </div>
        </div>

        <DialogFooter class="shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyDialogCellValue">
              <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyValue") }}
            </Button>
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyDialogCellColumnName">
              <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyColumnName") }}
            </Button>
          </div>
          <Button
            v-if="dialogCellDetail.isEditable"
            variant="ghost"
            size="sm"
            class="h-7 text-xs"
            @click="openDialogCellInSidePanel"
          >
            <Pencil class="mr-1.5 h-3 w-3" /> {{ t("grid.editValue") }}
          </Button>
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

        <div class="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          <span>{{ t("grid.columnsCount", { count: rowDetail.fields.length }) }}</span>
        </div>

        <div class="min-h-0 flex-1 overflow-auto rounded border">
          <table class="w-full min-w-[640px] text-xs">
            <thead class="sticky top-0 z-10 bg-muted/80 text-muted-foreground backdrop-blur">
              <tr class="border-b">
                <th class="w-16 px-3 py-2 text-left font-medium">{{ t("grid.fieldIndex") }}</th>
                <th class="w-56 px-3 py-2 text-left font-medium">{{ t("grid.columnName") }}</th>
                <th class="px-3 py-2 text-left font-medium">{{ t("grid.cellValue") }}</th>
                <th class="w-10 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(field, fieldIndex) in rowDetail.fields"
                :key="`${field.colIndex}:${field.column}`"
                class="border-b align-top last:border-b-0"
              >
                <td class="px-3 py-2 text-muted-foreground tabular-nums">{{ fieldIndex + 1 }}</td>
                <td class="px-3 py-2">
                  <div class="font-medium break-all">{{ field.column }}</div>
                  <div
                    :class="field.type ? typeColorClass(field.type) : 'text-muted-foreground'"
                    class="mt-1 text-[11px]"
                  >
                    {{ field.type || "-" }}
                  </div>
                  <div v-if="field.comment" class="mt-1 text-[11px] text-muted-foreground whitespace-pre-wrap">
                    {{ field.comment }}
                  </div>
                </td>
                <td class="min-w-0 px-3 py-2">
                  <div class="mb-1 text-[11px] text-muted-foreground">
                    {{ field.value === null ? t("grid.nullValue") : t("grid.valueLength") }}:
                    {{ field.value === null ? "true" : field.length }}
                  </div>
                  <a
                    v-if="field.imagePreviewUrl"
                    :href="field.imagePreviewUrl"
                    role="button"
                    class="mb-2 block max-h-48 overflow-hidden rounded border bg-muted/20"
                    @click.prevent="openImagePreview(field.imagePreviewUrl, field.column)"
                  >
                    <img
                      :src="field.imagePreviewUrl"
                      :alt="field.column"
                      loading="lazy"
                      decoding="async"
                      referrerpolicy="no-referrer"
                      class="max-h-48 w-full object-contain"
                    />
                  </a>
                  <pre
                    class="max-h-44 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-words"
                    :class="{ 'italic text-muted-foreground': field.value === null }"
                    >{{ field.rawValue }}</pre
                  >
                  <div v-if="field.formattedJson" class="mt-2 space-y-1">
                    <div class="text-muted-foreground">{{ t("grid.formattedJson") }}</div>
                    <pre
                      class="max-h-44 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-words"
                      >{{ field.formattedJson }}</pre
                    >
                  </div>
                </td>
                <td class="px-2 py-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-6 w-6"
                    :title="t('grid.copyValue')"
                    @click="copyRowDetailFieldValue(field)"
                  >
                    <Copy class="h-3 w-3" />
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <DialogFooter class="shrink-0 justify-start gap-2">
          <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyRowDetailJson">
            <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyRow") }}
          </Button>
          <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyRowDetailTsv">
            <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyRowTsv") }}
          </Button>
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

        <div class="min-h-0 flex-1 overflow-auto rounded border">
          <table class="w-full min-w-[500px] text-xs">
            <thead class="sticky top-0 z-10 bg-muted/80 text-muted-foreground backdrop-blur">
              <tr class="border-b">
                <th class="w-24 px-3 py-2 text-left font-medium">{{ t("grid.rowNumber") }}</th>
                <th class="px-3 py-2 text-left font-medium">{{ t("grid.cellValue") }}</th>
                <th class="w-10 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="field in columnDetail.fields"
                :key="`${field.rowId}:${field.colIndex}`"
                class="border-b align-top last:border-b-0"
              >
                <td class="px-3 py-2 tabular-nums">{{ field.rowNumber }}</td>
                <td class="min-w-0 px-3 py-2">
                  <div class="mb-1 text-[11px] text-muted-foreground">
                    {{ field.value === null ? t("grid.nullValue") : t("grid.valueLength") }}:
                    {{ field.value === null ? "true" : field.length }}
                  </div>
                  <a
                    v-if="field.imagePreviewUrl"
                    :href="field.imagePreviewUrl"
                    role="button"
                    class="mb-2 block max-h-40 overflow-hidden rounded border bg-muted/20"
                    @click.prevent="openImagePreview(field.imagePreviewUrl, field.column)"
                  >
                    <img
                      :src="field.imagePreviewUrl"
                      :alt="field.column"
                      loading="lazy"
                      decoding="async"
                      referrerpolicy="no-referrer"
                      class="max-h-40 w-full object-contain"
                    />
                  </a>
                  <pre
                    class="max-h-36 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-words"
                    :class="{ 'italic text-muted-foreground': field.value === null }"
                    >{{ field.rawValue }}</pre
                  >
                  <div v-if="field.formattedJson" class="mt-2 space-y-1">
                    <div class="text-muted-foreground">{{ t("grid.formattedJson") }}</div>
                    <pre
                      class="max-h-36 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-words"
                      >{{ field.formattedJson }}</pre
                    >
                  </div>
                </td>
                <td class="px-2 py-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-6 w-6"
                    :title="t('grid.copyValue')"
                    @click="copyColumnDetailFieldValue(field)"
                  >
                    <Copy class="h-3 w-3" />
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <DialogFooter class="shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyColumnDetailJson">
              <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyColumnValues") }}
            </Button>
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyColumnDetailTsv">
              <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyColumnTsv") }}
            </Button>
          </div>
          <Button variant="ghost" size="sm" class="h-7 text-xs" @click="copyColumnDetailColumnName">
            <Copy class="mr-1.5 h-3 w-3" /> {{ t("grid.copyColumnName") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <DangerConfirmDialog
      v-model:open="showDeleteRowConfirm"
      :message="
        pendingDeleteRowIds.length > 1
          ? t('dangerDialog.deleteRowsMessage', { count: pendingDeleteRowIds.length })
          : t('dangerDialog.deleteRowMessage')
      "
      :details="deleteRowDetails"
      :confirm-label="
        pendingDeleteRowIds.length > 1
          ? t('grid.deleteRows', { count: pendingDeleteRowIds.length })
          : t('grid.deleteRow')
      "
      @confirm="confirmDeleteRow"
    />
    <ImagePreviewDialog v-model:open="imagePreviewOpen" :src="imagePreviewSrc" :title="imagePreviewTitle" />
  </div>
</template>

<style scoped>
.data-grid-topbar {
  min-width: 760px;
}

.data-grid-topbar-scroll {
  scrollbar-width: thin;
}

.data-grid-scroller {
  overflow-anchor: none;
  will-change: scroll-position;
  contain: strict;
}

.data-grid-scroller :deep(.vue-recycle-scroller__item-wrapper) {
  min-width: var(--total-w);
  overflow: visible;
}

.data-grid-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style paint;
}

.data-grid-scroller.is-scrolling :deep(.vue-recycle-scroller__item-view) {
  pointer-events: none;
}

.transpose-grid-scroller {
  overflow-anchor: none;
  will-change: scroll-position;
}

.transpose-grid-scroller :deep(.vue-recycle-scroller__item-wrapper) {
  min-width: var(--transpose-total-w);
  overflow: visible;
}

.transpose-grid-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style paint;
}

.ddl-drawer-resizing {
  transition: none;
}

.detail-drawer-resizing {
  transition: none;
}

.cell-selected {
  background-color: color-mix(in oklab, var(--primary) 25%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary) 70%, transparent);
}

.row-cell-selected {
  background-color: color-mix(in oklab, var(--primary) 25%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary) 70%, transparent);
}

.transpose-record-header-selected {
  background-color: color-mix(in oklab, var(--primary) 25%, var(--background));
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary) 70%, transparent);
}

.transpose-record-header-active {
  background-color: color-mix(in oklab, var(--primary) 25%, var(--background));
}

.cell-selected-dirty {
  background-color: color-mix(in oklab, oklch(0.8 0.15 85) 30%, color-mix(in oklab, var(--primary) 18%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary) 70%, transparent);
}

.row-cell-selected-dirty {
  background-color: color-mix(in oklab, oklch(0.8 0.15 85) 30%, color-mix(in oklab, var(--primary) 18%, transparent));
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary) 70%, transparent);
}

.active-row > div:not(.cell-dirty) {
  background-color: color-mix(in oklab, var(--primary) 15%, transparent);
}

.ddl-code :deep(.ddl-kw) {
  color: oklch(0.6 0.15 250);
  font-weight: 600;
}

.ddl-code :deep(.ddl-ident) {
  color: oklch(0.65 0.15 150);
}

.ddl-code :deep(.ddl-str) {
  color: oklch(0.65 0.15 50);
}
</style>
