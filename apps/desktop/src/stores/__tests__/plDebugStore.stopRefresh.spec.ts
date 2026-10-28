// @vitest-environment happy-dom
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlDebugReceipt, PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";

vi.mock("@/lib/backend/api", () => ({ plDebugBootstrap: vi.fn(), plDebugStart: vi.fn(), plDebugOperate: vi.fn(), plDebugOperation: vi.fn(), plDebugStatus: vi.fn(), plDebugRead: vi.fn() }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [{ id: "c1", name: "Fixture" }] }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: { execute: () => Promise<unknown> }) => options.execute() }));
import * as api from "@/lib/backend/api";
import { usePlDebugStore } from "@/stores/plDebugStore";

let pinia: ReturnType<typeof createPinia>;
let snapshot: PlDebugSnapshot;
function receipt(operationId: string): PlDebugReceipt {
  return { serverEpoch: "epoch", sessionId: "session", operationId, generation: 1, revision: snapshot.revision, state: "succeeded", dispatched: true, result: snapshot, error: null };
}
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.mocked(api.plDebugBootstrap).mockResolvedValue({ serverEpoch: "epoch", heartbeatSeconds: 3600, leaseSeconds: 120, cleanupSeconds: 60 });
  vi.mocked(api.plDebugStart).mockImplementation(async (start) => {
    snapshot = {
      serverEpoch: "epoch",
      sessionId: "session",
      connectionId: "c1",
      database: "APP",
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
      line: "1",
    };
    return receipt(start.operationId);
  });
  vi.mocked(api.plDebugOperate).mockImplementation(async (request) => {
    const ending = request.action === "run_to_end";
    snapshot = { ...snapshot, revision: snapshot.revision + 1, stopRevision: Number(snapshot.stopRevision) + 1, line: "9", state: ending ? "ended" : "paused", executionStopped: ending, executionOutcome: ending ? "succeeded" : "pending" };
    return receipt(request.operationId);
  });
  vi.mocked(api.plDebugRead).mockImplementation(async () => ({ stopRevision: snapshot.stopRevision, variables: [], frames: [], output: "" }));
  vi.mocked(api.plDebugOperation).mockImplementation(async (_reference, operationId) => receipt(operationId));
  vi.mocked(api.plDebugStatus).mockImplementation(async () => snapshot);
});
afterEach(() => {
  disposePinia(pinia);
  vi.unstubAllGlobals();
});
async function startLiveSession() {
  const store = usePlDebugStore();
  await store.start("c1", "APP", { schema: "APP", objectType: "ANONYMOUS", source: "BEGIN NULL; END;" }, { riskAccepted: true, expectedConnectionRevision: "epoch:0" });
  return store;
}
describe("public plDebug stop banking", () => {
  it("retains partial variables and the native discovery error without claiming an empty successful read", async () => {
    const store = await startLiveSession();
    vi.mocked(api.plDebugRead).mockResolvedValueOnce({ stopRevision: snapshot.stopRevision, variables: [{ name: "V_NULL", state: "null", value: null, type: "VARCHAR2" }], variablesComplete: false, variablesError: "Outer frame source is not visible" });
    await store.refreshVariables();
    expect(store.variables).toHaveLength(1);
    expect(store.variables[0].state).toBe("null");
    expect(store.variableError).toBe("Outer frame source is not visible");
    expect(store.variablesState).toBe("error");
    vi.mocked(api.plDebugRead).mockResolvedValueOnce({ stopRevision: snapshot.stopRevision, variables: [], variablesComplete: false, variablesError: "Source unavailable" });
    await store.refreshVariables();
    expect(store.variables).toEqual([]);
    expect(store.variablesState).toBe("error");
    expect(store.variableError).toBe("Source unavailable");
  });
  it("banks exactly one stop for start", async () => {
    expect((await startLiveSession()).stopSeq).toBe(1);
  });
  it("banks one stop per continuation and none for panel reads", async () => {
    const store = await startLiveSession();
    await store.stepOver();
    expect(store.stopSeq).toBe(2);
    await store.refreshVariables();
    await store.refreshStack();
    expect(store.stopSeq).toBe(2);
  });
  it("banks one server-confirmed resume stop without replaying the operation", async () => {
    const store = await startLiveSession();
    await store.resume();
    expect(api.plDebugOperate).toHaveBeenCalledTimes(1);
    expect(store.stopSeq).toBe(2);
  });
  it("publishes termination separately without inventing another paused stop", async () => {
    const store = await startLiveSession();
    await store.resumeIgnoreBreakpoints();
    expect(store.stopSeq).toBe(1);
    expect(store.terminated).toBe(true);
  });
  it("does not bank a stop after a failed continuation", async () => {
    const store = await startLiveSession();
    vi.mocked(api.plDebugOperate).mockRejectedValue(new Error("debugger connection lost"));
    await expect(store.stepOver()).rejects.toThrow("debugger connection lost");
    expect(store.stopSeq).toBe(1);
    expect(store.error).toContain("debugger connection lost");
  });
});
