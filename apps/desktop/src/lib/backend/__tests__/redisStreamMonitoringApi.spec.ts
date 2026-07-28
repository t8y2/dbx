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

describe("Redis stream monitoring Tauri API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("invokes the group, consumer, and pending read commands with binary-safe raw names", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const { redisGetStreamConsumers, redisGetStreamGroups, redisGetStreamPending } = await import("@/lib/backend/tauri");

    await redisGetStreamGroups("redis-1", 2, "b3JkZXJz");
    await redisGetStreamConsumers("redis-1", 2, "b3JkZXJz", "Z3JvdXAALQ==");
    await redisGetStreamPending("redis-1", 2, "b3JkZXJz", "Z3JvdXAALQ==", "1714470000000-17");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "redis_get_stream_groups", {
      connectionId: "redis-1",
      db: 2,
      keyRaw: "b3JkZXJz",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "redis_get_stream_consumers", {
      connectionId: "redis-1",
      db: 2,
      keyRaw: "b3JkZXJz",
      groupRaw: "Z3JvdXAALQ==",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "redis_get_stream_pending", {
      connectionId: "redis-1",
      db: 2,
      keyRaw: "b3JkZXJz",
      groupRaw: "Z3JvdXAALQ==",
      cursor: "1714470000000-17",
    });
  });

  it("passes an optional binary-safe consumer name to the pending command", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    const { redisGetStreamPending } = await import("@/lib/backend/tauri");

    await redisGetStreamPending("redis-1", 2, "b3JkZXJz", "Z3JvdXAALQ==", "1714470000000-17", "d29ya2VyLWE=");

    expect(mocks.invoke).toHaveBeenCalledWith("redis_get_stream_pending", {
      connectionId: "redis-1",
      db: 2,
      keyRaw: "b3JkZXJz",
      groupRaw: "Z3JvdXAALQ==",
      cursor: "1714470000000-17",
      consumerRaw: "d29ya2VyLWE=",
    });
  });
});

describe("Redis stream monitoring HTTP API", () => {
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

  it("posts group, consumer, and pending queries to their read-only endpoints", async () => {
    const fetchMock = stubFetch();
    const { redisGetStreamConsumers, redisGetStreamGroups, redisGetStreamPending } = await import("@/lib/backend/http");

    await redisGetStreamGroups("redis-1", 2, "b3JkZXJz");
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/redis/get-stream-groups",
      body: { connectionId: "redis-1", db: 2, keyRaw: "b3JkZXJz" },
    });

    await redisGetStreamConsumers("redis-1", 2, "b3JkZXJz", "Z3JvdXAALQ==");
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/redis/get-stream-consumers",
      body: { connectionId: "redis-1", db: 2, keyRaw: "b3JkZXJz", groupRaw: "Z3JvdXAALQ==" },
    });

    await redisGetStreamPending("redis-1", 2, "b3JkZXJz", "Z3JvdXAALQ==", "1714470000000-17");
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/redis/get-stream-pending",
      body: { connectionId: "redis-1", db: 2, keyRaw: "b3JkZXJz", groupRaw: "Z3JvdXAALQ==", cursor: "1714470000000-17" },
    });
  });

  it("posts a consumer-scoped pending query", async () => {
    const fetchMock = stubFetch();
    const { redisGetStreamPending } = await import("@/lib/backend/http");

    await redisGetStreamPending("redis-1", 2, "b3JkZXJz", "Z3JvdXAALQ==", "1714470000000-17", "d29ya2VyLWE=");

    expect(lastCall(fetchMock)).toEqual({
      url: "/api/redis/get-stream-pending",
      body: {
        connectionId: "redis-1",
        db: 2,
        keyRaw: "b3JkZXJz",
        groupRaw: "Z3JvdXAALQ==",
        cursor: "1714470000000-17",
        consumerRaw: "d29ya2VyLWE=",
      },
    });
  });
});
