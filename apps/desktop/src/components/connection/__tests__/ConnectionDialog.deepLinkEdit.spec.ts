// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig } from "@/types/database";
import { CONNECTION_PROFILES } from "@/types/generated/connectionProfiles";
import { parseConnectionDeepLink, parseConnectionDeepLinkUpdate } from "@/lib/connection/connectionDeepLink";

const visibleTab = vi.hoisted(() => ({ value: "connection" }));

const { store, settings, backend, actualStoreHolder } = vi.hoisted(() => ({
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
  actualStoreHolder: { value: null as unknown },
  settings: {
    editorSettings: { sidebarShowConnectionNotes: false, globalConnectTimeoutSecs: 10, globalQueryTimeoutSecs: 0, connectTimeoutInheritConnectionIds: [], queryTimeoutInheritConnectionIds: [], deepLinkConnectionConfirmMode: "always" as "always" | "create" | "update" | "all" },
    rememberedDatabaseForConnection: vi.fn(() => ""),
    initEditorSettings: vi.fn().mockResolvedValue(undefined),
    persistEditorSettings: vi.fn(),
    updateEditorSettings: vi.fn(),
    updateEditorSettingsAndPersist: vi.fn(),
  },
  backend: {
    connectDb: vi.fn(),
    disconnectDb: vi.fn(),
    redisListDatabases: vi.fn(),
    listSchemas: vi.fn(),
    testConnectionWithInfo: vi.fn(),
    listDatabases: vi.fn(),
    listPlugins: vi.fn(),
    listJdbcDrivers: vi.fn(),
    listJdbcMavenBundles: vi.fn(),
    listJdbcLocalBundles: vi.fn(),
    listSshConfigHosts: vi.fn(),
    listInstalledAgents: vi.fn(),
    listInstalledAgentsLocal: vi.fn(),
    listenAgentInstallProgress: vi.fn(),
    loadConnections: vi.fn().mockResolvedValue([]),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    loadEditorSettings: vi.fn().mockResolvedValue(null),
    loadPinnedTreeNodeIds: vi.fn().mockResolvedValue([]),
    loadTableVGroups: vi.fn().mockResolvedValue({}),
    saveTableVGroups: vi.fn().mockResolvedValue(undefined),
    loadSidebarLayout: vi.fn().mockResolvedValue({ groups: [], order: [] }),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    loadTunnelProfiles: vi.fn().mockResolvedValue([]),
    saveEditorSettings: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => actualStoreHolder.value ?? store, CONNECTION_ATTEMPT_CANCELLED_MESSAGE: "cancelled" }));
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
        props.value === visibleTab.value ? h("div", slots.default?.()) : null,
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

function savedConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "saved-production",
    name: "Saved production",
    db_type: "mysql",
    driver_profile: "mysql",
    driver_label: "MySQL",
    host: "old.example.test",
    port: 3307,
    username: "old-user",
    password: "old-password",
    database: "orders",
    ssl: true,
    read_only: true,
    is_production: true,
    production_databases: ["orders"],
    production_badge_scope: "table",
    save_password: true,
    visible_databases: ["orders"],
    url_params: "connectTimeout=25",
    ...overrides,
  };
}

async function settle() {
  for (let i = 0; i < 8; i++) await nextTick();
}

async function mountDialog(config: ConnectionConfig, url: string, initiallyOpen = true) {
  const props = reactive({ open: initiallyOpen, editConfig: config, updatePrefill: url ? parseConnectionDeepLinkUpdate(url) : null });
  store.getConfig.mockReturnValue(config);
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(ConnectionDialog, {
          ...props,
          "onUpdate:open": (value: boolean) => {
            props.open = value;
          },
        }),
    }),
  );
  app.use(i18n);
  mountedApps.push(app);
  app.mount(container);
  await settle();
  return props;
}

async function mountNewDialog(url?: string) {
  const props = reactive({ open: true, prefillConfig: url ? parseConnectionDeepLink(url) : null });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(ConnectionDialog, {
          ...props,
          "onUpdate:open": (value: boolean) => {
            props.open = value;
          },
        }),
    }),
  );
  app.use(i18n);
  mountedApps.push(app);
  app.mount(container);
  await settle();
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  actualStoreHolder.value = null;
  visibleTab.value = "connection";
  i18n.global.locale.value = "en";
  settings.editorSettings.deepLinkConnectionConfirmMode = "always";
  for (const fn of Object.values(backend)) fn.mockResolvedValue([]);
  backend.listenAgentInstallProgress.mockResolvedValue(() => {});
  store.updateConnection.mockResolvedValue(undefined);
  store.addConnection.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  (actualStoreHolder.value as { $dispose?: () => void } | null)?.$dispose?.();
  actualStoreHolder.value = null;
});

describe("ConnectionDialog deep-link edit confirmation", () => {
  it("saves a new OceanBase connection with its explicitly entered port after switching mode", async () => {
    backend.listInstalledAgentsLocal.mockResolvedValue([{ db_type: "oceanbase-oracle", installed: true }]);
    await mountNewDialog();
    const category = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === i18n.global.t("connection.databaseCategoryDomestic"));
    expect(category).toBeTruthy();
    category!.click();
    await settle();
    const option = document.querySelector<HTMLButtonElement>('[title="OceanBase"]');
    expect(option).toBeTruthy();
    option!.click();
    await settle();
    option!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle();
    const port = document.querySelector<HTMLInputElement>('input[type="number"].col-span-1');
    expect(port?.value).toBe("2883");
    port!.value = "2881";
    port!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const mode = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === i18n.global.t("connection.oceanbaseOracleMode"));
    mode!.click();
    await settle();
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === i18n.global.t("connection.saveAndConnect"));
    expect(save).toBeTruthy();
    save!.click();
    await settle();
    expect(store.addConnection).toHaveBeenCalledWith(expect.objectContaining({ db_type: "oceanbase-oracle", driver_profile: "oceanbase-oracle", port: 2881 }), null);
  });

  it.each([false, true])("follows each OceanBase profile default in both directions (Oracle source: %s)", async (oracle) => {
    const mysqlPort = CONNECTION_PROFILES.oceanbase.port;
    const oraclePort = CONNECTION_PROFILES["oceanbase-oracle"].port;
    try {
      Object.defineProperty(CONNECTION_PROFILES.oceanbase, "port", { value: 12881, configurable: true });
      Object.defineProperty(CONNECTION_PROFILES["oceanbase-oracle"], "port", { value: 12883, configurable: true });
      await mountDialog(savedConnection({ db_type: oracle ? "oceanbase-oracle" : "mysql", driver_profile: oracle ? "oceanbase-oracle" : "oceanbase", port: oracle ? 12883 : 12881 }), "");
      for (const targetOracle of [!oracle, oracle]) {
        const portInput = document.querySelector<HTMLInputElement>('input[type="number"].col-span-1')!;
        for (const value of ["12889", String(targetOracle ? 12881 : 12883)]) {
          portInput.value = value;
          portInput.dispatchEvent(new Event("input", { bubbles: true }));
          await settle();
        }
        const key = targetOracle ? "connection.oceanbaseOracleMode" : "connection.oceanbaseMySQLMode";
        const mode = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === i18n.global.t(key));
        mode!.click();
        await settle();
        expect(document.querySelector<HTMLInputElement>('input[type="number"].col-span-1')?.value).toBe(String(targetOracle ? 12883 : 12881));
      }
      const customPort = document.querySelector<HTMLInputElement>('input[type="number"].col-span-1')!;
      customPort.value = "12889";
      customPort.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      for (const targetOracle of [!oracle, oracle]) {
        const key = targetOracle ? "connection.oceanbaseOracleMode" : "connection.oceanbaseMySQLMode";
        [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === i18n.global.t(key))!.click();
        await settle();
        expect(document.querySelector<HTMLInputElement>('input[type="number"].col-span-1')?.value).toBe("12889");
      }
    } finally {
      Object.defineProperty(CONNECTION_PROFILES.oceanbase, "port", { value: mysqlPort, configurable: true });
      Object.defineProperty(CONNECTION_PROFILES["oceanbase-oracle"], "port", { value: oraclePort, configurable: true });
    }
  });

  it.each([
    { port: 2881, oracle: false },
    { port: 12883, oracle: false },
    { port: 2883, oracle: false },
    { port: 2881, oracle: true },
    { port: 12883, oracle: true },
  ])("retains OceanBase port $port (Oracle source: $oracle) across compatibility mode switches and save", async ({ port, oracle }) => {
    backend.listInstalledAgentsLocal.mockResolvedValue([{ db_type: "oceanbase-oracle", installed: true }]);
    await mountDialog(savedConnection({ db_type: oracle ? "oceanbase-oracle" : "mysql", driver_profile: oracle ? "oceanbase-oracle" : "oceanbase", driver_label: "OceanBase", port: 2883 }), "");
    const portInput = document.querySelector<HTMLInputElement>('input[type="number"].col-span-1');
    expect(portInput).toBeTruthy();
    portInput!.value = String(port);
    portInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const clickMode = async (key: "connection.oceanbaseOracleMode" | "connection.oceanbaseMySQLMode") => {
      const button = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === i18n.global.t(key));
      expect(button).toBeTruthy();
      button!.click();
      await settle();
      const portInput = document.querySelector<HTMLInputElement>('input[type="number"].col-span-1');
      expect(portInput?.value).toBe(String(port));
    };
    await clickMode("connection.oceanbaseOracleMode");
    await clickMode("connection.oceanbaseOracleMode");
    await clickMode("connection.oceanbaseMySQLMode");
    await clickMode("connection.oceanbaseOracleMode");
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    save!.click();
    await settle();
    expect(store.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ db_type: "oceanbase-oracle", driver_profile: "oceanbase-oracle", port, username: "SYS", url_params: "", host: "old.example.test", password: "old-password" }));
  });

  it("preserves a protected generic JDBC target when only its name changes", async () => {
    const saved = savedConnection({
      db_type: "jdbc",
      driver_profile: "jdbc",
      driver_label: "JDBC",
      host: "db.example.test",
      port: 2881,
      username: "saved-user",
      password: "__DBX_SAVED_CREDENTIAL__:synthetic-password",
      connection_string: "__DBX_SAVED_CREDENTIAL__:synthetic-url",
      jdbc_driver_class: "example.Driver",
      jdbc_driver_paths: ["driver.jar"],
      jdbc_dialect: "oceanbase-oracle",
      production_badge_scope: undefined,
    });
    await mountDialog(saved, "");
    const name = [...document.querySelectorAll<HTMLInputElement>("input")].find((input) => input.value === saved.name);
    expect(name).toBeTruthy();
    name!.value = "Renamed JDBC";
    name!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    save!.click();
    await settle();
    expect(store.updateConnection).toHaveBeenCalledTimes(1);
    const submitted = store.updateConnection.mock.calls[0][0];
    expect(submitted.name).toBe("Renamed JDBC");
    expect(submitted.production_badge_scope).toBeUndefined();
    expect(submitted).toMatchObject({
      db_type: saved.db_type,
      driver_profile: saved.driver_profile,
      host: saved.host,
      port: saved.port,
      username: saved.username,
      password: saved.password,
      connection_string: saved.connection_string,
      jdbc_driver_class: saved.jdbc_driver_class,
      jdbc_driver_paths: saved.jdbc_driver_paths,
    });
  });

  it("shows the global Redis preview limit in advanced settings and persists it", async () => {
    visibleTab.value = "advanced";
    settings.editorSettings.redisValuePreviewLimitKiB = 64;
    const redis = savedConnection({ id: "redis-connection", name: "Redis", db_type: "redis", driver_profile: "redis", driver_label: "Redis", host: "127.0.0.1", port: 6379, database: "0" });
    await mountDialog(redis, "");
    const input = document.querySelector<HTMLInputElement>("#redis-value-preview-limit-input");
    expect(input?.value).toBe("64");
    expect(input?.min).toBe("1");
    expect(input?.max).toBe("65536");
    input!.value = "256";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    save!.click();
    await settle();
    expect(settings.updateEditorSettingsAndPersist).toHaveBeenCalledWith({ redisValuePreviewLimitKiB: 256 });
    expect(store.updateConnection).toHaveBeenCalled();
  });

  it("changes the advanced badge picker and persists it while retaining production protection", async () => {
    visibleTab.value = "advanced";
    await mountDialog(savedConnection({ production_badge_scope: "connection" }), "dbx://connection/new?id=saved-production");
    const trigger = document.querySelector<HTMLButtonElement>("#production-badge-scope");
    expect(trigger?.textContent).toContain("Connection");
    trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) => element.textContent?.trim() === "Table / object");
    expect(option).toBeTruthy();
    option!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(trigger?.textContent).toContain("Table / object");
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    save!.click();
    await settle();
    expect(store.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ production_badge_scope: "table", is_production: true, production_databases: ["orders"] }));
  });

  it("shows the default badge picker for an old saved connection", async () => {
    visibleTab.value = "advanced";
    await mountDialog(savedConnection({ production_badge_scope: undefined }), "dbx://connection/new?id=saved-production");
    expect(document.querySelector("#production-badge-scope")?.textContent).toContain("Database / schema (default)");
  });

  it("does not save, connect, or send retained credentials before confirmation", async () => {
    const saved = savedConnection();
    await mountDialog(saved, "dbx://connection/new?id=saved-production&host=new.example.test");

    expect([...document.querySelectorAll("input")].some((input) => input.value === "new.example.test")).toBe(true);
    expect(saved.host).toBe("old.example.test");
    expect(store.addConnection).not.toHaveBeenCalled();
    expect(store.updateConnection).not.toHaveBeenCalled();
    expect(store.connect).not.toHaveBeenCalled();
    expect(backend.connectDb).not.toHaveBeenCalled();
    expect(backend.testConnectionWithInfo).not.toHaveBeenCalled();
    expect(backend.listDatabases).not.toHaveBeenCalled();
  });

  it("dismisses the draft without persisting or connecting", async () => {
    const saved = savedConnection();
    const props = await mountDialog(saved, "dbx://connection/new?id=saved-production&password=new-password");
    (document.querySelector('[data-testid="dismiss-dialog"]') as HTMLButtonElement).click();
    await settle();

    expect(props.open).toBe(false);
    expect(saved.password).toBe("old-password");
    expect(store.updateConnection).not.toHaveBeenCalled();
    expect(store.addConnection).not.toHaveBeenCalled();
    expect(store.connect).not.toHaveBeenCalled();
    expect(backend.connectDb).not.toHaveBeenCalled();
  });

  it("updates the existing ID only after Save and preserves omitted fields", async () => {
    await mountDialog(savedConnection({ sidebar_auto_load_all_tables: true }), "dbx://connection/new?id=saved-production&password=new-password");
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    expect(save).toBeTruthy();
    save!.click();
    await settle();

    expect(store.updateConnection).toHaveBeenCalledTimes(1);
    expect(store.updateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "saved-production",
        name: "Saved production",
        host: "old.example.test",
        port: 3307,
        username: "old-user",
        password: "new-password",
        database: "orders",
        ssl: true,
        read_only: true,
        is_production: true,
        production_databases: ["orders"],
        production_badge_scope: "table",
        visible_databases: ["orders"],
        sidebar_auto_load_all_tables: true,
        url_params: "connectTimeout=25",
      }),
    );
    expect(store.addConnection).not.toHaveBeenCalled();
    expect(store.connect).not.toHaveBeenCalled();
  });

  it("preserves a protected generic JDBC target when only its name changes", async () => {
    const saved = savedConnection({
      db_type: "jdbc",
      driver_profile: "jdbc",
      driver_label: "JDBC",
      host: "db.example.test",
      port: 2881,
      username: "saved-user",
      password: "__DBX_SAVED_CREDENTIAL__:synthetic-password",
      connection_string: "__DBX_SAVED_CREDENTIAL__:synthetic-url",
      jdbc_driver_class: "example.Driver",
      jdbc_driver_paths: ["driver.jar"],
      jdbc_dialect: "oceanbase-oracle",
      production_badge_scope: undefined,
    });
    await mountDialog(saved, "");
    const name = [...document.querySelectorAll<HTMLInputElement>("input")].find((input) => input.value === saved.name);
    expect(name).toBeTruthy();
    name!.value = "Renamed JDBC";
    name!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    save!.click();
    await settle();

    expect(store.updateConnection).toHaveBeenCalledTimes(1);
    const submitted = store.updateConnection.mock.calls[0][0];
    expect(submitted.name).toBe("Renamed JDBC");
    expect(submitted.production_badge_scope).toBeUndefined();
    expect(submitted).toMatchObject({
      db_type: saved.db_type,
      driver_profile: saved.driver_profile,
      host: saved.host,
      port: saved.port,
      username: saved.username,
      password: saved.password,
      connection_string: saved.connection_string,
      jdbc_driver_class: saved.jdbc_driver_class,
      jdbc_driver_paths: saved.jdbc_driver_paths,
    });
  });

  it.each([true, false] as const)("preserves protected target settings through real Store load and Dialog save (%s DB links)", async (showDatabaseLinks) => {
    setActivePinia(createPinia());
    const saved = savedConnection({
      id: "loaded-protected-jdbc",
      db_type: "jdbc",
      driver_profile: "jdbc",
      driver_label: undefined,
      host: "db.example.test",
      port: 2881,
      username: "saved-user",
      password: "__DBX_SAVED_CREDENTIAL__:synthetic-password",
      connection_string: "__DBX_SAVED_CREDENTIAL__:synthetic-url",
      jdbc_driver_class: "example.Driver",
      jdbc_driver_paths: ["driver.jar"],
      url_params: undefined,
      show_database_links: showDatabaseLinks,
      production_badge_scope: undefined,
    });
    const untouched = savedConnection({
      id: "untouched-protected-jdbc",
      name: "Untouched JDBC",
      db_type: "jdbc",
      driver_profile: "jdbc",
      driver_label: undefined,
      host: "schema.example.test",
      port: 2882,
      username: "schema-user",
      password: "__DBX_SAVED_CREDENTIAL__:synthetic-schema-password",
      connection_string: "__DBX_SAVED_CREDENTIAL__:synthetic-schema-url",
      jdbc_driver_class: "example.SchemaDriver",
      jdbc_driver_paths: ["schema-driver.jar"],
      url_params: undefined,
      show_database_links: undefined,
    });
    vi.mocked(backend.loadConnections).mockResolvedValue([saved, untouched]);
    vi.mocked(backend.loadSidebarLayout).mockResolvedValue({ groups: [], order: [] });
    const { useConnectionStore } = await vi.importActual<typeof import("@/stores/connectionStore")>("@/stores/connectionStore");
    const actualStore = useConnectionStore();
    actualStoreHolder.value = actualStore;
    await actualStore.initFromDisk();
    const loaded = actualStore.getConfig(saved.id)!;
    expect(loaded.production_badge_scope).toBeUndefined();
    expect(loaded.driver_label).toBe("jdbc");
    expect(loaded.url_params).toBe("");
    expect(loaded.show_database_links).toBe(showDatabaseLinks);
    expect(actualStore.getConfig(untouched.id)?.show_database_links).toBeUndefined();

    await mountDialog(loaded, "");
    const name = [...document.querySelectorAll<HTMLInputElement>("input")].find((input) => input.value === loaded.name);
    expect(name).toBeTruthy();
    name!.value = "Renamed JDBC";
    name!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    save!.click();
    await settle();

    expect(backend.saveConnections).toHaveBeenCalledOnce();
    const persisted = vi.mocked(backend.saveConnections).mock.calls[0][0][0];
    const persistedUntouched = vi.mocked(backend.saveConnections).mock.calls[0][0].find((config) => config.id === untouched.id)!;
    expect(persisted.name).toBe("Renamed JDBC");
    expect(persisted.production_badge_scope).toBeUndefined();
    expect(persisted.host).toBe("db.example.test");
    expect(persisted.port).toBe(2881);
    expect(persisted.connection_string).toBe(saved.connection_string);
    expect(persisted.password).toBe(saved.password);
    expect(persisted.show_database_links).toBe(showDatabaseLinks);
    expect(persistedUntouched).toMatchObject({
      id: untouched.id,
      db_type: untouched.db_type,
      driver_profile: untouched.driver_profile,
      host: untouched.host,
      port: untouched.port,
      username: untouched.username,
      password: untouched.password,
      connection_string: untouched.connection_string,
      jdbc_driver_class: untouched.jdbc_driver_class,
      jdbc_driver_paths: untouched.jdbc_driver_paths,
    });
    expect(persistedUntouched.show_database_links).toBeUndefined();
  });

  it("keeps an explicitly selected badge scope on an unchanged generic JDBC target", async () => {
    visibleTab.value = "advanced";
    const saved = savedConnection({
      db_type: "jdbc",
      driver_profile: "jdbc",
      driver_label: "JDBC",
      host: "db.example.test",
      port: 2881,
      connection_string: "__DBX_SAVED_CREDENTIAL__:synthetic-url",
      jdbc_driver_class: "example.Driver",
      jdbc_driver_paths: ["driver.jar"],
      production_badge_scope: undefined,
    });
    await mountDialog(saved, "");
    const trigger = document.querySelector<HTMLButtonElement>("#production-badge-scope");
    expect(trigger?.textContent).toContain("Database / schema (default)");
    trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) => element.textContent?.trim() === "Table / object");
    expect(option).toBeTruthy();
    option!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    save!.click();
    await settle();

    expect(store.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ production_badge_scope: "table", host: "db.example.test", port: 2881 }));
  });

  it("keeps the existing generic JDBC normalization when its URL is replaced", async () => {
    const saved = savedConnection({
      db_type: "jdbc",
      driver_profile: "jdbc",
      driver_label: "JDBC",
      host: "db.example.test",
      port: 2881,
      connection_string: "__DBX_SAVED_CREDENTIAL__:synthetic-url",
      jdbc_driver_class: "example.Driver",
      jdbc_driver_paths: ["driver.jar"],
    });
    await mountDialog(saved, "");
    const url = [...document.querySelectorAll<HTMLInputElement>("input")].find((input) => input.value === saved.connection_string);
    expect(url).toBeTruthy();
    url!.value = "jdbc:example://new.example.test:9999/db";
    url!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    save!.click();
    await settle();

    expect(store.updateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        connection_string: "jdbc:example://new.example.test:9999/db",
        host: "",
        port: 0,
      }),
    );
  });

  it("keeps the generic JDBC new-connection endpoint normalization", async () => {
    await mountNewDialog();
    const jdbcCategory = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "JDBC connection");
    expect(jdbcCategory).toBeTruthy();
    jdbcCategory!.click();
    await settle();
    const jdbcOption = document.querySelector<HTMLButtonElement>('[title="JDBC"]');
    expect(jdbcOption).toBeTruthy();
    jdbcOption!.click();
    await settle();
    jdbcOption!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle();
    const url = [...document.querySelectorAll<HTMLInputElement>("input")].find((input) => input.placeholder.startsWith("jdbc:"));
    expect(url).toBeTruthy();
    url!.value = "jdbc:example://host/db";
    url!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    expect(save).toBeTruthy();
    save!.click();
    await settle();

    expect(store.addConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        db_type: "jdbc",
        connection_string: "jdbc:example://host/db",
        host: "",
        port: 0,
      }),
      null,
    );
  });

  it("applies explicit empty passwords and false TLS values without create defaults", async () => {
    await mountDialog(savedConnection(), "dbx://connection/new?id=saved-production&password=&ssl=false");
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    expect(save).toBeTruthy();
    save!.click();
    await settle();

    expect(store.updateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "saved-production",
        password: "",
        ssl: false,
        port: 3307,
        username: "old-user",
        database: "orders",
        read_only: true,
        is_production: true,
      }),
    );
    expect(store.addConnection).not.toHaveBeenCalled();
    expect(store.connect).not.toHaveBeenCalled();
  });

  it("keeps unsaved field edits when the saved config is refreshed", async () => {
    const props = await mountDialog(savedConnection(), "dbx://connection/new?id=saved-production&password=new-password");
    const username = [...document.querySelectorAll("input")].find((input) => input.value === "old-user");
    expect(username).toBeTruthy();
    username!.value = "manually-edited-user";
    username!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    props.editConfig = savedConnection({ username: "background-refresh-user" });
    await settle();
    expect([...document.querySelectorAll("input")].some((input) => input.value === "manually-edited-user")).toBe(true);
    expect(store.updateConnection).not.toHaveBeenCalled();
    expect(store.addConnection).not.toHaveBeenCalled();
  });

  it("hydrates a later-opened update without clearing omitted database or schema filters", async () => {
    const saved = savedConnection({ db_type: "postgres", driver_profile: "postgres", driver_label: "PostgreSQL", url_params: "sslmode=require", visible_schemas: ["approved_schema"] });
    const props = await mountDialog(saved, "dbx://connection/new?id=saved-production&user=new-user&password=new-password", false);
    props.open = true;
    await settle();

    expect([...document.querySelectorAll("input")].some((input) => input.value === "new-user")).toBe(true);
    expect([...document.querySelectorAll("input")].some((input) => input.value === "new-password")).toBe(true);
    expect(store.updateConnection).not.toHaveBeenCalled();
    expect(backend.connectDb).not.toHaveBeenCalled();
    expect(backend.testConnectionWithInfo).not.toHaveBeenCalled();

    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    expect(save).toBeTruthy();
    save!.click();
    await settle();

    expect(store.updateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "saved-production",
        username: "new-user",
        password: "new-password",
        visible_databases: ["orders"],
        visible_schemas: ["approved_schema"],
      }),
    );
    expect(store.addConnection).not.toHaveBeenCalled();
    expect(store.connect).not.toHaveBeenCalled();
  });

  it("does not recreate a target removed while its update is awaiting confirmation", async () => {
    await mountDialog(savedConnection(), "dbx://connection/new?id=saved-production&password=new-password");
    store.getConfig.mockReturnValue(undefined);
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    expect(save).toBeTruthy();
    save!.click();
    await settle();

    expect(store.updateConnection).not.toHaveBeenCalled();
    expect(store.addConnection).not.toHaveBeenCalled();
    expect(store.connect).not.toHaveBeenCalled();
    expect(backend.connectDb).not.toHaveBeenCalled();
  });

  it.each([
    { title: "marks an explicit SQL Server port without an existing external config", dbType: "sqlserver", patch: "port=1444", external: undefined, expectedExternal: { portExplicit: true }, expectedPort: 1444 },
    { title: "marks an explicit SQL Server port and retains unrelated external fields", dbType: "sqlserver", patch: "port=1444", external: { customSetting: "retained", port_explicit: false }, expectedExternal: { customSetting: "retained", portExplicit: true }, expectedPort: 1444 },
    { title: "retains MySQL external config on a credential-only update", dbType: "mysql", patch: "password=new-password", external: { customSetting: "retained" }, expectedExternal: { customSetting: "retained" }, expectedPort: 3307 },
    { title: "retains PostgreSQL external config on a credential-only update", dbType: "postgres", patch: "password=new-password", external: { customSetting: "retained" }, expectedExternal: { customSetting: "retained" }, expectedPort: 3307 },
    { title: "retains the SQL Server explicit-port flag on a credential-only update", dbType: "sqlserver", patch: "password=new-password", external: { customSetting: "retained", portExplicit: true }, expectedExternal: { customSetting: "retained", portExplicit: true }, expectedPort: 3307 },
  ] as const)("$title", async ({ dbType, patch, external, expectedExternal, expectedPort }) => {
    await mountDialog(savedConnection({ db_type: dbType, driver_profile: dbType, external_config: external }), `dbx://connection/new?id=saved-production&${patch}`);
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    expect(save).toBeTruthy();
    save!.click();
    await settle();

    expect(store.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ id: "saved-production", port: expectedPort, external_config: expectedExternal }));
    expect(store.addConnection).not.toHaveBeenCalled();
    expect(store.connect).not.toHaveBeenCalled();
    expect(backend.connectDb).not.toHaveBeenCalled();
  });

  it("recomputes the SQL Server explicit-port flag after a manual port edit in an update session", async () => {
    await mountDialog(savedConnection({ db_type: "sqlserver", driver_profile: "sqlserver", driver_label: "SQL Server", port: 1433, external_config: { customSetting: "retained" } }), "dbx://connection/new?id=saved-production&port=1444");
    const port = [...document.querySelectorAll("input")].find((input) => input.value === "1444");
    expect(port).toBeTruthy();
    port!.value = "1445";
    port!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    expect(save).toBeTruthy();
    save!.click();
    await settle();

    expect(store.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ id: "saved-production", port: 1445, external_config: { portExplicit: true } }));
    expect(store.addConnection).not.toHaveBeenCalled();
  });

  it("normalizes SQL Server host with comma port and marks explicit port on save", async () => {
    await mountDialog(savedConnection({ db_type: "sqlserver", driver_profile: "sqlserver", driver_label: "SQL Server", host: "127.0.0.1", port: 1433 }), "dbx://connection/new?id=saved-production&host=gg.test.com,9005");
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    expect(save).toBeTruthy();
    save!.click();
    await settle();

    expect(store.updateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "saved-production",
        host: "gg.test.com",
        port: 9005,
        external_config: { portExplicit: true },
      }),
    );
    expect(store.addConnection).not.toHaveBeenCalled();
  });

  it("normalizes SQL Server host with tcp prefix and comma port on blur", async () => {
    await mountDialog(savedConnection({ db_type: "sqlserver", driver_profile: "sqlserver", driver_label: "SQL Server", host: "127.0.0.1", port: 1433 }));
    const hostInput = [...document.querySelectorAll("input")].find((input) => input.value === "127.0.0.1");
    expect(hostInput).toBeTruthy();
    hostInput!.value = "tcp:sql.example.com,1444";
    hostInput!.dispatchEvent(new Event("input", { bubbles: true }));
    hostInput!.dispatchEvent(new Event("blur", { bubbles: true }));
    await settle();

    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save");
    expect(save).toBeTruthy();
    save!.click();
    await settle();

    expect(store.updateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "saved-production",
        host: "sql.example.com",
        port: 1444,
        external_config: { portExplicit: true },
      }),
    );
  });

  it("applies an id update link without waiting for confirmation when the mode allows updates", async () => {
    // 「仅带 id 的更新链接」/「所有连接链接」两种模式下，带 id 的深链不再停在编辑弹窗。
    settings.editorSettings.deepLinkConnectionConfirmMode = "update";

    await mountDialog(savedConnection(), "dbx://connection/new?id=saved-production&host=new.example.test");
    await settle();

    expect(store.updateConnection).toHaveBeenCalledTimes(1);
    expect(store.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ id: "saved-production", host: "new.example.test" }));
  });

  it("keeps an id update link open for confirmation in the default mode", async () => {
    await mountDialog(savedConnection(), "dbx://connection/new?id=saved-production&host=new.example.test");
    await settle();

    expect(store.updateConnection).not.toHaveBeenCalled();
  });
});
