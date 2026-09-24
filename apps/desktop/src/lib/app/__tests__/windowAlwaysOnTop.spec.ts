import { afterEach, describe, expect, it, vi } from "vitest";
import { emitWindowAlwaysOnTopChanged, pinDetachedWindowIfMainPinned, raiseDetachedWindowsAboveMain, WINDOW_ALWAYS_ON_TOP_CHANGED_EVENT } from "../windowAlwaysOnTop";

const mocks = vi.hoisted(() => ({
  getByLabel: vi.fn(),
  getAllWebviewWindows: vi.fn(),
  isTauriRuntime: vi.fn(() => true),
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.isTauriRuntime() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: mocks.getByLabel },
  getAllWebviewWindows: mocks.getAllWebviewWindows,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...args: unknown[]) => mocks.emit(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
  mocks.isTauriRuntime.mockReturnValue(true);
  mocks.emit.mockResolvedValue(undefined);
});

describe("windowAlwaysOnTop", () => {
  it("pins a detached window when the main window is already on top", async () => {
    const setAlwaysOnTop = vi.fn().mockResolvedValue(undefined);
    mocks.getByLabel.mockResolvedValue({ isAlwaysOnTop: async () => true });
    await pinDetachedWindowIfMainPinned({ label: "detached-tab-one", setAlwaysOnTop });
    expect(setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(mocks.emit).toHaveBeenCalledWith(WINDOW_ALWAYS_ON_TOP_CHANGED_EVENT, {
      windowLabel: "detached-tab-one",
      alwaysOnTop: true,
    });
  });

  it("does not pin a detached window when the main window is not on top", async () => {
    const setAlwaysOnTop = vi.fn().mockResolvedValue(undefined);
    mocks.getByLabel.mockResolvedValue({ isAlwaysOnTop: async () => false });
    await pinDetachedWindowIfMainPinned({ label: "detached-tab-one", setAlwaysOnTop });
    expect(setAlwaysOnTop).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("does not emit when the pinned detached window has no label", async () => {
    const setAlwaysOnTop = vi.fn().mockResolvedValue(undefined);
    mocks.getByLabel.mockResolvedValue({ isAlwaysOnTop: async () => true });
    await pinDetachedWindowIfMainPinned({ setAlwaysOnTop });
    expect(setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("raises only detached-tab windows when pinning the main host", async () => {
    const detached = {
      label: "detached-tab-one",
      setAlwaysOnTop: vi.fn().mockResolvedValue(undefined),
      show: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    };
    const other = {
      label: "main",
      setAlwaysOnTop: vi.fn(),
      show: vi.fn(),
      setFocus: vi.fn(),
    };
    mocks.getAllWebviewWindows.mockResolvedValue([other, detached]);
    await raiseDetachedWindowsAboveMain();
    expect(detached.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(detached.show).toHaveBeenCalledOnce();
    expect(detached.setFocus).toHaveBeenCalledOnce();
    expect(other.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith(WINDOW_ALWAYS_ON_TOP_CHANGED_EVENT, {
      windowLabel: "detached-tab-one",
      alwaysOnTop: true,
    });
  });

  it("emits always-on-top changes for a window label", async () => {
    await emitWindowAlwaysOnTopChanged("detached-tab-two", true);
    expect(mocks.emit).toHaveBeenCalledWith(WINDOW_ALWAYS_ON_TOP_CHANGED_EVENT, {
      windowLabel: "detached-tab-two",
      alwaysOnTop: true,
    });
  });
});
