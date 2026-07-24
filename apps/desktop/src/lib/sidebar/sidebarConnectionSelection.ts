import type { TreeNode } from "@/types/database";
import { copyNameForTreeNode } from "@/lib/sidebar/treeNodeClick";

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

export function copySelectedConnectionsToClipboards(selectedNodes: TreeNode[], copyConnectionsToTreeClipboard: (connectionIds: string[]) => number, copyToSystemClipboard: (text: string) => Promise<void>): number {
  const connectionNodes = selectedConnectionClipboardNodes(selectedNodes);
  if (connectionNodes.length === 0) return 0;

  const copiedCount = copyConnectionsToTreeClipboard(connectionNodes.map((node) => node.connectionId));
  if (copiedCount > 0) {
    // Connection duplication uses the tree clipboard, so keep it available even if OS clipboard access is denied.
    void copyToSystemClipboard(connectionNodes.map(copyNameForTreeNode).join("\n")).catch(() => {});
  }
  return copiedCount;
}

export function connectionPasteTargetGroupId(node: TreeNode | null | undefined, groupIdForConnection: (connectionId: string) => string | null): string | null {
  if (!node) return null;
  if (node.type === "connection-group") return node.id;
  if (isConnectionNode(node)) return groupIdForConnection(node.connectionId);
  return null;
}
