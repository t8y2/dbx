// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, ref, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DatabaseType, QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { DataGridToolbarActionCapability } from "@/lib/dataGrid/dataGridToolbar";
import { loadObjectDdl } from "@/lib/metadata/objectDdlCache";

vi.mock("@/lib/metadata/objectDdlCache", () => ({
  loadObjectDdl: vi.fn(async () => ({ ddl: "CREATE TABLE users (id INT);", cacheStatus: "remote" })),
}));

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
import { useSettingsStore } from "@/stores/settingsStore";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

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

function mountGrid(
  options: {
    displayableColumns?: boolean;
    columns?: string[];
    slots?: Record<string, () => ReturnType<typeof h>>;
    withTableMetadata?: boolean;
    context?: "table-data" | "results";
    queryMultiSource?: boolean;
    databaseType?: DatabaseType;
    sourceDatabase?: string;
    joinedWriteTargetCount?: number;
  } = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    shortcuts: {
      ...settingsStore.editorSettings.shortcuts,
      goToColumn: "Mod+G",
    },
  });
  const result = markRaw<QueryResult>({
    columns: options.columns ?? ["id"],
    rows: [Array.from({ length: (options.columns ?? ["id"]).length }, (_, index) => index + 1)],
    affected_rows: 0,
    execution_time_ms: 0,
    hidden_column_indexes: options.displayableColumns === false ? [0] : undefined,
  });

  const grid = ref<{ tableInfoToolbarCapability: DataGridToolbarActionCapability; goToColumnToolbarCapability: DataGridToolbarActionCapability }>();
  const host = document.createElement("div");
  document.body.append(host);
  const Root = defineComponent({
    setup() {
      return () =>
        h(
          TooltipProvider,
          { delayDuration: 0 },
          {
            default: () =>
              h(
                DataGrid,
                {
                  ref: grid,
                  result,
                  databaseType: options.databaseType ?? "mysql",
                  context: options.context ?? "table-data",
                  queryMultiSource: options.queryMultiSource,
                  joinedWriteTargets: options.joinedWriteTargetCount ? Array.from({ length: options.joinedWriteTargetCount }, (_, index) => ({ tableMeta: { tableName: `table_${index}`, columns: [], primaryKeys: [] }, sourceColumns: ["id"] })) : undefined,
                  ...(options.withTableMetadata
                    ? {
                        connectionId: "test-connection",
                        database: "test-database",
                        tableMeta: { tableName: "users", database: options.sourceDatabase, schema: options.databaseType === "sqlserver" ? "dbo" : "test-database", columns: [], primaryKeys: [] },
                      }
                    : {}),
                },
                options.slots,
              ),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.component("RecycleScroller", RecycleScroller);
  app.mount(host);
  const mounted = { app, host };
  mountedApps.push(mounted);
  return { ...mounted, settingsStore, grid };
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

function goToColumnItem(name: string, position: number): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.replaceAll(/\s/g, "") === `${name}#${position}`);
  if (!button) throw new Error(`Go-to-column item ${name} not found`);
  return button;
}

function goToColumnEvent(target: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "g" });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid go-to-column shortcut", () => {
  it("switches between the split and original single-row toolbar layouts", async () => {
    const { host, settingsStore } = mountGrid();
    await settle();

    const topbar = host.querySelector<HTMLElement>("[data-grid-toolbar-layout]");
    expect(topbar?.dataset.gridToolbarLayout).toBe("single");

    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "split" });
    await settle();

    expect(topbar?.dataset.gridToolbarLayout).toBe("split");
    expect(topbar?.classList.contains("grid")).toBe(true);

    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "single" });
    await settle();

    expect(topbar?.dataset.gridToolbarLayout).toBe("single");
    expect(topbar?.classList.contains("flex")).toBe(true);
    expect(host.querySelector('[data-grid-topbar-row="actions"].ml-auto')).not.toBeNull();

    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "split" });
    await settle();

    expect(topbar?.dataset.gridToolbarLayout).toBe("split");
    expect(topbar?.classList.contains("grid")).toBe(true);
    expect(host.querySelector('[data-grid-topbar-row="filters"].data-grid-topbar-scroll--row-divider')).not.toBeNull();
  });

  it("does not duplicate the DDL action in the table-data toolbar", async () => {
    const { host } = mountGrid({ withTableMetadata: true });
    await settle();

    expect(host.querySelector('[data-toolbar-action="tableInfo"]')).toBeNull();
  });

  it("shows a DDL action for query results with table metadata", async () => {
    const { host, grid } = mountGrid({ withTableMetadata: true, context: "results" });
    await settle();

    expect(grid.value?.tableInfoToolbarCapability.visible).toBe(true);
    expect(grid.value?.tableInfoToolbarCapability.label).toBe("DDL");
    expect(host.querySelector('[data-toolbar-action="tableInfo"]')).toBeNull();
  });

  it.each([1, 2])("hides DDL for a multi-source query with %i writable targets", async (joinedWriteTargetCount) => {
    const { grid } = mountGrid({ withTableMetadata: true, context: "results", queryMultiSource: true, joinedWriteTargetCount });
    await settle();
    expect(grid.value?.tableInfoToolbarCapability.visible).toBe(false);
  });

  it.each([
    { withTableMetadata: false, databaseType: "mysql" as const },
    { withTableMetadata: true, databaseType: "mongodb" as const },
  ])("hides DDL without a supported source: %j", async (options) => {
    const { grid } = mountGrid({ ...options, context: "results" });
    await settle();
    expect(grid.value?.tableInfoToolbarCapability.visible).toBe(false);
  });

  it.each([undefined, "reporting"])("opens DDL using source database %s with execution-database fallback", async (sourceDatabase) => {
    const { host, settingsStore, grid } = mountGrid({ withTableMetadata: true, context: "results", databaseType: "sqlserver", sourceDatabase });
    settingsStore.updateEditorSettings({ tableInfoActiveTab: "indexes" });
    await settle();
    await grid.value!.tableInfoToolbarCapability.onTrigger();
    await vi.waitFor(() => {
      expect(loadObjectDdl).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "test-connection", database: sourceDatabase ?? "test-database", schema: "dbo", tableName: "users" }), expect.anything());
      expect(host.querySelector("[data-table-info-drawer]")?.textContent).toContain("CREATE TABLE");
    });
    expect(grid.value?.tableInfoToolbarCapability.active).toBe(true);
  });

  it("keeps result actions and query filters in their separate toolbar rows", async () => {
    const { host } = mountGrid({
      slots: {
        "result-toolbar-leading": () => h("span", { "data-testid": "result-view" }, "结果视图"),
        "result-toolbar-actions": () => h("span", { "data-testid": "result-actions" }, "结果操作"),
        "search-bar": () => h("span", { "data-testid": "search-controls" }, "文档筛选"),
      },
    });
    await settle();

    const actionRowSelector = '[data-grid-topbar-row="actions"]';
    const filterRowSelector = '[data-grid-topbar-row="filters"]';
    expect(host.querySelector('[data-testid="result-view"]')?.closest(actionRowSelector)).not.toBeNull();
    expect(host.querySelector('[data-testid="result-actions"]')?.closest(actionRowSelector)).not.toBeNull();
    expect(host.querySelector('[data-testid="search-controls"]')?.closest(filterRowSelector)).not.toBeNull();
  });

  it("opens and consumes the configured shortcut when a column is displayable", async () => {
    const { host } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    root.focus();
    expect(document.activeElement).toBe(root);

    const event = goToColumnEvent(root);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(host.querySelector("[data-column-lookup-panel]")).not.toBeNull();
    expect(document.activeElement?.getAttribute("placeholder")).toBe("Search column/comment...");
  });

  it("toggles the column lookup panel from its toolbar capability", async () => {
    const { host, grid } = mountGrid({ columns: ["id", "name"] });
    await settle();

    expect(grid.value?.goToColumnToolbarCapability.active).toBe(false);

    await grid.value!.goToColumnToolbarCapability.onTrigger();
    await settle();

    expect(host.querySelector("[data-column-lookup-panel]")).not.toBeNull();
    expect(grid.value?.goToColumnToolbarCapability.active).toBe(true);

    await grid.value!.goToColumnToolbarCapability.onTrigger();
    await settle();

    expect(host.querySelector("[data-column-lookup-panel]")).toBeNull();
    expect(grid.value?.goToColumnToolbarCapability.active).toBe(false);
  });

  it("moves the lookup selection with arrows and chooses it with Enter", async () => {
    const { host } = mountGrid({ columns: ["id", "name"] });
    await settle();
    const root = gridRoot(host);
    root.focus();
    goToColumnEvent(root);
    await settle();

    const input = document.activeElement as HTMLInputElement;
    const down = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" });
    input.dispatchEvent(down);
    await settle();

    expect(down.defaultPrevented).toBe(true);
    expect(goToColumnItem("name", 2).classList).toContain("bg-accent");

    const enter = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
    input.dispatchEvent(enter);
    await settle();

    expect(enter.defaultPrevented).toBe(true);
    expect(host.querySelector("[data-column-lookup-panel]")).not.toBeNull();
  });

  it("does not consume the configured shortcut without a displayable column", async () => {
    const { host } = mountGrid({ displayableColumns: false });
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = goToColumnEvent(root);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-column-lookup-panel]")).toBeNull();
  });

  it("does not trigger or consume shortcuts from editable targets", async () => {
    const { host } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    const targets = [document.createElement("input"), document.createElement("textarea"), document.createElement("div"), document.createElement("div")];
    targets[2]!.setAttribute("contenteditable", "true");
    targets[3]!.setAttribute("role", "textbox");

    for (const target of targets) {
      root.append(target);
      const event = goToColumnEvent(target);
      expect(event.defaultPrevented).toBe(false);
    }
    await settle();

    expect(bubbled).toHaveBeenCalledTimes(targets.length);
    expect(host.querySelector("[data-column-lookup-panel]")).toBeNull();
  });

  it("leaves an unmatched root event untouched", async () => {
    const { host } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "j" });

    root.dispatchEvent(event);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-column-lookup-panel]")).toBeNull();
  });
});
