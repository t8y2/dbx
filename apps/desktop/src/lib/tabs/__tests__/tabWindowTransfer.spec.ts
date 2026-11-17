// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeDetachedTabTransfer,
  createTabWindowGroupTransfer,
  decodeTabWindowTransfer,
  encodeTabWindowTransfer,
  isDetachedTabWindow,
  listenForTabWindowTransfer,
  listenForTabWindowInfoRequest,
  listenForTabWindowInfoResponse,
  storeDetachedTabTransfer,
  tabWindowTransferEntries,
  type TabWindowTransferPayload,
} from "@/lib/tabs/tabWindowTransfer";
import type { QueryTab } from "@/types/database";

const bridge = vi.hoisted(() => ({
  listen: vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void) => () => {}),
  invoke: vi.fn(async (_command: string, _args: unknown) => null),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ listen: bridge.listen }) }));

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
  bridge.invoke.mockReset();
});

describe("detached tab window role", () => {
  it("survives consuming the one-time transfer URL token", async () => {
    await storeDetachedTabTransfer(transfer);
    window.history.replaceState(null, "", `/?dbxTransfer=${transfer.transferId}`);

    expect(isDetachedTabWindow()).toBe(true);
    expect((await consumeDetachedTabTransfer())?.transferId).toBe(transfer.transferId);
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
    bridge.listen.mockClear();
    const handler = vi.fn();
    await subscribe(handler);
    expect(bridge.listen).toHaveBeenCalledWith(eventName, expect.any(Function));
    const listener = bridge.listen.mock.calls[0][1];
    listener({ payload: transfer });
    expect(handler).toHaveBeenCalledWith(transfer);
  });

  it("uses the native handoff when separate WebViews do not share localStorage", async () => {
    bridge.invoke.mockImplementation(async (command) => {
      if (command === "load_detached_tab_handoff") return transfer;
      return null;
    });
    window.localStorage.clear();
    window.history.replaceState(null, "", `/?dbxTransfer=${transfer.transferId}`);
    expect((await consumeDetachedTabTransfer())?.transferId).toBe(transfer.transferId);
    expect(bridge.invoke).toHaveBeenCalledWith("load_detached_tab_handoff", { tabId: `dbx-tab-window-transfer:${transfer.transferId}` });
  });
});

describe("group window transfers", () => {
  const first = { ...transfer.tab, mode: "query", originalSql: "", createdAt: 1 } as QueryTab;
  const second = { ...first, id: "tab-2", title: "Query 2", sql: "select 2", pinned: true } as QueryTab;

  it("round-trips ordered tabs and the active tab through the shared transfer", async () => {
    const payload = createTabWindowGroupTransfer([first, second, first], "main", second.id)!;
    const decoded = decodeTabWindowTransfer(encodeTabWindowTransfer(payload))!;
    expect(tabWindowTransferEntries(decoded).map((entry) => entry.tab.id)).toEqual([first.id, second.id]);
    expect(decoded.activeTabId).toBe(second.id);
    expect(decoded.additionalTabs?.[0].liveTab?.sql).toBe(second.sql);
    expect(decoded.additionalTabs?.[0].tab.pinned).toBe(true);
    await storeDetachedTabTransfer(payload);
    window.history.replaceState(null, "", `/?dbxTransfer=${payload.transferId}`);
    expect((await consumeDetachedTabTransfer())?.additionalTabs).toEqual(payload.additionalTabs);
  });

  it("does not create an empty transfer and defaults selection to a group member", () => {
    expect(createTabWindowGroupTransfer([], "main")).toBeNull();
    expect(createTabWindowGroupTransfer([first, second], "main", "other-tab")?.activeTabId).toBe(first.id);
  });

  it.each([{ additionalTabs: [{ tab: { id: "tab-1" } }] }, { additionalTabs: [{ tab: {} }] }, { additionalTabs: "invalid" }, { additionalTabs: [{ tab: { id: "tab-2" }, liveTab: { id: "wrong-tab" } }] }, { additionalTabs: [{ tab: { id: "tab-2" } }], activeTabId: "unrelated-tab" }])(
    "rejects incomplete or ambiguous group payloads: %j",
    (patch) => {
      expect(decodeTabWindowTransfer(JSON.stringify({ ...transfer, ...patch }))).toBeNull();
    },
  );
});
