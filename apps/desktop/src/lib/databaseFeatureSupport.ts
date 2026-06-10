import type { DatabaseType, TreeNodeType } from "@/types/database";
import { canEditTableStructure } from "./tableStructureCapabilities";
import {
  AGENT_DRIVER_TYPES,
  CREATE_DATABASE_SUPPORTED_TYPES,
  DATABASE_SEARCH_SUPPORTED_TYPES,
  DATABASE_OBJECT_TREE_TYPES,
  DIAGRAM_SUPPORTED_TYPES,
  FETCH_FIRST_TYPES,
  FIELD_LINEAGE_SUPPORTED_TYPES,
  PG_LIKE_STRUCTURE_TYPES,
  SCHEMA_AWARE_TYPES,
  SINGLE_DATABASE_TYPES,
  SQL_FILE_UNSUPPORTED_TYPES,
  TABLE_IMPORT_SUPPORTED_TYPES,
  TRANSFER_SQL_TYPES,
  TREE_SCHEMA_TYPES,
} from "./databaseCapabilitySets";

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
  return !!dbType && !SQL_FILE_UNSUPPORTED_TYPES.has(dbType);
}

export function supportsSchemaDiagram(dbType?: DatabaseType): boolean {
  return !!dbType && DIAGRAM_SUPPORTED_TYPES.has(dbType);
}

export function supportsDatabaseSearch(dbType?: DatabaseType): boolean {
  return !!dbType && DATABASE_SEARCH_SUPPORTED_TYPES.has(dbType);
}

export function supportsTableImport(dbType?: DatabaseType): boolean {
  return !!dbType && TABLE_IMPORT_SUPPORTED_TYPES.has(dbType);
}

export function supportsTableStructureEditing(dbType?: DatabaseType): boolean {
  return canEditTableStructure(dbType);
}

export function supportsDatabaseCreation(dbType?: DatabaseType): boolean {
  return !!dbType && CREATE_DATABASE_SUPPORTED_TYPES.has(dbType);
}

export function supportsFieldLineage(dbType?: DatabaseType): boolean {
  return !!dbType && FIELD_LINEAGE_SUPPORTED_TYPES.has(dbType);
}

export function supportsTransfer(dbType?: DatabaseType): boolean {
  return !!dbType && TRANSFER_SQL_TYPES.has(dbType);
}

export function supportsDriverManagement(dbType?: DatabaseType): boolean {
  return !!dbType && AGENT_DRIVER_TYPES.has(dbType);
}

export function supportsObjectBrowser(dbType?: DatabaseType): boolean {
  return !!dbType && !["redis", "mongodb", "elasticsearch", "etcd"].includes(dbType);
}

export function supportsObjectBrowserTreeNode(dbType: DatabaseType | undefined, nodeType: TreeNodeType): boolean {
  if (!supportsObjectBrowser(dbType)) return false;
  if (nodeType === "database" && usesDatabaseObjectTreeMode(dbType)) return true;
  if (nodeType === "database" && isSchemaAware(dbType) && dbType !== "sqlserver") return false;
  return nodeType === "database" || nodeType === "schema" || nodeType === "object-browser";
}

export function supportsTableTruncate(dbType?: DatabaseType): boolean {
  return !!dbType && dbType !== "sqlite" && dbType !== "rqlite" && dbType !== "turso" && dbType !== "duckdb" && dbType !== "influxdb";
}

export function usesPostgresLikeStructureCopy(dbType?: DatabaseType): boolean {
  return !!dbType && PG_LIKE_STRUCTURE_TYPES.has(dbType);
}
