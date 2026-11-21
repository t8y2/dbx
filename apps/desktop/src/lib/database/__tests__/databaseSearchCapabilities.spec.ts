import { describe, expect, it } from "vitest";
import { BULK_DATABASE_SEARCH_TYPES, supportsBulkDatabaseSearch } from "@/lib/database/databaseSearchCapabilities";

// 镜像 Rust database_search_columns_sql.rs / database_search_probe_sql.rs 的家族 match 臂:
// 两边同步修改时必须一并更新此快照,防止前端预判与后端判定漂移。
const RUST_BULK_SEARCH_FAMILIES = ["oracle", "oceanbase-oracle", "dameng", "mysql", "doris", "starrocks", "manticoresearch", "goldendb", "postgres", "kingbase", "highgo", "uxdb", "vastbase", "opengauss", "gaussdb", "kwdb", "yashandb", "oscar", "redshift", "sqlserver"];

describe("databaseSearchCapabilities", () => {
  it("mirrors the Rust bulk search family dispatch", () => {
    expect([...BULK_DATABASE_SEARCH_TYPES].sort()).toEqual([...RUST_BULK_SEARCH_FAMILIES].sort());
  });

  it("gates unsupported dialects", () => {
    expect(supportsBulkDatabaseSearch("dameng")).toBe(true);
    expect(supportsBulkDatabaseSearch("sqlite")).toBe(false);
    expect(supportsBulkDatabaseSearch(undefined)).toBe(false);
  });
});
