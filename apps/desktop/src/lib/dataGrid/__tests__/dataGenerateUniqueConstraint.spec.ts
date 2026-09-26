import { describe, expect, it } from "vitest";
import { createTableGenerateState, defaultGeneratorParams, formatGeneratedRowValues, generateTableRowsChunk, type ColumnAttrs, type TableGenerateConfig } from "@/lib/dataGrid/dataGenerate";

const ROW_COUNT = 400;

function intColumn(uniqueConstraint: boolean, params: Record<string, unknown> = {}): TableGenerateConfig {
  const generatorKey = "number";
  const attrs: ColumnAttrs = {
    dataType: "int",
    isAutoIncrement: false,
    columnDefault: null,
    numericPrecision: 10,
    numericScale: 0,
    characterMaximumLength: null,
    uniqueConstraint,
  };
  return {
    tableName: "t_5958",
    tableType: "TABLE",
    schema: "dbx9428",
    database: "dbx9428",
    rowCount: ROW_COUNT,
    columns: [
      {
        columnName: "code",
        dataType: "int",
        rowCount: ROW_COUNT,
        generatorKey,
        generatorParams: { ...defaultGeneratorParams("code", attrs, generatorKey), min: 1, max: 10000, ...params },
        isAutoIncrement: false,
        columnDefault: null,
      },
    ],
  };
}

describe("data generation with a single-column unique constraint (#5958)", () => {
  it("turns per-column uniqueness on for constrained columns only", () => {
    const attrs: ColumnAttrs = { dataType: "int", columnDefault: null, uniqueConstraint: true };
    expect(defaultGeneratorParams("code", attrs, "number").unique).toBe(true);
    expect(defaultGeneratorParams("code", { ...attrs, uniqueConstraint: false }, "number").unique).toBeUndefined();
    expect(defaultGeneratorParams("code", { ...attrs, uniqueConstraint: undefined }, "number").unique).toBeUndefined();
  });

  it("leaves generators that are already unique untouched", () => {
    const attrs: ColumnAttrs = { dataType: "bigint", columnDefault: null, uniqueConstraint: true };
    expect(defaultGeneratorParams("id", attrs, "sequence").unique).toBeUndefined();
    expect(defaultGeneratorParams("id", { ...attrs, dataType: "uuid" }, "uuid").unique).toBeUndefined();
  });

  it("generates distinct values for the constrained column", () => {
    const config = intColumn(true);
    const state = createTableGenerateState(config, "mysql");
    const rows = generateTableRowsChunk(config, state, ROW_COUNT);
    const values = rows.map((row) => row[0]);
    expect(values).toHaveLength(ROW_COUNT);
    expect(new Set(values).size).toBe(ROW_COUNT);
  });

  it("keeps producing duplicates without the constraint hint, which is what made the INSERT fail", () => {
    const config = intColumn(false);
    const state = createTableGenerateState(config, "mysql");
    const rows = generateTableRowsChunk(config, state, ROW_COUNT);
    const values = rows.map((row) => row[0]);
    expect(new Set(values).size).toBeLessThan(ROW_COUNT);
  });

  it("does not treat repeated NULLs or SQL expressions as duplicate values", () => {
    const config = intColumn(true, { includeNull: true, nullPercent: 100 });
    const state = createTableGenerateState(config, "mysql");
    const rows = generateTableRowsChunk(config, state, 5);
    expect(rows.map((row) => row[0])).toEqual([null, null, null, null, null]);

    const expressionConfig = intColumn(true);
    expressionConfig.columns[0]!.columnDefault = "(uuid())";
    expressionConfig.columns[0]!.generatorParams = { ...expressionConfig.columns[0]!.generatorParams, includeDefault: true, defaultPercent: 100 };
    const expressionState = createTableGenerateState(expressionConfig, "mysql");
    const expressionRows = generateTableRowsChunk(expressionConfig, expressionState, 5);
    expect(expressionRows.map((row) => row[0])).toHaveLength(5);
    const formatted = expressionRows.map((row) => formatGeneratedRowValues(expressionConfig, "mysql", expressionState, row));
    expect(formatted).toEqual(["(uuid())", "(uuid())", "(uuid())", "(uuid())", "(uuid())"]);
  });
});
