// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig } from "@/types/database";

const { store, settings, backend, platformState } = vi.hoisted(() => ({
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
  platformState: { windows: true, desktop: true },
}));

vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => store, CONNECTION_ATTEMPT_CANCELLED_MESSAGE: "cancelled" }));
vi.mock("@/stores/settingsStore", async (original) => ({ ...(await original<typeof import("@/stores/settingsStore")>()), useSettingsStore: () => settings }));
vi.mock("@/stores/tunnelProfileStore", () => ({ useTunnelProfileStore: () => ({ profiles: [], profileById: () => undefined, init: vi.fn() }) }));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...backend }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => platformState.desktop }));
vi.mock("@/lib/backend/platform", async (original) => ({
  ...(await original<typeof import("@/lib/backend/platform")>()),
  isWindows: () => platformState.windows,
}));
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

function sqlServerConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "sqlserver-conn",
    name: "SQL Server connection",
    db_type: "sqlserver",
    driver_profile: "sqlserver",
    driver_label: "SQL Server",
    host: "sqlserver.example.test",
    port: 1433,
    username: "dbx_test",
    password: "secret",
    database: "master",
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

function buttonByText(text: string): HTMLButtonElement | undefined {
  const selector = text === "SQL Server" ? "button[aria-pressed]" : "button";
  return [...document.querySelectorAll<HTMLButtonElement>(selector)].find((button) => button.textContent?.trim() === text);
}

beforeEach(() => {
  vi.clearAllMocks();
  platformState.windows = true;
  platformState.desktop = true;
  i18n.global.locale.value = "en";
  for (const fn of Object.values(backend)) fn.mockResolvedValue([]);
  backend.listenAgentInstallProgress.mockResolvedValue(() => {});
});

afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount();
  document.body.innerHTML = "";
});

describe("SQL Server Windows authentication", () => {
  it("defaults saved connections to SQL login and preserves their credentials", async () => {
    await mountDialog(sqlServerConnection());
    expect(buttonByText("SQL Server")?.getAttribute("aria-pressed")).toBe("true");
    expect(buttonByText("Windows (current account, NTLM)")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Kerberos is not supported");
    expect(document.querySelector('input[type="password"]')).toBeTruthy();
    buttonByText("Save")!.click();
    await settle();
    expect(store.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ username: "dbx_test", password: "secret" }));
  });

  it("saves Windows authentication, clears unused SQL credentials, and preserves advanced parameters", async () => {
    await mountDialog(sqlServerConnection({ url_params: "applicationName={DBX; Client};encrypt=false" }));
    buttonByText("Windows (current account, NTLM)")!.click();
    await settle();
    expect(document.body.textContent).toContain("Only NTLM is supported; Kerberos is not supported.");
    expect(document.body.textContent).toContain("This option cannot be used if your environment requires Kerberos or disables NTLM.");
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.querySelector('input[aria-label="Save password"]')).toBeNull();
    expect([...document.querySelectorAll("input")].some((input) => input.value === "dbx_test")).toBe(false);
    expect(buttonByText("Legacy")?.disabled).toBe(true);
    buttonByText("Save")!.click();
    await settle();
    expect(store.updateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        url_params: "applicationName={DBX; Client};encrypt=false;sqlserverAuth=windows",
        username: "",
        password: "",
        save_password: false,
      }),
    );
  });

  it("restores the selected Windows mode when editing a saved connection", async () => {
    await mountDialog(sqlServerConnection({ url_params: "sqlserverAuth=windows", username: "", password: "", save_password: false }));
    expect(buttonByText("Windows (current account, NTLM)")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Only NTLM is supported; Kerberos is not supported.");
    expect(document.querySelector('input[type="password"]')).toBeNull();
    buttonByText("SQL Server")!.click();
    await settle();
    expect(document.body.textContent).not.toContain("Kerberos is not supported");
    expect(document.querySelector('input[type="password"]')).toBeTruthy();
    expect(buttonByText("Legacy")?.disabled).toBe(false);
  });

  it.each(["sql", "windows"] as const)("normalizes a host-entered port on submit without blur for %s authentication", async (authentication) => {
    await mountDialog(sqlServerConnection({ url_params: "applicationName={DBX; Client}" }));
    if (authentication === "windows") {
      buttonByText("Windows (current account, NTLM)")!.click();
      await settle();
    }
    const hostInput = [...document.querySelectorAll<HTMLInputElement>("input")].find((input) => input.value === "sqlserver.example.test")!;
    hostInput.value = "tcp:sqlserver.example.test,15433";
    hostInput.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    buttonByText("Save")!.click();
    await settle();
    expect(store.updateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "sqlserver.example.test",
        port: 15433,
        external_config: expect.objectContaining({ portExplicit: true }),
        url_params: authentication === "windows" ? "applicationName={DBX; Client}&sqlserverAuth=windows" : "applicationName={DBX; Client}",
        username: authentication === "windows" ? "" : "dbx_test",
        password: authentication === "windows" ? "" : "secret",
        save_password: authentication !== "windows",
      }),
    );
  });

  it.each([
    { windows: false, desktop: true },
    { windows: true, desktop: false },
  ])("blocks imported Windows authentication outside Windows desktop: %o", async (platform) => {
    Object.assign(platformState, platform);
    await mountDialog(sqlServerConnection({ url_params: "sqlserverAuth=windows" }));
    expect(buttonByText("Windows (current account, NTLM)")?.getAttribute("aria-pressed")).toBe("true");
    expect(buttonByText("Windows (current account, NTLM)")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Only NTLM is supported; Kerberos is not supported.");
    expect(document.body.textContent).toContain("Windows authentication is available only in the Windows desktop app.");
    expect(buttonByText("Test")?.disabled).toBe(true);
    expect(buttonByText("Save")?.disabled).toBe(true);
    expect(document.querySelector('input[type="password"]')).toBeNull();
    buttonByText("SQL Server")!.click();
    await settle();
    expect(buttonByText("Save")?.disabled).toBe(false);
  });

  it("requires switching away from Legacy before selecting Windows authentication", async () => {
    await mountDialog(sqlServerConnection({ driver_profile: "sqlserver-legacy" }));
    expect(buttonByText("Windows (current account, NTLM)")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Windows authentication requires the default driver.");
    buttonByText("Auto")!.click();
    await settle();
    expect(buttonByText("Windows (current account, NTLM)")?.disabled).toBe(false);
  });

  it("blocks an imported Legacy + Windows combination until the driver is changed", async () => {
    await mountDialog(sqlServerConnection({ driver_profile: "sqlserver-legacy", url_params: "sqlserverAuth=windows" }));
    expect(buttonByText("Save")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Windows authentication requires the default driver.");
    buttonByText("Auto")!.click();
    await settle();
    expect(buttonByText("Save")?.disabled).toBe(false);
    buttonByText("Save")!.click();
    await settle();
    expect(store.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ driver_profile: "sqlserver", url_params: "sqlserverAuth=windows" }));
  });

  it("rejects conflicting authentication parameters until a mode is explicitly selected", async () => {
    await mountDialog(sqlServerConnection({ url_params: "sqlserverAuth=windows;sqlserverAuth=sql" }));
    expect(buttonByText("Save")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Invalid or conflicting SQL Server authentication settings.");
    buttonByText("SQL Server")!.click();
    await settle();
    expect(buttonByText("Save")?.disabled).toBe(false);
    buttonByText("Save")!.click();
    await settle();
    expect(store.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ url_params: "" }));
  });
});
