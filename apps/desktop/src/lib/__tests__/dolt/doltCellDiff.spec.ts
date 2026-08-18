import { describe, expect, it } from "vitest";
import { buildDoltTextDiff, detectDoltCellFormat, doltCellCopyText, doltCellDisplayValue, formatDoltCellText, type DoltDiffCellTarget } from "@/lib/dolt/doltCellDiff";

function target(overrides: Partial<DoltDiffCellTarget> = {}): DoltDiffCellTarget {
  return {
    rowIndex: 0,
    columnIndex: 0,
    side: "after",
    columnName: "payload",
    columnKind: "unchanged",
    rowKind: "modified",
    beforeValue: "old",
    afterValue: "new",
    ...overrides,
  };
}

const labels = { nullValue: "NULL", rowMissing: "Row does not exist", columnMissing: "Column does not exist" };

describe("doltCellDiff", () => {
  it("distinguishes null values from missing rows and columns", () => {
    expect(doltCellDisplayValue(target({ beforeValue: null }), "before", labels)).toEqual({ state: "value", text: "NULL", rawText: "", canFormat: false });
    expect(doltCellDisplayValue(target({ rowKind: "added" }), "before", labels).state).toBe("row-missing");
    expect(doltCellDisplayValue(target({ columnKind: "added" }), "before", labels).state).toBe("column-missing");
    expect(doltCellCopyText(target({ beforeValue: null }), "before")).toBe("");
    expect(doltCellCopyText(target({ rowKind: "added" }), "before")).toBeNull();
  });

  it("manually formats single-line JSON without changing large number tokens", () => {
    const display = doltCellDisplayValue(target({ afterValue: '{"id":9007199254740993123,"items":[1,2]}' }), "after", labels);
    expect(formatDoltCellText(display, "json")).toEqual({
      text: '{\n  "id": 9007199254740993123,\n  "items": [\n    1,\n    2\n  ]\n}',
      error: null,
    });
  });

  it("manually formats XML and preserves raw text when parsing fails", () => {
    const valid = doltCellDisplayValue(target({ afterValue: "<root><item>1</item><item>2</item></root>" }), "after", labels);
    expect(formatDoltCellText(valid, "xml").text).toBe("<root>\n  <item>1</item>\n  <item>2</item>\n</root>");

    const invalid = doltCellDisplayValue(target({ afterValue: "<root>" }), "after", labels);
    const result = formatDoltCellText(invalid, "xml");
    expect(result.text).toBe("<root>");
    expect(result.error).toMatch(/Unclosed/i);
  });

  it("automatically detects validated JSON or XML and falls back to raw text", () => {
    const json = doltCellDisplayValue(target({ beforeValue: '{"value":1}' }), "before", labels);
    const brokenJson = doltCellDisplayValue(target({ afterValue: '{"value":' }), "after", labels);
    expect(detectDoltCellFormat([json, brokenJson])).toBe("json");

    const xml = doltCellDisplayValue(target({ beforeValue: "<root><value>1</value></root>" }), "before", labels);
    expect(detectDoltCellFormat([xml])).toBe("xml");
    expect(detectDoltCellFormat([json, xml])).toBe("raw");
    expect(detectDoltCellFormat([doltCellDisplayValue(target({ beforeValue: "plain text" }), "before", labels)])).toBe("raw");
  });

  it("builds aligned line and character-level modifications", () => {
    const rows = buildDoltTextDiff("{\n  value: 1\n}", "{\n  value: 2\n  enabled: true\n}");
    expect(rows.map((row) => row.kind)).toEqual(["equal", "modified", "added", "equal"]);
    expect(rows[1].beforeSegments.some((segment) => segment.changed && segment.text === "1")).toBe(true);
    expect(rows[1].afterSegments.some((segment) => segment.changed && segment.text === "2")).toBe(true);
    expect(rows[2]).toMatchObject({ beforeLineNumber: null, afterLineNumber: 3, afterText: "  enabled: true" });
  });

  it("keeps empty values visible as one aligned row", () => {
    expect(buildDoltTextDiff("", "")).toEqual([expect.objectContaining({ kind: "equal", beforeLineNumber: 1, afterLineNumber: 1, beforeText: "", afterText: "" })]);
  });
});
