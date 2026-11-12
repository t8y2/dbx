// @vitest-environment happy-dom

import { createApp, h, nextTick, reactive, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  updateOpen: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  toast: vi.fn(),
  folders: [] as string[],
  listFiles: vi.fn(),
  globalSearch: vi.fn(),
  connections: [] as any[],
  treeNodes: [] as any[],
  activeConnectionId: undefined as string | undefined,
  connectedIds: new Set<string>(),
  commands: [] as any[],
  pluginOpen: vi.fn(),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ connections: mocks.connections, treeNodes: mocks.treeNodes, activeConnectionId: mocks.activeConnectionId, connectedIds: mocks.connectedIds }),
}));
vi.mock("@/stores/savedSqlStore", () => ({ useSavedSqlStore: () => ({ allFiles: [] }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { shortcuts: {}, fontSize: 13, fontFamily: "monospace", theme: "app" } }) }));
vi.mock("@/composables/useTheme", () => ({ useTheme: () => ({ isDark: { value: false }, themePalette: { value: "pearl" } }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ editorFontTheme: () => [], loadEditorTheme: async () => [] }));
vi.mock("@/lib/backend/safeStorage", () => ({ safeLocalStorageGet: () => null, safeLocalStorageSet: vi.fn() }));
vi.mock("@/components/plugins/PluginIcon.vue", () => ({ default: { render: () => null } }));
vi.mock("@/lib/plugins/pluginCommandPalette", async () => {
  const { ref } = await import("vue");
  return { usePluginCommandPalette: () => ({ items: ref(mocks.commands), refresh: vi.fn(), open: mocks.pluginOpen }) };
});
vi.mock("@/lib/sqlFile/sqlFileFolders", async () => {
  const { ref } = await import("vue");
  return { getSqlFileFolderPaths: () => mocks.folders, getSqlFileFilter: () => "*.sql", sqlFileFoldersVersion: ref(0) };
});
vi.mock("@/lib/globalSearch/globalSearchSettings", async () => {
  const { ref } = await import("vue");
  return { composeGlobalSearchRoots: () => ["/sql"], getGlobalSearchRoots: () => ["/sql"], getGlobalSearchExtensions: () => ["sql"], globalSearchSettingsVersion: ref(0), saveGlobalSearchRoots: vi.fn(), saveGlobalSearchExtensions: vi.fn() };
});
vi.mock("@/lib/backend/api", () => ({
  listPlugins: async () => [],
  listSqlFilesInFolder: mocks.listFiles,
  readExternalSqlFileSnapshot: async (...args: unknown[]) => ({ content: await mocks.read(...args), version: { contentHash: "original", modifiedNs: "1", sizeBytes: 26 }, encoding: "utf8" }),
  writeExternalSqlFile: mocks.write,
  globalSearch: (...args: unknown[]) => mocks.globalSearch(...args),
}));
vi.mock("@/components/ui/dialog", async () => {
  const { defineComponent, h } = await import("vue");
  const passthrough = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  });
  const dialog = defineComponent({
    emits: ["update:open"],
    setup:
      (_, { slots, emit }) =>
      () =>
        h("div", [h("button", { "data-close-search": "", onClick: () => emit("update:open", false) }, "Close search"), slots.default?.()]),
  });
  return { Dialog: dialog, DialogContent: passthrough };
});

import QuickOpenDialog from "../QuickOpenDialog.vue";
import i18n from "@/i18n";
import { setQuickOpenScopeIds } from "@/lib/quickOpen/quickOpenScope";

let app: App;
let host: HTMLElement;

async function mountSearch() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const props = reactive({ open: false, initialContentMode: true, onSelect: mocks.select, "onUpdate:open": mocks.updateOpen });
  app = createApp({ render: () => h(QuickOpenDialog, props) });
  app.use(i18n);
  app.mount(host);
  props.open = true;
  await nextTick();
  const input = host.querySelector<HTMLInputElement>("input")!;
  input.value = "needle";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await vi.waitFor(() => expect(host.querySelectorAll("[data-selected]")).toHaveLength(2));
  await vi.waitFor(() => expect(host.querySelector(".cm-editor")).not.toBeNull(), { timeout: 10000 });
  return { input, props, rows: [...host.querySelectorAll<HTMLElement>("[data-selected]")] };
}

beforeEach(() => {
  setQuickOpenScopeIds([]);
  mocks.commands = [];
  mocks.pluginOpen.mockReset().mockReturnValue({});
  mocks.folders = [];
  mocks.connections = [];
  mocks.treeNodes = [];
  mocks.activeConnectionId = undefined;
  mocks.connectedIds = new Set();
  localStorage.clear();
  mocks.listFiles.mockReset().mockResolvedValue([]);
  mocks.globalSearch.mockReset().mockResolvedValue({
    matches: [
      { path: "/sql/first.sql", fileName: "first.sql", line: 2, column: 8, lineText: "SELECT needle;", matchText: "needle" },
      { path: "/sql/second.sql", fileName: "second.sql", line: 1, column: 8, lineText: "SELECT needle, 2;", matchText: "needle" },
    ],
    errors: [],
  });
  mocks.select.mockReset();
  mocks.updateOpen.mockReset();
  mocks.read.mockReset().mockResolvedValue("-- heading\nSELECT needle;");
  mocks.write.mockReset().mockResolvedValue({ kind: "written", version: { contentHash: "saved", modifiedNs: "2", sizeBytes: 30 } });
  mocks.toast.mockReset();
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
});
afterEach(() => {
  app?.unmount();
  setQuickOpenScopeIds([]);
  host?.remove();
  vi.restoreAllMocks();
});

describe("empty-query search home", () => {
  it("keeps the visible home selection aligned with Enter", async () => {
    mocks.connections = [{ id: "conn1", name: "Production", db_type: "postgres" }];
    mocks.activeConnectionId = "conn1";
    mocks.connectedIds = new Set(["conn1"]);
    mocks.treeNodes = [
      {
        id: "conn1",
        connectionId: "conn1",
        type: "connection",
        label: "Production",
        children: [{ id: "table1", connectionId: "conn1", type: "table", database: "analytics", schema: "public", label: "users", children: [] }],
      },
    ];

    host = document.createElement("div");
    document.body.appendChild(host);
    const props = reactive({ open: false, onSelect: mocks.select, "onUpdate:open": mocks.updateOpen });
    app = createApp({ render: () => h(QuickOpenDialog, props) });
    app.use(i18n);
    app.mount(host);
    props.open = true;
    await nextTick();
    await nextTick();

    const selected = host.querySelector<HTMLElement>('[data-selected="true"]');
    expect(selected?.textContent).toContain("users");
    const input = host.querySelector<HTMLInputElement>("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ type: "table", label: "users" }));
  });

  it("restores an uncached remote table from legacy history with the default data action", async () => {
    mocks.connections = [{ id: "conn1", name: "Production", db_type: "postgres" }];
    const item = { id: "remote-table", type: "table", label: "remote_users", connectionId: "conn1", connectionName: "Production", database: "analytics", schema: "public", tableName: "remote_users", tableType: "TABLE", source: "remote", searchText: "remote_users", searchScope: "structure" };
    localStorage.setItem("dbx.quick-open.recent-items", JSON.stringify([{ id: item.id, item, lastOpenedAt: Date.now() }]));
    host = document.createElement("div");
    document.body.appendChild(host);
    const props = reactive({ open: false, onSelect: mocks.select, "onUpdate:open": mocks.updateOpen });
    app = createApp({ render: () => h(QuickOpenDialog, props) });
    app.use(i18n);
    app.mount(host);
    props.open = true;
    await nextTick();
    await nextTick();

    expect(host.querySelector('[data-selected="true"]')?.textContent).toContain("remote_users");
    expect(host.textContent).toContain(i18n.global.t("quickOpen.actionOpenData"));
    const input = host.querySelector<HTMLInputElement>("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ id: item.id, type: "table" }));
    expect(mocks.select.mock.calls.at(-1)?.[0].searchScope).toBeUndefined();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ id: item.id, searchScope: "structure" }));
    const stored = JSON.parse(localStorage.getItem("dbx.quick-open.recent-items")!);
    expect(stored[0].item.searchScope).toBeUndefined();

    props.open = false;
    await nextTick();
    props.open = true;
    await nextTick();
    await nextTick();
    expect(host.querySelector('[data-selected="true"]')?.textContent).toContain("remote_users");
    expect(host.textContent).toContain(i18n.global.t("quickOpen.actionOpenData"));
    host.querySelector<HTMLInputElement>("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ id: item.id, type: "table", tableName: "remote_users" }));
    expect(mocks.select.mock.calls.at(-1)?.[0].searchScope).toBeUndefined();
  });

  it("keeps materialized views on their default action without a hidden structure shortcut", async () => {
    mocks.connections = [{ id: "conn1", name: "Production", db_type: "postgres" }];
    mocks.activeConnectionId = "conn1";
    mocks.connectedIds = new Set(["conn1"]);
    mocks.treeNodes = [
      {
        id: "conn1",
        connectionId: "conn1",
        type: "connection",
        label: "Production",
        children: [{ id: "mview1", connectionId: "conn1", type: "materialized_view", database: "analytics", schema: "public", label: "daily_sales", children: [] }],
      },
    ];

    host = document.createElement("div");
    document.body.appendChild(host);
    const props = reactive({ open: false, onSelect: mocks.select, "onUpdate:open": mocks.updateOpen });
    app = createApp({ render: () => h(QuickOpenDialog, props) });
    app.use(i18n);
    app.mount(host);
    props.open = true;
    await nextTick();
    await nextTick();

    expect(host.textContent).not.toContain(i18n.global.t("quickOpen.secondaryOpenStructure"));
    const input = host.querySelector<HTMLInputElement>("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));

    const selected = mocks.select.mock.calls.at(-1)?.[0];
    expect(selected).toEqual(expect.objectContaining({ type: "materialized_view", label: "daily_sales" }));
    expect(selected?.searchScope).toBeUndefined();
  });
});

describe("search categories and connection scope", () => {
  async function mountObjects() {
    host = document.createElement("div");
    document.body.appendChild(host);
    const props = reactive({ open: false, onSelect: mocks.select, "onUpdate:open": mocks.updateOpen });
    app = createApp({ render: () => h(QuickOpenDialog, props) });
    app.use(i18n);
    app.mount(host);
    props.open = true;
    await nextTick();
    await nextTick();
    return host.querySelector<HTMLInputElement>("input")!;
  }

  async function search(input: HTMLInputElement, query: string) {
    input.value = query;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
  }

  it.each(["column", "database", "connection"])("keeps %s matches visible for the broad objects query category", async (type) => {
    mocks.connections = [{ id: "conn1", name: "needle", db_type: "postgres" }];
    mocks.treeNodes = [{ id: "target", connectionId: "conn1", type, database: "needle", tableName: "users", label: "needle" }];
    const input = await mountObjects();
    await search(input, "category:objects needle");
    expect(host.querySelectorAll("[data-selected]").length).toBeGreaterThan(0);
    const all = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim().startsWith(i18n.global.t("quickOpen.categoryAll")))!;
    expect(all.classList.contains("bg-foreground")).toBe(true);
    if (type === "column") {
      await search(input, "category:objects kind:column needle");
      const fields = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim().startsWith(i18n.global.t("quickOpen.categoryFields")))!;
      expect(fields.classList.contains("bg-foreground")).toBe(true);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ type: "column", label: "needle" }));
    }
  });

  it.each(["table", "view", "materialized_view", "function", "schema"])("finds %s from the home database objects entry", async (type) => {
    mocks.connections = [{ id: "conn1", name: "Production", db_type: "postgres" }];
    mocks.treeNodes = [{ connectionId: "conn1", type, database: "app", schema: "needle", label: "needle" }];
    const input = await mountObjects();
    const entry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(i18n.global.t("quickOpen.homeSearchObjects")))!;
    entry.click();
    await nextTick();
    await search(input, `${input.value} needle`);
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ type, label: "needle" }));
  });

  it("switches from files to all database objects for kind:object", async () => {
    mocks.connections = [{ id: "conn1", name: "Production", db_type: "postgres" }];
    mocks.treeNodes = [{ connectionId: "conn1", type: "table", database: "app", label: "needle" }];
    const input = await mountObjects();
    await search(input, "kind:file needle");
    await search(input, "kind:object needle");
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ type: "table", label: "needle" }));
  });

  it.each([
    ["sequence", "objects"],
    ["package", "objects"],
    ["package-body", "objects"],
    ["sql_library_file", "files"],
    ["plugin_workbench", "commands"],
  ])("switches from fields to the category for kind:%s", async (kind, category) => {
    const input = await mountObjects();
    await search(input, "kind:column needle");
    await search(input, `kind:${kind} needle`);
    const key = `quickOpen.category${category[0]!.toUpperCase()}${category.slice(1)}`;
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim().startsWith(i18n.global.t(key)))!;
    expect(button.classList.contains("bg-foreground")).toBe(true);
  });

  it.each([
    ["TABLE", "table"],
    ["VIEW", "view"],
    ["MATERIALIZED_VIEW", "materialized_view"],
  ])("inherits %s through cached column groups for Enter and Ctrl+Enter", async (tableType, type) => {
    mocks.connections = [{ id: "conn1", name: "Production", db_type: "postgres" }];
    mocks.treeNodes = [
      {
        id: "owner1",
        connectionId: "conn1",
        type,
        database: "analytics",
        schema: "public",
        label: "users",
        children: [
          {
            id: "columns1",
            type: "group-columns",
            database: "analytics",
            schema: "public",
            tableName: "users",
            children: [{ id: "column1", connectionId: "conn1", type: "column", database: "analytics", schema: "public", tableName: "users", label: "email (text)", meta: { name: "email", data_type: "text" } }],
          },
        ],
      },
    ];
    const input = await mountObjects();
    await search(input, "kind:column email");
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ type: "column", tableType, tableName: "users", columnName: "email" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ type, tableType, label: "users", searchScope: "data", columnName: undefined }));
  });

  it("keeps file and command categories reachable beyond the object result limit", async () => {
    mocks.connections = [{ id: "conn1", name: "Production", db_type: "postgres" }];
    mocks.treeNodes = Array.from({ length: 205 }, (_, index) => ({ connectionId: "conn1", type: "table", database: "analytics", label: `needle_${index}` }));
    mocks.folders = ["/sql"];
    mocks.listFiles.mockResolvedValue([{ name: "needle.sql", path: "/sql/needle.sql", is_dir: false, children: [] }]);
    mocks.commands = [{ id: "command-needle", type: "plugin_command", label: "needle command", connectionId: "", searchText: "needle command", pluginId: "test", commandId: "needle" }];
    const input = await mountObjects();
    await search(input, "needle");
    await vi.waitFor(() => expect(host.querySelectorAll("[data-selected]")).toHaveLength(200));
    const category = (key: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim().startsWith(i18n.global.t(key)))!;
    expect(category("quickOpen.categoryFiles").textContent).toContain("1");
    expect(category("quickOpen.categoryCommands").textContent).toContain("1");
    category("quickOpen.categoryFiles").click();
    await nextTick();
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: "/sql/needle.sql" }));
    category("quickOpen.categoryCommands").click();
    await nextTick();
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.pluginOpen).toHaveBeenCalledWith(expect.objectContaining({ commandId: "needle" }));
  });

  it("preserves keywords when selecting a connection with spaces and filters recent home targets", async () => {
    mocks.connections = [
      { id: "a", name: "Production West", db_type: "postgres" },
      { id: "b", name: "Production East", db_type: "postgres" },
    ];
    mocks.treeNodes = mocks.connections.map((connection) => ({ connectionId: connection.id, type: "table", database: "analytics", label: "users" }));
    const input = await mountObjects();
    await search(input, "users");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: "a" }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await nextTick();
    expect([...host.querySelectorAll<HTMLElement>("[data-selected]")][1]?.dataset.selected).toBe("true");
    const eastButton = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Production East")!;
    eastButton.click();
    await nextTick();
    expect(input.value).toBe("users");
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: "b" }));
    await search(input, "");
    const homeRows = [...host.querySelectorAll<HTMLElement>("[data-selected]")];
    expect(homeRows.some((row) => row.textContent?.includes("Production West"))).toBe(false);
    expect(homeRows.some((row) => row.textContent?.includes("Production East"))).toBe(true);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: "b" }));
  });
});

describe("object search metadata regression", () => {
  it("removes false matches and opens the correct file after keyboard navigation", async () => {
    mocks.folders = ["/order-reports"];
    const firstName = "report-v2024-07-customer-order-detail-export.sql";
    const firstPath = `/order-reports/export/${firstName}`;
    const secondPath = "/order-reports/export/summary.sql";
    mocks.listFiles.mockResolvedValue([
      { name: firstName, path: firstPath, is_dir: false, children: [] },
      { name: "summary.sql", path: secondPath, is_dir: false, children: [] },
    ]);
    host = document.createElement("div");
    document.body.appendChild(host);
    const props = reactive({ open: false, onSelect: mocks.select, "onUpdate:open": mocks.updateOpen });
    app = createApp({ render: () => h(QuickOpenDialog, props) });
    app.use(i18n);
    app.mount(host);
    props.open = true;
    await nextTick();
    const input = host.querySelector<HTMLInputElement>("input")!;
    async function search(query: string) {
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await nextTick();
    }
    await vi.waitFor(() => expect(host.querySelectorAll("[data-selected]")).toHaveLength(2));
    await search("cordetxprep");
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).not.toHaveBeenCalled();
    await search("cordetxp");
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: firstPath, label: firstName }));
    mocks.select.mockClear();
    await search("ORDER-REPORTS");
    const rows = [...host.querySelectorAll<HTMLElement>("[data-selected]")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("summary.sql");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await nextTick();
    expect(rows[1].dataset.selected).toBe("true");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: firstPath }));
    await search("missing-file");
    expect(host.querySelectorAll("[data-selected]")).toHaveLength(0);
    await search("summary");
    expect(host.querySelector('[data-selected="true"]')?.textContent).toContain("summary.sql");
  });
});

describe("content search preview navigation", () => {
  it("keeps the second editing target through category, filter, and external mode changes", async () => {
    const { input, rows, props } = await mountSearch();
    rows[1]!.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.waitFor(() => expect(mocks.read).toHaveBeenLastCalledWith("/sql/second.sql", 32 * 1024 * 1024));
    await vi.waitFor(() => expect(host.querySelector('button[aria-label="Edit"]')?.hasAttribute("disabled")).toBe(false));
    host.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!.click();
    await nextTick();
    await nextTick();
    const editor = host.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editor)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nSELECT 3;" } });
    const category = (key: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim().startsWith(i18n.global.t(key)))!;
    category("quickOpen.categoryFiles").click();
    const filter = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "kind:table")!;
    expect(filter.disabled).toBe(true);
    filter.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    props.initialContentMode = false;
    await nextTick();
    expect(input.value).toBe("needle");
    expect(rows[1]!.dataset.selected).toBe("true");
    expect(category("quickOpen.categoryContent").classList.contains("bg-foreground")).toBe(true);
    expect(host.querySelectorAll(".cm-editor")).toHaveLength(1);
    expect(host.querySelector(".cm-editor")).toBe(editor);
    expect(editor.closest("aside")?.classList.contains("hidden")).toBe(false);
    expect(view.state.doc.toString()).toContain("SELECT 3;");
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Save")!.click();
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    expect(mocks.write).toHaveBeenCalledWith("/sql/second.sql", expect.stringContaining("SELECT 3;"), expect.anything());
    expect(rows[1]!.dataset.selected).toBe("true");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenLastCalledWith(expect.objectContaining({ filePath: "/sql/second.sql" }));
  });

  it("pins the preview while editing and resumes navigation after saving", async () => {
    const { input, rows, props } = await mountSearch();
    host.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!.click();
    await nextTick();
    await nextTick();
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\nSELECT 3;" } });
    rows[1]!.dispatchEvent(new MouseEvent("mouseenter"));
    rows[1]!.click();
    await nextTick();
    expect(input.disabled).toBe(true);
    expect(rows[0]!.dataset.selected).toBe("true");
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.updateOpen).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>("[data-close-search]")!.click();
    expect(mocks.updateOpen).not.toHaveBeenCalled();
    props.initialContentMode = false;
    await nextTick();
    expect(host.querySelector(".cm-editor")).not.toBeNull();
    const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Save")!;
    save.click();
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    expect(mocks.write).toHaveBeenCalledWith("/sql/first.sql", "-- heading\nSELECT needle;\nSELECT 3;", expect.objectContaining({ expectedContentHash: "original" }));
    rows[1]!.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.waitFor(() => expect(mocks.read).toHaveBeenLastCalledWith("/sql/second.sql", 32 * 1024 * 1024));
  });

  it("keeps edits after a save error and allows closing after cancellation", async () => {
    mocks.write.mockRejectedValue(new Error("write failed"));
    await mountSearch();
    host.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!.click();
    await nextTick();
    await nextTick();
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "my draft" } });
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Save")!.click();
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    host.querySelector<HTMLButtonElement>("[data-close-search]")!.click();
    expect(mocks.updateOpen).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("my draft");
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Cancel")!.click();
    await nextTick();
    expect(view.state.doc.toString()).toBe("-- heading\nSELECT needle;");
    host.querySelector<HTMLButtonElement>("[data-close-search]")!.click();
    expect(mocks.updateOpen).toHaveBeenCalledWith(false);
  });

  it("previews hovered results while keeping the dialog open", async () => {
    const { rows } = await mountSearch();
    rows[1]!.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.waitFor(() => expect(mocks.read).toHaveBeenLastCalledWith("/sql/second.sql", 32 * 1024 * 1024));
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.updateOpen).not.toHaveBeenCalled();
    rows[0]!.dispatchEvent(new MouseEvent("mouseenter"));
    await vi.waitFor(() => expect(mocks.read).toHaveBeenLastCalledWith("/sql/first.sql", 32 * 1024 * 1024));
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it("moves the preview with arrow keys and opens the selected file with Enter", async () => {
    const { input, rows } = await mountSearch();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await nextTick();
    expect(rows[1]!.dataset.selected).toBe("true");
    await vi.waitFor(() => expect(mocks.read).toHaveBeenLastCalledWith("/sql/second.sql", 32 * 1024 * 1024));
    expect(document.activeElement).toBe(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ filePath: "/sql/second.sql", line: 1 }));
    expect(mocks.updateOpen).toHaveBeenCalledWith(false);
  });

  it("hides preview when changing modes", async () => {
    const { props } = await mountSearch();
    props.initialContentMode = false;
    await nextTick();
    expect(host.querySelector(".cm-editor")).toBeNull();
  });

  it("switches from content mode to object mode for structured filters", async () => {
    const { input } = await mountSearch();
    input.value = "kind:column email";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await nextTick();
    expect(host.querySelector(".cm-editor")).toBeNull();
    expect(host.querySelector(`[title="${i18n.global.t("quickOpen.scope")}"]`)).not.toBeNull();
  });

  it("resets the category when the mode toggle returns to object search", async () => {
    await mountSearch();
    host.querySelector<HTMLButtonElement>(`[title="${i18n.global.t("quickOpen.modeObjects")}"]`)!.click();
    await nextTick();
    expect(host.querySelector(".cm-editor")).toBeNull();
    expect(host.textContent).toContain(i18n.global.t("quickOpen.categoryAll"));
  });

  it("returns to all results when a structured filter has no category mapping", async () => {
    const { input } = await mountSearch();
    input.value = "db:analytics";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    await nextTick();
    expect(host.querySelector(`[title="${i18n.global.t("quickOpen.scope")}"]`)).not.toBeNull();
    expect(host.textContent).toContain(i18n.global.t("quickOpen.previewEmptyTitle"));
  });

  it("cancels the content-search debounce when switching to object mode", async () => {
    const { input, props } = await mountSearch();
    mocks.globalSearch.mockClear();
    input.value = "slow-query";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    props.initialContentMode = false;
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(mocks.globalSearch).not.toHaveBeenCalled();
  });

  it("shows content search failures and retries the current query", async () => {
    const { input } = await mountSearch();
    mocks.globalSearch
      .mockReset()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({
        matches: [{ path: "/sql/recovered.sql", fileName: "recovered.sql", line: 1, column: 1, lineText: "needle", matchText: "needle" }],
        errors: [],
      });
    input.value = "broken";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull(), { timeout: 10000 });
    expect(host.textContent).toContain(i18n.global.t("quickOpen.contentSearchFailed"));
    expect(host.textContent).not.toContain(i18n.global.t("quickOpen.noResults"));
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === i18n.global.t("common.retry"));
    expect(retry).toBeDefined();
    retry!.click();

    await vi.waitFor(() => expect(host.textContent).toContain("recovered.sql"), { timeout: 10000 });
    expect(mocks.globalSearch).toHaveBeenCalledTimes(2);
  });

  it("shows partial content results together with backend scan warnings", async () => {
    mocks.globalSearch.mockReset().mockResolvedValue({
      matches: [
        { path: "/sql/available.sql", fileName: "available.sql", line: 1, column: 1, lineText: "needle", matchText: "needle" },
        { path: "/sql/available-2.sql", fileName: "available-2.sql", line: 1, column: 1, lineText: "needle", matchText: "needle" },
      ],
      errors: [{ path: "/sql/restricted", message: "permission denied" }],
    });
    await mountSearch();

    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull(), { timeout: 10000 });
    expect(host.textContent).toContain("/sql/restricted: permission denied");
    expect(host.textContent).toContain("available.sql");
  });

  // File-content search is not connection-scoped, so offering the picker there would be a
  // control that silently does nothing.
  it("shows the connection scope picker only in object mode", async () => {
    const { props } = await mountSearch();
    const scopeTitle = i18n.global.t("quickOpen.scope");
    expect([...host.querySelectorAll<HTMLElement>(`[title="${scopeTitle}"]`)]).toHaveLength(0);

    props.initialContentMode = false;
    await nextTick();
    expect([...host.querySelectorAll<HTMLElement>(`[title="${scopeTitle}"]`)]).toHaveLength(1);

    props.initialContentMode = true;
    await nextTick();
    expect([...host.querySelectorAll<HTMLElement>(`[title="${scopeTitle}"]`)]).toHaveLength(0);
  });

  it("preserves single-click opening a search result", async () => {
    const { rows } = await mountSearch();
    rows[1]!.click();
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ filePath: "/sql/second.sql" }));
    expect(mocks.updateOpen).toHaveBeenCalledWith(false);
  });

  it("navigates from preview focus, returns focus to search, and opens with Enter", async () => {
    const { input, rows } = await mountSearch();
    const preview = host.querySelector<HTMLElement>(".cm-content")!;
    preview.focus();
    preview.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await nextTick();
    expect(rows[1]!.dataset.selected).toBe("true");
    expect(document.activeElement).toBe(input);
    await vi.waitFor(() => expect(mocks.read).toHaveBeenLastCalledWith("/sql/second.sql", 32 * 1024 * 1024));
    await vi.waitFor(() => expect(host.querySelector(".cm-content")).not.toBeNull());
    const nextPreview = host.querySelector<HTMLElement>(".cm-content")!;
    nextPreview.focus();
    nextPreview.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(mocks.select).toHaveBeenCalledWith(expect.objectContaining({ filePath: "/sql/second.sql" }));
    expect(mocks.updateOpen).toHaveBeenCalledWith(false);
  });

  it("closes with Escape while the preview has focus", async () => {
    await mountSearch();
    const preview = host.querySelector<HTMLElement>(".cm-content")!;
    preview.focus();
    preview.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.updateOpen).toHaveBeenCalledWith(false);
  });
});
