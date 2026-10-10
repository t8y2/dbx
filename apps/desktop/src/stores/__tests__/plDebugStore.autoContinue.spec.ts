import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlDebugStore } from "@/stores/plDebugStore";
import * as api from "@/lib/backend/pl-debug-tauri";
import type { PlDebugBreakpoint } from "@/lib/backend/pl-debug-tauri";

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

/** Starts a session on `S.P_DEMO` and returns the store, ready for a breakpoint. */
async function startSession() {
  plStart.mockResolvedValue({ debugId: "d1", terminated: false, line: null, program: null });
  const store = usePlDebugStore();
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" });
  return store;
}

/** A stop parked on line 30, which is where the tests set their breakpoints. */
function stopOnLine30() {
  return { line: "30", terminated: false };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  // The agent assigns the breakpoint number; the frontend keeps its own fields.
  plSetBreakpoints.mockImplementation(async (_debugId: string, breakpoints: PlDebugBreakpoint[]) => breakpoints.map((breakpoint, index) => ({ ...breakpoint, breakpointNumber: 900 + index })));
  plDeleteBreakpoints.mockResolvedValue([]);
  plGetVariables.mockResolvedValue({ variables: [] });
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
