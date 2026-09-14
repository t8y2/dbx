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

  it("invokes the batch expiry commands with every selected key in one call", async () => {
    mocks.invoke.mockResolvedValue({ applied: 2, missing_key_raws: ["bWlzc2luZw=="] });
    const { redisSetKeysExpireAt, redisSetKeysTtl } = await import("@/lib/backend/tauri");

    const keyRaws = ["c2Vzc2lvbjpht", "c2Vzc2lvbjpi", "bWlzc2luZw=="];
    await expect(redisSetKeysTtl("redis-1", 2, keyRaws, 90)).resolves.toEqual({ applied: 2, missing_key_raws: ["bWlzc2luZw=="] });
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "redis_set_keys_ttl", { connectionId: "redis-1", db: 2, keyRaws, ttl: 90 });

    await redisSetKeysExpireAt("redis-1", 2, keyRaws, 1_735_689_600);
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "redis_set_keys_expire_at", {
      connectionId: "redis-1",
      db: 2,
      keyRaws,
      expireAt: 1_735_689_600,
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

  it("posts one batch expiry request per bounded chunk of selected keys", async () => {
    const fetchMock = stubFetch();
    const { redisSetKeysExpireAt, redisSetKeysTtl } = await import("@/lib/backend/http");

    const keyRaws = ["c2Vzc2lvbjpht", "c2Vzc2lvbjpi"];
    await redisSetKeysTtl("redis-1", 2, keyRaws, -1);
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/redis/set-keys-ttl",
      body: { connectionId: "redis-1", db: 2, keyRaws, ttl: -1 },
    });

    await redisSetKeysExpireAt("redis-1", 2, keyRaws, 1_735_689_600);
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/redis/set-keys-expire-at",
      body: { connectionId: "redis-1", db: 2, keyRaws, expireAt: 1_735_689_600 },
    });
  });
});
