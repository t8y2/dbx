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
  it.each([
    ["oracle", "SELECT NVL(\"name\", 'n/a') FROM t", '"name"', "QuotedIdentifier"],
    ["mysql", "SELECT IFNULL(`name`, 'n/a') FROM t", "`name`", "QuotedIdentifier"],
    ["postgres", "SELECT now(), data #>> '{name}' FROM t", "now", "Builtin"],
    ["sqlserver", "SELECT GETDATE() FROM #temp", "#temp", "SpecialVar"],
  ] as const)("uses the %s lexer for Kingbase without replacing its physical type", (mode, sql, token, expected) => {
    expect(nodeNameAt(createDbxCodeMirrorSqlDialect(langSql, mode, "kingbase"), sql, token)).toBe(expected);
  });

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

  // Verified against live servers rather than assumed:
  //   Oracle  `SELECT /* a /* b */ 1 FROM dual`      -> 1      (doubled */ -> ORA-00923)
  //   MySQL   `SELECT /* a /* b */ 1`                -> 1
  //   SQLite  `SELECT /* a /* b */ 1`                -> 1      (doubled */ -> syntax error)
  //   MSSQL   `SELECT /* a /* b */ */ 1`             -> 1      (single */ -> "missing end comment mark")
  // PostgreSQL and T-SQL both document nested block comments; the others close
  // at the first `*/`.
  it("does not nest block comments for Oracle, MySQL and SQLite", () => {
    // Real-world shape from an Oracle package body: a second `/*` appears before
    // the first `*/`. These dialects close the comment at the first `*/`, so the
    // code after it stays code. CodeMirror's SQL tokenizer otherwise nests
    // `/* */` and the comment state leaks downward, painting the rest of a
    // package body as a comment.
    const source = ["/* outer note /* inner marker */", "SELECT col FROM dual"].join("\n");

    for (const databaseType of ["oracle", "mysql", "sqlite"] as DatabaseType[]) {
      const dialect = createDbxCodeMirrorSqlDialect(langSql, "mysql", databaseType);
      expect(dialect.spec.nestedComments, databaseType).toBe(false);
      expect(nodeNameAt(dialect, source, "SELECT"), databaseType).toBe("Keyword");
      expect(nodeNameAt(dialect, source, "FROM"), databaseType).toBe("Keyword");
    }
  });

  it.each([
    ["postgres", "postgres"],
    ["sqlserver", "sqlserver"],
    // ClickHouse resolves to the StandardSQL base, so it needs its own row:
    // the Oracle/MySQL/SQLite case below cannot stand in for it.
    ["clickhouse", "clickhouse"],
  ] as const)("keeps nested block comments for %s, which documents them", (mode, databaseType) => {
    const dialect = createDbxCodeMirrorSqlDialect(langSql, mode, databaseType as DatabaseType);
    expect(dialect.spec.nestedComments).toBe(true);

    // Outer comment + nested comment + trailing SQL: both `*/` are consumed by
    // the comment, so the statement after it is live code.
    const closed = ["/* outer /* inner */ */", "SELECT 1"].join("\n");
    expect(nodeNameAt(dialect, closed, "SELECT"), `${databaseType} closed`).toBe("Keyword");

    // Only one `*/`: the nested level is still open, so the trailing SELECT
    // stays inside the comment — matching what these servers report.
    const stillOpen = ["/* outer /* inner */", "SELECT 1"].join("\n");
    expect(nodeNameAt(dialect, stillOpen, "SELECT"), `${databaseType} still open`).not.toBe("Keyword");
  });

  // db2, gbase8c and gbase8s resolve to the StandardSQL base, the same base
  // ClickHouse uses. ClickHouse documents nested comments and opts in above;
  // these three have no such documentation, so they keep the safe non-nesting
  // behaviour. Nesting them wrongly would re-introduce the runaway-comment bug,
  // whereas not nesting only ends a comment early — the cheaper mistake.
  it("leaves StandardSQL-based dialects non-nesting unless the engine documents nesting", () => {
    const source = ["/* outer note /* inner marker */", "SELECT col FROM t"].join("\n");

    for (const databaseType of ["db2", "gbase8c", "gbase8s"] as DatabaseType[]) {
      const dialect = createDbxCodeMirrorSqlDialect(langSql, "mysql", databaseType);
      expect(dialect.spec.nestedComments, databaseType).toBe(false);
      expect(nodeNameAt(dialect, source, "SELECT"), databaseType).toBe("Keyword");
    }

    // Same base, opposite setting — proves the flag is per dialect, not per base.
    expect(createDbxCodeMirrorSqlDialect(langSql, "clickhouse", "clickhouse").spec.nestedComments).toBe(true);
  });

  it("tags QuotedIdentifier as tags.name so quoted columns/tables match unquoted identifiers (#12122)", async () => {
    const { highlightTree, tags } = await import("@lezer/highlight");
    const { HighlightStyle } = await import("@codemirror/language");

    const style = HighlightStyle.define([
      { tag: tags.keyword, color: "keyword" },
      { tag: tags.string, color: "string" },
      { tag: tags.name, color: "identifier" },
    ]);

    const mysqlDialect = createDbxCodeMirrorSqlDialect(langSql, "mysql", "mysql");
    const doc = "SELECT `quoted_col`, plain_col, 'literal_string' FROM `tbl`";
    const tree = mysqlDialect.language.parser.parse(doc);
    const classes = new Map<string, string>();
    highlightTree(tree, style, (from, to, cls) => classes.set(doc.slice(from, to), cls));

    expect(classes.get("`quoted_col`")).toBeDefined();
    expect(classes.get("`quoted_col`")).toBe(classes.get("plain_col"));
    expect(classes.get("`quoted_col`")).toBe(classes.get("`tbl`"));
    expect(classes.get("`quoted_col`")).not.toBe(classes.get("'literal_string'"));
  });
});
