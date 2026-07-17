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
});
