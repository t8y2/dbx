import { describe, expect, it } from "vitest";
import { bulkEditInputToSqlValue, dataGridInlineBulkEditValue } from "@/lib/dataGrid/dataGridInlineBulkEdit";

describe("DataGrid inline bulk editing", () => {
  it.each([
    ["1", "1"],
    ["删", "删"],
    ["🙂", "🙂"],
  ])("starts from the printable %j key", (key, expected) => {
    expect(dataGridInlineBulkEditValue({ key }, 2)).toBe(expected);
  });

  it("starts empty with Enter and leaves single-cell editing unchanged", () => {
    expect(dataGridInlineBulkEditValue({ key: "Enter" }, 2)).toBe("");
    expect(dataGridInlineBulkEditValue({ key: "1" }, 1)).toBeUndefined();
  });

  it.each([{ key: "v", ctrlKey: true }, { key: "1", altKey: true }, { key: "删", isComposing: true }, { key: "删", keyCode: 229 }, { key: "Process" }])("ignores shortcut, composition, and control keys: %j", (event) => {
    expect(dataGridInlineBulkEditValue(event, 2)).toBeUndefined();
  });
});

describe("bulkEditInputToSqlValue", () => {
  it.each(["", "   ", "NULL", "null", "Null", "nUlL", " NULL "])("maps the NULL sentinel %j to SQL NULL", (input) => {
    expect(bulkEditInputToSqlValue(input)).toBeNull();
  });

  it.each(["0", "false", "NULLL", "NULLX", "'NULL'", "nulls", "NUL", " 1 "])("keeps non-sentinel input %j as typed", (input) => {
    expect(bulkEditInputToSqlValue(input)).toBe(input);
  });
});
