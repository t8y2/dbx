// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { createApp, nextTick, reactive } from "vue";
import EditorGroupTabBar from "../EditorGroupTabBar.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ConnectionConfig } from "@/types/database";

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

vi.mock("@/lib/plugins/pluginIconResolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/plugins/pluginIconResolver")>()),
  resolvePluginIcon: vi.fn(() => Promise.resolve("assets/plugin.svg")),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  readPluginAsset: vi.fn(() => Promise.resolve({ contentType: "image/svg+xml", dataBase64: "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=" })),
}));

const specDir = dirname(fileURLToPath(import.meta.url));
const sharedStyles = readFileSync(resolve(specDir, "../appTabBar.css"), "utf8");

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
    // Pin the engine to modern capabilities: these tests assert the designed
    // styles, not the legacy WebView fallbacks (covered in styles/__tests__).
    vi.stubGlobal("CSS", { supports: () => true });
    vi.stubGlobal("matchMedia", (query: string) => ({
      media: query,
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }));
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it.each((["none", "connection"] as const).flatMap((groupMode) => (["top", "bottom"] as const).flatMap((placement) => (["wrap", "scroll"] as const).map((tabLayout) => ({ groupMode, placement, tabLayout })))))(
    "preserves classic $placement $tabLayout row heights with $groupMode grouping in both sections",
    async ({ groupMode, placement, tabLayout }) => {
      const store = useQueryStore();
      const settings = useSettingsStore();
      settings.editorSettings.appLayout = "classic";
      settings.editorSettings.tabLayout = tabLayout;
      settings.editorSettings.tabGroupMode = groupMode;
      settings.editorSettings.tabPlacement = placement;
      for (let index = 0; index < 8; index += 1) {
        store.createTab("pg-1", "app", `Query ${index}`, "query");
      }
      store.tabs[0]!.pinned = true;
      const { app, host } = mountBar(store.focusedGroupId, store.tabs.slice(), store.activeTabId, pinia);
      const styles = document.createElement("style");
      styles.textContent = `html { font-size: 16px; } .h-full { height: 100%; }\n${sharedStyles}`;
      document.head.appendChild(styles);

      try {
        await settle();
        expect(host.querySelectorAll(".tab-section--horizontal")).toHaveLength(2);
        const entries = host.querySelectorAll<HTMLElement>(".tab-group-entry");
        expect(entries).toHaveLength(8);
        for (const entry of entries) {
          const row = tabLayout === "wrap" && groupMode !== "none" ? entry.querySelector<HTMLElement>(".tab-group-tab")! : entry;
          expect(getComputedStyle(row).height).toBe(tabLayout === "wrap" ? "32px" : "100%");
        }
      } finally {
        app.unmount();
        host.remove();
        styles.remove();
      }
    },
  );

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

    // Collapse the pg cluster: its pills contract, the count badge appears.
    headers[1]!.click();
    await settle();
    expect(host.querySelectorAll(".tab-group-entry--collapsed")).toHaveLength(2);
    expect(host.querySelectorAll("[data-tab-id]")).toHaveLength(3);
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

  it("only reveals a right-edge group when expansion leaves every member offscreen", async () => {
    const store = useQueryStore();
    const settings = useSettingsStore();
    settings.editorSettings.tabGroupMode = "connection";
    settings.editorSettings.tabLayout = "scroll";
    const mysql = store.createTab("mysql-1", "app", "MY 1", "query");
    store.createTab("pg-1", "app", "PG 1", "query");
    store.createTab("pg-1", "app", "PG 2", "query");
    const { app, host } = mountBar(store.groups[0]!.id, store.tabs.slice(), mysql, pinia);
    await settle();

    const headers = Array.from(host.querySelectorAll<HTMLButtonElement>(".tab-group-header"));
    const pgHeader = headers.find((header) => header.title === "pg-1")!;
    pgHeader.click();
    await settle();
    pgHeader.click();
    await settle();

    const container = host.querySelector<HTMLElement>(".app-tab-scroll")!;
    container.getBoundingClientRect = () => ({ left: 0, right: 300 }) as DOMRect;
    const pgEntries = Array.from(host.querySelectorAll<HTMLElement>('[data-tab-group-id="regular:connection:pg-1"]'));
    const pgPills = pgEntries.map((entry) => entry.querySelector<HTMLElement>(".tab-group-tab")!);
    pgPills.forEach((pill, index) => {
      pill.getBoundingClientRect = () => ({ left: 320 + index * 100, right: 420 + index * 100 }) as DOMRect;
    });
    const scrollBy = vi.fn();
    container.scrollBy = scrollBy;

    const transitionEnd = new Event("transitionend", { bubbles: true });
    Object.defineProperty(transitionEnd, "propertyName", { value: "max-width" });
    pgEntries[0]!.dispatchEvent(transitionEnd);

    expect(scrollBy).toHaveBeenCalledWith({ left: 124, behavior: "smooth" });

    pgHeader.click();
    await settle();
    pgHeader.click();
    await settle();
    pgPills[0]!.getBoundingClientRect = () => ({ left: 250, right: 350 }) as DOMRect;
    const partialScrollBy = vi.fn();
    container.scrollBy = partialScrollBy;
    const visibleTransitionEnd = new Event("transitionend", { bubbles: true });
    Object.defineProperty(visibleTransitionEnd, "propertyName", { value: "max-width" });
    pgEntries[0]!.dispatchEvent(visibleTransitionEnd);

    expect(partialScrollBy).toHaveBeenCalledWith({ left: 54, behavior: "smooth" });

    pgHeader.click();
    await settle();
    pgHeader.click();
    await settle();
    pgPills[0]!.getBoundingClientRect = () => ({ left: 100, right: 200 }) as DOMRect;
    const fullyVisibleScrollBy = vi.fn();
    container.scrollBy = fullyVisibleScrollBy;
    const fullyVisibleTransitionEnd = new Event("transitionend", { bubbles: true });
    Object.defineProperty(fullyVisibleTransitionEnd, "propertyName", { value: "max-width" });
    pgEntries[0]!.dispatchEvent(fullyVisibleTransitionEnd);

    expect(fullyVisibleScrollBy).not.toHaveBeenCalled();

    app.unmount();
    host.remove();
  });

  it("groups by database identity, disambiguating same-name databases across connections", async () => {
    const store = useQueryStore();
    const settings = useSettingsStore();
    settings.editorSettings.tabGroupMode = "database";
    const pgApp = store.createTab("pg-1", "app", "PG app", "query");
    store.createTab("mysql-1", "app", "MY app", "query");
    const pgConn = store.createTab("pg-1", "", "PG conn", "query");
    const mainGroup = store.groups[0];
    const { app, host } = mountBar(mainGroup.id, store.tabs.slice(), pgApp, pinia);
    await settle();

    const headers = Array.from(host.querySelectorAll<HTMLButtonElement>(".tab-group-header"));
    // Sorted by group key: the same-name "app" databases stay separate clusters
    // disambiguated by connection label, and the database-less tab clusters by connection.
    expect(headers.map((header) => header.title)).toEqual(["app · mysql-1", "pg-1", "app · pg-1"]);
    expect(host.querySelectorAll("[data-tab-id]").length).toBe(3);

    // Collapsing one "app" cluster leaves the other same-name cluster expanded.
    headers[0]!.click();
    await settle();
    expect(host.querySelectorAll(".tab-group-entry--collapsed")).toHaveLength(1);
    expect(host.querySelectorAll("[data-tab-id]")).toHaveLength(3);

    app.unmount();
    host.remove();
  });

  it("keeps Redis logical databases in one database group", async () => {
    const connectionStore = useConnectionStore();
    connectionStore.connections = [{ id: "redis-1", name: "Redis Cache", db_type: "redis", driver_profile: "redis", host: "127.0.0.1", port: 6379, color: "" } as ConnectionConfig];
    const store = useQueryStore();
    const settings = useSettingsStore();
    settings.editorSettings.tabGroupMode = "database";
    const db0 = store.createTab("redis-1", "0", "Redis 0", "redis");
    const db1 = store.createTab("redis-1", "1", "Redis 1", "redis");
    const { app, host } = mountBar(store.groups[0]!.id, store.tabs.slice(), db0, pinia);
    await settle();

    // db0 and db1 are logical databases of one connection, so a single header
    // labeled by the connection owns both pills instead of one cluster per db.
    const headers = Array.from(host.querySelectorAll<HTMLButtonElement>(".tab-group-header"));
    expect(headers.map((header) => header.title)).toEqual(["Redis Cache"]);
    const groupIds = new Set(Array.from(host.querySelectorAll("[data-tab-group-id]"), (entry) => entry.getAttribute("data-tab-group-id")));
    expect(groupIds.size).toBe(1);
    expect(host.querySelectorAll("[data-tab-id]")).toHaveLength(2);
    expect(host.querySelector(`[data-tab-id="${db0}"]`)?.textContent).toContain("db0");
    expect(host.querySelector(`[data-tab-id="${db1}"]`)?.textContent).toContain("db1");

    // Collapsing the cluster folds both logical databases into one count badge.
    headers[0]!.click();
    await settle();
    expect(host.querySelector(".tab-group-count")?.textContent).toBe("2");

    app.unmount();
    host.remove();
  });

  it("sizes the header chevron and rotates it only while the cluster is collapsed", async () => {
    const store = useQueryStore();
    const settings = useSettingsStore();
    settings.editorSettings.tabGroupMode = "connection";
    const tabId = store.createTab("pg-1", "app", "PG 1", "query");
    const { app, host } = mountBar(store.groups[0]!.id, store.tabs.slice(), tabId, pinia);
    const styles = document.createElement("style");
    styles.textContent = `html { font-size: 16px; }\n${sharedStyles}`;
    document.head.appendChild(styles);

    try {
      await settle();
      const header = host.querySelector<HTMLButtonElement>(".tab-group-header")!;
      // Group headers consistently expose the placement marker.
      expect(header.querySelector(".tab-group-database-icon")).not.toBeNull();
      expect(header.querySelector(".tab-group-marker")).not.toBeNull();
      const chevron = header.querySelector<HTMLElement>(".tab-group-chevron")!;
      expect(getComputedStyle(chevron).width).toBe("14px");
      expect(getComputedStyle(chevron).height).toBe("14px");
      expect(getComputedStyle(chevron).transition).toContain("transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)");
      expect(getComputedStyle(chevron).transform).toBe("rotate(0deg)");

      header.click();
      await settle();
      expect(chevron.classList.contains("tab-group-chevron--collapsed")).toBe(true);
      expect(header.getAttribute("aria-expanded")).toBe("false");
      expect(getComputedStyle(chevron).transform).toBe("rotate(-90deg)");

      header.click();
      await settle();
      expect(chevron.classList.contains("tab-group-chevron--collapsed")).toBe(false);
      expect(getComputedStyle(chevron).transform).toBe("rotate(0deg)");

      // The rail marker appears only under a vertical placement.
      settings.editorSettings.tabPlacement = "left";
      await settle();
      expect(host.querySelector(".tab-group-header .tab-group-marker")).not.toBeNull();
    } finally {
      app.unmount();
      host.remove();
      styles.remove();
    }
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

  it("renders plugin workbench tabs with the plugin icon instead of the code fallback", async () => {
    const store = useQueryStore();
    const pluginTabId = store.openPluginWorkbench("io.dbx.ssh", "io.dbx.ssh.workbench", { title: "SSH server", connectionId: "ssh-1", forceNew: true });
    const { app, host } = mountBar(store.groups[0].id, store.tabs.slice(), pluginTabId, pinia);
    await settle();
    // PluginIcon loads the asset asynchronously; wait for the blob <img> to appear.
    for (let i = 0; i < 20 && !host.querySelector(`[data-tab-id="${pluginTabId}"] img`); i += 1) {
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5));
    }

    const pill = host.querySelector<HTMLElement>(`[data-tab-id="${pluginTabId}"]`);
    expect(pill).toBeTruthy();
    expect(pill!.querySelector("img")).toBeTruthy();

    app.unmount();
    host.remove();
  });
});

describe("EditorGroupTabBar special page navigation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    setActivePinia(createPinia());
  });

  function mountSpecialBar(extraProps: Record<string, unknown> = {}) {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useQueryStore();
    const settings = useSettingsStore();
    settings.editorSettings.tabGroupMode = "connection";
    const tabId = store.createTab("pg-1", "app", "Query", "query");
    const specialPageTabs = reactive({ settingsOpen: true, settingsActive: true, driverStoreOpen: true, driverStoreActive: false, driverUpdateCount: 105 });
    const events: string[] = [];
    const mounted = mountBar(store.focusedGroupId, store.tabs.slice(), tabId, pinia, {
      specialPageTabs,
      "onActivate-settings": () => events.push("activate-settings"),
      "onActivate-driver-store": () => events.push("activate-driver-store"),
      "onClose-settings": () => events.push("close-settings"),
      "onClose-driver-store": () => events.push("close-driver-store"),
      ...extraProps,
    });
    return { ...mounted, store, settings, tabId, specialPageTabs, events };
  }

  it.each(["classic", "separated"] as const)("keeps grouped tabs and both special pages at every placement in %s layout", async (layout) => {
    const { app, host, settings, store, tabId } = mountSpecialBar();
    settings.editorSettings.appLayout = layout;
    for (const placement of ["top", "bottom", "left", "right"] as const) {
      settings.editorSettings.tabPlacement = placement;
      await settle();
      expect(host.querySelectorAll(".tab-group-header")).toHaveLength(1);
      expect(host.querySelectorAll("[data-settings-page-tab]")).toHaveLength(1);
      expect(host.querySelectorAll("[data-driver-store-tab]")).toHaveLength(1);
      expect(host.querySelector(`[data-tab-id="${tabId}"]`)?.getAttribute("data-active-tab")).toBe("false");
      expect(host.querySelector(".tab-group-header--active")).toBeNull();
      expect(store.activeTabId).toBe(tabId);
      const vertical = placement === "left" || placement === "right";
      expect(host.querySelector(".app-tab-bar")?.classList.contains("vertical-tab-layout")).toBe(vertical);
      const special = host.querySelector<HTMLElement>("[data-settings-page-tab]")!;
      expect(special.classList.contains("h-8")).toBe(vertical);
      expect(special.style.boxShadow).toBe(vertical ? "" : layout === "classic" ? "inset 0 -2px 0 color-mix(in srgb, var(--foreground) 72%, transparent)" : "");
    }
    app.unmount();
    host.remove();
  });

  it.each(["left", "right"] as const)("keeps collapsed %s special tabs accessible and closable without labels or badges", async (placement) => {
    const { app, host, settings, events } = mountSpecialBar({ tabBarCollapsed: true });
    settings.editorSettings.tabPlacement = placement;
    await settle();
    for (const [selector, action] of [
      ["[data-settings-page-tab]", "settings"],
      ["[data-driver-store-tab]", "driver-store"],
    ]) {
      const tab = host.querySelector<HTMLElement>(selector!)!;
      expect(tab.getAttribute("aria-label")).toBe(tab.title);
      expect(tab.getAttribute("tabindex")).toBe("0");
      expect(tab.textContent?.trim()).toBe("");
      expect(tab.querySelector("button")).toBeNull();
      tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      tab.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      tab.dispatchEvent(new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true }));
      expect(events).toEqual(expect.arrayContaining([`activate-${action}`, `close-${action}`]));
      expect(events.filter((event) => event === `activate-${action}`)).toHaveLength(2);
    }
    app.unmount();
    host.remove();
  });

  it.each(["classic", "separated"] as const)("lets side-tab wrappers size to their rows while preserving the %s horizontal layout", async (layout) => {
    const { app, host, settings, tabId } = mountSpecialBar();
    settings.editorSettings.appLayout = layout;
    for (const placement of ["top", "left", "bottom", "right", "top"] as const) {
      settings.editorSettings.tabPlacement = placement;
      await settle();
      const tab = host.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)!;
      const wrapper = tab.closest<HTMLElement>(".app-tab-scroll > div")!;
      expect(wrapper).not.toBeNull();
      expect(wrapper).not.toBe(tab);
      const horizontal = placement === "top" || placement === "bottom";
      expect(wrapper.classList.contains("h-full")).toBe(layout === "classic" && horizontal);
    }
    app.unmount();
    host.remove();
  });

  it("restores normal activation without resetting a collapsed semantic group", async () => {
    const { app, host, specialPageTabs, tabId, store } = mountSpecialBar();
    await settle();
    const header = host.querySelector<HTMLButtonElement>(".tab-group-header")!;
    header.click();
    await settle();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    specialPageTabs.settingsActive = false;
    await settle();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(store.activeTabId).toBe(tabId);
    header.click();
    await settle();
    expect(host.querySelector(`[data-tab-id="${tabId}"]`)?.getAttribute("data-active-tab")).toBe("true");
    expect(host.querySelector(".tab-group-header--active")).not.toBeNull();
    app.unmount();
    host.remove();
  });

  it("preserves special-tab context menu close scope and prevents close-button activation", async () => {
    const { app, host, events, store, tabId } = mountSpecialBar();
    await settle();
    const tab = host.querySelector<HTMLElement>("[data-settings-page-tab]")!;
    tab.querySelector<HTMLButtonElement>("button")!.click();
    expect(events).toEqual(["close-settings"]);
    tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await settle();
    const menu = document.body.querySelector<HTMLElement>("[data-dbx-context-menu]")!;
    const closeOther = Array.from(menu.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Close other tabs"))!;
    expect(closeOther).toBeDefined();
    closeOther.click();
    await settle();
    expect(events).toEqual(["close-settings", "close-driver-store"]);
    expect(store.tabs.map((item) => item.id)).toEqual([tabId]);
    app.unmount();
    host.remove();
  });
});
