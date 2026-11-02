// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, reactive, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DataGridFilterEditorView } from "@/stores/settingsStore";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";
import { clearDataGridStructuredFilterStates } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";

const backendMocks = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(async ({ tableName, whereInput }: { tableName: string; whereInput?: string }) => `SELECT * FROM ${tableName}${whereInput ? ` WHERE ${whereInput}` : ""}`),
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

function mountGrid(view: DataGridFilterEditorView, keepExpanded: boolean, initialWhereInput?: string, initialOrderByInput?: string, overrides: Record<string, unknown> = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    dataGridFilterEditorView: view,
    dataGridKeepFilterEditorExpanded: keepExpanded,
  });
  const result = markRaw<QueryResult>({
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 0,
  });
  const onExecuteSql = vi.fn().mockResolvedValue(undefined);
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
                initialWhereInput,
                initialOrderByInput,
                databaseType: "mysql",
                context: "table-data",
                tableMeta: {
                  tableName: "items",
                  columns: [{ name: "id", data_type: "int" }],
                  primaryKeys: ["id"],
                },
                onExecuteSql,
                ...overrides,
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
  return { host, onExecuteSql };
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
  clearDataGridStructuredFilterStates();
});

describe.each(["conditions", "text"] as const)("DataGrid %s filter editor state", (view) => {
  it("keeps a manually opened editor open after apply and still allows manual close", async () => {
    const { host, onExecuteSql } = mountGrid(view, false, "id = 1");
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
  it("keeps empty filter application open and does not execute a query (#13355)", async () => {
    const { host, onExecuteSql } = mountGrid("quick", false);
    await settle();
    filterToggle(host).click();
    await settle();
    const apply = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "Apply Filter")!;
    apply.click();
    await settle();
    expect(onExecuteSql).not.toHaveBeenCalled();
    expect(filterToggle(host).getAttribute("aria-expanded")).toBe("true");
  });
  it("continues to close its popover after apply", async () => {
    const { host, onExecuteSql } = mountGrid("quick", true, "id = 1");
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

describe("DataGrid text and builder synchronization (#13355)", () => {
  it("stores the applied sort state without dropping secondary fields and clears its fallback", async () => {
    const state = reactive<Record<string, unknown>>({
      result: { columns: ["id", "name"], rows: [[1, "alpha"]], affected_rows: 0, execution_time_ms: 0 },
      tableMeta: {
        tableName: "items",
        columns: [
          { name: "id", data_type: "int" },
          { name: "name", data_type: "varchar" },
        ],
        primaryKeys: ["id"],
      },
      sortColumn: undefined,
      sortColumnIndex: undefined,
      sortDirection: undefined,
      sortMode: undefined,
    });
    for (const key of ["sortColumn", "sortColumnIndex", "sortDirection", "sortMode"])
      state[`onUpdate:${key}`] = (value: unknown) => {
        state[key] = value;
      };
    const { host } = mountGrid("conditions", false, undefined, undefined, state);
    await settle();
    const text = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="ORDER BY"]')!;
    text.value = "`id` DESC, `name` ASC";
    text.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    sortToggle(host).click();
    await settle();
    const panel = host.querySelector("[data-grid-sort-workbench]")!;
    const apply = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Apply Sort")!;
    apply.click();
    await vi.waitFor(() => expect(state.sortColumn).toBe("id"));
    expect(state.sortDirection).toBe("desc");
    expect(text.value).toBe("`id` DESC, `name` ASC");
    expect(backendMocks.buildTableSelectSql).toHaveBeenLastCalledWith(expect.objectContaining({ orderBy: "`id` DESC, `name` ASC" }));
    [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Clear Sort")!.click();
    await vi.waitFor(() => expect(state.sortColumn).toBeUndefined());
    expect(state.sortDirection).toBeUndefined();
    expect(text.value).toBe("");
    expect(backendMocks.buildTableSelectSql).toHaveBeenLastCalledWith(expect.objectContaining({ orderBy: undefined }));
  });
  it("retains a MongoDB controlled sort arrow without SQL table metadata", async () => {
    const sort = reactive({ context: "results", databaseType: "mongodb", onExecuteSql: undefined, tableMeta: undefined, sortColumn: "id" as string | undefined, sortColumnIndex: 0, sortDirection: "desc" as string | undefined });
    const { host } = mountGrid("conditions", false, undefined, undefined, sort);
    await settle();
    expect(host.querySelector('button[aria-label="Sort: id DESC"]')).not.toBeNull();
    sort.sortColumn = undefined;
    sort.sortDirection = undefined;
    await settle();
    expect(host.querySelector('button[aria-label="Sort: id DESC"]')).toBeNull();
    expect(host.querySelector('button[aria-label="Sort: id"]')).not.toBeNull();
  });
  it("imports restored text sorting without applying the same field twice", async () => {
    const { host } = mountGrid("conditions", false, undefined, "`id` ASC");
    await settle();
    sortToggle(host).click();
    await settle();
    const panel = host.querySelector("[data-grid-sort-workbench]")!;
    const apply = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Apply Sort")!;
    apply.click();
    await vi.waitFor(() => expect(backendMocks.buildTableSelectSql).toHaveBeenLastCalledWith(expect.objectContaining({ orderBy: "`id` ASC" })));
  });
  it("edits a text filter through the panel without duplicating the previous condition", async () => {
    const { host } = mountGrid("conditions", false);
    await settle();
    const text = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="WHERE"]')!;
    text.value = "id = 6";
    text.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    filterToggle(host).click();
    await settle();
    const editor = host.querySelector<HTMLInputElement>("[data-filter-value-editor]")!;
    expect(editor.value).toBe("6");
    editor.value = "7";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    applyButton(host, "conditions").click();
    await vi.waitFor(() => expect(text.value).toBe("`id` = 7"));
    expect(backendMocks.buildTableSelectSql).toHaveBeenLastCalledWith(expect.objectContaining({ whereInput: "`id` = 7" }));
  });

  it("keeps incomplete and complex filter text editable", async () => {
    const { host } = mountGrid("conditions", false);
    await settle();
    const text = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="WHERE"]')!;
    for (const value of ["id ", "COALESCE(id, 0) = 1 ", "id = 'unfinished"]) {
      text.value = value;
      text.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
      expect(text.value).toBe(value);
    }
  });

  it("synchronizes text sorting with its builder and the column arrow", async () => {
    const { host } = mountGrid("conditions", false);
    await settle();
    const text = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="ORDER BY"]')!;
    text.value = "`id` DESC";
    text.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    sortToggle(host).click();
    await settle();
    const panel = host.querySelector("[data-grid-sort-workbench]")!;
    expect(panel.textContent).toContain("id");
    expect(panel.textContent).toContain("DESC");
    const apply = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Apply Sort")!;
    apply.click();
    await vi.waitFor(() => expect(backendMocks.buildTableSelectSql).toHaveBeenLastCalledWith(expect.objectContaining({ orderBy: "`id` DESC" })));
    expect(text.value).toBe("`id` DESC");
    expect(host.querySelector('button[aria-label="Sort: id DESC"]')).not.toBeNull();
  });
});
