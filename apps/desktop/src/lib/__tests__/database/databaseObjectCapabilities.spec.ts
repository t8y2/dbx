import { describe, expect, it } from "vitest";
import { normalizeSidebarObjectKind, sidebarObjectKindsForDatabase } from "@/lib/database/databaseObjectCapabilities";

describe("databaseObjectCapabilities", () => {
  it("exposes materialized views for Dameng", () => {
    expect(sidebarObjectKindsForDatabase("dameng")).toContain("MATERIALIZED_VIEW");
  });

  it("exposes materialized views for StarRocks and Doris", () => {
    expect(sidebarObjectKindsForDatabase("starrocks")).toContain("MATERIALIZED_VIEW");
    expect(sidebarObjectKindsForDatabase("doris")).toContain("MATERIALIZED_VIEW");
  });

  it("normalizes space separated materialized view types", () => {
    expect(normalizeSidebarObjectKind("MATERIALIZED VIEW")).toBe("MATERIALIZED_VIEW");
  });
});
