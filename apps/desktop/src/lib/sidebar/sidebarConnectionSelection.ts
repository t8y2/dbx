import type { TreeNode } from "@/types/database";

type ConnectionTreeNode = TreeNode & { connectionId: string };

export function isConnectionNode(node: TreeNode): node is ConnectionTreeNode {
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

export function selectedConnectionClipboardTargets(currentNode: TreeNode, selectedNodes: TreeNode[]): ConnectionTreeNode[] {
  return selectedConnectionActionTargets(currentNode, selectedNodes);
}

export function selectedConnectionEditTarget(currentNode: TreeNode, selectedNodes: TreeNode[]): ConnectionTreeNode | null {
  if (!isConnectionNode(currentNode)) return null;
  const selectedContainsCurrent = selectedNodes.some((node) => node.id === currentNode.id);
  if (selectedNodes.length > 1 && selectedContainsCurrent) return null;
  return currentNode;
}

export function selectedConnectionClipboardNodes(selectedNodes: TreeNode[]): ConnectionTreeNode[] {
  if (selectedNodes.length === 0 || !selectedNodes.every(isConnectionNode)) return [];
  return selectedNodes;
}

export function connectionPasteTargetGroupId(node: TreeNode | null | undefined, groupIdForConnection: (connectionId: string) => string | null): string | null {
  if (!node) return null;
  if (node.type === "connection-group") return node.id;
  if (isConnectionNode(node)) return groupIdForConnection(node.connectionId);
  return null;
}
