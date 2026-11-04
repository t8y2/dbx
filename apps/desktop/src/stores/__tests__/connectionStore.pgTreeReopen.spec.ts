import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TableInfo, TreeNode } from "@/types/database";
import { SCHEMA_TREE_CACHE_TTL_MS } from "@/lib/metadata/schemaTreeCache";

async function setup(mode: "grouped" | "simple", config: Partial<ConnectionConfig> = {}) {
  const cache = new Map<string, any>();
  const roots: TableInfo[] = Array.from({ length: 73 }, (_, i) => ({ name: `root_${String(i).padStart(3, "0")}`, schema: "public", table_type: "TABLE" }));
  const rows = roots.flatMap((root) => [root, ...Array.from({ length: 7 }, (_, i) => ({ name: `${root.name}_p${i}`, schema: "public", table_type: "TABLE", parent_name: root.name }))]);
  const listTables = vi.fn(async (_id: string, _db: string, _schema: string, _filter: string, limit: number, offset = 0, ...rest: unknown[]) => {
    expect(rest[4]).toBe(true);
    const selected = new Set(roots.slice(offset, offset + limit).map((root) => root.name));
    return rows.filter((row) => selected.has(row.parent_name || row.name));
  });
  const loadSchemaCache = vi.fn(async (key: string) => JSON.parse(JSON.stringify(cache.get(key) ?? null)));
  const saveSchemaCache = vi.fn(async (key: string, value: unknown) => {
    cache.set(key, JSON.parse(JSON.stringify(value)));
  });
  const connectDb = vi.fn().mockResolvedValue("pg");
  const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth,
    connectDb,
    connectionIdentifierQuote: vi.fn().mockResolvedValue('"'),
    listDatabases: vi.fn().mockResolvedValue([]),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    listObjects: vi.fn().mockResolvedValue([]),
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
  settings.editorSettings.sidebarObjectDisplay = mode;
  settings.desktopSettings.sidebar_table_page_size = 70;
  store.connections = [{ id: "pg", name: "PG", db_type: "postgres", host: "localhost", port: 5432, username: "postgres", database: "app", ...config } as ConnectionConfig];
  store.connectedIds.add("pg");
  store.treeNodes = [
    {
      id: "pg",
      label: "PG",
      type: "connection",
      connectionId: "pg",
      children: [
        { id: "pg:app:public", label: "public", type: "schema", connectionId: "pg", database: "app", schema: "public", children: mode === "simple" ? [] : [{ id: "pg:app:public:__tables", label: "Tables", type: "group-tables", connectionId: "pg", database: "app", schema: "public", children: [] }] },
      ],
    },
  ];
  const parent = mode === "simple" ? store.treeNodes[0].children![0] : store.treeNodes[0].children![0].children![0];
  const open = (force = false) => (mode === "simple" ? store.loadTables("pg", "app", "public", { force }) : store.loadObjectGroupChildren(parent, { force }));
  const release = () => {
    parent.isExpanded = false;
    expect(store.releaseCollapsedTreeNodeChildren(parent.id)).toBe(true);
    expect(parent.children).toEqual([]);
    expect(store.isTreeNodeChildrenLoaded(parent.id)).toBe(false);
  };
  const tables = () => parent.children!.filter((node) => node.type === "table");
  const more = () => parent.children!.find((node) => node.type === "load-more")!;
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  return { store, parent, open, release, tables, more, settle, cache, rows, roots, listTables, loadSchemaCache, saveSchemaCache, connectDb, checkConnectionHealth };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubGlobal("localStorage", { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn(), removeItem: vi.fn() });
  setActivePinia(createPinia());
});

const nativeConfigs: Partial<ConnectionConfig>[] = [
  { db_type: "postgres" },
  { db_type: "postgres", driver_profile: "postgres" },
  { db_type: "postgres", driver_profile: "cloudberry" },
  { db_type: "postgres", driver_profile: "cockroachdb" },
  { db_type: "redshift" },
  { db_type: "gaussdb", driver_profile: "gaussdb" },
  { db_type: "kwdb" },
  { db_type: "opengauss" },
];

describe.each(nativeConfigs.flatMap((config) => (["grouped", "simple"] as const).map((mode) => ({ mode, config }))))("$mode released root window: $config", ({ mode, config }) => {
  it.each(["disconnected", "dead-pool"])("loads the initial page after %s connection recovery", async (reason) => {
    const f = await setup(mode, config);
    if (reason === "disconnected") f.store.connectedIds.delete("pg");
    else f.checkConnectionHealth.mockRejectedValueOnce(new Error("pool dead"));
    await f.open();
    await f.settle();
    expect(f.connectDb).toHaveBeenCalledTimes(1);
    expect(f.tables()).toHaveLength(70);
    expect(f.parent.isExpanded).toBe(true);
  });
  it("preserves all 73 roots and complete partitions over three release/reopen cycles", async () => {
    const f = await setup(mode, config);
    await f.open();
    await f.settle();
    expect(f.tables()).toHaveLength(70);
    await f.store.loadMoreObjectGroupChildren(f.more());
    await f.settle();
    expect(f.tables()).toHaveLength(73);
    const identities = () => f.tables().map((root) => [root.id, root.children?.find((node) => node.type === "group-partitions")?.children?.map((node) => node.id)]);
    const expected = identities();
    expect(expected.every(([, partitions]) => Array.isArray(partitions) && partitions.length === 7)).toBe(true);
    for (let i = 0; i < 3; i++) {
      f.release();
      f.listTables.mockClear();
      await f.open();
      await f.settle();
      expect(f.tables()).toHaveLength(73);
      expect(identities()).toEqual(expected);
      expect(f.listTables).not.toHaveBeenCalled();
    }
  });
  it("keeps the partial cursor, then loads only the remaining roots", async () => {
    const f = await setup(mode, config);
    await f.open();
    await f.settle();
    const cursor = JSON.parse(JSON.stringify(f.more().loadMore));
    f.release();
    f.listTables.mockClear();
    await f.open();
    await f.settle();
    expect(f.tables()).toHaveLength(70);
    expect(f.more().loadMore).toEqual(cursor);
    expect(f.listTables).not.toHaveBeenCalled();
    await f.store.loadMoreObjectGroupChildren(f.more());
    expect(f.tables()).toHaveLength(73);
    expect(f.listTables.mock.calls.map((call) => call[5])).toEqual([70]);
  });

  it.each(["force", "stale", "invalid", "invalid-scope", "invalid-cursor", "legacy", "invalidate"])("reloads page zero for %s snapshots", async (reason) => {
    const f = await setup(mode, config);
    await f.open();
    await f.settle();
    await f.store.loadMoreObjectGroupChildren(f.more());
    f.release();
    // Iterate a snapshot: the legacy-key case deletes and reinserts entries.
    const snapshots = [...f.cache];
    for (const [key, payload] of snapshots) {
      if (reason === "stale") payload.cachedAt = new Date(Date.now() - SCHEMA_TREE_CACHE_TTL_MS - 1).toISOString();
      if (reason === "invalid") payload.children[0].children[0].objectCount++;
      if (reason === "invalid-scope") payload.children[0].schema = "other";
      if (reason === "invalid-cursor") payload.children.push({ id: "bad", type: "load-more", label: "More", connectionId: "pg", database: "app", schema: "public", loadMore: { parentId: f.parent.id, offset: -1, pageSize: 70 } });
      if (reason === "legacy") {
        f.cache.delete(key);
        f.cache.set(key.replace("-pg-roots-v1", ""), payload);
      }
    }
    if (reason === "invalidate") f.store.invalidateMetadataCache("pg", "app");
    f.listTables.mockClear();
    await f.open(reason === "force");
    await f.settle();
    expect(f.tables()).toHaveLength(70);
    expect(f.listTables.mock.calls.map((call) => call[5])).toEqual([0]);
  });

  it.each(["cancel", "disconnect", "refresh", "invalidate", "config", "filter", "search", "scoped-search"])("rejects delayed hydration after %s", async (action) => {
    const f = await setup(mode, config);
    await f.open();
    await f.settle();
    f.release();
    const payload = JSON.parse(JSON.stringify([...f.cache.values()][0]));
    let resolve!: (value: unknown) => void;
    f.loadSchemaCache.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.listTables.mockClear();
    const pending = f.open();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    if (action === "cancel") f.store.cancelTreeNodeLoad(f.parent.id);
    if (action === "disconnect") f.store.connectedIds.delete("pg");
    if (action === "refresh") await f.open(true);
    if (action === "invalidate") f.store.invalidateMetadataCache("pg", "app");
    if (action === "config") f.store.connections[0].host = "new-host";
    if (action === "filter") f.store.setSidebarTableNameFilter(f.store.tableNameFilterScopeKey({ ...f.parent, nodeKind: mode === "simple" ? "simple-tables" : "group-tables" }), { includePatterns: ["root_001%"], excludePatterns: [] });
    if (action === "search") f.store.sidebarSearchQuery = "needle";
    if (action === "scoped-search") f.store.setSidebarTableSearchQuery(f.parent.id, "needle");
    f.parent.isExpanded = false;
    const children = f.parent.children;
    resolve(payload);
    await pending;
    await f.settle();
    expect(f.parent.children).toBe(children);
    expect(f.parent.isExpanded).toBe(false);
    expect(f.listTables).toHaveBeenCalledTimes(action === "refresh" ? 1 : 0);
  });

  it("waits for a pending page save before restoring the released window", async () => {
    const f = await setup(mode, config);
    await f.open();
    await f.settle();
    let resolve!: () => void;
    const save = f.saveSchemaCache.getMockImplementation()!;
    f.saveSchemaCache.mockImplementationOnce(async (key, value) => {
      await new Promise<void>((done) => {
        resolve = done;
      });
      await save(key, value);
    });
    const more = f.store.loadMoreObjectGroupChildren(f.more());
    await vi.waitFor(() => expect(resolve).toBeDefined());
    f.release();
    f.listTables.mockClear();
    const reopen = f.open();
    resolve();
    await Promise.all([more, reopen]);
    await f.settle();
    expect(f.tables()).toHaveLength(73);
    expect(f.listTables).not.toHaveBeenCalled();
  });

  it.each(["cancel", "disconnect", "invalidate"])("does not publish after %s during a pending save", async (action) => {
    const f = await setup(mode, config);
    let resolve!: () => void;
    const save = f.saveSchemaCache.getMockImplementation()!;
    f.saveSchemaCache.mockImplementationOnce(async (key, value) => {
      await new Promise<void>((done) => {
        resolve = done;
      });
      await save(key, value);
    });
    const pending = f.open();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    if (action === "cancel") f.store.cancelTreeNodeLoad(f.parent.id);
    if (action === "disconnect") f.store.connectedIds.delete("pg");
    if (action === "invalidate") f.store.invalidateMetadataCache("pg", "app");
    f.parent.isExpanded = false;
    resolve();
    await pending;
    expect(f.parent.isExpanded).toBe(false);
    if (action !== "cancel") expect(f.cache.size).toBe(0);
  });

  it.each([0, 70])("rejects an invalidated in-flight page at offset %s and retries fresh", async (offset) => {
    const f = await setup(mode, config);
    if (offset) {
      await f.open();
      await f.settle();
    }
    const fetch = f.listTables.getMockImplementation()!;
    let resolve!: (value: TableInfo[]) => void;
    f.listTables.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = offset ? f.store.loadMoreObjectGroupChildren(f.more()) : f.open();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    f.store.invalidateMetadataCache("pg", "app");
    const before = f.parent.children;
    resolve(await fetch("pg", "app", "public", "", 71, offset, undefined, undefined, undefined, undefined, true));
    await pending;
    expect(f.parent.children).toBe(before);
    if (offset) await f.store.loadMoreObjectGroupChildren(f.more());
    else await f.open();
    expect(f.tables()).toHaveLength(offset ? 73 : 70);
    expect(f.listTables.mock.calls.map((call) => call[5])).toEqual(offset ? [0, 70, 70] : [0, 0]);
  });
  it("replaces expanded partition identities on explicit refresh", async () => {
    const f = await setup(mode, config);
    await f.open();
    await f.settle();
    f.tables()[0].isExpanded = true;
    for (const row of f.rows) if (row.parent_name) row.name += "_new";
    await f.open(true);
    await f.settle();
    const children = f.tables()[0].children!.find((node) => node.type === "group-partitions")!.children!;
    expect(children).toHaveLength(7);
    expect(children.every((node) => node.label.endsWith("_new"))).toBe(true);
  });

  it("serializes an obsolete save before the newer refresh snapshot", async () => {
    const f = await setup(mode, config);
    let resolve!: () => void;
    const save = f.saveSchemaCache.getMockImplementation()!;
    f.saveSchemaCache.mockImplementationOnce(async (key, value) => {
      await new Promise<void>((done) => {
        resolve = done;
      });
      await save(key, value);
    });
    const pending = f.open();
    await vi.waitFor(() => expect(resolve).toBeDefined());
    f.rows.splice(0, f.rows.length, f.roots[72]);
    f.roots.splice(0, f.roots.length, f.roots[72]);
    const refresh = f.open(true);
    await vi.waitFor(() => expect(f.tables()).toHaveLength(1));
    resolve();
    await Promise.all([pending, refresh]);
    await f.settle();
    expect([...f.cache.values()]).toHaveLength(1);
    expect([...f.cache.values()][0].children.map((node: TreeNode) => node.label)).toEqual(["root_072"]);
  });

  if (mode === "grouped")
    it("preserves explicit auto-all opt-in and reuses its complete window", async () => {
      const f = await setup(mode, config);
      f.store.connections[0].sidebar_auto_load_all_tables = true;
      await f.open();
      expect(f.tables()).toHaveLength(73);
      f.release();
      f.listTables.mockClear();
      await f.open();
      expect(f.tables()).toHaveLength(73);
      expect(f.listTables).not.toHaveBeenCalled();
    });
});

describe.each(["grouped", "simple"] as const)("%s external-driver cache", (mode) => {
  it.each([
    { db_type: "gaussdb", driver_profile: "gaussdb-m" },
    { db_type: "gaussdb", driver_profile: "GAUSSDB-M" },
    { db_type: "jdbc", driver_profile: "postgres" },
    { db_type: "postgres", connection_string: "jdbc:postgresql://localhost/app" },
  ] as Partial<ConnectionConfig>[])("retains generic cache behavior for %j", async (config) => {
    const f = await setup(mode, config);
    f.listTables.mockResolvedValue([]);
    await f.open();
    await f.settle();
    expect([...f.cache.keys()].every((key) => !key.includes("pg-roots"))).toBe(true);
    expect([...f.cache.keys()].length).toBeGreaterThan(0);
  });
});
