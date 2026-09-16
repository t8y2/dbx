import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { collectEditorSearchMatches, countEditorSearchMatches, createEditorSearchQuery, replaceEditorSearchMatches } from "@/lib/editor/editorSearchQuery";

function matchedText(search: string, useRegex: boolean): string[] {
  const state = EditorState.create({
    doc: String.raw`SELECT '\n' AS escaped;
SELECT 1 AS actual_line_break;`,
  });
  const cursor = createEditorSearchQuery({ search, caseSensitive: false, useRegex }).getCursor(state);
  const matches: string[] = [];

  for (let result = cursor.next(); !result.done; result = cursor.next()) {
    matches.push(state.sliceDoc(result.value.from, result.value.to));
  }

  return matches;
}

describe("editorSearchQuery", () => {
  it("treats escape sequences literally in normal search mode", () => {
    expect(matchedText(String.raw`\n`, false)).toEqual([String.raw`\n`]);
  });

  it("allows regular expression mode to match actual line breaks", () => {
    expect(matchedText(String.raw`\n`, true)).toEqual(["\n"]);
  });

  it("caps a large match collection without materializing every result", () => {
    const state = EditorState.create({ doc: Array.from({ length: 50000 }, () => "x").join(" ") });
    const query = createEditorSearchQuery({ search: "x", caseSensitive: true, useRegex: false });
    const matches = collectEditorSearchMatches(query, state, 0, state.doc.length, 1000);

    expect(matches).toHaveLength(1000);
    expect(matches.at(-1)).toEqual({ from: 1998, to: 1999 });
  });

  it("counts every match without materializing an unbounded range array", () => {
    const state = EditorState.create({ doc: Array.from({ length: 50000 }, () => "x").join(" ") });
    const query = createEditorSearchQuery({ search: "x", caseSensitive: true, useRegex: false });
    const startedAt = performance.now();
    const result = countEditorSearchMatches(query, state, 0, state.doc.length, { from: 49998, to: 49999 });
    const elapsed = performance.now() - startedAt;

    expect(result).toEqual({ count: 50000, currentIndex: 25000 });
    expect(elapsed).toBeLessThan(250);
  });

  it("collects zero-width regular expression matches within the requested limit", () => {
    const state = EditorState.create({ doc: "xxxxx" });
    const query = createEditorSearchQuery({ search: "(?=x)", caseSensitive: true, useRegex: true });

    expect(collectEditorSearchMatches(query, state, 0, state.doc.length, 3)).toEqual([
      { from: 0, to: 0 },
      { from: 1, to: 1 },
      { from: 2, to: 2 },
    ]);
  });

  it("counts every zero-width regular expression match", () => {
    const state = EditorState.create({ doc: "x".repeat(50000) });
    const query = createEditorSearchQuery({ search: "(?=x)", caseSensitive: true, useRegex: true });

    expect(countEditorSearchMatches(query, state, 0, state.doc.length)).toEqual({ count: 50000, currentIndex: 0 });
  });

  it("keeps replacement collection uncapped", () => {
    const state = EditorState.create({ doc: Array.from({ length: 1001 }, () => "x").join(" ") });
    const query = createEditorSearchQuery({ search: "x", caseSensitive: true, useRegex: false });
    const matches = collectEditorSearchMatches(query, state, 0, state.doc.length);
    const dispatch = vi.fn();

    expect(matches).toHaveLength(1001);
    expect(replaceEditorSearchMatches({ dispatch }, matches, () => "y")).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].changes).toHaveLength(1001);
  });
});
