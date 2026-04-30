import { strict as assert } from "node:assert";
import test from "node:test";
import { formatSqlText } from "../src/lib/sqlFormatter.ts";

test("formats SQL with uppercase keywords and readable line breaks", async () => {
  const formatted = await formatSqlText("select id, name from users where active = 1 order by name", "postgres");

  assert.match(formatted, /^SELECT\b/);
  assert.match(formatted, /\nFROM\b/);
  assert.match(formatted, /\nWHERE\b/);
  assert.match(formatted, /\nORDER BY\b/);
});

test("leaves blank SQL unchanged", async () => {
  assert.equal(await formatSqlText("  \n\t", "mysql"), "  \n\t");
});
