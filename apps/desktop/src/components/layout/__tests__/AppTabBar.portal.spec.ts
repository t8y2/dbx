// @vitest-environment happy-dom
import { computed, createApp, defineComponent, nextTick, reactive, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("splitpanes", () => ({
  Splitpanes: { template: "<div><slot /></div>" },
  Pane: { template: "<div><slot /></div>" },
}));
vi.mock("@/components/layout/EditorToolbar.vue", () => ({ default: { template: '<div data-test="toolbar" />' } }));
vi.mock("@/components/layout/QueryEditorSurface.vue", () => ({ default: { template: '<div data-test="query-editor" />' } }));
vi.mock("@/components/layout/QueryResultSurface.vue", () => ({ default: { template: '<div data-test="query-result" />' } }));
vi.mock("@/components/layout/ContentArea.vue", () => ({ default: { template: '<div data-test="content-area" />' } }));
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  closeClientConnectionSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tabs/tabResultCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tabs/tabResultCache")>()),
  deleteTabResultSnapshot: vi.fn().mockResolvedValue(undefined),
}));

import AppTabBar from "../AppTabBar.vue";
import SqlEditorWorkspace from "../SqlEditorWorkspace.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createGroupTabBarPortal, GROUP_TAB_BAR_PORTAL } from "../groupTabBarPortal";
import { createNoopEditorToolbarActions, EDITOR_TOOLBAR_ACTIONS } from "../editorToolbarActions";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { QueryTab } from "@/types/database";

function queryTab(id: string, connectionId = "mysql-local"): QueryTab {
  return { id, title: id, sql: "SELECT 1", mode: "query", connectionId, database: "app", isExecuting: false };
}

const cleanups: Array<() => void> = [];

async function settle() {
  await nextTick();
  await nextTick();
  await nextTick();
}

function mountNavigation(placement: "top" | "bottom" | "left" | "right", empty = false) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useQueryStore();
  const settings = useSettingsStore();
  settings.editorSettings.tabPlacement = placement;
  settings.editorSettings.tabGroupMode = "connection";
  store.tabs = empty ? [] : [queryTab("Query alpha"), queryTab("Query beta")];
  store.groups = [{ id: "main", tabIds: store.tabs.map((tab) => tab.id), activeTabId: store.tabs[0]?.id ?? null }];
  store.activeTabId = store.tabs[0]?.id ?? null;
  store.focusedGroupId = "main";
  store.sizes = [100];
  const pages = reactive({ settingsOpen: true, driverOpen: true, driverActive: false, draft: "initial" });
  const navigation = reactive({ width: 260, collapsed: false });
  const workspace = ref<{ toggleResultsPane: () => boolean } | null>(null);
  const saveTab = vi.fn();
  const saveAll = vi.fn();
  const active = computed(() => settings.settingsPageActive || pages.driverActive);
  const portal = createGroupTabBarPortal(active);
  const actions = {
    ...createNoopEditorToolbarActions(),
    specialPageTabs: computed(() => ({ settingsOpen: pages.settingsOpen, settingsActive: settings.settingsPageActive, driverStoreOpen: pages.driverOpen, driverStoreActive: pages.driverActive, driverUpdateCount: 2 })),
    activateSettingsPage: () => {
      pages.settingsOpen = true;
      pages.driverActive = false;
      settings.settingsPageActive = true;
    },
    closeSettingsPage: () => {
      pages.settingsOpen = false;
      settings.settingsPageActive = false;
    },
    activateDriverStore: () => {
      pages.driverOpen = true;
      settings.settingsPageActive = false;
      pages.driverActive = true;
    },
    closeDriverStore: () => {
      pages.driverOpen = false;
      pages.driverActive = false;
    },
  };
  const onQuerySurface = () => {
    pages.driverActive = false;
    settings.settingsPageActive = false;
  };
  window.addEventListener("dbx:activate-query-surface", onQuerySurface);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = defineComponent({
    components: { AppTabBar, SqlEditorWorkspace, TooltipProvider },
    setup: () => ({ store, settings, pages, active, navigation, workspace, saveTab, saveAll }),
    template: `
      <TooltipProvider>
        <AppTabBar :settings-page-open="pages.settingsOpen" :settings-page-active="settings.settingsPageActive" :driver-store-open="pages.driverOpen" :driver-store-active="pages.driverActive" :tab-bar-width="navigation.width" :tab-bar-collapsed="navigation.collapsed" @save-tab="saveTab" @save-all-tab-close="saveAll">
          <div v-show="settings.settingsPageActive" data-test="settings-page"><input v-model="pages.draft" data-test="settings-input" /></div>
          <div v-show="pages.driverActive" data-test="driver-page">Drivers</div>
        </AppTabBar>
        <div v-show="!active" data-test="editor-workspace-wrapper">
          <SqlEditorWorkspace ref="workspace" :active-tab="store.tabs.find(tab => tab.id === store.activeTabId)" :show-tab-navigation="store.tabs.length > 0 || pages.settingsOpen || pages.driverOpen" active-output-view="result" :has-executable-sql="true" :format-sql-request="null" :compress-sql-request="null" :keyword-case-request="null" :block-dangerous-redis-commands="false" :tab-bar-width="navigation.width" :tab-bar-collapsed="navigation.collapsed">
            <template #empty><div data-test="welcome"><button @click="store.createTab('mysql-local', 'app', 'New query', 'query')">New query</button></div></template>
          </SqlEditorWorkspace>
        </div>
      </TooltipProvider>`,
  });
  const app = createApp(root);
  const warnings: string[] = [];
  app.config.warnHandler = (message) => warnings.push(message);
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.provide(GROUP_TAB_BAR_PORTAL, portal);
  app.provide(EDITOR_TOOLBAR_ACTIONS, actions);
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
    window.removeEventListener("dbx:activate-query-surface", onQuerySurface);
  });
  return { host, store, settings, pages, portal, actions, warnings, navigation, workspace, saveTab, saveAll };
}

function element(host: HTMLElement, selector: string): HTMLElement {
  const result = host.querySelector<HTMLElement>(selector);
  expect(result, selector).not.toBeNull();
  return result!;
}

describe("AppTabBar group navigation portal", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function mixedClose(recoveryFirst = false) {
    const mounted = mountNavigation("top");
    mounted.settings.editorSettings.confirmUnsavedSqlClose = true;
    const [sql, recovery] = mounted.store.tabs;
    sql!.originalSql = "SELECT 0";
    recovery!.originalSql = recovery!.sql;
    recovery!.typeManagementDraft = { state: "stopped" } as NonNullable<QueryTab["typeManagementDraft"]>;
    mounted.store.closeTabsByIds(recoveryFirst ? [recovery!.id, sql!.id] : [sql!.id, recovery!.id]);
    return { ...mounted, sql: sql!, recovery: recovery! };
  }

  function closeButton(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((button) => button.textContent?.trim() === label);
  }

  it("keeps the current SQL save action in a mixed TYPE recovery batch", async () => {
    const { store, sql, recovery, saveTab, saveAll } = mixedClose();
    await settle();
    expect(store.pendingCloseTabId).toBe(sql.id);
    expect(closeButton("editor.discardChanges")).toBeDefined();
    expect(closeButton("objects.typeManagementDiscardClose")).toBeUndefined();
    expect(closeButton("editor.saveAllChanges")).toBeUndefined();
    expect(document.querySelector("[role='alert']")?.textContent).toBe("objects.typeManagementCloseWarning");
    expect(closeButton("savedSql.save")).toBeDefined();
    closeButton("savedSql.save")!.click();
    await settle();
    expect(saveTab).toHaveBeenCalledExactlyOnceWith(sql.id);
    expect(saveAll).not.toHaveBeenCalled();
    expect(store.tabs.find((tab) => tab.id === recovery.id)?.typeManagementDraft).toEqual({ state: "stopped" });
    expect(sql.sql).toBe("SELECT 1");
  });

  it.each([false, true])("scopes discard controls to the pending tab (TYPE first: %s)", async (recoveryFirst) => {
    const { store, sql, recovery } = mixedClose(recoveryFirst);
    await settle();
    expect(store.pendingCloseTabId).toBe(recoveryFirst ? recovery.id : sql.id);
    expect(closeButton(recoveryFirst ? "objects.typeManagementDiscardClose" : "editor.discardChanges")).toBeDefined();
    expect(!!closeButton("savedSql.save")).toBe(!recoveryFirst);
    closeButton(recoveryFirst ? "objects.typeManagementDiscardClose" : "editor.discardChanges")!.click();
    await settle();
    expect(store.pendingCloseTabId).toBe(recoveryFirst ? sql.id : recovery.id);
    expect(closeButton(recoveryFirst ? "editor.discardChanges" : "objects.typeManagementDiscardClose")).toBeDefined();
    expect(!!closeButton("savedSql.save")).toBe(recoveryFirst);
    expect(store.tabs.map((tab) => tab.id)).toEqual([recoveryFirst ? sql.id : recovery.id]);
    if (recoveryFirst) expect(store.tabs[0]?.sql).toBe("SELECT 1");
    else expect(store.tabs[0]?.typeManagementDraft).toEqual({ state: "stopped" });
  });

  it("cancels a mixed close without discarding SQL or the TYPE recovery draft", async () => {
    const { store, sql, recovery } = mixedClose();
    await settle();
    closeButton("common.cancel")!.click();
    await settle();
    expect(store.showCloseConfirm).toBe(false);
    expect(store.tabs.map((tab) => tab.id)).toEqual([sql.id, recovery.id]);
    expect(sql.sql).toBe("SELECT 1");
    expect(recovery.typeManagementDraft).toEqual({ state: "stopped" });
  });

  it("retains Save All for a batch without unfinished TYPE recovery", async () => {
    const { store, settings, saveAll } = mountNavigation("top");
    settings.editorSettings.confirmUnsavedSqlClose = true;
    for (const tab of store.tabs) tab.originalSql = "SELECT 0";
    store.tabs[1]!.typeManagementDraft = { state: "complete" } as NonNullable<QueryTab["typeManagementDraft"]>;
    store.closeTabsByIds(store.tabs.map((tab) => tab.id));
    await settle();
    expect(closeButton("savedSql.save")).toBeDefined();
    expect(closeButton("editor.saveAllChanges")).toBeDefined();
    closeButton("editor.saveAllChanges")!.click();
    expect(saveAll).toHaveBeenCalledOnce();
  });

  it.each(["top", "bottom", "left", "right"] as const)("moves the same %s bar between query, settings and driver surfaces", async (placement) => {
    const { host, pages, warnings } = mountNavigation(placement);
    await settle();
    const bar = element(host, "[data-main-tab-bar]");
    expect(bar.dataset.placement).toBe(placement);
    element(bar, "[data-settings-page-tab]").click();
    await settle();

    expect(host.querySelectorAll("[data-main-tab-bar]")).toHaveLength(1);
    expect(element(host, "[data-special-page-tab-target='main']").contains(bar)).toBe(true);
    expect(element(host, "[data-test='editor-workspace-wrapper']").style.display).toBe("none");
    expect(element(host, "[data-special-page-workspace]").style.display).not.toBe("none");
    expect(element(bar, "[data-settings-page-tab]").dataset.activeTab).toBe("true");
    expect(bar.querySelectorAll("[data-tab-id][data-active-tab='true']")).toHaveLength(0);
    const input = element(host, "[data-test='settings-input']") as HTMLInputElement;
    input.value = "edited setting";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(pages.draft).toBe("edited setting");

    element(bar, "[data-driver-store-tab]").click();
    await settle();
    expect(element(host, "[data-main-tab-bar]")).toBe(bar);
    expect(element(bar, "[data-driver-store-tab]").dataset.activeTab).toBe("true");
    expect(element(bar, "[data-settings-page-tab]").dataset.activeTab).toBe("false");

    element(bar, "[data-tab-id='Query alpha']").click();
    await settle();
    expect(element(host, "[data-main-tab-bar]")).toBe(bar);
    expect(element(host, "[data-test='editor-workspace-wrapper']").contains(bar)).toBe(true);
    expect(element(host, "[data-special-page-workspace]").style.display).toBe("none");
    expect(element(bar, "[data-tab-id='Query alpha']").dataset.activeTab).toBe("true");
    expect(element(host, "[data-test='settings-input']")).toBe(input);
    expect(input.value).toBe("edited setting");
    expect(warnings).toEqual([]);
  });

  it("preserves the side bar search and collapsed connection group across portal moves", async () => {
    const { host, actions, warnings } = mountNavigation("left");
    await settle();
    const bar = element(host, "[data-main-tab-bar]");
    element(bar, ".tab-group-header").click();
    await settle();
    expect(element(bar, ".tab-group-header").getAttribute("aria-expanded")).toBe("false");
    const search = element(bar, "input[type='search']") as HTMLInputElement;
    search.value = "alpha";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(bar.querySelector("[data-tab-id='Query beta']")).toBeNull();
    actions.activateSettingsPage();
    await settle();
    expect(element(host, "[data-main-tab-bar]")).toBe(bar);
    expect(element(bar, "input[type='search']")).toBe(search);
    expect(search.value).toBe("alpha");
    actions.closeSettingsPage();
    await settle();
    expect(element(host, "[data-main-tab-bar]")).toBe(bar);
    expect(search.value).toBe("alpha");
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(element(bar, ".tab-group-header").getAttribute("aria-expanded")).toBe("false");
    expect(warnings).toEqual([]);
  });

  it("keeps special navigation usable with no ordinary tabs", async () => {
    const { host, actions, warnings } = mountNavigation("left", true);
    actions.activateSettingsPage();
    await settle();
    expect(host.querySelectorAll("[data-main-tab-bar]")).toHaveLength(1);
    expect(host.querySelectorAll("[data-tab-id]")).toHaveLength(0);
    expect(element(host, "[data-special-page-tab-target='main'] [data-settings-page-tab]").dataset.activeTab).toBe("true");
    element(host, "[data-driver-store-tab]").click();
    await settle();
    expect(element(host, "[data-driver-store-tab]").dataset.activeTab).toBe("true");
    expect(warnings).toEqual([]);
  });

  it.each(["top", "bottom", "left", "right"] as const)("shows welcome after the last query closes while retaining %s special tabs", async (placement) => {
    const { host, store, pages, actions, warnings } = mountNavigation(placement);
    await settle();
    actions.activateSettingsPage();
    await settle();
    element(host, "[data-tab-id='Query alpha']").click();
    await settle();
    const tabIds = store.tabs.map((tab) => tab.id);
    for (const id of tabIds) store.closeTab(id, { force: true });
    await settle();
    const wrapper = element(host, "[data-test='editor-workspace-wrapper']");
    expect(wrapper.style.display).not.toBe("none");
    expect(wrapper.querySelectorAll("[data-test='welcome']")).toHaveLength(1);
    expect(wrapper.querySelectorAll("[data-settings-page-tab]")).toHaveLength(1);
    expect(wrapper.querySelectorAll("[data-driver-store-tab]")).toHaveLength(1);
    expect(wrapper.querySelector("[data-shared-result-surface]")).toBeNull();

    element(wrapper, "[data-settings-page-tab]").click();
    await settle();
    expect(wrapper.style.display).toBe("none");
    actions.closeSettingsPage();
    actions.closeDriverStore();
    await settle();
    expect(wrapper.style.display).not.toBe("none");
    expect(wrapper.querySelectorAll("[data-test='welcome']")).toHaveLength(1);
    expect(host.querySelector("[data-main-tab-bar]")).toBeNull();
    expect(element(host, "[data-workspace-tab-navigation]").style.display).toBe("none");
    expect(pages.settingsOpen || pages.driverOpen).toBe(false);

    element(wrapper, "[data-test='welcome'] button").click();
    await settle();
    expect(store.tabs).toHaveLength(1);
    expect(wrapper.querySelector("[data-test='welcome']")).toBeNull();
    expect(wrapper.querySelector("[data-test='query-editor']")).not.toBeNull();
    expect(host.querySelectorAll("[data-main-tab-bar]")).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("registers and removes portal targets as editor groups change while settings is open", async () => {
    const { host, store, portal, actions, warnings } = mountNavigation("left");
    actions.activateSettingsPage();
    await settle();
    store.tabs.push(queryTab("Query gamma", "postgres-local"));
    store.groups.push({ id: "secondary", tabIds: ["Query gamma"], activeTabId: "Query gamma" });
    store.sizes = [50, 50];
    await settle();
    expect(portal.targets.size).toBe(2);
    expect(host.querySelectorAll("[data-main-tab-bar]")).toHaveLength(2);
    expect(element(host, "[data-special-page-tab-target='secondary'] [data-main-tab-bar]").dataset.groupId).toBe("secondary");
    store.groups = store.groups.filter((group) => group.id !== "secondary");
    store.tabs = store.tabs.filter((tab) => tab.id !== "Query gamma");
    store.sizes = [100];
    await settle();
    expect(portal.targets.has("secondary")).toBe(false);
    expect(host.querySelectorAll("[data-main-tab-bar]")).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it.each(["left", "right"] as const)("keeps the same %s navigation outside the results split throughout query execution", async (placement) => {
    const { host, store, workspace, actions, warnings } = mountNavigation(placement);
    await settle();
    const bar = element(host, "[data-main-tab-bar]");
    const rail = element(host, "[data-workspace-tab-navigation]");
    const target = element(rail, "[data-workspace-tab-target='main']");
    const content = element(host, "[data-workspace-content]");
    expect(target.contains(bar)).toBe(true);
    expect(rail.parentElement).toBe(content.parentElement);
    expect(content.contains(rail)).toBe(false);
    expect(content.querySelector("[data-shared-result-surface]")).toBeNull();

    store.tabs[0]!.isExecuting = true;
    await settle();
    expect(content.querySelector("[data-shared-result-surface]")).not.toBeNull();
    store.tabs[0]!.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    store.tabs[0]!.isExecuting = false;
    await settle();
    expect(element(host, "[data-workspace-tab-target='main']")).toBe(target);
    expect(element(target, "[data-main-tab-bar]")).toBe(bar);
    expect(rail.querySelector("[data-shared-result-surface]")).toBeNull();

    expect(workspace.value!.toggleResultsPane()).toBe(true);
    await settle();
    await vi.waitFor(() => expect(content.querySelector("[data-shared-result-surface]")).toBeNull());
    expect(element(target, "[data-main-tab-bar]")).toBe(bar);
    expect(workspace.value!.toggleResultsPane()).toBe(true);
    await settle();
    expect(content.querySelector("[data-shared-result-surface]")).not.toBeNull();
    expect(element(host, "[data-workspace-tab-target='main']")).toBe(target);
    expect(element(target, "[data-main-tab-bar]")).toBe(bar);

    actions.activateSettingsPage();
    await settle();
    expect(element(host, "[data-special-page-tab-target='main']").contains(bar)).toBe(true);
    element(bar, "[data-tab-id='Query alpha']").click();
    await settle();
    expect(element(target, "[data-main-tab-bar]")).toBe(bar);
    expect(content.querySelector("[data-shared-result-surface]")).not.toBeNull();
    expect(warnings).toEqual([]);
  });

  it.each(["left", "right"] as const)("returns the %s rail bar to its original editor group for horizontal placements", async (placement) => {
    const { host, settings, warnings } = mountNavigation(placement);
    await settle();
    const bar = element(host, "[data-workspace-tab-target='main'] [data-main-tab-bar]");
    for (const horizontal of ["top", "bottom"] as const) {
      settings.editorSettings.tabPlacement = horizontal;
      await settle();
      expect(element(host, ".editor-group[data-group-id='main']").contains(bar)).toBe(true);
      expect(bar.dataset.placement).toBe(horizontal);
      expect(host.querySelectorAll("[data-main-tab-bar]")).toHaveLength(1);
      settings.editorSettings.tabPlacement = placement;
      await settle();
      expect(element(host, "[data-workspace-tab-target='main']").contains(bar)).toBe(true);
    }
    expect(warnings).toEqual([]);
  });

  it("moves a horizontal bar to the workspace rail after settings releases its portal", async () => {
    const { host, settings, actions, warnings } = mountNavigation("top");
    await settle();
    const bar = element(host, ".editor-group[data-group-id='main'] [data-main-tab-bar]");

    actions.activateSettingsPage();
    await settle();
    expect(element(host, "[data-special-page-tab-target='main']").contains(bar)).toBe(true);

    actions.closeSettingsPage();
    await settle();
    expect(element(host, ".editor-group[data-group-id='main']").contains(bar)).toBe(true);

    settings.editorSettings.tabGroupMode = "database-type";
    settings.editorSettings.tabPlacement = "left";
    await settle();

    expect(element(host, "[data-workspace-tab-target='main']").contains(bar)).toBe(true);
    expect(element(host, "[data-special-page-workspace]").style.display).toBe("none");
    expect(warnings).toEqual([]);
  });

  it.each(["left", "right"] as const)("synchronizes %s rail width and collapse with the persistent bar", async (placement) => {
    const { host, navigation, warnings } = mountNavigation(placement);
    await settle();
    const rail = element(host, "[data-workspace-tab-navigation]");
    const bar = element(rail, "[data-main-tab-bar]");
    expect(rail.style.width).toBe("260px");
    expect(bar.style.width).toBe("100%");
    navigation.width = 320;
    await settle();
    expect(rail.style.width).toBe("320px");
    expect(bar.style.width).toBe("100%");
    navigation.collapsed = true;
    await settle();
    expect(rail.style.width).toBe("var(--collapsed-tab-rail-width)");
    expect(bar.style.width).toBe("100%");
    expect(element(rail, "[data-main-tab-bar]")).toBe(bar);
    navigation.collapsed = false;
    await settle();
    expect(rail.style.width).toBe("320px");
    expect(bar.style.width).toBe("100%");
    expect(warnings).toEqual([]);
  });

  it("preserves each group's bar and tab ownership across workspace and special-page rails", async () => {
    const { host, store, actions, warnings } = mountNavigation("left");
    store.tabs.push(queryTab("Query gamma", "postgres-local"));
    store.groups.push({ id: "secondary", tabIds: ["Query gamma"], activeTabId: "Query gamma" });
    store.sizes = [50, 50];
    await settle();
    const main = element(host, "[data-workspace-tab-target='main'] [data-main-tab-bar]");
    const secondary = element(host, "[data-workspace-tab-target='secondary'] [data-main-tab-bar]");
    const originalGroups = store.groups.map((group) => ({ id: group.id, tabIds: [...group.tabIds], activeTabId: group.activeTabId }));
    actions.activateSettingsPage();
    await settle();
    expect(element(host, "[data-special-page-tab-target='main']").contains(main)).toBe(true);
    expect(element(host, "[data-special-page-tab-target='secondary']").contains(secondary)).toBe(true);
    actions.closeSettingsPage();
    await settle();
    expect(element(host, "[data-workspace-tab-target='main']").contains(main)).toBe(true);
    expect(element(host, "[data-workspace-tab-target='secondary']").contains(secondary)).toBe(true);
    expect(main.querySelector("[data-tab-id='Query gamma']")).toBeNull();
    expect(secondary.querySelector("[data-tab-id='Query alpha']")).toBeNull();
    expect(store.groups).toEqual(originalGroups);
    expect(store.focusedGroupId).toBe("main");
    expect(host.querySelectorAll("[data-main-tab-bar]")).toHaveLength(2);
    expect(warnings).toEqual([]);
  });
});
