import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid cell detail selection", () => {
  it("resynchronizes the open detail after a mouse selection gesture finishes", () => {
    expect(dataGridSource).toContain("watch([selectedRange, showCellDetail, isEditingDetail, isSelectingCells]");
    expect(dataGridSource).toContain("if (isSelectingCells.value) return;");
    expect(dataGridSource).toMatch(/detailCell\.value = target;\s+hydrateCellDetailTarget\(target\);/);
  });

  it("hydrates bounded large-value previews for every cell detail target", () => {
    expect(dataGridSource).toMatch(/function hydrateCellDetailTarget[\s\S]*?isLargeValuePreview[\s\S]*?hydrateLargeValueCell/);
    expect(dataGridSource).toMatch(/showCellDetails[\s\S]*?hydrateCellDetailTarget\(detailCell\.value\)/);
    expect(dataGridSource).toMatch(/openCellDetailDialog[\s\S]*?hydrateCellDetailTarget\(cellDetailDialogTarget\.value\)/);
  });
});
