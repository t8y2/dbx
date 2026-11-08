import { createPinia, disposePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";
import * as backend from "@/lib/backend/api";
import { usePlDebugStore } from "@/stores/plDebugStore";
import * as api from "@/lib/backend/pl-debug-tauri";
import type { PlDebugBreakpoint } from "@/lib/backend/pl-debug-tauri";
vi.mock("@/lib/backend/api", () => ({ plDebugBootstrap: vi.fn(), plDebugStart: vi.fn(), plDebugOperation: vi.fn(), plDebugStatus: vi.fn(), plDebugOperate: vi.fn(), plDebugRead: vi.fn() }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [{ id: "c1", name: "Fixture" }] }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: { execute: () => Promise<unknown> }) => options.execute() }));

vi.mock("@/lib/backend/pl-debug-tauri", () => ({
  plDebugAbort: vi.fn(),
  plDebugClose: vi.fn(),
  plDebugDeleteBreakpoints: vi.fn(),
  plDebugGetLog: vi.fn(),
  plDebugGetStack: vi.fn(),
  plDebugGetVariables: vi.fn(),
  plDebugListBreakpoints: vi.fn(),
  plDebugProbe: vi.fn(),
  plDebugResume: vi.fn(),
  plDebugResumeIgnoreBreakpoints: vi.fn(),
  plDebugSetBreakpoints: vi.fn(),
  plDebugSetExceptionBreakpoint: vi.fn(),
  plDebugSetValue: vi.fn(),
  plDebugStart: vi.fn(),
  plDebugStepIn: vi.fn(),
  plDebugStepOut: vi.fn(),
  plDebugStepOver: vi.fn(),
}));

const plStart = vi.mocked(api.plDebugStart);
const plResume = vi.mocked(api.plDebugResume);
const plSetBreakpoints = vi.mocked(api.plDebugSetBreakpoints);
const plDeleteBreakpoints = vi.mocked(api.plDebugDeleteBreakpoints);
const plGetVariables = vi.mocked(api.plDebugGetVariables);
let pinia: ReturnType<typeof createPinia>;
let snapshot: PlDebugSnapshot;
const receipt = (operationId: string) => ({ serverEpoch: "epoch", sessionId: "d1", operationId, generation: 1, revision: snapshot.revision, state: "succeeded" as const, dispatched: true, result: snapshot, error: null });

/** Starts a session on `S.P_DEMO` and returns the store, ready for a breakpoint. */
async function startSession() {
  plStart.mockResolvedValue({ debugId: "d1", terminated: false, line: null, program: null });
  const store = usePlDebugStore();
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" }, { riskAccepted: true, expectedConnectionRevision: "epoch:0" });
  return store;
}

/** A stop parked on line 30, which is where the tests set their breakpoints. */
function stopOnLine30() {
  return { line: "30", terminated: false };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  // The agent assigns the breakpoint number; the frontend keeps its own fields.
  plSetBreakpoints.mockImplementation(async (_debugId: string, breakpoints: PlDebugBreakpoint[]) => breakpoints.map((breakpoint, index) => ({ ...breakpoint, breakpointNumber: 900 + index })));
  plDeleteBreakpoints.mockResolvedValue([]);
  plGetVariables.mockResolvedValue({ variables: [] });
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.mocked(backend.plDebugBootstrap).mockResolvedValue({ serverEpoch: "epoch", heartbeatSeconds: 3600, leaseSeconds: 120, cleanupSeconds: 60 });
  vi.mocked(backend.plDebugStart).mockImplementation(async (start) => {
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
      line: null,
    };
    return receipt(start.operationId);
  });
  vi.mocked(backend.plDebugOperation).mockImplementation(async (_reference, operationId) => receipt(operationId));
  vi.mocked(backend.plDebugStatus).mockImplementation(async () => snapshot);
  vi.mocked(backend.plDebugOperate).mockImplementation(async (request) => {
    expect(request.sessionId).toBe("d1");
    const native = request.action === "resume" ? await plResume("d1") : request.action === "step_over" ? await api.plDebugStepOver("d1") : request.action === "step_in" ? await api.plDebugStepIn("d1") : undefined;
    if (!native) throw new Error(`Unexpected operation ${request.action}`);
    snapshot = { ...snapshot, ...native, state: native.terminated ? "ended" : "paused", executionStopped: native.terminated === true, revision: snapshot.revision + 1, stopRevision: Number(snapshot.stopRevision) + 1 };
    return receipt(request.operationId);
  });
  vi.mocked(backend.plDebugRead).mockImplementation(async (request) => {
    if (request.kind !== "variables") throw new Error(`Unexpected read ${request.kind}`);
    const native = await plGetVariables("d1", Number(request.params?.frame ?? 0));
    return { ...native, stopRevision: snapshot.stopRevision, variables: native.variables?.map((entry) => ({ ...entry, state: "value" })) ?? [] };
  });
});
afterEach(() => {
  disposePinia(pinia);
  vi.unstubAllGlobals();
});

describe("plDebugStore ignore count", () => {
  it("auto resumes while the ignore count is not reached", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointIgnoreCount(30, 3);
    plResume.mockResolvedValue(stopOnLine30());

    const result = await store.resume();

    // One user resume plus two automatic ones: hit 1 and 2 skip, hit 3 stops.
    expect(plResume).toHaveBeenCalledTimes(3);
    expect(store.breakpointLocals[30]?.hits).toBe(3);
    expect(result.line).toBe("30");
    expect(store.currentLine).toBe(30);
    expect(store.history.filter((entry) => entry.message.includes("auto resume"))).toHaveLength(2);
  });

  it("stops at the breakpoint as soon as the ignore count is reached", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointIgnoreCount(30, 1);
    plResume.mockResolvedValue(stopOnLine30());

    await store.resume();

    expect(plResume).toHaveBeenCalledTimes(1);
    expect(store.breakpointLocals[30]?.hits).toBe(1);
    expect(store.currentLine).toBe(30);
  });

  it("keeps counting stopped once the ignore count is reached", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointIgnoreCount(30, 1);
    plResume.mockResolvedValue(stopOnLine30());

    await store.resume();
    await store.resume();

    expect(plResume).toHaveBeenCalledTimes(2);
    expect(store.breakpointLocals[30]?.hits).toBe(1);
  });
});

describe("plDebugStore breakpoint condition", () => {
  it("auto resumes while the condition is false and stops when it holds", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointCondition(30, "V_COUNT > 3");
    plGetVariables.mockResolvedValueOnce({ variables: [{ name: "V_COUNT", value: "2" }] }).mockResolvedValueOnce({ variables: [{ name: "V_COUNT", value: "5" }] });
    plResume.mockResolvedValue(stopOnLine30());

    await store.resume();

    expect(plResume).toHaveBeenCalledTimes(2);
    expect(plGetVariables).toHaveBeenCalledTimes(2);
    expect(store.currentLine).toBe(30);
    expect(store.history.some((entry) => entry.level === "INFO" && entry.message.includes("is false"))).toBe(true);
  });

  it("stops immediately when the condition already holds", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointCondition(30, "V_NAME == 'ok'");
    plGetVariables.mockResolvedValue({ variables: [{ name: "V_NAME", value: "ok" }] });
    plResume.mockResolvedValue(stopOnLine30());

    await store.resume();

    expect(plResume).toHaveBeenCalledTimes(1);
    expect(store.currentLine).toBe(30);
  });

  it("stops with a WARN when the condition cannot be parsed", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointCondition(30, "V_COUNT >= ");
    plResume.mockResolvedValue(stopOnLine30());

    await store.resume();

    expect(plResume).toHaveBeenCalledTimes(1);
    const warn = store.history.filter((entry) => entry.level === "WARN");
    expect(warn).toHaveLength(1);
    expect(warn[0]?.message).toContain("not evaluated");
    expect(store.currentLine).toBe(30);
  });

  it("stops with a WARN when the variable is not visible", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointCondition(30, "V_MISSING == 1");
    plGetVariables.mockResolvedValue({ variables: [] });
    plResume.mockResolvedValue(stopOnLine30());

    await store.resume();

    expect(plResume).toHaveBeenCalledTimes(1);
    const warn = store.history.filter((entry) => entry.level === "WARN");
    expect(warn).toHaveLength(1);
    expect(warn[0]?.message).toContain("not visible");
  });
});

describe("plDebugStore automatic continue limit", () => {
  it("stops with an ERROR after the limit instead of looping forever", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointCondition(30, "V_COUNT > 100");
    plGetVariables.mockResolvedValue({ variables: [{ name: "V_COUNT", value: "1" }] });
    plResume.mockResolvedValue(stopOnLine30());

    await store.resume();

    // 1 user resume + 200 automatic ones, then the limiter refuses to continue.
    expect(plResume).toHaveBeenCalledTimes(201);
    expect(store.history.some((entry) => entry.level === "ERROR" && entry.message.includes("auto continue limit"))).toBe(true);
    expect(store.currentLine).toBe(30);
  });
});

describe("plDebugStore breakpoint enablement", () => {
  it("keeps the local condition and ignore count while disabled", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointCondition(30, "V_COUNT > 3");
    store.setBreakpointIgnoreCount(30, 5);

    await store.setBreakpointEnabled(30, false);

    expect(plDeleteBreakpoints).toHaveBeenCalledTimes(1);
    expect(store.breakpoints).toHaveLength(0);
    expect(store.breakpointLines).toEqual([]);
    expect(store.disabledBreakpointLines).toEqual([30]);
    expect(store.breakpointLocals[30]).toMatchObject({ enabled: false, ignoreCount: 5, condition: "V_COUNT > 3" });

    await store.setBreakpointEnabled(30, true);

    expect(store.breakpointLines).toEqual([30]);
    expect(store.breakpoints[0]?.condition).toBe("V_COUNT > 3");
    expect(store.breakpoints[0]?.ignoreCount).toBe(5);
    // The local properties must never travel to the agent.
    const sent = plSetBreakpoints.mock.calls[plSetBreakpoints.mock.calls.length - 1]?.[1] ?? [];
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("condition");
    expect(sent[0]).not.toHaveProperty("ignoreCount");
  });

  it("forgets the local properties when the gutter removes the breakpoint", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointCondition(30, "V_COUNT > 3");

    await store.toggleBreakpoint(30);

    expect(store.breakpoints).toHaveLength(0);
    expect(store.breakpointLocals[30]).toBeUndefined();
  });
});

describe("plDebugStore exception resume bookkeeping", () => {
  it("records the truncated exception resume as a warning instead of a plain stop", async () => {
    // helper 的异常恢复循环有上限；到顶时 agent 会在 message 里说明原因并停下。
    const store = await startSession();
    plResume.mockResolvedValue({ line: "30", terminated: false, exceptionResumeTruncated: true, message: "exception breakpoint resume stopped after 200 continuations without an exception" });

    await store.resume();

    expect(store.history.some((entry) => entry.level === "WARN" && entry.message.includes("without an exception"))).toBe(true);
  });

  it("stops on an exception without recording a warning", async () => {
    const store = await startSession();
    plResume.mockResolvedValue({ line: "30", terminated: false, stoppedOnException: true });

    await store.resume();

    expect(store.status?.stoppedOnException).toBe(true);
    expect(store.history.some((entry) => entry.level === "WARN")).toBe(false);
  });
});

describe("plDebugStore breakpoint message", () => {
  /** A breakpoint stop: reason 3 (reason_breakpoint) on line 30. */
  function hitLine30() {
    return { line: "30", reason: 3, terminated: false };
  }

  it("prints the breakpoint's own message when a resume stops on its line", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointMessage(30, "这里是重算余额的地方");
    plResume.mockResolvedValue(hitLine30());

    await store.resume();

    expect(store.history.some((entry) => entry.message === "breakpoint line 30: 这里是重算余额的地方")).toBe(true);
  });

  it("stays silent for a line whose breakpoint carries no message", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    plResume.mockResolvedValue(hitLine30());

    await store.resume();

    expect(store.history.some((entry) => entry.message.startsWith("breakpoint line 30: "))).toBe(false);
  });

  it("prints nothing for a line the ignore count resumed past", async () => {
    // The first hit is auto-resumed, so its message does not belong to the stop the
    // user sees; the run then stops on a line without a breakpoint at all.
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointIgnoreCount(30, 2);
    store.setBreakpointMessage(30, "只在停下来时显示");
    plResume.mockResolvedValueOnce(hitLine30()).mockResolvedValueOnce({ line: "40", reason: 9, terminated: false });

    await store.resume();

    expect(plResume).toHaveBeenCalledTimes(2);
    // The setter records its own INFO line, so the check asks for the HIT line.
    expect(store.history.some((entry) => entry.message === "breakpoint line 30: 只在停下来时显示")).toBe(false);
  });

  it("prints the message for a step that lands on the breakpoint", async () => {
    // A step can hit an armed breakpoint too; the message belongs to the stop, not to
    // the resume that produced it.
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointMessage(30, "单步也会命中");
    vi.mocked(api.plDebugStepOver).mockResolvedValue(hitLine30());

    await store.stepOver();

    expect(store.history.some((entry) => entry.message === "breakpoint line 30: 单步也会命中")).toBe(true);
  });

  it("stays silent when a step stops on a line that is not a breakpoint hit", async () => {
    const store = await startSession();
    await store.toggleBreakpoint(30);
    store.setBreakpointMessage(30, "不该出现");
    vi.mocked(api.plDebugStepOver).mockResolvedValue({ line: "30", reason: 9, terminated: false });

    await store.stepOver();

    expect(store.history.some((entry) => entry.message === "breakpoint line 30: 不该出现")).toBe(false);
  });
});
