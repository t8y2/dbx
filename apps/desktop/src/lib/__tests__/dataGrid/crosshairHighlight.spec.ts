import { describe, expect, it } from "vitest";
import { resolveCrosshairTarget } from "@/lib/dataGrid/crosshairHighlight";
import type { CellPosition } from "@/lib/dataGrid/gridSelection";

function focus(rowIndex: number, colIndex: number): CellPosition {
  return { rowIndex, colIndex };
}

describe("resolveCrosshairTarget", () => {
  const visibleColumnIndexes = [3, 7, 11];

  it("resolves both axes from selectionFocus for a plain cell", () => {
    const target = resolveCrosshairTarget({
      selectionFocus: focus(2, 1),
      selectionAnchor: focus(2, 1),
      hasRowSelection: false,
      hasColumnSelection: false,
      visibleColumnIndexes,
    });
    expect(target).toEqual({
      rowIndex: 2,
      visibleColIdx: 1,
      actualColIdx: 7,
      rowCrosshair: true,
      columnCrosshair: true,
    });
  });

  it("keeps both axes for a multi-cell range (anchor + focus)", () => {
    const target = resolveCrosshairTarget({
      selectionFocus: focus(5, 2),
      selectionAnchor: focus(1, 0),
      hasRowSelection: false,
      hasColumnSelection: false,
      visibleColumnIndexes,
    });
    expect(target).toEqual({
      rowIndex: 5,
      visibleColIdx: 2,
      actualColIdx: 11,
      rowCrosshair: true,
      columnCrosshair: true,
    });
  });

  it("only highlights the row when hasRowSelection is set alongside focus", () => {
    const target = resolveCrosshairTarget({
      selectionFocus: focus(4, 0),
      selectionAnchor: focus(4, 0),
      hasRowSelection: true,
      hasColumnSelection: false,
      visibleColumnIndexes,
    });
    expect(target?.rowCrosshair).toBe(true);
    expect(target?.columnCrosshair).toBe(false);
    expect(target?.rowIndex).toBe(4);
  });

  it("only highlights the column when hasColumnSelection is set alongside focus", () => {
    const target = resolveCrosshairTarget({
      selectionFocus: focus(4, 0),
      selectionAnchor: focus(4, 0),
      hasRowSelection: false,
      hasColumnSelection: true,
      visibleColumnIndexes,
    });
    expect(target?.rowCrosshair).toBe(false);
    expect(target?.columnCrosshair).toBe(true);
    expect(target?.visibleColIdx).toBe(0);
  });

  it("derives the row from fallbackRowIndex for a whole-row selection with no focus", () => {
    const target = resolveCrosshairTarget({
      selectionFocus: null,
      selectionAnchor: null,
      hasRowSelection: true,
      hasColumnSelection: false,
      visibleColumnIndexes,
      fallbackRowIndex: 9,
    });
    expect(target).toEqual({
      rowIndex: 9,
      visibleColIdx: 0,
      actualColIdx: 3,
      rowCrosshair: true,
      columnCrosshair: false,
    });
  });

  it("returns null for a whole-row selection when fallbackRowIndex is missing", () => {
    const target = resolveCrosshairTarget({
      selectionFocus: null,
      selectionAnchor: null,
      hasRowSelection: true,
      hasColumnSelection: false,
      visibleColumnIndexes,
    });
    expect(target).toBeNull();
  });

  it("derives the column from fallbackColumnIndex for a whole-column selection with no focus", () => {
    const target = resolveCrosshairTarget({
      selectionFocus: null,
      selectionAnchor: null,
      hasRowSelection: false,
      hasColumnSelection: true,
      visibleColumnIndexes,
      fallbackColumnIndex: 2,
    });
    expect(target).toEqual({
      rowIndex: 0,
      visibleColIdx: 2,
      actualColIdx: 11,
      rowCrosshair: false,
      columnCrosshair: true,
    });
  });

  it("returns null for a whole-column selection when fallbackColumnIndex is missing", () => {
    const target = resolveCrosshairTarget({
      selectionFocus: null,
      selectionAnchor: null,
      hasRowSelection: false,
      hasColumnSelection: true,
      visibleColumnIndexes,
    });
    expect(target).toBeNull();
  });

  it("returns null when there is no focus and no row/column selection", () => {
    const target = resolveCrosshairTarget({
      selectionFocus: null,
      selectionAnchor: null,
      hasRowSelection: false,
      hasColumnSelection: false,
      visibleColumnIndexes,
    });
    expect(target).toBeNull();
  });

  it("returns null when selectionFocus.colIndex is out of range for visibleColumnIndexes", () => {
    const target = resolveCrosshairTarget({
      selectionFocus: focus(0, 5),
      selectionAnchor: focus(0, 5),
      hasRowSelection: false,
      hasColumnSelection: false,
      visibleColumnIndexes,
    });
    expect(target).toBeNull();
  });

  it("returns null when fallbackColumnIndex is out of range for visibleColumnIndexes", () => {
    const target = resolveCrosshairTarget({
      selectionFocus: null,
      selectionAnchor: null,
      hasRowSelection: false,
      hasColumnSelection: true,
      visibleColumnIndexes,
      fallbackColumnIndex: 9,
    });
    expect(target).toBeNull();
  });

  it("returns null when visibleColumnIndexes is empty even with a focus", () => {
    const target = resolveCrosshairTarget({
      selectionFocus: focus(0, 0),
      selectionAnchor: focus(0, 0),
      hasRowSelection: false,
      hasColumnSelection: false,
      visibleColumnIndexes: [],
    });
    expect(target).toBeNull();
  });
});
