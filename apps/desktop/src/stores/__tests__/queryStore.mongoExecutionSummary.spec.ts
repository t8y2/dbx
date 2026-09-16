import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitMongoCommandRanges } from "@/lib/mongo/mongoShellCommand";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  getConnectionConfig: vi.fn(),
  mongoFindDocuments: vi.fn(),
  mongoParseShellCommand: vi.fn(),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    mongoFindDocuments: mocks.mongoFindDocuments,
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
    expect(tab.batchSqlExecution).toMatchObject({
      total: 1,
      completed: 1,
      items: [{ status: "success", statementIndex: 0 }],
    });
    expect(tab.batchSqlExecution?.items[0]?.status).not.toBe("skipped");
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
});
