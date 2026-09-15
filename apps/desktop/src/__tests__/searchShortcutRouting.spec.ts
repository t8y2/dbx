import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../App.vue", import.meta.url), "utf8");
const sidebarSource = readFileSync(new URL("../components/layout/AppSidebar.vue", import.meta.url), "utf8");
const connectionTreeSource = readFileSync(new URL("../components/sidebar/ConnectionTree.vue", import.meta.url), "utf8");
const treeItemSource = readFileSync(new URL("../components/sidebar/TreeItem.vue", import.meta.url), "utf8");

describe("search shortcut focus routing", () => {
  it("prioritizes the sidebar when Ctrl+F originates in the navigation area", () => {
    expect(appSource).toMatch(/const target = e\.target instanceof Element \? e\.target : null;[\s\S]*target\?\.closest\("\[data-app-sidebar\]"\)[\s\S]*appSidebarRef\.value\?\.focusSearch\(target\)/);
    expect(sidebarSource).toContain("<div data-app-sidebar");
  });

  it("routes a focused sidebar table-search control to its own input", () => {
    expect(connectionTreeSource).toMatch(/function focusSearch\(target: Element \| null = null\)[\s\S]*data-sidebar-table-search-control[\s\S]*data-sidebar-table-search-parent-id/);
    expect(treeItemSource).toMatch(/function onTableSearchControlKeydown\(event: KeyboardEvent\)[\s\S]*isFocusSearchShortcut\(event, settingsStore\.editorSettings\.shortcuts\)[\s\S]*data-sidebar-table-search-parent-id/);
    expect(treeItemSource).toContain("data-sidebar-table-search-control");
  });
});
