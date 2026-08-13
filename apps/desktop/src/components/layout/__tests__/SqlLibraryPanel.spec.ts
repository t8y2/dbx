import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(new URL("../SqlLibraryPanel.vue", import.meta.url), "utf8");

describe("SqlLibraryPanel selection contrast", () => {
  it("uses the accent foreground for selected rows and their metadata", () => {
    expect(panelSource).toContain('return "bg-accent text-accent-foreground";');
    expect(panelSource).toMatch(/function fileMetaClass[\s\S]*\? "text-accent-foreground" : "text-muted-foreground";/);
    expect(panelSource).not.toContain('contextFile(fileId) ? "text-foreground/70"');
  });

  it("lets a plain click reliably exit batch selection", () => {
    expect(panelSource).toMatch(/function handleDragMouseDown[\s\S]*if \(hasSelection\.value \|\| event\.shiftKey \|\| event\.metaKey \|\| event\.ctrlKey\) return;/);
    expect(panelSource).toMatch(/function handleFileClick[\s\S]*else \{[\s\S]*clearSelection\(\);[\s\S]*lastClickedItemIndex\.value = currentIndex;[\s\S]*setActiveItem\(file\.id, "file"\);/);
    expect(panelSource).toMatch(/function handleFolderClick[\s\S]*else \{[\s\S]*clearSelection\(\);[\s\S]*lastClickedItemIndex\.value = currentIndex;[\s\S]*setActiveItem\(folder\.id, "folder"\);/);
  });

  it("clears row selection when the blank panel area is clicked", () => {
    expect(panelSource).toContain('@click.self="clearPanelSelection"');
    expect(panelSource).toMatch(/function clearPanelSelection[\s\S]*clearSelection\(\);[\s\S]*activeItemId\.value = null;[\s\S]*activeItemType\.value = null;/);
  });

  it("does not use the first row as an implicit Shift selection anchor", () => {
    expect(panelSource).toContain("const anchorIndex = rangeAnchorIndex();");
    expect(panelSource).toMatch(/if \(anchorIndex === null\)[\s\S]*lastClickedItemIndex\.value = currentIndex;[\s\S]*return;/);
    expect(panelSource).not.toContain("lastClickedItemIndex.value ?? 0");
  });
});
