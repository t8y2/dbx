import { computed, nextTick, onActivated, onDeactivated, ref, watch, type ComputedRef, type Ref } from "vue";
import * as api from "@/lib/backend/api";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import { buildDataGridContextFilterCondition } from "@/lib/dataGrid/dataGridSql";
import { buildTableSelectSql } from "@/lib/table/tableSelectSql";
import { shouldIncludeSyntheticRowId } from "@/lib/table/tableEditing";
import { queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";
import type { ColumnInfo, ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";
import type { DataGridRuntimeScope } from "@/lib/dataGrid/dataGridRuntime";
import {
  createResultScopedPendingRequests,
  createResultScopedRowCache,
  isTableDataVisiblePreviewColumn,
  largeValueCellKey,
  largeValueCellMap,
  TABLE_DATA_VISIBLE_PREVIEW_CACHE_CONTENT_MAX_BYTES,
  TABLE_DATA_VISIBLE_PREVIEW_CACHE_ROWS,
  TABLE_DATA_VISIBLE_PREVIEW_SIZE,
  tableDataVisiblePreviewContentBytes,
  tableDataVisiblePreviewRowRange,
  type ResultScopedRowCache,
} from "@/lib/dataGrid/dataGridLargeValues";
import { CANVAS_DATA_GRID_ROW_HEIGHT } from "@/lib/dataGrid/canvasDataGridRenderer";

interface LargeValueRowItem {
  id: number;
  sourceIndex?: number;
  data: CellValue[];
  isNew: boolean;
  isDraft?: boolean;
  isDeleted: boolean;
  isDirtyCol: boolean[];
}

interface LargeValueTableMeta {
  catalog?: string;
  database?: string;
  schema?: string;
  tableName: string;
  tableType?: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
}

export interface UseDataGridLargeValuesOptions {
  result: ComputedRef<QueryResult>;
  tableMeta: ComputedRef<LargeValueTableMeta | undefined>;
  databaseType: ComputedRef<DatabaseType | undefined>;
  connectionId: ComputedRef<string | undefined>;
  executionDatabase: ComputedRef<string>;
  resultSourceColumns: ComputedRef<string[]>;
  allColumnTypes: ComputedRef<Array<string | undefined>>;
  renderedGridColumns: ComputedRef<Array<{ actualColIdx: number }>>;
  showTranspose: Ref<boolean>;
  displayRowCount: ComputedRef<number>;
  gridScrollerElement: () => HTMLElement | null;
  displayItemAt: (displayIndex: number) => LargeValueRowItem | undefined;
  getRowItem: (rowId: number) => LargeValueRowItem | undefined;
  tableColumnForGridColumn: (columnIndex: number) => ColumnInfo | undefined;
  formatCell: (value: CellValue, columnIndex?: number, originalBytes?: number, limitDisplay?: boolean) => string;
  formatCellCached: (value: CellValue, columnIndex?: number, originalBytes?: number) => string;
  scheduleCanvasDraw: () => void;
  clearCellFormatCache: () => void;
  invalidateResultEstimate: (result: QueryResult) => void;
  connectionIdentifierQuote: (connectionId?: string) => string | undefined;
  getConnectionConfig: (connectionId: string) => ConnectionConfig | undefined;
  includeDatabaseName: ComputedRef<boolean>;
  globalQueryTimeoutSecs: ComputedRef<number>;
  resultLifecycle: { beginOperation: () => number; isCurrent: (operation: number) => boolean };
  largeValueResolutionVersion: Ref<number>;
  runtimeScope: DataGridRuntimeScope;
  uuid: () => string;
  translate: (key: string, params?: Record<string, unknown>) => string;
  translateBackendError: (error: unknown) => string;
  appendDebugLog: (level: "info" | "warn" | "error", message: string, payload?: unknown) => void;
  toast: (message: string, duration?: number) => void;
  cloneRow: (rowId: number, resolved?: Map<number, CellValue>) => void;
  cloneRows: (rowIds: number[], resolved: Map<number, Map<number, CellValue>>) => void;
}

type ResolvedLargeValueCells = Map<number, Map<number, CellValue>>;
type LargeValueCellRequest = {
  item: LargeValueRowItem;
  sourceIndex: number;
  columnIndex: number;
  originalBytes: number;
};

export function useDataGridLargeValues(options: UseDataGridLargeValuesOptions) {
  const LARGE_VALUE_FETCH_MAX_ROWS = 200;
  const LARGE_VALUE_FETCH_TARGET_BYTES = 64 * 1024 * 1024;
  const pendingLargeValueHydrations = createResultScopedPendingRequests<boolean>();
  const largeValueCellsByKey = computed(() => largeValueCellMap(options.result.value));
  type VisibleLargeValuePreviewRequest = {
    item: LargeValueRowItem;
    sourceIndex: number;
    initialValues: Map<number, { value: CellValue; revision: number }>;
  };
  const visibleLargeValuePreviewCaches = new WeakMap<QueryResult, ResultScopedRowCache<CellValue>>();
  const visibleLargeValuePreviewCellRevisions = new WeakMap<QueryResult, Map<string, number>>();
  const failedVisibleLargeValuePreviewResults = new WeakSet<QueryResult>();
  const visibleLargeValuePreviewVersion = ref(0);
  let visibleLargeValuePreviewTimer = 0;
  let visibleLargeValuePreviewRequestedGeneration = 0;
  let visibleLargeValuePreviewActive = true;
  const visibleLargeValuePreviewExecutionIds = new Map<number, string>();

  function isLargeValuePreview(item: LargeValueRowItem | undefined, columnIndex: number): boolean {
    if (!item || item.isNew || item.isDraft || item.sourceIndex === undefined || item.isDirtyCol[columnIndex]) return false;
    return largeValueCellsByKey.value.has(largeValueCellKey(item.sourceIndex, columnIndex));
  }

  function largeValueOriginalBytes(item: Pick<LargeValueRowItem, "sourceIndex" | "isNew" | "isDraft" | "isDirtyCol"> | undefined, columnIndex: number): number | undefined {
    if (options.databaseType.value !== "mysql" || !item || item.isNew || item.isDraft || item.sourceIndex === undefined || item.isDirtyCol[columnIndex]) return undefined;
    return largeValueCellsByKey.value.get(largeValueCellKey(item.sourceIndex, columnIndex))?.original_bytes;
  }

  function formatGridItemCell(item: LargeValueRowItem, columnIndex: number): string {
    void visibleLargeValuePreviewVersion.value;
    return options.formatCellCached(visibleLargeValuePreviewValue(item, columnIndex, item.data[columnIndex] ?? null), columnIndex, largeValueOriginalBytes(item, columnIndex));
  }

  function formatGridItemCellForConfirmation(item: LargeValueRowItem, columnIndex: number): string {
    return options.formatCell(item.data[columnIndex], columnIndex, largeValueOriginalBytes(item, columnIndex), false);
  }

  function normalizedLargeValueIdentityPart(value: CellValue): string {
    if (value === null) return "null";
    return `${typeof value}:${JSON.stringify(value)}`;
  }

  function largeValueIdentityKey(row: readonly CellValue[], indexes: readonly number[]): string {
    return indexes.map((index) => normalizedLargeValueIdentityPart(row[index] ?? null)).join("\u001f");
  }

  function largeValueSourceColumnIndex(columnName: string): number {
    const normalized = columnName.toLocaleLowerCase();
    return options.resultSourceColumns.value.findIndex((column) => column.toLocaleLowerCase() === normalized);
  }

  function visibleLargeValuePreviewCache(result: QueryResult): ResultScopedRowCache<CellValue> {
    let cache = visibleLargeValuePreviewCaches.get(result);
    if (!cache) {
      cache = createResultScopedRowCache(TABLE_DATA_VISIBLE_PREVIEW_CACHE_ROWS, {
        maxBytes: TABLE_DATA_VISIBLE_PREVIEW_CACHE_CONTENT_MAX_BYTES,
        sizeOf: tableDataVisiblePreviewContentBytes,
      });
      visibleLargeValuePreviewCaches.set(result, cache);
    }
    return cache;
  }

  function visibleLargeValuePreviewCellRevisionKey(sourceIndex: number, columnIndex: number): string {
    return `${sourceIndex}:${columnIndex}`;
  }

  function visibleLargeValuePreviewCellRevision(result: QueryResult, sourceIndex: number, columnIndex: number): number {
    return visibleLargeValuePreviewCellRevisions.get(result)?.get(visibleLargeValuePreviewCellRevisionKey(sourceIndex, columnIndex)) ?? 0;
  }

  function bumpVisibleLargeValuePreviewCellRevision(result: QueryResult, sourceIndex: number, columnIndex: number) {
    let revisions = visibleLargeValuePreviewCellRevisions.get(result);
    if (!revisions) {
      revisions = new Map<string, number>();
      visibleLargeValuePreviewCellRevisions.set(result, revisions);
    }
    const key = visibleLargeValuePreviewCellRevisionKey(sourceIndex, columnIndex);
    revisions.set(key, (revisions.get(key) ?? 0) + 1);
  }

  function invalidateVisibleLargeValuePreviewCell(rowId: number, columnIndex: number) {
    const item = options.getRowItem(rowId);
    const sourceIndex = item?.sourceIndex ?? (rowId >= 0 ? rowId : undefined);
    if (sourceIndex === undefined) return;
    bumpVisibleLargeValuePreviewCellRevision(options.result.value, sourceIndex, columnIndex);
    const cache = visibleLargeValuePreviewCaches.get(options.result.value);
    if (!cache?.has(sourceIndex, columnIndex)) return;
    cache.forget(sourceIndex, columnIndex);
    visibleLargeValuePreviewVersion.value += 1;
    options.scheduleCanvasDraw();
  }

  function visibleLargeValuePreviewValue(item: Pick<LargeValueRowItem, "sourceIndex"> | undefined, columnIndex: number, fallback: CellValue): CellValue {
    if (item?.sourceIndex === undefined) return fallback;
    const preview = visibleLargeValuePreviewCaches.get(options.result.value)?.get(item.sourceIndex, columnIndex);
    return preview === undefined ? fallback : preview;
  }

  function visibleLargeValuePreviewColumnIndexes(): number[] {
    const rendered = options.renderedGridColumns.value.map((column) => column.actualColIdx);
    return [...new Set(rendered)].filter((columnIndex) => {
      const dataType = options.tableColumnForGridColumn(columnIndex)?.data_type ?? options.allColumnTypes.value[columnIndex] ?? "";
      return isTableDataVisiblePreviewColumn(options.databaseType.value, dataType);
    });
  }

  function evictVisibleLargeValuePreviews(cache: ResultScopedRowCache<CellValue>, protectedRows: ReadonlySet<number>): boolean {
    return cache.evict(protectedRows).length > 0;
  }

  async function hydrateVisibleLargeValuePreviews(generation: number) {
    const sourceResult = options.result.value;
    const tableMeta = options.tableMeta.value;
    const scroller = options.gridScrollerElement();
    if (
      !visibleLargeValuePreviewActive ||
      generation !== visibleLargeValuePreviewRequestedGeneration ||
      failedVisibleLargeValuePreviewResults.has(sourceResult) ||
      options.showTranspose.value ||
      (options.databaseType.value !== "mysql" && options.databaseType.value !== "postgres") ||
      !options.connectionId.value ||
      !tableMeta?.tableName ||
      tableMeta.primaryKeys.length === 0 ||
      !scroller
    )
      return;

    const range = tableDataVisiblePreviewRowRange(scroller.scrollTop, scroller.clientHeight, CANVAS_DATA_GRID_ROW_HEIGHT, options.displayRowCount.value);
    if (!range) return;
    const cache = visibleLargeValuePreviewCache(sourceResult);
    const activeSourceRows = new Set<number>();
    const requests = new Map<number, VisibleLargeValuePreviewRequest>();
    const targetColumnIndexes = visibleLargeValuePreviewColumnIndexes();
    for (let displayIndex = range.start; displayIndex < range.end; displayIndex++) {
      const item = options.displayItemAt(displayIndex);
      if (!item || item.sourceIndex === undefined || item.isNew || item.isDraft) continue;
      activeSourceRows.add(item.sourceIndex);
      cache.touch(item.sourceIndex);
      const initialValues = new Map<number, { value: CellValue; revision: number }>();
      for (const columnIndex of targetColumnIndexes) {
        if (!isLargeValuePreview(item, columnIndex) || cache.has(item.sourceIndex, columnIndex)) continue;
        initialValues.set(columnIndex, {
          value: item.data[columnIndex] ?? null,
          revision: visibleLargeValuePreviewCellRevision(sourceResult, item.sourceIndex, columnIndex),
        });
      }
      if (initialValues.size > 0) requests.set(item.sourceIndex, { item, sourceIndex: item.sourceIndex, initialValues });
    }

    if (requests.size === 0) {
      if (evictVisibleLargeValuePreviews(cache, activeSourceRows)) {
        visibleLargeValuePreviewVersion.value += 1;
        options.scheduleCanvasDraw();
      }
      return;
    }

    const primaryKeyIndexes = tableMeta.primaryKeys.map(largeValueSourceColumnIndex);
    if (primaryKeyIndexes.some((index) => index < 0)) return;
    const requestedColumnIndexes = [...new Set([...requests.values()].flatMap((request) => [...request.initialValues.keys()]))];
    const selectedColumns = [...tableMeta.primaryKeys];
    for (const columnIndex of requestedColumnIndexes) {
      const sourceColumn = options.resultSourceColumns.value[columnIndex];
      if (sourceColumn && !selectedColumns.some((column) => column.toLocaleLowerCase() === sourceColumn.toLocaleLowerCase())) selectedColumns.push(sourceColumn);
    }
    const selectedColumnTypes = selectedColumns.map((column) => tableMeta.columns.find((candidate) => candidate.name.toLocaleLowerCase() === column.toLocaleLowerCase())?.data_type ?? "");
    const predicates = await Promise.all([...requests.values()].map((request) => largeValueRowPredicate(request.item, primaryKeyIndexes)));
    if (!visibleLargeValuePreviewActive || generation !== visibleLargeValuePreviewRequestedGeneration || options.result.value !== sourceResult) return;
    const sql = await buildTableSelectSql({
      databaseType: options.databaseType.value,
      identifierQuote: options.connectionIdentifierQuote(options.connectionId.value),
      database: tableMeta.database,
      schema: tableMeta.schema,
      tableName: tableMeta.tableName,
      tableType: tableMeta.tableType,
      catalog: tableMeta.catalog,
      columns: selectedColumns,
      columnTypes: selectedColumnTypes,
      largeValuePreviewSize: TABLE_DATA_VISIBLE_PREVIEW_SIZE,
      primaryKeys: tableMeta.primaryKeys,
      whereInput: predicates.map((predicate) => `(${predicate})`).join(" OR "),
      limit: requests.size,
      offset: 0,
      includeRowId: shouldIncludeSyntheticRowId(options.databaseType.value, tableMeta.primaryKeys, tableMeta.tableType),
    });
    if (!visibleLargeValuePreviewActive || generation !== visibleLargeValuePreviewRequestedGeneration || options.result.value !== sourceResult) return;
    const connection = options.getConnectionConfig(options.connectionId.value!);
    const executionId = options.uuid();
    visibleLargeValuePreviewExecutionIds.set(generation, executionId);
    let results: QueryResult[];
    try {
      results = await api.executeMulti(options.connectionId.value, options.executionDatabase.value, sql, undefined, executionId, {
        maxRows: requests.size,
        fetchSize: requests.size,
        resultKeyColumns: tableMeta.primaryKeys,
        tableDataPreview: true,
        timeoutSecs: queryTimeoutSecsForConnection(connection, options.globalQueryTimeoutSecs.value),
      });
    } finally {
      if (visibleLargeValuePreviewExecutionIds.get(generation) === executionId) visibleLargeValuePreviewExecutionIds.delete(generation);
    }
    if (!visibleLargeValuePreviewActive || generation !== visibleLargeValuePreviewRequestedGeneration || options.result.value !== sourceResult) return;
    const result = results[0];
    if (!result || result.execution_error) {
      throw new Error(result?.error ? options.translateBackendError(result.error) : String(result?.rows?.[0]?.[0] ?? options.translate("grid.largeValueLoadFailed")));
    }
    const resultColumnIndexes = selectedColumns.map((column) => {
      const normalized = column.toLocaleLowerCase();
      return result.columns.findIndex((resultColumn) => resultColumn.toLocaleLowerCase() === normalized);
    });
    if (resultColumnIndexes.some((index) => index < 0)) throw new Error(options.translate("grid.largeValueColumnUnavailable"));
    const resultPrimaryKeyIndexes = resultColumnIndexes.slice(0, tableMeta.primaryKeys.length);
    const valuesByIdentity = new Map(result.rows.map((row) => [largeValueIdentityKey(row, resultPrimaryKeyIndexes), row]));
    const currentLargeValueCells = largeValueCellMap(sourceResult);
    let changed = false;
    for (const request of requests.values()) {
      const currentRow = sourceResult.rows[request.sourceIndex];
      if (!currentRow) continue;
      const identity = largeValueIdentityKey(currentRow, primaryKeyIndexes);
      const resolvedRow = valuesByIdentity.get(identity);
      if (!resolvedRow) continue;
      for (const [columnIndex, initialValue] of request.initialValues) {
        if (!currentLargeValueCells.has(largeValueCellKey(request.sourceIndex, columnIndex)) || currentRow[columnIndex] !== initialValue.value || visibleLargeValuePreviewCellRevision(sourceResult, request.sourceIndex, columnIndex) !== initialValue.revision) continue;
        const sourceColumn = options.resultSourceColumns.value[columnIndex];
        const selectedIndex = selectedColumns.findIndex((column) => column.toLocaleLowerCase() === sourceColumn?.toLocaleLowerCase());
        const resultIndex = resultColumnIndexes[selectedIndex];
        if (resultIndex === undefined || resultIndex < 0) continue;
        const previewValue = resolvedRow[resultIndex] ?? null;
        cache.remember(request.sourceIndex, columnIndex, previewValue);
        changed = true;
      }
    }
    if (evictVisibleLargeValuePreviews(cache, activeSourceRows)) changed = true;
    if (!changed) return;
    visibleLargeValuePreviewVersion.value += 1;
    options.scheduleCanvasDraw();
  }

  async function runVisibleLargeValuePreviewHydration(generation: number) {
    if (!visibleLargeValuePreviewActive || generation !== visibleLargeValuePreviewRequestedGeneration) return;
    const sourceResult = options.result.value;
    try {
      await hydrateVisibleLargeValuePreviews(generation);
    } catch (error) {
      if (options.result.value === sourceResult && generation === visibleLargeValuePreviewRequestedGeneration && !failedVisibleLargeValuePreviewResults.has(sourceResult)) {
        failedVisibleLargeValuePreviewResults.add(sourceResult);
        options.appendDebugLog("warn", "[DBX][DataGrid:visible-large-value-preview] disabled for result", error);
      }
    }
  }

  function cancelVisibleLargeValuePreviewHydrations() {
    for (const [generation, executionId] of visibleLargeValuePreviewExecutionIds) {
      visibleLargeValuePreviewExecutionIds.delete(generation);
      void api.cancelQuery(executionId).catch((error) => options.appendDebugLog("warn", "[DBX][DataGrid:visible-large-value-preview] cancel failed", error));
    }
  }

  function scheduleVisibleLargeValuePreviewHydration(delay = 150) {
    if (!visibleLargeValuePreviewActive) return;
    const generation = ++visibleLargeValuePreviewRequestedGeneration;
    cancelVisibleLargeValuePreviewHydrations();
    window.clearTimeout(visibleLargeValuePreviewTimer);
    visibleLargeValuePreviewTimer = window.setTimeout(() => {
      visibleLargeValuePreviewTimer = 0;
      void runVisibleLargeValuePreviewHydration(generation);
    }, delay);
  }

  function pauseVisibleLargeValuePreviewHydration() {
    visibleLargeValuePreviewActive = false;
    visibleLargeValuePreviewRequestedGeneration += 1;
    cancelVisibleLargeValuePreviewHydrations();
    window.clearTimeout(visibleLargeValuePreviewTimer);
    visibleLargeValuePreviewTimer = 0;
  }

  function resumeVisibleLargeValuePreviewHydration() {
    visibleLargeValuePreviewActive = true;
    scheduleVisibleLargeValuePreviewHydration();
  }

  watch(
    () => [options.result.value, options.result.value.rows.length, options.renderedGridColumns.value.map((column) => column.actualColIdx).join(","), options.showTranspose.value] as const,
    () => {
      nextTick(() => scheduleVisibleLargeValuePreviewHydration());
    },
    { immediate: true },
  );
  onActivated(resumeVisibleLargeValuePreviewHydration);
  onDeactivated(pauseVisibleLargeValuePreviewHydration);
  options.runtimeScope.addCleanup(pauseVisibleLargeValuePreviewHydration);

  function chunkLargeValueRequests(requests: LargeValueCellRequest[]): LargeValueCellRequest[][] {
    const chunks: LargeValueCellRequest[][] = [];
    let chunk: LargeValueCellRequest[] = [];
    let bytes = 0;
    for (const request of requests) {
      if (chunk.length > 0 && (chunk.length >= LARGE_VALUE_FETCH_MAX_ROWS || bytes + request.originalBytes > LARGE_VALUE_FETCH_TARGET_BYTES)) {
        chunks.push(chunk);
        chunk = [];
        bytes = 0;
      }
      chunk.push(request);
      bytes += request.originalBytes;
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
  }

  async function largeValueRowPredicate(item: LargeValueRowItem, primaryKeyIndexes: number[]): Promise<string> {
    const originalRow = item.sourceIndex === undefined ? undefined : options.result.value.rows[item.sourceIndex];
    if (!originalRow) throw new Error(options.translate("grid.largeValueRowUnavailable"));
    const tableMeta = options.tableMeta.value!;
    const conditions = await Promise.all(
      tableMeta.primaryKeys.map((columnName, index) =>
        buildDataGridContextFilterCondition({
          databaseType: options.databaseType.value,
          identifierQuote: options.connectionIdentifierQuote(options.connectionId.value),
          columnName,
          columnInfo: tableMeta.columns.find((column) => column.name.toLocaleLowerCase() === columnName.toLocaleLowerCase()),
          mode: "equals",
          value: originalRow[primaryKeyIndexes[index]!] ?? null,
        }),
      ),
    );
    if (conditions.some((condition) => !condition)) throw new Error(options.translate("grid.largeValueRowUnavailable"));
    return conditions.map((condition) => `(${condition})`).join(" AND ");
  }

  async function fetchLargeValueRequestChunk(columnIndex: number, requests: LargeValueCellRequest[], primaryKeyIndexes: number[], resolved: ResolvedLargeValueCells) {
    const tableMeta = options.tableMeta.value!;
    const sourceColumn = options.resultSourceColumns.value[columnIndex];
    if (!sourceColumn) throw new Error(options.translate("grid.largeValueColumnUnavailable"));
    const predicates = await Promise.all(requests.map((request) => largeValueRowPredicate(request.item, primaryKeyIndexes)));
    const selectedColumns = [...new Set([...tableMeta.primaryKeys, sourceColumn])];
    const sql = await buildTableSelectSql({
      databaseType: options.databaseType.value,
      identifierQuote: options.connectionIdentifierQuote(options.connectionId.value),
      database: tableMeta.database,
      schema: tableMeta.schema,
      tableName: tableMeta.tableName,
      tableType: tableMeta.tableType,
      catalog: tableMeta.catalog,
      columns: selectedColumns,
      includeDatabaseName: options.includeDatabaseName.value,
      primaryKeys: tableMeta.primaryKeys,
      whereInput: predicates.map((predicate) => `(${predicate})`).join(" OR "),
      limit: requests.length,
      offset: 0,
      includeRowId: shouldIncludeSyntheticRowId(options.databaseType.value, tableMeta.primaryKeys, tableMeta.tableType),
    });
    const connection = options.connectionId.value ? options.getConnectionConfig(options.connectionId.value!) : undefined;
    const results = await api.executeMulti(options.connectionId.value!, options.executionDatabase.value, sql, undefined, options.uuid(), {
      maxRows: requests.length,
      fetchSize: requests.length,
      timeoutSecs: queryTimeoutSecsForConnection(connection, options.globalQueryTimeoutSecs.value),
    });
    const result = results[0];
    if (!result || result.execution_error) {
      throw new Error(result?.error ? options.translateBackendError(result.error) : String(result?.rows?.[0]?.[0] ?? options.translate("grid.largeValueLoadFailed")));
    }
    const resultColumnIndexes = selectedColumns.map((column) => {
      const normalized = column.toLocaleLowerCase();
      return result.columns.findIndex((resultColumn) => resultColumn.toLocaleLowerCase() === normalized);
    });
    if (resultColumnIndexes.some((index) => index < 0)) throw new Error(options.translate("grid.largeValueColumnUnavailable"));
    const resultPrimaryKeyIndexes = resultColumnIndexes.slice(0, tableMeta.primaryKeys.length);
    const resultValueIndex = resultColumnIndexes[selectedColumns.indexOf(sourceColumn)];
    const valuesByIdentity = new Map(result.rows.map((row) => [largeValueIdentityKey(row, resultPrimaryKeyIndexes), row[resultValueIndex!] ?? null]));
    for (const request of requests) {
      const originalRow = options.result.value.rows[request.sourceIndex];
      const identity = originalRow ? largeValueIdentityKey(originalRow, primaryKeyIndexes) : "";
      if (!valuesByIdentity.has(identity)) throw new Error(options.translate("grid.largeValueRowUnavailable"));
      const rowValues = resolved.get(request.item.id) ?? new Map<number, CellValue>();
      rowValues.set(columnIndex, valuesByIdentity.get(identity) ?? null);
      resolved.set(request.item.id, rowValues);
    }
  }

  async function resolveLargeValueCells(rowIds: number[], columnIndexes: number[]): Promise<ResolvedLargeValueCells> {
    const resolved: ResolvedLargeValueCells = new Map();
    const requestedColumns = new Set(columnIndexes);
    const requestsByColumn = new Map<number, LargeValueCellRequest[]>();
    for (const rowId of new Set(rowIds)) {
      const item = options.getRowItem(rowId);
      if (!item || item.sourceIndex === undefined) continue;
      for (const columnIndex of requestedColumns) {
        if (!isLargeValuePreview(item, columnIndex)) continue;
        const metadata = largeValueCellsByKey.value.get(largeValueCellKey(item.sourceIndex, columnIndex));
        if (!metadata) continue;
        const requests = requestsByColumn.get(columnIndex) ?? [];
        requests.push({ item, sourceIndex: item.sourceIndex, columnIndex, originalBytes: metadata.original_bytes });
        requestsByColumn.set(columnIndex, requests);
      }
    }
    if (requestsByColumn.size === 0) return resolved;
    if ((options.databaseType.value !== "mysql" && options.databaseType.value !== "postgres" && options.databaseType.value !== "oracle") || !options.connectionId.value || !options.tableMeta.value?.tableName || options.tableMeta.value.primaryKeys.length === 0) {
      throw new Error(options.translate("grid.largeValueNeedsStableKey"));
    }
    const primaryKeyIndexes = options.tableMeta.value.primaryKeys.map(largeValueSourceColumnIndex);
    if (primaryKeyIndexes.some((index) => index < 0)) throw new Error(options.translate("grid.largeValueNeedsStableKey"));

    for (const [columnIndex, requests] of requestsByColumn) {
      for (const chunk of chunkLargeValueRequests(requests)) {
        await fetchLargeValueRequestChunk(columnIndex, chunk, primaryKeyIndexes, resolved);
      }
    }
    return resolved;
  }

  function reportLargeValueLoadError(error: unknown) {
    options.toast(options.translate("grid.largeValueLoadFailedWithMessage", { message: options.translateBackendError(error) }), 5000);
  }

  async function cloneRow(rowId: number) {
    try {
      const resolved = await resolveLargeValueCells(
        [rowId],
        options.result.value.columns.map((_, index) => index),
      );
      options.cloneRow(rowId, resolved.get(rowId));
    } catch (error) {
      reportLargeValueLoadError(error);
    }
  }

  async function cloneRows(rowIds: number[]) {
    try {
      const resolved = await resolveLargeValueCells(
        rowIds,
        options.result.value.columns.map((_, index) => index),
      );
      options.cloneRows(rowIds, resolved);
    } catch (error) {
      reportLargeValueLoadError(error);
    }
  }

  async function hydrateLargeValueCell(rowId: number, columnIndex: number): Promise<boolean> {
    const item = options.getRowItem(rowId);
    if (!isLargeValuePreview(item, columnIndex) || item?.sourceIndex === undefined) return true;
    const sourceResult = options.result.value;
    const hydrationKey = largeValueCellKey(item.sourceIndex, columnIndex);
    const operation = options.resultLifecycle.beginOperation();
    return pendingLargeValueHydrations.run(hydrationKey, sourceResult, async () => {
      try {
        const resolved = await resolveLargeValueCells([rowId], [columnIndex]);
        if (!options.resultLifecycle.isCurrent(operation) || options.result.value !== sourceResult) return false;
        const value = resolved.get(rowId)?.get(columnIndex);
        if (value === undefined && !resolved.get(rowId)?.has(columnIndex)) return false;
        const row = [...(sourceResult.rows[item.sourceIndex!] ?? [])];
        row[columnIndex] = value ?? null;
        const rows = sourceResult.rows.slice();
        rows[item.sourceIndex!] = row;
        sourceResult.rows = rows;
        visibleLargeValuePreviewCaches.get(sourceResult)?.forget(item.sourceIndex!, columnIndex);
        sourceResult.large_value_cells = sourceResult.large_value_cells?.filter((cell) => cell.row_index !== item.sourceIndex || cell.column_index !== columnIndex);
        options.largeValueResolutionVersion.value += 1;
        options.clearCellFormatCache();
        options.invalidateResultEstimate(sourceResult);
        return true;
      } catch (error) {
        if (options.resultLifecycle.isCurrent(operation) && options.result.value === sourceResult) reportLargeValueLoadError(error);
        return false;
      }
    });
  }

  return {
    isLargeValuePreview,
    largeValueOriginalBytes,
    formatGridItemCell,
    formatGridItemCellForConfirmation,
    visibleLargeValuePreviewValue,
    resolveLargeValueCells,
    hydrateLargeValueCell,
    invalidateVisibleLargeValuePreviewCell,
    scheduleVisibleLargeValuePreviewHydration,
    reportLargeValueLoadError,
    cloneRow,
    cloneRows,
  };
}
