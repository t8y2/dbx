import { describe, expect, it } from "vitest";
import { applyCnosdbTenantToExternalConfig, CNOSDB_DEFAULT_TENANT, cnosdbTenantFromExternalConfig } from "../cnosdbTenant";

describe("cnosdbTenant", () => {
  it("defaults to cnosdb", () => {
    expect(cnosdbTenantFromExternalConfig(undefined)).toBe(CNOSDB_DEFAULT_TENANT);
    expect(cnosdbTenantFromExternalConfig({})).toBe(CNOSDB_DEFAULT_TENANT);
  });

  it("reads a custom tenant", () => {
    expect(cnosdbTenantFromExternalConfig({ tenant: "acme" })).toBe("acme");
  });

  it("omits the default tenant from external_config", () => {
    expect(applyCnosdbTenantToExternalConfig({ tenant: "acme" }, CNOSDB_DEFAULT_TENANT)).toBeUndefined();
    expect(applyCnosdbTenantToExternalConfig(undefined, "demo")).toEqual({ tenant: "demo" });
  });
});
