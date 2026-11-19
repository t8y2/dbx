export type DataGridSearchCacheState = {
  scopeKey: string;
  searchText: string;
  deferredSearchText: string;
  overlayVisible: boolean;
  currentMatchIndex: number;
};

const SEARCH_STATE_CACHE_MAX_ENTRIES = 128;
const searchStateCache = new Map<string, DataGridSearchCacheState>();

/** 列集合定义了匹配空间；行数刻意不参与，翻页/追加行不应丢弃用户的搜索词。 */
export function createDataGridSearchScopeKey(columns: readonly string[]): string {
  return JSON.stringify(columns);
}

export function loadDataGridSearchState(cacheKey: string | undefined, scopeKey: string): DataGridSearchCacheState | undefined {
  const key = cacheKey?.trim();
  if (!key) return undefined;
  const cached = searchStateCache.get(key);
  if (!cached) return undefined;
  if (cached.scopeKey !== scopeKey) {
    searchStateCache.delete(key);
    return undefined;
  }
  searchStateCache.delete(key);
  searchStateCache.set(key, cached);
  return { ...cached };
}

export function saveDataGridSearchState(cacheKey: string | undefined, state: DataGridSearchCacheState) {
  const key = cacheKey?.trim();
  if (!key) return;
  searchStateCache.delete(key);
  // An empty, closed search bar is the default state; storing it would only pin a
  // dead entry and defeat the reset that close() performs.
  if (!state.searchText && !state.overlayVisible) return;
  searchStateCache.set(key, { ...state });
  // Query result keys are session-scoped, so bound the in-memory cache instead of
  // relying on store cleanup paths.
  while (searchStateCache.size > SEARCH_STATE_CACHE_MAX_ENTRIES) {
    const oldest = searchStateCache.keys().next().value;
    if (oldest === undefined) break;
    searchStateCache.delete(oldest);
  }
}

export function clearDataGridSearchStatesForTab(tabId: string) {
  searchStateCache.delete(tabId);
  for (const cacheKey of searchStateCache.keys()) {
    if (cacheKey.startsWith(`${tabId}-`)) searchStateCache.delete(cacheKey);
  }
}

export function clearDataGridSearchStates() {
  searchStateCache.clear();
}

export function dataGridSearchStateCount(): number {
  return searchStateCache.size;
}
