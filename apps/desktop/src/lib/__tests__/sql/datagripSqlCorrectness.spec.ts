import { describe, expect, it } from "vitest";
import { postgresql } from "sql-formatter";
import { formatDataGripSql } from "@/lib/sql/datagrip";
import { DEFAULT_SQL_FORMATTER_SETTINGS } from "@/lib/sql/sqlFormatterConfig";

const settings = { ...DEFAULT_SQL_FORMATTER_SETTINGS, keywordCase: "preserve" as const, tabWidth: 4 as const };

async function format(sql: string): Promise<string> {
  const result = await formatDataGripSql({ sql, dialect: "postgres", dialectOptions: postgresql, settings, paramTypes: null });
  const again = await formatDataGripSql({ sql: result.formatted, dialect: "postgres", dialectOptions: postgresql, settings, paramTypes: null });
  expect(again.formatted).toBe(result.formatted);
  return result.formatted;
}

describe("DataGrip literal and comment preservation", () => {
  it("keeps dollar-quoted procedure text byte-for-byte", async () => {
    const output = await format("SELECT $msg$BEGIN message END$msg$;");
    expect(output).toContain("$msg$BEGIN message END$msg$");
    expect(Buffer.from(output, "utf8").toString("hex")).toContain("424547494e206d65737361676520454e44");
    expect(output).not.toContain("BEGIN message\nEND");
  });

  it("preserves CRLF inside multiline string literals", async () => {
    const output = await format("SELECT 'one\r\ntwo';");
    expect(output).toContain("'one\r\ntwo'");
    expect(Buffer.from(output, "utf8").toString("hex")).toContain("6f6e650d0a74776f");
    expect(output).not.toContain("'one\ntwo'");
  });

  it.each([
    ["function call", "SELECT coalesce(NULL, 2 -- fallback\n);", /-- fallback\n\);/],
    ["IN list", "SELECT * FROM users WHERE id IN (1, 2 -- two\n);", /-- two\n\);/],
    ["CTE", "WITH x AS (SELECT 1 AS a -- one\n) SELECT * FROM x;", /-- one\n\s*\)\nSELECT/],
  ])("keeps the closing delimiter after a trailing line comment in a %s", async (_name, sql, expected) => {
    expect(await format(sql)).toMatch(expected);
  });

  it("preserves comments around a qualified-name dot", async () => {
    const output = await format("SELECT d. -- field\na FROM (SELECT 1 AS a) d;");
    expect(output).toContain("d. -- field\na");
    expect(output).toContain("FROM (SELECT 1 AS a) d;");
  });

  it("keeps the FROM clause after a trailing comment in a scalar subquery", async () => {
    const output = await format("SELECT * FROM t WHERE x = (SELECT max(y) -- m\nFROM z);");
    expect(output).toMatch(/-- m\n\s*FROM z/);
  });

  it("keeps ELSE and END after a trailing comment in CASE", async () => {
    const output = await format("SELECT CASE WHEN a THEN 1 -- k\nELSE 2 END;");
    expect(output).toMatch(/-- k\n\s*ELSE 2 END/);
  });

  it("keeps a comma after a trailing line comment on the following line", async () => {
    const output = await format("SELECT a -- c1\n, b FROM t;");
    expect(output).toContain("-- c1\n, b");
  });
});
