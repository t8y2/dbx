import { describe, expect, it } from "vitest";
import { canViewDatabaseObjectDependencies, databaseDependencyProviderFor } from "@/lib/database/databaseObjectDependencies";

const node = (overrides: Record<string, unknown> = {}) => ({
  type: "table" as const,
  schema: "APP",
  objectName: "ORDERS",
  label: "ORDERS",
  ...overrides,
});

describe("database dependency providers", () => {
  it("resolves only providers registered for the requested database", () => {
    expect(databaseDependencyProviderFor("xugu")?.databaseType).toBe("xugu");
    expect(databaseDependencyProviderFor("postgres")).toBeNull();
    expect(databaseDependencyProviderFor(undefined)).toBeNull();
  });

  it("keeps the UI capability check database-agnostic", () => {
    expect(canViewDatabaseObjectDependencies("xugu", node())).toBe(true);
    expect(canViewDatabaseObjectDependencies("postgres", node())).toBe(false);
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
