// @vitest-environment happy-dom
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { MySQL, sql } from "@codemirror/lang-sql";
import { beforeAll, describe, expect, it } from "vitest";
import { loadEngine } from "@/lib/sql/layout/internals";
import { casedKeywordFromSyntaxTree, createQueryEditorKeywordCaseOnTypeFilter, type QueryEditorKeywordCaseOnTypeOptions } from "@/lib/editor/queryEditorKeywordCaseOnType";

beforeAll(async () => {
  // The filter classifies synchronously and skips until the engine is imported.
  await loadEngine();
});

function createState(doc: string, options: Partial<QueryEditorKeywordCaseOnTypeOptions> = {}, selection: EditorSelection | number = doc.length, readOnly = false) {
  const filterOptions: QueryEditorKeywordCaseOnTypeOptions = {
    enabled: () => true,
    keywordCase: () => "upper",
    dialect: () => "mysql",
    databaseType: () => "mysql",
    ...options,
  };
  return EditorState.create({
    doc,
    selection: typeof selection === "number" ? { anchor: selection } : selection,
    extensions: [EditorState.allowMultipleSelections.of(true), readOnly ? EditorState.readOnly.of(true) : [], EditorState.transactionFilter.of(createQueryEditorKeywordCaseOnTypeFilter(filterOptions))],
  });
}

function typeText(state: EditorState, text: string, userEvent = "input.type") {
  // Mirrors real typing: replaces the selection (if any) and carries a caret
  // after the inserted text.
  return state.update({ ...state.replaceSelection(text), userEvent }).state;
}

/**
 * The production editor mounts @codemirror/lang-sql, so the statement window and
 * the lexical context come from the syntax tree rather than the scanner
 * fallback the other tests exercise (no language mounted there).
 */
function createTreeState(doc: string) {
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [sql({ dialect: MySQL }), EditorState.transactionFilter.of(createQueryEditorKeywordCaseOnTypeFilter({ enabled: () => true, keywordCase: () => "upper", dialect: () => "mysql", databaseType: () => "mysql" }))],
  });
  // Let the background parser catch up so the tree-backed window resolves.
  ensureSyntaxTree(state, state.doc.length, 2000);
  return state;
}

describe("queryEditorKeywordCaseOnType", () => {
  it("re-cases the keyword before a typed space", () => {
    expect(typeText(createState("select"), " ").doc.toString()).toBe("SELECT ");
    // Only the word being finished converts; `select` was converted when its own space was typed.
    expect(typeText(createState("select a from"), " ").doc.toString()).toBe("select a FROM ");
  });

  it("honors the lower mode", () => {
    expect(typeText(createState("SELECT a FROM", { keywordCase: () => "lower" }), " ").doc.toString()).toBe("SELECT a from ");
  });

  it("also converts on punctuation and line breaks", () => {
    expect(typeText(createState("select a from"), ",").doc.toString()).toBe("select a FROM,");
    expect(typeText(createState("select"), "\n").doc.toString()).toBe("SELECT\n");
  });

  it("keeps the keyword when the setting is disabled or the mode is preserve", () => {
    expect(typeText(createState("select", { enabled: () => false }), " ").doc.toString()).toBe("select ");
    expect(typeText(createState("select", { keywordCase: () => "preserve" }), " ").doc.toString()).toBe("select ");
  });

  it("leaves read-only editors alone", () => {
    expect(typeText(createState("select", {}, undefined, true), " ").doc.toString()).toBe("select ");
  });

  it("leaves selections, multi-cursor and pasted text alone", () => {
    // Typing over a selection replaces it; the replacement must not re-case anything.
    expect(typeText(createState("select", {}, { anchor: 0, head: 6 }), " ").doc.toString()).toBe(" ");
    const multi = EditorState.create({
      doc: "select",
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(6)], 1),
      extensions: [EditorState.allowMultipleSelections.of(true), EditorState.transactionFilter.of(createQueryEditorKeywordCaseOnTypeFilter({ enabled: () => true, keywordCase: () => "upper", dialect: () => "mysql", databaseType: () => "mysql" }))],
    });
    // Both cursors get the space; neither keyword-looking word is converted.
    expect(typeText(multi, " ").doc.toString()).toBe(" select ");
    expect(typeText(createState("select"), " ", "input.paste").doc.toString()).toBe("select ");
    expect(typeText(createState("select"), " ", "input.type.compose").doc.toString()).toBe("select ");
  });

  it("does not convert inside strings, comments or quoted identifiers", () => {
    expect(typeText(createState("select 'select"), " ").doc.toString()).toBe("select 'select ");
    expect(typeText(createState("-- select"), " ").doc.toString()).toBe("-- select ");
    expect(typeText(createState('"select'), " ").doc.toString()).toBe('"select ');
    expect(typeText(createState("`select"), " ").doc.toString()).toBe("`select ");
  });

  it("does not convert a qualified segment or the qualifier before a typed dot", () => {
    expect(typeText(createState("t.select"), " ").doc.toString()).toBe("t.select ");
    expect(typeText(createState("select"), ".").doc.toString()).toBe("select.");
  });

  it("only touches keywords, not identifiers, functions or already-cased words", () => {
    expect(typeText(createState("select mycol"), " ").doc.toString()).toBe("select mycol ");
    expect(typeText(createState("select count"), " ").doc.toString()).toBe("select count ");
    expect(typeText(createState("SELECT"), " ").doc.toString()).toBe("SELECT ");
    expect(typeText(createState("select"), "x").doc.toString()).toBe("selectx");
  });

  it("re-cases only the last word of a multi-word clause", () => {
    expect(typeText(createState("select a from t group by"), " ").doc.toString()).toBe("select a from t group BY ");
  });

  it("works on a later statement without re-casing earlier ones", () => {
    const doc = "select 1;\nselect";
    expect(typeText(createState(doc), " ").doc.toString()).toBe("select 1;\nSELECT ");
  });

  it("does nothing for a dialect with no SQL grammar", () => {
    expect(typeText(createState("select", { dialect: () => "cypher" }), " ").doc.toString()).toBe("select ");
  });

  it("leaves oversized statement windows alone", () => {
    const doc = `select ${"x,".repeat(9000)}from`;
    expect(doc.length).toBeGreaterThan(16 * 1024);
    expect(typeText(createState(doc), " ").doc.toString()).toBe(`${doc} `);
  });

  it("resolves the window and the lexical context from the SQL syntax tree when the grammar is mounted", () => {
    expect(typeText(createTreeState("select a from"), " ").doc.toString()).toBe("select a FROM ");
    expect(typeText(createTreeState("select 'select"), " ").doc.toString()).toBe("select 'select ");
    expect(typeText(createTreeState("-- select"), " ").doc.toString()).toBe("-- select ");
  });

  it("never reprocesses a replacement transaction", () => {
    // The SQL Server space branch dispatches a range replacement (keyword plus
    // space); only a pure typed insertion may be processed here.
    const state = createState("select", {}, 5);
    expect(state.update({ changes: { from: 0, to: 5, insert: " " }, userEvent: "input.type" }).state.doc.toString()).toBe(" t");
  });

  it("classifies directly from the syntax tree for the cold-start fallback", () => {
    const treeState = createTreeState("select");
    expect(casedKeywordFromSyntaxTree(treeState, 0, 6, "upper")).toEqual({ from: 0, to: 6, insert: "SELECT" });
    expect(casedKeywordFromSyntaxTree(treeState, 0, 6, "lower")).toBeNull();
    const identifier = createTreeState("select mycol");
    expect(casedKeywordFromSyntaxTree(identifier, 7, 12, "upper")).toBeNull();
    // Without the Lezer grammar mounted the tree has no Keyword nodes to trust.
    expect(casedKeywordFromSyntaxTree(EditorState.create({ doc: "select" }), 0, 6, "upper")).toBeNull();
  });

  it("keeps the conversion and the typed character in one undo step", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "select",
        selection: { anchor: 6 },
        extensions: [history(), EditorState.transactionFilter.of(createQueryEditorKeywordCaseOnTypeFilter({ enabled: () => true, keywordCase: () => "upper", dialect: () => "mysql", databaseType: () => "mysql" }))],
      }),
    });
    view.dispatch({ changes: { from: 6, insert: " " }, userEvent: "input.type" });
    expect(view.state.doc.toString()).toBe("SELECT ");
    expect(view.state.selection.main.head).toBe(7);
    undo(view);
    expect(view.state.doc.toString()).toBe("select");
    view.destroy();
  });
});
