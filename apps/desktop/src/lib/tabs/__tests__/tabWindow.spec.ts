import { beforeEach, describe, expect, it, vi } from "vitest";

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
});
