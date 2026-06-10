import assert from "node:assert/strict";
import { test } from "vitest";
import { formatCell, mdTable } from "../src/format.js";

test("formats markdown tables", () => {
  assert.equal(mdTable(["Name", "Type"], [["local", "postgres"]]), "| Name  | Type     |\n| ----- | -------- |\n| local | postgres |");
});

test("formats database cell values", () => {
  assert.equal(formatCell(null), "NULL");
  assert.equal(formatCell(undefined), "NULL");
  assert.equal(formatCell({ ok: true }), '{"ok":true}');
  assert.equal(formatCell("hello"), "hello");
});
