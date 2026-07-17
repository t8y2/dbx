import { strict as assert } from "node:assert";
import { test } from "vitest";
import * as langSql from "@codemirror/lang-sql";
import { sqlSemanticTableNameSpansForSyntaxTree } from "../../apps/desktop/src/lib/editor/codemirrorSqlSemanticHighlight.ts";
import { expandToSqlStatementWindow } from "../../apps/desktop/src/lib/sql/insertValueHints.ts";

test.each([
  ["string", `'${"x".repeat(40 * 1024)} FROM fake'`],
  ["block comment", `/* ${"x".repeat(40 * 1024)} FROM fake */`],
])("preserves %s context when the highlight window starts inside it", (_name, suppressedSql) => {
  const sql = `SELECT ${suppressedSql} AS payload;\nSELECT * FROM real_table;`;
  const realTable = sql.indexOf("real_table");
  const window = expandToSqlStatementWindow(sql, realTable, realTable + "real_table".length);
  const tree = langSql.StandardSQL.language.parser.parse(sql);

  assert.ok(window.from > sql.indexOf(suppressedSql));
  assert.deepEqual(
    sqlSemanticTableNameSpansForSyntaxTree(sql, window, tree).map((span) => sql.slice(span.start, span.end)),
    ["real_table"],
  );
});
