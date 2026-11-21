import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildInsertValueHintDecorations, insertValueHintsRefreshDispatchSpec, isInsertValueHintDecorationAt } from "@/lib/editor/codemirrorInsertValueHints";
import { parseInsertValueHints } from "@/lib/sql/insertValueHints";

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

test("a projection that already aliases its target column renders no hint widget", () => {
  const sql = ["INSERT INTO t (operation_apply_id, pacu_status)", "SELECT", "    noprid.ruid   as operation_apply_id,", "    noprid.flag", "FROM noprid"].join("\n");
  const decorations = buildInsertValueHintDecorations(parseInsertValueHints(sql));
  assert.equal(isInsertValueHintDecorationAt(decorations, sql.indexOf("noprid.ruid")), false);
  assert.equal(isInsertValueHintDecorationAt(decorations, sql.indexOf("noprid.flag")), true);
});
