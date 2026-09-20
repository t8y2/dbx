import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

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

function manyRedisDatabases(count: number) {
  return Array.from({ length: count }, (_, db) => ({ db, keys: db === 0 ? 5 : 0 }));
}

describe("connectionStore Redis database display limit (#1236)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("caps the sidebar list at the configured limit and appends a load-more node", async () => {
    const redisListDatabases = vi.fn().mockResolvedValue(manyRedisDatabases(30));
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      redisListDatabases,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().updateEditorSettings({ redisDatabaseDisplayLimit: 10 });

    const store = useConnectionStore();
    const connection = redisConnection();
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, children: [] }];

    await store.loadRedisDatabases(connection.id);

    const children = store.treeNodes[0].children ?? [];
    expect(children.filter((node) => node.type === "redis-db")).toHaveLength(10);
    const loadMore = children.find((node) => node.type === "load-more");
    expect(loadMore).toBeDefined();
    expect(loadMore?.loadMore).toEqual({ parentId: connection.id, offset: 10, pageSize: 20 });

    await store.loadMoreObjectGroupChildren(loadMore!);

    const expandedChildren = store.treeNodes[0].children ?? [];
    expect(expandedChildren.filter((node) => node.type === "redis-db")).toHaveLength(30);
    expect(expandedChildren.some((node) => node.type === "load-more")).toBe(false);
    expect(redisListDatabases).toHaveBeenCalledTimes(2);
  });

  it("does not truncate when the database count is within the configured limit", async () => {
    const redisListDatabases = vi.fn().mockResolvedValue(manyRedisDatabases(16));
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      redisListDatabases,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    // Default limit (1000) — the historical "show everything" behavior must be unchanged.
    expect(useSettingsStore().editorSettings.redisDatabaseDisplayLimit).toBe(1000);

    const store = useConnectionStore();
    const connection = redisConnection();
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, children: [] }];

    await store.loadRedisDatabases(connection.id);

    const children = store.treeNodes[0].children ?? [];
    expect(children.filter((node) => node.type === "redis-db")).toHaveLength(16);
    expect(children.some((node) => node.type === "load-more")).toBe(false);
  });
});
