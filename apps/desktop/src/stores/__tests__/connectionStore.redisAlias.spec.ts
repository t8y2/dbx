import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function redisConnection(): ConnectionConfig {
  return {
    id: "redis-1",
    name: "Redis",
    db_type: "redis",
    host: "127.0.0.1",
    port: 6379,
    username: "",
    password: "",
    database: "0",
  };
}

function seedRedisTree(store: { treeNodes: TreeNode[] }) {
  store.treeNodes.push({
    id: "redis-1",
    label: "Redis",
    type: "connection",
    connectionId: "redis-1",
    children: [
      {
        id: "redis-1:db3",
        label: "db3 (12)",
        type: "redis-db",
        connectionId: "redis-1",
        database: "3",
        loadedKeyCount: 0,
        totalKeyCount: 12,
        children: [],
      },
    ],
  });
}

describe("connectionStore Redis database aliases", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("persists an alias without disconnecting and keeps it during count refreshes", async () => {
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      saveConnections,
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.addEphemeralConnection(redisConnection());
    seedRedisTree(store);

    await store.setRedisDatabaseAlias("redis-1", "3", " orders ");

    expect(store.getRedisDatabaseAlias("redis-1", 3)).toBe("orders");
    expect(store.connectedIds.has("redis-1")).toBe(true);
    expect(store.treeNodes[0].children?.[0].label).toBe("db3 · orders (12)");
    expect(saveConnections).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: "redis-1",
        redis_database_aliases: { "3": "orders" },
      }),
    ]);

    store.updateRedisDbKeyStats("redis-1", 3, { total: 15 });
    expect(store.treeNodes[0].children?.[0].label).toBe("db3 · orders (15)");
  });

  it("clears an alias and removes the empty map from persisted config", async () => {
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      saveConnections,
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.addEphemeralConnection({
      ...redisConnection(),
      redis_database_aliases: { "3": "orders" },
    });
    seedRedisTree(store);

    await store.setRedisDatabaseAlias("redis-1", 3);

    expect(store.getRedisDatabaseAlias("redis-1", 3)).toBeUndefined();
    expect(store.treeNodes[0].children?.[0].label).toBe("db3 (12)");
    expect(saveConnections).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: "redis-1",
        redis_database_aliases: undefined,
      }),
    ]);
  });

  it("keeps aliases for one-time Redis connections in memory without persisting secrets", async () => {
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      saveConnections,
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.addEphemeralConnection({
      ...redisConnection(),
      one_time: true,
      password: "one-time-secret",
    });
    seedRedisTree(store);

    await store.setRedisDatabaseAlias("redis-1", 3, "orders");

    expect(store.getRedisDatabaseAlias("redis-1", 3)).toBe("orders");
    expect(store.connections[0]).toEqual(expect.objectContaining({ password: "one-time-secret", redis_database_aliases: { "3": "orders" } }));
    expect(saveConnections).toHaveBeenLastCalledWith([]);
  });
});
