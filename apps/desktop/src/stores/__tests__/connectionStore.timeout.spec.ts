import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function postgresConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "pg-1",
    name: "Postgres",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app",
    read_only: false,
    ...overrides,
  } as ConnectionConfig;
}

describe("connectionStore timeout recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out connected health checks and falls back to reconnect", async () => {
    const checkConnectionHealth = vi.fn(() => new Promise(() => undefined));
    const connectDb = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ connect_timeout_secs: 10 });
    store.connections = [connection];
    store.connectedIds.add(connection.id);

    const ensure = store.ensureConnected(connection.id);
    await vi.advanceTimersByTimeAsync(5001);
    await ensure;

    expect(checkConnectionHealth).toHaveBeenCalledWith(connection.id);
    expect(connectDb).toHaveBeenCalledWith(connection, expect.any(Number));
    expect(store.connectedIds.has(connection.id)).toBe(true);
  }, 10_000);

  it("normalizes missing keepalive interval to 30 seconds", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(postgresConnection({ keepalive_interval_secs: undefined }));

    expect(store.connections[0]?.keepalive_interval_secs).toBe(30);
  });

  it("clears connection node loading when health check timeout forces reconnect failure", async () => {
    const checkConnectionHealth = vi.fn(() => new Promise(() => undefined));
    const connectDb = vi.fn().mockRejectedValue(new Error("reconnect failed"));

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ connect_timeout_secs: 10 });
    const node: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isLoading: true,
      children: [],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [node];

    const ensure = store.ensureConnected(connection.id).catch((error) => error);
    await vi.advanceTimersByTimeAsync(5001);
    const error = await ensure;

    expect(error).toBeInstanceOf(Error);
    expect(node.isLoading).toBe(false);
  }, 10_000);

  it("cancels an in-flight connection without leaving connected or loading state", async () => {
    const connectDb = vi.fn(() => new Promise(() => undefined));
    const disconnectDb = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      disconnectDb,
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { CONNECTION_ATTEMPT_CANCELLED_MESSAGE, useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ connect_timeout_secs: 1 });
    const node: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isLoading: false,
      children: [],
    };
    store.connections = [connection];
    store.treeNodes = [node];

    const ensure = store.ensureConnected(connection.id).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);

    expect(store.connectingIds.has(connection.id)).toBe(true);
    expect(node.isLoading).toBe(true);

    await expect(store.cancelConnecting(connection.id)).resolves.toBe(true);
    expect(disconnectDb).toHaveBeenCalledWith(connection.id, expect.any(Number));
    expect(store.connectingIds.has(connection.id)).toBe(false);
    expect(store.connectedIds.has(connection.id)).toBe(false);
    expect(store.connectionErrors[connection.id]).toBeUndefined();
    expect(node.isLoading).toBe(false);

    await vi.advanceTimersByTimeAsync(3001);
    const error = await ensure;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
    expect(store.connectingIds.has(connection.id)).toBe(false);
    expect(store.connectedIds.has(connection.id)).toBe(false);
    expect(store.connectionErrors[connection.id]).toBeUndefined();
    expect(node.isLoading).toBe(false);
  }, 10_000);

  it("uses a shared SSH profile timeout and cleans up a late backend success", async () => {
    let resolveConnect!: (connectionId: string) => void;
    const connectDb = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const disconnectDb = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      disconnectDb,
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useTunnelProfileStore } = await import("@/stores/tunnelProfileStore");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    useTunnelProfileStore().profiles = [
      {
        type: "ssh",
        id: "slow-bastion",
        host: "bastion.example.com",
        port: 22,
        user: "dbx",
        connect_timeout_secs: 4,
      },
    ];
    const store = useConnectionStore();
    const connection = postgresConnection({
      connect_timeout_secs: 1,
      transport_layers: [
        {
          type: "ssh",
          id: "connection-hop",
          profile_id: "slow-bastion",
          host: "",
          port: 22,
          user: "root",
          connect_timeout_secs: 1,
        },
      ],
    });
    store.connections = [connection];

    let settled = false;
    const connect = store.connect(connection).catch((error) => error);
    void connect.finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(3001);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(3000);
    const error = await connect;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("timed out after 6s");

    resolveConnect(connection.id);
    await vi.advanceTimersByTimeAsync(1);
    expect(disconnectDb).toHaveBeenCalledWith(connection.id);
    expect(store.connectedIds.has(connection.id)).toBe(false);
  }, 10_000);

  it("allows reconnecting the same connection while a scoped cancel is pending", async () => {
    let resolveDisconnect!: () => void;
    const pendingConnect = new Promise<string>(() => undefined);
    let connectCallCount = 0;
    const connectDb = vi.fn(() => {
      connectCallCount += 1;
      return connectCallCount === 1 ? pendingConnect : Promise.resolve("pg-1");
    });
    const disconnectDb = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDisconnect = resolve;
        }),
    );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      disconnectDb,
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ connect_timeout_secs: 1 });
    store.connections = [connection];
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isLoading: false,
        children: [],
      },
    ];

    const firstEnsure = store.ensureConnected(connection.id).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectDb).toHaveBeenCalledTimes(1);
    const firstAttempt = connectDb.mock.calls[0]?.[1];

    const cancel = store.cancelConnecting(connection.id);
    await vi.advanceTimersByTimeAsync(1);
    expect(disconnectDb).toHaveBeenCalledWith(connection.id, firstAttempt);

    const reconnect = store.ensureConnected(connection.id);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectDb).toHaveBeenCalledTimes(2);
    expect(connectDb.mock.calls[1]?.[1]).not.toBe(firstAttempt);

    resolveDisconnect();
    await cancel;
    await reconnect;

    expect(connectDb).toHaveBeenCalledTimes(2);
    expect(store.connectedIds.has(connection.id)).toBe(true);
    expect(store.connectionErrors[connection.id]).toBeUndefined();

    await vi.advanceTimersByTimeAsync(3001);
    await firstEnsure;
  }, 10_000);

  it("starts a fresh root metadata load after canceling a pending connection", async () => {
    let connectCallCount = 0;
    const connectDb = vi.fn(() => {
      connectCallCount += 1;
      return connectCallCount === 1 ? new Promise<string>(() => undefined) : Promise.resolve("pg-1");
    });
    const disconnectDb = vi.fn().mockResolvedValue(undefined);
    const listDatabases = vi.fn().mockResolvedValue([{ name: "app" }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      disconnectDb,
      listDatabases,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ connect_timeout_secs: 10 });
    store.connections = [connection];
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isLoading: false,
        children: [],
      },
    ];

    void store.loadDatabases(connection.id).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectDb).toHaveBeenCalledTimes(1);
    const firstAttempt = connectDb.mock.calls[0]?.[1];

    await expect(store.cancelConnecting(connection.id)).resolves.toBe(true);
    expect(disconnectDb).toHaveBeenCalledWith(connection.id, firstAttempt);
    expect(store.treeNodes[0]?.isLoading).toBe(false);

    await store.loadDatabases(connection.id);

    expect(connectDb).toHaveBeenCalledTimes(2);
    expect(connectDb.mock.calls[1]?.[1]).not.toBe(firstAttempt);
    expect(listDatabases).toHaveBeenCalledTimes(1);
    expect(store.connectedIds.has(connection.id)).toBe(true);
    expect(store.treeNodes[0]?.isExpanded).toBe(true);
  }, 10_000);

  it("allows reconnecting the same connection while a scoped disconnect is pending", async () => {
    let resolveDisconnect!: () => void;
    const connectDb = vi.fn().mockResolvedValue("pg-1");
    const disconnectDb = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDisconnect = resolve;
        }),
    );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      disconnectDb,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ connect_timeout_secs: 10 });
    store.connections = [connection];
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isLoading: true,
        isExpanded: true,
        children: [],
      },
    ];

    await store.connect(connection);
    expect(store.connectedIds.has(connection.id)).toBe(true);
    const firstAttempt = connectDb.mock.calls[0]?.[1];

    const disconnect = store.disconnect(connection.id);
    expect(disconnectDb).toHaveBeenCalledWith(connection.id, firstAttempt);
    expect(store.connectedIds.has(connection.id)).toBe(false);
    expect(store.treeNodes[0]?.isLoading).toBe(false);
    expect(store.treeNodes[0]?.isExpanded).toBe(false);

    await store.connect(connection);
    expect(connectDb).toHaveBeenCalledTimes(2);
    expect(connectDb.mock.calls[1]?.[1]).not.toBe(firstAttempt);
    expect(store.connectedIds.has(connection.id)).toBe(true);

    resolveDisconnect();
    await disconnect;

    expect(store.connectedIds.has(connection.id)).toBe(true);
    expect(store.connectionErrors[connection.id]).toBeUndefined();
  }, 10_000);

  it("keeps a newer reconnect error when an older scoped disconnect finishes later", async () => {
    let resolveDisconnect!: () => void;
    let connectCallCount = 0;
    const connectDb = vi.fn(() => {
      connectCallCount += 1;
      return connectCallCount === 1 ? Promise.resolve("pg-1") : Promise.reject(new Error("reconnect failed"));
    });
    const disconnectDb = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDisconnect = resolve;
        }),
    );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      disconnectDb,
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ connect_timeout_secs: 10 });
    store.connections = [connection];

    await store.connect(connection);
    const firstAttempt = connectDb.mock.calls[0]?.[1];

    const disconnect = store.disconnect(connection.id);
    expect(disconnectDb).toHaveBeenCalledWith(connection.id, firstAttempt);

    await expect(store.connect(connection)).rejects.toThrow("reconnect failed");
    expect(store.connectionErrors[connection.id]).toBe("reconnect failed");

    resolveDisconnect();
    await disconnect;

    expect(store.connectedIds.has(connection.id)).toBe(false);
    expect(store.connectionErrors[connection.id]).toBe("reconnect failed");
  }, 10_000);

  it("scopes a normal disconnect to the active connection attempt when one is running", async () => {
    let resolveConnect!: (connectionId: string) => void;
    const connectDb = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const disconnectDb = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      disconnectDb,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { CONNECTION_ATTEMPT_CANCELLED_MESSAGE, useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ connect_timeout_secs: 10 });
    store.connections = [connection];

    const connect = store.connect(connection).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);
    const activeAttempt = connectDb.mock.calls[0]?.[1];

    await store.disconnect(connection.id);
    expect(disconnectDb).toHaveBeenCalledWith(connection.id, activeAttempt);
    expect(store.connectedIds.has(connection.id)).toBe(false);

    resolveConnect(connection.id);
    await vi.advanceTimersByTimeAsync(1);
    const error = await connect;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
    expect(disconnectDb).toHaveBeenLastCalledWith(connection.id, activeAttempt);
    expect(store.connectedIds.has(connection.id)).toBe(false);
  }, 10_000);

  it("cleans up backend state when a cancelled connection later succeeds", async () => {
    let resolveConnect!: (connectionId: string) => void;
    const connectDb = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveConnect = resolve;
        }),
    );
    const disconnectDb = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      disconnectDb,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { CONNECTION_ATTEMPT_CANCELLED_MESSAGE, useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ connect_timeout_secs: 10 });
    store.connections = [connection];

    const ensure = store.ensureConnected(connection.id).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);
    const attempt = connectDb.mock.calls[0]?.[1];

    await expect(store.cancelConnecting(connection.id)).resolves.toBe(true);
    expect(disconnectDb).toHaveBeenCalledTimes(1);
    expect(disconnectDb).toHaveBeenCalledWith(connection.id, attempt);

    resolveConnect(connection.id);
    await vi.advanceTimersByTimeAsync(1);
    const error = await ensure;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
    expect(disconnectDb).toHaveBeenCalledTimes(2);
    expect(disconnectDb).toHaveBeenLastCalledWith(connection.id, attempt);
    expect(store.connectedIds.has(connection.id)).toBe(false);
    expect(store.connectionErrors[connection.id]).toBeUndefined();
  }, 10_000);

  it("keeps errors from earlier cancelled attempts hidden after a second cancel", async () => {
    let rejectFirstConnect!: (error: Error) => void;
    let rejectSecondConnect!: (error: Error) => void;
    let connectCallCount = 0;
    const connectDb = vi.fn(() => {
      connectCallCount += 1;
      return new Promise<string>((_, reject) => {
        if (connectCallCount === 1) {
          rejectFirstConnect = reject;
        } else {
          rejectSecondConnect = reject;
        }
      });
    });
    const disconnectDb = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      disconnectDb,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { CONNECTION_ATTEMPT_CANCELLED_MESSAGE, useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection({ connect_timeout_secs: 10 });
    store.connections = [connection];

    const firstEnsure = store.ensureConnected(connection.id).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectDb).toHaveBeenCalledTimes(1);
    await expect(store.cancelConnecting(connection.id)).resolves.toBe(true);

    const secondEnsure = store.ensureConnected(connection.id).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(connectDb).toHaveBeenCalledTimes(2);
    await expect(store.cancelConnecting(connection.id)).resolves.toBe(true);

    rejectFirstConnect(new Error("first connection failed after cancel"));
    const firstError = await firstEnsure;
    expect(firstError).toBeInstanceOf(Error);
    expect(firstError.message).toContain(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
    expect(store.connectionErrors[connection.id]).toBeUndefined();

    rejectSecondConnect(new Error("second connection failed after cancel"));
    const secondError = await secondEnsure;
    expect(secondError).toBeInstanceOf(Error);
    expect(secondError.message).toContain(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
    expect(store.connectionErrors[connection.id]).toBeUndefined();
  }, 10_000);
});
