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
    expect(connectDb).toHaveBeenCalledWith(connection);
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
});
