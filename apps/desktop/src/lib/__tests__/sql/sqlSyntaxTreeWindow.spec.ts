import * as langSql from "@codemirror/lang-sql";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { resolveLexicalLeafFromSyntaxTree, resolveStatementWindowFromSyntaxTree } from "@/lib/sql/sqlSyntaxTreeWindow";

// Forces CM6's background parse to completion so tests are deterministic instead of racing the
// idle-time parse scheduler. Production code never does this (see sqlSyntaxTreeWindow.ts's doc
// comment on why it only ever consults syntaxTree/syntaxTreeAvailable, never ensureSyntaxTree).
function stateFor(doc: string, dialectName: "mysql" | "postgres" | "sqlserver" = "postgres", databaseType?: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, dialectName, databaseType as never) })],
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state;
}

describe("resolveStatementWindowFromSyntaxTree", () => {
  it("finds the true statement start (0) for an unterminated string with 120,000 repeated ';' -- the maintainer's exact round-4 counterexample, at a scale that reproduces it", () => {
    const sql = `SELECT 'unterminated ${";".repeat(120_000)}`;
    const cursor = sql.length - 5;
    const state = stateFor(sql);

    const window = resolveStatementWindowFromSyntaxTree(state, cursor);

    expect(window).not.toBeNull();
    expect(window?.from).toBe(0);
    expect(window?.to).toBe(sql.length);
  });

  it("resolves a normal multi-statement document and trims the trailing ';'", () => {
    const sql = "select id from users; select id from orders;";
    const cursor = sql.indexOf("orders");
    const state = stateFor(sql);

    const window = resolveStatementWindowFromSyntaxTree(state, cursor);

    expect(window).not.toBeNull();
    expect(sql.slice(window!.from, window!.to)).toBe("select id from orders");
  });

  it("resolves the statement when the cursor sits in trailing whitespace after the last token", () => {
    const sql = "select id from users;   \n  ";
    const cursor = sql.length - 2;
    const state = stateFor(sql);

    const window = resolveStatementWindowFromSyntaxTree(state, cursor);

    expect(window).not.toBeNull();
    expect(sql.slice(window!.from, window!.to)).toBe("select id from users");
  });

  it("returns null (safe fallback) when a nearby dollar-quote tag makes the tree's boundary untrustworthy", () => {
    // This app disables doubleDollarQuotedStrings (issue #788), so the tree parses each ';'
    // inside the $$ body as a real statement boundary instead of treating the body as one unit.
    const body = Array.from({ length: 400 }, (_, index) => `SELECT ${index};`).join(" ");
    const sql = `CREATE FUNCTION f() RETURNS void AS $$ ${body} $$ LANGUAGE sql;`;
    const cursor = sql.indexOf(body) + 2000;
    const state = stateFor(sql);

    const window = resolveStatementWindowFromSyntaxTree(state, cursor);

    expect(window).toBeNull();
  });

  it("requires the exact tagged delimiter before trusting a statement boundary", () => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $outer$ SELECT '$inner$'; SELECT 2; $outer$ LANGUAGE sql;`;
    const cursor = sql.indexOf("SELECT 2") + 3;
    const state = stateFor(sql);

    expect(resolveStatementWindowFromSyntaxTree(state, cursor)).toBeNull();
  });
});

describe("resolveLexicalLeafFromSyntaxTree", () => {
  it("classifies a position inside a single-quoted string as a string literal", () => {
    const sql = "select * from t where name = 'hello world'";
    const cursor = sql.indexOf("hello");
    const state = stateFor(sql);

    expect(resolveLexicalLeafFromSyntaxTree(state, cursor)).toEqual({
      inLineComment: false,
      inBlockComment: false,
      inStringLiteral: true,
    });
  });

  it("classifies a position inside an unterminated string spanning the rest of the document as a string literal", () => {
    const sql = `select 'unterminated ${";".repeat(40_000)}`;
    const cursor = sql.length - 3;
    const state = stateFor(sql);

    expect(resolveLexicalLeafFromSyntaxTree(state, cursor)?.inStringLiteral).toBe(true);
  });

  it("classifies a position inside an unterminated block comment as a comment", () => {
    const sql = `select 1;\n/* unterminated ${"x".repeat(40_000)}`;
    const cursor = sql.length - 3;
    const state = stateFor(sql);

    expect(resolveLexicalLeafFromSyntaxTree(state, cursor)).toEqual({
      inLineComment: false,
      inBlockComment: true,
      inStringLiteral: false,
    });
  });

  it("classifies a position inside a line comment as a comment", () => {
    const sql = "select 1; -- trailing comment\nselect 2;";
    const cursor = sql.indexOf("trailing");
    const state = stateFor(sql);

    expect(resolveLexicalLeafFromSyntaxTree(state, cursor)).toEqual({
      inLineComment: true,
      inBlockComment: false,
      inStringLiteral: false,
    });
  });

  it("does not treat a double-quoted or backtick-quoted identifier as a string literal", () => {
    const doubleQuoted = 'select "user_name" from users';
    const doubleQuotedState = stateFor(doubleQuoted);
    expect(resolveLexicalLeafFromSyntaxTree(doubleQuotedState, doubleQuoted.indexOf("user_name"))?.inStringLiteral).toBe(false);

    const backtickQuoted = "select `user_name` from users";
    const backtickState = stateFor(backtickQuoted, "mysql", "mysql");
    expect(resolveLexicalLeafFromSyntaxTree(backtickState, backtickQuoted.indexOf("user_name"))?.inStringLiteral).toBe(false);
  });

  it("classifies plain code as neither a comment nor a string literal", () => {
    const sql = "select id from users";
    const cursor = sql.indexOf("id");
    const state = stateFor(sql);

    expect(resolveLexicalLeafFromSyntaxTree(state, cursor)).toEqual({
      inLineComment: false,
      inBlockComment: false,
      inStringLiteral: false,
    });
  });
});
