import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { normalizeSqliteNamespace } from "@/lib/database/sqliteNamespace";
import { metricRangeQuery, qualifiedTableName } from "@/lib/table/tableSelectSql";
import type { ConnectionConfig, DatabaseType, QueryTab, TreeNode } from "@/types/database";

export interface NewQueryTarget {
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  shouldRefreshDefaultDatabase: boolean;
}

export type NewQueryContextSource = "tab" | "sidebar";

interface ResolveNewQueryTargetInput {
  activeTab?: Pick<QueryTab, "connectionId" | "database" | "schema" | "catalog" | "objectBrowser" | "tableMeta">;
  selectedTreeNode?: Pick<TreeNode, "connectionId" | "database" | "schema" | "catalog"> | null;
  activeConnectionId?: string | null;
  connections: Pick<ConnectionConfig, "id" | "host" | "database" | "default_schema" | "db_type">[];
  preferredSource?: NewQueryContextSource;
}

export function findTreeNodeById(nodes: TreeNode[], id: string | null | undefined): TreeNode | null {
  if (!id) return null;
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findTreeNodeById(node.children || [], id);
    if (found) return found;
  }
  return null;
}

export function resolveNewQueryTarget(input: ResolveNewQueryTargetInput): NewQueryTarget | null {
  const primaryContext = input.preferredSource === "sidebar" ? input.selectedTreeNode || undefined : input.activeTab;
  const secondaryContext = input.preferredSource === "sidebar" ? input.activeTab : input.selectedTreeNode || undefined;
  const primaryTarget = targetFromContext(primaryContext, input.connections);
  if (primaryTarget) return primaryTarget;
  const secondaryTarget = targetFromContext(secondaryContext, input.connections);
  if (secondaryTarget) return secondaryTarget;

  const activeConnection = input.activeConnectionId ? input.connections.find((connection) => connection.id === input.activeConnectionId) : undefined;
  const fallbackConnection = activeConnection || input.connections[0];
  return fallbackConnection
    ? {
        connectionId: fallbackConnection.id,
        database: resolveDefaultDatabase(fallbackConnection, []),
        schema: fallbackConnection.default_schema,
        shouldRefreshDefaultDatabase: true,
      }
    : null;
}

function targetFromContext(
  context: Pick<QueryTab, "connectionId" | "database" | "schema" | "catalog" | "objectBrowser" | "tableMeta"> | Pick<TreeNode, "connectionId" | "database" | "schema" | "catalog"> | undefined,
  connections: Pick<ConnectionConfig, "id" | "host" | "database" | "default_schema" | "db_type">[],
): NewQueryTarget | null {
  if (!context?.connectionId) return null;
  const connection = connections.find((item) => item.id === context.connectionId);
  if (!connection) return null;
  const contextDatabase = context.database || resolveDefaultDatabase(connection, []);
  const database = connection.db_type === "sqlite" ? normalizeSqliteNamespace(contextDatabase, connection) : contextDatabase;
  const objectBrowser = "objectBrowser" in context ? context.objectBrowser : undefined;
  const tableMeta = "tableMeta" in context ? context.tableMeta : undefined;
  return {
    connectionId: context.connectionId,
    database,
    schema: context.schema ?? objectBrowser?.schema ?? tableMeta?.schema ?? connection.default_schema,
    catalog: context.catalog ?? objectBrowser?.catalog ?? tableMeta?.catalog,
    shouldRefreshDefaultDatabase: !context.database,
  };
}

export interface NewQueryTable {
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  tableName: string;
}

export interface ResolveNewQueryTableInput {
  activeTab?: Pick<QueryTab, "mode" | "connectionId" | "database" | "schema" | "catalog" | "tableMeta" | "structureTableName" | "title"> | null;
  selectedTreeNode?: Pick<TreeNode, "type" | "connectionId" | "database" | "schema" | "catalog" | "tableName" | "label"> | null;
  preferredSource?: NewQueryContextSource;
}

export interface ResolveNewQueryInitialSqlInput extends ResolveNewQueryTableInput {
  prefillEnabled: boolean;
  targetConnectionId: string;
  targetDatabase: string;
  databaseType?: DatabaseType;
}

// Database types whose "table" view does not use standard SQL `SELECT * FROM <table>`
// (e.g. Neo4j uses Cypher). The new-query prefill is skipped for these.
const NEW_QUERY_PREFILL_DISABLED_TYPES: ReadonlySet<DatabaseType | undefined> = new Set<DatabaseType | undefined>(["neo4j"]);

export function isNewQueryPrefillSupported(databaseType: DatabaseType | undefined): boolean {
  return !NEW_QUERY_PREFILL_DISABLED_TYPES.has(databaseType);
}

function tableFromTab(tab: ResolveNewQueryTableInput["activeTab"]): NewQueryTable | null {
  if (!tab?.connectionId) return null;
  if (tab.mode === "data") {
    // Require the loaded tableMeta: a data tab's title is schema/catalog-qualified
    // (e.g. "public.users"), so using it as a bare table name while tableMeta is
    // still loading or errored would yield an invalid double-qualified reference.
    const meta = tab.tableMeta;
    const tableName = meta?.tableName?.trim();
    if (!tableName) return null;
    return { connectionId: tab.connectionId, database: tab.database, schema: meta?.schema ?? tab.schema, catalog: meta?.catalog, tableName };
  }
  if (tab.mode === "structure") {
    const tableName = (tab.structureTableName || "").trim();
    if (!tableName) return null;
    return { connectionId: tab.connectionId, database: tab.database, schema: tab.schema, catalog: tab.catalog, tableName };
  }
  return null;
}

function tableFromNode(node: ResolveNewQueryTableInput["selectedTreeNode"]): NewQueryTable | null {
  if (!node?.connectionId) return null;
  if (node.type !== "table" && node.type !== "view" && node.type !== "materialized_view") return null;
  const tableName = (node.tableName || node.label || "").trim();
  if (!tableName) return null;
  return { connectionId: node.connectionId, database: node.database || "", schema: node.schema, catalog: node.catalog, tableName };
}

/**
 * Resolves the "focused table" for a new query, mirroring the primary/secondary
 * selection of {@link resolveNewQueryTarget}: when `preferredSource` is `"sidebar"`
 * the selected tree node wins, otherwise the active tab wins; the other is the
 * fallback. Returns null when no table context is available.
 */
export function resolveNewQueryTable(input: ResolveNewQueryTableInput): NewQueryTable | null {
  const tabFirst = input.preferredSource !== "sidebar";
  const primary = tabFirst ? tableFromTab(input.activeTab) : tableFromNode(input.selectedTreeNode);
  if (primary) return primary;
  return tabFirst ? tableFromNode(input.selectedTreeNode) : tableFromTab(input.activeTab);
}

/**
 * Builds a `SELECT * FROM <table>` statement for the new-query prefill, reusing
 * the same per-dialect identifier quoting and schema/catalog qualification used
 * by the table-data view.
 */
export function buildSelectAllSql(databaseType: DatabaseType | undefined, table: Pick<NewQueryTable, "schema" | "catalog" | "tableName"> & Partial<Pick<NewQueryTable, "database">>): string {
  if (databaseType === "victoriametrics") return metricRangeQuery(table.tableName);
  const ref = qualifiedTableName({ databaseType, database: table.database, schema: table.schema, catalog: table.catalog, tableName: table.tableName });
  return `SELECT * FROM ${ref}`;
}

/**
 * Resolves the optional initial SQL for a new query tab. A table from another
 * connection or database is intentionally ignored because it cannot safely run
 * in the execution context selected for the new tab.
 */
export function resolveNewQueryInitialSql(input: ResolveNewQueryInitialSqlInput): string | undefined {
  if (!input.prefillEnabled || !isNewQueryPrefillSupported(input.databaseType)) return undefined;

  const table = resolveNewQueryTable(input);
  if (!table || table.connectionId !== input.targetConnectionId || table.database !== input.targetDatabase) return undefined;

  return buildSelectAllSql(input.databaseType, table);
}
