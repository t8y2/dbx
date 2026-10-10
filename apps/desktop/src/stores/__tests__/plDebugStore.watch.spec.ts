import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F5：监视窗口的 store 层契约。
 *
 * 三件事必须可断言：名字怎么对到当前帧的变量上、不在作用域时状态是什么、行内改值是否
 * 走的是既有 SET_VALUE 通道（frame = 当前帧、index = 0）。值本身不落进 store —— 每次
 * 渲染都从当前帧变量列表解析，所以单步/续跑之后列表还在、值跟着变。
 *
 * pause 不在本特性范围内：DBMS_DEBUG 没有中断原语（只有断点/步进事件，程序只在解释器
 * 入口让出），因此前端也没有 pause 按钮。
 */
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

import { usePlDebugStore } from "@/stores/plDebugStore";
import * as api from "@/lib/backend/pl-debug-tauri";

const plStart = vi.mocked(api.plDebugStart);
const plGetVariables = vi.mocked(api.plDebugGetVariables);
const plSetValue = vi.mocked(api.plDebugSetValue);
const plStepOver = vi.mocked(api.plDebugStepOver);

/** Starts a session on `S.P_DEMO`; frame 0 is the stopped frame. */
async function startSession() {
  plStart.mockResolvedValue({ debugId: "d1", terminated: false, line: "10", program: "P_DEMO" });
  const store = usePlDebugStore();
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" });
  return store;
}

/** The frame reports one scalar with a type, as the Rust `*name*type*value*` parser produces. */
function frameWith(values: Array<{ name: string; value: string; type?: string }>) {
  return { line: "10", terminated: false, variables: values };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  plGetVariables.mockResolvedValue({ variables: [] });
});

describe("watch name matching", () => {
  it("keeps the user's spelling and resolves the value case-insensitively against the frame", async () => {
    const store = await startSession();
    plGetVariables.mockResolvedValue(frameWith([{ name: "P_ID", value: "42", type: "NUMBER" }]));

    store.addWatch("p_id");
    await store.refreshVariables();

    expect(store.watchNames).toEqual(["p_id"]);
    expect(store.watches).toEqual([{ name: "p_id", value: "42", type: "NUMBER", inScope: true }]);
  });

  it("falls back to the last segment of a qualified name", async () => {
    // OceanBase 的 JSON 摊平后是 a.b.c 这样的路径；用户通常只写最后一段。
    const store = await startSession();
    plGetVariables.mockResolvedValue(frameWith([{ name: "S.P_ID.LEAF", value: "'x'", type: "VARCHAR2" }]));

    store.addWatch("LEAF");
    await store.refreshVariables();

    expect(store.watches[0]).toMatchObject({ value: "'x'", inScope: true });
  });

  it("prefers an exact match over the last-segment fallback", async () => {
    const store = await startSession();
    plGetVariables.mockResolvedValue(
      frameWith([
        { name: "NESTED.ID", value: "1" },
        { name: "ID", value: "2" },
      ]),
    );

    store.addWatch("ID");
    await store.refreshVariables();

    expect(store.watches[0]?.value).toBe("2");
  });

  it("ignores blank names and duplicate watch entries", async () => {
    const store = await startSession();

    store.addWatch("   ");
    store.addWatch("P_ID");
    store.addWatch("p_id");
    store.addWatch("  P_ID  ");

    expect(store.watchNames).toEqual(["P_ID"]);
  });

  it("removes exactly the requested row, keeping the others", async () => {
    const store = await startSession();
    store.addWatch("A");
    store.addWatch("B");

    store.removeWatch("A");

    expect(store.watchNames).toEqual(["B"]);
  });
});

describe("watch scope", () => {
  it("reports a name the frame does not contain as out of scope instead of an empty value", async () => {
    const store = await startSession();
    plGetVariables.mockResolvedValue(frameWith([{ name: "P_ID", value: "42", type: "NUMBER" }]));
    store.addWatch("P_ID");
    store.addWatch("V_MISSING");
    await store.refreshVariables();

    expect(store.watches).toEqual([
      { name: "P_ID", value: "42", type: "NUMBER", inScope: true },
      { name: "V_MISSING", value: null, type: null, inScope: false },
    ]);
  });

  it("keeps the list and refreshes the values across a step", async () => {
    const store = await startSession();
    plGetVariables.mockResolvedValue(frameWith([{ name: "V_COUNT", value: "1", type: "NUMBER" }]));
    store.addWatch("V_COUNT");
    await store.refreshVariables();

    plStepOver.mockResolvedValue({ line: "11", terminated: false });
    await store.stepOver();
    await store.refreshVariables();

    expect(store.watchNames).toEqual(["V_COUNT"]);
    expect(plStepOver).toHaveBeenCalledWith("d1");
    // Same one watch row: the list survived, the value was re-read.
    expect(store.watches).toHaveLength(1);
  });

  it("keeps the watch list when the session is closed, like the history", async () => {
    const store = await startSession();
    store.addWatch("P_ID");

    vi.mocked(api.plDebugClose).mockResolvedValue(undefined);
    await store.close();

    expect(store.watchNames).toEqual(["P_ID"]);
  });
});

describe("watch value editing", () => {
  it("assigns through SET_VALUE on the current frame with index 0, then re-reads it", async () => {
    const store = await startSession();
    plGetVariables.mockResolvedValue(frameWith([{ name: "P_ID", value: "42", type: "NUMBER" }]));
    store.addWatch("P_ID");
    await store.refreshVariables();
    plSetValue.mockResolvedValue({});
    plGetVariables.mockResolvedValue(frameWith([{ name: "P_ID", value: "43", type: "NUMBER" }]));

    await store.setWatchValue("P_ID", "43");

    expect(plSetValue).toHaveBeenCalledWith("d1", "P_ID", 0, 0, "43");
    expect(store.watches[0]?.value).toBe("43");
    expect(store.history.some((entry) => entry.message.includes("set P_ID := 43"))).toBe(true);
  });

  it("uses the selected frame, so a caller inspecting another frame edits that one", async () => {
    const store = await startSession();
    plSetValue.mockResolvedValue({});

    await store.setWatchValue("P_ID", "9", 2);

    expect(plSetValue).toHaveBeenCalledWith("d1", "P_ID", 2, 0, "9");
  });

  it("surfaces a failed assignment as the store error and rethrows", async () => {
    const store = await startSession();
    plSetValue.mockRejectedValue(new Error("error_no_such_variable"));

    await expect(store.setWatchValue("P_ID", "9")).rejects.toThrow("error_no_such_variable");
    expect(store.error).toContain("error_no_such_variable");
  });
});
