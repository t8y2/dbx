import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { collectEditorSearchMatches, createEditorSearchQuery, replaceEditorSearchMatches } from "@/lib/editor/editorSearchQuery";

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

  it("collects every scoped match when replacement is uncapped", () => {
    const state = EditorState.create({ doc: Array.from({ length: 1001 }, () => "x").join(" ") });
    const query = createEditorSearchQuery({ search: "x", caseSensitive: true, useRegex: false });
    const matches = collectEditorSearchMatches(query, state, 0, state.doc.length);
    const dispatch = vi.fn();

    expect(matches).toHaveLength(1001);
    expect(collectEditorSearchMatches(query, state, 0, state.doc.length, 1000)).toHaveLength(1000);
    expect(replaceEditorSearchMatches({ dispatch }, matches, () => "y")).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].changes).toHaveLength(1001);
  });
});
