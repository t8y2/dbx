export interface SidebarSearchExpansionState {
  readonly filteredNodeIds: Set<string>;
  readonly autoExpandedNodeIds: Set<string>;
  markFiltered(nodeId: string, autoExpanded: boolean): void;
  markUnfiltered(nodeId: string): boolean;
  shouldRestore(nodeId: string): boolean;
  hasTrackedNodes(): boolean;
  clear(): void;
}

export function createSidebarSearchExpansionState(): SidebarSearchExpansionState {
  const filteredNodeIds = new Set<string>();
  const autoExpandedNodeIds = new Set<string>();

  return {
    filteredNodeIds,
    autoExpandedNodeIds,
    markFiltered(nodeId, autoExpanded) {
      filteredNodeIds.add(nodeId);
      if (autoExpanded) autoExpandedNodeIds.add(nodeId);
    },
    markUnfiltered(nodeId) {
      return filteredNodeIds.delete(nodeId);
    },
    shouldRestore(nodeId) {
      return filteredNodeIds.has(nodeId) || autoExpandedNodeIds.has(nodeId);
    },
    hasTrackedNodes() {
      return filteredNodeIds.size > 0 || autoExpandedNodeIds.size > 0;
    },
    clear() {
      filteredNodeIds.clear();
      autoExpandedNodeIds.clear();
    },
  };
}
