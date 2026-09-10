import type { QueryTab, TreeNode } from "@/types/database";

/** A table reference emitted by the object browser's "Add to AI" action. */
export interface ObjectBrowserAiTableTarget {
  name: string;
  schema?: string;
}

/**
 * Converts object-browser table selections into the TreeNode[] shape that
 * App.vue's addToAi() consumes. Schema resolution uses the same fallback chain
 * the sidebar path relies on: the row's own schema, then the tab's schema,
 * then the database name as a last resort. The tab's catalog (Doris/StarRocks
 * external catalogs, etc.) is carried through so addToAi() can locate the
 * correct query context instead of falling back to a catalog-less tab.
 */
export function objectBrowserTablesToAiTreeNodes(tab: QueryTab, tables: ObjectBrowserAiTableTarget[]): TreeNode[] {
  return tables.map((table) => ({
    id: `${tab.connectionId}:${tab.database}:${table.schema || tab.schema || tab.database}:${table.name}`,
    label: table.name,
    type: "table" as const,
    connectionId: tab.connectionId,
    database: tab.database,
    catalog: tab.catalog,
    schema: table.schema || tab.schema || tab.database,
  }));
}
