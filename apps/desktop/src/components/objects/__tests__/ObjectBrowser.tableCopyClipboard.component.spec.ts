// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ObjectBrowser from "@/components/objects/ObjectBrowser.vue";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  listObjects: vi.fn(),
  listSchemas: vi.fn(),
  getColumns: vi.fn(),
  ensureConnected: vi.fn(),
  copyToClipboard: vi.fn(),
  toast: vi.fn(),
  store: { treeClipboard: null as unknown },
}));

vi.mock("@/lib/backend/api", () => ({
  listObjects: (...args: unknown[]) => mocks.listObjects(...args),
  listSchemas: (...args: unknown[]) => mocks.listSchemas(...args),
  getColumns: (...args: unknown[]) => mocks.getColumns(...args),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    get treeClipboard() {
      return mocks.store.treeClipboard;
    },
    set treeClipboard(value: unknown) {
      mocks.store.treeClipboard = value;
    },
    ensureConnected: mocks.ensureConnected,
    getConfig: () => connection,
    orderByPinnedTreeNodes: (rows: unknown[]) => rows,
  }),
}));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({}) }));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      shortcuts: { refreshData: "F5" },
      objectBrowserViewMode: "list",
      objectBrowserShowCheckbox: false,
      sidebarCopyTableNameSeparator: "newline",
      sidebarCopyTableNameIncludeSchema: false,
    },
  }),
}));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref("en-US") }) }));
vi.mock("@/i18n", () => ({ default: { install: () => undefined } }));
vi.mock("@/composables/useSqlHighlighter", () => ({ useSqlHighlighter: () => ({ highlight: (sql: string) => sql }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/common/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/common/clipboard")>()),
  copyToClipboard: (...args: unknown[]) => mocks.copyToClipboard(...args),
}));
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
  id: "mysql-copy",
  name: "MySQL",
  db_type: "mysql",
  database: "app",
  driver_profile: null,
  url_params: null,
  transport_layers: [],
} as unknown as ConnectionConfig;
const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  connection.db_type = "mysql";
  mocks.store.treeClipboard = null;
  mocks.listObjects.mockResolvedValue([
    { name: "orders", object_type: "TABLE" },
    { name: "users", object_type: "TABLE" },
    { name: "audit", object_type: "TABLE" },
  ]);
  mocks.listSchemas.mockResolvedValue([]);
  mocks.getColumns.mockResolvedValue([]);
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.copyToClipboard.mockResolvedValue(undefined);
  invalidateObjectBrowserRowsCache({});
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  invalidateObjectBrowserRowsCache({});
});

async function mountBrowser() {
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ setup: () => () => h(ObjectBrowser, { connection, database: "app" }) });
  mountedApps.push({ app, host });
  app.mount(host);
  await vi.waitFor(() => expect(host.textContent).toContain("users"));
  return host;
}

function rowFor(host: HTMLElement, name: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>(".grid.h-\\[34px\\]")].find((element) => element.textContent?.includes(name));
  expect(row, name).toBeDefined();
  return row!;
}

async function openColumnInfo(host: HTMLElement, columnCount = 2) {
  rowFor(host, "orders").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await vi.waitFor(() => expect(host.querySelector("[data-object-table-info-panel]")).not.toBeNull());
  const panel = host.querySelector<HTMLElement>("[data-object-table-info-panel]")!;
  const columnsTab = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("grid.tableInfoColumns"));
  expect(columnsTab).toBeDefined();
  columnsTab!.click();
  await vi.waitFor(() => expect(panel.querySelectorAll("[data-table-info-column]")).toHaveLength(columnCount));
  return panel;
}

describe("ObjectBrowser table copy", () => {
  it("copies selected table-info column names and escaped advanced metadata in display order", async () => {
    connection.id = "mysql-copy-columns-keyboard";
    mocks.getColumns.mockResolvedValue([
      { name: "second", data_type: "VARCHAR(20)", is_nullable: false, column_default: "x\ty", is_primary_key: false, extra: null, comment: "line 1\nline 2" },
      { name: "first", data_type: "NUMBER", is_nullable: true, column_default: null, is_primary_key: true, extra: null, comment: 'quote "value"' },
    ]);
    const host = await mountBrowser();
    const panel = await openColumnInfo(host);
    const columns = [...panel.querySelectorAll<HTMLElement>("[data-table-info-column]")];
    columns[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    columns[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    const columnsArea = panel.querySelector<HTMLElement>("[data-table-info-columns]")!;
    columnsArea.focus();
    const search = panel.querySelector<HTMLInputElement>("[data-table-info-search]")!;
    const searchShortcut = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
    search.dispatchEvent(searchShortcut);
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(searchShortcut.defaultPrevented).toBe(false);

    columnsArea.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenLastCalledWith("second\nfirst"));

    const copied: string[] = [];
    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", { value: { setData: (_type: string, value: string) => copied.push(value) } });
    columnsArea.dispatchEvent(copyEvent);
    expect(copyEvent.defaultPrevented).toBe(true);
    expect(copied).toEqual(["second\nfirst"]);

    columnsArea.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true, bubbles: true }));
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenLastCalledWith('#\tgrid.columnName\tgrid.columnType\tgrid.tableInfoNullable\tstructureEditor.defaultValue\tgrid.columnComment\n1\tsecond\tVARCHAR(20)\tNO\t"x\ty"\t"line 1\nline 2"\n2\tfirst\tNUMBER\tYES\t—\t"quote ""value"""'));
  });

  it("neutralizes spreadsheet formulas only in advanced metadata TSV", async () => {
    connection.id = "mysql-copy-columns-formula-guard";
    mocks.getColumns.mockResolvedValue([{ name: "=1+1", data_type: "VARCHAR(20)", is_nullable: false, column_default: " +SUM(1,1)", is_primary_key: false, extra: null, comment: "\tCMD" }]);
    const host = await mountBrowser();
    const panel = await openColumnInfo(host, 1);
    const column = panel.querySelector<HTMLElement>("[data-table-info-column]")!;
    column.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    column.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenLastCalledWith("=1+1"));

    column.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true, bubbles: true }));
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenLastCalledWith("#\tgrid.columnName\tgrid.columnType\tgrid.tableInfoNullable\tstructureEditor.defaultValue\tgrid.columnComment\n1\t'=1+1\tVARCHAR(20)\tNO\t' +SUM(1,1)\t" + '"\'\tCMD"'));
  });

  it("opens the advanced-copy context menu and copies only after its action is chosen", async () => {
    connection.id = "mysql-copy-columns-context";
    mocks.getColumns.mockResolvedValue([
      { name: "id", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: null },
      { name: "note", data_type: "TEXT", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: "memo" },
      { name: "status", data_type: "TEXT", is_nullable: true, column_default: "new", is_primary_key: false, extra: null, comment: null },
    ]);
    const host = await mountBrowser();
    const panel = await openColumnInfo(host, 3);
    const columns = [...panel.querySelectorAll<HTMLElement>("[data-table-info-column]")];
    columns[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    columns[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    columns[1]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 14 }));
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    const action = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((item) => item.textContent?.includes("contextMenu.copyAdvancedInfo"));
      expect(button).toBeDefined();
      return button!;
    });
    action.click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("#\tgrid.columnName\tgrid.columnType\tgrid.tableInfoNullable\tstructureEditor.defaultValue\tgrid.columnComment\n1\tid\tINT\tNO\t—\t\n2\tnote\tTEXT\tYES\t—\tmemo"));
    columns[2]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 14 }));
    expect(mocks.copyToClipboard).toHaveBeenCalledTimes(1);
    const secondAction = await vi.waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((item) => item.textContent?.includes("contextMenu.copyAdvancedInfo"));
      expect(button).toBeDefined();
      return button!;
    });
    secondAction.click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenLastCalledWith("#\tgrid.columnName\tgrid.columnType\tgrid.tableInfoNullable\tstructureEditor.defaultValue\tgrid.columnComment\n3\tstatus\tTEXT\tYES\tnew\t"));
  });

  it("clears the column selection when switching tables or closing the table-info panel", async () => {
    connection.id = "mysql-copy-columns-reset";
    mocks.getColumns.mockResolvedValue([
      { name: "id", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: null },
      { name: "name", data_type: "TEXT", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: null },
    ]);
    const host = await mountBrowser();
    let panel = await openColumnInfo(host);
    panel.querySelector<HTMLElement>('[data-table-info-column="id"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    rowFor(host, "users").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(host.querySelector("[data-object-table-info-panel]")).not.toBeNull());
    panel = host.querySelector<HTMLElement>("[data-object-table-info-panel]")!;
    const columnsTab = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("grid.tableInfoColumns"));
    columnsTab!.click();
    await vi.waitFor(() => expect(panel.querySelectorAll("[data-table-info-column]")).toHaveLength(2));
    const id = panel.querySelector<HTMLElement>('[data-table-info-column="id"]')!;
    const switchShortcut = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    id.dispatchEvent(switchShortcut);
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(switchShortcut.defaultPrevented).toBe(false);

    [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.classList.contains("h-5"))!.click();
    await vi.waitFor(() => expect(host.querySelector("[data-object-table-info-panel]")).toBeNull());
    rowFor(host, "users").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(host.querySelector("[data-object-table-info-panel]")).not.toBeNull());
    panel = await openColumnInfo(host);
    panel.querySelector<HTMLElement>('[data-table-info-column="id"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
  });

  it("clears hidden column selection when the table-info filter changes", async () => {
    connection.id = "mysql-copy-columns-filter-reset";
    mocks.getColumns.mockResolvedValue([
      { name: "id", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: null },
      { name: "name", data_type: "TEXT", is_nullable: true, column_default: null, is_primary_key: false, extra: null, comment: null },
    ]);
    const host = await mountBrowser();
    const panel = await openColumnInfo(host);
    panel.querySelector<HTMLElement>('[data-table-info-column="id"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const search = panel.querySelector<HTMLInputElement>("[data-table-info-search]")!;
    search.value = "name";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(panel.querySelectorAll("[data-table-info-column]")).toHaveLength(1));
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(panel.querySelectorAll("[data-table-info-column]")).toHaveLength(2));
    const name = panel.querySelector<HTMLElement>('[data-table-info-column="name"]')!;
    const filterShortcut = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    name.dispatchEvent(filterShortcut);
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(filterShortcut.defaultPrevented).toBe(false);
  });

  it("writes the selected table names to the system clipboard on Ctrl+C", async () => {
    const host = await mountBrowser();
    rowFor(host, "orders").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    rowFor(host, "users").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await nextTick();

    host.querySelector<HTMLElement>("[data-object-browser-root]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));

    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("orders\nusers"));
    expect(mocks.store.treeClipboard).toMatchObject({ kind: "table-copy", tables: [{ tableName: "orders" }, { tableName: "users" }] });
    expect(mocks.toast).toHaveBeenCalledWith("contextMenu.pasteTableClipboardUpdated", 2000);
  });

  it("reports a failed system clipboard write instead of claiming success", async () => {
    mocks.copyToClipboard.mockRejectedValue(new Error("denied"));
    const host = await mountBrowser();
    rowFor(host, "orders").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await nextTick();

    host.querySelector<HTMLElement>("[data-object-browser-root]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));

    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("grid.copyFailed", 5000));
    expect(mocks.toast).not.toHaveBeenCalledWith("contextMenu.pasteTableClipboardUpdated", 2000);
  });

  it("does not expose relational table copy or batch actions for NebulaGraph", async () => {
    connection.db_type = "nebula";
    const host = await mountBrowser();
    rowFor(host, "orders").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await nextTick();

    expect(host.textContent).not.toContain("objects.exportSelected");
    expect(host.textContent).not.toContain("objects.dropSelected");
    expect(host.querySelector('[title="objects.toggleCheckbox"]')).toBeNull();
    host.querySelector<HTMLElement>("[data-object-browser-root]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(mocks.store.treeClipboard).toBeNull();
  });
});
