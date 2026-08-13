import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(new URL("../SqlFilePanel.vue", import.meta.url), "utf8");

describe("SqlFilePanel selection", () => {
  it("uses the shared ordered-list selection behavior", () => {
    expect(panelSource).toContain("orderedListSelectionIntent(event)");
    expect(panelSource).toContain("orderedListRangeAnchorIndex(visibleItems.value");
    expect(panelSource).not.toContain("anchorIndex ?? 0");
  });

  it("does not open or expand rows during modifier selection", () => {
    expect(panelSource).toMatch(/if \(selectionIntent === "range"\)[\s\S]*selectRangeTo\(currentIndex\);[\s\S]*return;/);
    expect(panelSource).toMatch(/if \(selectionIntent === "toggle"\)[\s\S]*selectionAnchorIndex\.value = currentIndex;[\s\S]*return;/);
    expect(panelSource).toMatch(/selectionAnchorIndex\.value = currentIndex;[\s\S]*activate\(\);/);
  });

  it("clears selection when a non-row area is clicked", () => {
    expect(panelSource).toContain('@click="handlePanelClick"');
    expect(panelSource).toContain("[data-sql-file-row='true']");
    expect(panelSource).toContain('data-sql-file-row="true"');
  });
});
