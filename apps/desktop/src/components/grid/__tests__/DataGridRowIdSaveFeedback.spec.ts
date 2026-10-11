// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridEditor } from "@/composables/useDataGridEditor";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), execute: vi.fn(), history: vi.fn() }));
vi.mock("@/lib/backend/api", () => ({ prepareDataGridSave: mocks.prepare, executeBatch: mocks.execute }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ getConfig: () => undefined }) }));
vi.mock("@/stores/historyStore", () => ({ useHistoryStore: () => ({ add: mocks.history }) }));
vi.mock("@/stores/productionSafetyStore", () => ({ useProductionSafetyStore: () => ({}) }));

// Execute the actual grid callback and toolbar handler with the real editor.
// Mount only this save boundary, avoiding unrelated canvas/virtualization setup.
const source = readFileSync(new NodeURL("../DataGrid.vue", import.meta.url), "utf8");
function saveBoundary(toast: ReturnType<typeof vi.fn>) {
  const callback = source.match(/onSaveConflict: (.+),\r?\n/);
  const onSaveConflict = callback ? new Function("toast", `return (${callback[1]});`)(toast) : undefined;
  const toolbar = source.match(/async function onToolbarCommit\(\) \{([\s\S]*?)\n\}/);
  expect(toolbar).not.toBeNull();
  let editor!: ReturnType<typeof useDataGridEditor>;
  const result = ref({ columns: ["LABEL", "__DBX_PK_0"], rows: [["same", "ROW-22"]] });
  const reload = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const app = createApp(
    defineComponent({
      setup() {
        editor = useDataGridEditor({
          result: computed(() => result.value),
          editable: computed(() => true),
          databaseType: computed(() => "oceanbase-oracle"),
          connectionId: computed(() => "connection-1"),
          database: computed(() => "app"),
          tableMeta: computed(() => ({ tableName: "NOPK", primaryKeys: ["__DBX_ROWID"], columns: [] })),
          sourceColumns: computed(() => ["LABEL", "__DBX_ROWID"]),
          onExecuteSql: computed(() => undefined),
          sql: computed(() => "SELECT LABEL FROM NOPK"),
          searchText: ref(""),
          whereFilterInput: ref(""),
          currentWhereInput: computed(() => undefined),
          orderByInput: ref(""),
          rowStatusFilter: ref("all"),
          confirmDangerousRowDeletion: computed(() => true),
          pageSize: ref(100),
          currentPage: ref(1),
          cacheKey: computed(() => undefined),
          getRowItem: () => undefined,
          emit: reload,
          onSaveConflict,
        });
        editor.deletedRows.value.add(0);
        const commit = new Function("saveChanges", `return async function() {${toolbar![1]}}`)(editor.saveChanges);
        return () => h("button", { onClick: commit }, "commit");
      },
    }),
  );
  app.mount(host);
  const wrapper = {
    async commit() {
      host.querySelector("button")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
    },
    unmount() {
      app.unmount();
      host.remove();
    },
  };
  return { wrapper, editor, result, reload };
}

describe("DataGrid ROWID save feedback across reload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepare.mockResolvedValue({ statements: ["DELETE FROM NOPK WHERE ROWIDTOCHAR(ROWID)='ROW-22';"], rollbackStatements: [] });
  });

  it("toasts the conflict through ToolbarCommit before an asynchronous empty-result replacement clears saveError", async () => {
    mocks.execute.mockResolvedValue({ affected_rows: 0 });
    const toast = vi.fn();
    const { wrapper, editor, result, reload } = saveBoundary(toast);
    await wrapper.commit();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(editor.deletedRows.value.size).toBe(0);
    expect(toast).toHaveBeenCalledTimes(1);
    const message = toast.mock.calls[0][0];
    expect(message).toMatch(/0\D+1/);
    expect(message).toMatch(/another session|其他会话|其他工作階段/);
    expect(toast).toHaveBeenCalledWith(message, 5000);
    // The real result watcher discards indexed pending state after replacement.
    result.value = { columns: ["LABEL", "__DBX_PK_0"], rows: [] };
    await nextTick();
    expect(editor.saveError.value).toBe("");
    expect(toast).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("does not toast a normal one-row deletion", async () => {
    mocks.execute.mockResolvedValue({ affected_rows: 1 });
    const toast = vi.fn();
    const { wrapper } = saveBoundary(toast);
    await wrapper.commit();
    expect(toast).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("does not duplicate a normal execution failure through the conflict notification", async () => {
    mocks.execute.mockRejectedValue(new Error("connection failed"));
    const toast = vi.fn();
    const { wrapper, editor, reload } = saveBoundary(toast);
    await wrapper.commit();
    expect(editor.saveError.value).toContain("connection failed");
    expect(editor.deletedRows.value).toEqual(new Set([0]));
    expect(reload).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
