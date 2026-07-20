import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildDataGridColumnLookupItems, filterDataGridColumnLookupItems } from "../../apps/desktop/src/lib/dataGrid/dataGridColumnLookup.ts";
import { allNullColumnIndexes, filterColumnVisibilityOptions, hiddenColumnIndexesWithAllNullColumns, invertedHiddenColumnIndexes, nextHiddenColumnIndexes, removeAutoHiddenColumnIndexes, visibleColumnIndexesForFilter } from "../../apps/desktop/src/lib/dataGrid/dataGridColumnVisibility.ts";

test("filters column visibility options by trimmed case-insensitive text", () => {
  const options = filterColumnVisibilityOptions(["id", "created_at", "CustomerName"], "  NAME ");

  assert.deepEqual(options, [{ column: "CustomerName", index: 2 }]);
});

test("filters column visibility options by column comments", () => {
  const options = filterColumnVisibilityOptions(["id", "created_at", "customer_name"], "created time", {
    commentByColumn: new Map([["created_at", "Created time"]]),
  });

  assert.deepEqual(options, [{ column: "created_at", comment: "Created time", index: 1 }]);
});

test("builds go-to column lookup items with source column comments first", () => {
  const items = buildDataGridColumnLookupItems({
    columns: ["display_name"],
    sourceColumns: ["name"],
    commentByColumn: new Map([
      ["display_name", "Alias label"],
      ["name", "Customer name"],
    ]),
  });

  assert.deepEqual(items, [{ index: 0, name: "display_name", sourceName: "name", comment: "Customer name" }]);
});

test("filters go-to column lookup items by source column and comment", () => {
  const items = buildDataGridColumnLookupItems({
    columns: ["label", "created_at"],
    sourceColumns: ["user_name", undefined],
    commentByColumn: new Map([["user_name", "Customer name"]]),
  });

  assert.deepEqual(filterDataGridColumnLookupItems(items, "user_name").map((item) => item.index), [0]);
  assert.deepEqual(filterDataGridColumnLookupItems(items, "customer").map((item) => item.index), [0]);
});

test("keeps go-to column lookup usable without metadata", () => {
  const items = buildDataGridColumnLookupItems({ columns: ["id", "display_name"] });

  assert.deepEqual(filterDataGridColumnLookupItems(items, "display"), [{ index: 1, name: "display_name" }]);
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

test("all-null scan handles sparse, ragged and non-candidate columns", () => {
  // 前缀多 null 但尾行非 null 的列必须被剔除；availableIndexes 之外的列不参与
  const rows = [
    [null, 1, null, null],
    [null, null, null, null],
    [null, null, 2, null],
  ];
  assert.deepEqual(allNullColumnIndexes(rows, [0, 1, 2]), [0]);
  // 不等宽行：短行缺失的单元格为 undefined ≠ null，剔除该列（与原实现一致）
  assert.deepEqual(allNullColumnIndexes([[null, null], [null]], [0, 1]), [0]);
  // 全部候选都非 null：提前收敛返回空
  assert.deepEqual(allNullColumnIndexes([[1, 2]], [0, 1]), []);
  // 乱序候选：返回顺序保持 availableIndexes 原序
  assert.deepEqual(allNullColumnIndexes([[null, 1, null]], [2, 0]), [2, 0]);
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
