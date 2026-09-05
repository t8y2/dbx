// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { createApp, nextTick } from "vue";
import EditorGroupTabBar from "../EditorGroupTabBar.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: { name: "TooltipStub", template: `<div><slot /></div>` },
  TooltipTrigger: { name: "TooltipTriggerStub", template: `<div><slot /></div>` },
  TooltipContent: { name: "TooltipContentStub", template: `<div><slot /></div>` },
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: { name: "PopoverStub", props: ["open"], template: `<div v-if="open"><slot /></div>` },
  PopoverContent: { name: "PopoverContentStub", template: `<div><slot /></div>` },
  PopoverTrigger: { name: "PopoverTriggerStub", template: `<div><slot /></div>` },
}));

const specDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(specDir, "../EditorGroupTabBar.vue"), "utf8");
const sharedStyles = readFileSync(resolve(specDir, "../appTabBar.css"), "utf8");

describe("EditorGroupTabBar semantic tab groups", () => {
  it("keeps separate collapsed state for pinned and regular clusters under the same key", () => {
    expect(source).toContain("const collapsedTabGroups = ref<Set<string>>(new Set());");
    expect(source).toContain('return `${tab.pinned ? "fixed" : "regular"}:${tabGroupKey(tab)}`;');
    expect(source).toContain("function toggleTabGroup(tab: QueryTab)");
    expect(source).toContain(':aria-expanded="!isTabGroupCollapsed(entry.tab)"');
  });

  it("expands a collapsed group when one of its tabs becomes active", () => {
    expect(source).toContain("expandTabGroupForTab(tabId);");
  });

  it("supports persistent names and colors from the group header context menu", () => {
    expect(source).toContain('["#2563eb", "#d97706", "#7c3aed", "#059669", "#dc2626", "#0891b2", "#db2777", "#475569"]');
    expect(source).toContain("tabGroupCustomizations: customizations");
    expect(source).toContain("data-tab-group-name-input");
    expect(source).toContain('type="color"');
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

  it("exposes preferences and the group close from each tab context menu", () => {
    const menuStart = source.indexOf("function getTabMenuItems");
    const menuEnd = source.indexOf("function handleTabDoubleClick");
    expect(menuStart).toBeGreaterThanOrEqual(0);
    expect(menuEnd).toBeGreaterThan(menuStart);
    const menu = source.slice(menuStart, menuEnd);
    expect(menu).toContain("...getTabPreferenceMenuItems()");
    expect(menu).toContain("action: () => closeTabGroup(tab)");
    expect(menu).toContain('visible: settingsStore.editorSettings.tabGroupMode !== "none"');
  });

  it("closes the global semantic group by key, not just this pane's cluster", () => {
    // D1 (amended): closing a cluster is destructive and stays bar-local —
    // scoped to this pane's tabs (props.tabs), still within the trigger's
    // pinned section. Profile edits (rename/color/reset) keep global reach.
    const closeGroup = sourceBetween("function tabsInSemanticGroup", "function getTabPreferenceMenuItems");
    expect(closeGroup).toContain("props.tabs.filter((item) => item.pinned === tab.pinned && tabGroupKey(item) === groupKey)");
    expect(closeGroup).toContain("queryStore.closeTabsByIds(tabsToClose, finalActiveTabId)");
  });

  it("waits for tab preference persistence and treats the whole group title as the context target", () => {
    expect(source).toContain("await settingsStore.updateEditorSettingsAndPersist(partial)");
    expect(source).toContain("openTabGroupContextMenu($event, onContextMenu)");
    expect(source).toContain("document.getSelection()?.removeAllRanges()");
  });

  it("applies the group rail classes to clustered pills", () => {
    // The horizontal underline and vertical indent rails only render when the
    // pill carries tab-group-tab with its --first/--last markers.
    expect(source).toContain("'tab-group-tab': entry.grouping,");
    expect(source).toContain("'tab-group-tab--first': entry.grouping && entry.groupFirst,");
    expect(source).toContain("'tab-group-tab--last': entry.grouping && entry.groupLast,");
    expect(sharedStyles).toContain(".app-tab-bar:not(.vertical-tab-layout) .tab-group-tab::after");
  });

  it("hides collapsed cluster pills but reveals them while searching", () => {
    expect(source).toContain("grouping && !tabSearchQuery.value.trim() && isTabGroupCollapsed(tab)");
  });

  it("keeps wrap layout out of the vertical placement", () => {
    expect(source).toContain('const isWrapLayout = computed(() => !isVerticalLayout.value && settingsStore.editorSettings.tabLayout === "wrap");');
  });

  it("uses compact group pills and places the accent next to content for horizontal bars", () => {
    expect(source).toContain(':data-placement="settingsStore.editorSettings.tabPlacement"');
    expect(sharedStyles).toContain(".app-tab-bar:not(.vertical-tab-layout) .tab-group-header");
    expect(sharedStyles).toContain(".app-tab-bar:not(.vertical-tab-layout) .tab-group-header::after");
    expect(sharedStyles).toContain(".app-tab-bar:not(.vertical-tab-layout) .tab-group-header--collapsed::after");
    expect(sharedStyles).toContain('.app-tab-bar:not(.vertical-tab-layout)[data-placement="bottom"] .tab-group-tab::after');
    expect(sharedStyles).toContain(".app-tab-bar:not(.vertical-tab-layout) .tab-group-tab--last::after");
  });

  function sourceBetween(start: string, end: string): string {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex + start.length);
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    return source.slice(startIndex, endIndex);
  }
});

describe("EditorGroupTabBar vertical placement", () => {
  const groupSource = readFileSync(resolve(specDir, "../EditorGroup.vue"), "utf8");
  const workspaceSource = readFileSync(resolve(specDir, "../SqlEditorWorkspace.vue"), "utf8");
  const appSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../App.vue"), "utf8");

  it("renders each pane's own bar as a vertical strip when placement is left/right", () => {
    expect(source).toContain('const isVerticalLayout = computed(() => settingsStore.editorSettings.tabPlacement === "left" || settingsStore.editorSettings.tabPlacement === "right");');
    expect(source).toContain('isVerticalLayout.value && props.tabBarCollapsed ? "vertical-tab-layout--collapsed" : ""');
    // The strip flips to a column with vertical scrolling; no horizontal strip remains.
    expect(source).toContain("isVerticalLayout ? 'flex-col items-stretch overflow-y-auto overflow-x-hidden py-1'");
  });

  it("positions each pane's bar by the global placement without mixing directions", () => {
    expect(groupSource).toContain('case "bottom":');
    expect(groupSource).toContain('return "flex-col-reverse";');
    expect(groupSource).toContain('case "left":');
    expect(groupSource).toContain('return "flex-row";');
    expect(groupSource).toContain('case "right":');
    expect(groupSource).toContain('return "flex-row-reverse";');
    // The editor toolbar stays atop the pane's content column in every placement.
    expect(groupSource).toContain('class="flex min-h-0 min-w-0 flex-1 flex-col"');
  });

  it("shares the vertical width/collapse state from App through the pane chain", () => {
    expect(appSource).toContain(':tab-bar-width="tabBarWidth"');
    expect(appSource).toContain(':tab-bar-collapsed="tabBarCollapsed"');
    expect(appSource).toContain('@start-resize="startTabBarResize"');
    expect(appSource).toContain('@toggle-collapse="toggleTabBarCollapsed"');
    expect(workspaceSource).toContain(':tab-bar-width="tabBarWidth"');
    expect(workspaceSource).toContain("@start-resize=\"emit('start-resize', $event)\"");
    expect(groupSource).toContain(':tab-bar-width="tabBarWidth"');
    // Dragging any pane's handle drives the shared resize handler.
    expect(source).toContain("@mousedown=\"emit('start-resize', $event)\"");
    expect(source).toContain("@click=\"emit('toggle-collapse')\"");
  });

  it("keeps horizontal placements immune to the persisted collapse state", () => {
    expect(source).toContain("const isTabBarCollapsed = computed(() => isVerticalLayout.value && !!props.tabBarCollapsed);");
    expect(source).toContain("if (!isVerticalLayout.value) return undefined;");
  });

  it("uses the sidebar rail and soft active shadow for vertical pills", () => {
    expect(sharedStyles).toContain(".vertical-tab-layout .tab-group-tab::before");
    expect(sharedStyles).toContain('.vertical-tab-layout .app-tab-pill[data-active-tab="true"]');
    expect(sharedStyles).toContain("inset 0 0 0 1px color-mix");
    expect(sharedStyles).toContain(".vertical-tab-layout .tab-group-header:not(.tab-group-header--collapsed)::after");
    expect(sharedStyles).toContain("margin-inline: 2.5rem 0.5rem;");
  });
});

function createHost(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

async function settle() {
  await nextTick();
  await nextTick();
}

function mountBar(groupId: string, tabs: ReturnType<ReturnType<typeof useQueryStore>["tabs"]>[number][], activeTabId: string | null, activePinia: ReturnType<typeof createPinia>, extraProps: Record<string, unknown> = {}) {
  const host = createHost();
  const app = createApp(EditorGroupTabBar, {
    groupId,
    tabs,
    activeTabId,
    ...extraProps,
  });
  app.use(activePinia);
  app.use(
    createI18n({
      legacy: false,
      locale: "en",
      messages: {
        en: {
          contextMenu: {
            renameTab: "Rename",
            duplicateTab: "Duplicate",
            copyName: "Copy name",
            closeTab: "Close",
            closeOtherTabs: "Close other tabs",
            closeLeftTabs: "Close left tabs",
            closeRightTabs: "Close right tabs",
            closeAllTabs: "Close all tabs",
            closeTabGroup: "Close group",
            editTabGroup: "Edit group",
            resetTabGroup: "Reset group",
            pinTab: "Pin",
            unpinTab: "Unpin",
            fullTabTitle: "Full title",
            compactTabTitle: "Compact title",
            splitRight: "Split right",
            splitDown: "Split down",
            changeOrientation: "Change orientation",
            unsplit: "Unsplit",
          },
          sidebar: { locateActiveTab: "Locate" },
          settings: {
            tabPlacement: "Tab placement",
            tabPlacementTop: "Top",
            tabPlacementBottom: "Bottom",
            tabPlacementLeft: "Left",
            tabPlacementRight: "Right",
            tabGroup: "Group tabs by",
            tabGroupNone: "None",
            tabGroupDatabaseType: "Database type",
            tabGroupConnection: "Connection",
            tabSort: "Sort tabs",
            tabSortManual: "Manual",
            tabSortCreated: "Created",
            tabSortTitle: "Title",
          },
          tabs: {
            openInNewWindow: "Open in new window",
            settingsSaveFailed: "Save failed: {message}",
            editGroupTitle: "Edit group {name}",
            groupName: "Name",
            groupColor: "Color",
            groupColorAuto: "Auto",
            groupColorCustom: "Custom",
            resetGroup: "Reset",
            openTabs: "Open tabs",
            searchOpenTabs: "Search",
            noMatchingTabs: "No matching tabs",
          },
          common: { cancel: "Cancel", save: "Save" },
          toolbar: { formatSqlFailed: "Format failed" },
          grid: { copyFailed: "Copy failed: {message}" },
          connection: { copied: "Copied" },
        },
      },
    }),
  );
  app.mount(host);
  return { app, host };
}

describe("EditorGroupTabBar group behavior", () => {
  let pinia: ReturnType<typeof createPinia>;

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it("renders one header per connection cluster and collapses it to a count badge", async () => {
    const store = useQueryStore();
    const settings = useSettingsStore();
    settings.editorSettings.tabGroupMode = "connection";
    const pgA = store.createTab("pg-1", "app", "PG 1", "query");
    store.createTab("pg-1", "app", "PG 2", "query");
    const my = store.createTab("mysql-1", "app", "MY 1", "query");
    const mainGroup = store.groups[0];
    const { app, host } = mountBar(mainGroup.id, store.tabs.slice(), pgA, pinia);
    await settle();

    const headers = Array.from(host.querySelectorAll<HTMLButtonElement>(".tab-group-header"));
    // Sorted by group key: mysql-1 clusters before pg-1.
    expect(headers.map((header) => header.title)).toEqual(["mysql-1", "pg-1"]);
    expect(host.querySelectorAll("[data-tab-id]").length).toBe(3);

    // Collapse the pg cluster: its pills hide, the count badge appears.
    headers[1]!.click();
    await settle();
    expect(Array.from(host.querySelectorAll("[data-tab-id]")).map((pill) => pill.getAttribute("data-tab-id"))).toEqual([my]);
    const pgHeader = host.querySelectorAll<HTMLButtonElement>(".tab-group-header")[1]!;
    expect(pgHeader.querySelector(".tab-group-count")?.textContent).toBe("2");
    expect(pgHeader.getAttribute("aria-expanded")).toBe("false");

    // Expand again.
    pgHeader.click();
    await settle();
    expect(host.querySelectorAll("[data-tab-id]").length).toBe(3);

    app.unmount();
    host.remove();
  });

  it("exposes the drag-back hit-test anchor and highlights itself as the detached drop target", async () => {
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "PG 1", "query");
    const mainGroup = store.groups[0];
    const { app, host } = mountBar(mainGroup.id, store.tabs.slice(), tabId, pinia, { detachedDropTarget: true });
    await settle();

    const bar = host.querySelector<HTMLElement>(".app-tab-bar");
    // Dropping a detached window over any pane's strip returns the tab, so
    // every strip must carry the hit-test anchor App unions rects over.
    expect(bar?.hasAttribute("data-main-tab-bar")).toBe(true);
    expect(bar?.classList.contains("ring-2")).toBe(true);
    expect(bar?.classList.contains("ring-inset")).toBe(true);

    app.unmount();
    host.remove();
  });

  it("closing a group stays within the invoking pane, sparing the same-key cluster elsewhere", async () => {
    const store = useQueryStore();
    const settings = useSettingsStore();
    settings.editorSettings.tabGroupMode = "connection";
    const pgA = store.createTab("pg-1", "app", "PG 1", "query");
    const pgB = store.createTab("pg-1", "app", "PG 2", "query");
    const my = store.createTab("mysql-1", "app", "MY 1", "query");
    const mainGroup = store.groups[0];
    store.groups = [mainGroup, { id: "second-group", tabIds: [], activeTabId: null }];
    store.moveTabToGroup(pgB, "second-group");
    const mountedTabs = store.tabs.filter((tab) => tab.id === pgA || tab.id === my);
    const { app, host } = mountBar(mainGroup.id, mountedTabs, pgA, pinia);
    await settle();

    // The pg cluster spans main (pgA) and second-group (pgB). Closing the
    // group from THIS pane's menu is bar-local: main loses its pg cluster,
    // while the same-key cluster in second-group survives untouched.
    const pgPill = host.querySelector<HTMLElement>(`[data-tab-id="${pgA}"]`)!;
    expect(pgPill).not.toBeNull();
    pgPill.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await settle();

    const menu = document.body.querySelector<HTMLElement>("[data-dbx-context-menu]")!;
    expect(menu).not.toBeNull();
    const closeGroupItem = Array.from(menu.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Close group"));
    expect(closeGroupItem).toBeDefined();
    closeGroupItem!.click();
    await settle();

    const remainingIds = store.tabs.map((tab) => tab.id);
    expect(remainingIds).not.toContain(pgA);
    expect(remainingIds).toEqual(expect.arrayContaining([pgB, my]));
    // second-group keeps its tab, so it is not pruned either.
    expect(store.groups.map((group) => group.id)).toEqual(expect.arrayContaining(["second-group"]));
    expect(store.groups.find((group) => group.id === "second-group")?.tabIds).toEqual([pgB]);
    expect(store.groups.find((group) => group.id === mainGroup.id)?.tabIds).toEqual([my]);

    app.unmount();
    host.remove();
  });

  it("closing a group spares the pinned cluster that shares its key", async () => {
    const store = useQueryStore();
    const settings = useSettingsStore();
    settings.editorSettings.tabGroupMode = "connection";
    const pgA = store.createTab("pg-1", "app", "PG 1", "query");
    const pgB = store.createTab("pg-1", "app", "PG 2", "query");
    store.togglePinnedTab(pgB);
    const mainGroup = store.groups[0];
    const { app, host } = mountBar(mainGroup.id, store.tabs.slice(), pgA, pinia);
    await settle();

    const pgPill = host.querySelector<HTMLElement>(`[data-tab-id="${pgA}"]`)!;
    pgPill.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await settle();
    const menu = document.body.querySelector<HTMLElement>("[data-dbx-context-menu]")!;
    const closeGroupItem = Array.from(menu.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Close group"));
    expect(closeGroupItem).toBeDefined();
    closeGroupItem!.click();
    await settle();

    // The regular cluster is gone; the pinned tab with the same key survives.
    const remainingIds = store.tabs.map((tab) => tab.id);
    expect(remainingIds).toEqual([pgB]);

    app.unmount();
    host.remove();
  });

  it("offers the detach entry only for query and data tabs and emits the tab upward", async () => {
    const store = useQueryStore();
    const queryId = store.createTab("pg-1", "app", "PG 1", "query");
    const mongoId = store.createTab("mongo-1", "app", "MG 1", "mongo");
    const mainGroup = store.groups[0];
    const detached: string[] = [];
    const { app, host } = mountBar(mainGroup.id, store.tabs.slice(), queryId, pinia, { canDetachTabs: true, "onDetach-tab": (tab: { id: string }) => detached.push(tab.id) });
    await settle();

    const openMenu = async (tabId: string) => {
      host.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      await settle();
      const menu = document.body.querySelector<HTMLElement>("[data-dbx-context-menu]")!;
      return Array.from(menu.querySelectorAll<HTMLButtonElement>("button"));
    };

    // Query tab: the entry exists and routes the whole tab object upward.
    const queryItems = await openMenu(queryId);
    const detachItem = queryItems.find((button) => button.textContent?.includes("Open in new window"));
    expect(detachItem).toBeDefined();
    detachItem!.click();
    await settle();
    expect(detached).toEqual([queryId]);

    // Non-query/data tab: the entry is not rendered at all.
    const mongoItems = await openMenu(mongoId);
    expect(mongoItems.find((button) => button.textContent?.includes("Open in new window"))).toBeUndefined();

    app.unmount();
    host.remove();
  });
});
