import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

describe("mq policies tauri API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("invokes mq_list_policies with flattened filters", async () => {
    const { mqListPolicies } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue([{ name: "dbx-ttl", vhost: "/", pattern: "^dbx-", applyTo: "queues", priority: 0, definition: { "message-ttl": 60000 } }]);

    const result = await mqListPolicies("conn-1", { virtualHost: "/" });
    expect(mocks.invoke).toHaveBeenCalledWith("mq_list_policies", { connectionId: "conn-1", virtualHost: "/", allVhosts: undefined });
    expect(result[0]?.name).toBe("dbx-ttl");
    expect(result[0]?.definition).toEqual({ "message-ttl": 60000 });

    await mqListPolicies("conn-1", { allVhosts: true });
    expect(mocks.invoke).toHaveBeenCalledWith("mq_list_policies", { connectionId: "conn-1", virtualHost: undefined, allVhosts: true });

    await mqListPolicies("conn-1");
    expect(mocks.invoke).toHaveBeenCalledWith("mq_list_policies", { connectionId: "conn-1", virtualHost: undefined, allVhosts: undefined });
  });

  it("invokes mq_set_policy with flattened fields", async () => {
    const { mqSetPolicy } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue(undefined);

    await mqSetPolicy("conn-1", "/", { name: "dbx-ttl", pattern: "^dbx-", applyTo: "queues", priority: 10, definition: { "message-ttl": 60000 } });
    expect(mocks.invoke).toHaveBeenCalledWith("mq_set_policy", {
      connectionId: "conn-1",
      virtualHost: "/",
      name: "dbx-ttl",
      pattern: "^dbx-",
      applyTo: "queues",
      priority: 10,
      definition: { "message-ttl": 60000 },
    });

    await mqSetPolicy("conn-1", "/", { name: "dbx-dlx", pattern: ".*", definition: { "dead-letter-exchange": "dbx-dlx" } });
    expect(mocks.invoke).toHaveBeenCalledWith("mq_set_policy", {
      connectionId: "conn-1",
      virtualHost: "/",
      name: "dbx-dlx",
      pattern: ".*",
      applyTo: undefined,
      priority: undefined,
      definition: { "dead-letter-exchange": "dbx-dlx" },
    });
  });

  it("invokes mq_delete_policy with vhost and name", async () => {
    const { mqDeletePolicy } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue(undefined);

    await mqDeletePolicy("conn-1", "/", "dbx-ttl");

    expect(mocks.invoke).toHaveBeenCalledWith("mq_delete_policy", { connectionId: "conn-1", virtualHost: "/", name: "dbx-ttl" });
  });
});

describe("mq overview/nodes tauri API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("invokes mq_get_overview with only the connection id", async () => {
    const { mqGetOverview } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue({ messagesReady: 3, messagesUnacked: 1, publishRate: 0.5, totalQueues: 2 });

    const result = await mqGetOverview("conn-1");

    expect(mocks.invoke).toHaveBeenCalledWith("mq_get_overview", { connectionId: "conn-1" });
    expect(result.messagesReady).toBe(3);
    expect(result.totalQueues).toBe(2);
  });

  it("invokes mq_list_nodes with only the connection id", async () => {
    const { mqListNodes } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue([{ name: "rabbit@dbx", running: true, memUsed: 1024, memLimit: 4096, uptimeMs: 60000 }]);

    const result = await mqListNodes("conn-1");

    expect(mocks.invoke).toHaveBeenCalledWith("mq_list_nodes", { connectionId: "conn-1" });
    expect(result[0]?.name).toBe("rabbit@dbx");
    expect(result[0]?.running).toBe(true);
  });
});

describe("mq policies/overview/nodes HTTP API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function stubFetch(payload: unknown = []) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(payload),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function lastCall(fetchMock: ReturnType<typeof stubFetch>): { url: string; body: Record<string, unknown> } {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
  }

  it("posts to the policies endpoints", async () => {
    const fetchMock = stubFetch();
    const { mqListPolicies, mqSetPolicy, mqDeletePolicy } = await import("@/lib/backend/mq-http");

    await mqListPolicies("conn-1", { allVhosts: true });
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/policies/list", body: { connectionId: "conn-1", virtualHost: undefined, allVhosts: true } });

    await mqSetPolicy("conn-1", "/", { name: "dbx-ttl", pattern: "^dbx-", applyTo: "queues", priority: 10, definition: { "message-ttl": 60000 } });
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/mq/policies/set",
      body: { connectionId: "conn-1", virtualHost: "/", name: "dbx-ttl", pattern: "^dbx-", applyTo: "queues", priority: 10, definition: { "message-ttl": 60000 } },
    });

    await mqDeletePolicy("conn-1", "/", "dbx-ttl");
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/policies/delete", body: { connectionId: "conn-1", virtualHost: "/", name: "dbx-ttl" } });
  });

  it("posts to the overview and nodes endpoints", async () => {
    const fetchMock = stubFetch({});
    const { mqGetOverview, mqListNodes } = await import("@/lib/backend/mq-http");

    await mqGetOverview("conn-1");
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/overview", body: { connectionId: "conn-1" } });

    await mqListNodes("conn-1");
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/nodes", body: { connectionId: "conn-1" } });
  });

  it("surfaces HTTP errors with the response detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: vi.fn().mockResolvedValue('virtual host "*" is a listing sentinel'),
      }),
    );
    const { mqSetPolicy } = await import("@/lib/backend/mq-http");

    await expect(mqSetPolicy("conn-1", "*", { name: "dbx-ttl", pattern: ".*", definition: {} })).rejects.toThrow('virtual host "*" is a listing sentinel');
  });
});
