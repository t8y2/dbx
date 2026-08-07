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

  it("keeps incomplete editor SQL unchanged when the formatter cannot parse it", async () => {
    const sql = "select *\nfrom dbname.\n;";

    await expect(formatSqlText(sql, "mysql")).rejects.toThrow("Parse error at token:");
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
