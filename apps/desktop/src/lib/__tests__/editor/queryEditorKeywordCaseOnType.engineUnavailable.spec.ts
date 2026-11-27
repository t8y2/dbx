import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { MySQL, sql } from "@codemirror/lang-sql";
import { describe, expect, it, vi } from "vitest";
import { createQueryEditorKeywordCaseOnTypeFilter } from "@/lib/editor/queryEditorKeywordCaseOnType";

// Simulates a cold start whose formatter-engine import never succeeds: the
// syntax-tree fallback must still convert what it can, and the filter must fail
// safe (leave the text alone) when no tree is available either.
vi.mock("@/lib/sql/layout/internals", () => ({
  loadEngine: () => Promise.resolve(null),
  loadedSqlFormatterEngine: () => null,
}));

function createState(doc: string, withGrammar: boolean) {
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [...(withGrammar ? [sql({ dialect: MySQL })] : []), EditorState.transactionFilter.of(createQueryEditorKeywordCaseOnTypeFilter({ enabled: () => true, keywordCase: () => "upper", dialect: () => "mysql", databaseType: () => "mysql" }))],
  });
  if (withGrammar) ensureSyntaxTree(state, state.doc.length, 2000);
  return state;
}

function typeSpace(state: EditorState) {
  return state.update({ ...state.replaceSelection(" "), userEvent: "input.type" }).state;
}

describe("typing-time keyword case with the formatter engine unavailable", () => {
  it("falls back to the syntax tree instead of dropping the keyword", () => {
    expect(typeSpace(createState("select", true)).doc.toString()).toBe("SELECT ");
    expect(typeSpace(createState("select a from", true)).doc.toString()).toBe("select a FROM ");
    expect(typeSpace(createState("select mycol", true)).doc.toString()).toBe("select mycol ");
  });

  it("leaves the text alone when no usable tree exists", () => {
    expect(typeSpace(createState("select", false)).doc.toString()).toBe("select ");
  });
});
