import type { TreeNode } from "@/types/database";

type ConnectionTreeNode = TreeNode & { connectionId: string };

function isConnectionNode(node: TreeNode): node is ConnectionTreeNode {
  return node.type === "connection" && !!node.connectionId;
}

function selectedConnectionActionTargets(currentNode: TreeNode, selectedNodes: TreeNode[]): ConnectionTreeNode[] {
  if (!isConnectionNode(currentNode)) return [];
  const selectedContainsCurrent = selectedNodes.some((node) => node.id === currentNode.id);
  if (selectedNodes.length > 1 && selectedContainsCurrent && selectedNodes.every(isConnectionNode)) {
    return selectedNodes;
  }
  return [currentNode];
}

export function selectedConnectionDeleteTargets(currentNode: TreeNode, selectedNodes: TreeNode[]): ConnectionTreeNode[] {
  return selectedConnectionActionTargets(currentNode, selectedNodes);
}

export function selectedConnectionDuplicateTargets(currentNode: TreeNode, selectedNodes: TreeNode[]): ConnectionTreeNode[] {
  return selectedConnectionActionTargets(currentNode, selectedNodes);
}
