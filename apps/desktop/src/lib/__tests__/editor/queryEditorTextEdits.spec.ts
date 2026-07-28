import { readFileSync } from "node:fs";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { blankLineDeletionChanges, replaceSelectedEditorText } from "@/lib/editor/queryEditorTextEdits";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

function applyBlankLineDeletion(doc: string, from: number, to: number): string {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.range(from, to),
  });
  return state.update({ changes: blankLineDeletionChanges(state.doc, state.selection.main) }).state.doc.toString();
}

describe("replaceSelectedEditorText", () => {
  it("refuses to dispatch changes for a read-only editor", () => {
    const state = EditorState.create({
      doc: "a,b",
      selection: EditorSelection.range(0, 3),
      extensions: EditorState.readOnly.of(true),
    });
    const dispatch = vi.fn();

    expect(replaceSelectedEditorText({ state, dispatch }, "'a','b'")).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("disables and guards delimited-list generation in QueryEditor", () => {
    expect(queryEditorSource).toContain("disabled: props.readOnly || !canCopySelectedSql.value");
    expect(queryEditorSource).toMatch(/function openDelimitedListDialog\(\) \{\s+if \(props\.readOnly\) return;/);
    expect(queryEditorSource).toMatch(/function applyDelimitedListResult\(result: string\) \{[\s\S]*if \(!currentView \|\| props\.readOnly\) return;[\s\S]*replaceSelectedEditorText/);
  });
});

describe("blankLineDeletionChanges", () => {
  it("preserves one newline between adjacent non-empty SQL", () => {
    expect(applyBlankLineDeletion("a\n\nb", 2, 3)).toBe("a\nb");
  });

  it.each([
    ["partial-line selection", "select a\n\nselect b", 3, 12, "select a\nselect b"],
    ["full-line selection", "a\n  \nb", 2, 5, "a\nb"],
    ["document start", "\n\na", 0, 2, "a"],
    ["document end", "a\n\n", 2, 3, "a\n"],
  ])("handles %s with line-boundary edits", (_name, doc, from, to, expected) => {
    expect(applyBlankLineDeletion(doc, from, to)).toBe(expected);
  });
});
