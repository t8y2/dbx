import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tabBarSource = readFileSync(new URL("../AppTabBar.vue", import.meta.url), "utf8");
const groupTabBarSource = readFileSync(new URL("../EditorGroupTabBar.vue", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const startIndex = tabBarSource.indexOf(start);
  const endIndex = tabBarSource.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return tabBarSource.slice(startIndex, endIndex);
}

describe("AppTabBar single production path", () => {
  it("no longer renders the regular or pinned tab strip", () => {
    expect(tabBarSource).not.toContain("hideRegularTabs");
    expect(tabBarSource).not.toContain("regularTabs");
    expect(tabBarSource).not.toContain("fixedTabsContainerRef");
    expect(tabBarSource).not.toContain("useTabDrag");
    expect(tabBarSource).not.toContain("createRenameDuplicateTabItems");
    expect(groupTabBarSource).toContain("createRenameDuplicateTabItems");
  });

  it("keeps special pages and the close-confirm dialog as its only surfaces", () => {
    expect(tabBarSource).toContain("getSpecialRegularTabMenuItems('settings')");
    expect(tabBarSource).toContain("getSpecialRegularTabMenuItems('driverStore')");
    expect(tabBarSource).toContain(':open="queryStore.showCloseConfirm"');
  });

  it("scopes the close-other shortcut to the active tab's owner group", () => {
    expect(tabBarSource).toContain("closeOtherTabsInGroup(ownerGroup.id, activeTabId)");
  });
});

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

  it("shows the dirty tab list using the shared tab title presentation", () => {
    const listBlock = sourceBetween('v-for="tab in closeConfirmDirtyTabs"', "</PopoverContent>");
    expect(listBlock).toContain("tabDisplayTitle(tab, t)");
  });
});

describe("AppTabBar special page selection", () => {
  it("renders settings and driver store as app-level pills outside the editor groups", () => {
    expect(tabBarSource).toContain("data-settings-page-tab");
    expect(tabBarSource).toContain("data-driver-store-tab");
    expect(tabBarSource).toContain("@click=\"emit('activate-settings-page')\"");
    expect(tabBarSource).toContain("@click=\"emit('activate-driver-store')\"");
    expect(tabBarSource).toContain('t("toolbar.driverManager")');
  });

  it("keeps the driver update badge on the driver store pill", () => {
    expect(tabBarSource).toContain("agentDriverUpdateCount");
    expect(tabBarSource).toContain("aria-label=\"t('toolbar.updatableDriverCount')\"");
  });
});

describe("Group tabbar inherited presentation", () => {
  it("imports the shared tab bar stylesheet so pills, scrollbar, and wrap styles apply", () => {
    expect(groupTabBarSource).toContain('import "./appTabBar.css"');
    expect(groupTabBarSource).toContain("app-tab-pill");
    expect(groupTabBarSource).toContain("app-tab-scrollbar");
    expect(groupTabBarSource).toContain("app-tab-bar");
  });

  it("keeps the dirty marker and dirty title styling", () => {
    expect(groupTabBarSource).toContain("dirty-tab-marker");
    expect(groupTabBarSource).toContain("dirtyTabTitleStyle");
  });
});
