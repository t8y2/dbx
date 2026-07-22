import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

const NS = { tenant: "_rabbitmq", namespace: "/" };

describe("mq exchanges/bindings tauri API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("invokes mq_list_exchanges with the namespace ref", async () => {
    const { mqListExchanges } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue([{ name: "dbx-events", type: "topic", durable: true, autoDelete: false, internal: false }]);

    const result = await mqListExchanges("conn-1", NS);

    expect(mocks.invoke).toHaveBeenCalledWith("mq_list_exchanges", { connectionId: "conn-1", ns: NS });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("dbx-events");
  });

  it("invokes mq_create_exchange with flattened fields", async () => {
    const { mqCreateExchange } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue(undefined);

    await mqCreateExchange("conn-1", NS, { name: "dbx-events", type: "topic", durable: true, autoDelete: false });

    expect(mocks.invoke).toHaveBeenCalledWith("mq_create_exchange", {
      connectionId: "conn-1",
      ns: NS,
      name: "dbx-events",
      exchangeType: "topic",
      durable: true,
      autoDelete: false,
    });
  });

  it("invokes mq_delete_exchange with the exchange name", async () => {
    const { mqDeleteExchange } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue(undefined);

    await mqDeleteExchange("conn-1", NS, "dbx-events");

    expect(mocks.invoke).toHaveBeenCalledWith("mq_delete_exchange", { connectionId: "conn-1", ns: NS, name: "dbx-events" });
  });

  it("invokes mq_list_bindings with optional filters", async () => {
    const { mqListBindings } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue([]);

    await mqListBindings("conn-1", NS, { exchange: "dbx-events" });
    expect(mocks.invoke).toHaveBeenCalledWith("mq_list_bindings", { connectionId: "conn-1", ns: NS, exchange: "dbx-events", queue: undefined });

    await mqListBindings("conn-1", NS);
    expect(mocks.invoke).toHaveBeenCalledWith("mq_list_bindings", { connectionId: "conn-1", ns: NS, exchange: undefined, queue: undefined });
  });

  it("invokes mq_bind and mq_unbind with the binding object", async () => {
    const { mqBind, mqUnbind } = await import("@/lib/backend/mq-tauri");
    mocks.invoke.mockResolvedValue(undefined);
    const binding = { source: "dbx-events", destination: "dbx-queue", destinationType: "queue", routingKey: "orders.*" };

    await mqBind("conn-1", NS, binding);
    expect(mocks.invoke).toHaveBeenCalledWith("mq_bind", { connectionId: "conn-1", ns: NS, binding });

    await mqUnbind("conn-1", NS, binding);
    expect(mocks.invoke).toHaveBeenCalledWith("mq_unbind", { connectionId: "conn-1", ns: NS, binding });
  });
});

describe("mq exchanges/bindings HTTP API", () => {
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

  it("posts to the exchanges endpoints", async () => {
    const fetchMock = stubFetch();
    const { mqListExchanges, mqCreateExchange, mqDeleteExchange } = await import("@/lib/backend/mq-http");

    await mqListExchanges("conn-1", NS);
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/exchanges/list", body: { connectionId: "conn-1", ns: NS } });

    await mqCreateExchange("conn-1", NS, { name: "dbx-events", type: "fanout", durable: false, autoDelete: true });
    expect(lastCall(fetchMock)).toEqual({
      url: "/api/mq/exchanges/create",
      body: { connectionId: "conn-1", ns: NS, name: "dbx-events", exchangeType: "fanout", durable: false, autoDelete: true },
    });

    await mqDeleteExchange("conn-1", NS, "dbx-events");
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/exchanges/delete", body: { connectionId: "conn-1", ns: NS, name: "dbx-events" } });
  });

  it("posts to the bindings endpoints", async () => {
    const fetchMock = stubFetch();
    const { mqListBindings, mqBind, mqUnbind } = await import("@/lib/backend/mq-http");
    const binding = { source: "dbx-events", destination: "dbx-queue", destinationType: "queue", routingKey: "orders.*" };

    await mqListBindings("conn-1", NS, { queue: "dbx-queue" });
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/bindings/list", body: { connectionId: "conn-1", ns: NS, exchange: undefined, queue: "dbx-queue" } });

    await mqBind("conn-1", NS, binding);
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/bindings/bind", body: { connectionId: "conn-1", ns: NS, binding } });

    await mqUnbind("conn-1", NS, binding);
    expect(lastCall(fetchMock)).toEqual({ url: "/api/mq/bindings/unbind", body: { connectionId: "conn-1", ns: NS, binding } });
  });

  it("surfaces HTTP errors with the response detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("cannot delete built-in exchange"),
      }),
    );
    const { mqDeleteExchange } = await import("@/lib/backend/mq-http");

    await expect(mqDeleteExchange("conn-1", NS, "amq.direct")).rejects.toThrow("cannot delete built-in exchange");
  });
});
