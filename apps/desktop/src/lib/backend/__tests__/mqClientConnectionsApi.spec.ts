import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

const nsRoot = { tenant: "_rabbitmq", namespace: "/" };

describe("mq client connections/channels tauri API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("invokes mq_list_client_connections with the namespace ref", async () => {
    const { mqListClientConnections } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue([{ name: "192.168.1.10:51000 -> 192.168.1.126:5672", user: "jjsd", peerHost: "192.168.1.10", peerPort: 51000, state: "running", channels: 2 }]);

    const result = await mqListClientConnections("conn-1", nsRoot);

    expect(mocks.invoke).toHaveBeenCalledWith("mq_list_client_connections", { connectionId: "conn-1", ns: nsRoot });
    expect(result).toHaveLength(1);
    expect(result[0]?.peerHost).toBe("192.168.1.10");
  });

  it("invokes mq_list_client_channels with optional connection filter", async () => {
    const { mqListClientChannels } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue([{ name: "conn (1)", state: "running", prefetch: 10, messagesUnacked: 0, consumerCount: 1 }]);

    const result = await mqListClientChannels("conn-1", nsRoot, "conn");
    expect(mocks.invoke).toHaveBeenCalledWith("mq_list_client_channels", { connectionId: "conn-1", ns: nsRoot, connection: "conn" });
    expect(result[0]?.consumerCount).toBe(1);

    await mqListClientChannels("conn-1", nsRoot);
    expect(mocks.invoke).toHaveBeenCalledWith("mq_list_client_channels", { connectionId: "conn-1", ns: nsRoot, connection: undefined });
  });

  it("invokes mq_close_client_connection with the connection name", async () => {
    const { mqCloseClientConnection } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue(undefined);

    await mqCloseClientConnection("conn-1", nsRoot, "192.168.1.10:51000 -> 192.168.1.126:5672");

    expect(mocks.invoke).toHaveBeenCalledWith("mq_close_client_connection", { connectionId: "conn-1", ns: nsRoot, name: "192.168.1.10:51000 -> 192.168.1.126:5672" });
  });
});

describe("mq client connections/channels HTTP API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([]),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function lastCall(fetchMock: ReturnType<typeof stubFetch>): { url: string; body: Record<string, unknown> } {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
  }

  it("posts to the client-connections endpoints", async () => {
    const fetchMock = stubFetch();
    const { mqListClientConnections, mqCloseClientConnection } = await import("@/lib/backend/mq-http");

    await mqListClientConnections("conn-1", nsRoot);
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/client-connections/list", body: { connectionId: "conn-1", ns: nsRoot } });

    await mqCloseClientConnection("conn-1", nsRoot, "conn-name");
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/client-connections/close", body: { connectionId: "conn-1", ns: nsRoot, name: "conn-name" } });
  });

  it("posts to the channels list endpoint with optional connection filter", async () => {
    const fetchMock = stubFetch();
    const { mqListClientChannels } = await import("@/lib/backend/mq-http");

    await mqListClientChannels("conn-1", nsRoot, "conn");
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/channels/list", body: { connectionId: "conn-1", ns: nsRoot, connection: "conn" } });

    await mqListClientChannels("conn-1", nsRoot);
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/channels/list", body: { connectionId: "conn-1", ns: nsRoot, connection: undefined } });
  });

  it("surfaces HTTP errors with the response detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("connection not found"),
      }),
    );
    const { mqCloseClientConnection } = await import("@/lib/backend/mq-http");

    await expect(mqCloseClientConnection("conn-1", nsRoot, "gone")).rejects.toThrow("connection not found");
  });
});
