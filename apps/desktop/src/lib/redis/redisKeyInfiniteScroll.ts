export interface RedisKeyInfiniteScrollState {
  enabled: boolean;
  hasMore: boolean;
  busy: boolean;
  loadedKeys: number;
  maxKeys: number;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function shouldLoadMoreRedisKeys(state: RedisKeyInfiniteScrollState, threshold = 100): boolean {
  if (!state.enabled || !state.hasMore || state.busy) return false;
  if (state.loadedKeys >= state.maxKeys || state.clientHeight <= 0) return false;
  return state.scrollTop + state.clientHeight >= state.scrollHeight - Math.max(0, threshold);
}
