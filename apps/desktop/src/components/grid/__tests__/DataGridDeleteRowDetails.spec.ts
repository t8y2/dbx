import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid delete row confirmation details", () => {
  it("still wires deleteRowDetails into the delete-row DangerConfirmDialog", () => {
    const dialogStart = dataGridSource.indexOf('v-model:open="showDeleteRowConfirm"');
    const dialogEnd = dataGridSource.indexOf('@confirm="confirmDeleteRow"', dialogStart);

    expect(dialogStart).toBeGreaterThanOrEqual(0);
    expect(dialogEnd).toBeGreaterThan(dialogStart);

    const dialogSource = dataGridSource.slice(dialogStart, dialogEnd);
    expect(dialogSource).toContain(':details="deleteRowDetails"');
  });

  it("uses the unbounded confirmation formatter for delete details", () => {
    const detailsStart = dataGridSource.indexOf("const deleteRowDetails = computed");
    const detailsEnd = dataGridSource.indexOf("const hasVisibleRows", detailsStart);

    expect(detailsStart).toBeGreaterThanOrEqual(0);
    expect(detailsEnd).toBeGreaterThan(detailsStart);
    expect(dataGridSource.slice(detailsStart, detailsEnd)).toContain("formatGridItemCellForConfirmation");
    expect(dataGridSource).toContain("formatCell(item.data[columnIndex], columnIndex, largeValueOriginalBytes(item, columnIndex), false)");
  });

  it("keeps close-on-confirm disabled so confirmDeleteRow runs before the dialog auto-closes", () => {
    const dialogStart = dataGridSource.indexOf('v-model:open="showDeleteRowConfirm"');
    const dialogEnd = dataGridSource.indexOf('@confirm="confirmDeleteRow"', dialogStart);

    expect(dialogStart).toBeGreaterThanOrEqual(0);
    expect(dialogEnd).toBeGreaterThan(dialogStart);

    const dialogSource = dataGridSource.slice(dialogStart, dialogEnd);
    expect(dialogSource).toContain(':close-on-confirm="false"');
  });
});
