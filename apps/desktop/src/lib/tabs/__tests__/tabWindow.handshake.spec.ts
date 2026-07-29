// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

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
  const emitTo = vi.fn(async () => {});

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

  return { emitTo, FakeWebviewWindow, instances, listeners, mainWindow };
});

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: mocks.emitTo,
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
  beforeEach(() => {
    mocks.emitTo.mockClear();
    mocks.listeners.clear();
    mocks.instances.length = 0;
  });

  it("replaces the retained preview only after the shell is renderable", async () => {
    const { prepareTabWindow } = await import("@/lib/tabs/tabWindow");
    const onWindowShown = vi.fn();
    const preparation = prepareTabWindow("query-1", "Query", { onWindowShown });
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    const detached = mocks.instances[0];
    const visualEvent = [...mocks.listeners.keys()].find((event) => event.includes("-visual-ready-"));
    const transferEvent = [...mocks.listeners.keys()].find((event) => event.includes("-transfer-ready-"));

    expect(visualEvent).toBeTruthy();
    expect(transferEvent).toBeTruthy();
    expect(detached.options.visible).toBe(false);
    expect(detached.show).not.toHaveBeenCalled();

    mocks.listeners.get(visualEvent!)?.({ payload: {} });
    await vi.waitFor(() => expect(detached.show).toHaveBeenCalledOnce());
    expect(onWindowShown).toHaveBeenCalledOnce();

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

  it("announces transfer readiness before core initialization settles", async () => {
    window.history.replaceState(null, "", "/?dbxDetachedTransfer=transfer-mongo");
    let finishInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const onReceive = vi.fn(() => () => {});
    const { receiveDetachedTab } = await import("@/lib/tabs/tabWindow");

    const unlisten = await receiveDetachedTab(onReceive, { initialization });
    expect(mocks.emitTo).toHaveBeenCalledWith("main", "dbx-detached-tab-transfer-ready-transfer-mongo", {
      transferId: "transfer-mongo",
    });

    const transferEvent = "dbx-detached-tab-transfer-transfer-mongo";
    mocks.listeners.get(transferEvent)?.({
      payload: {
        transferId: "transfer-mongo",
        tab: {
          id: "mongo-1",
          title: "orders",
          connectionId: "connection-1",
          database: "analytics",
          sql: "orders",
          isExecuting: false,
          isCancelling: false,
          isExplaining: false,
          mode: "mongo",
        },
        activeOutputView: "result",
        selectedSql: "",
        cursorPos: 0,
        explainMode: "explain",
        blockDangerousRedisCommands: true,
        dataGridSnapshots: [],
      },
    });
    await Promise.resolve();
    expect(onReceive).not.toHaveBeenCalled();

    finishInitialization();
    await vi.waitFor(() => expect(onReceive).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(mocks.emitTo).toHaveBeenCalledWith("main", "dbx-detached-tab-accepted-transfer-mongo", {
        transferId: "transfer-mongo",
        ok: true,
      }),
    );
    unlisten();
  });
});
