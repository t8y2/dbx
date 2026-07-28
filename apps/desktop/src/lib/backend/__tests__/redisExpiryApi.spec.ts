import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

describe("Redis expiry Tauri API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("invokes EXPIREAT with the Unix timestamp", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const { redisSetExpireAt } = await import("@/lib/backend/tauri");

    await redisSetExpireAt("redis-1", 2, "c2Vzc2lvbg==", 1_735_689_600);

    expect(mocks.invoke).toHaveBeenCalledWith("redis_set_expire_at", {
      connectionId: "redis-1",
      db: 2,
      keyRaw: "c2Vzc2lvbg==",
      expireAt: 1_735_689_600,
    });
  });

  it("forwards relative TTL and persist values unchanged", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const { redisSetTtl } = await import("@/lib/backend/tauri");

    await redisSetTtl("redis-1", 2, "c2Vzc2lvbg==", 90);
    await redisSetTtl("redis-1", 2, "c2Vzc2lvbg==", -1);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "redis_set_ttl", {
      connectionId: "redis-1",
      db: 2,
      keyRaw: "c2Vzc2lvbg==",
      ttl: 90,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "redis_set_ttl", {
      connectionId: "redis-1",
      db: 2,
      keyRaw: "c2Vzc2lvbg==",
      ttl: -1,
    });
  });
});

describe("Redis expiry HTTP API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(undefined),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function lastCall(fetchMock: ReturnType<typeof stubFetch>): { url: string; body: Record<string, unknown> } {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
  }

  it("posts relative TTL, persist, and absolute expiration requests", async () => {
    const fetchMock = stubFetch();
    const { redisSetExpireAt, redisSetTtl } = await import("@/lib/backend/http");

    await redisSetTtl("redis-1", 2, "c2Vzc2lvbg==", 90);
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/redis/set-ttl",
      body: { connectionId: "redis-1", db: 2, keyRaw: "c2Vzc2lvbg==", ttl: 90 },
    });

    await redisSetTtl("redis-1", 2, "c2Vzc2lvbg==", -1);
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/redis/set-ttl",
      body: { connectionId: "redis-1", db: 2, keyRaw: "c2Vzc2lvbg==", ttl: -1 },
    });

    await redisSetExpireAt("redis-1", 2, "c2Vzc2lvbg==", 1_735_689_600);
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/redis/set-expire-at",
      body: { connectionId: "redis-1", db: 2, keyRaw: "c2Vzc2lvbg==", expireAt: 1_735_689_600 },
    });
  });
});
