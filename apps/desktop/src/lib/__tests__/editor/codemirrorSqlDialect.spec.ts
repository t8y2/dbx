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

  it("tokenizes T-SQL temp table names instead of erroring on the hash (#8267)", () => {
    const dialect = createDbxCodeMirrorSqlDialect(langSql, "sqlserver", "sqlserver");
    const statement = "select * into #GH_GHMXK from ##global_temp where b.jssjh = @sjh";

    // `#`/`##` prefixes used to fall through to a parser error token, leaving
    // temp table names unhighlighted; they share the SpecialVar channel with
    // @@variables, whose scanner handles the doubled prefix natively.
    expect(nodeNameAt(dialect, statement, "#GH_GHMXK")).toBe("SpecialVar");
    expect(nodeNameAt(dialect, statement, "##global_temp")).toBe("SpecialVar");
    expect(nodeNameAt(dialect, statement, "@sjh")).toBe("SpecialVar");
    expect(nodeNameAt(dialect, statement, "select")).toBe("Keyword");
    expect(nodeNameAt(dialect, statement, "into")).toBe("Keyword");

    // MySQL keeps interpreting `#` as a line comment — its dialect is untouched.
    const mysql = createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql");
    expect(nodeNameAt(mysql, "SELECT a FROM t -- x\nWHERE b = 1", "WHERE")).toBe("Keyword");
  });

  it("keeps double quotes as identifier delimiters for Oracle-family dialects", () => {
    const databaseTypes: DatabaseType[] = ["oracle", "dameng", "yashandb", "oscar", "oceanbase-oracle"];

    for (const databaseType of databaseTypes) {
      expect(createDbxCodeMirrorSqlDialect(langSql, "mysql", databaseType).spec.doubleQuotedStrings, databaseType).toBe(false);
    }
  });

  it("highlights core keywords for StandardSQL-based dialects (#8123)", () => {
    // IRIS/Caché (and every other StandardSQL-based type) previously resolved
    // with an empty keyword set, so SELECT/FROM/WHERE/AND rendered as plain
    // identifiers — exactly the highlighting the #8123 report shows.
    const reporterStatement = "select di.MR_ADM\nfrom SQLUser.DHCMRInfo di\nwhere di.MR_BAH = 1942487\n  and di.MR_RYRQ >= '2023-01-01'";
    for (const databaseType of ["iris", "jdbc", "h2", "db2", "hive"] as DatabaseType[]) {
      const dialect = createDbxCodeMirrorSqlDialect(langSql, "mysql", databaseType);
      for (const keyword of ["select", "from", "where", "and"]) {
        expect(nodeNameAt(dialect, reporterStatement, keyword), `${databaseType}:${keyword}`).toBe("Keyword");
      }
    }

    // Standard-SQL types gain a vocabulary too, while ClickHouse keeps its
    // pre-existing standard-vocabulary treatment unchanged.
    expect(createDbxCodeMirrorSqlDialect(langSql, "mysql", "iris").spec.types).toBe("array binary bit boolean char character clob date decimal double float int integer interval large national nchar nclob numeric object precision real smallint time timestamp varchar varying");
    const clickhouseDialect = createDbxCodeMirrorSqlDialect(langSql, "mysql", "clickhouse");
    expect(nodeNameAt(clickhouseDialect, "SELECT x FROM t WHERE y > 1", "WHERE")).toBe("Keyword");
  });

  it("enables backslashEscapes for MySQL-family dialects and ClickHouse while keeping it disabled for standard dialects", () => {
    const backslashEscapesTypes: DatabaseType[] = ["mysql", "doris", "starrocks", "manticoresearch", "goldendb", "gbase", "clickhouse", "hive", "spark", "impala", "argo", "databend"];
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
