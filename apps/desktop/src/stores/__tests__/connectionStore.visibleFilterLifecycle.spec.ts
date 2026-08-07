import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeSchemaTreeCache } from "@/lib/metadata/schemaTreeCache";
import type { ConnectionConfig, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function mysqlConnection(visibleDatabases?: string[]): ConnectionConfig {
  return {
    id: "mysql-visible-1",
    name: "MySQL visible filter",
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    database: "filter_alpha",
    visible_databases: visibleDatabases,
  } as ConnectionConfig;
}

async function setupStore(visibleDatabases?: string[]) {
  const connection = mysqlConnection(visibleDatabases);
  const cachedChildren = [databaseNode(connection.id, "filter_alpha"), databaseNode(connection.id, "filter_beta")];
  const listDatabases = vi.fn().mockResolvedValue([
    { name: "filter_alpha", comment: null },
    { name: "filter_beta", comment: null },
    { name: "filter_gamma", comment: null },
  ]);
  const disconnectDb = vi.fn().mockResolvedValue(undefined);

  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    connectDb: vi.fn().mockResolvedValue(connection.id),
    connectionDatabaseInfo: vi.fn().mockResolvedValue(null),
    connectionIdentifierQuote: vi.fn().mockResolvedValue("`"),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    disconnectDb,
    listDatabases,
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    loadSchemaCache: vi.fn().mockResolvedValue(encodeSchemaTreeCache(cachedChildren)),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));

  const { useConnectionStore } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  store.connections = [connection];
  store.sidebarLayout = { groups: [], order: [{ type: "connection", id: connection.id }] };
  store.treeNodes = [
    {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: false,
      children: [],
    },
  ];
  return { connection, disconnectDb, listDatabases, store };
}

function databaseNode(connectionId: string, database: string): TreeNode {
  return {
    id: `${connectionId}:${database}`,
    label: database,
    type: "database",
    connectionId,
    database,
    isExpanded: false,
    children: [],
  };
}

describe("connectionStore visible filter lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("hydrates a saved partial filter count on first expansion and clears it on disconnect", async () => {
    const { connection, disconnectDb, listDatabases, store } = await setupStore(["filter_alpha", "filter_beta"]);

    expect(store.getSidebarVisibleFilterSummary(connection.id)).toEqual({ mode: "database", isActive: false, selected: null, total: null });

    await store.loadDatabases(connection.id);

    await vi.waitFor(() => expect(listDatabases).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(store.getSidebarVisibleFilterSummary(connection.id)).toEqual({
        mode: "database",
        isActive: true,
        selected: 2,
        total: 3,
      }),
    );
    expect(store.connectedIds.has(connection.id)).toBe(true);

    await store.disconnect(connection.id);

    expect(disconnectDb).toHaveBeenCalledWith(connection.id, expect.any(Number));
    expect(store.connectedIds.has(connection.id)).toBe(false);
    expect(store.getSidebarVisibleFilterSummary(connection.id)).toEqual({ mode: "database", isActive: false, selected: null, total: null });
  });

  it("does not add a background refresh for an unfiltered cached connection", async () => {
    const { connection, listDatabases, store } = await setupStore();

    await store.loadDatabases(connection.id);

    expect(store.connectedIds.has(connection.id)).toBe(true);
    expect(listDatabases).not.toHaveBeenCalled();
    expect(store.getSidebarVisibleFilterSummary(connection.id)).toEqual({ mode: "database", isActive: false, selected: null, total: null });
  });
});
