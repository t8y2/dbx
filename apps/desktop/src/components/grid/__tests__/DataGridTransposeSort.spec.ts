// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, ref, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";
import { sortDataGridRowIndexes, type DataGridSortDirection, type DataGridSortMode } from "@/lib/dataGrid/dataGridSort";

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
        return () => h("div", attrs, [slots.before?.(), props.items.map((item, index) => slots.default?.({ item, index }))]);
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
      renderedColumnWidths: ref([120, 120]),
      totalWidth: ref(240),
      columnVars: ref({ "--total-w": "240px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function menuAction(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Sort menu action not found: ${label}`);
  return button;
}

function transposeField(host: HTMLElement, columnIndex: number): HTMLElement {
  const field = host.querySelector<HTMLElement>(`[data-grid-transpose-column-index="${columnIndex}"]`);
  if (!field) throw new Error(`Transpose field not found: ${columnIndex}`);
  return field.closest<HTMLElement>(".data-grid-transpose-row")!;
}

function transposeValues(host: HTMLElement, columnIndex: number): string[] {
  return [...transposeField(host, columnIndex).querySelectorAll<HTMLElement>("[data-grid-transpose-cell]")].map((cell) => cell.textContent?.trim() ?? "");
}

function transposeRecordHeader(host: HTMLElement, recordIndex: number): HTMLElement {
  const header = host.querySelector<HTMLElement>(`[data-grid-transpose-record-header][data-grid-transpose-record-index="${recordIndex}"]`);
  if (!header) throw new Error(`Transpose record header not found: ${recordIndex}`);
  return header;
}

function mountGrid() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "dom", dataGridMultiRowTranspose: true });

  const originalRows: QueryResult["rows"] = [
    ["b", "10"],
    ["a", null],
    ["c", "2"],
  ];
  const result = ref<QueryResult>(
    markRaw({
      columns: ["name", "score"],
      column_types: ["varchar", "bigint"],
      rows: originalRows,
      affected_rows: 0,
      execution_time_ms: 0,
    }),
  );
  const sortColumn = ref<string>();
  const sortColumnIndex = ref<number>();
  const sortDirection = ref<DataGridSortDirection>();
  const sortMode = ref<DataGridSortMode>();
  const onSort = vi.fn((column: string, columnIndex: number, direction: DataGridSortDirection | null, _whereInput?: string, mode: DataGridSortMode = "database") => {
    const indexes = direction ? sortDataGridRowIndexes(originalRows, columnIndex, direction, result.value.column_types?.[columnIndex]) : originalRows.map((_, index) => index);
    result.value = markRaw({ ...result.value, rows: indexes.map((index) => originalRows[index]!) });
    sortColumn.value = direction ? column : undefined;
    sortColumnIndex.value = direction ? columnIndex : undefined;
    sortDirection.value = direction ?? undefined;
    sortMode.value = direction ? mode : undefined;
  });

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
                result: result.value,
                databaseType: "mysql",
                context: "table-data",
                sortColumn: sortColumn.value,
                sortColumnIndex: sortColumnIndex.value,
                sortDirection: sortDirection.value,
                sortMode: sortMode.value,
                tableMeta: {
                  tableName: "scores",
                  columns: [
                    { name: "name", data_type: "varchar", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
                    { name: "score", data_type: "bigint", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
                  ],
                  primaryKeys: ["name"],
                },
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
  return { host, onSort };
}

async function openTranspose(host: HTMLElement) {
  const firstRowNumber = host.querySelector<HTMLElement>(".data-grid-row-number");
  if (!firstRowNumber) throw new Error("Row number not found");
  firstRowNumber.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  firstRowNumber.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, button: 0 }));
  await settle();
}

async function selectTransposeSort(host: HTMLElement, columnIndex: number, labelKey: string) {
  const trigger = transposeField(host, columnIndex).querySelector<HTMLButtonElement>("[data-grid-transpose-sort]");
  if (!trigger) throw new Error(`Transpose sort trigger not found: ${columnIndex}`);
  trigger.click();
  await settle();
  menuAction(i18n.global.t(labelKey)).click();
  await settle();
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid transpose sorting", () => {
  it("uses the shared local/database sort actions and keeps the active record and row selection", async () => {
    const { host, onSort } = mountGrid();
    await settle();
    await openTranspose(host);

    expect(transposeValues(host, 1)).toEqual(["10", "NULL", "2"]);
    const nextRecordButton = host.querySelector(".lucide-chevron-right")?.closest<HTMLButtonElement>("button");
    if (!nextRecordButton) throw new Error("Next transpose record button not found");
    nextRecordButton.click();
    await settle();
    expect(transposeRecordHeader(host, 0).classList.contains("transpose-record-header-selected")).toBe(true);
    expect(transposeRecordHeader(host, 1).classList.contains("transpose-record-header-active")).toBe(true);

    await selectTransposeSort(host, 1, "grid.sortCurrentPageAscending");
    expect(onSort).toHaveBeenLastCalledWith("score", 1, "asc", undefined, "local");
    expect(transposeValues(host, 1)).toEqual(["2", "10", "NULL"]);
    expect(transposeRecordHeader(host, 1).classList.contains("transpose-record-header-selected")).toBe(true);
    expect(transposeRecordHeader(host, 2).classList.contains("transpose-record-header-active")).toBe(true);

    await selectTransposeSort(host, 1, "grid.sortDatabaseDescending");
    expect(onSort).toHaveBeenLastCalledWith("score", 1, "desc", undefined, "database", "`score` DESC");
    expect(transposeValues(host, 1)).toEqual(["10", "2", "NULL"]);
    expect(transposeRecordHeader(host, 0).classList.contains("transpose-record-header-selected")).toBe(true);
    expect(transposeRecordHeader(host, 2).classList.contains("transpose-record-header-active")).toBe(true);

    await selectTransposeSort(host, 1, "grid.clearSort");
    expect(onSort).toHaveBeenLastCalledWith("score", 1, null, undefined, "database", undefined);
    expect(transposeValues(host, 1)).toEqual(["10", "NULL", "2"]);
    expect(transposeRecordHeader(host, 0).classList.contains("transpose-record-header-selected")).toBe(true);
    expect(transposeRecordHeader(host, 1).classList.contains("transpose-record-header-active")).toBe(true);
    expect(host.querySelector(".transpose-grid-scroller")).not.toBeNull();
  });
});
