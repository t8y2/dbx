import { describe, expect, it } from "vitest";
import type { KvGetResponse } from "@/lib/backend/api";
import { decideKvMetadataRefresh, KvListRequestGuard, loadedKvPageCount, mergeKvValueRefresh, removeMissingKvKey, selectedKeyMissingFromCompleteSnapshot, updateKvResponseTtl } from "@/lib/kv/kvMetadataRefresh";

function found(metadata: NonNullable<KvGetResponse["metadata"]>): KvGetResponse {
  return {
    found: true,
    key: "/service",
    value: { encoding: "utf8", data: "value" },
    metadata,
  };
}

describe("decideKvMetadataRefresh", () => {
  it("invalidates an in-flight silent snapshot for every foreground request", () => {
    const guard = new KvListRequestGuard();
    const initialSnapshot = guard.captureSnapshotRevision();

    const firstPageRequest = guard.beginForegroundRequest();
    expect(guard.isSnapshotRevisionCurrent(initialSnapshot)).toBe(false);
    expect(guard.isForegroundRequestCurrent(firstPageRequest)).toBe(true);

    const silentSnapshot = guard.captureSnapshotRevision();
    const loadMoreRequest = guard.beginForegroundRequest();
    expect(guard.isSnapshotRevisionCurrent(silentSnapshot)).toBe(false);
    expect(guard.isForegroundRequestCurrent(firstPageRequest)).toBe(false);
    expect(guard.isForegroundRequestCurrent(loadMoreRequest)).toBe(true);
  });

  it("updates only the TTL when the selected key metadata is unchanged", () => {
    const current = found({ modRevision: 10, lease: 20, ttl: 8, valueSize: 5 });
    const incoming = found({ modRevision: 10, lease: 20, ttl: 7 });

    expect(decideKvMetadataRefresh(current, incoming)).toEqual({ type: "update", ttl: 7 });
  });

  it("reloads the full value when the revision or lease changes", () => {
    const current = found({ modRevision: 10, lease: 20, ttl: 8 });

    expect(decideKvMetadataRefresh(current, found({ modRevision: 11, lease: 20, ttl: 7 }))).toEqual({ type: "reload" });
    expect(decideKvMetadataRefresh(current, found({ modRevision: 10, lease: 21, ttl: 7 }))).toEqual({ type: "reload" });
  });

  it("keeps polling without a full reload while etcd finalizes an expired lease", () => {
    const current = found({ modRevision: 10, lease: 20, ttl: 1 });

    expect(decideKvMetadataRefresh(current, found({ modRevision: 10, lease: 20, ttl: 0 }))).toEqual({ type: "update", ttl: 0 });
    expect(decideKvMetadataRefresh(current, found({ modRevision: 10, lease: 20 }))).toEqual({ type: "reload" });
  });

  it("updates TTL in place without replacing the value response", () => {
    const current = found({ modRevision: 10, lease: 20, ttl: 8 });
    const value = current.value;

    expect(updateKvResponseTtl(current, 7)).toBe(true);
    expect(current.metadata?.ttl).toBe(7);
    expect(current.value).toBe(value);
  });

  it("keeps the existing response during a silent full refresh when only TTL changed", () => {
    const current = found({ modRevision: 10, lease: 20, ttl: 8 });
    const incoming = found({ modRevision: 10, lease: 20, ttl: 7 });

    expect(mergeKvValueRefresh(current, incoming)).toBe(current);
    expect(current.metadata?.ttl).toBe(7);
  });

  it("replaces the response when a silent refresh finds a new value revision", () => {
    const current = found({ modRevision: 10, lease: 20, ttl: 8 });
    const incoming = found({ modRevision: 11, lease: 20, ttl: 7 });
    incoming.value = { encoding: "utf8", data: "updated" };

    expect(mergeKvValueRefresh(current, incoming)).toBe(incoming);
  });

  it("stops and exposes a missing key without reloading", () => {
    expect(decideKvMetadataRefresh(found({ modRevision: 10, lease: 20, ttl: 1 }), { found: false })).toEqual({ type: "notFound" });
  });

  it("stops when a metadata refresh cannot be reconciled with the current value", () => {
    expect(decideKvMetadataRefresh(null, found({ modRevision: 10, lease: 20, ttl: 1 }))).toEqual({ type: "stop" });
  });

  it("removes an expired key from the cached key list", () => {
    const keys = [{ key: "/dbx/a" }, { key: "/dbx/aaaaa" }, { key: "/test/a" }];

    expect(removeMissingKvKey(keys, "/dbx/aaaaa")).toEqual([{ key: "/dbx/a" }, { key: "/test/a" }]);
  });

  it("refreshes every page that the user has already loaded", () => {
    expect(loadedKvPageCount(0, 200)).toBe(1);
    expect(loadedKvPageCount(200, 200)).toBe(1);
    expect(loadedKvPageCount(201, 200)).toBe(2);
    expect(loadedKvPageCount(400, 200)).toBe(2);
  });

  it("only clears a selected key after a complete refreshed snapshot proves it expired", () => {
    const keys = [{ key: "/dbx/a" }];

    expect(selectedKeyMissingFromCompleteSnapshot("/dbx/expired", keys, null)).toBe(true);
    expect(selectedKeyMissingFromCompleteSnapshot("/dbx/expired", keys, "next-page")).toBe(false);
    expect(selectedKeyMissingFromCompleteSnapshot("/dbx/a", keys, null)).toBe(false);
    expect(selectedKeyMissingFromCompleteSnapshot(null, keys, null)).toBe(false);
  });
});
