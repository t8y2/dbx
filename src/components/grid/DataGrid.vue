<script lang="ts">
import { ref } from "vue";
const globalDdlOpen = ref(false);
</script>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Download,
  Plus,
  Trash2,
  Save,
  ChevronLeft,
  ChevronRight,
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
} from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import type { QueryResult, ColumnInfo, DatabaseType } from "@/types/database";
import * as api from "@/lib/api";
import { buildTableSelectSql, quoteTableIdentifier } from "@/lib/tableSelectSql";
import { formatGridSqlLiteral } from "@/lib/dataGridSql";
import { matchesRowStatusFilter, type RowStatus, type RowStatusFilter } from "@/lib/gridRowStatus";

import { useToast } from "@/composables/useToast";
import { useDataGridExport } from "@/composables/useDataGridExport";
import { useDataGridColumnResize } from "@/composables/useDataGridColumnResize";
import { useDataGridSelection } from "@/composables/useDataGridSelection";
import { useDataGridEditor } from "@/composables/useDataGridEditor";

const { t } = useI18n();
const { toast } = useToast();

const props = defineProps<{
  result: QueryResult;
  sql?: string;
  editable?: boolean;
  databaseType?: DatabaseType;
  connectionId?: string;
  database?: string;
  context?: "results" | "table-data";
  tableMeta?: {
    schema?: string;
    tableName: string;
    columns: ColumnInfo[];
    primaryKeys: string[];
  };
  loading?: boolean;
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
  reload: [sql?: string, searchText?: string, whereInput?: string, orderBy?: string];
  paginate: [offset: number, limit: number, whereInput?: string, orderBy?: string];
  sort: [column: string, columnIndex: number, direction: "asc" | "desc" | null, whereInput?: string];
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
  if (s === "bigint") return "int8";
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
const detailCell = ref<{ rowIndex: number; col: number } | null>(null);
const showCellDetail = ref(false);
const transposeRowIndex = ref<number | null>(null);
const showTranspose = ref(false);
const sortCol = ref<string | null>(null);
const sortColIndex = ref<number | null>(null);
const sortDir = ref<"asc" | "desc">("asc");
const searchText = ref("");
const deferredClientSearchText = ref("");
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

const orderBySuggestions = ref<string[]>([]);
const orderBySuggestionIndex = ref(-1);
const orderByInputRef = ref<HTMLInputElement>();
const orderByMeasureRef = ref<HTMLSpanElement>();
const orderBySuggestionLeft = ref(0);

const orderByInput = ref("");
const hasOrderByInput = computed(() => orderByInput.value.trim().length > 0);
const whereFilterInput = ref("");
const hasWhereFilterInput = computed(() => whereFilterInput.value.trim().length > 0);

type LocalColumnFilterDraft = {
  columnIndex: number;
  values: Set<string>;
};

const localColumnFilters = ref<Record<number, Set<string>>>({});
const localFilterOpenColumn = ref<number | null>(null);
const localFilterSearch = ref("");
const localFilterDraft = ref<LocalColumnFilterDraft | null>(null);

function localFilterKey(value: CellValue): string {
  if (value === null) return "__dbx_null__";
  if (typeof value === "boolean") return `bool:${value}`;
  if (typeof value === "number") return `num:${value}`;
  return `str:${String(value)}`;
}

function localFilterLabel(value: CellValue): string {
  return value === null ? "NULL" : formatCell(value);
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
      byKey.set(key, { key, label: localFilterLabel(value), count: 1, value });
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

function openLocalFilter(colIdx: number) {
  localFilterSearch.value = "";
  const allKeys = buildLocalFilterOptions(colIdx).map((option) => option.key);
  localFilterDraft.value = {
    columnIndex: colIdx,
    values: new Set(localColumnFilters.value[colIdx] ?? allKeys),
  };
  localFilterOpenColumn.value = colIdx;
}

function closeLocalFilter() {
  localFilterOpenColumn.value = null;
  localFilterDraft.value = null;
  localFilterSearch.value = "";
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

function applyLocalFilter() {
  const draft = localFilterDraft.value;
  if (!draft) return;
  const allKeys = new Set(localFilterAllOptions.value.map((option) => option.key));
  const next = { ...localColumnFilters.value };
  if (draft.values.size === 0 || draft.values.size === allKeys.size) {
    delete next[draft.columnIndex];
  } else {
    next[draft.columnIndex] = new Set(draft.values);
  }
  localColumnFilters.value = next;
  closeLocalFilter();
  resetGridVerticalScroll();
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
    if (e.key === "Escape") {
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
  if (e.key === "Escape") {
    searchText.value = "";
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

// --- Column resize composable ---
const { initColumnWidths, onResizeStart, autoFitColumn, columnVars, getIsResizing } = useDataGridColumnResize({
  columns: computed(() => props.result.columns),
  rows: computed(() => props.result.rows),
  gridRef,
});
function syncHeaderScroll(e: Event) {
  if (headerRef.value) {
    headerRef.value.scrollLeft = (e.target as HTMLElement).scrollLeft;
  }
}

initColumnWidths();
watch(() => props.result.columns.length, initColumnWidths);
watch(
  () => props.result,
  () => {
    localColumnFilters.value = {};
    closeLocalFilter();
  },
);

// --- Pagination ---
const pageSize = ref(100);
const currentPage = ref(1);
const isFullPage = computed(() => props.result.rows.length >= pageSize.value);
const isResultsContext = computed(() => props.context === "results");
const canUseWhereSearch = computed(() => !!props.tableMeta && !!props.onExecuteSql && !isResultsContext.value);
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
  return whereFilterInput.value.trim() || undefined;
}

function currentOrderBy(): string | undefined {
  return (
    orderByInput.value.trim() ||
    (sortCol.value ? `${quoteIdent(sortCol.value)} ${sortDir.value.toUpperCase()}` : undefined)
  );
}

function prevPage() {
  if (currentPage.value <= 1) return;
  currentPage.value--;
  resetGridVerticalScroll(true);
  emit("paginate", (currentPage.value - 1) * pageSize.value, pageSize.value, currentWhereInput(), currentOrderBy());
}
function nextPage() {
  if (!isFullPage.value) return;
  currentPage.value++;
  resetGridVerticalScroll(true);
  emit("paginate", (currentPage.value - 1) * pageSize.value, pageSize.value, currentWhereInput(), currentOrderBy());
}
function changePageSize(size: number) {
  pageSize.value = size;
  currentPage.value = 1;
  resetGridVerticalScroll(true);
  emit("paginate", 0, size, currentWhereInput(), currentOrderBy());
}

// --- Editing (composable) ---
type CellValue = string | number | boolean | null;

interface RowItem {
  id: number;
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
  onExecuteSql: computed(() => props.onExecuteSql),
  customSave: computed(() => props.customSave),
  sql: computed(() => props.sql),
  searchText,
  whereFilterInput,
  orderByInput,
  rowStatusFilter,
  getRowItem,
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
  onEditKeydown,
  addRow,
  showDeleteRowConfirm,
  requestDeleteRow,
  confirmDeleteRow,
  restoreRow,
  saveChanges,
  discardChanges,
  rowDataWithChanges,
  coerceCellValue,
  resetGridVerticalScroll,
  getResetScrollAfterResult,
  clearResetScrollAfterResult,
  cleanupFrames,
} = editor;

async function onToolbarRefresh() {
  if (transactionActive.value) {
    discardChanges();
  }
  emit(
    "reload",
    props.sql,
    searchText.value,
    whereFilterInput.value.trim() || undefined,
    orderByInput.value.trim() || undefined,
  );
}

async function onToolbarCommit() {
  await saveChanges();
}

function onToolbarRollback() {
  discardChanges();
  emit(
    "reload",
    props.sql,
    searchText.value,
    whereFilterInput.value.trim() || undefined,
    orderByInput.value.trim() || undefined,
  );
}

const sortedRows = computed(() => {
  let indices = localFilteredRows.value;
  const q = deferredClientSearchText.value;
  if (q) {
    const rows = props.result.rows;
    indices = indices.filter((sourceIndex) => {
      const data = rowDataWithChanges(rows[sourceIndex], sourceIndex);
      return data.some((cell) => cell !== null && String(cell).toLowerCase().includes(q));
    });
  }
  return indices;
});

const displayItems = computed<RowItem[]>(() => {
  const cols = props.result.columns;
  const rows = props.result.rows;
  const items: RowItem[] = sortedRows.value.map((sourceIndex) => {
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
  return items.filter((item) => matchesRowStatusFilter(item.status, rowStatusFilter.value));
});

function getRowItem(rowId: number): RowItem | undefined {
  return displayItems.value.find((item) => item.id === rowId);
}

const deleteRowDetails = computed(() =>
  props.tableMeta?.tableName
    ? t("dangerDialog.deleteRowDetails", { table: props.tableMeta.tableName })
    : t("dangerDialog.deleteRowDetailsNoTable"),
);

function deleteSelectedRow() {
  if (!contextCell.value) return;
  requestDeleteRow(contextCell.value.rowId);
}
const hasVisibleRows = computed(() => displayItems.value.length > 0);
const hasActiveFilter = computed(
  () => !!deferredClientSearchText.value || rowStatusFilter.value !== "all" || hasLocalColumnFilters.value,
);
const totalFilterableRowCount = computed(() => props.result.rows.length + newRows.value.length);
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
  columns: computed(() => props.result.columns),
  displayItems,
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
  finishCellSelection,
  beginCellSelection,
  extendCellSelection,
  cellIsSelected,
  selectedRangeStart,
} = selection;

const selectionSummary = computed(() => t("grid.selectedCells", { count: selectedCellCount.value }));
const contextRowItem = computed(() => (contextCell.value ? getRowItem(contextCell.value.rowId) : undefined));
const contextColumn = computed(() => {
  if (!contextCell.value || contextCell.value.col < 0) return null;
  return props.result.columns[contextCell.value.col] ?? null;
});
const contextCellValue = computed<CellValue | null>(() => {
  if (!contextCell.value || contextCell.value.col < 0) return null;
  return contextRowItem.value?.data[contextCell.value.col] ?? null;
});
const activeCellDetail = computed(() => {
  const cell = detailCell.value;
  if (!cell) return null;
  const item = displayItems.value[cell.rowIndex];
  const column = props.result.columns[cell.col];
  if (!item || !column) return null;
  const value = item.data[cell.col] ?? null;
  const rawValue = formatCell(value);
  const valueText = value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const trimmed = valueText.trim();
  const maybeJson = typeof value === "string" && (trimmed.startsWith("{") || trimmed.startsWith("["));
  let formattedJson = "";
  if (maybeJson) {
    try {
      formattedJson = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      formattedJson = "";
    }
  }
  return {
    rowNumber: cell.rowIndex + 1,
    rowId: item.id,
    colIndex: cell.col,
    column,
    type: columnTypeMap.value.get(column) || "",
    comment: columnCommentMap.value.get(column) || "",
    value,
    rawValue,
    length: value === null ? 0 : String(value).length,
    formattedJson,
    isEditable: props.editable && !item.isDeleted,
  };
});

const detailEditValue = ref("");
const isEditingDetail = ref(false);

function startDetailEdit() {
  const detail = activeCellDetail.value;
  if (!detail || !detail.isEditable) return;
  detailEditValue.value =
    detail.value === null ? "" : typeof detail.value === "object" ? JSON.stringify(detail.value) : String(detail.value);
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
  isEditingDetail.value = false;
}

function setDetailNull() {
  const detail = activeCellDetail.value;
  if (!detail || !detail.isEditable) return;

  const item = getRowItem(detail.rowId);
  if (!item || item.isDeleted) return;

  if (item.isNew && item.newIndex !== undefined) {
    newRows.value[item.newIndex][detail.colIndex] = null;
    newRows.value = [...newRows.value];
    isEditingDetail.value = false;
    detailCell.value = { ...detailCell.value! };
    return;
  }

  if (item.sourceIndex === undefined) return;
  if (!dirtyRows.value.has(item.sourceIndex)) dirtyRows.value.set(item.sourceIndex, new Map());
  dirtyRows.value.get(item.sourceIndex)!.set(detail.colIndex, null);
  dirtyRows.value = new Map(dirtyRows.value);
  if (useTransaction.value && !transactionActive.value) {
    enterTransaction();
  }
  isEditingDetail.value = false;
  detailCell.value = { ...detailCell.value! };
}

function toggleSort(colName: string, colIdx: number) {
  if (getIsResizing()) return;
  if (sortCol.value === colName && sortColIndex.value === colIdx) {
    if (sortDir.value === "asc") {
      sortDir.value = "desc";
      emit("sort", colName, colIdx, "desc", currentWhereInput());
    } else {
      sortCol.value = null;
      sortColIndex.value = null;
      sortDir.value = "asc";
      emit("sort", colName, colIdx, null, currentWhereInput());
    }
  } else {
    sortCol.value = colName;
    sortColIndex.value = colIdx;
    sortDir.value = "asc";
    emit("sort", colName, colIdx, "asc", currentWhereInput());
  }
}

function applyContextSort(direction: "asc" | "desc" | null) {
  if (!contextColumn.value || !contextCell.value) return;
  const column = contextColumn.value;
  const columnIndex = contextCell.value.col;
  orderByInput.value = "";
  currentPage.value = 1;
  if (direction) {
    sortCol.value = column;
    sortColIndex.value = columnIndex;
    sortDir.value = direction;
  } else {
    sortCol.value = null;
    sortColIndex.value = null;
    sortDir.value = "asc";
  }
  emit("sort", column, columnIndex, direction, currentWhereInput());
}

function contextFilterCondition(mode: "equals" | "not-equals" | "is-null" | "is-not-null"): string | null {
  if (!contextColumn.value) return null;
  const column = quoteIdent(contextColumn.value);
  const value = contextCellValue.value;

  if (mode === "is-null") return `${column} IS NULL`;
  if (mode === "is-not-null") return `${column} IS NOT NULL`;
  if (value === null) return mode === "equals" ? `${column} IS NULL` : `${column} IS NOT NULL`;
  return mode === "equals" ? `${column} = ${escapeVal(value)}` : `${column} <> ${escapeVal(value)}`;
}

async function applyContextFilter(mode: "equals" | "not-equals" | "is-null" | "is-not-null") {
  if (!canUseWhereSearch.value) return;
  const condition = contextFilterCondition(mode);
  if (!condition) return;
  const existing = whereFilterInput.value.trim();
  whereFilterInput.value = existing ? `(${existing}) AND (${condition})` : condition;
  await applyWhereFilter();
}

async function clearContextFilter() {
  if (!canUseWhereSearch.value) return;
  whereFilterInput.value = "";
  await applyWhereFilter();
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
    const sql = buildTableSelectSql({
      databaseType: props.databaseType,
      schema: props.tableMeta.schema,
      tableName: props.tableMeta.tableName,
      primaryKeys: props.tableMeta.primaryKeys,
      orderBy: orderByClause,
      limit: pageSize.value,
      whereInput: whereFilterInput.value.trim() || undefined,
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
    const sql = buildTableSelectSql({
      databaseType: props.databaseType,
      schema: props.tableMeta.schema,
      tableName: props.tableMeta.tableName,
      primaryKeys: props.tableMeta.primaryKeys,
      orderBy:
        orderByInput.value.trim() ||
        (sortCol.value ? `${quoteIdent(sortCol.value)} ${sortDir.value.toUpperCase()}` : undefined),
      limit: pageSize.value,
      whereInput: whereFilterInput.value.trim() || undefined,
    });
    await props.onExecuteSql(sql);
  } catch (e: any) {
    saveError.value = String(e?.message || e);
  } finally {
    isApplyingWhere.value = false;
  }
}

const CELL_DISPLAY_MAX_LENGTH = 256;

function formatCell(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  return s.length > CELL_DISPLAY_MAX_LENGTH ? s.slice(0, CELL_DISPLAY_MAX_LENGTH) : s;
}

function quoteIdent(name: string): string {
  return quoteTableIdentifier(props.databaseType, name);
}

function escapeVal(value: CellValue): string {
  return formatGridSqlLiteral(value);
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

function setRowStatusFilter(value: string) {
  rowStatusFilter.value = value as RowStatusFilter;
}

// --- Export composable ---
const {
  copyText,
  copyCell,
  copyRow,
  copyRowAsInsert,
  copyAll,
  copySelectionTsv,
  copySelectionCsv,
  copySelectionJson,
  copySelectionSqlInList,
  exportCsv,
  exportJson,
  exportMarkdown,
  exportXlsx,
  copySql,
} = useDataGridExport({
  columns: computed(() => props.result.columns),
  displayItems,
  sql: computed(() => props.sql),
  tableMeta: computed(() =>
    props.tableMeta ? { schema: props.tableMeta.schema, tableName: props.tableMeta.tableName } : undefined,
  ),
  databaseType: computed(() => props.databaseType),
  hasCellSelection,
  selectedCells,
  contextCell,
  getRowItem,
  formatCell,
  quoteIdent,
  escapeVal,
});

// --- Cell selection and detail ---
function showCellDetails(rowIndex: number, colIndex: number) {
  detailCell.value = { rowIndex, col: colIndex };
  showCellDetail.value = true;
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
      const col = start.colIndex + colOffset;
      if (col >= props.result.columns.length) return;
      applyCellValue(item.id, col, value);
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
    for (let col = range.startCol; col <= range.endCol; col++) {
      applyCellValue(item.id, col, null);
    }
  }
}

async function onGridKeydown(event: KeyboardEvent) {
  if (eventTargetAllowsNativeClipboard(event)) return;
  if (clipboardShortcut(event, "c")) {
    if (!hasCellSelection.value) return;
    event.preventDefault();
    copySelectionTsv();
    return;
  }
  if (clipboardShortcut(event, "x")) {
    if (!props.editable || !hasCellSelection.value) return;
    event.preventDefault();
    cutSelection();
    return;
  }
  if (clipboardShortcut(event, "v")) {
    if (!props.editable || !hasCellSelection.value) return;
    event.preventDefault();
    await pasteClipboardIntoSelection();
  }
}

function copyDetailValue() {
  if (!activeCellDetail.value) return;
  copyText(activeCellDetail.value.rawValue);
}

function copyDetailColumnName() {
  if (!activeCellDetail.value) return;
  copyText(activeCellDetail.value.column);
}

function copyDetailSqlCondition() {
  const detail = activeCellDetail.value;
  if (!detail) return;
  const column = quoteIdent(detail.column);
  const condition = detail.value === null ? `${column} IS NULL` : `${column} = ${escapeVal(detail.value)}`;
  copyText(condition);
}

const transposeData = computed(() => {
  if (transposeRowIndex.value === null) return null;
  const item = displayItems.value[transposeRowIndex.value];
  if (!item) return null;
  return props.result.columns.map((col, i) => ({
    column: col,
    type: columnTypeMap.value.get(col) || "",
    value: item.data[i],
    display: formatCell(item.data[i]),
    isNull: item.data[i] === null,
  }));
});

function openTranspose(rowIndex: number) {
  transposeRowIndex.value = rowIndex;
  showTranspose.value = true;
  showCellDetail.value = false;
}

function transposeNav(delta: number) {
  if (transposeRowIndex.value === null) return;
  const next = transposeRowIndex.value + delta;
  if (next >= 0 && next < displayItems.value.length) {
    transposeRowIndex.value = next;
  }
}

watch(
  () => props.result,
  () => {
    if (getResetScrollAfterResult()) {
      clearResetScrollAfterResult();
      resetGridVerticalScroll();
    }
    clearCellSelection();
    showCellDetail.value = false;
    detailCell.value = null;
    showTranspose.value = false;
    transposeRowIndex.value = null;
    exitTransaction();
  },
);

// --- Context menu handlers ---
function onCellContext(rowId: number, rowIndex: number, colIdx: number) {
  contextCell.value = { rowId, rowIndex, col: colIdx };
  if (!cellIsSelected(rowIndex, colIdx)) {
    selectSingleCell(rowIndex, colIdx);
  }
}

function onRowContext(rowId: number, rowIndex: number) {
  contextCell.value = { rowId, rowIndex, col: -1 };
  selectRow(rowIndex);
}

const sqlOneLiner = computed(() => props.sql?.replace(/\s+/g, " ").trim() || "");

const showDdl = globalDdlOpen;
const ddlContent = ref("");
const ddlLoading = ref(false);
const ddlWidth = ref(320);
const ddlWrap = ref(true);
const isResizingDdl = ref(false);
let ddlResizeStartX = 0;
let ddlResizeStartWidth = 0;

const ddlDrawerStyle = computed(() => ({
  width: `${ddlWidth.value}px`,
}));

async function toggleDdl() {
  if (showDdl.value) {
    showDdl.value = false;
    return;
  }
  await fetchDdl();
}

async function fetchDdl() {
  if (!props.connectionId || !props.tableMeta) return;
  showDdl.value = true;
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

if (showDdl.value && props.tableMeta && props.connectionId) {
  fetchDdl();
}

function copyDdl() {
  navigator.clipboard.writeText(ddlContent.value);
  toast(t("grid.copied"));
}

function toggleDdlWrap() {
  ddlWrap.value = !ddlWrap.value;
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
  onDdlResizeEnd();
  finishCellSelection();
  clearTimeout(_searchTimer);
  clearInterval(_loadingTimer);
});

const SQL_KEYWORDS =
  /\b(CREATE|TABLE|INDEX|UNIQUE|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|NOT|NULL|DEFAULT|INT|INTEGER|BIGINT|SMALLINT|VARCHAR|CHARACTER|VARYING|TEXT|BOOLEAN|DOUBLE|PRECISION|REAL|FLOAT|NUMERIC|DECIMAL|TIMESTAMP|DATE|TIME|SERIAL|AUTOINCREMENT|AUTO_INCREMENT|IF|EXISTS|ON|SET|CASCADE|RESTRICT|CHECK|WITH|WITHOUT|ZONE)\b/gi;

function highlightSql(sql: string): string {
  const tokens: string[] = [];
  let rest = sql;
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  let match: RegExpExecArray | null;
  let last = 0;
  while ((match = re.exec(rest)) !== null) {
    if (match.index > last) tokens.push(escapeAndHighlightKeywords(rest.slice(last, match.index)));
    const q = match[1];
    const escaped = q.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const cls = q.startsWith('"') ? "ddl-ident" : "ddl-str";
    tokens.push(`<span class="${cls}">${escaped}</span>`);
    last = re.lastIndex;
  }
  if (last < rest.length) tokens.push(escapeAndHighlightKeywords(rest.slice(last)));
  return tokens.join("");
}

function escapeAndHighlightKeywords(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(SQL_KEYWORDS, '<span class="ddl-kw">$1</span>');
}

defineExpose({
  useTransaction,
  transactionActive,
  isSaving,
  onToolbarRefresh,
  onToolbarCommit,
  onToolbarRollback,
  showDdl,
  toggleDdl,
});
</script>

<template>
  <div
    ref="gridRef"
    class="h-full flex flex-col overflow-hidden outline-none"
    :style="columnVars"
    tabindex="0"
    @keydown="onGridKeydown"
  >
    <ContextMenu>
      <ContextMenuTrigger as-child>
        <div v-if="hasData || canUseWhereSearch" class="flex-1 flex flex-col overflow-hidden">
          <!-- Search bar -->
          <div class="flex items-center border-b shrink-0 bg-muted/20 relative">
            <div class="flex-1 flex items-center gap-1 px-2 py-1 min-w-0">
              <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                ref="searchInputRef"
                v-model="searchText"
                autocapitalize="off"
                autocorrect="off"
                spellcheck="false"
                class="flex-1 h-5 min-w-0 text-xs bg-transparent outline-none placeholder:text-muted-foreground"
                :placeholder="t('grid.search')"
                @keydown="onSearchKeydown"
                @click="updateSuggestionPosition"
              />
              <span
                ref="measureRef"
                class="invisible absolute left-0 top-0 text-xs whitespace-pre pointer-events-none"
                aria-hidden="true"
              />
              <!-- Suggestion dropdown -->
              <div
                v-if="searchSuggestions.length > 0"
                class="absolute top-full mt-0.5 z-50 min-w-[180px] rounded-md border bg-popover text-popover-foreground shadow-md"
                :style="{ left: suggestionLeft + 24 + 'px' }"
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
              <span v-if="hasActiveFilter" class="text-xs text-muted-foreground shrink-0 px-1">
                {{ displayItems.length }}/{{ totalFilterableRowCount }}
              </span>
              <button
                v-if="hasLocalColumnFilters"
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

            <template v-if="canUseWhereSearch">
              <div class="flex-1 flex items-center gap-1 px-2 py-1 border-l min-w-0 relative">
                <span class="text-foreground/60 text-xs font-medium select-none shrink-0">WHERE</span>
                <input
                  ref="whereFilterInputRef"
                  v-model="whereFilterInput"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  class="flex-1 h-5 min-w-0 text-xs bg-transparent outline-none placeholder:text-muted-foreground/60"
                  placeholder="condition..."
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
                <div
                  v-if="whereSuggestions.length > 0"
                  class="absolute top-full mt-0.5 z-50 min-w-[180px] rounded-md border bg-popover text-popover-foreground shadow-md"
                  :style="{ left: whereSuggestionLeft + 24 + 'px' }"
                >
                  <div
                    v-for="(sug, idx) in whereSuggestions"
                    :key="sug"
                    class="flex items-center px-3 py-1.5 text-xs cursor-pointer"
                    :class="idx === whereSuggestionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'"
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
              <div class="flex-1 flex items-center gap-1 px-2 py-1 border-l border-r min-w-0 relative">
                <span class="text-foreground/60 text-xs font-medium select-none shrink-0">ORDER BY</span>
                <input
                  ref="orderByInputRef"
                  v-model="orderByInput"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  class="flex-1 h-5 min-w-0 text-xs bg-transparent outline-none placeholder:text-muted-foreground/60"
                  placeholder="columns..."
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
                <div
                  v-if="orderBySuggestions.length > 0"
                  class="absolute top-full mt-0.5 z-50 min-w-[180px] rounded-md border bg-popover text-popover-foreground shadow-md"
                  :style="{ left: orderBySuggestionLeft + 24 + 'px' }"
                >
                  <div
                    v-for="(sug, idx) in orderBySuggestions"
                    :key="sug"
                    class="flex items-center px-3 py-1.5 text-xs cursor-pointer"
                    :class="idx === orderBySuggestionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'"
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
            </template>

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
            <Select
              v-if="useTransaction && editable && (tableMeta || customSave)"
              :model-value="rowStatusFilter"
              @update:model-value="(value: any) => setRowStatusFilter(String(value))"
            >
              <SelectTrigger class="h-6 w-28 px-2 text-xs">
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
            <Button
              v-if="useTransaction && editable && (tableMeta || customSave)"
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
            <Button
              v-if="useTransaction"
              :variant="transactionActive ? 'default' : 'secondary'"
              size="sm"
              class="h-5 text-xs px-1.5"
              :disabled="!transactionActive || isSaving"
              @click="onToolbarCommit"
            >
              <Loader2 v-if="isSaving" class="w-3 h-3 mr-1 animate-spin" />
              <Save v-else class="w-3 h-3 mr-1" />
              {{ t("grid.commit") }}
            </Button>
            <Button
              v-if="useTransaction"
              variant="outline"
              size="sm"
              class="h-5 text-xs px-1.5"
              :disabled="!transactionActive"
              @click="onToolbarRollback"
            >
              <RotateCcw class="w-3 h-3 mr-1" />
              {{ t("grid.rollback") }}
            </Button>
          </div>
          <!-- Truncation warning banner -->
          <div
            v-if="result.truncated"
            class="shrink-0 px-3 py-1 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5"
          >
            <span>{{ t("grid.truncatedHint") }}</span>
          </div>
          <!-- Content area: table + DDL drawer -->
          <div class="flex-1 flex min-h-0 overflow-hidden">
            <div class="flex-1 flex flex-col min-w-0 overflow-hidden relative">
              <!-- Sticky header -->
              <div
                ref="headerRef"
                class="shrink-0 bg-[rgb(239_239_239)] dark:bg-muted/60 z-10 border-y border-border overflow-hidden"
              >
                <div class="flex text-xs font-semibold text-foreground" :style="{ width: 'var(--total-w)' }">
                  <div
                    class="shrink-0 px-2 py-1.5 border-r border-border text-center text-muted-foreground select-none"
                    :style="{ width: 'var(--row-num-w)' }"
                  >
                    #
                  </div>
                  <Tooltip v-for="(col, colIdx) in result.columns" :key="`${col}-${colIdx}`">
                    <TooltipTrigger as-child>
                      <div
                        class="shrink-0 px-2 py-1.5 border-r border-border whitespace-nowrap hover:bg-accent/60 select-none relative overflow-hidden"
                        :style="{ width: `var(--col-w-${colIdx})` }"
                      >
                        <span class="flex min-w-0 items-center gap-1 overflow-hidden">
                          <span class="min-w-0 flex-1 truncate cursor-pointer" @click="toggleSort(col, colIdx)">{{
                            col
                          }}</span>
                          <button
                            type="button"
                            class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                            :class="
                              sortCol === col && sortColIndex === colIdx ? 'text-primary opacity-100' : 'opacity-80'
                            "
                            :title="t('grid.sort')"
                            @click.stop="toggleSort(col, colIdx)"
                          >
                            <ArrowUp
                              v-if="sortCol === col && sortColIndex === colIdx && sortDir === 'asc'"
                              class="h-3 w-3 shrink-0"
                            />
                            <ArrowDown
                              v-else-if="sortCol === col && sortColIndex === colIdx && sortDir === 'desc'"
                              class="h-3 w-3 shrink-0"
                            />
                            <ArrowUpDown v-else class="h-3 w-3 shrink-0" />
                          </button>
                          <Popover
                            :open="localFilterOpenColumn === colIdx"
                            @update:open="(value: boolean) => (value ? openLocalFilter(colIdx) : closeLocalFilter())"
                          >
                            <PopoverTrigger as-child>
                              <button
                                type="button"
                                class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                :class="localFilterActive(colIdx) ? 'text-primary opacity-100' : 'opacity-80'"
                                :title="t('grid.localFilter')"
                                @click.stop
                              >
                                <Filter class="h-3.5 w-3.5" />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent
                              align="start"
                              side="bottom"
                              class="w-[420px] max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl ring-0 dark:border-slate-200 dark:bg-white dark:text-slate-900"
                              @click.stop
                              @keydown.stop
                            >
                              <div
                                class="border-b border-slate-200 bg-slate-50 px-3 py-2 text-center text-sm font-semibold text-slate-900"
                              >
                                {{ t("grid.localFilterFor", { column: col }) }}
                              </div>
                              <div class="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
                                <Search class="h-4 w-4 shrink-0 text-slate-400" />
                                <input
                                  v-model="localFilterSearch"
                                  autocapitalize="off"
                                  autocorrect="off"
                                  spellcheck="false"
                                  class="h-8 min-w-0 flex-1 bg-transparent text-sm text-slate-900 outline-none placeholder:text-slate-400"
                                  :placeholder="t('grid.searchValues')"
                                />
                              </div>
                              <div
                                class="grid grid-cols-[2rem_minmax(0,1fr)_4rem] border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-500"
                              >
                                <button
                                  type="button"
                                  class="flex h-5 w-5 items-center justify-center rounded border"
                                  :class="
                                    localFilterAllVisibleSelected
                                      ? 'border-blue-600 bg-blue-600 text-white'
                                      : 'border-slate-300 bg-white text-slate-700'
                                  "
                                  @click="toggleAllLocalFilterOptions"
                                >
                                  <Check v-if="localFilterAllVisibleSelected" class="h-3.5 w-3.5 stroke-[3]" />
                                </button>
                                <span>{{ t("grid.value") }}</span>
                                <span class="text-right">{{ t("grid.count") }}</span>
                              </div>
                              <div class="max-h-72 overflow-auto py-1">
                                <button
                                  v-for="option in localFilterOptions"
                                  :key="option.key"
                                  type="button"
                                  class="grid w-full grid-cols-[2rem_minmax(0,1fr)_4rem] items-center px-3 py-1.5 text-left text-sm text-slate-900 hover:bg-sky-50"
                                  @click="toggleLocalFilterValue(option.key)"
                                >
                                  <span
                                    class="flex h-5 w-5 items-center justify-center rounded border"
                                    :class="
                                      localFilterDraft?.values.has(option.key)
                                        ? 'border-blue-600 bg-blue-600 text-white'
                                        : 'border-slate-300 bg-white text-slate-700'
                                    "
                                  >
                                    <Check
                                      v-if="localFilterDraft?.values.has(option.key)"
                                      class="h-3.5 w-3.5 stroke-[3]"
                                    />
                                  </span>
                                  <span
                                    class="truncate font-mono"
                                    :class="{ 'italic text-slate-500': option.value === null }"
                                  >
                                    {{ option.label }}
                                  </span>
                                  <span class="text-right tabular-nums text-slate-500">{{ option.count }}</span>
                                </button>
                                <div
                                  v-if="localFilterAllOptions.length > localFilterOptions.length"
                                  class="px-3 py-1 text-center text-[11px] text-slate-500"
                                >
                                  {{
                                    t("grid.moreValues", {
                                      count: localFilterAllOptions.length - localFilterOptions.length,
                                    })
                                  }}
                                </div>
                                <div
                                  v-if="localFilterOptions.length === 0"
                                  class="px-3 py-8 text-center text-sm text-slate-500"
                                >
                                  {{ t("grid.noSearchResults") }}
                                </div>
                              </div>
                              <div
                                class="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-3 py-2"
                              >
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  class="h-7 px-2 text-xs text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-700 dark:hover:bg-slate-100 dark:hover:text-slate-900"
                                  @click="clearLocalFilter(colIdx)"
                                >
                                  {{ t("grid.clearFilter") }}
                                </Button>
                                <div class="flex items-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    class="h-7 border-slate-300 bg-white px-2 text-xs text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:border-slate-300 dark:bg-white dark:text-slate-700 dark:hover:bg-slate-100 dark:hover:text-slate-900"
                                    @click="closeLocalFilter"
                                  >
                                    {{ t("dangerDialog.cancel") }}
                                  </Button>
                                  <Button
                                    size="sm"
                                    class="h-7 bg-slate-950 px-2 text-xs text-white hover:bg-slate-800 dark:bg-slate-950 dark:text-white dark:hover:bg-slate-800"
                                    @click="applyLocalFilter"
                                  >
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
                      v-if="columnTypeMap.get(col) || columnCommentMap.get(col)"
                      side="bottom"
                      class="text-xs grid grid-cols-[auto_1fr] gap-x-2"
                    >
                      <template v-if="columnTypeMap.get(col)">
                        <span class="text-muted-foreground">{{ t("grid.columnType") }}</span>
                        <span :class="typeColorClass(columnTypeMap.get(col)!)">{{ columnTypeMap.get(col) }}</span>
                      </template>
                      <template v-if="columnCommentMap.get(col)">
                        <span class="text-muted-foreground">{{ t("grid.columnComment") }}</span>
                        <span>{{ columnCommentMap.get(col) }}</span>
                      </template>
                    </TooltipContent>
                  </Tooltip>
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
                :items="displayItems"
                :item-size="26"
                key-field="id"
                @scroll="syncHeaderScroll"
              >
                <template #default="{ item, index }">
                  <div
                    class="flex text-xs border-b border-border hover:bg-accent/50"
                    :class="{
                      'bg-destructive/5 opacity-70': item.isDeleted,
                      'bg-primary/5': item.isNew,
                      'bg-muted/30': !item.isNew && !item.isDeleted && index % 2 === 1,
                    }"
                    :style="{ height: '26px', width: 'var(--total-w)' }"
                  >
                    <div
                      class="shrink-0 px-2 py-1 border-r border-border text-center select-none cursor-default hover:bg-accent/50"
                      :class="rowNumberStatusClass(item)"
                      :style="{ width: 'var(--row-num-w)' }"
                      @click="selectRow(index)"
                      @contextmenu="onRowContext(item.id, index)"
                    >
                      {{ index + 1 }}
                    </div>
                    <div
                      v-for="(cell, colIdx) in item.data"
                      :key="colIdx"
                      class="group/cell shrink-0 px-3 py-1 border-r border-border whitespace-nowrap overflow-hidden text-ellipsis relative select-none"
                      :style="{ width: `var(--col-w-${colIdx})` }"
                      :class="{
                        'text-muted-foreground italic': isNull(cell),
                        'bg-yellow-500/10': item.isDirtyCol[colIdx],
                        'cell-selected': cellIsSelected(index, colIdx),
                        'tabular-nums': typeof cell === 'number',
                        'cursor-text hover:bg-accent/50': editable && !item.isDeleted,
                        'line-through': item.isDeleted,
                      }"
                      @mousedown="beginCellSelection(index, colIdx, $event)"
                      @mouseenter="extendCellSelection(index, colIdx)"
                      @dblclick="editable && !item.isDeleted && startEdit(item.id, colIdx)"
                      @contextmenu="onCellContext(item.id, index, colIdx)"
                    >
                      <template v-if="editingCell?.rowId === item.id && editingCell?.col === colIdx">
                        <input
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
                        {{ formatCell(cell) }}
                        <button
                          class="absolute right-0.5 top-0.5 hidden h-5 w-5 items-center justify-center rounded bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border hover:text-foreground group-hover/cell:flex"
                          :title="t('grid.cellDetails')"
                          @mousedown.stop
                          @click.stop="showCellDetails(index, colIdx)"
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
            </div>
            <!-- DDL Drawer -->
            <div
              v-if="showDdl"
              class="relative shrink-0 border-l flex flex-col bg-background min-w-0"
              :class="{ 'ddl-drawer-resizing': isResizingDdl }"
              :style="ddlDrawerStyle"
            >
              <div
                class="absolute left-0 top-0 bottom-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30"
                @mousedown.prevent="onDdlResizeStart"
              />
              <div class="flex items-center gap-2 px-3 py-1.5 border-b shrink-0 bg-muted/20">
                <Code2 class="w-3.5 h-3.5 text-muted-foreground" />
                <span class="text-xs font-medium flex-1 min-w-0 truncate">{{ tableMeta?.tableName }} DDL</span>
                <Button variant="ghost" size="icon" class="h-5 w-5" @click="copyDdl">
                  <Copy class="w-3 h-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5"
                  :class="{ 'bg-accent': ddlWrap }"
                  @click="toggleDdlWrap"
                >
                  <WrapText class="w-3 h-3" />
                </Button>
                <Button variant="ghost" size="icon" class="h-5 w-5" @click="showDdl = false">
                  <X class="w-3 h-3" />
                </Button>
              </div>
              <div v-if="ddlLoading" class="flex-1 flex items-center justify-center">
                <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
              <pre
                v-else
                class="flex-1 min-w-0 text-xs font-mono p-3 overflow-auto ddl-code leading-5 select-text"
                :class="ddlWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
                v-html="highlightSql(ddlContent)"
              ></pre>
            </div>
            <!-- Cell Detail Drawer -->
            <div
              v-if="showCellDetail && activeCellDetail"
              class="relative w-80 shrink-0 border-l flex flex-col bg-background min-w-0"
            >
              <div class="h-9 flex items-center gap-2 px-3 border-b shrink-0 bg-muted/20">
                <Info class="w-3.5 h-3.5 text-muted-foreground" />
                <span class="text-xs font-medium flex-1 min-w-0 truncate">{{ t("grid.cellDetails") }}</span>
                <Button variant="ghost" size="icon" class="h-5 w-5" @click="showCellDetail = false">
                  <X class="w-3 h-3" />
                </Button>
              </div>

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
                  <template v-if="isEditingDetail">
                    <textarea
                      v-model="detailEditValue"
                      class="w-full h-40 rounded border bg-background p-2 font-mono text-xs outline-none resize-y focus:border-primary"
                      @keydown.escape.stop="cancelDetailEdit"
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
                    class="max-h-56 overflow-auto rounded border bg-muted/20 p-2 font-mono text-xs whitespace-pre-wrap break-words cursor-pointer hover:border-primary/50"
                    :class="{ 'cursor-text': activeCellDetail.isEditable }"
                    @dblclick="startDetailEdit"
                    >{{ activeCellDetail.rawValue }}</pre
                  >
                </div>
                <div v-if="activeCellDetail.formattedJson" class="space-y-1">
                  <div class="text-muted-foreground">{{ t("grid.formattedJson") }}</div>
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
                <Button variant="ghost" size="sm" class="h-7 justify-start text-xs" @click="copyDetailSqlCondition">
                  <Code2 class="w-3 h-3 mr-2" /> {{ t("grid.copySqlCondition") }}
                </Button>
              </div>
            </div>
            <!-- Transpose Panel -->
            <div
              v-if="showTranspose && transposeData"
              class="relative w-80 shrink-0 border-l flex flex-col bg-background min-w-0"
            >
              <div class="h-9 flex items-center gap-2 px-3 border-b shrink-0 bg-muted/20">
                <Rows3 class="w-3.5 h-3.5 text-muted-foreground" />
                <span class="text-xs font-medium">{{ t("grid.transpose") }}</span>
                <span class="text-xs text-muted-foreground"
                  >{{ t("grid.rowNumber") }} {{ (transposeRowIndex ?? 0) + 1 }}</span
                >
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
                <Button variant="ghost" size="icon" class="h-5 w-5" @click="showTranspose = false">
                  <X class="w-3 h-3" />
                </Button>
              </div>
              <div class="flex-1 min-h-0 overflow-auto">
                <table class="w-full text-xs">
                  <tbody>
                    <tr
                      v-for="(field, fi) in transposeData"
                      :key="fi"
                      class="border-b border-border/50 hover:bg-accent/50"
                    >
                      <td class="px-3 py-1.5 font-medium text-muted-foreground whitespace-nowrap w-1/3 align-top">
                        <div>{{ field.column }}</div>
                        <div v-if="field.type" :class="typeColorClass(field.type)" class="text-[10px]">
                          {{ field.type }}
                        </div>
                      </td>
                      <td class="px-3 py-1.5 break-all" :class="{ 'text-muted-foreground italic': field.isNull }">
                        {{ field.display }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent class="w-max max-w-[min(80vw,20rem)]">
        <template v-if="contextColumn">
          <ContextMenuItem @click="applyContextSort('asc')">
            <ArrowUp class="w-3.5 h-3.5 mr-2" /> {{ t("grid.sortAscending") }}
          </ContextMenuItem>
          <ContextMenuItem @click="applyContextSort('desc')">
            <ArrowDown class="w-3.5 h-3.5 mr-2" /> {{ t("grid.sortDescending") }}
          </ContextMenuItem>
          <ContextMenuItem v-if="sortCol" @click="applyContextSort(null)">
            <ArrowUpDown class="w-3.5 h-3.5 mr-2" /> {{ t("grid.clearSort") }}
          </ContextMenuItem>
          <ContextMenuSub v-if="canUseWhereSearch">
            <ContextMenuSubTrigger> <Filter class="w-3.5 h-3.5 mr-2" /> {{ t("grid.filter") }} </ContextMenuSubTrigger>
            <ContextMenuSubContent class="w-max max-w-[min(80vw,18rem)]">
              <ContextMenuItem @click="applyContextFilter('equals')">{{ t("grid.filterByValue") }}</ContextMenuItem>
              <ContextMenuItem @click="applyContextFilter('not-equals')">
                {{ t("grid.filterExcludeValue") }}
              </ContextMenuItem>
              <ContextMenuItem @click="applyContextFilter('is-null')">{{ t("grid.filterIsNull") }}</ContextMenuItem>
              <ContextMenuItem @click="applyContextFilter('is-not-null')">
                {{ t("grid.filterIsNotNull") }}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem @click="clearContextFilter">{{ t("grid.clearFilter") }}</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
        </template>
        <ContextMenuSub>
          <ContextMenuSubTrigger> <Copy class="w-3.5 h-3.5 mr-2" /> {{ t("grid.copy") }} </ContextMenuSubTrigger>
          <ContextMenuSubContent class="w-max max-w-[min(80vw,18rem)]">
            <ContextMenuItem v-if="contextColumn" @click="copyCell">{{ t("grid.copyCell") }}</ContextMenuItem>
            <ContextMenuItem @click="copyRow">{{ t("grid.copyRow") }}</ContextMenuItem>
            <ContextMenuItem @click="copyRowAsInsert">{{ t("grid.copyRowInsert") }}</ContextMenuItem>
            <ContextMenuItem @click="copyAll">{{ t("grid.copyAll") }}</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem v-if="contextCell" @click="openTranspose(contextCell.rowIndex)">
          <Rows3 class="w-3.5 h-3.5 mr-2" /> {{ t("grid.transpose") }}
        </ContextMenuItem>
        <ContextMenuSub v-if="hasCellSelection">
          <ContextMenuSubTrigger>
            <SquareDashed class="w-3.5 h-3.5 mr-2" /> {{ t("grid.selection") }}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent class="w-max max-w-[min(80vw,20rem)]">
            <ContextMenuItem @click="copySelectionTsv">{{ t("grid.copySelectionTsv") }}</ContextMenuItem>
            <ContextMenuItem @click="copySelectionCsv">{{ t("grid.copySelectionCsv") }}</ContextMenuItem>
            <ContextMenuItem @click="copySelectionJson">{{ t("grid.copySelectionJson") }}</ContextMenuItem>
            <ContextMenuItem @click="copySelectionSqlInList">{{ t("grid.copySelectionSql") }}</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem @click="clearCellSelection">{{ t("grid.clearSelection") }}</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <template v-if="editable && contextRowItem">
          <ContextMenuItem v-if="contextRowItem.isDeleted" @click="restoreRow(contextRowItem.id)">
            <Undo2 class="w-3.5 h-3.5 mr-2" /> {{ t("grid.restoreRow") }}
          </ContextMenuItem>
          <ContextMenuItem v-else class="text-destructive" @click="deleteSelectedRow">
            <Trash2 class="w-3.5 h-3.5 mr-2" /> {{ t("grid.deleteRow") }}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </template>
        <ContextMenuSub>
          <ContextMenuSubTrigger> <FileDown class="w-3.5 h-3.5 mr-2" /> {{ t("grid.export") }} </ContextMenuSubTrigger>
          <ContextMenuSubContent class="w-max max-w-[min(80vw,16rem)]">
            <ContextMenuItem @click="exportCsv">{{ t("grid.exportCsv") }}</ContextMenuItem>
            <ContextMenuItem @click="exportXlsx">{{ t("grid.exportXlsx") }}</ContextMenuItem>
            <ContextMenuItem @click="exportJson">{{ t("grid.exportJson") }}</ContextMenuItem>
            <ContextMenuItem @click="exportMarkdown">{{ t("grid.exportMarkdown") }}</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>

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
      <span v-if="hasData">{{ t("grid.totalRows", { count: result.rows.length }) }}</span>
      <span v-if="result.truncated" class="text-amber-500 text-xs ml-1">(truncated)</span>
      <span v-if="!hasData">{{ t("grid.rowsAffected", { count: result.affected_rows }) }}</span>
      <span>{{ result.execution_time_ms }}ms</span>
      <span v-if="hasCellSelection" class="text-foreground">{{ selectionSummary }}</span>

      <template v-if="editable && (tableMeta || customSave) && !useTransaction">
        <span v-if="hasPendingChanges" class="ml-2 text-foreground">
          {{ t("grid.pendingChanges", { count: pendingChangeCount }) }}
        </span>
        <Button v-if="hasPendingChanges" variant="default" size="sm" class="h-5 text-xs ml-2" @click="saveChanges">
          <Save class="w-3 h-3 mr-1" /> {{ t("grid.save") }}
        </Button>
        <Button v-if="hasPendingChanges" variant="ghost" size="sm" class="h-5 text-xs" @click="discardChanges">
          {{ t("grid.discard") }}
        </Button>
      </template>

      <span class="ml-auto flex items-center gap-1">
        <Loader2 v-if="loading" class="w-3 h-3 animate-spin text-muted-foreground" />
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="sm" class="h-5 text-xs px-1.5">
              {{ pageSize }}{{ t("grid.rowsPerPageShort") }}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem v-for="s in [50, 100, 500, 1000]" :key="s" @click="changePageSize(s)">
              {{ s }} {{ t("grid.rowsPerPageShort") }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="currentPage <= 1" @click="prevPage">
          <ChevronLeft class="h-3 w-3" />
        </Button>
        <span>{{ currentPage }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!isFullPage" @click="nextPage">
          <ChevronRight class="h-3 w-3" />
        </Button>
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="h-5 w-5">
            <Download class="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem @click="exportCsv">{{ t("grid.exportCsv") }}</DropdownMenuItem>
          <DropdownMenuItem @click="exportXlsx">{{ t("grid.exportXlsx") }}</DropdownMenuItem>
          <DropdownMenuItem @click="exportJson">{{ t("grid.exportJson") }}</DropdownMenuItem>
          <DropdownMenuItem @click="exportMarkdown">{{ t("grid.exportMarkdown") }}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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

    <DangerConfirmDialog
      v-model:open="showDeleteRowConfirm"
      :message="t('dangerDialog.deleteRowMessage')"
      :details="deleteRowDetails"
      :confirm-label="t('grid.deleteRow')"
      @confirm="confirmDeleteRow"
    />
  </div>
</template>

<style scoped>
.data-grid-scroller {
  overflow-anchor: none;
}

.data-grid-scroller :deep(.vue-recycle-scroller__item-wrapper) {
  min-width: var(--total-w);
  overflow: visible;
}

.ddl-drawer-resizing {
  transition: none;
}

.cell-selected {
  background-color: color-mix(in oklab, var(--primary) 18%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary) 55%, transparent);
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
