// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMcpUpdateBadge } from "@/composables/useMcpUpdateBadge";
import { beginMcpStatusRequest } from "@/lib/mcp/mcpUpdateStatus";
import type { McpServerStatus } from "@/lib/backend/tauri";

const apiMock = vi.hoisted(() => ({
  checkMcpServerStatus: vi.fn<() => Promise<McpServerStatus>>(),
}));

vi.mock("@/lib/backend/api", () => apiMock);

const mockedCheck = apiMock.checkMcpServerStatus;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeStatus(update_available: boolean, overrides: Partial<McpServerStatus> = {}): McpServerStatus {
  return {
    installed: true,
    npm_available: true,
    node_path: null,
    node_version: null,
    current_version: "1.0.0",
    latest_version: "1.0.0",
    update_available,
    bin_path: null,
    native_bin_path: null,
    script_path: null,
    data_dir: null,
    install_command: "",
    update_command: "",
    error: null,
    ...overrides,
  };
}

function makeBadge(enabled = true, isDesktop = true) {
  return useMcpUpdateBadge({
    isDesktop,
    updateNotificationsEnabled: () => enabled,
  });
}

beforeEach(() => {
  mockedCheck.mockReset();
});

describe("useMcpUpdateBadge", () => {
  it("更新通知关闭时不发起检查", async () => {
    const badge = makeBadge(false);
    await badge.refreshMcpUpdateStatus();
    expect(mockedCheck).not.toHaveBeenCalled();
    expect(badge.mcpUpdateAvailable.value).toBe(false);
  });

  it("update_available 为真时置亮红点", async () => {
    mockedCheck.mockResolvedValue(makeStatus(true));
    const badge = makeBadge(true);
    await badge.refreshMcpUpdateStatus();
    expect(badge.mcpUpdateAvailable.value).toBe(true);
  });

  it("更新后通过事件 payload 清除红点", () => {
    const badge = makeBadge(true);
    badge.applyMcpStatus(true);
    expect(badge.mcpUpdateAvailable.value).toBe(true);
    badge.handleMcpStatusChanged(new CustomEvent("dbx:mcp-status-changed", { detail: { updateAvailable: false } }));
    expect(badge.mcpUpdateAvailable.value).toBe(false);
  });

  it("乱序响应保护：旧请求晚返回不覆盖新结果", async () => {
    const pending = deferred<McpServerStatus>();
    mockedCheck.mockReturnValueOnce(pending.promise);
    const badge = makeBadge(true);
    const refreshA = badge.refreshMcpUpdateStatus();
    // 用户升级，事件回传 false，使在途的请求 A 失效
    badge.handleMcpStatusChanged(new CustomEvent("dbx:mcp-status-changed", { detail: { updateAvailable: false } }));
    expect(badge.mcpUpdateAvailable.value).toBe(false);
    // 旧请求 A 晚返回 true（升级前的状态），必须被忽略
    pending.resolve(makeStatus(true));
    await refreshA;
    expect(badge.mcpUpdateAvailable.value).toBe(false);
  });

  it("忽略早于当前根组件请求的设置页事件", async () => {
    const settingsRequestId = beginMcpStatusRequest();
    const pending = deferred<McpServerStatus>();
    mockedCheck.mockReturnValueOnce(pending.promise);
    const badge = makeBadge(true);
    const refresh = badge.refreshMcpUpdateStatus();

    badge.handleMcpStatusChanged(new CustomEvent("dbx-mcp-status-changed", { detail: { updateAvailable: true, requestId: settingsRequestId } }));
    expect(badge.mcpUpdateAvailable.value).toBe(false);

    pending.resolve(makeStatus(true));
    await refresh;
    expect(badge.mcpUpdateAvailable.value).toBe(true);
  });

  it("registry 结果未知时保留已知红点", async () => {
    mockedCheck.mockResolvedValue(makeStatus(false, { latest_version: null }));
    const badge = makeBadge(true);
    badge.applyMcpStatus(true);

    await badge.refreshMcpUpdateStatus();

    expect(badge.mcpUpdateAvailable.value).toBe(true);
  });

  it("Web 端（非桌面）不发起检查", async () => {
    const badge = makeBadge(true, false);
    await badge.refreshMcpUpdateStatus();
    expect(mockedCheck).not.toHaveBeenCalled();
    expect(badge.mcpUpdateAvailable.value).toBe(false);
  });

  it("无 payload 的事件回退到重新检查", async () => {
    mockedCheck.mockResolvedValue(makeStatus(true));
    const badge = makeBadge(true);
    badge.handleMcpStatusChanged(new CustomEvent("dbx:mcp-status-changed"));
    await vi.waitFor(() => expect(badge.mcpUpdateAvailable.value).toBe(true));
  });
});
