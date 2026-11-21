import { describe, expect, it } from "vitest";
import { processListSelectionAfterClick, type ProcessListSelectionState } from "@/lib/database/processListSelection";

const rows = [{ id: 11 }, { id: 12 }, { id: 13 }, { id: 14 }, { id: 15 }];
const plain = { shiftKey: false, metaKey: false, ctrlKey: false };
const shift = { shiftKey: true, metaKey: false, ctrlKey: false };
const ctrl = { shiftKey: false, metaKey: false, ctrlKey: true };

function state(selected: number[], anchorId: number | null): ProcessListSelectionState {
  return { selected: new Set(selected), anchorId };
}

describe("processListSelectionAfterClick", () => {
  it("toggles one row and moves the anchor on a plain click", () => {
    expect(processListSelectionAfterClick(rows, state([], null), 12, plain)).toEqual({ selected: new Set([12]), anchorId: 12 });
    expect(processListSelectionAfterClick(rows, state([12, 14], 12), 14, plain)).toEqual({ selected: new Set([12]), anchorId: 14 });
  });

  it("selects the whole range on Shift+click in either direction", () => {
    expect(processListSelectionAfterClick(rows, state([12], 12), 15, shift)).toEqual({ selected: new Set([12, 13, 14, 15]), anchorId: 12 });
    expect(processListSelectionAfterClick(rows, state([15], 15), 12, shift)).toEqual({ selected: new Set([12, 13, 14, 15]), anchorId: 15 });
  });

  it("deselects the range when the Shift+clicked row was already selected", () => {
    expect(processListSelectionAfterClick(rows, state([12, 13, 14, 15], 12), 14, shift)).toEqual({ selected: new Set([15]), anchorId: 12 });
  });

  it("keeps the anchor so consecutive Shift+clicks re-extend from the same row", () => {
    const first = processListSelectionAfterClick(rows, state([12], 12), 14, shift);
    expect(processListSelectionAfterClick(rows, first, 15, shift)).toEqual({ selected: new Set([12, 13, 14, 15]), anchorId: 12 });
  });

  it("keeps rows outside the range untouched", () => {
    expect(processListSelectionAfterClick(rows, state([11, 12, 15], 12), 13, shift)).toEqual({ selected: new Set([11, 12, 13, 15]), anchorId: 12 });
  });

  it("treats Cmd/Ctrl as a single toggle", () => {
    expect(processListSelectionAfterClick(rows, state([12], 12), 14, ctrl)).toEqual({ selected: new Set([12, 14]), anchorId: 14 });
  });

  it("falls back to a plain toggle when the Shift anchor is gone", () => {
    expect(processListSelectionAfterClick(rows, state([12], 99), 13, shift)).toEqual({ selected: new Set([12, 13]), anchorId: 13 });
    expect(processListSelectionAfterClick(rows, state([12], null), 13, shift)).toEqual({ selected: new Set([12, 13]), anchorId: 13 });
  });

  it("ignores ids that are not selectable in the current list", () => {
    const current = state([12], 12);
    expect(processListSelectionAfterClick(rows, current, 99, plain)).toBe(current);
    expect(processListSelectionAfterClick(rows, current, 99, shift)).toBe(current);
  });
});
