import { describe, expect, it } from "vitest";
import { normalizeDetachedTabRuntime, type DetachedTabRuntimeState } from "@/lib/app/detachedTabHandoff";

describe("normalizeDetachedTabRuntime", () => {
  it("migrates a legacy-only oracleTxnPossiblyDirty key to txnPossiblyDirty", () => {
    // Detached handoffs persist to disk, so payloads written by pre-#9018
    // builds can still carry the old key; the sticky dirty bit must survive.
    const runtime: DetachedTabRuntimeState = { oracleTxnPossiblyDirty: true };
    expect(normalizeDetachedTabRuntime(runtime)).toEqual({ txnPossiblyDirty: true });
  });

  it("prefers the renamed key when both are present", () => {
    const runtime: DetachedTabRuntimeState = { txnPossiblyDirty: false, oracleTxnPossiblyDirty: true };
    expect(normalizeDetachedTabRuntime(runtime)).toEqual({ txnPossiblyDirty: false });
  });

  it("keeps a legacy clean bit as clean", () => {
    const runtime: DetachedTabRuntimeState = { txnSessionId: "txn-1", oracleTxnPossiblyDirty: false };
    expect(normalizeDetachedTabRuntime(runtime)).toEqual({ txnSessionId: "txn-1", txnPossiblyDirty: false });
  });

  it("leaves runtimes without either key untouched", () => {
    expect(normalizeDetachedTabRuntime({ txnSessionId: "txn-1" })).toEqual({ txnSessionId: "txn-1" });
  });
});
