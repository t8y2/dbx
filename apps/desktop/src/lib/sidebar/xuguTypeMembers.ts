import type { CompletionAssistantCandidate, TreeNode } from "@/types/database";

export function isXuguTypeMemberContainer(node: TreeNode, databaseType?: string): boolean {
  return databaseType === "xugu" && node.type === "type" && node.xuguTypeMembersExpandable === true && !!node.connectionId && !!node.database;
}

export function buildXuguTypeMemberNodes(typeNode: TreeNode, candidates: readonly CompletionAssistantCandidate[]): TreeNode[] {
  const parentName = typeNode.objectName || typeNode.label;
  const parentSchema = typeNode.schema;
  const seen = new Set<string>();
  const attributes: TreeNode[] = [];
  const methods: TreeNode[] = [];

  for (const candidate of candidates) {
    const name = candidate.name.trim();
    if (!name || (candidate.kind !== "column" && candidate.kind !== "procedure" && candidate.kind !== "function")) continue;
    const signature = candidate.signature?.trim() || "";
    const dataType = candidate.data_type?.trim() || "";
    const key = `${candidate.kind}\0${name}\0${signature}\0${dataType}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const base = {
      connectionId: typeNode.connectionId,
      database: typeNode.database,
      schema: parentSchema,
      parentName,
      parentSchema,
      parentType: "type" as const,
      isExpanded: false,
      children: undefined,
    };
    if (candidate.kind === "column") {
      attributes.push({
        ...base,
        id: `${typeNode.id}:attribute:${name}`,
        label: dataType ? `${name} (${dataType})` : name,
        type: "type-attribute",
        objectName: name,
      });
      continue;
    }

    const call = `${name}(${signature})`;
    const label = candidate.kind === "function" ? `FUNCTION ${call}${dataType ? ` → ${dataType}` : ""}` : `PROCEDURE ${call}`;
    methods.push({
      ...base,
      id: `${typeNode.id}:method:${candidate.kind}:${name}:${signature}`,
      label,
      type: "type-method",
      objectName: name,
      signature: signature || undefined,
    });
  }

  return [...attributes, ...methods];
}
