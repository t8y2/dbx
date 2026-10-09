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

function findModeButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined;
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

describe("ConnectionDialog Salesforce username-password mode", () => {
  it("switches to password mode and reveals the credential inputs", async () => {
    await mountDialog(salesforceConnection());

    const passwordTab = findModeButton("Username & Password");
    expect(passwordTab, "password mode button should exist").toBeTruthy();
    expect(passwordTab!.disabled, "password mode button should be clickable").toBe(false);

    passwordTab!.click();
    await settle();

    expect(passwordTab!.getAttribute("aria-pressed")).toBe("true");
    const username = [...document.querySelectorAll("input")].find((input) => input.getAttribute("placeholder") === "user@example.com");
    expect(username, "username input should render in password mode").toBeTruthy();
    expect((username as HTMLInputElement).disabled).toBe(false);
    const signIn = findModeButton("Sign In");
    expect(signIn, "sign-in button should render in password mode").toBeTruthy();
  });

  it("keeps the password mode button enabled while a browser OAuth authorize is not running", async () => {
    await mountDialog(salesforceConnection({ external_config: { auth: { mode: "oauth", environment: "sandbox", clientId: "consumer-key", authorizedAt: "2026-09-21T00:00:00.000Z" } } } as Partial<ConnectionConfig>));

    const passwordTab = findModeButton("Username & Password");
    expect(passwordTab).toBeTruthy();
    expect(passwordTab!.disabled).toBe(false);
    passwordTab!.click();
    await settle();
    expect(passwordTab!.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows each mode only the guidance that applies to it", async () => {
    const bodyText = () => document.body.textContent ?? "";

    // Token mode carries no Connected App at all: neither client-ID hint renders,
    // and Salesforce has no TLS toggle (the driver always speaks HTTPS).
    await mountDialog(salesforceConnection());
    expect(bodyText()).not.toContain("The Connected App consumer key.");
    expect(bodyText()).not.toContain("Create a Connected App in Salesforce Setup");
    expect(bodyText()).not.toContain("Enable encrypted connection");

    const passwordTab = findModeButton("Username & Password");
    passwordTab!.click();
    await settle();
    expect(bodyText()).toContain("The Connected App consumer key.");
    expect(bodyText()).toContain("No callback URL needed");
    expect(bodyText()).not.toContain("Create a Connected App in Salesforce Setup");

    const deviceTab = findModeButton("Device Code");
    deviceTab!.click();
    await settle();
    expect(bodyText()).toContain("If requesting the code fails");
    expect(bodyText()).not.toContain("No callback URL needed");
  });

  it("reserves the callback-URL guidance for browser OAuth", async () => {
    await mountDialog(salesforceConnection({ external_config: { auth: { mode: "oauth", environment: "sandbox", clientId: "consumer-key" } } } as Partial<ConnectionConfig>));
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Create a Connected App in Salesforce Setup");
    expect(text).not.toContain("The Connected App consumer key.");
    expect(text).not.toContain("If requesting the code fails");
  });
});
