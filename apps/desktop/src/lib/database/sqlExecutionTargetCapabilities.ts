import type { ConnectionConfig, DatabaseType } from "@/types/database";
import type { MultiDbExecutionTarget } from "@/types/sqlExecution";
import { isSchemaAware, isSingleDatabase, supportsConnectionScopedQueryExecution, supportsQueryTargetDatabaseListing, usesConnectionOnlyQueryTarget } from "@/lib/database/databaseFeatureSupport";
import { supportsConnectionLevelSqlExecution } from "@/lib/connection/connectionLevelDatabaseBootstrap";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { supportsQueryExecution } from "@/lib/database/databaseFeatureSupport";
import { registeredSqlExecutionTargetAllowsEmptyMetadataDefault, registeredSqlExecutionTargetDefaultDatabase, resolveSqlExecutionTargetProvider, supportsRegisteredCatalogTarget, type SqlExecutionTargetProvider, type SqlExecutionTargetScope } from "@/lib/database/sqlExecutionTargetRegistry";

/**
 * Defaults that are part of the driver contract rather than values inferred
 * from a possibly incomplete metadata response. A configured connection
 * database is handled separately below and is also considered a stable
 * default for that connection.
 */
export interface SqlExecutionTargetCapabilities {
  databaseType: DatabaseType;
  scope: SqlExecutionTargetScope;
  provider: SqlExecutionTargetProvider;
  supportsCatalog: boolean;
  supportsDatabase: boolean;
  supportsSchema: boolean;
  /** Whether a database-like namespace is required to construct a target. */
  databaseRequired: boolean;
  /** Whether the namespace is enumerated by the existing metadata path. */
  databaseListable: boolean;
  /** Whether the connection itself is a valid fallback target. */
  connectionFallback: boolean;
  /** Whether an empty database is a valid target value for this scope. */
  allowsEmptyDatabaseTarget: boolean;
  /** Stable default used only before metadata has been loaded or by registered fallback rules. */
  defaultDatabase?: string;
  /** A loaded empty metadata list must not be widened to this fallback implicitly. */
  allowDefaultWhenDatabaseListEmpty: boolean;
}

/**
 * Resolves the target shape for every query-capable connection surface.
 *
 * This is the single extension point for multi-database target semantics. UI,
 * validation and persistence consumers should use this result instead of
 * maintaining database-type allow-lists of their own.
 */
export function sqlExecutionTargetCapabilities(connection: ConnectionConfig | undefined): SqlExecutionTargetCapabilities | undefined {
  const databaseType = effectiveDatabaseTypeForConnection(connection);
  if (!connection || !databaseType || !supportsQueryExecution(connection.db_type)) return undefined;

  const connectionOnly = usesConnectionOnlyQueryTarget(databaseType);
  const connectionScoped = supportsConnectionScopedQueryExecution(databaseType);
  const supportsCatalog = supportsRegisteredCatalogTarget(connection, databaseType);
  const supportsSchema = !connectionOnly && isSchemaAware(databaseType);
  const supportsDatabase = !connectionOnly;
  const databaseListable = !connectionOnly;
  const namespaceTarget = connectionScoped && !connectionOnly;
  const defaultDatabase = defaultExecutionTargetDatabase(connection, databaseType);
  const connectionLevelExecution = supportsConnectionLevelSqlExecution(connection);
  const hasStableDefault = defaultDatabase.length > 0 && (registeredSqlExecutionTargetAllowsEmptyMetadataDefault(databaseType) || !!connection.database?.trim());
  const scope: SqlExecutionTargetScope = connectionOnly ? "connection" : supportsCatalog ? "catalog" : namespaceTarget ? "namespace" : "database";

  return {
    databaseType,
    scope,
    provider: resolveSqlExecutionTargetProvider(scope, databaseType),
    supportsCatalog,
    supportsDatabase,
    supportsSchema,
    databaseRequired: connectionOnly ? false : namespaceTarget ? true : !isSingleDatabase(databaseType) && !connectionLevelExecution,
    databaseListable,
    connectionFallback: connectionOnly,
    allowsEmptyDatabaseTarget: connectionOnly || isSingleDatabase(databaseType),
    defaultDatabase,
    allowDefaultWhenDatabaseListEmpty: hasStableDefault,
  };
}

function defaultExecutionTargetDatabase(connection: ConnectionConfig, databaseType: DatabaseType): string {
  return registeredSqlExecutionTargetDefaultDatabase(connection, databaseType);
}

export function targetUsesConnectionOnlyScope(connection: ConnectionConfig | undefined): boolean {
  return sqlExecutionTargetCapabilities(connection)?.scope === "connection";
}

export function targetUsesNamespaceScope(connection: ConnectionConfig | undefined): boolean {
  return sqlExecutionTargetCapabilities(connection)?.scope === "namespace";
}

export function targetUsesConnectionFallback(connection: ConnectionConfig | undefined): boolean {
  return sqlExecutionTargetCapabilities(connection)?.connectionFallback === true;
}

export function targetAllowsEmptyDatabase(connection: ConnectionConfig | undefined): boolean {
  return sqlExecutionTargetCapabilities(connection)?.allowsEmptyDatabaseTarget === true;
}

/**
 * Normalizes a target at the boundary where it is created from a live
 * connection. This prevents an old tab namespace from leaking into a
 * connection-scoped target and makes all producers use the same shape.
 * Persisted targets are intentionally not silently normalized on load; they
 * must be validated and shown as invalid when their stored shape is stale.
 */
export function normalizeSqlExecutionTarget(connection: ConnectionConfig | undefined, target: MultiDbExecutionTarget): MultiDbExecutionTarget {
  const capabilities = sqlExecutionTargetCapabilities(connection);
  if (!capabilities) return { ...target };
  if (capabilities.scope === "connection") return { connectionId: target.connectionId, database: "" };
  return {
    connectionId: target.connectionId,
    database: capabilities.supportsDatabase ? target.database : "",
    ...(capabilities.supportsCatalog && target.catalog ? { catalog: target.catalog } : {}),
    ...(capabilities.supportsSchema && target.schema ? { schema: target.schema } : {}),
  };
}

export function targetIsSingleDatabase(connection: ConnectionConfig | undefined): boolean {
  const capabilities = sqlExecutionTargetCapabilities(connection);
  return capabilities ? isSingleDatabase(capabilities.databaseType) : false;
}

export function targetDefaultDatabase(connection: ConnectionConfig | undefined): string {
  return sqlExecutionTargetCapabilities(connection)?.defaultDatabase ?? "";
}

export function targetCanUseDefaultWhenDatabaseListEmpty(connection: ConnectionConfig | undefined): boolean {
  return sqlExecutionTargetCapabilities(connection)?.allowDefaultWhenDatabaseListEmpty === true;
}

export function targetDatabaseListIsRequired(connection: ConnectionConfig | undefined): boolean {
  const capabilities = sqlExecutionTargetCapabilities(connection);
  return !!capabilities?.databaseRequired;
}

export function targetDatabaseMetadataIsListable(connection: ConnectionConfig | undefined): boolean {
  return sqlExecutionTargetCapabilities(connection)?.databaseListable === true;
}

export function targetSupportsSchema(connection: ConnectionConfig | undefined): boolean {
  return sqlExecutionTargetCapabilities(connection)?.supportsSchema === true;
}

export function targetSupportsCatalog(connection: ConnectionConfig | undefined): boolean {
  return sqlExecutionTargetCapabilities(connection)?.supportsCatalog === true;
}

/**
 * Namespace lists are already backed by the existing database-options loader
 * for document/vector query surfaces. Keep this helper explicit so a future
 * target provider can register a different loader without changing consumers.
 */
export function targetNamespaceListIsRegistered(connection: ConnectionConfig | undefined): boolean {
  const databaseType = sqlExecutionTargetCapabilities(connection)?.databaseType;
  return !!databaseType && supportsQueryTargetDatabaseListing(databaseType);
}
