import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid native clipboard regions", () => {
  it("keeps table info text selection out of grid copy shortcuts", () => {
    expect(dataGridSource).toMatch(/<div\b(?=[^>]*\bv-if="showTableInfo")(?=[^>]*\bdata-native-clipboard)[^>]*>/);
  });

  it("keeps transposed field-name text selection out of grid copy shortcuts", () => {
    expect(dataGridSource).toMatch(/<div\b(?=[^>]*\bdata-native-clipboard)(?=[^>]*class="sticky left-0)[^>]*>/);
  });

  it("opens read-only text selection from DOM, canvas, and transposed cells", () => {
    expect(dataGridSource.match(/startReadonlyCellTextSelection\(/g)).toHaveLength(4);
    expect(dataGridSource).not.toContain("showReadonlyCellDetailsOnDblClick");
    expect(dataGridSource).toContain("if (!canEditCellItem(item, actualColIdx)) {");
    expect(dataGridSource.match(/<DataGridReadonlyTextSelection/g)).toHaveLength(3);
  });

  it("uses a text cursor for read-only cells across grid render modes", () => {
    expect(dataGridSource).toContain('hitItem && actualColIdx !== undefined ? "text" : "cell"');
    expect(dataGridSource).toContain("'cursor-text': !isScrolling && !canEditCellItem(item, col.actualColIdx)");
    expect(dataGridSource).toContain("'cursor-text': !isScrolling,");
  });
});
