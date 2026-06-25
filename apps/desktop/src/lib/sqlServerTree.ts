import type { TreeNode } from "@/types/database";
import { sortSidebarNames } from "@/lib/databaseTree";

export const SQLSERVER_DEFAULT_SCHEMA = "dbo";

export function buildSqlServerDatabaseTreeNodes(connectionId: string, database: string, schemas: string[]): TreeNode[] {
  const databaseNodeId = `${connectionId}:${database}`;
  return sortSidebarNames(schemas).map((schema) => ({
    id: `${databaseNodeId}:${schema}`,
    label: schema,
    type: "schema" as const,
    connectionId,
    database,
    schema,
    isExpanded: false,
    children: [],
  }));
}
