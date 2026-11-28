// @vitest-environment happy-dom

import * as langSql from "@codemirror/lang-sql";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { sqlBeginEndMatching } from "@/lib/editor/codemirrorSqlBlockFolding";

/** Rendered text of the `BEGIN`/`END` keywords the match highlighter marks with the caret on `cursor`. */
function highlightedKeywords(sql: string, cursor: number, dialectName: "mysql" | "sqlserver" = "sqlserver"): string[] {
  const state = EditorState.create({
    doc: sql,
    selection: { anchor: cursor },
    extensions: [langSql.sql({ dialect: createDbxCodeMirrorSqlDialect(langSql, dialectName) }), sqlBeginEndMatching],
  });
  ensureSyntaxTree(state, sql.length, 5_000);
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state, parent });
  const keywords = [...view.dom.querySelectorAll(".cm-matchingBracket")].map((element) => element.textContent ?? "");
  view.destroy();
  parent.remove();
  return keywords;
}

/** Offset of the caret when it sits inside the `nth` (1-based) `needle` of `sql`. */
function caretIn(sql: string, needle: string, nth = 1): number {
  let from = 0;
  let index = -1;
  for (let i = 0; i < nth; i++) {
    index = sql.indexOf(needle, from);
    from = index + needle.length;
  }
  return index + 1;
}

describe("sqlBeginEndMatching", () => {
  it("highlights both keywords of the block the caret sits on, with another block following (dbx#15561)", () => {
    // Before the fix the first block's END was swallowed as MySQL's `END IF` because the next
    // statement's `IF` sat on the following line, so this pair never existed and neither keyword
    // was highlighted -- exactly the "some begin...end blocks do not highlight" report.
    const sql = `IF @a = 1
BEGIN
  SELECT 1
END

IF @b = 2
BEGIN
  SELECT 2
END`;

    expect(highlightedKeywords(sql, caretIn(sql, "BEGIN", 1))).toEqual(["BEGIN", "END"]);
    expect(highlightedKeywords(sql, caretIn(sql, "BEGIN", 2))).toEqual(["BEGIN", "END"]);
  });

  it("highlights the nested block a caret inside the inner BEGIN belongs to", () => {
    const sql = `IF EXISTS (SELECT 1)
BEGIN
  IF @a = 1
  BEGIN
    SELECT 1
  END
END
IF @b = 2
BEGIN
  SELECT 2
END`;

    expect(highlightedKeywords(sql, caretIn(sql, "BEGIN", 2))).toEqual(["BEGIN", "END"]);
  });

  it("does not highlight anything when the caret is not on a BEGIN/END keyword", () => {
    const sql = "BEGIN\n  SELECT 1\nEND";

    expect(highlightedKeywords(sql, caretIn(sql, "SELECT"))).toEqual([]);
  });
});
