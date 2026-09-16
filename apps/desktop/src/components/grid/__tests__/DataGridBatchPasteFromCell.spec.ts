// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, defineComponent, h, markRaw, nextTick, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import type { CustomSaveHandler } from "@/composables/useDataGridEditor";
import { buildMongoUpdateDocument } from "@/lib/mongo/mongoDocumentValues";
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

interface MountGridOptions {
  result?: QueryResult;
  quickEntry?: boolean;
  hideNullColumns?: boolean;
  readonlyColumnIndexes?: number[];
  databaseType?: "dameng" | "mongodb";
  customSaveHandler?: CustomSaveHandler;
}

function mountGrid(options: MountGridOptions = {}) {
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
                databaseType: options.databaseType ?? "dameng",
                context: "table-data",
                editable: true,
                customSaveHandler: options.customSaveHandler,
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
  it("expands beyond pre-added blank rows when pasted rows exceed them", async () => {
    const { host } = mountGrid();
    await settle();
    for (let index = 0; index < 5; index++) await addBlankRow(host);

    const blankRows = pendingRows(host);
    expect(blankRows).toHaveLength(5);
    await selectCell(visibleCells(blankRows[0]!)[0]!);
    await selectCell(visibleCells(blankRows[4]!)[0]!, { shiftKey: true });
    await paste(host, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => visibleCellTexts(row)[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(visibleCellTexts(rows.at(-1)!)[0]).toBe("10");
  });

  it("reuses exactly enough pre-added blank rows without adding an extra row", async () => {
    const { host } = mountGrid();
    await settle();
    for (let index = 0; index < 10; index++) await addBlankRow(host);

    const blankRows = pendingRows(host);
    expect(blankRows).toHaveLength(10);
    await selectCell(visibleCells(blankRows[0]!)[0]!);
    await selectCell(visibleCells(blankRows[9]!)[0]!, { shiftKey: true });
    await paste(host, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => visibleCellTexts(row)[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(visibleCellTexts(rows.at(-1)!)[0]).toBe("10");
  });

  it("keeps extra pre-added blank rows when the clipboard has fewer rows", async () => {
    const { host } = mountGrid();
    await settle();
    for (let index = 0; index < 10; index++) await addBlankRow(host);

    const blankRows = pendingRows(host);
    await selectCell(visibleCells(blankRows[0]!)[0]!);
    await selectCell(visibleCells(blankRows[9]!)[0]!, { shiftKey: true });
    await paste(host, "1\n2\n3\n4\n5");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(10);
    expect(visibleCellTexts(rows[0]!)[0]).toBe("1");
    expect(visibleCellTexts(rows[4]!)[0]).toBe("5");
    expect(visibleCellTexts(rows[5]!)[0]).toBe("NULL");
    expect(visibleCellTexts(rows[9]!)[0]).toBe("NULL");
  });

  it("keeps single-cell auto expansion with pre-added blank rows", async () => {
    const { host } = mountGrid();
    await settle();
    for (let index = 0; index < 5; index++) await addBlankRow(host);

    const blankRows = pendingRows(host);
    await selectCell(visibleCells(blankRows[0]!)[0]!);
    await paste(host, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => visibleCellTexts(row)[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(visibleCellTexts(rows.at(-1)!)[0]).toBe("10");
  });

  it("preserves visible column mapping for a multi-row selection", async () => {
    const { host } = mountGrid({ hideNullColumns: true });
    await settle();
    for (let index = 0; index < 5; index++) await addBlankRow(host);

    const blankRows = pendingRows(host);
    await selectCell(visibleCells(blankRows[0]!)[1]!);
    await selectCell(visibleCells(blankRows[4]!)[1]!, { shiftKey: true });
    const clipboardRows = Array.from({ length: 10 }, (_, index) => `value-${index + 1}\tnote-${index + 1}`).join("\n");
    await paste(host, clipboardRows);

    const rows = pendingRows(host);
    expect(rows).toHaveLength(10);
    expect(visibleCellTexts(rows[0]!)).toEqual(["NULL", "value-1", "note-1"]);
    expect(visibleCellTexts(rows.at(-1)!)).toEqual(["NULL", "value-10", "note-10"]);
  });

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
    for (let index = 0; index < 5; index++) await addBlankRow(host);

    const blankRows = pendingRows(host);
    expect(blankRows).toHaveLength(5);
    await selectRowNumber(blankRows[0]!);
    const clipboardRows = Array.from({ length: 10 }, (_, index) => `${index + 10}\t${index + 20}`).join("\n");
    await paste(host, clipboardRows);

    const rows = pendingRows(host);
    expect(rows).toHaveLength(10);
    expect(visibleCellTexts(rows[0]!)).toEqual(["10", "20", "NULL"]);
    expect(visibleCellTexts(rows.at(-1)!)).toEqual(["19", "29", "NULL"]);
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

  it("does not expand a multi-row selection containing a nonblank new row", async () => {
    const { host } = mountGrid();
    await settle();
    for (let index = 0; index < 5; index++) await addBlankRow(host);

    let rows = pendingRows(host);
    await selectCell(visibleCells(rows[0]!)[2]!);
    await paste(host, "occupied");
    rows = pendingRows(host);
    await selectCell(visibleCells(rows[0]!)[2]!);
    await selectCell(visibleCells(rows[4]!)[2]!, { shiftKey: true });
    await paste(host, "1\n2\n3\n4\n5\n6\n7\n8\n9\n10");

    rows = pendingRows(host);
    expect(rows).toHaveLength(5);
    expect(visibleCellTexts(rows.at(-1)!)[2]).toBe("5");
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

  it("preserves an ordinary string when a Mongo column selection is pasted and saved", async () => {
    const result: QueryResult = {
      columns: ["_id", "status"],
      rows: [
        ["1", "pending"],
        ["2", "queued"],
      ],
      affected_rows: 0,
      execution_time_ms: 0,
    };
    const originals = [
      { _id: "1", status: "pending" },
      { _id: "2", status: "queued" },
    ];
    const updates: Array<Record<string, unknown>> = [];
    const customSaveHandler: CustomSaveHandler = {
      supportsInsert: false,
      save: async ({ dirtyRows, columns }) => {
        for (const [rowIndex, changes] of dirtyRows) {
          updates.push(buildMongoUpdateDocument(changes, columns, originals[rowIndex]));
        }
      },
    };
    const { host } = mountGrid({ result, databaseType: "mongodb", customSaveHandler });
    await settle();
    await selectColumnHeader(host, 1);
    await paste(host, "Y");
    gridRoot(host).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "s" }));
    await settle();

    expect(updates).toEqual([{ $set: { status: "Y" } }, { $set: { status: "Y" } }]);
  });

  it("keeps JSON-looking plain text when a Mongo column paste reaches a missing field", async () => {
    const result: QueryResult = {
      columns: ["_id", "status"],
      rows: [
        ["1", null],
        ["2", null],
      ],
      affected_rows: 0,
      execution_time_ms: 0,
    };
    const originals = [{ _id: "1" }, { _id: "2" }];
    const updates: Array<Record<string, unknown>> = [];
    const customSaveHandler: CustomSaveHandler = {
      supportsInsert: false,
      save: async ({ dirtyRows, columns }) => {
        for (const [rowIndex, changes] of dirtyRows) {
          updates.push(buildMongoUpdateDocument(changes, columns, originals[rowIndex]));
        }
      },
    };
    const { host } = mountGrid({ result, databaseType: "mongodb", customSaveHandler });
    await settle();
    await selectColumnHeader(host, 1);
    await paste(host, "{plain text");
    gridRoot(host).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "s" }));
    await settle();

    expect(updates).toEqual([{ $set: { status: "{plain text" } }, { $set: { status: "{plain text" } }]);
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
