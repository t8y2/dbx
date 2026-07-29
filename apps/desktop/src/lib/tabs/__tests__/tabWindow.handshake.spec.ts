// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const mainWindow = {
    label: "main",
    listen: vi.fn(async (event: string, listener: (event: { payload: unknown }) => void) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    }),
  };
  const instances: FakeWebviewWindow[] = [];

  class FakeWebviewWindow {
    static getByLabel = vi.fn(async () => null);
    readonly show = vi.fn(async () => {});
    readonly close = vi.fn(async () => {});
    readonly destroy = vi.fn(async () => {});
    readonly setFocus = vi.fn(async () => {});

    constructor(
      readonly label: string,
      readonly options: Record<string, unknown>,
    ) {
      instances.push(this);
    }

    async once(event: string, listener: (event: { payload: unknown }) => void) {
      if (event === "tauri://created") queueMicrotask(() => listener({ payload: null }));
      return () => {};
    }
  }

  return { FakeWebviewWindow, instances, listeners, mainWindow };
});

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: vi.fn(async () => []),
  getCurrentWebviewWindow: () => mocks.mainWindow,
  WebviewWindow: mocks.FakeWebviewWindow,
}));

vi.mock("@/lib/backend/tauriRuntime", () => ({
  isTauriRuntime: () => true,
}));

describe("detached tab startup handshake", () => {
  it("shows the shell before waiting for the full transfer receiver", async () => {
    const { prepareTabWindow } = await import("@/lib/tabs/tabWindow");
    const preparation = prepareTabWindow("query-1", "Query");
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    const detached = mocks.instances[0];
    const shellEvent = [...mocks.listeners.keys()].find((event) => event.includes("-shell-ready-"));
    const transferEvent = [...mocks.listeners.keys()].find((event) => event.includes("-transfer-ready-"));

    expect(shellEvent).toBeTruthy();
    expect(transferEvent).toBeTruthy();
    expect(detached.options.visible).toBe(false);

    mocks.listeners.get(shellEvent!)?.({ payload: {} });
    await vi.waitFor(() => expect(detached.show).toHaveBeenCalledOnce());

    let transferReceiverReady = false;
    void preparation.then(() => {
      transferReceiverReady = true;
    });
    await Promise.resolve();
    expect(transferReceiverReady).toBe(false);

    mocks.listeners.get(transferEvent!)?.({ payload: {} });
    const prepared = await preparation;

    expect(transferReceiverReady).toBe(true);
    await prepared.abort();
    expect(detached.close).toHaveBeenCalledOnce();
  });
});
