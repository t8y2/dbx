import type { TreeNode } from "@/types/database";

const SQLSERVER_LINKED_SCHEMA_PREFIX = "__dbx_sqlserver_linked__:";

export interface SqlServerLinkedSchemaRef {
  server: string;
  catalog: string;
  schema: string;
}

export function encodeSqlServerLinkedSchema(ref: SqlServerLinkedSchemaRef): string {
  return `${SQLSERVER_LINKED_SCHEMA_PREFIX}${[ref.server, ref.catalog, ref.schema].map(encodeURIComponent).join("|")}`;
}

export function parseSqlServerLinkedSchema(schema: string | undefined): SqlServerLinkedSchemaRef | null {
  if (!schema?.startsWith(SQLSERVER_LINKED_SCHEMA_PREFIX)) return null;
  const parts = schema.slice(SQLSERVER_LINKED_SCHEMA_PREFIX.length).split("|").map(decodeURIComponent);
  if (parts.length !== 3 || parts.some((part) => !part.trim())) return null;
  return { server: parts[0], catalog: parts[1], schema: parts[2] };
}

export function isSqlServerLinkedNode(node: Pick<TreeNode, "linkedServer" | "linkedCatalog" | "linkedSchema" | "schema">): boolean {
  return !!node.linkedServer || !!node.linkedCatalog || !!node.linkedSchema || !!parseSqlServerLinkedSchema(node.schema);
}

export function sqlServerLinkedTableSchema(node: Pick<TreeNode, "linkedServer" | "linkedCatalog" | "linkedSchema">): string | undefined {
  if (!node.linkedServer || !node.linkedCatalog || !node.linkedSchema) return undefined;
  return encodeSqlServerLinkedSchema({
    server: node.linkedServer,
    catalog: node.linkedCatalog,
    schema: node.linkedSchema,
  });
}

export function quoteSqlServerIdentifier(name: string): string {
  return `[${name.replace(/\]/g, "]]")}]`;
}

export function sqlServerLinkedTableName(ref: SqlServerLinkedSchemaRef, tableName: string): string {
  return [ref.server, ref.catalog, ref.schema, tableName].map(quoteSqlServerIdentifier).join(".");
}
