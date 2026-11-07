// @vitest-environment happy-dom
import { createApp, h, nextTick, reactive, ref, type App } from "vue";
import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EditorToolbar from "../EditorToolbar.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const { connectionIsOpen, connectionIdentifierQuote } = vi.hoisted(() => ({ connectionIsOpen: vi.fn(), connectionIdentifierQuote: vi.fn() }));

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
  connectionIsOpen,
  connectionIdentifierQuote,
  loadSavedSqlLibrary: vi.fn(async () => ({ folders: [], files: [] })),
  saveSavedSqlEditorPositions: vi.fn(async () => {}),
  saveTabs: vi.fn(async () => {}),
}));

let pinia: Pinia;
const mountedApps: App[] = [];

function config(id: string, name: string): ConnectionConfig {
  return { id, name, db_type: "mysql", host: "localhost", port: 3306, username: "root", password: "" };
}

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  disposePinia(pinia);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

async function mountToolbar(connectedIds = ["primary", "secondary"]) {
  const store = useConnectionStore();
  store.connections = [config("primary", "Primary MySQL"), config("offline", "Offline reporting"), config("secondary", "Secondary MySQL"), config("archive", "Archived database")];
  store.connectedIds = new Set(connectedIds);
  store.sidebarLayout = {
    groups: [
      { id: "production", name: "Production", collapsed: false },
      { id: "archive-group", name: "Archive", collapsed: false },
    ],
    order: [
      {
        type: "group",
        id: "production",
        children: [
          { type: "connection", id: "primary" },
          { type: "connection", id: "offline" },
        ],
      },
      { type: "group", id: "archive-group", children: [{ type: "connection", id: "archive" }] },
    ],
  };
  const ensureConnected = vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
  const activeTab = reactive<QueryTab>({ id: "query", title: "Query", connectionId: "primary", database: "demo", sql: "SELECT 1", mode: "query", isExecuting: false, isCancelling: false, isExplaining: false });
  const toolbar = ref<InstanceType<typeof EditorToolbar>>();
  const onChangeConnection = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    setup: () => () => h(EditorToolbar, { ref: toolbar, activeTab, activeConnection: store.getConfig(activeTab.connectionId), hasExecutableSql: true, executableSqlMayContainDml: false, sqlKeywordCase: "preserve", onChangeConnection }),
  });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  mountedApps.push(app);
  app.mount(host);
  await nextTick();
  expect(toolbar.value?.openConnectionPicker()).toBe(true);
  await nextTick();
  await nextTick();

  const pickerRows = () => [...host.querySelectorAll<HTMLButtonElement>("[data-picker-connection]")].map((button) => button.dataset.pickerConnection);
  const picker = () => host.querySelector<HTMLElement>(".dbx-connection-tree-select-list")!;
  const trigger = () => host.querySelector<HTMLButtonElement>('[data-stub="PopoverTrigger"] button')!;
  const search = async (text: string) => {
    const input = host.querySelector<HTMLInputElement>("input")!;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await nextTick();
    return input;
  };
  return { store, activeTab, onChangeConnection, ensureConnected, host, pickerRows, picker, trigger, search };
}

describe("EditorToolbar connected connection picker", () => {
  it("lists a backend-open connection even when its default database's dialect is unavailable", async () => {
    const { store, host, pickerRows, onChangeConnection, ensureConnected } = await mountToolbar([]);
    store.connections = store.connections.map((connection) => (connection.id === "secondary" ? { ...connection, db_type: "opengauss" } : connection));
    connectionIsOpen.mockImplementation(async (id: string) => id === "secondary");
    connectionIdentifierQuote.mockRejectedValue(new Error("Connection pool is not open: secondary"));

    await store.refreshConnectedConnections();
    await nextTick();
    expect(pickerRows()).toEqual(["secondary"]);
    expect(store.connectedIds.has("secondary")).toBe(false);
    host.querySelector<HTMLButtonElement>('[data-picker-connection="secondary"]')!.click();
    await nextTick();
    expect(onChangeConnection).toHaveBeenCalledExactlyOnceWith("secondary");
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it("lists only connected entries, retains their groups, and emits the original selection event", async () => {
    const { host, pickerRows, onChangeConnection, activeTab, ensureConnected } = await mountToolbar();
    expect(pickerRows()).toEqual(["primary", "secondary"]);
    expect(host.querySelector('[data-picker-group="production"]')?.textContent).toContain("Production");
    expect(host.querySelector('[data-picker-group="archive-group"]')).toBeNull();
    expect(onChangeConnection).not.toHaveBeenCalled();

    host.querySelector<HTMLButtonElement>('[data-picker-connection="secondary"]')!.click();
    await nextTick();
    expect(onChangeConnection).toHaveBeenCalledExactlyOnceWith("secondary");
    expect(activeTab.connectionId).toBe("primary");
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it("reacts to connect and disconnect without changing the bound tab or losing its connection name", async () => {
    const { store, activeTab, pickerRows, trigger, onChangeConnection, ensureConnected } = await mountToolbar();
    store.connectedIds.delete("primary");
    store.connectedIds.add("offline");
    await nextTick();

    expect(pickerRows()).toEqual(["offline", "secondary"]);
    expect(trigger().textContent).toContain("Primary MySQL");
    expect(activeTab.connectionId).toBe("primary");
    expect(onChangeConnection).not.toHaveBeenCalled();

    store.connectedIds = new Set(["primary"]);
    await nextTick();
    expect(pickerRows()).toEqual(["primary"]);
    expect(activeTab.connectionId).toBe("primary");
    expect(onChangeConnection).not.toHaveBeenCalled();
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it("cannot reveal or select disconnected entries through connection-name or group search", async () => {
    const { search, pickerRows, picker, onChangeConnection } = await mountToolbar();
    for (const text of ["Offline reporting", "Archive"]) {
      const input = await search(text);
      expect(pickerRows()).toEqual([]);
      expect(picker().textContent).toContain("grid.noSearchResults");
      expect(picker().textContent).not.toContain("editor.noConnectedConnections");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await nextTick();
      expect(onChangeConnection).not.toHaveBeenCalled();
    }
    const input = await search("Secondary");
    expect(pickerRows()).toEqual(["secondary"]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await nextTick();
    expect(onChangeConnection).toHaveBeenCalledExactlyOnceWith("secondary");
  });

  it("shows the no-connected-connections state while preserving a disconnected tab's label", async () => {
    const { activeTab, pickerRows, picker, trigger, search, onChangeConnection, ensureConnected } = await mountToolbar([]);
    expect(pickerRows()).toEqual([]);
    expect(picker().textContent).toContain("editor.noConnectedConnections");
    expect(picker().textContent).not.toContain("grid.noSearchResults");
    expect(trigger().textContent).toContain("Primary MySQL");
    const input = await search("Primary");
    expect(pickerRows()).toEqual([]);
    expect(picker().textContent).toContain("editor.noConnectedConnections");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await nextTick();
    expect(activeTab.connectionId).toBe("primary");
    expect(onChangeConnection).not.toHaveBeenCalled();
    expect(ensureConnected).not.toHaveBeenCalled();
  });
});
