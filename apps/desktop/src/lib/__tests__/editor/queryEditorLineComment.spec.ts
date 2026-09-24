import { toggleLineComment } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { EditorState, Prec, type Transaction } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { queryEditorCommentTokens, queryEditorLineCommentToken, queryEditorWordLanguageData } from "@/lib/editor/queryEditorLineComment";

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

describe("QueryEditor word selection", () => {
  it("includes the @ prefix in SQL Server variable words", () => {
    const sqlServer = EditorState.create({ doc: "@name", extensions: [EditorState.languageData.of(() => queryEditorWordLanguageData("sqlserver"))] });
    const mysql = EditorState.create({ doc: "@name", extensions: [EditorState.languageData.of(() => queryEditorWordLanguageData("mysql"))] });
    const systemVariable = EditorState.create({ doc: "@@ROWCOUNT", extensions: [EditorState.languageData.of(() => queryEditorWordLanguageData("sqlserver"))] });

    for (let position = 0; position <= 5; position += 1) expect(sqlServer.wordAt(position)).toMatchObject({ from: 0, to: 5 });
    expect(mysql.wordAt(2)).toMatchObject({ from: 1, to: 5 });
    expect(systemVariable.wordAt(1)).toMatchObject({ from: 0, to: 10 });
  });

  it("includes the # prefix in SQL Server temp table words", () => {
    const create = (doc: string, dbType: "sqlserver" | "mysql") => EditorState.create({ doc, extensions: [EditorState.languageData.of(() => queryEditorWordLanguageData(dbType))] });
    const local = create("#order", "sqlserver");
    const global = create("##order", "sqlserver");
    const mysql = create("#order", "mysql");

    for (let position = 0; position <= 6; position += 1) expect(local.wordAt(position)).toMatchObject({ from: 0, to: 6 });
    for (let position = 0; position <= 7; position += 1) expect(global.wordAt(position)).toMatchObject({ from: 0, to: 7 });
    expect(mysql.wordAt(3)).toMatchObject({ from: 1, to: 6 });
  });
});

describe("QueryEditor line comment", () => {
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
