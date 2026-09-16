import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../App.vue", import.meta.url), "utf8");
const sidebarSource = readFileSync(new URL("../components/layout/AppSidebar.vue", import.meta.url), "utf8");
const connectionTreeSource = readFileSync(new URL("../components/sidebar/ConnectionTree.vue", import.meta.url), "utf8");
const treeItemSource = readFileSync(new URL("../components/sidebar/TreeItem.vue", import.meta.url), "utf8");
const contentAreaSource = readFileSync(new URL("../components/layout/ContentArea.vue", import.meta.url), "utf8");
const dataGridSource = readFileSync(new URL("../components/grid/DataGrid.vue", import.meta.url), "utf8");
const objectBrowserSource = readFileSync(new URL("../components/objects/ObjectBrowser.vue", import.meta.url), "utf8");
const aiAssistantSource = readFileSync(new URL("../components/editor/AiAssistant.vue", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");
const sqlLibrarySource = readFileSync(new URL("../components/layout/SqlLibraryPanel.vue", import.meta.url), "utf8");
const historySource = readFileSync(new URL("../components/editor/QueryHistory.vue", import.meta.url), "utf8");
const driverStoreSource = readFileSync(new URL("../components/config/DriverStoreDialog.vue", import.meta.url), "utf8");
const pluginCenterSource = readFileSync(new URL("../components/plugins/PluginContributionsPanel.vue", import.meta.url), "utf8");
const connectionDialogSource = readFileSync(new URL("../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");

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

  it("routes a focused table properties panel to its local search input", () => {
    expect(contentAreaSource).toMatch(/function focusSearch\(target: Element \| null = null\)[\s\S]*dataGridRef\.value\?\.focusSearch\(target\)/);
    expect(dataGridSource).toMatch(/function focusSearch\(target: Element \| null = null\)[\s\S]*data-table-info-drawer[\s\S]*data-table-info-search/);
    expect(dataGridSource).toMatch(/focusSearch\(event\.target instanceof Element \? event\.target : document\.activeElement instanceof Element \? document\.activeElement : null\);/);
    expect(objectBrowserSource).toMatch(/function focusSearch\(target: Element \| null = null\)[\s\S]*data-object-table-info-panel[\s\S]*data-table-info-search/);
  });

  it("routes auxiliary page and panel searches before the query surface", () => {
    expect(appSource).toMatch(/function focusSearchInAuxiliarySurface\(target: Element \| null\)[\s\S]*data-connection-db-search[\s\S]*data-settings-global-search[\s\S]*data-driver-store-agent-search[\s\S]*data-plugin-marketplace-search[\s\S]*data-history-panel[\s\S]*data-sql-library-panel/);
    expect(appSource).toMatch(/lastFocusedAuxiliarySurface[\s\S]*rememberAuxiliarySearchSurface[\s\S]*data-sql-library-panel/);
    expect(appSource).toMatch(/const targetIsDocument = !target \|\| target === document\.body \|\| target === document\.documentElement;[\s\S]*if \(!targetIsDocument\) return false;/);
    expect(appSource).toMatch(/lastFocusedSidebarSurface[\s\S]*rememberSidebarSearchSurface[\s\S]*data-app-sidebar/);
    expect(appSource).toMatch(/function handleAuxiliarySearchKeydownCapture\(e: KeyboardEvent\)[\s\S]*focusSearchInAuxiliarySurface\(target\)[\s\S]*addEventListener\("keydown", handleAuxiliarySearchKeydownCapture, true\)/);
    expect(appSource).toContain("aiAssistantRef.value.focusSearch()");
    expect(aiAssistantSource).toMatch(/function focusSearch\(\): boolean[\s\S]*setConversationListOpen\(true\)/);
    expect(aiAssistantSource).toContain("data-ai-conversation-search");
    expect(settingsSource).toContain("data-settings-global-search");
    expect(sqlLibrarySource).toContain("data-sql-library-search");
    expect(historySource).toContain("data-history-search");
    expect(driverStoreSource).toContain("data-driver-store-agent-search");
    expect(pluginCenterSource).toContain("data-plugin-marketplace-search");
    expect(connectionDialogSource).toContain("data-connection-db-search");
  });

  it("keeps the search shortcut inside the modal connection dialog", () => {
    expect(appSource).toMatch(/if \(showConnectionDialog\.value\) \{[\s\S]*?data-connection-db-search[\s\S]*?return true;\s*\}/);
  });
});
