import { describe, expect, it } from "vitest";
import { objectBrowserTargetForNamespaceRow } from "@/lib/database/objectBrowserTarget";

describe("objectBrowserTargetForNamespaceRow", () => {
  it("binds connection-root schema engines as both database and schema", () => {
    for (const dbType of ["oracle", "dameng", "oceanbase-oracle"] as const) {
      expect(objectBrowserTargetForNamespaceRow({ db_type: dbType }, "schema_b")).toEqual({
        database: "schema_b",
        schema: "schema_b",
      });
    }
  });

  it("resolves inferred JDBC dialects before deciding", () => {
    expect(objectBrowserTargetForNamespaceRow({ db_type: "jdbc", jdbc_driver_class: "oracle.jdbc.OracleDriver" }, "APP")).toEqual({
      database: "APP",
      schema: "APP",
    });
  });

  it("keeps database rows as databases for engines with a database level", () => {
    for (const dbType of ["mysql", "postgres", "sqlserver"] as const) {
      expect(objectBrowserTargetForNamespaceRow({ db_type: dbType }, "shop")).toEqual({ database: "shop" });
    }
  });

  it("treats a missing connection as a plain database row", () => {
    expect(objectBrowserTargetForNamespaceRow(undefined, "shop")).toEqual({ database: "shop" });
  });
});
