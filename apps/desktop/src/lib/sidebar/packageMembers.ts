import type { CompletionAssistantCandidate, TreeNode } from "@/types/database";

export function markPackageNodesExpandable(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => (node.type === "package" ? { ...node, children: node.children ?? [] } : node));
}

export function buildPackageMemberNodes(packageNode: TreeNode, candidates: readonly CompletionAssistantCandidate[]): TreeNode[] {
  const parentName = packageNode.objectName || packageNode.label;
  const parentSchema = packageNode.schema;
  const seen = new Set<string>();
  const children: TreeNode[] = [];

  for (const candidate of candidates) {
    if (candidate.kind !== "procedure" && candidate.kind !== "function") continue;
    const name = candidate.name.trim();
    if (!name) continue;
    const signature = candidate.signature?.trim() || "";
    const key = `${candidate.kind}\0${name}\0${signature}`;
    if (seen.has(key)) continue;
    seen.add(key);
    children.push({
      id: `${packageNode.id}:member:${candidate.kind}:${name}:${signature}`,
      label: signature ? `${name}(${signature})` : name,
      type: candidate.kind,
      objectName: name,
      signature: signature || undefined,
      parentName,
      parentSchema,
      parentType: "package",
      valid: packageNode.valid,
      connectionId: packageNode.connectionId,
      database: packageNode.database,
      schema: parentSchema,
      isExpanded: false,
      children: undefined,
    });
  }

  return children;
}
