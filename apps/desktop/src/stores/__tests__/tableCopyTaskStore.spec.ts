// @vitest-environment happy-dom
import { createPinia, getActivePinia, setActivePinia } from "pinia";
import { createApp, h, nextTick, type App } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTableCopyTaskStore, type MysqlTableCopyEntry } from "@/stores/tableCopyTaskStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import TableCopyProgressDialog from "@/components/objects/TableCopyProgressDialog.vue";
import i18n from "@/i18n";
import { BackendErrorException } from "@/lib/backend/errorUtils";
import { useExportTracker } from "@/composables/useExportTracker";

const mocks = vi.hoisted(() => ({
  executeConditionalUpdate: vi.fn(),
  cancelConditionalUpdate: vi.fn(),
  getColumns: vi.fn(),
  buildDuplicateTableStructureSql: vi.fn(),
  buildCopyTableDataSql: vi.fn(),
  ensureConnected: vi.fn(),
  refreshObjectListTreeNode: vi.fn(),
  refreshDataTabsForTable: vi.fn(),
}));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => mocks }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => mocks }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const result = (rows = 0) => ({ columns: [], rows: [], affected_rows: rows, execution_time_ms: 1 });
const entry = () => ({ connection: { id: "local", name: "Local", db_type: "mysql" }, database: "demo", sourceName: "source", targetName: "copy" }) as MysqlTableCopyEntry;
const sqlFailure = (detail: string) => new BackendErrorException({ version: 1, code: "DBX-JDBC-4001", source: "jdbc-agent", messageKey: "backendErrors.sqlFailed", messageParams: {}, operationOutcome: "unknown", diagnostics: { category: "sql", stage: "execute" }, detail });
let mounted: App | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  const tracker = useExportTracker();
  for (const task of tracker.tasks.value) {
    task.canRemove = true;
    tracker.removeTask(task.exportId);
  }
  setActivePinia(createPinia());
  i18n.global.locale.value = "en";
  mocks.ensureConnected.mockResolvedValue(undefined);
  mocks.refreshObjectListTreeNode.mockResolvedValue(undefined);
  mocks.refreshDataTabsForTable.mockResolvedValue(1);
  mocks.buildDuplicateTableStructureSql.mockResolvedValue("CREATE TABLE `copy` LIKE `source`;");
  mocks.buildCopyTableDataSql.mockResolvedValue("INSERT INTO `copy` (`id`) SELECT `id` FROM `source`;");
  mocks.getColumns.mockResolvedValue([{ name: "id", data_type: "int", extra: "", is_nullable: false }]);
  mocks.executeConditionalUpdate.mockResolvedValue(result(7000001));
  mocks.cancelConditionalUpdate.mockResolvedValue({ requested: true, terminal: false, databaseTerminal: false });
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("MySQL table copy task", () => {
  it("keeps one running task and refreshes the captured target only after copy completion", async () => {
    const store = useTableCopyTaskStore();
    const data = deferred<ReturnType<typeof result>>();
    mocks.executeConditionalUpdate.mockImplementation(async (_id, _db, sql) => (sql.startsWith("INSERT") ? data.promise : result()));
    const original = entry();
    const pending = store.run([original], "structure-and-data");
    await vi.waitFor(() => expect(store.task?.phase).toBe("data"));
    original.targetName = "different";
    original.connection.id = "other-connection";
    expect(store.task?.targets[0]?.structureCreated).toBe(true);
    expect(store.busy).toBe(true);
    expect(store.open).toBe(false);
    const tracked = useExportTracker().tasks.value[0]!;
    expect(tracked.kind).toBe("table-copy");
    expect(tracked.copyPhase).toBe("data");
    expect(useExportTracker().activeCount.value).toBe(1);
    expect(await store.run([entry()], "structure-and-data")).toBe(false);
    expect(mocks.executeConditionalUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.refreshDataTabsForTable).not.toHaveBeenCalled();
    expect(mocks.executeConditionalUpdate.mock.calls[1]).toEqual(["local", "demo", expect.stringContaining("INSERT"), undefined, expect.any(String), { timeoutSecs: 0, catalog: undefined }]);
    expect(mocks.executeConditionalUpdate.mock.calls[0]?.[4]).not.toBe(mocks.executeConditionalUpdate.mock.calls[1]?.[4]);
    data.resolve(result(7000001));
    expect(await pending).toBe(true);
    expect(store.task?.status).toBe("succeeded");
    expect(store.task?.targets[0]?.copiedRows).toBe(7000001);
    expect(mocks.refreshDataTabsForTable).toHaveBeenCalledWith({ connectionId: "local", database: "demo", schema: undefined, catalog: undefined, name: "copy" });
    expect(store.busy).toBe(false);
    expect(tracked.status).toBe("Done");
    expect(tracked.affectedRows).toBe(7000001);
    expect(useExportTracker().activeCount.value).toBe(0);
  });

  it("keeps the confirmed outcome when cancellation is requested during refresh", async () => {
    const store = useTableCopyTaskStore();
    const refresh = deferred<number>();
    mocks.refreshDataTabsForTable.mockReturnValue(refresh.promise);
    const pending = store.run([entry()], "data-only");
    await vi.waitFor(() => expect(store.task?.phase).toBe("refreshing"));
    expect(store.busy).toBe(true);
    await store.cancel();
    expect(store.task?.status).toBe("succeeded");
    expect(mocks.cancelConditionalUpdate).not.toHaveBeenCalled();
    refresh.resolve(1);
    expect(await pending).toBe(true);
    expect(store.busy).toBe(false);
  });

  it("cancels pending metadata before SQL is dispatched", async () => {
    const store = useTableCopyTaskStore();
    const metadata = deferred<any[]>();
    mocks.getColumns.mockReturnValue(metadata.promise);
    const pending = store.run([entry()], "data-only");
    await vi.waitFor(() => expect(mocks.getColumns).toHaveBeenCalled());
    await store.cancel();
    metadata.resolve([{ name: "id", extra: "" }]);
    await pending;
    expect(store.task?.status).toBe("cancelled");
    expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
    expect(mocks.cancelConditionalUpdate).not.toHaveBeenCalled();
  });

  it("cancels only its production confirmation and never dispatches the reviewed SQL", async () => {
    const store = useTableCopyTaskStore();
    const source = entry();
    source.connection.is_production = true;
    const pending = store.run([source], "structure-only");
    const guard = useProductionSafetyStore();
    await vi.waitFor(() => expect(guard.pending?.scopeId).toBe(store.task?.id));
    await store.cancel();
    await pending;
    expect(guard.pending).toBeUndefined();
    expect(mocks.executeConditionalUpdate).not.toHaveBeenCalled();
    expect(store.task?.status).toBe("cancelled");
  });

  it("waits for the database response after requesting cancellation and retains the created structure", async () => {
    const store = useTableCopyTaskStore();
    const data = deferred<ReturnType<typeof result>>();
    mocks.executeConditionalUpdate.mockImplementation(async (_id, _db, sql) => (sql.startsWith("INSERT") ? data.promise : result()));
    const pending = store.run([entry(), { ...entry(), targetName: "second_copy" }], "structure-and-data");
    await vi.waitFor(() => expect(store.task?.phase).toBe("data"));
    const id = mocks.executeConditionalUpdate.mock.calls[1]![4];
    await store.cancel();
    expect(mocks.cancelConditionalUpdate).toHaveBeenCalledWith(id, undefined);
    expect(store.task?.status).toBe("cancelling");
    expect(store.busy).toBe(true);
    data.reject(sqlFailure("Server error: ERROR 1317 (70100): Query execution was interrupted"));
    await pending;
    expect(store.task?.status).toBe("cancelled");
    expect(store.task?.targets.map((target) => target.status)).toEqual(["cancelled", "pending"]);
    expect(store.task?.targets[0]?.structureCreated).toBe(true);
    expect(store.busy).toBe(false);
    expect(mocks.executeConditionalUpdate).toHaveBeenCalledTimes(2);
  });

  it("reports an acknowledged commit as success when it wins the cancellation race", async () => {
    const store = useTableCopyTaskStore();
    const data = deferred<ReturnType<typeof result>>();
    mocks.executeConditionalUpdate.mockReturnValue(data.promise);
    const pending = store.run([entry()], "data-only");
    await vi.waitFor(() => expect(mocks.executeConditionalUpdate).toHaveBeenCalled());
    await store.cancel();
    data.resolve(result(12));
    expect(await pending).toBe(true);
    expect(store.task?.status).toBe("succeeded");
    expect(store.task?.targets[0]?.copiedRows).toBe(12);
  });

  it("keeps the running guard on a lost response and never turns completion observation into success", async () => {
    const store = useTableCopyTaskStore();
    mocks.executeConditionalUpdate.mockRejectedValue(new Error("Connection lost while waiting for the response"));
    await store.run([entry()], "data-only");
    expect(store.task?.status).toBe("unknown");
    expect(store.busy).toBe(true);
    const tracker = useExportTracker();
    const tracked = tracker.tasks.value[0]!;
    expect(tracked.status).toBe("Unknown");
    tracker.removeTask(tracked.exportId);
    expect(tracker.tasks.value).toContain(tracked);
    expect(tracker.activeCount.value).toBe(1);
    expect(await store.run([entry()], "data-only")).toBe(false);
    mocks.cancelConditionalUpdate.mockResolvedValue({ requested: false, terminal: true, databaseTerminal: false });
    await store.checkCompletion();
    expect(store.busy).toBe(true);
    mocks.cancelConditionalUpdate.mockResolvedValue({ requested: false, terminal: true, databaseTerminal: true });
    await store.checkCompletion();
    expect(store.busy).toBe(false);
    expect(store.task?.status).toBe("unknown");
    expect(tracked.copyPhase).toBe("unknown");
    expect(tracked.status).toBe("Error");
    expect(tracker.activeCount.value).toBe(0);
    expect(mocks.executeConditionalUpdate).toHaveBeenCalledTimes(1);
  });

  it("preserves copy success when refreshing a target tab fails", async () => {
    const store = useTableCopyTaskStore();
    mocks.refreshDataTabsForTable.mockRejectedValue(new Error("Refresh unavailable"));
    expect(await store.run([entry()], "structure-and-data")).toBe(true);
    expect(store.task?.status).toBe("succeeded");
    expect(store.task?.refreshError).toBe("Refresh unavailable");
  });

  it("continues a batch after a confirmed SQL failure without reporting all targets successful", async () => {
    const store = useTableCopyTaskStore();
    mocks.executeConditionalUpdate.mockRejectedValueOnce(sqlFailure("Target exists")).mockResolvedValue(result(3));
    await store.run([entry(), { ...entry(), targetName: "second" }], "structure-only");
    expect(store.task?.status).toBe("failed");
    expect(store.task?.targets.map((target) => target.status)).toEqual(["failed", "succeeded"]);
  });

  it("does not refresh an untouched existing target after CREATE is rejected", async () => {
    const store = useTableCopyTaskStore();
    mocks.executeConditionalUpdate.mockRejectedValue(sqlFailure("Target already exists"));
    await store.run([entry()], "structure-and-data");
    expect(store.task?.status).toBe("failed");
    expect(mocks.refreshDataTabsForTable).not.toHaveBeenCalled();
    expect(mocks.getColumns).not.toHaveBeenCalled();
  });

  it("bounds a stalled cancellation request while continuing to observe the original execution", async () => {
    const store = useTableCopyTaskStore();
    const data = deferred<ReturnType<typeof result>>();
    mocks.executeConditionalUpdate.mockReturnValue(data.promise);
    const pending = store.run([entry()], "data-only");
    await vi.waitFor(() => expect(store.task?.phase).toBe("data"));
    vi.useFakeTimers();
    mocks.cancelConditionalUpdate.mockReturnValue(new Promise(() => {}));
    const cancel = store.cancel();
    await vi.advanceTimersByTimeAsync(12_000);
    await cancel;
    expect(store.cancelSending).toBe(false);
    expect(store.task?.cancelError).toContain("timed out");
    expect(store.busy).toBe(true);
    data.resolve(result(1));
    await pending;
    expect(store.task?.status).toBe("succeeded");
  });

  it("can hide and reopen active task details without cancelling the background copy", async () => {
    const store = useTableCopyTaskStore();
    const data = deferred<ReturnType<typeof result>>();
    mocks.executeConditionalUpdate.mockReturnValue(data.promise);
    const pending = store.run([entry()], "data-only");
    await vi.waitFor(() => expect(store.task?.phase).toBe("data"));
    const tracked = useExportTracker().tasks.value[0]!;
    tracked.onOpen!();
    mounted = createApp({ render: () => h(TableCopyProgressDialog) });
    mounted.use(i18n);
    mounted.use(getActivePinia()!);
    const root = document.createElement("div");
    document.body.append(root);
    mounted.mount(root);
    await nextTick();
    expect(document.body.textContent).toContain("Copying data");
    expect(document.body.textContent).toContain("Elapsed:");
    expect(document.body.textContent).toContain("Cancel copy");
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    store.close();
    expect(store.open).toBe(false);
    expect(store.busy).toBe(true);
    expect(mocks.cancelConditionalUpdate).not.toHaveBeenCalled();
    tracked.onOpen!();
    await nextTick();
    expect(store.open).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(store.open).toBe(false);
    expect(store.busy).toBe(true);
    tracked.onOpen!();
    data.resolve(result(42));
    await pending;
    await nextTick();
    expect(document.body.textContent).toContain("Database-confirmed copied rows: 42");
    const close = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Close");
    close!.click();
    await nextTick();
    expect(store.open).toBe(false);
  });

  it("opens historical results independently of a later running copy", async () => {
    const store = useTableCopyTaskStore();
    await store.run([entry()], "data-only");
    const previous = store.task;
    const historical = useExportTracker().tasks.value[0]!;
    const data = deferred<ReturnType<typeof result>>();
    mocks.executeConditionalUpdate.mockReturnValue(data.promise);
    const pending = store.run([{ ...entry(), targetName: "another" }], "data-only");
    await vi.waitFor(() => expect(store.task?.phase).toBe("data"));
    historical.onOpen!();
    expect(store.displayedTask).toBe(previous);
    expect(store.task?.targets[0]?.name).toBe("another");
    expect(store.busy).toBe(true);
    data.resolve(result(1));
    await pending;
    expect(store.displayedTask).toBe(previous);
    expect(historical.affectedRows).toBe(7000001);
  });
});
