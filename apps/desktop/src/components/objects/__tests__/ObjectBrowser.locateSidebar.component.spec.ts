// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig, ObjectBrowserViewMode } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  mongoListCollections: vi.fn(),
  ensureConnected: vi.fn(),
  openTable: vi.fn(),
  locateTable: vi.fn(),
  viewMode: "list" as ObjectBrowserViewMode,
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  mongoListCollections: (...args: unknown[]) => mocks.mongoListCollections(...args),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: () => connection,
    ensureConnected: mocks.ensureConnected,
    orderByPinnedTreeNodes: (rows: unknown[]) => rows,
  }),
}));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { refreshData: "F5" },
      objectBrowserViewMode: mocks.viewMode,
      objectBrowserShowCheckbox: false,
      sidebarActivation: "double",
    },
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => (key === "sidebar.locateActiveTab" ? "Locate in sidebar" : key), locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
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
vi.mock("@/components/editor/QueryEditor.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/editor/DangerConfirmDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/ProcedureExecutionDialog.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/objects/CustomTypeInfoPanel.vue", () => ({ default: { render: () => null } }));
vi.mock("@/components/export/XlsxHeaderDialog.vue", () => ({ default: { render: () => null } }));

const connection = {
  id: "locate-connection",
  name: "PostgreSQL",
  db_type: "postgres",
  database: "connection_default",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];
const gridStyle = document.createElement("style");
gridStyle.textContent = ".object-browser-grid-wrapper { padding: 8px; }";

beforeEach(() => {
  document.head.append(gridStyle);
  vi.clearAllMocks();
  mocks.viewMode = "list";
  connection.db_type = "postgres";
  mocks.listObjects.mockResolvedValue([
    { name: "orders", object_type: "TABLE", schema: "row_schema" },
    { name: "customers", object_type: "TABLE", schema: "row_schema" },
    { name: "recent_orders", object_type: "VIEW", schema: "row_schema" },
    { name: "order_totals", object_type: "MATERIALIZED_VIEW", schema: "row_schema" },
    { name: "refresh_orders", object_type: "PROCEDURE", schema: "row_schema" },
  ]);
  mocks.listSchemas.mockResolvedValue(["browser_schema", "row_schema"]);
  mocks.mongoListCollections.mockResolvedValue([
    { name: "orders", kind: "collection" },
    { name: "recent_orders", kind: "view" },
  ]);
  mocks.ensureConnected.mockResolvedValue(undefined);
  invalidateObjectBrowserRowsCache({});
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
  gridStyle.remove();
});

async function mountBrowser(options: { schema?: string; catalog?: string } = { schema: "browser_schema", catalog: "external_catalog" }) {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({
    setup: () => () => h(ObjectBrowser, { connection, database: "browser_database", selectedObjectFilter: "all", ...options, onOpenTable: mocks.openTable, onLocateTable: mocks.locateTable }),
  });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.querySelector('[title="orders"]')).not.toBeNull());
  return host;
}

function rowFor(host: HTMLElement, name: string): HTMLElement {
  const row = host.querySelector(`[title="${name}"]`)?.closest<HTMLElement>(".cursor-default");
  expect(row, name).toBeTruthy();
  return row!;
}

async function openMenu(host: HTMLElement, name: string) {
  rowFor(host, name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await nextTick();
}

function menuButton(label: string): HTMLButtonElement {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].filter((button) => button.textContent?.trim() === label);
  expect(buttons, label).toHaveLength(1);
  expect(buttons[0]!.disabled).toBe(false);
  return buttons[0]!;
}

describe.each(["list", "grid"] as const)("ObjectBrowser locate in sidebar (%s)", (viewMode) => {
  beforeEach(() => {
    mocks.viewMode = viewMode;
  });

  it.each([
    ["orders", "TABLE"],
    ["recent_orders", "VIEW"],
    ["order_totals", "MATERIALIZED_VIEW"],
  ])("locates %s with the exact row identity without opening a tab", async (tableName, tableType) => {
    const host = await mountBrowser();
    expect(host.querySelector(viewMode === "grid" ? ".object-browser-grid-scroller" : ".object-browser-scroller")).not.toBeNull();
    await openMenu(host, tableName);
    expect(mocks.locateTable).not.toHaveBeenCalled();
    mocks.ensureConnected.mockClear();

    menuButton("Locate in sidebar").click();
    await nextTick();

    expect(mocks.locateTable).toHaveBeenCalledExactlyOnceWith({ tableName, tableType, schema: "row_schema", catalog: "external_catalog" });
    expect(mocks.openTable).not.toHaveBeenCalled();
    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    expect(document.querySelector("[data-dbx-context-menu]")).toBeNull();
  });

  it("keeps the default schema and catalog unspecified", async () => {
    connection.db_type = "mysql";
    mocks.listObjects.mockResolvedValue([{ name: "orders", object_type: "TABLE" }]);
    const host = await mountBrowser({});
    await openMenu(host, "orders");
    menuButton("Locate in sidebar").click();

    expect(mocks.locateTable).toHaveBeenCalledExactlyOnceWith({ tableName: "orders", tableType: "TABLE", schema: undefined, catalog: undefined });
    expect(mocks.openTable).not.toHaveBeenCalled();
  });

  it("uses the browser schema when the object metadata omits it", async () => {
    mocks.listObjects.mockResolvedValue([{ name: "orders", object_type: "TABLE" }]);
    const host = await mountBrowser();
    await openMenu(host, "orders");
    menuButton("Locate in sidebar").click();

    expect(mocks.locateTable).toHaveBeenCalledExactlyOnceWith({ tableName: "orders", tableType: "TABLE", schema: "browser_schema", catalog: "external_catalog" });
  });

  it.each([
    ["nebula", "orders"],
    ["nebula", "recent_orders"],
    ["victoriametrics", "orders"],
  ] as const)("also exposes locate in the specialized %s menu for %s", async (dbType, name) => {
    connection.db_type = dbType;
    const host = await mountBrowser();
    await openMenu(host, name);
    menuButton("contextMenu.viewData");
    menuButton("Locate in sidebar").click();

    expect(mocks.locateTable).toHaveBeenCalledOnce();
    expect(mocks.locateTable.mock.calls[0]![0].tableName).toBe(name);
    expect(mocks.openTable).not.toHaveBeenCalled();
  });

  it.each([
    ["orders", "TABLE"],
    ["recent_orders", "VIEW"],
  ])("preserves the MongoDB row type when locating %s", async (tableName, tableType) => {
    connection.db_type = "mongodb";
    const host = await mountBrowser({});
    await openMenu(host, tableName);
    menuButton("Locate in sidebar").click();

    expect(mocks.locateTable).toHaveBeenCalledExactlyOnceWith({ tableName, tableType, schema: undefined, catalog: undefined });
    expect(mocks.openTable).not.toHaveBeenCalled();
  });

  it("locates only the context row while preserving the batch selection", async () => {
    const host = await mountBrowser();
    for (const name of ["orders", "customers"]) rowFor(host, name).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await nextTick();
    await openMenu(host, "orders");
    menuButton("Locate in sidebar").click();
    await nextTick();

    expect(mocks.locateTable).toHaveBeenCalledExactlyOnceWith({ tableName: "orders", tableType: "TABLE", schema: "row_schema", catalog: "external_catalog" });
    for (const name of ["orders", "customers"]) expect(rowFor(host, name).classList.contains("bg-accent")).toBe(true);
    await openMenu(host, "orders");
    menuButton("common.more").dispatchEvent(new MouseEvent("mouseenter"));
    await nextTick();
    menuButton("contextMenu.batchDrop");
    menuButton("contextMenu.batchEmpty");
    expect(mocks.openTable).not.toHaveBeenCalled();
  });

  it.each([
    ["orders", "TABLE"],
    ["recent_orders", "VIEW"],
  ])("preserves the view-data menu and double-click action for %s", async (tableName, tableType) => {
    const host = await mountBrowser();
    await openMenu(host, tableName);
    menuButton("contextMenu.viewData").click();
    await nextTick();
    rowFor(host, tableName).dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));

    expect(mocks.openTable).toHaveBeenCalledTimes(2);
    for (const [target] of mocks.openTable.mock.calls) expect(target).toEqual({ tableName, tableType, schema: "row_schema", catalog: "external_catalog", comment: undefined });
    expect(mocks.locateTable).not.toHaveBeenCalled();
  });

  it("keeps non-table object menus unchanged", async () => {
    const host = await mountBrowser();
    await openMenu(host, "refresh_orders");
    expect(document.querySelector("[data-dbx-context-menu]")?.textContent).not.toContain("Locate in sidebar");
    menuButton("contextMenu.viewSource");
    menuButton("contextMenu.executeProcedure");
  });
});
