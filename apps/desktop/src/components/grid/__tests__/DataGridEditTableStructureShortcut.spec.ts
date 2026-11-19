// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, ref, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ColumnInfo, DatabaseType, QueryResult, TableInfoTab } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/composables/useDataGridColumnResize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridColumnResize")>();
  const { ref } = await import("vue");
  return {
    ...actual,
    useDataGridColumnResize: () => ({
      initColumnWidths: vi.fn(),
      onResizeStart: vi.fn(),
      autoFitColumn: vi.fn(),
      renderedColumnWidths: ref([120]),
      totalWidth: ref(120),
      columnVars: ref({ "--total-w": "120px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];
const backend = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  cancelQuery: vi.fn(async () => true),
  checkConnectionHealth: vi.fn(async () => undefined),
  getTableOwner: vi.fn(async () => undefined),
  getTablePartitionStatus: vi.fn(async () => ({ isPartitionedParent: false, isPartition: false })),
  listTriggers: vi.fn(async () => []),
}));
vi.mock("@/lib/backend/api", async (original) => ({ ...(await original<typeof import("@/lib/backend/api")>()), ...backend }));
import { useConnectionStore } from "@/stores/connectionStore";

const RecycleScroller = defineComponent({
  props: {
    items: {
      type: Array as PropType<unknown[]>,
      default: () => [],
    },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        "div",
        attrs,
        props.items.map((item) => slots.default?.({ item })),
      );
  },
});

interface TableMeta {
  catalog?: string;
  schema?: string;
  tableName: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
}

function mountGrid(
  options: {
    context?: "results" | "table-data";
    databaseType?: DatabaseType;
    connectionId?: string;
    database?: string;
    tableMeta?: TableMeta | null;
    shortcut?: string;
    tableInfoTab?: TableInfoTab;
    autoShowTableInfo?: boolean;
  } = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    tableInfoActiveTab: options.tableInfoTab ?? "ddl",
    shortcuts: {
      ...settingsStore.editorSettings.shortcuts,
      editTableStructure: options.shortcut ?? "Mod+D",
    },
  });
  const queryStore = useQueryStore();
  if (options.databaseType === "oracle" || options.databaseType === "oceanbase-oracle") {
    const connections = useConnectionStore();
    connections.addEphemeralConnection({ id: options.connectionId ?? "connection-1", name: "Relations", db_type: options.databaseType, host: "localhost", port: 1, username: "test", password: "" });
    connections.connectedIds.add(options.connectionId ?? "connection-1");
  }
  const onOpenDependencyObject = vi.fn();
  const openTableStructure = vi.spyOn(queryStore, "openTableStructure").mockImplementation(() => "structure-tab");
  const result = markRaw<QueryResult>({
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 0,
  });
  const defaultTableMeta: TableMeta = {
    catalog: "warehouse",
    schema: "public",
    tableName: "users",
    columns: [],
    primaryKeys: [],
  };

  const host = document.createElement("div");
  const grid = ref<{ canOpenTableStructureEditor: boolean; openTableStructureEditor: (tab?: TableInfoTab) => boolean }>();
  document.body.append(host);
  const Root = defineComponent({
    setup() {
      return () =>
        h(
          TooltipProvider,
          { delayDuration: 0 },
          {
            default: () =>
              h(DataGrid, {
                ref: grid,
                result,
                databaseType: options.databaseType ?? "mysql",
                context: options.context ?? "table-data",
                connectionId: options.connectionId ?? "connection-1",
                database: options.database ?? "app",
                tableMeta: options.tableMeta === null ? undefined : (options.tableMeta ?? defaultTableMeta),
                autoShowTableInfo: options.autoShowTableInfo ?? false,
                onOpenDependencyObject,
              }),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.component("RecycleScroller", RecycleScroller);
  app.mount(host);
  mountedApps.push({ app, host });
  return { host, openTableStructure, grid, onOpenDependencyObject };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function gridRoot(host: HTMLElement): HTMLElement {
  const root = host.querySelector<HTMLElement>("[data-grid-root]");
  if (!root) throw new Error("Data grid root not found");
  return root;
}

function dispatchModShortcut(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid edit-table-structure shortcut", () => {
  it("opens captured table relations in the real drawer and keeps the edit action on a supported structure tab", async () => {
    backend.executeQuery.mockResolvedValue({
      columns: ["DIRECTION", "OBJECT_OWNER", "OBJECT_NAME", "OBJECT_TYPE", "REFERENCED_OWNER", "REFERENCED_NAME", "REFERENCED_TYPE", "DEPENDENCY_TYPE", "REFERENCED_LINK_NAME"],
      rows: [["REFERENCED_BY", "Other.Owner", "Uses.Table", "FUNCTION", "Captured.Schema", "Mixed.Table", "TABLE", "HARD", null]],
      affected_rows: 0,
      execution_time_ms: 1,
    });
    const { host, grid, openTableStructure, onOpenDependencyObject } = mountGrid({
      databaseType: "oceanbase-oracle",
      database: "Captured.Database",
      tableInfoTab: "relations",
      autoShowTableInfo: true,
      tableMeta: { schema: "Captured.Schema", catalog: "Captured.Catalog", tableName: "Mixed.Table", columns: [], primaryKeys: [] },
    });
    await vi.waitFor(() => expect(backend.executeQuery).toHaveBeenCalled());
    expect(backend.executeQuery.mock.calls.at(-1)).toEqual(["connection-1", "Captured.Database", expect.stringContaining("ALL_DEPENDENCIES"), "Captured.Schema", expect.any(String), { catalog: "Captured.Catalog" }]);
    expect(host.querySelector('[data-object-section="source"]')).toBeNull();
    host.querySelector<HTMLButtonElement>('[data-object-section="dependents"]')!.click();
    await vi.waitFor(() => expect([...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Uses.Table")).toBe(true));
    [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Uses.Table")!.click();
    expect(onOpenDependencyObject).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "connection-1", database: "Captured.Database", schema: "Captured.Schema", catalog: "Captured.Catalog" }), expect.objectContaining({ name: "Uses.Table", schema: "Other.Owner", type: "function" }));
    expect(grid.value!.openTableStructureEditor("relations")).toBe(true);
    expect(openTableStructure).toHaveBeenLastCalledWith("connection-1", "Captured.Database", "Captured.Schema", "Mixed.Table", "columns", undefined, "Captured.Catalog", "table");
  });

  it("exposes columns navigation to the table header even when the information drawer is closed", async () => {
    const { host, openTableStructure, grid } = mountGrid({ tableInfoTab: "indexes" });
    await settle();
    expect(host.querySelector("[data-edit-table-structure]")).toBeNull();
    expect(grid.value?.canOpenTableStructureEditor).toBe(true);
    expect(grid.value!.openTableStructureEditor()).toBe(true);
    expect(openTableStructure).toHaveBeenCalledExactlyOnceWith("connection-1", "app", "public", "users", "columns", undefined, "warehouse", "table");
  });

  it("returns false from openTableStructureEditor when table structure editing is not available", async () => {
    const { grid, openTableStructure } = mountGrid({ databaseType: "redis" });
    await settle();
    expect(grid.value?.canOpenTableStructureEditor).toBe(false);
    expect(grid.value!.openTableStructureEditor()).toBe(false);
    expect(openTableStructure).not.toHaveBeenCalled();
  });

  it("opens the existing structure editor route for an eligible table-data grid", async () => {
    const { host, openTableStructure } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    root.focus();

    const event = dispatchModShortcut(root, "d");
    await settle();

    expect(document.activeElement).toBe(root);
    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(openTableStructure).toHaveBeenCalledOnce();
    expect(openTableStructure).toHaveBeenCalledWith("connection-1", "app", "public", "users", "columns", undefined, "warehouse", "table");
  });

  it.each(["triggers", "indexes"] as const)("opens columns even when the drawer remembers %s", async (tableInfoTab) => {
    const { host, openTableStructure } = mountGrid({ tableInfoTab });
    await settle();

    dispatchModShortcut(gridRoot(host), "d");
    await settle();

    expect(openTableStructure).toHaveBeenCalledExactlyOnceWith("connection-1", "app", "public", "users", "columns", undefined, "warehouse", "table");
    expect(useSettingsStore().editorSettings.tableInfoActiveTab).toBe(tableInfoTab);
  });

  it("uses a configured shortcut and leaves the default key untouched", async () => {
    const { host, openTableStructure } = mountGrid({ shortcut: "Mod+E" });
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const defaultEvent = dispatchModShortcut(root, "d");
    const customEvent = dispatchModShortcut(root, "e");
    await settle();

    expect(defaultEvent.defaultPrevented).toBe(false);
    expect(customEvent.defaultPrevented).toBe(true);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(openTableStructure).toHaveBeenCalledOnce();
    expect(openTableStructure).toHaveBeenCalledWith("connection-1", "app", "public", "users", "columns", undefined, "warehouse", "table");
  });

  it.each([
    ["query result", { context: "results" as const }],
    ["unsupported database", { databaseType: "redis" as const }],
    ["missing connection", { connectionId: "" }],
    ["missing database", { database: "" }],
    ["missing table metadata", { tableMeta: null }],
  ])("does not consume the shortcut for %s", async (_label, options) => {
    const { host, openTableStructure } = mountGrid(options);
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = dispatchModShortcut(root, "d");
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(openTableStructure).not.toHaveBeenCalled();
    expect(host.querySelector("[data-edit-table-structure]")).toBeNull();
  });

  it("leaves editable text targets untouched", async () => {
    const { host, openTableStructure } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    const targets = [document.createElement("input"), document.createElement("textarea"), document.createElement("div"), document.createElement("div")];
    targets[2]!.setAttribute("contenteditable", "true");
    targets[3]!.setAttribute("role", "textbox");

    for (const target of targets) {
      root.append(target);
      const event = dispatchModShortcut(target, "d");
      expect(event.defaultPrevented).toBe(false);
    }
    await settle();

    expect(bubbled).toHaveBeenCalledTimes(targets.length);
    expect(openTableStructure).not.toHaveBeenCalled();
  });

  it("preserves Ctrl+C for a native clipboard selection", async () => {
    const { host, openTableStructure } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const region = document.createElement("div");
    region.setAttribute("data-native-clipboard", "true");
    region.textContent = "selected table information";
    root.append(region);
    const range = document.createRange();
    range.selectNodeContents(region);
    window.getSelection()?.addRange(range);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = dispatchModShortcut(region, "c");
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(openTableStructure).not.toHaveBeenCalled();
  });

  it("keeps the drawer's edit button on its current facet", async () => {
    const { host, openTableStructure } = mountGrid({ tableInfoTab: "triggers", autoShowTableInfo: true });
    await settle();

    const editButton = host.querySelector<HTMLButtonElement>(`.table-info-action-button[aria-label="${i18n.global.t("contextMenu.editStructure")}"]`);
    expect(editButton).not.toBeNull();
    editButton!.click();
    await settle();

    expect(openTableStructure).toHaveBeenCalledExactlyOnceWith("connection-1", "app", "public", "users", "triggers", undefined, "warehouse", "table");
  });
});
