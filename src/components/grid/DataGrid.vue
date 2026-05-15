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
  TableProperties,
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
import type { QueryResult, ColumnInfo, DatabaseType, ForeignKeyInfo, IndexInfo, TriggerInfo } from "@/types/database";
import * as api from "@/lib/api";
import {
  buildTableSelectSql,
  qualifiedTableName,
  normalizeWhereInput,
  quoteTableIdentifier,
} from "@/lib/tableSelectSql";
import {
  canEditExistingTableRows,
  hiveTablePropertiesIndicateTransactional,
  isHiddenGridColumn,
  usesSyntheticRowIdKey,
} from "@/lib/tableEditing";
import { formatGridSqlLiteral } from "@/lib/dataGridSql";
import { matchesRowStatusFilter, type RowStatus, type RowStatusFilter } from "@/lib/gridRowStatus";
import { displayCellValue, type CellValue } from "@/lib/cellValue";
import { isCancelSearchShortcut, isFocusSearchShortcut } from "@/lib/keyboardShortcuts";
import { dataGridHeaderContentWidth, scrollbarGutterWidth } from "@/lib/dataGridScrollGutter";

import { useToast } from "@/composables/useToast";
import { useDataGridExport } from "@/composables/useDataGridExport";
import { useDataGridColumnResize } from "@/composables/useDataGridColumnResize";
import { useDataGridSelection } from "@/composables/useDataGridSelection";
import { useDataGridEditor } from "@/composables/useDataGridEditor";
import { useSettingsStore } from "@/stores/settingsStore";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { toast } = useToast();

const props = defineProps<{
  result: QueryResult;
  sql?: string;
  editable?: boolean;
  databaseType?: DatabaseType;
  connectionId?: string;
  database?: string;
  context?: "results" | "table-data";
  initialWhereInput?: string;
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
const transposePanelWidth = ref(320);
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

const orderBySuggestions = ref<string[]>([]);
const orderBySuggestionIndex = ref(-1);
const orderByInputRef = ref<HTMLInputElement>();
const orderByMeasureRef = ref<HTMLSpanElement>();
const orderBySuggestionLeft = ref(0);

const orderByInput = ref("");
const hasOrderByInput = computed(() => orderByInput.value.trim().length > 0);
const whereFilterInput = ref(props.initialWhereInput ?? "");
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
const visibleColumnIndexes = computed(() =>
  props.result.columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => !isHiddenGridColumn(props.databaseType, column, props.tableMeta?.primaryKeys ?? []))
    .map(({ index }) => index),
);
const visibleColumns = computed(() => visibleColumnIndexes.value.map((index) => props.result.columns[index]));
const visibleRows = computed(() =>
  props.result.rows.map((row) => visibleColumnIndexes.value.map((index) => row[index])),
);
const firstVisibleColumnIndex = computed(() => visibleColumnIndexes.value[0] ?? 0);
function actualColumnIndex(visibleColumnIndex: number): number {
  return visibleColumnIndexes.value[visibleColumnIndex] ?? visibleColumnIndex;
}

// --- Column resize composable ---
const { initColumnWidths, onResizeStart, autoFitColumn, columnVars, getIsResizing } = useDataGridColumnResize({
  columns: visibleColumns,
  rows: visibleRows,
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
watch(
  () => props.result,
  () => {
    localColumnFilters.value = {};
    closeLocalFilter();
  },
);

// --- Pagination ---
const pageSize = ref(settingsStore.editorSettings.pageSize);
const currentPage = ref(1);
const isFullPage = computed(() => props.result.rows.length >= pageSize.value);
const isResultsContext = computed(() => props.context === "results");
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
    const table = qualifiedTableName({
      databaseType: "hive",
      schema: props.tableMeta.schema,
      tableName: props.tableMeta.tableName,
    });
    try {
      const result = await api.executeQuery(
        props.connectionId,
        props.database,
        `SHOW TBLPROPERTIES ${table} ('transactional')`,
        props.tableMeta.schema,
      );
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
  return whereFilterInput.value.trim() || undefined;
}

function currentOrderBy(): string | undefined {
  return (
    orderByInput.value.trim() ||
    (sortCol.value ? `${queryColumnRef(sortCol.value)} ${sortDir.value.toUpperCase()}` : undefined)
  );
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
  if (!isFullPage.value) return;
  currentPage.value++;
  resetGridVerticalScroll(true);
  emit("paginate", (currentPage.value - 1) * pageSize.value, pageSize.value, currentWhereInput(), currentOrderBy());
}
function changePageSize(size: number) {
  pageSize.value = size;
  settingsStore.updateEditorSettings({ pageSize: size });
  currentPage.value = 1;
  resetGridVerticalScroll(true);
  emit("paginate", 0, size, currentWhereInput(), currentOrderBy());
}

async function lastPage() {
  if (!props.connectionId || !props.tableMeta) return;
  const table = qualifiedTableName({
    databaseType: props.databaseType,
    schema: props.tableMeta.schema,
    tableName: props.tableMeta.tableName,
  });
  const predicate = normalizeWhereInput(currentWhereInput());
  const where = predicate ? ` WHERE (${predicate})` : "";
  const sql = `SELECT COUNT(*) AS cnt FROM ${table}${where}`;
  try {
    const result = await api.executeQuery(props.connectionId, props.database ?? "", sql, props.tableMeta.schema);
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
  resetGridVerticalScroll,
  getResetScrollAfterResult,
  clearResetScrollAfterResult,
  cleanupFrames,
} = editor;

function canEditRowItem(item: RowItem | undefined): boolean {
  return !!props.editable && !!item && !item.isDeleted && (item.isNew || canEditExistingRows.value);
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
    orderByInput.value.trim() || undefined,
    pageSize.value,
    (currentPage.value - 1) * pageSize.value,
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
    pageSize.value,
    (currentPage.value - 1) * pageSize.value,
  );
}

const sortedRows = computed(() => {
  let indices = localFilteredRows.value;
  const q = deferredClientSearchText.value;
  if (q) {
    const rows = props.result.rows;
    indices = indices.filter((sourceIndex) => {
      const data = rows[sourceIndex];
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
      if (data[c] !== null && String(data[c]).toLowerCase().includes(q)) {
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
  finishCellSelection,
  extendCellSelection,
  cellIsSelected,
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
const activeCellDetail = computed(() => {
  const cell = detailCell.value;
  if (!cell) return null;
  const item = displayItems.value[cell.rowIndex];
  const column = props.result.columns[cell.col];
  if (!item || !column) return null;
  const value = item.data[cell.col] ?? null;
  const rawValue = displayCellValue(value);
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
    isEditable: canEditRowItem(item),
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
  if (!canEditExistingRows.value) return;
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

type FilterMode =
  | "equals"
  | "not-equals"
  | "is-null"
  | "is-not-null"
  | "like"
  | "not-like"
  | "less-than"
  | "greater-than";

function contextFilterCondition(mode: FilterMode): string | null {
  if (!contextColumn.value) return null;
  const column = queryColumnRef(contextColumn.value);
  const value = contextCellValue.value;

  if (mode === "is-null") return `${column} IS NULL`;
  if (mode === "is-not-null") return `${column} IS NOT NULL`;
  if (value === null) return mode === "equals" ? `${column} IS NULL` : `${column} IS NOT NULL`;
  if (mode === "like") return `${column} LIKE ${escapeVal(`%${value}%`)}`;
  if (mode === "not-like") return `${column} NOT LIKE ${escapeVal(`%${value}%`)}`;
  if (mode === "less-than") return `${column} < ${escapeVal(value)}`;
  if (mode === "greater-than") return `${column} > ${escapeVal(value)}`;
  return mode === "equals" ? `${column} = ${escapeVal(value)}` : `${column} <> ${escapeVal(value)}`;
}

async function applyContextFilter(mode: FilterMode) {
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
      columns: props.tableMeta.columns.map((column) => column.name),
      primaryKeys: props.tableMeta.primaryKeys,
      orderBy: orderByClause,
      limit: pageSize.value,
      whereInput: whereFilterInput.value.trim() || undefined,
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
    const sql = buildTableSelectSql({
      databaseType: props.databaseType,
      schema: props.tableMeta.schema,
      tableName: props.tableMeta.tableName,
      columns: props.tableMeta.columns.map((column) => column.name),
      primaryKeys: props.tableMeta.primaryKeys,
      orderBy:
        orderByInput.value.trim() ||
        (sortCol.value ? `${queryColumnRef(sortCol.value)} ${sortDir.value.toUpperCase()}` : undefined),
      limit: pageSize.value,
      whereInput: whereFilterInput.value.trim() || undefined,
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

function formatCell(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  return s.length > CELL_DISPLAY_MAX_LENGTH ? s.slice(0, CELL_DISPLAY_MAX_LENGTH) : s;
}

function quoteIdent(name: string): string {
  return quoteTableIdentifier(props.databaseType, name);
}

function queryColumnRef(name: string): string {
  const quoted = quoteIdent(name);
  return props.databaseType === "neo4j" ? `n.${quoted}` : quoted;
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
  columns: visibleColumns,
  displayItems: visibleDisplayItems,
  sql: computed(() => props.sql),
  tableMeta: computed(() =>
    props.tableMeta ? { schema: props.tableMeta.schema, tableName: props.tableMeta.tableName } : undefined,
  ),
  databaseType: computed(() => props.databaseType),
  hasCellSelection,
  selectedCells,
  selectedRange,
  contextCell: exportContextCell,
  getRowItem: (rowId: number) => visibleDisplayItems.value.find((item) => item.id === rowId),
  quoteIdent,
  escapeVal,
  selectedRowIds,
  hasRowSelection,
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

async function onGridKeydown(event: KeyboardEvent) {
  if (isFocusSearchShortcut(event)) {
    event.preventDefault();
    focusSearch();
    return;
  }
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
  const detail = activeCellDetail.value;
  if (!detail) return;
  const text = detail.value === null ? "" : displayCellValue(detail.value);
  copyText(text);
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
  return visibleColumnIndexes.value.map((columnIndex) => {
    const col = props.result.columns[columnIndex];
    return {
      column: col,
      type: columnTypeMap.value.get(col) || "",
      value: item.data[columnIndex],
      display: formatCell(item.data[columnIndex]),
      isNull: item.data[columnIndex] === null,
    };
  });
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

function onTransposeResizeStart(e: MouseEvent) {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = transposePanelWidth.value;
  const onMove = (ev: MouseEvent) => {
    transposePanelWidth.value = Math.max(200, startWidth - (ev.clientX - startX));
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

watch(
  () => props.result,
  () => {
    if (getResetScrollAfterResult()) {
      clearResetScrollAfterResult();
      resetGridVerticalScroll();
    }
    clearCellSelection();
    clearRowSelection();
    showCellDetail.value = false;
    detailCell.value = null;
    showTranspose.value = false;
    transposeRowIndex.value = null;
    exitTransaction();
  },
);

// --- Context menu handlers ---
function onCellContext(rowId: number, rowIndex: number, colIdx: number, visibleColIdx: number) {
  contextCell.value = { rowId, rowIndex, col: colIdx };
  if (hasRowSelection.value && isRowSelected(rowId)) {
    return;
  }
  clearRowSelection();
  if (!cellIsSelected(rowIndex, visibleColIdx)) {
    selectSingleCell(rowIndex, visibleColIdx);
  }
}

function onRowContext(rowId: number, rowIndex: number) {
  contextCell.value = { rowId, rowIndex, col: -1 };
  if (!isRowSelected(rowId)) {
    clearCellSelection();
    selectedRowIds.value = new Set([rowId]);
    selection.lastClickedRowIndex.value = rowIndex;
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

const ddlDrawerStyle = computed(() => ({
  width: `${ddlWidth.value}px`,
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
  showDdl: showTableInfo,
  toggleDdl: toggleTableInfo,
  showTableInfo,
  toggleTableInfo,
  focusSearch,
});
</script>

<template>
  <div
    ref="gridRef"
    class="h-full flex flex-col overflow-hidden outline-none"
    :style="gridStyle"
    tabindex="0"
    @keydown="onGridKeydown"
  >
    <ContextMenu>
      <ContextMenuTrigger as-child>
        <div v-if="hasData || canUseWhereSearch" class="flex-1 flex flex-col overflow-hidden">
          <!-- Search bar -->
          <div class="flex items-stretch border-b shrink-0 bg-muted/20 relative">
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
              <div class="flex-1 flex items-center gap-1 px-2 py-0.5 border-l min-w-0 relative">
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
              <div class="flex-1 flex items-center gap-1 px-2 py-0.5 border-l border-r min-w-0 relative">
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

            <slot name="search-bar" />

            <div class="flex shrink-0 items-center gap-1 px-1 ml-auto">
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
              <!-- Sticky header -->
              <div
                ref="headerRef"
                class="shrink-0 bg-[rgb(239_239_239)] dark:bg-muted/60 z-10 border-y border-border overflow-hidden"
              >
                <div class="flex text-xs font-semibold text-foreground" :style="{ width: 'var(--header-total-w)' }">
                  <div
                    class="shrink-0 px-2 py-1.5 border-r border-border text-center text-muted-foreground select-none"
                    :style="{ width: 'var(--row-num-w)' }"
                  >
                    #
                  </div>
                  <Tooltip v-for="(col, colIdx) in visibleColumns" :key="`${col}-${actualColumnIndex(colIdx)}`">
                    <TooltipTrigger as-child>
                      <div
                        class="shrink-0 px-2 py-1.5 border-r border-border whitespace-nowrap hover:bg-accent/60 select-none relative overflow-hidden"
                        :style="{ width: `var(--col-w-${colIdx})` }"
                      >
                        <span class="flex min-w-0 items-center gap-1 overflow-hidden">
                          <span
                            class="min-w-0 flex-1 truncate cursor-pointer"
                            @click="toggleSort(col, actualColumnIndex(colIdx))"
                          >
                            {{ col }}
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
                          <Popover
                            :open="localFilterOpenColumn === actualColumnIndex(colIdx)"
                            @update:open="
                              (value: boolean) =>
                                value ? openLocalFilter(actualColumnIndex(colIdx)) : closeLocalFilter()
                            "
                          >
                            <PopoverTrigger as-child>
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
                                  @click="clearLocalFilter(actualColumnIndex(colIdx))"
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
                <template #default="{ item, index }">
                  <div
                    class="flex text-xs border-b border-border"
                    :class="{
                      'bg-destructive/5 opacity-70': item.isDeleted,
                      'bg-primary/5': item.isNew && !isRowActive(index),
                      'bg-muted/30': !item.isNew && !item.isDeleted && !isRowActive(index) && index % 2 === 1,
                      'active-row': isRowActive(index) && !item.isDeleted,
                    }"
                    :style="{ height: '26px', width: 'var(--total-w)' }"
                    :data-row-index="index"
                  >
                    <div
                      class="shrink-0 px-2 py-1 border-r border-border text-center select-none cursor-default hover:bg-accent/50"
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
                      @click="handleRowClick(index, item.id, $event)"
                      @contextmenu="onRowContext(item.id, index)"
                    >
                      {{ index + 1 }}
                    </div>
                    <div
                      v-for="(actualColIdx, visibleColIdx) in visibleColumnIndexes"
                      :key="actualColIdx"
                      class="group/cell shrink-0 px-3 py-1 border-r border-border whitespace-nowrap overflow-hidden text-ellipsis relative select-none"
                      :style="{ width: `var(--col-w-${visibleColIdx})` }"
                      :class="{
                        'text-muted-foreground italic': isNull(item.data[actualColIdx]),
                        'bg-yellow-500/10 cell-dirty': item.isDirtyCol[actualColIdx],
                        'cell-selected': cellIsSelected(index, visibleColIdx) && !item.isDirtyCol[actualColIdx],
                        'cell-selected-dirty': cellIsSelected(index, visibleColIdx) && item.isDirtyCol[actualColIdx],
                        'bg-yellow-200/60 dark:bg-yellow-500/20': cellIsSearchMatch(index, actualColIdx),
                        'ring-2 ring-inset ring-yellow-500 bg-yellow-300/60 dark:bg-yellow-500/40': cellIsCurrentMatch(
                          index,
                          actualColIdx,
                        ),
                        'tabular-nums': typeof item.data[actualColIdx] === 'number',
                        'cursor-text hover:bg-accent/50': canEditRowItem(item),
                        'line-through': item.isDeleted,
                      }"
                      @mousedown="handleDataCellMousedown(index, visibleColIdx, item.id, $event)"
                      @mouseenter="extendCellSelection(index, visibleColIdx)"
                      @dblclick="canEditRowItem(item) && startEdit(item.id, actualColIdx)"
                      @contextmenu="onCellContext(item.id, index, actualColIdx, visibleColIdx)"
                    >
                      <template v-if="editingCell?.rowId === item.id && editingCell?.col === actualColIdx">
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
                        {{ formatCell(item.data[actualColIdx]) }}
                        <button
                          class="absolute right-0.5 top-0.5 hidden h-5 w-5 items-center justify-center rounded bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border hover:text-foreground group-hover/cell:flex"
                          :title="t('grid.cellDetails')"
                          @mousedown.stop
                          @click.stop="showCellDetails(index, actualColIdx)"
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
                <Button
                  v-if="activeTableInfoTab === 'ddl'"
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5"
                  @click="copyDdl"
                >
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

              <div v-if="activeTableInfoTab === 'columns'" class="flex-1 min-h-0 overflow-auto">
                <table class="w-full text-xs">
                  <thead class="sticky top-0 bg-muted/80 backdrop-blur text-muted-foreground">
                    <tr class="border-b">
                      <th class="text-left font-medium px-3 py-2">{{ t("grid.columnName") }}</th>
                      <th class="text-left font-medium px-3 py-2">{{ t("grid.columnType") }}</th>
                      <th class="text-left font-medium px-3 py-2">{{ t("grid.tableInfoNullable") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="column in tableMeta?.columns" :key="column.name" class="border-b hover:bg-muted/30">
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
                <div v-else-if="indexes.length === 0" class="p-6 text-center text-xs text-muted-foreground">
                  {{ t("grid.tableInfoEmpty") }}
                </div>
                <div v-else class="divide-y">
                  <div v-for="index in indexes" :key="index.name" class="p-3 text-xs">
                    <div class="font-medium truncate">{{ index.name }}</div>
                    <div class="mt-1 flex flex-wrap gap-1">
                      <span v-if="index.is_primary" class="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600"
                        >PK</span
                      >
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
                <div v-else-if="foreignKeys.length === 0" class="p-6 text-center text-xs text-muted-foreground">
                  {{ t("grid.tableInfoEmpty") }}
                </div>
                <div v-else class="divide-y">
                  <div v-for="fk in foreignKeys" :key="`${fk.name}:${fk.column}`" class="p-3 text-xs">
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
                <div v-else-if="triggers.length === 0" class="p-6 text-center text-xs text-muted-foreground">
                  {{ t("grid.tableInfoEmpty") }}
                </div>
                <div v-else class="divide-y">
                  <div v-for="trigger in triggers" :key="trigger.name" class="p-3 text-xs">
                    <div class="font-medium truncate">{{ trigger.name }}</div>
                    <div class="mt-1 text-[11px] text-muted-foreground">{{ trigger.timing }} {{ trigger.event }}</div>
                  </div>
                </div>
              </div>

              <pre
                v-else-if="activeTableInfoTab === 'ddl' && !ddlLoading"
                class="flex-1 min-w-0 text-xs font-mono p-3 overflow-auto ddl-code leading-5 select-text"
                :class="ddlWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
                v-html="highlightSql(ddlContent)"
              ></pre>
              <div v-else class="flex-1 flex items-center justify-center">
                <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
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
                  >
        {{ activeCellDetail.formattedJson }}</pre
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
              class="relative shrink-0 border-l flex flex-col bg-background min-w-0"
              :style="{ width: transposePanelWidth + 'px' }"
            >
              <div
                class="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-20 hover:bg-primary/30 active:bg-primary/50"
                @mousedown="onTransposeResizeStart"
              />
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
              <ContextMenuItem @click="applyContextFilter('like')">{{ t("grid.filterLike") }}</ContextMenuItem>
              <ContextMenuItem @click="applyContextFilter('not-like')">{{ t("grid.filterNotLike") }}</ContextMenuItem>
              <ContextMenuItem @click="applyContextFilter('less-than')">{{ t("grid.filterLessThan") }}</ContextMenuItem>
              <ContextMenuItem @click="applyContextFilter('greater-than')">
                {{ t("grid.filterGreaterThan") }}
              </ContextMenuItem>
              <ContextMenuSeparator />
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
            <ContextMenuItem @click="copyRow">
              {{ isMultiRow ? t("grid.copyRows", { count: multiRowCount }) : t("grid.copyRow") }}
            </ContextMenuItem>
            <ContextMenuItem @click="copyRowAsInsert">
              {{ isMultiRow ? t("grid.copyRowsInsert", { count: multiRowCount }) : t("grid.copyRowInsert") }}
            </ContextMenuItem>
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
          <ContextMenuItem @click="isMultiRow ? cloneRows(affectedRowIds()) : cloneRow(contextRowItem.id)">
            <CopyPlus class="w-3.5 h-3.5 mr-2" />
            {{ isMultiRow ? t("grid.cloneRows", { count: multiRowCount }) : t("grid.cloneRow") }}
          </ContextMenuItem>
          <ContextMenuItem
            v-if="contextRowItem.isDeleted"
            @click="isMultiRow ? restoreRows(affectedRowIds()) : restoreRow(contextRowItem.id)"
          >
            <Undo2 class="w-3.5 h-3.5 mr-2" />
            {{ isMultiRow ? t("grid.restoreRows", { count: multiRowCount }) : t("grid.restoreRow") }}
          </ContextMenuItem>
          <ContextMenuItem
            v-else-if="canDeleteRowItem(contextRowItem)"
            class="text-destructive"
            @click="isMultiRow ? requestDeleteRows(affectedRowIds()) : requestDeleteRow(contextRowItem.id)"
          >
            <Trash2 class="w-3.5 h-3.5 mr-2" />
            {{ isMultiRow ? t("grid.deleteRows", { count: multiRowCount }) : t("grid.deleteRow") }}
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
            <template v-if="isMultiRow">
              <ContextMenuSeparator />
              <ContextMenuItem @click="exportSelectedRowsCsv">{{ t("grid.exportSelectedRowsCsv") }}</ContextMenuItem>
              <ContextMenuItem @click="exportSelectedRowsXlsx">{{ t("grid.exportSelectedRowsXlsx") }}</ContextMenuItem>
              <ContextMenuItem @click="exportSelectedRowsJson">{{ t("grid.exportSelectedRowsJson") }}</ContextMenuItem>
              <ContextMenuItem @click="exportSelectedRowsMarkdown">{{
                t("grid.exportSelectedRowsMarkdown")
              }}</ContextMenuItem>
            </template>
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
      <span v-if="selectedRowCount > 0 || hasCellSelection" class="text-foreground">{{ selectionSummary }}</span>

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
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="currentPage <= 1" @click="firstPage">
          <ChevronsLeft class="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="currentPage <= 1" @click="prevPage">
          <ChevronLeft class="h-3 w-3" />
        </Button>
        <span>{{ currentPage }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!isFullPage" @click="nextPage">
          <ChevronRight class="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!isFullPage" @click="lastPage">
          <ChevronsRight class="h-3 w-3" />
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
          <template v-if="isMultiRow">
            <ContextMenuSeparator />
            <DropdownMenuItem @click="exportSelectedRowsCsv">{{ t("grid.exportSelectedRowsCsv") }}</DropdownMenuItem>
            <DropdownMenuItem @click="exportSelectedRowsXlsx">{{ t("grid.exportSelectedRowsXlsx") }}</DropdownMenuItem>
            <DropdownMenuItem @click="exportSelectedRowsJson">{{ t("grid.exportSelectedRowsJson") }}</DropdownMenuItem>
            <DropdownMenuItem @click="exportSelectedRowsMarkdown">{{
              t("grid.exportSelectedRowsMarkdown")
            }}</DropdownMenuItem>
          </template>
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
  </div>
</template>

<style scoped>
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

.ddl-drawer-resizing {
  transition: none;
}

.cell-selected {
  background-color: color-mix(in oklab, var(--primary) 25%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--primary) 70%, transparent);
}

.cell-selected-dirty {
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
