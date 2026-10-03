import { describe, expect, it } from "vitest";
import {
  autoMapImportColumns,
  buildTableImportParseOptions,
  defaultTableImportEmptyStringAsNull,
  formatTableImportElapsed,
  importDataTypeForDatabase,
  nextTableImportWizardStep,
  previousTableImportWizardStep,
  requiredImportTargetColumns,
  resolveTableImportElapsed,
  suggestImportTargetDataTypes,
  tableImportProgressPercent,
  validateImportMappings,
} from "@/lib/table/tableImport";

describe("tableImport", () => {
  it("keeps empty fields as empty strings for every source format by default", () => {
    // 导出端默认用 `\N` 表示 NULL，空字段代表空字符串；导入端默认必须与之一致，
    // 否则 DBX 导出的 CSV 再导回时会把 '' 变成 NULL。
    expect(defaultTableImportEmptyStringAsNull("excel")).toBe(false);
    expect(defaultTableImportEmptyStringAsNull("csv")).toBe(false);
    expect(defaultTableImportEmptyStringAsNull("tsv")).toBe(false);
    expect(defaultTableImportEmptyStringAsNull("delimited")).toBe(false);
    expect(defaultTableImportEmptyStringAsNull("json")).toBe(false);
  });

  it("only disables the shared NULL literal when empty fields are treated as NULL", () => {
    const baseSettings = {
      delimiter: ",",
      textEncoding: "auto" as const,
      titleRow: 1,
      dataStartRow: 2,
      lastDataRow: 0,
      trimValues: false,
      jsonShape: "auto" as const,
    };

    const sharedLiteral = buildTableImportParseOptions({ ...baseSettings, format: "csv", emptyStringAsNull: false });
    expect(sharedLiteral.nullLiteral).toBeUndefined();
    expect(sharedLiteral.emptyStringAsNull).toBe(false);

    const legacyEmptyField = buildTableImportParseOptions({ ...baseSettings, format: "csv", emptyStringAsNull: true });
    expect(legacyEmptyField.nullLiteral).toBe("");
    expect(legacyEmptyField.emptyStringAsNull).toBe(true);
  });

  it("passes the decimal separator only for delimited sources", () => {
    const settings = {
      delimiter: ";",
      decimalSeparator: ",",
      textEncoding: "auto" as const,
      titleRow: 1,
      dataStartRow: 2,
      lastDataRow: 0,
      trimValues: false,
      emptyStringAsNull: false,
      jsonShape: "auto" as const,
    };
    expect(buildTableImportParseOptions({ ...settings, format: "delimited" }).decimalSeparator).toBe(",");
    expect(buildTableImportParseOptions({ ...settings, format: "csv" }).decimalSeparator).toBe(",");
    expect(buildTableImportParseOptions({ ...settings, format: "tsv" }).decimalSeparator).toBe(",");
    expect(buildTableImportParseOptions({ ...settings, format: "json" }).decimalSeparator).toBeNull();
  });

  it("formats import elapsed time for progress and terminal summaries", () => {
    expect(formatTableImportElapsed(0)).toBe("0 ms");
    expect(formatTableImportElapsed(999)).toBe("999 ms");
    expect(formatTableImportElapsed(1_250)).toBe("1.3 s");
    expect(formatTableImportElapsed(61_000)).toBe("1m 1s");
  });

  it("uses the backend elapsed time as the terminal source of truth", () => {
    expect(resolveTableImportElapsed(1_500, 1_000, false)).toBe(1_500);
    expect(resolveTableImportElapsed(1_500, 2_000, false)).toBe(2_000);
    expect(resolveTableImportElapsed(2_500, 2_000, true)).toBe(2_000);
    expect(resolveTableImportElapsed(2_500, undefined, true)).toBe(2_500);
  });

  it("uses byte progress for unknown totals and reserves 100 for done", () => {
    expect(tableImportProgressPercent({ status: "running", rowsImported: 500, totalRows: 0, totalRowsExact: false, bytesRead: 50, totalBytes: 100 })).toBe(50);
    expect(tableImportProgressPercent({ status: "running", rowsImported: 1000, totalRows: 0, totalRowsExact: false, bytesRead: 100, totalBytes: 100 })).toBe(99);
    expect(tableImportProgressPercent({ status: "done", rowsImported: 1000, totalRows: 1000, totalRowsExact: true })).toBe(100);
    expect(tableImportProgressPercent({ status: "running", phase: "detectingEncoding", rowsImported: 0, totalRows: 1000, totalRowsExact: true, bytesRead: 100, totalBytes: 100 })).toBe(10);
    expect(tableImportProgressPercent({ status: "running", phase: "reading", rowsImported: 0, totalRows: 0, totalRowsExact: false, bytesRead: 0, totalBytes: 100 })).toBe(0);
    expect(tableImportProgressPercent({ status: "running", phase: "writing", rowsImported: 500, totalRows: 1000, totalRowsExact: true, bytesRead: 50, totalBytes: 100 })).toBe(55);
    expect(tableImportProgressPercent({ status: "running", phase: "finalizing", rowsImported: 1000, totalRows: 1000, totalRowsExact: true, bytesRead: 100, totalBytes: 100 })).toBe(99);
  });

  it("auto maps exact and normalized column names", () => {
    expect(autoMapImportColumns(["id", "user name", "ignored"], ["id", "user_name"])).toEqual({
      id: "id",
      "user name": "user_name",
      ignored: "",
    });
  });

  it("maps headerless columns by position even when generated names match a different target", () => {
    expect(autoMapImportColumns(["column_1", "column_2"], ["column_2", "column_1"], "position")).toEqual({ column_1: "column_2", column_2: "column_1" });
  });

  it("skips excess source columns and leaves excess target columns unmapped", () => {
    expect(autoMapImportColumns(["column_1", "column_2", "column_3"], ["id", "name"], "position")).toEqual({ column_1: "id", column_2: "name", column_3: "" });
    expect(autoMapImportColumns(["column_1"], ["id", "name"], "position")).toEqual({ column_1: "id" });
    expect(autoMapImportColumns(["column_1"], [], "position")).toEqual({ column_1: "" });
  });

  it("rejects empty mappings and duplicate target columns", () => {
    expect(validateImportMappings([])).toEqual({
      valid: false,
      errors: ["No columns mapped for import"],
      duplicateTargets: [],
    });

    const result = validateImportMappings([
      { sourceColumn: "a", targetColumn: "name" },
      { sourceColumn: "b", targetColumn: "NAME" },
    ]);

    expect(result.valid).toBe(false);
    expect(result.duplicateTargets).toEqual(["NAME"]);
    expect(result.errors[0]).toContain("Target column mapped more than once");
  });

  it("rejects empty create-table data types", () => {
    const result = validateImportMappings([{ sourceColumn: "code", targetColumn: "code", targetDataType: "" }]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["Target data type cannot be empty: code"]);
  });

  it("detects unmapped required target columns", () => {
    expect(
      requiredImportTargetColumns(
        [
          { name: "id", is_nullable: false, column_default: null, extra: "auto_increment" },
          { name: "name", is_nullable: false, column_default: null },
          { name: "created_at", is_nullable: false, column_default: "CURRENT_TIMESTAMP" },
        ],
        ["id"],
      ),
    ).toEqual(["name"]);
  });

  it("moves through wizard steps with bounds", () => {
    expect(nextTableImportWizardStep("source")).toBe("options");
    expect(nextTableImportWizardStep("execution")).toBe("execution");
    expect(previousTableImportWizardStep("review")).toBe("mapping");
    expect(previousTableImportWizardStep("source")).toBe("source");
  });

  it("keeps the selected Excel worksheet in execution parse options", () => {
    const baseSettings = {
      delimiter: ",",
      textEncoding: "auto" as const,
      titleRow: 1,
      dataStartRow: 2,
      lastDataRow: 0,
      trimValues: false,
      emptyStringAsNull: true,
      jsonShape: "auto" as const,
    };

    expect(buildTableImportParseOptions({ ...baseSettings, format: "excel", sheetName: "Second" }).sheetName).toBe("Second");
    expect(buildTableImportParseOptions({ ...baseSettings, format: "csv", sheetName: "Second" }).sheetName).toBeNull();
  });

  it("passes the text encoding for SQL script sources like delimited text", () => {
    const settings = {
      delimiter: ",",
      textEncoding: "gbk" as const,
      titleRow: 1,
      dataStartRow: 2,
      lastDataRow: 0,
      trimValues: false,
      emptyStringAsNull: true,
      jsonShape: "auto" as const,
      databaseType: "mysql" as const,
    };

    expect(buildTableImportParseOptions({ ...settings, format: "sql" }).encoding).toBe("gbk");
    expect(buildTableImportParseOptions({ ...settings, format: "sql" }).sqlDialect).toBe("mysql");
    expect(buildTableImportParseOptions({ ...settings, format: "delimited" }).encoding).toBe("gbk");
    expect(buildTableImportParseOptions({ ...settings, format: "delimited" }).sqlDialect).toBeNull();
    expect(buildTableImportParseOptions({ ...settings, format: "excel" }).encoding).toBeNull();
  });

  it("suggests create-table data types from preview rows", () => {
    expect(
      suggestImportTargetDataTypes(
        ["id", "code", "amount", "created_at"],
        [
          ["1001", "00123", "12.5", "2026-07-07 08:15:00"],
          ["1002", "00456", "13.75", "2026-07-07 09:15:00"],
        ],
        "mysql",
      ),
    ).toEqual({
      id: "BIGINT",
      code: "TEXT",
      amount: "DOUBLE",
      created_at: "DATETIME",
    });
  });

  it("uses SQL Server FLOAT for inferred decimal columns", () => {
    expect(suggestImportTargetDataTypes(["id", "active", "amount", "created_at", "notes"], [[1001, true, "12.5", "2026-07-07 08:15:00", "invoice"]], "sqlserver")).toEqual({
      id: "BIGINT",
      active: "BIT",
      amount: "FLOAT",
      created_at: "DATETIME2",
      notes: "NVARCHAR(MAX)",
    });
    expect(importDataTypeForDatabase("decimal", "mysql")).toBe("DOUBLE");
    expect(importDataTypeForDatabase("decimal", "postgres")).toBe("DOUBLE PRECISION");
    expect(importDataTypeForDatabase("decimal", "sqlite")).toBe("REAL");
    expect(importDataTypeForDatabase("decimal", "oracle")).toBe("BINARY_DOUBLE");
  });
});
