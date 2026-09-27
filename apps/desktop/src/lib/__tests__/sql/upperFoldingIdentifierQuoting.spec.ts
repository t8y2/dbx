import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";

describe("upper-folding completion with identifier quoting disabled (#9775)", () => {
  const sql = "SELECT t.c FROM abc t";
  const cursor = "SELECT t.c".length;
  const columnApplyOf = (databaseType: "dameng" | "db2", extra: { quoteIdentifiers?: boolean }) =>
    buildSqlCompletionItems(sql, cursor, {
      databaseType,
      tables: [{ name: "abc", type: "table" as const }],
      columnsByTable: new Map([["abc", [{ name: "col1", table: "abc" }]]]),
      ...extra,
    }).find((item) => item.label === "col1")?.apply;

  it.each(["dameng", "db2"] as const)("keeps lowercase columns bare on %s when quoting is disabled", (databaseType) => {
    expect(columnApplyOf(databaseType, { quoteIdentifiers: false })).toBe("col1");
  });

  it.each(["dameng", "db2"] as const)("still quotes lowercase columns on %s by default and when quoting is enabled", (databaseType) => {
    expect(columnApplyOf(databaseType, {})).toBe('"col1"');
    expect(columnApplyOf(databaseType, { quoteIdentifiers: true })).toBe('"col1"');
  });

  it.each(["dameng", "db2"] as const)("keeps mixed-case table names bare on %s when quoting is disabled", (databaseType) => {
    const tableSql = "SELECT * FROM Ab";
    const items = buildSqlCompletionItems(tableSql, tableSql.length, {
      databaseType,
      tables: [{ name: "Abc", type: "table" as const }],
      columnsByTable: new Map(),
      quoteIdentifiers: false,
    });
    expect(items.find((item) => item.label === "Abc")?.apply).toBe("Abc");
  });

  it.each(["dameng", "db2"] as const)("keeps all-uppercase columns bare on %s regardless of the setting", (databaseType) => {
    const upperSql = "SELECT t.c FROM abc t";
    const applyOf = (extra: { quoteIdentifiers?: boolean }) =>
      buildSqlCompletionItems(upperSql, "SELECT t.c".length, {
        databaseType,
        tables: [{ name: "abc", type: "table" as const }],
        columnsByTable: new Map([["abc", [{ name: "COL1", table: "abc" }]]]),
        ...extra,
      }).find((item) => item.label === "COL1")?.apply;
    expect(applyOf({ quoteIdentifiers: false })).toBe("COL1");
    expect(applyOf({ quoteIdentifiers: true })).toBe("COL1");
  });
});
