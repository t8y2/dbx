import type { CompletionAssistantCandidate, DatabaseType, TreeNode, TreeNodeType } from "@/types/database";

export function markPackageNodesExpandable(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => (node.type === "package" ? { ...node, children: node.children ?? [] } : node));
}

function packageMemberGroup(packageNode: TreeNode, type: "procedure" | "function", children: TreeNode[]): TreeNode {
  const isProcedureGroup = type === "procedure";
  const groupType: TreeNodeType = isProcedureGroup ? "group-procedures" : "group-functions";
  return {
    id: `${packageNode.id}:members:${type}s`,
    label: isProcedureGroup ? "tree.procedures" : "tree.functions",
    type: groupType,
    objectName: packageNode.objectName || packageNode.label,
    parentName: packageNode.objectName || packageNode.label,
    parentSchema: packageNode.schema,
    parentType: "package",
    connectionId: packageNode.connectionId,
    database: packageNode.database,
    schema: packageNode.schema,
    objectCount: children.length,
    isExpanded: false,
    children,
  };
}

function packageMemberNode(packageNode: TreeNode, kind: "procedure" | "function", name: string, signature: string): TreeNode {
  return {
    id: `${packageNode.id}:member:${kind}:${name}:${signature}`,
    label: signature ? `${name}(${signature})` : name,
    type: kind,
    objectName: name,
    signature: signature || undefined,
    parentName: packageNode.objectName || packageNode.label,
    parentSchema: packageNode.schema,
    parentType: "package",
    valid: packageNode.valid,
    connectionId: packageNode.connectionId,
    database: packageNode.database,
    schema: packageNode.schema,
    isExpanded: false,
    children: undefined,
  };
}

export function buildPackageMemberNodes(packageNode: TreeNode, candidates: readonly CompletionAssistantCandidate[], databaseType?: DatabaseType): TreeNode[] {
  const seen = new Set<string>();
  const members: TreeNode[] = [];
  const procedures: TreeNode[] = [];
  const functions: TreeNode[] = [];

  for (const candidate of candidates) {
    if (candidate.kind !== "procedure" && candidate.kind !== "function") continue;
    const name = candidate.name.trim();
    if (!name) continue;
    const signature = candidate.signature?.trim() || "";
    const key = `${candidate.kind}\0${name}\0${signature}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const member = packageMemberNode(packageNode, candidate.kind, name, signature);
    members.push(member);
    if (candidate.kind === "procedure") procedures.push(member);
    else functions.push(member);
  }

  // Xugu presents package specifications and bodies as one logical package.
  // Keep the richer member folders scoped to Xugu so Oracle and other package
  // providers retain their existing flat member tree.
  if (databaseType !== "xugu") return members;

  const groups: TreeNode[] = [];
  if (procedures.length > 0) groups.push(packageMemberGroup(packageNode, "procedure", procedures));
  if (functions.length > 0) groups.push(packageMemberGroup(packageNode, "function", functions));
  return groups;
}
