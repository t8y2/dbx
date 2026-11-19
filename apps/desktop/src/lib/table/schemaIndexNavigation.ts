import type { SchemaIndexIdentity, TreeNode } from "@/types/database";

/** Only dictionary fields identify an index and its table; never parse a label. */
export function schemaIndexIdentity(source: { schema?: string; name?: string; parentSchema?: string; parentName?: string }): SchemaIndexIdentity | null {
  const { schema, name, parentSchema, parentName } = source;
  if (!schema || !name || !parentSchema || !parentName) return null;
  return { schema, name, parentSchema, parentName };
}

export function schemaIndexNodeIdentity(node: TreeNode): SchemaIndexIdentity | null {
  return node.type === "index" && node.objectScope === "schema" ? schemaIndexIdentity({ ...node, name: node.objectName }) : null;
}

export function schemaIndexIsSameOwner(target: SchemaIndexIdentity | null): target is SchemaIndexIdentity {
  return target !== null && target.schema === target.parentSchema;
}
