import { strict as assert } from "node:assert";
import { test } from "vitest";
import { parseSqlErrorLocation, sqlErrorDecorationRange, sqlErrorMessagePosition, sqlErrorSqlMatchesEditor } from "../../apps/desktop/src/lib/sql/sqlDiagnostics.ts";

test("locates the Oracle invalid identifier reported by the Agent", () => {
  const sql = "select x.* from si_price_adjust_task t;";
  const message = 'ORA-00904: "X": invalid identifier error occur at position: 9';

  assert.deepEqual(sqlErrorDecorationRange(sql, message), { from: 7, to: 8 });
  assert.equal(sql.slice(7, 8), "x");
});

test("locates a multi-character qualified Oracle identifier instead of a later selector character", () => {
  const sql = "SELECT bad.* FROM dual t";
  const message = 'ORA-00904: "BAD": invalid identifier error occur at position: 11';

  assert.deepEqual(sqlErrorDecorationRange(sql, message), { from: 7, to: 10 });
});

test("preserves Oracle quoted identifier casing", () => {
  const sql = 'SELECT "X".*, "x".* FROM dual t';
  const message = 'ORA-00904: "x": invalid identifier error occur at position: 18';

  assert.deepEqual(sqlErrorDecorationRange(sql, message), { from: 15, to: 16 });
});

test("uses Oracle Agent absolute positions across lines", () => {
  const sql = "SELECT 1,\n       missing_col\nFROM dual";
  const message = 'ORA-00904: "MISSING_COL": invalid identifier error occur at position: 17';

  assert.deepEqual(sqlErrorDecorationRange(sql, message), { from: 17, to: 28 });
});

test("accepts zero as an Oracle Agent absolute position", () => {
  const sql = "SELEC 1 FROM dual";

  assert.deepEqual(sqlErrorDecorationRange(sql, "ORA-00900: invalid SQL statement error occur at position: 0"), { from: 0, to: 1 });
});

test("rejects malformed or out-of-range Oracle Agent positions", () => {
  assert.equal(sqlErrorDecorationRange("SELECT 1", "error occur at position: nope"), null);
  assert.equal(sqlErrorDecorationRange("SELECT 1", "error occur at position: 99"), null);
});

test("keeps existing line-column and PostgreSQL caret parsing", () => {
  assert.deepEqual(parseSqlErrorLocation("syntax error at line 2, column 4"), { line: 1, column: 3 });
  assert.deepEqual(parseSqlErrorLocation("ERROR 1064: syntax error near 'LIMIT 100' at line 3"), { line: 2, column: 0 });
  assert.deepEqual(parseSqlErrorLocation('ERROR: column "bad" does not exist\nLINE 3: SELECT bad\n               ^'), { line: 2, column: 15 });
  assert.deepEqual(sqlErrorDecorationRange("SELECT 1\nFROM bad", "syntax error at line 2, column 2"), { from: 10, to: 11 });
});

test("parses the Oracle Agent offset without needing the SQL it refers to", () => {
  assert.deepEqual(sqlErrorMessagePosition('ORA-00904: "NOPE_COL": invalid identifier error occur at position: 2270'), { kind: "offset", offset: 2270 });
  assert.deepEqual(sqlErrorMessagePosition("error occurred at position: 0"), { kind: "offset", offset: 0 });
});

test("prefers a textual location over the Oracle Agent offset", () => {
  assert.deepEqual(sqlErrorMessagePosition("syntax error at line 2, column 4 error occur at position: 9"), { kind: "location", location: { line: 1, column: 3 } });
  assert.deepEqual(sqlErrorMessagePosition('ERROR: column "bad" does not exist\nLINE 3: SELECT bad\n               ^'), { kind: "location", location: { line: 2, column: 15 } });
});

test("returns null when the message carries no usable position", () => {
  assert.equal(sqlErrorMessagePosition("ERROR 1054 (42S22): Unknown column 'nope_col' in 'field list'"), null);
  assert.equal(sqlErrorMessagePosition("error occur at position: nope"), null);
  assert.equal(sqlErrorMessagePosition('ORA-00904: "X": invalid identifier'), null);
});

test("matches DBX pagination rewrites without accepting unrelated stale SQL", () => {
  const editorSql = "SELECT *\nFROM projects\nWHERE ;";
  const executedSql = "SELECT *\nFROM projects\nWHERE LIMIT 100;";

  assert.equal(sqlErrorSqlMatchesEditor(editorSql, executedSql), true);
  assert.equal(sqlErrorSqlMatchesEditor(editorSql, "SELECT *\nFROM other_table\nWHERE LIMIT 100;"), false);
});

test("matches the user's own LIMIT when the SQL differs only by a semicolon", () => {
  const editorSql = "SELECT *\nFROM projects\nLIMIT 10";
  const executedSql = "SELECT *\nFROM projects\nLIMIT 10;";

  assert.equal(sqlErrorSqlMatchesEditor(editorSql, executedSql), true);
});

test("strips the generated OFFSET ROWS FETCH FIRST suffix fully", () => {
  const editorSql = "SELECT *\nFROM projects";
  const executedSql = "SELECT *\nFROM projects OFFSET 10 ROWS FETCH FIRST 5 ROWS ONLY;";

  assert.equal(sqlErrorSqlMatchesEditor(editorSql, executedSql), true);
});
