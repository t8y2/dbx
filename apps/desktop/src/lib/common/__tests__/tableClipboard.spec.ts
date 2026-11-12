import { describe, expect, it } from "vitest";
import { formatRowsAsSpreadsheetTsv } from "@/lib/common/tableClipboard";

describe("formatRowsAsSpreadsheetTsv", () => {
  it("formats headers and rows for direct spreadsheet paste", () => {
    expect(
      formatRowsAsSpreadsheetTsv(
        [{ name: "orders", comment: "line 1\nline 2" }],
        [
          { label: "Name", value: (row) => row.name },
          { label: "Comment", value: (row) => row.comment },
        ],
      ),
    ).toBe('Name\tComment\norders\t"line 1\nline 2"');
  });

  it("guards formula-like values through the spreadsheet encoder", () => {
    expect(formatRowsAsSpreadsheetTsv([{ value: "=1+1" }], [{ label: "Value", value: (row) => row.value }])).toBe("Value\n'=1+1");
  });

  it("preserves an empty table header when there are no rows", () => {
    expect(formatRowsAsSpreadsheetTsv([], [{ label: "Name", value: () => "" }])).toBe("Name");
  });
});
