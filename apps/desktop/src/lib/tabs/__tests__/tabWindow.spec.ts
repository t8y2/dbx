import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let statusListener: ((event: { payload: { requestId: string; windowLabel: string; dirty: boolean } }) => void) | undefined;
  const unlisten = vi.fn();
  const mainWindow = {
    label: "main",
    listen: vi.fn(async (_event: string, listener: typeof statusListener) => {
      statusListener = listener;
      return unlisten;
    }),
  };
  const detachedWindows = [{ label: "detached-tab-query-1" }, { label: "detached-tab-query-2" }];
  const emitTo = vi.fn(async (label: string, _event: string, payload: { requestId: string }) => {
    statusListener?.({
      payload: {
        requestId: payload.requestId,
        windowLabel: label,
        dirty: label === "detached-tab-query-2",
      },
    });
  });
  return { detachedWindows, emitTo, mainWindow, unlisten };
});

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: mocks.emitTo,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: vi.fn(async () => mocks.detachedWindows),
  getCurrentWebviewWindow: vi.fn(() => mocks.mainWindow),
  WebviewWindow: class {},
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({
  isTauriRuntime: () => true,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("detached tab app close checks", () => {
  beforeEach(() => {
    mocks.emitTo.mockClear();
    mocks.mainWindow.listen.mockClear();
    mocks.unlisten.mockClear();
  });

  it("collects dirty detached windows before allowing app exit", async () => {
    const { checkDetachedWindowsBeforeAppClose } = await import("@/lib/tabs/tabWindow");

    const result = await checkDetachedWindowsBeforeAppClose();

    expect(result).toEqual({
      dirtyWindowLabels: ["detached-tab-query-2"],
      unresponsiveWindowLabels: [],
    });
    expect(mocks.emitTo).toHaveBeenCalledTimes(2);
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("notifies the main window as soon as the detached shell is mounted", async () => {
    vi.stubGlobal("window", { location: { search: "?dbxDetachedTransfer=transfer-1" } });
    const { notifyDetachedWindowShellReady } = await import("@/lib/tabs/tabWindow");

    await notifyDetachedWindowShellReady();

    expect(mocks.emitTo).toHaveBeenCalledWith("main", "dbx-detached-tab-shell-ready-transfer-1", {
      transferId: "transfer-1",
    });
  });
});

describe("detached tab window cleanup", () => {
  it("destroys the window after cleanup completes", async () => {
    const { destroyDetachedWindowAfterCleanup } = await import("@/lib/tabs/tabWindow");
    const target = { destroy: vi.fn(async () => {}) };

    const outcome = await destroyDetachedWindowAfterCleanup(target, async () => {});

    expect(outcome).toEqual({ status: "completed" });
    expect(target.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the window when cleanup fails", async () => {
    const { destroyDetachedWindowAfterCleanup } = await import("@/lib/tabs/tabWindow");
    const target = { destroy: vi.fn(async () => {}) };
    const error = new Error("cleanup failed");

    const outcome = await destroyDetachedWindowAfterCleanup(target, async () => {
      throw error;
    });

    expect(outcome).toEqual({ status: "failed", error });
    expect(target.destroy).toHaveBeenCalledOnce();
  });

  it("destroys the window when cleanup does not settle before the deadline", async () => {
    vi.useFakeTimers();
    const { destroyDetachedWindowAfterCleanup } = await import("@/lib/tabs/tabWindow");
    const target = { destroy: vi.fn(async () => {}) };

    const outcomePromise = destroyDetachedWindowAfterCleanup(target, () => new Promise<void>(() => {}), 100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(outcomePromise).resolves.toEqual({ status: "timed-out", timeoutMs: 100 });
    expect(target.destroy).toHaveBeenCalledOnce();
  });
});
