import { createPinia, disposePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlDebugReceipt, PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";
import type { PlDebugExecuteResult } from "@/lib/backend/pl-debug-tauri";
import { usePlDebugStore } from "@/stores/plDebugStore";
import * as api from "@/lib/backend/api";

vi.mock("@/lib/backend/api", () => ({ plDebugBootstrap: vi.fn(), plDebugStart: vi.fn(), plDebugOperation: vi.fn(), plDebugStatus: vi.fn(), plDebugOperate: vi.fn() }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [{ id: "c1", name: "Fixture" }] }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: { execute: () => Promise<unknown> }) => options.execute() }));

const plExecute = vi.fn<() => Promise<PlDebugExecuteResult>>();
let snapshot: PlDebugSnapshot;
const receipts = new Map<string, ReturnType<typeof receipt>>();
const piniaInstances: ReturnType<typeof createPinia>[] = [];
function activatePinia() {
  const pinia = createPinia();
  piniaInstances.push(pinia);
  setActivePinia(pinia);
}
function receipt(operationId: string, result: unknown = snapshot): PlDebugReceipt {
  return { serverEpoch: "epoch", sessionId: "d1", operationId, generation: 1, revision: snapshot.revision, state: "succeeded" as const, dispatched: true, result, error: null };
}

async function startSession() {
  const store = usePlDebugStore();
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" }, { riskAccepted: true, expectedConnectionRevision: "epoch:0" });
  return store;
}

beforeEach(() => {
  activatePinia();
  vi.clearAllMocks();
  receipts.clear();
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.mocked(api.plDebugBootstrap).mockResolvedValue({ serverEpoch: "epoch", heartbeatSeconds: 3600, leaseSeconds: 120, cleanupSeconds: 60 });
  vi.mocked(api.plDebugStart).mockImplementation(async (start) => {
    snapshot = {
      serverEpoch: "epoch",
      sessionId: "d1",
      connectionId: start.connectionId,
      database: start.database,
      clientSessionId: start.clientSessionId,
      startOperationId: start.operationId,
      generation: 1,
      revision: 2,
      state: "paused",
      startState: "succeeded",
      executionOutcome: "pending",
      executionStopped: false,
      releaseState: "open",
      transactionOutcome: "not_started",
      runtimeExited: false,
      closing: false,
      activeOperationId: null,
      stopRevision: 1,
      target: start.target,
      line: "12",
    };
    const started = receipt(start.operationId);
    receipts.set(start.operationId, started);
    return started;
  });
  vi.mocked(api.plDebugOperation).mockImplementation(async (_reference, operationId) => receipts.get(operationId)!);
  vi.mocked(api.plDebugStatus).mockImplementation(async () => snapshot);
  vi.mocked(api.plDebugOperate).mockImplementation(async (request) => {
    expect(request.action).toBe("execute");
    const completed = receipt(request.operationId, await plExecute());
    receipts.set(request.operationId, completed);
    return completed;
  });
});
afterEach(() => {
  for (const pinia of piniaInstances.splice(0)) disposePinia(pinia);
  vi.unstubAllGlobals();
});

describe("plDebugStore debuggee SQL (DBMS_DEBUG.EXECUTE)", () => {
  it("retains nullable partial rows from a confirmed failed SQL receipt", async () => {
    const store = await startSession();
    vi.mocked(api.plDebugOperate).mockImplementationOnce(async (request) => {
      const completed = receipt(request.operationId, { ok: false, rows: [null, "partial"], count: 2, complete: false, error: "ORA-20001: original SQL failed", resultError: "Remaining results unavailable" });
      completed.state = "failed";
      receipts.set(request.operationId, completed);
      return completed;
    });
    const result = await store.executeInDebuggee("BEGIN :1 := rows; END;");
    expect(result.rows).toEqual([null, "partial"]);
    expect(result.error).toBe("ORA-20001: original SQL failed");
    expect(api.plDebugOperate).toHaveBeenCalledTimes(1);
    expect(store.error).toBeNull();
  });
  it("runs the statement in the debuggee session and records the row count", async () => {
    const store = await startSession();
    plExecute.mockResolvedValue({ ok: true, rows: ["1"], count: 1, message: "executed in the debuggee session (frame 0): 1 rows" });

    const result = await store.executeInDebuggee("SELECT COUNT(*) FROM T WHERE tag='uncommitted'");

    expect(api.plDebugOperate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "d1", action: "execute", params: { sql: "SELECT COUNT(*) FROM T WHERE tag='uncommitted'", maxRows: 0, stopRevision: 1 } }));
    expect(result.rows).toEqual(["1"]);
    expect(store.history.some((entry) => entry.level === "INFO" && entry.message === "debuggee SQL → 1 row(s)")).toBe(true);
    expect(store.error).toBeNull();
  });

  it("keeps an unknown SQL receipt unresolved and refuses another dispatch", async () => {
    const store = await startSession();
    vi.mocked(api.plDebugOperate).mockImplementationOnce(async (request) => {
      const unknown = receipt(request.operationId, { ok: false, rows: ["unconfirmed"], count: 1 });
      unknown.state = "unknown";
      receipts.set(request.operationId, unknown);
      return unknown;
    });
    await expect(store.executeInDebuggee("BEGIN NULL; END;")).rejects.toThrow(/unknown/);
    await expect(store.executeInDebuggee("BEGIN NULL; END;")).rejects.toThrow();
    expect(api.plDebugOperate).toHaveBeenCalledTimes(1);
  });

  it("records the server's rejection as a warning instead of throwing", async () => {
    // 服务器说"没有停靠点"时这是它的判断，不是 RPC 失败：语句与理由都要留下。
    const store = await startSession();
    plExecute.mockResolvedValue({ ok: false, rows: [], count: 0, error: "ORA-00942: table or view does not exist" });

    const result = await store.executeInDebuggee("SELECT * FROM no_such_table", 20);

    expect(result.ok).toBe(false);
    expect(store.error).toBeNull();
    expect(store.history.some((entry) => entry.level === "WARN" && entry.message === "debuggee SQL: ORA-00942: table or view does not exist")).toBe(true);
    expect(api.plDebugOperate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "d1", action: "execute", params: { sql: "SELECT * FROM no_such_table", maxRows: 20, stopRevision: 1 } }));
  });

  it("refuses an empty statement before calling the backend", async () => {
    const store = await startSession();

    await expect(store.executeInDebuggee("   ")).rejects.toThrow(/empty/);

    expect(plExecute).not.toHaveBeenCalled();
  });

  it("reports an empty answer without inventing rows", async () => {
    const store = await startSession();
    plExecute.mockResolvedValue({ ok: true, rows: [], count: 0 });

    const result = await store.executeInDebuggee("INSERT INTO T VALUES (1)");

    expect(result.ok).toBe(true);
    expect(result.rows).toEqual([]);
    expect(store.history.some((entry) => entry.message === "debuggee SQL → 0 row(s)")).toBe(true);
  });

  it("needs a session", async () => {
    activatePinia();
    const store = usePlDebugStore();

    await expect(store.executeInDebuggee("SELECT 1 FROM DUAL")).rejects.toThrow(/no debug session/);
  });
});
