import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid native clipboard regions", () => {
  it("keeps table info text selection out of grid copy shortcuts", () => {
    const drawerStart = dataGridSource.indexOf('<div v-if="showTableInfo"');
    const drawerTagEnd = dataGridSource.indexOf(">", drawerStart);

    expect(drawerStart).toBeGreaterThanOrEqual(0);
    expect(dataGridSource.slice(drawerStart, drawerTagEnd)).toContain("data-native-clipboard");
  });
});
