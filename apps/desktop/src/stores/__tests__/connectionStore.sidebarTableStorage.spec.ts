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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("connectionStore sidebar table storage", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("reloads table sizes after refreshing an object list with a newly created table", async () => {
    const listTables = vi.fn().mockResolvedValue([
      { name: "EXISTING_TABLE", table_type: "BASE TABLE", comment: null },
      { name: "NEW_TABLE", table_type: "BASE TABLE", comment: null },
    ]);
    const initialStatistics = deferred<Array<{ name: string; schema: string; total_bytes: number }>>();
    const refreshedStatistics = deferred<Array<{ name: string; schema: string; total_bytes: number }>>();
    const listObjectStatistics = vi.fn().mockReturnValueOnce(initialStatistics.promise).mockReturnValueOnce(refreshedStatistics.promise);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listObjects: vi.fn().mockResolvedValue([]),
      listObjectStatistics,
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.sidebarObjectDisplay = "simple";
    settingsStore.editorSettings.sidebarObjectInfoMode = "size";

    const connection = {
      id: "oracle-1",
      name: "Oracle",
      db_type: "oracle",
      host: "127.0.0.1",
      port: 1521,
      username: "APP",
      password: "",
      database: "ORCL",
    } as ConnectionConfig;
    const existingTable: TreeNode = {
      id: "oracle-1:ORCL:APP:EXISTING_TABLE",
      label: "EXISTING_TABLE",
      type: "table",
      connectionId: connection.id,
      database: connection.database,
      schema: "APP",
    };
    const schemaNode: TreeNode = {
      id: "oracle-1:ORCL:APP",
      label: "APP",
      type: "schema",
      connectionId: connection.id,
      database: connection.database,
      schema: "APP",
      isExpanded: true,
      children: [existingTable],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, children: [schemaNode] }];

    const initialLoad = store.loadSidebarTableStorage({ connectionId: connection.id, database: connection.database, schema: "APP" });
    expect(listObjectStatistics).toHaveBeenCalledTimes(1);

    await store.refreshObjectListTreeNode(connection.id, connection.database, "APP");
    expect(listObjectStatistics).toHaveBeenCalledTimes(2);

    const currentExistingTable = schemaNode.children?.find((node) => node.label === "EXISTING_TABLE");
    const newTable = schemaNode.children?.find((node) => node.label === "NEW_TABLE");
    refreshedStatistics.resolve([
      { name: "EXISTING_TABLE", schema: "APP", total_bytes: 8192 },
      { name: "NEW_TABLE", schema: "APP", total_bytes: 16384 },
    ]);
    await vi.waitFor(() => expect(newTable?.sizeBytes).toBe(16384));

    initialStatistics.resolve([{ name: "EXISTING_TABLE", schema: "APP", total_bytes: 4096 }]);
    await initialLoad;
    expect(currentExistingTable?.sizeBytes).toBe(8192);
    expect(newTable?.sizeBytes).toBe(16384);
  });

  it("does not cache a table-size request that finishes after the connection is lost", async () => {
    const staleStatistics = deferred<Array<{ name: string; schema: string; total_bytes: number }>>();
    const listObjectStatistics = vi
      .fn()
      .mockReturnValueOnce(staleStatistics.promise)
      .mockResolvedValueOnce([{ name: "USERS", schema: "APP", total_bytes: 8192 }]);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listObjectStatistics,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectInfoMode = "size";
    const connection = { id: "oracle-1", name: "Oracle", db_type: "oracle", host: "127.0.0.1", port: 1521, username: "APP", password: "", database: "ORCL" } as ConnectionConfig;
    const tableNode = (): TreeNode => ({ id: "oracle-1:ORCL:APP:USERS", label: "USERS", type: "table", connectionId: connection.id, database: connection.database, schema: "APP" });
    const setLiveTree = () => {
      store.connectedIds.add(connection.id);
      store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, children: [tableNode()] }];
    };
    store.connections = [connection];
    setLiveTree();

    const staleLoad = store.loadSidebarTableStorage({ connectionId: connection.id, database: connection.database, schema: "APP" });
    store.markConnectionLost(connection.id, new Error("connection closed"));
    staleStatistics.resolve([{ name: "USERS", schema: "APP", total_bytes: 4096 }]);
    await staleLoad;

    setLiveTree();
    await store.loadSidebarTableStorage({ connectionId: connection.id, database: connection.database, schema: "APP" });

    expect(listObjectStatistics).toHaveBeenCalledTimes(2);
    expect(store.treeNodes[0]?.children?.[0]?.sizeBytes).toBe(8192);
  });

  it("does not cache a database-size request that finishes after the connection is lost", async () => {
    const staleStorage = deferred<Array<{ name: string; size_bytes: number }>>();
    const listDatabaseStorage = vi
      .fn()
      .mockReturnValueOnce(staleStorage.promise)
      .mockResolvedValueOnce([{ name: "app", size_bytes: 16384 }]);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      listDatabaseStorage,
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectInfoMode = "size";
    const connection = { id: "pg-1", name: "PostgreSQL", db_type: "postgres", host: "127.0.0.1", port: 5432, username: "postgres", password: "" } as ConnectionConfig;
    const setLiveTree = () => {
      store.connectedIds.add(connection.id);
      store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, children: [{ id: "pg-1:app", label: "app", type: "database", connectionId: connection.id, database: "app" }] }];
    };
    store.connections = [connection];
    setLiveTree();

    const staleLoad = store.loadSidebarDatabaseStorage(connection.id);
    store.markConnectionLost(connection.id, new Error("connection closed"));
    staleStorage.resolve([{ name: "app", size_bytes: 4096 }]);
    await staleLoad;

    setLiveTree();
    await store.loadSidebarDatabaseStorage(connection.id);

    expect(listDatabaseStorage).toHaveBeenCalledTimes(2);
    expect(store.treeNodes[0]?.children?.[0]?.sizeBytes).toBe(16384);
  });
});
