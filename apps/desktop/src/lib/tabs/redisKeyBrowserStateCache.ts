export type RedisKeyBrowserSearchMode = "key" | "value" | "all";

export interface RedisKeyBrowserStateSnapshot {
  /** Key / value / all search input text. */
  searchPattern: string;
  /** Which Redis search mode the toolbar is in. */
  searchMode: RedisKeyBrowserSearchMode;
  /** Fuzzy MATCH wrapping for key-mode searches. */
  fuzzyKeySearch: boolean;
  /** Local filter: only show keys with TTL = -1 in the loaded result set. */
  noExpiryOnly: boolean;
}

// ContentArea renders only the active tab, so RedisKeyBrowser is unmounted on
// every tab switch and remounted when the user comes back. Search conditions
// survive that round trip through this session-scoped cache keyed by tab id —
// the same role documentBrowserStateCache plays for Mongo/ES collection tabs.
// The bound keeps state for long tab sessions from accumulating forever.
const MAX_ENTRIES = 32;
const cache = new Map<string, RedisKeyBrowserStateSnapshot>();

export function restoreRedisKeyBrowserState(stateKey: string): RedisKeyBrowserStateSnapshot | undefined {
  const snapshot = cache.get(stateKey);
  if (!snapshot) return undefined;
  // Refresh LRU recency.
  cache.delete(stateKey);
  cache.set(stateKey, snapshot);
  return snapshot;
}

export function saveRedisKeyBrowserState(stateKey: string, snapshot: RedisKeyBrowserStateSnapshot): void {
  cache.delete(stateKey);
  cache.set(stateKey, snapshot);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearRedisKeyBrowserState(stateKey: string): void {
  cache.delete(stateKey);
}
