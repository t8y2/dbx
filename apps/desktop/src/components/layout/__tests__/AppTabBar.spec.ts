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

describe("AppTabBar layout-aware special tabs", () => {
  it("mirrors the classic flat tab presentation instead of pills in the classic layout", () => {
    // 经典布局下普通标签是全高 + 右边框分隔的扁平段；特殊标签必须跟随同一呈现，
    // 不能永远是分离布局的圆角 pill（v0.6.3 分栏重构后的样式漂移）。
    expect(tabBarSource).toMatch(/isClassicLayout = computed\(\(\) => settingsStore\.editorSettings\.appLayout === "classic"\)/);
    expect(tabBarSource).toContain('isClassicLayout.value ? "h-9 items-stretch" : "h-10 items-center px-2"');
    expect(tabBarSource).toContain('isClassicLayout.value ? "h-full items-center overflow-x-auto" : "h-full items-center gap-1.5 overflow-x-auto py-1.5"');
    expect(tabBarSource).toContain('isClassicLayout.value ? "bg-muted" : `bg-background ${settingsStore.editorSettings.tabPlacement === "bottom" ? "border-t" : "border-b"}`');
    expect(tabBarSource).toContain('["h-full border-r border-border/80 font-medium dark:border-border/45", active ? "bg-background text-foreground" : "text-foreground/70 hover:text-foreground/90"]');
    expect(tabBarSource).toMatch(/h-7 \$\{widthClass\} rounded-md border/);
  });

  it("keeps both special tabs on the shared presentation helper", () => {
    expect(tabBarSource).toContain("specialTabClass(!!settingsPageActive, 'min-w-36')");
    expect(tabBarSource).toContain("specialTabClass(!!driverStoreActive, 'min-w-38')");
    // 经典布局激活的特殊标签与普通标签一样显示 inset 下划线指示条。
    expect(tabBarSource).toContain('return active ? { boxShadow: "inset 0 -2px 0 var(--ring)" } : undefined;');
    expect(tabBarSource).toContain(':style="specialTabColorStyle(!!settingsPageActive)"');
    expect(tabBarSource).toContain(':style="specialTabColorStyle(!!driverStoreActive)"');
  });
});

describe("AppTabBar return tabs while a special page is active", () => {
  // 特殊页激活时工作区被整体隐藏，分组标签条随之消失；必须在特殊条里重渲
  // 染打开的标签，否则用户没有任何鼠标路径切回编辑器（v0.6.4 回归）。
  // 未激活的特殊页不再渲染独立条，由分组标签条末尾承载（见 EditorGroupTabBar）。
  it("renders the app-level strip only while a special page is active", () => {
    expect(tabBarSource).toContain('v-if="driverStoreActive || settingsPageActive"');
  });

  it("re-renders the open tabs only while settings or the driver store is active", () => {
    expect(tabBarSource).toContain("(props.settingsPageActive || props.driverStoreActive ? queryStore.tabs : [])");
    expect(tabBarSource).toContain('v-for="tab in overlayReturnTabs"');
    expect(tabBarSource).toContain("data-return-tab");
    expect(tabBarSource).toContain("@click=\"emit('activate-tab', tab.id)\"");
    // 普通标签在前，设置/驱动管理追加在末尾（v0.6.2 的顺序；新开的特殊页
    // 不应插到最前面）。
    const indices = ['v-for="tab in overlayReturnTabs"', "data-settings-page-tab", "data-driver-store-tab"].map((marker) => tabBarSource.indexOf(marker));
    expect(indices.every((index) => index >= 0)).toBe(true);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it("keeps return tabs inactive while the special page owns the surface", () => {
    // 特殊页激活期间只有一个激活面：返回标签不得保留上一个标签的高亮。
    expect(tabBarSource).toContain(':class="specialTabClass(false)"');
    expect(tabBarSource).toContain(':style="tabColorStyle(tab, false, isClassicLayout)"');
    expect(tabBarSource).toContain('data-active-tab="false"');
  });

  it("gives return tabs the native mode icon", () => {
    expect(tabBarSource).toContain(':class="tabIconClass(tab)"');
    expect(tabBarSource).toContain('<TabModeIcon :tab="tab" class="h-3.5 w-3.5" />');
  });

  it("keeps return tabs closable with the shared dirty-confirm flow", () => {
    expect(tabBarSource).toContain('@mousedown.middle.prevent="queryStore.closeTab(tab.id)"');
    expect(tabBarSource).toContain('@click.stop="queryStore.closeTab(tab.id)"');
  });

  it("wires the return-tab click to the query-surface activation in App", () => {
    const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");
    expect(appSource).toContain('@activate-tab="activateQueryTab"');
    // activateQueryTab flips the special surfaces off and switches to the tab.
    expect(appSource).toMatch(/function activateQueryTab\(tabId: string\): boolean \{[\s\S]*?activateQuerySurface\(\);/);
  });
});

describe("Group strip special page tabs", () => {
  it("appends open special pages to the focused group strip like v0.6.2", () => {
    expect(groupTabBarSource).toContain("queryStore.focusedGroupId === props.groupId");
    expect(groupTabBarSource).toContain("data-settings-page-tab");
    expect(groupTabBarSource).toContain("data-driver-store-tab");
    expect(groupTabBarSource).toContain("@click=\"emit('activate-settings')\"");
    expect(groupTabBarSource).toContain("@click=\"emit('activate-driver-store')\"");
    expect(groupTabBarSource).toContain('t("toolbar.driverManager")');
    // 经典布局下的激活下划线与普通标签一致。
    expect(groupTabBarSource).toContain('return active ? { boxShadow: "inset 0 -2px 0 var(--ring)" } : undefined;');
  });

  it("wires the group strip through the injected special page actions", () => {
    const groupSource = readFileSync(new URL("../EditorGroup.vue", import.meta.url), "utf8");
    expect(groupSource).toContain(':special-page-tabs="toolbar.specialPageTabs.value"');
    expect(groupSource).toContain('@activate-settings="toolbar.activateSettingsPage()"');
    expect(groupSource).toContain('@close-driver-store="toolbar.closeDriverStore()"');
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
