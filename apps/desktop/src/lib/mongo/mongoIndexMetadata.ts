import type { TreeNode } from "@/types/database";

type MongoIndexMetadataStore = {
  treeNodes: TreeNode[];
  loadIndexes: (connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) => Promise<void>;
};

export type MongoIndexMetadataScope = {
  connectionId: string;
  database: string;
  collection: string;
};

export function findLoadedMongoIndexesGroup(nodes: readonly TreeNode[], scope: MongoIndexMetadataScope): TreeNode | undefined {
  const pending = [...nodes];
  const visited = new Set<TreeNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node.type === "group-indexes" && node.connectionId === scope.connectionId && node.database === scope.database && node.tableName === scope.collection) return node;
    pending.push(...(node.children ?? []), ...(node.hiddenChildren ?? []));
  }
  return undefined;
}

/** Refresh an existing sidebar index group without changing its expanded state. */
export async function refreshLoadedMongoIndexes(store: MongoIndexMetadataStore, scope: MongoIndexMetadataScope): Promise<boolean> {
  const group = findLoadedMongoIndexesGroup(store.treeNodes, scope);
  if (!group) return false;

  const wasExpanded = group.isExpanded;
  try {
    await store.loadIndexes(scope.connectionId, scope.database, scope.collection, group.schema, group.id, group.catalog);
  } finally {
    const currentGroup = findLoadedMongoIndexesGroup(store.treeNodes, scope);
    if (currentGroup) currentGroup.isExpanded = wasExpanded;
  }
  return true;
}
