import type { ConnectionConfig, ObjectBrowserFilter, TreeNode } from "@/types/database";
import { connectionUsesVisibleSchemaFilter } from "@/lib/database/visibleDatabases";

export interface ObjectNavigatorTarget {
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  filter: ObjectBrowserFilter;
  selectedObjectName?: string;
}

const groupFilters: Partial<Record<TreeNode["type"], ObjectBrowserFilter>> = {
  "group-tables": "tables",
  "group-dolt-system-tables": "tables",
  "group-views": "views",
  "group-materialized-views": "materializedViews",
  "group-procedures": "procedures",
  "group-functions": "functions",
  "group-internal-functions": "functions",
  "group-udf-functions": "functions",
  "group-triggers": "triggers",
  "group-events": "events",
  "group-sequences": "sequences",
  "group-packages": "packages",
  "group-types": "types",
};

const objectFilters: Partial<Record<TreeNode["type"], ObjectBrowserFilter>> = {
  table: "tables",
  view: "views",
  materialized_view: "materializedViews",
  procedure: "procedures",
  function: "functions",
  trigger: "triggers",
  event: "events",
  sequence: "sequences",
  package: "packages",
  type: "types",
};

export function objectNavigatorTargetForTreeNode(node: TreeNode, connection?: Partial<ConnectionConfig>): ObjectNavigatorTarget | null {
  if (!node.connectionId) return null;
  if (node.type === "connection") return { connectionId: node.connectionId, database: "", filter: "all" };
  const database = node.schema && connectionUsesVisibleSchemaFilter(connection) ? connection?.database || node.database || "" : node.database || connection?.database || "";
  if (!database) return null;
  const base = { connectionId: node.connectionId, database, schema: node.schema, catalog: node.catalog };
  if (node.type === "database" || node.type === "schema" || node.type === "object-browser" || node.type === "mongo-db") {
    return { ...base, filter: "all" };
  }
  const groupFilter = groupFilters[node.type];
  if (groupFilter) return { ...base, filter: groupFilter };
  const objectFilter = objectFilters[node.type];
  if (objectFilter) return { ...base, filter: objectFilter, selectedObjectName: node.objectName || node.tableName || node.label };
  return null;
}
