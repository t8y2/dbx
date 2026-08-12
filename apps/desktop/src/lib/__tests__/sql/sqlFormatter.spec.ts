import { describe, expect, it } from "vitest";
import { formatSqlForDisplay, formatSqlForEditing, formatSqlText, MAX_SQL_FORMAT_CHARS, sqlFormatDialectForDbType, UnsupportedStructuredInputError } from "@/lib/sql/sqlFormatter";

describe("sqlFormatter", () => {
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
  it("preserves DBX brace placeholders in generic and MySQL SQL", async () => {
    const sql = "SELECT ${x} AS shell_value, #{x} AS mybatis_value, '${date}' AS quoted_value";

    for (const dialect of ["generic", "mysql"] as const) {
      const formatted = await formatSqlText(sql, dialect);

      expect(formatted).toContain("${x}");
      expect(formatted).toContain("#{x}");
      expect(formatted).toContain("'${date}'");
    }
  });

  it("falls back to the postgres formatter when the generic dialect cannot parse SQL", async () => {
    const formatted = await formatSqlText("SELECT 1::int AS id;", "generic");

    expect(formatted).toContain("1::int");
    expect(formatted).toContain("AS id");
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
