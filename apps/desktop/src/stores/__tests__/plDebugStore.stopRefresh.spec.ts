// @vitest-environment happy-dom

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { usePlDebugStore } from "@/stores/plDebugStore";
import * as api from "@/lib/backend/pl-debug-tauri";

/**
 * The panels are edge-triggered on `stopSeq`: it must grow once per stop and must NOT
 * grow when a panel merely reads the session (refreshVariables / refreshStack rewrite
 * `status`, and a counter that followed those writes would re-arm the watchers from
 * inside their own responses — the refresh loop measured in the running app on
 * 2026-10-13).
 */
describe("plDebug stop banking", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(api.plDebugGetVariables).mockResolvedValue({ variables: [] });
    vi.mocked(api.plDebugGetStack).mockResolvedValue({ backtrace: "" });
    vi.mocked(api.plDebugGetLog).mockResolvedValue({ output: "" });
  });

  async function startLiveSession() {
    const store = usePlDebugStore();
    vi.mocked(api.plDebugStart).mockResolvedValue({ debugId: "d1", line: "1", program: "P_DEMO", reason: 6, terminated: false });
    await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" });
    return store;
  }

  it("banks exactly one stop for the session start", async () => {
    const store = await startLiveSession();

    expect(store.stopSeq).toBe(1);
  });

  it("banks one stop per continuation and none for a panel refresh", async () => {
    const store = await startLiveSession();
    vi.mocked(api.plDebugStepOver).mockResolvedValue({ line: "2", reason: 9, terminated: false });

    await store.stepOver();
    expect(store.stopSeq).toBe(2);

    await store.refreshVariables();
    await store.refreshStack();
    expect(store.stopSeq).toBe(2);
  });

  it("banks one stop per resume even when ignore counts auto-resume along the way", async () => {
    const store = await startLiveSession();
    // Two resumes past line 9, then the stop the user sees; only that stop is banked.
    store.setBreakpointIgnoreCount(9, 2);
    vi.mocked(api.plDebugResume).mockResolvedValueOnce({ line: "9", reason: 3, terminated: false }).mockResolvedValueOnce({ line: "9", reason: 3, terminated: false });

    await store.resume();

    expect(api.plDebugResume).toHaveBeenCalledTimes(2);
    expect(store.stopSeq).toBe(2);
  });

  it("banks the final stop of a run-to-end as well", async () => {
    const store = await startLiveSession();
    vi.mocked(api.plDebugResumeIgnoreBreakpoints).mockResolvedValue({ line: "12", reason: 25, terminated: true });

    await store.resumeIgnoreBreakpoints();

    expect(store.stopSeq).toBe(2);
    expect(store.terminated).toBe(true);
  });

  it("does not bank a stop when the continuation failed", async () => {
    const store = await startLiveSession();
    vi.mocked(api.plDebugStepOver).mockRejectedValue(new Error("debugger connection lost"));

    await expect(store.stepOver()).rejects.toThrow("debugger connection lost");
    expect(store.stopSeq).toBe(1);
    expect(store.error).toContain("debugger connection lost");
  });
});
