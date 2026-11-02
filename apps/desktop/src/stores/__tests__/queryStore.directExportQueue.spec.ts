import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QueryResultExportRequest, TableExportProgress } from "@/lib/backend/api";

const mocks = vi.hoisted(() => ({
  mode: vi.fn(),
  ensure: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  config: { id: "oracle-1", name: "Oracle", db_type: "oracle", database: "APP", query_timeout_secs: 30 },
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/export/exportExecutionMode", () => ({ showExportExecutionModeDialog: mocks.mode }));
vi.mock("@/lib/backend/api", () => ({ saveOpenTabsState: vi.fn().mockResolvedValue(undefined), startQueryResultExport: mocks.start, cancelQueryResultExport: mocks.cancel }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ ensureConnected: mocks.ensure, getConfig: () => mocks.config, connectionIdentifierQuote: () => '"' }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { exportBatchSize: 1000, exportRowLimitEnabled: false, globalQueryTimeoutSecs: 30 } }) }));

const pending: Array<{ request: QueryResultExportRequest; progress: (progress: TableExportProgress) => void; resolve: (progress: TableExportProgress) => void; reject: (error: Error) => void }> = [];
let pinia: Pinia;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  pending.length = 0;
  pinia = createPinia();
  setActivePinia(pinia);
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  mocks.mode.mockResolvedValue("queued");
  mocks.ensure.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(undefined);
  mocks.start.mockImplementation((request, progress) => new Promise((resolve, reject) => pending.push({ request, progress, resolve, reject })));
});

afterEach(() => {
  disposePinia(pinia);
  vi.unstubAllGlobals();
});

function finish(index: number) {
  const entry = pending[index]!;
  const progress: TableExportProgress = { exportId: entry.request.exportId, tableName: "Query Result", status: "Done", rowsExported: 1, totalRows: 1 };
  entry.progress(progress);
  entry.resolve(progress);
}

it("queues the captured direct SQL request and does not reconnect or execute waiting items", async () => {
  const { useQueryStore } = await import("../queryStore");
  const store = useQueryStore();
  const id = store.createTab("oracle-1", "APP", "Query");
  const comments = ["original"];
  await store.exportQuerySqlDirect(id, "SELECT 1 FROM dual", "csv", "first.csv");
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  await store.exportQuerySqlDirect(id, "SELECT 2 FROM dual", "xlsx", "second.xlsx", comments);
  expect(mocks.ensure).toHaveBeenCalledTimes(1);
  comments[0] = "changed";
  store.tabs.find((tab) => tab.id === id)!.database = "OTHER";
  finish(0);
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(pending[1]!.request).toEqual(expect.objectContaining({ database: "APP", sql: "SELECT 2 FROM dual", filePath: "second.xlsx", columnComments: ["original"] }));
  finish(1);
});

it("cancels a waiting direct export without a cancel or start RPC", async () => {
  const { useQueryStore } = await import("../queryStore");
  const { useExportTracker } = await import("@/composables/useExportTracker");
  const store = useQueryStore();
  const id = store.createTab("oracle-1", "APP", "Query");
  await store.exportQuerySqlDirect(id, "SELECT 1 FROM dual", "csv", "first.csv");
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  await store.exportQuerySqlDirect(id, "SELECT 2 FROM dual", "csv", "second.csv");
  const tracker = useExportTracker();
  await tracker.cancelTask(tracker.tasks.value[1]!.exportId);
  finish(0);
  await Promise.resolve();
  expect(mocks.start).toHaveBeenCalledTimes(1);
  expect(mocks.cancel).not.toHaveBeenCalled();
});

it("waits for actual terminal after running cancellation and retains unknown execution", async () => {
  const { useQueryStore } = await import("../queryStore");
  const { useExportTracker } = await import("@/composables/useExportTracker");
  const store = useQueryStore();
  const id = store.createTab("oracle-1", "APP", "Query");
  await store.exportQuerySqlDirect(id, "SELECT 1 FROM dual", "csv", "first.csv");
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  await store.exportQuerySqlDirect(id, "SELECT 2 FROM dual", "csv", "second.csv");
  const tracker = useExportTracker();
  await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
  expect(tracker.tasks.value[0]!.status).toBe("Cancelling");
  await tracker.cancelTask(tracker.tasks.value[0]!.exportId);
  expect(mocks.cancel).toHaveBeenCalledTimes(1);
  expect(mocks.cancel).toHaveBeenCalledWith(pending[0]!.request.exportId, pending[0]!.request.executionId);
  expect(pending).toHaveLength(1);
  pending[0]!.reject(new Error("lost terminal"));
  await vi.waitFor(() => expect(tracker.tasks.value[0]!.status).toBe("Unknown"));
  expect(pending).toHaveLength(1);
  await tracker.cancelTask(tracker.tasks.value[1]!.exportId);
});

it("finishes a known preparation failure and permits the following independent export", async () => {
  const { useQueryStore } = await import("../queryStore");
  const { useExportTracker } = await import("@/composables/useExportTracker");
  const store = useQueryStore();
  const id = store.createTab("oracle-1", "APP", "Query");
  mocks.ensure.mockRejectedValueOnce(new Error("connection unavailable"));
  await store.exportQuerySqlDirect(id, "SELECT 1 FROM dual", "csv", "first.csv");
  await store.exportQuerySqlDirect(id, "SELECT 2 FROM dual", "csv", "second.csv");
  const tracker = useExportTracker();
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  expect(tracker.tasks.value[0]!).toEqual(expect.objectContaining({ status: "Error", errorMessage: "connection unavailable", finishedAt: expect.any(Number) }));
  expect(pending[0]!.request.sql).toBe("SELECT 2 FROM dual");
  finish(0);
});
