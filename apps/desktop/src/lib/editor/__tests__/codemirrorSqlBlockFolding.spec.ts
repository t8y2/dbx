import * as langSql from "@codemirror/lang-sql";
import { ensureSyntaxTree, foldable } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { sqlBlockFoldService } from "@/lib/editor/codemirrorSqlBlockFolding";

function stateFor(doc: string, dialectName: "mysql" | "sqlserver" = "mysql"): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, dialectName) }), sqlBlockFoldService],
  });
  ensureSyntaxTree(state, doc.length, 5_000);
  return state;
}

function foldedTextAtLine(state: EditorState, lineNumber: number): string | null {
  const line = state.doc.line(lineNumber);
  const range = foldable(state, line.from, line.to);
  return range ? state.sliceDoc(range.from, range.to) : null;
}

describe("sqlBlockFoldService", () => {
  it("folds a BEGIN...END block, from the end of the BEGIN line to the start of END", () => {
    const sql = "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND";
    const state = stateFor(sql);

    expect(foldedTextAtLine(state, 2)).toBe("\n  SELECT 1;\n");
  });

  it("does not fold IF...END IF (issue #6574's original complaint) -- no node exists for it, and folds nothing else either", () => {
    const sql = "BEGIN\n  IF 1 = 1 THEN\n    SELECT 1;\n  END IF;\nEND";
    const state = stateFor(sql);

    // Line 2 ("IF 1 = 1 THEN") is not opened by this service, so no BEGIN/CASE-block fold starts there.
    expect(foldedTextAtLine(state, 2)).toBeNull();
  });

  it("regression: END IF inside a BEGIN block must not be mistaken for BEGIN's own closer", () => {
    // Before the fix, the first `END` (of "END IF") popped the BEGIN entry off the stack early,
    // so the BEGIN fold ended at "END IF" instead of the real outer END, and the final bare
    // `END` was left unmatched.
    const sql = "BEGIN\n  IF 1 = 1 THEN\n    SELECT 1;\n  END IF;\nEND";
    const state = stateFor(sql);

    const folded = foldedTextAtLine(state, 1);
    expect(folded).not.toBeNull();
    expect(folded).toContain("END IF;"); // the real outer END must swallow the inner "END IF;" too
    expect(state.sliceDoc(0, foldable(state, state.doc.line(1).from, state.doc.line(1).to)!.to)).toBe("BEGIN\n  IF 1 = 1 THEN\n    SELECT 1;\n  END IF;\n");
  });

  it("folds nested BEGIN...END blocks independently", () => {
    const sql = "BEGIN\n  BEGIN\n    SELECT 1;\n  END;\n  SELECT 2;\nEND";
    const state = stateFor(sql);

    expect(foldedTextAtLine(state, 2)).toBe("\n    SELECT 1;\n  ");
    expect(foldedTextAtLine(state, 1)).toBe("\n  BEGIN\n    SELECT 1;\n  END;\n  SELECT 2;\n");
  });

  it("folds CASE...END (expression form, bare END)", () => {
    const sql = "SELECT CASE\n  WHEN a THEN 1\n  ELSE 2\nEND FROM t";
    const state = stateFor(sql);

    expect(foldedTextAtLine(state, 1)).toBe("\n  WHEN a THEN 1\n  ELSE 2\n");
  });

  it("folds CASE...END CASE (procedural statement form) and does not treat the trailing CASE as a new opener", () => {
    const sql = "BEGIN\n  CASE v\n    WHEN 1 THEN SELECT 1;\n  END CASE;\nEND";
    const state = stateFor(sql);

    expect(foldedTextAtLine(state, 2)).toBe("\n    WHEN 1 THEN SELECT 1;\n  ");
  });

  it("regression: END TRY / END CATCH must not be treated as closing an enclosing BEGIN", () => {
    const sql = "BEGIN\n  BEGIN TRY\n    SELECT 1;\n  END TRY\n  BEGIN CATCH\n    SELECT 2;\n  END CATCH;\nEND";
    const state = stateFor(sql, "sqlserver");

    const folded = foldedTextAtLine(state, 1);
    expect(folded).not.toBeNull();
    expect(folded).toContain("END CATCH;"); // outer BEGIN must extend all the way to the real outer END
  });

  it.each(["BEGIN TRAN", "begin transaction", "BeGiN DiStRiBuTeD TrAnSaCtIoN"])("does not treat SQL Server %s as a block opener inside BEGIN...END", (transactionBegin) => {
    const sql = `BEGIN
  ${transactionBegin};
  SELECT CASE
    WHEN 1 = 1 THEN 1
    ELSE 0
  END;
  COMMIT TRAN;
END`;
    const state = stateFor(sql, "sqlserver");

    expect(foldedTextAtLine(state, 2)).toBeNull();
    expect(foldedTextAtLine(state, 3)).toBe("\n    WHEN 1 = 1 THEN 1\n    ELSE 0\n  ");
    const folded = foldedTextAtLine(state, 1);
    expect(folded).not.toBeNull();
    expect(folded).toContain("COMMIT TRAN;");
  });

  it("keeps a similarly prefixed BEGIN word as an ordinary block opener", () => {
    const sql = "BEGIN TRANS\n  SELECT CASE\n    WHEN 1 = 1 THEN 1\n  END;\nEND";
    const state = stateFor(sql, "sqlserver");

    expect(foldedTextAtLine(state, 1)).toContain("SELECT CASE");
    expect(foldedTextAtLine(state, 2)).toBe("\n    WHEN 1 = 1 THEN 1\n  ");
  });

  it("ignores keywords inside string/identifier/comment text", () => {
    const sql = "BEGIN\n  SELECT 'BEGIN END CASE', \"END\";\n  /* BEGIN nested comment END */\nEND";
    const state = stateFor(sql);

    expect(foldedTextAtLine(state, 1)).toBe("\n  SELECT 'BEGIN END CASE', \"END\";\n  /* BEGIN nested comment END */\n");
  });

  it("returns null for a line with no block opener", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const state = stateFor(sql);

    expect(foldedTextAtLine(state, 1)).toBeNull();
    expect(foldedTextAtLine(state, 2)).toBeNull();
  });

  it("regression: a BEGIN...END block entirely on one line must not produce an inverted fold range", () => {
    // `from`/`to` were both derived from the shared line, and `from` (end of line) fell after
    // `to` (start of END) -- CodeMirror's foldable() must not surface that as a range at all.
    const sql = "PROCEDURE p() BEGIN END";
    const state = stateFor(sql);

    expect(foldedTextAtLine(state, 1)).toBeNull();
  });

  it("regression: a comment between END and CASE/TRY/CATCH must not break continuation detection", () => {
    // Before the fix, the gap check required pure whitespace, so a comment there made `END`
    // look like a bare closer; the literal `CASE`/`TRY`/`CATCH` word right after was then
    // pushed as an unmatched new opener, desyncing every fold pairing after it.
    const sql = "BEGIN\n  CASE v\n    WHEN 1 THEN SELECT 1;\n  END /* comment */ CASE;\nEND";
    const state = stateFor(sql);

    expect(foldedTextAtLine(state, 2)).toBe("\n    WHEN 1 THEN SELECT 1;\n  ");
    const folded = foldedTextAtLine(state, 1);
    expect(folded).not.toBeNull();
    expect(folded).toContain("END /* comment */ CASE;");
  });

  it("still folds correctly after a dialect reconfigure with the document unchanged", () => {
    // QueryEditor.vue's databaseType/dialect watcher reconfigures the language extension in a
    // Compartment, via a dispatch with no doc `changes`, whenever the user switches a tab's
    // connection dialect without editing text -- exercise that same sequence here.
    const languageComp = new Compartment();
    const sql = "BEGIN\n  BEGIN TRY\n    SELECT 1;\n  END TRY\nEND";
    let state = EditorState.create({
      doc: sql,
      extensions: [languageComp.of(langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, "mysql") })), sqlBlockFoldService],
    });
    ensureSyntaxTree(state, sql.length, 5_000);
    expect(foldedTextAtLine(state, 1)).toContain("END TRY");

    // Reconfigure only -- no `changes`, so `state.doc` (the `Text` instance) stays identical.
    const before = state.doc;
    state = state.update({
      effects: languageComp.reconfigure(langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, "sqlserver") })),
    }).state;
    expect(state.doc).toBe(before);
    ensureSyntaxTree(state, sql.length, 5_000);

    expect(foldedTextAtLine(state, 1)).toContain("END TRY");
  });
});
