import { computed, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSqlExecution } from "../useSqlExecution";
import { useQueryStore } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import * as api from "@/lib/backend/api";
import type { ConnectionConfig, QueryTab } from "@/types/database";

vi.mock("vue-i18n", () => ({ createI18n: () => ({ global: { locale: { value: "en" }, setLocaleMessage: vi.fn() } }), useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/backend/api", () => ({
  saveEditorSettings: vi.fn(),
  saveHistory: vi.fn(),
  unlockConnectionWrites: vi.fn(),
  lockConnectionWrites: vi.fn(),
  connectionWriteUnlockState: vi.fn().mockResolvedValue(0),
  beginManualTransaction: vi.fn(),
  executeInManualTransaction: vi.fn(),
  commitManualTransaction: vi.fn(),
  rollbackManualTransaction: vi.fn(),
}));

function setup() {
  const connection = { id: "target-connection", name: "Test", db_type: "oceanbase-oracle", host: "localhost", port: 2881, username: "test", password: "" } as ConnectionConfig;
  const tab = { id: "source", connectionId: "source-connection", database: "source_db", sql: "INSERT INTO t VALUES (1)", title: "SQL", mode: "query", isDirty: false, isExecuting: false, isCancelling: false, isExplaining: false } as QueryTab;
  const store = useQueryStore();
  store.tabs.push(tab);
  const ordinary = vi.spyOn(store, "executeTabSql");
  const cleanup = vi.spyOn(store, "removeMultiDbExecutionWorker").mockResolvedValue(undefined);
  const capture = vi.spyOn(store, "captureMultiDbExecutionWorkerResult").mockReturnValue("result-run");
  const history = vi.spyOn(useHistoryStore(), "add").mockResolvedValue(undefined);
  const execution = useSqlExecution({ activeTab: computed(() => tab), activeConnection: computed(() => connection), executableSql: computed(() => tab.sql), activeOutputView: ref("result"), requestDangerConfirmation: async () => true });
  const input = {
    tab,
    connection,
    sql: tab.sql,
    scopeId: "batch",
    executionTarget: { connectionId: connection.id, database: "target_db", schema: "target_schema" },
    resultRun: { batchId: "batch", title: "Target", target: { connectionId: connection.id, database: "target_db" } },
    manualTransaction: true,
  };
  return { execution, input, ordinary, cleanup, capture, history };
}

describe("manual multi-database submission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    setActivePinia(createPinia());
    vi.mocked(api.beginManualTransaction).mockResolvedValue("session");
    vi.mocked(api.executeInManualTransaction).mockResolvedValue([{ columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 }]);
    vi.mocked(api.commitManualTransaction).mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 });
    vi.mocked(api.rollbackManualTransaction).mockResolvedValue({ columns: [], rows: [], affected_rows: 0, execution_time_ms: 0 });
  });

  it("uses the captured target and records success only after an explicit commit", async () => {
    const { execution, input, ordinary, cleanup, capture, history } = setup();
    input.tab.resultCountSql = "SELECT COUNT(*) FROM unrelated_source";
    input.tab.resultPageSql = "SELECT * FROM unrelated_source";
    const result = await execution.executeTargetSql(input);
    expect(api.beginManualTransaction).toHaveBeenCalledExactlyOnceWith("target-connection", "target_db", "target_schema", undefined);
    expect(api.executeInManualTransaction).toHaveBeenCalledExactlyOnceWith("session", input.sql, "target_db", "target_schema", 100000);
    expect(ordinary).not.toHaveBeenCalled();
    expect(result.status).toBe("pending_commit");
    expect(capture.mock.calls[0][3].status).toBe("pending_commit");
    const worker = useQueryStore().getExecutionTab(capture.mock.calls[0][1]);
    expect(worker?.resultCountSql).toBeUndefined();
    expect(worker?.resultPageSql).toBeUndefined();
    expect(worker?.resultBaseSql).toBe(input.sql);
    expect(input.tab.resultCountSql).toBe("SELECT COUNT(*) FROM unrelated_source");
    expect(history).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    await result.transaction!.finish("commit");
    expect(api.commitManualTransaction).toHaveBeenCalledExactlyOnceWith("session");
    expect(history).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ connection_id: "target-connection", database: "target_db", success: true }));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rolls back pending changes without writing a successful history entry", async () => {
    const { execution, input, history, cleanup } = setup();
    const result = await execution.executeTargetSql(input);
    await result.transaction!.finish("rollback");
    expect(api.rollbackManualTransaction).toHaveBeenCalledExactlyOnceWith("session");
    expect(api.commitManualTransaction).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not replay a failed statement or an expired session", async () => {
    const { execution, input, ordinary } = setup();
    vi.mocked(api.executeInManualTransaction).mockRejectedValueOnce(new Error("Transaction session not found"));
    vi.mocked(api.rollbackManualTransaction).mockRejectedValueOnce(new Error("Transaction session not found"));
    const result = await execution.executeTargetSql(input);
    expect(result.status).toBe("failed");
    expect(result.transaction).toBeUndefined();
    expect(api.beginManualTransaction).toHaveBeenCalledTimes(1);
    expect(api.executeInManualTransaction).toHaveBeenCalledTimes(1);
    expect(ordinary).not.toHaveBeenCalled();
  });

  it("cleans up a late session if cancellation arrives while begin is pending", async () => {
    const { execution, input } = setup();
    let cancelled = false;
    let release!: (session: string) => void;
    vi.mocked(api.beginManualTransaction).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const running = execution.executeTargetSql({ ...input, isCancellationRequested: () => cancelled });
    await vi.waitFor(() => expect(api.beginManualTransaction).toHaveBeenCalled());
    cancelled = true;
    release("late-session");
    const result = await running;
    expect(result.status).toBe("cancelled");
    expect(api.executeInManualTransaction).not.toHaveBeenCalled();
    expect(api.rollbackManualTransaction).toHaveBeenCalledExactlyOnceWith("late-session");
  });

  it("retains failed rollback for cleanup and disallows commit", async () => {
    const { execution, input, cleanup } = setup();
    vi.mocked(api.executeInManualTransaction).mockRejectedValueOnce(new Error("statement failed"));
    vi.mocked(api.rollbackManualTransaction).mockRejectedValueOnce(new Error("transport unavailable"));
    const result = await execution.executeTargetSql(input);
    expect(result.status).toBe("failed");
    expect(result.transaction?.canCommit).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    await result.transaction!.finish("rollback");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not retry an uncertain commit or report a success history entry", async () => {
    const { execution, input, history } = setup();
    const result = await execution.executeTargetSql(input);
    vi.mocked(api.commitManualTransaction).mockRejectedValueOnce(new Error("transport unavailable"));
    await expect(result.transaction!.finish("commit")).rejects.toThrow("transport unavailable");
    await expect(result.transaction!.finish("commit")).rejects.toThrow("multiDbExecute.manualCommitUnavailable");
    expect(api.commitManualTransaction).toHaveBeenCalledTimes(1);
    expect(history).not.toHaveBeenCalled();
    await result.transaction!.finish("rollback");
  });

  it("does not turn a completed commit into a pending transaction when history fails", async () => {
    const { execution, input, history, cleanup } = setup();
    history.mockRejectedValueOnce(new Error("history unavailable"));
    const result = await execution.executeTargetSql(input);
    await expect(result.transaction!.finish("commit")).resolves.toBeUndefined();
    await result.transaction!.finish("commit");
    expect(api.commitManualTransaction).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not claim rollback after a lost commit response and a missing session", async () => {
    const { execution, input, cleanup, history } = setup();
    const result = await execution.executeTargetSql(input);
    vi.mocked(api.commitManualTransaction).mockRejectedValueOnce(new Error("response lost"));
    await expect(result.transaction!.finish("commit")).rejects.toThrow("response lost");
    vi.mocked(api.rollbackManualTransaction).mockRejectedValueOnce(new Error("Transaction session not found"));
    expect(await result.transaction!.finish("rollback")).toBe("toolbar.commitOutcomeUnknown");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(history).not.toHaveBeenCalled();
  });

  it("stops later statements in the same target after cancellation", async () => {
    const { execution, input } = setup();
    let cancelled = false;
    vi.mocked(api.executeInManualTransaction).mockImplementationOnce(async () => {
      cancelled = true;
      return [{ columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 }];
    });
    const result = await execution.executeTargetSql({ ...input, sql: "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);", isCancellationRequested: () => cancelled });
    expect(result.status).toBe("cancelled");
    expect(api.executeInManualTransaction).toHaveBeenCalledExactlyOnceWith("session", "INSERT INTO t VALUES (1)", "target_db", "target_schema", 100000);
    expect(api.rollbackManualTransaction).toHaveBeenCalledExactlyOnceWith("session");
  });

  it("keeps an Oracle procedural block intact while submitting subsequent statements on the same session", async () => {
    const { execution, input } = setup();
    const block = "BEGIN INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); END;";
    const result = await execution.executeTargetSql({ ...input, sql: `${block}\nINSERT INTO t VALUES (3);` });
    expect(result.status).toBe("pending_commit");
    expect(api.executeInManualTransaction.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["session", block],
      ["session", "INSERT INTO t VALUES (3)"],
    ]);
    await result.transaction!.finish("rollback");
  });

  it("preserves each submitted statement and editor range for the result summary", async () => {
    const { execution, input, capture } = setup();
    const first = "INSERT INTO t VALUES (1)";
    const second = "INSERT INTO t VALUES (2)";
    const result = await execution.executeTargetSql({ ...input, sql: `${first};\n${second};`, sourceOffset: 10 });
    const worker = useQueryStore().getExecutionTab(capture.mock.calls[0][1]);
    expect(worker?.results).toEqual([
      expect.objectContaining({ statement_index: 0, sourceStatement: first, sourceFrom: 10, sourceTo: 10 + first.length }),
      expect.objectContaining({ statement_index: 1, sourceStatement: second, sourceFrom: 12 + first.length, sourceTo: 12 + first.length + second.length }),
    ]);
    await result.transaction!.finish("rollback");
  });
});
