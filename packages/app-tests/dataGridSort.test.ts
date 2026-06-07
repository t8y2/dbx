import { strict as assert } from "node:assert";
import test from "node:test";
import { nextDataGridSortState } from "../../apps/desktop/src/lib/dataGridSort.ts";

test("cycles data grid header sort through asc, desc, and clear", () => {
  const asc = nextDataGridSortState({ column: null, columnIndex: null, direction: "asc" }, "id", 0);
  assert.deepEqual(asc, { column: "id", columnIndex: 0, direction: "asc" });

  const desc = nextDataGridSortState(asc, "id", 0);
  assert.deepEqual(desc, { column: "id", columnIndex: 0, direction: "desc" });

  const cleared = nextDataGridSortState(desc, "id", 0);
  assert.deepEqual(cleared, { column: null, columnIndex: null, direction: "asc" });
});

test("starts a new column at ascending sort", () => {
  const next = nextDataGridSortState({ column: "id", columnIndex: 0, direction: "desc" }, "name", 1);

  assert.deepEqual(next, { column: "name", columnIndex: 1, direction: "asc" });
});
