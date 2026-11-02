import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  editorSettings: {
    autoCalculateTotalRows: false,
    continueOnErrorOnBatch: false,
    globalQueryTimeoutSecs: 30,
    pageSize: 100,
    queryResultMaxRows: 10_000,
    queryResultMaxRowsEnabled: true,
  },
  toast: vi.fn(),
  ensureConnected: vi.fn(),
  getConnectionConfig: vi.fn(),
  mongoExecuteScript: vi.fn(),
  mongoFindDocuments: vi.fn(),
  mongoParseShellCommand: vi.fn(),
  mongoRunCommand: vi.fn(),
}));

vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

vi.mock("@/lib/backend/api", () => ({
  mongoExecuteScript: mocks.mongoExecuteScript,
  mongoFindDocuments: mocks.mongoFindDocuments,
  mongoParseShellCommand: mocks.mongoParseShellCommand,
  mongoRunCommand: mocks.mongoRunCommand,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: mocks.getConnectionConfig,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: mocks.editorSettings,
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

describe("queryStore MongoDB JavaScript integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.editorSettings.pageSize = 100;
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.getConnectionConfig.mockReturnValue({
      id: "mongo-1",
      name: "MongoDB",
      db_type: "mongodb",
      database: "app",
      query_timeout_secs: 30,
    });
  });

  it("caps oversized MongoDB script row requests before dispatch", async () => {
    mocks.editorSettings.pageSize = Number.MAX_SAFE_INTEGER;
    mocks.mongoExecuteScript.mockResolvedValue({
      output: [],
      operationCount: 0,
      succeededOperationCount: 0,
      currentDatabase: "app",
      truncated: false,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const source = "({ ok: true })";
    const tabId = store.createTab("mongo-1", "app", "Script", "query", undefined, source);

    await store.executeTabSql(tabId, source, { mongoScriptExecution: true });

    expect(mocks.mongoExecuteScript).toHaveBeenCalledWith(expect.objectContaining({ maxRows: 10_000 }));
  });

  it("dispatches an explicitly requested selection as one confirmed script result", async () => {
    mocks.mongoExecuteScript.mockResolvedValue({
      finalValue: { inserted: 2 },
      output: [{ kind: "text", value: "done" }],
      operationCount: 2,
      succeededOperationCount: 2,
      currentDatabase: "archive",
      truncated: false,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const source = "for (let i = 0; i < 2; i += 1) { db.items.insertOne({ index: i }); }";
    const tabId = store.createTab("mongo-1", "app", "Script", "query", undefined, source);

    await store.executeTabSql(tabId, source, { mongoScriptExecution: true, dangerousMongoScriptConfirmed: true, sourceOffset: 12 });

    expect(mocks.mongoExecuteScript).toHaveBeenCalledWith({
      connectionId: "mongo-1",
      database: "app",
      source,
      executionId: expect.any(String),
      maxRows: 100,
      timeoutSecs: 30,
      dangerousOperationConfirmed: true,
    });
    expect(mocks.mongoParseShellCommand).not.toHaveBeenCalled();
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.database).toBe("archive");
    expect(tab.results).toBeUndefined();
    expect(tab.mongoEditTarget).toBeUndefined();
    expect(tab.result?.rows).toEqual([
      ["Text", "done"],
      ["Final value", '{\n  "inserted": 2\n}'],
      ["Summary", "2 of 2 operations succeeded · current database: archive"],
    ]);
    expect(tab.result).toMatchObject({ sourceStatement: source, sourceFrom: 12, sourceTo: 12 + source.length });
  });

  it.each([
    ["misspelled command", "db.items.fnd({})", "Collection method fnd() is not supported"],
    ["unsupported command", "db.items.mapReduce({})", "Collection method mapReduce() is not supported"],
    ["ordinary parser error", "db.items.find({", "MongoDB command has unclosed"],
  ])("does not enter QuickJS or issue database requests for a %s", async (_label, source, expectedError) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Invalid command", "query", undefined, source);

    await store.executeTabSql(tabId, source);

    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.mongoExecuteScript).not.toHaveBeenCalled();
    expect(mocks.mongoParseShellCommand).not.toHaveBeenCalled();
    expect(mocks.mongoFindDocuments).not.toHaveBeenCalled();
    expect(mocks.mongoRunCommand).not.toHaveBeenCalled();
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(String(tab.result?.rows?.[0]?.[0])).toContain(expectedError);
  });

  it("preserves find pagination and editable-result metadata on the command path", async () => {
    mocks.mongoParseShellCommand.mockResolvedValue({ kind: "find", collection: "items", filter: "{}", skip: 0, limit: 0 });
    mocks.mongoFindDocuments.mockResolvedValue({
      documents: [{ _id: "1", name: "Alice" }],
      extended_documents: [{ _id: { $oid: "000000000000000000000001" }, name: "Alice" }],
      total: 1,
      total_is_exact: true,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const source = "db.items.find({})";
    const tabId = store.createTab("mongo-1", "app", "Find", "query", undefined, source);

    await store.executeTabSql(tabId, source, { pagination: { limit: 25, offset: 0 } });

    expect(mocks.mongoExecuteScript).not.toHaveBeenCalled();
    expect(mocks.mongoFindDocuments).toHaveBeenCalledWith("mongo-1", "app", "items", 0, 25, "{}", undefined, undefined, undefined, expect.any(String), true);
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.mongoEditTarget).toEqual({ collection: "items", idColumn: "_id" });
    expect(tab.resultPageLimit).toBe(25);
    expect(tab.result?.mongo_documents).toEqual([{ _id: "1", name: "Alice" }]);
  });

  it("keeps supported command batches grouped on the existing path", async () => {
    mocks.mongoParseShellCommand.mockImplementation(async (source: string) => {
      if (source.trim().startsWith("use ")) return { kind: "use", database: "admin" };
      return { kind: "runCommand", commandJson: '{"ping":1}' };
    });
    mocks.mongoRunCommand.mockResolvedValue({ documents: [{ ok: 1 }], extended_documents: [{ ok: 1 }], total: 1, total_is_exact: true });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const source = "use admin; db.runCommand({ ping: 1 })";
    const tabId = store.createTab("mongo-1", "app", "Commands", "query", undefined, source);

    await store.executeTabSql(tabId, source);

    expect(mocks.mongoExecuteScript).not.toHaveBeenCalled();
    expect(mocks.mongoRunCommand).toHaveBeenCalledWith("mongo-1", "admin", '{"ping":1}', expect.any(String));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.database).toBe("admin");
    expect(tab.results).toHaveLength(2);
    expect(tab.results?.[0]?.rows).toEqual([["switched to db admin"]]);
    expect(tab.results?.[1]?.mongo_documents).toEqual([{ ok: 1 }]);
  });
  it("does not dispatch a script cancelled during connection setup", async () => {
    let connected!: () => void;
    mocks.ensureConnected.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          connected = resolve;
        }),
    );
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Script", "query", undefined, "print(1)");
    const execution = store.executeTabSql(tabId, "print(1)", { mongoScriptExecution: true, dangerousMongoScriptConfirmed: true });
    await vi.waitFor(() => expect(connected).toBeTypeOf("function"));
    store.tabs.find((tab) => tab.id === tabId)!.cancelRequestCount = 1;
    connected();
    expect(await execution).toBe(false);
    expect(mocks.mongoExecuteScript).not.toHaveBeenCalled();
  });

  it.each(["cancel", "supersede"])("does not publish a late script result after %s", async (action) => {
    let complete!: (result: unknown) => void;
    mocks.mongoExecuteScript.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Script", "query", undefined, "print(1)");
    const execution = store.executeTabSql(tabId, "print(1)", { mongoScriptExecution: true, dangerousMongoScriptConfirmed: true });
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    if (action === "cancel") tab.cancelRequestCount = 1;
    else tab.executionId = "new-execution";
    complete({ output: [], operationCount: 0, succeededOperationCount: 0, currentDatabase: "wrong", truncated: false });
    expect(await execution).toBe(false);
    expect(tab.database).toBe("app");
    expect(tab.result).toBeUndefined();
  });

  it.each(["cancel", "supersede", "target-change", "closed-tab"])("reports confirmed writes from a late successful response after %s without replacing the current result", async (action) => {
    let complete!: (result: unknown) => void;
    mocks.mongoExecuteScript.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const source = "db.items.insertOne({ a: 1 })";
    const tabId = store.createTab("mongo-1", "app", "Script", "query", undefined, source);
    const execution = store.executeTabSql(tabId, source, { mongoScriptExecution: true, dangerousMongoScriptConfirmed: true });
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    const tab = store.tabs.find((item) => item.id === tabId)!;
    if (action === "cancel") tab.cancelRequestCount = 1;
    else if (action === "target-change") store.updateDatabase(tabId, "changed");
    else if (action === "closed-tab") store.tabs = [];
    else tab.executionId = "new-execution";
    tab.result = { columns: ["other"], rows: [["do not replace"]], affected_rows: 0, execution_time_ms: 1 };
    complete({ output: [], operationCount: 2, succeededOperationCount: 2, currentDatabase: "app", truncated: false });
    expect(await execution).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith("2 of 2 operations succeeded · current database: app", 10000);
    expect(tab.result.rows).toEqual([["do not replace"]]);
  });

  it("preserves a previous result as a separate run when executing a script", async () => {
    mocks.mongoExecuteScript.mockResolvedValue({ output: [], operationCount: 0, succeededOperationCount: 0, currentDatabase: "app", truncated: false });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Script", "query", undefined, "print(1)");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.result = { columns: ["old"], rows: [["retained"]], affected_rows: 0, execution_time_ms: 1 };
    await store.executeTabSql(tabId, "print(1)", { mongoScriptExecution: true, dangerousMongoScriptConfirmed: true, openInNewResultTab: true });
    expect(tab.resultRuns).toHaveLength(2);
    expect(tab.resultRuns?.[0]?.result?.rows).toEqual([["retained"]]);
    expect(tab.resultRuns?.[1]?.result?.rows).toEqual([["Summary", "0 of 0 operations succeeded · current database: app"]]);
    expect(tab.batchSqlExecution).toBeUndefined();
    expect(tab.resultEditorFingerprint).toBeTruthy();
  });

  it.each(["cancel", "cancel-cleared", "target-change", "closed-tab"])("reports partial completion after %s", async (action) => {
    let fail!: (error: unknown) => void;
    mocks.mongoExecuteScript.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Script", "query", undefined, "db.items.insertOne({ a: 1 })");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.result = { columns: ["old"], rows: [["retained"]], affected_rows: 0, execution_time_ms: 1 };
    const execution = store.executeTabSql(tabId, tab.sql, { mongoScriptExecution: true, dangerousMongoScriptConfirmed: true, openInNewResultTab: true });
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    if (action === "target-change") store.updateDatabase(tabId, "changed");
    else if (action === "closed-tab") store.tabs = [];
    else {
      tab.isCancelling = true;
      tab.cancelRequestCount = 1;
      if (action === "cancel-cleared") tab.executionId = undefined;
    }
    fail("[mongo_script.cancelled] Script cancelled (MongoDB shell progress: 1 confirmed completed of 2 attempted operations; in-flight operation outcome unknown)");
    await execution;
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("1 of 2"), 10000);
    expect(mocks.toast.mock.calls[0]?.[0]).toContain("unknown");
    if (action === "cancel") {
      expect(String(tab.result?.rows[0]?.[0])).toContain("unknown");
      expect(tab.resultRuns?.[0]?.result?.rows).toEqual([["retained"]]);
    }
  });
});
