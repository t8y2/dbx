import type { ConnectionConfig, DatabaseInfo, TreeNode } from "@/types/database";
import { DEFAULT_DATABASE_TREE_LABEL } from "./treeNodeContext";

const sidebarNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function shouldIncludeDefaultDatabaseNode(connection: Pick<ConnectionConfig, "db_type"> | undefined, databases: DatabaseInfo[]): boolean {
  return connection?.db_type === "mysql" && databases.some((database) => !database.name.trim());
}

export function sortSidebarNames(names: readonly string[]): string[] {
  return [...names].sort((left, right) => sidebarNameCollator.compare(left, right));
}

export function sortSidebarDatabases(databases: readonly DatabaseInfo[]): DatabaseInfo[] {
  return [...databases].sort((left, right) => sidebarNameCollator.compare(left.name, right.name));
}

export function buildDatabaseTreeNodes(connectionId: string, databases: DatabaseInfo[], options: { includeDefaultWhenEmpty?: boolean } = {}): TreeNode[] {
  const nodes = sortSidebarDatabases(databases).flatMap((db) => {
    const name = db.name.trim();
    if (!name) return [];
    return [
      {
        id: `${connectionId}:${name}`,
        label: name,
        type: "database" as const,
        connectionId,
        database: name,
        isExpanded: false,
        children: [],
      },
    ];
  });

  if (nodes.length > 0 || !options.includeDefaultWhenEmpty) return nodes;

  return [
    {
      id: `${connectionId}:`,
      label: DEFAULT_DATABASE_TREE_LABEL,
      type: "database" as const,
      connectionId,
      database: "",
      isExpanded: false,
      children: [],
    },
  ];
}

export function buildDuckDbConnectionTreeNodes(connectionId: string, databases: DatabaseInfo[], primarySchemas: string[]): TreeNode[] {
  const schemaNodes = sortSidebarNames(primarySchemas).flatMap((schema) => {
    const name = schema.trim();
    if (!name) return [];
    return [
      {
        id: `${connectionId}:main:${name}`,
        label: name,
        type: "schema" as const,
        connectionId,
        database: "main",
        schema: name,
        isExpanded: false,
        children: [],
      },
    ];
  });

  const attachedCatalogNodes = sortSidebarDatabases(databases).flatMap((db) => {
    const name = db.name.trim();
    if (!name || name === "main") return [];
    return [
      {
        id: `${connectionId}:${name}`,
        label: name,
        type: "database" as const,
        connectionId,
        database: name,
        isExpanded: false,
        children: [],
      },
    ];
  });

  return [...schemaNodes, ...attachedCatalogNodes];
}
