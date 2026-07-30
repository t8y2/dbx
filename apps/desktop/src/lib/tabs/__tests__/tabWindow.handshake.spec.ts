// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const mainWindow = {
    label: "main",
    destroy: vi.fn(async () => {}),
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
    mocks.mainWindow.destroy.mockClear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(detached.destroy).toHaveBeenCalledOnce();
  });

  it("never reopens the source owner after the durable commit point", async () => {
    const { prepareTabWindow } = await import("@/lib/tabs/tabWindow");
    const preparation = prepareTabWindow("query-commit", "Query");
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    const detached = mocks.instances[0];
    const visualEvent = [...mocks.listeners.keys()].find((event) => event.includes("-visual-ready-"))!;
    const transferReadyEvent = [...mocks.listeners.keys()].find((event) => event.includes("-transfer-ready-"))!;
    mocks.listeners.get(visualEvent)?.({ payload: {} });
    mocks.listeners.get(transferReadyEvent)?.({ payload: {} });
    const preparedWindow = await preparation;
    const onPrepared = vi.fn(async () => {});
    vi.useFakeTimers();

    const transfer = preparedWindow.transfer(
      {
        tab: {
          id: "query-commit",
          title: "Query",
          connectionId: "connection-1",
          database: "app",
          sql: "select 1",
          mode: "query",
          isExecuting: false,
        },
        activeOutputView: "result",
        selectedSql: "",
        cursorPos: 0,
        explainMode: "explain",
        blockDangerousRedisCommands: true,
        dataGridSnapshots: [],
      },
      { onPrepared },
    );
    await Promise.resolve();
    await Promise.resolve();
    const preparedEvent = [...mocks.listeners.keys()].find((event) => event.includes("-prepared-"))!;
    const transferId = preparedEvent.slice(preparedEvent.lastIndexOf("-") + 1);
    mocks.listeners.get(preparedEvent)?.({ payload: { transferId, ok: true } });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(transfer).resolves.toEqual({ commitAcknowledged: false });
    expect(onPrepared).toHaveBeenCalledOnce();
    expect(mocks.emitTo).toHaveBeenCalledWith(detached.label, expect.stringContaining("-decision-"), expect.objectContaining({ decision: "commit" }));

    await preparedWindow.abort();
    expect(detached.destroy).not.toHaveBeenCalled();
  });

  it("aborts a provisional child when preparation misses the source timeout", async () => {
    const { prepareTabWindow } = await import("@/lib/tabs/tabWindow");
    const preparation = prepareTabWindow("query-timeout", "Query");
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1));
    const detached = mocks.instances[0];
    const visualEvent = [...mocks.listeners.keys()].find((event) => event.includes("-visual-ready-"))!;
    const transferReadyEvent = [...mocks.listeners.keys()].find((event) => event.includes("-transfer-ready-"))!;
    mocks.listeners.get(visualEvent)?.({ payload: {} });
    mocks.listeners.get(transferReadyEvent)?.({ payload: {} });
    const preparedWindow = await preparation;
    vi.useFakeTimers();

    const transfer = preparedWindow
      .transfer({
        tab: {
          id: "query-timeout",
          title: "Query",
          connectionId: "connection-1",
          database: "app",
          sql: "select 1",
          mode: "query",
          isExecuting: false,
        },
        activeOutputView: "result",
        selectedSql: "",
        cursorPos: 0,
        explainMode: "explain",
        blockDangerousRedisCommands: true,
        dataGridSnapshots: [],
      })
      .catch((error) => error);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(transfer).resolves.toMatchObject({
      message: "Detached tab window did not prepare the tab",
    });
    expect(mocks.emitTo).toHaveBeenCalledWith(detached.label, expect.stringContaining("-decision-"), expect.objectContaining({ decision: "abort" }));

    await preparedWindow.abort();
    expect(detached.destroy).toHaveBeenCalledOnce();
  });

  it("keeps the adopted tab provisional until the source commits ownership", async () => {
    window.history.replaceState(null, "", "/?dbxDetachedTransfer=transfer-mongo");
    let finishInitialization!: () => void;
    const initialization = new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    const onReceive = vi.fn(() => () => {});
    const onCommitted = vi.fn();
    const { receiveDetachedTab } = await import("@/lib/tabs/tabWindow");

    const unlisten = await receiveDetachedTab(onReceive, { initialization, onCommitted });
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
      expect(mocks.emitTo).toHaveBeenCalledWith("main", "dbx-detached-tab-prepared-transfer-mongo", {
        transferId: "transfer-mongo",
        ok: true,
      }),
    );
    expect(onCommitted).not.toHaveBeenCalled();

    mocks.listeners.get("dbx-detached-tab-decision-transfer-mongo")?.({
      payload: {
        transferId: "transfer-mongo",
        decision: "commit",
      },
    });
    await vi.waitFor(() => expect(onCommitted).toHaveBeenCalledOnce());
    expect(mocks.emitTo).toHaveBeenCalledWith("main", "dbx-detached-tab-committed-transfer-mongo", {
      transferId: "transfer-mongo",
    });
    unlisten();
  });

  it("recovers a committed detached tab after its WebView reloads", async () => {
    window.history.replaceState(null, "", "/?dbxDetachedTransfer=transfer-reload");
    const firstReceive = vi.fn(() => () => {});
    const firstCommitted = vi.fn();
    const { receiveDetachedTab } = await import("@/lib/tabs/tabWindow");
    const unlistenFirst = await receiveDetachedTab(firstReceive, { onCommitted: firstCommitted });
    const payload = {
      transferId: "transfer-reload",
      tab: {
        id: "query-reload",
        title: "Query",
        connectionId: "connection-1",
        database: "app",
        sql: "select 42",
        mode: "query" as const,
        isExecuting: false,
      },
      activeOutputView: "result" as const,
      selectedSql: "",
      cursorPos: 0,
      explainMode: "explain" as const,
      blockDangerousRedisCommands: true,
      dataGridSnapshots: [],
    };

    mocks.listeners.get("dbx-detached-tab-transfer-transfer-reload")?.({ payload });
    await vi.waitFor(() => expect(firstReceive).toHaveBeenCalledOnce());
    mocks.listeners.get("dbx-detached-tab-decision-transfer-reload")?.({
      payload: {
        transferId: "transfer-reload",
        decision: "commit",
      },
    });
    await vi.waitFor(() => expect(firstCommitted).toHaveBeenCalledOnce());
    unlistenFirst();
    mocks.emitTo.mockClear();

    const recoveredReceive = vi.fn(() => () => {});
    const recoveredCommitted = vi.fn();
    const unlistenRecovered = await receiveDetachedTab(recoveredReceive, {
      onCommitted: recoveredCommitted,
    });

    expect(recoveredReceive).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "transfer-reload",
        tab: expect.objectContaining({
          id: "query-reload",
          sql: "select 42",
          isExecuting: false,
        }),
      }),
    );
    expect(recoveredCommitted).toHaveBeenCalledOnce();
    expect(mocks.emitTo).not.toHaveBeenCalledWith("main", "dbx-detached-tab-transfer-ready-transfer-reload", expect.anything());
    unlistenRecovered();
  });

  it("rolls back provisional adoption before an abort destroys the child", async () => {
    window.history.replaceState(null, "", "/?dbxDetachedTransfer=transfer-abort");
    const rollback = vi.fn(async () => {});
    const onReceive = vi.fn(() => rollback);
    const onCommitted = vi.fn();
    const { receiveDetachedTab } = await import("@/lib/tabs/tabWindow");
    const unlisten = await receiveDetachedTab(onReceive, { onCommitted });

    mocks.listeners.get("dbx-detached-tab-transfer-transfer-abort")?.({
      payload: {
        transferId: "transfer-abort",
        tab: {
          id: "query-abort",
          title: "Query",
          connectionId: "connection-1",
          database: "app",
          sql: "select 1",
          mode: "query",
          isExecuting: false,
        },
        activeOutputView: "result",
        selectedSql: "",
        cursorPos: 0,
        explainMode: "explain",
        blockDangerousRedisCommands: true,
        dataGridSnapshots: [],
      },
    });
    await vi.waitFor(() => expect(onReceive).toHaveBeenCalledOnce());
    mocks.listeners.get("dbx-detached-tab-decision-transfer-abort")?.({
      payload: {
        transferId: "transfer-abort",
        decision: "abort",
      },
    });

    await vi.waitFor(() => expect(rollback).toHaveBeenCalledOnce());
    expect(onCommitted).not.toHaveBeenCalled();
    expect(mocks.mainWindow.destroy).toHaveBeenCalledOnce();
    unlisten();
  });
});
