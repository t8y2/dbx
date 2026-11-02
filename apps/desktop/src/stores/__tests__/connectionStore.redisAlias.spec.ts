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

  it("preserves pinned state and order for redis databases with aliases after reconnecting", async () => {
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    const savePinnedTreeNodeIds = vi.fn().mockResolvedValue(undefined);
    const redisListDatabases = vi.fn().mockResolvedValue([
      { db: 0, keys: 5 },
      { db: 1, keys: 10 },
      { db: 2, keys: 20 },
    ]);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      saveConnections,
      savePinnedTreeNodeIds,
      redisListDatabases,
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({ sidebarPinDefaultDatabase: false });
    const store = useConnectionStore();
    const conn = redisConnection();
    store.connections = [conn];
    store.connectedIds.add(conn.id);
    store.treeNodes = [{ id: conn.id, label: conn.name, type: "connection", connectionId: conn.id, children: [] }];

    await store.loadRedisDatabases(conn.id);
    expect(store.treeNodes[0].children).toHaveLength(3);

    // 1. Set aliases for db1 and db2
    await store.setRedisDatabaseAlias(conn.id, 1, "orders");
    await store.setRedisDatabaseAlias(conn.id, 2, "users");

    const db1Node = store.treeNodes[0].children!.find((n) => n.database === "1")!;
    const db2Node = store.treeNodes[0].children!.find((n) => n.database === "2")!;
    expect(db1Node.label).toBe("db1 · orders (10)");
    expect(db2Node.label).toBe("db2 · users (20)");

    // 2. Pin db2 then pin db1
    store.toggleTreeNodePin(db2Node);
    store.toggleTreeNodePin(db1Node);

    expect(store.isTreeNodePinned(db2Node)).toBe(true);
    expect(store.isTreeNodePinned(db1Node)).toBe(true);
    expect(store.treeNodes[0].children!.map((n) => n.database)).toEqual(["2", "1", "0"]);

    // 3. Simulate reconnect / database reload (e.g. key counts might be slightly different or same)
    redisListDatabases.mockResolvedValue([
      { db: 0, keys: 5 },
      { db: 1, keys: 11 }, // count changed slightly
      { db: 2, keys: 20 },
    ]);
    await store.loadRedisDatabases(conn.id);

    const reloadedChildren = store.treeNodes[0].children!;
    const reloadedDb2 = reloadedChildren.find((n) => n.database === "2")!;
    const reloadedDb1 = reloadedChildren.find((n) => n.database === "1")!;
    const reloadedDb0 = reloadedChildren.find((n) => n.database === "0")!;

    expect(store.isTreeNodePinned(reloadedDb2)).toBe(true);
    expect(store.isTreeNodePinned(reloadedDb1)).toBe(true);
    expect(store.isTreeNodePinned(reloadedDb0)).toBe(false);
    expect(reloadedChildren.map((n) => n.database)).toEqual(["2", "1", "0"]);

    // 4. Unpin db2: db1 remains pinned first, db2 returns to natural order
    store.toggleTreeNodePin(reloadedDb2);
    expect(store.isTreeNodePinned(reloadedDb2)).toBe(false);
    expect(store.isTreeNodePinned(reloadedDb1)).toBe(true);
    expect(store.treeNodes[0].children!.map((n) => n.database)).toEqual(["1", "0", "2"]);
  });

  it("preserves pinned state when alias is assigned after pinning and database is reloaded", async () => {
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    const savePinnedTreeNodeIds = vi.fn().mockResolvedValue(undefined);
    const redisListDatabases = vi.fn().mockResolvedValue([
      { db: 0, keys: 5 },
      { db: 1, keys: 10 },
    ]);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      saveConnections,
      savePinnedTreeNodeIds,
      redisListDatabases,
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({ sidebarPinDefaultDatabase: false });
    const store = useConnectionStore();
    const conn = redisConnection();
    store.connections = [conn];
    store.connectedIds.add(conn.id);
    store.treeNodes = [{ id: conn.id, label: conn.name, type: "connection", connectionId: conn.id, children: [] }];

    await store.loadRedisDatabases(conn.id);
    const db1Node = store.treeNodes[0].children!.find((n) => n.database === "1")!;

    // Pin db1 first without alias
    store.toggleTreeNodePin(db1Node);
    expect(store.isTreeNodePinned(db1Node)).toBe(true);

    // Set alias for db1
    await store.setRedisDatabaseAlias(conn.id, 1, "analytics");
    expect(store.isTreeNodePinned(db1Node)).toBe(true);

    // Reconnect / reload
    await store.loadRedisDatabases(conn.id);
    const reloadedDb1 = store.treeNodes[0].children!.find((n) => n.database === "1")!;
    expect(store.isTreeNodePinned(reloadedDb1)).toBe(true);
    expect(store.treeNodes[0].children!.map((n) => n.database)).toEqual(["1", "0"]);
  });
});
