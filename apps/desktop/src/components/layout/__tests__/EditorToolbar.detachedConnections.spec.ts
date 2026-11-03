// @vitest-environment happy-dom
// Real detached-store initialization and Toolbar/ConnectionTreeSelect regression.
// Native I/O is represented by an in-memory shared backend; no native GUI is tested.
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const backend = vi.hoisted(() => ({
  saved: [
    { id: "A", name: "Main MySQL A", db_type: "mysql", host: "127.0.0.1", port: 3306, username: "fixture", password: "fixture", save_password: true },
    { id: "B", name: "Main MySQL B", db_type: "mysql", host: "127.0.0.1", port: 3307, username: "fixture", password: "fixture", save_password: true },
  ] as ConnectionConfig[],
  open: new Set<string>(),
  prewarm: vi.fn(async () => {}),
  isOpen: vi.fn(async (id: string) => backend.open.has(id)),
  listeners: new Map<string, (event: { payload: unknown }) => Promise<void>>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => Promise<void>) => {
    backend.listeners.set(name, callback);
    return () => backend.listeners.delete(name);
  }),
}));

// Keep EditorToolbar, ConnectionTreeSelect, its search/tree builder, and Pinia
// real. Only presentation wrappers are replaced, so popover rows stay available
// in happy-dom without relying on overlay geometry or animation timing.
vi.mock("@/components/ui/button", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return { Button: createPassthroughStub("Button", "button") };
});
vi.mock("@/components/ui/popover", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return {
    Popover: createPassthroughStub("Popover"),
    PopoverContent: createPassthroughStub("PopoverContent"),
    PopoverTrigger: createPassthroughStub("PopoverTrigger"),
  };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return {
    Tooltip: createPassthroughStub("Tooltip"),
    TooltipTrigger: createPassthroughStub("TooltipTrigger"),
    TooltipContent: createPassthroughStub("TooltipContent"),
  };
});
vi.mock("@/components/ui/LightTooltip.vue", async () => {
  const { createPassthroughStub } = await import("@/components/grid/__tests__/vueHostHarness");
  return { default: createPassthroughStub("LightTooltip") };
});
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: { template: "<span />" } }));
vi.mock("@/components/icons/DatabaseIcon.vue", () => ({ default: { template: "<span />" } }));
vi.mock("@/components/plugins/PluginIcon.vue", () => ({ default: { template: "<span />" } }));
vi.mock("@/components/common/ProductionContextBadge.vue", () => ({ default: { template: "<span />" } }));
vi.mock("@/lib/backend/api", () => ({
  loadEditorSettings: vi.fn(async () => null),
  saveEditorSettings: vi.fn(async () => {}),
  loadConnections: vi.fn(async () => structuredClone(backend.saved)),
  saveConnections: vi.fn(async () => {}),
  loadPinnedTreeNodeIds: vi.fn(async () => []),
  savePinnedTreeNodeIds: vi.fn(async () => {}),
  loadTunnelProfiles: vi.fn(async () => []),
  loadTableVGroups: vi.fn(async () => ({})),
  saveTableVGroups: vi.fn(async () => {}),
  loadSidebarLayout: vi.fn(async () => null),
  saveSidebarLayout: vi.fn(async () => {}),
  loadSchemaCache: vi.fn(async () => null),
  saveSchemaCache: vi.fn(async () => {}),
  connectDb: vi.fn(async (config: ConnectionConfig) => {
    backend.open.add(config.id);
    return config.id;
  }),
  checkConnectionHealth: vi.fn(async () => {}),
  connectionDatabaseInfo: vi.fn(async () => undefined),
  connectionIdentifierQuote: vi.fn(async () => "`"),
  sessionCredentialStatus: vi.fn(async () => true),
  listInstalledAgents: vi.fn(async () => []),
  connectionIsOpen: backend.isOpen,
  prewarmConnection: backend.prewarm,
  loadSavedSqlLibrary: vi.fn(async () => ({ folders: [], files: [] })),
  loadSavedSqlEditorPositions: vi.fn(async () => []),
  saveSavedSqlEditorPositions: vi.fn(async () => {}),
  saveTabs: vi.fn(async () => {}),
  saveOpenTabsState: vi.fn(async () => {}),
  saveDetachedTabHandoff: vi.fn(async () => {}),
  loadOpenTabsState: vi.fn(async () => null),
}));

const piniaInstances: Pinia[] = [];
const mountedApps: App[] = [];
function freshPinia() {
  const pinia = createPinia();
  piniaInstances.push(pinia);
  setActivePinia(pinia);
  return pinia;
}

beforeEach(() => {
  vi.resetModules();
  document.body.replaceChildren();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  // Runtime marker only: all native backend calls above are mocked, not stores.
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  backend.saved.splice(2);
  backend.open.clear();
  backend.prewarm.mockClear();
  backend.isOpen.mockClear();
  backend.listeners.clear();
});
afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  for (const pinia of piniaInstances.splice(0)) disposePinia(pinia);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("hydrates established connections into a detached store and refreshes changes when its picker opens", async () => {
  // Main window's real connection establishment and real handoff serializer.
  freshPinia();
  const { useConnectionStore: useMainConnectionStore } = await import("@/stores/connectionStore");
  const { useQueryStore: useMainQueryStore } = await import("@/stores/queryStore");
  const main = useMainConnectionStore();
  await main.initFromDisk();
  await main.connect(main.getConfig("A")!);
  await main.connect(main.getConfig("B")!);
  expect([...main.connectedIds]).toEqual(["A", "B"]);
  const mainQuery = useMainQueryStore();
  const tabId = mainQuery.createTab("A", "demo", "Detached SQL", "query", undefined, "SELECT 1");
  const handoff = await mainQuery.prepareDetachedTab(tabId);
  await mainQuery.flushPendingPersist();
  expect(handoff.sourceWindowLabel).toBe("main");

  // A second webview has separate modules/Pinia. Retain the shared mock backend.
  vi.resetModules();
  window.history.replaceState({}, "", `/?dbxDetachedTab=${encodeURIComponent(tabId)}`);
  const childPinia = freshPinia();
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useQueryStore } = await import("@/stores/queryStore");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  const { resolveWindowContext } = await import("@/lib/app/windowContext");
  const child = useConnectionStore();
  const childQuery = useQueryStore();
  // Match App.vue initDetachedWindow, using the real implementations.
  await useSettingsStore().initEditorSettings();
  await child.initFromDisk();
  await childQuery.adoptDetachedTab(JSON.parse(JSON.stringify(handoff)));
  await childQuery.hydrateSavedSqlTabs();
  expect(resolveWindowContext().kind).toBe("detached-tab");
  expect(childQuery.groups[0].activeTabId).toBe(tabId);
  const activeTab = childQuery.tabs.find((tab) => tab.id === tabId)!;
  expect(activeTab.connectionId).toBe("A");

  // App refreshes the detached connection snapshot in the background after handoff.
  await child.refreshConnectedConnections();
  expect([...child.connectedIds]).toEqual(["A", "B"]);

  // Opening the picker also refreshes connections created after detaching.
  backend.saved.push({ ...backend.saved[0], id: "C", name: "Main MySQL C" });
  backend.open.add("C");
  backend.open.delete("B");

  // Existing warm-up remains independent of the read-only picker refresh.
  child.warmConnection("A", { database: activeTab.database });
  await child.handleConnectionLivenessMessage({ kind: "resync" });

  const Toolbar = (await import("../EditorToolbar.vue")).default;
  const toolbar = ref<any>();
  const selected: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    setup: () => () =>
      h(Toolbar, {
        ref: toolbar,
        activeTab,
        activeConnection: child.getConfig(activeTab.connectionId),
        hasExecutableSql: true,
        executableSqlMayContainDml: false,
        sqlKeywordCase: "preserve",
        onChangeConnection: (id: string) => selected.push(id),
      }),
  });
  app.use(childPinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  mountedApps.push(app);
  app.mount(host);
  await nextTick();
  expect(toolbar.value.openConnectionPicker()).toBe(true);
  await nextTick();
  await nextTick();
  const rows = () => [...host.querySelectorAll<HTMLElement>("[data-picker-connection]")].map((el) => el.dataset.pickerConnection);
  await vi.waitFor(() => expect(rows()).toEqual(["A", "C"]));
  expect(child.connections.map((connection) => connection.id)).toEqual(["A", "B", "C"]);
  expect(activeTab.connectionId).toBe("A");
  host.querySelector<HTMLButtonElement>('[data-picker-connection="C"]')!.click();
  await nextTick();
  expect(selected).toEqual(["C"]);
  expect(activeTab.connectionId).toBe("A");
  // No synchronization path may reconnect B or establish a new pool itself.
  expect([...backend.open]).toEqual(["A", "C"]);
  const api = await import("@/lib/backend/api");
  expect(vi.mocked(api.connectDb).mock.calls.map(([config]) => config.id)).toEqual(["A", "B"]);
}, 60000);

it("updates an already-open detached picker on SSH transport changes and ignores a stale disconnect", async () => {
  window.history.replaceState({}, "", "/?dbxDetachedTab=ssh-picker");
  backend.saved.push({ ...backend.saved[0], id: "SSH", name: "SSH server", db_type: "plugin", plugin_id: "io.dbx.ssh", plugin_connection_provider: "ssh", plugin_connection_type: "ssh" });
  backend.open.add("A");
  backend.open.add("SSH");
  const childPinia = freshPinia();
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useQueryStore } = await import("@/stores/queryStore");
  const { subscribePluginConnectionStateChanges } = await import("@/lib/connection/connectionStateEvents");
  const child = useConnectionStore();
  await child.initFromDisk();
  await child.refreshConnectedConnections();
  // App registers this shared subscription in both main and detached windows.
  const stop = await subscribePluginConnectionStateChanges(child.getConfig, () => child.refreshConnectedConnections());
  const childQuery = useQueryStore();
  const tabId = childQuery.createTab("A", "demo", "Query", "query", undefined, "SELECT 1");
  const activeTab = childQuery.tabs.find((tab) => tab.id === tabId)!;
  const Toolbar = (await import("../EditorToolbar.vue")).default;
  const toolbar = ref<any>();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    setup: () => () => h(Toolbar, { ref: toolbar, activeTab, activeConnection: child.getConfig("A"), hasExecutableSql: true, executableSqlMayContainDml: false, sqlKeywordCase: "preserve" }),
  });
  app.use(childPinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  mountedApps.push(app);
  app.mount(host);
  await nextTick();
  expect(toolbar.value.openConnectionPicker()).toBe(true);
  await nextTick();
  await child.refreshConnectedConnections();
  await nextTick();
  const rows = () => [...host.querySelectorAll<HTMLElement>("[data-picker-connection]")].map((el) => el.dataset.pickerConnection);
  expect(rows()).toEqual(["A", "SSH"]);
  const api = await import("@/lib/backend/api");
  vi.mocked(api.connectDb).mockClear();
  const transportEvent = (state: string) => ({ payload: { pluginId: "io.dbx.ssh", method: "ssh/session/state", params: { connectionId: "SSH", state } } });
  const receive = backend.listeners.get("dbx-plugin-event")!;

  // A delayed disconnect from an older session must not hide its replacement.
  await receive(transportEvent("disconnected"));
  await nextTick();
  expect(rows()).toEqual(["A", "SSH"]);

  // No close/reopen: the native event removes the actually disconnected entry.
  backend.open.delete("SSH");
  await receive(transportEvent("disconnected"));
  await nextTick();
  expect(rows()).toEqual(["A"]);
  expect(child.establishedConnectionIds.has("SSH")).toBe(false);

  backend.open.add("SSH");
  await receive(transportEvent("connected"));
  await nextTick();
  expect(rows()).toEqual(["A", "SSH"]);
  expect(api.connectDb).not.toHaveBeenCalled();
  expect(activeTab.connectionId).toBe("A");
  stop();
}, 60000);
