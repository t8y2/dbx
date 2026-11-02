import { createPinia, disposePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";
import type { PlDebugStatus } from "@/lib/backend/pl-debug-tauri";
import { usePlDebugStore } from "@/stores/plDebugStore";
import * as api from "@/lib/backend/api";

vi.mock("@/lib/backend/api", () => ({ plDebugBootstrap: vi.fn(), plDebugStart: vi.fn(), plDebugOperation: vi.fn(), plDebugStatus: vi.fn(), plDebugOperate: vi.fn() }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [{ id: "c1", name: "Fixture" }] }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: { execute: () => Promise<unknown> }) => options.execute() }));

const plStepOver = vi.fn<() => Promise<PlDebugStatus>>();
let snapshot: PlDebugSnapshot;
const piniaInstances: ReturnType<typeof createPinia>[] = [];
function activatePinia() {
  const pinia = createPinia();
  piniaInstances.push(pinia);
  setActivePinia(pinia);
}
const receipt = (operationId: string) => ({ serverEpoch: "epoch", sessionId: snapshot.sessionId, operationId, generation: snapshot.generation, revision: snapshot.revision, state: "succeeded" as const, dispatched: true, result: snapshot, error: null });

async function startSession() {
  const store = usePlDebugStore();
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" }, { riskAccepted: true, expectedConnectionRevision: "epoch:0" });
  return store;
}

beforeEach(() => {
  activatePinia();
  vi.clearAllMocks();
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
      line: "4",
    };
    return receipt(start.operationId);
  });
  vi.mocked(api.plDebugOperation).mockImplementation(async (_reference, operationId) => receipt(operationId));
  vi.mocked(api.plDebugStatus).mockImplementation(async () => snapshot);
  vi.mocked(api.plDebugOperate).mockImplementation(async (request) => {
    expect(request.action).toBe("step_over");
    const next = await plStepOver();
    snapshot = { ...snapshot, line: next.line, revision: snapshot.revision + 1, stopRevision: Number(snapshot.stopRevision) + 1, state: next.terminated ? "ended" : "paused", executionStopped: next.terminated === true, executionOutcome: next.terminated ? "succeeded" : "pending" };
    return receipt(request.operationId);
  });
});
afterEach(() => {
  for (const pinia of piniaInstances.splice(0)) disposePinia(pinia);
  vi.unstubAllGlobals();
});

describe("plDebugStore trace run (#35)", () => {
  it("counts every line the program executes", async () => {
    const store = await startSession();
    // 4 -> 5 -> 6 -> 5 -> 7(end): the loop body line 5 runs twice.
    plStepOver.mockResolvedValueOnce({ line: "5", terminated: false }).mockResolvedValueOnce({ line: "6", terminated: false }).mockResolvedValueOnce({ line: "5", terminated: false }).mockResolvedValueOnce({ line: "7", terminated: true });

    const result = await store.startTrace();

    expect(result.lines).toEqual([
      { line: 5, hits: 2 },
      { line: 6, hits: 1 },
      { line: 7, hits: 1 },
    ]);
    expect(result.steps).toBe(4);
    expect(result.truncated).toBe(false);
    expect(store.terminated).toBe(true);
    expect(store.history.some((entry) => entry.message.startsWith("trace: 4 step(s) over 3 line(s)"))).toBe(true);
  });

  it("stops at the step cap and says the program has not finished", async () => {
    const store = await startSession();
    plStepOver.mockResolvedValue({ line: "5", terminated: false });

    const result = await store.startTrace(3);

    expect(plStepOver).toHaveBeenCalledTimes(3);
    expect(result.steps).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.lines).toEqual([{ line: 5, hits: 3 }]);
    expect(store.history.some((entry) => entry.level === "WARN" && entry.message.includes("3-step cap"))).toBe(true);
  });

  it("stops between steps when the user asks for it", async () => {
    const store = await startSession();
    plStepOver.mockImplementation(async () => {
      // The user presses Stop while the first step is in flight.
      store.stopTrace();
      return { line: "5", terminated: false };
    });

    const result = await store.startTrace(50);

    expect(plStepOver).toHaveBeenCalledTimes(1);
    expect(result.steps).toBe(1);
    expect(result.truncated).toBe(false);
    expect(store.history.some((entry) => entry.message.startsWith("trace: stop requested"))).toBe(true);
  });

  it("refuses a finished debuggee and a missing session", async () => {
    const store = await startSession();
    plStepOver.mockResolvedValue({ line: "9", terminated: true });
    await store.startTrace();
    await expect(store.startTrace()).rejects.toThrow(/finished/);

    activatePinia();
    const fresh = usePlDebugStore();
    await expect(fresh.startTrace()).rejects.toThrow(/no debug session/);
  });

  it("clears the completed trace when restart confirms a new generation", async () => {
    const store = await startSession();
    plStepOver.mockResolvedValueOnce({ line: "9", terminated: true });
    await store.startTrace();
    expect(store.traceResult?.lines).toEqual([{ line: 9, hits: 1 }]);
    snapshot = { ...snapshot, releaseState: "released", runtimeExited: true, revision: snapshot.revision + 1 };
    await store.recover();
    vi.mocked(api.plDebugOperate).mockImplementationOnce(async (request) => {
      expect(request.action).toBe("restart");
      snapshot = { ...snapshot, generation: 2, revision: snapshot.revision + 1, state: "paused", executionStopped: false, executionOutcome: "pending", releaseState: "open", runtimeExited: false, stopRevision: 1, line: "4" };
      return receipt(request.operationId);
    });

    await store.restart();

    expect(store.publicSnapshot?.generation).toBe(2);
    expect(store.traceResult).toBeNull();
  });

  it("clears the previous target trace when another session starts after release", async () => {
    const store = await startSession();
    plStepOver.mockResolvedValueOnce({ line: "9", terminated: true });
    await store.startTrace();
    snapshot = { ...snapshot, releaseState: "released", runtimeExited: true, revision: snapshot.revision + 1 };
    await store.recover();
    vi.mocked(api.plDebugStart).mockImplementationOnce(async (start) => {
      snapshot = { ...snapshot, sessionId: "d2", startOperationId: start.operationId, target: start.target, generation: 1, revision: 2, state: "paused", executionStopped: false, executionOutcome: "pending", releaseState: "open", runtimeExited: false, stopRevision: 1, line: "4" };
      return receipt(start.operationId);
    });

    await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "OTHER_DEMO" }, { riskAccepted: true, expectedConnectionRevision: "epoch:0" });

    expect(store.publicSnapshot?.sessionId).toBe("d2");
    expect(store.target?.objectName).toBe("OTHER_DEMO");
    expect(store.traceResult).toBeNull();
  });

  it("keeps the trace after a temporary recovery failure in the same generation", async () => {
    const store = await startSession();
    plStepOver.mockResolvedValue({ line: "5", terminated: false });
    await store.startTrace(1);
    const trace = store.traceResult;
    vi.mocked(api.plDebugStatus).mockRejectedValueOnce(new Error("temporarily disconnected"));

    await expect(store.recover()).rejects.toThrow("temporarily disconnected");
    expect(store.publicSnapshot).toBeNull();
    expect(store.traceResult).toEqual(trace);
    await store.recover();

    expect(store.publicSnapshot?.generation).toBe(1);
    expect(store.traceResult).toEqual(trace);
  });

  it("keeps a trace during same-generation refresh and step or a rejected restart", async () => {
    const store = await startSession();
    plStepOver.mockResolvedValue({ line: "5", terminated: false });
    await store.startTrace(1);
    const trace = store.traceResult;
    await store.recover();
    await store.stepOver();
    expect(store.traceResult).toEqual(trace);
    snapshot = { ...snapshot, state: "ended", executionStopped: true, executionOutcome: "succeeded", releaseState: "released", runtimeExited: true, revision: snapshot.revision + 1 };
    await store.recover();
    vi.mocked(api.plDebugOperate).mockRejectedValueOnce(new Error("restart rejected"));

    await expect(store.restart()).rejects.toThrow("restart rejected");

    expect(store.traceResult).toEqual(trace);
  });
});
