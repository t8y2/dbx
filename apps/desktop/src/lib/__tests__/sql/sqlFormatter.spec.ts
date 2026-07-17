import { describe, expect, it } from "vitest";
import { formatSqlForDisplay, formatSqlText, MAX_SQL_FORMAT_CHARS, sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";

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

  it("returns the original SQL for display when formatting fails", async () => {
    const oversizedSql = "x".repeat(MAX_SQL_FORMAT_CHARS + 1);

    await expect(formatSqlText(oversizedSql, "postgres")).rejects.toThrow("SQL is too large to format safely.");
    await expect(formatSqlForDisplay(oversizedSql, "postgres")).resolves.toBe(oversizedSql);
  });
});
