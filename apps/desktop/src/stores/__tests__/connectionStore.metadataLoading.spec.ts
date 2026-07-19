import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, ObjectInfo, TableInfo, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function postgresConnection(): ConnectionConfig {
  return {
    id: "pg-1",
    name: "Postgres",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app",
  } as ConnectionConfig;
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

function procedure(name: string): ObjectInfo {
  return {
    name,
    object_type: "PROCEDURE",
    schema: "app",
    comment: null,
    created_at: null,
    updated_at: null,
    parent_schema: null,
    parent_name: null,
  };
}

describe("connectionStore metadata loading", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("loads missing database roots only for connected sidebar search targets", async () => {
    const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);
    const listDatabases = vi.fn().mockResolvedValue([{ name: "dajia", comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      listDatabases,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { filterSidebarTree } = await import("@/lib/sidebar/sidebarSearchTree");
    const store = useConnectionStore();
    const active = { ...mysqlConnection(), id: "mysql-active", name: "localhost" };
    const connected = { ...mysqlConnection(), id: "mysql-connected", name: "PLM-PRO" };
    const disconnected = { ...mysqlConnection(), id: "mysql-disconnected", name: "offline" };
    const nodes: TreeNode[] = [
      {
        id: active.id,
        label: active.name,
        type: "connection",
        connectionId: active.id,
        isExpanded: true,
        children: [{ id: `${active.id}:dajia`, label: "dajia", type: "database", connectionId: active.id, database: "dajia", isExpanded: false }],
      },
      { id: connected.id, label: connected.name, type: "connection", connectionId: connected.id, isExpanded: false, children: [] },
      { id: disconnected.id, label: disconnected.name, type: "connection", connectionId: disconnected.id, isExpanded: false, children: [] },
    ];
    store.connections = [active, connected, disconnected];
    store.connectedIds = new Set([active.id, connected.id]);
    store.activeConnectionId = active.id;
    store.treeNodes = nodes;

    await Promise.all(nodes.map((node) => store.loadConnectedConnectionRootForSidebarSearch(node.connectionId!)));

    expect(listDatabases).toHaveBeenCalledTimes(1);
    expect(listDatabases).toHaveBeenCalledWith(connected.id);
    expect(checkConnectionHealth).not.toHaveBeenCalled();
    expect(store.activeConnectionId).toBe(active.id);
    expect(nodes.map((node) => node.isExpanded)).toEqual([true, false, false]);
    expect(filterSidebarTree(nodes, "dajia", new Set()).map((node) => node.id)).toEqual([active.id, connected.id]);
  });

  it("does not collapse a connection whose normal root load is already in flight", async () => {
    let resolveDatabases!: (databases: Array<{ name: string; comment: null }>) => void;
    let markListStarted!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const listDatabases = vi.fn(
      () =>
        new Promise<Array<{ name: string; comment: null }>>((resolve) => {
          resolveDatabases = resolve;
          markListStarted();
        }),
    );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listDatabases,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = mysqlConnection();
    const node: TreeNode = { id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, isExpanded: false, children: [] };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [node];

    const normalLoad = store.loadDatabases(connection.id);
    const searchLoad = store.loadConnectedConnectionRootForSidebarSearch(connection.id);
    await listStarted;
    resolveDatabases([{ name: "dajia", comment: null }]);
    await Promise.all([normalLoad, searchLoad]);

    expect(listDatabases).toHaveBeenCalledTimes(1);
    expect(node.isExpanded).toBe(true);
  });

  it("renders simple-mode table children without waiting for supplemental objects", async () => {
    const tables: TableInfo[] = [{ name: "users", table_type: "TABLE", comment: null }];
    const listTables = vi.fn().mockResolvedValue(tables);
    const listObjects = vi.fn(() => new Promise(() => undefined));

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listObjects,
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.sidebarObjectDisplay = "simple";

    const connection = postgresConnection();
    const schemaNode: TreeNode = {
      id: "pg-1:app:public",
      label: "public",
      type: "schema",
      connectionId: connection.id,
      database: "app",
      schema: "public",
      isExpanded: false,
      children: [],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isExpanded: true,
        children: [
          {
            id: "pg-1:app",
            label: "app",
            type: "database",
            connectionId: connection.id,
            database: "app",
            isExpanded: true,
            children: [schemaNode],
          },
        ],
      },
    ];

    const result = await Promise.race([store.loadTables(connection.id, "app", "public").then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("timeout"), 50))]);

    expect(result).toBe("done");
    expect(listTables).toHaveBeenCalledWith(connection.id, "app", "public", undefined, 1001, 0);
    expect(listObjects).toHaveBeenCalled();
    expect(schemaNode.children?.map((node) => node.label)).toEqual(["users"]);
  });

  it("clears a stale connection error after a schema metadata retry succeeds", async () => {
    const listSchemaInfos = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection slots exhausted"))
      .mockResolvedValueOnce([{ name: "public", comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listSchemaInfos,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection();
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isExpanded: true,
        children: [
          {
            id: `${connection.id}:app`,
            label: "app",
            type: "database",
            connectionId: connection.id,
            database: "app",
            isExpanded: false,
            children: [],
          },
        ],
      },
    ];

    await expect(store.loadSchemas(connection.id, "app", { force: true })).rejects.toThrow("connection slots exhausted");
    expect(store.connectionErrors[connection.id]).toBe("connection slots exhausted");

    await store.loadSchemas(connection.id, "app", { force: true });

    expect(store.connectionErrors[connection.id]).toBeUndefined();
    expect(store.treeNodes[0]?.children?.[0]?.children?.map((node) => node.label)).toEqual(["public"]);
  });

  it("clears a failed metadata warning when the driver hint finishes during retry", async () => {
    let resolveAgents!: (drivers: Array<{ db_type: string; installed: boolean; update_available: boolean }>) => void;
    let resolveSchemas!: (schemas: Array<{ name: string; comment: null }>) => void;
    const listInstalledAgents = vi.fn(
      () =>
        new Promise<Array<{ db_type: string; installed: boolean; update_available: boolean }>>((resolve) => {
          resolveAgents = resolve;
        }),
    );
    const listSchemaInfos = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection slots exhausted"))
      .mockImplementationOnce(
        () =>
          new Promise<Array<{ name: string; comment: null }>>((resolve) => {
            resolveSchemas = resolve;
          }),
      );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents,
      listSchemaInfos,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = { ...postgresConnection(), db_type: "oracle" } as ConnectionConfig;
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isExpanded: true,
        children: [
          {
            id: `${connection.id}:app`,
            label: "app",
            type: "database",
            connectionId: connection.id,
            database: "app",
            isExpanded: false,
            children: [],
          },
        ],
      },
    ];

    await expect(store.loadSchemas(connection.id, "app", { force: true })).rejects.toThrow("connection slots exhausted");
    expect(store.connectionErrors[connection.id]).toBe("connection slots exhausted");

    const retry = store.loadSchemas(connection.id, "app", { force: true });
    await vi.waitFor(() => expect(listSchemaInfos).toHaveBeenCalledTimes(2));

    resolveAgents([{ db_type: "oracle", installed: true, update_available: true }]);
    await vi.waitFor(() => expect(store.connectionErrors[connection.id]).toContain("built-in driver update"));

    resolveSchemas([{ name: "public", comment: null }]);
    await retry;

    expect(store.connectionErrors[connection.id]).toBeUndefined();
  });

  it("does not clear a newer error when an older metadata request succeeds", async () => {
    let resolveSchemas!: (schemas: Array<{ name: string; comment: null }>) => void;
    const listSchemaInfos = vi.fn(
      () =>
        new Promise<Array<{ name: string; comment: null }>>((resolve) => {
          resolveSchemas = resolve;
        }),
    );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listSchemaInfos,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection();
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isExpanded: true,
        children: [
          {
            id: `${connection.id}:app`,
            label: "app",
            type: "database",
            connectionId: connection.id,
            database: "app",
            isExpanded: false,
            children: [],
          },
        ],
      },
    ];
    store.setConnectionError(connection.id, "old error");

    const load = store.loadSchemas(connection.id, "app", { force: true });
    await vi.waitFor(() => expect(listSchemaInfos).toHaveBeenCalledOnce());
    store.setConnectionError(connection.id, "newer error");
    resolveSchemas([{ name: "public", comment: null }]);
    await load;

    expect(store.connectionErrors[connection.id]).toBe("newer error");
  });

  it("keeps an expanding schema attached while its parent refreshes", async () => {
    const listSchemaInfos = vi.fn().mockResolvedValue([{ name: "core", comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listSchemaInfos,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection();
    const schemaNode: TreeNode = {
      id: "pg-1:app:core",
      label: "core",
      type: "schema",
      connectionId: connection.id,
      database: "app",
      schema: "core",
      isExpanded: true,
      isLoading: true,
      children: [],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isExpanded: true,
        children: [
          {
            id: "pg-1:app",
            label: "app",
            type: "database",
            connectionId: connection.id,
            database: "app",
            isExpanded: true,
            children: [schemaNode],
          },
        ],
      },
    ];

    const storedSchema = store.treeNodes[0].children?.[0].children?.[0];
    await store.loadSchemas(connection.id, "app", { force: true });

    const refreshedSchema = store.treeNodes[0].children?.[0].children?.[0];
    expect(refreshedSchema).toBe(storedSchema);
    expect(refreshedSchema?.isExpanded).toBe(true);
    expect(refreshedSchema?.isLoading).toBe(true);
  });

  it("paginates procedure groups and appends the next page", async () => {
    const firstPage = Array.from({ length: 201 }, (_, index) => procedure(`p_${String(index + 1).padStart(4, "0")}`));
    const listObjects = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([procedure("p_0201"), procedure("p_0202")])
      .mockResolvedValueOnce([procedure("p_0999")]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listObjects,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.sidebarObjectDisplay = "grouped";
    settingsStore.desktopSettings.sidebar_table_page_size = 200;

    const connection = mysqlConnection();
    const procedureGroup: TreeNode = {
      id: "mysql-1:app:__procedures",
      label: "tree.procedures",
      type: "group-procedures",
      connectionId: connection.id,
      database: "app",
      isExpanded: false,
      children: [],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isExpanded: true,
        children: [
          {
            id: "mysql-1:app",
            label: "app",
            type: "database",
            connectionId: connection.id,
            database: "app",
            isExpanded: true,
            children: [procedureGroup],
          },
        ],
      },
    ];

    const storedProcedureGroup = store.treeNodes[0].children?.[0].children?.[0];
    expect(storedProcedureGroup?.type).toBe("group-procedures");
    await store.loadObjectGroupChildren(storedProcedureGroup!);

    expect(listObjects).toHaveBeenNthCalledWith(1, connection.id, "app", "app", ["PROCEDURE"], undefined, 201, 0);
    expect(storedProcedureGroup?.children).toHaveLength(201);
    expect(storedProcedureGroup?.children?.[0].label).toBe("p_0001");
    expect(storedProcedureGroup?.children?.[199].label).toBe("p_0200");
    expect(storedProcedureGroup?.children?.[200].label).toBe("tree.loadMore");

    const loadMoreNode = storedProcedureGroup?.children?.at(-1);
    expect(loadMoreNode?.type).toBe("load-more");
    await store.loadMoreObjectGroupChildren(loadMoreNode!);

    expect(listObjects).toHaveBeenNthCalledWith(2, connection.id, "app", "app", ["PROCEDURE"], undefined, 201, 200);
    expect(storedProcedureGroup?.children).toHaveLength(202);
    expect(storedProcedureGroup?.children?.at(-1)?.label).toBe("p_0202");

    store.sidebarSearchQuery = "p_0999";
    await store.loadObjectGroupChildren(storedProcedureGroup!, { force: true, searchFilter: "p_0999" });

    expect(listObjects).toHaveBeenNthCalledWith(3, connection.id, "app", "app", ["PROCEDURE"], "p_0999", undefined, undefined);
    expect(storedProcedureGroup?.children?.map((node) => node.label)).toEqual(["p_0999"]);
  });
});
