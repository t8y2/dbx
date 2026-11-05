import type { McpConnectionPolicy, McpGlobalPolicy } from "@/lib/backend/tauri";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";
import { buildMcpAccessTreeRows, type McpTreeConnectionRow } from "./mcpAccessTree";

export type McpDatabaseAccess = Pick<McpConnectionPolicy, "databaseScope" | "allowedDatabases" | "databasePolicies">;
export type McpDatabaseAccessPolicy = Pick<McpGlobalPolicy, "readOnly" | "allowDangerousSql" | "allowedConnectionIds" | "allowedGroupIds" | "connectionPolicies" | "groupPolicies">;

export function databaseAccess(rule?: McpDatabaseAccess): McpDatabaseAccess {
  const databaseScope = rule?.databaseScope ?? "all";
  const allowedDatabases = databaseScope === "selected" ? [...new Set(rule?.allowedDatabases ?? [])].sort() : [];
  const databasePolicies = (rule?.databasePolicies ?? [])
    .filter((entry) => allowedDatabases.includes(entry.databaseName))
    .map((entry) => ({ ...entry }))
    .sort((a, b) => a.databaseName.localeCompare(b.databaseName));
  return { databaseScope, allowedDatabases, databasePolicies };
}

export function databaseAccessEqual(left?: McpDatabaseAccess, right?: McpDatabaseAccess): boolean {
  return JSON.stringify(databaseAccess(left)) === JSON.stringify(databaseAccess(right));
}

export function databaseConnectionRow(policy: McpDatabaseAccessPolicy, id: string, layout: SidebarLayout, connections: readonly ConnectionConfig[]): McpTreeConnectionRow | undefined {
  return buildMcpAccessTreeRows(policy, layout, connections, { expandedGroupIds: new Set(layout.groups.map((group) => group.id)), expandedConnectionIds: new Set() }).find((row): row is McpTreeConnectionRow => row.type === "connection" && row.id === id);
}

/** Show legacy ceilings as their effective values before editing individual overrides. */
export function editableDatabaseAccess(policy: McpDatabaseAccessPolicy, id: string, layout: SidebarLayout, connections: readonly ConnectionConfig[]): McpDatabaseAccess {
  const rule = policy.connectionPolicies.find((entry) => entry.connectionId === id);
  const access = databaseAccess(rule);
  if (!rule || rule.executionModePolicyVersion === 1) return access;
  const rows = buildMcpAccessTreeRows(policy, layout, connections, { expandedGroupIds: new Set(layout.groups.map((group) => group.id)), expandedConnectionIds: new Set([id]) });
  access.databasePolicies = access.databasePolicies.map((entry) => {
    const row = rows.find((item) => item.type === "database" && item.connectionId === id && item.database === entry.databaseName);
    return row ? { ...entry, readOnly: row.effective === "read_only", allowDangerousSql: row.effective === "high_risk_write" } : entry;
  });
  return access;
}

/** Patch only one connection's database fields, preserving all unrelated settings. */
export function mergeDatabaseAccess(policy: McpDatabaseAccessPolicy, id: string, access: McpDatabaseAccess, layout: SidebarLayout, connections: readonly ConnectionConfig[]): McpConnectionPolicy[] {
  const existing = policy.connectionPolicies.find((entry) => entry.connectionId === id);
  const next: McpConnectionPolicy = {
    connectionId: id,
    readOnly: false,
    allowDangerousSql: false,
    executionModeConfigured: false,
    executionModePolicyVersion: 1,
    allowSalesforceDml: false,
    ...existing,
    ...databaseAccess(access),
  };
  if (existing && existing.executionModePolicyVersion !== 1) {
    // Upgrading a legacy ceiling must retain the effective *saved* connection
    // permission, never an unrelated pending global/group/connection edit.
    const row = databaseConnectionRow(policy, id, layout, connections);
    if (!row) throw new Error("Connection is unavailable");
    next.readOnly = row.effective === "read_only";
    next.allowDangerousSql = row.effective === "high_risk_write";
    next.executionModeConfigured = true;
    next.executionModePolicyVersion = 1;
    next.allowSalesforceDml = next.allowSalesforceDml && !next.readOnly;
  }
  const rules = [...policy.connectionPolicies];
  const index = rules.findIndex((entry) => entry.connectionId === id);
  const meaningful = next.executionModeConfigured || next.databaseScope !== "all" || next.databasePolicies.length > 0 || next.allowSalesforceDml;
  if (index >= 0) {
    if (meaningful) rules[index] = next;
    else rules.splice(index, 1);
  } else if (meaningful) rules.push(next);
  return rules.sort((left, right) => left.connectionId.localeCompare(right.connectionId));
}
