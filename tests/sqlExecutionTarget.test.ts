import { strict as assert } from "node:assert";
import test from "node:test";
import { resolveExecutableSql } from "../src/lib/sqlExecutionTarget.js";

test("uses selected SQL when the editor has a non-empty selection", () => {
  const sql = "SELECT * FROM users;\nSELECT * FROM orders;";

  const result = resolveExecutableSql(sql, "SELECT * FROM orders;");

  assert.equal(result, "SELECT * FROM orders;");
});

test("falls back to full SQL when the selection is only whitespace", () => {
  const sql = "SELECT * FROM users;";

  const result = resolveExecutableSql(sql, "   \n\t");

  assert.equal(result, sql);
});
