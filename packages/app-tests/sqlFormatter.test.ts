import { strict as assert } from "node:assert";
import { test } from "vitest";
import { formatSqlText, MAX_SQL_FORMAT_CHARS } from "../../apps/desktop/src/lib/sqlFormatter.ts";

test("formats SQL with uppercase keywords and readable line breaks by default", async () => {
  const formatted = await formatSqlText("select id, name from users where active = 1 order by name", "postgres");

  assert.match(formatted, /^SELECT\b/);
  assert.match(formatted, /\nFROM\b/);
  assert.match(formatted, /\nWHERE\b/);
  assert.match(formatted, /\nORDER BY\b/);
});

test("formats SQL with custom keyword case and indentation settings", async () => {
  const formatted = await formatSqlText("select id from users where active = 1", "postgres", {
    keywordCase: "lower",
    dataTypeCase: "preserve",
    functionCase: "preserve",
    useTabs: true,
    tabWidth: 2,
    logicalOperatorNewline: "before",
    expressionWidth: 50,
    linesBetweenQueries: 1,
    denseOperators: false,
    newlineBeforeSemicolon: false,
  });

  assert.match(formatted, /^select\b/);
  assert.match(formatted, /\nfrom\b/);
  assert.doesNotMatch(formatted, /^SELECT\b/);
});

test("leaves blank SQL unchanged", async () => {
  assert.equal(await formatSqlText("  \n\t", "mysql"), "  \n\t");
});

test("rejects very large SQL before loading formatter work", async () => {
  await assert.rejects(
    () => formatSqlText("x".repeat(MAX_SQL_FORMAT_CHARS + 1), "generic"),
    /too large/i,
  );
});
