import { describe, expect, it } from "vitest";

import type { McpConnectionPolicy, McpGlobalPolicy } from "@/lib/backend/tauri";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";
import { buildMcpAccessTreeRows, countMcpTreeExceptions, mcpTreeRowHasException, type McpTreeConnectionRow, type McpTreeDatabaseRow, type McpTreeGroupRow } from "@/lib/mcp/mcpAccessTree";

function connection(id: string, dbType = "mysql"): ConnectionConfig {
  return { id, name: `${id}-name`, db_type: dbType, host: "127.0.0.1", port: 3306, username: "u", password: "" } as ConnectionConfig;
}

const layout: SidebarLayout = {
  groups: [
    { id: "prod", name: "Production", collapsed: false },
    { id: "eu", name: "EU", collapsed: false },
  ] as SidebarLayout["groups"],
  order: [
    {
      type: "group",
      id: "prod",
      children: [
        { type: "group", id: "eu", children: [{ type: "connection", id: "c1" }] },
        { type: "connection", id: "c2" },
      ],
    },
    { type: "connection", id: "c3" },
  ],
};

const connections = [connection("c1"), connection("c2"), connection("c3"), connection("orphan")];

function rule(patch: Partial<McpConnectionPolicy> & { connectionId: string }): McpConnectionPolicy {
  return { readOnly: false, allowDangerousSql: false, executionModeConfigured: false, executionModePolicyVersion: 1, databaseScope: "all", allowedDatabases: [], databasePolicies: [], allowSalesforceDml: false, ...patch };
}

function policy(patch: Partial<McpGlobalPolicy> = {}) {
  return { readOnly: true, allowDangerousSql: false, allowedConnectionIds: null, allowedGroupIds: [], connectionPolicies: [], groupPolicies: [], ...patch };
}

const expandAll = { expandedGroupIds: new Set(["prod", "eu"]), expandedConnectionIds: new Set(["c1", "c2", "c3"]) };

function rowsBy(rows: ReturnType<typeof buildMcpAccessTreeRows>) {
  return Object.fromEntries(rows.map((row) => [row.key, row]));
}

describe("MCP access tree", () => {
  it("lists sidebar order with orphans at the root and respects collapsed groups", () => {
    const collapsed = buildMcpAccessTreeRows(policy(), layout, connections, { expandedGroupIds: new Set(), expandedConnectionIds: new Set() });
    expect(collapsed.map((row) => row.key)).toEqual(["group:prod", "connection:c3", "connection:orphan"]);
    const expanded = buildMcpAccessTreeRows(policy(), layout, connections, expandAll);
    expect(expanded.map((row) => [row.key, row.depth])).toEqual([
      ["group:prod", 0],
      ["group:eu", 1],
      ["connection:c1", 2],
      ["connection:c2", 1],
      ["connection:c3", 0],
      ["connection:orphan", 0],
    ]);
    expect((expanded[0] as McpTreeGroupRow).connectionCount).toBe(2);
  });

  it("resolves database > connection > closest group > ancestor group > global", () => {
    const rows = rowsBy(
      buildMcpAccessTreeRows(
        policy({
          groupPolicies: [
            { groupId: "prod", readOnly: false, allowDangerousSql: false },
            { groupId: "eu", readOnly: false, allowDangerousSql: true },
          ],
          connectionPolicies: [rule({ connectionId: "c2", executionModeConfigured: true, readOnly: true }), rule({ connectionId: "c1", databaseScope: "selected", allowedDatabases: ["billing", "ops"], databasePolicies: [{ databaseName: "billing", readOnly: true, allowDangerousSql: false }] })],
        }),
        layout,
        connections,
        expandAll,
      ),
    );
    expect(rows["group:eu"]).toMatchObject({ effective: "high_risk_write", source: { kind: "group", groupId: "eu" } });
    expect(rows["connection:c1"]).toMatchObject({ effective: "high_risk_write", source: { kind: "group", groupId: "eu", groupName: "EU" }, setting: "inherit", databaseCount: 2 });
    expect(rows["database:c1:billing"]).toMatchObject({ effective: "read_only", source: { kind: "database" }, setting: "read_only" });
    expect((rows["database:c1:ops"] as McpTreeDatabaseRow).effective).toBe("high_risk_write");
    expect(rows["connection:c2"]).toMatchObject({ effective: "read_only", source: { kind: "connection" } });
    expect(rows["connection:c3"]).toMatchObject({ effective: "read_only", source: { kind: "global" } });
  });

  it("treats legacy connection rules as ceilings", () => {
    const rows = rowsBy(buildMcpAccessTreeRows(policy({ readOnly: false, allowDangerousSql: false, connectionPolicies: [rule({ connectionId: "c3", executionModeConfigured: true, allowDangerousSql: true, executionModePolicyVersion: null })] }), layout, connections, expandAll));
    const c3 = rows["connection:c3"] as McpTreeConnectionRow;
    expect(c3.legacy).toBe(true);
    expect(c3.effective).toBe("safe_write");
  });

  it("derives visibility from a custom connection scope", () => {
    const rows = rowsBy(buildMcpAccessTreeRows(policy({ allowedConnectionIds: ["c3"], allowedGroupIds: ["eu"] }), layout, connections, expandAll));
    expect(rows["group:prod"]).toMatchObject({ visible: false, visibleConnectionCount: 1, connectionCount: 2 });
    expect(rows["group:eu"]).toMatchObject({ visible: true, selected: true });
    expect(rows["connection:c1"]).toMatchObject({ visible: true, selected: false, coveredBy: "eu" });
    expect(rows["connection:c2"].visible).toBe(false);
    expect(rows["connection:c3"]).toMatchObject({ visible: true, selected: true, coveredBy: null });
    expect(rows["connection:orphan"].visible).toBe(false);
  });

  it.each([
    { allowedConnectionIds: ["c1"], allowedGroupIds: [], visible: 1 },
    { allowedConnectionIds: ["c1", "c2"], allowedGroupIds: [], visible: 2 },
    { allowedConnectionIds: [], allowedGroupIds: ["eu"], visible: 1 },
    { allowedConnectionIds: ["c1", "c1", "missing"], allowedGroupIds: ["eu"], visible: 1 },
    { allowedConnectionIds: [], allowedGroupIds: [], visible: 0 },
  ])("aggregates visible descendants without granting the parent: %j", ({ allowedConnectionIds, allowedGroupIds, visible }) => {
    const fields = policy({ allowedConnectionIds, allowedGroupIds });
    const before = JSON.stringify(fields);
    const collapsed = { expandedGroupIds: new Set<string>(), expandedConnectionIds: new Set<string>() };
    for (const options of [collapsed, expandAll, { ...collapsed, query: "c2-name" }]) {
      const rows = rowsBy(buildMcpAccessTreeRows(fields, layout, connections, options));
      expect(rows["group:prod"]).toMatchObject({ visible: false, selected: false, coveredBy: null, visibleConnectionCount: visible, connectionCount: 2 });
    }
    expect(JSON.stringify(fields)).toBe(before);
  });

  it("keeps full descendant counts when only one permission exception matches the filter", () => {
    const fields = policy({ allowedConnectionIds: ["c1"], connectionPolicies: [rule({ connectionId: "c2", executionModeConfigured: true })] });
    const rows = rowsBy(buildMcpAccessTreeRows(fields, layout, connections, { ...expandAll, exceptionsOnly: true }));
    expect(rows["group:prod"]).toMatchObject({ visible: false, connectionCount: 2, visibleConnectionCount: 1 });
    expect(rows["connection:c1"]).toBeUndefined();
    expect(rows["connection:c2"].visible).toBe(false);
  });

  it.each([policy(), policy({ allowedConnectionIds: [], allowedGroupIds: ["prod"] })])("counts global and ancestor grants without treating empty groups as partial", (fields) => {
    const withEmpty: SidebarLayout = { groups: [...layout.groups, { id: "empty", name: "Empty", collapsed: false }], order: [...layout.order, { type: "group", id: "empty", children: [] }] };
    const rows = rowsBy(buildMcpAccessTreeRows(fields, withEmpty, connections, expandAll));
    expect(rows["group:prod"]).toMatchObject({ visible: true, visibleConnectionCount: 2, connectionCount: 2 });
    expect(rows["group:eu"]).toMatchObject({ visible: true, visibleConnectionCount: 1, connectionCount: 1 });
    expect(rows["group:empty"]).toMatchObject({ visibleConnectionCount: 0, connectionCount: 0 });
  });

  it("applies group defaults to individually visible children without widening visibility", () => {
    const fields = policy({ allowedConnectionIds: ["c1"], groupPolicies: [{ groupId: "prod", readOnly: false, allowDangerousSql: false }] });
    const rows = rowsBy(buildMcpAccessTreeRows(fields, layout, connections, expandAll));
    expect(rows["group:prod"]).toMatchObject({ selected: false, visibleConnectionCount: 1, setting: "safe_write" });
    expect(rows["connection:c1"]).toMatchObject({ visible: true, effective: "safe_write", source: { kind: "group", groupId: "prod" } });
    expect(rows["connection:c2"].visible).toBe(false);
  });

  it("filters by text keeping ancestors and by exceptions only", () => {
    const searched = buildMcpAccessTreeRows(policy(), layout, connections, { expandedGroupIds: new Set(), expandedConnectionIds: new Set(), query: "c1-name" });
    expect(searched.map((row) => row.key)).toEqual(["group:prod", "group:eu", "connection:c1"]);
    const exceptions = buildMcpAccessTreeRows(policy({ connectionPolicies: [rule({ connectionId: "c2", allowSalesforceDml: true })] }), layout, connections, { ...expandAll, exceptionsOnly: true });
    expect(exceptions.map((row) => row.key)).toEqual(["group:prod", "connection:c2"]);
  });

  it("counts exceptions and flags rows with their own settings", () => {
    const fields = policy({
      groupPolicies: [{ groupId: "prod", readOnly: true, allowDangerousSql: false }],
      connectionPolicies: [rule({ connectionId: "c1", databaseScope: "selected", allowedDatabases: ["a"], databasePolicies: [{ databaseName: "a", readOnly: true, allowDangerousSql: false }] }), rule({ connectionId: "c2" })],
    });
    expect(countMcpTreeExceptions(fields)).toEqual({ groups: 1, connections: 1, databases: 1 });
    const rows = rowsBy(buildMcpAccessTreeRows(fields, layout, connections, expandAll));
    expect(mcpTreeRowHasException(rows["connection:c1"])).toBe(true);
    expect(mcpTreeRowHasException(rows["connection:c2"])).toBe(false);
  });
  it("reveals nested exceptions even when their groups and connections are collapsed", () => {
    const fields = policy({ connectionPolicies: [rule({ connectionId: "c1", databaseScope: "selected", allowedDatabases: ["app"], databasePolicies: [{ databaseName: "app", readOnly: false, allowDangerousSql: false }] })] });
    const collapsed = { expandedGroupIds: new Set<string>(), expandedConnectionIds: new Set<string>() };
    const rows = buildMcpAccessTreeRows(fields, layout, connections, { ...collapsed, exceptionsOnly: true });
    expect(rows.map((row) => row.key)).toEqual(["group:prod", "group:eu", "connection:c1", "database:c1:app"]);
    expect(buildMcpAccessTreeRows(fields, layout, connections, collapsed).map((row) => row.key)).toEqual(["group:prod", "connection:c3", "connection:orphan"]);
  });

  it("keeps legacy database ceilings when the connection itself inherits", () => {
    const rows = rowsBy(
      buildMcpAccessTreeRows(
        policy({ connectionPolicies: [rule({ connectionId: "c1", executionModeConfigured: false, executionModePolicyVersion: null, databaseScope: "selected", allowedDatabases: ["app"], databasePolicies: [{ databaseName: "app", readOnly: false, allowDangerousSql: true }] })] }),
        layout,
        connections,
        expandAll,
      ),
    );
    expect(rows["database:c1:app"].effective).toBe("read_only");
  });
});
