// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig, InstalledPlugin } from "@/types/database";

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

async function mountDialog(config?: ConnectionConfig) {
  const props = reactive({ open: true, editConfig: config, pluginProvider: config ? undefined : { pluginId: "io.dbx.ssh", providerId: "io.dbx.ssh.connection" } });
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

function sshPlugin(): InstalledPlugin {
  return {
    manifest: {
      id: "io.dbx.ssh",
      name: "SSH server",
      drivers: [],
      contributions: [
        {
          type: "connection-provider",
          id: "io.dbx.ssh.connection",
          database_type: "ssh",
          fields: [
            { key: "host", label: "Host", type: "text", binding: "host", default: "ssh.example.com" },
            { key: "port", label: "Port", type: "number", binding: "port", default: 22 },
            { key: "username", label: "Username", type: "text", binding: "username", default: "tester" },
            { key: "password", label: "Password", type: "password", binding: "password" },
          ],
        },
      ],
    },
    compatibility: { compatible: true, errors: [], warnings: [] },
  };
}

function sshConnection(note?: string): ConnectionConfig {
  return {
    id: "ssh-1",
    name: "SSH server",
    db_type: "plugin",
    plugin_id: "io.dbx.ssh",
    plugin_connection_provider: "io.dbx.ssh.connection",
    plugin_connection_type: "ssh",
    host: "ssh.example.com",
    port: 22,
    username: "tester",
    password: "saved-password",
    save_password: true,
    note,
    external_config: { authentication: "password", terminal_encoding: "utf8" },
    connection_secrets: { passphrase: "saved-passphrase" },
  };
}

function genericPlugin(): InstalledPlugin {
  return {
    manifest: {
      id: "io.dbx.kafka",
      name: "Kafka",
      drivers: [],
      contributions: [
        {
          type: "connection-provider",
          id: "io.dbx.kafka.connection",
          database_type: "kafka",
          fields: [
            { key: "host", label: "Broker", type: "text", binding: "host", default: "kafka.example.com" },
            { key: "port", label: "Port", type: "number", binding: "port", default: 9092 },
          ],
        },
      ],
    },
    compatibility: { compatible: true, errors: [], warnings: [] },
  };
}

function genericConnection(note?: string): ConnectionConfig {
  return {
    id: "kafka-1",
    name: "Kafka cluster",
    db_type: "plugin",
    plugin_id: "io.dbx.kafka",
    plugin_connection_provider: "io.dbx.kafka.connection",
    plugin_connection_type: "kafka",
    host: "kafka.example.com",
    port: 9092,
    note,
  };
}

function noteEditor(): HTMLTextAreaElement {
  const editors = document.querySelectorAll<HTMLTextAreaElement>(`textarea[placeholder="${i18n.global.t("connection.notePlaceholder")}"]`);
  expect(editors).toHaveLength(1);
  return editors[0]!;
}

async function changeNote(value: string) {
  const editor = noteEditor();
  editor.value = value;
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

function saveButton(editing = true): HTMLButtonElement {
  const label = i18n.global.t(editing ? "connection.save" : "connection.saveAndConnect");
  const button = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === label);
  expect(button).toBeDefined();
  expect(button!.disabled).toBe(false);
  return button!;
}

describe("ConnectionDialog plugin connection notes", () => {
  beforeEach(() => {
    backend.listPlugins.mockResolvedValue([sshPlugin()]);
    store.connect.mockResolvedValue(undefined);
    settings.editorSettings.sidebarShowConnectionNotes = false;
  });

  it("shows the saved SSH note and sidebar visibility control", async () => {
    await mountDialog(sshConnection("Production SSH server"));

    expect(noteEditor().value).toBe("Production SSH server");
    expect(document.querySelectorAll("#connection-note-sidebar-visibility")).toHaveLength(1);
  });

  it.each([
    ["Existing SSH note", "Updated SSH note"],
    ["Existing SSH note", ""],
    [undefined, "New SSH note"],
  ])("saves SSH note changes from %s to %s and restores them on reopen", async (previousNote, nextNote) => {
    const config = sshConnection(previousNote);
    await mountDialog(config);
    await changeNote(nextNote);
    saveButton().click();

    await vi.waitFor(() => expect(store.updateConnection).toHaveBeenCalledOnce());
    const saved = store.updateConnection.mock.calls[0]![0] as ConnectionConfig;
    expect(saved).toMatchObject({
      id: config.id,
      note: nextNote || undefined,
      db_type: config.db_type,
      plugin_id: config.plugin_id,
      plugin_connection_provider: config.plugin_connection_provider,
      plugin_connection_type: config.plugin_connection_type,
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      external_config: config.external_config,
      connection_secrets: config.connection_secrets,
    });
    expect(config.note).toBe(previousNote);
    await settle();
    await mountDialog(saved);
    expect(noteEditor().value).toBe(nextNote);
  });

  it("saves a note when creating an SSH connection", async () => {
    await mountDialog();
    await changeNote("New SSH server");
    saveButton(false).click();

    await vi.waitFor(() => expect(store.addConnection).toHaveBeenCalledOnce());
    expect(store.addConnection.mock.calls[0]![0]).toMatchObject({
      note: "New SSH server",
      db_type: "plugin",
      plugin_id: "io.dbx.ssh",
      plugin_connection_provider: "io.dbx.ssh.connection",
      host: "ssh.example.com",
    });
  });

  it("saves and restores notes for a non-SSH plugin connection", async () => {
    backend.listPlugins.mockResolvedValue([genericPlugin()]);
    const config = genericConnection("Original Kafka note");
    await mountDialog(config);

    expect(noteEditor().value).toBe("Original Kafka note");
    await changeNote("Updated Kafka note");
    saveButton().click();

    await vi.waitFor(() => expect(store.updateConnection).toHaveBeenCalledOnce());
    const saved = store.updateConnection.mock.calls[0]![0] as ConnectionConfig;
    expect(saved).toMatchObject({
      note: "Updated Kafka note",
      db_type: "plugin",
      plugin_id: "io.dbx.kafka",
      plugin_connection_provider: "io.dbx.kafka.connection",
      plugin_connection_type: "kafka",
      host: "kafka.example.com",
      port: 9092,
    });

    await settle();
    await mountDialog(saved);
    expect(noteEditor().value).toBe("Updated Kafka note");
  });

  it("discards note edits when the dialog is dismissed", async () => {
    const config = sshConnection("Original SSH note");
    await mountDialog(config);
    await changeNote("Unsaved note");
    document.querySelector<HTMLButtonElement>('[data-testid="dismiss-dialog"]')!.click();
    await settle();

    expect(store.updateConnection).not.toHaveBeenCalled();
    expect(store.addConnection).not.toHaveBeenCalled();
    expect(config.note).toBe("Original SSH note");
    await mountDialog(config);
    expect(noteEditor().value).toBe("Original SSH note");
  });

  it("keeps one working note editor for built-in database connections", async () => {
    await mountDialog({ id: "postgres-1", name: "Postgres", db_type: "postgres", host: "localhost", port: 5432, note: "Database note" });
    expect(noteEditor().value).toBe("Database note");
    await changeNote("Updated database note");
    saveButton().click();

    await vi.waitFor(() => expect(store.updateConnection).toHaveBeenCalledOnce());
    expect(store.updateConnection.mock.calls[0]![0]).toMatchObject({ id: "postgres-1", note: "Updated database note" });
  });
});
