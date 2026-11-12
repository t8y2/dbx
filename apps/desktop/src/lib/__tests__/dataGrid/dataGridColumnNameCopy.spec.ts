import { afterEach, describe, expect, it, vi } from "vitest";
import { COLUMN_NAME_COPY_SEPARATOR_OPTIONS, columnNamesForCopy, formatColumnNamesForCopy, isColumnNameCopySeparator, loadColumnNameCopySeparator, saveColumnNameCopySeparator, supportsColumnNameQuoting } from "@/lib/dataGrid/dataGridColumnNameCopy";
import type { DatabaseType } from "@/types/database";

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

  it("formats a comma list of single-quoted literals for IN (...) lists (#14495)", () => {
    expect(formatColumnNamesForCopy(["id", "user_name"], { separator: "comma", quote: true, quoteStyle: "single" })).toBe("'id','user_name'");
    // Escapes a quote instead of producing broken SQL, and needs no identifier-quote support.
    expect(formatColumnNamesForCopy(["o'brien"], { separator: "comma", quote: true, quoteStyle: "single", databaseType: "jdbc" })).toBe("'o''brien'");
    // The default style is still the database identifier quote.
    expect(formatColumnNamesForCopy(["type"], { separator: "comma", quote: true, databaseType: "mysql" })).toBe("`type`");
  });

  it("escapes backslashes for dialects where a backslash escapes the next character (#14495)", () => {
    const single = (names: string[], databaseType?: DatabaseType) => formatColumnNamesForCopy(names, { separator: "comma", quote: true, quoteStyle: "single", databaseType });
    for (const databaseType of ["mysql", "doris", "starrocks", "hive", "argo", "transwarp", "impala", "spark", "databend"] as const) {
      // \t and \Z would otherwise be read as a tab and as ctrl-Z.
      expect(single(["C:\\tmp", "\\Z"], databaseType)).toBe("'C:\\\\tmp','\\\\Z'");
      // A backslash before the quote must not shift the string boundary.
      expect(single(["a\\'b"], databaseType)).toBe("'a\\\\''b'");
    }
    // Standard-conforming dialects keep the backslash literal, so only quotes double.
    for (const databaseType of ["postgres", "oracle", "sqlserver", "sqlite", "clickhouse"] as const) {
      expect(single(["C:\\tmp", "a\\'b"], databaseType)).toBe("'C:\\tmp','a\\''b'");
    }
    // Without a known dialect the safer text is preserved verbatim.
    expect(single(["C:\\tmp"])).toBe("'C:\\tmp'");
  });
});
