import type { DatabaseType, TreeNodeType } from "@/types/database";
import { supportsDatabaseFeature } from "@/lib/database/databaseDriverManifest";
import { canEditTableStructure } from "@/lib/table/tableStructureCapabilities";
import { DATABASE_OBJECT_TREE_TYPES, FETCH_FIRST_TYPES, PG_LIKE_STRUCTURE_TYPES, SCHEMA_AWARE_TYPES, SINGLE_DATABASE_TYPES, TREE_SCHEMA_TYPES } from "@/lib/database/databaseCapabilitySets";

export function isSchemaAware(dbType?: DatabaseType): boolean {
  return !!dbType && SCHEMA_AWARE_TYPES.has(dbType);
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
  return !!dbType && dbType !== "sqlite" && dbType !== "rqlite" && dbType !== "turso" && dbType !== "duckdb" && dbType !== "influxdb" && dbType !== "manticoresearch";
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
