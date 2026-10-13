import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlDebugStore } from "@/stores/plDebugStore";
import * as api from "@/lib/backend/pl-debug-tauri";

vi.mock("@/lib/backend/pl-debug-tauri", () => ({
  plDebugAbort: vi.fn(),
  plDebugClose: vi.fn(),
  plDebugDeleteBreakpoints: vi.fn(),
  plDebugExecute: vi.fn(),
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
const plStepOver = vi.mocked(api.plDebugStepOver);

async function startSession() {
  plStart.mockResolvedValue({ debugId: "d1", terminated: false, line: "4", program: "P_DEMO" });
  const store = usePlDebugStore();
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" });
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  vi.mocked(api.plDebugGetVariables).mockResolvedValue({ variables: [] });
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

    setActivePinia(createPinia());
    const fresh = usePlDebugStore();
    await expect(fresh.startTrace()).rejects.toThrow(/no debug session/);
  });
});
