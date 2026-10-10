import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F2：匿名块调试启动请求的**电文形状**。
 *
 * 这里刻意 mock `@tauri-apps/api/core` 而不是 `pl-debug-tauri`：本测试要证明的是从
 * store 到 Tauri 命令的整条链路上，`pl_debug_start` 的参数名（`connectionId` /
 * `database` / `request`）和 request 体（`objectType: "ANONYMOUS"` + `source`，无参数）
 * 与后端契约逐字一致 —— mock 上层包装就看不到 invoke 的实际载荷。
 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { usePlDebugStore } from "@/stores/plDebugStore";
import { buildPlDebugAnonymousBlockStartRequest } from "@/lib/debug/plDebugAnonymousBlock";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  invokeMock.mockResolvedValue({ debugId: "d1", terminated: false });
});

describe("pl_debug_start for an anonymous block", () => {
  it("passes the anonymous request body through invoke unchanged", async () => {
    const store = usePlDebugStore();
    const request = buildPlDebugAnonymousBlockStartRequest({ schema: "APP", source: "BEGIN\n  NULL;\nEND;" });

    await store.start("conn-1", "db1", request);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("pl_debug_start", {
      connectionId: "conn-1",
      database: "db1",
      request: { schema: "APP", objectType: "ANONYMOUS", objectName: null, packageName: null, source: "BEGIN\n  NULL;\nEND;", params: [] },
    });
  });

  it("records the anonymous target in the store so the source editor can render the submitted text", async () => {
    const store = usePlDebugStore();

    await store.start("conn-1", "db1", buildPlDebugAnonymousBlockStartRequest({ source: "DECLARE\nBEGIN\n  NULL;\nEND;" }));

    expect(store.target).toEqual({ schema: null, objectType: "ANONYMOUS", objectName: null, packageName: null, source: "DECLARE\nBEGIN\n  NULL;\nEND;" });
    expect(store.hasSession).toBe(true);
    expect(store.debugId).toBe("d1");
  });

  it("keeps gutter breakpoints of an anonymous session shaped as the agent expects", async () => {
    // 匿名块的断点没有程序名：只有 kind=ANONYMOUS 与行号（Go agent 走
    // DBX_SET_BREAKPOINT_ANONYMOUS 分支），行号就是提交文本的行号。
    const store = usePlDebugStore();
    await store.start("conn-1", "db1", buildPlDebugAnonymousBlockStartRequest({ source: "BEGIN\n  NULL;\nEND;" }));
    invokeMock.mockResolvedValueOnce([{ owner: "APP", line: 2, breakpointNumber: 7, kind: "ANONYMOUS" }]);

    await store.toggleBreakpoint(2);

    expect(invokeMock).toHaveBeenLastCalledWith("pl_debug_set_breakpoints", {
      debugId: "d1",
      breakpoints: [{ owner: null, name: null, line: 2, kind: "ANONYMOUS" }],
    });
    expect(store.breakpointLines).toEqual([2]);
  });
});
