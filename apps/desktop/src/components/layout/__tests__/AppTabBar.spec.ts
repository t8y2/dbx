import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tabBarSource = readFileSync(new URL("../AppTabBar.vue", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const startIndex = tabBarSource.indexOf(start);
  const endIndex = tabBarSource.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return tabBarSource.slice(startIndex, endIndex);
}

describe("AppTabBar close confirmation layout", () => {
  it("allows long unbroken tab titles to shrink and wrap inside the dialog", () => {
    expect(tabBarSource).toMatch(/<DialogContent class="[^"]*\bmin-w-0\b[^"]*\bsm:max-w-md\b/);
    expect(tabBarSource).toMatch(/<div class="[^"]*\bmin-w-0\b[^"]*\bspace-y-2\b">\s*<p class="[^"]*\bwrap-anywhere\b/);
  });

  it("keeps all single and bulk close actions while allowing the footer to wrap", () => {
    expect(tabBarSource).toMatch(/<DialogFooter class="[^"]*\bmin-w-0\b[^"]*\bsm:flex-wrap\b">/);
    expect(tabBarSource).toContain('v-if="showCloseConfirmBulkActions" variant="secondary" class="border-border" @click="handleDiscardAllAndClose"');
    expect(tabBarSource).toContain('v-if="showCloseConfirmBulkActions" @click="handleSaveAllAndClose"');
    expect(tabBarSource).toContain('variant="secondary" class="border-border" @click="handleDiscardAndClose"');
    expect(tabBarSource).toContain('@click="handleSaveAndClose"');
    expect(tabBarSource).toContain('@click="handleCancelClose"');
  });
});

describe("AppTabBar HBase presentation", () => {
  it("uses the table icon in regular, pinned, and overflow tab surfaces", () => {
    expect(tabBarSource).toContain('if (tab.mode === "data" || tab.mode === "mongo" || tab.mode === "redis" || tab.mode === "hbase") return Table2;');
    expect(tabBarSource.match(/tab\.mode === 'hbase'/g)).toHaveLength(2);
    expect(tabBarSource).toContain('tab.mode === "hbase" || tab.mode === "structure"');
  });
});

describe("AppTabBar object browser presentation", () => {
  it("uses matching icons and colors for object and database browser tabs", () => {
    expect(tabBarSource).toContain('if (tab.mode === "databases" || tab.mode === "objects") return "text-amber-500 dark:text-amber-400";');
    expect(tabBarSource).toContain('if (tab.mode === "databases") return Database;');
    expect(tabBarSource).toContain('if (tab.mode === "objects") return TableProperties;');
    expect(tabBarSource.match(/tab\.mode === 'databases'/g)).toHaveLength(2);
    expect(tabBarSource.match(/:class="tabIconClass\(tab\)"/g)).toHaveLength(2);
    expect(tabBarSource.match(/tabMenuIcon\(tab\).*tabIconClass\(tab\)/g)).toHaveLength(2);
  });
});

describe("AppTabBar locate-in-sidebar action", () => {
  it("emits the exact right-clicked tab only when it has a sidebar target", () => {
    const menu = sourceBetween("function getTabMenuItems", "function handleSaveAndClose");

    expect(tabBarSource).toContain('"locate-tab": [tab: QueryTab];');
    expect(menu).toMatch(/label: t\("sidebar\.locateActiveTab"\),\s*action: \(\) => emit\("locate-tab", tab\),\s*icon: Crosshair,\s*visible: !!activeTabSidebarTarget\(tab\)/);
    expect(menu).not.toContain("activateTab(tab.id)");
  });

  it("leaves settings, driver, and existing regular-tab menu actions unchanged", () => {
    const specialMenu = sourceBetween("function getSpecialRegularTabMenuItems", "function getTabMenuItems");
    const regularMenu = sourceBetween("function getTabMenuItems", "function handleSaveAndClose");

    expect(specialMenu).not.toContain('t("sidebar.locateActiveTab")');
    expect(regularMenu).toContain('label: t("contextMenu.copyName")');
    expect(regularMenu).toContain("action: () => queryStore.togglePinnedTab(tab.id)");
    expect(regularMenu).toContain("action: () => queryStore.closeTab(tab.id)");
  });
});

describe("AppTabBar Zen mode interaction", () => {
  it("switches Zen mode for data tabs while preserving query-tab renaming", () => {
    const handler = sourceBetween("function handleTabDoubleClick", "function handleTabMouseDown");

    expect(tabBarSource).toContain('"toggle-zen-mode": [];');
    expect(handler).toContain('if (tab.mode === "data") {');
    expect(handler).toContain('emit("toggle-zen-mode");');
    expect(handler).toContain("startRenameTab(tab);");
    expect(handler).toContain("event.target instanceof Element && event.target.closest(\"button, input, [role='button']\")");
    expect(tabBarSource.match(/@dblclick="handleTabDoubleClick\(tab, \$event\)"/g)).toHaveLength(2);
  });
});

describe("AppTabBar right-side close action", () => {
  it("places the action after close-other and disables it when the target has no tabs to its right", () => {
    expect(tabBarSource).toContain('label: t("contextMenu.closeRightTabs")');
    expect(tabBarSource).toContain("action: () => closeTabsToRightFromTab(tab)");
    expect(tabBarSource).toContain("disabled: !hasTabsToRight(tab)");

    const closeOtherPositions = [...tabBarSource.matchAll(/label: closeOtherLabel,/g)].map((match) => match.index);
    const closeRightPositions = [...tabBarSource.matchAll(/label: t\("contextMenu\.closeRightTabs"\),/g)].map((match) => match.index);
    const closeAllPositions = [...tabBarSource.matchAll(/label: closeAllLabel,/g)].map((match) => match.index);
    expect(closeOtherPositions).toHaveLength(2);
    expect(closeRightPositions).toHaveLength(2);
    expect(closeAllPositions).toHaveLength(2);
    closeRightPositions.forEach((position, index) => {
      expect(position).toBeGreaterThan(closeOtherPositions[index]);
      expect(position).toBeLessThan(closeAllPositions[index]);
    });
  });

  it("waits for query tab confirmation before closing special surfaces", () => {
    expect(tabBarSource).toMatch(/queryStore\.closeTabsByIds\(tabsToClose, finalActiveTabId, \(\) => \{[\s\S]*closeSpecialRegularSurfaces\(\);/);
    expect(tabBarSource).toContain("if (shouldActivateTarget) activateTab(tab.id)");
  });

  it("reactivates settings after closing an active driver store to its right", () => {
    expect(tabBarSource).toContain("const shouldActivateSettings = !!props.driverStoreActive");
    expect(tabBarSource).toMatch(/emit\("close-driver-store"\);\s*if \(shouldActivateSettings\) emit\("activate-settings-page"\);/);
  });
});

describe("AppTabBar left-side close action", () => {
  it("places the action after close-other, before close-right, and disables it when the target has no tabs to its left", () => {
    expect(tabBarSource).toContain('label: t("contextMenu.closeLeftTabs")');
    expect(tabBarSource).toContain("action: () => closeTabsToLeftFromTab(tab)");
    expect(tabBarSource).toContain("disabled: !hasTabsToLeft(tab)");

    const closeOtherPositions = [...tabBarSource.matchAll(/label: closeOtherLabel,/g)].map((match) => match.index);
    const closeLeftPositions = [...tabBarSource.matchAll(/label: t\("contextMenu\.closeLeftTabs"\),/g)].map((match) => match.index);
    const closeRightPositions = [...tabBarSource.matchAll(/label: t\("contextMenu\.closeRightTabs"\),/g)].map((match) => match.index);
    expect(closeOtherPositions).toHaveLength(2);
    // The special-surface menu has no left-side action: settings and the
    // driver store sit at the rightmost end of the tab bar, so nothing can be
    // to the left of them. Only the regular/pinned tab menu gets the item.
    expect(closeLeftPositions).toHaveLength(1);
    expect(closeRightPositions).toHaveLength(2);
    const closeLeftPosition = closeLeftPositions[0];
    expect(closeLeftPosition).toBeGreaterThan(closeOtherPositions[1]);
    expect(closeLeftPosition).toBeLessThan(closeRightPositions[1]);
  });
});

describe("AppTabBar special page selection", () => {
  it("shows the active settings or driver-manager tab with the same ring used by regular tabs", () => {
    expect(tabBarSource).toContain("function specialTabActiveStyle(active: boolean | undefined)");
    expect(tabBarSource).toContain('return isClassicLayout.value ? { boxShadow: "inset 0 -2px 0 var(--ring)" } : { borderColor: "var(--ring)" };');
    expect(tabBarSource).toContain(':style="specialTabActiveStyle(settingsPageActive)"');
    expect(tabBarSource).toContain(':style="specialTabActiveStyle(driverStoreActive)"');
  });

  it("does not leave a query group highlighted behind an active special page", () => {
    const groupActive = sourceBetween("function isTabGroupActive", "function toggleTabGroup");

    expect(groupActive).toContain("if (props.driverStoreActive || props.settingsPageActive) return false;");
  });

  it("restores the active special page after closing the group containing the retained query tab", () => {
    const restoreSurface = sourceBetween("function restoreSpecialRegularSurface", "function closeSpecialRegularSurfaces");
    const closeGroup = sourceBetween("function closeTabGroup", "function tabsToRightInGroup");

    expect(restoreSurface).toContain('if (surface === "settings" && props.settingsPageOpen) emit("activate-settings-page")');
    expect(restoreSurface).toContain('if (surface === "driverStore" && props.driverStoreOpen) emit("activate-driver-store")');
    expect(restoreSurface).toContain("const surface = pendingGroupCloseSpecialSurface.value;");
    expect(restoreSurface).toContain("pendingGroupCloseSpecialSurface.value = null;");
    expect(closeGroup).toContain('props.settingsPageActive ? "settings" : props.driverStoreActive ? "driverStore" : null');
    expect(closeGroup).toContain("pendingGroupCloseSpecialSurface.value = activeSpecialSurface;");
    expect(closeGroup).toContain("queryStore.closeTabsByIds(tabsToClose, finalActiveTabId, finishSpecialSurfacePreservingGroupClose)");
    expect(closeGroup).toContain("restoreSpecialRegularSurface(activeSpecialSurface);");
  });

  it("keeps and restores the special page while dirty grouped tabs are confirmed or cancelled", () => {
    const activeTabWatch = sourceBetween("watch(\n  () => queryStore.activeTabId", "watch(\n  () => props.driverStoreActive");
    const dismissClose = sourceBetween("function dismissCloseConfirm", "function handleCancelClose");
    const cancelClose = sourceBetween("function handleCancelClose", "const tabsContainerRef");

    expect(activeTabWatch).toContain("restoreSpecialRegularSurface(pendingGroupCloseSpecialSurface.value);");
    expect(dismissClose).toContain("pendingGroupCloseSpecialSurface.value = null;");
    expect(dismissClose).toContain("restoreSpecialRegularSurface(specialSurface);");
    expect(cancelClose).toContain("dismissCloseConfirm();");
    expect(tabBarSource).toContain("if (!open) dismissCloseConfirm();");
  });
});

describe("AppTabBar overflow search", () => {
  it("filters every open tab by its display and source titles", () => {
    expect(tabBarSource).toContain('const tabSearchQuery = ref("");');
    expect(tabBarSource).toContain("const filteredOpenTabs = computed(() => {");
    expect(tabBarSource).toContain("return displayedTabs.value.filter((tab) => tabMatchesSearch(tab, query));");
    expect(tabBarSource).toContain("return tabTitleText(tab).toLocaleLowerCase().includes(query) || tab.title.toLocaleLowerCase().includes(query) || connectionName.toLocaleLowerCase().includes(query);");
  });

  it("provides the same focused search control and empty state in both overflow menus", () => {
    expect(tabBarSource.match(/<Input data-tab-search-input=/g)).toHaveLength(2);
    expect(tabBarSource.match(/v-for="tab in filteredOpenTabs"/g)).toHaveLength(2);
    expect(tabBarSource.match(/tabs\.noMatchingTabs/g)).toHaveLength(2);
    expect(tabBarSource).toContain('[data-tab-search-input="regular"]');
    expect(tabBarSource).toContain('[data-tab-search-input="fixed"]');
  });
});

describe("AppTabBar query execution status", () => {
  it("replaces the icon through one shared status component in every tab surface", () => {
    expect(tabBarSource).toContain('import TabExecutionStatus from "@/components/layout/TabExecutionStatus.vue";');
    expect(tabBarSource.match(/<TabExecutionStatus :tab="tab">/g)).toHaveLength(4);
    expect(tabBarSource.match(/<\/TabExecutionStatus>/g)).toHaveLength(4);
  });
});

describe("AppTabBar collapsible groups", () => {
  it("supports a persistent icon-only vertical tab bar without losing tab actions", () => {
    expect(tabBarSource).toContain("tabBarCollapsed?: boolean;");
    expect(tabBarSource).toContain('"toggle-collapse": [];');
    expect(tabBarSource).toContain('return { width: "3.5rem", flex: "0 0 3.5rem" };');
    expect(tabBarSource).toContain('<component :is="tabBarCollapseIcon"');
    expect(tabBarSource).toContain("@click=\"emit('toggle-collapse')\"");
    expect(tabBarSource).toContain('v-if="!isTabBarCollapsed" class="panel-resize-handle"');
    expect(tabBarSource).toContain(".vertical-tab-layout--collapsed .app-tab-pill");
    expect(tabBarSource).toContain(".vertical-tab-layout.vertical-tab-layout--collapsed .tab-group-tab::before");
    expect(tabBarSource.match(/v-if="isTabBarCollapsed && isDirtyTab\(tab\)"/g)).toHaveLength(2);
    expect(tabBarSource).toMatch(/\(collapsed\) => \{\s*if \(collapsed\) tabSearchQuery\.value = "";/);
  });

  it("keeps horizontal placements immune to the persisted vertical collapse state", () => {
    expect(tabBarSource).toContain("const isTabBarCollapsed = computed(() => isVerticalLayout.value && !!props.tabBarCollapsed);");
    expect(tabBarSource).not.toContain('v-else-if="!tabBarCollapsed"');
    expect(tabBarSource).not.toContain('v-if="!tabBarCollapsed" class="min-w-0 truncate');
    expect(tabBarSource).not.toContain('v-if="tabBarCollapsed && isDirtyTab');
    // The only raw-prop guards left render inside the vertical-only toolbar.
    expect(tabBarSource.match(/!tabBarCollapsed/g)).toHaveLength(3);
  });

  it("keeps only grouping and collapse in the compact vertical toolbar", () => {
    expect(tabBarSource).toContain('const verticalTabToolbarButtonClass = "inline-flex h-7 w-7');
    expect(tabBarSource.match(/:trigger-class="verticalTabToolbarButtonClass"/g)).toHaveLength(1);
    const toolbar = sourceBetween('<div v-if="!tabBarCollapsed" class="flex shrink-0 items-center gap-0">', "</div>\n      <button");
    expect(toolbar).toContain(':trigger-icon="ListFilter"');
    expect(toolbar).not.toContain(':trigger-icon="ArrowDownUp"');
    expect(toolbar).not.toContain(':trigger-icon="PanelTop"');
    expect(tabBarSource).toContain('class="flex shrink-0 items-center gap-0.5 border-b p-1.5"');
    expect(tabBarSource).toContain('class="flex shrink-0 items-center gap-0"');
  });

  it("keeps separate collapsed state for regular and fixed groups", () => {
    expect(tabBarSource).toContain("const collapsedTabGroups = ref<Set<string>>(new Set());");
    expect(tabBarSource).toContain('return `${tab.pinned ? "fixed" : "regular"}:${tabGroupKey(tab)}`;');
    expect(tabBarSource).toContain("function toggleTabGroup(tab: QueryTab)");
    expect(tabBarSource.match(/:aria-expanded="!isTabGroupCollapsed\(tab\)"/g)).toHaveLength(2);
    expect(tabBarSource.match(/<CustomContextMenu v-if="!isTabGroupCollapsed\(tab\)"/g)).toHaveLength(2);
  });

  it("temporarily reveals matches and expands a collapsed group when one of its tabs becomes active", () => {
    expect(tabBarSource).toContain('if (settingsStore.editorSettings.tabGroupMode === "none" || tabSearchQuery.value.trim()) return false;');
    expect(tabBarSource).toContain("expandTabGroupForTab(tabId);");
  });

  it("uses compact group pills and places the accent next to content for top and bottom bars", () => {
    expect(tabBarSource).toContain(':data-placement="settingsStore.editorSettings.tabPlacement"');
    expect(tabBarSource).toContain(".app-tab-bar:not(.vertical-tab-layout) .tab-group-header");
    expect(tabBarSource).toContain(".app-tab-bar:not(.vertical-tab-layout) .tab-group-header::after");
    expect(tabBarSource).toContain(".app-tab-bar:not(.vertical-tab-layout) .tab-group-header--collapsed::after");
    expect(tabBarSource).toContain('.app-tab-bar:not(.vertical-tab-layout)[data-placement="bottom"] .tab-group-tab::after');
    expect(tabBarSource).toContain(".app-tab-bar:not(.vertical-tab-layout) .tab-group-tab--last::after");
    expect(tabBarSource).toContain(".vertical-tab-layout .tab-group-tab::before");
  });

  it("supports persistent names and colors from the group header context menu", () => {
    expect(tabBarSource.match(/:items="\(\) => getTabGroupMenuItems\(tab\)"/g)).toHaveLength(2);
    expect(tabBarSource).toContain('["#2563eb", "#d97706", "#7c3aed", "#059669", "#dc2626", "#0891b2", "#db2777", "#475569"]');
    expect(tabBarSource).toContain("tabGroupCustomizations: customizations");
    expect(tabBarSource).toContain("data-tab-group-name-input");
    expect(tabBarSource).toContain('type="color"');
  });

  it("exposes placement, grouping, and sorting preferences from the group context menu", () => {
    const preferences = sourceBetween("function getTabPreferenceMenuItems", "function getTabGroupMenuItems");
    const groupMenu = sourceBetween("function getTabGroupMenuItems", "function openTabGroupContextMenu");
    expect(preferences).toContain('label: t("settings.tabPlacement")');
    expect(preferences).toContain("action: () => updateTabPlacement(item.value)");
    expect(preferences).toContain('label: t("settings.tabGroup")');
    expect(preferences).toContain("action: () => updateTabGroupMode(item.value)");
    expect(preferences).toContain('label: t("settings.tabSort")');
    expect(preferences).toContain("action: () => updateTabSortMode(item.value)");
    expect(preferences.match(/checked: item\.value === settingsStore\.editorSettings\./g)).toHaveLength(3);
    expect(groupMenu).toContain("...getTabPreferenceMenuItems()");
  });

  it("exposes placement, grouping, and sorting preferences from each tab context menu", () => {
    const menu = sourceBetween("function getTabMenuItems", "function handleSaveAndClose");
    expect(menu).toContain("...getTabPreferenceMenuItems()");
  });

  it("waits for tab preference persistence and treats the whole group title as the context target", () => {
    expect(tabBarSource).toContain("await settingsStore.updateEditorSettingsAndPersist(partial)");
    expect(tabBarSource.match(/openTabGroupContextMenu\(\$event, onContextMenu\)/g)).toHaveLength(2);
    expect(tabBarSource).toContain("document.getSelection()?.removeAllRanges()");
    expect(tabBarSource).toContain("user-select: none;");
  });

  it("removes the unexplained fixed-tab divider from vertical placement", () => {
    expect(tabBarSource).toContain("isVerticalLayout ? 'max-h-[40%] flex-col bg-background pt-1'");
    expect(tabBarSource).toContain('<Pin v-if="!isTabBarCollapsed" class="tab-group-pin" aria-hidden="true" />');
  });

  it("uses a soft active shadow and a single indented rail for sidebar groups", () => {
    expect(tabBarSource).toContain("if (isVerticalLayout.value) {");
    expect(tabBarSource).toContain('"--app-tab-background": "var(--accent)"');
    expect(tabBarSource).toContain('.vertical-tab-layout .app-tab-pill[data-active-tab="true"]');
    expect(tabBarSource).toContain("inset 0 0 0 1px color-mix");
    expect(tabBarSource).toContain(".vertical-tab-layout .tab-group-header:not(.tab-group-header--collapsed)::after");
    expect(tabBarSource).toContain(".vertical-tab-layout .tab-group-tab::after");
    expect(tabBarSource).toContain("margin-inline: 2.5rem 0.5rem;");
    expect(tabBarSource).toContain("padding-inline-start: 0.65rem !important;");
    expect(tabBarSource).toContain("left: -0.65rem;");
    expect(tabBarSource).toContain(".vertical-tab-layout .tab-group-tab--first::before");
    expect(tabBarSource).toContain("bottom: -1.08rem;");
    expect(tabBarSource).toContain("top: 50%;");
    expect(tabBarSource).toContain("border-bottom-left-radius: 0.1875rem;");
  });
});
