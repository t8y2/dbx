// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, shallowRef, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ShortcutActionId } from "@/lib/editor/shortcutRegistry";

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
const shortcutCases = [
  { actionId: "goToFirstPage", key: "F1", offset: 0, functionName: "firstPage" },
  { actionId: "goToPreviousPage", key: "F2", offset: 100, functionName: "prevPage" },
  { actionId: "goToNextPage", key: "F3", offset: 300, functionName: "nextPage" },
  { actionId: "goToLastPage", key: "F4", offset: 400, functionName: "lastPage" },
] as const;

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
    pageOffset?: number;
    totalRowCount?: number;
    loading?: boolean;
    paginationEnabled?: boolean;
    infiniteScroll?: boolean;
    empty?: boolean;
    configurePaginationShortcuts?: boolean;
    pageSizePreference?: "results" | "table-open";
  } = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    infiniteScroll: options.infiniteScroll ?? false,
    shortcuts: {
      ...settingsStore.editorSettings.shortcuts,
      ...(options.configurePaginationShortcuts === false
        ? {}
        : {
            goToFirstPage: "Alt+F1",
            goToPreviousPage: "Alt+F2",
            goToNextPage: "Alt+F3",
            goToLastPage: "Alt+F4",
          }),
    },
  });
  const result = markRaw<QueryResult>({
    columns: ["id"],
    rows: options.empty ? [] : [[1]],
    affected_rows: 0,
    execution_time_ms: 0,
  });
  const paginate = vi.fn();
  const gridState = shallowRef<Record<string, unknown>>({});

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
                pageSizePreference: options.pageSizePreference,
                pageLimit: 100,
                pageOffset: options.pageOffset ?? 200,
                totalRowCount: options.totalRowCount ?? 500,
                loading: options.loading ?? false,
                paginationEnabled: options.paginationEnabled ?? true,
                ...gridState.value,
                onPaginate: paginate,
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
  const mounted = { app, host };
  mountedApps.push(mounted);
  return { host, paginate, settingsStore, gridState };
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

function dispatchShortcut(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, altKey: true, key });
  target.dispatchEvent(event);
  return event;
}

function menuActionButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')).find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Menu action button not found: ${label}`);
  return button;
}

async function openCustomPageSizeMenu(host: HTMLElement): Promise<HTMLInputElement> {
  const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find((button) => button.textContent?.includes("100"));
  expect(trigger).toBeDefined();
  trigger!.click();
  await settle();
  const input = document.querySelector<HTMLInputElement>('[role="menu"] input[type="number"]');
  expect(input).not.toBeNull();
  return input!;
}

async function enterCustomPageSize(host: HTMLElement, size: string): Promise<void> {
  const input = await openCustomPageSizeMenu(host);
  input.value = size;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid pagination shortcuts", () => {
  it("allows pointer focus and editing in the custom page size input", async () => {
    const { host, paginate } = mountGrid();
    await settle();
    const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")).find((button) => button.textContent?.includes("100"));
    expect(trigger).toBeDefined();
    trigger!.click();
    await settle();

    const input = document.querySelector<HTMLInputElement>('[role="menu"] input[type="number"]');
    expect(input).not.toBeNull();
    const pointer = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    input!.dispatchEvent(pointer);
    // Canceling pointerdown suppresses the browser's native focus behavior.
    expect(pointer.defaultPrevented).toBe(false);
    input!.focus();
    input!.value = "250";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(document.activeElement).toBe(input);
    input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate.mock.calls[0]?.slice(0, 2)).toEqual([0, 250]);
  });

  it.each(shortcutCases)("runs $functionName through the configured $actionId shortcut", async ({ key, offset }) => {
    const { host, paginate } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    root.focus();

    const event = dispatchShortcut(root, key);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate.mock.calls[0]?.slice(0, 2)).toEqual([offset, 100]);
  });

  it.each([
    ["goToFirstPage", "F1"],
    ["goToPreviousPage", "F2"],
  ] as const)("does not consume %s on the first page", async (_actionId, key) => {
    const { host, paginate } = mountGrid({ pageOffset: 0 });
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = dispatchShortcut(root, key);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(paginate).not.toHaveBeenCalled();
  });

  it.each([
    ["goToNextPage", "F3"],
    ["goToLastPage", "F4"],
  ] as const)("does not consume %s on the last page", async (_actionId, key) => {
    const { host, paginate } = mountGrid({ pageOffset: 400 });
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = dispatchShortcut(root, key);
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(paginate).not.toHaveBeenCalled();
  });

  it.each([
    ["loading", { loading: true }],
    ["disabled pagination", { paginationEnabled: false }],
    ["infinite scroll", { infiniteScroll: true }],
    ["no available pages", { pageOffset: 0, totalRowCount: 0, empty: true }],
  ] as const)("does not consume pagination shortcuts during %s", async (_label, options) => {
    const { host, paginate } = mountGrid(options);
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    for (const { key } of shortcutCases) {
      const event = dispatchShortcut(root, key);
      expect(event.defaultPrevented).toBe(false);
    }
    await settle();

    expect(bubbled).toHaveBeenCalledTimes(shortcutCases.length);
    expect(paginate).not.toHaveBeenCalled();
  });

  it("does not trigger or consume pagination shortcuts from editable targets", async () => {
    const { host, paginate } = mountGrid();
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);
    const targets = [document.createElement("input"), document.createElement("textarea"), document.createElement("div"), document.createElement("div")];
    targets[2]!.setAttribute("contenteditable", "true");
    targets[3]!.setAttribute("role", "textbox");

    for (const target of targets) {
      root.append(target);
      const event = dispatchShortcut(target, "F3");
      expect(event.defaultPrevented).toBe(false);
    }
    await settle();

    expect(bubbled).toHaveBeenCalledTimes(targets.length);
    expect(paginate).not.toHaveBeenCalled();
  });

  it("keeps legacy settings without pagination mappings keyboard-neutral", async () => {
    const { host, paginate } = mountGrid({ configurePaginationShortcuts: false });
    await settle();
    const root = gridRoot(host);
    const bubbled = vi.fn();
    host.addEventListener("keydown", bubbled);

    const event = dispatchShortcut(root, "F3");
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(paginate).not.toHaveBeenCalled();
    const actionIds: ShortcutActionId[] = shortcutCases.map(({ actionId }) => actionId);
    expect(actionIds).toHaveLength(4);
  });
});

describe("DataGrid custom page size persistence", () => {
  it("applying a custom page size is temporary and does not write editor settings", async () => {
    const { host, paginate, settingsStore } = mountGrid();
    await settle();
    const updateEditorSettings = vi.spyOn(settingsStore, "updateEditorSettings");

    await enterCustomPageSize(host, "250");
    menuActionButton(i18n.global.t("grid.applyForThisQuery")).click();
    await settle();

    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate.mock.calls[0]?.slice(0, 2)).toEqual([0, 250]);
    expect(updateEditorSettings).not.toHaveBeenCalled();
    expect(settingsStore.editorSettings.pageSize).toBe(100);
    expect(settingsStore.editorSettings.tableOpenPageSize).toBe(100);
  });

  it("set-as-default persists the table-open page size for table grids", async () => {
    const { host, paginate, settingsStore } = mountGrid();
    await settle();
    const updateEditorSettings = vi.spyOn(settingsStore, "updateEditorSettings");

    await enterCustomPageSize(host, "250");
    menuActionButton(i18n.global.t("grid.applyAndSetDefault")).click();
    await settle();

    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate.mock.calls[0]?.slice(0, 2)).toEqual([0, 250]);
    expect(updateEditorSettings).toHaveBeenCalledWith({ tableOpenPageSize: 250 });
    expect(settingsStore.editorSettings.tableOpenPageSize).toBe(250);
    expect(settingsStore.editorSettings.pageSize).toBe(100);
  });

  it("set-as-default persists the query page size for results grids", async () => {
    const { host, paginate, settingsStore } = mountGrid({ pageSizePreference: "results" });
    await settle();
    const updateEditorSettings = vi.spyOn(settingsStore, "updateEditorSettings");

    await enterCustomPageSize(host, "250");
    menuActionButton(i18n.global.t("grid.applyAndSetDefault")).click();
    await settle();

    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate.mock.calls[0]?.slice(0, 2)).toEqual([0, 250]);
    expect(updateEditorSettings).toHaveBeenCalledWith({ pageSize: 250 });
    expect(settingsStore.editorSettings.pageSize).toBe(250);
    expect(settingsStore.editorSettings.tableOpenPageSize).toBe(100);
  });
});

describe("DataGrid SQL load-all exhaustion", () => {
  it.each([0, 1])("stops after a %i-row tail and does not probe again", async (tailRows) => {
    const { host, paginate, gridState } = mountGrid({ pageOffset: 0, totalRowCount: 100 });
    const result = (count: number, appended?: number) => ({ columns: ["id"], rows: Array.from({ length: count }, (_, i) => [i]), has_more: false, appended_from_row_count: appended, affected_rows: 0, execution_time_ms: 0 });
    gridState.value = { context: "results", pageSql: "SELECT id FROM items LIMIT 100", executedPageOffset: 0, executedPageLimit: 100, result: result(100) };
    await settle();
    const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.global.t("grid.loadAllAndGoToLastRow")}"]`)!;
    button.click();
    await settle();
    expect(paginate.mock.calls[0]?.slice(0, 2)).toEqual([100, 100]);
    gridState.value = { ...gridState.value, executedPageOffset: 100, result: result(100 + tailRows, 100) };
    await settle();
    button.click();
    await settle();
    expect(paginate).toHaveBeenCalledOnce();
  });

  it("respects the configured result cap when a SQL page is full", async () => {
    const { host, paginate, settingsStore, gridState } = mountGrid({ pageOffset: 0, totalRowCount: 100 });
    settingsStore.updateEditorSettings({ queryResultMaxRowsEnabled: true, queryResultMaxRows: 100 });
    gridState.value = { context: "results", pageSql: "SELECT id FROM items LIMIT 100", result: { columns: ["id"], rows: Array.from({ length: 100 }, (_, i) => [i]), has_more: false, truncated: true, affected_rows: 0, execution_time_ms: 0 } };
    await settle();
    host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.global.t("grid.loadAllAndGoToLastRow")}"]`)!.click();
    await settle();
    expect(paginate).not.toHaveBeenCalled();
  });

  it.each([false, true])("probes past a cached total and stops at an empty tail (infiniteScroll=%s)", async (infiniteScroll) => {
    const { host, paginate, settingsStore, gridState } = mountGrid({ infiniteScroll, pageOffset: 0, totalRowCount: 100 });
    settingsStore.updateEditorSettings({ queryResultMaxRowsEnabled: true, queryResultMaxRows: 1000 });
    const rows = Array.from({ length: 100 }, (_, index) => [index]);
    gridState.value = { context: "results", pageSql: "SELECT id FROM items LIMIT 100", executedPageOffset: 0, executedPageLimit: 100, result: { columns: ["id"], rows, has_more: false, affected_rows: 0, execution_time_ms: 0 } };
    await settle();
    const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.global.t("grid.loadAllAndGoToLastRow")}"]`)!;
    button.click();
    await settle();
    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate.mock.calls[0]?.slice(0, 2)).toEqual([100, 100]);
    expect(paginate.mock.calls[0]?.[4]).toBe(true);

    // COUNT said 100, but the original session has another full page.
    gridState.value = { ...gridState.value, executedPageOffset: 100, result: { columns: ["id"], rows: [...rows, ...rows], has_more: false, appended_from_row_count: 100, affected_rows: 0, execution_time_ms: 0 } };
    await settle();
    expect(paginate).toHaveBeenCalledTimes(2);
    expect(paginate.mock.calls[1]?.slice(0, 2)).toEqual([200, 100]);

    gridState.value = { ...gridState.value, executedPageOffset: 200, result: { columns: ["id"], rows: [...rows, ...rows], has_more: false, appended_from_row_count: 200, affected_rows: 0, execution_time_ms: 0 } };
    await settle();
    button.click();
    await settle();
    expect(paginate).toHaveBeenCalledTimes(2);
  });
});

describe("DataGrid multi-chunk load-all run", () => {
  it("keeps loading consecutive chunks across multiple post-flush ticks until total is reached (#11230)", async () => {
    const { host, paginate, settingsStore, gridState } = mountGrid({ infiniteScroll: true, pageOffset: 0, totalRowCount: 260_000 });
    settingsStore.updateEditorSettings({ queryResultMaxRowsEnabled: true, queryResultMaxRows: 100_000 });
    const initialRows = Array.from({ length: 500 }, (_, index) => [index]);
    gridState.value = {
      context: "table-data",
      pageLimit: 500,
      pageOffset: 0,
      totalRowCount: 260_000,
      result: { columns: ["id"], rows: initialRows, has_more: true, affected_rows: 0, execution_time_ms: 0 },
    };
    await settle();

    const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.global.t("grid.loadAllAndGoToLastRow")}"]`)!;
    button.click();
    await settle();

    const confirmButton = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === i18n.global.t("grid.loadAllRowsContinue"));
    if (confirmButton) {
      confirmButton.click();
      await settle();
    }

    expect(paginate).toHaveBeenCalledOnce();
    expect(paginate.mock.calls[0]?.slice(0, 2)).toEqual([500, 99_500]);
    expect(paginate.mock.calls[0]?.[4]).toBe(true);

    const chunk1Rows = [...initialRows, ...Array.from({ length: 99_500 }, (_, index) => [index + 500])];
    gridState.value = {
      ...gridState.value,
      result: { columns: ["id"], rows: chunk1Rows, has_more: true, appended_from_row_count: 500, affected_rows: 0, execution_time_ms: 0 },
    };
    await settle();

    expect(paginate).toHaveBeenCalledTimes(2);
    expect(paginate.mock.calls[1]?.slice(0, 2)).toEqual([100_000, 99_500]);
    expect(paginate.mock.calls[1]?.[4]).toBe(true);

    const chunk2Rows = [...chunk1Rows, ...Array.from({ length: 99_500 }, (_, index) => [index + 100_000])];
    gridState.value = {
      ...gridState.value,
      result: { columns: ["id"], rows: chunk2Rows, has_more: true, appended_from_row_count: 100_000, affected_rows: 0, execution_time_ms: 0 },
    };
    await settle();

    expect(paginate).toHaveBeenCalledTimes(3);
    expect(paginate.mock.calls[2]?.slice(0, 2)).toEqual([199_500, 60_500]);
    expect(paginate.mock.calls[2]?.[4]).toBe(true);

    const chunk3Rows = [...chunk2Rows, ...Array.from({ length: 60_500 }, (_, index) => [index + 199_500])];
    gridState.value = {
      ...gridState.value,
      result: { columns: ["id"], rows: chunk3Rows, has_more: false, appended_from_row_count: 199_500, affected_rows: 0, execution_time_ms: 0 },
    };
    await settle();

    expect(paginate).toHaveBeenCalledTimes(3);
  });
});
