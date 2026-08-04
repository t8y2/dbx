import { describe, expect, it } from "vitest";
import { coerceDataGridCellValue, dataGridCellDisplayText } from "@/lib/dataGrid/dataGridCellCoercion";

describe("dataGridCellDisplayText", () => {
  it("formats Oracle DATE values without RFC3339 separators", () => {
    expect(
      dataGridCellDisplayText({
        value: "2022-08-25T09:58:43Z",
        databaseType: "oracle",
        columnInfo: { data_type: "DATE" },
      }),
    ).toBe("2022-08-25 09:58:43");
  });

  it("formats midnight Oracle DATE values as a date", () => {
    expect(
      dataGridCellDisplayText({
        value: "2022-08-25T00:00:00Z",
        databaseType: "oracle",
        columnInfo: { data_type: "DATE" },
      }),
    ).toBe("2022-08-25");
  });

  it("does not format non-date Oracle strings", () => {
    expect(
      dataGridCellDisplayText({
        value: "2022-08-25T09:58:43Z",
        databaseType: "oracle",
        columnInfo: { data_type: "VARCHAR2(64)" },
      }),
    ).toBeUndefined();
  });
});

describe("coerceDataGridCellValue", () => {
  it.each(["null", "NULL", "Null", "nUlL"])("preserves literal %s input as text", (value) => {
    expect(
      coerceDataGridCellValue({
        value,
        oldValue: null,
        databaseType: "mysql",
        columnInfo: { data_type: "varchar(255)" },
      }),
    ).toBe(value);

    expect(
      coerceDataGridCellValue({
        value,
        oldValue: "previous",
        databaseType: "postgres",
        columnInfo: { data_type: "text" },
      }),
    ).toBe(value);
  });

  it("preserves an explicitly generated empty string for a null cell", () => {
    const options = {
      value: "",
      oldValue: null,
      databaseType: "mysql" as const,
      columnInfo: { data_type: "varchar(255)" },
    };

    expect(coerceDataGridCellValue(options)).toBeNull();
    expect(coerceDataGridCellValue({ ...options, preserveEmptyString: true })).toBe("");
  });

  it("strips unambiguous thousands separators before numeric coercion", () => {
    expect(
      coerceDataGridCellValue({
        value: "1,234.50",
        oldValue: 1234.5,
        databaseType: "sqlserver",
        columnInfo: { data_type: "float" },
      }),
    ).toBe(1234.5);

    expect(
      coerceDataGridCellValue({
        value: "1,234,567",
        oldValue: 1234567,
        databaseType: "sqlserver",
        columnInfo: { data_type: "int" },
      }),
    ).toBe(1234567);

    expect(
      coerceDataGridCellValue({
        value: "-10,000.00",
        oldValue: "-10000.00",
        databaseType: "sqlserver",
        columnInfo: { data_type: "decimal(18,2)" },
      }),
    ).toBe("-10000.00");
  });

  it("preserves exact text for grouped decimals", () => {
    expect(
      coerceDataGridCellValue({
        value: "10,000.00",
        oldValue: "10000.50",
        databaseType: "sqlserver",
        columnInfo: { data_type: "decimal(18,2)" },
      }),
    ).toBe("10000.00");
  });

  it("normalizes grouped mantissas with scientific notation", () => {
    expect(
      coerceDataGridCellValue({
        value: "1,234.50e2",
        oldValue: "0",
        databaseType: "sqlserver",
        columnInfo: { data_type: "decimal(18,2)" },
      }),
    ).toBe("1234.50e2");

    expect(
      coerceDataGridCellValue({
        value: "-1,234.5E-2",
        oldValue: "0",
        databaseType: "sqlserver",
        columnInfo: { data_type: "decimal(18,2)" },
      }),
    ).toBe("-1234.5E-2");
  });

  it("preserves exact text for grouped integers beyond Number.MAX_SAFE_INTEGER", () => {
    expect(
      coerceDataGridCellValue({
        value: "9,007,199,254,740,993",
        oldValue: 9007199254740992,
        databaseType: "mysql",
        columnInfo: { data_type: "bigint" },
      }),
    ).toBe("9007199254740993");
  });

  it("leaves ambiguous single-group values untouched", () => {
    expect(
      coerceDataGridCellValue({
        value: "10,000",
        oldValue: 10000,
        databaseType: "sqlserver",
        columnInfo: { data_type: "int" },
      }),
    ).toBe("10,000");

    expect(
      coerceDataGridCellValue({
        value: "1,000e3",
        oldValue: 1000000,
        databaseType: "sqlserver",
        columnInfo: { data_type: "float" },
      }),
    ).toBe("1,000e3");
  });

  it("does not strip commas when the column is not numeric", () => {
    expect(
      coerceDataGridCellValue({
        value: "10,000.00",
        oldValue: "10,000.00",
        databaseType: "sqlserver",
        columnInfo: { data_type: "varchar(255)" },
      }),
    ).toBe("10,000.00");
  });

  it("leaves invalid thousand-grouping values untouched", () => {
    expect(
      coerceDataGridCellValue({
        value: "1,23",
        oldValue: 123,
        databaseType: "sqlserver",
        columnInfo: { data_type: "decimal(18,2)" },
      }),
    ).toBe("1,23");
  });
});
