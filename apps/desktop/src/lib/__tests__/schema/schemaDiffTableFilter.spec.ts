import { describe, expect, it } from "vitest";
import { compileSchemaDiffTableFilter, filterSchemaDiffTables, isSchemaDiffView } from "@/lib/schema/schemaDiffTableFilter";
import { DEFAULT_MYSQL_OPTIONS } from "@/types/schemaDiff";
import type { TableInfo } from "@/types/database";

const tables: TableInfo[] = [
  { name: "users", table_type: "BASE TABLE" },
  { name: "active_users", table_type: "VIEW" },
  { name: "monthly_users", table_type: "MATERIALIZED VIEW" },
];

describe("schemaDiffTableFilter", () => {
  it("recognizes regular and materialized views", () => {
    expect(isSchemaDiffView(tables[0])).toBe(false);
    expect(isSchemaDiffView(tables[1])).toBe(true);
    expect(isSchemaDiffView(tables[2])).toBe(true);
  });

  it("completely excludes views when view comparison is disabled", () => {
    const options = { ...DEFAULT_MYSQL_OPTIONS, tables: true, views: false };
    const result = filterSchemaDiffTables(tables, tables, compileSchemaDiffTableFilter(options), options);

    expect(result.sourceTables.map((table) => table.name)).toEqual(["users"]);
    expect(result.targetTables.map((table) => table.name)).toEqual(["users"]);
  });

  it("completely excludes tables when table comparison is disabled", () => {
    const options = { ...DEFAULT_MYSQL_OPTIONS, tables: false, views: true };
    const result = filterSchemaDiffTables(tables, tables, compileSchemaDiffTableFilter(options), options);

    expect(result.sourceTables.map((table) => table.name)).toEqual(["active_users", "monthly_users"]);
    expect(result.targetTables.map((table) => table.name)).toEqual(["active_users", "monthly_users"]);
  });

  it("applies name filters after object type options", () => {
    const options = {
      ...DEFAULT_MYSQL_OPTIONS,
      tables: true,
      views: true,
      tableIncludePattern: "users$",
      tableExcludePattern: "^active_",
    };
    const result = filterSchemaDiffTables(tables, tables, compileSchemaDiffTableFilter(options), options);

    expect(result.sourceTables.map((table) => table.name)).toEqual(["users", "monthly_users"]);
  });
});
