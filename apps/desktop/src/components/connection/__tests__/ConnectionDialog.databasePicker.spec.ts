// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { loadLocaleMessages, type Locale } from "@/i18n";
import type { InstalledPlugin } from "@/types/database";
import { CONNECTION_PICKER_VIEW_STORAGE_KEY } from "@/lib/connection/connectionPickerViewPreference";

const { store, settings, backend } = vi.hoisted(() => ({
  store: {
    connectionGroupOptions: [],
    newConnectionGroupId: null,
    selectedConnectionGroupId: null,
    addConnection: vi.fn(),
    updateConnection: vi.fn(),
    connect: vi.fn(),
    ensureConnected: vi.fn(),
    addEphemeralConnection: vi.fn(),
    removeConnection: vi.fn(),
    startEditing: vi.fn(),
    stopEditing: vi.fn(),
    clearConnectionError: vi.fn(),
    updateConnectionDatabaseInfo: vi.fn(),
    applyGlobalTimeouts: vi.fn((config) => config),
    getConfig: vi.fn(),
  },
  settings: {
    editorSettings: { sidebarShowConnectionNotes: false, globalConnectTimeoutSecs: 10, globalQueryTimeoutSecs: 0 },
    rememberedDatabaseForConnection: vi.fn(() => ""),
    persistEditorSettings: vi.fn(),
    updateEditorSettings: vi.fn(),
    updateEditorSettingsAndPersist: vi.fn(),
  },
  backend: {
    connectDb: vi.fn(),
    disconnectDb: vi.fn(),
    testConnectionWithInfo: vi.fn(),
    listDatabases: vi.fn(),
    listPlugins: vi.fn(),
    listJdbcDrivers: vi.fn(),
    listJdbcMavenBundles: vi.fn(),
    listJdbcLocalBundles: vi.fn(),
    listSshConfigHosts: vi.fn(),
    listInstalledAgentsLocal: vi.fn(),
    listenAgentInstallProgress: vi.fn(),
  },
}));

vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => store, CONNECTION_ATTEMPT_CANCELLED_MESSAGE: "cancelled" }));
vi.mock("@/stores/settingsStore", async (original) => ({ ...(await original<typeof import("@/stores/settingsStore")>()), useSettingsStore: () => settings }));
vi.mock("@/stores/tunnelProfileStore", () => ({ useTunnelProfileStore: () => ({ profiles: [], profileById: () => undefined, init: vi.fn() }) }));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...backend }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup:
      (_props, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  const Dialog = defineComponent({
    props: { open: Boolean },
    emits: ["update:open"],
    setup:
      (props, { slots, emit }) =>
      () =>
        props.open ? h("section", [h("button", { "data-testid": "dismiss-dialog", onClick: () => emit("update:open", false) }, "Dismiss"), slots.default?.()]) : null,
  });
  return { Dialog, DialogContent: passthrough, DialogHeader: passthrough, DialogTitle: passthrough, DialogFooter: passthrough };
});
vi.mock("@/components/ui/button", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Button: defineComponent({
      inheritAttrs: false,
      setup:
        (_props, { attrs, slots }) =>
        () =>
          h("button", attrs, slots.default?.()),
    }),
  };
});
vi.mock("@/components/ui/input", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    Input: defineComponent({
      props: ["modelValue"],
      emits: ["update:modelValue"],
      setup:
        (props, { attrs, emit }) =>
        () =>
          h("input", { ...attrs, value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) }),
    }),
  };
});
vi.mock("@/components/ui/PasswordInput.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: ["modelValue"],
      setup:
        (props, { attrs }) =>
        () =>
          h("input", { ...attrs, type: "password", value: props.modelValue }),
    }),
  };
});
vi.mock("@/components/ui/tabs", async () => {
  const { defineComponent, h } = await import("vue");
  const pass = defineComponent({
    setup:
      (_props, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  const TabsContent = defineComponent({
    props: ["value"],
    setup:
      (props, { slots }) =>
      () =>
        props.value === "connection" ? h("div", slots.default?.()) : null,
  });
  return { Tabs: pass, TabsContent, TabsList: pass, TabsTrigger: pass };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { defineComponent, h } = await import("vue");
  const pass = defineComponent({
    setup:
      (_props, { slots }) =>
      () =>
        h("span", slots.default?.()),
  });
  return { HelpTooltip: pass, Tooltip: pass, TooltipContent: pass, TooltipTrigger: pass };
});

import ConnectionDialog from "@/components/connection/ConnectionDialog.vue";

const mountedApps: App[] = [];
const localizedAllLabels: Array<[Locale, string]> = [
  ["az", "Hamısı"],
  ["en", "All"],
  ["es", "Todas"],
  ["it", "Tutti"],
  ["ja", "すべて"],
  ["ko", "전체"],
  ["pt-BR", "Todos"],
  ["ru", "Все"],
  ["tr", "Tümü"],
  ["zh-CN", "全部"],
  ["zh-TW", "全部"],
];
const categoryNames = ["Relational", "Analytics", "Chinese DBs", "Lightweight", "Docs/Cache/Search", "Graph/Vector", "Time series", "Message queues", "Registry/Config"];

async function settle() {
  for (let i = 0; i < 8; i++) await nextTick();
}

async function mountDialog(initiallyOpen = true) {
  const props = reactive({ open: initiallyOpen });
  const updates: boolean[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(ConnectionDialog, {
          ...props,
          "onUpdate:open": (value: boolean) => {
            updates.push(value);
            props.open = value;
          },
        }),
    }),
  );
  app.use(i18n);
  mountedApps.push(app);
  app.mount(container);
  await settle();
  return { props, updates };
}

function navButtons() {
  return [...document.querySelectorAll<HTMLButtonElement>("[data-connection-category-nav] button")];
}

function currentCategory() {
  return navButtons()
    .find((button) => button.getAttribute("aria-current") === "page")
    ?.textContent?.trim();
}

function pickerButtons() {
  return [...document.querySelectorAll<HTMLButtonElement>(".connection-db-picker-results section button")];
}

function pickerName(button: HTMLButtonElement) {
  if (button.title) return button.title;
  const text = button.textContent?.trim() ?? "";
  const category = button.closest("section")?.querySelector("h3")?.textContent?.trim();
  // List results also expose their category as visible secondary text.
  return category && text.endsWith(category) ? text.slice(0, -category.length).trim() : text;
}

function pickerNames() {
  return pickerButtons().map(pickerName);
}

function selectedNames() {
  return pickerButtons()
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map(pickerName);
}

function buttonNamed(name: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name);
  expect(button, `Expected a visible button named ${name}`).toBeTruthy();
  return button!;
}

async function clickNamed(name: string) {
  buttonNamed(name).click();
  await settle();
}

async function selectDatabase(name: string, doubleClick = false) {
  const button = pickerButtons().find((candidate) => pickerName(candidate) === name);
  expect(button, `Expected a visible database named ${name}`).toBeTruthy();
  button!.click();
  if (doubleClick) button!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await settle();
}

function searchInput() {
  const input = document.querySelector<HTMLInputElement>("[data-connection-db-search]");
  expect(input).toBeTruthy();
  return input!;
}

async function search(value: string) {
  const input = searchInput();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

function pluginFixture(id = "io.test.picker", labels = ["Test warehouse"]): InstalledPlugin {
  return {
    compatibility: { compatible: true },
    manifest: {
      id,
      name: "Picker fixture",
      icon: "https://example.test/plugin.svg",
      drivers: [],
      contributions: labels.map((label, index) => ({ type: "connection-provider", id: `provider-${index}`, label, database_type: "fixture", fields: [] })),
    },
  };
}

// Compile the lazy language bundles before timed interaction tests. This also
// prevents a slow import from one test changing the locale of the next test.
beforeAll(async () => {
  await Promise.all(localizedAllLabels.map(([locale]) => loadLocaleMessages(locale)));
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  i18n.global.locale.value = "en";
  for (const fn of Object.values(backend)) fn.mockResolvedValue([]);
  backend.listenAgentInstallProgress.mockResolvedValue(() => {});
  store.updateConnection.mockResolvedValue(undefined);
  store.addConnection.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("ConnectionDialog database picker", () => {
  it("opens on All with the complete catalog grouped in the established category order", async () => {
    backend.listPlugins.mockResolvedValue([pluginFixture()]);
    await mountDialog();

    expect(currentCategory()).toBe("All");
    expect(navButtons().map((button) => button.textContent?.trim())).toEqual(["All", ...categoryNames, "Plugins"]);
    expect([...document.querySelectorAll(".connection-db-picker-results h3")].map((heading) => heading.textContent)).toEqual([...categoryNames, "Plugins"]);
    expect(pickerNames()).toEqual(expect.arrayContaining(["MySQL", "PostgreSQL", "Redis", "SQLite", "Apache Ignite", "Test warehouse"]));
    expect(selectedNames()).toEqual(["MySQL"]);
    expect(buttonNamed("Next").disabled).toBe(false);
    expect(backend.connectDb).not.toHaveBeenCalled();
    expect(store.addConnection).not.toHaveBeenCalled();
  });

  it("renders exactly the ordered union of individual categories, without duplicate entries", async () => {
    backend.listPlugins.mockResolvedValue([pluginFixture()]);
    await mountDialog();
    const allNames = pickerNames();
    const individualNames: string[] = [];
    for (const category of [...categoryNames, "Plugins"]) {
      await clickNamed(category);
      expect(currentCategory()).toBe(category);
      const names = pickerNames();
      expect(names.length).toBeGreaterThan(0);
      individualNames.push(...names);
    }
    await clickNamed("All");

    expect(pickerNames()).toEqual(allNames);
    expect(allNames).toEqual(individualNames);
    expect(new Set(allNames).size).toBe(allNames.length);
    expect(allNames.filter((name) => name.includes("Ignite"))).toEqual(["Apache Ignite"]);
    expect(allNames.filter((name) => name.includes("InfluxDB"))).toEqual(["InfluxDB"]);
  });

  it("preserves the entire catalog, selection and All navigation when switching grid and list", async () => {
    backend.listPlugins.mockResolvedValue([pluginFixture()]);
    await mountDialog();
    const allNames = pickerNames();
    await selectDatabase("Redis");
    expect(currentCategory()).toBe("All");
    expect(pickerNames()).toEqual(allNames);
    await clickNamed("List view");

    expect(buttonNamed("List view").getAttribute("aria-pressed")).toBe("true");
    expect(pickerNames()).toEqual(allNames);
    expect(selectedNames()).toEqual(["Redis"]);
    expect(currentCategory()).toBe("All");
    await clickNamed("Icon view");
    expect(buttonNamed("Icon view").getAttribute("aria-pressed")).toBe("true");
    expect(pickerNames()).toEqual(allNames);
    expect(selectedNames()).toEqual(["Redis"]);
  });

  it("selects a visible first database on category changes, while All keeps the current selection", async () => {
    await mountDialog();
    await selectDatabase("PostgreSQL");
    await clickNamed("Relational");
    expect(selectedNames()).toEqual(["PostgreSQL"]);
    await clickNamed("Analytics");
    expect(selectedNames()).toEqual([pickerNames()[0]]);
    await selectDatabase("ClickHouse");
    expect(currentCategory()).toBe("Analytics");
    await clickNamed("All");
    expect(selectedNames()).toEqual(["ClickHouse"]);
    expect(currentCategory()).toBe("All");
  });

  it.each([
    ["  ReDiS  ", "Redis"],
    ["sqlserver", "SQL Server"],
    ["ignite3", "Apache Ignite"],
    ["ignite 3", "Apache Ignite"],
  ])("searches globally from a category using %s", async (query, expected) => {
    await mountDialog();
    await clickNamed("Lightweight");
    await search(query);

    expect(pickerNames()).toContain(expected);
    expect(currentCategory()).toBeUndefined();
    expect(document.body.textContent).toContain("Search results");
    await selectDatabase(expected);
    expect(searchInput().value).toBe(query);
    await search("");
    expect(currentCategory()).toBe("Lightweight");
    expect(pickerNames()).toContain("SQLite");
    expect(pickerNames()).not.toContain(expected);
  });

  it("matches translated category names globally and restores the originating category when cleared", async () => {
    await loadLocaleMessages("zh-CN");
    i18n.global.locale.value = "zh-CN";
    await mountDialog();
    const relational = i18n.global.t("connection.databaseCategorySql");
    const documentCategory = i18n.global.t("connection.databaseCategoryDocument");
    await clickNamed(documentCategory);
    const expectedNames = pickerNames();
    await clickNamed(relational);
    await search(documentCategory);

    expect(pickerNames()).toEqual(expectedNames);
    expect(pickerNames()).toContain("Redis");
    await search("");
    expect(currentCategory()).toBe(relational);
    expect(pickerNames()).toContain("MySQL");
  });

  it.each(["All", "Lightweight"])("preserves %s, search, view and selection across Next and Previous", async (category) => {
    await mountDialog();
    await clickNamed(category);
    await clickNamed("List view");
    await search("postgres");
    await selectDatabase("PostgreSQL");
    const matches = pickerNames();
    await clickNamed("Next");
    expect(document.querySelector("[data-connection-db-search]")).toBeNull();
    await clickNamed("Previous");

    expect(searchInput().value).toBe("postgres");
    expect(pickerNames()).toEqual(matches);
    expect(selectedNames()).toEqual(["PostgreSQL"]);
    expect(buttonNamed("List view").getAttribute("aria-pressed")).toBe("true");
    await search("");
    expect(currentCategory()).toBe(category);
  });

  it("keeps category and selection when a database is double-clicked and its type button returns to the picker", async () => {
    await mountDialog();
    await clickNamed("Analytics");
    await selectDatabase("ClickHouse", true);
    expect(document.querySelector("[data-connection-db-search]")).toBeNull();
    await clickNamed("ClickHouse");
    expect(currentCategory()).toBe("Analytics");
    expect(selectedNames()).toEqual(["ClickHouse"]);
  });

  it("disables Next for unmatched or unselected search results without changing the selection", async () => {
    await mountDialog();
    await search("no-database-can-have-this-name");
    expect(pickerNames()).toEqual([]);
    expect(document.body.textContent).toContain(i18n.global.t("connection.noDatabaseMatches"));
    expect(buttonNamed("Next").disabled).toBe(true);
    await search("redis");
    expect(pickerNames()).toContain("Redis");
    expect(selectedNames()).toEqual([]);
    expect(buttonNamed("Next").disabled).toBe(true);
    await selectDatabase("Redis");
    expect(buttonNamed("Next").disabled).toBe(false);
    await search("");
    expect(selectedNames()).toEqual(["Redis"]);
  });

  it("resets All, query and selection after dismissal while keeping the persisted view", async () => {
    const { props, updates } = await mountDialog();
    await clickNamed("Analytics");
    await clickNamed("List view");
    await search("postgres");
    await selectDatabase("PostgreSQL");
    await clickNamed("Next");
    (document.querySelector('[data-testid="dismiss-dialog"]') as HTMLButtonElement).click();
    await settle();
    expect(props.open).toBe(false);
    expect(updates).toEqual([false]);
    expect(document.querySelector("[data-connection-category-nav]")).toBeNull();
    props.open = true;
    await settle();

    expect(currentCategory()).toBe("All");
    expect(searchInput().value).toBe("");
    expect(selectedNames()).toEqual(["MySQL"]);
    expect(buttonNamed("List view").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(CONNECTION_PICKER_VIEW_STORAGE_KEY)).toBe("list");
    expect(store.addConnection).not.toHaveBeenCalled();
    expect(store.connect).not.toHaveBeenCalled();
  });

  it("restores the saved list preference for a newly mounted dialog", async () => {
    await mountDialog();
    await clickNamed("List view");
    for (const app of mountedApps.splice(0)) app.unmount();
    document.body.innerHTML = "";
    await mountDialog();

    expect(currentCategory()).toBe("All");
    expect(buttonNamed("List view").getAttribute("aria-pressed")).toBe("true");
    expect(pickerNames()).toContain("Redis");
  });

  it("adds 500 dynamically loaded plugin providers once, in stable order, in both views and global search", async () => {
    let resolvePlugins!: (plugins: InstalledPlugin[]) => void;
    const pendingPlugins = new Promise<InstalledPlugin[]>((resolve) => {
      resolvePlugins = resolve;
    });
    backend.listPlugins.mockReturnValue(pendingPlugins);
    await mountDialog();
    const builtins = pickerNames();
    expect(navButtons().map((button) => button.textContent?.trim())).not.toContain("Plugins");
    const labels = Array.from({ length: 500 }, (_, index) => `Warehouse ${String(index).padStart(3, "0")}`);
    const plugin = pluginFixture("io.test.large", [...labels].reverse());
    resolvePlugins([plugin, plugin]);
    await settle();

    expect(currentCategory()).toBe("All");
    expect(pickerNames()).toEqual([...builtins, ...labels]);
    expect(pickerNames()).toHaveLength(builtins.length + 500);
    await clickNamed("List view");
    expect(pickerNames()).toEqual([...builtins, ...labels]);
    await clickNamed("Relational");
    await search("Warehouse 499");
    expect(pickerNames()).toEqual(["Warehouse 499"]);
    await selectDatabase("Warehouse 499");
    expect(selectedNames()).toEqual(["Warehouse 499"]);
    await clickNamed("Next");
    await clickNamed("Previous");
    expect(searchInput().value).toBe("Warehouse 499");
    expect(selectedNames()).toEqual(["Warehouse 499"]);
    await search("io.test.large/provider-0");
    expect(pickerNames()).toEqual(["Warehouse 499"]);
    await clickNamed("All");
    expect(pickerNames()).toEqual([...builtins, ...labels]);
    expect(selectedNames()).toEqual(["Warehouse 499"]);
  });

  it("keeps the merged Ignite card and selected version across All and category navigation", async () => {
    await mountDialog();
    await selectDatabase("Apache Ignite", true);
    await clickNamed("Ignite 3.x");
    expect(buttonNamed("Ignite 3.x").getAttribute("aria-pressed")).toBe("true");
    await clickNamed("Previous");
    expect(currentCategory()).toBe("All");
    expect(pickerNames().filter((name) => name.includes("Ignite"))).toEqual(["Apache Ignite"]);
    expect(selectedNames()).toEqual(["Apache Ignite"]);
    await clickNamed("Analytics");
    await clickNamed("All");
    await clickNamed("Next");
    expect(buttonNamed("Ignite 3.x").getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["All", "Lightweight"])("retains the standalone JDBC entry and returns to usable browsing from %s", async (category) => {
    await mountDialog();
    await clickNamed(category);
    await search("redis");
    (document.querySelector("[data-jdbc-connection-entry]") as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector("[data-connection-db-search]")).toBeNull();
    expect(buttonNamed("JDBC")).toBeTruthy();
    await clickNamed("Previous");
    expect(searchInput().value).toBe("");
    expect(currentCategory()).toBe(category);
    expect(document.body.textContent).toContain(`${i18n.global.t("connection.selectedDatabase")}: JDBC`);
    expect(document.querySelector("[data-jdbc-connection-entry]")).toBeTruthy();
    await selectDatabase(category === "All" ? "Redis" : "SQLite");
    expect(buttonNamed("Next").disabled).toBe(false);
  });

  it.each(localizedAllLabels)("renders a native All navigation label in %s", async (locale, label) => {
    i18n.global.locale.value = locale;
    await mountDialog();

    expect(i18n.global.te("connection.databaseCategoryAll", locale)).toBe(true);
    expect(navButtons()[0].textContent?.trim()).toBe(label);
    expect(currentCategory()).toBe(label);
    expect(pickerNames()).toContain("MySQL");
    expect(pickerNames()).toContain("Redis");
  });
});
