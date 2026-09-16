import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dataGridInlineBulkEditValue } from "@/lib/dataGrid/dataGridInlineBulkEdit";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

function functionBody(name: string, nextName: string): string {
  const start = dataGridSource.indexOf(`function ${name}`);
  const end = dataGridSource.indexOf(`function ${nextName}`, start + 1);
  return start >= 0 && end > start ? dataGridSource.slice(start, end) : "";
}

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

  it("starts a cell editor instead of opening the bulk edit dialog", () => {
    const keydown = functionBody("onGridKeydown", "copyDetailValue");
    expect(keydown).toContain("beginInlineBulkEdit(inlineBulkEditValue)");
    expect(keydown).not.toContain("openBulkEditDialog");
  });

  it("commits the inline value to the full selection", () => {
    const commit = functionBody("commitInlineBulkEdit", "commitBooleanGridEdit");
    expect(commit).toContain("fillSelectionWithValue(nextValue, { emptyStringAsNull: true })");
    expect(commit).toContain("cancelEdit()");
  });
});
