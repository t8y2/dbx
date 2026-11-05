import { createPinia, disposePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlDebugSnapshot, PlDebugStartIntent } from "@/lib/debug/plDebugProtocol";

/**
 * F2：匿名块调试启动请求的**电文形状**。
 *
 * 这里刻意 mock `@tauri-apps/api/core` 而不是 `pl-debug-tauri`：本测试要证明的是从
 * store 到 Tauri 命令的整条链路上，启动 intent 的 target（匿名块 source，无参数）
 * 与后端契约逐字一致 —— mock 上层包装就看不到 invoke 的实际载荷。
 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [{ id: "conn-1", name: "Fixture" }] }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: { execute: () => Promise<unknown> }) => options.execute() }));

import { invoke } from "@tauri-apps/api/core";
import { usePlDebugStore } from "@/stores/plDebugStore";
import { buildPlDebugAnonymousBlockStartRequest } from "@/lib/debug/plDebugAnonymousBlock";

const invokeMock = vi.mocked(invoke);
let pinia: ReturnType<typeof createPinia>;
let snapshot: PlDebugSnapshot;
let result: unknown;
const confirmation = { riskAccepted: true, expectedConnectionRevision: "epoch:0" };
const receipt = (operationId: string) => ({ serverEpoch: "epoch", sessionId: "d1", operationId, generation: 1, revision: snapshot.revision, state: "succeeded", dispatched: true, result: result ?? snapshot, error: null });

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.clearAllMocks();
  result = undefined;
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  invokeMock.mockImplementation(async (command, args) => {
    const body = args as Record<string, unknown>;
    if (command === "pl_debug_bootstrap") return { serverEpoch: "epoch", heartbeatSeconds: 3600, leaseSeconds: 120, cleanupSeconds: 60 };
    if (command === "pl_debug_start") {
      const start = body.request as PlDebugStartIntent;
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
        line: "1",
      };
      return receipt(start.operationId);
    }
    if (command === "pl_debug_status") return snapshot;
    if (command === "pl_debug_operation") return receipt(String(body.operationId));
    if (command === "pl_debug_set_breakpoints") return [{ owner: "APP", line: 2, breakpointNumber: 7, kind: "ANONYMOUS" }];
    throw new Error(`Unexpected Tauri command ${command}`);
  });
});
afterEach(() => {
  disposePinia(pinia);
  vi.unstubAllGlobals();
});

describe("pl_debug_start for an anonymous block", () => {
  it("passes the anonymous request body through invoke unchanged", async () => {
    const store = usePlDebugStore();
    const request = buildPlDebugAnonymousBlockStartRequest({ schema: "APP", source: "BEGIN\n  NULL;\nEND;" });

    await store.start("conn-1", "db1", request, confirmation);

    expect(invokeMock.mock.calls.filter(([command]) => command === "pl_debug_start")).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("pl_debug_start", { request: expect.objectContaining({ connectionId: "conn-1", database: "db1", riskAccepted: true, target: request }) });
  });

  it("records the anonymous target in the store so the source editor can render the submitted text", async () => {
    const store = usePlDebugStore();

    await store.start("conn-1", "db1", buildPlDebugAnonymousBlockStartRequest({ source: "DECLARE\nBEGIN\n  NULL;\nEND;" }), confirmation);

    expect(store.target).toEqual({ schema: null, objectType: "ANONYMOUS", objectName: null, packageName: null, source: "DECLARE\nBEGIN\n  NULL;\nEND;" });
    expect(store.hasSession).toBe(true);
    expect(store.debugId).toBe("d1");
  });

  it("keeps gutter breakpoints of an anonymous session shaped as the agent expects", async () => {
    // 匿名块的断点没有程序名：只有 kind=ANONYMOUS 与行号（Go agent 走
    // DBX_SET_BREAKPOINT_ANONYMOUS 分支），行号就是提交文本的行号。
    const store = usePlDebugStore();
    await store.start("conn-1", "db1", buildPlDebugAnonymousBlockStartRequest({ source: "BEGIN\n  NULL;\nEND;" }), confirmation);

    await store.toggleBreakpoint(2);

    expect(invokeMock).toHaveBeenLastCalledWith("pl_debug_set_breakpoints", { debugId: "d1", breakpoints: [{ owner: null, name: null, line: 2, kind: "ANONYMOUS" }] });
    expect(store.breakpointLines).toEqual([2]);
  });
});
