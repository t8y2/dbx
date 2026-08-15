import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid setup initialization order", () => {
  it("initializes where-search capability before the immediate filter preview watcher", () => {
    const canUseWhereSearchDeclaration = dataGridSource.indexOf("const canUseWhereSearch = computed");
    const filterPreviewDeclaration = dataGridSource.indexOf("const filterPreviewVisible = computed");
    const filterPreviewWatcher = dataGridSource.indexOf("[filterPreviewVisible, structuredFilterRules]");

    expect(canUseWhereSearchDeclaration).toBeGreaterThanOrEqual(0);
    expect(filterPreviewDeclaration).toBeGreaterThan(canUseWhereSearchDeclaration);
    expect(filterPreviewWatcher).toBeGreaterThan(filterPreviewDeclaration);
  });
});
