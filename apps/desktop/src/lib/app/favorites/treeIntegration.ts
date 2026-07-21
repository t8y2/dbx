import type { TreeNode } from "@/types/database";
import { buildFavoritesPlaceholderNode, favoritesNodeParentId, isFavoritesPlaceholderNode } from "@/lib/table/tableTree";
import type { FavoritesController } from "@/lib/app/favorites/controller";

/** Ensure every database/schema in the tree has a favorites placeholder as
 *  its first child. Walks the tree in place and then calls the controller to
 *  populate the placeholders' children. */
export function ensureFavoritesPlaceholdersInTree(tree: TreeNode[], controller: FavoritesController): void {
  const visit = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "database" || node.type === "schema" || node.type === "linked-server-schema" || node.type === "doris-catalog") {
        ensurePlaceholderForParent(node);
      }
      if (node.children) visit(node.children);
      if (node.hiddenChildren) visit(node.hiddenChildren);
    }
  };
  visit(tree);
  refreshFavoritesPlaceholdersInTree(tree, controller);
}

/** Add a favorites placeholder to one parent (no-op if already present or
 *  the parent is not a database/schema). Mutates the children array in
 *  place. */
export function ensurePlaceholderForParent(parent: TreeNode): void {
  if (!parent.connectionId || parent.database === undefined) return;
  if (!parent.children) parent.children = [];
  if (parent.children.some(isFavoritesPlaceholderNode)) return;
  const placeholder = buildFavoritesPlaceholderNode({
    nodeId: parent.id,
    connectionId: parent.connectionId,
    database: parent.database,
    schema: parent.schema,
  });
  parent.children = [placeholder, ...parent.children];
}

/** Rebuild the children of every favorites placeholder under the supplied
 *  tree, reflecting the latest state from the controller. Used after
 *  favorite toggles and after tree rebuilds so the favorites group is
 *  always in sync with the structured state. */
export function refreshFavoritesPlaceholdersInTree(tree: TreeNode[], controller: FavoritesController): void {
  const updatedParents = new Set<string>();
  const visit = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (isFavoritesPlaceholderNode(node) && node.connectionId !== undefined && node.database !== undefined) {
        const next = controller.computePlaceholderChildren({
          connectionId: node.connectionId,
          database: node.database,
          schema: node.schema,
          parentId: node.id,
          sourceTree: tree,
        });
        node.children = next.children;
        node.objectCount = next.objectCount;
        const parentId = favoritesNodeParentId(node);
        if (parentId) updatedParents.add(parentId);
      }
      if (node.children) visit(node.children);
      if (node.hiddenChildren) visit(node.hiddenChildren);
    }
  };
  visit(tree);

  // Reposition the favorites node to stay at the top of its parent's children
  // (it is the first child created when the database is loaded). Without
  // this, expanding/loading siblings could bury it below the regular groups.
  for (const parentId of updatedParents) {
    const parent = findNode(tree, parentId);
    if (!parent?.children) continue;
    const favoritesIdx = parent.children.findIndex(isFavoritesPlaceholderNode);
    if (favoritesIdx > 0) {
      const [favoritesNode] = parent.children.splice(favoritesIdx, 1);
      if (favoritesNode) parent.children.unshift(favoritesNode);
    }
  }
}

function findNode(nodes: readonly TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findNode(node.children, id);
      if (found) return found;
    }
    if (node.hiddenChildren) {
      const found = findNode(node.hiddenChildren, id);
      if (found) return found;
    }
  }
  return undefined;
}
