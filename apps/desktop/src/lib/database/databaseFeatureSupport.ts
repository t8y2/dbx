import type { CatalogInfo, ConnectionConfig, DatabaseType, TreeNodeType } from "@/types/database";
import { supportsDatabaseFeature } from "@/lib/database/databaseDriverManifest";
import { canEditTableStructure } from "@/lib/table/tableStructureCapabilities";
import { CLEARABLE_QUERY_SCHEMA_TYPES, DATABASE_OBJECT_TREE_TYPES, DATABASE_SCHEMA_QUALIFIED_TYPES, FETCH_FIRST_TYPES, PG_LIKE_STRUCTURE_TYPES, PG_VACUUM_TYPES, SCHEMA_AWARE_TYPES, SINGLE_DATABASE_TYPES, TREE_SCHEMA_TYPES } from "@/lib/database/databaseCapabilitySets";
import { supportsRegisteredConnectionScopedQueryExecution, supportsRegisteredQueryTargetDatabaseListing, usesRegisteredConnectionOnlyQueryTarget } from "@/lib/database/sqlExecutionTargetRegistry";

export function isSchemaAware(dbType?: DatabaseType): boolean {
  return !!dbType && SCHEMA_AWARE_TYPES.has(dbType);
}

export function supportsDatabaseSchemaQualifier(dbType?: DatabaseType): boolean {
  return !!dbType && DATABASE_SCHEMA_QUALIFIED_TYPES.has(dbType);
}

export function supportsDatabaseNameCompletion(dbType?: DatabaseType): boolean {
  return !!dbType && ((!isSchemaAware(dbType) && !isSingleDatabase(dbType)) || dbType === "sqlserver");
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

/**
 * Keep the catalog grouping layer whenever SHOW CATALOGS exposes an external
 * catalog. A single visible external catalog still carries namespace
 * information that cannot be represented by the flat database tree.
 */
export function shouldShowDorisCatalogTree(catalogs: readonly CatalogInfo[]): boolean {
  return catalogs.some((catalog) => !isInternalDorisCatalog(catalog.catalog_type, catalog.name));
}

export function usesTreeSchemaMode(dbType?: DatabaseType): boolean {
  return !!dbType && TREE_SCHEMA_TYPES.has(dbType);
}

export function canConfigureVisibleSchemasForTreeNode(dbType: DatabaseType | undefined, nodeType: TreeNodeType, database?: string | null): boolean {
  if (!isSchemaAware(dbType)) return false;
  if (nodeType === "database") return database != null;
  return nodeType === "connection" && !usesTreeSchemaMode(dbType);
}

export function usesDatabaseObjectTreeMode(dbType?: DatabaseType): boolean {
  return !!dbType && DATABASE_OBJECT_TREE_TYPES.has(dbType);
}

export function databaseObjectTreeQuerySchema(dbType: DatabaseType | undefined, database: string, schema?: string): string {
  if (usesDatabaseObjectTreeMode(dbType)) return "";
  return schema || database;
}

/**
 * Cloud Spanner is the one schema-aware type whose default schema is the empty string: that is the
 * literal name of GoogleSQL's user schema, and the agent forwards it to the driver verbatim. Every
 * `schema || database` fallback therefore has to be bypassed, because `database` holds a resource
 * path (`projects/…/databases/db`) that is never a schema name and matches no metadata.
 *
 * Named schemas (Spanner 2024+) pass through unchanged. Callers that already collapsed
 * `schema || node.database` are normalized back to the blank schema, which is safe because a Spanner
 * schema identifier is letters, digits and underscores and can never contain the path separator.
 */
export function spannerObjectTreeSchema(schema?: string): string {
  return schema && !schema.includes("/") ? schema : "";
}

/**
 * Whether a schema tree node carries a name its children can be loaded for. Cloud Spanner is the one
 * type where the empty string is a real schema name (GoogleSQL's user schema), so a plain truthiness
 * check would leave that node expandable but permanently empty. Every other type keeps the
 * truthiness test, which also filters the undefined schema on nodes that have no schema level.
 */
export function schemaNodeHasLoadableName(dbType: DatabaseType | undefined, schema?: string): boolean {
  return dbType === "spanner" ? schema != null : !!schema;
}

export function databaseObjectTreeNodeSchema(dbType: DatabaseType | undefined, database: string, schema?: string): string | undefined {
  if (usesDatabaseObjectTreeMode(dbType)) return undefined;
  if (dbType === "spanner") return spannerObjectTreeSchema(schema);
  if (schema) return schema;
  return isSchemaAware(dbType) ? database : undefined;
}

export function isSingleDatabase(dbType?: DatabaseType): boolean {
  return !!dbType && SINGLE_DATABASE_TYPES.has(dbType);
}

export function supportsClearableQuerySchema(dbType?: DatabaseType): boolean {
  return !!dbType && CLEARABLE_QUERY_SCHEMA_TYPES.has(dbType);
}

export function supportsConnectionQueryActions(dbType?: DatabaseType): boolean {
  return dbType !== "nacos" && dbType !== "consul" && dbType !== "hbase";
}

/**
 * Whether the current product surface exposes a query execution path for the
 * database type. This is intentionally distinct from sqlFileExecution:
 * document/vector/key-value editors can execute commands from a query tab
 * even when importing a SQL file is not supported.
 */
export function supportsQueryExecution(dbType?: DatabaseType): boolean {
  return supportsDatabaseFeature(dbType, "queryExecution");
}

/**
 * The AI assistant currently builds its context from database/table metadata.
 * Connection-only query targets (for example etcd and ZooKeeper) do not expose
 * that hierarchy, so they must not be offered by sidebar "Add to AI" actions.
 */
export function supportsAiAssistantContext(dbType?: DatabaseType): boolean {
  return supportsQueryExecution(dbType) && !usesConnectionOnlyQueryTarget(dbType);
}

export function supportsConnectionScopedQueryExecution(dbType?: DatabaseType): boolean {
  return supportsRegisteredConnectionScopedQueryExecution(dbType);
}

/**
 * Query surfaces whose target is the connection itself and which do not expose
 * a database namespace to select. Keep this separate from
 * supportsConnectionScopedQueryExecution: document/vector stores may execute
 * without a selected database while still exposing database-like namespaces
 * (for example indexes or collections) for browsing and target selection.
 */
export function usesConnectionOnlyQueryTarget(dbType?: DatabaseType): boolean {
  return usesRegisteredConnectionOnlyQueryTarget(dbType);
}

/**
 * Database-like namespaces exposed by connection-scoped document/vector
 * query surfaces. This is the extension point for drivers whose query target
 * is still selected from a database/index list rather than from SQL metadata.
 */
export function supportsQueryTargetDatabaseListing(dbType?: DatabaseType): boolean {
  return supportsRegisteredQueryTargetDatabaseListing(dbType);
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

export function supportsQueryEditorBlockComments(dbType?: DatabaseType): boolean {
  if (!dbType) return true;
  return supportsSqlFileExecution(dbType);
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

export function supportsConnectionDatabaseBrowser(dbType?: DatabaseType): boolean {
  // MongoDB reuses the object browser for collections, not the SQL database list.
  return supportsObjectBrowser(dbType) && dbType !== "mongodb";
}

export function supportsObjectBrowserTreeNode(dbType: DatabaseType | undefined, nodeType: TreeNodeType): boolean {
  if (!supportsObjectBrowser(dbType)) return false;
  if (dbType === "mongodb") return nodeType === "mongo-db";
  if (nodeType === "database" && usesDatabaseObjectTreeMode(dbType)) return true;
  if (nodeType === "database" && isSchemaAware(dbType) && dbType !== "sqlserver") return false;
  return nodeType === "database" || nodeType === "schema" || nodeType === "object-browser";
}

export function supportsTableTruncate(dbType?: DatabaseType): boolean {
  return !!dbType && dbType !== "impala" && dbType !== "sqlite" && dbType !== "rqlite" && dbType !== "turso" && dbType !== "cloudflare-d1" && dbType !== "duckdb" && dbType !== "influxdb" && dbType !== "victoriametrics" && dbType !== "manticoresearch";
}

export function supportsTableVacuum(dbType?: DatabaseType): boolean {
  return !!dbType && PG_VACUUM_TYPES.has(dbType);
}

export function usesPostgresLikeStructureCopy(dbType?: DatabaseType): boolean {
  return !!dbType && PG_LIKE_STRUCTURE_TYPES.has(dbType);
}

const TRANSACTION_SUPPORTED_TYPES: readonly string[] = ["postgres", "mysql", "oracle", "jdbc"];

/**
 * Returns true if the given database type supports explicit transaction control
 * (i.e. toggling between auto-commit and manual transaction mode via BEGIN/COMMIT).
 */
export function supportsTransaction(dbType?: string): boolean {
  return !!dbType && TRANSACTION_SUPPORTED_TYPES.includes(dbType);
}

/**
 * Default auto-commit mode when opening a query tab for the given database type.
 * Query tabs default to auto-commit; users can explicitly switch to manual transactions.
 *
 * When the user has configured `manual` as their default, manual mode only applies to
 * databases that actually support explicit transaction control — otherwise the tab is
 * forced back to auto-commit so it does not start in an unsupported state. (For
 * non-transaction databases, `queryStore` also forces auto-commit on first execution,
 * but that would leave the new tab's initial state misleading; gating here avoids that.)
 *
 * The `defaultMode` selector is the user-configured default (Settings > Editor);
 * it is supplied by the caller rather than read here so this module stays free of
 * any Pinia store dependency.
 */
export function defaultAutoCommitForDbType(dbType: string | undefined, defaultMode: "auto" | "manual" = "auto"): boolean {
  if (defaultMode !== "manual") return true;
  return !supportsTransaction(dbType);
}
