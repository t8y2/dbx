import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitMongoCommandRanges } from "@/lib/mongo/mongoShellCommand";
import i18n from "@/i18n";

const mocks = vi.hoisted(() => ({
  cancelQuery: vi.fn(),
  ensureConnected: vi.fn(),
  getConnectionConfig: vi.fn(),
  mongoFindDocuments: vi.fn(),
  mongoExecuteScript: vi.fn(),
  mongoParseShellCommand: vi.fn(),
}));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    cancelQuery: mocks.cancelQuery,
    mongoFindDocuments: mocks.mongoFindDocuments,
    mongoExecuteScript: mocks.mongoExecuteScript,
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

const SCRIPT = "(function () { var out = []; db.users.find({}).forEach(function (d) { out.push(d._id); }); return out; })()";

describe("queryStore MongoDB scripts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.getConnectionConfig.mockReturnValue({ id: "mongo-1", name: "MongoDB", db_type: "mongodb", database: "app", query_timeout_secs: 45 });
    mocks.cancelQuery.mockResolvedValue(true);
    mocks.mongoParseShellCommand.mockImplementation(async (source: string) => {
      const range = splitMongoCommandRanges(source)[0];
      if (!range) throw new Error("parse failed");
      return range.command;
    });
    mocks.mongoExecuteScript.mockResolvedValue({ columns: ["result"], rows: [[3]], affected_rows: 0, execution_time_ms: 1 });
  });

  it.each([
    ["a misspelled command", "db.users.fnd({})"],
    ["an unsupported cursor method", "db.users.find({}).explode()"],
    ["a parser error", "db.users.find({ a: })"],
    ["a JavaScript script", SCRIPT],
  ])("ordinary execution never runs %s as a script or sends a database request", async (_label, source) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");

    await store.executeTabSql(tabId, source);

    expect(mocks.mongoExecuteScript).not.toHaveBeenCalled();
    expect(mocks.mongoFindDocuments).not.toHaveBeenCalled();
    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(tab.result?.columns).toEqual(["Error"]);
  });

  it("points a script run through ordinary execution at the explicit script action", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");

    await store.executeTabSql(tabId, SCRIPT);

    const tab = store.tabs.find((item) => item.id === tabId)!;
    expect(String(tab.result?.rows[0]?.[0])).toContain(i18n.global.t("mongoScript.useScriptAction"));
  });

  it("runs the explicit script action through the script runtime with the execution ID", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");

    await store.executeTabSql(tabId, SCRIPT, { mongoScript: {} });

    expect(mocks.mongoExecuteScript).toHaveBeenCalledOnce();
    const [connectionId, database, source, options, executionId] = mocks.mongoExecuteScript.mock.calls[0]!;
    expect([connectionId, database, source]).toEqual(["mongo-1", "app", SCRIPT]);
    expect(options).toEqual({ timeoutMs: 45_000, confirmedProductionWrites: false });
    expect(executionId).toEqual(expect.any(String));
    expect(store.tabs.find((item) => item.id === tabId)?.result?.rows).toEqual([[3]]);
  });

  it("forwards the user's production confirmation, never a production verdict", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");

    await store.executeTabSql(tabId, SCRIPT, { mongoScript: { confirmedProductionWrites: true } });

    const options = mocks.mongoExecuteScript.mock.calls[0]![3];
    expect(options).toMatchObject({ confirmedProductionWrites: true });
    expect(options).not.toHaveProperty("productionDatabase");
    expect(options).not.toHaveProperty("allowWrites");
  });

  it("asks the server for its longest script run when the connection has no query timeout", async () => {
    mocks.getConnectionConfig.mockReturnValue({ id: "mongo-1", name: "MongoDB", db_type: "mongodb", database: "app", query_timeout_secs: 0 });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");

    await store.executeTabSql(tabId, SCRIPT, { mongoScript: {} });

    expect(mocks.mongoExecuteScript.mock.calls[0]![3]).toMatchObject({ timeoutMs: Number.MAX_SAFE_INTEGER });
  });

  it("localizes the progress the backend reports for a failed script", async () => {
    mocks.mongoExecuteScript.mockRejectedValue("E11000 duplicate key error\nConfirmed completed operations: 2 (1 writes).\nOutcome unknown, it may or may not have been applied: db.a.insertOne({})\nWrites are not rolled back.");
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");
    const translate = i18n.global.t;
    const t = vi.spyOn(i18n.global, "t").mockImplementation(((key: string, ...rest: unknown[]) => (key.startsWith("mongoScript.progress") ? `<${key} ${JSON.stringify(rest[0] ?? {})}>` : (translate as (...args: unknown[]) => string)(key, ...rest))) as typeof i18n.global.t);
    try {
      await store.executeTabSql(tabId, SCRIPT, { mongoScript: {} });
    } finally {
      t.mockRestore();
    }

    const message = String(store.tabs.find((item) => item.id === tabId)?.result?.rows[0]?.[0]);
    expect(message.split("\n")).toEqual(["E11000 duplicate key error", '<mongoScript.progressConfirmed {"count":2,"writes":1}>', '<mongoScript.progressUnknown {"operation":"db.a.insertOne({})"}>', "<mongoScript.progressNotRolledBack {}>"]);
  });

  it.each([
    ["keeps the progress report", "Query canceled\nConfirmed completed operations: 3 (3 writes).\nWrites are not rolled back.", "Confirmed completed operations: 3 (3 writes)."],
    ["restores the previous result when nothing ran", "Query canceled", "previous"],
  ])("a canceled script with kept results %s", async (_label, backendError, shown) => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.resultAutoSave = true;
    tab.result = { columns: ["value"], rows: [["previous"]], affected_rows: 0, execution_time_ms: 1 };
    let fail: (error: unknown) => void = () => {};
    mocks.mongoExecuteScript.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));

    const running = store.executeTabSql(tabId, SCRIPT, { mongoScript: {} });
    await vi.waitFor(() => expect(mocks.mongoExecuteScript).toHaveBeenCalled());
    await store.cancelTabExecution(tabId);
    fail(backendError);
    await running;

    expect(String(store.tabs.find((item) => item.id === tabId)?.result?.rows[0]?.[0])).toContain(shown);
  });

  it("localizes the write summary of a successful script", async () => {
    mocks.mongoExecuteScript.mockResolvedValue({
      columns: ["result"],
      rows: [[1]],
      affected_rows: 0,
      execution_time_ms: 1,
      messages: [{ severity: "INFO", code: "MONGO_SCRIPT_WRITES", message: "Confirmed completed operations: 2 (2 writes)." }],
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mongo-1", "app", "Query");
    const translate = i18n.global.t;
    const t = vi.spyOn(i18n.global, "t").mockImplementation(((key: string, ...rest: unknown[]) => (key === "mongoScript.progressConfirmed" ? `<${key} ${JSON.stringify(rest[0])}>` : (translate as (...args: unknown[]) => string)(key, ...rest))) as typeof i18n.global.t);
    try {
      await store.executeTabSql(tabId, SCRIPT, { mongoScript: {} });
    } finally {
      t.mockRestore();
    }

    expect(store.tabs.find((item) => item.id === tabId)?.result?.messages).toEqual([{ severity: "INFO", code: "MONGO_SCRIPT_WRITES", message: '<mongoScript.progressConfirmed {"count":2,"writes":2}>' }]);
  });
});
