import { describe, expect, it } from "vitest";
import { buildSqlCompletionItemsFromContext, getSqlCompletionContext, type SqlCompletionColumn } from "@/lib/sql/sqlCompletion";
import { SqlCompletionAnalysisEngine } from "@/lib/sql/sqlCompletionAnalysis";

// Each name accepts both CREATE TABLE name (...) and CREATE TABLE t (name integer)
// followed by an unquoted SELECT in PostgreSQL 16.10 (#13742).
const postgresIdentifierNames = [
  "alter",
  "anti",
  "apply",
  "asof",
  "between",
  "coalesce",
  "current",
  "database",
  "delete",
  "describe",
  "drop",
  "exists",
  "explain",
  "filter",
  "first",
  "following",
  "ignore",
  "index",
  "insert",
  "key",
  "last",
  "next",
  "nulls",
  "over",
  "partition",
  "pivot",
  "positional",
  "preceding",
  "qualify",
  "recursive",
  "respect",
  "rows",
  "sample",
  "schema",
  "semi",
  "set",
  "straight_join",
  "unbounded",
  "unpivot",
  "update",
  "values",
  "view",
];
const dialectOptions = { databaseType: "postgres", dialect: "postgres" } as const;

describe.each([false, true])("PostgreSQL keyword-like identifiers (semantic=%s)", (semanticCompletionEnabled) => {
  it.each(postgresIdentifierNames)("completes columns of the unquoted table %s", (table) => {
    const columns = ["request_no", "org_id"].map((name) => ({ name, table, schema: "public" }));
    const engine = new SqlCompletionAnalysisEngine();
    for (const prefix of ["req", "or", "org", "request_no", "org_id"]) {
      const sql = `SELECT *\nFROM ${table} WHERE ${prefix};`;
      const { completionContext } = engine.analyze({ ...dialectOptions, sql, cursor: sql.length - 1, semanticCompletionEnabled });
      const items = buildSqlCompletionItemsFromContext(completionContext, {
        ...dialectOptions,
        tables: [{ name: table, schema: "public" }],
        columnsByTable: new Map([[`public.${table}`, columns]]),
      });
      expect(completionContext.referencedTables, sql).toEqual(expect.arrayContaining([expect.objectContaining({ name: table })]));
      expect(
        items.filter((item) => item.type === "column").map((item) => item.label),
        sql,
      ).toContain(prefix.startsWith("or") ? "org_id" : "request_no");
    }
  });

  it.each(postgresIdentifierNames)("completes the keyword-like column %s", (name) => {
    const columns: SqlCompletionColumn[] = [{ name, table: "records", schema: "public" }];
    const engine = new SqlCompletionAnalysisEngine();
    for (const clause of ["SELECT", "SELECT * FROM records WHERE"]) {
      for (const prefix of [name.slice(0, 2), name]) {
        const sql = clause === "SELECT" ? `SELECT ${prefix} FROM records;` : `${clause} ${prefix};`;
        const cursor = clause === "SELECT" ? `SELECT ${prefix}`.length : sql.length - 1;
        const { completionContext } = engine.analyze({ ...dialectOptions, sql, cursor, semanticCompletionEnabled });
        const items = buildSqlCompletionItemsFromContext(completionContext, {
          ...dialectOptions,
          tables: [{ name: "records", schema: "public" }],
          columnsByTable: new Map([["public.records", columns]]),
        });
        expect(items, sql).toEqual(expect.arrayContaining([expect.objectContaining({ label: name, type: "column" })]));
      }
    }
  });
});

describe("keyword-like table reference boundaries", () => {
  it.each(["FROM", "WHERE", "JOIN", "ON", "GROUP", "ORDER", "LIMIT"])("does not treat a PostgreSQL clause word as a table: %s", (word) => {
    const sql = `SELECT * FROM ${word} req`;
    expect(getSqlCompletionContext(sql, sql.length, dialectOptions).referencedTables.map((table) => table.name)).not.toContain(word.toLowerCase());
  });

  it.each(["redshift", "gaussdb", "kingbase", "highgo", "uxdb", "vastbase", "kwdb", "opengauss"] as const)("preserves PostgreSQL-like identifier rules for %s", (databaseType) => {
    const sql = "SELECT * FROM apply WHERE req";
    expect(getSqlCompletionContext(sql, sql.length, { databaseType }).referencedTables).toEqual([expect.objectContaining({ name: "apply" })]);
  });

  it.each(["CROSS", "OUTER"])("preserves SQL Server %s APPLY table references", (modifier) => {
    const sql = `SELECT * FROM users u ${modifier} APPLY orders o WHERE o.req`;
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "sqlserver", dialect: "sqlserver" });
    expect(context.referencedTables).toEqual([expect.objectContaining({ name: "users", alias: "u" }), expect.objectContaining({ name: "orders", alias: "o" })]);
  });

  it("does not relax the legacy blacklist for SQL Server", () => {
    const sql = "SELECT * FROM apply WHERE req";
    expect(getSqlCompletionContext(sql, sql.length, { databaseType: "sqlserver" }).referencedTables).toEqual([]);
  });
});
