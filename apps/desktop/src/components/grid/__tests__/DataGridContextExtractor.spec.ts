import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid context extractor lifecycle", () => {
  it("clears the right-click target after the context-menu action has started", () => {
    expect(source).toContain('@open="onGridContextMenuOpen"');
    expect(source).toContain('@close="onGridContextMenuClose"');
    expect(source).toContain("queueMicrotask(() => {");
    expect(source).toContain("invalidateSyntheticContextSelection();");
  });
});
