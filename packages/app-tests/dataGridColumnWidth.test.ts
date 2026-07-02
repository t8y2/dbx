import { expect, test } from "vitest";
import { calculateDataGridColumnWidth, DATA_GRID_AUTO_FIT_VALUE_TEXT_LIMIT, DATA_GRID_COL_AUTO_FIT_MAX_WIDTH, DATA_GRID_COL_MAX_WIDTH } from "../../apps/desktop/src/lib/dataGridColumnWidth.ts";

test("default data grid column width remains compact for long values", () => {
  const width = calculateDataGridColumnWidth({
    columnName: "description",
    sampleValues: ["x".repeat(120)],
  });

  expect(width).toBe(DATA_GRID_COL_MAX_WIDTH);
});

test("auto-fit data grid column width expands long values beyond default width", () => {
  const width = calculateDataGridColumnWidth({
    columnName: "description",
    sampleValues: ["x".repeat(120)],
    maxWidth: DATA_GRID_COL_AUTO_FIT_MAX_WIDTH,
    valueTextLimit: DATA_GRID_AUTO_FIT_VALUE_TEXT_LIMIT,
  });

  expect(width).toBeGreaterThan(DATA_GRID_COL_MAX_WIDTH);
});

test("auto-fit data grid column width stays bounded for very long values", () => {
  const width = calculateDataGridColumnWidth({
    columnName: "description",
    sampleValues: ["x".repeat(1000)],
    maxWidth: DATA_GRID_COL_AUTO_FIT_MAX_WIDTH,
    valueTextLimit: DATA_GRID_AUTO_FIT_VALUE_TEXT_LIMIT,
  });

  expect(width).toBe(DATA_GRID_COL_AUTO_FIT_MAX_WIDTH);
});
