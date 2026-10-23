// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig, InstalledPlugin, SshTunnelConfig, TransportLayerConfig } from "@/types/database";

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
      (props, { slots }) =>
      () =>
        props.open ? h("section", slots.default?.()) : null,
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
        props.value === "transport" ? h("div", slots.default?.()) : null,
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

function sshLayer(id: string, extras: Partial<SshTunnelConfig> = {}): TransportLayerConfig {
  return { type: "ssh", id, name: `Layer ${id}`, host: `${id}.example.com`, port: 22, user: "root", enabled: true, ...extras };
}

const proxyLayer: TransportLayerConfig = { type: "proxy", id: "proxy", name: "Corporate proxy", enabled: true, proxy_type: "socks5", host: "proxy.example.com", port: 1080 };

function tunnelled(layers: TransportLayerConfig[], overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return { id: "pg-1", name: "Postgres", db_type: "postgres", driver_profile: "postgres", driver_label: "PostgreSQL", host: "db.internal", port: 5432, username: "app", password: "secret", database: "app", save_password: true, transport_layers: layers, ...overrides };
}

function pluginWithProvider(proxyRoute: boolean): InstalledPlugin {
  return {
    manifest: {
      id: "sample.kafka",
      name: "Sample Kafka",
      drivers: [],
      contributions: [{ type: "connection-provider", id: "sample.connection", label: "Sample Kafka", database_type: "sample", fields: [], capabilities: ["connect"], proxy_route: proxyRoute }],
    },
    compatibility: { compatible: true },
  };
}

function pluginConnection(layers: TransportLayerConfig[]): ConnectionConfig {
  return { id: "plugin-1", name: "Sample", db_type: "plugin", plugin_id: "sample.kafka", plugin_connection_provider: "sample.connection", plugin_connection_type: "sample", host: "", port: 0, username: "", password: "", transport_layers: layers };
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
}

function localPortInput(): HTMLInputElement | null {
  const label = [...document.querySelectorAll("label")].find((element) => element.textContent?.trim() === "Local Port");
  return label?.parentElement?.querySelector("input") ?? null;
}

async function typeLocalPort(value: string) {
  const input = localPortInput();
  expect(input, "the selected SSH layer should render the Local Port input").toBeTruthy();
  input!.value = value;
  input!.dispatchEvent(new Event("input"));
  await settle();
}

async function save() {
  [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save")!.click();
  await settle();
}

function savedLayers(): TransportLayerConfig[] {
  expect(store.updateConnection).toHaveBeenCalledTimes(1);
  return store.updateConnection.mock.calls[0][0].transport_layers;
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

describe("ConnectionDialog SSH fixed local port", () => {
  it("shows the saved port with an Auto placeholder and keeps it on save", async () => {
    await mountDialog(tunnelled([sshLayer("bastion", { local_port: 4059 })]));

    expect(localPortInput()?.value).toBe("4059");
    expect(localPortInput()?.getAttribute("placeholder")).toBe("Auto");

    await save();

    expect(savedLayers()).toEqual([expect.objectContaining({ id: "bastion", local_port: 4059 })]);
  });

  it.each([
    ["typing a new port", undefined, "4060", 4060],
    ["changing the port", 4059, "4060", 4060],
    ["clearing the port", 4059, "", undefined],
  ])("%s saves a numeric local_port or leaves it unset", async (_name, initial, typed, expected) => {
    await mountDialog(tunnelled([sshLayer("bastion", { local_port: initial })]));

    await typeLocalPort(typed);
    await save();

    const layer = savedLayers()[0] as SshTunnelConfig;
    expect(layer.local_port).toBe(expected);
    expect("local_port" in JSON.parse(JSON.stringify(layer))).toBe(expected !== undefined);
  });

  it.each([
    ["NaN", Number.NaN],
    ["text", "abc"],
  ])("saves no port for a saved non-numeric %s value instead of failing validation", async (_name, saved) => {
    await mountDialog(tunnelled([sshLayer("bastion", { local_port: saved as number })]));

    await save();

    expect(document.body.textContent).not.toContain("Local port must be between 1 and 65535");
    const layer = savedLayers()[0] as SshTunnelConfig;
    expect(layer.local_port).toBeUndefined();
    expect("local_port" in JSON.parse(JSON.stringify(layer))).toBe(false);
  });

  it("saves no port when the field emits a non-numeric value", async () => {
    await mountDialog(tunnelled([sshLayer("bastion", { local_port: 4059 })]));
    // A number input sanitizes text to "", so the raw string only reaches the handler through a text input.
    localPortInput()!.type = "text";

    await typeLocalPort("abc");
    await save();

    expect(document.body.textContent).not.toContain("Local port must be between 1 and 65535");
    expect((savedLayers()[0] as SshTunnelConfig).local_port).toBeUndefined();
  });

  it.each([
    ["70000", "70000"],
    ["0", "0"],
    ["4059.5", "4059.5"],
  ])("refuses to save %s as the port instead of dropping it", async (_name, typed) => {
    await mountDialog(tunnelled([sshLayer("bastion")]));

    await typeLocalPort(typed);
    await save();

    expect(store.updateConnection).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Layer bastion: Local port must be between 1 and 65535");
  });

  it.each([
    ["an earlier enabled layer", [sshLayer("first", { local_port: 4059 }), sshLayer("second")]],
    ["a layer followed by a proxy", [sshLayer("first", { local_port: 4059 }), proxyLayer]],
  ])("refuses a port on %s", async (_name, layers) => {
    await mountDialog(tunnelled(layers));

    await save();

    expect(store.updateConnection).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Layer first: Local port only applies to the last enabled layer");
  });

  it("accepts the port on the last enabled layer when later layers are disabled", async () => {
    await mountDialog(tunnelled([sshLayer("first", { local_port: 4059 }), sshLayer("second", { enabled: false })]));

    await save();

    expect(savedLayers()).toEqual([expect.objectContaining({ id: "first", local_port: 4059 }), expect.objectContaining({ id: "second", enabled: false })]);
  });

  it("drops an invalid port once its layer is disabled so the backend never receives it", async () => {
    await mountDialog(tunnelled([sshLayer("first"), sshLayer("second")]));

    await typeLocalPort("70000");
    document.querySelector<HTMLInputElement>('.connection-transport-layer-option input[type="checkbox"]')!.click();
    await settle();
    await save();

    const [first] = savedLayers() as SshTunnelConfig[];
    expect(first.enabled).toBe(false);
    expect(first.local_port).toBeUndefined();
  });

  it("does not copy the port when a layer is duplicated", async () => {
    await mountDialog(tunnelled([sshLayer("first", { local_port: 4059 })]));

    [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Duplicate")!.click();
    await settle();
    expect(localPortInput()?.value).toBe("");

    document.querySelector<HTMLElement>(".connection-transport-layer-option")!.click();
    await settle();
    expect(localPortInput()?.value).toBe("4059");
  });

  it.each([
    ["ClickHouse", { db_type: "clickhouse", driver_profile: "clickhouse", driver_label: "ClickHouse", port: 8123 }],
    ["Redis Cluster", { db_type: "redis", driver_profile: "redis", driver_label: "Redis", port: 6379, redis_connection_mode: "cluster", redis_cluster_nodes: "10.0.0.1:6379" }],
  ] as [string, Partial<ConnectionConfig>][])("refuses a port on a %s connection, whose primary path never binds it", async (_name, overrides) => {
    await mountDialog(tunnelled([sshLayer("bastion", { local_port: 4059 })], overrides));

    await save();

    expect(store.updateConnection).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Layer bastion: Local port is not supported for this connection type");
  });

  it("saves the same connection type without a port", async () => {
    await mountDialog(tunnelled([sshLayer("bastion")], { db_type: "clickhouse", driver_profile: "clickhouse", driver_label: "ClickHouse", port: 8123 }));

    await save();

    expect((savedLayers()[0] as SshTunnelConfig).local_port).toBeUndefined();
  });

  it("accepts a port on a Redis standalone connection", async () => {
    await mountDialog(tunnelled([sshLayer("bastion", { local_port: 4059 })], { db_type: "redis", driver_profile: "redis", driver_label: "Redis", port: 6379, redis_connection_mode: "standalone" }));

    await save();

    expect(savedLayers()).toEqual([expect.objectContaining({ id: "bastion", local_port: 4059 })]);
  });

  it("refuses a port on a plugin connection whose provider declares proxy_route", async () => {
    backend.listPlugins.mockResolvedValue([pluginWithProvider(true)]);
    await mountDialog(pluginConnection([sshLayer("bastion", { local_port: 4059 })]));

    await save();

    expect(store.updateConnection).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Layer bastion: Local port is not supported for this connection type");
  });

  it("saves a plugin connection with proxy_route when the layer has no port", async () => {
    backend.listPlugins.mockResolvedValue([pluginWithProvider(true)]);
    await mountDialog(pluginConnection([sshLayer("bastion")]));

    await save();

    expect((savedLayers()[0] as SshTunnelConfig).local_port).toBeUndefined();
  });

  it("accepts a port on a plugin connection whose provider does not declare proxy_route", async () => {
    backend.listPlugins.mockResolvedValue([pluginWithProvider(false)]);
    await mountDialog(pluginConnection([sshLayer("bastion", { local_port: 4059 })]));

    await save();

    expect(savedLayers()).toEqual([expect.objectContaining({ id: "bastion", local_port: 4059 })]);
  });

  it("does not offer a port on a layer that is not SSH", async () => {
    await mountDialog(tunnelled([proxyLayer]));

    expect(localPortInput()).toBeNull();
  });
});
