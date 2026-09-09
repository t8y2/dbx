import { describe, expect, it } from "vitest";
import { createMcpResultProtectionPolicy } from "@/lib/mcp/mcpResultProtection";
import { buildResultProtectionResources, supportsResultProtectionDatabaseScope } from "@/lib/mcp/mcpResultProtectionResources";
import type { SidebarLayout } from "@/types/database";

const layout: SidebarLayout = {
  groups: [
    { id: "parent", name: "Production", collapsed: false },
    { id: "child", name: "Applications", collapsed: false },
  ],
  order: [{ type: "group", id: "parent", children: [{ type: "group", id: "child", children: [{ type: "connection", id: "inherited" }] }] }],
};
const connections = [
  { id: "inherited", name: "Inherited", db_type: "postgres" as const },
  { id: "excluded", name: "Excluded", db_type: "mysql" as const },
];

describe("result protection resources", () => {
  it("keeps global and nested authorized groups while excluding unauthorized connections", () => {
    const rows = buildResultProtectionResources({ layout, connections, allowedGroupIds: ["parent"], allowedConnectionIds: [], connectionPolicies: [], policy: createMcpResultProtectionPolicy(), databases: {} });
    expect(rows.map((row) => row.scope.kind)).toEqual(["global", "group", "group", "connection"]);
    expect(rows.at(-1)?.groupIds).toEqual(["parent", "child"]);
    expect(rows.some((row) => row.name === "Excluded")).toBe(false);
  });

  it("filters actual databases by authorization and preserves existing inactive scopes", () => {
    const policy = createMcpResultProtectionPolicy();
    policy.overrides = [
      { connectionId: "inherited", database: "old", settings: policy.default },
      { connectionId: "missing", database: null, settings: policy.default },
    ];
    const rows = buildResultProtectionResources({ layout, connections, allowedGroupIds: ["parent"], allowedConnectionIds: [], connectionPolicies: [{ connectionId: "inherited", databaseScope: "selected", allowedDatabases: ["app"] }], policy, databases: { inherited: ["app", "private", "old"] } });
    const databases = rows.filter((row) => row.scope.kind === "database");
    expect(databases.map((row) => [row.name, row.active])).toEqual([
      ["app", true],
      ["old", false],
    ]);
    expect(rows.find((row) => row.name === "missing")?.active).toBe(false);
    expect(policy.overrides).toHaveLength(2);
  });

  it("does not expose new database scopes for none authorization or unsupported engines", () => {
    const base = { layout, connections, allowedGroupIds: [], allowedConnectionIds: null, policy: createMcpResultProtectionPolicy(), databases: { inherited: ["app"] } };
    expect(buildResultProtectionResources({ ...base, connectionPolicies: [{ connectionId: "inherited", databaseScope: "none", allowedDatabases: [] }] }).some((row) => row.scope.kind === "database")).toBe(false);
    expect(supportsResultProtectionDatabaseScope({ db_type: "mongodb" })).toBe(false);
    expect(supportsResultProtectionDatabaseScope({ db_type: "sqlserver", driver_profile: "sqlserver-legacy" })).toBe(false);
    expect(supportsResultProtectionDatabaseScope({ db_type: "mysql", driver_profile: "oceanbase" })).toBe(false);
    expect(supportsResultProtectionDatabaseScope({ db_type: "sqlite", attached_databases: [{ name: "extra", path: "extra.sqlite" }] })).toBe(false);
    expect(supportsResultProtectionDatabaseScope({ db_type: "sqlite" })).toBe(true);
  });
});
