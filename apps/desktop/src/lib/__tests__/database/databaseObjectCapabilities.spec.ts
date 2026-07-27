import { describe, expect, it } from "vitest";
import { normalizeSidebarObjectKind, sidebarObjectKindsForDatabase } from "@/lib/database/databaseObjectCapabilities";

describe("databaseObjectCapabilities", () => {
  it("exposes materialized views for Dameng", () => {
    expect(sidebarObjectKindsForDatabase("dameng")).toContain("MATERIALIZED_VIEW");
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
