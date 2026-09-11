// @vitest-environment happy-dom

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSelectionMatchMarkerScan, SELECTION_MATCH_SCAN_CHUNK_LENGTH, SELECTION_MATCH_UPDATE_DELAY_MS, selectionMatchOccurrences } from "@/lib/editor/codemirrorSelectionMatches";

function createView(doc: string, selection = EditorSelection.cursor(0)) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection,
      extensions: [selectionMatchOccurrences()],
    }),
  });
}

describe("selectionMatchOccurrences", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("waits for pointer selection updates to settle before rendering scrollbar matches", async () => {
    const view = createView("foo one\nfoo two\nfoo three");

    view.dispatch({ selection: { anchor: 0, head: 3 }, userEvent: "select.pointer" });

    expect(view.dom.querySelectorAll(".cm-selectionMatchScrollbarMark")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SELECTION_MATCH_UPDATE_DELAY_MS - 1);
    expect(view.dom.querySelectorAll(".cm-selectionMatchScrollbarMark")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(view.dom.querySelectorAll(".cm-selectionMatchScrollbarMark")).toHaveLength(3);
    view.destroy();
  });

  it("scans large documents incrementally instead of completing in the update callback", async () => {
    const prefix = "x".repeat(SELECTION_MATCH_SCAN_CHUNK_LENGTH + 8);
    const view = createView(`${prefix}needle`, EditorSelection.range(prefix.length, prefix.length + 6));

    await vi.advanceTimersByTimeAsync(0);
    expect(view.dom.querySelectorAll(".cm-selectionMatchScrollbarMark")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(20);
    expect(view.dom.querySelectorAll(".cm-selectionMatchScrollbarMark")).toHaveLength(1);
    view.destroy();
  });

  it("cancels an in-progress scan when the selection changes", async () => {
    const prefix = "x".repeat(SELECTION_MATCH_SCAN_CHUNK_LENGTH + 8);
    const view = createView(`${prefix}needle`, EditorSelection.range(prefix.length, prefix.length + 6));

    await vi.advanceTimersByTimeAsync(0);
    view.dispatch({ selection: { anchor: 0 }, userEvent: "select.pointer" });
    await vi.advanceTimersByTimeAsync(SELECTION_MATCH_UPDATE_DELAY_MS + 40);

    expect(view.dom.querySelectorAll(".cm-selectionMatchScrollbarMark")).toHaveLength(0);
    view.destroy();
  });
});

describe("SelectionMatchMarkerScan", () => {
  it("finds a match that crosses a scan chunk boundary exactly once", () => {
    const prefix = "x".repeat(SELECTION_MATCH_SCAN_CHUNK_LENGTH - 2);
    const doc = `${prefix}needle tail`;
    const state = EditorState.create({ doc, selection: EditorSelection.range(prefix.length, prefix.length + 6) });
    const scan = createSelectionMatchMarkerScan(state)!;

    while (!scan.scanNextChunk()) {
      // Continue through the remaining chunks.
    }

    expect(scan.markers).toEqual([{ from: prefix.length, to: prefix.length + 6, lineNumber: 1, selected: true }]);
  });

  it.each([
    { name: "canonical decomposition", query: "\u00e9x", occurrence: "e\u0301x" },
    { name: "compatibility decomposition", query: "Ax", occurrence: "\u{1d400}x" },
  ])("finds a $name match across a scan chunk boundary", ({ query, occurrence }) => {
    const prefix = "x".repeat(SELECTION_MATCH_SCAN_CHUNK_LENGTH - 1);
    const doc = `${prefix}${occurrence}\n${query}`;
    const selectedFrom = doc.length - query.length;
    const state = EditorState.create({ doc, selection: EditorSelection.range(selectedFrom, doc.length) });
    const scan = createSelectionMatchMarkerScan(state)!;

    while (!scan.scanNextChunk()) {
      // Continue through the remaining chunks.
    }

    expect(scan.markers).toContainEqual({ from: prefix.length, to: prefix.length + occurrence.length, lineNumber: 1, selected: false });
  });

  it("caps scanned matches while retaining the selected marker beyond the cap", () => {
    const prefix = `${"id ".repeat(100_000)}\n`;
    const state = EditorState.create({ doc: `${prefix}id`, selection: EditorSelection.range(prefix.length, prefix.length + 2) });
    const scan = createSelectionMatchMarkerScan(state)!;

    expect(state.doc.length).toBeGreaterThan(SELECTION_MATCH_SCAN_CHUNK_LENGTH);
    expect(scan.scanNextChunk()).toBe(true);
    expect(scan.markers).toEqual([
      { from: prefix.length, to: prefix.length + 2, lineNumber: 2, selected: true },
      { from: 0, to: 2, lineNumber: 1, selected: false },
    ]);
  });
});
