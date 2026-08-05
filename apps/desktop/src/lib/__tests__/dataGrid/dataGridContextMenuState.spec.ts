import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../../../components/grid/DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid context menu state", () => {
  it("clears the context target whenever the result is replaced", () => {
    expect(dataGridSource).toMatch(/watch\(\s*\(\) => props\.result,[\s\S]*?clearRowSelection\(\);\s*invalidateSyntheticContextSelection\(\);[\s\S]*?exitTransaction\(\);/);
  });

  it("uses the actual copyable row count in the copy menu", () => {
    expect(dataGridSource).toContain('label: copyRowCount.value > 1 ? t("grid.copyRows", { count: copyRowCount.value }) : t("grid.copyRow")');
  });
});
