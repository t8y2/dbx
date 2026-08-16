import { EditorState, type Transaction } from "@codemirror/state";
import { insertNewlineKeepIndent } from "@codemirror/commands";
import { describe, expect, it, vi } from "vitest";
import { insertQueryEditorNewline, shouldStartNextSqlStatementAtColumnZero } from "@/lib/editor/queryEditorNewline";
import type { DatabaseType } from "@/types/database";

function createState(doc: string, cursor = doc.length) {
  return EditorState.create({ doc, selection: { anchor: cursor } });
}

function insertNewline(doc: string, databaseType: DatabaseType = "mysql") {
  let state = createState(doc);
  const dispatch = vi.fn((transaction: Transaction) => {
    state = transaction.state;
  });
  const handled = insertQueryEditorNewline(
    {
      get state() {
        return state;
      },
      dispatch,
    } as never,
    insertNewlineKeepIndent,
    databaseType,
  );
  return { dispatch, handled, state };
}

describe("queryEditorNewline", () => {
  it("starts a new top-level statement at column zero after a formatted SQL terminator", () => {
    const result = insertNewline("SELECT\n  *\nFROM\n  users;");

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("SELECT\n  *\nFROM\n  users;\n");
    expect(result.state.selection.main.head).toBe(result.state.doc.length);
  });

  it("keeps indentation while the current SQL statement is unfinished", () => {
    const result = insertNewline("SELECT\n  *\nFROM\n  users");

    expect(result.state.doc.toString()).toBe("SELECT\n  *\nFROM\n  users\n  ");
  });

  it("keeps indentation after an internal MySQL routine semicolon", () => {
    const sqlText = "CREATE PROCEDURE p() BEGIN\n  SET value = 1;";
    const result = insertNewline(sqlText, "mysql");

    expect(shouldStartNextSqlStatementAtColumnZero(createState(sqlText), "mysql")).toBe(false);
    expect(result.state.doc.toString()).toBe(`${sqlText}\n  `);
  });

  it("recognizes the final semicolon of a MySQL routine as a top-level terminator", () => {
    const sqlText = "CREATE PROCEDURE p() BEGIN\n  SET value = 1;\nEND;";

    expect(shouldStartNextSqlStatementAtColumnZero(createState(sqlText), "mysql")).toBe(true);
  });

  it("does not treat semicolons in strings or comments as statement terminators", () => {
    for (const sqlText of ["  SELECT ';'", "  -- unfinished note;", "SELECT 1;\n  -- trailing note;"]) {
      expect(shouldStartNextSqlStatementAtColumnZero(createState(sqlText), "mysql")).toBe(false);
      expect(insertNewline(sqlText).state.doc.toString()).toBe(`${sqlText}\n  `);
    }
  });

  it("distinguishes internal and final Oracle PLSQL semicolons", () => {
    const internal = "BEGIN\n  NULL;";
    const complete = `${internal}\nEND;`;

    expect(shouldStartNextSqlStatementAtColumnZero(createState(internal), "oracle")).toBe(false);
    expect(shouldStartNextSqlStatementAtColumnZero(createState(complete), "oracle")).toBe(true);
  });

  it("resets indentation when spaces follow the terminating semicolon", () => {
    const sqlText = "  SELECT 1;   ";

    expect(insertNewline(sqlText).state.doc.toString()).toBe(`${sqlText}\n`);
  });
});
