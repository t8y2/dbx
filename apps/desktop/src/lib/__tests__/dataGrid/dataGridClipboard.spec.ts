import { afterEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard } from "@/lib/common/clipboard";
import { encodeSpreadsheetTsvCell } from "@/lib/common/spreadsheetTsv";
import { claimDataGridPaste, claimDataGridSelectAll, clearDataGridClipboardCopy, parseDataGridClipboard, parseDataGridClipboardInBatches, planDataGridPaste, rememberDataGridClipboardCopy } from "@/lib/dataGrid/dataGridClipboard";
import { DataGridClipboardCapacityError } from "@/lib/dataGrid/dataGridRowPreparation";

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

describe("claimDataGridSelectAll", () => {
  it("blocks native page selection while the grid is loading", () => {
    const event = pasteEvent(false);

    expect(claimDataGridSelectAll(event, true, false)).toBe("block");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("selects grid data after loading", () => {
    const event = pasteEvent(false);

    expect(claimDataGridSelectAll(event, false, true)).toBe("select");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("keeps native selection for editors and empty idle grids", () => {
    const editorEvent = pasteEvent(true);
    const emptyGridEvent = pasteEvent(false);

    expect(claimDataGridSelectAll(editorEvent, true, false)).toBe("native");
    expect(claimDataGridSelectAll(emptyGridEvent, false, false)).toBe("native");
    expect(editorEvent.preventDefault).not.toHaveBeenCalled();
    expect(emptyGridEvent.preventDefault).not.toHaveBeenCalled();
  });
});

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
  it.each<[string, string[][]]>([
    ['"line 1\nline 2"\tnote', [["line 1\nline 2", "note"]]],
    [
      '"left\tinside"\t"a ""quoted"" value"\r\nnext\trow\r\n',
      [
        ["left\tinside", 'a "quoted" value'],
        ["next", "row"],
      ],
    ],
    ['"line 1\r\nline 2"\t""', [["line 1\r\nline 2", ""]]],
    ['""\t""\n', [["", ""]]],
    ['"a"\t', [["a", ""]]],
    ['plain"quote\t"quoted"', [['plain"quote', "quoted"]]],
    [
      '"unfinished\tcell\nnext\trow',
      [
        ['"unfinished', "cell"],
        ["next", "row"],
      ],
    ],
  ])("parses quoted spreadsheet cells without internal clipboard metadata: %j", async (text, expected) => {
    expect(parseDataGridClipboard(text)).toEqual(expected);
    expect(await parseDataGridClipboardInBatches(text)).toEqual(expected);
  });

  it("round-trips the spreadsheet TSV encoder without internal copy metadata", () => {
    const row = ["left\tinside", "line 1\r\nline 2", 'a "quoted" value', "中文", ""];
    expect(parseDataGridClipboard(row.map(encodeSpreadsheetTsvCell).join("\t"))).toEqual([row]);
  });

  it("keeps quoted NULL text literal while restoring unquoted NULL markers", async () => {
    const text = '"NULL"\tNULL\t""';
    const expected = [["NULL", null, ""]];
    expect(parseDataGridClipboard(text, {}, "NULL")).toEqual(expected);
    expect(await parseDataGridClipboardInBatches(text, {}, {}, "NULL")).toEqual(expected);
  });

  it("applies row and cell limits to logical quoted cells", () => {
    const text = '"line 1\nline 2"\tend';
    expect(parseDataGridClipboard(text, { maxRows: 1, maxCells: 2 })).toEqual([["line 1\nline 2", "end"]]);
    expect(() => parseDataGridClipboard(text, { maxCells: 1 })).toThrow(DataGridClipboardCapacityError);
    expect(() => parseDataGridClipboard(text + "\nnext", { maxRows: 1 })).toThrow(DataGridClipboardCapacityError);
  });

  it("yields and can be cancelled inside a large quoted cell", async () => {
    const controller = new AbortController();
    const text = '"' + "line\n".repeat(20_000) + '"\tend';
    const result = await parseDataGridClipboardInBatches(text, {
      signal: controller.signal,
      onProgress: ({ completed }) => {
        if (completed > 0) controller.abort();
      },
    });
    expect(result).toBeNull();
    expect(await parseDataGridClipboardInBatches(text, {}, { maxRows: 1, maxCells: 2 })).toEqual([["line\n".repeat(20_000), "end"]]);
  });

  it("bounds logical rows and cells before allocating an oversized clipboard", () => {
    expect(() => parseDataGridClipboard("a\nb\nc", { maxRows: 2 })).toThrow(DataGridClipboardCapacityError);
    expect(() => parseDataGridClipboard("a\tb\tc", { maxCells: 2 })).toThrow(DataGridClipboardCapacityError);
  });

  it("counts internal multiline values as one logical row", () => {
    const text = "line\n".repeat(1000);
    rememberDataGridClipboardCopy(text, [[text]]);
    expect(parseDataGridClipboard(text, { maxRows: 1, maxCells: 1 })).toEqual([[text]]);
  });

  it.each(["a\r\nb\r\n", "a\rb\r", "a\nb\n"])("preserves line endings through batched parsing: %j", async (text) => {
    expect(await parseDataGridClipboardInBatches(text)).toEqual([["a"], ["b"]]);
  });

  it("cancels during parsing before returning a clipboard matrix", async () => {
    const controller = new AbortController();
    const result = await parseDataGridClipboardInBatches("a\n".repeat(50_000), {
      signal: controller.signal,
      onProgress: ({ completed }) => {
        if (completed > 0) controller.abort();
      },
    });
    expect(result).toBeNull();
  });

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

  it("turns the configured null text back into NULL while leaving other fields alone", () => {
    expect(parseDataGridClipboard("NULL\tkeep", {}, "NULL")).toEqual([[null, "keep"]]);
    expect(parseDataGridClipboard("null\tkeep", {}, "NULL")).toEqual([["null", "keep"]]);
    expect(parseDataGridClipboard("\tkeep", {}, "NULL")).toEqual([["", "keep"]]);
  });

  it("keeps an empty clipboard field empty when no null text is configured", () => {
    expect(parseDataGridClipboard("\tkeep", {}, "")).toEqual([["", "keep"]]);
  });

  it("applies the configured null text through the batched parser", async () => {
    const text = Array.from({ length: 50 }, (_, index) => `${index % 2 === 0 ? "NULL" : `keep-${index}`}`).join("\n");

    expect(await parseDataGridClipboardInBatches(text, {}, {}, "NULL")).toEqual(text.split("\n").map((cell, index) => [index % 2 === 0 ? null : cell]));
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

  it("preserves embedded tabs and newlines even without null values", () => {
    const text = '"left\tinside"\t"line 1\nline 2"';
    rememberDataGridClipboardCopy(text, [["left\tinside", "line 1\nline 2"]]);

    expect(parseDataGridClipboard(text)).toEqual([["left\tinside", "line 1\nline 2"]]);
  });

  it("restores null positions after copied headers", () => {
    rememberDataGridClipboardCopy("name\tnote\nAda\tNULL", [["Ada", null]], ["name", "note"]);

    expect(parseDataGridClipboard("name\tnote\nAda\tNULL")).toEqual([
      ["name", "note"],
      ["Ada", null],
    ]);
  });
});
