// @vitest-environment happy-dom

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
const plResume = vi.mocked(api.plDebugResume);
const plSetBreakpoints = vi.mocked(api.plDebugSetBreakpoints);

/** A session that runs to the end, so `hasSession` is false afterwards. */
async function finishedSession() {
  plStart.mockResolvedValue({ debugId: "d1", terminated: false, line: "4", program: "P_DEMO" });
  plResume.mockResolvedValue({ line: "12", reason: 25, terminated: true });
  const store = usePlDebugStore();
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" });
  await store.resume();
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  vi.mocked(api.plDebugGetVariables).mockResolvedValue({ variables: [] });
  plSetBreakpoints.mockImplementation(async (_debugId: string, breakpoints) => breakpoints.map((breakpoint, index) => ({ ...breakpoint, breakpointNumber: 900 + index })));
  vi.mocked(api.plDebugDeleteBreakpoints).mockResolvedValue([]);
});

// Reported from use (2026-10-13): after the program finished, clicking a line number did
// nothing at all — the store returned early without a word, and the toolbar's only way
// back ("Restart") was disabled because it required a live session too.
describe("a debug session that has finished", () => {
  it("refuses a gutter breakpoint out loud instead of doing nothing", async () => {
    const store = await finishedSession();

    await store.toggleBreakpoint(7);

    expect(plSetBreakpoints).not.toHaveBeenCalled();
    const warn = store.history.filter((entry) => entry.level === "WARN").at(-1);
    expect(warn?.message).toContain("breakpoint line 7");
    expect(warn?.message).toContain("restart the debugger");
    expect(store.breakpoints).toEqual([]);
  });

  it("refuses an enable/disable out loud too", async () => {
    const store = await finishedSession();

    await store.setBreakpointEnabled(7, false);

    expect(store.history.filter((entry) => entry.level === "WARN").at(-1)?.message).toContain("no live debug session");
  });

  it("keeps the session handle and target so Restart can replay the launch", async () => {
    const store = await finishedSession();

    // The toolbar's Restart is gated on these, not on `hasSession` (a finished session
    // has none): a missing handle or target would leave the panel a dead end again.
    expect(store.hasSession).toBe(false);
    expect(store.terminated).toBe(true);
    expect(store.debugId).toBe("d1");
    expect(store.connectionId).toBe("c1");
    expect(store.database).toBe("ob");
    expect(store.target?.objectName).toBe("P_DEMO");
  });

  it("closes a finished session without complaining", async () => {
    const store = await finishedSession();
    vi.mocked(api.plDebugClose).mockResolvedValue({ debugId: "d1", terminated: true });

    await store.close();

    expect(api.plDebugClose).toHaveBeenCalledWith("d1");
    expect(store.debugId).toBeNull();
    expect(store.target).toBeNull();
    expect(store.history.some((entry) => entry.level === "WARN" && entry.message.includes("close failed"))).toBe(false);
  });
});
