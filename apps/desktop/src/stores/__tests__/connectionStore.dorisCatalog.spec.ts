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

function starRocksConnection(): ConnectionConfig {
  return {
    id: "starrocks-1",
    name: "StarRocks",
    db_type: "starrocks",
    host: "127.0.0.1",
    port: 9030,
    username: "root",
    password: "",
    database: "sales",
    visible_databases: ["analytics"],
  } as ConnectionConfig;
}

function catalogNode(connectionId: string, catalog: string, catalogType: string, children: TreeNode[] = []): TreeNode {
  return {
    id: `${connectionId}:doris-catalog:${catalog}`,
    label: catalog,
    type: "doris-catalog",
    connectionId,
    catalog,
    catalogType,
    isExpanded: true,
    children,
  };
}

function databaseNode(connectionId: string, catalog: string, database: string): TreeNode {
  return {
    id: `${connectionId}:doris-catalog:${catalog}:${database}`,
    label: database,
    type: "database",
    connectionId,
    catalog,
    database,
    isExpanded: true,
    children: [],
  };
}

describe("connectionStore Doris catalog tree", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("applies visible database filtering inside external catalogs", async () => {
    const listDorisCatalogDatabases = vi.fn().mockResolvedValue([{ name: "app" }, { name: "analytics" }]);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listDorisCatalogDatabases,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = starRocksConnection();
    const catalog = catalogNode(connection.id, "hive", "Hive");
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, children: [catalog] }];

    await store.loadTreeNodeChildren(catalog, { force: true });

    expect(catalog.children?.map((node) => [node.catalog, node.database])).toEqual([["hive", "analytics"]]);
  });

  it("refreshes the selected catalog when database names collide", async () => {
    const listTables = vi.fn().mockResolvedValue([{ name: "orders", table_type: "BASE TABLE", comment: null }]);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "grouped";
    const connection = starRocksConnection();
    const hiveDatabase = databaseNode(connection.id, "hive", "sales");
    const icebergDatabase = databaseNode(connection.id, "iceberg", "sales");
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        children: [catalogNode(connection.id, "hive", "Hive", [hiveDatabase]), catalogNode(connection.id, "iceberg", "Iceberg", [icebergDatabase])],
      },
    ];

    await store.refreshObjectListTreeNode(connection.id, "sales", "sales", "iceberg");

    expect(listTables).toHaveBeenCalledTimes(1);
    expect(listTables.mock.calls[0]?.[7]).toBe("iceberg");
    expect(hiveDatabase.children).toEqual([]);
    expect(icebergDatabase.children?.map((node) => [node.catalog, node.database, node.label])).toEqual([
      ["iceberg", "sales", "orders"],
      ["iceberg", "sales", "tree.queries"],
    ]);
  });
});
