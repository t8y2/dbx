// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, getActivePinia, setActivePinia } from "pinia";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { getCachedObjectBrowserRows, invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { freezeSourceIdentities } from "@/lib/table/objectSourceIdentity";
import type { ConnectionConfig } from "@/types/database";
import type { OracleRoutineOperation } from "@/types/schemaDiff";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  getObjectSource: vi.fn(),
  buildEditableObjectSource: vi.fn(),
  buildExecutableObjectSourceStatements: vi.fn(),
  executeQuery: vi.fn(),
  prepareOracleRoutineSave: vi.fn(),
  updateOracleRoutineOperationReferences: vi.fn(),
  executeOracleRoutineOperation: vi.fn(),
  ensureConnected: vi.fn(),
  toast: vi.fn(),
  sourceTabs: [] as Array<{ id: string; sourceLoad?: { error?: string }; objectSource?: unknown }>,
  openObjectSourceTabPending: vi.fn(),
  sourceLoadFailure: "",
  deferSourceTabLoad: false,
  finishSourceTabLoad: undefined as (() => void) | undefined,
  invalidObjectType: "PROCEDURE",
  deleteSchemaCachePrefix: vi.fn(),
  refreshObjectListTreeNode: vi.fn(),
  createTab: vi.fn(),
  updateSql: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  getObjectSource: (...args: unknown[]) => mocks.getObjectSource(...args),
  buildEditableObjectSource: (...args: unknown[]) => mocks.buildEditableObjectSource(...args),
  buildExecutableObjectSourceStatements: (...args: unknown[]) => mocks.buildExecutableObjectSourceStatements(...args),
  executeQuery: (...args: unknown[]) => mocks.executeQuery(...args),
  prepareOracleRoutineSave: (...args: unknown[]) => mocks.prepareOracleRoutineSave(...args),
  updateOracleRoutineOperationReferences: (...args: unknown[]) => mocks.updateOracleRoutineOperationReferences(...args),
  executeOracleRoutineOperation: (...args: unknown[]) => mocks.executeOracleRoutineOperation(...args),
  deleteSchemaCachePrefix: (...args: unknown[]) => mocks.deleteSchemaCachePrefix(...args),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    treeClipboard: null,
    ensureConnected: mocks.ensureConnected,
    getConfig: () => connection,
    orderByPinnedTreeNodes: (rows: unknown[]) => rows,
    refreshObjectListTreeNode: mocks.refreshObjectListTreeNode,
  }),
}));
vi.mock("@/stores/queryStore", async () => {
  const { reactive } = await import("vue");
  const tabs = reactive(mocks.sourceTabs);
  mocks.openObjectSourceTabPending.mockImplementation(() => {
    const tab = reactive({ id: "source-1", sourceLoad: {} as { error?: string } | undefined, objectSource: undefined as unknown });
    tabs.push(tab);
    const finish = () => {
      if (mocks.sourceLoadFailure) tab.sourceLoad!.error = mocks.sourceLoadFailure;
      else {
        tab.sourceLoad = undefined;
        tab.objectSource = { name: "P_BAD", objectType: "PROCEDURE" };
      }
    };
    mocks.finishSourceTabLoad = finish;
    if (!mocks.deferSourceTabLoad) setTimeout(finish, 0);
    return tab.id;
  });
  return {
    useQueryStore: () => ({
      tabs,
      openObjectSourceTabPending: (...args: unknown[]) => mocks.openObjectSourceTabPending(...args),
      createTab: mocks.createTab,
      updateSql: mocks.updateSql,
    }),
  };
});
vi.mock("@/components/objects/OracleInvalidObjectsDialog.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: { open: Boolean },
      emits: ["update:open", "open-source", "compile-finished", "trigger-result"],
      setup(props, { emit }) {
        return () =>
          props.open
            ? h("div", { "data-invalid-object-dialog": "" }, [
                h("button", { onClick: () => emit("open-source", { owner: "APP", name: "P_BAD", type: mocks.invalidObjectType }) }, "open-source"),
                h("button", { "data-compile-finished": "", onClick: () => emit("compile-finished", { connectionId: "oracle-source", database: "ORCL", schema: "APP_A" }) }, "compile-finished"),
                h("button", { onClick: () => emit("update:open", false) }, "close-dialog"),
              ])
            : null;
      },
    }),
  };
});
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { refreshData: "F5" },
      objectBrowserViewMode: "list",
      objectBrowserShowCheckbox: false,
      sidebarActivation: "single",
    },
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => (values === undefined ? key : `${key}:${Object.values(values).join(",")}`), locale: ref("en-US") }) }));
vi.mock("@/i18n", async () => {
  const { default: en } = await import("@/i18n/locales/en");
  return { default: { install: () => undefined, global: { t: (key: string) => en.objects[key.split(".")[1] as keyof typeof en.objects] || key } } };
});
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("vue-virtual-scroller", () => ({
  RecycleScroller: defineComponent({
    props: { items: { type: Array, default: () => [] } },
    setup(props, { slots }) {
      return () =>
        h(
          "div",
          props.items.map((item) => slots.default?.({ item })),
        );
    },
  }),
}));
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: { render: () => null } }));
vi.mock("@/components/ui/ToolbarOverflowMenu.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/ui/CustomContextMenu.vue", () => ({
  default: defineComponent({
    setup(_, { slots }) {
      return () => slots.default?.({ onContextMenu: () => undefined, isOpen: false });
    },
  }),
}));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

const connection = {
  id: "mysql-views",
  name: "MySQL",
  db_type: "mysql",
  database: "app",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;
const oracleConnection = {
  id: "oracle-source",
  name: "Oracle",
  db_type: "oracle",
  host: "localhost",
  port: 1521,
  username: "APP",
  password: "",
} as ConnectionConfig;

const VIEW_NAME = "v_demo";
const VIEW_SQL = "CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_demo` AS select 1 AS `id`";
const ALTER_SQL = "ALTER ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v_demo` AS select 1 AS `id`";

const SINGLE_CLICK_DELAY = 250;
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  mocks.sourceTabs.splice(0);
  mocks.sourceLoadFailure = "";
  mocks.deferSourceTabLoad = false;
  mocks.finishSourceTabLoad = undefined;
  mocks.invalidObjectType = "PROCEDURE";
  mocks.listObjects.mockResolvedValue([{ name: VIEW_NAME, schema: "app", object_type: "VIEW" }]);
  mocks.listSchemas.mockResolvedValue([]);
  mocks.getObjectSource.mockResolvedValue({ source: VIEW_SQL, editable: true });
  mocks.buildEditableObjectSource.mockImplementation(async (options: { source: string }) => options.source);
  mocks.buildExecutableObjectSourceStatements.mockResolvedValue([ALTER_SQL]);
  mocks.executeQuery.mockResolvedValue({ columns: [], rows: [] });
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.deleteSchemaCachePrefix.mockReset().mockResolvedValue(undefined);
  mocks.refreshObjectListTreeNode.mockResolvedValue(undefined);
  mocks.createTab.mockReturnValue("repair-1");
  invalidateObjectBrowserRowsCache({});
});

afterEach(() => {
  vi.useRealTimers();
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
});

async function mountBrowser(browserConnection = connection, database = "app") {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection: browserConnection, database }) });
  app.use(getActivePinia()!);
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.textContent).toContain(VIEW_NAME));
  return host;
}

async function mountOracleBrowserWithSchema() {
  const schema = ref("APP_A");
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection: oracleConnection, database: "ORCL", schema: schema.value }) });
  app.use(getActivePinia()!);
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.textContent).toContain(VIEW_NAME));
  return { host, schema };
}

function rowFor(host: HTMLElement, name: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>(".grid.h-\\[34px\\]")].find((element) => element.textContent?.includes(name));
  expect(row, name).toBeDefined();
  return row!;
}

function saveButton(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "objects.saveSource");
}

function click(element: HTMLElement, detail = 1) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
}

async function settle() {
  for (let i = 0; i < 12; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await nextTick();
  }
}

/** A VIEW row's single click is deferred by SINGLE_CLICK_DELAY before it opens the panel. */
async function clickRow(host: HTMLElement, name: string) {
  click(rowFor(host, name));
  await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);
  await settle();
}

describe("ObjectBrowser view source save", () => {
  it.each(["confirm", "cancel"] as const)("uses the real production guard before a routine source save (%s)", async (decision) => {
    const target = { ...oracleConnection, id: `browser-production-${decision}`, is_production: true };
    const source = 'CREATE OR REPLACE FUNCTION "APP"."v_demo" RETURN NUMBER AS BEGIN RETURN 1; END;';
    const identity = { owner: "APP", name: VIEW_NAME, kind: "FUNCTION" as const };
    const operation: OracleRoutineOperation = {
      operationId: `browser-production-${decision}`,
      target: { connectionId: target.id, database: "ORCL", schema: "APP", databaseType: "oracle", generation: 0 },
      identity,
      lifecycle: "terminal",
      dispatched: true,
      acknowledged: true,
      readback: { identity, state: "verified", exists: true, source, version: null, definitionMatches: true, compilerMessages: [], issues: [] },
      error: null,
    };
    mocks.listObjects.mockResolvedValue([{ name: VIEW_NAME, schema: "APP", object_type: "FUNCTION" }]);
    mocks.getObjectSource.mockResolvedValue({ name: VIEW_NAME, schema: "APP", object_type: "FUNCTION", source, editable: true });
    mocks.buildExecutableObjectSourceStatements.mockResolvedValue([source]);
    mocks.prepareOracleRoutineSave.mockResolvedValue({ ...operation, lifecycle: "prepared", dispatched: false, acknowledged: false, readback: null });
    mocks.executeOracleRoutineOperation.mockResolvedValue(operation);
    const host = await mountBrowser(target, "ORCL");
    vi.useFakeTimers();
    await clickRow(host, VIEW_NAME);
    click(saveButton(host)!);
    await settle();
    const safety = useProductionSafetyStore();
    expect(safety.pending).toMatchObject({ connectionName: target.name, database: "ORCL", sql: source, source: "production.sourceObjectSource" });
    expect(mocks.prepareOracleRoutineSave).toHaveBeenCalledExactlyOnceWith({ connectionId: target.id, database: "ORCL", identity, sql: source });
    expect(mocks.executeOracleRoutineOperation).not.toHaveBeenCalled();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    if (decision === "confirm") safety.confirm();
    else safety.cancel();
    await settle();
    if (decision === "confirm") {
      expect(mocks.executeOracleRoutineOperation).toHaveBeenCalledExactlyOnceWith(operation.operationId, source);
      expect(mocks.toast).toHaveBeenCalledWith("objects.sourceSaved", 2000);
    } else {
      expect(mocks.executeOracleRoutineOperation).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
      expect(mocks.getObjectSource).toHaveBeenCalledTimes(1);
      expect(saveButton(host)).toBeDefined();
    }
  });

  it.each([false, true])("counts a routine save only after complete verification (valid=%s)", async (valid) => {
    const source = 'CREATE OR REPLACE FUNCTION "APP"."v_demo" RETURN NUMBER AS BEGIN RETURN 1; END;';
    const identity = { owner: "APP", name: VIEW_NAME, kind: "FUNCTION" as const };
    const operation: OracleRoutineOperation = {
      operationId: `browser-routine-${valid}`,
      target: { connectionId: oracleConnection.id, database: "ORCL", schema: "APP", databaseType: "oracle", generation: 0 },
      identity,
      lifecycle: "terminal",
      dispatched: true,
      acknowledged: true,
      readback: { identity, state: valid ? "verified" : "invalid", exists: true, source, version: null, definitionMatches: true, compilerMessages: valid ? [] : [{ attribute: "ERROR", line: 1, position: 72, text: "missing identifier" }], issues: [] },
      error: null,
    };
    mocks.listObjects.mockResolvedValue([{ name: VIEW_NAME, schema: "APP", object_type: "FUNCTION" }]);
    mocks.getObjectSource.mockResolvedValue({ name: VIEW_NAME, schema: "APP", object_type: "FUNCTION", source, editable: true });
    mocks.buildExecutableObjectSourceStatements.mockResolvedValue([source]);
    mocks.prepareOracleRoutineSave.mockResolvedValue({ ...operation, lifecycle: "prepared", dispatched: false, acknowledged: false, readback: null });
    mocks.executeOracleRoutineOperation.mockResolvedValue(operation);
    const host = await mountBrowser(oracleConnection, "ORCL");
    vi.useFakeTimers();
    await clickRow(host, VIEW_NAME);
    click(saveButton(host)!);
    await settle();
    expect(mocks.prepareOracleRoutineSave).toHaveBeenCalledWith({ connectionId: oracleConnection.id, database: "ORCL", identity, sql: source });
    expect(mocks.executeOracleRoutineOperation).toHaveBeenCalledExactlyOnceWith(operation.operationId, source);
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    if (valid) {
      expect(mocks.toast).toHaveBeenCalledWith("objects.sourceSaved", 2000);
      expect(saveButton(host)).toBeUndefined();
    } else {
      expect(host.textContent).toContain("ERROR 1:72 missing identifier");
      expect(mocks.toast).not.toHaveBeenCalledWith("objects.sourceSaved", 2000);
      expect(mocks.getObjectSource).toHaveBeenCalledTimes(1);
      expect(saveButton(host)).toBeDefined();
    }
  });
  it("invalidates completed compile caches but does not refresh an unmounted browser", async () => {
    let release!: () => void;
    mocks.listSchemas.mockResolvedValue(["APP_A", "APP_B"]);
    const ddlPrefix = "object-ddl:v1:oracle-source:ORCL:APP_A:";
    mocks.deleteSchemaCachePrefix.mockImplementation(async (prefix: string) => {
      if (prefix === ddlPrefix) await new Promise<void>((resolve) => (release = resolve));
    });
    const { host } = await mountOracleBrowserWithSchema();
    const scope = { connectionId: oracleConnection.id, database: "ORCL", schema: "APP_A", oracleTriggerContract: 1 as const, exactIdentity: true };
    expect(getCachedObjectBrowserRows(scope)).toBeDefined();
    expect(getCachedObjectBrowserRows({ connectionId: oracleConnection.id, database: "ORCL", schema: "APP_A" })).toBeUndefined();
    expect(getCachedObjectBrowserRows({ ...scope, exactIdentity: false })).toBeUndefined();
    expect(getCachedObjectBrowserRows({ ...scope, oracleTriggerContract: undefined })).toBeUndefined();
    const listCalls = mocks.listObjects.mock.calls.length;
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("processList.oracleInvalidObjects.title"))?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-compile-finished]")?.click();
    await vi.waitFor(() => expect(mocks.deleteSchemaCachePrefix).toHaveBeenCalledWith(ddlPrefix));
    const mounted = mountedApps.splice(
      mountedApps.findIndex((item) => item.host === host),
      1,
    )[0]!;
    mounted.app.unmount();
    release();
    await vi.waitFor(() => expect(getCachedObjectBrowserRows(scope)).toBeUndefined());
    expect(mocks.listObjects).toHaveBeenCalledTimes(listCalls);
    expect(mocks.refreshObjectListTreeNode).not.toHaveBeenCalled();
    host.remove();
  });

  it("still refreshes the mounted browser after compile cache invalidation", async () => {
    mocks.listSchemas.mockResolvedValue(["APP_A", "APP_B"]);
    const { host } = await mountOracleBrowserWithSchema();
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("processList.oracleInvalidObjects.title"))?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-compile-finished]")?.click();
    await vi.waitFor(() => expect(mocks.refreshObjectListTreeNode).toHaveBeenCalledWith(oracleConnection.id, "ORCL", "APP_A"));
  });

  it.each(["INDEX", "JAVA CLASS"])("does not dispatch unsupported %s to a source tab", async (type) => {
    mocks.invalidObjectType = type;
    const host = await mountBrowser(oracleConnection, "ORCL");
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("processList.oracleInvalidObjects.title"))?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-invalid-object-dialog] button")?.click();
    await nextTick();
    expect(mocks.openObjectSourceTabPending).not.toHaveBeenCalled();
    expect(mocks.getObjectSource).not.toHaveBeenCalled();
    expect(host.querySelector("[data-invalid-object-dialog]")).not.toBeNull();
  });

  it.each([
    ["PACKAGE BODY", "PACKAGE_BODY"],
    ["MATERIALIZED VIEW", "MATERIALIZED_VIEW"],
    ["TYPE", "TYPE"],
    ["TYPE BODY", "TYPE_BODY"],
  ])("opens supported %s through the normalized source-tab request", async (type, kind) => {
    mocks.invalidObjectType = type;
    const host = await mountBrowser(oracleConnection, "ORCL");
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("processList.oracleInvalidObjects.title"))?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-invalid-object-dialog] button")?.click();
    expect(mocks.openObjectSourceTabPending).toHaveBeenCalledWith(expect.objectContaining({ schema: "APP", initialEditing: true, request: { name: "P_BAD", objectType: kind } }));
    expect(mocks.createTab).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(host.querySelector("[data-invalid-object-dialog]")).toBeNull());
  });

  it.each([["TRIGGER", "TRIGGER"]])("keeps the supported %s repair path usable", async (type, kind) => {
    mocks.invalidObjectType = type;
    const source = `CREATE OR REPLACE ${type} P_BAD`;
    mocks.getObjectSource.mockResolvedValueOnce({ source, editable: true });
    const host = await mountBrowser(oracleConnection, "ORCL");
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("processList.oracleInvalidObjects.title"))?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-invalid-object-dialog] button")?.click();
    await vi.waitFor(() => expect(mocks.updateSql).toHaveBeenCalledWith("repair-1", source));
    expect(mocks.getObjectSource).toHaveBeenCalledWith(oracleConnection.id, "ORCL", "APP", "P_BAD", kind);
    expect(mocks.createTab).toHaveBeenCalledWith(oracleConnection.id, "ORCL", "Repair - P_BAD", "query", "APP", undefined, undefined);
    expect(mocks.openObjectSourceTabPending).not.toHaveBeenCalled();
    expect(host.querySelector("[data-invalid-object-dialog]")).toBeNull();
  });

  it("closes the invalid-object dialog after its source tab loads", async () => {
    const host = await mountBrowser(oracleConnection, "ORCL");
    const opener = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("processList.oracleInvalidObjects.title"));
    opener?.click();
    await nextTick();
    expect(host.querySelector("[data-invalid-object-dialog]")).not.toBeNull();
    host.querySelector<HTMLButtonElement>("[data-invalid-object-dialog] button")?.click();
    await vi.waitFor(() => expect(host.querySelector("[data-invalid-object-dialog]")).toBeNull());
  });

  it("keeps invalid-object diagnostics open and reports source-load failure", async () => {
    mocks.sourceLoadFailure = "ORA-00942: source unavailable";
    const host = await mountBrowser(oracleConnection, "ORCL");
    const opener = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("processList.oracleInvalidObjects.title"));
    opener?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-invalid-object-dialog] button")?.click();
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("ORA-00942: source unavailable"), 5000));
    expect(host.querySelector("[data-invalid-object-dialog]")).not.toBeNull();
  });

  it("does not close or toast into the current dialog when the schema changes during source loading", async () => {
    mocks.deferSourceTabLoad = true;
    const { host, schema } = await mountOracleBrowserWithSchema();
    const opener = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("processList.oracleInvalidObjects.title"));
    opener?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-invalid-object-dialog] button")?.click();
    await vi.waitFor(() => expect(mocks.finishSourceTabLoad).toBeTypeOf("function"));
    schema.value = "APP_B";
    await nextTick();
    mocks.finishSourceTabLoad?.();
    await nextTick();
    expect(host.querySelector("[data-invalid-object-dialog]")).not.toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("does not let a source request from a closed dialog close its reopened replacement", async () => {
    mocks.deferSourceTabLoad = true;
    const host = await mountBrowser(oracleConnection, "ORCL");
    const opener = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("processList.oracleInvalidObjects.title"));
    opener?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-invalid-object-dialog] button")?.click();
    await vi.waitFor(() => expect(mocks.finishSourceTabLoad).toBeTypeOf("function"));
    host.querySelector<HTMLButtonElement>("[data-invalid-object-dialog] button:last-child")?.click();
    await nextTick();
    opener?.click();
    await nextTick();
    expect(host.querySelector("[data-invalid-object-dialog]")).not.toBeNull();
    mocks.finishSourceTabLoad?.();
    await nextTick();
    expect(host.querySelector("[data-invalid-object-dialog]")).not.toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("does not create a repair tab or toast when a TRIGGER source request returns after unmount", async () => {
    let release!: (value: { source: string; editable: boolean }) => void;
    mocks.invalidObjectType = "TRIGGER";
    mocks.getObjectSource.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    const host = await mountBrowser(oracleConnection, "ORCL");
    const opener = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("processList.oracleInvalidObjects.title"));
    opener?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-invalid-object-dialog] button")?.click();
    await vi.waitFor(() => expect(mocks.getObjectSource).toHaveBeenCalledWith(oracleConnection.id, "ORCL", "APP", "P_BAD", "TRIGGER"));
    const mounted = mountedApps.splice(
      mountedApps.findIndex((item) => item.host === host),
      1,
    )[0]!;
    mounted.app.unmount();
    release({ source: "CREATE TRIGGER P_BAD BEFORE INSERT ON T BEGIN NULL; END;", editable: true });
    await Promise.resolve();
    await nextTick();
    expect(mocks.openObjectSourceTabPending).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    host.remove();
  });

  it("does not create another TYPE tab or toast when its pending source finishes after unmount", async () => {
    mocks.invalidObjectType = "TYPE";
    mocks.deferSourceTabLoad = true;
    const host = await mountBrowser(oracleConnection, "ORCL");
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("processList.oracleInvalidObjects.title"))?.click();
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-invalid-object-dialog] button")?.click();
    await vi.waitFor(() => expect(mocks.finishSourceTabLoad).toBeTypeOf("function"));
    expect(mocks.openObjectSourceTabPending).toHaveBeenCalledOnce();
    const mounted = mountedApps.splice(
      mountedApps.findIndex((item) => item.host === host),
      1,
    )[0]!;
    mounted.app.unmount();
    mocks.finishSourceTabLoad?.();
    await nextTick();
    expect(mocks.openObjectSourceTabPending).toHaveBeenCalledOnce();
    expect(mocks.createTab).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    host.remove();
  });

  it("does not dispatch a save whose source identity changed during SQL construction", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();
    await clickRow(host, VIEW_NAME);
    let complete!: (value: string[]) => void;
    mocks.buildExecutableObjectSourceStatements.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        complete = resolve;
      }),
    );
    click(saveButton(host)!);
    await settle();
    const migration = freezeSourceIdentities([{ connectionId: connection.id, database: "app", schema: "app", objectType: "VIEW", name: VIEW_NAME }]);
    migration.markDispatched();
    migration.finish();
    complete([ALTER_SQL]);
    await settle();
    expect(mocks.executeQuery).not.toHaveBeenCalled();
    expect(host.textContent).toContain("reload");
    expect(saveButton(host)).toBeDefined();
  });
  it("keeps the Save button idle and usable after a successful view-source save", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();

    // Single click on a VIEW row opens the source side panel in edit mode.
    await clickRow(host, VIEW_NAME);

    const save = saveButton(host);
    expect(save, "save button").toBeDefined();
    expect(save!.disabled).toBe(false);
    expect(save!.querySelector(".animate-spin")).toBeNull();

    click(save!);
    await settle();
    expect(mocks.executeQuery).toHaveBeenCalledWith("mysql-views", "app", ALTER_SQL, "app");
    expect(mocks.toast).toHaveBeenCalledWith("objects.sourceSaved", 2000);
    // The success path closes the panel (same row + source mode).
    expect(saveButton(host)).toBeUndefined();

    // Re-opening the same view must not inherit the previous save's spinner:
    // the save's finally() cannot clear it once the panel closed and bumped the
    // request-guard epoch, so the new panel load owns that state.
    await clickRow(host, VIEW_NAME);

    const reopened = saveButton(host);
    expect(reopened, "reopened save button").toBeDefined();
    expect(reopened!.querySelector(".animate-spin")).toBeNull();
    expect(reopened!.disabled).toBe(false);
  });
});
