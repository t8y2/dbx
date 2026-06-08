import { strict as assert } from "node:assert";
import { afterEach, test, vi } from "vitest";
import { formatSqlText, MAX_SQL_FORMAT_CHARS } from "../../apps/desktop/src/lib/sqlFormatter.ts";

afterEach(() => {
  vi.doUnmock("sql-formatter");
});

test("rejects very large SQL before importing formatter", async () => {
  vi.resetModules();
  vi.doMock("sql-formatter", () => {
    throw new Error("formatter should not load");
  });

  const {
    formatSqlText: isolatedFormatSqlText,
    MAX_SQL_FORMAT_CHARS: isolatedMaxSqlFormatChars,
  } = await import("../../apps/desktop/src/lib/sqlFormatter.ts");

  await assert.rejects(
    () => isolatedFormatSqlText("x".repeat(isolatedMaxSqlFormatChars + 1), "generic"),
    /too large/i,
  );
});

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
