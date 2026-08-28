import type { DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";

export type DataGridCachedServerColumnFilter = {
  condition: string;
  keys: string[];
  labels: string[];
};

export type DataGridStructuredFilterCacheState = {
  scopeKey: string;
  manualWhereInput: string;
  rules: DataGridStructuredFilterRule[];
  appliedWhereInput: string;
  serverColumnFilters: Record<number, DataGridCachedServerColumnFilter>;
};

const STRUCTURED_FILTER_STATE_CACHE_MAX_ENTRIES = 128;
const structuredFilterStateCache = new Map<string, DataGridStructuredFilterCacheState>();

export function cloneDataGridStructuredFilterRules(rules: readonly DataGridStructuredFilterRule[]): DataGridStructuredFilterRule[] {
  return rules.map((rule) => ({ ...rule }));
}

export function loadDataGridStructuredFilterState(cacheKey: string, scopeKey: string): DataGridStructuredFilterCacheState | undefined {
  const cached = structuredFilterStateCache.get(cacheKey);
  if (!cached || cached.scopeKey !== scopeKey) return undefined;
  structuredFilterStateCache.delete(cacheKey);
  structuredFilterStateCache.set(cacheKey, cached);
  return {
    ...cached,
    rules: cloneDataGridStructuredFilterRules(cached.rules),
    serverColumnFilters: structuredClone(cached.serverColumnFilters),
  };
}

export function saveDataGridStructuredFilterState(cacheKey: string, state: DataGridStructuredFilterCacheState) {
  structuredFilterStateCache.delete(cacheKey);
  structuredFilterStateCache.set(cacheKey, {
    ...state,
    rules: cloneDataGridStructuredFilterRules(state.rules),
    serverColumnFilters: structuredClone(state.serverColumnFilters),
  });
  while (structuredFilterStateCache.size > STRUCTURED_FILTER_STATE_CACHE_MAX_ENTRIES) {
    const oldest = structuredFilterStateCache.keys().next().value;
    if (oldest === undefined) break;
    structuredFilterStateCache.delete(oldest);
  }
}

export function clearDataGridStructuredFilterStatesForTab(tabId: string) {
  structuredFilterStateCache.delete(tabId);
  for (const cacheKey of structuredFilterStateCache.keys()) {
    if (cacheKey.startsWith(`${tabId}-`)) structuredFilterStateCache.delete(cacheKey);
  }
}
