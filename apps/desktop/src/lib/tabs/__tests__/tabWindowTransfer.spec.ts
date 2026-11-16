// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeDetachedTabTransfer, isDetachedTabWindow, listenForTabWindowTransfer, listenForTabWindowInfoRequest, listenForTabWindowInfoResponse, storeDetachedTabTransfer, type TabWindowTransferPayload } from "@/lib/tabs/tabWindowTransfer";

const { listen } = vi.hoisted(() => ({ listen: vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void) => () => {}) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ listen }) }));

const transfer: TabWindowTransferPayload = {
  transferId: "detached-transfer",
  sourceWindowLabel: "main",
  tab: {
    id: "tab-1",
    title: "Query 1",
    connectionId: "connection-1",
    database: "db",
    sql: "select 1",
  },
};

afterEach(() => {
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("detached tab window role", () => {
  it("survives consuming the one-time transfer URL token", () => {
    storeDetachedTabTransfer(transfer);
    window.history.replaceState(null, "", `/?dbxTransfer=${transfer.transferId}`);

    expect(isDetachedTabWindow()).toBe(true);
    expect(consumeDetachedTabTransfer()?.transferId).toBe(transfer.transferId);
    expect(window.location.search).not.toContain("dbxTransfer");
    expect(isDetachedTabWindow()).toBe(true);
  });
});

describe("window transfer event routing", () => {
  it.each([
    ["dbx:tab-window-transfer", listenForTabWindowTransfer],
    ["dbx:tab-window-info-request", listenForTabWindowInfoRequest],
    ["dbx:tab-window-info-response", listenForTabWindowInfoResponse],
  ] as const)("scopes %s to the receiving WebView", async (eventName, subscribe) => {
    listen.mockClear();
    const handler = vi.fn();
    await subscribe(handler);
    expect(listen).toHaveBeenCalledWith(eventName, expect.any(Function));
    const listener = listen.mock.calls[0][1];
    listener({ payload: transfer });
    expect(handler).toHaveBeenCalledWith(transfer);
  });
});
