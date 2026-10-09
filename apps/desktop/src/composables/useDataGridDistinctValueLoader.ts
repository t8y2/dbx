import { onUnmounted, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";
import * as api from "@/lib/backend/api";
import { buildDataGridColumnDistinctValuesSql } from "@/lib/dataGrid/dataGridSql";
import { dataGridLocalFilterKey, type DataGridLocalFilterOption } from "@/lib/dataGrid/dataGridLocalColumnFilterState";
import { queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { ColumnInfo, ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";

export const DATA_GRID_DISTINCT_VALUE_DEFAULT_LIMIT = 1000;
export const DATA_GRID_DISTINCT_VALUE_MAX_LIMIT = 1000;
export const DATA_GRID_DISTINCT_VALUE_DEBOUNCE_MS = 300;
const DATA_GRID_DISTINCT_VALUE_CACHE_TTL_MS = 30_000;

interface DataGridDistinctValueTableMeta {
  catalog?: string;
  database?: string;
  schema?: string;
  tableName: string;
  columns: ColumnInfo[];
}

export interface DataGridDistinctValueLoadRequest {
  columnIndex: number;
  columnName: string;
  searchValue?: string;
  limit?: number;
  includeCounts?: boolean;
}

export interface UseDataGridDistinctValueLoaderOptions {
  scopeIdentity: MaybeRefOrGetter<string>;
  getConnectionId: () => string | undefined;
  getExecutionDatabase: () => string;
  getSchema: () => string | undefined;
  getDatabaseType: () => DatabaseType | undefined;
  getConnectionConfig: () => Pick<ConnectionConfig, "driver_profile" | "query_timeout_secs" | "query_timeout_inherit"> | undefined;
  getIdentifierQuote: () => string | undefined;
  getGlobalQueryTimeoutSecs: () => number | undefined;
  waitForTableMeta: () => Promise<DataGridDistinctValueTableMeta | null>;
  formatValue: (value: CellValue, columnIndex: number) => string;
  keyForValue?: (value: CellValue, columnInfo?: ColumnInfo) => string;
}

type CachedDistinctValues = {
  expiresAt: number;
  options: DataGridLocalFilterOption[];
  limited: boolean;
};

export interface DataGridDistinctValueLoader {
  loading: Ref<boolean>;
  error: Ref<string>;
  options: Ref<DataGridLocalFilterOption[]>;
  limited: Ref<boolean>;
  valueByKey: Ref<Map<string, CellValue>>;
  load: (request: DataGridDistinctValueLoadRequest) => Promise<void>;
  schedule: (request: DataGridDistinctValueLoadRequest, debounceMs?: number) => void;
  reset: (options?: { clearCache?: boolean }) => void;
}

export function useDataGridDistinctValueLoader(options: UseDataGridDistinctValueLoaderOptions): DataGridDistinctValueLoader {
  const loading = ref(false);
  const error = ref("");
  const distinctOptions = ref<DataGridLocalFilterOption[]>([]);
  const limited = ref(false);
  const valueByKey = ref<Map<string, CellValue>>(new Map());
  const cache = new Map<string, CachedDistinctValues>();
  let requestId = 0;
  let timer: ReturnType<typeof window.setTimeout> | undefined;

  function normalizedLimit(limit?: number) {
    return Math.min(DATA_GRID_DISTINCT_VALUE_MAX_LIMIT, Math.max(1, Math.trunc(limit ?? DATA_GRID_DISTINCT_VALUE_DEFAULT_LIMIT)));
  }

  function cancelPending() {
    requestId += 1;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    loading.value = false;
  }

  function reset(resetOptions: { clearCache?: boolean } = {}) {
    cancelPending();
    error.value = "";
    distinctOptions.value = [];
    limited.value = false;
    valueByKey.value = new Map();
    if (resetOptions.clearCache) cache.clear();
  }

  function optionFromRow(row: QueryResult["rows"][number], columnIndex: number, columnInfo?: ColumnInfo): DataGridLocalFilterOption {
    const value = (row[0] ?? null) as CellValue;
    const countValue = Number(row[1]);
    return {
      key: options.keyForValue?.(value, columnInfo) ?? dataGridLocalFilterKey(value),
      label: options.formatValue(value, columnIndex),
      count: Number.isFinite(countValue) ? countValue : null,
      value,
    };
  }

  function optionsFromResult(result: QueryResult, columnIndex: number, columnInfo: ColumnInfo | undefined, displayLimit: number): DataGridLocalFilterOption[] {
    const byKey = new Map<string, DataGridLocalFilterOption>();
    for (const row of result.rows) {
      const option = optionFromRow(row, columnIndex, columnInfo);
      const current = byKey.get(option.key);
      if (current) current.count = (current.count ?? 0) + (option.count ?? 0);
      else byKey.set(option.key, option);
      if (byKey.size > displayLimit) break;
    }
    return [...byKey.values()].slice(0, displayLimit);
  }

  function applyValues(nextOptions: DataGridLocalFilterOption[], nextLimited: boolean) {
    const nextValueByKey = new Map(valueByKey.value);
    for (const option of nextOptions) nextValueByKey.set(option.key, option.value);
    valueByKey.value = nextValueByKey;
    distinctOptions.value = nextOptions;
    limited.value = nextLimited;
  }

  function cacheKey(request: DataGridDistinctValueLoadRequest, tableMeta: DataGridDistinctValueTableMeta, displayLimit: number) {
    return JSON.stringify([
      toValue(options.scopeIdentity),
      options.getConnectionId() ?? "",
      options.getExecutionDatabase(),
      tableMeta.catalog ?? "",
      tableMeta.database ?? "",
      tableMeta.schema ?? "",
      tableMeta.tableName,
      request.columnName,
      request.searchValue?.trim() ?? "",
      displayLimit,
      request.includeCounts !== false,
    ]);
  }

  async function performLoad(request: DataGridDistinctValueLoadRequest, activeRequestId: number) {
    loading.value = true;
    error.value = "";
    limited.value = false;
    try {
      const connectionId = options.getConnectionId();
      if (!connectionId || !request.columnName) return;
      const tableMeta = await options.waitForTableMeta();
      if (!tableMeta || activeRequestId !== requestId) return;
      const displayLimit = normalizedLimit(request.limit);
      const key = cacheKey(request, tableMeta, displayLimit);
      const now = Date.now();
      for (const [cachedKey, cachedValue] of cache) {
        if (cachedValue.expiresAt <= now) cache.delete(cachedKey);
      }
      const cached = cache.get(key);
      if (cached) {
        applyValues(cached.options, cached.limited);
        return;
      }

      const columnInfo = tableMeta.columns.find((column) => column.name === request.columnName);
      const connection = options.getConnectionConfig();
      const sql = await buildDataGridColumnDistinctValuesSql({
        databaseType: options.getDatabaseType(),
        driverProfile: connection?.driver_profile,
        identifierQuote: options.getIdentifierQuote(),
        catalog: tableMeta.catalog,
        database: tableMeta.database,
        schema: tableMeta.schema,
        tableName: tableMeta.tableName,
        columnName: request.columnName,
        columnInfo,
        searchValue: request.searchValue?.trim() || undefined,
        limit: displayLimit,
        includeCounts: request.includeCounts !== false,
        excludeNulls: false,
      });
      const result = await api.executeQuery(connectionId, options.getExecutionDatabase(), sql, tableMeta.schema ?? options.getSchema(), undefined, {
        maxRows: displayLimit,
        fetchSize: displayLimit,
        pageSize: displayLimit,
        timeoutSecs: queryTimeoutSecsForConnection(connection, options.getGlobalQueryTimeoutSecs()),
      });
      if (activeRequestId !== requestId) return;
      const nextOptions = optionsFromResult(result, request.columnIndex, columnInfo, displayLimit);
      const nextLimited = result.truncated === true || result.rows.length >= displayLimit;
      cache.set(key, {
        expiresAt: Date.now() + DATA_GRID_DISTINCT_VALUE_CACHE_TTL_MS,
        options: nextOptions,
        limited: nextLimited,
      });
      applyValues(nextOptions, nextLimited);
    } catch (loadError: any) {
      if (activeRequestId !== requestId) return;
      distinctOptions.value = [];
      limited.value = false;
      error.value = String(loadError?.message || loadError);
    } finally {
      if (activeRequestId === requestId) loading.value = false;
    }
  }

  function load(request: DataGridDistinctValueLoadRequest) {
    cancelPending();
    const activeRequestId = requestId;
    return performLoad(request, activeRequestId);
  }

  function schedule(request: DataGridDistinctValueLoadRequest, debounceMs = DATA_GRID_DISTINCT_VALUE_DEBOUNCE_MS) {
    cancelPending();
    const activeRequestId = requestId;
    loading.value = true;
    error.value = "";
    timer = window.setTimeout(
      () => {
        timer = undefined;
        void performLoad(request, activeRequestId);
      },
      Math.max(0, debounceMs),
    );
  }

  watch(
    () => toValue(options.scopeIdentity),
    () => reset({ clearCache: true }),
  );
  onUnmounted(() => reset({ clearCache: true }));

  return { loading, error, options: distinctOptions, limited, valueByKey, load, schedule, reset };
}
