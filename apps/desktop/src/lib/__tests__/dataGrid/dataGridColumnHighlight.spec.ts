import { describe, expect, it } from "vitest";
import {
  clearAllColumnHighlights,
  clearColumnHighlight,
  computeColumnHighlightMatchKeys,
  hasAnyColumnHighlight,
  hasColumnHighlight,
  isColumnDuplicateHighlightActive,
  isColumnNullHighlightActive,
  setColumnDuplicateHighlight,
  setColumnNullHighlight,
  toggleColumnDuplicateHighlight,
  toggleColumnNullHighlight,
  type ColumnHighlightRule,
} from "@/lib/dataGrid/dataGridColumnHighlight";
import { dataGridSearchMatchKey, type CanvasDataGridRow } from "@/lib/dataGrid/canvasDataGridRenderer";

function makeRow(displayIndex: number, data: any[]): CanvasDataGridRow {
  return {
    id: displayIndex + 1,
    displayIndex,
    data,
    isNew: false,
    isDeleted: false,
    isDirtyCol: [],
    status: "clean" as any,
  };
}

describe("dataGridColumnHighlight", () => {
  it("toggles and updates column highlight rules correctly", () => {
    const rules = new Map<number, ColumnHighlightRule>();

    expect(isColumnDuplicateHighlightActive(rules, 0)).toBe(false);
    expect(isColumnNullHighlightActive(rules, 0)).toBe(false);
    expect(hasColumnHighlight(rules, 0)).toBe(false);
    expect(hasAnyColumnHighlight(rules)).toBe(false);

    // Toggle duplicates on
    expect(toggleColumnDuplicateHighlight(rules, 0)).toBe(true);
    expect(isColumnDuplicateHighlightActive(rules, 0)).toBe(true);
    expect(isColumnNullHighlightActive(rules, 0)).toBe(false);
    expect(hasColumnHighlight(rules, 0)).toBe(true);
    expect(hasAnyColumnHighlight(rules)).toBe(true);

    // Toggle nulls on
    expect(toggleColumnNullHighlight(rules, 0)).toBe(true);
    expect(isColumnDuplicateHighlightActive(rules, 0)).toBe(true);
    expect(isColumnNullHighlightActive(rules, 0)).toBe(true);

    // Toggle duplicates off
    expect(toggleColumnDuplicateHighlight(rules, 0)).toBe(false);
    expect(isColumnDuplicateHighlightActive(rules, 0)).toBe(false);
    expect(isColumnNullHighlightActive(rules, 0)).toBe(true);

    // Clear column
    clearColumnHighlight(rules, 0);
    expect(rules.has(0)).toBe(false);
    expect(hasAnyColumnHighlight(rules)).toBe(false);
  });

  it("handles explicit set and clearAllColumnHighlights", () => {
    const rules = new Map<number, ColumnHighlightRule>();
    setColumnDuplicateHighlight(rules, 1, true);
    setColumnNullHighlight(rules, 2, true);

    expect(hasColumnHighlight(rules, 1)).toBe(true);
    expect(hasColumnHighlight(rules, 2)).toBe(true);
    expect(rules.size).toBe(2);

    setColumnDuplicateHighlight(rules, 1, false);
    expect(rules.has(1)).toBe(false);

    clearAllColumnHighlights(rules);
    expect(rules.size).toBe(0);
  });

  it("computes duplicate and null highlight keys for rows", () => {
    const rows: CanvasDataGridRow[] = [makeRow(0, ["alice", 10, null]), makeRow(1, ["bob", 20, "foo"]), makeRow(2, ["alice", 10, null]), makeRow(3, ["charlie", 30, "bar"]), makeRow(4, [null, 10, "foo"])];

    const rules = new Map<number, ColumnHighlightRule>();
    rules.set(0, { duplicates: true });
    rules.set(1, { duplicates: true });
    rules.set(2, { nulls: true });

    const matches = computeColumnHighlightMatchKeys({ rows, rules });

    // Col 0: "alice" appears at row 0 and 2. null at row 4 is not treated as duplicate.
    expect(matches.duplicateKeys.has(dataGridSearchMatchKey(0, 0))).toBe(true);
    expect(matches.duplicateKeys.has(dataGridSearchMatchKey(2, 0))).toBe(true);
    expect(matches.duplicateKeys.has(dataGridSearchMatchKey(1, 0))).toBe(false);
    expect(matches.duplicateKeys.has(dataGridSearchMatchKey(4, 0))).toBe(false);

    // Col 1: 10 appears at row 0, 2, 4 (count = 3).
    expect(matches.duplicateKeys.has(dataGridSearchMatchKey(0, 1))).toBe(true);
    expect(matches.duplicateKeys.has(dataGridSearchMatchKey(2, 1))).toBe(true);
    expect(matches.duplicateKeys.has(dataGridSearchMatchKey(4, 1))).toBe(true);
    expect(matches.duplicateKeys.has(dataGridSearchMatchKey(1, 1))).toBe(false);
    expect(matches.duplicateKeys.has(dataGridSearchMatchKey(3, 1))).toBe(false);

    // Col 2: null appears at row 0 and 2.
    expect(matches.nullKeys.has(dataGridSearchMatchKey(0, 2))).toBe(true);
    expect(matches.nullKeys.has(dataGridSearchMatchKey(2, 2))).toBe(true);
    expect(matches.nullKeys.has(dataGridSearchMatchKey(1, 2))).toBe(false);
    expect(matches.nullKeys.has(dataGridSearchMatchKey(3, 2))).toBe(false);
    expect(matches.nullKeys.has(dataGridSearchMatchKey(4, 2))).toBe(false);
  });

  it("supports custom isNullValue check", () => {
    const rows: CanvasDataGridRow[] = [makeRow(0, ["(NULL)", 1]), makeRow(1, ["valid", 2]), makeRow(2, [null, 1])];

    const rules = new Map<number, ColumnHighlightRule>([[0, { nulls: true }]]);
    const matches = computeColumnHighlightMatchKeys({
      rows,
      rules,
      isNullValue: (val) => val === "(NULL)" || val === null,
    });

    expect(matches.nullKeys.has(dataGridSearchMatchKey(0, 0))).toBe(true);
    expect(matches.nullKeys.has(dataGridSearchMatchKey(1, 0))).toBe(false);
    expect(matches.nullKeys.has(dataGridSearchMatchKey(2, 0))).toBe(true);
  });

  it("handles object values (e.g. JSON)", () => {
    const rows: CanvasDataGridRow[] = [makeRow(0, [{ a: 1 }]), makeRow(1, [{ a: 2 }]), makeRow(2, [{ a: 1 }])];

    const rules = new Map<number, ColumnHighlightRule>([[0, { duplicates: true }]]);
    const matches = computeColumnHighlightMatchKeys({ rows, rules });

    expect(matches.duplicateKeys.has(dataGridSearchMatchKey(0, 0))).toBe(true);
    expect(matches.duplicateKeys.has(dataGridSearchMatchKey(1, 0))).toBe(false);
    expect(matches.duplicateKeys.has(dataGridSearchMatchKey(2, 0))).toBe(true);
  });
});
