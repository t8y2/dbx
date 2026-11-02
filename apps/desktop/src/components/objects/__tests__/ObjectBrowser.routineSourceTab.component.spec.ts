// @vitest-environment happy-dom

import { createApp, defineComponent, h, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  getObjectSource: vi.fn(),
  buildEditableObjectSource: vi.fn(),
  buildDropObjectSql: vi.fn(),
  contextMenuAction: "",
  ensureConnected: vi.fn(),
  openObjectSourceTabPending: vi.fn(),
  toast: vi.fn(),
  typePanelRefresh: vi.fn(),
  editorSettings: {
    shortcuts: { refreshData: "F5" },
    objectBrowserViewMode: "list",
    objectBrowserShowCheckbox: false,
    sidebarActivation: "single",
    objectBrowserAutoOpenDetailPanel: true as boolean | undefined,
  },
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  getObjectSource: (...args: unknown[]) => mocks.getObjectSource(...args),
  buildEditableObjectSource: (...args: unknown[]) => mocks.buildEditableObjectSource(...args),
  buildDropObjectSql: (...args: unknown[]) => mocks.buildDropObjectSql(...args),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    treeClipboard: null,
    ensureConnected: mocks.ensureConnected,
    getConfig: () => connection,
    tableNameFilterForScope: () => undefined,
    orderByPinnedTreeNodes: (rows: unknown[]) => rows,
  }),
}));
vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ openObjectSourceTabPending: mocks.openObjectSourceTabPending }),
}));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: mocks.editorSettings,
    updateEditorSettings: (partial: Partial<typeof mocks.editorSettings>) => {
      Object.assign(mocks.editorSettings, partial);
    },
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
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
    props: { items: { type: [Array, Function], default: () => [] } },
    setup(props, { slots }) {
      return () =>
        slots.default?.({
          onContextMenu: () => {
            const items = typeof props.items === "function" ? props.items() : props.items;
            items.find((item: { label?: string }) => item.label === mocks.contextMenuAction)?.action?.();
          },
          isOpen: false,
        });
    },
  }),
}));
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({
  default: defineComponent({
    props: { name: { type: String, default: "" } },
    setup(props, { expose }) {
      expose({ selectTab: vi.fn(), refresh: mocks.typePanelRefresh });
      return () => h("div", { "data-custom-type-panel": true }, props.name);
    },
  }),
}));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

const connection = {
  id: "mysql-routines",
  name: "MySQL",
  db_type: "mysql",
  database: "app",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;

// ObjectBrowser.vue's SINGLE_CLICK_DELAY; the deferral is what lets a second
// click cancel the side panel before it loads.
const SINGLE_CLICK_DELAY = 250;
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  connection.db_type = "mysql";
  mocks.contextMenuAction = "";
  mocks.buildDropObjectSql.mockResolvedValue('DROP PROCEDURE "app"."sp_daily_report"();');
  mocks.listObjects.mockResolvedValue([
    { name: "sp_daily_report", schema: "app", object_type: "PROCEDURE", signature: "IN day DATE" },
    { name: "fn_total", schema: "app", object_type: "FUNCTION", signature: "" },
    { name: "seq_invoice", schema: "app", object_type: "SEQUENCE" },
  ]);
  mocks.listSchemas.mockResolvedValue([]);
  mocks.getObjectSource.mockResolvedValue({ source: "CREATE PROCEDURE sp_daily_report() BEGIN END", editable: true });
  mocks.buildEditableObjectSource.mockImplementation(async (options: { source: string }) => options.source);
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.openObjectSourceTabPending.mockReturnValue("tab-1");
  mocks.editorSettings.objectBrowserAutoOpenDetailPanel = true;
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

async function mountBrowser(browserConnection: ConnectionConfig = connection, readyName = "sp_daily_report") {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection: browserConnection, database: "app" }) });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.textContent).toContain(readyName));
  return host;
}

function rowFor(host: HTMLElement, name: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>(".grid.h-\\[34px\\]")].find((element) => element.textContent?.includes(name));
  expect(row, name).toBeDefined();
  return row!;
}

function click(row: HTMLElement, detail: number) {
  row.dispatchEvent(new MouseEvent("click", { bubbles: true, detail }));
}

describe("ObjectBrowser routine double click", () => {
  it("opens Oracle TYPE details and reads TYPE_BODY through the existing source panel", async () => {
    const oracleConnection = { ...connection, id: "oracle-1", db_type: "oracle" } as ConnectionConfig;
    mocks.listObjects.mockResolvedValue([
      { name: "address_type", schema: "app", object_type: "TYPE" },
      { name: "address_type_body", schema: "app", object_type: "TYPE_BODY" },
    ]);
    mocks.getObjectSource.mockResolvedValue({ source: "CREATE TYPE BODY app.address_type_body AS ...;", editable: false });
    const host = await mountBrowser(oracleConnection, "address_type");

    click(rowFor(host, "address_type"), 1);
    await vi.waitFor(() => expect(host.textContent).toContain("address_type"));
    const refresh = host.querySelector<HTMLButtonElement>('button[title^="grid.refresh"]');
    refresh?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(mocks.typePanelRefresh).toHaveBeenCalledTimes(1));

    click(rowFor(host, "address_type_body"), 1);
    await vi.waitFor(() => expect(mocks.getObjectSource).toHaveBeenCalledWith("oracle-1", "app", "app", "address_type_body", "TYPE_BODY", undefined));
    expect(mocks.buildEditableObjectSource).not.toHaveBeenCalled();
  });

  it.each(["", "v integer", "v INOUT integer"])("keeps the selected Kingbase overload in its DROP preview (%j)", async (signature) => {
    connection.db_type = "kingbase";
    mocks.listObjects.mockResolvedValue([{ name: "sp_daily_report", schema: "app", object_type: "PROCEDURE", signature }]);
    mocks.contextMenuAction = "contextMenu.dropProcedure";
    const host = await mountBrowser();

    rowFor(host, "sp_daily_report").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    await vi.waitFor(() =>
      expect(mocks.buildDropObjectSql).toHaveBeenCalledWith(
        expect.objectContaining({
          databaseType: "kingbase",
          objectType: "PROCEDURE",
          schema: "app",
          name: "sp_daily_report",
          signature,
        }),
      ),
    );
  });

  it("keeps a reopened source panel independent of the previous late response", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();
    let release!: (value: { source: string; editable: boolean }) => void;
    mocks.getObjectSource
      .mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      )
      .mockResolvedValueOnce({ source: "FRESH_SOURCE", editable: true });
    const row = rowFor(host, "sp_daily_report");
    click(row, 1);
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY);
    click(row, 1);
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY);
    click(row, 1);
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY);
    expect(mocks.getObjectSource).toHaveBeenCalledTimes(2);
    release({ source: "STALE_SOURCE", editable: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.buildEditableObjectSource).toHaveBeenCalledTimes(1);
    expect(mocks.buildEditableObjectSource).toHaveBeenCalledWith(expect.objectContaining({ source: "FRESH_SOURCE" }));
  });
  it("releases a pending source timer on unmount and discards a late source response", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();
    let release!: (value: { source: string; editable: boolean }) => void;
    mocks.getObjectSource.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    click(rowFor(host, "sp_daily_report"), 1);
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY);
    expect(mocks.getObjectSource).toHaveBeenCalledTimes(1);
    const mounted = mountedApps.splice(
      mountedApps.findIndex((item) => item.host === host),
      1,
    )[0];
    mounted.app.unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    release({ source: "LATE_SOURCE", editable: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.buildEditableObjectSource).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("LATE_SOURCE");
    host.remove();
  });
  it("ends the source-panel wait when the backend never returns", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();
    mocks.getObjectSource.mockReturnValueOnce(new Promise(() => undefined));
    click(rowFor(host, "sp_daily_report"), 1);
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY + 35_001);
    expect(host.textContent).toContain("Metadata loading timed out");
  });
  it("opens an editable source tab for a double-clicked PROCEDURE", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();
    const row = rowFor(host, "sp_daily_report");

    click(row, 1);
    click(row, 2);

    expect(mocks.openObjectSourceTabPending).toHaveBeenCalledTimes(1);
    expect(mocks.openObjectSourceTabPending).toHaveBeenCalledWith({
      connectionId: "mysql-routines",
      database: "app",
      title: "Source - sp_daily_report(IN day DATE)",
      schema: "app",
      catalog: undefined,
      initialEditing: true,
      request: { name: "sp_daily_report", objectType: "PROCEDURE", signature: "IN day DATE" },
    });
    // The second click cancelled the pending single click, so the side panel
    // never fetched the source.
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);
    expect(mocks.getObjectSource).not.toHaveBeenCalled();
  });

  it("opens an editable source tab for a double-clicked FUNCTION", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();
    const row = rowFor(host, "fn_total");

    click(row, 1);
    click(row, 2);

    expect(mocks.openObjectSourceTabPending).toHaveBeenCalledWith(expect.objectContaining({ initialEditing: true, request: { name: "fn_total", objectType: "FUNCTION", signature: "" } }));
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);
    expect(mocks.getObjectSource).not.toHaveBeenCalled();
  });

  it("keeps a single click on the source side panel", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();

    click(rowFor(host, "sp_daily_report"), 1);

    // Deferred: nothing happens until the double-click window closes.
    expect(mocks.getObjectSource).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY);
    expect(mocks.getObjectSource).toHaveBeenCalledWith("mysql-routines", "app", "app", "sp_daily_report", "PROCEDURE", "IN day DATE");
    expect(mocks.openObjectSourceTabPending).not.toHaveBeenCalled();
  });

  it("leaves non-routine source rows on the side panel when double clicked", async () => {
    const host = await mountBrowser();
    vi.useFakeTimers();
    const row = rowFor(host, "seq_invoice");

    click(row, 1);
    click(row, 2);
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);

    expect(mocks.openObjectSourceTabPending).not.toHaveBeenCalled();
    expect(mocks.getObjectSource).toHaveBeenCalledWith("mysql-routines", "app", "app", "seq_invoice", "SEQUENCE", undefined);
  });

  it("does not auto-open source side panel on single click when objectBrowserAutoOpenDetailPanel is false", async () => {
    mocks.editorSettings.objectBrowserAutoOpenDetailPanel = false;
    const host = await mountBrowser();
    vi.useFakeTimers();

    click(rowFor(host, "sp_daily_report"), 1);
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);

    expect(mocks.getObjectSource).not.toHaveBeenCalled();
  });

  it("still opens routine source tab on double click when objectBrowserAutoOpenDetailPanel is false", async () => {
    mocks.editorSettings.objectBrowserAutoOpenDetailPanel = false;
    const host = await mountBrowser();
    vi.useFakeTimers();

    const row = rowFor(host, "sp_daily_report");
    click(row, 1);
    click(row, 2);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.openObjectSourceTabPending).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "mysql-routines",
        database: "app",
        request: expect.objectContaining({ name: "sp_daily_report", objectType: "PROCEDURE" }),
      }),
    );
  });

  it("switches side panel when clicking different objects while detail panel is open and auto-open is false", async () => {
    mocks.editorSettings.objectBrowserAutoOpenDetailPanel = false;
    const host = await mountBrowser();
    vi.useFakeTimers();

    const spRow = rowFor(host, "sp_daily_report");
    click(spRow, 1);
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);
    expect(mocks.getObjectSource).not.toHaveBeenCalled();

    // Manually open the side panel
    const toggleBtn = host.querySelector<HTMLButtonElement>('button[title="objects.openDetailPanel"]');
    expect(toggleBtn).not.toBeNull();
    toggleBtn?.click();
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);

    expect(mocks.getObjectSource).toHaveBeenCalledWith("mysql-routines", "app", "app", "sp_daily_report", "PROCEDURE", "IN day DATE");
    expect(spRow.style.boxShadow).toBe("inset 3px 0 0 var(--primary)");

    // Switch to another object: sequence
    const seqRow = rowFor(host, "seq_invoice");
    click(seqRow, 1);
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);

    expect(mocks.getObjectSource).toHaveBeenCalledWith("mysql-routines", "app", "app", "seq_invoice", "SEQUENCE", undefined);
    expect(spRow.style.boxShadow).toBe("");
    expect(seqRow.style.boxShadow).toBe("inset 3px 0 0 var(--primary)");

    // Clicking the same row again does not close the panel when auto-open is false
    click(seqRow, 1);
    await vi.advanceTimersByTimeAsync(SINGLE_CLICK_DELAY * 2);
    expect(seqRow.style.boxShadow).toBe("inset 3px 0 0 var(--primary)");
  });
});
