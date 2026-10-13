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
const plExecute = vi.mocked(api.plDebugExecute);

async function startSession() {
  plStart.mockResolvedValue({ debugId: "d1", terminated: false, line: "12", program: "P_DEMO" });
  const store = usePlDebugStore();
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" });
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  // selectFrame re-reads the frame's variables, so the GET_VALUES channel needs an
  // answer even in the cases that only care about the SQL call.
  vi.mocked(api.plDebugGetVariables).mockResolvedValue({ variables: [] });
});

describe("plDebugStore debuggee SQL (DBMS_DEBUG.EXECUTE)", () => {
  it("runs the statement in the debuggee session and records the row count", async () => {
    const store = await startSession();
    plExecute.mockResolvedValue({ ok: true, rows: ["1"], count: 1, message: "executed in the debuggee session (frame 0): 1 rows" });

    const result = await store.executeInDebuggee("SELECT COUNT(*) FROM T WHERE tag='uncommitted'");

    expect(plExecute).toHaveBeenCalledWith("d1", "SELECT COUNT(*) FROM T WHERE tag='uncommitted'", 0);
    expect(result.rows).toEqual(["1"]);
    expect(store.history.some((entry) => entry.level === "INFO" && entry.message === "debuggee SQL → 1 row(s)")).toBe(true);
    expect(store.error).toBeNull();
  });

  it("records the server's rejection as a warning instead of throwing", async () => {
    // 服务器说"没有停靠点"时这是它的判断，不是 RPC 失败：语句与理由都要留下。
    const store = await startSession();
    plExecute.mockResolvedValue({ ok: false, rows: [], count: 0, error: "ORA-00942: table or view does not exist" });

    const result = await store.executeInDebuggee("SELECT * FROM no_such_table", 20);

    expect(result.ok).toBe(false);
    expect(store.error).toBeNull();
    expect(store.history.some((entry) => entry.level === "WARN" && entry.message === "debuggee SQL: ORA-00942: table or view does not exist")).toBe(true);
    expect(plExecute).toHaveBeenCalledWith("d1", "SELECT * FROM no_such_table", 20);
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
    setActivePinia(createPinia());
    const store = usePlDebugStore();

    await expect(store.executeInDebuggee("SELECT 1 FROM DUAL")).rejects.toThrow(/no debug session/);
  });
});
