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

/** Generation observer that does not claim a load or toggle isLoading. */
export type TreeNodeLoadEpoch = {
  isCurrent(): boolean;
};

export class TreeNodeLoadRegistry {
  private readonly generations = new Map<string, number>();
  private readonly cancellationGenerations = new Map<string, number>();

  begin(node: TreeNodeLike): TreeNodeLoadHandle {
    const generation = (this.generations.get(node.id) ?? 0) + 1;
    this.generations.set(node.id, generation);
    node.isLoading = true;
    return this.createHandle(node.id, generation, this.cancellationGenerations.get(node.id) ?? 0);
  }

  /** Snapshot the current generation without claiming ownership (no spinner). */
  observe(nodeId: string): TreeNodeLoadEpoch {
    // Register the id so later prefix invalidation (e.g. connection disconnect) can bump it
    // even when this node never called begin().
    if (!this.generations.has(nodeId)) {
      this.generations.set(nodeId, 0);
    }
    const generation = this.generations.get(nodeId)!;
    return {
      isCurrent: () => this.generations.get(nodeId) === generation,
    };
  }

  /** Bump every recorded generation under nodeId (inclusive), including pruned IDs. */
  invalidatePrefix(nodeId: string): void {
    // Always bump the prefix root, even when no load was recorded for it yet.
    this.generations.set(nodeId, (this.generations.get(nodeId) ?? 0) + 1);
    const prefix = `${nodeId}:`;
    for (const id of [...this.generations.keys()]) {
      if (id !== nodeId && id.startsWith(prefix)) {
        this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
      }
    }
  }

  /**
   * User cancellation is stronger than ordinary invalidation: a load waiting for
   * connection recovery must not reclaim ownership after its node was collapsed.
   */
  cancelPrefix(nodeId: string): void {
    const prefix = `${nodeId}:`;
    const affectedIds = new Set<string>([nodeId]);
    for (const id of this.generations.keys()) {
      if (id.startsWith(prefix)) affectedIds.add(id);
    }
    for (const id of affectedIds) {
      this.cancellationGenerations.set(id, (this.cancellationGenerations.get(id) ?? 0) + 1);
    }
    this.invalidatePrefix(nodeId);
  }

  /** Bump recorded generations for descendants only (not the parent load itself). */
  invalidateDescendants(parentId: string): void {
    const prefix = `${parentId}:`;
    for (const id of [...this.generations.keys()]) {
      if (id.startsWith(prefix)) {
        this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
      }
    }
  }

  /**
   * Invalidate all loads for a connection (including pruned node IDs) and clear sticky
   * spinners on surviving live nodes. Always prefix-bump first so removed IDs cannot stay current.
   */
  invalidateConnection(connectionId: string, root: TreeNodeLike | null): void {
    this.invalidatePrefix(connectionId);
    if (!root) return;
    const stack: TreeNodeLike[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      node.isLoading = false;
      if (node.children?.length) stack.push(...node.children);
    }
  }

  private isCurrent(nodeId: string, generation: number): boolean {
    return this.generations.get(nodeId) === generation;
  }

  private createHandle(nodeId: string, generation: number, cancellationGeneration: number): TreeNodeLoadHandle {
    const registry = this;
    return {
      nodeId,
      generation,
      isCurrent() {
        return registry.isCurrent(nodeId, generation);
      },
      reclaim(node: TreeNodeLike) {
        if (!registry.isCurrent(nodeId, generation) && (registry.cancellationGenerations.get(nodeId) ?? 0) !== cancellationGeneration) {
          return this;
        }
        if (node.id !== nodeId) {
          return registry.begin(node);
        }
        if (registry.isCurrent(nodeId, generation)) {
          node.isLoading = true;
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
