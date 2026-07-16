import { describe, expect, it, vi } from "vitest";

import { claimDataGridPaste, planDataGridPaste } from "@/lib/dataGrid/dataGridClipboard";

function target(nativeClipboard: boolean): EventTarget {
  return {
    closest: () => (nativeClipboard ? {} : null),
  } as unknown as EventTarget;
}

function pasteEvent(nativeClipboard: boolean) {
  return {
    target: target(nativeClipboard),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe("claimDataGridPaste", () => {
  it("keeps native paste behavior for editors inside the grid", () => {
    const event = pasteEvent(true);

    expect(claimDataGridPaste(event, true, true)).toBe("native");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it("owns and applies paste for editable grid selections", () => {
    const event = pasteEvent(false);

    expect(claimDataGridPaste(event, true, true)).toBe("paste");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("blocks paste for read-only results", () => {
    const event = pasteEvent(false);

    expect(claimDataGridPaste(event, false, true)).toBe("block");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("blocks paste when the grid has no selection target", () => {
    const event = pasteEvent(false);

    expect(claimDataGridPaste(event, true, false)).toBe("block");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });
});

describe("planDataGridPaste", () => {
  it("flattens a clipboard matrix within grid bounds", () => {
    expect(
      planDataGridPaste(
        [
          ["a", "b"],
          ["c", "d"],
        ],
        2,
        1,
      ),
    ).toEqual([
      { rowOffset: 0, columnOffset: 0, value: "a" },
      { rowOffset: 1, columnOffset: 0, value: "c" },
    ]);
  });

  it("returns no cells for empty bounds", () => {
    expect(planDataGridPaste([["a"]], 0, 1)).toEqual([]);
    expect(planDataGridPaste([["a"]], 1, 0)).toEqual([]);
  });
});
