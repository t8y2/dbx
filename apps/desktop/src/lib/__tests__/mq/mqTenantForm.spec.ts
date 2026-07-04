import { describe, expect, it } from "vitest";
import { defaultTenantConfig, mqClusterOptionsFromExtra, validateTenantForm } from "@/lib/mq/mqTenantForm";

describe("mqTenantForm", () => {
  it("extracts selectable cluster names from Pulsar cluster info extras", () => {
    expect(mqClusterOptionsFromExtra({ clusters: ["standalone", "ec-pulsar", "standalone", "", 42] })).toEqual(["standalone", "ec-pulsar"]);
    expect(mqClusterOptionsFromExtra({ clusters: "standalone" })).toEqual([]);
    expect(mqClusterOptionsFromExtra(undefined)).toEqual([]);
  });

  it("prefills a new tenant with detected clusters", () => {
    const config = defaultTenantConfig(["standalone", "ec-pulsar"]);

    expect(config).toEqual({
      adminRoles: [],
      allowedClusters: ["standalone", "ec-pulsar"],
    });
  });

  it("requires both a tenant name and at least one allowed cluster", () => {
    expect(validateTenantForm("", { adminRoles: [], allowedClusters: ["standalone"] })).toBe("Tenant name is required");
    expect(validateTenantForm("tenant-a", { adminRoles: [], allowedClusters: [] })).toBe("Allowed clusters are required");
    expect(validateTenantForm("tenant-a", { adminRoles: [], allowedClusters: ["standalone"] })).toBeUndefined();
  });
});
