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
  tableNameFilterForScope: vi.fn(),
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
    tableNameFilterForScope: (...args: unknown[]) => mocks.tableNameFilterForScope(...args),
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
  mocks.tableNameFilterForScope.mockReturnValue(undefined);
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
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

  it("shows the list copy menu without requiring a selection", async () => {
    const host = await mountBrowser();
    const trigger = host.querySelector<HTMLButtonElement>("[data-object-copy-menu]");
    expect(trigger).toBeDefined();
    trigger!.click();
    await nextTick();
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes("objects.copyCurrentPageAsTable"));
    expect(item).toBeDefined();
    item!.click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenLastCalledWith(expect.stringContaining("audit\tobjects.table")));
  });

  it("preserves routine signatures when copying the current object names", async () => {
    connection.id = "mysql-copy-routines";
    mocks.listObjects.mockResolvedValue([
      { name: "find_user", object_type: "FUNCTION", signature: "id integer" },
      { name: "find_user", object_type: "FUNCTION", signature: "name text" },
      { name: "users", object_type: "TABLE" },
    ]);
    const host = await mountBrowser();
    const allFilter = [...host.querySelectorAll<HTMLButtonElement>("[data-object-filter-chips] button")].find((button) => button.textContent?.includes("objects.all"));
    allFilter?.click();
    await nextTick();
    const copyButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("objects.copyNames"));
    expect(copyButton).toBeDefined();
    copyButton!.click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenLastCalledWith(expect.stringContaining("find_user(id integer)")));
    expect(mocks.copyToClipboard).toHaveBeenLastCalledWith(expect.stringContaining("find_user(name text)"));
  });

  it("uses one unified copy button for selected names", async () => {
    const host = await mountBrowser();
    rowFor(host, "orders").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await nextTick();

    const selectedCopyButtons = [...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.includes("objects.copyTableSelected"));
    expect(selectedCopyButtons).toHaveLength(1);
    selectedCopyButtons[0].click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("orders"));
    expect(host.textContent).not.toContain("objects.copySelectedNames");
  });

  it("keeps the primary selected copy enabled when search hides the selected row", async () => {
    const host = await mountBrowser();
    rowFor(host, "orders").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await nextTick();

    const searchInput = host.querySelector<HTMLInputElement>("[data-object-search-input]")!;
    searchInput.value = "missing";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(host.querySelectorAll(".grid.h-\\[34px\\]")).toHaveLength(0));

    const primaryCopy = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("objects.copyTableSelected"));
    expect(primaryCopy).toBeDefined();
    expect(primaryCopy!.disabled).toBe(false);
    primaryCopy!.click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("orders"));
  });

  it("copies the visible object metadata as a spreadsheet table from the copy menu", async () => {
    mocks.listObjects.mockResolvedValue([
      { name: "orders", object_type: "TABLE", comment: "sales" },
      { name: "users", object_type: "TABLE", comment: "accounts" },
    ]);
    const host = await mountBrowser();
    rowFor(host, "orders").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    rowFor(host, "users").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await nextTick();
    const trigger = host.querySelector<HTMLButtonElement>("[data-object-copy-menu]");
    expect(trigger).toBeDefined();
    trigger!.click();
    await nextTick();
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes("objects.copySelectedAsTable"));
    expect(item).toBeDefined();
    item!.click();
    // MySQL 连接现在包含 charset/collation 列（空值，与对象列表列定义一致）
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenLastCalledWith("objects.name\tobjects.type\tstructureEditor.characterSet\tstructureEditor.collation\tobjects.rows\tobjects.size\tobjects.comment\norders\tobjects.table\t\t\t\t\tsales\nusers\tobjects.table\t\t\t\t\taccounts"));
  });

  it("loads all server-paged filtered objects in batches before copying", async () => {
    connection.id = "oceanbase-copy-all";
    connection.db_type = "oceanbase-oracle";
    mocks.tableNameFilterForScope.mockReturnValue({ includePatterns: [], excludePatterns: ["audit%"] });
    mocks.listObjects.mockImplementation((_id: string, _database: string, _schema: string | undefined, _types: unknown, _filter: string | undefined, limit: number | undefined, offset: number | undefined) => {
      if (limit === 1000 && offset === 1000) return Promise.resolve([{ name: "audit", object_type: "TABLE", comment: "archive" }]);
      if (limit === 1000 && offset === 0) {
        return Promise.resolve([{ name: "orders", object_type: "TABLE", comment: "sales" }, { name: "users", object_type: "TABLE", comment: "accounts" }, ...Array.from({ length: 998 }, (_, index) => ({ name: `table_${index}`, object_type: "TABLE" }))]);
      }
      return Promise.resolve([
        { name: "orders", object_type: "TABLE", comment: "sales" },
        { name: "users", object_type: "TABLE", comment: "accounts" },
      ]);
    });
    const host = await mountBrowser();
    rowFor(host, "orders").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await nextTick();
    host.querySelector<HTMLButtonElement>("[data-object-copy-menu]")!.click();
    await nextTick();
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes("objects.copyAllAsTable"));
    expect(item).toBeDefined();
    item!.click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenLastCalledWith(expect.not.stringContaining("audit")));
    expect(mocks.listObjects.mock.calls.some((call) => call[5] === 1000 && call[6] === 1000)).toBe(true);
  });

  it("keeps all copy-all pages on the start-time search and object filter", async () => {
    connection.id = "oceanbase-copy-snapshot";
    connection.db_type = "oceanbase-oracle";
    const secondPage = deferred<unknown[]>();
    const thirdPage = deferred<unknown[]>();
    mocks.listObjects.mockImplementation((_id: string, _database: string, _schema: string | undefined, types: unknown, filter: string | undefined, limit: number | undefined, offset: number | undefined) => {
      if (limit === 1000 && offset === 0) return Promise.resolve([{ name: "orders", object_type: "TABLE" }, ...Array.from({ length: 999 }, (_, index) => ({ name: `table_${index}`, object_type: "TABLE" }))]);
      if (limit === 1000 && offset === 1000) return secondPage.promise;
      if (limit === 1000 && offset === 2000) {
        expect(types).toEqual(["TABLE"]);
        expect(filter).toBeUndefined();
        return thirdPage.promise;
      }
      return Promise.resolve([
        { name: "orders", object_type: "TABLE" },
        { name: "users", object_type: "TABLE" },
      ]);
    });
    const host = await mountBrowser();
    host.querySelector<HTMLButtonElement>("[data-object-copy-menu]")!.click();
    await nextTick();
    const copyAll = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes("objects.copyAllAsTable"));
    expect(copyAll).toBeDefined();
    copyAll!.click();
    await vi.waitFor(() => expect(mocks.listObjects.mock.calls.some((call) => call[5] === 1000 && call[6] === 1000)).toBe(true));

    host.querySelector<HTMLButtonElement>("[data-object-copy-menu]")!.click();
    await nextTick();
    const duplicate = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent?.includes("objects.copyAllAsTable"));
    expect(duplicate?.getAttribute("aria-disabled")).toBe("true");
    duplicate?.click();

    const searchInput = host.querySelector<HTMLInputElement>("[data-object-search-input]")!;
    searchInput.value = "changed";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    secondPage.resolve([{ name: "users", object_type: "TABLE" }, ...Array.from({ length: 999 }, (_, index) => ({ name: `page2_${index}`, object_type: "TABLE" }))]);
    await vi.waitFor(() => expect(mocks.listObjects.mock.calls.some((call) => call[5] === 1000 && call[6] === 2000)).toBe(true));
    thirdPage.resolve([]);
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith(expect.stringContaining("orders")));
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
    expect(host.querySelector<HTMLButtonElement>("[data-object-copy-menu]")).not.toBeNull();
    const copyButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("objects.copyNames"));
    expect(copyButton).toBeDefined();
    copyButton!.click();
    await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith("audit\norders\nusers"));
    host.querySelector<HTMLElement>("[data-object-browser-root]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
    expect(mocks.store.treeClipboard).toBeNull();
  });
});
