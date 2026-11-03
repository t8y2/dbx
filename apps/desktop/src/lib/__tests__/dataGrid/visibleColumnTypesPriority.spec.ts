import { describe, expect, it } from "vitest";
import { formatMetadataColumnTypeLabel, isNumericColumnType, resolveHeaderColumnType, resolveResultColumnType, shortHeaderTypeName } from "@/lib/dataGrid/dataGridColumnType";

describe("resolveResultColumnType", () => {
  function tableTypes(entries: Record<string, string>): Map<string, string> {
    return new Map(Object.entries(entries));
  }

  it("prefers ResultSet column_types over table metadata", () => {
    // SELECT CAST(amount AS TEXT) AS amount — the column is no longer numeric
    // even though the underlying source column is `decimal(10,2)`.
    const type = resolveResultColumnType({
      resultColumnType: "text",
      resultColumnName: "amount",
      sourceColumnName: "amount",
      tableColumnTypesByName: tableTypes({ amount: "decimal(10,2)" }),
    });
    expect(type).toBe("text");
    expect(isNumericColumnType(type)).toBe(false);
  });

  it("falls back to source column metadata when ResultSet omits the type", () => {
    const type = resolveResultColumnType({
      resultColumnType: undefined,
      resultColumnName: "amount",
      sourceColumnName: "amount",
      tableColumnTypesByName: tableTypes({ amount: "decimal(10,2)" }),
    });
    expect(type).toBe("decimal(10,2)");
    expect(isNumericColumnType(type)).toBe(true);
  });

  it("falls back to result column name when source column name is unavailable", () => {
    const type = resolveResultColumnType({
      resultColumnType: undefined,
      resultColumnName: "amount",
      sourceColumnName: undefined,
      tableColumnTypesByName: tableTypes({ amount: "decimal(10,2)" }),
    });
    expect(type).toBe("decimal(10,2)");
  });

  it("returns undefined when no source provides a type", () => {
    expect(
      resolveResultColumnType({
        resultColumnType: undefined,
        resultColumnName: "unknown",
        sourceColumnName: "unknown",
        tableColumnTypesByName: tableTypes({ amount: "decimal(10,2)" }),
      }),
    ).toBeUndefined();
  });

  it("treats whitespace-only ResultSet types as missing and falls back to metadata", () => {
    const type = resolveResultColumnType({
      resultColumnType: "   ",
      resultColumnName: "amount",
      sourceColumnName: "amount",
      tableColumnTypesByName: tableTypes({ amount: "int" }),
    });
    expect(type).toBe("int");
  });

  it("ignores whitespace-only table metadata entries", () => {
    const type = resolveResultColumnType({
      resultColumnType: undefined,
      resultColumnName: "amount",
      sourceColumnName: "amount",
      tableColumnTypesByName: tableTypes({ amount: "   " }),
    });
    expect(type).toBeUndefined();
  });

  it("prefers the source column name over the result column name when both differ", () => {
    // Source column `total_price` aliased as `total` — when no result type is
    // supplied, we should resolve via the source column name first.
    const type = resolveResultColumnType({
      resultColumnType: undefined,
      resultColumnName: "total",
      sourceColumnName: "total_price",
      tableColumnTypesByName: tableTypes({ total: "varchar(20)", total_price: "decimal(18,4)" }),
    });
    expect(type).toBe("decimal(18,4)");
  });

  it("handles missing tableColumnTypesByName gracefully", () => {
    expect(
      resolveResultColumnType({
        resultColumnType: undefined,
        resultColumnName: "amount",
        sourceColumnName: "amount",
      }),
    ).toBeUndefined();
  });

  it("drives right alignment only when the ResultSet reports a numeric type", () => {
    // SELECT CAST(amount AS TEXT) AS amount must NOT right-align even though
    // the source column is numeric.
    const castToText = resolveResultColumnType({
      resultColumnType: "text",
      resultColumnName: "amount",
      sourceColumnName: "amount",
      tableColumnTypesByName: tableTypes({ amount: "decimal(10,2)" }),
    });
    expect(isNumericColumnType(castToText)).toBe(false);

    // SELECT CAST(label AS INTEGER) AS label must right-align even though the
    // source column is text.
    const castToInteger = resolveResultColumnType({
      resultColumnType: "integer",
      resultColumnName: "label",
      sourceColumnName: "label",
      tableColumnTypesByName: tableTypes({ label: "varchar(50)" }),
    });
    expect(isNumericColumnType(castToInteger)).toBe(true);
  });

  it("resolves DuckDB computed decimal columns as numeric even when table metadata only has base columns (#12364)", () => {
    // Query: select (数值列+1.10) as 金额 from tab;
    // Table tab only has column "数值列", not "金额"
    const type = resolveResultColumnType({
      resultColumnType: "DECIMAL(18, 2)",
      resultColumnName: "金额",
      sourceColumnName: undefined,
      tableColumnTypesByName: tableTypes({ 数值列: "integer" }),
    });
    expect(type).toBe("DECIMAL(18, 2)");
    expect(isNumericColumnType(type)).toBe(true);
  });
});

describe("resolveHeaderColumnType", () => {
  it("prefers single-table metadata, then display enrichment, then ResultSet types", () => {
    expect(
      resolveHeaderColumnType({
        tableColumnType: "varchar(32)",
        displayColumnType: "varchar(64)",
        resultColumnTypes: ["varchar"],
        actualColIdx: 0,
      }),
    ).toBe("varchar(32)");

    expect(
      resolveHeaderColumnType({
        tableColumnType: undefined,
        displayColumnType: "character varying(50)",
        resultColumnTypes: ["varchar"],
        actualColIdx: 0,
      }),
    ).toBe("character varying(50)");

    expect(
      resolveHeaderColumnType({
        tableColumnType: undefined,
        displayColumnType: undefined,
        resultColumnTypes: ["varchar"],
        actualColIdx: 0,
      }),
    ).toBe("varchar");
  });
});

describe("shortHeaderTypeName", () => {
  it("shortens verbose PostgreSQL type names while keeping length suffixes", () => {
    expect(shortHeaderTypeName("character varying(50)")).toBe("varchar(50)");
    expect(shortHeaderTypeName("character varying")).toBe("varchar");
    expect(shortHeaderTypeName("timestamp without time zone")).toBe("timestamp");
    expect(formatMetadataColumnTypeLabel({ dataType: "varchar", characterMaximumLength: 50 })).toBe("varchar(50)");
  });
});
