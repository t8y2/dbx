import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid cell detail selection", () => {
  it("resynchronizes the open detail after a mouse selection gesture finishes", () => {
    expect(dataGridSource).toContain("watch([selectedRange, showCellDetail, isEditingDetail, isSelectingCells]");
    expect(dataGridSource).toContain("if (isSelectingCells.value) return;");
  });
});
