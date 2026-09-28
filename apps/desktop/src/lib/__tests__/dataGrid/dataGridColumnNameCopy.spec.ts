import { afterEach, describe, expect, it, vi } from "vitest";
import { COLUMN_NAME_COPY_SEPARATOR_OPTIONS, columnNamesForCopy, formatColumnNamesForCopy, isColumnNameCopySeparator, loadColumnNameCopySeparator, saveColumnNameCopySeparator, supportsColumnNameQuoting } from "@/lib/dataGrid/dataGridColumnNameCopy";

describe("dataGridColumnNameCopy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("joins names with every supported separator", () => {
    const names = ["id", "type", "order"];
    expect(formatColumnNamesForCopy(names, { separator: "tab" })).toBe("id\ttype\torder");
    expect(formatColumnNamesForCopy(names, { separator: "comma" })).toBe("id,type,order");
    expect(formatColumnNamesForCopy(names, { separator: "newline" })).toBe("id\ntype\norder");
    expect(formatColumnNamesForCopy(names, { separator: "comma-newline" })).toBe("id,\ntype,\norder");
  });

  it("quotes names with the database-specific identifier quote", () => {
    const names = ["type", "order"];
    expect(formatColumnNamesForCopy(names, { separator: "comma", quote: true, databaseType: "mysql" })).toBe("`type`,`order`");
    expect(formatColumnNamesForCopy(names, { separator: "comma", quote: true, databaseType: "clickhouse" })).toBe("`type`,`order`");
    expect(formatColumnNamesForCopy(names, { separator: "comma", quote: true, databaseType: "postgres" })).toBe('"type","order"');
    expect(formatColumnNamesForCopy(names, { separator: "comma", quote: true, databaseType: "sqlserver" })).toBe("[type],[order]");
  });

  it("escapes embedded quote characters when quoting", () => {
    expect(formatColumnNamesForCopy(["a`b"], { separator: "tab", quote: true, databaseType: "mysql" })).toBe("`a``b`");
    expect(formatColumnNamesForCopy(['a"b'], { separator: "tab", quote: true, databaseType: "postgres" })).toBe('"a""b"');
  });

  it("ignores the quote flag for databases without SQL identifier quoting", () => {
    expect(formatColumnNamesForCopy(["type"], { separator: "tab", quote: true, databaseType: "mongodb" })).toBe("type");
    expect(formatColumnNamesForCopy(["type"], { separator: "tab", quote: true, databaseType: "qdrant" })).toBe("type");
    expect(formatColumnNamesForCopy(["type"], { separator: "tab", quote: true })).toBe("type");
  });

  it("reports quoting support only for SQL databases with a usable quote character", () => {
    expect(supportsColumnNameQuoting("mysql")).toBe(true);
    expect(supportsColumnNameQuoting("clickhouse")).toBe(true);
    expect(supportsColumnNameQuoting("postgres")).toBe(true);
    expect(supportsColumnNameQuoting("mongodb")).toBe(false);
    expect(supportsColumnNameQuoting("redis")).toBe(false);
    expect(supportsColumnNameQuoting("elasticsearch")).toBe(false);
    expect(supportsColumnNameQuoting("easysearch")).toBe(false);
    expect(supportsColumnNameQuoting("meilisearch")).toBe(false);
    expect(supportsColumnNameQuoting("qdrant")).toBe(false);
    expect(supportsColumnNameQuoting("jdbc")).toBe(false);
    expect(supportsColumnNameQuoting("iotdb")).toBe(false);
    expect(supportsColumnNameQuoting(undefined)).toBe(false);
  });

  it("keeps user-hidden columns when copying all column names", () => {
    const allColumns = ["id", "hidden_value", "created_at"];
    const visibleColumns = ["id", "created_at"];
    expect(columnNamesForCopy({ allColumnNames: allColumns, displayableIndexes: [0, 1, 2], visibleColumnNames: visibleColumns, scope: "all" })).toEqual(allColumns);
    expect(columnNamesForCopy({ allColumnNames: allColumns, displayableIndexes: [0, 1, 2], visibleColumnNames: visibleColumns, scope: "visible" })).toEqual(visibleColumns);
  });

  it("leaves grid-internal columns out of the copyable names (#10464)", () => {
    // 可编辑行定位用的 `__DBX_PK_*` 别名只存在于结果集里，网格把它藏起来，
    // 「复制列名」也必须一样：用户看到的是一列，复制出来就该是一列。
    const columns = ["rep_def_sql", "__DBX_PK_0"];
    expect(columnNamesForCopy({ allColumnNames: columns, displayableIndexes: [0], visibleColumnNames: ["rep_def_sql"], scope: "all" })).toEqual(["rep_def_sql"]);
  });

  it("validates separator values", () => {
    for (const option of COLUMN_NAME_COPY_SEPARATOR_OPTIONS) expect(isColumnNameCopySeparator(option)).toBe(true);
    expect(isColumnNameCopySeparator(";")).toBe(false);
    expect(isColumnNameCopySeparator(null)).toBe(false);
  });

  it("persists the separator choice and falls back to tab for missing or invalid values", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    expect(loadColumnNameCopySeparator()).toBe("tab");
    saveColumnNameCopySeparator("comma-newline");
    expect(loadColumnNameCopySeparator()).toBe("comma-newline");
    store.set("dbx-copy-column-names-separator", "bogus");
    expect(loadColumnNameCopySeparator()).toBe("tab");
  });
});
