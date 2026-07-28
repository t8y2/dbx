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

const structuredFilterStateCache = new Map<string, DataGridStructuredFilterCacheState>();

export function cloneDataGridStructuredFilterRules(rules: readonly DataGridStructuredFilterRule[]): DataGridStructuredFilterRule[] {
  return rules.map((rule) => ({ ...rule }));
}

export function loadDataGridStructuredFilterState(cacheKey: string, scopeKey: string): DataGridStructuredFilterCacheState | undefined {
  const cached = structuredFilterStateCache.get(cacheKey);
  if (!cached || cached.scopeKey !== scopeKey) return undefined;
  return {
    ...cached,
    rules: cloneDataGridStructuredFilterRules(cached.rules),
    serverColumnFilters: structuredClone(cached.serverColumnFilters),
  };
}

export function saveDataGridStructuredFilterState(cacheKey: string, state: DataGridStructuredFilterCacheState) {
  structuredFilterStateCache.set(cacheKey, {
    ...state,
    rules: cloneDataGridStructuredFilterRules(state.rules),
    serverColumnFilters: structuredClone(state.serverColumnFilters),
  });
}
