// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig } from "@/types/database";

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
      emits: ["update:modelValue"],
      setup:
        (props, { attrs, emit }) =>
        () =>
          h("input", { ...attrs, type: "password", value: props.modelValue, onInput: (event: Event) => emit("update:modelValue", (event.target as HTMLInputElement).value) }),
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

function salesforceConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "sfdc-sandbox",
    name: "Salesforce sandbox",
    db_type: "salesforce",
    driver_profile: "salesforce",
    driver_label: "Salesforce",
    host: "https://acme--qas1.sandbox.my.salesforce.com",
    port: 443,
    password: "saved-access-token",
    ssl: true,
    save_password: true,
    ...overrides,
  } as ConnectionConfig;
}

async function settle() {
  for (let i = 0; i < 8; i++) await nextTick();
}

async function mountDialog(config: ConnectionConfig) {
  const props = reactive({ open: true, editConfig: config });
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

function redisConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "redis-1",
    name: "Redis",
    db_type: "redis",
    host: "127.0.0.1",
    port: 6379,
    password: "secret",
    save_password: true,
    ...overrides,
  } as ConnectionConfig;
}

function savePasswordCheckbox(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[aria-label="Save password"]');
}

describe("ConnectionDialog save-password checkbox", () => {
  it("renders on the Redis form and toggles form.save_password", async () => {
    await mountDialog(redisConnection());

    const checkbox = savePasswordCheckbox();
    expect(checkbox, "Redis form should render the save-password checkbox").toBeTruthy();
    expect(checkbox!.checked).toBe(true);

    checkbox!.click();
    await settle();

    expect(savePasswordCheckbox()!.checked).toBe(false);
  });

  it("renders on the MongoDB form mode", async () => {
    await mountDialog({
      id: "mongo-1",
      name: "MongoDB",
      db_type: "mongodb",
      host: "127.0.0.1",
      port: 27017,
      username: "dbx",
      password: "secret",
      save_password: true,
    } as ConnectionConfig);

    expect(savePasswordCheckbox(), "MongoDB form should render the save-password checkbox").toBeTruthy();
  });

  it("renders on the etcd form", async () => {
    await mountDialog({
      id: "etcd-1",
      name: "etcd",
      db_type: "etcd",
      host: "127.0.0.1",
      port: 2379,
      username: "root",
      password: "secret",
      save_password: true,
    } as ConnectionConfig);

    expect(savePasswordCheckbox(), "etcd form should render the save-password checkbox").toBeTruthy();
  });

  it("renders on the Salesforce access-token form", async () => {
    await mountDialog(salesforceConnection());

    expect(savePasswordCheckbox(), "Salesforce token form should render the save-password checkbox").toBeTruthy();
  });

  it("does not render when the connection has no password field", async () => {
    await mountDialog({
      id: "spanner-1",
      name: "Spanner",
      db_type: "spanner",
      host: "project/instance",
      database: "db",
      save_password: true,
    } as ConnectionConfig);

    expect(savePasswordCheckbox()).toBeNull();
  });
});

function elasticsearchConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return { id: "es-1", name: "Elasticsearch", db_type: "elasticsearch", host: "search.example.com", port: 9243, username: "elastic", password: "basic-password", ssl: true, save_password: true, ...overrides } as ConnectionConfig;
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === name);
  expect(button, `Expected button ${name}`).toBeTruthy();
  return button!;
}

describe("Elasticsearch API key authentication", () => {
  it("clears the previous credential on switch, hides username and submits the key in the secret slot", async () => {
    await mountDialog(elasticsearchConnection());
    expect(buttonNamed("Basic").getAttribute("aria-pressed")).toBe("true");
    buttonNamed("API Key").click();
    await settle();
    const input = document.querySelector<HTMLInputElement>('input[placeholder="Base64(id:api_key)"]')!;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(Array.from(document.querySelectorAll("label")).some((label) => label.textContent?.trim() === "User")).toBe(false);
    input.value = "  c3ludGhldGljOmtleQ==  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    buttonNamed("Test").click();
    await settle();
    expect(backend.testConnectionWithInfo).toHaveBeenCalledWith(expect.objectContaining({ username: "", password: "c3ludGhldGljOmtleQ==", external_config: { authType: "apiKey" } }));
    buttonNamed("Save").click();
    await settle();
    expect(store.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ username: "", password: "c3ludGhldGljOmtleQ==", external_config: { authType: "apiKey" }, save_password: true }));
  });

  it("restores the API key mode when editing and clears the key when switching back to Basic", async () => {
    await mountDialog(elasticsearchConnection({ username: "", password: "encoded-key", external_config: { authType: "apiKey" }, save_password: false }));
    expect(buttonNamed("API Key").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector<HTMLInputElement>('input[placeholder="Base64(id:api_key)"]')!.value).toBe("encoded-key");
    expect(savePasswordCheckbox()!.checked).toBe(false);
    buttonNamed("Basic").click();
    await settle();
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    expect(document.querySelector('input[placeholder="Base64(id:api_key)"]')).toBeNull();
  });
});
