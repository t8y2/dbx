// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import * as viewModule from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { NEWLINE_MARKER, NEWLINE_MARKER_CLASS, createShowWhitespaceExtension } from "@/lib/editor/codemirrorShowWhitespace";

let view: EditorView | null = null;

function mount(doc: string, enabled: boolean) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [createShowWhitespaceExtension(viewModule, enabled)] }) });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
});

describe("createShowWhitespaceExtension", () => {
  it("adds nothing when disabled", () => {
    expect(createShowWhitespaceExtension(viewModule, false)).toEqual([]);
    const v = mount("select 1\n\tfrom t", false);
    expect(v.dom.querySelectorAll(`.${NEWLINE_MARKER_CLASS}`)).toHaveLength(0);
    expect(v.dom.querySelector(".cm-highlightSpace, .cm-highlightTab")).toBeNull();
  });

  it("marks a line break after every line except the last", () => {
    const v = mount("select 1\n\tfrom t\nwhere x", true);
    const markers = v.dom.querySelectorAll(`.${NEWLINE_MARKER_CLASS}`);
    expect(markers).toHaveLength(2);
    expect(markers[0]!.textContent).toBe(NEWLINE_MARKER);
  });

  it("marks spaces and tabs and never changes the document text", () => {
    const doc = "select  1\n\tfrom t";
    const v = mount(doc, true);
    expect(v.dom.querySelector(".cm-highlightSpace")).not.toBeNull();
    expect(v.dom.querySelector(".cm-highlightTab")).not.toBeNull();
    expect(v.state.doc.toString()).toBe(doc);
  });

  it("keeps marking empty lines and follows edits", () => {
    const v = mount("a\n\nb", true);
    expect(v.dom.querySelectorAll(`.${NEWLINE_MARKER_CLASS}`)).toHaveLength(2);
    v.dispatch({ changes: { from: v.state.doc.length, insert: "\nc" } });
    expect(v.dom.querySelectorAll(`.${NEWLINE_MARKER_CLASS}`)).toHaveLength(3);
  });
});
