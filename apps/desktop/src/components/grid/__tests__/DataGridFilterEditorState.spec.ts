// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DataGridFilterEditorView } from "@/stores/settingsStore";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearDataGridStructuredFilterStates } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";
import { clearDataGridSortBuilderMemoryCache } from "@/composables/useDataGridSortBuilder";

const backendMocks = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(async ({ tableName, whereInput, orderBy }: { tableName: string; whereInput?: string; orderBy?: string }) => `SELECT * FROM ${tableName}${whereInput ? ` WHERE ${whereInput}` : ""}${orderBy ? ` ORDER BY ${orderBy}` : ""}`),
  loadEditorSettings: vi.fn().mockResolvedValue({}),
  saveEditorSettings: vi.fn().mockResolvedValue(undefined),
  buildDataGridContextFilterCondition: vi.fn(async ({ columnName, value }: { columnName: string; value: unknown }) => `\`${columnName}\` = ${String(value)}`),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    buildTableSelectSql: backendMocks.buildTableSelectSql,
    buildDataGridContextFilterCondition: backendMocks.buildDataGridContextFilterCondition,
    loadEditorSettings: backendMocks.loadEditorSettings,
    saveEditorSettings: backendMocks.saveEditorSettings,
  };
});

vi.mock("vue-virtual-scroller", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    RecycleScroller: defineComponent({
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
    }),
  };
});

vi.mock("@/composables/useDataGridColumnResize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridColumnResize")>();
  const { ref } = await import("vue");
  return {
    ...actual,
    useDataGridColumnResize: () => ({
      initColumnWidths: vi.fn(),
      onResizeStart: vi.fn(),
      autoFitColumn: vi.fn(),
      hasUserSizedColumns: ref(false),
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

function panelSelector(view: DataGridFilterEditorView): string {
  return view === "conditions" ? "[data-grid-filter-workbench]" : "[data-grid-text-filter-workbench]";
}

function filterToggle(host: HTMLElement): HTMLButtonElement {
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Filter"][aria-expanded]');
  if (!toggle) throw new Error("Filter editor toggle not found");
  return toggle;
}

function sortPanelSelector(view: DataGridFilterEditorView): string {
  return view === "conditions" ? "[data-grid-sort-workbench]" : "[data-grid-text-sort-workbench]";
}

function sortToggle(host: HTMLElement): HTMLButtonElement {
  const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Sort"][aria-expanded]');
  if (!toggle) throw new Error("Sort editor toggle not found");
  return toggle;
}

function applyButton(host: HTMLElement, view: DataGridFilterEditorView): HTMLButtonElement {
  const panel = host.querySelector(panelSelector(view));
  const button = [...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent?.trim() === "Apply Filter");
  if (!button) throw new Error("Filter editor apply button not found");
  return button;
}

function sortApplyButton(host: HTMLElement, view: DataGridFilterEditorView): HTMLButtonElement {
  const panel = host.querySelector(sortPanelSelector(view));
  const button = [...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((candidate) => candidate.textContent?.trim() === "Apply Sort");
  if (!button) throw new Error("Sort editor apply button not found");
  return button;
}

async function selectSortColumn(workbench: Element, columnName: string) {
  const trigger = workbench.querySelector<HTMLElement>('[data-slot="select-trigger"]');
  if (!trigger) throw new Error("Sort column select trigger not found");
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  await settle();

  const search = document.querySelector<HTMLInputElement>("[data-sort-column-search] input");
  if (!search) throw new Error("Sort column search input not found");
  search.value = columnName;
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await settle();
}

function mountGrid(
  view: DataGridFilterEditorView,
  keepExpanded: boolean,
  options: {
    dataGridOrderByVisible?: boolean;
    initialOrderByInput?: string;
    sortColumn?: string;
    sortColumnIndex?: number;
    sortDirection?: "asc" | "desc";
    sortMode?: "database" | "local";
  } = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    dataGridFilterEditorView: view,
    dataGridKeepFilterEditorExpanded: keepExpanded,
    dataGridOrderByVisible: options.dataGridOrderByVisible ?? true,
  });
  const result = markRaw<QueryResult>({
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 0,
  });
  const onExecuteSql = vi.fn().mockResolvedValue(undefined);
  const onSort = vi.fn();
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
              h(DataGrid, {
                result,
                databaseType: "mysql",
                context: "table-data",
                initialOrderByInput: options.initialOrderByInput,
                sortColumn: options.sortColumn,
                sortColumnIndex: options.sortColumnIndex,
                sortDirection: options.sortDirection,
                sortMode: options.sortMode,
                tableMeta: {
                  tableName: "items",
                  columns: [{ name: "id", data_type: "int" }],
                  primaryKeys: ["id"],
                },
                onExecuteSql,
                onSort,
              }),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mountedApps.push({ app, host });
  return { host, onExecuteSql, onSort };
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function contextMenuButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Context menu item not found: ${label}`);
  return button;
}

async function openCellCustomFilter(host: HTMLElement) {
  // Canvas rendering has no per-cell DOM, so switch to the DOM grid before
  // driving the cell context menu.
  useSettingsStore().updateEditorSettings({ dataGridRenderMode: "dom" });
  await settle();
  const cell = host.querySelector<HTMLElement>('[data-row-index="0"] [data-visible-col-index="0"]');
  if (!cell) throw new Error("Grid cell not found");
  cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }));
  await settle();
  contextMenuButton("Filter").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  await settle();
  contextMenuButton("Custom Filter").click();
  await settle();
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  document.querySelectorAll("[data-dbx-context-menu]").forEach((menu) => menu.remove());
  clearDataGridSortBuilderMemoryCache();
  clearDataGridStructuredFilterStates();
});

describe.each(["conditions", "text"] as const)("DataGrid %s filter editor state", (view) => {
  it("keeps a manually opened editor open after apply and still allows manual close", async () => {
    const { host, onExecuteSql } = mountGrid(view, false);
    await settle();

    expect(host.querySelector(panelSelector(view))).toBeNull();
    filterToggle(host).click();
    await settle();
    expect(host.querySelector(panelSelector(view))).not.toBeNull();

    applyButton(host, view).click();
    await vi.waitFor(() => expect(onExecuteSql).toHaveBeenCalledOnce());
    expect(host.querySelector(panelSelector(view))).not.toBeNull();

    filterToggle(host).click();
    await settle();
    expect(host.querySelector(panelSelector(view))).toBeNull();
  });

  it("uses the persisted expansion preference only as the initial state", async () => {
    const { host } = mountGrid(view, true);
    await settle();

    expect(host.querySelector(panelSelector(view))).not.toBeNull();
    expect(filterToggle(host).getAttribute("aria-expanded")).toBe("true");

    filterToggle(host).click();
    await settle();
    expect(host.querySelector(panelSelector(view))).toBeNull();

    filterToggle(host).click();
    await settle();
    expect(host.querySelector(panelSelector(view))).not.toBeNull();
  });

  it("opens the matching sort workbench and keeps it mutually exclusive with the filter workbench", async () => {
    const { host } = mountGrid(view, true);
    await settle();

    expect(host.querySelector(panelSelector(view))).not.toBeNull();
    expect(host.querySelector(sortPanelSelector(view))).toBeNull();

    sortToggle(host).click();
    await settle();
    expect(host.querySelector(panelSelector(view))).toBeNull();
    expect(host.querySelector(sortPanelSelector(view))).not.toBeNull();
    expect(sortToggle(host).getAttribute("aria-expanded")).toBe("true");

    filterToggle(host).click();
    await settle();
    expect(host.querySelector(sortPanelSelector(view))).toBeNull();
    expect(host.querySelector(panelSelector(view))).not.toBeNull();
  });

  it("closes and removes the sort workbench when dataGridOrderByVisible is toggled off", async () => {
    const { host } = mountGrid(view, false);
    await settle();

    expect(host.querySelector(sortPanelSelector(view))).toBeNull();
    const toggle = sortToggle(host);
    toggle.click();
    await settle();
    expect(host.querySelector(sortPanelSelector(view))).not.toBeNull();
    expect(sortToggle(host).getAttribute("aria-expanded")).toBe("true");

    useSettingsStore().updateEditorSettings({ dataGridOrderByVisible: false });
    await settle();

    expect(host.querySelector(sortPanelSelector(view))).toBeNull();
    // Column-header sorting remains available when the toolbar editor is hidden.
    expect(toggle.isConnected).toBe(false);
  });

  it("deactivates active structured sort and re-queries without ORDER BY when dataGridOrderByVisible is toggled off", async () => {
    const { host, onExecuteSql, onSort } = mountGrid(view, false);
    await settle();

    sortToggle(host).click();
    await settle();
    const workbench = host.querySelector(sortPanelSelector(view));
    if (!workbench) throw new Error("Sort workbench not found");
    await selectSortColumn(workbench, "id");

    sortApplyButton(host, view).click();
    await vi.waitFor(() => expect(onExecuteSql).toHaveBeenCalledTimes(1));
    expect(onExecuteSql.mock.calls[0][0]).toContain("ORDER BY `id` ASC");

    useSettingsStore().updateEditorSettings({ dataGridOrderByVisible: false });
    await settle();

    await vi.waitFor(() => expect(onExecuteSql).toHaveBeenCalledTimes(2));
    expect(onExecuteSql.mock.calls[1][0]).not.toContain("ORDER BY");
    expect(host.querySelector(sortPanelSelector(view))).toBeNull();

    // Subsequent column sort when ORDER BY is hidden does not stack with previous structured sort
    const sortBtn = host.querySelector<HTMLButtonElement>('button[title="Sort"]');
    if (sortBtn) {
      sortBtn.click();
      await settle();
      const ascItem = [...document.querySelectorAll<HTMLButtonElement>("button")].find((btn) => btn.textContent?.includes("Sort Database Ascending"));
      ascItem?.click();
      await settle();
      expect(onSort).toHaveBeenCalledWith("id", 0, "asc", undefined, "database", "`id` ASC");
    }
  });

  it("clears restored column and manual sorts when mounted with ORDER BY hidden", async () => {
    const { onExecuteSql, onSort } = mountGrid(view, false, {
      dataGridOrderByVisible: false,
      initialOrderByInput: "`id` ASC",
      sortColumn: "id",
      sortColumnIndex: 0,
      sortDirection: "asc",
      sortMode: "database",
    });
    await settle();

    expect(onSort).toHaveBeenCalledWith("id", 0, null, undefined, "database", "");
    expect(onExecuteSql).not.toHaveBeenCalled();
  });
});

describe("DataGrid custom filter menu", () => {
  it.each(["quick", "conditions", "text"] as const)("opens the rule builder seeded from the right-clicked cell in %s view", async (view) => {
    const { host } = mountGrid(view, false);
    await settle();

    await openCellCustomFilter(host);

    expect(host.querySelector("[data-grid-filter-workbench]")).not.toBeNull();
    const valueEditor = [...host.querySelectorAll<HTMLInputElement>("[data-filter-value-editor]")].find((input) => input.value === "1");
    expect(valueEditor, "seeded value editor").toBeDefined();
    await vi.waitFor(() => expect(document.activeElement).toBe(valueEditor));
    await vi.waitFor(() => expect(host.querySelector("[data-grid-filter-workbench]")?.textContent).toContain("`id` = 1"));
  });
});

describe("DataGrid quick filter editor state", () => {
  it("continues to close its popover after apply", async () => {
    const { host, onExecuteSql } = mountGrid("quick", true);
    await settle();

    const toggle = filterToggle(host);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    await settle();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const apply = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "Apply Filter");
    if (!apply) throw new Error("Quick filter apply button not found");
    apply.click();
    await vi.waitFor(() => expect(onExecuteSql).toHaveBeenCalledOnce());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
