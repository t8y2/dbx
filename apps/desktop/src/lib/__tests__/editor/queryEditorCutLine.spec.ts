import { EditorSelection, EditorState, type Extension, type Transaction } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cutQueryEditorLine } from "@/lib/editor/queryEditorCutLine";
import { copyToClipboard } from "@/lib/common/clipboard";

vi.mock("@/lib/common/clipboard", () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));

afterEach(() => {
  vi.mocked(copyToClipboard).mockClear();
});

function runCutLine(doc: string, selection: EditorSelection | { anchor: number; head?: number }, extensions: Extension[] = []) {
  let state = EditorState.create({ doc, selection, extensions });
  const dispatch = vi.fn((transaction: Transaction) => {
    state = transaction.state;
  });
  const handled = cutQueryEditorLine({
    get state() {
      return state;
    },
    dispatch,
  } as never);

  return { dispatch, handled, state };
}

describe("cutQueryEditorLine", () => {
  it("removes an empty trailing line the cursor sits on", () => {
    const result = runCutLine("select 1;\n\n", { anchor: 11 });

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("select 1;\n");
    expect(copyToClipboard).toHaveBeenCalledWith("");
  });

  it("removes a non-empty last line together with its line break", () => {
    const doc = "select 1;\nselect 2";
    const result = runCutLine(doc, { anchor: doc.length });

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("select 1;");
    expect(copyToClipboard).toHaveBeenCalledWith("select 2");
  });

  it("cuts every cursored line in one pass when one cursor is on the last line", () => {
    const doc = "a\nb\nc\nd";
    const selection = EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(doc.length)], 1);
    const result = runCutLine(doc, selection, [EditorState.allowMultipleSelections.of(true)]);

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("b\nc");
    expect(copyToClipboard).toHaveBeenCalledWith("a\nd");
  });

  it("leaves cursors mid-document to the native cut", () => {
    const doc = "a\nb\nc";
    const result = runCutLine(doc, { anchor: doc.indexOf("b") });

    expect(result.handled).toBe(false);
    expect(result.dispatch).not.toHaveBeenCalled();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("leaves real selections to the native cut", () => {
    const doc = "a\nb\nc";
    const result = runCutLine(doc, EditorSelection.range(0, 1));

    expect(result.handled).toBe(false);
    expect(result.dispatch).not.toHaveBeenCalled();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("leaves single-line documents to the native cut", () => {
    const result = runCutLine("select 1;", { anchor: 4 });

    expect(result.handled).toBe(false);
    expect(result.dispatch).not.toHaveBeenCalled();
  });

  it("does not cut read-only documents", () => {
    const doc = "select 1;\nselect 2";
    const result = runCutLine(doc, { anchor: doc.length }, [EditorState.readOnly.of(true)]);

    expect(result.handled).toBe(false);
    expect(result.dispatch).not.toHaveBeenCalled();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("still deletes the line when the clipboard write fails", async () => {
    vi.mocked(copyToClipboard).mockRejectedValueOnce(new Error("denied"));
    const doc = "select 1;\nselect 2";
    const result = runCutLine(doc, { anchor: doc.length });

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("select 1;");
  });
});
