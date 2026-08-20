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

  // ---- Visual (explicit) table selection (#6533) ----
  const all: TableInfo[] = [
    { name: "users", table_type: "BASE TABLE" },
    { name: "active_users", table_type: "BASE TABLE" },
    { name: "orders", table_type: "BASE TABLE" },
    { name: "orders_bak", table_type: "BASE TABLE" },
  ];
  const baseOptions = { ...DEFAULT_MYSQL_OPTIONS, tables: true, views: true };

  it("keeps legacy behavior when no visual selection is set (undefined selection = no restriction)", () => {
    const options = { ...baseOptions, tableIncludePattern: "^orders$", tableExcludePattern: "_bak$" };
    const result = filterSchemaDiffTables(all, all, compileSchemaDiffTableFilter(options), options, undefined);
    expect(result.sourceTables.map((t) => t.name)).toEqual(["orders"]);
  });

  it("restricts to the explicitly selected tables only", () => {
    const result = filterSchemaDiffTables(all, all, compileSchemaDiffTableFilter(baseOptions), baseOptions, ["users", "orders"]);
    expect(result.sourceTables.map((t) => t.name)).toEqual(["users", "orders"]);
  });

  it("intersects visual selection with the include regex", () => {
    const options = { ...baseOptions, tableIncludePattern: "^users$" };
    const result = filterSchemaDiffTables(all, all, compileSchemaDiffTableFilter(options), options, ["users", "orders"]);
    expect(result.sourceTables.map((t) => t.name)).toEqual(["users"]);
  });

  it("intersects visual selection with the exclude regex", () => {
    const options = { ...baseOptions, tableExcludePattern: "_bak$" };
    const result = filterSchemaDiffTables(all, all, compileSchemaDiffTableFilter(options), options, ["orders", "orders_bak"]);
    expect(result.sourceTables.map((t) => t.name)).toEqual(["orders"]);
  });

  it("treats an explicitly empty selection ([]) as selecting nothing, distinct from undefined", () => {
    const result = filterSchemaDiffTables(all, all, compileSchemaDiffTableFilter(baseOptions), baseOptions, []);
    expect(result.sourceTables).toEqual([]);
  });

  it("keeps selected source tables when same-name targets are missing", () => {
    const sourceOnly: TableInfo[] = [
      { name: "a", table_type: "BASE TABLE" },
      { name: "b", table_type: "BASE TABLE" },
      { name: "c", table_type: "BASE TABLE" },
    ];
    const targetPartly: TableInfo[] = [
      { name: "a", table_type: "BASE TABLE" },
      { name: "c", table_type: "BASE TABLE" },
    ];
    const result = filterSchemaDiffTables(sourceOnly, targetPartly, compileSchemaDiffTableFilter(baseOptions), baseOptions, ["a", "b", "c"]);
    expect(result.sourceTables.map((t) => t.name)).toEqual(["a", "b", "c"]);
    expect(result.targetTables.map((t) => t.name)).toEqual(["a", "c"]);
  });

  it("does not include unselected target tables that would otherwise look like drops", () => {
    const source: TableInfo[] = [{ name: "a", table_type: "BASE TABLE" }];
    const target: TableInfo[] = [
      { name: "a", table_type: "BASE TABLE" },
      { name: "b", table_type: "BASE TABLE" },
    ];
    const result = filterSchemaDiffTables(source, target, compileSchemaDiffTableFilter(baseOptions), baseOptions, ["a"]);
    expect(result.sourceTables.map((t) => t.name)).toEqual(["a"]);
    expect(result.targetTables.map((t) => t.name)).toEqual(["a"]);
  });
});
