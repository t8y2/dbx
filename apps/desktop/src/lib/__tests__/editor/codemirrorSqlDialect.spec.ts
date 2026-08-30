import { describe, expect, it } from "vitest";
import * as langSql from "@codemirror/lang-sql";
import { createDbxCodeMirrorSqlDialect, postgresKeywordSyntaxTerms, sqlServerBuiltinSyntaxTerms } from "@/lib/editor/codemirrorSqlDialect";
import type { DatabaseType } from "@/types/database";

function nodeNameAt(dialect: langSql.SQLDialect, statement: string, word: string): string | undefined {
  const cursor = dialect.language.parser.parse(statement).cursor();

  do {
    if (statement.slice(cursor.from, cursor.to) === word) return cursor.name;
  } while (cursor.next());

  return undefined;
}

describe("codemirrorSqlDialect", () => {
  it("keeps common PostgreSQL identifier names out of keyword highlighting", () => {
    const keywords = new Set(postgresKeywordSyntaxTerms(langSql.PostgreSQL.spec.keywords || "").split(/\s+/));

    expect(keywords.has("select")).toBe(true);
    expect(keywords.has("from")).toBe(true);
    expect(keywords.has("where")).toBe(true);
    expect(keywords.has("id")).toBe(false);
    expect(keywords.has("name")).toBe(false);
    expect(keywords.has("user")).toBe(false);
    expect(keywords.has("count")).toBe(false);
  });

  it("highlights common functions dropped from Postgres/MySQL keyword lists as builtins", () => {
    const postgresBuiltins = new Set(createDbxCodeMirrorSqlDialect(langSql, "postgres", "postgres").spec.builtin?.split(/\s+/));
    const mysqlBuiltins = new Set(createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql").spec.builtin?.split(/\s+/));

    expect(postgresBuiltins.has("count")).toBe(true);
    expect(postgresBuiltins.has("to_char")).toBe(true);
    expect(mysqlBuiltins.has("ifnull")).toBe(true);
    expect(mysqlBuiltins.has("date_format")).toBe(true);
  });

  it("adds Dolt routines to highlighting without changing standard MySQL", () => {
    const doltBuiltins = new Set(createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql", "dolt").spec.builtin?.split(/\s+/));
    const mysqlBuiltins = new Set(createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql", "mysql").spec.builtin?.split(/\s+/));

    expect(doltBuiltins.has("dolt_branch")).toBe(true);
    expect(doltBuiltins.has("dolt_merge")).toBe(true);
    expect(mysqlBuiltins.has("dolt_branch")).toBe(false);
  });

  it("highlights SQL Server clause words as keywords instead of builtin functions", () => {
    const builtins = new Set(sqlServerBuiltinSyntaxTerms(langSql.MSSQL.spec.builtin || "").split(/\s+/));

    expect(builtins.has("set")).toBe(false);
    expect(builtins.has("next")).toBe(false);
    expect(builtins.has("for")).toBe(false);
    expect(builtins.has("getdate")).toBe(true);
    expect(builtins.has("count")).toBe(true);
    expect(builtins.has("left")).toBe(true);
  });

  it("tokenizes SET as a keyword for SQL Server statements", () => {
    const dialect = createDbxCodeMirrorSqlDialect(langSql, "sqlserver", "sqlserver");
    const statements = ["UPDATE users SET name = 'Alice' WHERE id = 1", "SET NOCOUNT ON", "SET @total = 5"];

    for (const statement of statements) {
      expect(nodeNameAt(dialect, statement, "SET"), statement).toBe("Keyword");
    }

    expect(nodeNameAt(dialect, "SELECT COUNT(*) FROM users", "COUNT")).toBe("Builtin");
    expect(nodeNameAt(dialect, "SELECT GETDATE()", "GETDATE")).toBe("Builtin");
  });

  it("keeps double quotes as identifier delimiters for Oracle-family dialects", () => {
    const databaseTypes: DatabaseType[] = ["oracle", "dameng", "yashandb", "oscar", "oceanbase-oracle"];

    for (const databaseType of databaseTypes) {
      expect(createDbxCodeMirrorSqlDialect(langSql, "mysql", databaseType).spec.doubleQuotedStrings, databaseType).toBe(false);
    }
  });
});
