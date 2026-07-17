import { strict as assert } from "node:assert";
import { test } from "vitest";
import { sortDataGridRowIndexes, sortDataGridRows } from "../../apps/desktop/src/lib/dataGrid/dataGridSort.ts";

test("sortDataGridRows sorts numbers numerically and keeps null values last", () => {
  const rows = [
    [10, "ten"],
    [2, "two"],
    [null, "none"],
    [1, "one"],
  ];

  assert.deepEqual(sortDataGridRows(rows, 0, "asc"), [
    [1, "one"],
    [2, "two"],
    [10, "ten"],
    [null, "none"],
  ]);
  assert.deepEqual(sortDataGridRows(rows, 0, "desc"), [
    [10, "ten"],
    [2, "two"],
    [1, "one"],
    [null, "none"],
  ]);
});

test("sortDataGridRows uses natural string order and keeps equal values stable", () => {
  const rows = [
    ["item-10", "first"],
    ["item-2", "second"],
    ["item-2", "third"],
  ];

  assert.deepEqual(sortDataGridRows(rows, 0, "asc"), [
    ["item-2", "second"],
    ["item-2", "third"],
    ["item-10", "first"],
  ]);
});

test("sortDataGridRows sorts ISO date strings by time", () => {
  const rows = [["2026-02-01"], ["2025-12-31"], ["2026-01-01"]];

  assert.deepEqual(sortDataGridRows(rows, 0, "asc"), [["2025-12-31"], ["2026-01-01"], ["2026-02-01"]]);
});

test("sortDataGridRowIndexes preserves stable source ordering", () => {
  const rows = [["item-10"], ["item-2"], ["item-2"]];

  assert.deepEqual(sortDataGridRowIndexes(rows, 0, "asc"), [1, 2, 0]);
  assert.deepEqual(sortDataGridRowIndexes(rows, 0, "desc"), [0, 1, 2]);
});
