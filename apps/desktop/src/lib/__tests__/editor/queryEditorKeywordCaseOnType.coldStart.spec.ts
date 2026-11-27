// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { MySQL, sql } from "@codemirror/lang-sql";
import { describe, expect, it } from "vitest";
import { loadedSqlFormatterEngine } from "@/lib/sql/layout/internals";
import { createQueryEditorKeywordCaseOnTypeFilter } from "@/lib/editor/queryEditorKeywordCaseOnType";

// Deliberately does NOT preload the sql-formatter engine: this file pins the
// cold-start behavior (first keyword after launching the app, before the lazy
// import resolves). Vitest isolates module state per test file, so the engine
// stays unloaded here even when other specs load it.

function createColdState(doc: string) {
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [sql({ dialect: MySQL }), EditorState.transactionFilter.of(createQueryEditorKeywordCaseOnTypeFilter({ enabled: () => true, keywordCase: () => "upper", dialect: () => "mysql", databaseType: () => "mysql" }))],
  });
  ensureSyntaxTree(state, state.doc.length, 2000);
  return state;
}

function typeSpace(state: EditorState) {
  return state.update({ ...state.replaceSelection(" "), userEvent: "input.type" }).state;
}

describe("typing-time keyword case before the formatter engine loads", () => {
  it("converts the first keyword from the syntax tree instead of dropping it", () => {
    expect(loadedSqlFormatterEngine()).toBeNull();
    expect(typeSpace(createColdState("select")).doc.toString()).toBe("SELECT ");
    expect(typeSpace(createColdState("select a from")).doc.toString()).toBe("select a FROM ");
    expect(typeSpace(createColdState("select a from t group by")).doc.toString()).toBe("select a from t group BY ");
  });

  it("keeps the same guards while classifying from the tree", () => {
    expect(typeSpace(createColdState("select mycol")).doc.toString()).toBe("select mycol ");
    expect(typeSpace(createColdState("t.select")).doc.toString()).toBe("t.select ");
    expect(typeSpace(createColdState("select 'select")).doc.toString()).toBe("select 'select ");
    expect(typeSpace(createColdState("-- select")).doc.toString()).toBe("-- select ");
  });
});
