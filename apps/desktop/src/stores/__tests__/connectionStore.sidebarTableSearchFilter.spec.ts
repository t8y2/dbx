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
  const listTables = vi.fn().mockResolvedValue([
    { name: "t_order", table_type: "BASE TABLE" },
    { name: "t_user", table_type: "BASE TABLE" },
  ]);

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
  return { store, connectDb, listTables };
}

function tablesGroupNode(store: ReturnType<typeof setup>["store"]): TreeNode {
  const database = store.treeNodes[0].children![0];
  return database.children![0];
}

describe("sidebar table search index respects the per-connection table filter", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("passes the per-connection table filter when building the search index", async () => {
    const { store, connectDb, listTables } = await setup();
    const group = tablesGroupNode(store);
    store.setSidebarTableNameFilter(store.tableNameFilterScopeKey({ connectionId: group.connectionId!, database: group.database, schema: group.schema, nodeKind: group.type, catalog: group.catalog }), { includePatterns: ["t_order%"], excludePatterns: [] });

    const entries = await store.refreshSidebarTableSearchIndex(group.id);

    expect(connectDb).toHaveBeenCalledTimes(1);
    const call = listTables.mock.calls.at(-1)!;
    expect(call[8]).toEqual({ includePatterns: ["t_order%"], excludePatterns: [] });
    expect((entries ?? []).map((entry) => entry.name)).toEqual(["t_order", "t_user"]);
  }, 20_000);

  it("builds the index without a filter when none is set", async () => {
    const { store, listTables } = await setup();
    const group = tablesGroupNode(store);

    await store.refreshSidebarTableSearchIndex(group.id);

    const call = listTables.mock.calls.at(-1)!;
    expect(call[8]).toBeUndefined();
  }, 20_000);

  it("drops the stale index when the table filter changes and rebuilds with the filter", async () => {
    const { store, listTables } = await setup();
    const group = tablesGroupNode(store);
    const scopeKey = store.tableNameFilterScopeKey({ connectionId: group.connectionId!, database: group.database, schema: group.schema, nodeKind: group.type, catalog: group.catalog });

    // 无过滤时先建一次索引（未过滤的旧索引会一直留在缓存里）。
    await store.refreshSidebarTableSearchIndex(group.id);
    const cached = await store.loadSidebarTableSearchIndex(group.id);
    expect((cached ?? []).map((entry) => entry.name)).toEqual(["t_order", "t_user"]);

    // 用户修改过滤条件：树刷新 + 索引失效，重建时必须带上过滤器。
    store.setSidebarTableNameFilter(scopeKey, { includePatterns: ["t_user%"], excludePatterns: [] });
    await store.refreshTreeNodeForTableNameFilter(group, scopeKey, 1);

    const invalidated = await store.loadSidebarTableSearchIndex(group.id);
    expect(invalidated).toBeNull();

    const rebuilt = await store.refreshSidebarTableSearchIndex(group.id);
    const call = listTables.mock.calls.at(-1)!;
    expect(call[8]).toEqual({ includePatterns: ["t_user%"], excludePatterns: [] });
    expect((rebuilt ?? []).map((entry) => entry.name)).toEqual(["t_order", "t_user"]);
  }, 20_000);
});
