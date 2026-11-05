import { describe, expect, it } from "vitest";
import { sortObjectBrowserTableColumns } from "../objectBrowserTableInfo";

function column(overrides: Partial<{ name: string; data_type: string; is_nullable: boolean; column_default: string | null }>) {
  return { name: "col", data_type: "text", is_nullable: true, column_default: null, ...overrides };
}

describe("sortObjectBrowserTableColumns", () => {
  it("returns the input order unchanged without a sort", () => {
    const columns = [column({ name: "bravo" }), column({ name: "alpha" })];
    expect(sortObjectBrowserTableColumns(columns, null)).toBe(columns);
  });

  it("sorts by name ascending and inverts it descending", () => {
    const columns = [column({ name: "charlie" }), column({ name: "alpha" }), column({ name: "bravo" })];
    expect(sortObjectBrowserTableColumns(columns, { key: "name", direction: "asc" }).map((item) => item.name)).toEqual(["alpha", "bravo", "charlie"]);
    expect(sortObjectBrowserTableColumns(columns, { key: "name", direction: "desc" }).map((item) => item.name)).toEqual(["charlie", "bravo", "alpha"]);
  });

  it("orders numeric column names naturally so col2 comes before col10", () => {
    const columns = [column({ name: "col10" }), column({ name: "col2" }), column({ name: "col1" })];
    expect(sortObjectBrowserTableColumns(columns, { key: "name", direction: "asc" }).map((item) => item.name)).toEqual(["col1", "col2", "col10"]);
  });

  it("keeps the source order for ties", () => {
    const columns = [column({ name: "same", data_type: "integer", column_default: "1" }), column({ name: "same", data_type: "integer", column_default: "2" }), column({ name: "same", data_type: "integer", column_default: "3" })];
    expect(sortObjectBrowserTableColumns(columns, { key: "dataType", direction: "asc" }).map((item) => item.column_default)).toEqual(["1", "2", "3"]);
    expect(sortObjectBrowserTableColumns(columns, { key: "dataType", direction: "desc" }).map((item) => item.column_default)).toEqual(["1", "2", "3"]);
  });

  it("sorts nullable flags with NO before YES ascending and YES before NO descending", () => {
    const columns = [column({ name: "a", is_nullable: true }), column({ name: "b", is_nullable: false }), column({ name: "c", is_nullable: true })];
    expect(sortObjectBrowserTableColumns(columns, { key: "nullable", direction: "asc" }).map((item) => item.name)).toEqual(["b", "a", "c"]);
    expect(sortObjectBrowserTableColumns(columns, { key: "nullable", direction: "desc" }).map((item) => item.name)).toEqual(["a", "c", "b"]);
  });

  it("orders null column_default values before non-null defaults ascending and after them descending", () => {
    const columns = [column({ name: "a", column_default: "nextval('s')" }), column({ name: "b", column_default: null }), column({ name: "c", column_default: "0" })];
    expect(sortObjectBrowserTableColumns(columns, { key: "defaultValue", direction: "asc" }).map((item) => item.name)).toEqual(["b", "c", "a"]);
    expect(sortObjectBrowserTableColumns(columns, { key: "defaultValue", direction: "desc" }).map((item) => item.name)).toEqual(["a", "c", "b"]);
  });

  it("keeps the option payloads intact and does not mutate the input", () => {
    const columns = [column({ name: "bravo" }), column({ name: "alpha" })];
    const sorted = sortObjectBrowserTableColumns(columns, { key: "name", direction: "asc" });
    expect(sorted[0]).toEqual({ name: "alpha", data_type: "text", is_nullable: true, column_default: null });
    expect(columns.map((item) => item.name)).toEqual(["bravo", "alpha"]);
  });

  it("returns copies intact for empty or single element lists", () => {
    expect(sortObjectBrowserTableColumns([], { key: "name", direction: "asc" })).toEqual([]);
    const single = [column({ name: "col_a" })];
    expect(sortObjectBrowserTableColumns(single, { key: "name", direction: "desc" })).toEqual([single[0]]);
  });
});
