import { beforeEach, describe, expect, it, vi } from "vitest";

type CloseRequestPayload = "settings" | "quit" | "window" | { target?: "settings" | "quit" | "window"; windowLabel?: string };

const mocks = vi.hoisted(() => ({
  closeRequestListener: undefined as undefined | ((event: { payload?: CloseRequestPayload }) => void),
  completeWindowClose: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
  windowLabel: "main",
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({
  isTauriRuntime: () => true,
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    desktopSettings: { quit_on_close: false, close_action_prompted: true },
    updateDesktopSettings: vi.fn(),
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  completeWindowClose: mocks.completeWindowClose,
  completeAppClose: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: mocks.windowLabel, listen: mocks.listen }),
}));

describe("useCloseActionPrompt", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.closeRequestListener = undefined;
    mocks.completeWindowClose.mockReset();
    mocks.listen.mockReset();
    mocks.windowLabel = "main";
    mocks.listen.mockImplementation(async (_event, listener) => {
      mocks.closeRequestListener = listener;
      return () => {};
    });
  });

  it("ignores a detached-window close event addressed to another WebView", async () => {
    const { useCloseActionPrompt } = await import("@/composables/useCloseActionPrompt");
    const requestClose = vi.fn();
    const prompt = useCloseActionPrompt({ requestClose });

    prompt.setupCloseActionPromptListener();
    await vi.waitFor(() => expect(mocks.closeRequestListener).toBeTypeOf("function"));
    mocks.closeRequestListener!({ payload: { target: "window", windowLabel: "dbx-tab-1" } });

    expect(requestClose).not.toHaveBeenCalled();
  });

  it("routes a detached-window close event to its owning WebView", async () => {
    mocks.windowLabel = "dbx-tab-1";
    const { useCloseActionPrompt } = await import("@/composables/useCloseActionPrompt");
    const requestClose = vi.fn();
    const prompt = useCloseActionPrompt({ requestClose });

    prompt.setupCloseActionPromptListener();
    await vi.waitFor(() => expect(mocks.closeRequestListener).toBeTypeOf("function"));
    mocks.closeRequestListener!({ payload: { target: "window", windowLabel: "dbx-tab-1" } });

    expect(requestClose).toHaveBeenCalledWith("window");
  });

  it("completes the detached-window flow without invoking app close", async () => {
    const { useCloseActionPrompt } = await import("@/composables/useCloseActionPrompt");
    const prompt = useCloseActionPrompt({ requestClose: vi.fn() });

    await prompt.performCloseAction("window");

    expect(mocks.completeWindowClose).toHaveBeenCalledOnce();
  });
});
