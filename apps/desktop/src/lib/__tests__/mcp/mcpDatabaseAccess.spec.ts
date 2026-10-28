import { describe, expect, it } from "vitest";
import { normalizeMcpGlobalPolicy } from "@/stores/settingsStore";
import { databaseAccess, databaseAccessEqual, editableDatabaseAccess, mergeDatabaseAccess } from "@/lib/mcp/mcpDatabaseAccess";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

const connections = [{ id: "c1", name: "DB", db_type: "mysql" }] as ConnectionConfig[];
const layout: SidebarLayout = { groups: [], order: [] };
const rule = {
  connectionId: "c1",
  readOnly: false,
  allowDangerousSql: true,
  executionModeConfigured: true,
  executionModePolicyVersion: null,
  databaseScope: "selected" as const,
  allowedDatabases: ["a"],
  databasePolicies: [{ databaseName: "a", readOnly: false, allowDangerousSql: true }],
  allowSalesforceDml: false,
};

describe("database permission patches", () => {
  it("represents legacy database ceilings at their effective permission without mutating the stored rule", () => {
    const policy = normalizeMcpGlobalPolicy({ readOnly: true, connectionPolicies: [rule] });
    const edited = editableDatabaseAccess(policy, "c1", layout, connections);
    expect(edited.databasePolicies).toEqual([{ databaseName: "a", readOnly: true, allowDangerousSql: false }]);
    const merged = mergeDatabaseAccess(policy, "c1", edited, layout, connections);
    expect(merged[0]).toMatchObject({ readOnly: true, allowDangerousSql: false, executionModePolicyVersion: 1, databasePolicies: edited.databasePolicies });
    expect(policy.connectionPolicies[0].allowDangerousSql).toBe(true);
  });
  it("retains inherited connection permission semantics while applying a database override", () => {
    const policy = normalizeMcpGlobalPolicy({ readOnly: true, connectionPolicies: [{ ...rule, executionModeConfigured: false, executionModePolicyVersion: 1 }] });
    const merged = mergeDatabaseAccess(policy, "c1", { databaseScope: "selected", allowedDatabases: ["a", "b"], databasePolicies: [{ databaseName: "b", readOnly: false, allowDangerousSql: false }] }, layout, connections);
    expect(merged[0].executionModeConfigured).toBe(false);
    expect(merged[0].databasePolicies[0].databaseName).toBe("b");
  });
  it("clears removed database overrides and compares membership independently of ordering", () => {
    const value = { databaseScope: "selected" as const, allowedDatabases: ["b", "a", "b"], databasePolicies: [{ databaseName: "removed", readOnly: true, allowDangerousSql: false }] };
    expect(databaseAccess(value)).toEqual({ databaseScope: "selected", allowedDatabases: ["a", "b"], databasePolicies: [] });
    expect(databaseAccessEqual(value, { databaseScope: "selected", allowedDatabases: ["a", "b"], databasePolicies: [] })).toBe(true);
    expect(databaseAccessEqual(value, databaseAccess())).toBe(false);
  });
  it("removes an empty connection rule when restoring all databases without changing other connections", () => {
    const policy = normalizeMcpGlobalPolicy({
      connectionPolicies: [
        { ...rule, executionModeConfigured: false, executionModePolicyVersion: 1 },
        { ...rule, connectionId: "other" },
      ],
    });
    const merged = mergeDatabaseAccess(policy, "c1", databaseAccess(), layout, connections);
    expect(merged).toEqual([policy.connectionPolicies[1]]);
  });
});
