import type { TreeNode } from "@/types/database";
import type { SqlCompletionTable } from "@/lib/sql/sqlCompletion";

const TABLE_NODE_TYPES = new Set(["table", "view", "materialized_view"]);

export function completionSchemasFromTree(nodes: readonly TreeNode[], connectionId: string, database: string): string[] {
  const seen = new Set<string>();
  const schemas: string[] = [];
  visitTree(nodes, (node) => {
    if (node.connectionId !== connectionId || node.database !== database || node.type !== "schema" || !node.schema) return;
    const key = node.schema.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    schemas.push(node.schema);
  });
  return schemas;
}

export function completionTablesFromTree(nodes: readonly TreeNode[], connectionId: string, database: string, schema?: string, catalog?: string): SqlCompletionTable[] {
  const preferredSchema = schema?.toLowerCase();
  const preferredCatalog = catalog?.toLowerCase();
  const tables: SqlCompletionTable[] = [];
  visitTree(nodes, (node) => {
    if (node.connectionId !== connectionId || node.database !== database || !TABLE_NODE_TYPES.has(node.type)) return;
    // External catalogs can contain databases and tables with the same names as
    // the internal catalog. Keep the two metadata scopes isolated.
    if ((node.catalog?.toLowerCase() ?? undefined) !== preferredCatalog) return;
    if (preferredSchema && node.schema?.toLowerCase() !== preferredSchema) return;
    tables.push({
      name: node.tableName || node.label,
      catalog: node.catalog,
      schema: node.schema,
      type: node.type === "materialized_view" ? "materialized_view" : node.type === "view" ? "view" : "table",
    });
  });
  return dedupeCompletionTables(tables);
}

function visitTree(nodes: readonly TreeNode[], visit: (node: TreeNode) => void) {
  for (const node of nodes) {
    visit(node);
    if (node.children?.length) visitTree(node.children, visit);
    if (node.hiddenChildren?.length) visitTree(node.hiddenChildren, visit);
  }
}

function dedupeCompletionTables(tables: SqlCompletionTable[]): SqlCompletionTable[] {
  const seen = new Set<string>();
  const result: SqlCompletionTable[] = [];
  for (const table of tables) {
    const key = `${table.catalog ?? ""}.${table.schema ?? ""}.${table.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(table);
  }
  return result;
}
