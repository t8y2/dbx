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

function dorisConnection(): ConnectionConfig {
  return {
    ...mysqlConnection(),
    id: "doris-1",
    name: "Doris",
    db_type: "doris",
    port: 9030,
  } as ConnectionConfig;
}

function oracleConnection(): ConnectionConfig {
  return {
    id: "oracle-1",
    name: "Oracle",
    db_type: "oracle",
    host: "127.0.0.1",
    port: 1521,
    username: "SYSTEM",
    password: "",
    database: "XE",
  } as ConnectionConfig;
}

function genericJdbcConnection(): ConnectionConfig {
  return {
    id: "jdbc-1",
    name: "Generic JDBC",
    db_type: "jdbc",
    host: "127.0.0.1",
    port: 0,
    username: "app",
    password: "",
    database: "testdb",
    driver_profile: "jdbc",
    connection_string: "jdbc:example://127.0.0.1/testdb",
  } as ConnectionConfig;
}

function informixConnection(): ConnectionConfig {
  return {
    id: "informix-1",
    name: "Informix",
    db_type: "informix",
    host: "127.0.0.1",
    port: 9088,
    username: "informix",
    password: "",
    database: "prulife",
  } as ConnectionConfig;
}

function gbase8sConnection(): ConnectionConfig {
  return {
    ...informixConnection(),
    id: "gbase8s-1",
    name: "GBase 8s",
    db_type: "gbase",
    driver_profile: "gbase8s",
    database: "dbx_test",
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
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
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
  }, 10_000);

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
  }, 10_000);

  it("discovers schema nodes for unknown generic JDBC databases", async () => {
    const listSchemaInfos = vi.fn().mockResolvedValue([
      { name: "app", comment: null },
      { name: "reporting", comment: null },
    ]);
    const listTables = vi.fn().mockResolvedValue([]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listSchemaInfos,
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = genericJdbcConnection();
    const databaseNode: TreeNode = { id: "jdbc-1:testdb", label: "testdb", type: "database", connectionId: connection.id, database: "testdb", isExpanded: false, children: [] };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, isExpanded: true, children: [databaseNode] }];

    await store.loadTreeNodeChildren(databaseNode, { force: true });

    expect(listSchemaInfos).toHaveBeenCalledWith(connection.id, "testdb");
    expect(listTables).not.toHaveBeenCalled();
    expect(databaseNode.children?.map((node) => [node.type, node.label, node.schema])).toEqual([
      ["schema", "app", "app"],
      ["schema", "reporting", "reporting"],
    ]);
  });

  it("keeps the flat object tree for unknown generic JDBC databases without schemas", async () => {
    const listSchemaInfos = vi.fn().mockResolvedValue([]);
    const listTables = vi.fn().mockResolvedValue([{ name: "t", table_type: "TABLE", comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listObjects: vi.fn().mockResolvedValue([]),
      listSchemaInfos,
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const connection = genericJdbcConnection();
    const databaseNode: TreeNode = { id: "jdbc-1:testdb", label: "testdb", type: "database", connectionId: connection.id, database: "testdb", isExpanded: false, children: [] };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, isExpanded: true, children: [databaseNode] }];

    await store.loadTreeNodeChildren(databaseNode, { force: true });

    expect(listSchemaInfos).toHaveBeenCalledWith(connection.id, "testdb");
    expect(listTables).toHaveBeenCalled();
    expect(databaseNode.children?.map((node) => [node.type, node.label, node.schema])).toEqual([["table", "t", undefined]]);
  });

  it("keeps the flat object tree for GBase 8s databases that cannot qualify schemas in DML", async () => {
    const listSchemaInfos = vi.fn().mockResolvedValue([]);
    const listTables = vi.fn().mockResolvedValue([{ name: "connection_smoke", table_type: "TABLE", comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listObjects: vi.fn().mockResolvedValue([]),
      listSchemaInfos,
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const connection = gbase8sConnection();
    const databaseNode: TreeNode = { id: `${connection.id}:dbx_test`, label: "dbx_test", type: "database", connectionId: connection.id, database: "dbx_test", isExpanded: false, children: [] };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, isExpanded: true, children: [databaseNode] }];

    await store.loadTreeNodeChildren(databaseNode, { force: true });

    expect(listSchemaInfos).toHaveBeenCalledWith(connection.id, "dbx_test");
    expect(listTables).toHaveBeenCalled();
    expect(databaseNode.children?.map((node) => [node.type, node.label, node.schema])).toEqual([["table", "connection_smoke", undefined]]);
  });

  it("renders simple-mode table children without waiting for supplemental objects", async () => {
    const tables: TableInfo[] = [{ name: "users", table_type: "BASE TABLE", comment: null }];
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

  it("keeps concurrent table-tree and local-index refreshes in separate cache entries", async () => {
    const treeCacheKey = "pg-1:app:public:group-tables:objects-v6";
    const indexCacheKey = `${treeCacheKey}:table-search-index-v1`;
    const cachedPayloads = new Map<string, unknown>([
      [
        treeCacheKey,
        {
          version: 3,
          cachedAt: new Date().toISOString(),
          children: [{ id: "old", label: "old_table", type: "table", connectionId: "pg-1", database: "app", schema: "public", isExpanded: false }],
        },
      ],
    ]);
    let releaseTableLists!: () => void;
    let tableListCalls = 0;
    const bothTableListsStarted = new Promise<void>((resolve) => {
      releaseTableLists = resolve;
    });
    const listTables = vi.fn(async (_connectionId: string, _database: string, _schema: string, _filter?: string, limit?: number) => {
      tableListCalls += 1;
      if (tableListCalls === 2) releaseTableLists();
      await bothTableListsStarted;
      return limit === 2 ? ([{ name: "indexed_table", table_type: "TABLE", comment: null }] satisfies TableInfo[]) : ([{ name: "fresh_table", table_type: "TABLE", comment: null }] satisfies TableInfo[]);
    });
    const loadSchemaCache = vi.fn(async (key: string) => {
      const payload = cachedPayloads.get(key) ?? null;
      await Promise.resolve();
      return payload == null ? null : structuredClone(payload);
    });
    const saveSchemaCache = vi.fn(async (key: string, payload: unknown) => {
      cachedPayloads.set(key, structuredClone(payload));
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listTables,
      loadSchemaCache,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache,
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { decodeSchemaTreeCache } = await import("@/lib/metadata/schemaTreeCache");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().desktopSettings.sidebar_table_page_size = 2;

    const connection = postgresConnection();
    const tablesGroup: TreeNode = {
      id: "pg-1:app:public:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: connection.id,
      database: "app",
      schema: "public",
      isExpanded: true,
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
            children: [
              {
                id: "pg-1:app:public",
                label: "public",
                type: "schema",
                connectionId: connection.id,
                database: "app",
                schema: "public",
                isExpanded: true,
                children: [tablesGroup],
              },
            ],
          },
        ],
      },
    ];

    await Promise.all([store.loadObjectGroupChildren(tablesGroup, { force: true }), store.refreshSidebarTableSearchIndex(tablesGroup.id)]);

    const treeCache = decodeSchemaTreeCache<TreeNode[]>(cachedPayloads.get(treeCacheKey));
    const indexCache = decodeSchemaTreeCache<TreeNode[]>(cachedPayloads.get(indexCacheKey));
    expect(treeCache?.children.map((node) => node.label)).toEqual(["fresh_table"]);
    expect(indexCache?.tableSearchIndex?.entries).toEqual([{ name: "indexed_table", tableType: "TABLE" }]);
    await expect(store.loadSidebarTableSearchIndex(tablesGroup.id)).resolves.toEqual([{ name: "indexed_table", table_type: "TABLE" }]);
    expect(loadSchemaCache).toHaveBeenLastCalledWith(indexCacheKey);
  });

  it("bypasses Oracle object-group caches created before DIP visibility was fixed", async () => {
    const listTables = vi.fn().mockResolvedValue([
      { name: "V_ONE", table_type: "VIEW", comment: null },
      { name: "V_TWO", table_type: "VIEW", comment: null },
      { name: "V_THREE", table_type: "VIEW", comment: null },
    ] satisfies TableInfo[]);
    const legacyChildren: TreeNode[] = [
      { id: "oracle-1:XE:DIP:__views:DIP:V_ONE", label: "V_ONE", type: "view", connectionId: "oracle-1", database: "XE", schema: "DIP", isExpanded: false },
      { id: "oracle-1:XE:DIP:__views:DIP:V_TWO", label: "V_TWO", type: "view", connectionId: "oracle-1", database: "XE", schema: "DIP", isExpanded: false },
    ];
    const loadSchemaCache = vi.fn(async (key: string) =>
      key.endsWith(":objects-v6")
        ? {
            version: 2,
            cachedAt: new Date().toISOString(),
            children: legacyChildren,
          }
        : null,
    );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listTables,
      loadSchemaCache,
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().desktopSettings.sidebar_table_page_size = 200;
    const connection = oracleConnection();
    const viewGroup: TreeNode = {
      id: "oracle-1:XE:DIP:__views",
      label: "tree.views",
      type: "group-views",
      connectionId: connection.id,
      database: "XE",
      schema: "DIP",
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
            id: "oracle-1:XE:DIP",
            label: "DIP",
            type: "schema",
            connectionId: connection.id,
            database: "XE",
            schema: "DIP",
            isExpanded: true,
            children: [viewGroup],
          },
        ],
      },
    ];

    const storedViewGroup = store.treeNodes[0].children?.[0].children?.[0];
    expect(storedViewGroup?.type).toBe("group-views");
    await store.loadObjectGroupChildren(storedViewGroup!);

    expect(loadSchemaCache).toHaveBeenCalledWith("oracle-1:XE:DIP:group-views:objects-v7");
    expect(listTables).toHaveBeenCalledWith(connection.id, "XE", "DIP", undefined, 201, 0, ["VIEW"]);
    expect(storedViewGroup?.children?.map((node) => node.label)).toEqual(["V_ONE", "V_THREE", "V_TWO"]);
  });

  it("ignores stale table filter refreshes that finish out of order", async () => {
    let resolveFirst!: (tables: TableInfo[]) => void;
    let resolveSecond!: (tables: TableInfo[]) => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const secondStartedPromise = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const listTables = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<TableInfo[]>((resolve) => {
            resolveFirst = resolve;
            firstStarted();
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<TableInfo[]>((resolve) => {
            resolveSecond = resolve;
            secondStarted();
          }),
      );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection();
    const tableGroup: TreeNode = {
      id: "pg-1:app:public:__tables",
      label: "tree.tables",
      type: "group-tables",
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
            id: "pg-1:app:public",
            label: "public",
            type: "schema",
            connectionId: connection.id,
            database: "app",
            schema: "public",
            isExpanded: true,
            children: [tableGroup],
          },
        ],
      },
    ];
    const scopeKey = store.tableNameFilterScopeKey({
      connectionId: connection.id,
      database: "app",
      schema: "public",
      nodeKind: "group-tables",
    });
    const currentTableGroup = () => store.treeNodes[0].children?.[0].children?.[0] as TreeNode;

    const firstRevision = store.setSidebarTableNameFilter(scopeKey, { includePatterns: ["old_%"], excludePatterns: [] });
    const firstRefresh = store.refreshTreeNodeForTableNameFilter(currentTableGroup(), scopeKey, firstRevision);
    await firstStartedPromise;
    const secondRevision = store.setSidebarTableNameFilter(scopeKey, { includePatterns: ["new_%"], excludePatterns: [] });
    const secondRefresh = store.refreshTreeNodeForTableNameFilter(currentTableGroup(), scopeKey, secondRevision);
    await secondStartedPromise;

    resolveSecond([{ name: "new_users", table_type: "BASE TABLE", comment: null }]);
    await secondRefresh;
    expect(currentTableGroup().children?.map((node) => node.label)).toEqual(["new_users"]);

    resolveFirst([{ name: "old_users", table_type: "BASE TABLE", comment: null }]);
    await firstRefresh;
    expect(currentTableGroup().children?.map((node) => node.label)).toEqual(["new_users"]);
  });

  it("applies include filters to Doris internal table groups", async () => {
    const listTables = vi.fn().mockResolvedValue([{ name: "ads_pgc_report", table_type: "BASE TABLE", comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = dorisConnection();
    const tableGroup: TreeNode = {
      id: "doris-1:warehouse:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: connection.id,
      database: "warehouse",
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
            id: "doris-1:warehouse",
            label: "warehouse",
            type: "database",
            connectionId: connection.id,
            database: "warehouse",
            isExpanded: true,
            children: [tableGroup],
          },
        ],
      },
    ];

    const scopeKey = store.tableNameFilterScopeKey({
      connectionId: connection.id,
      database: "warehouse",
      nodeKind: "group-tables",
    });
    const revision = store.setSidebarTableNameFilter(scopeKey, { includePatterns: ["ads_pgc_%"], excludePatterns: [] });
    await store.refreshTreeNodeForTableNameFilter(tableGroup, scopeKey, revision);

    expect(listTables).toHaveBeenCalledWith(connection.id, "warehouse", "warehouse", undefined, 1001, 0, ["TABLE"], undefined, { includePatterns: ["ads_pgc_%"], excludePatterns: [] });
    expect(tableGroup.children?.map((node) => node.label)).toEqual(["ads_pgc_report"]);
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
    expect(store.treeNodes[0]?.children?.[0]?.children?.map((node) => node.label)).toEqual(["public", "tree.extensions"]);
  });

  it("preserves the last successful tree snapshot when a forced metadata refresh fails", async () => {
    const listSchemaInfos = vi.fn().mockRejectedValue(new Error("Agent RPC call timed out (5s)"));
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix,
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
    const previousSchema: TreeNode = {
      id: `${connection.id}:app:public`,
      label: "public",
      type: "schema",
      connectionId: connection.id,
      database: "app",
      schema: "public",
      isExpanded: false,
      children: [],
    };
    const databaseNode: TreeNode = {
      id: `${connection.id}:app`,
      label: "app",
      type: "database",
      connectionId: connection.id,
      database: "app",
      isExpanded: true,
      children: [previousSchema],
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
        children: [databaseNode],
      },
    ];

    await expect(store.refreshTreeNode(databaseNode)).rejects.toThrow("Agent RPC call timed out (5s)");

    expect(databaseNode.children).toEqual([previousSchema]);
    expect(databaseNode.isExpanded).toBe(true);
    expect(store.connectionErrors[connection.id]).toBe("Agent RPC call timed out (5s)");
    expect(deleteSchemaCachePrefix).toHaveBeenCalledWith("pg-1:app:");
  });

  it("does not let an older refresh resume after a newer refresh succeeds", async () => {
    let resolveOlderMetadata!: (value: Array<{ name: string; comment: null }>) => void;
    const olderMetadata = new Promise<Array<{ name: string; comment: null }>>((resolve) => {
      resolveOlderMetadata = resolve;
    });
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    const listSchemaInfos = vi
      .fn()
      .mockImplementationOnce(() => olderMetadata)
      .mockResolvedValue([{ name: "latest", comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix,
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
    const databaseNode: TreeNode = {
      id: `${connection.id}:app`,
      label: "app",
      type: "database",
      connectionId: connection.id,
      database: "app",
      isExpanded: true,
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
        children: [databaseNode],
      },
    ];

    const olderRefresh = store.refreshTreeNode(databaseNode);
    await vi.waitFor(() => expect(listSchemaInfos).toHaveBeenCalledTimes(1));
    await store.refreshTreeNode(databaseNode);
    resolveOlderMetadata([{ name: "stale", comment: null }]);
    await olderRefresh;

    expect(listSchemaInfos).toHaveBeenCalledTimes(2);
    expect(databaseNode.children?.map((node) => node.label)).toEqual(["latest", "tree.extensions"]);
  });

  it("does not let an older refresh failure overwrite a newer successful refresh", async () => {
    let rejectOlderMetadata!: (reason: Error) => void;
    const olderMetadata = new Promise<Array<{ name: string; comment: null }>>((_, reject) => {
      rejectOlderMetadata = reject;
    });
    const listSchemaInfos = vi
      .fn()
      .mockImplementationOnce(() => olderMetadata)
      .mockResolvedValue([{ name: "latest", comment: null }]);

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
    const databaseNode: TreeNode = {
      id: `${connection.id}:app`,
      label: "app",
      type: "database",
      connectionId: connection.id,
      database: "app",
      isExpanded: true,
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
        children: [databaseNode],
      },
    ];

    const olderRefresh = store.refreshTreeNode(databaseNode);
    await vi.waitFor(() => expect(listSchemaInfos).toHaveBeenCalledTimes(1));
    await store.refreshTreeNode(databaseNode);
    rejectOlderMetadata(new Error("connection closed"));
    await expect(olderRefresh).rejects.toThrow("connection closed");

    expect(databaseNode.children?.map((node) => node.label)).toEqual(["latest", "tree.extensions"]);
    expect(store.connectionErrors[connection.id]).toBeUndefined();
    expect(store.connectedIds.has(connection.id)).toBe(true);
  });

  it("does not restore a pre-disconnect snapshot into a same-id reconnected node", async () => {
    let rejectMetadata!: (reason: Error) => void;
    const pendingMetadata = new Promise<Array<{ name: string; comment: null }>>((_, reject) => {
      rejectMetadata = reject;
    });
    const listSchemaInfos = vi.fn().mockReturnValue(pendingMetadata);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      disconnectDb: vi.fn().mockResolvedValue(undefined),
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
    const databaseId = `${connection.id}:app`;
    const staleSchema: TreeNode = {
      id: `${databaseId}:stale`,
      label: "stale",
      type: "schema",
      connectionId: connection.id,
      database: "app",
      schema: "stale",
      children: [],
    };
    const databaseNode: TreeNode = {
      id: databaseId,
      label: "app",
      type: "database",
      connectionId: connection.id,
      database: "app",
      isExpanded: true,
      children: [staleSchema],
    };
    const connectionNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [databaseNode],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [connectionNode];

    const staleRefresh = store.refreshTreeNode(databaseNode);
    await vi.waitFor(() => expect(listSchemaInfos).toHaveBeenCalledTimes(1));
    await store.disconnect(connection.id);

    const freshSchema: TreeNode = {
      id: `${databaseId}:fresh`,
      label: "fresh",
      type: "schema",
      connectionId: connection.id,
      database: "app",
      schema: "fresh",
      children: [],
    };
    const reconnectedDatabaseNode: TreeNode = {
      ...databaseNode,
      children: [freshSchema],
    };
    connectionNode.children = [reconnectedDatabaseNode];
    store.connectedIds.add(connection.id);

    rejectMetadata(new Error("disconnected refresh"));
    await expect(staleRefresh).rejects.toThrow("disconnected refresh");

    expect(reconnectedDatabaseNode.children?.map((child) => child.label)).toEqual(["fresh"]);
  });

  it.each(["opengauss", "kingbase"] as const)("reloads %s sidebar schemas when system visibility changes", async (dbType) => {
    const listSchemaInfos = vi.fn().mockResolvedValue([
      { name: "information_schema", comment: null },
      { name: "pg_catalog", comment: null },
      { name: "public", comment: null },
    ]);
    const loadSchemaCache = vi.fn().mockResolvedValue(null);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listSchemaInfos,
      loadSchemaCache,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = { ...postgresConnection(), id: `${dbType}-1`, db_type: dbType, show_system_schemas: false } as ConnectionConfig;
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
    const databaseNode = store.treeNodes[0]!.children![0]!;

    await store.loadSchemas(connection.id, "app");
    expect(databaseNode.children?.map((node) => node.label).filter((label) => label !== "tree.extensions")).toEqual(["public"]);

    store.connections[0]!.show_system_schemas = true;
    databaseNode.children = [];
    databaseNode.isExpanded = false;
    await store.loadSchemas(connection.id, "app");

    expect(loadSchemaCache.mock.calls.map(([key]) => key)).toEqual([`${connection.id}:app:schemas-v3:hide-system`, `${connection.id}:app:schemas-v3:show-system`]);
    expect(databaseNode.children?.map((node) => node.label).filter((label) => label !== "tree.extensions")).toEqual(["information_schema", "pg_catalog", "public"]);
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

  it("reloads a collapsed database after a forced connection database refresh", async () => {
    const listDatabases = vi
      .fn()
      .mockResolvedValueOnce([
        { name: "test1", comment: null },
        { name: "test2", comment: null },
      ])
      .mockResolvedValueOnce([{ name: "test1", comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listDatabases,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
    const connectionNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [
        {
          id: test1Id,
          label: "test1",
          type: "database",
          connectionId: connection.id,
          database: "test1",
          isExpanded: false,
          children: [],
        },
      ],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [connectionNode];

    await store.loadTables(connection.id, "test1");
    expect(store.isTreeNodeChildrenLoaded(test1Id)).toBe(true);
    expect(connectionNode.children![0].children?.length).toBeGreaterThan(0);

    connectionNode.children![0].isExpanded = false;
    connectionNode.children![0].children = [];

    await store.loadDatabases(connection.id, { force: true });
    expect(listDatabases).toHaveBeenCalledTimes(1);
    expect(connectionNode.children![0].children?.length ?? 0).toBe(0);

    await store.loadTables(connection.id, "test1");
    expect(connectionNode.children![0].children?.length).toBeGreaterThan(0);
    expect(store.isTreeNodeChildrenLoaded(test1Id)).toBe(true);
  });

  it("reloads a collapsed database in simple mode after a forced connection database refresh", async () => {
    const tables: TableInfo[] = [{ name: "users", table_type: "TABLE", comment: null }];
    const listDatabases = vi
      .fn()
      .mockResolvedValueOnce([{ name: "test1", comment: null }])
      .mockResolvedValueOnce([{ name: "test1", comment: null }]);
    const listTables = vi.fn().mockResolvedValue(tables);
    const listObjects = vi.fn().mockResolvedValue([]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listDatabases,
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listTables,
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
    settingsStore.editorSettings.sidebarObjectDisplay = "simple";

    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
    const connectionNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [
        {
          id: test1Id,
          label: "test1",
          type: "database",
          connectionId: connection.id,
          database: "test1",
          isExpanded: false,
          children: [],
        },
      ],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [connectionNode];

    await store.loadTables(connection.id, "test1");
    expect(listTables).toHaveBeenCalledTimes(1);
    expect(store.isTreeNodeChildrenLoaded(test1Id)).toBe(true);

    connectionNode.children![0].isExpanded = false;
    connectionNode.children![0].children = [];

    await store.loadDatabases(connection.id, { force: true });
    listTables.mockClear();

    await store.loadTables(connection.id, "test1");
    expect(connectionNode.children![0].children?.length ?? 0).toBeGreaterThan(0);
  });

  it("refetches a simple empty database after DDL-driven same-id shell refresh", async () => {
    const listDatabases = vi.fn().mockResolvedValue([{ name: "test1", comment: null }]);
    const listTables = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: "users", table_type: "TABLE", comment: null }]);
    const listObjects = vi.fn().mockResolvedValue([]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listDatabases,
      listTables,
      listObjects,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";

    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
    const connectionNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [
        {
          id: test1Id,
          label: "test1",
          type: "database",
          connectionId: connection.id,
          database: "test1",
          isExpanded: false,
          children: [],
        },
      ],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [connectionNode];

    await store.loadTables(connection.id, "test1");
    expect(listTables).toHaveBeenCalledTimes(1);
    expect(store.canUseLoadedTreeNodeToggle(store.treeNodes[0].children![0])).toBe(true);

    connectionNode.children![0].isExpanded = false;
    connectionNode.children![0].children = [];

    // DDL created the first table; connection-level refresh rebuilds the same-id empty shell.
    await store.loadDatabases(connection.id, { force: true });
    listTables.mockClear();

    await store.loadTables(connection.id, "test1");
    expect(listTables).toHaveBeenCalledTimes(1);
    expect(connectionNode.children![0].children?.some((child) => child.label === "users")).toBe(true);
  });

  it("does not refetch a legitimately empty simple-mode database on re-expand", async () => {
    const listTables = vi.fn().mockResolvedValue([]);
    const listObjects = vi.fn().mockResolvedValue([]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listTables,
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
    settingsStore.editorSettings.sidebarObjectDisplay = "simple";

    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
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
            id: test1Id,
            label: "test1",
            type: "database",
            connectionId: connection.id,
            database: "test1",
            isExpanded: true,
            children: [],
          },
        ],
      },
    ];

    await store.loadTables(connection.id, "test1");
    expect(listTables).toHaveBeenCalledTimes(1);
    expect(store.canUseLoadedTreeNodeToggle(store.treeNodes[0].children![0])).toBe(true);

    listTables.mockClear();
    await store.loadTables(connection.id, "test1");
    expect(listTables).not.toHaveBeenCalled();
  });

  it("clears grouped object-group markers when the database shell goes stale", async () => {
    const tables: TableInfo[] = [{ name: "users", table_type: "TABLE", comment: null }];
    const listTables = vi.fn().mockResolvedValue(tables);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
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
    settingsStore.editorSettings.sidebarObjectDisplay = "grouped";

    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
    const dbNode: TreeNode = {
      id: test1Id,
      label: "test1",
      type: "database",
      connectionId: connection.id,
      database: "test1",
      isExpanded: true,
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
        children: [dbNode],
      },
    ];

    await store.loadTables(connection.id, "test1");
    const tablesGroup = dbNode.children?.find((child) => child.type === "group-tables");
    expect(tablesGroup).toBeDefined();
    await store.loadObjectGroupChildren(tablesGroup!);
    const tablesGroupInTree = dbNode.children?.find((child) => child.type === "group-tables");
    expect(tablesGroupInTree?.children?.length ?? 0).toBeGreaterThan(0);
    const groupId = tablesGroupInTree!.id;
    expect(store.isTreeNodeChildrenLoaded(groupId)).toBe(true);
    expect(store.canUseLoadedTreeNodeToggle(tablesGroupInTree!)).toBe(true);

    dbNode.children = [];
    listTables.mockClear();
    await store.loadTables(connection.id, "test1");

    expect(store.isTreeNodeChildrenLoaded(groupId)).toBe(false);
    expect(store.canUseLoadedTreeNodeToggle({ ...tablesGroup!, id: groupId, children: [] } as TreeNode)).toBe(false);

    const refreshedTablesGroup = dbNode.children?.find((child) => child.type === "group-tables");
    expect(refreshedTablesGroup).toBeDefined();
    await store.loadObjectGroupChildren(refreshedTablesGroup!);
    expect(listTables).toHaveBeenCalledTimes(1);
    expect(refreshedTablesGroup?.children?.length).toBeGreaterThan(0);
  });

  it("applies async table loads to the current tree node after an in-tree replacement", async () => {
    const tables: TableInfo[] = [{ name: "users", table_type: "TABLE", comment: null }];
    let resolveTables!: (tables: TableInfo[]) => void;
    const listTablesPromise = new Promise<TableInfo[]>((resolve) => {
      resolveTables = resolve;
    });
    const listTables = vi.fn(() => listTablesPromise);
    const listObjects = vi.fn().mockResolvedValue([]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listTables,
      listObjects,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";

    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
    const staleDbNode: TreeNode = {
      id: test1Id,
      label: "test1",
      type: "database",
      connectionId: connection.id,
      database: "test1",
      isExpanded: true,
      children: [],
    };
    const connectionNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [staleDbNode],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [connectionNode];

    const loadPromise = store.loadTables(connection.id, "test1");
    await vi.waitFor(() => expect(listTables).toHaveBeenCalled());
    const replacementDb: TreeNode = {
      id: test1Id,
      label: "test1",
      type: "database",
      connectionId: connection.id,
      database: "test1",
      isExpanded: true,
      children: [],
    };
    connectionNode.children = [replacementDb];
    resolveTables(tables);
    await loadPromise;

    expect(staleDbNode.children?.length ?? 0).toBe(0);
    expect(replacementDb.children?.length ?? 0).toBeGreaterThan(0);
    expect(store.isTreeNodeChildrenLoaded(test1Id)).toBe(true);
  });

  it("applies persisted cache to the current tree node after an in-tree replacement", async () => {
    const cachedTable: TreeNode = {
      id: "mysql-1:test1:users",
      label: "users",
      type: "table",
      connectionId: "mysql-1",
      database: "test1",
      isExpanded: false,
      children: [],
    };
    let resolveCache!: (payload: unknown) => void;
    const loadSchemaCachePromise = new Promise<unknown>((resolve) => {
      resolveCache = resolve;
    });
    const loadSchemaCache = vi.fn(() => loadSchemaCachePromise);
    const listTables = vi.fn();

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listTables,
      loadSchemaCache,
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";

    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
    const staleDbNode: TreeNode = {
      id: test1Id,
      label: "test1",
      type: "database",
      connectionId: connection.id,
      database: "test1",
      isExpanded: true,
      children: [],
    };
    const connectionNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [staleDbNode],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [connectionNode];

    const loadPromise = store.loadTables(connection.id, "test1");
    await vi.waitFor(() => expect(loadSchemaCache).toHaveBeenCalled());
    const replacementDb: TreeNode = {
      id: test1Id,
      label: "test1",
      type: "database",
      connectionId: connection.id,
      database: "test1",
      isExpanded: true,
      children: [],
    };
    connectionNode.children = [replacementDb];
    resolveCache({
      version: 2,
      cachedAt: new Date().toISOString(),
      children: [cachedTable],
    });
    await loadPromise;

    expect(listTables).not.toHaveBeenCalled();
    expect(staleDbNode.children?.length ?? 0).toBe(0);
    expect(replacementDb.children?.length ?? 0).toBeGreaterThan(0);
    expect(store.isTreeNodeChildrenLoaded(test1Id)).toBe(true);
  });

  it("keeps database loaded markers when connection children are reordered only", async () => {
    const listDatabases = vi.fn().mockResolvedValue([{ name: "test1", comment: null }]);
    const listTables = vi.fn().mockResolvedValue([{ name: "users", table_type: "TABLE", comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listDatabases,
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
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
            id: test1Id,
            label: "test1",
            type: "database",
            connectionId: connection.id,
            database: "test1",
            isExpanded: true,
            children: [],
          },
        ],
      },
    ];

    await store.loadDatabases(connection.id, { force: true });
    await store.loadTables(connection.id, "test1");
    expect(store.isTreeNodeChildrenLoaded(test1Id)).toBe(true);
    listTables.mockClear();

    await store.loadDatabases(connection.id);
    expect(listDatabases).toHaveBeenCalledTimes(1);
    expect(listTables).not.toHaveBeenCalled();
    expect(store.isTreeNodeChildrenLoaded(test1Id)).toBe(true);
  });

  it("keeps database loaded markers when connection refresh passes utility-only children", async () => {
    const listDatabases = vi
      .fn()
      .mockResolvedValueOnce([{ name: "test1", comment: null }])
      .mockResolvedValueOnce([]);
    const listTables = vi.fn().mockResolvedValue([{ name: "users", table_type: "TABLE", comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listDatabases,
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isExpanded: true,
        children: [],
      },
    ];

    await store.loadDatabases(connection.id, { force: true });
    await store.loadTables(connection.id, "test1");
    expect(store.isTreeNodeChildrenLoaded(test1Id)).toBe(true);
    listTables.mockClear();

    await store.loadDatabases(connection.id, { force: true });

    expect(listDatabases).toHaveBeenCalledTimes(2);
    expect(listTables).not.toHaveBeenCalled();
    expect(store.treeNodes[0].children?.some((child) => child.id === test1Id && child.type === "database")).toBe(true);
    expect(store.isTreeNodeChildrenLoaded(test1Id)).toBe(true);
  });

  it("clears connection loading after disconnect even when metadata apply is skipped", async () => {
    let resolveDatabases!: (value: { name: string; comment: null }[]) => void;
    const listDatabases = vi.fn(
      () =>
        new Promise<{ name: string; comment: null }[]>((resolve) => {
          resolveDatabases = resolve;
        }),
    );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listDatabases,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = mysqlConnection();
    const connectionNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [connectionNode];

    const loadPromise = store.loadDatabases(connection.id, { force: true });
    await vi.waitFor(() => expect(listDatabases).toHaveBeenCalled());
    expect(connectionNode.isLoading).toBe(true);
    store.connectedIds.delete(connection.id);
    resolveDatabases([{ name: "app", comment: null }]);
    await loadPromise;

    const liveConnection = store.treeNodes.find((node) => node.id === connection.id);
    expect(liveConnection?.isLoading).toBe(false);
    expect(connectionNode.isLoading).toBe(false);
  });

  it("ignores stale metadata results after disconnect and same-id reconnect", async () => {
    let resolveOldTables!: (tables: TableInfo[]) => void;
    let resolveNewTables!: (tables: TableInfo[]) => void;
    let listTablesCalls = 0;
    const listTables = vi.fn(() => {
      listTablesCalls += 1;
      if (listTablesCalls === 1) {
        return new Promise<TableInfo[]>((resolve) => {
          resolveOldTables = resolve;
        });
      }
      return new Promise<TableInfo[]>((resolve) => {
        resolveNewTables = resolve;
      });
    });
    const listObjects = vi.fn().mockResolvedValue([]);
    const connectDb = vi.fn().mockResolvedValue("mysql-1");
    const disconnectDb = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      connectDb,
      disconnectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listTables,
      listObjects,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";

    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
    const connectionNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [
        {
          id: test1Id,
          label: "test1",
          type: "database",
          connectionId: connection.id,
          database: "test1",
          isExpanded: true,
          children: [],
        },
      ],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [connectionNode];

    const staleLoad = store.loadTables(connection.id, "test1");
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledTimes(1));

    await store.disconnect(connection.id);
    expect(store.connectedIds.has(connection.id)).toBe(false);

    const reconnectedDb: TreeNode = {
      id: test1Id,
      label: "test1",
      type: "database",
      connectionId: connection.id,
      database: "test1",
      isExpanded: true,
      children: [],
      isLoading: false,
    };
    connectionNode.children = [reconnectedDb];
    await store.connect(connection);
    expect(store.connectedIds.has(connection.id)).toBe(true);

    const freshLoad = store.loadTables(connection.id, "test1", undefined, { force: true });
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledTimes(2));
    expect(reconnectedDb.isLoading).toBe(true);

    resolveOldTables([{ name: "stale_users", table_type: "TABLE", comment: null }]);
    await staleLoad;

    expect(reconnectedDb.children?.some((child) => child.label === "stale_users")).toBe(false);
    expect(reconnectedDb.isLoading).toBe(true);
    expect(store.isTreeNodeChildrenLoaded(test1Id)).toBe(false);

    resolveNewTables([{ name: "fresh_users", table_type: "TABLE", comment: null }]);
    await freshLoad;
    expect(reconnectedDb.children?.some((child) => child.label === "fresh_users")).toBe(true);
    expect(reconnectedDb.isLoading).toBe(false);
  });

  it("keeps database loading spinner when ensureConnected reconnects during the same load", async () => {
    let resolveTables!: (tables: TableInfo[]) => void;
    const listTables = vi.fn(
      () =>
        new Promise<TableInfo[]>((resolve) => {
          resolveTables = resolve;
        }),
    );
    const listObjects = vi.fn().mockResolvedValue([]);
    const checkConnectionHealth = vi.fn().mockRejectedValueOnce(new Error("pool dead")).mockResolvedValue(undefined);
    const connectDb = vi.fn().mockResolvedValue("mysql-1");

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listTables,
      listObjects,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";

    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
    const dbNode: TreeNode = {
      id: test1Id,
      label: "test1",
      type: "database",
      connectionId: connection.id,
      database: "test1",
      isExpanded: true,
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
        children: [dbNode],
      },
    ];

    const loadPromise = store.loadTables(connection.id, "test1");
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledTimes(1));
    expect(checkConnectionHealth).toHaveBeenCalled();
    expect(connectDb).toHaveBeenCalled();
    expect(dbNode.isLoading).toBe(true);

    resolveTables([{ name: "users", table_type: "TABLE", comment: null }]);
    await loadPromise;

    expect(dbNode.children?.some((child) => child.label === "users")).toBe(true);
    expect(dbNode.isLoading).toBe(false);
  });

  it("clears sticky subtree loading when health-check reconnect bumps revision", async () => {
    let resolveTables!: (tables: TableInfo[]) => void;
    const listTables = vi.fn(
      () =>
        new Promise<TableInfo[]>((resolve) => {
          resolveTables = resolve;
        }),
    );
    const listObjects = vi.fn().mockResolvedValue([]);
    const checkConnectionHealth = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("pool dead"));
    const connectDb = vi.fn().mockResolvedValue("mysql-1");

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listTables,
      listObjects,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";

    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
    const dbNode: TreeNode = {
      id: test1Id,
      label: "test1",
      type: "database",
      connectionId: connection.id,
      database: "test1",
      isExpanded: true,
      children: [],
    };
    const connectionNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [dbNode],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [connectionNode];

    const staleLoad = store.loadTables(connection.id, "test1");
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledTimes(1));
    expect(dbNode.isLoading).toBe(true);
    expect(checkConnectionHealth).toHaveBeenCalledTimes(1);

    // Expire the health-check TTL, then ensureConnected: failed health → reconnect
    // bumps the epoch while the same DB node object survives (unlike disconnect).
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await store.ensureConnected(connection.id);
    expect(checkConnectionHealth).toHaveBeenCalledTimes(2);
    expect(connectDb).toHaveBeenCalled();
    expect(store.connectedIds.has(connection.id)).toBe(true);
    expect(connectionNode.children?.[0]).toBe(dbNode);
    expect(dbNode.isLoading).toBe(false);

    resolveTables([{ name: "stale_users", table_type: "TABLE", comment: null }]);
    await staleLoad;

    expect(dbNode.children?.some((child) => child.label === "stale_users")).toBe(false);
    expect(dbNode.isLoading).toBe(false);
    expect(store.isTreeNodeChildrenLoaded(test1Id)).toBe(false);
  });

  it("does not re-expand a node collapsed while its load is still in flight", async () => {
    let resolveTables!: (tables: TableInfo[]) => void;
    const listTables = vi.fn(
      () =>
        new Promise<TableInfo[]>((resolve) => {
          resolveTables = resolve;
        }),
    );
    const listObjects = vi.fn().mockResolvedValue([]);
    const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);
    const connectDb = vi.fn().mockResolvedValue("mysql-1");

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      connectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listTables,
      listObjects,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";

    const connection = mysqlConnection();
    const test1Id = `${connection.id}:test1`;
    const dbNode: TreeNode = {
      id: test1Id,
      label: "test1",
      type: "database",
      connectionId: connection.id,
      database: "test1",
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
        children: [dbNode],
      },
    ];

    const loadPromise = store.loadTables(connection.id, "test1");
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledTimes(1));
    expect(dbNode.isLoading).toBe(true);
    expect(dbNode.isExpanded).toBe(false);

    // Simulate the user collapsing the node while the metadata load is still in flight.
    dbNode.isExpanded = false;
    store.cancelTreeNodeLoad(dbNode.id);

    resolveTables([{ name: "users", table_type: "TABLE", comment: null }]);
    await loadPromise;

    // The in-flight load must not re-expand the node, and the spinner must be cleared.
    expect(dbNode.isLoading).toBe(false);
    expect(dbNode.isExpanded).toBe(false);
  });

  it("does not re-expand an Informix schema collapsed while its metadata cache is being saved", async () => {
    let resolveCacheSave!: () => void;
    const saveSchemaCache = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCacheSave = resolve;
        }),
    );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "grouped";

    const connection = informixConnection();
    const databaseNode: TreeNode = {
      id: `${connection.id}:prulife`,
      label: "prulife",
      type: "database",
      connectionId: connection.id,
      database: "prulife",
      isExpanded: true,
      children: [],
    };
    const schemaNode: TreeNode = {
      id: `${connection.id}:prulife:xtdpcky`,
      label: "xtdpcky",
      type: "schema",
      connectionId: connection.id,
      database: "prulife",
      schema: "xtdpcky",
      isExpanded: true,
      children: [],
    };
    databaseNode.children = [schemaNode];
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        isExpanded: true,
        children: [databaseNode],
      },
    ];

    const loadPromise = store.loadTables(connection.id, "prulife", "xtdpcky", { force: true });
    await vi.waitFor(() => expect(saveSchemaCache).toHaveBeenCalledTimes(1));
    expect(saveSchemaCache.mock.calls[0]?.[0]).toBe(`${connection.id}:prulife:xtdpcky:objects-grouped-v7-informix-owner-v2`);
    expect(schemaNode.isLoading).toBe(true);

    schemaNode.isExpanded = false;
    store.cancelTreeNodeLoad(schemaNode.id);
    resolveCacheSave();
    await loadPromise;

    expect(schemaNode.isLoading).toBe(false);
    expect(schemaNode.isExpanded).toBe(false);
  });

  it("does not let an Informix schema load reclaim ownership after collapse during a health check", async () => {
    let resolveHealthCheck!: () => void;
    const checkConnectionHealth = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHealthCheck = resolve;
        }),
    );
    const saveSchemaCache = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "grouped";

    const connection = informixConnection();
    const schemaNode: TreeNode = {
      id: `${connection.id}:prulife:xtdpcky`,
      label: "xtdpcky",
      type: "schema",
      connectionId: connection.id,
      database: "prulife",
      schema: "xtdpcky",
      isExpanded: true,
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
            id: `${connection.id}:prulife`,
            label: "prulife",
            type: "database",
            connectionId: connection.id,
            database: "prulife",
            isExpanded: true,
            children: [schemaNode],
          },
        ],
      },
    ];

    const loadPromise = store.loadTables(connection.id, "prulife", "xtdpcky", { force: true });
    await vi.waitFor(() => expect(checkConnectionHealth).toHaveBeenCalledTimes(1));
    expect(schemaNode.isLoading).toBe(true);

    schemaNode.isExpanded = false;
    store.cancelTreeNodeLoad(schemaNode.id);
    resolveHealthCheck();
    await loadPromise;

    expect(saveSchemaCache).not.toHaveBeenCalled();
    expect(schemaNode.isLoading).toBe(false);
    expect(schemaNode.isExpanded).toBe(false);
  });

  it("does not apply load-more results after the parent generation is invalidated", async () => {
    const firstPage = Array.from({ length: 201 }, (_, index) => ({
      name: `t_${String(index + 1).padStart(4, "0")}`,
      table_type: "TABLE" as const,
      comment: null,
    }));
    const refreshedFirstPage = firstPage.map((table) => ({ ...table, name: `fresh_${table.name}` }));
    let resolveSecondPage!: (tables: TableInfo[]) => void;
    const secondPagePromise = new Promise<TableInfo[]>((resolve) => {
      resolveSecondPage = resolve;
    });
    const listTables = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockImplementationOnce(() => secondPagePromise)
      .mockResolvedValueOnce(refreshedFirstPage);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
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
    settingsStore.editorSettings.sidebarObjectDisplay = "grouped";
    settingsStore.desktopSettings.sidebar_table_page_size = 200;

    const connection = mysqlConnection();
    const tablesGroup: TreeNode = {
      id: "mysql-1:app:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: connection.id,
      database: "app",
      isExpanded: false,
      children: [],
    };
    const connectionNode: TreeNode = {
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
          children: [tablesGroup],
        },
      ],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [connectionNode];

    await store.loadObjectGroupChildren(tablesGroup);
    const loadMoreNode = tablesGroup.children?.at(-1);
    expect(loadMoreNode?.type).toBe("load-more");

    const loadMorePromise = store.loadMoreObjectGroupChildren(loadMoreNode!);
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledTimes(2));

    // Force-reload the parent group while load-more is in flight. Parent stays in-tree, but its
    // generation advances; the stale page must not merge into the refreshed children.
    await store.loadObjectGroupChildren(tablesGroup, { force: true });
    expect(tablesGroup.children?.some((child) => child.label?.startsWith("fresh_"))).toBe(true);

    resolveSecondPage([{ name: "t_0202", table_type: "TABLE", comment: null }]);
    await loadMorePromise;

    expect(tablesGroup.children?.some((child) => child.label === "t_0202")).toBe(false);
    expect(tablesGroup.children?.some((child) => child.label?.startsWith("fresh_"))).toBe(true);
  });

  it("merges load-more table pages onto the live group node after an in-tree replacement", async () => {
    const firstPage = Array.from({ length: 201 }, (_, index) => ({
      name: `t_${String(index + 1).padStart(4, "0")}`,
      table_type: "TABLE" as const,
      comment: null,
    }));
    let resolveSecondPage!: (tables: TableInfo[]) => void;
    const secondPagePromise = new Promise<TableInfo[]>((resolve) => {
      resolveSecondPage = resolve;
    });
    const listTables = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockImplementationOnce(() => secondPagePromise);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
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
    settingsStore.editorSettings.sidebarObjectDisplay = "grouped";
    settingsStore.desktopSettings.sidebar_table_page_size = 200;

    const connection = mysqlConnection();
    const staleTablesGroup: TreeNode = {
      id: "mysql-1:app:__tables",
      label: "tree.tables",
      type: "group-tables",
      connectionId: connection.id,
      database: "app",
      isExpanded: false,
      children: [],
    };
    const connectionNode: TreeNode = {
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
          children: [staleTablesGroup],
        },
      ],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [connectionNode];

    await store.loadObjectGroupChildren(staleTablesGroup);
    const loadMoreNode = staleTablesGroup.children?.at(-1);
    expect(loadMoreNode?.type).toBe("load-more");

    const loadMorePromise = store.loadMoreObjectGroupChildren(loadMoreNode!);
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledTimes(2));

    const concurrentTable: TreeNode = {
      id: "mysql-1:app:__concurrent_marker",
      label: "__concurrent_marker",
      type: "table",
      connectionId: connection.id,
      database: "app",
      isExpanded: false,
      children: [],
    };
    const liveTablesGroup: TreeNode = {
      ...staleTablesGroup,
      children: [...(staleTablesGroup.children?.filter((child) => child.type !== "load-more") ?? []), concurrentTable, loadMoreNode!],
    };
    connectionNode.children![0].children = [liveTablesGroup];

    resolveSecondPage([{ name: "t_0202", table_type: "TABLE", comment: null }]);
    await loadMorePromise;

    expect(staleTablesGroup.children?.some((child) => child.label === "t_0202")).toBe(false);
    expect(liveTablesGroup.children?.some((child) => child.id === concurrentTable.id)).toBe(true);
    expect(liveTablesGroup.children?.some((child) => child.label === "t_0202")).toBe(true);
  });

  it("keeps table column loaded markers when a tables group appends via load-more", async () => {
    const firstPage = Array.from({ length: 201 }, (_, index) => ({
      name: `t_${String(index + 1).padStart(4, "0")}`,
      table_type: "TABLE" as const,
      comment: null,
    }));
    const listTables = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([{ name: "t_0202", table_type: "TABLE", comment: null }]);
    const getColumns = vi.fn().mockResolvedValue([{ name: "id", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: null }]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listTables,
      getColumns,
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
    const tablesGroup: TreeNode = {
      id: "mysql-1:app:__tables",
      label: "tree.tables",
      type: "group-tables",
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
            children: [tablesGroup],
          },
        ],
      },
    ];

    await store.loadObjectGroupChildren(tablesGroup);
    const firstTable = tablesGroup.children?.find((child) => child.type === "table");
    expect(firstTable).toBeDefined();
    await store.loadTableGroups(connection.id, "app", firstTable!.label, undefined, firstTable!.id);
    const columnsGroupId = `${firstTable!.id}:__columns`;
    await store.loadColumns(connection.id, "app", firstTable!.label, undefined, columnsGroupId);
    expect(store.isTreeNodeChildrenLoaded(columnsGroupId)).toBe(true);

    const loadMoreNode = tablesGroup.children?.at(-1);
    expect(loadMoreNode?.type).toBe("load-more");
    getColumns.mockClear();
    await store.loadMoreObjectGroupChildren(loadMoreNode!);

    expect(store.isTreeNodeChildrenLoaded(columnsGroupId)).toBe(true);
    expect(getColumns).not.toHaveBeenCalled();
  });

  it("applies SQL Server database object loads to the current tree node after an in-tree replacement", async () => {
    let resolveSchemas!: (schemas: string[]) => void;
    const listSchemas = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          resolveSchemas = resolve;
        }),
    );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listSchemas,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "grouped";

    const connection = {
      id: "sqlserver-1",
      name: "SQL Server",
      db_type: "sqlserver",
      host: "127.0.0.1",
      port: 1433,
      username: "sa",
      password: "",
      database: "master",
    } as ConnectionConfig;
    const dbId = `${connection.id}:app`;
    const staleDbNode: TreeNode = {
      id: dbId,
      label: "app",
      type: "database",
      connectionId: connection.id,
      database: "app",
      isExpanded: true,
      children: [],
    };
    const connectionNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [staleDbNode],
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    store.treeNodes = [connectionNode];

    const loadPromise = store.loadSqlServerDatabaseObjects(connection.id, "app", { force: true });
    await vi.waitFor(() => expect(listSchemas).toHaveBeenCalled());
    const replacementDb: TreeNode = {
      id: dbId,
      label: "app",
      type: "database",
      connectionId: connection.id,
      database: "app",
      isExpanded: true,
      children: [],
    };
    connectionNode.children = [replacementDb];
    resolveSchemas(["dbo"]);
    await loadPromise;

    expect(staleDbNode.children?.length ?? 0).toBe(0);
    expect(replacementDb.children?.length ?? 0).toBeGreaterThan(0);
    expect(store.isTreeNodeChildrenLoaded(dbId)).toBe(true);
  });
});
