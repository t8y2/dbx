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

function mysqlConnection(): ConnectionConfig {
  return {
    id: "mysql-1",
    name: "MySQL",
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    database: "app",
  } as ConnectionConfig;
}

function treeWithDatabases(connection: ConnectionConfig, databases: { name: string; sizeBytes: number | null }[]): TreeNode[] {
  return [
    {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: databases.map((db) => ({
        id: `${connection.id}:${db.name}`,
        label: db.name,
        type: "database",
        connectionId: connection.id,
        database: db.name,
        sizeBytes: db.sizeBytes,
        isExpanded: false,
        children: [],
      })),
    },
  ];
}

async function setupStore(databaseSizeImpl: (connectionId: string, database: string) => Promise<number | null>) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    databaseSize: vi.fn(databaseSizeImpl),
    listDatabaseStatistics: vi.fn().mockResolvedValue([]),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));
  const { useConnectionStore } = await import("@/stores/connectionStore");
  return useConnectionStore();
}

describe("connectionStore database size (manual)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("fetchDatabaseSize updates only the targeted database node", async () => {
    const store = await setupStore(async () => 2048);
    const connection = mysqlConnection();
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = treeWithDatabases(connection, [
      { name: "app", sizeBytes: null },
      { name: "other", sizeBytes: 111 },
    ]);

    const result = await store.fetchDatabaseSize(connection.id, "app");

    expect(result).toBe(2048);
    const children = store.treeNodes[0].children!;
    expect(children.find((n) => n.database === "app")?.sizeBytes).toBe(2048);
    expect(children.find((n) => n.database === "other")?.sizeBytes).toBe(111);
  });

  it("automatic statistics with null does not overwrite a manually fetched size", async () => {
    const store = await setupStore(async () => 4096);
    const connection = mysqlConnection();
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = treeWithDatabases(connection, [{ name: "app", sizeBytes: 4096 }]);

    // Automatic pass timed out for "app" (size_bytes null) — must keep the manual value.
    const changed = store.applyDatabaseStatisticsToConnectionTree(connection.id, [{ name: "app", size_bytes: null }]);

    expect(changed).toBe(false);
    expect(store.treeNodes[0].children![0].sizeBytes).toBe(4096);
  });

  it("automatic statistics still fills sizes that are not yet known", async () => {
    const store = await setupStore(async () => 4096);
    const connection = mysqlConnection();
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = treeWithDatabases(connection, [{ name: "app", sizeBytes: null }]);

    const changed = store.applyDatabaseStatisticsToConnectionTree(connection.id, [{ name: "app", size_bytes: 9000 }]);

    expect(changed).toBe(true);
    expect(store.treeNodes[0].children![0].sizeBytes).toBe(9000);
  });
});
