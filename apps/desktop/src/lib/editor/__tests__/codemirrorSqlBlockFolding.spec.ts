import * as langSql from "@codemirror/lang-sql";
import { ensureSyntaxTree, foldable } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { collectUnionBranchFoldRanges, sqlBlockFoldService } from "@/lib/editor/codemirrorSqlBlockFolding";

function stateFor(doc: string, dialectName: "mysql" | "postgres" | "sqlserver" = "mysql"): EditorState {
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

  it("folds each CTE and nested FROM subquery in the reported PostgreSQL structure", () => {
    const sql = `WITH t1 AS (
    SELECT fee_code
    FROM fact_activity
)
, t2 AS (
    SELECT fee_code
    FROM fact_verification
)
, t3 AS (
    SELECT fee_code
    FROM (
        SELECT fee_code
        FROM fact_extract
    ) extracted
)
SELECT *
FROM t1
LEFT JOIN t2 ON t1.fee_code = t2.fee_code
LEFT JOIN t3 ON t1.fee_code = t3.fee_code;`;
    const state = stateFor(sql, "postgres");

    expect(foldedTextAtLine(state, 1)).toBe("\n    SELECT fee_code\n    FROM fact_activity\n");
    expect(foldedTextAtLine(state, 5)).toBe("\n    SELECT fee_code\n    FROM fact_verification\n");
    expect(foldedTextAtLine(state, 9)).toContain("FROM (\n");
    expect(foldedTextAtLine(state, 11)).toBe("\n        SELECT fee_code\n        FROM fact_extract\n    ");
  });

  it("folds a LEFT JOIN subquery from its opening line", () => {
    const sql = `SELECT account.id
FROM account
LEFT JOIN (
  SELECT account_id, SUM(amount) AS total
  FROM fee
  GROUP BY account_id
) summary ON summary.account_id = account.id;`;
    const state = stateFor(sql, "postgres");

    expect(foldedTextAtLine(state, 3)).toBe("\n  SELECT account_id, SUM(amount) AS total\n  FROM fee\n  GROUP BY account_id\n");
  });

  it("folds SELECT branches around UNION ALL at the same query level", () => {
    const sql = `WITH combined AS (
  SELECT id, amount
  FROM current_fees
  UNION ALL
  SELECT id, amount
  FROM archived_fees
)
SELECT *
FROM combined
UNION ALL
SELECT *
FROM manual_fees;`;
    const state = stateFor(sql, "postgres");

    expect(foldedTextAtLine(state, 2)).toBe("\n  FROM current_fees\n  ");
    expect(foldedTextAtLine(state, 5)).toBe("\n  FROM archived_fees\n");
    expect(foldedTextAtLine(state, 8)).toBe("\nFROM combined\n");
    expect(foldedTextAtLine(state, 11)).toBe("\nFROM manual_fees");
  });

  it("precomputes UNION branch boundaries with one token-position read per token", () => {
    const branchCount = 1_000;
    let positionReads = 0;
    const tokens: Array<{ readonly from: number; readonly keyword: "SELECT" | "UNION" }> = Array.from({ length: branchCount * 2 - 1 }, (_, index) => ({
      keyword: index % 2 === 0 ? "SELECT" : "UNION",
      get from() {
        positionReads++;
        return index * 10;
      },
    }));
    const scopeEnd = tokens.length * 10;

    const ranges = collectUnionBranchFoldRanges(tokens, scopeEnd);

    expect(ranges).toHaveLength(branchCount);
    expect(ranges[0]).toEqual({ from: 0, to: 10 });
    expect(ranges.at(-1)).toEqual({ from: (tokens.length - 1) * 10, to: scopeEnd });
    expect(positionReads).toBe(tokens.length);
  });

  it("does not create query folds for keywords in strings, comments, or same-line subqueries", () => {
    const sql = `SELECT '(SELECT fake)' AS text_value;
-- LEFT JOIN (SELECT fake)
SELECT * FROM (SELECT 1 AS value) one_line;`;
    const state = stateFor(sql, "postgres");

    expect(foldedTextAtLine(state, 1)).toBeNull();
    expect(foldedTextAtLine(state, 2)).toBeNull();
    expect(foldedTextAtLine(state, 3)).toBeNull();
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
