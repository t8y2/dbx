// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { consumeDetachedTabTransfer, isDetachedTabWindow, storeDetachedTabTransfer, type TabWindowTransferPayload } from "@/lib/tabs/tabWindowTransfer";

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
