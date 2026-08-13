import type { ConnectionConfig, DatabaseType } from "@/types/database";
import type { MultiDbExecutionTarget } from "@/types/sqlExecution";

export type SqlExecutionTargetScope = "catalog" | "database" | "namespace" | "connection";

export type SqlExecutionTargetListLevel = "catalog" | "database" | "schema";

export type SqlExecutionTargetContext = { scope: "catalog"; catalog?: string; database: string; schema?: string } | { scope: "database"; database: string; schema?: string } | { scope: "namespace"; namespaceKind: string; namespace: string } | { scope: "connection" };

export interface SqlExecutionTargetMetadataLoader {
  listCatalogs?: () => Promise<readonly string[]>;
  listDatabases?: (catalog?: string) => Promise<readonly string[]>;
  listSchemas?: (database: string) => Promise<readonly string[]>;
}

/**
 * The target provider is the common contract for target discovery, validation
 * and execution-context mapping. Metadata itself remains owned by the
 * existing composables; providers receive a narrow loader adapter so a new
 * target kind does not need to know about Vue stores or backend caches.
 */
export interface SqlExecutionTargetProvider {
  readonly id: string;
  readonly scope: SqlExecutionTargetScope;
  canListTargets(connection: ConnectionConfig): boolean;
  listTargets(connection: ConnectionConfig, request: { level: SqlExecutionTargetListLevel; catalog?: string; database?: string }, loader: SqlExecutionTargetMetadataLoader): Promise<readonly string[]>;
  validateTarget(target: MultiDbExecutionTarget, connection: ConnectionConfig): void | Promise<void>;
  toExecutionContext(target: MultiDbExecutionTarget, connection: ConnectionConfig): SqlExecutionTargetContext;
}

/**
 * Target-scope registration for query surfaces whose execution context is not
 * the ordinary database/schema hierarchy.
 *
 * Keep this registry independent from UI components, metadata loaders and the
 * executor. Adding a connection-scoped query driver should require one
 * registration here; consumers derive their behavior from the registered
 * scope instead of maintaining separate database-type lists.
 */
export type RegisteredSqlExecutionTargetScope = "namespace" | "connection";

interface SqlExecutionTargetRegistration {
  scope?: RegisteredSqlExecutionTargetScope;
  provider?: SqlExecutionTargetProvider;
  supportsCatalog?: boolean;
  /**
   * Returns a driver-defined stable namespace default, if one exists. This
   * is deliberately separate from connection.database, which is handled as
   * a per-connection default by the capability resolver.
   */
  defaultDatabase?: (connection: Pick<ConnectionConfig, "database" | "driver_profile">) => string;
  /** Whether the default remains valid when metadata enumeration is empty. */
  allowDefaultWhenDatabaseListEmpty?: boolean;
}

function optional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function providerError(message: string): never {
  throw new Error(message);
}

function createProvider(scope: SqlExecutionTargetScope): SqlExecutionTargetProvider {
  return {
    id: `builtin:${scope}`,
    scope,
    canListTargets: (connection) => scope !== "connection" && Boolean(connection.id),
    async listTargets(_connection, request, loader) {
      if (request.level === "catalog") return (await loader.listCatalogs?.()) ?? [];
      if (request.level === "database") return (await loader.listDatabases?.(request.catalog)) ?? [];
      return (await loader.listSchemas?.(request.database ?? "")) ?? [];
    },
    validateTarget(target, connection) {
      if (target.connectionId !== connection.id) providerError("Target connection does not match the selected connection.");
      if (scope === "connection") {
        if (target.database.trim() || target.catalog !== undefined || target.schema !== undefined) providerError("Connection-scoped targets cannot contain a database, catalog, or schema.");
        return;
      }
      if (scope !== "catalog" && target.catalog !== undefined) providerError("This target scope does not support catalogs.");
      if (scope !== "namespace" && target.schema !== undefined && typeof target.schema !== "string") providerError("Invalid target schema.");
      if (scope === "namespace" && !target.database.trim()) providerError("Namespace targets require a namespace.");
    },
    toExecutionContext(target, _connection) {
      if (scope === "connection") return { scope };
      if (scope === "namespace") return { scope, namespaceKind: "namespace", namespace: target.database };
      return {
        scope,
        ...(scope === "catalog" && target.catalog !== undefined ? { catalog: target.catalog } : {}),
        database: target.database,
        ...(target.schema !== undefined ? { schema: target.schema } : {}),
      };
    },
  };
}

const SQL_EXECUTION_TARGET_PROVIDERS: Record<SqlExecutionTargetScope, SqlExecutionTargetProvider> = {
  catalog: createProvider("catalog"),
  database: createProvider("database"),
  namespace: createProvider("namespace"),
  connection: createProvider("connection"),
};

const SQL_EXECUTION_TARGET_REGISTRY: Partial<Record<DatabaseType, SqlExecutionTargetRegistration>> = {
  // These query surfaces currently accept the target namespace in the SQL/REST
  // text itself, while the shared executeQuery boundary does not carry a
  // namespace context. Keep them connection-scoped until a driver provider can
  // safely apply a selected index/collection/database to the actual request.
  elasticsearch: { scope: "connection" },
  easysearch: { scope: "connection" },
  meilisearch: { scope: "connection" },
  qdrant: { scope: "connection" },
  milvus: { scope: "connection" },
  weaviate: { scope: "connection" },
  chromadb: { scope: "connection" },
  etcd: { scope: "connection" },
  zookeeper: { scope: "connection" },
  doris: { supportsCatalog: true },
  starrocks: { supportsCatalog: true },
  "cloudflare-d1": { defaultDatabase: () => "main", allowDefaultWhenDatabaseListEmpty: true },
  sqlite: { defaultDatabase: (connection) => connection.database?.trim() || "main", allowDefaultWhenDatabaseListEmpty: true },
  postgres: {
    defaultDatabase: (connection) => connection.database?.trim() || (connection.driver_profile === "cockroachdb" ? "defaultdb" : "postgres"),
    allowDefaultWhenDatabaseListEmpty: true,
  },
  victoriametrics: { defaultDatabase: (connection) => connection.database?.trim() || "metrics", allowDefaultWhenDatabaseListEmpty: true },
};

export function registeredSqlExecutionTargetScope(dbType?: DatabaseType): RegisteredSqlExecutionTargetScope | undefined {
  return dbType ? SQL_EXECUTION_TARGET_REGISTRY[dbType]?.scope : undefined;
}

export function supportsRegisteredConnectionScopedQueryExecution(dbType?: DatabaseType): boolean {
  return registeredSqlExecutionTargetScope(dbType) !== undefined;
}

export function usesRegisteredConnectionOnlyQueryTarget(dbType?: DatabaseType): boolean {
  return registeredSqlExecutionTargetScope(dbType) === "connection";
}

export function supportsRegisteredQueryTargetDatabaseListing(dbType?: DatabaseType): boolean {
  return registeredSqlExecutionTargetScope(dbType) === "namespace";
}

export function supportsRegisteredCatalogTarget(connection: Pick<ConnectionConfig, "db_type" | "driver_profile"> | undefined, dbType?: DatabaseType): boolean {
  if (!connection || !dbType) return false;
  return SQL_EXECUTION_TARGET_REGISTRY[dbType]?.supportsCatalog === true;
}

export function registeredSqlExecutionTargetDefaultDatabase(connection: Pick<ConnectionConfig, "database" | "driver_profile">, dbType: DatabaseType): string {
  return SQL_EXECUTION_TARGET_REGISTRY[dbType]?.defaultDatabase?.(connection) ?? connection.database?.trim() ?? "";
}

export function registeredSqlExecutionTargetAllowsEmptyMetadataDefault(dbType?: DatabaseType): boolean {
  return dbType ? SQL_EXECUTION_TARGET_REGISTRY[dbType]?.allowDefaultWhenDatabaseListEmpty === true : false;
}

export function resolveSqlExecutionTargetProvider(scope: SqlExecutionTargetScope, dbType?: DatabaseType): SqlExecutionTargetProvider {
  return (dbType ? SQL_EXECUTION_TARGET_REGISTRY[dbType]?.provider : undefined) ?? SQL_EXECUTION_TARGET_PROVIDERS[scope];
}

export function registeredSqlExecutionTargetNamespaceKind(dbType?: DatabaseType): string | undefined {
  return dbType && SQL_EXECUTION_TARGET_REGISTRY[dbType]?.scope === "namespace" ? "namespace" : undefined;
}

export function normalizeSqlExecutionTargetContext(context: SqlExecutionTargetContext): SqlExecutionTargetContext {
  if (context.scope === "connection") return { scope: "connection" };
  if (context.scope === "namespace") {
    return {
      scope: "namespace",
      namespaceKind: optional(context.namespaceKind) ?? "namespace",
      namespace: context.namespace?.trim() ?? "",
    };
  }
  return {
    scope: context.scope,
    ...(context.scope === "catalog" && context.catalog !== undefined ? { catalog: optional(context.catalog) } : {}),
    database: context.database.trim(),
    ...(context.schema !== undefined ? { schema: optional(context.schema) } : {}),
  };
}
