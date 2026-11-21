// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, ref, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { ColumnInfo, QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

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

interface MountOptions {
  renderMode?: "dom" | "canvas";
  editable?: boolean;
  allowInsertRows?: boolean;
  quickEntry?: boolean;
  rowCount?: number;
}

function mountGrid(options: MountOptions = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    dataGridRenderMode: "canvas",
    dataGridMultiRowTranspose: false,
    dataGridHideNullColumns: false,
    dataGridStripedRows: true,
    dataGridQuickEntry: options.quickEntry ?? false,
  });

  const rows = Array.from({ length: options.rowCount ?? 2 }, (_, index) => [index + 1, `name-${index}`]);
  const result = markRaw<QueryResult>({
    columns: ["id", "name"],
    rows,
    affected_rows: 0,
    execution_time_ms: 0,
  });
  const columns: ColumnInfo[] = [
    { name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
    { name: "name", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
  ];

  const host = document.createElement("div");
  document.body.append(host);
  const grid = ref<{
    selectSingleCell: (row: number, col: number) => void;
    editSelectedCell: () => boolean;
    isSaving: boolean;
  }>();
  const Root = defineComponent({
    setup() {
      return () =>
        h(
          TooltipProvider,
          { delayDuration: 0 },
          {
            default: () =>
              h(DataGrid, {
                ref: grid,
                result,
                databaseType: "mysql",
                context: "table-data",
                editable: options.editable ?? true,
                allowInsertRows: options.allowInsertRows,
                connectionId: "connection-1",
                database: "app",
                tableMeta: { tableName: "users", columns, primaryKeys: ["id"] },
              }),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  if ((options.renderMode ?? "dom") === "dom") settingsStore.updateEditorSettings({ dataGridRenderMode: "dom" });
  const mounted = { app, host, grid };
  mountedApps.push({ app, host });
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

function dispatchKey(target: HTMLElement, key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...modifiers });
  target.dispatchEvent(event);
  return event;
}

function displayRows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>(".data-grid-row")];
}

function cellsOf(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>(".data-grid-cell")];
}

async function selectCellAt(host: HTMLElement, rowIndex: number, visibleColIndex: number) {
  const cell = cellsOf(displayRows(host)[rowIndex]!)[visibleColIndex];
  if (!cell) throw new Error(`Cell not found: row ${rowIndex} col ${visibleColIndex}`);
  cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  await settle();
}

async function addRowWithArrowDown(host: HTMLElement, rowCount: number) {
  await selectCellAt(host, rowCount - 1, 0);
  dispatchKey(gridRoot(host), "ArrowDown");
  await settle();
}

/** 新增行会立即打开编辑器；用户先收尾（Esc 只取消输入）才能继续操作网格。 */
async function closeOpenEditor(host: HTMLElement) {
  const editor = host.querySelector<HTMLElement>(".cell-edit-input");
  if (!editor) return;
  editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
  await settle();
}

async function typeIntoOpenEditor(host: HTMLElement, value: string) {
  const input = host.querySelector<HTMLInputElement>(".cell-edit-input");
  if (!input) throw new Error("Cell editor is not open");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
  await settle();
}

function selectedRowIndex(host: HTMLElement): number | undefined {
  const row = displayRows(host).find((candidate) => candidate.querySelector(".cell-selected, .cell-selected-dirty, .cell-selected--single") !== null);
  return row ? Number(row.dataset.rowIndex) : undefined;
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid arrow-down insert row", () => {
  it("adds a pending row when ArrowDown is pressed on the last displayed row", async () => {
    const { host } = mountGrid({ rowCount: 2 });
    await settle();
    expect(displayRows(host)).toHaveLength(2);

    await addRowWithArrowDown(host, 2);

    const rows = displayRows(host);
    expect(rows).toHaveLength(3);
    const newRow = rows[2]!;
    // 追加在显示末尾，且被标注为待插入行
    expect(newRow.classList.contains("data-grid-row--new")).toBe(true);
    // 整行底色来自新增行色源（DOM 与 Canvas 共用同一 CSS 变量）
    expect(newRow.getAttribute("style")).toContain("--data-grid-row-new-bg");
    // 未填写的新行沿用 "*" 占位
    expect(newRow.querySelector(".data-grid-row-number")?.textContent?.trim()).toBe("*");
    // 与「新增行」按钮一致：新增后立即进入首列编辑
    expect(host.querySelector(".cell-edit-input")).not.toBeNull();
  });

  it("keeps the normal down-move away from the last row", async () => {
    const { host } = mountGrid({ rowCount: 3 });
    await settle();
    await selectCellAt(host, 0, 0);
    expect(selectedRowIndex(host)).toBe(0);

    const event = dispatchKey(gridRoot(host), "ArrowDown");
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(selectedRowIndex(host)).toBe(1);
    expect(displayRows(host)).toHaveLength(3);
  });

  it("does not add a row when Shift extends the selection on the last row", async () => {
    const { host } = mountGrid({ rowCount: 2 });
    await settle();
    await selectCellAt(host, 1, 0);

    dispatchKey(gridRoot(host), "ArrowDown", { shiftKey: true });
    await settle();

    expect(displayRows(host)).toHaveLength(2);
    expect(host.querySelector(".cell-edit-input")).toBeNull();
  });

  it("does not add a row when the grid is read-only", async () => {
    const { host } = mountGrid({ rowCount: 2, editable: false });
    await settle();
    await selectCellAt(host, 1, 0);

    dispatchKey(gridRoot(host), "ArrowDown");
    await settle();

    expect(displayRows(host)).toHaveLength(2);
    expect(host.querySelector(".cell-edit-input")).toBeNull();
  });

  it("does not add a row when the save target rejects inserts", async () => {
    const { host } = mountGrid({ rowCount: 2, allowInsertRows: false });
    await settle();
    await selectCellAt(host, 1, 0);

    dispatchKey(gridRoot(host), "ArrowDown");
    await settle();

    expect(displayRows(host)).toHaveLength(2);
  });

  it("does not add a second row when the down arrow is pressed again right after adding", async () => {
    const { host } = mountGrid({ rowCount: 2 });
    await settle();
    await addRowWithArrowDown(host, 2);
    expect(displayRows(host)).toHaveLength(3);

    // 新增后编辑器已开在新行上：此时的下键属于编辑器，不得再追加一行
    const event = dispatchKey(gridRoot(host), "ArrowDown");
    await settle();

    expect(displayRows(host)).toHaveLength(3);
    expect(event.defaultPrevented).toBe(false);
  });

  // 行为级回归守卫（不是分支证明）：快速录入开启时末尾是草稿行，此时下键不得凭空多出第二个空行。
  // 草稿行本身不进 selectedCellCount，所以真正拦住它的是「单格选中」条件；这条用例锁定的是最终行为。
  it("does not add a row while quick entry leaves a draft row at the end", async () => {
    const { host } = mountGrid({ rowCount: 2, quickEntry: true });
    await settle();
    const rowsBefore = displayRows(host);
    // 2 条已落库行 + 末尾那行快速录入草稿行
    expect(rowsBefore.length).toBe(3);
    await selectCellAt(host, rowsBefore.length - 1, 0);

    dispatchKey(gridRoot(host), "ArrowDown");
    await settle();

    expect(displayRows(host)).toHaveLength(rowsBefore.length);
  });

  it("adds a row in canvas render mode too", async () => {
    const { host, grid } = mountGrid({ rowCount: 2, renderMode: "canvas" });
    await settle();
    const root = gridRoot(host);
    // Canvas 模式没有行元素，用「新增行立即进入编辑」这条与按钮一致的信号判定
    expect(displayRows(host)).toHaveLength(0);
    grid.value!.selectSingleCell(1, 0);
    await settle();

    const event = dispatchKey(root, "ArrowDown");
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(host.querySelector(".canvas-grid-overlay .cell-edit-input")).not.toBeNull();
  });
});

describe("DataGrid escape pending row and cell revert", () => {
  it("removes the untouched new row under the cursor and keeps it undoable", async () => {
    const { host } = mountGrid({ rowCount: 2 });
    await settle();
    await addRowWithArrowDown(host, 2);
    await closeOpenEditor(host);
    expect(displayRows(host)).toHaveLength(3);

    await selectCellAt(host, 2, 0);
    const escape = dispatchKey(gridRoot(host), "Escape");
    await settle();

    expect(escape.defaultPrevented).toBe(true);
    expect(displayRows(host)).toHaveLength(2);

    dispatchKey(gridRoot(host), "z", { ctrlKey: true });
    await settle();
    expect(displayRows(host)).toHaveLength(3);
  });

  it("clears the cell instead of removing a new row that already has a value", async () => {
    const { host } = mountGrid({ rowCount: 2 });
    await settle();
    await addRowWithArrowDown(host, 2);
    // 新增后编辑器开在新行上：填一个值再提交，该行就不再是「未触碰」
    await typeIntoOpenEditor(host, "typed");
    await selectCellAt(host, 2, 0);

    const escape = dispatchKey(gridRoot(host), "Escape");
    await settle();

    expect(escape.defaultPrevented).toBe(true);
    expect(displayRows(host)).toHaveLength(3);
    expect(cellsOf(displayRows(host)[2]!)[0]!.classList.contains("cell-dirty")).toBe(false);
    expect(displayRows(host)[2]!.textContent).not.toContain("typed");
  });

  it("keeps the pending row when Escape only cancels the inline editor", async () => {
    const { host } = mountGrid({ rowCount: 2 });
    await settle();
    await addRowWithArrowDown(host, 2);
    const editor = host.querySelector<HTMLElement>(".cell-edit-input");
    expect(editor).not.toBeNull();

    editor!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
    await settle();

    // 两段式：编辑器内的 Esc 只取消输入，新增行留在网格里（网格焦点下的第二次 Esc 才撤掉它）
    expect(host.querySelector(".cell-edit-input")).toBeNull();
    expect(displayRows(host)).toHaveLength(3);

    await selectCellAt(host, 2, 0);
    dispatchKey(gridRoot(host), "Escape");
    await settle();
    expect(displayRows(host)).toHaveLength(2);
  });

  it("restores a dirty existing cell to its original value", async () => {
    const { host } = mountGrid({ rowCount: 2 });
    await settle();
    await selectCellAt(host, 0, 1);
    dispatchKey(gridRoot(host), "Enter");
    await settle();
    await typeIntoOpenEditor(host, "renamed");
    await selectCellAt(host, 0, 1);
    expect(cellsOf(displayRows(host)[0]!)[1]!.classList.contains("cell-dirty")).toBe(true);

    const escape = dispatchKey(gridRoot(host), "Escape");
    await settle();

    expect(escape.defaultPrevented).toBe(true);
    expect(cellsOf(displayRows(host)[0]!)[1]!.classList.contains("cell-dirty")).toBe(false);
    expect(displayRows(host)[0]!.textContent).toContain("name-0");
    expect(displayRows(host)[0]!.textContent).not.toContain("renamed");
  });

  it("does not revert while a save is in flight, and reverts once it finishes", async () => {
    const { host, grid } = mountGrid({ rowCount: 2 });
    await settle();
    await selectCellAt(host, 0, 1);
    dispatchKey(gridRoot(host), "Enter");
    await settle();
    await typeIntoOpenEditor(host, "renamed");
    await selectCellAt(host, 0, 1);
    const editedCell = () => cellsOf(displayRows(host)[0]!)[1]!;
    expect(editedCell().classList.contains("cell-dirty")).toBe(true);

    // 保存进行中：这一轮保存已经捕获了当前值，此刻回退会与数据库写入结果脱节
    grid.value!.isSaving = true;
    const whileSaving = dispatchKey(gridRoot(host), "Escape");
    await settle();
    expect(whileSaving.defaultPrevented).toBe(false);
    expect(editedCell().classList.contains("cell-dirty")).toBe(true);
    expect(displayRows(host)[0]!.textContent).toContain("renamed");

    // 正向对照：保存结束后同一个键位恢复回退能力（证明拦住它的是 isSaving 门槛本身）
    grid.value!.isSaving = false;
    const afterSaving = dispatchKey(gridRoot(host), "Escape");
    await settle();
    expect(afterSaving.defaultPrevented).toBe(true);
    expect(editedCell().classList.contains("cell-dirty")).toBe(false);
    expect(displayRows(host)[0]!.textContent).toContain("name-0");
  });

  it("does not consume Escape when there is nothing to revert", async () => {
    const { host } = mountGrid({ rowCount: 2 });
    await settle();
    await selectCellAt(host, 0, 1);

    const escape = dispatchKey(gridRoot(host), "Escape");
    await settle();

    expect(escape.defaultPrevented).toBe(false);
    expect(displayRows(host)).toHaveLength(2);
    expect(displayRows(host)[0]!.textContent).toContain("name-0");
  });

  it("does not revert a multi-cell selection", async () => {
    const { host } = mountGrid({ rowCount: 2 });
    await settle();
    await selectCellAt(host, 0, 0);
    await selectCellAt(host, 0, 1);
    // 拖选出跨格范围：第一次选择作为锚点，第二次带 shiftKey 扩展
    const rangeCell = cellsOf(displayRows(host)[1]!)[1]!;
    rangeCell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    await settle();

    const escape = dispatchKey(gridRoot(host), "Escape");
    await settle();

    expect(escape.defaultPrevented).toBe(false);
  });
});
