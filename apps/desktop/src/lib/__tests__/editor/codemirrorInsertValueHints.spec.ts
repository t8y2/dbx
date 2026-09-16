import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildInsertValueHintDecorations, insertValueHintsRefreshDispatchSpec, isInsertValueHintDecorationAt } from "@/lib/editor/codemirrorInsertValueHints";

test("insertValueHintsRefreshDispatchSpec disables scrollIntoView", () => {
  assert.equal(insertValueHintsRefreshDispatchSpec.scrollIntoView, false);
});

test("isInsertValueHintDecorationAt detects widget anchors", () => {
  const sql = "INSERT INTO t (a, b) VALUES (1, 2)";
  const valueOne = sql.indexOf("1");
  const valueTwo = sql.indexOf("2");
  const decorations = buildInsertValueHintDecorations([
    { from: valueOne, column: "a" },
    { from: valueTwo, column: "b" },
  ]);
  assert.equal(isInsertValueHintDecorationAt(decorations, valueOne), true);
  assert.equal(isInsertValueHintDecorationAt(decorations, valueTwo), true);
  assert.equal(isInsertValueHintDecorationAt(decorations, sql.indexOf("INSERT")), false);
});
