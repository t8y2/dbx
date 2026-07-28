import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid DDL search navigation", () => {
  it("resets navigation when the raw search query changes", () => {
    expect(dataGridSource).toMatch(/watch\(\s*\[filteredDdlContent, searchQuery\],/);
  });
});
