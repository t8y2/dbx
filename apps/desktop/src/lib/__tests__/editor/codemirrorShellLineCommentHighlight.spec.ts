// @vitest-environment happy-dom

import { HighlightStyle, highlightingFor, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { sql } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { afterEach, describe, expect, it } from "vitest";
import { SHELL_LINE_COMMENT_CLASS, createShellLineCommentHighlight, shellLineCommentClass } from "@/lib/editor/codemirrorShellLineCommentHighlight";

const commentHighlightStyle = HighlightStyle.define([{ tag: tags.lineComment, color: "#6c7086", fontStyle: "italic" }]);

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string, extensions: import("@codemirror/state").Extension[] = []) {
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [sql(), ...extensions, createShellLineCommentHighlight({ ViewPlugin, Decoration, highlightingFor, syntaxTree })],
    }),
    parent: document.body,
  });
  return view;
}

describe("createShellLineCommentHighlight", () => {
  it("decorates // comments that the SQL grammar leaves untokenized", () => {
    const editor = mount('// list users\ndb.sites.insertOne({ url: "https://example.com" })');
    const decorated = Array.from(editor.dom.querySelectorAll(`.${SHELL_LINE_COMMENT_CLASS}`)).map((node) => node.textContent);

    expect(decorated).toEqual(["// list users"]);
  });

  it("does not decorate // inside parsed block comments or strings", () => {
    const editor = mount('/* hidden // marker */\nSELECT "https://example.com";\n// shown');
    const decorated = Array.from(editor.dom.querySelectorAll(`.${SHELL_LINE_COMMENT_CLASS}`)).map((node) => node.textContent);

    expect(decorated).toEqual(["// shown"]);
  });

  it("carries the active theme's comment class so // matches SQL --", () => {
    const editor = mount("// list users", [syntaxHighlighting(commentHighlightStyle)]);
    const themeClass = highlightingFor(editor.state, [tags.lineComment]);
    const node = editor.dom.querySelector(`.${SHELL_LINE_COMMENT_CLASS}`);

    expect(themeClass).toBeTruthy();
    expect(node?.className.split(" ")).toContain(themeClass?.split(" ")[0]);
  });

  it("falls back to the bare class when the theme styles no comments", () => {
    const state = EditorState.create({ doc: "// list users", extensions: [sql()] });

    expect(shellLineCommentClass(state, highlightingFor)).toBe(SHELL_LINE_COMMENT_CLASS);
  });
});
