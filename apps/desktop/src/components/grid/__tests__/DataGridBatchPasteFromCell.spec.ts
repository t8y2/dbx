// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, defineComponent, h, markRaw, nextTick, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
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
      renderedColumnWidths: ref([120, 120, 120, 120]),
      totalWidth: ref(480),
      columnVars: ref({ "--total-w": "480px" }),
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

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function defaultResult(): QueryResult {
  return {
    columns: ["c0", "hidden", "c2", "c3"],
    rows: [[1, null, "seed-2", "seed-3"]],
    affected_rows: 0,
    execution_time_ms: 0,
  };
}

function mountGrid(options: { result?: QueryResult; quickEntry?: boolean; hideNullColumns?: boolean; readonlyColumnIndexes?: number[] } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "canvas", dataGridHideNullColumns: options.hideNullColumns ?? false, dataGridQuickEntry: options.quickEntry ?? false });
  const gridResult = markRaw(options.result ?? defaultResult());

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
                result: gridResult,
                databaseType: "dameng",
                context: "table-data",
                editable: true,
                readonlyColumnIndexes: options.readonlyColumnIndexes,
                tableMeta: {
                  tableName: "paste_target",
                  columns: gridResult.columns.map((name, index) => ({
                    name,
                    data_type: index === 0 ? "int" : "varchar",
                    is_nullable: index !== 0,
                    column_default: null,
                    is_primary_key: index === 0,
                    extra: null,
                  })),
                  primaryKeys: ["c0"],
                },
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
  settingsStore.updateEditorSettings({ dataGridRenderMode: "dom" });
  const mounted = { app, host };
  mountedApps.push(mounted);
  return mounted;
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

async function addBlankRow(host: HTMLElement) {
  gridRoot(host).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "n" }));
  await settle();
  const editor = host.querySelector<HTMLElement>(".cell-edit-input");
  editor?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
  await settle();
}

async function selectCell(cell: HTMLElement, options: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
  cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...options }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, ...options }));
  await settle();
}

async function selectRowNumber(row: HTMLElement) {
  const rowNumber = row.querySelector<HTMLElement>(".data-grid-row-number");
  if (!rowNumber) throw new Error("Row number not found");
  rowNumber.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  await settle();
}

async function selectColumnHeader(host: HTMLElement, actualColumnIndex: number) {
  const header = host.querySelector<HTMLElement>(`[data-grid-column-index="${actualColumnIndex}"]`);
  if (!header) throw new Error(`Column header not found: ${actualColumnIndex}`);
  header.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  await settle();
}

async function paste(host: HTMLElement, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  gridRoot(host).dispatchEvent(event);
  await settle();
}

function pendingRows(host: HTMLElement, existingRowCount = 1): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".data-grid-row")].slice(existingRowCount);
}

function displayRows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".data-grid-row")];
}

function visibleCells(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>("[data-visible-col-index]")];
}

function visibleCellTexts(row: HTMLElement): Array<string | undefined> {
  return visibleCells(row).map((cell) => cell.textContent?.trim());
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid multi-row paste from a blank cell", () => {
  it("starts at the selected visible column, skips hidden columns, and appends rows", async () => {
    const { host } = mountGrid({ hideNullColumns: true });
    await settle();
    await addBlankRow(host);

    const [blankRow] = pendingRows(host);
    expect(blankRow).toBeDefined();
    const cells = visibleCells(blankRow!);
    expect(cells).toHaveLength(3);
    await selectCell(cells[1]!);
    expect(cells[1]!.className).toContain("cell-selected");
    await paste(host, "a\tb\nc\td");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(2);
    expect(visibleCellTexts(rows[0]!)).toEqual(["NULL", "a", "b"]);
    expect(visibleCellTexts(rows[1]!)).toEqual(["NULL", "c", "d"]);
  });

  it("appends rows from the terminal quick-entry draft cell", async () => {
    const { host } = mountGrid({ quickEntry: true, hideNullColumns: true });
    await settle();

    const draftRow = displayRows(host).at(-1);
    expect(draftRow).toBeDefined();
    const cells = visibleCells(draftRow!);
    await selectCell(cells[1]!);
    await paste(host, "a\tb\nc\td");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(2);
    expect(visibleCellTexts(rows[0]!)).toEqual(["NULL", "a", "b"]);
    expect(visibleCellTexts(rows[1]!)).toEqual(["NULL", "c", "d"]);
  });

  it("keeps row-number paste priority and starts from the first visible column", async () => {
    const { host } = mountGrid({ hideNullColumns: true });
    await settle();
    await addBlankRow(host);

    const [blankRow] = pendingRows(host);
    expect(blankRow).toBeDefined();
    await selectRowNumber(blankRow!);
    await paste(host, "10\t20\n30\t40");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(2);
    expect(visibleCellTexts(rows[0]!)).toEqual(["10", "20", "NULL"]);
    expect(visibleCellTexts(rows[1]!)).toEqual(["30", "40", "NULL"]);
  });

  it("keeps nonblank new rows on the ordinary bounded paste path", async () => {
    const { host } = mountGrid();
    await settle();
    await addBlankRow(host);

    let [row] = pendingRows(host);
    await selectCell(visibleCells(row!)[2]!);
    await paste(host, "occupied");
    [row] = pendingRows(host);
    await selectCell(visibleCells(row!)[2]!);
    await paste(host, "first\nsecond");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(1);
    expect(visibleCellTexts(rows[0]!)[2]).toBe("first");
  });

  it("keeps existing rows on the ordinary bounded paste path", async () => {
    const { host } = mountGrid();
    await settle();

    const [row] = displayRows(host);
    await selectCell(visibleCells(row!)[2]!);
    await paste(host, "first\nsecond");

    const rows = displayRows(host);
    expect(rows).toHaveLength(1);
    expect(visibleCellTexts(rows[0]!)[2]).toBe("first");
  });

  it("does not append from a multi-cell range", async () => {
    const { host } = mountGrid();
    await settle();
    await addBlankRow(host);

    const [row] = pendingRows(host);
    const cells = visibleCells(row!);
    await selectCell(cells[1]!);
    await selectCell(cells[2]!, { shiftKey: true });
    await paste(host, "a\tb\nc\td");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(1);
    expect(visibleCellTexts(rows[0]!).slice(1, 3)).toEqual(["a", "b"]);
  });

  it("does not append from a column selection", async () => {
    const { host } = mountGrid();
    await settle();
    await addBlankRow(host);

    await selectColumnHeader(host, 2);
    await paste(host, "first\nsecond\nthird");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(1);
    expect(visibleCellTexts(rows[0]!)[2]).toBe("second");
  });

  it("does not append from a readonly cell", async () => {
    const { host } = mountGrid({ readonlyColumnIndexes: [2] });
    await settle();
    await addBlankRow(host);

    const [row] = pendingRows(host);
    await selectCell(visibleCells(row!)[2]!);
    await paste(host, "first\nsecond");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(1);
    expect(visibleCellTexts(rows[0]!)[2]).toBe("NULL");
  });

  it("does not append an empty clipboard", async () => {
    const { host } = mountGrid();
    await settle();
    await addBlankRow(host);

    const [row] = pendingRows(host);
    await selectCell(visibleCells(row!)[2]!);
    await paste(host, "");

    expect(pendingRows(host)).toHaveLength(1);
  });

  it("routes DOM and canvas cell gestures through the same selection preparation", () => {
    const source = readFileSync(resolve(process.cwd(), "apps/desktop/src/components/grid/DataGrid.vue"), "utf8");
    const domGesture = source.slice(source.indexOf('@mousedown="\n                          prepareDataCellMouseDown'), source.indexOf('@mouseenter="onCellMouseenter'));
    const canvasGesture = source.slice(source.indexOf("function onCanvasMouseDown"), source.indexOf("function onCanvasContext"));

    expect(domGesture).toContain("prepareDataCellMouseDown(item, col.actualColIdx);");
    expect(domGesture).toContain("handleDataCellMousedown(item.displayIndex, col.visibleColIdx, item.id, $event);");
    expect(canvasGesture).toContain("prepareDataCellMouseDown(item, actualColIdx)");
    expect(canvasGesture).toContain("handleDataCellMousedown(item.displayIndex, hit.visibleColIdx, item.id, event)");
    expect(source).toContain("columnIndexes: visibleColumnIndexes.value.slice(range.startCol)");
  });
});
