import { readFileSync } from "node:fs";
import { toggleLineComment } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { EditorState, Prec, type Transaction } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { queryEditorCommentTokens, queryEditorLineCommentToken } from "@/lib/editor/queryEditorLineComment";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");
const editorThemesSource = readFileSync(new URL("../../editor/editorThemes.ts", import.meta.url), "utf8");
const shellHighlightSource = readFileSync(new URL("../../editor/codemirrorShellLineCommentHighlight.ts", import.meta.url), "utf8");

function runToggleLineComment(doc: string, commentToken: string) {
  let state = EditorState.create({
    doc,
    selection: { anchor: 0 },
    extensions: [sql(), Prec.highest(EditorState.languageData.of(() => [{ commentTokens: { line: commentToken } }]))],
  });
  const dispatch = vi.fn((transaction: Transaction) => {
    state = transaction.state;
  });
  const handled = toggleLineComment({
    get state() {
      return state;
    },
    dispatch,
  } as never);

  return { handled, state };
}

describe("queryEditorLineCommentToken", () => {
  it("uses the MongoDB shell line comment marker", () => {
    expect(queryEditorLineCommentToken("mongodb")).toBe("//");
  });

  it("keeps block comment tokens while overriding MongoDB line comments", () => {
    expect(queryEditorCommentTokens("mongodb")).toEqual({
      line: "//",
      block: { open: "/*", close: "*/" },
    });
  });

  it("keeps the SQL line comment marker elsewhere", () => {
    expect(queryEditorLineCommentToken(undefined)).toBe("--");
    expect(queryEditorLineCommentToken("mysql")).toBe("--");
    expect(queryEditorLineCommentToken("postgres")).toBe("--");
  });
});

describe("QueryEditor line comment", () => {
  it("overrides the language comment tokens in the SQL language compartment", () => {
    expect(queryEditorSource).toContain("Prec.highest(EditorState.languageData.of(() => [{ commentTokens: queryEditorCommentTokens(props.databaseType) }]))");
  });

  it("highlights // comments with the theme's comment style", () => {
    expect(queryEditorSource).toContain('queryEditorLineCommentToken(props.databaseType) === "//" ? shellLineCommentHighlightPlugin : []');
    expect(queryEditorSource).toContain("const shellLineCommentHighlightPlugin = createShellLineCommentHighlight({ ViewPlugin, Decoration, highlightingFor, syntaxTree });");
    expect(queryEditorSource).toContain("shellLineCommentTheme(EditorView),");
    expect(editorThemesSource).toContain('".cm-shell-line-comment *"');
    expect(editorThemesSource).toContain('color: "inherit !important"');
  });

  it("bounds shell comment scanning to syntax-aware visible lines", () => {
    expect(shellHighlightSource).toContain("view.state.doc.lineAt(visibleRange.from).from");
    expect(shellHighlightSource).toContain("tree.resolveInner(absoluteFrom, 1)");
    expect(shellHighlightSource).not.toContain("sliceString(0, end)");
  });

  it("comments a MongoDB line with //", () => {
    const result = runToggleLineComment("db.users.find({})", "//");

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("// db.users.find({})");
  });

  it("uncomments a MongoDB line commented with //", () => {
    const result = runToggleLineComment("// db.users.find({})", "//");

    expect(result.state.doc.toString()).toBe("db.users.find({})");
  });

  it("still comments SQL with --", () => {
    const result = runToggleLineComment("SELECT 1", "--");

    expect(result.state.doc.toString()).toBe("-- SELECT 1");
  });
});
