/**
 * Per-tree-node load generation: one handle owns both apply eligibility and spinner clear.
 * Connection/reconnect invalidation bumps generations under a connection so stale loads
 * cannot write children or clear a newer load's isLoading.
 */

export type TreeNodeLike = {
  id: string;
  connectionId?: string;
  isLoading?: boolean;
  children?: TreeNodeLike[];
};

export type TreeNodeLoadHandle = {
  readonly nodeId: string;
  readonly generation: number;
  isCurrent(): boolean;
  /** After ensureConnected may invalidate gens; reclaim ownership and keep spinner lit. */
  reclaim(node: TreeNodeLike): TreeNodeLoadHandle;
  targetNode(findLive: (nodeId: string) => TreeNodeLike | null, isConnected: (connectionId: string) => boolean): TreeNodeLike | null;
  finish(findLive: (nodeId: string) => TreeNodeLike | null): void;
};

export class TreeNodeLoadRegistry {
  private readonly generations = new Map<string, number>();

  begin(node: TreeNodeLike): TreeNodeLoadHandle {
    const generation = (this.generations.get(node.id) ?? 0) + 1;
    this.generations.set(node.id, generation);
    const liveHint = node;
    liveHint.isLoading = true;
    return this.createHandle(node.id, generation);
  }

  /** Invalidate all loads for a connection subtree and clear sticky spinners on surviving nodes. */
  invalidateConnection(connectionId: string, root: TreeNodeLike | null): void {
    if (root) {
      const stack: TreeNodeLike[] = [root];
      while (stack.length) {
        const node = stack.pop()!;
        this.generations.set(node.id, (this.generations.get(node.id) ?? 0) + 1);
        node.isLoading = false;
        if (node.children?.length) stack.push(...node.children);
      }
      return;
    }
    const prefix = `${connectionId}:`;
    for (const id of [...this.generations.keys()]) {
      if (id === connectionId || id.startsWith(prefix)) {
        this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
      }
    }
  }

  private isCurrent(nodeId: string, generation: number): boolean {
    return this.generations.get(nodeId) === generation;
  }

  private createHandle(nodeId: string, generation: number): TreeNodeLoadHandle {
    const registry = this;
    return {
      nodeId,
      generation,
      isCurrent() {
        return registry.isCurrent(nodeId, generation);
      },
      reclaim(node: TreeNodeLike) {
        if (node.id !== nodeId) {
          return registry.begin(node);
        }
        if (registry.isCurrent(nodeId, generation)) {
          node.isLoading = true;
          const live = node;
          live.isLoading = true;
          return this;
        }
        return registry.begin(node);
      },
      targetNode(findLive, isConnected) {
        if (!registry.isCurrent(nodeId, generation)) return null;
        const current = findLive(nodeId);
        if (!current) return null;
        if (current.connectionId && !isConnected(current.connectionId)) return null;
        return current;
      },
      finish(findLive) {
        if (!registry.isCurrent(nodeId, generation)) return;
        const current = findLive(nodeId);
        if (current) current.isLoading = false;
      },
    };
  }
}
