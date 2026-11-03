// @vitest-environment happy-dom
import { createApp, defineComponent, h, markRaw, nextTick, reactive, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { useDataGridEditor } from "@/composables/useDataGridEditor";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), execute: vi.fn(), toast: vi.fn() }));
let editor: ReturnType<typeof useDataGridEditor>;
vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  prepareDataGridSave: mocks.prepare,
  executeBatch: mocks.execute,
  saveEditorSettings: vi.fn().mockResolvedValue(undefined),
  getTablePartitionStatus: vi.fn().mockResolvedValue(null),
  listObjectStatistics: vi.fn().mockResolvedValue([]),
  getTableComment: vi.fn().mockResolvedValue(null),
  executeQuery: vi.fn().mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 }),
}));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/stores/historyStore", () => ({ useHistoryStore: () => ({ add: vi.fn() }) }));
vi.mock("@/composables/useDataGridEditor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridEditor")>();
  return {
    ...actual,
    useDataGridEditor: (...args: Parameters<typeof actual.useDataGridEditor>) => {
      editor = actual.useDataGridEditor(...args);
      return editor;
    },
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
      renderedColumnWidths: ref([120]),
      totalWidth: ref(120),
      columnVars: ref({ "--total-w": "120px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const mounted: Array<{ app: App; host: HTMLElement }> = [];
async function settle() {
  for (let i = 0; i < 8; i++) {
    await nextTick();
    await Promise.resolve();
  }
}
function mountGrid(editable = true) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().updateEditorSettings({ dataGridRenderMode: "canvas", infiniteScroll: false });
  const result = (rows: QueryResult["rows"]): QueryResult => markRaw({ columns: ["LABEL", "__DBX_PK_0"], rows, affected_rows: 0, execution_time_ms: 1 });
  const state = reactive({ result: result([["same", "ROW-22"]]) });
  const reload = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup: () => () =>
        h(
          TooltipProvider,
          { delayDuration: 0 },
          {
            default: () =>
              h(DataGrid, {
                ...state,
                editable,
                context: "table-data",
                databaseType: "oceanbase-oracle",
                connectionId: "connection-1",
                database: "app",
                tableMeta: { tableName: "NOPK", primaryKeys: ["__DBX_ROWID"], columns: [] },
                sourceColumns: ["LABEL", "__DBX_ROWID"],
                sql: "SELECT LABEL FROM NOPK",
                onReload: reload,
              }),
          },
        ),
    }),
  );
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mounted.push({ app, host });
  // Stage a deletion in the real editor, then use the rendered grid toolbar.
  editor.deletedRows.value.add(0);
  return {
    reload,
    replaceResult: () => {
      state.result = result([]);
    },
    async commit() {
      await settle();
      const button = host.querySelector<HTMLButtonElement>('button[data-toolbar-action="save"]');
      expect(button, "Save toolbar button missing").not.toBeNull();
      expect(button!.disabled).toBe(false);
      button!.click();
      await vi.waitFor(() => {
        expect(mocks.execute).toHaveBeenCalledTimes(1);
        expect(editor.isSaving.value).toBe(false);
      });
      await settle();
    },
  };
}
afterEach(async () => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount();
    host.remove();
  }
  await settle();
  vi.unstubAllGlobals();
});
describe("DataGrid ROWID save feedback across reload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request in grid test")));
    mocks.prepare.mockResolvedValue({ statements: ["DELETE FROM NOPK WHERE ROWIDTOCHAR(ROWID)='ROW-22';"], rollbackStatements: [] });
  });
  it("does not prepare or execute staged ROWID changes when query metadata made the grid read-only", async () => {
    mountGrid(false);
    await settle();
    await editor.saveChanges();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(editor.deletedRows.value).toEqual(new Set([0]));
  });
  it("notifies once through the rendered toolbar and preserves feedback after result replacement", async () => {
    mocks.execute.mockResolvedValue({ affected_rows: 0 });
    const grid = mountGrid();
    await grid.commit();
    expect(grid.reload).toHaveBeenCalledTimes(1);
    expect(editor.deletedRows.value.size).toBe(0);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    const message = mocks.toast.mock.calls[0][0];
    expect(message).toMatch(/0\D+1/);
    expect(message).toMatch(/another session|其他会话|其他工作階段/);
    expect(mocks.toast).toHaveBeenCalledWith(message, 5000);
    grid.replaceResult();
    await settle();
    expect(editor.saveError.value).toBe("");
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });
  it("does not notify a normal one-row deletion", async () => {
    mocks.execute.mockResolvedValue({ affected_rows: 1 });
    const grid = mountGrid();
    await grid.commit();
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it("retains the draft and does not emit a conflict notification on execution failure", async () => {
    mocks.execute.mockRejectedValue(new Error("connection failed"));
    const grid = mountGrid();
    await grid.commit();
    expect(editor.saveError.value).toContain("connection failed");
    expect(editor.deletedRows.value).toEqual(new Set([0]));
    expect(grid.reload).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it("retains the edited value when a plain ROWID update matches zero rows", async () => {
    mocks.prepare.mockResolvedValue({ statements: ["UPDATE NOPK SET LABEL='edited' WHERE ROWIDTOCHAR(ROWID)='ROW-22';"], rollbackStatements: [], keylessGuards: [] });
    mocks.execute.mockResolvedValue({ affected_rows: 0 });
    const grid = mountGrid();
    editor.deletedRows.value.clear();
    editor.dirtyRows.value = new Map([[0, new Map([[0, "edited"]])]]);
    await grid.commit();
    expect(editor.saveError.value).toMatch(/no longer matches|不再匹配|不再符合/);
    expect(editor.dirtyRows.value.get(0)?.get(0)).toBe("edited");
    expect(grid.reload).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
