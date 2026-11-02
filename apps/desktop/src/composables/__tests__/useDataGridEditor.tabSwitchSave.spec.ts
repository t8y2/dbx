// @vitest-environment happy-dom
import { createApp, computed, defineComponent, h, nextTick, ref, type Ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDataGridPendingSnapshotsForTab, pendingDataGridSaveCount, useDataGridEditor } from "@/composables/useDataGridEditor";
import type { CellValue } from "@/lib/dataGrid/cellValue";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  prepareDataGridSave: vi.fn(),
  executeBatch: vi.fn(),
  executeInTransaction: vi.fn(),
  executeInManualTransaction: vi.fn(),
  executeQuery: vi.fn(),
  addHistory: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  prepareDataGridSave: mocks.prepareDataGridSave,
  executeBatch: mocks.executeBatch,
  executeConditionalUpdate: vi.fn(),
  cancelConditionalUpdate: vi.fn(),
  executeInTransaction: mocks.executeInTransaction,
  executeInManualTransaction: mocks.executeInManualTransaction,
  executeQuery: mocks.executeQuery,
  unlockConnectionWrites: vi.fn(),
  lockConnectionWrites: vi.fn(),
  connectionWriteUnlockState: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({ getConfig: mocks.getConfig }),
}));
vi.mock("@/stores/historyStore", () => ({
  useHistoryStore: () => ({ add: mocks.addHistory }),
}));
vi.mock("@/stores/productionSafetyStore", () => ({
  useProductionSafetyStore: () => ({}),
}));

type Editor = ReturnType<typeof useDataGridEditor>;

const TABLE_META = {
  tableName: "orders",
  columns: [
    { name: "id", data_type: "int" },
    { name: "status", data_type: "varchar" },
  ],
  primaryKeys: ["id"],
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

interface GridFixture {
  editor: Editor;
  tabId: string;
  emit: ReturnType<typeof vi.fn>;
  refreshSavedRows: ReturnType<typeof vi.fn>;
  onAdoptedSaveCompleted: ReturnType<typeof vi.fn>;
}

/**
 * Mounts (through a real component, so the composable's lifecycle hooks run) a
 * grid editor for one query tab. The query tab unmounts the grid when the user
 * leaves it or switches to the summary view, and mounts a fresh one on return.
 */
function mountGrid(options: { tabId?: string; cacheKey?: string; withoutTabId?: boolean } = {}) {
  const tabId = options.tabId ?? "query-tab-1";
  const cacheKey = options.cacheKey ?? "query-tab-1-current-0";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const emit = vi.fn();
  const refreshSavedRows = vi.fn(async () => false);
  const onAdoptedSaveCompleted = vi.fn();
  const rows: CellValue[][] = Array.from({ length: 4 }, (_, index) => [index + 1, "pending"]);
  let editor!: Editor;

  const GridHost = defineComponent({
    setup() {
      const result = ref({ columns: ["id", "status"], rows });
      editor = useDataGridEditor({
        result: result as Ref<{ columns: string[]; rows: CellValue[][] }>,
        editable: ref(true),
        databaseType: ref("postgres"),
        connectionId: ref("connection-1"),
        database: ref("app"),
        // Not reactive in the template render: the save compares the table meta
        // it prepared against this one after every await.
        tableMeta: computed(() => TABLE_META),
        onExecuteSql: ref(undefined),
        sql: ref("select * from orders"),
        searchText: ref(""),
        whereFilterInput: ref(""),
        currentWhereInput: ref(undefined),
        orderByInput: ref(""),
        rowStatusFilter: ref("all"),
        pageSize: ref(100),
        currentPage: ref(1),
        cacheKey: ref(cacheKey),
        tabId: options.withoutTabId ? undefined : ref(tabId),
        resultViewGeneration: ref("generation-initial"),
        getRowItem: (rowId) => {
          const row = rows[rowId];
          if (rowId < 0 || !row) return undefined;
          const changes = editor?.dirtyRows.value.get(rowId);
          return { id: rowId, sourceIndex: rowId, data: row, isNew: false, isDeleted: false, isDirtyCol: row.map((_, index) => changes?.has(index) ?? false), status: changes?.size ? "edited" : "normal" };
        },
        refreshSavedRows,
        onAdoptedSaveCompleted,
        emit,
      });
      return () => h("div");
    },
  });

  const app = createApp(GridHost);
  app.mount(host);
  const fixture: GridFixture = { editor, tabId, emit, refreshSavedRows, onAdoptedSaveCompleted };
  return {
    ...fixture,
    // A remount replaces the editor; always hand out the mounted instance.
    get currentEditor() {
      return editor;
    },
    unmount() {
      app.unmount();
      host.remove();
    },
  };
}

function stageFourPendingUpdates(editor: Editor) {
  // Four edited rows, like the bulk paste in the report.
  editor.dirtyRows.value = new Map(Array.from({ length: 4 }, (_, rowId) => [rowId, new Map([[1, "saved"]])]));
  expect(editor.pendingChangeCount.value).toBe(4);
}

async function flush() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

describe("useDataGridEditor save across a grid unmount (#13226)", () => {
  beforeEach(() => {
    expect(pendingDataGridSaveCount(), "registry leaked from the previous test").toBe(0);
    mocks.getConfig.mockReset().mockReturnValue(undefined);
    mocks.prepareDataGridSave.mockReset();
    mocks.executeBatch.mockReset();
    mocks.executeInTransaction.mockReset();
    mocks.executeInTransaction.mockResolvedValue([]);
    mocks.addHistory.mockReset().mockResolvedValue(undefined);
  });

  it("adopts the running save after a remount: no stale badge, busy commit, then refresh and report", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders SET status = 'saved'"], rollbackStatements: [] });
    const execution = deferred<{ affected_rows: number }>();
    mocks.executeBatch.mockReturnValueOnce(execution.promise);

    const first = mountGrid();
    stageFourPendingUpdates(first.currentEditor);
    const saving = first.currentEditor.saveChanges();
    // The server write is now in flight (the grid shows the busy commit icon).
    await flush();
    expect(first.currentEditor.isSaving.value).toBe(true);
    expect(mocks.executeBatch).toHaveBeenCalledOnce();
    expect(first.emit).not.toHaveBeenCalled();

    // The user leaves the tab (or opens the summary view) while the server is
    // still writing, then comes back: a fresh grid for the same tab/result.
    first.unmount();
    await flush();
    const second = mountGrid();

    // Same visible state as never having left: the 4 saved changes are not
    // pending any more and the commit action stays busy until the save ends.
    expect(second.currentEditor.pendingChangeCount.value).toBe(0);
    expect(second.currentEditor.isSaving.value).toBe(true);
    expect(second.emit).not.toHaveBeenCalled();

    execution.resolve({ affected_rows: 4 });
    await saving;
    await flush();

    expect(second.currentEditor.isSaving.value).toBe(false);
    expect(second.currentEditor.hasPendingChanges.value).toBe(false);
    // The returning grid reloads the result and reports the completed save.
    const reload = second.emit.mock.calls.find(([event]) => event === "reload");
    expect(reload).toBeDefined();
    expect(reload?.[1]).toBe("select * from orders");
    expect(second.onAdoptedSaveCompleted).toHaveBeenCalledOnce();
    second.unmount();
  });

  it("refreshes the finished result when the grid returns after the save already settled", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders SET status = 'saved'"], rollbackStatements: [] });
    const execution = deferred<{ affected_rows: number }>();
    mocks.executeBatch.mockReturnValueOnce(execution.promise);

    const first = mountGrid();
    stageFourPendingUpdates(first.currentEditor);
    const saving = first.currentEditor.saveChanges();
    first.unmount();
    await flush();

    execution.resolve({ affected_rows: 4 });
    await saving;
    await flush();
    // Nobody was mounted when the save ended, so the reload is still owed.

    const second = mountGrid();
    await flush();
    expect(second.currentEditor.pendingChangeCount.value).toBe(0);
    expect(second.currentEditor.isSaving.value).toBe(false);
    const reload = second.emit.mock.calls.find(([event]) => event === "reload");
    expect(reload).toBeDefined();
    // The next mount never repeats the refresh.
    second.unmount();
    const third = mountGrid();
    await flush();
    expect(third.emit).not.toHaveBeenCalled();
    third.unmount();
  });

  it("keeps the pending changes when the adopted save fails", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders SET status = 'saved'"], rollbackStatements: [] });
    const execution = deferred<{ affected_rows: number }>();
    mocks.executeBatch.mockReturnValueOnce(execution.promise);

    const first = mountGrid();
    stageFourPendingUpdates(first.currentEditor);
    const saving = first.currentEditor.saveChanges();
    first.unmount();
    await flush();

    const second = mountGrid();
    execution.reject(new Error("deadlock found"));
    await saving;
    await flush();

    // The write did not happen: nothing was saved, nothing to reload, but the
    // changes must be back for a retry rather than lost.
    expect(second.currentEditor.isSaving.value).toBe(false);
    expect(second.currentEditor.pendingChangeCount.value).toBe(4);
    expect(second.emit).not.toHaveBeenCalled();
    expect(second.onAdoptedSaveCompleted).not.toHaveBeenCalled();

    // A further remount still sees the failed changes as pending.
    second.unmount();
    const third = mountGrid();
    await flush();
    expect(third.currentEditor.pendingChangeCount.value).toBe(4);
    third.unmount();
  });

  it("does not adopt a save that belongs to another tab", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders SET status = 'saved'"], rollbackStatements: [] });
    const execution = deferred<{ affected_rows: number }>();
    mocks.executeBatch.mockReturnValueOnce(execution.promise);

    const first = mountGrid();
    stageFourPendingUpdates(first.currentEditor);
    const saving = first.currentEditor.saveChanges();
    first.unmount();
    await flush();

    // A different query tab must not be blocked by another tab's save.
    const other = mountGrid({ tabId: "query-tab-2", cacheKey: "query-tab-2-current-0" });
    other.currentEditor.dirtyRows.value = new Map([[0, new Map([[1, "other tab"]])]]);
    expect(other.currentEditor.pendingChangeCount.value).toBe(1);
    expect(other.currentEditor.isSaving.value).toBe(false);
    expect(other.emit).not.toHaveBeenCalled();
    other.unmount();

    // The save settles with no grid mounted: its reload is owed to the grid that
    // returns to query-tab-1, which then consumes it.
    execution.resolve({ affected_rows: 4 });
    await saving;
    await flush();
    const back = mountGrid();
    await flush();
    expect(back.emit.mock.calls.some(([event]) => event === "reload")).toBe(true);
    back.unmount();
    expect(pendingDataGridSaveCount()).toBe(0);
  });

  it("adopts the save of a grid mounted without a tab id (cache-key fallback)", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders SET status = 'saved'"], rollbackStatements: [] });
    const execution = deferred<{ affected_rows: number }>();
    mocks.executeBatch.mockReturnValueOnce(execution.promise);

    const first = mountGrid({ withoutTabId: true });
    stageFourPendingUpdates(first.currentEditor);
    const saving = first.currentEditor.saveChanges();
    await flush();
    expect(first.currentEditor.isSaving.value).toBe(true);

    first.unmount();
    await flush();
    const second = mountGrid({ withoutTabId: true });

    // No tabId: the cache key identifies the grid, so it still adopts the save.
    expect(second.currentEditor.isSaving.value).toBe(true);
    execution.resolve({ affected_rows: 4 });
    await saving;
    await flush();

    expect(second.currentEditor.isSaving.value).toBe(false);
    expect(second.currentEditor.pendingChangeCount.value).toBe(0);
    expect(second.emit.mock.calls.some(([event]) => event === "reload")).toBe(true);
    expect(second.onAdoptedSaveCompleted).toHaveBeenCalledOnce();
    second.unmount();
    // The adopted record is consumed, so the registry does not leak.
    expect(pendingDataGridSaveCount()).toBe(0);
  });

  it("does not resurrect the saved rows when the save succeeds with no grid mounted", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders SET status = 'saved'"], rollbackStatements: [] });
    const execution = deferred<{ affected_rows: number }>();
    mocks.executeBatch.mockReturnValueOnce(execution.promise);

    const first = mountGrid();
    stageFourPendingUpdates(first.currentEditor);
    const saving = first.currentEditor.saveChanges();
    // Leaving persists the pending changes: this is the snapshot that used to
    // come back as the stale "498" badge.
    first.unmount();
    await flush();

    execution.resolve({ affected_rows: 4 });
    await saving;
    await flush();

    const second = mountGrid();
    await flush();
    expect(second.currentEditor.pendingChangeCount.value).toBe(0);
    expect(second.currentEditor.hasPendingChanges.value).toBe(false);
    expect(second.currentEditor.isSaving.value).toBe(false);
    // Never left a running save behind, and never reported a save it did not see.
    expect(second.onAdoptedSaveCompleted).not.toHaveBeenCalled();
    // The reload it owed was consumed by the grid that returned.
    expect(second.emit.mock.calls.some(([event]) => event === "reload")).toBe(true);
    second.unmount();
    expect(pendingDataGridSaveCount()).toBe(0);
  });

  it("keeps the pending changes retryable when the save fails with no grid mounted", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders SET status = 'saved'"], rollbackStatements: [] });
    const execution = deferred<{ affected_rows: number }>();
    mocks.executeBatch.mockReturnValueOnce(execution.promise);

    const first = mountGrid();
    stageFourPendingUpdates(first.currentEditor);
    const saving = first.currentEditor.saveChanges();
    first.unmount();
    await flush();

    execution.reject(new Error("deadlock found"));
    await saving;
    await flush();

    const second = mountGrid();
    await flush();
    expect(second.currentEditor.isSaving.value).toBe(false);
    expect(second.currentEditor.pendingChangeCount.value).toBe(4);
    expect(second.emit).not.toHaveBeenCalled();
    expect(second.onAdoptedSaveCompleted).not.toHaveBeenCalled();
    second.unmount();
    expect(pendingDataGridSaveCount()).toBe(0);
  });

  it("keeps both saves of a split view independent and does not drop the running one", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders SET status = 'saved'"], rollbackStatements: [] });
    const leftExecution = deferred<{ affected_rows: number }>();
    const rightExecution = deferred<{ affected_rows: number }>();
    mocks.executeBatch.mockReturnValueOnce(leftExecution.promise).mockReturnValueOnce(rightExecution.promise);

    // Split view: two grids of the same tab and result payload, both mounted.
    const left = mountGrid();
    const right = mountGrid();
    stageFourPendingUpdates(left.currentEditor);
    stageFourPendingUpdates(right.currentEditor);
    const leftSaving = left.currentEditor.saveChanges();
    await flush();
    const rightSaving = right.currentEditor.saveChanges();
    await flush();
    expect(mocks.executeBatch).toHaveBeenCalledTimes(2);
    expect(pendingDataGridSaveCount()).toBe(2);

    // The older save settles first: it must not delete the still-running one.
    leftExecution.resolve({ affected_rows: 4 });
    await leftSaving;
    await flush();
    expect(right.currentEditor.isSaving.value).toBe(true);
    expect(pendingDataGridSaveCount()).toBe(1);

    rightExecution.resolve({ affected_rows: 4 });
    await rightSaving;
    await flush();
    expect(right.currentEditor.isSaving.value).toBe(false);
    expect(pendingDataGridSaveCount()).toBe(0);
    // Each grid reported its own save; neither toasted as an adopter.
    expect(left.onAdoptedSaveCompleted).not.toHaveBeenCalled();
    expect(right.onAdoptedSaveCompleted).not.toHaveBeenCalled();
    left.unmount();
    right.unmount();
  });

  it("drops the pending saves of a closed tab", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders SET status = 'saved'"], rollbackStatements: [] });
    const execution = deferred<{ affected_rows: number }>();
    mocks.executeBatch.mockReturnValueOnce(execution.promise);

    const first = mountGrid();
    stageFourPendingUpdates(first.currentEditor);
    const saving = first.currentEditor.saveChanges();
    await flush();
    expect(pendingDataGridSaveCount()).toBe(1);

    first.unmount();
    await flush();
    clearDataGridPendingSnapshotsForTab("query-tab-1");
    expect(pendingDataGridSaveCount()).toBe(0);

    execution.resolve({ affected_rows: 4 });
    await saving;
    await flush();
    expect(pendingDataGridSaveCount()).toBe(0);
  });

  it("reports an adopted completion once, even across further remounts", async () => {
    mocks.prepareDataGridSave.mockResolvedValue({ statements: ["UPDATE orders SET status = 'saved'"], rollbackStatements: [] });
    const execution = deferred<{ affected_rows: number }>();
    mocks.executeBatch.mockReturnValueOnce(execution.promise);

    const first = mountGrid();
    stageFourPendingUpdates(first.currentEditor);
    const saving = first.currentEditor.saveChanges();
    first.unmount();
    await flush();

    const second = mountGrid();
    execution.resolve({ affected_rows: 4 });
    await saving;
    await flush();
    expect(second.onAdoptedSaveCompleted).toHaveBeenCalledOnce();

    second.unmount();
    const third = mountGrid();
    await flush();
    expect(third.onAdoptedSaveCompleted).not.toHaveBeenCalled();
    expect(third.currentEditor.isSaving.value).toBe(false);
    third.unmount();
    expect(pendingDataGridSaveCount()).toBe(0);
  });
});
