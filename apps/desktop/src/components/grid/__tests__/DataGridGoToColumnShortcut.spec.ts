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
    filterControls?: boolean;
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

  const grid = ref<{
    tableInfoToolbarCapability: DataGridToolbarActionCapability;
    goToColumnToolbarCapability: DataGridToolbarActionCapability;
    moveDisplayableColumn: (fromDisplayableIndex: number, toDisplayableIndex: number) => void;
  }>();
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
                  onExecuteSql: options.filterControls ? async () => undefined : undefined,
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

function mockToolbarGeometry(geometry: { width: number; filters: number; actions: number; compactActions?: number; leading?: number; conditionInputs?: { where: number; order: number } }) {
  const observers: Array<{ callback: () => void; elements: Set<Element> }> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      elements = new Set<Element>();
      constructor(callback: () => void) {
        observers.push({ callback, elements: this.elements });
      }
      observe(element: Element) {
        this.elements.add(element);
      }
      unobserve(element: Element) {
        this.elements.delete(element);
      }
      disconnect() {
        this.elements.clear();
      }
    },
  );
  const isLeading = (element: HTMLElement) => !!element.querySelector("[data-test-toolbar-leading]");
  const conditionLabelWidth = (element: HTMLElement) => (element.closest("[data-grid-condition-editor]")?.getAttribute("data-grid-condition-editor") === "where" ? 42 : 67);

  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute("data-grid-condition-input-viewport")) {
      const kind = this.closest("[data-grid-condition-editor]")?.getAttribute("data-grid-condition-editor") === "where" ? "where" : "order";
      const compact = !!this.closest("[data-grid-condition-editor]")?.querySelector(".data-grid-topbar-condition-label--compact");
      return (geometry.conditionInputs?.[kind] ?? 250) + (compact ? conditionLabelWidth(this) : 0);
    }
    if (this.classList.contains("data-grid-topbar-condition-label")) return this.classList.contains("data-grid-topbar-condition-label--compact") ? 0 : conditionLabelWidth(this);
    if (this.classList.contains("data-grid-topbar-shell") || this.dataset.gridTopbarRow === "filters") return geometry.width;
    if (this.dataset.gridTopbarRow === "actions") return isLeading(this) ? (geometry.leading ?? 0) : Math.max(0, geometry.width - (geometry.leading ?? 0));
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("data-grid-topbar-condition-label")) return conditionLabelWidth(this);
    if (this.classList.contains("data-grid-topbar-shell")) return geometry.width;
    if (this.dataset.gridTopbarRow === "filters") return this.querySelector(".data-grid-topbar--compact") ? geometry.width : Math.max(geometry.width, geometry.filters);
    if (this.dataset.gridTopbarRow === "actions") {
      if (isLeading(this)) return geometry.leading ?? 0;
      const actions = this.querySelector(".data-grid-topbar-action-label--compact") ? (geometry.compactActions ?? geometry.actions) : geometry.actions;
      return Math.max(this.clientWidth, actions);
    }
    return 0;
  });
  return (selector = ".data-grid-topbar-shell") => {
    for (const observer of observers) {
      if ([...observer.elements].some((element) => element.matches(selector))) observer.callback();
    }
  };
}

function goToColumnItem(name: string, position: number): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.replaceAll(/\s/g, "") === `${name}#${position}`);
  if (!button) throw new Error(`Go-to-column item ${name} not found`);
  return button;
}

function goToColumnOrder(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>("[data-column-lookup-panel] button")].map((button) => button.textContent?.replaceAll(/\s/g, "") ?? "").filter((text) => text.includes("#"));
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
  vi.unstubAllGlobals();
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

  it("keeps split toolbar labels expanded below the single-row breakpoint and resets layout history", async () => {
    mockToolbarGeometry({ width: 800, filters: 600, actions: 600 });
    const { host, settingsStore } = mountGrid();
    await settle();
    const refresh = () => host.querySelector<HTMLElement>('[data-toolbar-action="refresh"] .data-grid-topbar-action-label');
    await vi.waitFor(() => expect(refresh()?.classList.contains("data-grid-topbar-action-label--compact")).toBe(true));

    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "split" });
    await vi.waitFor(() => expect(refresh()?.classList.contains("data-grid-topbar-action-label--compact")).toBe(false));
    expect(host.querySelector(".data-grid-topbar--compact")).toBeNull();

    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "single" });
    await vi.waitFor(() => expect(refresh()?.classList.contains("data-grid-topbar-action-label--compact")).toBe(true));
    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "split" });
    await vi.waitFor(() => expect(refresh()?.classList.contains("data-grid-topbar-action-label--compact")).toBe(false));
  });

  it("compacts split filter controls independently from action labels", async () => {
    const geometry = { width: 800, filters: 900, actions: 500 };
    const resize = mockToolbarGeometry(geometry);
    const { host, settingsStore } = mountGrid();
    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "split" });
    await vi.waitFor(() => expect(host.querySelector(".data-grid-topbar--compact")).not.toBeNull());
    expect(host.querySelector('[data-toolbar-action="refresh"] .data-grid-topbar-action-label--compact')).toBeNull();

    geometry.width = 940;
    resize();
    await vi.waitFor(() => expect(host.querySelector(".data-grid-topbar--compact")).toBeNull());
    expect(host.querySelector('[data-toolbar-action="refresh"] .data-grid-topbar-action-label--compact')).toBeNull();
  });

  it("measures both split action segments and restores their labels when the pane grows", async () => {
    const geometry = { width: 700, filters: 500, actions: 650, compactActions: 450, leading: 100 };
    const resize = mockToolbarGeometry(geometry);
    const { host, settingsStore } = mountGrid({ slots: { "result-toolbar-leading": () => h("span", { "data-test-toolbar-leading": "" }, "Results") } });
    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "split" });
    await vi.waitFor(() => expect(host.querySelector('[data-toolbar-action="refresh"] .data-grid-topbar-action-label--compact')).not.toBeNull());
    expect(host.querySelector(".data-grid-topbar--compact")).toBeNull();

    geometry.width = 800;
    resize();
    await vi.waitFor(() => expect(host.querySelector('[data-toolbar-action="refresh"] .data-grid-topbar-action-label--compact')).toBeNull());
    expect(host.querySelector(".data-grid-topbar--compact")).toBeNull();
  });

  it("restores split action labels while the filter row still needs compact controls", async () => {
    const geometry = { width: 700, filters: 900, actions: 750, compactActions: 450, leading: 100 };
    const resize = mockToolbarGeometry(geometry);
    const { host, settingsStore } = mountGrid({ slots: { "result-toolbar-leading": () => h("span", { "data-test-toolbar-leading": "" }, "Results") } });
    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "split" });
    await vi.waitFor(() => expect(host.querySelector('[data-toolbar-action="refresh"] .data-grid-topbar-action-label--compact')).not.toBeNull());
    expect(host.querySelector(".data-grid-topbar--compact")).not.toBeNull();

    geometry.width = 900;
    resize();
    await vi.waitFor(() => expect(host.querySelector('[data-toolbar-action="refresh"] .data-grid-topbar-action-label--compact')).toBeNull());
    expect(host.querySelector(".data-grid-topbar--compact")).not.toBeNull();

    geometry.width = 940;
    resize();
    await vi.waitFor(() => expect(host.querySelector(".data-grid-topbar--compact")).toBeNull());
  });

  it("compacts WHERE and ORDER BY when inputs become too narrow without row overflow", async () => {
    const geometry = { width: 500, filters: 500, actions: 300, conditionInputs: { where: 150, order: 120 } };
    const resize = mockToolbarGeometry(geometry);
    const { host, settingsStore } = mountGrid({ filterControls: true, withTableMetadata: true });
    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "split" });
    await vi.waitFor(() => expect(host.querySelectorAll("[data-grid-condition-editor] > div > .data-grid-topbar-condition-label--compact")).toHaveLength(2));
    expect(host.querySelector('[data-toolbar-action="refresh"] .data-grid-topbar-action-label--compact')).toBeNull();

    geometry.width = 800;
    geometry.conditionInputs = { where: 260, order: 230 };
    resize();
    await vi.waitFor(() => expect(host.querySelector(".data-grid-topbar-condition-label--compact")).toBeNull());
  });

  it("remeasures the WHERE/ORDER BY divider without resizing the pane and avoids premature label expansion", async () => {
    const geometry = { width: 800, filters: 800, actions: 300, conditionInputs: { where: 260, order: 120 } };
    const resize = mockToolbarGeometry(geometry);
    const { host, settingsStore } = mountGrid({ filterControls: true, withTableMetadata: true });
    settingsStore.updateEditorSettings({ dataGridToolbarLayout: "split" });
    await vi.waitFor(() => expect(host.querySelectorAll("[data-grid-condition-editor] > div > .data-grid-topbar-condition-label--compact")).toHaveLength(2));

    geometry.conditionInputs.order = 165;
    resize("[data-grid-condition-input-viewport]");
    await settle();
    expect(host.querySelectorAll("[data-grid-condition-editor] > div > .data-grid-topbar-condition-label--compact")).toHaveLength(2);

    geometry.conditionInputs.order = 190;
    resize("[data-grid-condition-input-viewport]");
    await vi.waitFor(() => expect(host.querySelector(".data-grid-topbar-condition-label--compact")).toBeNull());
    expect(host.querySelector('[data-toolbar-action="refresh"] .data-grid-topbar-action-label--compact')).toBeNull();
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

  it("lists columns in the local column order after the user reorders them", async () => {
    const { host, grid } = mountGrid({ columns: ["id", "name"] });
    await settle();

    grid.value!.moveDisplayableColumn(1, 0);
    await settle();

    const root = gridRoot(host);
    root.focus();
    goToColumnEvent(root);
    await settle();

    expect(goToColumnOrder()).toEqual(["name#2", "id#1"]);
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
