import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isReactive } from "vue";
import type { ColumnInfo, ConnectionConfig, TableInfo, TreeNode } from "@/types/database";
import { encodeSchemaTreeCache, SCHEMA_TREE_CACHE_TTL_MS } from "@/lib/metadata/schemaTreeCache";
import { decorateDatabaseSavedSqlTreeNodes } from "@/lib/savedSql/savedSqlDatabaseTree";
import { appendTableTreeLoadMoreNode, buildTableTreeNodes, mergeTableTreePageChildren, withoutTableTreeLoadMoreNodes } from "@/lib/table/tableTree";

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

function columns(count: number): ColumnInfo[] {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        name: `col_${index}`,
        data_type: "text",
        is_nullable: true,
        column_default: null,
        is_primary_key: index === 0,
        comment: null,
      }) as unknown as ColumnInfo,
  );
}

function findById(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findById(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

const GROUP_ID = "pg-1:app:public:users:__columns";

async function setupTdengineCache() {
  const cache = new Map<string, any>();
  const rows: TableInfo[] = [{ name: "stable", table_type: "STABLE" }, ...Array.from({ length: 450 }, (_, index) => ({ name: `child_${String(index).padStart(3, "0")}`, table_type: "TABLE", parent_name: "stable" }))];
  const listTables = vi.fn((_id: string, _db: string, _schema: string, _search?: string, limit?: number, offset?: number) => Promise.resolve(rows.slice(offset ?? 0, (offset ?? 0) + (limit ?? rows.length))));
  const loadSchemaCache = vi.fn(async (key: string) => JSON.parse(JSON.stringify(cache.get(key) ?? null)));
  const saveSchemaCache = vi.fn(async (key: string, value: unknown) => {
    cache.set(key, JSON.parse(JSON.stringify(value)));
  });
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    deleteSchemaCachePrefix: vi.fn(async (prefix: string) => {
      for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
    }),
    listTables,
    loadSchemaCache,
    saveSchemaCache,
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  const store = useConnectionStore();
  const settings = useSettingsStore();
  settings.editorSettings.sidebarObjectDisplay = "grouped";
  settings.desktopSettings.sidebar_table_page_size = 420;
  const connection = { ...postgresConnection(), db_type: "tdengine", sidebar_auto_load_all_tables: true } as ConnectionConfig;
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  store.treeNodes = [{ id: connection.id, label: "TDengine", type: "connection", connectionId: connection.id, children: [{ id: `${connection.id}:app:__tables`, label: "Tables", type: "group-tables", connectionId: connection.id, database: "app", children: [] }] }];
  const group = store.treeNodes[0].children![0];
  const release = () => {
    group.isExpanded = false;
    expect(store.releaseCollapsedTreeNodeChildren(group.id)).toBe(true);
    expect(group.children).toEqual([]);
  };
  return { store, group, cache, rows, listTables, loadSchemaCache, saveSchemaCache, release };
}

async function setupStoreWithColumnGroup() {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

  async function loadStore(getColumns: ReturnType<typeof vi.fn>) {
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      getColumns,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
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
            id: "pg-1:app",
            label: "app",
            type: "database",
            connectionId: connection.id,
            database: "app",
            isExpanded: true,
            children: [
              {
                id: "pg-1:app:public:users",
                label: "users",
                type: "table",
                connectionId: connection.id,
                database: "app",
                schema: "public",
                tableName: "users",
                isExpanded: true,
                children: [
                  {
                    id: GROUP_ID,
                    label: "Columns",
                    type: "group-columns",
                    connectionId: connection.id,
                    database: "app",
                    schema: "public",
                    tableName: "users",
                    isExpanded: false,
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    return store;
  }

  return { loadStore };
}

describe("connectionStore schema tree memory", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("reuses a fresh complete TDengine auto-all snapshot after large-group release", async () => {
    const { store, group, listTables, release } = await setupTdengineCache();
    await store.loadObjectGroupChildren(group);
    expect(listTables.mock.calls.map((call) => call[5])).toEqual([0, 420]);
    const ids = group.children![0].children![0].children!.map((node) => node.id);
    for (let round = 0; round < 2; round++) {
      release();
      listTables.mockClear();
      await store.loadObjectGroupChildren(group);
      expect(listTables).not.toHaveBeenCalled();
      expect(group.children![0].children![0].children!.map((node) => node.id)).toEqual(ids);
      expect(group.children![0].children![0].objectCount).toBe(450);
      expect(group.isExpanded).toBe(true);
    }
  });

  it("continues a fresh partial TDengine snapshot from its nested cursor", async () => {
    const { store, group, listTables, release } = await setupTdengineCache();
    store.connections[0].sidebar_auto_load_all_tables = false;
    await store.loadObjectGroupChildren(group, { force: true });
    expect(group.children![0].children![0].children!.at(-1)?.loadMore?.offset).toBe(420);
    release();
    store.connections[0].sidebar_auto_load_all_tables = true;
    listTables.mockClear();
    await store.loadObjectGroupChildren(group);
    expect(listTables.mock.calls.map((call) => call[5])).toEqual([420]);
    expect(group.children![0].children![0].objectCount).toBe(450);
    expect(group.children![0].children![0].children!.some((node) => node.type === "load-more")).toBe(false);
  });

  it.each(["stale", "force", "legacy", "missing", "v2", "invalid-node", "invalid-cursor", "invalid-count"])("reloads TDengine %s cache through one controlled full load", async (mode) => {
    const { store, group, cache, listTables, release } = await setupTdengineCache();
    await store.loadObjectGroupChildren(group);
    release();
    for (const [key, value] of cache) {
      if (mode === "stale") value.cachedAt = new Date(Date.now() - SCHEMA_TREE_CACHE_TTL_MS - 1).toISOString();
      if (mode === "legacy") cache.set(key, value.children);
      if (mode === "missing") cache.delete(key);
      if (mode === "v2") value.version = 2;
      if (mode === "invalid-node") value.children = [null];
      if (mode === "invalid-cursor") value.children.push({ id: "bad-cursor", type: "load-more", label: "more", connectionId: group.connectionId, database: group.database });
      if (mode === "invalid-count") value.children[0].children[0].objectCount++;
    }
    listTables.mockClear();
    await store.loadObjectGroupChildren(group, mode === "force" ? { force: true } : undefined);
    expect(listTables.mock.calls.map((call) => call[5])).toEqual([0, 420]);
    expect(group.children![0].children![0].objectCount).toBe(450);
  });

  it.each(["cancel", "search", "scoped-search", "disconnect", "refresh", "invalidate", "config"])("rejects delayed TDengine cache hydration after %s", async (action) => {
    const { store, group, loadSchemaCache, listTables, cache, release } = await setupTdengineCache();
    await store.loadObjectGroupChildren(group);
    release();
    const payload = JSON.parse(JSON.stringify([...cache.values()][0]));
    let resolveCache!: (value: any) => void;
    loadSchemaCache.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCache = resolve;
        }),
    );
    listTables.mockClear();
    const pending = store.loadObjectGroupChildren(group);
    await vi.waitFor(() => expect(resolveCache).toBeDefined());
    if (action === "cancel") store.cancelTreeNodeLoad(group.id);
    if (action === "search") store.sidebarSearchQuery = "needle";
    if (action === "scoped-search") store.setSidebarTableSearchQuery(group.id, "needle");
    if (action === "disconnect") store.connectedIds.delete(group.connectionId!);
    if (action === "refresh") await store.loadObjectGroupChildren(group, { force: true });
    if (action === "invalidate") store.invalidateMetadataCache(group.connectionId!, "app");
    if (action === "config") store.connections[0].host = "another-host";
    group.isExpanded = false;
    const currentChildren = group.children;
    resolveCache(payload);
    await pending;
    expect(group.children).toBe(currentChildren);
    expect(group.isExpanded).toBe(false);
    expect(listTables).toHaveBeenCalledTimes(action === "refresh" ? 2 : 0);
  });

  it("refreshes an expanded TDengine parent's child identities, not just its count", async () => {
    const { store, group, rows } = await setupTdengineCache();
    await store.loadObjectGroupChildren(group);
    group.children![0].isExpanded = true;
    rows.splice(1, rows.length - 1, ...Array.from({ length: 450 }, (_, i) => ({ name: `new_${String(i).padStart(3, "0")}`, table_type: "TABLE", parent_name: "stable" })));
    await store.loadObjectGroupChildren(group, { force: true });
    const children = group.children![0].children!.find((node) => node.type === "group-partitions")!;
    expect(children.children?.map((node) => node.label)).toEqual(rows.slice(1).map((row) => row.name));
    expect(children.objectCount).toBe(450);
  });

  it("deletes an obsolete in-flight TDengine save before a newer refresh is persisted", async () => {
    const { store, group, rows, cache, saveSchemaCache } = await setupTdengineCache();
    const save = saveSchemaCache.getMockImplementation()!;
    let resolveSave!: () => void;
    saveSchemaCache.mockImplementationOnce(async (key, value) => {
      await new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
      await save(key, value);
    });
    const oldLoad = store.loadObjectGroupChildren(group);
    await vi.waitFor(() => expect(resolveSave).toBeDefined());
    rows.splice(0, rows.length, { name: "replacement", table_type: "STABLE" });
    const refresh = store.loadObjectGroupChildren(group, { force: true });
    await vi.waitFor(() => expect(group.children?.[0]?.label).toBe("replacement"));
    resolveSave();
    await Promise.all([oldLoad, refresh]);
    const snapshots = [...cache.values()];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].children.map((node: TreeNode) => node.label)).toEqual(["replacement"]);
    expect(group.children?.map((node) => node.label)).toEqual(["replacement"]);
  });

  it("retains valid partial progress on cancel while a TDengine cache save is pending", async () => {
    const { store, group, saveSchemaCache, listTables, release } = await setupTdengineCache();
    const save = saveSchemaCache.getMockImplementation()!;
    let resolveSave!: () => void;
    saveSchemaCache.mockImplementationOnce(async (key, value) => {
      await new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
      await save(key, value);
    });
    const pending = store.loadObjectGroupChildren(group);
    await vi.waitFor(() => expect(resolveSave).toBeDefined());
    store.cancelTreeNodeLoad(group.id);
    group.isExpanded = false;
    resolveSave();
    await pending;
    expect(group.isExpanded).toBe(false);
    expect(listTables.mock.calls.map((call) => call[5])).toEqual([0]);
    release();
    listTables.mockClear();
    await store.loadObjectGroupChildren(group);
    expect(listTables.mock.calls.map((call) => call[5])).toEqual([420]);
    expect(group.children![0].children![0].objectCount).toBe(450);
  });

  it("does not reuse a persisted TDengine tree after metadata invalidation", async () => {
    const { store, group, listTables, release } = await setupTdengineCache();
    await store.loadObjectGroupChildren(group);
    release();
    store.invalidateMetadataCache(group.connectionId!, "app");
    listTables.mockClear();
    await store.loadObjectGroupChildren(group);
    expect(listTables.mock.calls.map((call) => call[5])).toEqual([0, 420]);
  });

  it.each([0, 420])("does not resume an obsolete TDengine page at offset %s after invalidation during persistence", async (offset) => {
    const { store, group, saveSchemaCache, listTables, cache } = await setupTdengineCache();
    const save = saveSchemaCache.getMockImplementation()!;
    if (offset > 0) saveSchemaCache.mockImplementationOnce(save);
    let resolveSave!: () => void;
    saveSchemaCache.mockImplementationOnce(async (key, value) => {
      await new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
      await save(key, value);
    });
    const pending = store.loadObjectGroupChildren(group);
    await vi.waitFor(() => expect(resolveSave).toBeDefined());
    store.invalidateMetadataCache(group.connectionId!, "app");
    group.isExpanded = false;
    resolveSave();
    await pending;
    expect(listTables.mock.calls.map((call) => call[5])).toEqual(offset > 0 ? [0, 420] : [0]);
    expect(cache.size).toBe(0);
    expect(group.isExpanded).toBe(false);
  });

  it("does not mistake a self-consistent but incomplete historical v3 snapshot for a full TDengine tree", async () => {
    const { store, group, cache, listTables, loadSchemaCache, rows } = await setupTdengineCache();
    const legacyChildren = buildTableTreeNodes({ nodeId: "pg-1:app", connectionId: "pg-1", database: "app", tables: rows.slice(0, 100) });
    const legacyKey = "pg-1:app::group-tables:objects-v9";
    cache.set(legacyKey, encodeSchemaTreeCache(legacyChildren));
    await store.loadObjectGroupChildren(group);
    expect(loadSchemaCache).not.toHaveBeenCalledWith(legacyKey);
    expect(loadSchemaCache).toHaveBeenCalledWith("pg-1:app::group-tables:objects-tdengine-v1");
    expect(listTables.mock.calls.map((call) => call[5])).toEqual([0, 420]);
    expect(group.children![0].children![0].objectCount).toBe(450);
    expect(cache.has(legacyKey)).toBe(true);
  });

  it("retries a failed partial TDengine page without restarting page zero", async () => {
    const { store, group, listTables, release } = await setupTdengineCache();
    store.connections[0].sidebar_auto_load_all_tables = false;
    await store.loadObjectGroupChildren(group, { force: true });
    release();
    store.connections[0].sidebar_auto_load_all_tables = true;
    listTables.mockClear();
    listTables.mockRejectedValueOnce(new Error("temporary metadata failure"));
    await expect(store.loadObjectGroupChildren(group)).rejects.toThrow("temporary metadata failure");
    expect(group.children![0].children![0].objectCount).toBe(419);
    await store.loadObjectGroupChildren(group);
    expect(listTables.mock.calls.map((call) => call[5])).toEqual([420, 420]);
    expect(group.children![0].children![0].objectCount).toBe(450);
  });

  it("marks leaf column nodes raw so Vue does not deep-wrap them", async () => {
    const { loadStore } = await setupStoreWithColumnGroup();
    const getColumns = vi.fn().mockResolvedValue(columns(5));
    const store = await loadStore(getColumns);

    await store.loadColumns("pg-1", "app", "users", "public", GROUP_ID);

    const group = findById(store.treeNodes, GROUP_ID);
    expect(group?.children).toHaveLength(5);
    // The container group stays reactive so expand/collapse still drives the UI...
    expect(isReactive(group!)).toBe(true);
    // ...but every leaf column (and, transitively, its `meta`) is raw.
    for (const leaf of group!.children ?? []) {
      expect(isReactive(leaf)).toBe(false);
      expect(isReactive(leaf.meta as object)).toBe(false);
    }
  });

  it("releases a large collapsed subtree and reloads it on demand", async () => {
    const { loadStore } = await setupStoreWithColumnGroup();
    const getColumns = vi.fn().mockResolvedValue(columns(500));
    const store = await loadStore(getColumns);

    await store.loadColumns("pg-1", "app", "users", "public", GROUP_ID);
    expect(findById(store.treeNodes, GROUP_ID)?.children).toHaveLength(500);
    expect(store.isTreeNodeChildrenLoaded(GROUP_ID)).toBe(true);

    const released = store.releaseCollapsedTreeNodeChildren(GROUP_ID);

    expect(released).toBe(true);
    expect(findById(store.treeNodes, GROUP_ID)?.children).toEqual([]);
    // Forgetting the loaded id is what makes a later expand reload the children.
    expect(store.isTreeNodeChildrenLoaded(GROUP_ID)).toBe(false);
  });

  it("keeps a small collapsed subtree so routine expand/collapse stays instant", async () => {
    const { loadStore } = await setupStoreWithColumnGroup();
    const getColumns = vi.fn().mockResolvedValue(columns(20));
    const store = await loadStore(getColumns);

    await store.loadColumns("pg-1", "app", "users", "public", GROUP_ID);

    const released = store.releaseCollapsedTreeNodeChildren(GROUP_ID);

    expect(released).toBe(false);
    expect(findById(store.treeNodes, GROUP_ID)?.children).toHaveLength(20);
    expect(store.isTreeNodeChildrenLoaded(GROUP_ID)).toBe(true);
  });

  it.each([false, true])("preserves decorated paged child tables through release/reopen (partial=%s)", async (partial) => {
    const { loadStore } = await setupStoreWithColumnGroup();
    const getColumns = vi.fn();
    const store = await loadStore(getColumns);
    store.connections[0].db_type = "tdengine";
    const context = { nodeId: "pg-1:app:__tables", connectionId: "pg-1", database: "app" };
    const childTables = (start: number, end: number) => Array.from({ length: end - start }, (_, index) => ({ name: `meter_${start + index}`, table_type: "CHILD TABLE", parent_name: "meters" }));
    const firstPage = buildTableTreeNodes({ ...context, tables: [{ name: "meters", table_type: "STABLE" }, ...childTables(0, 200)] });
    const decorated = decorateDatabaseSavedSqlTreeNodes(firstPage, []);
    // The real saved-SQL projection clones visible nodes but retains hidden ones.
    expect(decorated[0].children?.[0]).not.toBe(decorated[0].hiddenChildren?.[0]);
    let tables = mergeTableTreePageChildren(decorated, buildTableTreeNodes({ ...context, tables: childTables(200, 450) }), context.connectionId, context.database);
    const cursor: TreeNode = { id: `${context.nodeId}:__load_more`, label: "More", type: "load-more", connectionId: context.connectionId, database: context.database, loadMore: { parentId: context.nodeId, offset: 451, pageSize: 250, anchor: "\u0000meters\u0000meter_450" } };
    if (partial) tables = appendTableTreeLoadMoreNode(tables, cursor, { name: "meters" });
    store.treeNodes = decorateDatabaseSavedSqlTreeNodes(tables, []);
    const tableId = tables[0].id;
    const group = () => findById(store.treeNodes, tableId)!.children!.find((node) => node.type === "group-partitions")!;
    const expectedIds = group()
      .children!.filter((node) => node.type === "table")
      .map((node) => node.id);

    for (let round = 0; round < 3; round += 1) {
      await store.loadTableGroups(context.connectionId, context.database, "meters", undefined, tableId);
      findById(store.treeNodes, tableId)!.isExpanded = false;
      expect(store.releaseCollapsedTreeNodeChildren(tableId)).toBe(true);
      expect(findById(store.treeNodes, tableId)?.children).toEqual([]);
      expect(store.isTreeNodeChildrenLoaded(tableId)).toBe(false);
      await store.loadTableGroups(context.connectionId, context.database, "meters", undefined, tableId);
      expect(group().objectCount).toBe(450);
      expect(
        group()
          .children!.filter((node) => node.type === "table")
          .map((node) => node.id),
      ).toEqual(expectedIds);
      expect(group().children!.filter((node) => node.type === "load-more")).toEqual(partial ? [cursor] : []);
    }

    if (partial) {
      // Continue from the preserved cursor, including an overlapping row.
      store.treeNodes = decorateDatabaseSavedSqlTreeNodes(mergeTableTreePageChildren(withoutTableTreeLoadMoreNodes(store.treeNodes), buildTableTreeNodes({ ...context, tables: childTables(449, 500) }), context.connectionId, context.database), []);
      expect(store.releaseCollapsedTreeNodeChildren(tableId)).toBe(true);
      await store.loadTableGroups(context.connectionId, context.database, "meters", undefined, tableId);
      expect(group().objectCount).toBe(500);
      expect(new Set(group().children!.map((node) => node.id)).size).toBe(500);
      expect(group().children!.some((node) => node.type === "load-more")).toBe(false);
    }
    expect(getColumns).not.toHaveBeenCalled();
  });

  it("preserves the visible authoritative group from a legacy serialized tree on release", async () => {
    const { loadStore } = await setupStoreWithColumnGroup();
    const store = await loadStore(vi.fn());
    store.connections[0].db_type = "tdengine";
    const table = buildTableTreeNodes({ nodeId: "pg-1:app", connectionId: "pg-1", database: "app", tables: [{ name: "meters", table_type: "STABLE" }, ...Array.from({ length: 450 }, (_, index) => ({ name: `meter_${index}`, table_type: "CHILD TABLE", parent_name: "meters" }))] })[0];
    const legacy = JSON.parse(JSON.stringify(table)) as TreeNode;
    legacy.hiddenChildren![0].children = legacy.hiddenChildren![0].children!.slice(0, 200);
    legacy.hiddenChildren![0].objectCount = 200;
    // No new page or table-group load repairs this old snapshot before collapse.
    store.treeNodes = [legacy];
    expect(store.releaseCollapsedTreeNodeChildren(legacy.id)).toBe(true);
    await store.loadTableGroups("pg-1", "app", "meters", undefined, legacy.id);
    expect(store.treeNodes[0].children?.[0].objectCount).toBe(450);
    expect(store.treeNodes[0].children?.[0].children).toHaveLength(450);
  });
});
