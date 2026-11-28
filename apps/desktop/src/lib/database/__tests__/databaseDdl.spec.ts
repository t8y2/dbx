import { describe, expect, it } from "vitest";
import { buildShowCreateDatabaseSql } from "@/lib/database/databaseDdl";

describe("buildShowCreateDatabaseSql", () => {
  it("builds SHOW CREATE DATABASE for MySQL and escapes backticks in the name", () => {
    expect(buildShowCreateDatabaseSql("mysql", "shop")).toBe("SHOW CREATE DATABASE `shop`;");
    expect(buildShowCreateDatabaseSql("mysql", "we`ird")).toBe("SHOW CREATE DATABASE `we``ird`;");
  });

  it("returns null for engines without a database CREATE statement", () => {
    expect(buildShowCreateDatabaseSql("postgres", "shop")).toBeNull();
    expect(buildShowCreateDatabaseSql("sqlite", "main")).toBeNull();
    expect(buildShowCreateDatabaseSql(undefined, "shop")).toBeNull();
  });
});
