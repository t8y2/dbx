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

describe("ConnectionDialog MQTT certificate credentials", () => {
  it("keeps Basic credentials when switching to client certificate authentication", async () => {
    await mountDialog({
      id: "mqtt-1",
      name: "MQTT",
      db_type: "mqtt",
      username: "",
      password: "",
      host: "broker.example.com",
      port: 8883,
      external_config: {
        host: "broker.example.com",
        port: 8883,
        clientId: "dbx-test",
        tls: true,
        auth: { kind: "password", username: "device", password: "secret" },
      },
    } as ConnectionConfig);
    const certificate = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === i18n.global.t("connection.mqttAuthCertificate"));
    expect(certificate).toBeTruthy();
    certificate!.click();
    await settle();
    const username = document.querySelector<HTMLInputElement>(`input[placeholder="${i18n.global.t("connection.mqttUsernamePlaceholder")}"]`);
    const password = document.querySelector<HTMLInputElement>('input[type="password"]');
    expect(username?.value).toBe("device");
    expect(password?.value).toBe("secret");
    document.querySelector<HTMLInputElement>('input[placeholder="/path/to/client.crt"]')!.value = "/client.crt";
    document.querySelector<HTMLInputElement>('input[placeholder="/path/to/client.crt"]')!.dispatchEvent(new Event("input"));
    document.querySelector<HTMLInputElement>('input[placeholder="/path/to/client.key"]')!.value = "/client.key";
    document.querySelector<HTMLInputElement>('input[placeholder="/path/to/client.key"]')!.dispatchEvent(new Event("input"));
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === i18n.global.t("common.save"));
    expect(save).toBeTruthy();
    save!.click();
    await settle();
    await vi.waitFor(() =>
      expect(store.updateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "mqtt-1",
          external_config: expect.objectContaining({
            auth: expect.objectContaining({
              kind: "certificate",
              username: "device",
              password: "secret",
              clientCertPath: "/client.crt",
              clientKeyPath: "/client.key",
            }),
          }),
        }),
      ),
    );
  });

  it("restores credentials from a saved certificate connection", async () => {
    await mountDialog({
      id: "mqtt-1",
      name: "MQTT",
      db_type: "mqtt",
      username: "",
      password: "",
      host: "broker.example.com",
      port: 8883,
      external_config: { host: "broker.example.com", port: 8883, clientId: "dbx-test", tls: true, auth: { kind: "certificate", username: "device", password: "secret", clientCertPath: "/client.crt", clientKeyPath: "/client.key" } },
    } as ConnectionConfig);
    expect(document.querySelector<HTMLInputElement>(`input[placeholder="${i18n.global.t("connection.mqttUsernamePlaceholder")}"]`)?.value).toBe("device");
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("secret");
  });
});
