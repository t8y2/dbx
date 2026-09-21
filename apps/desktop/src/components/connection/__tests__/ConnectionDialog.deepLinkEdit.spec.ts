// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig } from "@/types/database";
import { parseConnectionDeepLinkUpdate } from "@/lib/connection/connectionDeepLink";

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
  const props = reactive({ open: initiallyOpen, editConfig: config, updatePrefill: parseConnectionDeepLinkUpdate(url) });
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

beforeEach(() => {
  vi.clearAllMocks();
  i18n.global.locale.value = "en";
  for (const fn of Object.values(backend)) fn.mockResolvedValue([]);
  backend.listenAgentInstallProgress.mockResolvedValue(() => {});
  store.updateConnection.mockResolvedValue(undefined);
  store.addConnection.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("ConnectionDialog deep-link edit confirmation", () => {
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
    await mountDialog(savedConnection(), "dbx://connection/new?id=saved-production&password=new-password");
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
        visible_databases: ["orders"],
        url_params: "connectTimeout=25",
      }),
    );
    expect(store.addConnection).not.toHaveBeenCalled();
    expect(store.connect).not.toHaveBeenCalled();
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
});
