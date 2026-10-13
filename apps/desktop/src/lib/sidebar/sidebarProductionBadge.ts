import { productionContextForDatabase, productionDatabases } from "@/lib/database/productionSafety";
import type { ConnectionConfig, ProductionBadgeScope, TreeNode } from "@/types/database";

const productionObjectTypes: ReadonlySet<TreeNode["type"]> = new Set([
  "database",
  "schema",
  "redis-db",
  "mongo-db",
  "mq-tenant",
  "nacos-namespace",
  "consul-root",
  "table",
  "table-vgroup",
  "view",
  "materialized_view",
  "procedure",
  "function",
  "sequence",
  "synonym",
  "type",
  "package",
  "job",
  "extension",
  "event-trigger",
  "oracle-db-link",
  "mongo-collection",
  "dynamodb-table",
  "vector-collection",
  "elasticsearch-index",
]);

export function sidebarProductionBadgeScope(connection: ConnectionConfig | undefined): ProductionBadgeScope {
  const scope = connection?.production_badge_scope;
  return scope === "connection" || scope === "table" ? scope : "database";
}

export function showSidebarRowProductionBadge(node: Pick<TreeNode, "type" | "database">, connection: ConnectionConfig | undefined, stickyContext = false): boolean {
  if (stickyContext) return false;
  const scope = sidebarProductionBadgeScope(connection);
  const active = productionContextForDatabase(connection, node.database).active;
  // Connection-only display must still warn when just selected databases are
  // production; the safety scope remains limited to those databases.
  if (node.type === "connection") return active || (scope === "connection" && productionDatabases(connection).length > 0);
  return active && scope === "table" && productionObjectTypes.has(node.type);
}

export function showSidebarStickyProductionBadge(node: Pick<TreeNode, "database"> | undefined, connection: ConnectionConfig | undefined): boolean {
  // A fixed header is a navigation safety cue in every display scope.
  return !!node && productionContextForDatabase(connection, node.database).active;
}
