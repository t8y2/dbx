// @vitest-environment happy-dom
import { createApp, defineComponent, h, markRaw, nextTick, ref, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { DatabaseType, QueryResult } from "@/types/database";
import { extractDataGridSelection } from "@/lib/backend/api";

vi.mock("@/lib/backend/api", async (original) => ({
  ...(await original<typeof import("@/lib/backend/api")>()),
  extractDataGridSelection: vi.fn(async () => ({ text: "copied selection", mimeType: "text/plain", fileExtension: "txt", rowCount: 1, columnCount: 1 })),
}));

vi.mock("@/lib/common/clipboard", async (original) => ({
  ...(await original<typeof import("@/lib/common/clipboard")>()),
  copyToClipboard: vi.fn(async () => true),
}));
vi.mock("@/composables/useDataGridColumnResize", async (original) => ({
  ...(await original<typeof import("@/composables/useDataGridColumnResize")>()),
  useDataGridColumnResize: () => ({
    initColumnWidths: vi.fn(),
    onResizeStart: vi.fn(),
    autoFitColumn: vi.fn(),
    renderedColumnWidths: ref([120, 120]),
    totalWidth: ref(240),
    columnVars: ref({ "--total-w": "240px" }),
    getIsResizing: () => false,
  }),
}));
import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllMocks();
});
async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}
async function mountGrid(databaseType: DatabaseType = "mysql", options: { rows?: unknown[][]; hidden?: number[] } = {}) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().updateEditorSettings({ dataGridRenderMode: "canvas" });
  const result = markRaw<QueryResult>({
    columns: ["id", "name"],
    rows: options.rows ?? [
      [1, "Alice"],
      [2, "Bob"],
    ],
    affected_rows: 0,
    execution_time_ms: 1,
    hidden_column_indexes: options.hidden,
  });
  const grid = ref<{ focusGrid(): boolean; selectSingleCell(row: number, column: number): void; selectRow(row: number): void; setDefaultCopyPreference(value: string): void }>();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp({ render: () => h(TooltipProvider, {}, { default: () => h(DataGrid, { ref: grid, result, databaseType, context: "results" }) }) });
  app.use(pinia);
  app.use(i18n);
  app.component(
    "RecycleScroller",
    defineComponent({
      props: { items: Array as PropType<unknown[]> },
      setup:
        (props, { attrs, slots }) =>
        () =>
          h(
            "div",
            attrs,
            props.items?.map((item) => slots.default?.({ item })),
          ),
    }),
  );
  app.mount(host);
  cleanups.push(() => {
    app.unmount();
    host.remove();
  });
  await settle();
  const root = host.querySelector<HTMLElement>("[data-grid-root]")!;
  const key = async (key: string, modifiers: KeyboardEventInit = {}) => {
    root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }));
    await settle();
  };
  const copy = async () => {
    vi.mocked(copyToClipboard).mockClear();
    vi.mocked(extractDataGridSelection).mockClear();
    await key("c", { ctrlKey: true });
    await vi.waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
    expect(copyToClipboard).toHaveBeenCalledWith("copied selection");
    const calls = vi.mocked(extractDataGridSelection).mock.calls;
    const request = calls[calls.length - 1]![0];
    return request.rows.map((row) => request.selectedColumnIndexes.map((index) => row[index]));
  };
  return { grid, root, key, copy };
}

describe("DataGrid keyboard focus", () => {
  it.each(["mysql", "postgres", "sqlite", "sqlserver"] as const)("focuses and selects the first cell for %s, ready for navigation and copying", async (type) => {
    const { grid, root, key, copy } = await mountGrid(type);
    expect(grid.value!.focusGrid()).toBe(true);
    await settle();
    expect(document.activeElement).toBe(root);
    expect(await copy()).toEqual([[1]]);
    await key("ArrowRight");
    expect(await copy()).toEqual([["Alice"]]);
    await key("a", { ctrlKey: true });
    expect(await copy()).toEqual([
      [1, "Alice"],
      [2, "Bob"],
    ]);
  });
  it("retains an existing cell selection when returning from the editor", async () => {
    const { grid, copy } = await mountGrid();
    grid.value!.selectSingleCell(1, 1);
    grid.value!.focusGrid();
    expect(await copy()).toEqual([["Bob"]]);
  });
  it("retains selected rows instead of replacing them with the first cell", async () => {
    const { grid, copy } = await mountGrid();
    grid.value!.selectRow(1);
    grid.value!.focusGrid();
    expect(await copy()).toEqual([[2, "Bob"]]);
  });
  it("focuses an empty tabular result without inventing a selected cell", async () => {
    const { grid, root, key } = await mountGrid("postgres", { rows: [] });
    expect(grid.value!.focusGrid()).toBe(true);
    expect(document.activeElement).toBe(root);
    await key("c", { ctrlKey: true });
    expect(copyToClipboard).not.toHaveBeenCalled();
  });
  it("uses the first visible column and refuses grids with no visible columns", async () => {
    const { grid, copy } = await mountGrid("mysql", { hidden: [0] });
    grid.value!.focusGrid();
    expect(await copy()).toEqual([["Alice"]]);
    const hidden = await mountGrid("mysql", { hidden: [0, 1] });
    expect(hidden.grid.value!.focusGrid()).toBe(false);
  });
  it("keeps the configured CSV-with-headers extractor for select-all and copy", async () => {
    const { grid, key, copy } = await mountGrid();
    grid.value!.setDefaultCopyPreference("csv-with-headers");
    grid.value!.focusGrid();
    await key("a", { ctrlKey: true });
    expect(await copy()).toEqual([
      [1, "Alice"],
      [2, "Bob"],
    ]);
    expect(vi.mocked(extractDataGridSelection).mock.calls[0]![0].extractor).toBe("csv-with-headers");
  });
});
