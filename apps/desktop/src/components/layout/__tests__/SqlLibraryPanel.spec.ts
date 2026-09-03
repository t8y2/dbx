import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(new URL("../SqlLibraryPanel.vue", import.meta.url), "utf8");

describe("SqlLibraryPanel selection contrast", () => {
  it("explains how SQL Library content differs from local SQL files", () => {
    expect(panelSource).toContain('import HelpTooltip from "@/components/ui/tooltip/HelpTooltip.vue";');
    expect(panelSource).toMatch(/<HelpTooltip :label="t\('sqlLibrary\.storageHelp'\)" side="bottom"[\s\S]*?\{\{ t\("sqlLibrary\.storageHelp"\) \}\}[\s\S]*?<\/HelpTooltip>/);
    expect(panelSource).toContain('content-class="max-w-[320px] whitespace-pre-line"');
  });

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

  it("shows a single collapse-all button and seeds a default-collapsed library", () => {
    expect(panelSource).toContain("ChevronsDownUp,");
    expect(panelSource).toContain("t('sqlLibrary.collapseAll')");
    expect(panelSource).toMatch(/function collapseAllFolders\(\)[\s\S]*allFoldersTreeOrder[\s\S]*collapsedFolders\.value = new Set\(folderIds\);/);
    expect(panelSource).toMatch(/const collapseDefaultsSeeded = ref\(false\);[\s\S]*collapsedFolders\.value = new Set\(folderIds\);/);
    expect(panelSource).toMatch(/@click="collapseAllFolders"/);
    expect(panelSource).toMatch(/:disabled="!hasAnyFolder\(\)"/);
  });

  it("auto-expands a search-matched branch so matched files remain visible when the library collapses by default", () => {
    expect(panelSource).toMatch(/function isFolderExpanded\(folder: SavedSqlFolder\) \{[\s\S]*if \(searchQuery\.value && folderBranchMatchesQuery\(folder\)\) return true;[\s\S]*return !collapsedFolders\.value\.has\(folder\.id\);/);
    expect(panelSource).toMatch(/if \(!isFolderExpanded\(folder\)\) return;/);
  });
});
