import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let statusListener: ((event: { payload: { requestId: string; windowLabel: string; dirty: boolean } }) => void) | undefined;
  const unlisten = vi.fn();
  const mainWindow = {
    label: "main",
    show: vi.fn(async () => {}),
    setFocus: vi.fn(async () => {}),
    listen: vi.fn(async (_event: string, listener: typeof statusListener) => {
      statusListener = listener;
      return unlisten;
    }),
  };
  const detachedWindows = [{ label: "detached-tab-query-1" }, { label: "detached-tab-query-2" }];
  const getAllWebviewWindows = vi.fn(async () => detachedWindows);
  const emitTo = vi.fn(async (label: string, _event: string, payload: { requestId: string }) => {
    statusListener?.({
      payload: {
        requestId: payload.requestId,
        windowLabel: label,
        dirty: label === "detached-tab-query-2",
      },
    });
  });
  return { detachedWindows, emitTo, getAllWebviewWindows, mainWindow, unlisten };
});

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: mocks.emitTo,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: mocks.getAllWebviewWindows,
  getCurrentWebviewWindow: vi.fn(() => mocks.mainWindow),
  WebviewWindow: class {
    static getByLabel = vi.fn(async (label: string) => (label === "main" ? mocks.mainWindow : null));
  },
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
    mocks.mainWindow.show.mockClear();
    mocks.mainWindow.setFocus.mockClear();
    mocks.getAllWebviewWindows.mockReset();
    mocks.getAllWebviewWindows.mockResolvedValue(mocks.detachedWindows);
  });

  it("notifies the main window when the detached shell is renderable", async () => {
    vi.stubGlobal("window", { location: { search: "?dbxDetachedTransfer=transfer-1" } });
    const { notifyDetachedWindowVisualReady } = await import("@/lib/tabs/tabWindow");

    await notifyDetachedWindowVisualReady();

    expect(mocks.emitTo).toHaveBeenCalledWith("main", "dbx-detached-tab-visual-ready-transfer-1", {
      transferId: "transfer-1",
    });
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

  it("does not treat a detached-window enumeration failure as an empty list", async () => {
    mocks.getAllWebviewWindows.mockRejectedValueOnce(new Error("window enumeration failed"));
    const { listDetachedTabWindowLabels } = await import("@/lib/tabs/tabWindow");

    await expect(listDetachedTabWindowLabels()).rejects.toThrow("window enumeration failed");
  });

  it("forwards main-only actions without loading their UI in the detached window", async () => {
    vi.stubGlobal("window", { location: { search: "?dbxDetachedTransfer=transfer-1" } });
    const { requestDetachedTabMainWindowAction } = await import("@/lib/tabs/tabWindow");

    await requestDetachedTabMainWindowAction({ type: "open-settings", initialTab: "editor" });

    expect(mocks.mainWindow.show).toHaveBeenCalledOnce();
    expect(mocks.mainWindow.setFocus).toHaveBeenCalledOnce();
    expect(mocks.emitTo).toHaveBeenCalledWith("main", "dbx-detached-tab-main-window-action", {
      type: "open-settings",
      initialTab: "editor",
    });
  });

  it("waits for detached persistence before reporting a clean close status", async () => {
    vi.stubGlobal("window", { location: { search: "?dbxDetachedTransfer=transfer-1" } });
    let finishCheck!: (dirty: boolean) => void;
    const hasDirtyTabs = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishCheck = resolve;
        }),
    );
    const { listenForDetachedAppCloseChecks } = await import("@/lib/tabs/tabWindow");
    await listenForDetachedAppCloseChecks(hasDirtyTabs);
    const listener = mocks.mainWindow.listen.mock.calls.at(-1)?.[1];
    mocks.emitTo.mockImplementationOnce(async () => {});

    const handling = listener?.({ payload: { requestId: "close-1" } });
    await Promise.resolve();
    expect(mocks.emitTo).not.toHaveBeenCalled();

    finishCheck(false);
    await handling;

    expect(mocks.emitTo).toHaveBeenCalledWith("main", "dbx-detached-tab-app-close-status", {
      requestId: "close-1",
      windowLabel: "main",
      dirty: false,
    });
  });

  it("reports the detached window as dirty when its close check fails", async () => {
    vi.stubGlobal("window", { location: { search: "?dbxDetachedTransfer=transfer-1" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { listenForDetachedAppCloseChecks } = await import("@/lib/tabs/tabWindow");
    await listenForDetachedAppCloseChecks(async () => {
      throw new Error("persistence failed");
    });
    const listener = mocks.mainWindow.listen.mock.calls.at(-1)?.[1];
    mocks.emitTo.mockImplementationOnce(async () => {});

    await listener?.({ payload: { requestId: "close-2" } });

    expect(mocks.emitTo).toHaveBeenCalledWith("main", "dbx-detached-tab-app-close-status", {
      requestId: "close-2",
      windowLabel: "main",
      dirty: true,
    });
    expect(warn).toHaveBeenCalledWith("[DBX][detached-tab:app-close-check:error]", expect.any(Error));
    warn.mockRestore();
  });

  it("opens the dirty confirmation only after the main window explicitly requests it", async () => {
    vi.stubGlobal("window", { location: { search: "?dbxDetachedTransfer=transfer-1" } });
    const onDirtyPrompt = vi.fn();
    const { listenForDetachedAppCloseChecks } = await import("@/lib/tabs/tabWindow");
    await listenForDetachedAppCloseChecks(() => true, onDirtyPrompt);
    const listener = mocks.mainWindow.listen.mock.calls.at(-1)?.[1];
    mocks.emitTo.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {});

    await listener?.({ payload: { requestId: "close-check" } });
    expect(onDirtyPrompt).not.toHaveBeenCalled();

    await listener?.({ payload: { requestId: "close-prompt", prompt: true } });
    expect(onDirtyPrompt).toHaveBeenCalledOnce();
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
