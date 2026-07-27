import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid native clipboard regions", () => {
  it("keeps table info text selection out of grid copy shortcuts", () => {
    expect(dataGridSource).toMatch(/<div\b(?=[^>]*\bv-if="showTableInfo")(?=[^>]*\bdata-native-clipboard)[^>]*>/);
  });
});
