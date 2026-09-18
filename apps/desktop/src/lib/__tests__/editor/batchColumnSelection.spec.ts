// @vitest-environment happy-dom

import { snippetCompletion } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { batchColumnSelectionColumnList, batchColumnSelectionInsertReplacement, batchColumnSelectionReplaceTo, completionReplacementTo, isBatchColumnSelectionCompletionActive, shouldResolveSqlColumnCompletion, shouldSwallowSelectStar } from "@/lib/editor/batchColumnSelection";
import { getSqlCompletionContext, prepareSqlCompletionReplacement } from "@/lib/sql/sqlCompletion";

const columnItem = { label: "price", type: "column" as const, apply: "price", boost: 0 };

function replaceSelectWildcardFor(document: string, to: number): boolean {
  const context = getSqlCompletionContext(document, to);
  return prepareSqlCompletionReplacement(document, to, context, [columnItem]).items[0]?.replaceSelectWildcard === true;
}

describe("batchColumnSelectionColumnList", () => {
  it("keeps a typed qualifier on every projection after the first", () => {
    expect(batchColumnSelectionColumnList(["method", "path", "remark"], "select", "ap")).toBe("method, ap.path, ap.remark");
  });

  it("does not add a qualifier to INSERT target columns", () => {
    expect(batchColumnSelectionColumnList(["id", "name"], "insert", "users")).toBe("id, name");
  });
});

describe("batchColumnSelectionReplaceTo", () => {
  it("consumes the auto-inserted INSERT closing parenthesis", () => {
    expect(batchColumnSelectionReplaceTo({ from: 20, to: 20, mode: "insert", nextCharacter: ")" })).toBe(21);
  });

  it("keeps the replacement boundary when INSERT has no closing parenthesis", () => {
    expect(batchColumnSelectionReplaceTo({ from: 20, to: 20, mode: "insert", nextCharacter: "" })).toBe(20);
  });

  it("continues consuming a matching closing identifier quote", () => {
    expect(batchColumnSelectionReplaceTo({ from: 20, to: 20, mode: "select", nextCharacter: '"', replaceClosingQuote: '"' })).toBe(21);
  });

  it("consumes a lone SELECT * immediately after an empty-prefix completion (#9433-adjacent)", () => {
    expect(batchColumnSelectionReplaceTo({ from: 7, to: 7, mode: "select", nextCharacter: "*", replaceSelectWildcard: true })).toBe(8);
  });

  it("does not consume a `*` that is a multiplication operator, not the wildcard", () => {
    expect(batchColumnSelectionReplaceTo({ from: 7, to: 7, mode: "select", nextCharacter: "*", replaceSelectWildcard: false })).toBe(7);
  });
});

describe("shouldSwallowSelectStar", () => {
  it("swallows a bare `*` only with an explicit SELECT wildcard marker", () => {
    expect(shouldSwallowSelectStar(7, 7, "*", true)).toBe(true);
    expect(shouldSwallowSelectStar(7, 7, "*", false)).toBe(false);
    expect(shouldSwallowSelectStar(7, 7, "*")).toBe(false);
  });

  it("leaves a `*` alone once a real prefix was replaced", () => {
    expect(shouldSwallowSelectStar(7, 10, "*", true)).toBe(false);
  });

  it("leaves any other trailing character alone", () => {
    expect(shouldSwallowSelectStar(7, 7, " ", true)).toBe(false);
    expect(shouldSwallowSelectStar(7, 7, "", true)).toBe(false);
  });
});

describe("completion wildcard acceptance", () => {
  it.each([
    ["SELECT * FROM users", "SELECT price FROM users"],
    ["SELECT *qty FROM users", "SELECT price*qty FROM users"],
  ])("applies ordinary completion without deleting multiplication in %s", (document, expected) => {
    const from = document.indexOf("*");
    const replaceTo = completionReplacementTo({ from, to: from, nextCharacter: "*", replaceSelectWildcard: replaceSelectWildcardFor(document, from) });
    const transaction = EditorState.create({ doc: document }).update({ changes: { from, to: replaceTo, insert: "price" } });

    expect(transaction.state.doc.toString()).toBe(expected);
  });

  it.each([
    ["SELECT * FROM users", "SELECT price FROM users"],
    ["SELECT *qty FROM users", "SELECT price*qty FROM users"],
  ])("applies snippet completion without deleting multiplication in %s", (document, expected) => {
    const from = document.indexOf("*");
    const replaceTo = completionReplacementTo({ from, to: from, nextCharacter: "*", replaceSelectWildcard: replaceSelectWildcardFor(document, from) });
    const view = new EditorView({ parent: window.document.createElement("div"), state: EditorState.create({ doc: document }) });
    const snippet = snippetCompletion("price", { label: "price", type: "function" });

    expect(typeof snippet.apply).toBe("function");
    if (typeof snippet.apply === "function") snippet.apply(view, snippet, from, replaceTo);
    expect(view.state.doc.toString()).toBe(expected);
    view.destroy();
  });

  it.each([
    ["SELECT * FROM users", "SELECT price, qty FROM users"],
    ["SELECT *qty FROM users", "SELECT price, qty*qty FROM users"],
  ])("applies batch completion without deleting multiplication in %s", (document, expected) => {
    const from = document.indexOf("*");
    const replaceTo = batchColumnSelectionReplaceTo({ from, to: from, mode: "select", nextCharacter: "*", replaceSelectWildcard: replaceSelectWildcardFor(document, from) });
    const transaction = EditorState.create({ doc: document }).update({ changes: { from, to: replaceTo, insert: "price, qty" } });

    expect(transaction.state.doc.toString()).toBe(expected);
  });
});

describe("batchColumnSelectionInsertReplacement", () => {
  it("consumes whitespace before an existing closing parenthesis", () => {
    expect(
      batchColumnSelectionInsertReplacement({
        document: "INSERT INTO users (id   )",
        to: "INSERT INTO users (id".length,
        columns: "id, name",
        valuesKeyword: "VALUES",
        valueCount: 2,
      }),
    ).toEqual({ replaceTo: "INSERT INTO users (id   )".length, insert: "id, name) VALUES (${1:value}, ${2:value})" });
  });

  it("does not duplicate an existing VALUES clause", () => {
    expect(
      batchColumnSelectionInsertReplacement({
        document: "INSERT INTO users (id)  VALUES (1)",
        to: "INSERT INTO users (id".length,
        columns: "id, name",
        valuesKeyword: "VALUES",
        valueCount: 2,
      }),
    ).toEqual({ replaceTo: "INSERT INTO users (id)".length, insert: "id, name)" });
  });
});

describe("isBatchColumnSelectionCompletionActive", () => {
  it("only accepts a currently active completion popup", () => {
    expect(isBatchColumnSelectionCompletionActive("active")).toBe(true);
    expect(isBatchColumnSelectionCompletionActive("pending")).toBe(false);
    expect(isBatchColumnSelectionCompletionActive(null)).toBe(false);
  });
});

describe("shouldResolveSqlColumnCompletion", () => {
  it("loads fields after SELECT space when a FROM table is already known", () => {
    expect(shouldResolveSqlColumnCompletion({ suggestColumns: true, hasReferencedTables: true, prefix: "", typedActivation: false, selectListColumnContext: true })).toBe(true);
  });

  it("keeps empty non-SELECT column contexts from fetching metadata", () => {
    expect(shouldResolveSqlColumnCompletion({ suggestColumns: true, hasReferencedTables: true, prefix: "", typedActivation: false, selectListColumnContext: false })).toBe(false);
  });
});
