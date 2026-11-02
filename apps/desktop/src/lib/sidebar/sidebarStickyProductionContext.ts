import type { FlatTreeIndex, FlatTreeNode } from "@/composables/useFlatTree";

/** Resolve the context entering the fixed header's first row during handover. */
export function resolveSidebarStickyProductionNode(nodes: readonly FlatTreeNode[], index: FlatTreeIndex, currentIndex: number, scrollTop: number, rowHeight: number): FlatTreeNode | null {
  const current = nodes[currentIndex];
  if (currentIndex < 0 || !current) return null;
  const nextContainer = current.type === "schema" ? index.nextSchemaContainerIndexByIndex[currentIndex] : index.nextDatabaseContainerIndexByIndex[currentIndex];
  const nextBoundary = index.nextBoundaryIndexByIndex[currentIndex] ?? -1;
  const nextCollision = nextContainer < 0 ? nextBoundary : nextBoundary < 0 ? nextContainer : Math.min(nextContainer, nextBoundary);
  if (nextCollision < 0 || nextCollision * rowHeight - scrollTop >= rowHeight) return current;
  // A connection/group boundary ends the previous container's production scope.
  return nextCollision === nextBoundary ? null : (nodes[nextCollision] ?? null);
}

/**
 * Resolve the fixed container for a plain DOM tree from actual row positions.
 * This avoids switching early when rendered rows are taller than the virtual
 * row-height estimate (for example after a query node or font-size change).
 */
export function resolvePlainStickyContainerIndex(_nodes: readonly FlatTreeNode[], index: FlatTreeIndex, rows: readonly { nodeId: string; top: number }[], scrollerTop: number): number {
  let pinnedIndex = -1;
  for (const row of rows) {
    const flatIndex = index.flatNodeIndexById.get(row.nodeId);
    if (flatIndex == null) continue;
    if (row.top <= scrollerTop + 0.5) {
      pinnedIndex = index.stickyContainerIndexByIndex[flatIndex] ?? -1;
      continue;
    }
    break;
  }
  return pinnedIndex;
}
