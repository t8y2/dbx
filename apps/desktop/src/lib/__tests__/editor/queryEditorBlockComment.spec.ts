import { toggleBlockComment } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";

function runToggleBlockComment(doc: string, selection: EditorSelection | { anchor: number; head?: number }) {
  let state = EditorState.create({ doc, selection, extensions: [sql()] });
  const dispatch = vi.fn((transaction: Transaction) => {
    state = transaction.state;
  });
  const handled = toggleBlockComment({
    get state() {
      return state;
    },
    dispatch,
  } as never);

  return { dispatch, handled, state };
}

describe("QueryEditor block comment", () => {
  it("wraps the selected SQL in a block comment", () => {
    const doc = "SELECT id FROM users;";
    const selection = EditorSelection.range(doc.indexOf("id"), doc.indexOf("id") + "id".length);
    const result = runToggleBlockComment(doc, selection);

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("SELECT /* id */ FROM users;");
  });

  it("removes an existing block comment around the selection", () => {
    const doc = "SELECT /* id */ FROM users;";
    const selection = EditorSelection.range(doc.indexOf("/*"), doc.indexOf("*/") + "*/".length);
    const result = runToggleBlockComment(doc, selection);

    expect(result.state.doc.toString()).toBe("SELECT id FROM users;");
  });
});
