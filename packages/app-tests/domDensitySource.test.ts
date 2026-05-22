import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dataGridSource = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");

test("data grid mounts the cell detail action only for the active cell", () => {
  assert.match(dataGridSource, /cellDetailButtonVisible/);
  assert.match(dataGridSource, /v-if="cellDetailButtonVisible\(index, actualColIdx\)"/);
  assert.match(dataGridSource, /@mouseenter="onCellMouseenter\(index, visibleColIdx, actualColIdx\)"/);
  assert.doesNotMatch(dataGridSource, /group-hover\/cell:flex/);
});
