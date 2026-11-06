// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick, reactive, type App, type VNode } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ConnectionConfig } from "@/types/database";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";

const fixture = vi.hoisted(() => ({
  tab: "connection",
  stored: null as ConnectionConfig | null,
  store: {
    connectionGroupOptions: [],
    newConnectionGroupId: null,
    selectedConnectionGroupId: null,
    addConnection: vi.fn(),
    updateConnection: vi.fn(),
    refreshNavigationPresentation: vi.fn(),
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
    editorSettings: { sidebarShowConnectionNotes: false, globalConnectTimeoutSecs: 10, globalQueryTimeoutSecs: 0, connectTimeoutInheritConnectionIds: [], queryTimeoutInheritConnectionIds: [], deepLinkConnectionConfirmMode: "always" },
    rememberedDatabaseForConnection: vi.fn(() => ""),
    initEditorSettings: vi.fn(),
    persistEditorSettings: vi.fn(),
    updateEditorSettings: vi.fn(),
    updateEditorSettingsAndPersist: vi.fn(),
  },
  backend: {
    connectDb: vi.fn(),
    disconnectDb: vi.fn(),
    listSchemas: vi.fn(),
    executeQuery: vi.fn(),
    listDatabases: vi.fn(),
    redisListDatabases: vi.fn(),
    testConnectionWithInfo: vi.fn(),
    connectionParameters: vi.fn(),
    listPlugins: vi.fn(),
    listJdbcDrivers: vi.fn(),
    listJdbcMavenBundles: vi.fn(),
    listJdbcLocalBundles: vi.fn(),
    listSshConfigHosts: vi.fn(),
    listInstalledAgents: vi.fn(),
    listInstalledAgentsLocal: vi.fn(),
    listenAgentInstallProgress: vi.fn(),
  },
}));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => fixture.store, CONNECTION_ATTEMPT_CANCELLED_MESSAGE: "cancelled" }));
vi.mock("@/stores/settingsStore", async (original) => ({ ...(await original<typeof import("@/stores/settingsStore")>()), useSettingsStore: () => fixture.settings }));
vi.mock("@/stores/tunnelProfileStore", () => ({ useTunnelProfileStore: () => ({ profiles: [], profileById: () => undefined, init: vi.fn() }) }));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...fixture.backend }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const pass = defineComponent({
    setup:
      (_props, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  const Dialog = defineComponent({
    props: { open: Boolean },
    setup:
      (props, { slots }) =>
      () =>
        props.open ? h("section", slots.default?.()) : null,
  });
  return { Dialog, DialogContent: pass, DialogHeader: pass, DialogTitle: pass, DialogDescription: pass, DialogFooter: pass };
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
        props.value === fixture.tab ? h("div", slots.default?.()) : null,
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
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: {
    props: ["items"],
    setup:
      (props: { items: unknown[] }, { slots }: { slots: { default: (value: { item: unknown }) => VNode[] } }) =>
      () =>
        h(
          "div",
          props.items.flatMap((item) => slots.default({ item })),
        ),
  },
}));
import ConnectionDialog from "../ConnectionDialog.vue";

const apps: App[] = [];
const navigationKeys = ["show_system_schemas", "visible_databases", "visible_database_patterns", "visible_schemas", "schema_visibility"];
function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "navigation-edit",
    name: "Navigation edit",
    db_type: "postgres",
    driver_profile: "postgres",
    driver_label: "PostgreSQL",
    host: "initial.test",
    port: 5432,
    username: "tester",
    password: "typed-password",
    database: "orders",
    save_password: true,
    show_system_schemas: false,
    visible_databases: ["orders"],
    visible_database_patterns: ["order%"],
    visible_schemas: { orders: ["public"], archive: ["history"] },
    ...overrides,
  };
}
async function settle() {
  for (let index = 0; index < 8; index++) await nextTick();
}
function button(label: string, last = false) {
  const matches = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((entry) => entry.textContent?.trim() === label);
  const found = last ? matches.at(-1) : matches[0];
  expect(found, label).toBeDefined();
  return found!;
}
async function inputWithValue(value: string, next: string) {
  const input = [...document.querySelectorAll<HTMLInputElement>("input")].find((entry) => entry.value === value);
  expect(input, value).toBeDefined();
  input!.value = next;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}
function expandSystemGroup() {
  const button = document.querySelector<HTMLButtonElement>('[data-schema-group="system"] button[aria-expanded]');
  expect(button).toBeTruthy();
  if (button!.getAttribute("aria-expanded") === "false") button!.click();
}
async function mount(saved: ConnectionConfig, creating = false, initialVisibleSchemaDatabase?: string) {
  fixture.stored = reactive(saved);
  const state = reactive({ open: true, initialVisibleSchemaDatabase, editConfig: saved });
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(ConnectionDialog, {
          open: state.open,
          initialVisibleSchemaDatabase: state.initialVisibleSchemaDatabase,
          "onUpdate:open": () => {},
          ...(creating
            ? { prefillConfig: { dbType: saved.db_type, driverProfile: saved.driver_profile ?? saved.db_type, driverLabel: saved.driver_label ?? saved.db_type, name: saved.name, host: saved.host, port: saved.port, username: saved.username, password: saved.password, database: saved.database } }
            : { editConfig: state.editConfig }),
        }),
    }),
  );
  app.use(i18n);
  const host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  apps.push(app);
  await settle();
  return Object.assign(state, {
    unmount: () => {
      app.unmount();
      host.remove();
      apps.splice(apps.indexOf(app), 1);
    },
  });
}
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      throw new Error(`Unmocked request: ${String(input)}`);
    }),
  );
  vi.resetAllMocks();
  fixture.tab = "connection";
  i18n.global.locale.value = "en";
  Object.assign(fixture.settings.editorSettings, { sidebarShowConnectionNotes: false, globalConnectTimeoutSecs: 10, globalQueryTimeoutSecs: 0, connectTimeoutInheritConnectionIds: [], queryTimeoutInheritConnectionIds: [] });
  for (const operation of Object.values(fixture.backend)) operation.mockResolvedValue([]);
  fixture.backend.listenAgentInstallProgress.mockResolvedValue(() => {});
  fixture.backend.listSchemas.mockResolvedValue(["public", "sales"]);
  fixture.backend.executeQuery.mockResolvedValue({ columns: ["USERNAME"], rows: [["SYS"], ["SYSRAC"]] });
  fixture.store.getConfig.mockImplementation((id) => (fixture.stored?.id === id ? fixture.stored : undefined));
  fixture.store.applyGlobalTimeouts.mockImplementation((value) => value);
  fixture.store.connect.mockResolvedValue(undefined);
  fixture.store.ensureConnected.mockResolvedValue(undefined);
  fixture.store.refreshNavigationPresentation.mockResolvedValue(undefined);
  fixture.store.addEphemeralConnection.mockResolvedValue(undefined);
  fixture.store.removeConnection.mockResolvedValue(undefined);
  fixture.store.addConnection.mockImplementation(async (value) => {
    fixture.stored = { ...value, password: value.save_password === false ? "" : value.password };
    return fixture.stored;
  });
  fixture.store.updateConnection.mockImplementation(async (value) => {
    fixture.stored = { ...value, password: value.save_password === false ? "" : value.password };
    return fixture.stored;
  });
});
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount();
  document.body.innerHTML = "";
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("connection form navigation visibility persistence", () => {
  it("discards late root-schema choices after another saved connection replaces the draft", async () => {
    fixture.backend.listInstalledAgentsLocal.mockResolvedValue([{ db_type: "oracle", installed: true }]);
    let complete!: (names: string[]) => void;
    fixture.backend.listSchemas.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          complete = resolve;
        }),
    );
    const first = config({ id: "root-a", db_type: "oracle", driver_profile: "oracle", visible_databases: undefined, visible_database_patterns: undefined, visible_schemas: { orders: ["APP"] } });
    const state = await mount(first);
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 })).click();
    await vi.waitFor(() => expect(fixture.backend.listSchemas).toHaveBeenCalledOnce());
    const next = { ...first, id: "root-b", visible_schemas: { orders: ["B_APP"] } };
    fixture.stored = reactive(next);
    state.editConfig = next;
    await settle();
    complete(["LATE_A"]);
    await settle();
    expect(document.querySelector('[data-schema-row="LATE_A"]')).toBeNull();
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ id: "root-b", visible_schemas: { orders: ["B_APP"] } }), expect.anything());
  });
  it("previews root legacy choices without writing and saves current-item overrides only on confirmation", async () => {
    fixture.backend.listInstalledAgentsLocal.mockResolvedValue([{ db_type: "oracle", installed: true }]);
    fixture.backend.listSchemas.mockResolvedValue(["APP", "SALES", "SYS"]);
    await mount(config({ db_type: "oracle", driver_profile: "oracle", visible_schemas: undefined, visible_databases: ["SYS"], visible_database_patterns: ["SA%"], default_schema: "APP" }));
    await vi.waitFor(() => expect(button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 3 })).disabled).toBe(false));
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 3 })).click();
    await vi.waitFor(() => expect(document.querySelector('[data-schema-row="SYS"]')).toBeTruthy());
    expect(document.querySelector('[data-schema-row="SYS"]')?.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[data-schema-row="SALES"]')?.getAttribute("aria-checked")).toBe("true");
    expect(fixture.store.updateConnection).not.toHaveBeenCalled();
    button(i18n.global.t("visibleDatabases.clear")).click();
    await settle();
    button(i18n.global.t("visibleSchemas.save"), true).click();
    await settle();
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledWith(
      expect.objectContaining({ database: "orders", default_schema: "APP", schema_visibility: { migrate_legacy: true, databases: { orders: { APP: false, SALES: false } } }, visible_database_patterns: ["SA%"] }),
      expect.objectContaining({ updatedVisibleSchemaKeys: ["orders"] }),
    );
  });
  it("rejects pending schema choices when another saved id with the same name and physical target replaces the draft", async () => {
    let complete!: (names: string[]) => void;
    fixture.backend.listSchemas.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          complete = resolve;
        }),
    );
    const first = config({ id: "saved-a", visible_databases: undefined, visible_database_patterns: undefined });
    const state = await mount(first);
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 })).click();
    await vi.waitFor(() => expect(fixture.backend.listSchemas).toHaveBeenCalledOnce());
    const next = { ...first, id: "saved-c", visible_schemas: { orders: ["c_schema"], archive: ["c_archive"] } };
    fixture.stored = reactive(next);
    state.editConfig = next;
    await settle();
    complete(["late_a_schema"]);
    await settle();
    expect([...document.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "late_a_schema")).toBe(false);
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "saved-c", name: first.name, host: first.host, database: "orders", visible_schemas: next.visible_schemas }),
      expect.objectContaining({ expectedFingerprint: connectionConfigFingerprint(next), preserveNavigationVisibility: expect.arrayContaining(navigationKeys) }),
    );
    expect(fixture.store.updateConnection.mock.calls[0][1].updatedVisibleSchemaKeys).toBeUndefined();
  });
  it("closes the open schema picker when another saved id replaces the draft and cannot submit its old selection", async () => {
    const first = config({ id: "saved-a", visible_databases: undefined, visible_database_patterns: undefined });
    const state = await mount(first);
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 })).click();
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "sales")).toBe(true));
    button("sales").click();
    const next = { ...first, id: "saved-c", visible_schemas: { orders: ["c_schema"], archive: ["c_archive"] } };
    fixture.stored = reactive(next);
    state.editConfig = next;
    await settle();
    expect([...document.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "sales")).toBe(false);
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "saved-c", visible_schemas: next.visible_schemas }), expect.objectContaining({ preserveNavigationVisibility: expect.arrayContaining(navigationKeys) }));
    expect(fixture.store.updateConnection.mock.calls[0][1].updatedVisibleSchemaKeys).toBeUndefined();
  });
  it("offers one schema filter without the obsolete system toggle for a known PostgreSQL JDBC dialect", async () => {
    fixture.tab = "advanced";
    await mount(config({ db_type: "jdbc", driver_profile: "jdbc", driver_label: "JDBC", connection_string: "jdbc:postgresql://initial.test:5432/orders", jdbc_driver_class: "org.postgresql.Driver", visible_schemas: undefined, visible_databases: undefined, visible_database_patterns: undefined }));
    expect(document.getElementById("connection-show-system-schemas")).toBeNull();
    expect(button(i18n.global.t("visibleSchemas.title"))).toBeDefined();
    expect(fixture.store.connect).not.toHaveBeenCalled();
    expect(fixture.store.ensureConnected).not.toHaveBeenCalled();
    expect(fixture.backend.connectDb).not.toHaveBeenCalled();
    expect(fixture.backend.listSchemas).not.toHaveBeenCalled();
    expect(fixture.store.updateConnection).not.toHaveBeenCalled();
  });
  it("uses PostgreSQL system schema rules in the JDBC picker and saves its selection without changing the JDBC target", async () => {
    fixture.backend.listSchemas.mockResolvedValue(["public", "pg_catalog", "information_schema"]);
    const saved = config({ db_type: "jdbc", driver_profile: "jdbc", driver_label: "JDBC", connection_string: "jdbc:postgresql://initial.test:5432/orders", jdbc_driver_class: "org.postgresql.Driver", visible_schemas: undefined, visible_databases: undefined, visible_database_patterns: undefined });
    await mount(saved);
    button(i18n.global.t("visibleSchemas.title")).click();
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "public")).toBe(true));
    const hasSchema = (name: string) => [...document.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === name);
    expect(hasSchema("pg_catalog")).toBe(false);
    expect(hasSchema("information_schema")).toBe(false);
    expandSystemGroup();
    await settle();
    expect(hasSchema("pg_catalog")).toBe(true);
    expect(hasSchema("information_schema")).toBe(true);
    button("pg_catalog").click();
    button(i18n.global.t("visibleSchemas.save"), true).click();
    await settle();
    expect(fixture.store.updateConnection).not.toHaveBeenCalled();
    button("Save").click();
    await vi.waitFor(() => expect(fixture.store.updateConnection).toHaveBeenCalledOnce());
    expect(fixture.store.updateConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: saved.id,
        db_type: "jdbc",
        driver_profile: "jdbc",
        connection_string: saved.connection_string,
        jdbc_driver_class: saved.jdbc_driver_class,
        host: saved.host,
        port: saved.port,
        database: "orders",
        schema_visibility: { migrate_legacy: true, databases: { orders: { pg_catalog: true } } },
      }),
      expect.objectContaining({ updatedVisibleSchemaKeys: ["orders"] }),
    );
    expect(fixture.backend.listSchemas).toHaveBeenCalledExactlyOnceWith(expect.any(String), "orders", false, true);
    expect(fixture.store.addEphemeralConnection).toHaveBeenCalledWith(expect.objectContaining({ db_type: "jdbc", connection_string: saved.connection_string, database: "orders" }));
    expect(fixture.store.connect).not.toHaveBeenCalled();
  });
  it("edits the initial schema database bucket without changing the connection target", async () => {
    fixture.backend.listSchemas.mockResolvedValue(["history", "archive_extra"]);
    await mount(config({ visible_databases: undefined, visible_database_patterns: undefined }), false, "archive");
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 })).click();
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "archive_extra")).toBe(true));
    expect(fixture.backend.listSchemas).toHaveBeenCalledExactlyOnceWith(expect.any(String), "archive", false, true);
    expect(fixture.store.addEphemeralConnection).toHaveBeenCalledWith(expect.objectContaining({ database: "archive" }));
    button("archive_extra").click();
    button(i18n.global.t("visibleSchemas.save"), true).click();
    await settle();
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ database: "orders", schema_visibility: { migrate_legacy: true, databases: { archive: {} } }, visible_schemas: { orders: ["public"], archive: ["history"] } }),
      expect.objectContaining({ updatedVisibleSchemaKeys: ["archive"] }),
    );
  });
  it("edits the empty root bucket for Oracle JDBC URLs without treating an object owner as a database", async () => {
    fixture.backend.listSchemas.mockResolvedValue(["APP", "SALES"]);
    const saved = config({
      db_type: "jdbc",
      driver_profile: "jdbc",
      driver_label: "JDBC",
      connection_string: "jdbc:oracle:thin:@//initial.test:1521/XE",
      jdbc_driver_class: "oracle.jdbc.OracleDriver",
      database: undefined,
      visible_schemas: { "": ["APP"] },
      visible_databases: undefined,
      visible_database_patterns: undefined,
    });
    await mount(saved, false, "APP");
    const label = i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 });
    await vi.waitFor(() => expect(button(label).disabled).toBe(false));
    button(label).click();
    await vi.waitFor(() => expect(document.querySelector('[data-schema-row="SALES"]')).toBeTruthy());
    button("SALES").click();
    button(i18n.global.t("visibleSchemas.save"), true).click();
    await settle();
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledWith(expect.objectContaining({ database: undefined, connection_string: saved.connection_string, schema_visibility: { migrate_legacy: true, databases: { "": {} } } }), expect.objectContaining({ updatedVisibleSchemaKeys: [""] }));
  });
  it("keeps an open draft scope stable and restores the default database on ordinary reopen", async () => {
    fixture.backend.listSchemas.mockResolvedValue(["public", "history", "archive_extra"]);
    const saved = config({ visible_databases: undefined, visible_database_patterns: undefined });
    const state = await mount(saved, false, "archive");
    state.initialVisibleSchemaDatabase = "orders";
    await settle();
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 })).click();
    await vi.waitFor(() => expect(fixture.backend.listSchemas).toHaveBeenCalledOnce());
    expect(fixture.backend.listSchemas.mock.calls[0][1]).toBe("archive");
    state.open = false;
    await settle();
    fixture.store.stopEditing();
    state.unmount();
    await mount(saved);
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 })).click();
    await vi.waitFor(() => expect(fixture.backend.listSchemas).toHaveBeenCalledTimes(2));
    expect(fixture.backend.listSchemas.mock.calls[1][1]).toBe("orders");
    expect(fixture.store.updateConnection).not.toHaveBeenCalled();
  });
  it("does not install late schema choices after the draft target changes", async () => {
    let complete!: (names: string[]) => void;
    fixture.backend.listSchemas.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          complete = resolve;
        }),
    );
    await mount(config({ visible_databases: undefined, visible_database_patterns: undefined }), false, "archive");
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 })).click();
    await vi.waitFor(() => expect(fixture.backend.listSchemas).toHaveBeenCalledOnce());
    await inputWithValue("initial.test", "new-target.test");
    complete(["late_archive_choice"]);
    await settle();
    expect([...document.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "late_archive_choice")).toBe(false);
    expect(fixture.store.updateConnection).not.toHaveBeenCalled();
    expect(fixture.store.removeConnection).toHaveBeenCalledOnce();
  });
  it("saves a selected system schema and refreshes navigation without changing the connection target", async () => {
    fixture.backend.listSchemas.mockResolvedValue(["public", "sales", "pg_catalog"]);
    const saved = config({ visible_databases: undefined, visible_database_patterns: undefined });
    await mount(saved);
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 })).click();
    await vi.waitFor(() => expect(document.querySelector('[data-schema-group="system"]')).toBeTruthy());
    expandSystemGroup();
    await settle();
    button("pg_catalog").click();
    button(i18n.global.t("visibleSchemas.save"), true).click();
    await settle();
    expect(fixture.store.updateConnection).not.toHaveBeenCalled();
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ database: "orders", schema_visibility: { migrate_legacy: true, databases: { orders: { sales: false, pg_catalog: true } } }, visible_schemas: saved.visible_schemas }),
      expect.objectContaining({ preserveNavigationVisibility: expect.arrayContaining(navigationKeys.filter((key) => key !== "schema_visibility")), expectedFingerprint: connectionConfigFingerprint(saved) }),
    );
    expect(fixture.store.updateConnection.mock.calls[0][1].preserveNavigationVisibility).toContain("show_system_schemas");
    expect(fixture.store.refreshNavigationPresentation).toHaveBeenCalledExactlyOnceWith(saved.id, { visibilityChanged: true });
    expect(fixture.store.connect).not.toHaveBeenCalled();
    expect(fixture.store.ensureConnected).toHaveBeenCalledOnce();
    expect(fixture.backend.connectDb).not.toHaveBeenCalled();
  });
  it("discards a schema selection draft when the connection dialog closes without saving", async () => {
    const saved = config();
    const state = await mount(saved);
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 })).click();
    await vi.waitFor(() => expect(document.querySelector('[data-schema-row="sales"]')).toBeTruthy());
    button("sales").click();
    button(i18n.global.t("visibleSchemas.save"), true).click();
    await settle();
    state.open = false;
    await settle();
    expect(fixture.stored?.show_system_schemas).toBe(false);
    expect(fixture.store.updateConnection).not.toHaveBeenCalled();
    expect(fixture.store.refreshNavigationPresentation).not.toHaveBeenCalled();
    state.open = true;
    await settle();
    expect([...document.querySelectorAll("button")].map((entry) => entry.textContent?.trim()).join(" | ")).toContain(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 }));
  });
  it("retains a failed schema selection draft without refreshing or reconnecting", async () => {
    await mount(config());
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 })).click();
    await vi.waitFor(() => expect(document.querySelector('[data-schema-row="sales"]')).toBeTruthy());
    button("sales").click();
    button(i18n.global.t("visibleSchemas.save"), true).click();
    await settle();
    fixture.store.updateConnection.mockRejectedValueOnce(new Error("fixture save failed"));
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledOnce();
    expect(fixture.store.updateConnection.mock.calls[0][0].schema_visibility).toEqual({ migrate_legacy: true, databases: { orders: {} } });
    expect(fixture.store.refreshNavigationPresentation).not.toHaveBeenCalled();
    expect(fixture.store.connect).not.toHaveBeenCalled();
    expect(button("Save").disabled).toBe(false);
  });
  it("does not refresh navigation or reconnect when the saved visibility is unchanged", async () => {
    await mount(config());
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledOnce();
    expect(fixture.store.refreshNavigationPresentation).not.toHaveBeenCalled();
    expect(fixture.store.connect).not.toHaveBeenCalled();
  });
  it("opens the schema picker when the connection has no existing schema filter", async () => {
    await mount(config({ visible_schemas: undefined, visible_databases: undefined, visible_database_patterns: undefined }));
    button(i18n.global.t("visibleSchemas.title")).click();
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "sales")).toBe(true));
    expect(fixture.backend.listSchemas).toHaveBeenCalledOnce();
    expect(fixture.store.updateConnection).not.toHaveBeenCalled();
  });
  it("preserves every untouched navigation field while saving a changed host", async () => {
    const saved = config();
    await mount(saved);
    await inputWithValue(saved.host, "edited.test");
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: "edited.test" }), expect.objectContaining({ preserveNavigationVisibility: expect.arrayContaining(navigationKeys), expectedFingerprint: connectionConfigFingerprint(saved) }));
    expect(fixture.store.updateConnection.mock.calls[0][1].preserveNavigationVisibility).toHaveLength(5);
  });
  it("only replaces the explicitly edited schema database bucket", async () => {
    await mount(config({ visible_databases: undefined, visible_database_patterns: undefined }));
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 1, total: 0 })).click();
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "sales")).toBe(true));
    button("sales").click();
    button(i18n.global.t("visibleSchemas.save"), true).click();
    await settle();
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ schema_visibility: { migrate_legacy: true, databases: { orders: {} } }, visible_schemas: { orders: ["public"], archive: ["history"] } }),
      expect.objectContaining({ preserveNavigationVisibility: expect.arrayContaining(navigationKeys.filter((key) => key !== "schema_visibility")), updatedVisibleSchemaKeys: ["orders"] }),
    );
    expect(fixture.store.updateConnection.mock.calls[0][1].preserveNavigationVisibility).not.toContain("schema_visibility");
    expect(fixture.store.updateConnection.mock.calls[0][1].preserveNavigationVisibility).toContain("visible_schemas");
    expect(fixture.store.refreshNavigationPresentation).toHaveBeenCalledExactlyOnceWith("navigation-edit", { visibilityChanged: true });
    expect(fixture.store.connect).not.toHaveBeenCalled();
  });
  it("treats Show all databases after a host change as an explicit filter clear", async () => {
    fixture.backend.listDatabases.mockResolvedValue([{ name: "orders" }, { name: "archive" }]);
    await mount(config({ db_type: "mysql", driver_profile: "mysql", driver_label: "MySQL", port: 3306, visible_database_patterns: undefined }));
    await inputWithValue("initial.test", "edited.test");
    button(i18n.global.t("contextMenu.selectVisibleDatabases")).click();
    await vi.waitFor(() => expect([...document.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === i18n.global.t("visibleDatabases.showAll"))).toBe(true));
    button(i18n.global.t("visibleDatabases.showAll")).click();
    await settle();
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledOnce();
    const [submitted, options] = fixture.store.updateConnection.mock.calls[0];
    expect(submitted.visible_databases).toBeUndefined();
    expect(submitted.visible_database_patterns).toBeUndefined();
    expect(options.preserveNavigationVisibility).not.toContain("visible_databases");
    expect(options.preserveNavigationVisibility).not.toContain("visible_database_patterns");
  });
  it("saves current-item choices with ordinary defaults after a host change", async () => {
    fixture.backend.listInstalledAgentsLocal.mockResolvedValue([{ db_type: "oracle", installed: true }]);
    await mount(config({ db_type: "oracle", driver_profile: "oracle", driver_label: "Oracle", port: 1521, visible_databases: undefined, visible_database_patterns: undefined }));
    await inputWithValue("initial.test", "edited.test");
    button(i18n.global.t("visibleSchemas.selectedCount", { selected: 0, total: 0 })).click();
    await vi.waitFor(() => expect(document.querySelector('[data-schema-row="public"]')).toBeTruthy());
    button(i18n.global.t("visibleDatabases.selectAll")).click();
    await settle();
    button(i18n.global.t("visibleSchemas.save"), true).click();
    await settle();
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledOnce();
    const [submitted, options] = fixture.store.updateConnection.mock.calls[0];
    expect(submitted.schema_visibility).toEqual({ migrate_legacy: false, databases: { orders: {} } });
    expect(options.preserveNavigationVisibility).not.toContain("schema_visibility");
    expect(options.updatedVisibleSchemaKeys).toEqual(["orders"]);
  });
  it("uses the saved visibility as the baseline for a second host-only save in a controlled open dialog", async () => {
    const saved = config();
    await mount(saved);
    const returned = config({ visible_databases: ["new-db", "second-db"], visible_database_patterns: ["new%"], show_system_schemas: true, visible_schemas: { orders: ["sales", "audit"], archive: ["new-history"] } });
    fixture.store.updateConnection.mockResolvedValueOnce(returned);
    button("Save").click();
    await settle();
    const selectedTwo = i18n.global.t("visibleSchemas.selectedCount", { selected: 2, total: 0 });
    expect([...document.querySelectorAll("button")].filter((entry) => entry.textContent?.trim() === selectedTwo)).toHaveLength(1);
    expect(button(i18n.global.t("visibleDatabases.selectedCount", { selected: 0, total: 0 }))).toBeDefined();
    fixture.stored = reactive(returned);
    await inputWithValue(saved.host, "second.test");
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).toHaveBeenCalledTimes(2);
    const [submitted, options] = fixture.store.updateConnection.mock.calls[1];
    expect(submitted).toMatchObject({ host: "second.test", show_system_schemas: true, visible_database_patterns: ["new%"] });
    expect(options.preserveNavigationVisibility).toEqual(expect.arrayContaining(navigationKeys));
    expect(options.preserveNavigationVisibility).toHaveLength(5);
    expect(options.updatedVisibleSchemaKeys ?? []).toEqual([]);
  });
  it("keeps this edit's transient password after the Store returns a blank persisted password", async () => {
    await mount(config({ save_password: false }));
    button("Save").click();
    await settle();
    expect([...document.querySelectorAll<HTMLInputElement>("input")].some((entry) => entry.value === "typed-password")).toBe(true);
    await inputWithValue("initial.test", "second.test");
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection.mock.calls[1][0].password).toBe("typed-password");
  });
  it("passes the entered password to Save and Connect when it is not persisted", async () => {
    await mount(config({ id: "new-draft", save_password: false }), true);
    const savePassword = document.querySelector<HTMLInputElement>(`input[aria-label="${i18n.global.t("connection.savePassword")}"]`)!;
    savePassword.click();
    await settle();
    button(i18n.global.t("connection.saveAndConnect")).click();
    await settle();
    expect(fixture.store.addConnection).toHaveBeenCalledWith(expect.objectContaining({ password: "typed-password", save_password: false }), null);
    await vi.waitFor(() => expect(fixture.store.connect).toHaveBeenCalledWith(expect.objectContaining({ password: "typed-password", save_password: false })));
  });
  it("does not submit an obsolete stored target after waiting for global timeout persistence", async () => {
    fixture.tab = "advanced";
    await mount(config({ connect_timeout_inherit: true }));
    const timeout = [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')].find((entry) => entry.value === "10" && !entry.disabled)!;
    expect(timeout).toBeDefined();
    timeout.value = "20";
    timeout.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    let release!: () => void;
    fixture.settings.persistEditorSettings.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    button("Save").click();
    await vi.waitFor(() => expect(fixture.settings.persistEditorSettings).toHaveBeenCalledOnce());
    fixture.stored = config({ host: "concurrently-edited.test" });
    release();
    await settle();
    expect(fixture.store.updateConnection).not.toHaveBeenCalled();
    expect(document.querySelector("section")).not.toBeNull();
    expect(button("Save").disabled).toBe(false);
  });
  it("keeps an edited form when the stored host changed before Save was clicked", async () => {
    await mount(config());
    await inputWithValue("initial.test", "my-draft.test");
    fixture.stored = config({ host: "external-change.test" });
    button("Save").click();
    await settle();
    expect(fixture.store.updateConnection).not.toHaveBeenCalled();
    expect([...document.querySelectorAll<HTMLInputElement>("input")].some((entry) => entry.value === "my-draft.test")).toBe(true);
    expect(button("Save").disabled).toBe(false);
  });
});
