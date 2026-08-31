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

function mysqlConnection(): ConnectionConfig {
  return {
    id: "mysql-info",
    name: "MySQL",
    db_type: "mysql",
    driver_profile: "mysql",
    driver_label: "MySQL",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "secret",
    database: "app",
  };
}

describe("connectionStore database info", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("persists metadata from a successful live connection without marking it disconnected", async () => {
    const config = mysqlConnection();
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    const saveConnectionDatabaseInfo = vi.fn().mockResolvedValue(undefined);
    const connectionDatabaseInfo = vi.fn().mockResolvedValue({ productName: "MySQL", productVersion: "8.0.34" });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb: vi.fn().mockResolvedValue(config.id),
      connectionDatabaseInfo,
      saveConnectionDatabaseInfo,
      saveConnections,
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(config);
    await store.connect(config);

    await vi.waitFor(() => expect(saveConnectionDatabaseInfo).toHaveBeenCalled());
    expect(connectionDatabaseInfo).toHaveBeenCalledWith(config.id);
    expect(saveConnectionDatabaseInfo).toHaveBeenCalledWith(config.id, {
      productName: "MySQL",
      productVersion: "8.0.34",
      currentDatabase: "app",
      serverComment: undefined,
      serverCharset: undefined,
      serverCollation: undefined,
      unquotedIdentifierCase: undefined,
      quotedIdentifierCase: undefined,
      driverName: undefined,
      driverVersion: undefined,
      jdbcVersion: undefined,
    });
    expect(store.getConfig(config.id)?.database_info?.productVersion).toBe("8.0.34");
    expect(store.connectedIds.has(config.id)).toBe(true);
  });

  it("preserves the connection tree node while background database info is stored", async () => {
    const config = mysqlConnection();
    const saveConnectionDatabaseInfo = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb: vi.fn().mockResolvedValue(config.id),
      connectionDatabaseInfo: vi.fn().mockResolvedValue({ productName: "MySQL", productVersion: "8.0.34" }),
      saveConnectionDatabaseInfo,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(config);
    const connectionNode = store.treeNodes[0];

    await store.connect(config);
    await vi.waitFor(() => expect(saveConnectionDatabaseInfo).toHaveBeenCalled());

    expect(store.treeNodes[0]).toBe(connectionNode);
    expect(store.getConfig(config.id)?.database_info?.productVersion).toBe("8.0.34");
    expect(store.connectedIds.has(config.id)).toBe(true);
  });

  it("keeps a live connection when only its note changes", async () => {
    const config = mysqlConnection();
    const saveConnections = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb: vi.fn().mockResolvedValue(config.id),
      connectionDatabaseInfo: vi.fn().mockRejectedValue(new Error("metadata unavailable")),
      saveConnections,
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(config);
    await store.connect(config);
    const connectionNode = store.treeNodes[0];
    connectionNode.isExpanded = true;
    const existingChildIds = connectionNode.children?.map((child) => child.id);

    await store.updateConnection({ ...config, note: "Production reporting" });

    expect(saveConnections).toHaveBeenLastCalledWith([expect.objectContaining({ id: config.id, note: "Production reporting" })]);
    expect(store.getConfig(config.id)?.note).toBe("Production reporting");
    expect(store.connectedIds.has(config.id)).toBe(true);
    expect(store.treeNodes[0].comment).toBe("Production reporting");
    expect(store.treeNodes[0].isExpanded).toBe(true);
    expect(store.treeNodes[0].children?.map((child) => child.id)).toEqual(existingChildIds);
  });

  it("does not delay connection success while optional metadata is loading", async () => {
    const config = mysqlConnection();
    let resolveDatabaseInfo!: (value: { productName: string; productVersion: string }) => void;
    const databaseInfo = new Promise<{ productName: string; productVersion: string }>((resolve) => {
      resolveDatabaseInfo = resolve;
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb: vi.fn().mockResolvedValue(config.id),
      connectionDatabaseInfo: vi.fn(() => databaseInfo),
      saveConnectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(config);
    await expect(store.connect(config)).resolves.toBe(config.id);
    expect(store.connectedIds.has(config.id)).toBe(true);

    resolveDatabaseInfo({ productName: "MySQL", productVersion: "8.0.34" });
    await vi.waitFor(() => expect(store.getConfig(config.id)?.database_info?.productVersion).toBe("8.0.34"));
  });

  it("refreshes physical table metadata after delayed ShardingSphere detection", async () => {
    const config = mysqlConnection();
    let resolveDatabaseInfo!: (value: { productName: string; productVersion: string }) => void;
    const databaseInfo = new Promise<{ productName: string; productVersion: string }>((resolve) => {
      resolveDatabaseInfo = resolve;
    });
    let useLogicalTables = false;
    const listTables = vi.fn().mockImplementation(async () => [
      {
        name: useLogicalTables ? "async_task" : "async_task_0",
        table_type: "BASE TABLE",
        comment: null,
      },
    ]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      connectDb: vi.fn().mockResolvedValue(config.id),
      connectionDatabaseInfo: vi.fn(() => databaseInfo),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listDatabases: vi.fn().mockResolvedValue([{ name: "app" }]),
      listObjects: vi.fn().mockResolvedValue([]),
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnectionDatabaseInfo: vi.fn().mockImplementation(async () => {
        useLogicalTables = true;
      }),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    await store.addConnection(config);
    await store.connect(config);
    await store.loadDatabases(config.id, { force: true });
    const databaseNode = store.treeNodes[0]?.children?.find((node) => node.type === "database" && node.database === "app");
    expect(databaseNode).toBeDefined();
    await store.loadTreeNodeChildren(databaseNode!, { force: true });
    expect(databaseNode?.children?.filter((node) => node.type === "table").map((node) => node.label)).toEqual(["async_task_0"]);

    resolveDatabaseInfo({ productName: "MySQL", productVersion: "8.0.27-ShardingSphere-Proxy 5.5.2" });

    await vi.waitFor(() => {
      const refreshedDatabaseNode = store.treeNodes[0]?.children?.find((node) => node.type === "database" && node.database === "app");
      expect(refreshedDatabaseNode?.children?.filter((node) => node.type === "table").map((node) => node.label)).toEqual(["async_task"]);
    });
    expect(listTables).toHaveBeenCalledTimes(2);
  });

  it("does not let a pre-detection table request overwrite the refreshed logical tables", async () => {
    const config = mysqlConnection();
    let resolveDatabaseInfo!: (value: { productName: string; productVersion: string }) => void;
    const databaseInfo = new Promise<{ productName: string; productVersion: string }>((resolve) => {
      resolveDatabaseInfo = resolve;
    });
    let resolvePhysicalTables!: (value: Array<{ name: string; table_type: string; comment: null }>) => void;
    const physicalTables = new Promise<Array<{ name: string; table_type: string; comment: null }>>((resolve) => {
      resolvePhysicalTables = resolve;
    });
    let useLogicalTables = false;
    const listTables = vi
      .fn()
      .mockImplementationOnce(() => physicalTables)
      .mockResolvedValue([
        {
          name: "async_task",
          table_type: "BASE TABLE",
          comment: null,
        },
      ]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      connectDb: vi.fn().mockResolvedValue(config.id),
      connectionDatabaseInfo: vi.fn(() => databaseInfo),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listDatabases: vi.fn().mockResolvedValue([{ name: "app" }]),
      listObjects: vi.fn().mockResolvedValue([]),
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnectionDatabaseInfo: vi.fn().mockImplementation(async () => {
        useLogicalTables = true;
      }),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    await store.addConnection(config);
    await store.connect(config);
    await store.loadDatabases(config.id, { force: true });
    const databaseNode = store.treeNodes[0]?.children?.find((node) => node.type === "database" && node.database === "app");
    expect(databaseNode).toBeDefined();
    databaseNode!.isExpanded = true;
    const physicalLoad = store.loadTreeNodeChildren(databaseNode!, { force: true });
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledTimes(1));

    resolveDatabaseInfo({ productName: "MySQL", productVersion: "8.0.27-ShardingSphere-Proxy 5.5.2" });
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledTimes(2));
    resolvePhysicalTables([
      {
        name: "async_task_0",
        table_type: "BASE TABLE",
        comment: null,
      },
    ]);
    await physicalLoad;

    await vi.waitFor(() => {
      const refreshedDatabaseNode = store.treeNodes[0]?.children?.find((node) => node.type === "database" && node.database === "app");
      expect(refreshedDatabaseNode?.children?.filter((node) => node.type === "table").map((node) => node.label)).toEqual(["async_task"]);
    });
    expect(useLogicalTables).toBe(true);
  });

  it("keeps a successful connection when optional metadata refresh fails", async () => {
    const config = mysqlConnection();

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb: vi.fn().mockResolvedValue(config.id),
      connectionDatabaseInfo: vi.fn().mockRejectedValue(new Error("metadata unavailable")),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(config);
    await expect(store.connect(config)).resolves.toBe(config.id);
    expect(store.connectedIds.has(config.id)).toBe(true);
  });
});
