// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, shallowRef, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import type { CellValue } from "@/lib/dataGrid/cellValue";
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
      hasUserSizedColumns: ref(false),
      renderedColumnWidths: ref([160, 160]),
      totalWidth: ref(320),
      columnVars: ref({ "--total-w": "320px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

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

interface DataGridApi {
  displayItems: Array<{ sourceIndex?: number }>;
}

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function resultOf(rows: CellValue[][]): QueryResult {
  return markRaw<QueryResult>({
    columns: ["code", "status"],
    column_types: ["varchar", "varchar"],
    rows,
    affected_rows: rows.length,
    execution_time_ms: 0,
  });
}

function mountGrid(initialResult: QueryResult, viewGeneration = "generation-1") {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().updateEditorSettings({ dataGridRenderMode: "dom" });
  const result = shallowRef(initialResult);
  const generation = shallowRef(viewGeneration);
  const gridRef = shallowRef<DataGridApi | null>(null);
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
                ref: gridRef,
                result: result.value,
                viewGeneration: generation.value,
                databaseType: "mysql",
                context: "results",
                onExecuteSql: vi.fn(),
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
  return {
    host,
    gridRef,
    replaceResult: (nextResult: QueryResult, nextGeneration = generation.value) => {
      result.value = nextResult;
      generation.value = nextGeneration;
    },
  };
}

async function settle() {
  for (let i = 0; i < 6; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

function displayedSourceIndexes(gridRef: { value: DataGridApi | null }): number[] {
  return (gridRef.value?.displayItems ?? []).map((item) => item.sourceIndex ?? -1);
}

function contextMenuButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Context menu item not found: ${label}`);
  return button;
}

/** Right-click a visible cell and run an in-memory filter action from the submenu. */
async function applyCellFilterMenu(host: HTMLElement, displayRow: number, visibleCol: number, itemKey: string) {
  const cell = host.querySelector<HTMLElement>(`[data-row-index="${displayRow}"] [data-visible-col-index="${visibleCol}"]`);
  if (!cell) throw new Error(`Cell not found: ${displayRow}/${visibleCol}`);
  cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 12 }));
  await settle();
  contextMenuButton(i18n.global.t("grid.filter")).dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  await settle();
  contextMenuButton(i18n.global.t(itemKey)).click();
  await settle();
}

function filterByCellValue(host: HTMLElement, displayRow: number, visibleCol: number) {
  return applyCellFilterMenu(host, displayRow, visibleCol, "grid.filterByValue");
}

function excludeCellValue(host: HTMLElement, displayRow: number, visibleCol: number) {
  return applyCellFilterMenu(host, displayRow, visibleCol, "grid.filterExcludeValue");
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  document.querySelectorAll("[data-dbx-context-menu]").forEach((menu) => menu.remove());
  vi.restoreAllMocks();
});

describe("DataGrid in-memory result cell filter (#13237)", () => {
  it("AND-composes columns and clears through the local-filter chip", async () => {
    const { host, gridRef } = mountGrid(
      resultOf([
        ["007", "a"],
        ["7", "a"],
        ["007", "b"],
        [null, "a"],
        ["", "b"],
      ]),
    );
    await settle();
    expect(displayedSourceIndexes(gridRef)).toEqual([0, 1, 2, 3, 4]);

    await filterByCellValue(host, 0, 0);
    expect(displayedSourceIndexes(gridRef)).toEqual([0, 2]);

    // A second column must narrow the first filter, not replace it.
    await filterByCellValue(host, 0, 1);
    expect(displayedSourceIndexes(gridRef)).toEqual([0]);

    const chip = host.querySelector<HTMLButtonElement>(`button[title="${i18n.global.t("grid.clearLocalFilters")}"]`);
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toContain("2");
    chip!.click();
    await settle();
    expect(displayedSourceIndexes(gridRef)).toEqual([0, 1, 2, 3, 4]);
  });

  it("compares text by value and shows the filtered empty state", async () => {
    const { host, gridRef } = mountGrid(
      resultOf([
        ["007", "a"],
        ["7", "a"],
        ["007", "b"],
      ]),
    );
    await settle();

    // "7" must not match the "007" rows the way Number() coercion did.
    await filterByCellValue(host, 1, 0);
    expect(displayedSourceIndexes(gridRef)).toEqual([1]);

    // Excluding the only remaining row's status hides every row, which is a
    // filter result rather than an empty dataset.
    await excludeCellValue(host, 0, 1);
    expect(displayedSourceIndexes(gridRef)).toEqual([]);
    expect(host.textContent).toContain(i18n.global.t("grid.noFilteredRows"));
    expect(host.textContent).not.toContain(i18n.global.t("grid.noRows"));
  });

  it("keeps the filter on appended rows and resets it on a new generation", async () => {
    const { host, gridRef, replaceResult } = mountGrid(
      resultOf([
        ["007", "a"],
        ["7", "b"],
      ]),
    );
    await settle();
    await filterByCellValue(host, 0, 0);
    expect(displayedSourceIndexes(gridRef)).toEqual([0]);

    // Load-more appends publish a new result object with the same generation.
    replaceResult(
      resultOf([
        ["007", "a"],
        ["7", "b"],
        ["007", "c"],
      ]),
    );
    await settle();
    expect(displayedSourceIndexes(gridRef)).toEqual([0, 2]);

    // A replaced logical result (new generation) drops the stale filter.
    replaceResult(resultOf([["7", "b"]]), "generation-2");
    await settle();
    expect(displayedSourceIndexes(gridRef)).toEqual([0]);
  });
});
