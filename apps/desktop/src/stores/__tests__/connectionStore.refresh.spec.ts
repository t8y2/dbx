import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isObjectCacheInvalidationError } from "@/lib/metadata/objectCacheInvalidationError";
import type { ConnectionConfig, TreeNode } from "@/types/database";

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

function schemaNode(children: TreeNode[]): TreeNode {
  return {
    id: "pg-1:app:public",
    label: "public",
    type: "schema",
    connectionId: "pg-1",
    database: "app",
    schema: "public",
    isExpanded: true,
    children,
  };
}

function objectGroup(type: "group-views" | "group-procedures", key: string, child: TreeNode): TreeNode {
  return {
    id: `pg-1:app:public:${key}`,
    label: type === "group-views" ? "tree.views" : "tree.procedures",
    type,
    connectionId: "pg-1",
    database: "app",
    schema: "public",
    isExpanded: true,
    objectCount: 7,
    children: [child],
  };
}

function column(name: string) {
  return {
    name,
    data_type: "VARCHAR",
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    extra: null,
    comment: null,
    numeric_precision: null,
    numeric_scale: null,
    character_maximum_length: 255,
  };
}

function installApiMocks(options?: { getColumns?: ReturnType<typeof vi.fn>; listTables?: ReturnType<typeof vi.fn>; listObjects?: ReturnType<typeof vi.fn> }) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    getColumns: options?.getColumns ?? vi.fn().mockResolvedValue([]),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    listObjects: options?.listObjects ?? vi.fn().mockResolvedValue([]),
    listTables: options?.listTables ?? vi.fn().mockResolvedValue([]),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));
}

async function createStore(root: TreeNode) {
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  const store = useConnectionStore();
  useSettingsStore().editorSettings.sidebarObjectDisplay = "grouped";
  const connection = postgresConnection();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, isExpanded: true, children: [root] }];
  return store;
}

describe("connectionStore tree refresh state", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("preserves an object group count while rebuilding grouped placeholders", async () => {
    installApiMocks();
    const oldView: TreeNode = { id: "pg-1:app:public:old_view", label: "old_view", type: "view", connectionId: "pg-1", database: "app", schema: "public" };
    const root = schemaNode([objectGroup("group-views", "__views", oldView)]);
    root.children![0]!.isExpanded = false;
    const store = await createStore(root);

    await store.loadTreeNodeChildren(root, { force: true });

    expect(root.children?.find((child) => child.type === "group-views")?.objectCount).toBe(7);
  });

  it("rolls back tree data and loaded markers when an expanded child refresh fails", async () => {
    const listTables = vi.fn().mockResolvedValue([{ name: "fresh_view", table_type: "VIEW", comment: null }]);
    const listObjects = vi.fn().mockRejectedValue(new Error("metadata denied"));
    installApiMocks({ listTables, listObjects });

    const oldView: TreeNode = { id: "pg-1:app:public:old_view", label: "old_view", type: "view", connectionId: "pg-1", database: "app", schema: "public" };
    const oldProcedure: TreeNode = { id: "pg-1:app:public:old_procedure", label: "old_procedure", type: "procedure", connectionId: "pg-1", database: "app", schema: "public" };
    const root = schemaNode([objectGroup("group-views", "__views", oldView), objectGroup("group-procedures", "__procedures", oldProcedure)]);
    const hiddenChildren: TreeNode[] = [{ id: "pg-1:app:public:hidden", label: "hidden", type: "view", connectionId: "pg-1", database: "app", schema: "public" }];
    root.hiddenChildren = hiddenChildren;
    root.objectCount = 42;
    const store = await createStore(root);

    await store.loadTreeNodeChildren(root, { force: true });
    const previousChildren = root.children;
    const viewsGroupId = root.children!.find((child) => child.type === "group-views")!.id;
    const proceduresGroupId = root.children!.find((child) => child.type === "group-procedures")!.id;
    expect(store.isTreeNodeChildrenLoaded(root.id)).toBe(true);
    expect(store.isTreeNodeChildrenLoaded(viewsGroupId)).toBe(false);

    await expect(store.refreshTreeNode(root)).rejects.toThrow("metadata denied");

    expect(listTables).toHaveBeenCalledOnce();
    expect(listObjects).toHaveBeenCalledOnce();
    expect(root.children).toBe(previousChildren);
    expect(root.hiddenChildren).toBe(hiddenChildren);
    expect(root.objectCount).toBe(42);
    expect(root.children?.find((child) => child.type === "group-views")?.children?.map((child) => child.label)).toEqual(["old_view"]);
    expect(root.children?.find((child) => child.type === "group-procedures")?.children?.map((child) => child.label)).toEqual(["old_procedure"]);
    expect(store.isTreeNodeChildrenLoaded(root.id)).toBe(true);
    expect(store.isTreeNodeChildrenLoaded(viewsGroupId)).toBe(false);
    expect(store.isTreeNodeChildrenLoaded(proceduresGroupId)).toBe(false);
  });

  it("reloads completion columns after refreshing their schema tree", async () => {
    const getColumns = vi
      .fn()
      .mockResolvedValueOnce([column("id")])
      .mockResolvedValueOnce([column("id"), column("new_column")]);
    const listTables = vi.fn().mockResolvedValue([{ name: "users", table_type: "BASE TABLE", comment: null }]);
    installApiMocks({ getColumns, listTables });
    const root = schemaNode([]);
    const store = await createStore(root);

    await expect(store.listCompletionColumns("pg-1", "app", "users", "public")).resolves.toEqual([expect.objectContaining({ name: "id" })]);

    await store.refreshTreeNode(root);

    await expect(store.listCompletionColumns("pg-1", "app", "users", "public")).resolves.toEqual([expect.objectContaining({ name: "id" }), expect.objectContaining({ name: "new_column" })]);
    expect(getColumns).toHaveBeenCalledTimes(2);
    expect(store.completionCacheRevision("pg-1", "app")).toBeGreaterThan(0);
  });
});

describe("connection node refresh awaits object cache invalidation", () => {
  function installConnectionApiMocks(options?: { deleteSchemaCachePrefix?: ReturnType<typeof vi.fn>; getColumns?: ReturnType<typeof vi.fn>; getTableDisplayDdl?: ReturnType<typeof vi.fn>; listDatabases?: ReturnType<typeof vi.fn>; listSchemaInfos?: ReturnType<typeof vi.fn> }) {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: options?.deleteSchemaCachePrefix ?? vi.fn().mockResolvedValue(undefined),
      getColumns: options?.getColumns ?? vi.fn().mockResolvedValue([]),
      getTableDisplayDdl: options?.getTableDisplayDdl ?? vi.fn().mockResolvedValue("CREATE TABLE users (id int)"),
      listDatabases: options?.listDatabases ?? vi.fn().mockResolvedValue([{ name: "app", comment: null }]),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listObjects: vi.fn().mockResolvedValue([]),
      listSchemaInfos: options?.listSchemaInfos ?? vi.fn().mockResolvedValue([{ name: "public", comment: null }]),
      listTables: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));
  }

  /** A database node under the connection node: refresh reloads it via listSchemaInfos. */
  function databaseNode(): TreeNode {
    return { id: "pg-1:app", label: "app", type: "database", connectionId: "pg-1", database: "app", isExpanded: true, children: [] };
  }

  async function createStoreWithConnection(connectionId = "pg-1") {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "grouped";
    const connection: ConnectionConfig = {
      ...postgresConnection(),
      id: connectionId,
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    const connectionNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [],
    };
    store.treeNodes = [connectionNode];
    return { store, connectionNode };
  }

  function objectCacheDeletePrefixes(mock: ReturnType<typeof vi.fn>): string[] {
    return mock.mock.calls.filter(([prefix]) => (prefix as string).startsWith("object-")).map(([prefix]) => prefix as string);
  }

  /** A prefix-deletion mock whose object-cache deletions share one deferred gate. */
  function gatedObjectCacheDeletes() {
    const deleteSchemaCachePrefix = vi.fn((prefix: string) => {
      if (!prefix.startsWith("object-")) return Promise.resolve();
      return gate.then(() => undefined);
    });
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    return { deleteSchemaCachePrefix, releaseObjectCacheDeletes: () => resolveGate() };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("blocks the tree reload until both object cache deletions settle", async () => {
    const { deleteSchemaCachePrefix, releaseObjectCacheDeletes } = gatedObjectCacheDeletes();
    const listDatabases = vi.fn().mockResolvedValue([{ name: "app", comment: null }]);
    installConnectionApiMocks({ deleteSchemaCachePrefix, listDatabases });
    const { store, connectionNode } = await createStoreWithConnection();

    let settled = false;
    const refresh = store.refreshConnectionTreeNode(connectionNode).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix).length).toBe(2));
    expect(settled).toBe(false);
    expect(listDatabases).not.toHaveBeenCalled();

    releaseObjectCacheDeletes();
    await refresh;
    expect(listDatabases).toHaveBeenCalledTimes(1);
    expect(listDatabases).toHaveBeenCalledWith("pg-1");
  });

  it("issues exactly one object-cache deletion per namespace on a connection refresh", async () => {
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    installConnectionApiMocks({ deleteSchemaCachePrefix });
    const { store, connectionNode } = await createStoreWithConnection();

    await store.refreshConnectionTreeNode(connectionNode);

    expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix).sort()).toEqual(["object-ddl:v1:pg-1:", "object-meta:v1:pg-1:"]);
  });

  it("lets concurrent connection refreshes share the pending deletions", async () => {
    const { deleteSchemaCachePrefix, releaseObjectCacheDeletes } = gatedObjectCacheDeletes();
    installConnectionApiMocks({ deleteSchemaCachePrefix });
    const { store, connectionNode } = await createStoreWithConnection();

    const first = store.refreshConnectionTreeNode(connectionNode);
    const second = store.refreshConnectionTreeNode(connectionNode);
    await vi.waitFor(() => expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix).length).toBe(2));

    releaseObjectCacheDeletes();
    await Promise.all([first, second]);
    expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix)).toHaveLength(2);
  });

  it("rejects with the object cache error and skips the tree reload when deletion fails", async () => {
    const deleteSchemaCachePrefix = vi.fn((prefix: string) => (prefix.startsWith("object-") ? Promise.reject(new Error("sqlite locked")) : Promise.resolve()));
    const listDatabases = vi.fn().mockResolvedValue([{ name: "app", comment: null }]);
    installConnectionApiMocks({ deleteSchemaCachePrefix, listDatabases });
    const { store, connectionNode } = await createStoreWithConnection();
    const previousChildren = connectionNode.children;

    const failure = await store.refreshConnectionTreeNode(connectionNode).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isObjectCacheInvalidationError(failure)).toBe(true);
    expect((failure as Error).message).toBe("sqlite locked");
    expect(listDatabases).not.toHaveBeenCalled();
    expect(connectionNode.children).toBe(previousChildren);
  });

  it("retries the deletion and completes the tree reload on a subsequent refresh", async () => {
    let objectDeletionFailures = 2;
    const deleteSchemaCachePrefix = vi.fn((prefix: string) => {
      if (!prefix.startsWith("object-")) return Promise.resolve();
      return objectDeletionFailures-- > 0 ? Promise.reject(new Error("locked")) : Promise.resolve();
    });
    const listDatabases = vi.fn().mockResolvedValue([{ name: "app", comment: null }]);
    installConnectionApiMocks({ deleteSchemaCachePrefix, listDatabases });
    const { store, connectionNode } = await createStoreWithConnection();

    await expect(store.refreshConnectionTreeNode(connectionNode)).rejects.toThrow("locked");
    expect(listDatabases).not.toHaveBeenCalled();

    await expect(store.refreshConnectionTreeNode(connectionNode)).resolves.toBeUndefined();
    expect(listDatabases).toHaveBeenCalledTimes(1);
  });

  it("encodes connection ids in the invalidated object cache prefixes", async () => {
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    installConnectionApiMocks({ deleteSchemaCachePrefix });
    const { store, connectionNode } = await createStoreWithConnection("pg:1");

    await store.refreshConnectionTreeNode(connectionNode);

    expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix).sort()).toEqual(["object-ddl:v1:pg%3A1:", "object-meta:v1:pg%3A1:"]);
  });

  it("keeps non-connection node refresh best-effort when the object deletion fails", async () => {
    const deleteSchemaCachePrefix = vi.fn((prefix: string) => (prefix.startsWith("object-") ? Promise.reject(new Error("locked")) : Promise.resolve()));
    const listSchemaInfos = vi.fn().mockResolvedValue([{ name: "public", comment: null }]);
    installConnectionApiMocks({ deleteSchemaCachePrefix, listSchemaInfos });
    const { store } = await createStoreWithConnection();
    const database = databaseNode();
    store.treeNodes[0]!.children = [database];

    await expect(store.refreshTreeNode(database)).resolves.toBeUndefined();
    // The tree still reloads even though the object-cache deletion failed.
    expect(listSchemaInfos).toHaveBeenCalledTimes(1);
    expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix).sort()).toEqual(["object-ddl:v1:pg-1:app:", "object-meta:v1:pg-1:app:"]);
  });

  it("does not fetch object DDL or column metadata during a connection refresh", async () => {
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    const getTableDisplayDdl = vi.fn();
    const getColumns = vi.fn();
    installConnectionApiMocks({ deleteSchemaCachePrefix, getTableDisplayDdl, getColumns });
    const { store, connectionNode } = await createStoreWithConnection();

    await store.refreshConnectionTreeNode(connectionNode);

    expect(getTableDisplayDdl).not.toHaveBeenCalled();
    expect(getColumns).not.toHaveBeenCalled();
  });

  it("routes non-connection nodes to the regular refresh path", async () => {
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    installConnectionApiMocks({ deleteSchemaCachePrefix });
    const { store } = await createStoreWithConnection();
    const database = databaseNode();
    store.treeNodes[0]!.children = [database];

    await expect(store.refreshConnectionTreeNode(database)).resolves.toBeUndefined();
    expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix).sort()).toEqual(["object-ddl:v1:pg-1:app:", "object-meta:v1:pg-1:app:"]);
  });
});
