import { computed, onUnmounted, watch, type ComputedRef, type Ref } from "vue";
import * as api from "@/lib/backend/api";
import { buildColumnValueFilterCondition, buildColumnValuesFilterCondition, parseFilterValue, removeColumnValueFilterCondition, replaceColumnValueFilterCondition, appendColumnValueFilterCondition } from "@/lib/dataGrid/dataGridColumnFilter";
import { buildDataGridColumnDistinctValuesSql } from "@/lib/dataGrid/dataGridSql";
import { buildDataGridLocalFilterOptions, dataGridLocalFilterKey, dataGridLocalFilterLabel, rowMatchesDataGridLocalColumnFilters, type DataGridLocalFilterOption } from "@/lib/dataGrid/dataGridLocalColumnFilterState";
import type { DataGridCachedServerColumnFilter } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { ColumnInfo, DatabaseType, QueryResult } from "@/types/database";

export type DataGridLocalFilterMode = "local" | "server";

export type DataGridLocalFilterDraft = {
  columnIndex: number;
  values: Set<string>;
  mode: DataGridLocalFilterMode;
  touched: boolean;
};

export interface DataGridColumnFilterState {
  localColumnFilters: Ref<Record<number, Set<string>>>;
  localFilterOpenColumn: Ref<number | null>;
  localFilterSearch: Ref<string>;
  localFilterDraft: Ref<DataGridLocalFilterDraft | null>;
  serverFilterLoading: Ref<boolean>;
  serverFilterError: Ref<string>;
  serverFilterOptions: Ref<DataGridLocalFilterOption[]>;
  serverFilterLimited: Ref<boolean>;
  serverFilterValueByKey: Ref<Map<string, CellValue>>;
  serverColumnFilters: Ref<Record<number, DataGridCachedServerColumnFilter>>;
}

interface TableMetadata {
  catalog?: string;
  database?: string;
  schema?: string;
  tableName: string;
  columns: ColumnInfo[];
}

interface ConnectionConfig {
  driver_profile?: string;
}

export interface UseDataGridColumnFiltersOptions {
  state: DataGridColumnFilterState;
  getResult: () => QueryResult;
  getTableMeta: () => TableMetadata | undefined;
  getConnectionId: () => string | undefined;
  getSchema: () => string | undefined;
  getExecutionDatabase: () => string;
  resolvedDatabaseType: ComputedRef<DatabaseType | undefined>;
  canUseWhereSearch: ComputedRef<boolean>;
  canUseServerColumnFilter: ComputedRef<boolean>;
  structuredFilterCount: ComputedRef<number>;
  hasStructuredFilters: ComputedRef<boolean>;
  whereFilterInput: Ref<string>;
  getConnectionConfig: () => ConnectionConfig | undefined;
  getIdentifierQuote: () => string | undefined;
  getNewRows: () => readonly (readonly CellValue[])[];
  getRowData: (row: CellValue[], sourceIndex: number) => readonly CellValue[];
  formatValue: (value: CellValue, columnIndex: number) => string;
  waitForTableMeta: () => Promise<TableMetadata | null>;
  applyWhereFilter: () => Promise<void>;
  resetGridVerticalScroll: () => void;
  onOpen?: () => void;
  onClose?: () => void;
  emitLocalFiltersChange: (filters: Record<string, string[]>) => void;
}

export const DATA_GRID_SERVER_COLUMN_FILTER_LIMIT = 1000;
const SERVER_COLUMN_FILTER_DEBOUNCE_MS = 300;

export function useDataGridColumnFilters(options: UseDataGridColumnFiltersOptions) {
  const { state } = options;
  let serverFilterRequestId = 0;
  let serverFilterSearchTimer: ReturnType<typeof window.setTimeout> | undefined;

  watch(
    state.localColumnFilters,
    (filters) => {
      options.emitLocalFiltersChange(Object.fromEntries(Object.entries(filters).flatMap(([columnIndex, values]) => (values.size > 0 ? [[columnIndex, [...values]]] : []))));
    },
    { deep: true },
  );

  function localFilterLabel(value: CellValue, columnIndex: number): string {
    return dataGridLocalFilterLabel(value, columnIndex, options.formatValue);
  }

  function buildLocalFilterOptions(columnIndex: number): DataGridLocalFilterOption[] {
    const result = options.getResult();
    return buildDataGridLocalFilterOptions({
      rows: result.rows,
      newRows: options.getNewRows(),
      columnIndex,
      getRowData: options.getRowData,
      formatValue: options.formatValue,
    });
  }

  const localFilterActive = (columnIndex: number) => !!state.localColumnFilters.value[columnIndex]?.size || !!state.serverColumnFilters.value[columnIndex];
  const localFilterCount = computed(() => Object.values(state.localColumnFilters.value).filter((values) => values.size).length);
  const serverColumnFilterCount = computed(() => Object.keys(state.serverColumnFilters.value).length);
  const hasLocalColumnFilters = computed(() => localFilterCount.value > 0);
  const hasServerColumnFilters = computed(() => serverColumnFilterCount.value > 0);
  const filterButtonCount = computed(() => options.structuredFilterCount.value + localFilterCount.value + serverColumnFilterCount.value);
  const filterButtonActive = computed(() => options.hasStructuredFilters.value || hasLocalColumnFilters.value || hasServerColumnFilters.value);
  const localFilterSummaries = computed(() =>
    [
      ...Object.entries(state.localColumnFilters.value)
        .filter(([, selected]) => selected.size > 0)
        .map(([columnIndexText, selected]) => {
          const columnIndex = Number(columnIndexText);
          const labelByKey = new Map(buildLocalFilterOptions(columnIndex).map((option) => [option.key, option.label]));
          return { columnIndex, values: [...selected].map((key) => labelByKey.get(key) ?? key) };
        }),
      ...Object.entries(state.serverColumnFilters.value).map(([columnIndexText, filter]) => ({ columnIndex: Number(columnIndexText), values: filter.labels })),
    ].map(({ columnIndex, values }) => ({
      columnIndex,
      columnName: options.getResult().columns[columnIndex] ?? `#${columnIndex + 1}`,
      values: values.slice(0, 3),
      hiddenValueCount: Math.max(0, values.length - 3),
    })),
  );

  const localFilteredRows = computed(() => {
    const rows = options.getResult().rows;
    if (!hasLocalColumnFilters.value) return rows.map((_, index) => index);
    return rows.flatMap((row, index) => (rowMatchesDataGridLocalColumnFilters(options.getRowData(row, index), state.localColumnFilters.value) ? [index] : []));
  });
  const rowMatchesLocalColumnFilters = (data: CellValue[]) => rowMatchesDataGridLocalColumnFilters(data, state.localColumnFilters.value);

  const localFilterAllOptions = computed(() => {
    if (state.localFilterDraft.value?.mode === "server") return state.serverFilterOptions.value;
    const columnIndex = state.localFilterDraft.value?.columnIndex;
    return columnIndex === undefined ? [] : buildLocalFilterOptions(columnIndex);
  });
  const localFilterOptions = computed(() => {
    if (state.localFilterDraft.value?.mode === "server") return state.serverFilterOptions.value;
    const query = state.localFilterSearch.value.trim().toLowerCase();
    return localFilterAllOptions.value.filter((option) => !query || option.label.toLowerCase().includes(query)).slice(0, 500);
  });
  const localFilterTypedValue = computed(() => state.localFilterSearch.value.trim());
  const localFilterDraftIsAllSelected = computed(() => {
    const draft = state.localFilterDraft.value;
    const allKeys = localFilterAllOptions.value.map((option) => option.key);
    return !!draft && allKeys.length > 0 && allKeys.every((key) => draft.values.has(key));
  });
  const localFilterAllVisibleSelected = computed(() => {
    const draft = state.localFilterDraft.value;
    return !!draft && localFilterOptions.value.length > 0 && localFilterOptions.value.every((option) => draft.values.has(option.key));
  });
  const canApplyTypedLocalFilterValue = computed(() => {
    const typed = localFilterTypedValue.value;
    if (!state.localFilterDraft.value || !typed || !options.canUseWhereSearch.value) return false;
    const normalized = typed.toLowerCase();
    return !localFilterAllOptions.value.some((option) => option.label.toLowerCase() === normalized);
  });

  function resetServerFilterState() {
    serverFilterRequestId++;
    if (serverFilterSearchTimer !== undefined) {
      window.clearTimeout(serverFilterSearchTimer);
      serverFilterSearchTimer = undefined;
    }
    state.serverFilterLoading.value = false;
    state.serverFilterError.value = "";
    state.serverFilterOptions.value = [];
    state.serverFilterLimited.value = false;
    state.serverFilterValueByKey.value = new Map();
  }

  function openLocalFilter(columnIndex: number, requestedMode: DataGridLocalFilterMode = "local") {
    options.onOpen?.();
    state.localFilterSearch.value = "";
    const mode = requestedMode === "server" && options.canUseServerColumnFilter.value ? "server" : "local";
    const allKeys = mode === "server" ? [] : buildLocalFilterOptions(columnIndex).map((option) => option.key);
    state.localFilterDraft.value = {
      columnIndex,
      values: new Set(mode === "server" ? allKeys : (state.localColumnFilters.value[columnIndex] ?? allKeys)),
      mode,
      touched: false,
    };
    state.localFilterOpenColumn.value = columnIndex;
    resetServerFilterState();
    if (mode === "server") void loadServerFilterValues(columnIndex, "");
  }

  function closeLocalFilter() {
    options.onClose?.();
    state.localFilterOpenColumn.value = null;
    state.localFilterDraft.value = null;
    state.localFilterSearch.value = "";
    resetServerFilterState();
  }

  function serverFilterOptionFromRow(row: QueryResult["rows"][number], columnIndex: number): DataGridLocalFilterOption {
    const value = (row[0] ?? null) as CellValue;
    const countValue = Number(row[1]);
    return { key: dataGridLocalFilterKey(value), label: localFilterLabel(value, columnIndex), count: Number.isFinite(countValue) ? countValue : null, value };
  }

  function serverFilterOptionsFromResult(result: QueryResult, columnIndex: number): DataGridLocalFilterOption[] {
    const byKey = new Map<string, DataGridLocalFilterOption>();
    for (const row of result.rows) {
      const option = serverFilterOptionFromRow(row, columnIndex);
      const current = byKey.get(option.key);
      if (current) current.count = (current.count ?? 0) + (option.count ?? 0);
      else byKey.set(option.key, option);
    }
    return [...byKey.values()];
  }

  function syncServerFilterDraft(columnIndex: number, filterOptions: DataGridLocalFilterOption[]) {
    const draft = state.localFilterDraft.value;
    if (!draft || draft.mode !== "server" || draft.columnIndex !== columnIndex || draft.touched) return;
    const activeFilter = state.serverColumnFilters.value[columnIndex];
    state.localFilterDraft.value = { ...draft, values: new Set(activeFilter?.keys ?? filterOptions.map((option) => option.key)) };
  }

  async function loadServerFilterValues(columnIndex: number, searchValue: string) {
    const connectionId = options.getConnectionId();
    if (!options.canUseServerColumnFilter.value || !connectionId) return;
    const columnName = options.getResult().columns[columnIndex];
    if (!columnName) return;
    const requestId = ++serverFilterRequestId;
    state.serverFilterLoading.value = true;
    state.serverFilterError.value = "";
    state.serverFilterLimited.value = false;
    try {
      const tableMeta = await options.waitForTableMeta();
      if (!tableMeta) return;
      const columnInfo = tableMeta.columns.find((column) => column.name === columnName);
      const sql = await buildDataGridColumnDistinctValuesSql({
        databaseType: options.resolvedDatabaseType.value,
        driverProfile: options.getConnectionConfig()?.driver_profile,
        identifierQuote: options.getIdentifierQuote(),
        catalog: tableMeta.catalog,
        database: tableMeta.database,
        schema: tableMeta.schema,
        tableName: tableMeta.tableName,
        columnName,
        columnInfo,
        searchValue: searchValue.trim() || undefined,
        limit: DATA_GRID_SERVER_COLUMN_FILTER_LIMIT,
        includeCounts: true,
      });
      const result = await api.executeQuery(connectionId, options.getExecutionDatabase(), sql, tableMeta.schema ?? options.getSchema(), undefined, {
        maxRows: DATA_GRID_SERVER_COLUMN_FILTER_LIMIT,
        fetchSize: DATA_GRID_SERVER_COLUMN_FILTER_LIMIT,
        pageSize: DATA_GRID_SERVER_COLUMN_FILTER_LIMIT,
      });
      if (requestId !== serverFilterRequestId || state.localFilterOpenColumn.value !== columnIndex) return;
      const filterOptions = serverFilterOptionsFromResult(result, columnIndex);
      const nextValueByKey = new Map(state.serverFilterValueByKey.value);
      for (const option of filterOptions) nextValueByKey.set(option.key, option.value);
      state.serverFilterValueByKey.value = nextValueByKey;
      state.serverFilterOptions.value = filterOptions;
      state.serverFilterLimited.value = result.truncated === true || result.rows.length >= DATA_GRID_SERVER_COLUMN_FILTER_LIMIT;
      syncServerFilterDraft(columnIndex, filterOptions);
    } catch (error: any) {
      if (requestId !== serverFilterRequestId) return;
      state.serverFilterOptions.value = [];
      state.serverFilterError.value = String(error?.message || error);
    } finally {
      if (requestId === serverFilterRequestId) state.serverFilterLoading.value = false;
    }
  }

  watch(state.localFilterSearch, (value) => {
    const draft = state.localFilterDraft.value;
    if (!draft || draft.mode !== "server" || state.localFilterOpenColumn.value !== draft.columnIndex) return;
    if (serverFilterSearchTimer !== undefined) window.clearTimeout(serverFilterSearchTimer);
    serverFilterSearchTimer = window.setTimeout(() => void loadServerFilterValues(draft.columnIndex, value), SERVER_COLUMN_FILTER_DEBOUNCE_MS);
  });

  onUnmounted(resetServerFilterState);

  function toggleLocalFilterValue(key: string) {
    const draft = state.localFilterDraft.value;
    if (!draft) return;
    const values = new Set(draft.values);
    if (values.has(key)) values.delete(key);
    else values.add(key);
    state.localFilterDraft.value = { ...draft, values, touched: true };
  }

  function toggleAllLocalFilterOptions() {
    const draft = state.localFilterDraft.value;
    if (!draft) return;
    const visibleKeys = localFilterOptions.value.map((option) => option.key);
    const values = new Set(draft.values);
    if (localFilterAllVisibleSelected.value) visibleKeys.forEach((key) => values.delete(key));
    else visibleKeys.forEach((key) => values.add(key));
    state.localFilterDraft.value = { ...draft, values, touched: true };
  }

  async function applyLocalFilter() {
    const draft = state.localFilterDraft.value;
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
    const selected = state.localFilterSearch.value.trim() ? new Set([...draft.values].filter((key) => localFilterOptions.value.some((option) => option.key === key))) : draft.values;
    const next = { ...state.localColumnFilters.value };
    if (selected.size === 0 || selected.size === allKeys.size) delete next[draft.columnIndex];
    else next[draft.columnIndex] = new Set(selected);
    state.localColumnFilters.value = next;
    closeLocalFilter();
    options.resetGridVerticalScroll();
  }

  async function applyServerColumnFilter(draft: DataGridLocalFilterDraft) {
    if (!draft.touched && !state.localFilterSearch.value.trim()) {
      closeLocalFilter();
      return;
    }
    if (canApplyTypedLocalFilterValue.value && state.serverFilterOptions.value.length === 0) {
      await applyTypedLocalFilterValue();
      return;
    }
    const columnName = options.getResult().columns[draft.columnIndex];
    if (!columnName) return;
    const values = [...draft.values].flatMap((key) => (state.serverFilterValueByKey.value.has(key) ? [state.serverFilterValueByKey.value.get(key)!] : []));
    if (values.length === 0) {
      closeLocalFilter();
      return;
    }
    const condition = await buildColumnValuesFilterCondition({
      databaseType: options.resolvedDatabaseType.value,
      identifierQuote: options.getIdentifierQuote(),
      columnName,
      columnInfo: options.getTableMeta()?.columns.find((column) => column.name === columnName),
      values,
    });
    if (!condition) return;
    const next = { ...state.localColumnFilters.value };
    delete next[draft.columnIndex];
    state.localColumnFilters.value = next;
    const previousCondition = state.serverColumnFilters.value[draft.columnIndex]?.condition;
    options.whereFilterInput.value = replaceColumnValueFilterCondition(options.whereFilterInput.value, previousCondition, condition);
    state.serverColumnFilters.value = {
      ...state.serverColumnFilters.value,
      [draft.columnIndex]: { condition, keys: [...draft.values], labels: values.map((value) => localFilterLabel(value, draft.columnIndex)) },
    };
    closeLocalFilter();
    await options.applyWhereFilter();
  }

  async function applyTypedLocalFilterValue() {
    const draft = state.localFilterDraft.value;
    if (!draft) return;
    const columnName = options.getResult().columns[draft.columnIndex];
    if (!columnName) return;
    const columnInfo = options.getTableMeta()?.columns.find((column) => column.name === columnName);
    const condition = await buildColumnValueFilterCondition({
      databaseType: options.resolvedDatabaseType.value,
      identifierQuote: options.getIdentifierQuote(),
      columnName,
      columnInfo,
      rawValue: localFilterTypedValue.value,
    });
    if (!condition) return;
    const next = { ...state.localColumnFilters.value };
    delete next[draft.columnIndex];
    state.localColumnFilters.value = next;
    if (draft.mode === "server") {
      const previousCondition = state.serverColumnFilters.value[draft.columnIndex]?.condition;
      const rawValue = localFilterTypedValue.value.trim();
      const value = (/^null$/i.test(rawValue) ? null : parseFilterValue(rawValue, columnInfo, options.resolvedDatabaseType.value)) as CellValue;
      options.whereFilterInput.value = replaceColumnValueFilterCondition(options.whereFilterInput.value, previousCondition, condition);
      state.serverColumnFilters.value = {
        ...state.serverColumnFilters.value,
        [draft.columnIndex]: { condition, keys: [dataGridLocalFilterKey(value)], labels: [localFilterLabel(value, draft.columnIndex)] },
      };
    } else {
      options.whereFilterInput.value = appendColumnValueFilterCondition(options.whereFilterInput.value, condition);
    }
    closeLocalFilter();
    await options.applyWhereFilter();
  }

  function clearLocalFilter(columnIndex?: number, applyServerWhereFilter = true) {
    let removedServerFilter = false;
    if (columnIndex === undefined) {
      state.localColumnFilters.value = {};
      let nextWhereInput = options.whereFilterInput.value;
      for (const filter of Object.values(state.serverColumnFilters.value)) nextWhereInput = removeColumnValueFilterCondition(nextWhereInput, filter.condition);
      removedServerFilter = Object.keys(state.serverColumnFilters.value).length > 0;
      state.serverColumnFilters.value = {};
      options.whereFilterInput.value = nextWhereInput;
    } else {
      const next = { ...state.localColumnFilters.value };
      delete next[columnIndex];
      state.localColumnFilters.value = next;
      const serverFilter = state.serverColumnFilters.value[columnIndex];
      if (serverFilter) {
        removedServerFilter = true;
        const nextServerFilters = { ...state.serverColumnFilters.value };
        delete nextServerFilters[columnIndex];
        state.serverColumnFilters.value = nextServerFilters;
        options.whereFilterInput.value = removeColumnValueFilterCondition(options.whereFilterInput.value, serverFilter.condition);
      }
    }
    closeLocalFilter();
    options.resetGridVerticalScroll();
    if (removedServerFilter && applyServerWhereFilter && options.canUseWhereSearch.value) void options.applyWhereFilter();
  }

  return {
    localFilterActive,
    localFilterCount,
    serverColumnFilterCount,
    hasLocalColumnFilters,
    hasServerColumnFilters,
    filterButtonCount,
    filterButtonActive,
    localFilterSummaries,
    localFilteredRows,
    rowMatchesLocalColumnFilters,
    localFilterAllOptions,
    localFilterOptions,
    localFilterTypedValue,
    canApplyTypedLocalFilterValue,
    openLocalFilter,
    closeLocalFilter,
    toggleLocalFilterValue,
    toggleAllLocalFilterOptions,
    applyLocalFilter,
    applyTypedLocalFilterValue,
    clearLocalFilter,
  };
}
