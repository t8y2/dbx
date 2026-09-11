import type { QueryTab, TreeNode } from "@/types/database";

/** A table reference emitted by the object browser's "Add to AI" action. */
export interface ObjectBrowserAiTableTarget {
  name: string;
  schema?: string;
}

/**
 * Converts object-browser table selections into the TreeNode[] shape that
 * App.vue's addToAi() consumes. Schema resolution mirrors the sidebar path,
 * which passes real tree nodes through as-is: the row's own schema, then the
 * tab's schema. The database name is deliberately NOT a schema fallback —
 * rows are already built with the engine-aware connectionObjectTreeNodeSchema()
 * (ObjectBrowser.vue), which applies the database-as-schema fallback for the
 * engines where that is correct (Oracle/Dameng/Hive family, sqlite) and keeps
 * schema undefined for schema-less engines (MySQL/MariaDB etc., whose tabs
 * also carry schema: undefined). Substituting the database name here would
 * break addToAi()'s tab matching for those engines, spawning a stray query
 * tab and clearing the accumulated AI context. The tab's catalog
 * (Doris/StarRocks external catalogs, etc.) is carried through so addToAi()
 * can locate the correct query context instead of falling back to a
 * catalog-less tab.
 */
export function objectBrowserTablesToAiTreeNodes(tab: QueryTab, tables: ObjectBrowserAiTableTarget[]): TreeNode[] {
  return tables.map((table) => {
    const schema = table.schema || tab.schema;
    return {
      id: `${tab.connectionId}:${tab.database}:${schema || ""}:${table.name}`,
      label: table.name,
      type: "table" as const,
      connectionId: tab.connectionId,
      database: tab.database,
      catalog: tab.catalog,
      schema,
    };
  });
}
