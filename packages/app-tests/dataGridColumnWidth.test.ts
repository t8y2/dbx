import { strict as assert } from "node:assert";
import test from "node:test";
import { calculateDataGridColumnWidth, DATA_GRID_HEADER_CONTROL_WIDTH } from "../../apps/desktop/src/lib/dataGridColumnWidth.ts";

test("reserves header control space when auto-sizing a column from the header", () => {
  const width = calculateDataGridColumnWidth({
    columnName: "created_at",
    sampleValues: [],
  });

  assert.equal(width, "created_at".length * 8 + DATA_GRID_HEADER_CONTROL_WIDTH);
});

test("keeps cell content as the sizing driver when it is wider than header controls", () => {
  const width = calculateDataGridColumnWidth({
    columnName: "id",
    sampleValues: ["a long enough value to dominate"],
  });

  assert.equal(width, "a long enough value to dominate".length * 8 + 28);
});
