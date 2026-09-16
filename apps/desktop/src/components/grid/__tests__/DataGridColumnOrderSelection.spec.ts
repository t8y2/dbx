import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid synchronized column order selection", () => {
  it("reconciles the active selection when another grid changes the table order", () => {
    expect(dataGridSource).toContain("applyColumnOrderChange(() => onTableDataGridColumnOrderChanged(event));");
    expect(dataGridSource).toContain("window.addEventListener(TABLE_DATA_GRID_COLUMN_ORDER_CHANGED_EVENT, onSynchronizedTableDataGridColumnOrderChanged);");
    expect(dataGridSource).toContain("window.removeEventListener(TABLE_DATA_GRID_COLUMN_ORDER_CHANGED_EVENT, onSynchronizedTableDataGridColumnOrderChanged);");
  });
});
