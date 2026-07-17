import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { test, vi } from "vitest";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import type { ConnectionConfig } from "../../apps/desktop/src/types/database.ts";

function installMemoryStorage() {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function conn(id: string): ConnectionConfig {
  return {
    id,
    name: id,
    db_type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "",
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("successful disconnect clears the connection error", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input) === "/api/connection/disconnect") {
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.recordConnectionError("conn-1", new Error("metadata failed"));

    await store.disconnect("conn-1");

    assert.equal(store.connectionErrors["conn-1"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("failed disconnect keeps the existing connection error", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input) === "/api/connection/disconnect") {
      return new Response("disconnect failed", { status: 500 });
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.recordConnectionError("conn-1", new Error("metadata failed"));

    await assert.rejects(() => store.disconnect("conn-1"), /disconnect failed/);

    assert.equal(store.connectionErrors["conn-1"], "metadata failed");
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("hanging disconnect request still clears local connection state", async () => {
  vi.useFakeTimers();
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input) === "/api/connection/disconnect") {
      return new Promise<Response>(() => {});
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.activeConnectionId = "conn-1";
    store.recordConnectionError("conn-1", new Error("metadata failed"));
    store.treeNodes.push({
      id: "conn-1",
      label: "conn-1",
      type: "connection",
      connectionId: "conn-1",
      isLoading: true,
      isExpanded: true,
      children: [{ id: "conn-1:db", label: "db", type: "database", connectionId: "conn-1", database: "db" }],
    });

    const disconnectPromise = store.disconnect("conn-1");
    await vi.advanceTimersByTimeAsync(5000);
    await disconnectPromise;

    assert.equal(store.connectionErrors["conn-1"], undefined);
    assert.equal(store.connectedIds.has("conn-1"), false);
    assert.equal(store.activeConnectionId, null);
    assert.equal(store.treeNodes[0].isLoading, false);
    assert.equal(store.treeNodes[0].isExpanded, false);
    assert.deepEqual(store.treeNodes[0].children, []);
  } finally {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("query errors mentioning connection do not mark the connection disconnected", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.activeConnectionId = "conn-1";

    store.recordConnectionLostError("conn-1", new Error('relation "connection" does not exist'));

    assert.equal(store.connectedIds.has("conn-1"), true);
    assert.equal(store.activeConnectionId, "conn-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreStorage();
  }
});

test("known backend connection errors mark the connection disconnected", async () => {
  const restoreStorage = installMemoryStorage();
  const messages = [
    "java.sql.SQLRecoverableException: 关闭的连接",
    "java.sql.SQLRecoverableException: 连接已关闭",
    "server closed session with no notification",
    "server closed the connection unexpectedly",
    "Error occurred while creating a new object: error communicating with the server",
    "ORA-02396: exceeded maximum idle time, please connect again",
    "Agent stdin not available",
    "Failed to write to agent stdin",
    "MySQL connection failed: Input/output error: No route to host (os error 65)",
  ];

  try {
    for (const [index, message] of messages.entries()) {
      setActivePinia(createPinia());
      const store = useConnectionStore();
      const connectionId = `conn-${index}`;
      store.addEphemeralConnection(conn(connectionId));
      store.activeConnectionId = connectionId;

      const marked = store.recordConnectionLostError(connectionId, new Error(message));

      assert.equal(marked, true, message);
      assert.equal(store.connectedIds.has(connectionId), false, message);
      assert.equal(store.activeConnectionId, null, message);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreStorage();
  }
});

test("explicit lost-connection marker clears state without relying on error text", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.activeConnectionId = "conn-1";
    store.treeNodes.push({
      id: "conn-1",
      label: "conn-1",
      type: "connection",
      connectionId: "conn-1",
      isLoading: true,
      children: [],
    });

    store.markConnectionLost("conn-1", new Error("连接可能已断开，请刷新数据重试"));

    assert.equal(store.connectedIds.has("conn-1"), false);
    assert.equal(store.activeConnectionId, null);
    assert.equal(store.treeNodes[0].isLoading, false);
    assert.equal(store.connectionErrors["conn-1"], "连接可能已断开，请刷新数据重试");
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreStorage();
  }
});

test("late original connect errors replace the generic timeout detail", async () => {
  vi.useFakeTimers();
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input) === "/api/connection/connect") {
      return new Promise<Response>((_, reject) => {
        setTimeout(() => reject(new Error("MySQL connection failed: raw socket timeout")), 3500);
      });
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    const config = { ...conn("conn-1"), connect_timeout_secs: 1 };
    const connectPromise = store.connect(config);
    const timeoutRejection = assert.rejects(() => connectPromise, /Connection attempt timed out after 3s/);

    await vi.advanceTimersByTimeAsync(3000);
    await timeoutRejection;
    assert.equal(store.connectionErrors["conn-1"], "Connection attempt timed out after 3s. Please check the network or VPN and try again.");

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    assert.match(store.connectionErrors["conn-1"], /Original database error returned after the UI timeout/);
    assert.match(store.connectionErrors["conn-1"], /MySQL connection failed: raw socket timeout/);
  } finally {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("late original connect success is disconnected after the UI timeout", async () => {
  vi.useFakeTimers();
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  const disconnected: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/connection/connect") {
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response(JSON.stringify("conn-1"), { status: 200, headers: { "Content-Type": "application/json" } })), 3500);
      });
    }
    if (String(input) === "/api/connection/disconnect") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { connectionId?: string };
      if (body.connectionId) disconnected.push(body.connectionId);
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    const config = { ...conn("conn-1"), connect_timeout_secs: 1 };
    const connectPromise = store.connect(config);
    const timeoutRejection = assert.rejects(() => connectPromise, /Connection attempt timed out after 3s/);

    await vi.advanceTimersByTimeAsync(3000);
    await timeoutRejection;
    assert.equal(store.connectedIds.has("conn-1"), false);

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    assert.deepEqual(disconnected, ["conn-1"]);
    assert.equal(store.connectedIds.has("conn-1"), false);
  } finally {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("late original connect success does not disconnect a newer connected state", async () => {
  vi.useFakeTimers();
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  const disconnected: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/connection/connect") {
      return new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response(JSON.stringify("conn-1"), { status: 200, headers: { "Content-Type": "application/json" } })), 3500);
      });
    }
    if (String(input) === "/api/connection/disconnect") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { connectionId?: string };
      if (body.connectionId) disconnected.push(body.connectionId);
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    const config = { ...conn("conn-1"), connect_timeout_secs: 1 };
    const connectPromise = store.connect(config);
    const timeoutRejection = assert.rejects(() => connectPromise, /Connection attempt timed out after 3s/);

    await vi.advanceTimersByTimeAsync(3000);
    await timeoutRejection;
    store.connectedIds.add("conn-1");

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    assert.deepEqual(disconnected, []);
    assert.equal(store.connectedIds.has("conn-1"), true);
  } finally {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("hanging database metadata load times out and clears loading state", async () => {
  vi.useFakeTimers();
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input).startsWith("/api/schema/databases?")) {
      return new Promise<Response>(() => {});
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.activeConnectionId = "conn-1";
    store.treeNodes.push({
      id: "conn-1",
      label: "conn-1",
      type: "connection",
      connectionId: "conn-1",
      children: [],
    });

    const loadPromise = store.loadDatabases("conn-1");
    const timeoutRejection = assert.rejects(() => loadPromise, /Connection timed out while loading databases after 35s/);

    await vi.advanceTimersByTimeAsync(35000);
    await timeoutRejection;

    assert.equal(store.treeNodes[0].isLoading, false);
    assert.equal(store.connectedIds.has("conn-1"), false);
    assert.equal(store.activeConnectionId, null);
    assert.match(store.connectionErrors["conn-1"], /Connection timed out while loading databases/);
  } finally {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("utility-only connection cache is ignored and replaced with live metadata children", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  const utilityOnlyCache = {
    version: 2,
    cachedAt: new Date().toISOString(),
    children: [
      {
        id: "conn-1:__user_admin",
        label: "tree.userAdmin",
        type: "user-admin",
        connectionId: "conn-1",
        database: "",
      },
    ],
  };
  let listDatabasesCalls = 0;
  let savedPayload: any = null;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/schema/cache?")) {
      return jsonResponse(utilityOnlyCache);
    }
    if (url.startsWith("/api/schema/databases?")) {
      listDatabasesCalls++;
      return jsonResponse([{ name: "app" }]);
    }
    if (url === "/api/schema/cache" && init?.method === "POST") {
      savedPayload = JSON.parse(String(init.body ?? "{}")).payload;
      return jsonResponse(null);
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection({ ...conn("conn-1"), db_type: "mysql", port: 3306 });
    store.treeNodes.push({
      id: "conn-1",
      label: "conn-1",
      type: "connection",
      connectionId: "conn-1",
      children: [],
    });

    await store.loadDatabases("conn-1");

    assert.equal(listDatabasesCalls, 1);
    assert.deepEqual(
      store.treeNodes[0].children?.map((child) => child.type),
      ["database", "user-admin"],
    );
    assert.deepEqual(
      savedPayload?.children?.map((child: any) => child.type),
      ["database"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("empty root metadata does not replace existing databases with only user admin", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  let savedPayload: any = null;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/schema/cache?")) {
      return jsonResponse(null);
    }
    if (url.startsWith("/api/schema/databases?")) {
      return jsonResponse([]);
    }
    if (url === "/api/schema/cache" && init?.method === "POST") {
      savedPayload = JSON.parse(String(init.body ?? "{}")).payload;
      return jsonResponse(null);
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection({ ...conn("conn-1"), db_type: "mysql", port: 3306 });
    store.treeNodes.push({
      id: "conn-1",
      label: "conn-1",
      type: "connection",
      connectionId: "conn-1",
      children: [
        {
          id: "conn-1:app",
          label: "app",
          type: "database",
          connectionId: "conn-1",
          database: "app",
          children: [],
        },
      ],
    });

    await store.loadDatabases("conn-1");

    assert.deepEqual(
      store.treeNodes[0].children?.map((child) => child.type),
      ["database", "user-admin"],
    );
    assert.deepEqual(
      store.treeNodes[0].children?.map((child) => child.id),
      ["conn-1:app", "conn-1:__user_admin"],
    );
    assert.deepEqual(
      savedPayload?.children?.map((child: any) => child.id),
      ["conn-1:app"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test.each([
  ["redis", "loadRedisDatabases", "/api/redis/list-databases", "Redis databases"],
  ["mq", "loadMqTenants", "/api/mq/tenants/list", "message queue tenants"],
  ["mongodb", "loadMongoDatabases", "/api/document-store/list-databases", "MongoDB databases"],
  ["elasticsearch", "loadElasticsearchIndices", "/api/document-store/list-collections", "Elasticsearch indices"],
  ["qdrant", "loadVectorCollections", "/api/document-store/list-collections", "vector collections"],
] as const)("hanging %s root metadata load times out and clears loading state", async (dbType, loader, endpoint, label) => {
  vi.useFakeTimers();
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    if (String(input) === endpoint) {
      return new Promise<Response>(() => {});
    }
    // Marking a connection lost also cleans up any query client sessions.
    if (String(input) === "/api/query/close-client-session") {
      return jsonResponse(true);
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection({ ...conn("conn-1"), db_type: dbType });
    store.activeConnectionId = "conn-1";
    store.treeNodes.push({
      id: "conn-1",
      label: "conn-1",
      type: "connection",
      connectionId: "conn-1",
      children: [],
    });

    const loadPromise = store[loader]("conn-1");
    const timeoutRejection = assert.rejects(() => loadPromise, new RegExp(`Connection timed out while loading ${label} after 35s`));

    await vi.advanceTimersByTimeAsync(35000);
    await timeoutRejection;

    assert.equal(store.treeNodes[0].isLoading, false);
    assert.equal(store.connectedIds.has("conn-1"), false);
    assert.equal(store.activeConnectionId, null);
    assert.match(store.connectionErrors["conn-1"], new RegExp(`Connection timed out while loading ${label}`));
  } finally {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});
