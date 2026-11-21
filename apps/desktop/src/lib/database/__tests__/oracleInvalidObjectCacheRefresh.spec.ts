import { describe, expect, it, vi } from "vitest";
import { completeOracleInvalidObjectCompile, type OracleInvalidObjectCompileScope } from "../oracleInvalidObjectCacheRefresh";

const scopeA: OracleInvalidObjectCompileScope = { connectionId: "conn-a", database: "ORCL", schema: "APP_A" };

describe("invalid-object compile cache refresh routing", () => {
  it.each([
    ["another schema in the same connection", { ...scopeA, schema: "APP_B" }],
    ["another connection", { connectionId: "conn-b", database: "ORCL", schema: "APP_A" }],
  ])("invalidates the completed scope but does not refresh %s", async (_label, current) => {
    const invalidate = vi.fn<(_: OracleInvalidObjectCompileScope) => Promise<void>>().mockResolvedValue(undefined);
    const refresh = vi.fn<(_: OracleInvalidObjectCompileScope) => Promise<void>>().mockResolvedValue(undefined);

    await completeOracleInvalidObjectCompile(scopeA, () => current, invalidate, refresh);

    expect(invalidate).toHaveBeenCalledWith(scopeA);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("invalidates and refreshes the same completed scope", async () => {
    const invalidate = vi.fn<(_: OracleInvalidObjectCompileScope) => Promise<void>>().mockResolvedValue(undefined);
    const refresh = vi.fn<(_: OracleInvalidObjectCompileScope) => Promise<void>>().mockResolvedValue(undefined);

    await completeOracleInvalidObjectCompile(scopeA, () => scopeA, invalidate, refresh);

    expect(invalidate).toHaveBeenCalledWith(scopeA);
    expect(refresh).toHaveBeenCalledWith(scopeA);
  });

  it("checks current scope after invalidation completes", async () => {
    let current = scopeA;
    const invalidate = vi.fn(async () => {
      current = { ...scopeA, schema: "APP_B" };
    });
    const refresh = vi.fn<(_: OracleInvalidObjectCompileScope) => Promise<void>>().mockResolvedValue(undefined);

    await completeOracleInvalidObjectCompile(scopeA, () => current, invalidate, refresh);

    expect(invalidate).toHaveBeenCalledWith(scopeA);
    expect(refresh).not.toHaveBeenCalled();
  });
});
