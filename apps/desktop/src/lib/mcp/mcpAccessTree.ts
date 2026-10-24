import type { McpConnectionPolicy, McpGlobalPolicy, McpGroupPolicy } from "@/lib/backend/tauri";
import type { ConnectionConfig, SidebarLayout, SidebarOrderEntry } from "@/types/database";

/**
 * View model of the MCP access-control tree: the sidebar's groups and
 * connections, plus the databases a connection has rules for, each with its
 * own setting, its effective level and where that level comes from. Pure, so
 * the inheritance rules can be tested without the settings dialog; the
 * component only renders rows and forwards edits.
 *
 * Inheritance (mirrors `dbx_core::mcp_access` and the v1 server rules):
 * database > connection > closest group > ancestor group > global default.
 */

export type McpTreeLevel = "read_only" | "safe_write" | "high_risk_write";
export type McpTreeSetting = McpTreeLevel | "inherit";
export type McpTreeVisibility = "visible" | "hidden";

export type McpTreeSource = { kind: "global" } | { kind: "group"; groupId: string; groupName: string } | { kind: "connection" } | { kind: "database" };

interface McpTreeRowBase {
  key: string;
  depth: number;
  /** The resource is admitted directly or through a group/global scope. */
  visible: boolean;
  effective: McpTreeLevel;
  source: McpTreeSource;
  setting: McpTreeSetting;
}

export interface McpTreeGroupRow extends McpTreeRowBase {
  type: "group";
  id: string;
  name: string;
  pathIds: string[];
  /** Explicitly selected under a custom connection scope. */
  selected: boolean;
  /** Admitted by a selected ancestor group. */
  coveredBy: string | null;
  connectionCount: number;
  /** Actual visible descendants, including individually selected connections. */
  visibleConnectionCount: number;
  childCount: number;
}

export interface McpTreeConnectionRow extends McpTreeRowBase {
  type: "connection";
  id: string;
  connection: ConnectionConfig;
  pathIds: string[];
  selected: boolean;
  coveredBy: string | null;
  databaseScope: McpConnectionPolicy["databaseScope"];
  /** Databases with a rule (listed under a `selected` scope). */
  databaseCount: number;
  /** Rule saved before connection rules carried a version (a ceiling, not an override). */
  legacy: boolean;
  salesforceDml: boolean;
}

export interface McpTreeDatabaseRow extends McpTreeRowBase {
  type: "database";
  connectionId: string;
  database: string;
}

export type McpTreeRow = McpTreeGroupRow | McpTreeConnectionRow | McpTreeDatabaseRow;

type ScopeFields = Pick<McpGlobalPolicy, "readOnly" | "allowDangerousSql" | "allowedConnectionIds" | "allowedGroupIds" | "connectionPolicies" | "groupPolicies">;

const RANK: Record<McpTreeLevel, number> = { read_only: 0, safe_write: 1, high_risk_write: 2 };

export function mcpTreeLevelFromFlags(readOnly: boolean, allowDangerousSql: boolean): McpTreeLevel {
  if (readOnly) return "read_only";
  return allowDangerousSql ? "high_risk_write" : "safe_write";
}

function stricter(left: McpTreeLevel, right: McpTreeLevel): McpTreeLevel {
  return RANK[left] <= RANK[right] ? left : right;
}

function groupSetting(policy: McpGroupPolicy | undefined): McpTreeSetting {
  return policy ? mcpTreeLevelFromFlags(policy.readOnly, policy.allowDangerousSql) : "inherit";
}

function connectionSetting(policy: McpConnectionPolicy | undefined): McpTreeSetting {
  if (!policy || !policy.executionModeConfigured) return "inherit";
  return mcpTreeLevelFromFlags(policy.readOnly, policy.allowDangerousSql);
}

interface TreeGroupNode {
  type: "group";
  id: string;
  name: string;
  pathIds: string[];
  children: TreeNode[];
}

interface TreeConnectionNode {
  type: "connection";
  connection: ConnectionConfig;
  pathIds: string[];
}

type TreeNode = TreeGroupNode | TreeConnectionNode;

function entryChildren(entry: Extract<SidebarOrderEntry, { type: "group" }>): SidebarOrderEntry[] {
  return entry.children ?? entry.connectionIds?.map((id) => ({ type: "connection" as const, id })) ?? [];
}

/** Sidebar order as a tree; connections missing from the layout are appended at the root. */
export function buildMcpResourceTree(layout: SidebarLayout, connections: readonly ConnectionConfig[]): TreeNode[] {
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const groupNames = new Map(layout.groups.map((group) => [group.id, group.name]));
  const seenConnections = new Set<string>();
  const seenGroups = new Set<string>();
  const build = (entries: SidebarOrderEntry[], pathIds: string[]): TreeNode[] =>
    entries.flatMap((entry): TreeNode[] => {
      if (entry.type === "connection") {
        const connection = byId.get(entry.id);
        if (!connection || seenConnections.has(entry.id)) return [];
        seenConnections.add(entry.id);
        return [{ type: "connection", connection, pathIds }];
      }
      const name = groupNames.get(entry.id);
      if (!name || seenGroups.has(entry.id)) return [];
      seenGroups.add(entry.id);
      const nextPath = [...pathIds, entry.id];
      return [{ type: "group", id: entry.id, name, pathIds: nextPath, children: build(entryChildren(entry), nextPath) }];
    });
  const nodes = build(layout.order, []);
  for (const connection of connections) {
    if (!seenConnections.has(connection.id)) nodes.push({ type: "connection", connection, pathIds: [] });
  }
  return nodes;
}

export interface McpAccessTreeOptions {
  /** Group ids whose children are shown. */
  expandedGroupIds: ReadonlySet<string>;
  /** Connection ids whose database rows are shown. */
  expandedConnectionIds: ReadonlySet<string>;
  /** Free-text filter; matching rows keep their ancestors and are expanded. */
  query?: string;
  /** Only rows that carry a setting (and their ancestors). */
  exceptionsOnly?: boolean;
  /** Connections with immediately saved product/plugin scope rules. */
  scopeExceptionIds?: ReadonlySet<string>;
}

/** Flattens the tree into rows in display order, with effective levels resolved. */
export function buildMcpAccessTreeRows(policy: ScopeFields, layout: SidebarLayout, connections: readonly ConnectionConfig[], options: McpAccessTreeOptions): McpTreeRow[] {
  const globalLevel = mcpTreeLevelFromFlags(policy.readOnly, policy.allowDangerousSql);
  const groupPolicies = new Map(policy.groupPolicies.map((rule) => [rule.groupId, rule]));
  const connectionPolicies = new Map(policy.connectionPolicies.map((rule) => [rule.connectionId, rule]));
  const customScope = policy.allowedConnectionIds !== null;
  const selectedGroups = new Set(policy.allowedGroupIds);
  const selectedConnections = new Set(policy.allowedConnectionIds ?? []);
  const groupNames = new Map(layout.groups.map((group) => [group.id, group.name]));
  const query = options.query?.trim().toLocaleLowerCase() ?? "";

  const inherited = (pathIds: string[]): { level: McpTreeLevel; source: McpTreeSource } => {
    let result: { level: McpTreeLevel; source: McpTreeSource } = { level: globalLevel, source: { kind: "global" } };
    for (const groupId of pathIds) {
      const setting = groupSetting(groupPolicies.get(groupId));
      if (setting !== "inherit") result = { level: setting, source: { kind: "group", groupId, groupName: groupNames.get(groupId) ?? groupId } };
    }
    return result;
  };
  const coveringGroup = (pathIds: string[]) => [...pathIds].reverse().find((id) => selectedGroups.has(id)) ?? null;
  const connectionVisible = (node: TreeConnectionNode) => !customScope || selectedConnections.has(node.connection.id) || coveringGroup(node.pathIds) !== null;

  // Summarize the complete tree before expanding or filtering rows. A group's
  // grant includes future connections, whereas individually visible children do
  // not: keep this aggregate separate from the group's own `visible` flag.
  const tree = buildMcpResourceTree(layout, connections);
  const groupCounts = new Map<string, { total: number; visible: number }>();
  const summarize = (nodes: TreeNode[]): { total: number; visible: number } => {
    const counts = { total: 0, visible: 0 };
    for (const node of nodes) {
      if (node.type === "connection") {
        counts.total++;
        if (connectionVisible(node)) counts.visible++;
      } else {
        const children = summarize(node.children);
        groupCounts.set(node.id, children);
        counts.total += children.total;
        counts.visible += children.visible;
      }
    }
    return counts;
  };
  summarize(tree);

  const connectionRows = (node: TreeConnectionNode, depth: number): McpTreeRow[] => {
    const { connection } = node;
    const rule = connectionPolicies.get(connection.id);
    const setting = connectionSetting(rule);
    const legacy = Boolean(rule && rule.executionModePolicyVersion !== 1);
    const parent = inherited(node.pathIds);
    let effective = parent.level;
    let source = parent.source;
    if (setting !== "inherit") {
      // Legacy rules are ceilings: never wider than what the connection inherits.
      effective = legacy ? stricter(setting, parent.level) : setting;
      source = { kind: "connection" };
    }
    const coveredBy = coveringGroup(node.pathIds);
    const selected = selectedConnections.has(connection.id);
    const visible = connectionVisible(node);
    const databaseScope = rule?.databaseScope ?? "all";
    const databases = databaseScope === "selected" ? (rule?.allowedDatabases ?? []) : [];
    const row: McpTreeConnectionRow = {
      type: "connection",
      key: `connection:${connection.id}`,
      id: connection.id,
      connection,
      pathIds: node.pathIds,
      depth,
      visible,
      effective,
      source,
      setting,
      selected,
      coveredBy,
      databaseScope,
      databaseCount: databases.length,
      legacy,
      salesforceDml: Boolean(rule?.allowSalesforceDml && !rule.readOnly),
    };
    if (!options.expandedConnectionIds.has(connection.id) && !query && !options.exceptionsOnly) return [row];
    const databaseRows = databases.map((database): McpTreeDatabaseRow => {
      const databaseRule = rule?.databasePolicies.find((item) => item.databaseName === database);
      const databaseSetting: McpTreeSetting = databaseRule ? mcpTreeLevelFromFlags(databaseRule.readOnly, databaseRule.allowDangerousSql) : "inherit";
      const databaseEffective = databaseSetting === "inherit" ? effective : legacy ? stricter(databaseSetting, effective) : databaseSetting;
      return {
        type: "database",
        key: `database:${connection.id}:${database}`,
        connectionId: connection.id,
        database,
        depth: depth + 1,
        visible,
        effective: databaseEffective,
        source: databaseSetting === "inherit" ? source : { kind: "database" },
        setting: databaseSetting,
      };
    });
    return [row, ...databaseRows];
  };

  const visit = (nodes: TreeNode[], depth: number): McpTreeRow[] =>
    nodes.flatMap((node): McpTreeRow[] => {
      if (node.type === "connection") return connectionRows(node, depth);
      const setting = groupSetting(groupPolicies.get(node.id));
      const parent = inherited(node.pathIds.slice(0, -1));
      const coveredBy = coveringGroup(node.pathIds.slice(0, -1));
      const selected = selectedGroups.has(node.id);
      const counts = groupCounts.get(node.id)!;
      const row: McpTreeGroupRow = {
        type: "group",
        key: `group:${node.id}`,
        id: node.id,
        name: node.name,
        pathIds: node.pathIds,
        depth,
        visible: !customScope || selected || coveredBy !== null,
        effective: setting === "inherit" ? parent.level : setting,
        source: setting === "inherit" ? parent.source : { kind: "group", groupId: node.id, groupName: node.name },
        setting,
        selected,
        coveredBy,
        connectionCount: counts.total,
        visibleConnectionCount: counts.visible,
        childCount: node.children.length,
      };
      if (!options.expandedGroupIds.has(node.id) && !query && !options.exceptionsOnly) return [row];
      return [row, ...visit(node.children, depth + 1)];
    });

  let rows = visit(tree, 0);
  if (query) rows = keepMatchingWithAncestors(rows, (row) => mcpTreeRowText(row).includes(query));
  if (options.exceptionsOnly) rows = keepMatchingWithAncestors(rows, (row) => mcpTreeRowHasException(row) || (row.type === "connection" && Boolean(options.scopeExceptionIds?.has(row.id))));
  return rows;
}

export function mcpTreeRowText(row: McpTreeRow): string {
  if (row.type === "group") return row.name.toLocaleLowerCase();
  if (row.type === "database") return row.database.toLocaleLowerCase();
  const { connection } = row;
  return [connection.name, connection.db_type, connection.host, connection.database].filter(Boolean).join(" ").toLocaleLowerCase();
}

/** A row carries its own setting (not merely inherited). */
export function mcpTreeRowHasException(row: McpTreeRow): boolean {
  if (row.setting !== "inherit") return true;
  if (row.type === "connection") return row.databaseScope !== "all" || row.salesforceDml;
  return false;
}

/** Keeps matching rows plus every ancestor row (by depth), preserving order. */
function keepMatchingWithAncestors(rows: McpTreeRow[], matches: (row: McpTreeRow) => boolean): McpTreeRow[] {
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (!matches(row)) return;
    keep.add(index);
    let depth = row.depth;
    for (let parent = index - 1; parent >= 0 && depth > 0; parent -= 1) {
      if (rows[parent].depth < depth) {
        keep.add(parent);
        depth = rows[parent].depth;
      }
    }
  });
  return rows.filter((_, index) => keep.has(index));
}

/** Number of rows with their own settings, for the summary line. */
export function countMcpTreeExceptions(policy: ScopeFields, scopeExceptionIds: ReadonlySet<string> = new Set()): { groups: number; connections: number; databases: number } {
  return {
    groups: policy.groupPolicies.length,
    connections: new Set([...scopeExceptionIds, ...policy.connectionPolicies.filter((rule) => rule.executionModeConfigured || rule.databaseScope !== "all" || rule.allowSalesforceDml).map((rule) => rule.connectionId)]).size,
    databases: policy.connectionPolicies.reduce((total, rule) => total + rule.databasePolicies.length, 0),
  };
}
