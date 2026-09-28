import { computed, ref, watch, type ComputedRef, type Ref } from "vue";
import { buildColumnValueFilterCondition, buildColumnValuesFilterCondition, parseFilterValue, removeColumnValueFilterCondition, replaceColumnValueFilterCondition, appendColumnValueFilterCondition } from "@/lib/dataGrid/dataGridColumnFilter";
import { buildDataGridLocalFilterOptions, sortDataGridLocalFilterOptions, type DataGridLocalFilterSort, dataGridLocalFilterKey, dataGridLocalFilterLabel, rowMatchesDataGridLocalColumnFilters, type DataGridLocalFilterOption } from "@/lib/dataGrid/dataGridLocalColumnFilterState";
import type { DataGridCachedServerColumnFilter } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import { DATA_GRID_DISTINCT_VALUE_DEFAULT_LIMIT, useDataGridDistinctValueLoader } from "@/composables/useDataGridDistinctValueLoader";
import type { ColumnInfo, ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";

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
  serverColumnFilters: Ref<Record<number, DataGridCachedServerColumnFilter>>;
}

interface TableMetadata {
  catalog?: string;
  database?: string;
  schema?: string;
  tableName: string;
  columns: ColumnInfo[];
}

export interface UseDataGridColumnFiltersOptions {
  state: DataGridColumnFilterState;
  getResult: () => QueryResult;
  getTableMeta: () => TableMetadata | undefined;
  getConnectionId: () => string | undefined;
  getSchema: () => string | undefined;
  getExecutionDatabase: () => string;
  scopeIdentity: ComputedRef<string>;
  resolvedDatabaseType: ComputedRef<DatabaseType | undefined>;
  canUseWhereSearch: ComputedRef<boolean>;
  canUseServerColumnFilter: ComputedRef<boolean>;
  structuredFilterCount: ComputedRef<number>;
  hasStructuredFilters: ComputedRef<boolean>;
  whereFilterInput: Ref<string>;
  getConnectionConfig: () => Pick<ConnectionConfig, "driver_profile" | "query_timeout_secs" | "query_timeout_inherit"> | undefined;
  getIdentifierQuote: () => string | undefined;
  getGlobalQueryTimeoutSecs: () => number | undefined;
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

export const DATA_GRID_SERVER_COLUMN_FILTER_LIMIT = DATA_GRID_DISTINCT_VALUE_DEFAULT_LIMIT;

export function useDataGridColumnFilters(options: UseDataGridColumnFiltersOptions) {
  const { state } = options;
  const localFilterSort = ref<DataGridLocalFilterSort>({ field: "value", direction: "asc" });
  const distinctValueLoader = useDataGridDistinctValueLoader({
    scopeIdentity: options.scopeIdentity,
    getConnectionId: options.getConnectionId,
    getExecutionDatabase: options.getExecutionDatabase,
    getSchema: options.getSchema,
    getDatabaseType: () => options.resolvedDatabaseType.value,
    getConnectionConfig: options.getConnectionConfig,
    getIdentifierQuote: options.getIdentifierQuote,
    getGlobalQueryTimeoutSecs: options.getGlobalQueryTimeoutSecs,
    waitForTableMeta: options.waitForTableMeta,
    formatValue: options.formatValue,
  });
  const serverFilterLoading = distinctValueLoader.loading;
  const serverFilterError = distinctValueLoader.error;
  const serverFilterOptions = distinctValueLoader.options;
  const serverFilterLimited = distinctValueLoader.limited;
  const serverFilterValueByKey = distinctValueLoader.valueByKey;

  function toggleLocalFilterSort(field: DataGridLocalFilterSort["field"]) {
    if (state.localFilterDraft.value?.mode !== "local") return;
    const current = localFilterSort.value;
    localFilterSort.value = {
      field,
      direction: current.field === field ? (current.direction === "asc" ? "desc" : "asc") : field === "count" ? "desc" : "asc",
    };
  }

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
    if (state.localFilterDraft.value?.mode === "server") return serverFilterOptions.value;
    const columnIndex = state.localFilterDraft.value?.columnIndex;
    return columnIndex === undefined ? [] : buildLocalFilterOptions(columnIndex);
  });
  const localFilterOptions = computed(() => {
    if (state.localFilterDraft.value?.mode === "server") return serverFilterOptions.value;
    const query = state.localFilterSearch.value.trim().toLowerCase();
    const matchingOptions = localFilterAllOptions.value.filter((option) => !query || option.label.toLowerCase().includes(query));
    // Sort before limiting so frequent values outside the default first 500 remain discoverable.
    // buildDataGridLocalFilterOptions already returns value-ascending options, so the default
    // sort state skips the re-sort instead of re-running it on every search keystroke.
    const sort = localFilterSort.value;
    const sorted = sort.field === "value" && sort.direction === "asc" ? matchingOptions : sortDataGridLocalFilterOptions(matchingOptions, sort);
    return sorted.slice(0, 500);
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

  function openLocalFilter(columnIndex: number, requestedMode: DataGridLocalFilterMode = "local") {
    options.onOpen?.();
    localFilterSort.value = { field: "value", direction: "asc" };
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
    distinctValueLoader.reset();
    if (mode === "server") void loadServerFilterValues(columnIndex, "");
  }

  function closeLocalFilter() {
    options.onClose?.();
    state.localFilterOpenColumn.value = null;
    state.localFilterDraft.value = null;
    state.localFilterSearch.value = "";
    distinctValueLoader.reset();
  }

  function syncServerFilterDraft(columnIndex: number, filterOptions: DataGridLocalFilterOption[]) {
    const draft = state.localFilterDraft.value;
    if (!draft || draft.mode !== "server" || draft.columnIndex !== columnIndex || draft.touched) return;
    const activeFilter = state.serverColumnFilters.value[columnIndex];
    state.localFilterDraft.value = { ...draft, values: new Set(activeFilter?.keys ?? filterOptions.map((option) => option.key)) };
  }

  watch(serverFilterOptions, (filterOptions) => {
    const draft = state.localFilterDraft.value;
    if (draft?.mode === "server" && state.localFilterOpenColumn.value === draft.columnIndex) syncServerFilterDraft(draft.columnIndex, filterOptions);
  });

  async function loadServerFilterValues(columnIndex: number, searchValue: string) {
    if (!options.canUseServerColumnFilter.value || !options.getConnectionId()) return;
    const columnName = options.getResult().columns[columnIndex];
    if (!columnName) return;
    await distinctValueLoader.load({
      columnIndex,
      columnName,
      searchValue,
      limit: DATA_GRID_SERVER_COLUMN_FILTER_LIMIT,
      includeCounts: true,
    });
    if (state.localFilterOpenColumn.value === columnIndex) syncServerFilterDraft(columnIndex, serverFilterOptions.value);
  }

  watch(state.localFilterSearch, (value) => {
    const draft = state.localFilterDraft.value;
    if (!draft || draft.mode !== "server" || state.localFilterOpenColumn.value !== draft.columnIndex) return;
    const columnName = options.getResult().columns[draft.columnIndex];
    if (!columnName) return;
    distinctValueLoader.schedule({
      columnIndex: draft.columnIndex,
      columnName,
      searchValue: value,
      limit: DATA_GRID_SERVER_COLUMN_FILTER_LIMIT,
      includeCounts: true,
    });
  });

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
    if (canApplyTypedLocalFilterValue.value && serverFilterOptions.value.length === 0) {
      await applyTypedLocalFilterValue();
      return;
    }
    const columnName = options.getResult().columns[draft.columnIndex];
    if (!columnName) return;
    const values = [...draft.values].flatMap((key) => (serverFilterValueByKey.value.has(key) ? [serverFilterValueByKey.value.get(key)!] : []));
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

  function resetDistinctValueCache() {
    distinctValueLoader.reset({ clearCache: true });
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
    localFilterSort,
    toggleLocalFilterSort,
    localFilterTypedValue,
    canApplyTypedLocalFilterValue,
    serverFilterLoading,
    serverFilterError,
    serverFilterOptions,
    serverFilterLimited,
    resetDistinctValueCache,
    openLocalFilter,
    closeLocalFilter,
    toggleLocalFilterValue,
    toggleAllLocalFilterOptions,
    applyLocalFilter,
    applyTypedLocalFilterValue,
    clearLocalFilter,
  };
}
