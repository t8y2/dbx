import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F1/F2「静默失败要出声」的 store 层契约，外加两条同主题的追加规则
 * （`stepHint` / `runToEndIncomplete`）。
 *
 * 这些场景的共同点：后端在协议上都报"成功"——没建成的断点只是让返回清单比请求
 * 短，入口停靠点的 set_value 回 ok=true，step_in 没进去、运行到结束没跑完也照常
 * 返回一个停靠状态——而用户端（gutter 标记还在、变量面板照旧）看不到任何异常。
 * 因此断言的是历史通道里的 WARN：请求数、拒绝数与典型场景说明，set_value 的
 * reason 6 提示，以及 agent 对"没进去/没跑完"的解释原文；并把"不该出声"的对照
 * （全部建成 / reason 9 / 请求 0 个 / hint 缺失或空串 / 未置位）一并钉住，避免
 * WARN 变成噪音。
 *
 * 这里 mock `@tauri-apps/api/core` 的 invoke（与 plDebugStore.anonymous.spec.ts
 * 同法）：要断言的就是到达 invoke 的电文载荷与落进 history 的文案；响应按调用
 * 顺序给出，并用 toHaveBeenNthCalledWith 钉住命令顺序。
 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { usePlDebugStore } from "@/stores/plDebugStore";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
});

/** Starts an ANONYMOUS session whose 3-line source is `BEGIN / NULL; / END;`. */
async function startAnonymousSession() {
  invokeMock.mockResolvedValueOnce({ debugId: "d1", terminated: false });
  const store = usePlDebugStore();
  await store.start("conn-1", "db1", { objectType: "ANONYMOUS", source: "BEGIN\n  NULL;\nEND;" });
  return store;
}

/** Starts a `S.P_DEMO` session; the agent reports the parked stop through `reason`. */
async function startProcedureSession() {
  invokeMock.mockResolvedValueOnce({ debugId: "d1", terminated: false, line: "5", program: "P_DEMO" });
  const store = usePlDebugStore();
  await store.start("conn-1", "db1", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" });
  return store;
}

/** The newest history entry, which is where a silent-failure warning must land. */
function lastHistory(store: ReturnType<typeof usePlDebugStore>) {
  return store.history[store.history.length - 1];
}

describe("breakpoints the server did not create (F1)", () => {
  it("records a WARN with the refused count when the server returns an empty list", async () => {
    // 匿名块在 Oracle 19c 上的实测行为：pl_debug_set_breakpoints 返回 []，
    // 之后第一次 continue/step 就把块跑完，断点永远没有机会生效。
    const store = await startAnonymousSession();
    invokeMock.mockResolvedValueOnce([]);

    await store.toggleBreakpoint(2);

    expect(invokeMock).toHaveBeenNthCalledWith(2, "pl_debug_set_breakpoints", {
      debugId: "d1",
      breakpoints: [{ owner: null, name: null, line: 2, kind: "ANONYMOUS" }],
    });
    const last = lastHistory(store);
    expect(last?.level).toBe("WARN");
    expect(last?.message).toContain("1 of 1");
    expect(last?.message).toContain("not in effect");
    expect(last?.message).toContain("anonymous block");
    // The refused breakpoint never enters the local list either, so the gutter
    // must not keep painting it as armed.
    expect(store.breakpoints).toHaveLength(0);
    expect(store.breakpointLines).toEqual([]);
  });

  it("records no WARN when the server created the requested breakpoint", async () => {
    const store = await startAnonymousSession();
    invokeMock.mockResolvedValueOnce([{ owner: null, name: null, line: 2, breakpointNumber: 7, kind: "ANONYMOUS" }]);

    await store.toggleBreakpoint(2);

    expect(store.breakpointLines).toEqual([2]);
    expect(store.history.some((entry) => entry.level === "WARN")).toBe(false);
  });

  it("records no WARN when no breakpoint was requested at all", async () => {
    const store = await startAnonymousSession();

    await store.applyBreakpoints([]);

    // Only the start command reached invoke: nothing was asked of the server.
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(store.history.some((entry) => entry.level === "WARN")).toBe(false);
  });
});

describe("set_value at the routine entry (F2)", () => {
  it("warns that the value may be overwritten by the declaration section (reason 6)", async () => {
    const store = await startProcedureSession();
    // The SET_VALUE response is an envelope, not a flat PlDebugStatus: the stop
    // position lives in `snapshot` (measured on 19c through the app's own call
    // path: `{ok, result, message, assignmentSemicolon, snapshot}`).
    invokeMock.mockResolvedValueOnce({
      ok: true,
      result: 0,
      message: "set V_N (frame=0, index=0)",
      snapshot: { reason: 6, line: "5", terminated: false },
    });
    invokeMock.mockResolvedValueOnce({ variables: [{ name: "V_N", value: "7", type: "NUMBER" }] });

    await store.setValue("V_N", 0, 0, "7");

    expect(invokeMock).toHaveBeenNthCalledWith(2, "pl_debug_set_value", { debugId: "d1", name: "V_N", frame: 0, index: 0, value: "7" });
    // The assignment itself stays as before: it is neither blocked nor an error.
    expect(store.error).toBeNull();
    const last = lastHistory(store);
    expect(last?.level).toBe("WARN");
    expect(last?.message).toContain("reason 6");
    expect(last?.message).toContain("declaration section");
    expect(last?.message).toContain("step once");
  });

  it("records no WARN for a plain line stop (reason 9)", async () => {
    const store = await startProcedureSession();
    invokeMock.mockResolvedValueOnce({ ok: true, result: 0, snapshot: { reason: 9, line: "8", terminated: false } });
    invokeMock.mockResolvedValueOnce({ variables: [{ name: "V_N", value: "200", type: "NUMBER" }] });

    await store.setValue("V_N", 0, 0, "200");

    expect(store.history.some((entry) => entry.message.includes("set V_N := 200"))).toBe(true);
    expect(store.history.some((entry) => entry.level === "WARN")).toBe(false);
  });

  it("reads the reason from the envelope's snapshot, not from its top level", async () => {
    // A `reason` on the envelope's top level is not part of the contract: reading it
    // there left the warning dead in production (the real response carries no such
    // field). A response shaped that way must not produce a warning.
    const store = await startProcedureSession();
    invokeMock.mockResolvedValueOnce({ ok: true, result: 0, reason: 6, line: "5", terminated: false });
    invokeMock.mockResolvedValueOnce({ variables: [{ name: "V_N", value: "7", type: "NUMBER" }] });

    await store.setValue("V_N", 0, 0, "7");

    expect(store.history.some((entry) => entry.level === "WARN")).toBe(false);
  });
});

describe("step_in that did not enter a subprogram (stepHint)", () => {
  it("records the agent's hint as the last history entry, verbatim", async () => {
    const store = await startProcedureSession();
    const hint = "step in: no call to enter on line 5; the line was stepped over (the callee may also need COMPILE DEBUG)";
    invokeMock.mockResolvedValueOnce({ line: "6", terminated: false, stepHint: hint });

    await store.stepIn();

    expect(invokeMock).toHaveBeenNthCalledWith(2, "pl_debug_step_in", { debugId: "d1" });
    const last = lastHistory(store);
    expect(last?.level).toBe("WARN");
    // Backend-authored text: recorded as-is, never re-authored in the store.
    expect(last?.message).toBe(hint);
  });

  it("records no WARN when the hint is absent or an empty string", async () => {
    const store = await startProcedureSession();
    invokeMock.mockResolvedValueOnce({ line: "6", terminated: false }); // 缺失

    await store.stepIn();

    expect(store.history.some((entry) => entry.level === "WARN")).toBe(false);

    invokeMock.mockResolvedValueOnce({ line: "7", terminated: false, stepHint: "" }); // 空串

    await store.stepIn();

    expect(store.history.filter((entry) => entry.message.startsWith("step in")).length).toBe(2);
    expect(store.history.some((entry) => entry.level === "WARN")).toBe(false);
  });
});

describe("resume to end that did not finish (runToEndIncomplete)", () => {
  it("records a WARN carrying the agent's message, with a fallback when it is missing", async () => {
    const store = await startProcedureSession();
    invokeMock.mockResolvedValueOnce({
      line: "30",
      terminated: false,
      runToEndIncomplete: true,
      message: "could not disable breakpoint 7; stopped at line 30",
    });

    await store.resumeIgnoreBreakpoints();

    expect(invokeMock).toHaveBeenNthCalledWith(2, "pl_debug_resume_ignore_breakpoints", { debugId: "d1" });
    const last = lastHistory(store);
    expect(last?.level).toBe("WARN");
    expect(last?.message).toBe("run to end: could not disable breakpoint 7; stopped at line 30");

    invokeMock.mockResolvedValueOnce({ line: "31", terminated: false, runToEndIncomplete: true }); // 无 message

    await store.resumeIgnoreBreakpoints();

    expect(lastHistory(store)?.level).toBe("WARN");
    expect(lastHistory(store)?.message).toBe("run to end: stopped before the program finished");
  });

  it("records no WARN when the flag is false or absent", async () => {
    const store = await startProcedureSession();
    invokeMock.mockResolvedValueOnce({ line: "30", terminated: false, runToEndIncomplete: false });

    await store.resumeIgnoreBreakpoints();

    expect(store.history.some((entry) => entry.level === "WARN")).toBe(false);

    invokeMock.mockResolvedValueOnce({ terminated: true }); // 缺失

    await store.resumeIgnoreBreakpoints();

    expect(store.history.some((entry) => entry.level === "WARN")).toBe(false);
    expect(store.terminated).toBe(true);
  });
});
