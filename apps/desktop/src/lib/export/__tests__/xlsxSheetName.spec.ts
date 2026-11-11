import { describe, expect, it } from "vitest";
import { normalizeXlsxSheetName, xlsxDataSheetName, xlsxRequestSheetName, XLSX_SHEET_NAME_MAX_LENGTH } from "@/lib/export/xlsxSheetName";

describe("normalizeXlsxSheetName", () => {
  it("trims the name and treats anything that is not a string as unset", () => {
    expect(normalizeXlsxSheetName("  Report  ")).toBe("Report");
    expect(normalizeXlsxSheetName("")).toBe("");
    expect(normalizeXlsxSheetName("   ")).toBe("");
    expect(normalizeXlsxSheetName(undefined)).toBe("");
    expect(normalizeXlsxSheetName(null)).toBe("");
    expect(normalizeXlsxSheetName(42)).toBe("");
  });

  it("replaces the characters Excel forbids in a sheet name", () => {
    expect(normalizeXlsxSheetName("a/b:c*d?e[f]g\\h")).toBe("a b c d e f g h");
    expect(normalizeXlsxSheetName("[]")).toBe("");
  });

  it("cuts the name to Excel's 31-character limit without splitting characters", () => {
    expect(XLSX_SHEET_NAME_MAX_LENGTH).toBe(31);
    expect(normalizeXlsxSheetName("x".repeat(40))).toBe("x".repeat(31));
    const emoji = "🙂".repeat(40);
    expect([...normalizeXlsxSheetName(emoji)]).toHaveLength(31);
  });
});

describe("xlsxDataSheetName", () => {
  it("uses the fixed name when one is set and the export's own default otherwise", () => {
    expect(xlsxDataSheetName("Report", "secret_table")).toBe("Report");
    expect(xlsxDataSheetName(" Report ", "secret_table")).toBe("Report");
    expect(xlsxDataSheetName("", "secret_table")).toBe("secret_table");
    expect(xlsxDataSheetName(undefined, "secret_table")).toBe("secret_table");
    expect(xlsxDataSheetName("[]", "secret_table")).toBe("secret_table");
  });
});

describe("xlsxRequestSheetName", () => {
  it("only sends a sheet name for xlsx exports with a fixed name", () => {
    expect(xlsxRequestSheetName("Report", "xlsx")).toBe("Report");
    expect(xlsxRequestSheetName("Report", "csv")).toBeUndefined();
    expect(xlsxRequestSheetName("Report", "sql")).toBeUndefined();
    expect(xlsxRequestSheetName("", "xlsx")).toBeUndefined();
    expect(xlsxRequestSheetName(undefined, "xlsx")).toBeUndefined();
  });
});
