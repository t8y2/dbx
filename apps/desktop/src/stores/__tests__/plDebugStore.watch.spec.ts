import { createPinia, disposePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";
import type { PlDebugStatus } from "@/lib/backend/pl-debug-tauri";

/**
 * F5：监视窗口的 store 层契约。
 *
 * 监视名原样送到专用 value 读取，显示原生返回的值/作用域；改值经原操作回执执行。
 * 这里的字典夹具模拟 Agent 名称解析，不将前端显示测试当作原生名称解析证据。
 *
 * pause 不在本特性范围内：DBMS_DEBUG 没有中断原语（只有断点/步进事件，程序只在解释器
 * 入口让出），因此前端也没有 pause 按钮。
 */
vi.mock("@/lib/backend/api", () => ({ plDebugBootstrap: vi.fn(), plDebugStart: vi.fn(), plDebugOperation: vi.fn(), plDebugStatus: vi.fn(), plDebugOperate: vi.fn(), plDebugRead: vi.fn() }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [{ id: "c1", name: "Fixture" }] }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: { execute: () => Promise<unknown> }) => options.execute() }));

import { usePlDebugStore } from "@/stores/plDebugStore";
import * as api from "@/lib/backend/api";

const plGetVariables = vi.fn<() => Promise<{ variables: Array<{ name: string; value: string; type?: string }> }>>();
const plSetValue = vi.fn<() => Promise<Record<string, unknown>>>();
const plStepOver = vi.fn<() => Promise<PlDebugStatus>>();
let snapshot: PlDebugSnapshot;
let pinia: ReturnType<typeof createPinia>;
let operationResult: unknown;
const receipt = (operationId: string) => ({ serverEpoch: "epoch", sessionId: "d1", operationId, generation: 1, revision: snapshot.revision, state: "succeeded" as const, dispatched: true, result: operationResult ?? snapshot, error: null });

/** Starts a session on `S.P_DEMO`; frame 0 is the stopped frame. */
async function startSession() {
  const store = usePlDebugStore();
  await store.start("c1", "ob", { schema: "S", objectType: "PROCEDURE", objectName: "P_DEMO" }, { riskAccepted: true, expectedConnectionRevision: "epoch:0" });
  return store;
}

/** Values returned by the simulated Agent dictionary. */
function frameWith(values: Array<{ name: string; value: string; type?: string }>) {
  return { line: "10", terminated: false, variables: values };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  operationResult = undefined;
  plGetVariables.mockResolvedValue({ variables: [] });
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
      line: "10",
    };
    return receipt(start.operationId);
  });
  vi.mocked(api.plDebugOperation).mockImplementation(async (_reference, operationId) => receipt(operationId));
  vi.mocked(api.plDebugStatus).mockImplementation(async () => snapshot);
  vi.mocked(api.plDebugOperate).mockImplementation(async (request) => {
    if (request.action === "step_over") {
      const next = await plStepOver();
      snapshot = { ...snapshot, line: next.line, revision: snapshot.revision + 1, stopRevision: Number(snapshot.stopRevision) + 1 };
    } else if (request.action === "set_value") operationResult = await plSetValue();
    else if (request.action === "close") snapshot = { ...snapshot, revision: snapshot.revision + 1, state: "ended", executionStopped: true, runtimeExited: true, releaseState: "released" };
    else throw new Error(`Unexpected operation ${request.action}`);
    return receipt(request.operationId);
  });
  vi.mocked(api.plDebugRead).mockImplementation(async (request) => {
    const { variables } = await plGetVariables();
    if (request.kind === "variables") return { stopRevision: snapshot.stopRevision, variables: variables.map((variable) => ({ ...variable, state: "value" })) };
    if (request.kind !== "value") throw new Error(`Unexpected read ${request.kind}`);
    const name = String(request.params?.name);
    const found = variables.find((variable) => variable.name.toUpperCase() === name.toUpperCase()) ?? variables.find((variable) => variable.name.split(".").at(-1)?.toUpperCase() === name.toUpperCase());
    return { stopRevision: snapshot.stopRevision, variable: found ? { ...found, state: "value" } : { name, state: "out_of_scope", value: null } };
  });
});
afterEach(() => {
  disposePinia(pinia);
  vi.unstubAllGlobals();
});

describe("watch name matching", () => {
  it("keeps the user's spelling and resolves the value case-insensitively against the frame", async () => {
    const store = await startSession();
    plGetVariables.mockResolvedValue(frameWith([{ name: "P_ID", value: "42", type: "NUMBER" }]));

    store.addWatch("p_id");
    await store.refreshVariables();

    expect(store.watchNames).toEqual(["p_id"]);
    expect(api.plDebugRead).toHaveBeenCalledWith(expect.objectContaining({ kind: "value", params: { name: "p_id", frame: 0 } }));
    expect(store.watches).toMatchObject([{ name: "p_id", value: "42", type: "NUMBER", inScope: true }]);
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
      { name: "P_ID", value: "42", type: "NUMBER", inScope: true, state: "value", message: null },
      { name: "V_MISSING", value: null, type: null, inScope: false, state: "out_of_scope", message: null },
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
    expect(api.plDebugOperate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "d1", action: "step_over" }));
    // Same one watch row: the list survived, the value was re-read.
    expect(store.watches).toHaveLength(1);
  });

  it("keeps the watch list when the session is closed, like the history", async () => {
    const store = await startSession();
    store.addWatch("P_ID");

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

    expect(api.plDebugOperate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "d1", action: "set_value", params: expect.objectContaining({ name: "P_ID", frame: 0, index: 0, value: "43" }) }));
    expect(store.watches[0]?.value).toBe("43");
    expect(store.history.some((entry) => entry.message.includes("set P_ID := 43"))).toBe(true);
  });

  it("uses the selected frame, so a caller inspecting another frame edits that one", async () => {
    const store = await startSession();
    plSetValue.mockResolvedValue({});

    await store.selectFrame(2);
    await store.setWatchValue("P_ID", "9", 2);

    expect(api.plDebugOperate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "d1", action: "set_value", params: expect.objectContaining({ name: "P_ID", frame: 2, index: 0, value: "9" }) }));
  });

  it("surfaces a failed assignment as the store error and rethrows", async () => {
    const store = await startSession();
    plSetValue.mockRejectedValue(new Error("error_no_such_variable"));

    await expect(store.setWatchValue("P_ID", "9")).rejects.toThrow("error_no_such_variable");
    expect(store.error).toContain("error_no_such_variable");
  });
});
