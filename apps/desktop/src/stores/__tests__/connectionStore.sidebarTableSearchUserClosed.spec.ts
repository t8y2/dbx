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

function pgConnection(id: string): ConnectionConfig {
  return { id, name: id, db_type: "postgres", host: "127.0.0.1", port: 5432, username: "postgres", password: "", database: "app", read_only: false } as ConnectionConfig;
}

function databaseNode(connectionId: string, database: string): TreeNode {
  return {
    id: `${connectionId}:${database}`,
    label: database,
    type: "database",
    connectionId,
    database,
    isExpanded: true,
    children: [{ id: `${connectionId}:${database}:__tables`, label: "tables", type: "group-tables", connectionId, database, children: [] }],
  };
}

async function setup() {
  const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);
  const connectDb = vi.fn(async (config: ConnectionConfig) => config.id);
  const listTables = vi.fn().mockResolvedValue([]);

  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth,
    connectDb,
    listTables,
    disconnectDb: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    deleteTableVGroupsForConnection: vi.fn().mockResolvedValue(undefined),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));

  const { useConnectionStore } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  store.connections = [pgConnection("conn-a")];
  // 侧栏里该库的节点还在（这是搜索输入框存在的前提）。
  store.treeNodes = [
    {
      id: "conn-a",
      label: "conn-a",
      type: "connection",
      connectionId: "conn-a",
      isExpanded: true,
      children: [databaseNode("conn-a", "app")],
    },
  ];
  store.sidebarTableSearchQueries = { "conn-a:app": "user" };
  return { store, connectDb, listTables };
}

describe("sidebar table search never wakes an explicitly user-closed connection", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("declines to build the index instead of reconnecting", async () => {
    const { store, connectDb, listTables } = await setup();
    store.userClosedConnectionIds = new Set(["conn-a"]);

    // 首次搜索触发索引构建（ConnectionTree → loadOrBuildSidebarTableSearchIndex → build）。
    const entries = await store.refreshSidebarTableSearchIndex("conn-a:app");

    expect(connectDb).not.toHaveBeenCalled();
    expect(listTables).not.toHaveBeenCalled();
    // null = 本次不建索引，UI 回退到"只过滤已加载的表"，不会缓存成"无匹配"。
    expect(entries).toBeNull();
    expect(store.connectedIds.has("conn-a")).toBe(false);
  }, 20_000);

  it("still builds normally when the connection was not closed by the user", async () => {
    const { store, connectDb, listTables } = await setup();

    const entries = await store.refreshSidebarTableSearchIndex("conn-a:app");

    expect(connectDb).toHaveBeenCalledTimes(1);
    expect(listTables).toHaveBeenCalled();
    expect(Array.isArray(entries)).toBe(true);
  }, 20_000);

  it("remote table search refresh is guarded the same way", async () => {
    const { store, connectDb, listTables } = await setup();
    store.userClosedConnectionIds = new Set(["conn-a"]);

    await store.refreshSidebarTableSearch("conn-a:app");

    expect(connectDb).not.toHaveBeenCalled();
    expect(listTables).not.toHaveBeenCalled();
  }, 20_000);
});
