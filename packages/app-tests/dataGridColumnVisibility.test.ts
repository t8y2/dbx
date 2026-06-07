import { strict as assert } from "node:assert";
import test from "node:test";
import {
  allNullColumnIndexes,
  filterColumnVisibilityOptions,
  hiddenColumnIndexesWithAllNullColumns,
  invertedHiddenColumnIndexes,
  nextHiddenColumnIndexes,
  removeAutoHiddenColumnIndexes,
  visibleColumnIndexesForFilter,
} from "../../apps/desktop/src/lib/dataGridColumnVisibility.ts";

test("filters column visibility options by trimmed case-insensitive text", () => {
  const options = filterColumnVisibilityOptions(["id", "created_at", "CustomerName"], "  NAME ");

  assert.deepEqual(options, [{ column: "CustomerName", index: 2 }]);
});

test("removes hidden indexes from visible columns", () => {
  const indexes = visibleColumnIndexesForFilter([0, 1, 2, 3], new Set([1, 3]));

  assert.deepEqual(indexes, [0, 2]);
});

test("keeps the last visible column when toggling visibility", () => {
  const hidden = nextHiddenColumnIndexes({
    columnIndex: 0,
    hiddenIndexes: new Set([1, 2]),
    totalColumns: 3,
  });

  assert.deepEqual([...hidden].sort(), [1, 2]);
});

test("shows a hidden column again when toggled", () => {
  const hidden = nextHiddenColumnIndexes({
    columnIndex: 1,
    hiddenIndexes: new Set([1, 2]),
    totalColumns: 4,
  });

  assert.deepEqual([...hidden].sort(), [2]);
});

test("inverts hidden column indexes", () => {
  const hidden = invertedHiddenColumnIndexes([0, 1, 2, 3], new Set([1, 3]));

  assert.deepEqual([...hidden].sort(), [0, 2]);
});

test("keeps one column visible when inverting all visible columns", () => {
  const hidden = invertedHiddenColumnIndexes([0, 1, 2], new Set());

  assert.deepEqual([...hidden].sort(), [1, 2]);
});

test("finds columns where every row is NULL", () => {
  const indexes = allNullColumnIndexes(
    [
      [1, null, null, "x"],
      [2, null, null, null],
    ],
    [0, 1, 2, 3],
  );

  assert.deepEqual(indexes, [1, 2]);
});

test("does not treat empty results as all-null columns", () => {
  assert.deepEqual(allNullColumnIndexes([], [0, 1, 2]), []);
});

test("hides all-null columns without restoring manually hidden columns", () => {
  const result = hiddenColumnIndexesWithAllNullColumns({
    availableIndexes: [0, 1, 2, 3],
    hiddenIndexes: new Set([3]),
    allNullIndexes: new Set([1, 2, 3]),
  });

  assert.deepEqual([...result.hiddenIndexes].sort(), [1, 2, 3]);
  assert.deepEqual([...result.autoHiddenIndexes].sort(), [1, 2]);
  assert.deepEqual([...removeAutoHiddenColumnIndexes(result.hiddenIndexes, result.autoHiddenIndexes)].sort(), [3]);
});

test("keeps one all-null column visible when every column is NULL", () => {
  const result = hiddenColumnIndexesWithAllNullColumns({
    availableIndexes: [0, 1, 2],
    hiddenIndexes: new Set(),
    allNullIndexes: new Set([0, 1, 2]),
  });

  assert.deepEqual([...result.hiddenIndexes].sort(), [1, 2]);
  assert.deepEqual([...result.autoHiddenIndexes].sort(), [1, 2]);
});
