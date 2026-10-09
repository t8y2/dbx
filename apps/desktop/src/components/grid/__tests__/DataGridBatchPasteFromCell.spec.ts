// @vitest-environment happy-dom

import { createApp, defineComponent, h, KeepAlive, markRaw, nextTick, shallowRef, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import type { CustomSaveHandler } from "@/composables/useDataGridEditor";
import { buildMongoUpdateDocument } from "@/lib/mongo/mongoDocumentValues";
import { TooltipProvider } from "@/components/ui/tooltip";
import { readTextFromClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";

vi.mock("@/lib/common/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/common/clipboard")>()),
  readTextFromClipboard: vi.fn(),
}));

// DataGrid.vue imports RecycleScroller directly (no global registration),
// so the module itself must be stubbed for deterministic row rendering.
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
  editable?: boolean;
  allowInsertRows?: boolean;
}

function mountGrid(options: MountGridOptions = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "canvas", dataGridHideNullColumns: options.hideNullColumns ?? false, dataGridQuickEntry: options.quickEntry ?? false });
  const resultRef = shallowRef(markRaw(options.result ?? defaultResult()));
  const visibleRef = shallowRef(true);

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
              h(KeepAlive, null, {
                default: () =>
                  visibleRef.value
                    ? h(DataGrid, {
                        result: resultRef.value,
                        databaseType: options.databaseType ?? "dameng",
                        context: "table-data",
                        editable: options.editable ?? true,
                        allowInsertRows: options.allowInsertRows,
                        customSaveHandler: options.customSaveHandler,
                        readonlyColumnIndexes: options.readonlyColumnIndexes,
                        tableMeta: {
                          tableName: "paste_target",
                          columns: resultRef.value.columns.map((name, index) => ({
                            name,
                            data_type: index === 0 ? "int" : "varchar",
                            is_nullable: index !== 0,
                            column_default: null,
                            is_primary_key: index === 0,
                            extra: null,
                          })),
                          primaryKeys: ["c0"],
                        },
                      })
                    : null,
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
  return { ...mounted, resultRef, visibleRef };
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
  vi.mocked(readTextFromClipboard).mockReset();
});

async function pasteAsNewRows(host: HTMLElement) {
  const trigger = [...host.querySelectorAll<HTMLElement>("[aria-haspopup='menu']")].find((button) => button.getAttribute("aria-label") === i18n.global.t("grid.addRow"));
  if (!trigger) throw new Error("Add row menu trigger not found");
  trigger.click();
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settle();
  const item = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((item) => item.textContent?.trim() === i18n.global.t("grid.pasteAsNewRows"));
  if (!item) throw new Error("Paste as new rows menu item not found");
  item.click();
  await settle();
}

describe("DataGrid paste as new rows", () => {
  it("drops a clipboard read that finishes after deactivation and reactivation", async () => {
    const { host, visibleRef } = mountGrid();
    await settle();
    let finishRead!: (text: string) => void;
    vi.mocked(readTextFromClipboard).mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    await pasteAsNewRows(host);
    visibleRef.value = false;
    await settle();
    visibleRef.value = true;
    await settle();
    finishRead("2\tignored\tAda\tLovelace");
    await settle();
    expect(pendingRows(host)).toHaveLength(0);
  });

  it("bounds a single SQL line with excessive logical rows and leaves no drafts", async () => {
    const columns = Array.from({ length: 1000 }, (_, i) => `c${i}`);
    const { host } = mountGrid({ result: { ...defaultResult(), columns, rows: [[1, ...Array(999).fill(null)]] }, hideNullColumns: true });
    await settle();
    vi.mocked(readTextFromClipboard).mockResolvedValue(`INSERT INTO t VALUES ${"(1),".repeat(1000)}(1)`);
    await pasteAsNewRows(host);
    await vi.waitFor(() => expect(document.querySelector("[data-grid-row-preparation]")).toBeNull(), { timeout: 5000, interval: 10 });
    expect(pendingRows(host)).toHaveLength(0);
    await vi.waitFor(() => expect(useToast().message.value).toBe(i18n.global.t("grid.insertRowsClipboardTooLarge")), { interval: 1 });
  });

  it("allows a narrow overwrite paste in a wide table beyond the pending insertion row limit", async () => {
    const columns = Array.from({ length: 2000 }, (_, i) => `c${i}`);
    const rows = Array.from({ length: 600 }, (_, i) => [i, ...Array(1999).fill(null)]);
    const save = vi.fn<CustomSaveHandler["save"]>().mockResolvedValue();
    const { host } = mountGrid({ result: { ...defaultResult(), columns, rows }, hideNullColumns: true, customSaveHandler: { canInsert: true, save } });
    await settle();
    await selectColumnHeader(host, 0);
    await paste(host, Array.from({ length: 600 }, (_, i) => String(i + 1000)).join("\n"));
    host.querySelector<HTMLElement>("[data-toolbar-action='save']")!.click();
    await settle();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0].newRows).toHaveLength(0);
    expect(save.mock.calls[0]![0].dirtyRows.size).toBe(600);
  });

  it("inserts clipboard rows from the toolbar without preallocated blank rows or a selection", async () => {
    const { host } = mountGrid({ hideNullColumns: true });
    await settle();
    vi.mocked(readTextFromClipboard).mockResolvedValue("2\tAda\tLovelace\n3\tGrace\tHopper");

    await pasteAsNewRows(host);

    expect(readTextFromClipboard).toHaveBeenCalledOnce();
    expect(displayRows(host)).toHaveLength(3);
    expect(visibleCellTexts(displayRows(host)[0]!)).toEqual(["1", "seed-2", "seed-3"]);
    expect(pendingRows(host).map(visibleCellTexts)).toEqual([
      ["2", "Ada", "Lovelace"],
      ["3", "Grace", "Hopper"],
    ]);
  });

  it("drops a delayed clipboard read when the result is replaced", async () => {
    const { host, resultRef } = mountGrid();
    await settle();
    let finishRead!: (text: string) => void;
    vi.mocked(readTextFromClipboard).mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    await pasteAsNewRows(host);
    resultRef.value = markRaw({ ...defaultResult(), rows: [[99, null, "replacement", "result"]] });
    await settle();

    finishRead("2\tignored\tAda\tLovelace");
    await settle();

    expect(displayRows(host)).toHaveLength(1);
    expect(pendingRows(host)).toHaveLength(0);
    expect(visibleCellTexts(displayRows(host)[0]!)[0]).toBe("99");
  });

  it("passes pasted drafts through the existing save handler without modifying existing rows", async () => {
    const save = vi.fn<CustomSaveHandler["save"]>().mockResolvedValue();
    const { host } = mountGrid({ customSaveHandler: { canInsert: true, save } });
    await settle();
    vi.mocked(readTextFromClipboard).mockResolvedValue("2\tkeep\tAda\tLovelace");
    await pasteAsNewRows(host);
    host.querySelector<HTMLElement>("[data-toolbar-action='save']")!.click();
    await settle();

    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]![0].newRows).toEqual([[2, "keep", "Ada", "Lovelace"]]);
    expect(save.mock.calls[0]![0].dirtyRows.size).toBe(0);
    expect(save.mock.calls[0]![0].rows).toEqual(defaultResult().rows);
  });

  it.each(["empty", "unavailable"])("leaves no placeholder rows when the clipboard is %s", async (clipboardState) => {
    const { host } = mountGrid();
    await settle();
    if (clipboardState === "empty") vi.mocked(readTextFromClipboard).mockResolvedValue("");
    else vi.mocked(readTextFromClipboard).mockRejectedValue(new Error("Clipboard access denied"));

    await pasteAsNewRows(host);

    expect(pendingRows(host)).toHaveLength(0);
    expect(displayRows(host)).toHaveLength(1);
  });

  it.each([{ editable: false }, { allowInsertRows: false }])("hides insertion actions when unsupported: %j", async (options) => {
    const { host } = mountGrid(options);
    await settle();

    expect(host.querySelector("[data-toolbar-action='addRow']")).toBeNull();
    expect(readTextFromClipboard).not.toHaveBeenCalled();
  });
});

describe("DataGrid multi-row paste from a blank cell", () => {
  it("shows cancellable progress for a large paste and leaves the blank row unchanged", async () => {
    const { host } = mountGrid();
    await settle();
    await addBlankRow(host);
    await selectCell(visibleCells(pendingRows(host)[0]!)[0]!);
    await paste(host, Array.from({ length: 5000 }, (_, index) => `${index + 2}\tExcel`).join("\n"));

    const progress = document.querySelector<HTMLElement>("[data-grid-row-preparation] [role='progressbar']");
    expect(progress).not.toBeNull();
    await vi.waitFor(() => expect(Number(progress!.getAttribute("aria-valuenow"))).toBeGreaterThan(0), { interval: 1 });
    document.querySelector<HTMLButtonElement>("[data-grid-row-preparation] button")!.click();
    await vi.waitFor(() => expect(document.querySelector("[data-grid-row-preparation]")).toBeNull(), { interval: 1 });
    expect(pendingRows(host)).toHaveLength(1);
    expect(visibleCellTexts(pendingRows(host)[0]!)).toEqual(["NULL", "NULL", "NULL", "NULL"]);
  });

  it("drops a large paste when its result is replaced during preparation", async () => {
    const { host, resultRef } = mountGrid();
    await settle();
    await addBlankRow(host);
    await selectCell(visibleCells(pendingRows(host)[0]!)[0]!);
    await paste(host, Array.from({ length: 5000 }, (_, index) => `${index + 2}\tExcel`).join("\n"));
    expect(document.querySelector("[data-grid-row-preparation]")).not.toBeNull();
    resultRef.value = markRaw({ ...defaultResult(), rows: [[99, null, "replacement", "result"]] });
    await vi.waitFor(() => expect(document.querySelector("[data-grid-row-preparation]")).toBeNull(), { interval: 1 });
    expect(pendingRows(host)).toHaveLength(0);
    expect(visibleCellTexts(displayRows(host)[0]!)[0]).toBe("99");
  });

  it("expands one blank new row to hold all 50 Excel rows and saves every row", async () => {
    const save = vi.fn<CustomSaveHandler["save"]>().mockResolvedValue();
    const { host } = mountGrid({ customSaveHandler: { canInsert: true, save } });
    await settle();
    await addBlankRow(host);
    await selectCell(visibleCells(pendingRows(host)[0]!)[0]!);
    await paste(host, Array.from({ length: 50 }, (_, index) => `${index + 2}\tExcel ${index + 1}`).join("\r\n"));

    expect(pendingRows(host)).toHaveLength(50);
    expect(visibleCellTexts(pendingRows(host).at(-1)!).slice(0, 2)).toEqual(["51", "Excel 50"]);
    host.querySelector<HTMLElement>("[data-toolbar-action='save']")!.click();
    await settle();
    expect(save.mock.calls[0]![0].newRows).toHaveLength(50);
    expect(save.mock.calls[0]![0].newRows.at(-1)).toEqual([51, "Excel 50", null, null]);
    expect(save.mock.calls[0]![0].dirtyRows.size).toBe(0);
  });

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

  it("expands a multi-cell range on a blank new row without losing clipboard rows", async () => {
    const { host } = mountGrid();
    await settle();
    await addBlankRow(host);

    const [row] = pendingRows(host);
    const cells = visibleCells(row!);
    await selectCell(cells[1]!);
    await selectCell(cells[2]!, { shiftKey: true });
    await paste(host, "a\tb\nc\td");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(2);
    expect(visibleCellTexts(rows[0]!).slice(1, 3)).toEqual(["a", "b"]);
    expect(visibleCellTexts(rows[1]!).slice(1, 3)).toEqual(["c", "d"]);
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
});

describe("DataGrid INSERT statement paste into blank new rows", () => {
  it("fills a blank new row from a pasted INSERT statement aligned by column names", async () => {
    const { host } = mountGrid();
    await settle();
    await addBlankRow(host);

    const blankRows = pendingRows(host);
    expect(blankRows).toHaveLength(1);
    // Row-number selection marks the blank new row as the append target, so
    // the INSERT values are aligned by column names instead of positions.
    await selectRowNumber(blankRows[0]!);
    // Column names in a scrambled order: c0 is the first visible column but
    // receives 42 through name alignment, not position.
    await paste(host, "INSERT INTO paste_target (c2, c0, hidden) VALUES ('from-insert', 42, 'h-val')");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(1);
    const cells = visibleCellTexts(rows[0]!);
    expect(cells[0]).toBe("42");
    expect(cells[1]).toBe("h-val");
    expect(cells[2]).toBe("from-insert");
  });

  it("appends one row per statement when pasting multiple INSERT statements", async () => {
    const { host } = mountGrid();
    await settle();
    await addBlankRow(host);

    const blankRows = pendingRows(host);
    await selectCell(visibleCells(blankRows[0]!)[0]!);
    await paste(host, "INSERT INTO paste_target (c0, c2) VALUES (1, 'a');\nINSERT INTO paste_target (c0, c2) VALUES (2, 'b');");

    const rows = pendingRows(host);
    expect(rows).toHaveLength(2);
    expect(visibleCellTexts(rows[0]!)[0]).toBe("1");
    expect(visibleCellTexts(rows[0]!)[2]).toBe("a");
    expect(visibleCellTexts(rows[1]!)[0]).toBe("2");
    expect(visibleCellTexts(rows[1]!)[2]).toBe("b");
  });
});
