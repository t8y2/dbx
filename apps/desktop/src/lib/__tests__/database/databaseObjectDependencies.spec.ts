import { describe, expect, it } from "vitest";
import { canViewDatabaseObjectDependencies, databaseDependencyProviderFor } from "@/lib/database/databaseObjectDependencies";
import type { TreeNode, TriggerInfo } from "@/types/database";

const node = (overrides: Record<string, unknown> = {}) => ({
  type: "table" as const,
  schema: "APP",
  objectName: "ORDERS",
  label: "ORDERS",
  ...overrides,
});

describe("database dependency providers", () => {
  it("limits DM dependency support to the exact trigger adapter and preserves its raw owner/name", () => {
    const trigger: TriggerInfo = { name: " Tr'ig ", event: "INSERT", timing: "BEFORE", oracle_metadata: { contractVersion: 1, identityMode: "exact", engine: "dm", engineVersion: "8.1.3", owner: " Owner ", name: " Tr'ig ", scope: "TABLE", reads: {} } };
    const item: TreeNode = { id: "t", type: "trigger", label: "display label", schema: " Owner ", objectName: trigger.name, meta: trigger };
    const provider = databaseDependencyProviderFor("dameng");
    expect(provider).not.toBeNull();
    expect(provider!.supports(item)).toBe(true);
    expect(provider!.buildQuery(item)).toContain("d.NAME = ' Tr''ig '");
    expect(provider!.buildQuery(item)).toContain("d.TYPE = 'TRIGGER'");
    expect(provider!.targetLabel?.(item)).toMatchObject({ name: " Owner . Tr'ig " });
    for (const changed of [
      { ...item, meta: undefined },
      { ...item, schema: "Other" },
      { ...item, type: "procedure" as const },
    ]) {
      expect(provider!.supports(changed)).toBe(false);
      expect(provider!.buildQuery(changed)).toBeNull();
    }
    trigger.oracle_metadata!.engineVersion = "6.0";
    expect(provider!.supports(item)).toBe(false);
  });

  it("resolves only providers registered for the requested database", () => {
    expect(databaseDependencyProviderFor("xugu")?.databaseType).toBe("xugu");
    expect(databaseDependencyProviderFor("oracle")?.databaseType).toBe("oracle");
    expect(databaseDependencyProviderFor("oceanbase-oracle")?.databaseType).toBe("oracle");
    expect(databaseDependencyProviderFor("postgres")).toBeNull();
    expect(databaseDependencyProviderFor(undefined)).toBeNull();
  });

  it("keeps the UI capability check database-agnostic", () => {
    expect(canViewDatabaseObjectDependencies("xugu", node())).toBe(true);
    expect(canViewDatabaseObjectDependencies("oracle", node({ type: "procedure" }))).toBe(true);
    expect(canViewDatabaseObjectDependencies("oceanbase-oracle", node({ type: "package" }))).toBe(true);
    expect(canViewDatabaseObjectDependencies("postgres", node())).toBe(false);
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("exposes table and view relations through the existing provider in %s", (databaseType) => {
    for (const type of ["table", "view", "materialized_view"] as const) {
      const target = node({ type });
      expect(canViewDatabaseObjectDependencies(databaseType, target)).toBe(true);
      expect(databaseDependencyProviderFor(databaseType)?.buildQuery(target)).toContain("ALL_DEPENDENCIES");
    }
  });

  it("does not expose package members or incomplete nodes", () => {
    const provider = databaseDependencyProviderFor("xugu");
    expect(provider).not.toBeNull();
    expect(provider!.supports(node({ type: "procedure", parentType: "package", parentName: "PKG" }))).toBe(false);
    expect(provider!.supports(node({ type: "package-body" }))).toBe(false);
    expect(provider!.buildQuery(node({ schema: undefined }))).toBeNull();
    expect(provider!.buildQuery(node({ type: "sequence" }))).toBeNull();
  });
});
