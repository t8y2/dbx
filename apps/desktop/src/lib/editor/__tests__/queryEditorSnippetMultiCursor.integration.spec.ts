// @vitest-environment happy-dom
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { applySnippetAcrossRanges } from "@/lib/editor/queryEditorSnippetMultiCursor";

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe("applySnippetAcrossRanges (issue #14096)", () => {
  it("applies the snippet to every cursor", () => {
    const doc = "sfhd_dwd.dwd_t_ug_org\nsfhd_dwd.dwd_t_ug_user\nsfhd_dwd.dwd_t_cus_room";
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({
        doc,
        selection: EditorSelection.create([EditorSelection.cursor(2), EditorSelection.cursor(24), EditorSelection.cursor(47)]),
        extensions: [EditorState.allowMultipleSelections.of(true)],
      }),
    });
    views.push(view);
    applySnippetAcrossRanges(view, "select * from ${1:table_name};", 0, 2);
    expect(view.state.doc.toString()).toBe("select * from table_name;hd_dwd.dwd_t_ug_org\nselect * from table_name;hd_dwd.dwd_t_ug_user\nselect * from table_name;hd_dwd.dwd_t_cus_room");
  });

  it("is a no-op for a single cursor and delegates to the normal span", () => {
    const doc = "sfhd_dwd.dwd_t_ug_org";
    const view = new EditorView({
      parent: document.createElement("div"),
      state: EditorState.create({ doc, selection: { anchor: 2 } }),
    });
    views.push(view);
    applySnippetAcrossRanges(view, "select * from ${1:table_name};", 0, 2);
    expect(view.state.doc.toString()).toBe("select * from table_name;hd_dwd.dwd_t_ug_org");
  });
});
