import { describe, expect, it } from "vitest";
import { formatSqlForDisplay, formatSqlForEditing, formatSqlText } from "@/lib/sql/sqlFormatter";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";

function sqlTokens(sql: string) {
  return tokenizeSqlSemantic(sql, "mysql").map(({ kind, normalized }) => ({ kind, normalized }));
}

const viewSql =
  "ALTER ALGORITHM=UNDEFINED DEFINER=`root`@`127.0.0.1` SQL SECURITY DEFINER VIEW `v_format_repro` AS WITH `库存处理` AS (SELECT CAST(CASE WHEN `单位` LIKE '%/%' THEN REPLACE(SUBSTRING_INDEX(`单位`,'/',1),'只','1') ELSE REPLACE(`单位`,'只','1') END AS UNSIGNED) * `实收数量` AS `数量` FROM `库存`) SELECT `数量` FROM `库存处理`;";

describe("MySQL REPLACE function formatting", () => {
  it.each(["standard", "tabularLeft", "tabularRight"] as const)("formats CASE expressions in view DDL using the %s layout", async (indentStyle) => {
    const formatted = await formatSqlText(viewSql, "mysql", { indentStyle });

    expect(formatted.split("\n").length).toBeGreaterThan(1);
    expect(sqlTokens(formatted)).toEqual(sqlTokens(viewSql));
    expect(formatted).toContain("`root` @`127.0.0.1`");
  });

  it.each([formatSqlForEditing, formatSqlForDisplay])("formats the view through the editing and display entry points", async (format) => {
    const formatted = await format(viewSql, "mysql");
    expect(formatted).not.toBe(viewSql);
    expect(formatted.split("\n").length).toBeGreaterThan(1);
  });

  it("uses function casing for REPLACE calls and preserves quoted identifiers and literals", async () => {
    const source = "select case when 1 then RePlAcE('REPLACE INTO','INTO','结果') end as `REPLACE`";
    const formatted = await formatSqlText(source, "mysql", { keywordCase: "upper", functionCase: "lower" });

    expect(formatted).toContain("THEN replace('REPLACE INTO', 'INTO', '结果')");
    expect(formatted).toContain("AS `REPLACE`");
  });

  it("recognizes calls separated from their parentheses by comments", async () => {
    const source = "SELECT CASE WHEN 1 THEN replace /* block */ ('a','a','b') ELSE RePlAcE -- line\n('c','c','d') END AS `结果`";
    const formatted = await formatSqlText(source, "mysql", { functionCase: "lower" });

    expect(formatted).toContain("replace/* block */");
    expect(formatted).toMatch(/replace -- line\n\s*\(/);
    expect(sqlTokens(formatted)).toEqual(sqlTokens(source));
  });

  it("keeps REPLACE statements as clauses while formatting function calls inside them", async () => {
    const source = "replace into `库存` (`单位`) values ('a'); replace low_priority into `库存` set `单位` = REPLACE('a','a','b'); replace delayed `库存` (`单位`) values ('c');";
    const formatted = await formatSqlText(source, "mysql", { keywordCase: "upper", functionCase: "lower" });

    expect(formatted).toContain("REPLACE INTO");
    expect(formatted).toContain("REPLACE LOW_PRIORITY INTO");
    expect(formatted).toContain("REPLACE DELAYED");
    expect(formatted).toContain("replace('a', 'a', 'b')");
    expect(formatted).toContain("`库存`");
  });

  it("retains MySQL's existing SET datatype and VALUES function handling", async () => {
    const source = "CREATE TABLE `t` (`x` SET('a','b')); INSERT INTO `t` VALUES ('a') ON DUPLICATE KEY UPDATE `x` = VALUES(`x`);";
    const formatted = await formatSqlText(source, "mysql");

    expect(formatted).toMatch(/SET\s*\('a', 'b'\)/);
    expect(formatted).toContain("VALUES(`x`)");
  });
});
