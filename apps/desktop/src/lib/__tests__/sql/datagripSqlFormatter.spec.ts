import { describe, expect, it } from "vitest";
import { mysql, postgresql, sqlite } from "sql-formatter";
import { formatDataGripSql } from "@/lib/sql/datagrip";
import { DataGripFormatBudgetError, MAX_DATAGRIP_INPUT_CHARS } from "@/lib/sql/datagrip/format";
import { DEFAULT_SQL_FORMATTER_SETTINGS } from "@/lib/sql/sqlFormatterConfig";
import corpus from "./fixtures/datagrip/format-corpus.json";
import implementationCorpus from "./fixtures/datagrip/implementation-corpus.json";
import differences from "./fixtures/datagrip/format-differences.json";

const dialectOptions = { postgres: postgresql, mysql, sqlite };
const settings = { ...DEFAULT_SQL_FORMATTER_SETTINGS, keywordCase: "preserve" as const, tabWidth: 4 as const };
const implementations = new Map(implementationCorpus.map((item) => [`${item.dialect}/${item.name}`, item]));
const documentedDifferences = new Map(differences.map((item) => [`${item.dialect}/${item.name}`, item.reason]));

async function format(item: (typeof corpus)[number]) {
  const request = {
    dialect: item.dialect as "postgres" | "mysql" | "sqlite",
    dialectOptions: dialectOptions[item.dialect as keyof typeof dialectOptions],
    settings,
    paramTypes: null,
  };
  return formatDataGripSql({ ...request, sql: item.input });
}

describe("DataGrip SQL formatter differential corpus", () => {
  it.each(corpus.map((item) => [item.dialect, item.name, item] as const))("%s / %s", async (_dialect, _name, item) => {
    const result = await format(item);
    const key = `${item.dialect}/${item.name}`;
    const difference = documentedDifferences.get(key);
    const expected = difference ? implementations.get(key)?.actual : item.expected;
    expect(expected).toBeDefined();
    expect(result.formatted).toBe(expected);
    if (difference) expect(result.formatted).not.toBe(item.expected);
    expect(result.metrics.astNodes).toBeGreaterThan(0);
    expect(result.metrics.blockNodes).toBeGreaterThan(0);

    const again = await formatDataGripSql({
      sql: result.formatted,
      dialect: item.dialect as "postgres" | "mysql" | "sqlite",
      dialectOptions: dialectOptions[item.dialect as keyof typeof dialectOptions],
      settings,
      paramTypes: null,
    });
    expect(again.formatted).toBe(result.formatted);
  });

  it("rejects an excessive input before constructing the AST", async () => {
    await expect(
      formatDataGripSql({
        sql: " ".repeat(MAX_DATAGRIP_INPUT_CHARS + 1),
        dialect: "postgres",
        dialectOptions: postgresql,
        settings,
        paramTypes: null,
      }),
    ).rejects.toBeInstanceOf(DataGripFormatBudgetError);
  });
  it("records the exact compatibility and documented-difference counts", () => {
    expect(corpus.length).toBe(43);
    expect(differences.length).toBe(5);
    expect(corpus.filter((item) => !documentedDifferences.has(`${item.dialect}/${item.name}`)).length).toBe(38);
  });
});
