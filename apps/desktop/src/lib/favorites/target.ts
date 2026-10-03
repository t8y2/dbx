import type { ConnectionConfig, TreeNode } from "@/types/database";
import type { FavoriteTarget, TableFavorite } from "@/types/favorites";
import { connectionObjectTreeNodeSchema, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { supportsDatabaseFeature } from "@/lib/database/databaseDriverManifest";
import { isSqlServerLinkedNode } from "@/lib/database/sqlServerLinkedServers";

export function favoriteTargetFromNode(node: TreeNode, config?: ConnectionConfig): FavoriteTarget | null {
  const type = effectiveDatabaseTypeForConnection(config);
  if (!config || !type || node.type !== "table" || !node.connectionId || node.database == null || isSqlServerLinkedNode(node)) return null;
  // These engines use their own object viewers, even where a node is called a table.
  if (["mongodb", "hbase", "redis", "cassandra", "neo4j", "elasticsearch", "meilisearch"].includes(type) || !supportsDatabaseFeature(type, "queryExecution")) return null;
  return {
    connectionId: node.connectionId,
    catalog: node.catalog || "",
    database: node.database,
    schema: connectionObjectTreeNodeSchema(config, node.database, node.schema) || "",
    objectType: "table",
    objectName: node.objectName || node.tableName || node.label,
  };
}

export function favoriteTargetKey(target: FavoriteTarget): string {
  return JSON.stringify([target.connectionId, target.catalog, target.database, target.schema, target.objectType, target.objectName]);
}

export function favoritePath(target: FavoriteTarget, connectionName?: string): string {
  return [connectionName || target.connectionId, target.catalog, target.database, target.schema, target.objectName].filter(Boolean).join(" / ");
}

const codeOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
export function sortFavorites(items: TableFavorite[]): TableFavorite[] {
  return [...items].sort((a, b) => codeOrder.compare(a.code, b.code) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
