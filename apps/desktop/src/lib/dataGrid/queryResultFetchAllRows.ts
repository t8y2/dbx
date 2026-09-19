import { reactive, ref } from "vue";

/** Batch size for the sequential fetch-all-rows loop. Mirrors RedisKeyBrowser.vue's FETCH_ALL_SCAN_COUNT for the analogous "fetch all" flow, but larger since SQL LIMIT/OFFSET batches are cheaper than key scans. */
export const QUERY_RESULT_FETCH_ALL_BATCH_ROWS = 10_000;

/** Above this row count, the confirmation dialog switches to a stronger warning regardless of the "don't ask again" preference. */
export const QUERY_RESULT_FETCH_ALL_WARN_ROWS = 1_000_000;

export function shouldWarnFetchAllRows(totalRows: number | undefined, cap: number, threshold = QUERY_RESULT_FETCH_ALL_WARN_ROWS): boolean {
  const effectiveRows = typeof totalRows === "number" ? Math.min(totalRows, cap) : cap;
  return effectiveRows > threshold;
}

// Session-scoped singleton (useDataGridActions is instantiated once, in
// App.vue), mirroring useSqlExecution.ts's suppressDangerConfirm — resets on
// app restart, never persisted, and shared across every DataGrid instance so
// switching result tabs does not re-prompt.
export const suppressFetchAllRowsConfirm = ref(false);

interface FetchAllRowsState {
  stopRequested: boolean;
}

const activeFetches = reactive(new Map<string, FetchAllRowsState>());

export function isFetchingAllRows(tabId: string | undefined): boolean {
  return !!tabId && activeFetches.has(tabId);
}

export function beginFetchAllRows(tabId: string): boolean {
  if (activeFetches.has(tabId)) return false;
  activeFetches.set(tabId, { stopRequested: false });
  return true;
}

export function endFetchAllRows(tabId: string): void {
  activeFetches.delete(tabId);
}

export function requestStopFetchAllRows(tabId: string): void {
  const state = activeFetches.get(tabId);
  if (state) state.stopRequested = true;
}

export function isFetchAllRowsStopRequested(tabId: string): boolean {
  return activeFetches.get(tabId)?.stopRequested === true;
}
