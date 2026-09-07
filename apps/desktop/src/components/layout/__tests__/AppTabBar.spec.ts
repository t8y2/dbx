import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tabBarSource = readFileSync(new URL("../AppTabBar.vue", import.meta.url), "utf8");
const groupTabBarSource = readFileSync(new URL("../EditorGroupTabBar.vue", import.meta.url), "utf8");
const groupSource = readFileSync(new URL("../EditorGroup.vue", import.meta.url), "utf8");

describe("AppTabBar shared group navigation", () => {
  it("hosts existing group bars without rendering a second tab strip", () => {
    expect(tabBarSource).toContain("GROUP_TAB_BAR_PORTAL");
    expect(tabBarSource).toContain('v-for="group in queryStore.groups"');
    expect(tabBarSource).toContain(':data-special-page-tab-target="group.id"');
    expect(tabBarSource).not.toContain("overlayReturnTabs");
    expect(tabBarSource).not.toContain("data-return-tab");
    expect(tabBarSource).not.toContain("createRenameDuplicateTabItems");
    expect(groupSource).toContain("<Teleport defer");
    expect(groupSource).toContain(':disabled="!tabBarPortal?.active.value || !tabBarTarget"');
  });

  it("retains targets while hiding inactive special content and follows all placements", () => {
    expect(tabBarSource).toContain('v-show="driverStoreActive || settingsPageActive"');
    expect(tabBarSource).toContain("data-special-page-navigation");
    expect(tabBarSource).toContain("data-special-page-content");
    expect(tabBarSource).toContain("<slot />");
    for (const layout of ["flex-col", "flex-col-reverse", "flex-row", "flex-row-reverse"]) {
      expect(tabBarSource).toContain(layout);
    }
    expect(tabBarSource).toContain("props.tabBarCollapsed");
    expect(tabBarSource).toContain("props.tabBarWidth");
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
    const start = tabBarSource.indexOf('v-for="tab in closeConfirmDirtyTabs"');
    const end = tabBarSource.indexOf("</PopoverContent>", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(tabBarSource.slice(start, end)).toContain("tabDisplayTitle(tab, t)");
  });
});

describe("Group strip special page tabs", () => {
  it("keeps special page tabs and their update badge in the focused group", () => {
    expect(groupTabBarSource).toContain("queryStore.focusedGroupId === props.groupId");
    expect(groupTabBarSource).toContain("data-settings-page-tab");
    expect(groupTabBarSource).toContain("data-driver-store-tab");
    expect(groupTabBarSource).toContain("@click=\"emit('activate-settings')\"");
    expect(groupTabBarSource).toContain("@click=\"emit('activate-driver-store')\"");
    expect(groupTabBarSource).toContain('t("toolbar.driverManager")');
    expect(groupTabBarSource).toContain("aria-label=\"t('toolbar.updatableDriverCount')\"");
    expect(groupTabBarSource).toContain("specialPageTabs?.driverUpdateCount");
  });

  it("routes special-page actions and preserves ordinary-tab dirty closing", () => {
    expect(groupSource).toContain(':special-page-tabs="toolbar.specialPageTabs.value"');
    expect(groupSource).toContain('@activate-settings="toolbar.activateSettingsPage()"');
    expect(groupSource).toContain('@close-driver-store="toolbar.closeDriverStore()"');
    expect(groupTabBarSource).toContain('@mousedown.middle.prevent="closeTab(entry.tab)"');
    expect(groupTabBarSource).toContain('@click.stop="closeTab(entry.tab)"');
    expect(groupTabBarSource).toContain("queryStore.closeTab(tab.id)");
  });

  it("uses one presentation path for active special pages and inactive ordinary tabs", () => {
    expect(groupTabBarSource).toContain("return !specialPageActive.value && tab.id === props.activeTabId;");
    expect(groupTabBarSource).toContain("specialPageTabClass(!!specialPageTabs?.settingsActive)");
    expect(groupTabBarSource).toContain("specialPageTabClass(!!specialPageTabs?.driverStoreActive)");
    expect(groupTabBarSource).toContain('return active ? { boxShadow: "inset 0 -2px 0 var(--ring)" } : undefined;');
    expect(groupTabBarSource).toContain('import "./appTabBar.css"');
    expect(groupTabBarSource).toContain("dirty-tab-marker");
    expect(groupTabBarSource).toContain("dirtyTabTitleStyle");
    expect(groupTabBarSource).toContain("createRenameDuplicateTabItems");
  });
});
