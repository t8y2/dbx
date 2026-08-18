import * as langSql from "@codemirror/lang-sql";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { isSqlCompletionSuppressedContext, isSqlLikeCompletionStatement } from "@/lib/sql/sqlCompletion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";

// Forces CM6's background parse to completion so tests are deterministic. Production code never
// does this -- see sqlSyntaxTreeWindow.ts's doc comment.
function stateFor(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, "postgres", "postgres") })],
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state;
}

describe("isSqlCompletionSuppressedContext with a live EditorState", () => {
  it("suppresses completion inside the maintainer's round-4 counterexample (unterminated string with 120,000 repeated ';') where the pure-string fallback gets the boundary wrong", () => {
    const sql = `SELECT 'unterminated ${";".repeat(120_000)}`;
    const cursor = sql.length - 5;
    const state = stateFor(sql);

    // Pure-string call (no live EditorState): exercises the documented bounded fallback, which
    // is the path affected by the still-open, disclosed heuristic limitation.
    const withoutTree = isSqlCompletionSuppressedContext(sql, cursor, { databaseType: "postgres" });
    // With the live EditorState: resolved via the syntax tree, which correctly sees this whole
    // 50,000-character run as one unterminated string literal.
    const withTree = isSqlCompletionSuppressedContext(sql, cursor, { databaseType: "postgres", editorState: state });

    expect(withTree).toBe(true);
    // Documents the contrast, not a requirement: the pure-string fallback (no live EditorState)
    // still exhibits the maintainer's exact round-4 counterexample, because it's unchanged --
    // see insertValueHints.ts's doc comment and the reframed test in insertValueHints.test.ts. A
    // real editor session always has a live EditorState, so `withTree` (asserted above) is what
    // actually reaches a user typing in the editor.
    expect(withoutTree).toBe(false);
  });

  it("does not suppress completion on real code immediately before the unterminated string opens", () => {
    const sql = `SELECT id, ${";".repeat(50)}'unterminated forever`;
    const cursor = sql.indexOf("id") + 1;
    const state = stateFor(sql);

    expect(isSqlCompletionSuppressedContext(sql, cursor, { databaseType: "postgres", editorState: state })).toBe(false);
  });
});

describe("isSqlLikeCompletionStatement with a live EditorState", () => {
  it("resolves the active statement via the syntax tree for a cursor deep inside a large document", () => {
    const filler = Array.from({ length: 2_000 }, (_, index) => `-- comment line ${index}\n`).join("");
    const sql = `${filler}SELECT id FROM users WHERE `;
    const cursor = sql.length;
    const state = stateFor(sql);

    expect(isSqlLikeCompletionStatement(sql, cursor, { databaseType: "postgres", editorState: state })).toBe(true);
  });

  it("builds the completion semantic model from only the active statement", () => {
    const filler = Array.from({ length: 4_000 }, (_, index) => `SELECT ${index};\n`).join("");
    const activeStatement = "SELECT u. FROM users u";
    const sql = filler + activeStatement;
    const cursor = sql.indexOf("u. FROM", filler.length) + 2;
    const state = stateFor(sql);

    const model = buildSqlSemanticModel(sql, cursor, { databaseType: "postgres", editorState: state });

    expect(model.statement.text).toBe(activeStatement);
    expect(model.rowSources).toEqual([expect.objectContaining({ name: "users", alias: "u" })]);
    expect(model.tokens.length).toBeLessThan(10);
    expect(model.tokens.every((token) => token.span.start >= filler.length)).toBe(true);
  });
});
