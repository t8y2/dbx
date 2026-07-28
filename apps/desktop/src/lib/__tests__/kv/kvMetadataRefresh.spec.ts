import { describe, expect, it } from "vitest";
import type { KvGetResponse } from "@/lib/backend/api";
import { decideKvMetadataRefresh, hasPositiveKvLease, knownKvLeaseSummaries, KvListRequestGuard, mergeKvKeyMetadata, mergeKvValueRefresh, nextKvLeaseRefreshDelay, removeMissingKvKey, updateKvResponseTtl } from "@/lib/kv/kvMetadataRefresh";

function found(metadata: NonNullable<KvGetResponse["metadata"]>): KvGetResponse {
  return {
    found: true,
    key: "/service",
    value: { encoding: "utf8", data: "value" },
    metadata,
  };
}

describe("decideKvMetadataRefresh", () => {
  it("keeps only the latest foreground request current", () => {
    const guard = new KvListRequestGuard();
    const firstPageRequest = guard.beginForegroundRequest();
    expect(guard.isForegroundRequestCurrent(firstPageRequest)).toBe(true);

    const loadMoreRequest = guard.beginForegroundRequest();
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

  it("tracks only known leased keys and excludes the selected key", () => {
    const keys = [{ key: "/no-lease", lease: 0 }, { key: "/leased", lease: "10" }, { key: "/selected", lease: 20 }, { key: "/unknown" }];

    expect(knownKvLeaseSummaries(keys, "/selected")).toEqual([keys[1]]);
    expect(knownKvLeaseSummaries(keys, null)).toEqual([keys[1], keys[2]]);
  });

  it("excludes only the selected raw-byte identity from lease refresh", () => {
    const keys = [
      { key: "[base64:/w==]", keyIdentity: "ff", lease: 10 },
      { key: "[base64:/w==]", keyIdentity: "5b6261736536343a2f773d3d5d", lease: 20 },
    ];

    expect(knownKvLeaseSummaries(keys, "ff")).toEqual([keys[1]]);
  });

  it("recognizes positive lease IDs in the string-based int64 transport", () => {
    expect(hasPositiveKvLease("9007199254740993")).toBe(true);
    expect(hasPositiveKvLease(10)).toBe(true);
    expect(hasPositiveKvLease("0")).toBe(false);
    expect(hasPositiveKvLease("")).toBe(false);
  });

  it("merges refreshed metadata without replacing the known value size and removes expired keys", () => {
    const keys = [
      { key: "/leased", lease: 10, ttl: 4, valueSize: 12 },
      { key: "/expired", lease: 20, ttl: 1 },
    ];

    expect(mergeKvKeyMetadata(keys, "/leased", found({ lease: 11, ttl: 3, modRevision: 5, valueSize: 0 }))).toEqual([
      { key: "/leased", lease: 11, ttl: 3, modRevision: 5, valueSize: 12 },
      { key: "/expired", lease: 20, ttl: 1 },
    ]);
    expect(mergeKvKeyMetadata(keys, "/expired", { found: false })).toEqual([{ key: "/leased", lease: 10, ttl: 4, valueSize: 12 }]);
  });

  it("refreshes and removes only the matching raw-byte identity when display keys collide", () => {
    const keys = [
      { key: "[base64:/w==]", keyIdentity: "ff", lease: 10, ttl: 4, valueSize: 12 },
      { key: "[base64:/w==]", keyIdentity: "5b6261736536343a2f773d3d5d", lease: 20, ttl: 8, valueSize: 24 },
    ];

    expect(mergeKvKeyMetadata(keys, "[base64:/w==]", found({ lease: 11, ttl: 3, modRevision: 5 }), "ff")).toEqual([{ key: "[base64:/w==]", keyIdentity: "ff", lease: 11, ttl: 3, modRevision: 5, valueSize: 12 }, keys[1]]);
    expect(removeMissingKvKey(keys, "[base64:/w==]", "ff")).toEqual([keys[1]]);
  });

  it("backs off after failures and resets after a successful cycle", () => {
    expect(nextKvLeaseRefreshDelay(2000, true)).toBe(4000);
    expect(nextKvLeaseRefreshDelay(4000, true)).toBe(8000);
    expect(nextKvLeaseRefreshDelay(16000, true)).toBe(30000);
    expect(nextKvLeaseRefreshDelay(30000, true)).toBe(30000);
    expect(nextKvLeaseRefreshDelay(16000, false)).toBe(2000);
  });
});
