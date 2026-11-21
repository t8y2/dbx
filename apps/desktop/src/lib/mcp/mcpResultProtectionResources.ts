import { buildConnectionGroupIdPathMap } from "@/lib/sidebar/sidebarLayout";
import { resultProtectionScopeKey, type McpResultProtectionPolicy, type ResultProtectionScope } from "@/lib/mcp/mcpResultProtection";
import type { ConnectionConfig, SidebarLayout, SidebarOrderEntry } from "@/types/database";

export type ResultProtectionConnection = Pick<ConnectionConfig, "id" | "name" | "db_type"> & Partial<Pick<ConnectionConfig, "driver_profile" | "attached_databases" | "init_script" | "default_schema">>;
export interface ResultProtectionResource {
  key: string;
  scope: ResultProtectionScope;
  name: string;
  pathNames: string[];
  groupIds: string[];
  depth: number;
  active: boolean;
}
export interface ResultProtectionResourceInput {
  layout: SidebarLayout;
  connections: readonly ResultProtectionConnection[];
  allowedConnectionIds: readonly string[] | null;
  allowedGroupIds: readonly string[];
  connectionPolicies: readonly { connectionId: string; databaseScope: "all" | "selected" | "none"; allowedDatabases: readonly string[] }[];
  policy: McpResultProtectionPolicy;
  databases: Readonly<Record<string, readonly string[]>>;
}

export function supportsResultProtectionDatabaseScope(connection: Pick<ResultProtectionConnection, "db_type" | "driver_profile" | "attached_databases" | "init_script" | "default_schema">): boolean {
  if (connection.init_script?.trim()) return false;
  const profile = connection.driver_profile?.toLowerCase();
  if (connection.db_type === "mysql") return !["doris", "starrocks", "manticoresearch", "selectdb", "oceanbase"].includes(profile ?? "");
  if (connection.db_type === "postgres") return true;
  if (connection.db_type === "sqlserver") return profile !== "sqlserver-legacy";
  if (connection.db_type === "sqlite") return !connection.attached_databases?.length && (!connection.default_schema || connection.default_schema.toLowerCase() === "main");
  return false;
}

export function buildResultProtectionResources(input: ResultProtectionResourceInput): ResultProtectionResource[] {
  const groupNames = new Map(input.layout.groups.map((group) => [group.id, group.name]));
  const connectionPaths = buildConnectionGroupIdPathMap(input.layout);
  const groupPaths = new Map<string, string[]>();
  const collectGroups = (entries: SidebarOrderEntry[], parent: string[]) => {
    for (const entry of entries) {
      if (entry.type !== "group" || groupPaths.has(entry.id)) continue;
      const path = [...parent, entry.id];
      groupPaths.set(entry.id, path);
      collectGroups(entry.children ?? (entry.connectionIds ?? []).map((id) => ({ type: "connection", id })), path);
    }
  };
  collectGroups(input.layout.order, []);
  const allowed = (id: string) => input.allowedConnectionIds === null || input.allowedConnectionIds.includes(id) || (connectionPaths.get(id) ?? []).some((groupId) => input.allowedGroupIds.includes(groupId));
  const activeGroups = new Set<string>();
  for (const [id, path] of groupPaths) {
    if (input.allowedConnectionIds === null || path.some((groupId) => input.allowedGroupIds.includes(groupId))) path.forEach((groupId) => activeGroups.add(groupId));
    if (input.allowedGroupIds.includes(id)) path.forEach((groupId) => activeGroups.add(groupId));
  }
  for (const connection of input.connections) if (allowed(connection.id)) (connectionPaths.get(connection.id) ?? []).forEach((id) => activeGroups.add(id));
  const retainedGroups = new Set((input.policy.groupOverrides ?? []).map((override) => override.groupId));
  const retainedConnections = new Set(input.policy.overrides.map((override) => override.connectionId));
  const visibleGroups = new Set(activeGroups);
  for (const id of retainedGroups) (groupPaths.get(id) ?? [id]).forEach((groupId) => visibleGroups.add(groupId));
  for (const id of retainedConnections) (connectionPaths.get(id) ?? []).forEach((groupId) => visibleGroups.add(groupId));
  const rows: ResultProtectionResource[] = [];
  const seen = new Set<string>();
  const append = (scope: ResultProtectionScope, name: string, pathNames: string[], groupIds: string[], depth: number, active: boolean) => {
    const key = resultProtectionScopeKey(scope);
    if (!seen.has(key)) rows.push({ key, scope, name, pathNames, groupIds, depth, active });
    seen.add(key);
  };
  append({ kind: "global" }, "", [], [], 0, true);
  const appendConnection = (id: string) => {
    const connection = input.connections.find((item) => item.id === id);
    const active = Boolean(connection && allowed(id));
    if (!active && !retainedConnections.has(id)) return;
    const path = connectionPaths.get(id) ?? [];
    const names = [...path.map((groupId) => groupNames.get(groupId) ?? groupId), connection?.name ?? id];
    append({ kind: "connection", connectionId: id }, connection?.name ?? id, names, path, path.length, active);
    const permission = input.connectionPolicies.find((item) => item.connectionId === id);
    const supported = Boolean(connection && supportsResultProtectionDatabaseScope(connection));
    const databaseAllowed = (database: string) => active && supported && permission?.databaseScope !== "none" && (permission?.databaseScope !== "selected" || permission.allowedDatabases.includes(database)) && (connection?.db_type !== "sqlite" || database === "main");
    const existing = input.policy.overrides.filter((scope) => scope.connectionId === id && scope.database !== null).map((scope) => scope.database!);
    const actual = connection?.db_type === "sqlite" && supported ? ["main"] : (input.databases[id] ?? []);
    const databases = [...new Set([...actual.filter(databaseAllowed), ...existing])].sort((a, b) => a.localeCompare(b));
    for (const database of databases) append({ kind: "database", connectionId: id, database }, database, [...names, database], path, path.length + 1, databaseAllowed(database));
  };
  const visit = (entries: SidebarOrderEntry[]) => {
    for (const entry of entries) {
      if (entry.type === "connection") appendConnection(entry.id);
      else if (visibleGroups.has(entry.id)) {
        const path = groupPaths.get(entry.id) ?? [entry.id];
        append(
          { kind: "group", groupId: entry.id },
          groupNames.get(entry.id) ?? entry.id,
          path.map((id) => groupNames.get(id) ?? id),
          path,
          path.length - 1,
          activeGroups.has(entry.id),
        );
        visit(entry.children ?? (entry.connectionIds ?? []).map((id) => ({ type: "connection", id })));
      }
    }
  };
  visit(input.layout.order);
  for (const connection of input.connections) appendConnection(connection.id);
  for (const id of retainedConnections) appendConnection(id);
  for (const id of retainedGroups) if (!seen.has(resultProtectionScopeKey({ kind: "group", groupId: id }))) append({ kind: "group", groupId: id }, groupNames.get(id) ?? id, [groupNames.get(id) ?? id], [id], 0, false);
  return rows;
}
