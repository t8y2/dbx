import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitMongoCommandRanges } from "@/lib/mongo/mongoShellCommand";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  getConnectionConfig: vi.fn(),
  mongoFindDocuments: vi.fn(),
  mongoExplainFind: vi.fn(),
  cancelQuery: vi.fn(),
  mongoParseShellCommand: vi.fn(),
  tabResultSnapshots: new Map<string, unknown>(),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    mongoFindDocuments: mocks.mongoFindDocuments,
    mongoExplainFind: mocks.mongoExplainFind,
    cancelQuery: mocks.cancelQuery,
    mongoParseShellCommand: mocks.mongoParseShellCommand,
  };
});

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: mocks.getConnectionConfig,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { autoCalculateTotalRows: false, pageSize: 100, continueOnErrorOnBatch: false, queryResultMaxRowsEnabled: false, queryResultMaxRows: 0 },
  }),
}));

vi.mock("@/lib/tabs/tabResultCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tabs/tabResultCache")>();
  return {
    ...actual,
    writeTabResultSnapshot: vi.fn(async (key: string, snapshot: Parameters<typeof actual.encodeTabResultSnapshot>[0]) => {
      mocks.tabResultSnapshots.set(key, actual.decodeTabResultSnapshot(actual.encodeTabResultSnapshot(snapshot)));
      return true;
    }),
    readTabResultSnapshot: vi.fn(async (key: string) => mocks.tabResultSnapshots.get(key)),
    deleteTabResultSnapshot: vi.fn(async (key: string) => {
      mocks.tabResultSnapshots.delete(key);
    }),
  };
});

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("queryStore MongoDB execution summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.tabResultSnapshots.clear();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.getConnectionConfig.mockReturnValue({
      id: "mongo-1",
      name: "MongoDB",
      db_type: "mongodb",
      database: "app",
    });
    mocks.mongoParseShellCommand.mockImplementation(async (source: string) => splitMongoCommandRanges(source)[0]!.command);
  });

  it("marks a successful find command as success with the returned row count, instead of leaving it stuck at 'skipped'", async () => {
    mocks.mongoFindDocuments.mockResolvedValue({
      documents: [
        { _id: "1", name: "alice" },
        { _id: "2", name: "bob" },
        { _id: "3", name: "carol" },
      ],
      extended_documents: [],
      total: 3,
      total_is_exact: true,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");

    await store.executeTabSql(tabId, "db.users.find()");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.rows).toHaveLength(3);
    expect(tab.result?.client_request_wait_ms).toEqual(expect.any(Number));
    expect(tab.result?.client_result_ms).toEqual(expect.any(Number));
    expect(tab.result?.timing_page_count).toBe(1);
    expect(tab.batchSqlExecution).toMatchObject({
      total: 1,
      completed: 1,
      items: [{ status: "success", statementIndex: 0 }],
    });
    expect(tab.batchSqlExecution?.items[0]?.status).not.toBe("skipped");
  });

  it("skips the total count when an explicit limit fits in the first page", async () => {
    mocks.mongoFindDocuments.mockResolvedValue({
      documents: [{ _id: "1" }, { _id: "2" }],
      extended_documents: [],
      total: 2,
      total_is_exact: false,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");

    await store.executeTabSql(tabId, "db.events.find({ type: 0 }).sort({ eventTime: -1 }).limit(50)");

    expect(mocks.mongoFindDocuments).toHaveBeenCalledWith("mongo-1", "app", "events", 0, 50, expect.any(String), undefined, expect.any(String), undefined, expect.any(String), false);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.rows).toHaveLength(2);
    expect(tab.result?.truncated).toBe(false);
    expect(tab.resultTotalRowCount).toBe(2);
  });

  it.each((["auto-keep", "new-result"] as const).flatMap((mode) => (["success", "error"] as const).map((status) => ({ mode, status }))))("preserves the new MongoDB summary after viewing history during execution ($mode, $status)", async ({ mode, status }) => {
    const oldSql = "db.old_collection.find()";
    const newSql = "db.new_collection.find()";
    const oldResponse = { documents: [{ _id: "old" }], extended_documents: [], total: 1, total_is_exact: true };
    const newResponse = { documents: [{ _id: "new-1" }, { _id: "new-2" }], extended_documents: [], total: 2, total_is_exact: true };
    mocks.mongoFindDocuments.mockResolvedValueOnce(oldResponse);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");
    if (mode === "auto-keep") store.toggleResultAutoSave(tabId);
    const options = { openInNewResultTab: mode === "new-result" };
    await store.executeTabSql(tabId, oldSql, options);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    const oldRunId = tab.activeResultRunId!;
    const oldBatch = JSON.parse(JSON.stringify(tab.batchSqlExecution));

    let resolve!: (value: typeof newResponse) => void;
    let reject!: (reason: Error) => void;
    mocks.mongoFindDocuments.mockImplementationOnce(
      () =>
        new Promise<typeof newResponse>((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        }),
    );
    const execution = store.executeTabSql(tabId, newSql, options);
    await vi.waitFor(() => expect(mocks.mongoFindDocuments).toHaveBeenCalledTimes(2));
    const executionId = tab.executionId;
    await store.setActiveResultRun(tabId, oldRunId, { evictInactive: false });
    expect(tab.batchSqlExecution).toEqual(oldBatch);
    if (status === "error") reject(new Error("current query failed"));
    else resolve(newResponse);
    await execution;

    const newRunId = tab.activeResultRunId!;
    expect(newRunId).not.toBe(oldRunId);
    expect(tab.resultRuns).toHaveLength(2);
    expect(tab.result?.sourceStatement).toBe(newSql);
    expect(tab.result?.rows).toHaveLength(status === "success" ? 2 : 1);
    expect(tab.batchSqlExecution).toMatchObject({
      executionId,
      completed: 1,
      finishedAt: expect.any(Number),
      items: [{ sql: newSql, status, affectedRows: status === "success" ? 2 : 0, executionTimeMs: expect.any(Number) }],
    });
    if (status === "error") expect(tab.batchSqlExecution?.items[0]?.error).toContain("current query failed");
    const completedBatch = JSON.parse(JSON.stringify(tab.batchSqlExecution));
    expect(tab.resultRuns!.find((run) => run.id === oldRunId)!.batchSqlExecution).toEqual(oldBatch);

    await store.setActiveResultRun(tabId, oldRunId, { evictInactive: false });
    expect(tab.batchSqlExecution).toEqual(oldBatch);
    await store.setActiveResultRun(tabId, newRunId, { evictInactive: false });
    expect(tab.result?.sourceStatement).toBe(newSql);
    expect(tab.batchSqlExecution).toEqual(completedBatch);
    expect(tab.resultRuns!.find((run) => run.id === newRunId)!.batchSqlExecution).toEqual(completedBatch);
  });

  it("keeps counting when an explicit limit spans more than one page", async () => {
    mocks.mongoFindDocuments.mockResolvedValue({ documents: [{ _id: "1" }], extended_documents: [], total: 500, total_is_exact: true });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");

    await store.executeTabSql(tabId, "db.events.find({ type: 0 }).limit(150)");

    expect(mocks.mongoFindDocuments).toHaveBeenCalledWith("mongo-1", "app", "events", 0, 100, expect.any(String), undefined, undefined, undefined, expect.any(String), true);
  });

  it("marks a failing mongo command as error instead of leaving it stuck at 'skipped'", async () => {
    mocks.mongoFindDocuments.mockRejectedValue(new Error("collection not found"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");

    await store.executeTabSql(tabId, "db.missing.find()");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.batchSqlExecution).toMatchObject({
      total: 1,
      completed: 1,
      items: [{ status: "error", statementIndex: 0 }],
    });
  });

  it("reconciles each command in a multi-command mongo batch by position", async () => {
    mocks.mongoFindDocuments.mockResolvedValue({ documents: [{ _id: "1" }], extended_documents: [], total: 1, total_is_exact: true });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");

    await store.executeTabSql(tabId, "db.users.find();\ndb.orders.find()");

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.batchSqlExecution).toMatchObject({
      total: 2,
      completed: 2,
      items: [
        { status: "success", statementIndex: 0 },
        { status: "success", statementIndex: 1 },
      ],
    });
  });

  it("executes the authoritative inDatabase wrapper against the sibling database and restores the session database", async () => {
    mocks.mongoFindDocuments.mockResolvedValue({ documents: [{ _id: "1" }], extended_documents: [], total: 1, total_is_exact: true });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");

    await store.executeTabSql(tabId, 'db.getSiblingDB("reports").events.find();\ndb.users.find()');

    expect(mocks.mongoFindDocuments).toHaveBeenNthCalledWith(1, "mongo-1", "reports", "events", expect.any(Number), expect.any(Number), "{}", undefined, undefined, undefined, expect.any(String), true);
    expect(mocks.mongoFindDocuments).toHaveBeenNthCalledWith(2, "mongo-1", "app", "users", expect.any(Number), expect.any(Number), "{}", undefined, undefined, undefined, expect.any(String), true);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.batchSqlExecution).toMatchObject({
      total: 2,
      completed: 2,
      items: [
        { status: "success", statementIndex: 0 },
        { status: "success", statementIndex: 1 },
      ],
    });
  });

  it("forwards the active execution ID to a pending explain and its cancellation", async () => {
    let rejectExplain!: (reason: Error) => void;
    mocks.mongoExplainFind.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectExplain = reject;
        }),
    );
    mocks.cancelQuery.mockImplementation(async () => {
      rejectExplain(new Error("Query canceled"));
      return true;
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");
    const execution = store.executeTabSql(tabId, 'db.users.find({}).explain("executionStats")');

    await vi.waitFor(() => expect(mocks.mongoExplainFind).toHaveBeenCalledOnce());
    const executionId = store.tabs.find((tab) => tab.id === tabId)!.executionId;
    try {
      expect(executionId).toEqual(expect.any(String));
      expect(mocks.mongoExplainFind).toHaveBeenCalledWith("mongo-1", "app", "users", expect.objectContaining({ verbosity: "executionStats" }), executionId);
      await expect(store.cancelTabExecution(tabId)).resolves.toBe(true);
      expect(mocks.cancelQuery).toHaveBeenCalledWith(executionId);
    } finally {
      rejectExplain(new Error("Query canceled"));
      await execution;
    }
    expect(store.tabs.find((tab) => tab.id === tabId)).toMatchObject({ isExecuting: false, executionId: undefined });
  });
});
