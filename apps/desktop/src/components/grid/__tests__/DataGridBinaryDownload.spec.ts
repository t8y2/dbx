// @vitest-environment happy-dom

import { createApp, defineComponent, h, nextTick, ref, type App, type ComponentPublicInstance } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { QueryResult } from "@/types/database";
import type { DataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";

const mocks = vi.hoisted(() => ({ hydrate: vi.fn(), save: vi.fn() }));

vi.mock("@/composables/useDataGridLargeValues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridLargeValues")>();
  return {
    ...actual,
    useDataGridLargeValues: (options: Parameters<typeof actual.useDataGridLargeValues>[0]) => ({ ...actual.useDataGridLargeValues(options), hydrateLargeValueCell: mocks.hydrate }),
  };
});

vi.mock("@/lib/dataGrid/binaryCellDownload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dataGrid/binaryCellDownload")>()),
  downloadBinaryCellPayload: mocks.save,
}));

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

const mounted: Array<{ app: App; host: HTMLElement }> = [];

afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.resetAllMocks();
});

async function mountGrid() {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().updateEditorSettings({ dataGridRenderMode: "canvas" });
  const result = ref<QueryResult>({
    columns: ["ID", "CONTENT"],
    column_types: ["int4", "bytea"],
    rows: [
      [3, "0xff"],
      [2, "\\x01..."],
      [1, "0xfe"],
    ],
    affected_rows: 0,
    execution_time_ms: 1,
    large_value_cells: [{ row_index: 1, column_index: 1, original_bytes: 4 }],
  });
  const grid = ref<ComponentPublicInstance>();
  const app = createApp(
    defineComponent({
      setup: () => () => h(TooltipProvider, {}, { default: () => h(DataGrid, { ref: grid, result: result.value, databaseType: "postgres", context: "table-data" }) }),
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  await nextTick();
  // Exercise the actual component handlers with its reactive display-row mapping.
  const state = (
    grid.value!.$ as unknown as {
      setupState: {
        cellDetailFor: (row: number, column: number) => DataGridCellDetail;
        downloadDetailBinaryValue: (detail: DataGridCellDetail, mode: "binary") => Promise<void>;
        localColumnFilters: Record<number, Set<string>>;
      };
    }
  ).setupState;
  let finish!: (success: boolean) => void;
  mocks.hydrate.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  mocks.save.mockResolvedValue({ kind: "cancelled" });
  return { result, state, finish: (success = true) => finish(success) };
}

describe("DataGrid binary download identity", () => {
  it("downloads the selected record when local filtering changes the display position during hydration", async () => {
    const { result, state, finish } = await mountGrid();
    const detail = state.cellDetailFor(1, 1);
    const pending = state.downloadDetailBinaryValue(detail, "binary");
    state.localColumnFilters = { 0: new Set(["num:2", "num:1"]) };
    await nextTick();
    expect(state.cellDetailFor(1, 1).rowId).not.toBe(detail.rowId);
    result.value.rows[1]![1] = "\\x01020304";
    result.value.large_value_cells = [];
    finish();
    await pending;
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(mocks.save.mock.calls[0]![0].data).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("does not download from a replacement result that reuses the same row index", async () => {
    const { result, state, finish } = await mountGrid();
    const pending = state.downloadDetailBinaryValue(state.cellDetailFor(1, 1), "binary");
    result.value = {
      ...result.value,
      rows: [
        [9, "0xff"],
        [8, "0xfe"],
      ],
      large_value_cells: [],
    };
    await nextTick();
    finish();
    await pending;
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not substitute another record when the selected row is filtered out", async () => {
    const { result, state, finish } = await mountGrid();
    const pending = state.downloadDetailBinaryValue(state.cellDetailFor(1, 1), "binary");
    state.localColumnFilters = { 0: new Set(["num:3", "num:1"]) };
    result.value.rows[1]![1] = "\\x01020304";
    result.value.large_value_cells = [];
    await nextTick();
    finish();
    await pending;
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not download a preview after hydration fails", async () => {
    const { state, finish } = await mountGrid();
    const pending = state.downloadDetailBinaryValue(state.cellDetailFor(1, 1), "binary");
    finish(false);
    await pending;
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
