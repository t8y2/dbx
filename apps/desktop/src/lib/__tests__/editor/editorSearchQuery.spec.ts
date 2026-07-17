import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { createEditorSearchQuery } from "@/lib/editor/editorSearchQuery";

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
});
