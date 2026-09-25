import { findRedisHeaderChain, findRedisOuterGroup, type RedisHeaderBoundary, type RedisOuterGroupBoundary } from "./redisKeyGroupIndex";

export const REDIS_GROUP_ROW_HEIGHT = 30;

export function redisStickyHeaders(outer: readonly RedisOuterGroupBoundary[], headers: readonly RedisHeaderBoundary[], scroll: number, height: number, tree: boolean) {
  const size = REDIS_GROUP_ROW_HEIGHT;
  const capacity = tree ? Math.min(3, Math.floor((height * 0.3) / size)) : 1;
  const group = findRedisOuterGroup(outer, scroll / size);
  if (!capacity || !group || group.end <= group.start + 1 || scroll <= group.start * size) return [];
  const outerOffset = Math.min(0, group.end * size - scroll - size);
  if (!tree) return [{ row: group.row, top: outerOffset, omitted: false, path: group.row.label }];
  // Probe only the small overlay band, never the virtual source. Do not cross
  // the outer boundary while choosing descendants at a section transition.
  const chain = findRedisHeaderChain(headers, Math.min(group.end - 0.001, (scroll + (capacity - 1) * size) / size)).filter((entry) => entry.end > entry.start + 1);
  const candidates = chain.length > capacity ? [chain[0]!, ...chain.slice(-(capacity - 1))] : chain;
  if (capacity === 1) candidates.splice(1);
  const path = chain.map((entry) => entry.row.label).join(" › ");
  return candidates.flatMap((entry, slot) => {
    const top = slot * size;
    if (entry.start * size >= scroll + top || entry.end * size <= scroll + top || entry.end <= entry.start + 1) return [];
    return [{ row: entry.row, top: Math.min(top, entry.end * size - scroll - size), omitted: slot === 1 && chain.length > capacity, path }];
  });
}

export function redisStickyHeight(sticky: ReturnType<typeof redisStickyHeaders>) {
  return sticky.reduce((height, row) => Math.max(height, row.top + REDIS_GROUP_ROW_HEIGHT), 0);
}
