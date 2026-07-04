import { strict as assert } from "node:assert";
import { test } from "vitest";
import { columnOrderKeysForIndexes, isDefaultColumnOrder, moveVisibleColumnIndex, orderedColumnIndexes, uniqueDataGridColumnOrderKeys } from "../../apps/desktop/src/lib/dataGrid/dataGridColumnOrder";

test("creates stable keys for duplicate column names", () => {
    assert.deepEqual(uniqueDataGridColumnOrderKeys(["id", "name", "name"]), [`id\u00000`, `name\u00000`, `name\u00001`]);
});

test("uses source columns when available", () => {
    assert.deepEqual(uniqueDataGridColumnOrderKeys(["id", "display_name"], ["id", "name"]), [`id\u00000`, `name\u00000`]);
});

test("orders available indexes from persisted keys and appends new columns", () => {
    const keys = uniqueDataGridColumnOrderKeys(["id", "name", "email", "created_at"]);
    assert.deepEqual(
        orderedColumnIndexes({
            availableIndexes: [0, 1, 2, 3],
            columnKeys: keys,
            orderedKeys: [keys[2], keys[0], "missing"],
        }),
        [2, 0, 1, 3],
    );
});

test("ignores unavailable indexes while preserving displayable columns", () => {
    const keys = uniqueDataGridColumnOrderKeys(["id", "name", "email"]);
    assert.deepEqual(
        orderedColumnIndexes({
            availableIndexes: [1, 2],
            columnKeys: keys,
            orderedKeys: [keys[0], keys[2], keys[1]],
        }),
        [2, 1],
    );
});

test("moves a visible column forward", () => {
    assert.deepEqual(
        moveVisibleColumnIndex({
            orderedIndexes: [0, 1, 2, 3],
            hiddenIndexes: new Set(),
            fromVisibleIndex: 3,
            toVisibleIndex: 1,
        }),
        [0, 3, 1, 2],
    );
});

test("moves a visible column backward", () => {
    assert.deepEqual(
        moveVisibleColumnIndex({
            orderedIndexes: [0, 1, 2, 3],
            hiddenIndexes: new Set(),
            fromVisibleIndex: 1,
            toVisibleIndex: 3,
        }),
        [0, 2, 3, 1],
    );
});

test("moves a visible column to an adjacent later position", () => {
    assert.deepEqual(
        moveVisibleColumnIndex({
            orderedIndexes: [0, 1, 2, 3],
            hiddenIndexes: new Set(),
            fromVisibleIndex: 1,
            toVisibleIndex: 2,
        }),
        [0, 2, 1, 3],
    );
});

test("moves visible columns without disturbing hidden column identity", () => {
    assert.deepEqual(
        moveVisibleColumnIndex({
            orderedIndexes: [0, 1, 2, 3],
            hiddenIndexes: new Set([1]),
            fromVisibleIndex: 2,
            toVisibleIndex: 0,
        }),
        [3, 0, 1, 2],
    );
});

test("returns no-op for invalid or same visible indexes", () => {
    const orderedIndexes = [0, 1, 2];
    assert.deepEqual(moveVisibleColumnIndex({ orderedIndexes, hiddenIndexes: new Set(), fromVisibleIndex: 1, toVisibleIndex: 1 }), orderedIndexes);
    assert.deepEqual(moveVisibleColumnIndex({ orderedIndexes, hiddenIndexes: new Set(), fromVisibleIndex: -1, toVisibleIndex: 1 }), orderedIndexes);
});

test("converts indexes back to persisted keys", () => {
    const keys = uniqueDataGridColumnOrderKeys(["id", "name", "email"]);
    assert.deepEqual(columnOrderKeysForIndexes([2, 0, 1], keys), [keys[2], keys[0], keys[1]]);
});

test("detects default order", () => {
    assert.equal(isDefaultColumnOrder([0, 1, 2], [0, 1, 2]), true);
    assert.equal(isDefaultColumnOrder([0, 1, 2], [1, 0, 2]), false);
});
