import type { ConnectionConfig, TreeNode } from "@/types/database";
import { connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";

/** Minimal surface area needed to drive a favorites placeholder's parent
 *  content load. The store implementation calls the real loaders; tests
 *  can swap in stubs to assert which loader was selected. */
export interface FavoritesParentLoaders {
  loadTables(connectionId: string, database: string, schema?: string): Promise<void>;
  loadSchemas(connectionId: string, database: string): Promise<void>;
  loadSqlServerDatabaseObjects(connectionId: string, database: string): Promise<void>;
  getConfig(connectionId: string): ConnectionConfig | undefined;
}

/** Decide which loader to call for the parent (database/schema) of a
 *  favorites placeholder. Mirrors the `database`/`schema` toggle path in
 *  `SidebarTreeRuntimeHost` so a first-time favorites expansion pulls the
 *  same content the user would have seen by clicking the parent itself. */
export function pickFavoritesParentLoader(node: Pick<TreeNode, "connectionId" | "database" | "schema">, loaders: FavoritesParentLoaders): (() => Promise<void>) | null {
  if (!node.connectionId || node.database === undefined) return null;
  if (node.schema) {
    return () => loaders.loadTables(node.connectionId as string, node.database as string, node.schema);
  }
  const config = loaders.getConfig(node.connectionId);
  const effectiveDbType = effectiveDatabaseTypeForConnection(config);
  if (config?.db_type === "sqlserver") {
    return () => loaders.loadSqlServerDatabaseObjects(node.connectionId as string, node.database as string);
  }
  if (usesTreeSchemaMode(effectiveDbType) && !connectionUsesDatabaseObjectTreeMode(config)) {
    return () => loaders.loadSchemas(node.connectionId as string, node.database as string);
  }
  return () => loaders.loadTables(node.connectionId as string, node.database as string);
}

/** Load the parent (database/schema) tree for a favorites placeholder.
 *  Mirrors the database-node toggle path so the very first time a user
 *  expands the placeholder (before they have ever expanded the underlying
 *  database), the favorites can resolve to real tables/views instead of
 *  rendering an empty list. */
export async function loadFavoritesParentContent(node: Pick<TreeNode, "connectionId" | "database" | "schema">, loaders: FavoritesParentLoaders): Promise<boolean> {
  const invoke = pickFavoritesParentLoader(node, loaders);
  if (!invoke) return false;
  await invoke();
  return true;
}
