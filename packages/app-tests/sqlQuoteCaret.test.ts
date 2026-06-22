import { strict as assert } from "node:assert";
import { test } from "vitest";
import { caretPositionInsideInsertedSqlSingleQuotes, insertedSqlSingleQuoteAtCaret } from "../../apps/desktop/src/lib/sqlQuoteCaret.ts";

test("detects a newly typed SQL single quote", () => {
  assert.equal(
    insertedSqlSingleQuoteAtCaret({
      previousValue: "name = ",
      nextValue: "name = '",
      selectionStart: 8,
    }),
    true,
  );
  assert.equal(
    insertedSqlSingleQuoteAtCaret({
      previousValue: "name = '",
      nextValue: "name = ''",
      selectionStart: 9,
    }),
    true,
  );
});

test("moves the caret between SQL single quotes after typing the closing quote", () => {
  assert.equal(
    caretPositionInsideInsertedSqlSingleQuotes({
      previousValue: "name = '",
      nextValue: "name = ''",
      selectionStart: 9,
    }),
    8,
  );
});

test("moves the caret between pasted SQL single quotes", () => {
  assert.equal(
    caretPositionInsideInsertedSqlSingleQuotes({
      previousValue: "name = ",
      nextValue: "name = ''",
      selectionStart: 9,
    }),
    8,
  );
});

test("keeps the caret unchanged for ordinary quote edits", () => {
  assert.equal(
    caretPositionInsideInsertedSqlSingleQuotes({
      previousValue: "name = ",
      nextValue: "name = '",
      selectionStart: 8,
    }),
    null,
  );
  assert.equal(
    caretPositionInsideInsertedSqlSingleQuotes({
      previousValue: "name = 'a",
      nextValue: "name = 'a'",
      selectionStart: 10,
    }),
    null,
  );
});
