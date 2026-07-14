import { beforeEach, describe, expect, it, vi } from "vitest";

const { tauriInvoke } = vi.hoisted(() => ({ tauriInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

import { invoke, productionWriteAuthorizationHeaders, productionWriteRequestDigest, withProductionWriteAuthorization, type ProductionWriteAuthorization } from "../productionWriteAuthorization";

function authorization(token: string, digest: string): ProductionWriteAuthorization {
  return { token, operation: "redisSetString", requestDigest: digest };
}

describe("production write authorization transport", () => {
  beforeEach(() => {
    tauriInvoke.mockReset();
    tauriInvoke.mockResolvedValue(undefined);
  });

  it("creates stable request digests independent of object key order", async () => {
    const first = await productionWriteRequestDigest("redisSetString", ["conn", 0, { value: "next", ttl: 30 }]);
    const second = await productionWriteRequestDigest("redisSetString", ["conn", 0, { ttl: 30, value: "next" }]);
    const different = await productionWriteRequestDigest("redisSetString", ["conn", 0, { value: "other", ttl: 30 }]);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(different).not.toBe(first);
  });

  it("captures each concurrent Tauri authorization before restoring the ambient context", async () => {
    const first = authorization("first-token", "a".repeat(64));
    const second = authorization("second-token", "b".repeat(64));

    await Promise.all([withProductionWriteAuthorization(first, () => invoke("redis_set_string", { connectionId: "conn", value: "first" })), withProductionWriteAuthorization(second, () => invoke("redis_set_string", { connectionId: "conn", value: "second" }))]);

    expect(tauriInvoke).toHaveBeenNthCalledWith(1, "redis_set_string", {
      connectionId: "conn",
      value: "first",
      productionWriteAuthorization: first,
    });
    expect(tauriInvoke).toHaveBeenNthCalledWith(2, "redis_set_string", {
      connectionId: "conn",
      value: "second",
      productionWriteAuthorization: second,
    });
    expect(productionWriteAuthorizationHeaders()).toEqual({});
  });

  it("exposes all HTTP headers only while the mutation transport starts", async () => {
    const current = authorization("single-token", "c".repeat(64));
    const captured = await withProductionWriteAuthorization(current, async () => productionWriteAuthorizationHeaders());

    expect(captured).toEqual({
      "X-DBX-Production-Write-Token": current.token,
      "X-DBX-Production-Write-Operation": current.operation,
      "X-DBX-Production-Write-Digest": current.requestDigest,
    });
    expect(productionWriteAuthorizationHeaders()).toEqual({});
  });
});
