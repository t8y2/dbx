import { afterEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard } from "@/lib/common/clipboard";
import { claimDataGridPaste, clearDataGridClipboardCopy, parseDataGridClipboard, planDataGridPaste, rememberDataGridClipboardCopy } from "@/lib/dataGrid/dataGridClipboard";

afterEach(() => clearDataGridClipboardCopy());

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

describe("parseDataGridClipboard", () => {
  it("restores null values copied from the DBX grid", () => {
    rememberDataGridClipboardCopy("NULL\tNULL", [[null, "NULL"]]);

    expect(parseDataGridClipboard("NULL\tNULL")).toEqual([[null, "NULL"]]);
  });

  it("keeps null text from external clipboard content as strings", () => {
    rememberDataGridClipboardCopy("NULL", [[null]]);
    clearDataGridClipboardCopy();

    expect(parseDataGridClipboard("NULL")).toEqual([["NULL"]]);
    expect(parseDataGridClipboard("null")).toEqual([["null"]]);
  });

  it("does not reuse null metadata after a literal NULL is copied", () => {
    rememberDataGridClipboardCopy("NULL", [[null]]);
    rememberDataGridClipboardCopy("NULL", [["NULL"]]);

    expect(parseDataGridClipboard("NULL")).toEqual([["NULL"]]);
  });

  it("invalidates null metadata after another successful in-app copy", async () => {
    rememberDataGridClipboardCopy("NULL", [[null]]);
    await copyToClipboard("NULL", { navigator: { clipboard: { writeText: vi.fn() } } });

    expect(parseDataGridClipboard("NULL")).toEqual([["NULL"]]);
  });

  it("keeps null metadata when a later in-app copy fails", async () => {
    rememberDataGridClipboardCopy("NULL", [[null]]);
    await expect(copyToClipboard("NULL", { navigator: { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } } })).rejects.toThrow("Clipboard API is not available");

    expect(parseDataGridClipboard("NULL")).toEqual([[null]]);
  });

  it("preserves null positions beside cells containing tabs and newlines", () => {
    const text = "left\tinside\tNULL\nline 1\nline 2\ttail";
    rememberDataGridClipboardCopy(text, [
      ["left\tinside", null],
      ["line 1\nline 2", "tail"],
    ]);

    expect(parseDataGridClipboard(text)).toEqual([
      ["left\tinside", null],
      ["line 1\nline 2", "tail"],
    ]);
  });

  it("restores null positions after copied headers", () => {
    rememberDataGridClipboardCopy("name\tnote\nAda\tNULL", [["Ada", null]], true);

    expect(parseDataGridClipboard("name\tnote\nAda\tNULL")).toEqual([
      ["name", "note"],
      ["Ada", null],
    ]);
  });
});
