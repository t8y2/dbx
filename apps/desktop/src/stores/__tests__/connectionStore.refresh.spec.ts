// @vitest-environment happy-dom
import { createPinia, setActivePinia } from "pinia";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isObjectCacheInvalidationError } from "@/lib/metadata/objectCacheInvalidationError";
import { decodeSchemaTreeCache, encodeSchemaTreeCache } from "@/lib/metadata/schemaTreeCache";
import { collectSidebarRegexIndexScopes } from "@/lib/sidebar/sidebarRegexSearchIndex";
import { buildSidebarIndexedTableNodes, mergeSidebarRegexIndexScopes, type SidebarRegexIndexScope } from "@/lib/sidebar/sidebarSearchTree";
import { createColumnDrafts } from "@/lib/table/tableStructureEditorState";
import type { ColumnInfo, ConnectionConfig, TableInfo, TreeNode } from "@/types/database";

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

function installApiMocks(options?: {
  deleteSchemaCachePrefix?: ReturnType<typeof vi.fn>;
  getColumns?: ReturnType<typeof vi.fn>;
  getTableComment?: ReturnType<typeof vi.fn>;
  listDatabases?: ReturnType<typeof vi.fn>;
  listObjects?: ReturnType<typeof vi.fn>;
  listSchemaInfos?: ReturnType<typeof vi.fn>;
  listTables?: ReturnType<typeof vi.fn>;
  listTriggers?: ReturnType<typeof vi.fn>;
  loadSchemaCache?: ReturnType<typeof vi.fn>;
  saveSchemaCache?: ReturnType<typeof vi.fn>;
}) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: options?.deleteSchemaCachePrefix ?? vi.fn().mockResolvedValue(undefined),
    getColumns: options?.getColumns ?? vi.fn().mockResolvedValue([]),
    getTableComment: options?.getTableComment ?? vi.fn().mockResolvedValue(null),
    listDatabases: options?.listDatabases ?? vi.fn().mockResolvedValue([{ name: "app", comment: null }]),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    listObjects: options?.listObjects ?? vi.fn().mockResolvedValue([]),
    listSchemaInfos: options?.listSchemaInfos ?? vi.fn().mockResolvedValue([{ name: "public", comment: null }]),
    listTables: options?.listTables ?? vi.fn().mockResolvedValue([]),
    listTriggers: options?.listTriggers ?? vi.fn().mockResolvedValue([]),
    loadSchemaCache: options?.loadSchemaCache ?? vi.fn().mockResolvedValue(null),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSchemaCache: options?.saveSchemaCache ?? vi.fn().mockResolvedValue(undefined),
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
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    document.body.replaceChildren();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  function tableNodeForCommentRefresh(overrides: Partial<TreeNode> = {}): TreeNode {
    return {
      id: "pg-1:app:public:users",
      label: "users",
      type: "table",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      comment: "old comment",
      isExpanded: false,
      children: [],
      ...overrides,
    };
  }

  function deferredComment() {
    let resolve!: (value: string | null) => void;
    const promise = new Promise<string | null>((finish) => {
      resolve = finish;
    });
    return { promise, resolve };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => {
      resolve = finish;
    });
    return { promise, resolve };
  }

  async function indexedCommentFixture(options: { inTree?: boolean; getTableComment?: ReturnType<typeof vi.fn>; listTables?: ReturnType<typeof vi.fn>; loadSchemaCache?: ReturnType<typeof vi.fn> } = {}) {
    const treeCacheKey = "pg-1:app:public:group-tables:objects-v9-pg-roots-v1";
    const indexCacheKey = `${treeCacheKey}:table-search-index-v1`;
    const entries: TableInfo[] = [
      { name: "users", table_type: "TABLE", schema: "public", comment: "old comment" },
      { name: "orders", table_type: "TABLE", schema: "public", comment: "other comment" },
    ];
    const originalIndex = encodeSchemaTreeCache([], Date.now() - 1000, { version: 4, complete: true, indexedAt: new Date(Date.now() - 1000).toISOString(), entries: entries.map(({ name, table_type, schema, comment }) => ({ name, tableType: table_type, schema, comment })) });
    const cache = new Map<string, unknown>([[indexCacheKey, originalIndex]]);
    const deleteSchemaCachePrefix = vi.fn(async (prefix: string) => {
      for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
    });
    const loadSchemaCache = options.loadSchemaCache ?? vi.fn(async (key: string) => (cache.has(key) ? JSON.parse(JSON.stringify(cache.get(key))) : null));
    const saveSchemaCache = vi.fn(async (key: string, value: unknown) => {
      cache.set(key, JSON.parse(JSON.stringify(value)));
    });
    const listTables = options.listTables ?? vi.fn().mockResolvedValue(entries);
    const getTableComment = options.getTableComment ?? vi.fn().mockResolvedValue("updated comment");
    installApiMocks({ deleteSchemaCachePrefix, loadSchemaCache, saveSchemaCache, listTables, getTableComment });
    const parent: TreeNode = { ...schemaNode([]), id: "pg-1:app:public:__tables", label: "Tables", type: "group-tables", isExpanded: false };
    const indexedNodes = buildSidebarIndexedTableNodes({ parentNodeId: parent.id, nodeType: parent.type, connectionId: "pg-1", database: "app", schema: "public", entries });
    const table = indexedNodes.find((node) => node.label === "users")!;
    if (options.inTree) parent.children = indexedNodes;
    const store = await createStore(schemaNode([parent]));
    return { store, parent, table, indexedNodes, cache, treeCacheKey, indexCacheKey, originalIndex, entries, loadSchemaCache, saveSchemaCache, deleteSchemaCachePrefix, listTables, getTableComment };
  }

  async function mountCachedSearch(store: Awaited<ReturnType<typeof indexedCommentFixture>>["store"], customLoad?: (shouldCancel: () => boolean, onProgress: (scopes: SidebarRegexIndexScope[]) => void) => Promise<SidebarRegexIndexScope[]>) {
    const { useSidebarSearchIndexes } = await import("@/composables/useSidebarSearchIndexes");
    const query = ref("");
    const load = vi.fn(
      customLoad ??
        ((shouldCancel: () => boolean) =>
          collectSidebarRegexIndexScopes(
            {
              loadSidebarTableSearchIndexScopes: () => store.loadSidebarTableSearchIndexScopes(),
              loadSidebarTableSearchIndex: (scope) => store.loadSidebarTableSearchIndex(scope.parentNodeId, scope),
            },
            store.treeNodes,
            shouldCancel,
          )),
    );
    const onError = vi.fn();
    let search!: ReturnType<typeof useSidebarSearchIndexes>;
    const app = createApp(
      defineComponent({
        setup() {
          search = useSidebarSearchIndexes({ query, context: [() => store.sidebarTableSearchIndexInvalidation.revision], commentUpdate: () => store.sidebarTableCommentUpdate, load, onError });
          return () =>
            h(
              "div",
              search.scopes.value.flatMap((scope) => buildSidebarIndexedTableNodes(scope).map((node) => h("span", { "data-table": node.label }, `${node.label}: ${node.comment}`))),
            );
        },
      }),
    );
    const host = document.createElement("div");
    document.body.append(host);
    app.mount(host);
    cleanups.push(() => app.unmount());
    query.value = "users";
    await vi.waitFor(() => expect(host.querySelector('[data-table="users"]')?.textContent).toBe("users: old comment"));
    return { query, load, host, search, onError };
  }

  it.each([false, true])("refreshes and clears a table comment without changing expansion (%s)", async (expanded) => {
    const getTableComment = vi.fn().mockResolvedValueOnce("updated comment").mockResolvedValueOnce(null);
    installApiMocks({ getTableComment });
    const table = tableNodeForCommentRefresh({ catalog: "external", isExpanded: expanded });
    const store = await createStore(schemaNode([table]));

    await store.refreshTreeNode(table);

    expect(table.comment).toBe("updated comment");
    // Native PostgreSQL/MySQL use the ordinary metadata API, not Oracle-only exact identity.
    expect(getTableComment).toHaveBeenNthCalledWith(1, "pg-1", "app", "public", "users", "external");
    expect(table.isExpanded).toBe(expanded);
    expect(table.children?.map((child) => child.type)).toContain("group-columns");

    await store.refreshTreeNode(table);

    expect(table.comment).toBeNull();
    expect(getTableComment).toHaveBeenCalledTimes(2);
    expect(table.isExpanded).toBe(expanded);
    expect(table.children?.map((child) => child.type)).toContain("group-columns");
  });

  it.each([
    ["view", false],
    ["view", true],
    ["materialized_view", false],
    ["materialized_view", true],
  ] as const)("preserves the %s comment while refreshing its structure and expansion (%s)", async (type, expanded) => {
    // PostgreSQL's table-comment endpoint returns null for ordinary views.
    const getTableComment = vi.fn().mockResolvedValue(null);
    const getColumns = vi.fn().mockResolvedValue([column("fresh")]);
    installApiMocks({ getTableComment, getColumns });
    const columns: TreeNode = {
      id: "pg-1:app:public:users:__columns",
      label: "Columns",
      type: "group-columns",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      tableName: "users",
      isExpanded: true,
      children: [{ id: "old-column", label: "old", type: "column", meta: column("old") }],
    };
    const view = tableNodeForCommentRefresh({ type, isExpanded: expanded, children: [columns] });
    const store = await createStore(schemaNode([view]));

    await store.refreshTreeNode(view);

    expect(getTableComment).not.toHaveBeenCalled();
    expect(view.comment).toBe("old comment");
    expect(view.isExpanded).toBe(expanded);
    expect(getColumns).toHaveBeenCalledWith("pg-1", "app", "public", "users", undefined);
    const refreshedColumns = view.children?.find((child) => child.type === "group-columns");
    expect(refreshedColumns?.isExpanded).toBe(true);
    expect(refreshedColumns?.children?.map((child) => child.meta)).toEqual([column("fresh")]);
  });

  it("preserves the old comment when its lookup fails while refreshing expanded columns", async () => {
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    const saveSchemaCache = vi.fn().mockResolvedValue(undefined);
    const getTableComment = vi.fn().mockRejectedValue(new Error("comment metadata denied"));
    const getColumns = vi.fn().mockResolvedValue([column("fresh")]);
    installApiMocks({ deleteSchemaCachePrefix, saveSchemaCache, getTableComment, getColumns });
    const columns: TreeNode = {
      id: "pg-1:app:public:users:__columns",
      label: "Columns",
      type: "group-columns",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      tableName: "users",
      isExpanded: true,
      children: [{ id: "pg-1:app:public:users:__columns:old", label: "old", type: "column", meta: column("old") }],
    };
    const table = tableNodeForCommentRefresh({ isExpanded: true, children: [columns] });
    const store = await createStore(schemaNode([table]));

    await expect(store.refreshTreeNode(table)).resolves.toBeUndefined();

    expect(getTableComment).toHaveBeenCalledOnce();
    expect(table.comment).toBe("old comment");
    expect(table.isExpanded).toBe(true);
    expect(getColumns).toHaveBeenCalledWith("pg-1", "app", "public", "users", undefined);
    const refreshedColumns = table.children?.find((child) => child.type === "group-columns");
    expect(refreshedColumns?.isExpanded).toBe(true);
    expect(refreshedColumns?.children?.map((child) => child.meta)).toEqual([column("fresh")]);
    expect(deleteSchemaCachePrefix).not.toHaveBeenCalledWith("pg-1:app:public:objects-grouped-v9");
    expect(saveSchemaCache).not.toHaveBeenCalledWith("pg-1:app:public:objects-grouped-v9", null);
    expect(store.sidebarTableCommentUpdate).toBeNull();
  });

  it("keeps the newer comment when an earlier refresh completes last", async () => {
    const saveSchemaCache = vi.fn().mockResolvedValue(undefined);
    const earlier = deferredComment();
    const getTableComment = vi.fn().mockReturnValueOnce(earlier.promise).mockResolvedValueOnce("newer comment");
    installApiMocks({ saveSchemaCache, getTableComment });
    const table = tableNodeForCommentRefresh();
    const store = await createStore(schemaNode([table]));

    const firstRefresh = store.refreshTreeNode(table);
    await vi.waitFor(() => expect(getTableComment).toHaveBeenCalledTimes(1));
    await store.refreshTreeNode(table);
    expect(table.comment).toBe("newer comment");
    expect(saveSchemaCache.mock.calls.filter(([key, value]) => key === "pg-1:app:public:objects-grouped-v9" && value === null)).toHaveLength(1);

    earlier.resolve("stale comment");
    await firstRefresh;

    expect(getTableComment).toHaveBeenCalledTimes(2);
    expect(table.comment).toBe("newer comment");
    expect(saveSchemaCache.mock.calls.filter(([key, value]) => key === "pg-1:app:public:objects-grouped-v9" && value === null)).toHaveLength(1);
  });

  it.each(["replaced", "disconnected"] as const)("ignores a pending comment after its target is %s", async (change) => {
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    const saveSchemaCache = vi.fn().mockResolvedValue(undefined);
    const pending = deferredComment();
    const getTableComment = vi.fn().mockReturnValue(pending.promise);
    installApiMocks({ deleteSchemaCachePrefix, saveSchemaCache, getTableComment });
    const table = tableNodeForCommentRefresh();
    const store = await createStore(schemaNode([table]));
    const replacement = tableNodeForCommentRefresh({ comment: "parent refresh comment" });

    const refresh = store.refreshTreeNode(table);
    await vi.waitFor(() => expect(getTableComment).toHaveBeenCalledOnce());
    if (change === "replaced") store.treeNodes[0]!.children![0]!.children = [replacement];
    else store.connectedIds.delete("pg-1");
    pending.resolve("stale comment");
    await refresh;

    expect(table.comment).toBe("old comment");
    expect(deleteSchemaCachePrefix).not.toHaveBeenCalledWith("pg-1:app:public:objects-grouped-v9");
    expect(saveSchemaCache).not.toHaveBeenCalledWith("pg-1:app:public:objects-grouped-v9", null);
    expect(store.sidebarTableCommentUpdate).toBeNull();
    if (change === "replaced") expect(store.treeNodes[0]!.children![0]!.children![0]!.comment).toBe("parent refresh comment");
  });

  it("does not fetch table comments just to load child groups", async () => {
    const getTableComment = vi.fn().mockResolvedValue("updated comment");
    installApiMocks({ getTableComment });
    const table = tableNodeForCommentRefresh();
    const store = await createStore(schemaNode([table]));

    await store.loadTreeNodeChildren(table);

    expect(getTableComment).not.toHaveBeenCalled();
    expect(table.comment).toBe("old comment");
    expect(table.children?.map((child) => child.type)).toContain("group-columns");
  });

  it("does not fetch unsupported SQLite table comments during refresh", async () => {
    const getTableComment = vi.fn().mockResolvedValue("updated comment");
    installApiMocks({ getTableComment });
    const table = tableNodeForCommentRefresh();
    const store = await createStore(schemaNode([table]));
    store.connections = [{ ...postgresConnection(), db_type: "sqlite", database: "/tmp/app.sqlite" }];

    await store.refreshTreeNode(table);

    expect(getTableComment).not.toHaveBeenCalled();
    expect(table.comment).toBe("old comment");
    expect(table.isExpanded).toBe(false);
    expect(table.children?.map((child) => child.type)).toContain("group-columns");
  });

  it.each(["grouped", "simple", "vgroup"] as const)("invalidates the containing %s list cache without rebuilding its rows or pagination", async (layout) => {
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    const saveSchemaCache = vi.fn().mockResolvedValue(undefined);
    const listTables = vi.fn();
    installApiMocks({ deleteSchemaCachePrefix, saveSchemaCache, listTables, getTableComment: vi.fn().mockResolvedValue("updated comment") });
    const table = tableNodeForCommentRefresh();
    const sibling = tableNodeForCommentRefresh({ id: "pg-1:app:public:orders", label: "orders", comment: "other table comment", isExpanded: true });
    const root = schemaNode([]);
    const parent: TreeNode = layout === "simple" ? root : { ...root, id: "pg-1:app:public:__tables", label: "Tables", type: "group-tables" };
    const cursor: TreeNode = { id: `${parent.id}:load-more`, label: "Load more", type: "load-more", loadMore: { parentId: parent.id, offset: 200, pageSize: 100 } };
    const tableContainer: TreeNode = layout === "vgroup" ? { id: "table-vgroup:favorite", label: "Favorite", type: "table-vgroup", vgroupId: "favorite", isExpanded: true, children: [table] } : table;
    parent.children = [tableContainer, sibling, cursor];
    parent.objectCount = 350;
    parent.isExpanded = false;
    if (parent !== root) root.children = [parent];
    const previousChildren = parent.children;
    const previousCursor = cursor.loadMore;
    const store = await createStore(root);
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = layout === "simple" ? "simple" : "grouped";
    const expectedCacheKey = layout === "simple" ? "pg-1:app:public:objects-simple-v9-pg-roots-v1" : "pg-1:app:public:group-tables:objects-v9-pg-roots-v1";

    await store.refreshTreeNode(table);

    expect(saveSchemaCache).toHaveBeenCalledWith(expectedCacheKey, null);
    expect(deleteSchemaCachePrefix).not.toHaveBeenCalledWith(expectedCacheKey);
    expect(parent.children).toBe(previousChildren);
    expect(parent.children).toEqual([tableContainer, sibling, cursor]);
    expect(parent.objectCount).toBe(350);
    expect(parent.isExpanded).toBe(false);
    expect(cursor.loadMore).toBe(previousCursor);
    expect(cursor.loadMore).toEqual({ parentId: parent.id, offset: 200, pageSize: 100 });
    expect(sibling).toMatchObject({ comment: "other table comment", isExpanded: true, children: [] });
    expect(table.comment).toBe("updated comment");
    expect(listTables).not.toHaveBeenCalled();
  });

  it.each(["tree", "search", "retained-search"] as const)("updates the cached comment for a %s target without removing search results", async (targetKind) => {
    const fixture = await indexedCommentFixture({ inTree: targetKind === "tree" });
    const { store, table, parent, cache, treeCacheKey, indexCacheKey, originalIndex, listTables, getTableComment, deleteSchemaCachePrefix } = fixture;
    await expect(store.loadSidebarTableSearchIndex(parent.id)).resolves.toEqual(fixture.entries);
    const manifestBefore = await store.loadSidebarTableSearchIndexScopes();
    const invalidationBefore = store.sidebarTableSearchIndexInvalidation;
    if (targetKind === "retained-search") store.retainSidebarSearchDetailTable(table);

    await store.refreshTreeNode(store.resolveSidebarSearchDetailTable(table));

    expect(getTableComment).toHaveBeenCalledWith("pg-1", "app", "public", "users", undefined);
    expect(store.resolveSidebarSearchDetailTable(table).comment).toBe("updated comment");
    expect(store.sidebarTableSearchIndexInvalidation).toBe(invalidationBefore);
    expect(deleteSchemaCachePrefix).not.toHaveBeenCalledWith(treeCacheKey);
    expect(deleteSchemaCachePrefix).not.toHaveBeenCalledWith(indexCacheKey);
    expect(cache.get(treeCacheKey)).toBeNull();
    const expected = fixture.entries.map((entry) => (entry.name === "users" ? { ...entry, comment: "updated comment" } : entry));
    await expect(store.loadSidebarTableSearchIndex(parent.id)).resolves.toEqual(expected);
    const persisted = decodeSchemaTreeCache(cache.get(indexCacheKey));
    expect(persisted?.tableSearchIndex?.entries).toEqual(originalIndex.tableSearchIndex!.entries.map((entry) => (entry.name === "users" ? { ...entry, comment: "updated comment" } : entry)));
    expect(persisted?.tableSearchIndex?.indexedAt).toBe(originalIndex.tableSearchIndex!.indexedAt);
    const manifestAfter = await store.loadSidebarTableSearchIndexScopes();
    expect(manifestAfter.map(({ scope }) => scope)).toEqual(manifestBefore.map(({ scope }) => scope));
    expect(listTables).not.toHaveBeenCalled();
  });

  it("keeps an indexed local/regex search result visible when its comment is refreshed", async () => {
    const { store, parent, table, listTables } = await indexedCommentFixture();
    await store.loadSidebarTableSearchIndex(parent.id);
    store.retainSidebarSearchDetailTable(table);
    const detail = store.resolveSidebarSearchDetailTable(table);
    const { host, load, onError } = await mountCachedSearch(store);

    await store.refreshTreeNode(detail);
    await nextTick();

    expect(host.querySelector('[data-table="users"]')?.textContent).toBe("users: updated comment");
    expect(host.querySelector('[data-table="orders"]')?.textContent).toBe("orders: other comment");
    expect(store.resolveSidebarSearchDetailTable(table)).toBe(detail);
    expect(load).toHaveBeenCalledOnce();
    expect(listTables).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([false, true])("refreshes a qualified search detail after pagination adds the same table (search cleared: %s)", async (clearSearch) => {
    const pageRows = deferred<TableInfo[]>();
    const pendingComment = deferredComment();
    const { store, parent, table, entries, listTables, getTableComment } = await indexedCommentFixture({ listTables: vi.fn().mockReturnValue(pageRows.promise), getTableComment: vi.fn().mockReturnValue(pendingComment.promise) });
    await store.loadSidebarTableSearchIndex(parent.id);
    const more: TreeNode = { id: `${parent.id}:more`, label: "Load more", type: "load-more", connectionId: parent.connectionId, database: parent.database, schema: parent.schema, loadMore: { parentId: parent.id, offset: 1, pageSize: 100 } };
    parent.children = [more];
    const page = store.loadMoreObjectGroupChildren(more);
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledOnce());

    store.retainSidebarSearchDetailTable(table);
    const detail = store.resolveSidebarSearchDetailTable(table);
    await store.loadTreeNodeChildren(detail);
    detail.isExpanded = true;
    expect(detail.children?.some((child) => child.type === "group-columns")).toBe(true);
    pageRows.resolve(entries);
    await page;
    const live = parent.children!.find((row) => row.id === detail.id)!;
    expect(live).toBeDefined();
    expect(live).not.toBe(detail);
    expect(live.isExpanded).toBeFalsy();

    const refresh = store.refreshTreeNode(live);
    await vi.waitFor(() => expect(getTableComment).toHaveBeenCalledOnce());
    if (clearSearch) store.clearSidebarSearchDetailTables();
    pendingComment.resolve("updated comment");
    await refresh;

    expect(live.comment).toBe("updated comment");
    expect(live.isExpanded).toBeFalsy();
    if (clearSearch) {
      expect(store.findSidebarSearchDetailNode(table)).toBeNull();
      expect(detail.comment).toBe("old comment");
      return;
    }
    const scopes = (await store.loadSidebarTableSearchIndexScopes()).map(({ scope, entries }) => ({ ...scope, entries: entries.filter((entry) => entry.schema === "public" && entry.name === "users") }));
    const qualified = mergeSidebarRegexIndexScopes(store.treeNodes, scopes, store.resolveSidebarSearchDetailTable, { scopesOnly: true });
    const visible = qualified[0]?.children?.find((row) => row.id === detail.id);
    expect(visible).toBe(detail);
    expect.soft(visible?.comment).toBe("updated comment");
    expect.soft(visible?.isExpanded).toBe(true);
    expect(visible?.children?.some((child) => child.type === "group-columns")).toBe(true);
  });

  it("clears a removed table comment in memory and persisted search indexes", async () => {
    const { store, parent, table, cache, indexCacheKey } = await indexedCommentFixture({ getTableComment: vi.fn().mockResolvedValue(null) });
    await store.loadSidebarTableSearchIndex(parent.id);

    await store.refreshTreeNode(table);

    expect((await store.loadSidebarTableSearchIndex(parent.id))?.find((entry) => entry.name === "users")?.comment).toBeNull();
    expect(decodeSchemaTreeCache(cache.get(indexCacheKey))?.tableSearchIndex?.entries.find((entry) => entry.name === "users")?.comment).toBeNull();
    expect(store.resolveSidebarSearchDetailTable(table).comment).toBeNull();
  });

  it("keeps a comment refreshed during an index build without overriding later server reads", async () => {
    const building = deferred<TableInfo[]>();
    const listTables = vi.fn().mockReturnValueOnce(building.promise);
    const fixture = await indexedCommentFixture({ listTables });
    const { store, table, parent, entries, cache, indexCacheKey } = fixture;
    await store.loadSidebarTableSearchIndex(parent.id);
    const build = store.refreshSidebarTableSearchIndex(parent.id);
    await vi.waitFor(() => expect(listTables).toHaveBeenCalledOnce());

    await store.refreshTreeNode(table);
    building.resolve(entries);

    const expected = entries.map((entry) => (entry.name === "users" ? { ...entry, comment: "updated comment" } : entry));
    await expect(build).resolves.toEqual(expected);
    await expect(store.loadSidebarTableSearchIndex(parent.id)).resolves.toEqual(expected);
    expect(decodeSchemaTreeCache(cache.get(indexCacheKey))?.tableSearchIndex?.entries.find((entry) => entry.name === "users")?.comment).toBe("updated comment");
    const latest = entries.map((entry) => (entry.name === "users" ? { ...entry, comment: "later server comment" } : entry));
    listTables.mockResolvedValueOnce(latest);
    await expect(store.refreshSidebarTableSearchIndex(parent.id)).resolves.toEqual(latest);
  });

  it.each([false, true])("handles a pending UI index load after a comment refresh (clear search: %s)", async (clearSearch) => {
    const { store, parent, table } = await indexedCommentFixture();
    await store.loadSidebarTableSearchIndex(parent.id);
    const oldScopes = (await store.loadSidebarTableSearchIndexScopes()).map(({ scope, entries }) => ({ ...scope, entries }));
    const loading = deferred<SidebarRegexIndexScope[]>();
    const { host, query, search } = await mountCachedSearch(store, (_shouldCancel, publish) => {
      publish(oldScopes);
      return loading.promise;
    });

    await store.refreshTreeNode(table);
    await nextTick();
    expect(host.querySelector('[data-table="users"]')?.textContent).toBe("users: updated comment");
    if (clearSearch) {
      query.value = "";
      store.clearSidebarSearchDetailTables();
      await nextTick();
    }
    loading.resolve(oldScopes);
    await vi.waitFor(() => expect(search.isLoading.value).toBe(false));
    await nextTick();

    expect(host.querySelector('[data-table="users"]')?.textContent).toBe(clearSearch ? undefined : "users: updated comment");
  });

  it("keeps a comment refreshed during a persisted index read", async () => {
    const reading = deferred<unknown>();
    const loadSchemaCache = vi.fn(async (key: string) => (key.endsWith(":table-search-index-v1") ? reading.promise : null));
    const fixture = await indexedCommentFixture({ inTree: true, loadSchemaCache });
    const { store, table, parent, entries, originalIndex, cache, indexCacheKey } = fixture;
    const read = store.loadSidebarTableSearchIndex(parent.id);
    await vi.waitFor(() => expect(loadSchemaCache).toHaveBeenCalledWith(indexCacheKey));
    const refresh = store.refreshTreeNode(table);
    await vi.waitFor(() => expect(table.comment).toBe("updated comment"));
    reading.resolve(originalIndex);
    const expected = entries.map((entry) => (entry.name === "users" ? { ...entry, comment: "updated comment" } : entry));

    await expect(read).resolves.toEqual(expected);
    await refresh;

    await expect(store.loadSidebarTableSearchIndex(parent.id)).resolves.toEqual(expected);
    expect(decodeSchemaTreeCache(cache.get(indexCacheKey))?.tableSearchIndex?.entries.find((entry) => entry.name === "users")?.comment).toBe("updated comment");
  });

  it.each(["users", "orders"] as const)("retains both refreshed comments when %s finishes first in the same index", async (firstName) => {
    const pending = { users: deferredComment(), orders: deferredComment() };
    const getTableComment = vi.fn((_connection: string, _database: string, _schema: string, name: "users" | "orders") => pending[name].promise);
    const { store, parent, indexedNodes, entries, cache, indexCacheKey } = await indexedCommentFixture({ getTableComment });
    await store.loadSidebarTableSearchIndex(parent.id);
    const users = indexedNodes.find((node) => node.label === "users")!;
    const orders = indexedNodes.find((node) => node.label === "orders")!;
    const refreshes = { users: store.refreshTreeNode(users), orders: store.refreshTreeNode(orders) };
    await vi.waitFor(() => expect(getTableComment).toHaveBeenCalledTimes(2));
    const secondName = firstName === "users" ? "orders" : "users";
    pending[firstName].resolve(`${firstName} updated`);
    await refreshes[firstName];
    pending[secondName].resolve(`${secondName} updated`);
    await refreshes[secondName];

    await expect(store.loadSidebarTableSearchIndex(parent.id)).resolves.toEqual(entries.map((entry) => ({ ...entry, comment: `${entry.name} updated` })));
    expect(decodeSchemaTreeCache(cache.get(indexCacheKey))?.tableSearchIndex?.entries.map(({ name, comment }) => ({ name, comment }))).toEqual(entries.map(({ name }) => ({ name, comment: `${name} updated` })));
    expect(store.resolveSidebarSearchDetailTable(users).comment).toBe("users updated");
    expect(store.resolveSidebarSearchDetailTable(orders).comment).toBe("orders updated");
  });

  it("ignores a pending search comment after the search details are cleared", async () => {
    const pending = deferredComment();
    const getTableComment = vi.fn().mockReturnValue(pending.promise);
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    const saveSchemaCache = vi.fn().mockResolvedValue(undefined);
    installApiMocks({ deleteSchemaCachePrefix, saveSchemaCache, getTableComment });
    const parent: TreeNode = { ...schemaNode([]), id: "pg-1:app:public:__tables", label: "Tables", type: "group-tables", isExpanded: false };
    const table = buildSidebarIndexedTableNodes({ parentNodeId: parent.id, nodeType: parent.type, connectionId: "pg-1", database: "app", schema: "public", entries: [{ name: "users", table_type: "TABLE", schema: "public", comment: "old comment" }] })[0]!;
    const store = await createStore(schemaNode([parent]));

    const refresh = store.refreshTreeNode(table);
    await vi.waitFor(() => expect(getTableComment).toHaveBeenCalledOnce());
    const retained = store.resolveSidebarSearchDetailTable(table);
    expect(retained).not.toBe(table);
    store.clearSidebarSearchDetailTables();
    pending.resolve("stale comment");
    await refresh;

    expect(retained.comment).toBe("old comment");
    expect(store.resolveSidebarSearchDetailTable(table)).toBe(table);
    expect(table.comment).toBe("old comment");
    expect(store.sidebarTableCommentUpdate).toBeNull();
    expect(saveSchemaCache).not.toHaveBeenCalledWith("pg-1:app:public:group-tables:objects-v9-pg-roots-v1", null);
    expect(deleteSchemaCachePrefix).not.toHaveBeenCalledWith("pg-1:app:public:group-tables:objects-v9-pg-roots-v1");
    expect(deleteSchemaCachePrefix).not.toHaveBeenCalledWith("pg-1:app:public:group-tables:objects-v9-pg-roots-v1:table-search-index-v1");
  });

  it.each([
    [true, "old"],
    [false, "old"],
    [true, "renamed"],
    [false, "renamed"],
  ] as const)("refreshes saved table columns without changing expansion (%s, %s)", async (expanded, name) => {
    const getColumns = vi.fn().mockResolvedValue([column("old"), column("removed")]);
    installApiMocks({ getColumns });
    const group: TreeNode = { id: "pg-1:app:public:users:__columns", label: "Columns", type: "group-columns", connectionId: "pg-1", database: "app", schema: "public", tableName: "users", children: [] };
    const otherSchema = { ...group, id: "other-schema", schema: "other", isExpanded: true, children: [] };
    const otherCatalog = { ...group, id: "other-catalog", catalog: "external", isExpanded: true, children: [] };
    const store = await createStore(schemaNode([group, otherSchema, otherCatalog]));
    await store.loadColumns("pg-1", "app", "users", "public", group.id);
    group.isExpanded = expanded;
    const updated = { ...column(name), data_type: "character varying", character_maximum_length: 512, comment: "updated comment", is_nullable: false };
    getColumns.mockResolvedValue([updated]);

    await store.refreshTableColumnsTree("pg-1", "app", "users", "public");

    expect(getColumns).toHaveBeenCalledTimes(2);
    expect(getColumns).toHaveBeenLastCalledWith("pg-1", "app", "public", "users", undefined);
    expect(group.children).toHaveLength(1);
    expect(group.children![0]).toMatchObject({ label: `${name} (character varying)`, meta: updated });
    expect(createColumnDrafts([group.children![0]!.meta as ColumnInfo], "postgres")[0]).toMatchObject({ dataType: "character varying(512)", comment: "updated comment", isNullable: false });
    expect(group.objectCount).toBe(1);
    expect(group.isExpanded).toBe(expanded);
    expect(otherSchema.children).toEqual([]);
    expect(otherCatalog.children).toEqual([]);
  });

  it("preserves old columns on a failed reload and retries an empty loaded group", async () => {
    const getColumns = vi.fn().mockResolvedValue([]);
    installApiMocks({ getColumns });
    const group: TreeNode = { id: "pg-1:app:public:users:__columns", label: "Columns", type: "group-columns", connectionId: "pg-1", database: "app", schema: "public", tableName: "users", children: [] };
    const store = await createStore(schemaNode([group]));
    await store.loadColumns("pg-1", "app", "users", "public", group.id);
    group.isExpanded = false;
    getColumns.mockResolvedValueOnce([column("added")]);
    await store.refreshTableColumnsTree("pg-1", "app", "users", "public");
    expect(group.children![0]!.meta).toEqual(column("added"));
    getColumns.mockRejectedValueOnce(new Error("metadata denied"));
    await expect(store.refreshTableColumnsTree("pg-1", "app", "users", "public")).rejects.toThrow("metadata denied");
    expect(group.children![0]!.meta).toEqual(column("added"));
    expect(group.isExpanded).toBe(false);
    expect(group.isLoading).toBe(false);
  });

  it("ignores an older column request that finishes after the saved structure reload", async () => {
    let finishOld!: (value: ReturnType<typeof column>[]) => void;
    const getColumns = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValue([column("fresh")]);
    installApiMocks({ getColumns });
    const group: TreeNode = { id: "pg-1:app:public:users:__columns", label: "Columns", type: "group-columns", connectionId: "pg-1", database: "app", schema: "public", tableName: "users", children: [] };
    const store = await createStore(schemaNode([group]));
    const oldLoad = store.loadColumns("pg-1", "app", "users", "public", group.id);
    await store.refreshTableColumnsTree("pg-1", "app", "users", "public");
    finishOld([column("stale")]);
    await oldLoad;
    expect(group.children![0]!.meta).toEqual(column("fresh"));
  });

  it("does not load unopened column groups after a structure save", async () => {
    const getColumns = vi.fn();
    installApiMocks({ getColumns });
    const group: TreeNode = { id: "pg-1:app:public:users:__columns", label: "Columns", type: "group-columns", connectionId: "pg-1", database: "app", schema: "public", tableName: "users", children: [] };
    const store = await createStore(schemaNode([group]));
    await store.refreshTableColumnsTree("pg-1", "app", "users", "public");
    expect(getColumns).not.toHaveBeenCalled();
    expect(group.isExpanded).toBeUndefined();
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

  it("refreshes a table-level trigger group using listTriggers without wiping triggers", async () => {
    const listTriggers = vi.fn().mockResolvedValue([{ name: "trg_orders_audit", timing: "AFTER", event: "UPDATE", enabled: false }]);
    const listObjects = vi.fn().mockResolvedValue([]);
    installApiMocks({ listTriggers, listObjects });

    const triggerGroup: TreeNode = {
      id: "pg-1:app:public:orders:__triggers",
      label: "tree.triggers",
      type: "group-triggers",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      tableName: "orders",
      isExpanded: true,
      children: [],
    };
    const table: TreeNode = {
      id: "pg-1:app:public:orders",
      label: "orders",
      type: "table",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      tableName: "orders",
      isExpanded: true,
      children: [triggerGroup],
    };
    const root = schemaNode([table]);
    const store = await createStore(root);

    await store.refreshTreeNode(triggerGroup);

    expect(listTriggers).toHaveBeenCalledWith("pg-1", "app", "public", "orders", undefined);
    expect(listObjects).not.toHaveBeenCalled();
    expect(triggerGroup.objectCount).toBe(1);
    expect(triggerGroup.children).toHaveLength(1);
    expect(triggerGroup.children![0]).toMatchObject({
      id: "pg-1:app:public:orders:__triggers:trg_orders_audit",
      type: "trigger",
      tableName: "orders",
      meta: { name: "trg_orders_audit", enabled: false },
    });
  });

  it("refreshes the parent table trigger group when refreshing a child trigger node", async () => {
    const listTriggers = vi.fn().mockResolvedValue([{ name: "trg_orders_audit", timing: "AFTER", event: "UPDATE", enabled: true }]);
    installApiMocks({ listTriggers });

    const triggerChild: TreeNode = {
      id: "pg-1:app:public:orders:__triggers:trg_orders_audit",
      label: "trg_orders_audit (AFTER UPDATE)",
      type: "trigger",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      tableName: "orders",
      meta: { name: "trg_orders_audit", enabled: false },
    };
    const triggerGroup: TreeNode = {
      id: "pg-1:app:public:orders:__triggers",
      label: "tree.triggers",
      type: "group-triggers",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      tableName: "orders",
      isExpanded: true,
      children: [triggerChild],
    };
    const table: TreeNode = {
      id: "pg-1:app:public:orders",
      label: "orders",
      type: "table",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      tableName: "orders",
      isExpanded: true,
      children: [triggerGroup],
    };
    const root = schemaNode([table]);
    const store = await createStore(root);

    await store.refreshTreeNode(triggerChild);

    expect(listTriggers).toHaveBeenCalledWith("pg-1", "app", "public", "orders", undefined);
    expect(triggerGroup.children![0].meta).toMatchObject({
      name: "trg_orders_audit",
      enabled: true,
    });
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

describe("connectionStore refresh keeps the node expansion state (#14919, #15079)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  function tableNode(expanded: boolean): TreeNode {
    return { id: "pg-1:app:public:users", label: "users", type: "table", connectionId: "pg-1", database: "app", schema: "public", isExpanded: expanded, children: [] };
  }

  function schemaNodeWithState(expanded: boolean, children: TreeNode[] = []): TreeNode {
    return { id: "pg-1:app:public", label: "public", type: "schema", connectionId: "pg-1", database: "app", schema: "public", isExpanded: expanded, children };
  }

  function databaseNodeWithState(expanded: boolean, children: TreeNode[] = []): TreeNode {
    return { id: "pg-1:app", label: "app", type: "database", connectionId: "pg-1", database: "app", isExpanded: expanded, children };
  }

  it("reloads a collapsed table's groups without expanding it", async () => {
    installApiMocks();
    const table = tableNode(false);
    const store = await createStore(schemaNode([table]));

    await store.refreshTreeNode(table);

    expect(table.isExpanded).toBe(false);
    expect(table.children?.map((child) => child.type)).toContain("group-columns");
  });

  it("keeps an expanded table expanded", async () => {
    installApiMocks();
    const table = tableNode(true);
    const store = await createStore(schemaNode([table]));

    await store.refreshTreeNode(table);

    expect(table.isExpanded).toBe(true);
    expect(table.children?.map((child) => child.type)).toContain("group-columns");
  });

  it("reloads a collapsed schema node without expanding it (#15079)", async () => {
    installApiMocks();
    const schema = schemaNodeWithState(false);
    const store = await createStore(schema);

    await store.refreshTreeNode(schema);

    expect(schema.isExpanded).toBe(false);
    expect(schema.children?.map((child) => child.type)).toContain("group-tables");
  });

  it("keeps an expanded schema node expanded on refresh (#15079)", async () => {
    installApiMocks();
    const schema = schemaNodeWithState(true);
    const store = await createStore(schema);

    await store.refreshTreeNode(schema);

    expect(schema.isExpanded).toBe(true);
    expect(schema.children?.map((child) => child.type)).toContain("group-tables");
  });

  it("reloads a collapsed database node without expanding it (#15079)", async () => {
    installApiMocks();
    const database = databaseNodeWithState(false);
    const store = await createStore(database);

    await store.refreshTreeNode(database);

    expect(database.isExpanded).toBe(false);
    expect(database.children?.map((child) => child.label)).toContain("public");
  });

  it("keeps an expanded database node expanded on refresh (#15079)", async () => {
    installApiMocks();
    const database = databaseNodeWithState(true);
    const store = await createStore(database);

    await store.refreshTreeNode(database);

    expect(database.isExpanded).toBe(true);
    expect(database.children?.map((child) => child.label)).toContain("public");
  });

  it("keeps a collapsed database node collapsed when DDL triggers refreshObjectListTreeNode (#15079)", async () => {
    const listTables = vi.fn().mockResolvedValue([{ name: "customers", table_type: "BASE TABLE", comment: null }]);
    installApiMocks({ listTables });

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "grouped";

    const mysqlConfig: ConnectionConfig = {
      id: "mysql-1",
      name: "MySQL",
      db_type: "mysql",
      host: "127.0.0.1",
      port: 3306,
      username: "root",
      password: "",
      database: "shop_db",
    } as ConnectionConfig;

    const dbNode: TreeNode = {
      id: "mysql-1:shop_db",
      label: "shop_db",
      type: "database",
      connectionId: "mysql-1",
      database: "shop_db",
      isExpanded: false,
      children: [],
    };

    store.connections = [mysqlConfig];
    store.connectedIds.add(mysqlConfig.id);
    store.treeNodes = [{ id: mysqlConfig.id, label: mysqlConfig.name, type: "connection", connectionId: mysqlConfig.id, isExpanded: true, children: [dbNode] }];

    await store.refreshObjectListTreeNode("mysql-1", "shop_db");

    expect(dbNode.isExpanded).toBe(false);
    expect(dbNode.children?.map((child) => child.type)).toContain("group-tables");
  });
});
