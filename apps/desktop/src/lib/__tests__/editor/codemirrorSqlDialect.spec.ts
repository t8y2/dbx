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

  it("enables backslashEscapes for MySQL-family dialects and ClickHouse while keeping it disabled for standard dialects", () => {
    const backslashEscapesTypes: DatabaseType[] = ["mysql", "doris", "starrocks", "goldendb", "gbase", "sundb", "databend", "clickhouse", "hive", "spark", "impala", "argo"];
    for (const databaseType of backslashEscapesTypes) {
      expect(createDbxCodeMirrorSqlDialect(langSql, "mysql", databaseType).spec.backslashEscapes, databaseType).toBe(true);
    }

    const standardTypes: DatabaseType[] = ["postgres", "sqlserver", "sqlite", "oracle", "dameng"];
    for (const databaseType of standardTypes) {
      expect(createDbxCodeMirrorSqlDialect(langSql, "mysql", databaseType).spec.backslashEscapes, databaseType).toBeUndefined();
    }
  });

  it("correctly tokenizes string literals containing escaped quotes in MySQL statements without corrupting trailing code", () => {
    const dialect = createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql");
    const statement = ["SELECT CONCAT('\\'', sl.id) id, sl.settlement_price_tax '本次结算金额含税',", "CASE sc.`type`", "    WHEN 0 THEN '物资'", "    WHEN 1 THEN '设备'", "    ELSE ''", "END AS '合同类型'"].join("\n");

    expect(nodeNameAt(dialect, statement, "'\\''")).toBe("String");
    expect(nodeNameAt(dialect, statement, "'本次结算金额含税'")).toBe("String");
    expect(nodeNameAt(dialect, statement, "CASE")).toBe("Keyword");
    expect(nodeNameAt(dialect, statement, "`type`")).toBe("QuotedIdentifier");
    expect(nodeNameAt(dialect, statement, "WHEN")).toBe("Keyword");
    expect(nodeNameAt(dialect, statement, "THEN")).toBe("Keyword");
    expect(nodeNameAt(dialect, statement, "'物资'")).toBe("String");
    expect(nodeNameAt(dialect, statement, "'设备'")).toBe("String");
    expect(nodeNameAt(dialect, statement, "''")).toBe("String");
    expect(nodeNameAt(dialect, statement, "END")).toBe("Keyword");
    expect(nodeNameAt(dialect, statement, "'合同类型'")).toBe("String");

    const doubleQuoteStatement = 'SELECT "escaped\\"quote", col FROM tbl';
    expect(nodeNameAt(dialect, doubleQuoteStatement, '"escaped\\"quote"')).toBe("String");
    expect(nodeNameAt(dialect, doubleQuoteStatement, "col")).toBe("Identifier");
  });
});
