import type { ConnectionConfig, DatabaseType, TreeNodeType } from "@/types/database";
import { supportsDatabaseFeature } from "@/lib/database/databaseDriverManifest";
import { canEditTableStructure } from "@/lib/table/tableStructureCapabilities";
import { DATABASE_OBJECT_TREE_TYPES, FETCH_FIRST_TYPES, PG_LIKE_STRUCTURE_TYPES, SCHEMA_AWARE_TYPES, SINGLE_DATABASE_TYPES, TREE_SCHEMA_TYPES } from "@/lib/database/databaseCapabilitySets";

export function isSchemaAware(dbType?: DatabaseType): boolean {
  return !!dbType && SCHEMA_AWARE_TYPES.has(dbType);
}

/**
 * Doris-family engines that support multi-catalog federation (`SHOW CATALOGS`):
 * Doris (incl. SelectDB) and StarRocks. Manticore Search shares the MySQL code
 * path but has no catalog concept, so it is excluded.
 */
export function isDorisFamilyCatalogCapable(dbType?: DatabaseType, driverProfile?: string | null): boolean {
  if (dbType === "doris" || dbType === "starrocks") return true;
  return driverProfile === "doris" || driverProfile === "selectdb" || driverProfile === "starrocks";
}

export function connectionIsDorisFamilyCatalogCapable(connection: Pick<ConnectionConfig, "db_type" | "driver_profile"> | undefined): boolean {
  if (!connection) return false;
  return isDorisFamilyCatalogCapable(connection.db_type, connection.driver_profile);
}

/**
 * Whether a Doris/StarRocks catalog is the engine's built-in (non-federated)
 * catalog. Doris names it `internal` (Type=`internal`); StarRocks names it
 * `default_catalog` (Type=`Internal`). The `catalogType` column is the
 * cross-engine signal, so it is matched case-insensitively, falling back to the
 * canonical Doris name `internal` when the type is absent (very old / proxied
 * deployments). Mirrors `CatalogInfo::is_internal` on the backend.
 */
export function isInternalDorisCatalog(catalogType?: string | null, catalogName?: string | null): boolean {
  const type = (catalogType ?? "").trim().toLowerCase();
  if (type) return type === "internal";
  return (catalogName ?? "").trim() === "internal";
}

export function usesTreeSchemaMode(dbType?: DatabaseType): boolean {
  return !!dbType && TREE_SCHEMA_TYPES.has(dbType);
}

export function usesDatabaseObjectTreeMode(dbType?: DatabaseType): boolean {
  return !!dbType && DATABASE_OBJECT_TREE_TYPES.has(dbType);
}

export function databaseObjectTreeQuerySchema(dbType: DatabaseType | undefined, database: string, schema?: string): string {
  if (usesDatabaseObjectTreeMode(dbType)) return "";
  return schema || database;
}

export function databaseObjectTreeNodeSchema(dbType: DatabaseType | undefined, database: string, schema?: string): string | undefined {
  if (usesDatabaseObjectTreeMode(dbType)) return undefined;
  if (schema) return schema;
  return isSchemaAware(dbType) ? database : undefined;
}

export function isSingleDatabase(dbType?: DatabaseType): boolean {
  return !!dbType && SINGLE_DATABASE_TYPES.has(dbType);
}

export function usesFetchFirst(dbType?: DatabaseType): boolean {
  return !!dbType && FETCH_FIRST_TYPES.has(dbType);
}

export function supportsSqlFileExecution(dbType?: DatabaseType): boolean {
  return supportsDatabaseFeature(dbType, "sqlFileExecution");
}

const NON_SQL_IN_LIST_PASTE_TYPES = new Set<DatabaseType>(["neo4j"]);

export function supportsSqlInListPaste(dbType?: DatabaseType): boolean {
  if (!dbType) return true;
  return supportsSqlFileExecution(dbType) && !NON_SQL_IN_LIST_PASTE_TYPES.has(dbType);
}

export function supportsSchemaDiagram(dbType?: DatabaseType): boolean {
  return supportsDatabaseFeature(dbType, "diagram");
}

export function supportsDatabaseSearch(dbType?: DatabaseType): boolean {
  return supportsDatabaseFeature(dbType, "schemaSearch");
}

export function supportsTableImport(dbType?: DatabaseType): boolean {
  return supportsDatabaseFeature(dbType, "tableImport");
}

export function supportsTableStructureEditing(dbType?: DatabaseType): boolean {
  return supportsDatabaseFeature(dbType, "tableStructureEdit") && canEditTableStructure(dbType);
}

export function supportsDatabaseCreation(dbType?: DatabaseType): boolean {
  return supportsDatabaseFeature(dbType, "databaseCreate");
}

export function supportsFieldLineage(dbType?: DatabaseType): boolean {
  return supportsDatabaseFeature(dbType, "fieldLineage");
}

export function supportsTransfer(dbType?: DatabaseType): boolean {
  return supportsDatabaseFeature(dbType, "dataTransfer");
}

export function supportsDriverManagement(dbType?: DatabaseType): boolean {
  return supportsDatabaseFeature(dbType, "driverManagement");
}

export function supportsObjectBrowser(dbType?: DatabaseType): boolean {
  return supportsDatabaseFeature(dbType, "objectBrowser");
}

export function supportsObjectBrowserTreeNode(dbType: DatabaseType | undefined, nodeType: TreeNodeType): boolean {
  if (!supportsObjectBrowser(dbType)) return false;
  if (nodeType === "database" && usesDatabaseObjectTreeMode(dbType)) return true;
  if (nodeType === "database" && isSchemaAware(dbType) && dbType !== "sqlserver") return false;
  return nodeType === "database" || nodeType === "schema" || nodeType === "object-browser";
}

export function supportsTableTruncate(dbType?: DatabaseType): boolean {
  return !!dbType && dbType !== "sqlite" && dbType !== "rqlite" && dbType !== "turso" && dbType !== "cloudflare-d1" && dbType !== "duckdb" && dbType !== "influxdb" && dbType !== "manticoresearch";
}

export function usesPostgresLikeStructureCopy(dbType?: DatabaseType): boolean {
  return !!dbType && PG_LIKE_STRUCTURE_TYPES.has(dbType);
}

const TRANSACTION_SUPPORTED_TYPES: readonly string[] = ["postgres", "mysql"];

/**
 * Returns true if the given database type supports explicit transaction control
 * (i.e. toggling between auto-commit and manual transaction mode via BEGIN/COMMIT).
 */
export function supportsTransaction(dbType?: string): boolean {
  return !!dbType && TRANSACTION_SUPPORTED_TYPES.includes(dbType);
}
