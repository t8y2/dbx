export function prunePinnedTreeNodeIdsForConnection(ids: Set<string>, connectionId: string): Set<string> {
  const next = new Set<string>();
  const prefix = `${connectionId}:`;
  for (const id of ids) {
    if (id === connectionId) continue;
    if (id.startsWith(prefix)) continue;
    next.add(id);
  }
  return next;
}
