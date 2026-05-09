import type { DatabaseInfo, TreeNode } from "@/types/database";

export function buildDatabaseTreeNodes(connectionId: string, databases: DatabaseInfo[]): TreeNode[] {
  return databases.map((db) => ({
    id: `${connectionId}:${db.name}`,
    label: db.name,
    type: "database" as const,
    connectionId,
    database: db.name,
    isExpanded: false,
    children: [],
  }));
}
