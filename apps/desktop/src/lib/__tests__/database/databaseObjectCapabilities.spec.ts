import { describe, expect, it } from "vitest";
import { normalizeSidebarObjectKind, sidebarObjectKindsForDatabase, supportsPackageMemberExpansion } from "@/lib/database/databaseObjectCapabilities";

describe("databaseObjectCapabilities", () => {
  it("exposes supported programmable objects for Dameng", () => {
    expect(sidebarObjectKindsForDatabase("dameng")).toEqual(expect.arrayContaining(["MATERIALIZED_VIEW", "SEQUENCE", "PACKAGE", "PACKAGE_BODY"]));
  });

  it("exposes synonyms for Xugu only", () => {
    expect(sidebarObjectKindsForDatabase("xugu")).toContain("SYNONYM");
    expect(sidebarObjectKindsForDatabase("postgres")).not.toContain("SYNONYM");
  });

  it("expands package members only for implemented database paths", () => {
    expect(supportsPackageMemberExpansion("oracle")).toBe(true);
    expect(supportsPackageMemberExpansion("xugu")).toBe(true);
    expect(supportsPackageMemberExpansion("dameng")).toBe(false);
    expect(supportsPackageMemberExpansion("opengauss")).toBe(false);
  });

  it("exposes only tables for HBase namespaces", () => {
    expect(sidebarObjectKindsForDatabase("hbase")).toEqual(["TABLE"]);
  });

  it("exposes materialized views for StarRocks only", () => {
    // StarRocks has a dedicated MV listing/classification path in
    // crates/dbx-core/src/db/mysql.rs (`list_starrocks_tables` +
    // `classify_starrocks_materialized_views`).
    expect(sidebarObjectKindsForDatabase("starrocks")).toContain("MATERIALIZED_VIEW");

    // Doris uses the generic SHOW TABLES listing path with no MV classifier,
    // so advertising MV in the sidebar would have nothing to route to.
    // Keep Doris on TABLE_VIEW_OBJECTS until a Doris-specific listing path
    // lands.
    expect(sidebarObjectKindsForDatabase("doris")).not.toContain("MATERIALIZED_VIEW");
    expect(sidebarObjectKindsForDatabase("doris")).toEqual(expect.arrayContaining(["TABLE", "VIEW"]));
  });

  it("normalizes space separated materialized view types", () => {
    expect(normalizeSidebarObjectKind("MATERIALIZED VIEW")).toBe("MATERIALIZED_VIEW");
  });
});
