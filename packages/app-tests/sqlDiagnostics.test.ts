import { strict as assert } from "node:assert";
import test from "node:test";
import { parseSqlErrorLocation } from "../../apps/desktop/src/lib/sqlDiagnostics.ts";

test("parses generic line and column error positions", () => {
  assert.deepEqual(parseSqlErrorLocation("syntax error at line 3 column 12"), {
    line: 2,
    column: 11,
  });
});

test("parses colon separated line and column error positions", () => {
  assert.deepEqual(parseSqlErrorLocation("ERROR 1064 (42000): near 'from' at line 2, column 7"), {
    line: 1,
    column: 6,
  });
});

test("parses PostgreSQL position offsets", () => {
  assert.deepEqual(parseSqlErrorLocation('ERROR: syntax error at or near "from"\nLINE 4: select from users\n        ^'), {
    line: 3,
    column: 8,
  });
});

test("returns null when error has no editor position", () => {
  assert.equal(parseSqlErrorLocation("permission denied for table users"), null);
});
