import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canFormatSqlForDatabaseType, formatSqlForDisplay, formatSqlForEditing, formatSqlText, MAX_SQL_FORMAT_CHARS, sqlFormatDialectForDbType, UnsupportedStructuredInputError } from "@/lib/sql/sqlFormatter";
import { extractSqlParameters } from "@/lib/sql/sqlParameters";

const sqlFormatterSource = readFileSync(new URL("../../sql/sqlFormatter.ts", import.meta.url), "utf8");

describe("sqlFormatter", () => {
  it("does not use lookbehind regular expressions in the startup path", () => {
    expect(sqlFormatterSource).not.toContain("(?<!");
    expect(sqlFormatterSource).not.toContain("(?<=");
  });

  it("disables SQL formatting for VictoriaMetrics queries", () => {
    expect(canFormatSqlForDatabaseType("victoriametrics")).toBe(false);
    expect(canFormatSqlForDatabaseType("mysql")).toBe(true);
  });

  it("preserves source empty lines only when configured", async () => {
    const sql = "-- tstt\n\nSELECT * FROM AUX_TABLE AS au LIMIT 100;";
    const consecutiveEmptyLines = "-- section\n\n\nSELECT 1;";
    const queriesWithEmptyLine = "SELECT 1;\n\nSELECT 2;";
    const queriesWithTwoEmptyLines = "SELECT 1;\n\n\nSELECT 2;";

    const defaultFormatted = await formatSqlForEditing(sql, "generic");
    const preserved = await formatSqlForEditing(sql, "generic", { preserveEmptyLines: true });
    const preservedConsecutive = await formatSqlForEditing(consecutiveEmptyLines, "generic", { preserveEmptyLines: true });
    const preservedQueriesNoSpacing = await formatSqlForEditing(queriesWithEmptyLine, "generic", { preserveEmptyLines: true, linesBetweenQueries: 0 });
    const preservedQueries = await formatSqlForEditing(queriesWithEmptyLine, "generic", { preserveEmptyLines: true, linesBetweenQueries: 1 });
    const preservedQueriesWideSpacing = await formatSqlForEditing(queriesWithEmptyLine, "generic", { preserveEmptyLines: true, linesBetweenQueries: 2 });
    const preservedQueriesWithTwoEmptyLines = await formatSqlForEditing(queriesWithTwoEmptyLines, "generic", { preserveEmptyLines: true, linesBetweenQueries: 1 });

    expect(defaultFormatted).toContain("-- tstt\nSELECT");
    expect(preserved).toContain("-- tstt\n\nSELECT");
    expect(preservedConsecutive).toContain("-- section\n\n\nSELECT");
    expect(preservedQueriesNoSpacing).toBe("SELECT\n  1;\n\nSELECT\n  2;");
    expect(preservedQueries).toBe("SELECT\n  1;\n\nSELECT\n  2;");
    expect(preservedQueriesWideSpacing).toBe("SELECT\n  1;\n\n\nSELECT\n  2;");
    expect(preservedQueriesWithTwoEmptyLines).toBe("SELECT\n  1;\n\n\nSELECT\n  2;");
    expect(preserved).not.toContain("__DBX_PRESERVE_EMPTY_LINE_");
  });

  it("maps PostgreSQL-compatible database types to the postgres formatter dialect", () => {
    for (const dbType of ["postgres", "kwdb", "gaussdb", "opengauss", "questdb", "kingbase", "highgo", "vastbase", "redshift"]) {
      expect(sqlFormatDialectForDbType(dbType)).toBe("postgres");
    }
  });

  it("maps SQLite-compatible database types to the sqlite formatter dialect", () => {
    for (const dbType of ["sqlite", "rqlite", "turso", "cloudflare-d1"]) {
      expect(sqlFormatDialectForDbType(dbType)).toBe("sqlite");
    }
  });

  it("maps Dameng to its scoped formatter dialect", () => {
    expect(sqlFormatDialectForDbType("dameng")).toBe("dameng");
  });

  it("maps DuckDB to its scoped formatter dialect", () => {
    expect(sqlFormatDialectForDbType("duckdb")).toBe("duckdb");
  });

  it("maps Oracle and OceanBase Oracle mode to the PL/SQL formatter dialect", () => {
    expect(sqlFormatDialectForDbType("oracle")).toBe("oracle");
    // OceanBase Oracle mode speaks Oracle SQL — issue #7540: it must reuse the
    // Oracle dialect so view DDL previews are formatted instead of one line.
    expect(sqlFormatDialectForDbType("oceanbase-oracle")).toBe("oracle");
  });

  it("formats an OceanBase Oracle single-line view DDL into readable multi-line SQL (issue #7540)", async () => {
    const singleLine = `CREATE OR REPLACE VIEW "APP"."ACTIVE_USERS" AS SELECT ID, NAME FROM USERS WHERE STATUS = 'ACTIVE'`;
    const formatted = await formatSqlForDisplay(singleLine, sqlFormatDialectForDbType("oceanbase-oracle"));

    expect(formatted).not.toBe(singleLine);
    expect(formatted.split("\n").length).toBeGreaterThan(1);
    expect(formatted).toContain("CREATE OR REPLACE VIEW");
    expect(formatted).toMatch(/\bSELECT\b/);
    expect(formatted).toMatch(/\bFROM\b/);
    expect(formatted).toMatch(/\bWHERE\b/);
    // String literals and quoted identifiers must survive formatting untouched.
    expect(formatted).toContain("'ACTIVE'");
    expect(formatted).toContain('"ACTIVE_USERS"');
  });

  it("formats a bare OceanBase Oracle view source wrapped as CREATE VIEW (issue #7540)", async () => {
    // Mirrors the backend build_view_ddl_sql output for a fallback ALL_VIEWS.TEXT
    // body: `CREATE VIEW <name> AS <single-line SELECT>`.
    const wrapped = `CREATE VIEW "APP"."ACTIVE_USERS" AS
SELECT ID, NAME FROM USERS WHERE STATUS = 'ACTIVE';`;
    const formatted = await formatSqlForDisplay(wrapped, sqlFormatDialectForDbType("oceanbase-oracle"));

    expect(formatted.split("\n").length).toBeGreaterThan(2);
    expect(formatted).toMatch(/\bSELECT\b/);
    expect(formatted).toMatch(/\bFROM\b/);
    expect(formatted).toMatch(/\bWHERE\b/);
    expect(formatted).toContain("'ACTIVE'");
  });

  it("does not split string literals when formatting an OceanBase Oracle view (issue #7540)", async () => {
    const singleLine = `CREATE OR REPLACE VIEW "APP"."V" AS SELECT 'SELECT X FROM Y' AS TXT FROM DUAL`;
    const formatted = await formatSqlForDisplay(singleLine, sqlFormatDialectForDbType("oceanbase-oracle"));

    expect(formatted).toContain("'SELECT X FROM Y'");
  });

  it("leaves an already multi-line OceanBase Oracle view DDL semantically intact (issue #7540)", async () => {
    const multiLine = `CREATE OR REPLACE VIEW "APP"."ACTIVE_USERS" AS
SELECT
  ID,
  NAME
FROM USERS
WHERE STATUS = 'ACTIVE';`;
    const formatted = await formatSqlForDisplay(multiLine, sqlFormatDialectForDbType("oceanbase-oracle"));

    expect(formatted).toContain('"ACTIVE_USERS"');
    expect(formatted).toContain("'ACTIVE'");
    expect(formatted).toMatch(/\bID\b/);
    expect(formatted).toMatch(/\bNAME\b/);
    expect(formatted).toMatch(/\bWHERE\b/);
  });

  it("keeps issue #7138 Oracle hierarchy clauses intact", async () => {
    const sql = "SELECT ctt.U_DM FROM cte_test ctt START WITH ctt.SU_DM IN ('16','17','18','19') CONNECT BY PRIOR ctt.U_DM = HY.SU_DM;";

    await expect(formatSqlForEditing(sql, sqlFormatDialectForDbType("oracle"))).resolves.toBe(`SELECT
  ctt.U_DM
FROM
  cte_test ctt
START WITH ctt.SU_DM IN ('16', '17', '18', '19')
CONNECT BY PRIOR ctt.U_DM = HY.SU_DM;`);
  });

  it("formats valid Oracle hierarchy clauses with the same alias", async () => {
    const sql = "SELECT ctt.U_DM FROM cte_test ctt START WITH ctt.SU_DM = '16' CONNECT BY PRIOR ctt.U_DM = ctt.SU_DM;";

    const formatted = await formatSqlForEditing(sql, sqlFormatDialectForDbType("oracle"));

    expect(formatted).toContain("FROM\n  cte_test ctt\nSTART WITH ctt.SU_DM = '16'");
    expect(formatted).toContain("\nCONNECT BY PRIOR ctt.U_DM = ctt.SU_DM;");
  });

  it("formats ordinary Oracle SQL and anonymous PL/SQL", async () => {
    await expect(formatSqlForEditing("select employee_id from employees where department_id = 10;", sqlFormatDialectForDbType("oracle"))).resolves.toBe("SELECT\n  employee_id\nFROM\n  employees\nWHERE\n  department_id = 10;");
    await expect(formatSqlForEditing("declare v_count number := 1; begin v_count := v_count + 1; end;", sqlFormatDialectForDbType("oracle"))).resolves.toBe("DECLARE v_count number := 1;\n\nBEGIN v_count := v_count + 1;\n\nEND;");
  });

  it("keeps incomplete Oracle editor SQL unchanged", async () => {
    const sql = "select *\nfrom dbname.\n;";

    await expect(formatSqlForEditing(sql, sqlFormatDialectForDbType("oracle"))).resolves.toBe(sql);
  });

  it("keeps DuckDB prefix aliases out of formatted named parameters", async () => {
    const cases = [
      ["select 日期:date(订单日期) from 订单;", []],
      ['select total:price * quantity, "order":sum(amount) from sales;', []],
      ["from r:range(:row_count) select total:r.range + :offset;", ["row_count", "offset"]],
      ["select res: col1 + col2, root: sqrt(col1) from tbl;", []],
    ] as const;

    for (const [sql, expectedParameters] of cases) {
      const formatted = await formatSqlText(sql, sqlFormatDialectForDbType("duckdb"));

      expect(formatted).not.toBe(sql);
      expect(extractSqlParameters(formatted, { databaseType: "duckdb" })).toEqual(expectedParameters);
      expect(formatted).not.toContain("__DBX_DUCKDB_PREFIX_ALIAS_COLON_");
    }
  });

  it("keeps ordinary DuckDB named parameters enabled independently of prefix aliases", async () => {
    const formatted = await formatSqlText("select :outside, total:price from sales;", sqlFormatDialectForDbType("duckdb"));

    expect(extractSqlParameters(formatted, { databaseType: "duckdb" })).toEqual(["outside"]);
    expect(extractSqlParameters(formatted, { databaseType: "duckdb", enabledSyntaxes: [] })).toEqual([]);
  });

  it("does not change generic formatting of compact colon syntax", async () => {
    const formatted = await formatSqlText("select total:price from sales;", "generic");

    expect(extractSqlParameters(formatted, { databaseType: "postgres" })).toEqual(["price"]);
  });

  it("preserves DuckDB strings and comments while protecting prefix aliases", async () => {
    const sql = `select total:price, 'literal:date', $$dollar:date
AND inside
OR inside$$ as note
      from sales /* alias:date */ /*__DBX_DUCKDB_PREFIX_ALIAS_COLON_0__*/ -- trailing:date`;
    const formatted = await formatSqlText(sql, sqlFormatDialectForDbType("duckdb"), { logicalOperatorNewline: "none" });

    expect(extractSqlParameters(formatted, { databaseType: "duckdb" })).toEqual([]);
    expect(formatted).toContain("'literal:date'");
    expect(formatted).toContain("$$dollar:date\nAND inside\nOR inside$$");
    expect(formatted).toContain("/* alias:date */");
    expect(formatted).toContain("/*__DBX_DUCKDB_PREFIX_ALIAS_COLON_0__*/");
    expect(formatted).toContain("-- trailing:date");
  });

  it("keeps DuckDB casts, named arguments, and their real parameters intact", async () => {
    const sql = "select struct_pack(key := :value), total:price, value::integer;";
    const formatted = await formatSqlText(sql, sqlFormatDialectForDbType("duckdb"));

    expect(extractSqlParameters(formatted, { databaseType: "duckdb" })).toEqual(["value"]);
    expect(formatted).toContain("value::integer");
  });

  it("returns unsupported DuckDB struct literals unchanged without leaking formatter markers", async () => {
    const sql = "select {'key': value, nested: {'inner': inner_value}}, total:price;";
    const formatted = await formatSqlForEditing(sql, sqlFormatDialectForDbType("duckdb"));

    expect(formatted).toBe(sql);
    expect(extractSqlParameters(formatted, { databaseType: "duckdb" })).toEqual([]);
    expect(formatted).not.toContain("__DBX_DUCKDB_PREFIX_ALIAS_COLON_");
  });

  it("returns malformed DuckDB SQL unchanged without leaking formatter markers", async () => {
    const sql = "select total:price from dbname.\n;";

    const formatted = await formatSqlForEditing(sql, sqlFormatDialectForDbType("duckdb"));

    expect(formatted).toBe(sql);
    expect(formatted).not.toContain("__DBX_DUCKDB_PREFIX_ALIAS_COLON_");
  });

  it("preserves ClickHouse lambda arrows when formatting issue #3573 SQL", async () => {
    const sql = `
      WITH industry_code_donghua_id_RYCzfD AS (SELECT id
      FROM cd.industry_code_donghua
      WHERE cd.industry_code_donghua.code IN ('INB0709', 'INB0004'))
      SELECT id,ent_short,arrayMap(x->dictGet(cd.industry_donghua_dict,'name',x),prefer_industry) as prefer_industry_name,org_type,company_id,arrayCount(\`investment.be_company_id\` -> 1, \`investment.be_company_id\`) as be_company_count
      FROM search_donghua.investor
      WHERE arrayExists(x -> x IN industry_code_donghua_id_RYCzfD, prefer_industry)
      ORDER BY be_company_count DESC,id ASC
      LIMIT 0,10
    `;

    const formatted = await formatSqlText(sql, sqlFormatDialectForDbType("clickhouse"));

    expect(formatted).toContain("x -> dictGet");
    expect(formatted).not.toContain("- >");
  });

  it("preserves the ClickHouse table alias from issue #7079", async () => {
    const formatted = await formatSqlText("SELECT *\nFROM MATERIAL m\nLIMIT 100;", sqlFormatDialectForDbType("clickhouse"));

    expect(formatted).toBe("SELECT\n  *\nFROM\n  MATERIAL m\nLIMIT\n  100;");
  });

  it.each(["d", "dd", "h", "hh", "m", "mcs", "mi", "mm", "ms", "n", "ns", "q", "qq", "s", "ss", "wk", "ww", "yy", "yyyy"])("preserves ClickHouse identifier-like date part %s while formatting keywords", async (identifier) => {
    const formatted = await formatSqlText(`select ${identifier}, t.${identifier} from material ${identifier} limit 100;`, sqlFormatDialectForDbType("clickhouse"));

    expect(formatted).toContain(`  ${identifier},`);
    expect(formatted).toContain(`material ${identifier}`);
    expect(formatted).toContain("SELECT");
    expect(formatted).toContain("FROM");
    expect(formatted).toContain("LIMIT");
  });

  it("keeps ClickHouse identifier casing independent from keyword casing", async () => {
    const sql = "SELECT * FROM MATERIAL M LIMIT 100;";

    const lowerKeywords = await formatSqlText(sql, sqlFormatDialectForDbType("clickhouse"), { keywordCase: "lower", identifierCase: "preserve" });
    const lowerIdentifiers = await formatSqlText(sql, sqlFormatDialectForDbType("clickhouse"), { keywordCase: "upper", identifierCase: "lower" });

    expect(lowerKeywords).toContain("from\n  MATERIAL M");
    expect(lowerKeywords).toContain("limit\n  100");
    expect(lowerIdentifiers).toContain("FROM\n  material m");
    expect(lowerIdentifiers).toContain("LIMIT\n  100");
  });

  it("still formats unambiguous ClickHouse interval keywords", async () => {
    const formatted = await formatSqlText("select now() + interval 1 minutes from source_table m;", sqlFormatDialectForDbType("clickhouse"));

    expect(formatted).toContain("INTERVAL 1 MINUTES");
    expect(formatted).toContain("FROM\n  source_table m");
  });

  it("preserves DBX brace placeholders in generic and MySQL SQL", async () => {
    const sql = "SELECT ${x} AS shell_value, #{x} AS mybatis_value, '${date}' AS quoted_value";

    for (const dialect of ["generic", "mysql"] as const) {
      const formatted = await formatSqlText(sql, dialect);

      expect(formatted).toContain("${x}");
      expect(formatted).toContain("#{x}");
      expect(formatted).toContain("'${date}'");
    }
  });

  it.each(["mysql", "sqlite"] as const)("applies keyword case to LIKE operators in the %s dialect", async (dialect) => {
    const sql = "select * from users where name like '%like%' and note not like 'LIKE'";

    const upper = await formatSqlText(sql, dialect, { keywordCase: "upper", functionCase: "preserve" });
    const lower = await formatSqlText(sql.toUpperCase(), dialect, { keywordCase: "lower", functionCase: "preserve", identifierCase: "lower" });

    expect(upper).toContain("name LIKE '%like%'");
    expect(upper).toContain("note NOT LIKE 'LIKE'");
    expect(lower).toContain("name like '%LIKE%'");
    expect(lower).toContain("note not like 'LIKE'");
  });

  it("keeps SQLite LIKE functions and qualified identifiers under their own case settings", async () => {
    const formatted = await formatSqlText("select like('%a%', name), filters.like from users", "sqlite", {
      keywordCase: "upper",
      functionCase: "preserve",
      identifierCase: "preserve",
    });

    expect(formatted).toContain("like(");
    expect(formatted).toContain("filters.like");
  });

  it.each(["mysql", "sqlite"] as const)("does not rewrite LIKE inside DBX placeholders in the %s dialect", async (dialect) => {
    for (const [lowerPlaceholder, upperPlaceholder] of [
      ["${like}", "${LIKE}"],
      ["#{like}", "#{LIKE}"],
      [":like", ":LIKE"],
      ["@like", "@LIKE"],
    ]) {
      const upper = await formatSqlText(`select * from users where name like 'a';\nselect ${lowerPlaceholder} as marker`, dialect, {
        keywordCase: "upper",
        functionCase: "preserve",
      });
      const lower = await formatSqlText(`SELECT * FROM users WHERE name LIKE 'a';\nSELECT ${upperPlaceholder} AS marker`, dialect, {
        keywordCase: "lower",
        functionCase: "preserve",
        identifierCase: "lower",
      });

      expect(upper).toContain(lowerPlaceholder);
      expect(upper).toContain("name LIKE 'a'");
      expect(lower).toContain(upperPlaceholder);
      expect(lower).toContain("name like 'a'");
    }
  });

  it("falls back to the postgres formatter when the generic dialect cannot parse SQL", async () => {
    const formatted = await formatSqlText("SELECT 1::int AS id;", "generic");

    expect(formatted).toContain("1::int");
    expect(formatted).toContain("AS id");
  });

  it("formats complete backtick-quoted spans with the PostgreSQL dialect", async () => {
    const formatted = await formatSqlText("select `schema`.`odd``name` from user;", "postgres");

    expect(formatted).toBe("SELECT\n  `schema`.`odd``name`\nFROM\n  user;");
  });

  it("keeps PostgreSQL double-quoted identifiers and casts unchanged", async () => {
    const formatted = await formatSqlText('select "display""name" from records where payload::jsonb is not null;', "postgres");

    expect(formatted).toBe('SELECT\n  "display""name"\nFROM\n  records\nWHERE\n  payload::jsonb IS NOT NULL;');
  });

  it("keeps MySQL backtick formatting unchanged", async () => {
    const formatted = await formatSqlText("select `schema`.`odd``name` from `user`;", "mysql");

    expect(formatted).toBe("SELECT\n  `schema`.`odd``name`\nFROM\n  `user`;");
  });

  it("keeps malformed PostgreSQL backtick input unchanged while editing", async () => {
    const sql = "select `id from user;";

    await expect(formatSqlText(sql, "postgres")).rejects.toThrow("Parse error: Unexpected");
    await expect(formatSqlForEditing(sql, "postgres")).resolves.toBe(sql);
  });

  it("formats Dameng SQL with a standalone trailing dot without changing the invalid token", async () => {
    const sql = `SELECT JS1.REC_CREATOR as "recCreator", JS1.REC_CREATOR_JOB_ID as "recCreatorJobId" FROM APSSC.TMPJS01 JS1 WHERE 1=1 AND JS1.SUBSTR(REC_CREATE_TIME,1,8) = ? ORDER BY DECODE(JS1.STATUS,'DRAFT',1,'PENDING_APPROVAL',2,'APPROVED',3,'POSTED',4,'REJECTED',5,'DELETED',6), JS1.REC_CREATE_TIME DESC .`;

    const formatted = await formatSqlForEditing(sql, sqlFormatDialectForDbType("dameng"));

    expect(formatted).toContain('JS1.REC_CREATOR AS "recCreator"');
    expect(formatted).toContain("DECODE (");
    expect(formatted.endsWith("JS1.REC_CREATE_TIME DESC .")).toBe(true);
  });

  it("only recovers a whitespace-separated final dot", async () => {
    await expect(formatSqlText("SELECT schema.", "dameng")).rejects.toThrow();
    await expect(formatSqlText("SELECT 1..", "dameng")).rejects.toThrow();
    await expect(formatSqlText("SELECT 'value .'", "dameng")).resolves.toContain("'value .'");
  });

  it("preserves whitespace after a recovered trailing dot", async () => {
    await expect(formatSqlForEditing("SELECT 1 .\n", "dameng")).resolves.toBe("SELECT\n  1 .\n");
  });

  it("preserves the newline before a trailing dot after a line comment", async () => {
    await expect(formatSqlForEditing("DELETE FROM accounts -- comment\n .", "dameng")).resolves.toBe("DELETE FROM accounts -- comment\n .");
  });

  it("does not change trailing-dot formatting for other databases", async () => {
    await expect(formatSqlText("SELECT 1 .", "generic")).rejects.toThrow();
    await expect(formatSqlForEditing("SELECT 1 .", "generic")).resolves.toBe("SELECT 1 .");
  });

  it("keeps incomplete editor SQL unchanged when the formatter cannot parse it", async () => {
    const sql = "select *\nfrom dbname.\n;";

    await expect(formatSqlText(sql, "mysql")).rejects.toThrow("Parse error at token:");
    await expect(formatSqlForEditing(sql, "mysql")).resolves.toBe(sql);
  });

  it("keeps editor SQL unchanged when it contains full-width characters the tokenizer can't parse", async () => {
    const sql = "update t set a=concat(t.入池时间（审核通过时间）,' 00:00:00') where t.入池时间（审核通过时间） ≠ '';";

    await expect(formatSqlText(sql, "mysql")).rejects.toThrow("Parse error: Unexpected");
    await expect(formatSqlForEditing(sql, "mysql")).resolves.toBe(sql);
  });

  it("keeps non-parse editor formatting failures visible", async () => {
    const oversizedSql = "x".repeat(MAX_SQL_FORMAT_CHARS + 1);

    await expect(formatSqlForEditing(oversizedSql, "mysql")).rejects.toThrow("SQL is too large to format safely.");
  });

  it("returns the original SQL for display when formatting fails", async () => {
    const oversizedSql = "x".repeat(MAX_SQL_FORMAT_CHARS + 1);

    await expect(formatSqlText(oversizedSql, "postgres")).rejects.toThrow("SQL is too large to format safely.");
    await expect(formatSqlForDisplay(oversizedSql, "postgres")).resolves.toBe(oversizedSql);
  });

  it("refuses to format XML-looking input instead of corrupting it (regression: silent rewrite)", async () => {
    const xml = `<root><item id="1">value</item></root>`;

    // The SQL formatter previously accepted this and rewrote it into corrupted
    // output (`< root > < item id = "1" > ...`). It must now be refused so no
    // caller can ever write sql-formatter output back over the user's text.
    await expect(formatSqlText(xml, "generic")).rejects.toBeInstanceOf(UnsupportedStructuredInputError);
    await expect(formatSqlText(xml, "postgres")).rejects.toBeInstanceOf(UnsupportedStructuredInputError);
  });

  it("still formats selected SQL Server bracket-quoted identifiers", async () => {
    await expect(formatSqlText(`[dbo].[orders]`, "sqlserver")).resolves.toBe(`[dbo].[orders]`);
  });

  it("still formats selected SQL comparison fragments", async () => {
    await expect(formatSqlText(`< 10`, "postgres")).resolves.toBe(`< 10`);
    await expect(formatSqlText(`< 10 AND score > 2`, "postgres")).resolves.toBe(`< 10\nAND score > 2`);
  });

  it("keeps logical conditions on one line when configured", async () => {
    const formatted = await formatSqlText("SELECT * FROM t WHERE a = 1 AND b = 2", "mysql", { logicalOperatorNewline: "none" });

    expect(formatted).toContain("a = 1 AND b = 2");
    expect(formatted).not.toMatch(/\n\s*AND\b/i);
  });

  it("does not collapse AND/OR line breaks inside block comments (regression: comment reformatting)", async () => {
    // sql-formatter preserves newlines inside /* ... */ verbatim, so the
    // keepLogicalOperatorsOnSameLine post-pass used to fold the comment's
    // internal `AND`/`OR` onto one line along with the real clause `AND`.
    // The comment body must stay multi-line; only the clause-level AND gets
    // pulled back onto the previous (comment-closing) line instead of sitting
    // alone on its own line.
    const sql = "SELECT * FROM t WHERE 1 = 1 /* note:\nAND is a keyword here\nOR also */ AND b = 2";

    for (const dialect of ["mysql", "postgres", "generic"] as const) {
      const formatted = await formatSqlText(sql, dialect, { logicalOperatorNewline: "none" });

      // 注释内部多行结构必须保留
      expect(formatted).toContain("/* note:");
      expect(formatted).toContain("AND is a keyword here");
      expect(formatted).toContain("OR also */");
      // 注释内部 AND/OR 仍各自独占一行（前面是换行）
      expect(formatted).toMatch(/note:\n\s*AND is a keyword here/);
      expect(formatted).toMatch(/keyword here\n\s*OR also/);
      // 真正子句间的 AND 换行应被折叠：AND b = 2 不再独占行首
      expect(formatted).toContain("*/ AND b = 2");
      expect(formatted).not.toMatch(/\n\s*AND b = 2/);
    }
  });

  it("does not collapse AND/OR inside single-quoted string literals", async () => {
    // 字符串字面量内的 AND/OR 也不应被当作逻辑算子折叠。这里用一个含换行的
    // 字符串（虽然 sql-formatter 通常会把字符串单行化，但遮罩应防御性覆盖）。
    const sql = "SELECT 'a\nAND b\nOR c' AS s WHERE x = 1 AND y = 2";

    const formatted = await formatSqlText(sql, "postgres", { logicalOperatorNewline: "none" });

    expect(formatted).toContain("'a\nAND b\nOR c'");
    expect(formatted).toContain("x = 1 AND y = 2");
  });

  it("can keep FROM and the first table on the same line", async () => {
    const formatted = await formatSqlText("SELECT * FROM tVillage AS tv INNER JOIN tLand AS tl ON tv.villageId = tl.villageId AND 1 = 1", "sqlserver", {
      fromClauseLayout: "sameLine",
      logicalOperatorNewline: "none",
      useTabs: true,
      tabWidth: 4,
    });

    expect(formatted).toContain("FROM\ttVillage AS tv");
    expect(formatted).toContain("ON tv.villageId = tl.villageId AND 1 = 1");
  });

  it("keeps derived tables multiline with FROM same-line layout", async () => {
    const formatted = await formatSqlText("SELECT * FROM (SELECT * FROM tVillage) AS tv", "sqlserver", { fromClauseLayout: "sameLine" });

    expect(formatted).toContain("FROM\n");
    expect(formatted).toContain("\n    SELECT");
    expect(formatted).toContain("FROM  tVillage");
  });

  it("keeps display formatting lossless for XML/JSON-looking input", async () => {
    const xml = `<root><item id="1">value</item></root>`;
    const json = `{"a":1}`;

    await expect(formatSqlForDisplay(xml, "generic")).resolves.toBe(xml);
    await expect(formatSqlForDisplay(json, "generic")).resolves.toBe(json);
  });

  it("still formats genuine SQL that starts with a non-structured token", async () => {
    const formatted = await formatSqlText(`SELECT '{"a":1}'::jsonb AS j FROM t`, "postgres");

    expect(formatted).toContain("SELECT");
    expect(formatted).toContain("::jsonb");
  });
});
