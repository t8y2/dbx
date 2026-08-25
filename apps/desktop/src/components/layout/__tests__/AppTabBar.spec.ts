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

describe("AppTabBar detached tab window", () => {
  it("places Open in Separate Window directly below Fix Tab and offers it for every tab", () => {
    const fixPosition = tabBarSource.indexOf('label: tab.pinned ? t("contextMenu.unfixTab") : t("contextMenu.fixTab")');
    const detachPosition = tabBarSource.indexOf('label: t("contextMenu.openInSeparateWindow")');
    expect(fixPosition).toBeGreaterThanOrEqual(0);
    expect(detachPosition).toBeGreaterThan(fixPosition);
    expect(tabBarSource).toContain("visible: isTauriRuntime()");
    expect(tabBarSource).toContain("action: () => void detachTabToWindow(tab)");
  });

  it("detaches through the shared ack-gated flow and surfaces block/failure reasons", () => {
    // 页签栏分离委托共享实现：prepare → 子窗口 adopt 回执确认后 finalize，
    // 失败回滚（页签保留）；执行中查询/未提交事务等不可迁移状态拒绝分离并明确提示。
    expect(tabBarSource).toContain('import { detachTabFailureMessage, detachTabToWindow as detachTabToWindowShared } from "@/lib/detached/detachTabToWindow";');
    expect(tabBarSource).toContain("const result = await detachTabToWindowShared(tab.id, t);");
    expect(tabBarSource).toContain("if (!result.ok) toast(detachTabFailureMessage(result.reason, t), 5000);");
    expect(tabBarSource).toContain('console.error("[detached-tab] open failed", error);');
  });

  it("hides pendingDetach tabs from every tab-bar surface so separate-window opens do not flicker", () => {
    // 「用独立窗口打开」创建即隐藏：所有渲染面（固定/常规/溢出列表/空栏判断）都走 visibleTabs。
    expect(tabBarSource).toContain("const visibleTabs = computed(() => queryStore.tabs.filter((tab) => !tab.pendingDetach));");
    expect(tabBarSource).toContain("const fixedTabs = computed(() => visibleTabs.value.filter((tab) => tab.pinned));");
    expect(tabBarSource).toContain("const regularTabs = computed(() => visibleTabs.value.filter((tab) => !tab.pinned));");
    expect(tabBarSource).toContain('v-if="visibleTabs.length > 0 || driverStoreOpen || settingsPageOpen"');
    expect(tabBarSource).not.toContain('v-for="tab in queryStore.tabs"');
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
    expect(tabBarSource).toMatch(/queryStore\.closeRightTabs\(tab\.id, \(\) => \{[\s\S]*closeSpecialRegularSurfaces\(\);/);
    expect(tabBarSource).toContain("if (shouldActivateTarget) activateTab(tab.id)");
  });

  it("reactivates settings after closing an active driver store to its right", () => {
    expect(tabBarSource).toContain("const shouldActivateSettings = !!props.driverStoreActive");
    expect(tabBarSource).toMatch(/emit\("close-driver-store"\);\s*if \(shouldActivateSettings\) emit\("activate-settings-page"\);/);
  });
});

describe("AppTabBar special page selection", () => {
  it("shows the active settings or driver-manager tab with the same ring used by regular tabs", () => {
    expect(tabBarSource).toContain("function specialTabActiveStyle(active: boolean | undefined)");
    expect(tabBarSource).toContain('return isClassicLayout.value ? { boxShadow: "inset 0 -2px 0 var(--ring)" } : { borderColor: "var(--ring)" };');
    expect(tabBarSource).toContain(':style="specialTabActiveStyle(settingsPageActive)"');
    expect(tabBarSource).toContain(':style="specialTabActiveStyle(driverStoreActive)"');
  });
});

describe("AppTabBar overflow search", () => {
  it("filters every open tab by its display and source titles", () => {
    expect(tabBarSource).toContain('const tabSearchQuery = ref("");');
    expect(tabBarSource).toContain("const filteredOpenTabs = computed(() => {");
    expect(tabBarSource).toContain("return queryStore.tabs.filter((tab) => tabTitleText(tab).toLocaleLowerCase().includes(query) || tab.title.toLocaleLowerCase().includes(query));");
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
