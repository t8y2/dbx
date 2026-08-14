import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { encodeSchemaTreeCache, encodeTableSearchIndexManifest, type TableSearchIndexManifestEntry } from "../../apps/desktop/src/lib/metadata/schemaTreeCache.ts";
import type { ConnectionConfig, TreeNode } from "../../apps/desktop/src/types/database.ts";

const MANIFEST_CACHE_KEY = "dbx:sidebar-table-search-index-manifest-v1";

const { loadSchemaCacheMock, saveSchemaCacheMock, deleteSchemaCachePrefixMock, saveConnectionsMock, listTablesMock, checkConnectionHealthMock, persistedCache } = vi.hoisted(() => {
  const persisted = new Map<string, unknown>();
  return {
    loadSchemaCacheMock: vi.fn(async (cacheKey: string) => persisted.get(cacheKey) ?? null),
    saveSchemaCacheMock: vi.fn(async (cacheKey: string, payload: unknown) => {
      persisted.set(cacheKey, payload);
    }),
    deleteSchemaCachePrefixMock: vi.fn(async (prefix: string) => {
      for (const cacheKey of persisted.keys()) {
        if (cacheKey === prefix || cacheKey.startsWith(prefix)) persisted.delete(cacheKey);
      }
    }),
    saveConnectionsMock: vi.fn(async () => undefined),
    listTablesMock: vi.fn(),
    checkConnectionHealthMock: vi.fn(async () => undefined),
    persistedCache: persisted,
  };
});

vi.mock("../../apps/desktop/src/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../apps/desktop/src/lib/backend/api")>();
  return {
    ...actual,
    loadSchemaCache: loadSchemaCacheMock,
    saveSchemaCache: saveSchemaCacheMock,
    deleteSchemaCachePrefix: deleteSchemaCachePrefixMock,
    saveConnections: saveConnectionsMock,
    listTables: listTablesMock,
    checkConnectionHealth: checkConnectionHealthMock,
  };
});

import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";

beforeEach(() => {
  loadSchemaCacheMock.mockReset();
  saveSchemaCacheMock.mockReset();
  deleteSchemaCachePrefixMock.mockReset();
  saveConnectionsMock.mockReset();
  listTablesMock.mockReset();
  checkConnectionHealthMock.mockReset();
  persistedCache.clear();
  loadSchemaCacheMock.mockImplementation(async (cacheKey: string) => persistedCache.get(cacheKey) ?? null);
  saveSchemaCacheMock.mockImplementation(async (cacheKey: string, payload: unknown) => {
    persistedCache.set(cacheKey, payload);
  });
  deleteSchemaCachePrefixMock.mockImplementation(async (prefix: string) => {
    for (const cacheKey of persistedCache.keys()) {
      if (cacheKey === prefix || cacheKey.startsWith(prefix)) persistedCache.delete(cacheKey);
    }
  });
  saveConnectionsMock.mockResolvedValue(undefined);
});

function installMemoryStorage() {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function conn(id: string): ConnectionConfig {
  return {
    id,
    name: id,
    db_type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "",
  };
}

function connectionNodeWithDatabases(...databases: string[]): TreeNode {
  return {
    id: "conn-1",
    label: "conn-1",
    type: "connection",
    connectionId: "conn-1",
    isExpanded: true,
    children: databases.map((database) => ({ id: "conn-1:" + database, label: database, type: "database", connectionId: "conn-1", database })),
  };
}

function indexEnvelope(entries: Array<{ name: string; tableType: string }>, cachedAt = Date.now()) {
  return encodeSchemaTreeCache<TreeNode[]>([], cachedAt, {
    complete: true,
    indexedAt: new Date(cachedAt).toISOString(),
    entries,
  });
}

function manifestScope(cacheKey: string, parentNodeId: string, overrides: Partial<TableSearchIndexManifestEntry> = {}): TableSearchIndexManifestEntry {
  return {
    cacheKey,
    parentNodeId,
    connectionId: "conn-1",
    database: "app",
    nodeType: "group-tables",
    ...overrides,
  };
}

test("loadSidebarTableSearchIndexScopes reads only the local schema cache", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    const cacheKey = "conn-1:app:__tables:index";
    persistedCache.set(MANIFEST_CACHE_KEY, encodeTableSearchIndexManifest([manifestScope(cacheKey, "conn-1:app:__tables")]));
    persistedCache.set(cacheKey, indexEnvelope([{ name: "orders", tableType: "TABLE" }]));

    const scopes = await store.loadSidebarTableSearchIndexScopes();

    assert.equal(scopes.length, 1);
    assert.deepEqual(
      scopes[0]?.entries.map((entry) => [entry.name, entry.table_type]),
      [["orders", "TABLE"]],
    );
    assert.equal(listTablesMock.mock.calls.length, 0);
    assert.equal(checkConnectionHealthMock.mock.calls.length, 0);
    assert.deepEqual([...new Set(loadSchemaCacheMock.mock.calls.map(([key]) => key))].sort(), [MANIFEST_CACHE_KEY, cacheKey].sort());
  } finally {
    restoreStorage();
  }
});

test("a stale but complete local index is still readable", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    const cacheKey = "conn-1:app:__tables:index";
    persistedCache.set(MANIFEST_CACHE_KEY, encodeTableSearchIndexManifest([manifestScope(cacheKey, "conn-1:app:__tables")]));
    persistedCache.set(cacheKey, indexEnvelope([{ name: "orders", tableType: "TABLE" }], Date.now() - 60 * 60 * 1000));

    const scopes = await store.loadSidebarTableSearchIndexScopes();

    assert.deepEqual(
      scopes[0]?.entries.map((entry) => entry.name),
      ["orders"],
    );
    assert.equal(listTablesMock.mock.calls.length, 0);
  } finally {
    restoreStorage();
  }
});

test("concurrent reads of the same index cache key hit the storage once", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.treeNodes.push(connectionNodeWithDatabases("app"));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loadSchemaCacheMock.mockImplementation(async (cacheKey: string) => {
      if (cacheKey === MANIFEST_CACHE_KEY) return null;
      await gate;
      return indexEnvelope([{ name: "orders", tableType: "TABLE" }]);
    });

    const pending = Promise.all([store.loadSidebarTableSearchIndex("conn-1:app"), store.loadSidebarTableSearchIndex("conn-1:app")]);
    await vi.waitFor(() => {
      assert.equal(loadSchemaCacheMock.mock.calls.filter(([key]) => key !== MANIFEST_CACHE_KEY).length, 1);
    });
    release();
    const [first, second] = await pending;

    assert.deepEqual(
      first?.map((entry) => entry.name),
      ["orders"],
    );
    assert.deepEqual(
      second?.map((entry) => entry.name),
      ["orders"],
    );
    assert.equal(loadSchemaCacheMock.mock.calls.filter(([key]) => key !== MANIFEST_CACHE_KEY).length, 1);
    assert.equal(listTablesMock.mock.calls.length, 0);
    assert.equal(checkConnectionHealthMock.mock.calls.length, 0);
  } finally {
    restoreStorage();
  }
});

test("resolves the index parent by composite identity when ids collide", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.treeNodes.push({
      id: "conn-1",
      label: "conn-1",
      type: "connection",
      connectionId: "conn-1",
      isExpanded: true,
      children: [
        { id: "conn-1:a:b", label: "a:b", type: "database", connectionId: "conn-1", database: "a:b", children: [] },
        {
          id: "conn-1:a",
          label: "a",
          type: "database",
          connectionId: "conn-1",
          database: "a",
          children: [{ id: "conn-1:a:b", label: "b", type: "schema", connectionId: "conn-1", database: "a", schema: "b", children: [] }],
        },
      ],
    });
    loadSchemaCacheMock.mockImplementation(async (cacheKey: string) => {
      if (cacheKey === MANIFEST_CACHE_KEY) return null;
      return indexEnvelope([{ name: "only_schema_table", tableType: "TABLE" }]);
    });

    const entries = await store.loadSidebarTableSearchIndex("conn-1:a:b", { connectionId: "conn-1", database: "a", schema: "b", nodeType: "schema" });

    assert.deepEqual(
      entries?.map((entry) => entry.name),
      ["only_schema_table"],
    );
    // The registered manifest path must point into the database a -> schema b
    // branch, not at the same-id database "a:b" node.
    const scopes = await store.loadSidebarTableSearchIndexScopes();
    assert.equal(scopes.length, 1);
    assert.deepEqual(
      scopes[0]?.scope.path?.map((node) => node.id),
      ["conn-1", "conn-1:a", "conn-1:a:b"],
    );
    assert.deepEqual(
      scopes[0]?.scope.path?.map((node) => node.type),
      ["connection", "database", "schema"],
    );
  } finally {
    restoreStorage();
  }
});

test("a composite identity with no matching node reads nothing", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.treeNodes.push({
      id: "conn-1",
      label: "conn-1",
      type: "connection",
      connectionId: "conn-1",
      isExpanded: true,
      children: [{ id: "conn-1:a:b", label: "a:b", type: "database", connectionId: "conn-1", database: "a:b", children: [] }],
    });

    const entries = await store.loadSidebarTableSearchIndex("conn-1:a:b", { connectionId: "conn-1", database: "a", schema: "b", nodeType: "schema" });

    assert.equal(entries, null);
    assert.equal(loadSchemaCacheMock.mock.calls.length, 0);
    assert.equal(listTablesMock.mock.calls.length, 0);
  } finally {
    restoreStorage();
  }
});

test("catalog-scoped indexes remain distinct when database names match", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    const hiveDatabase: TreeNode = { id: "conn-1:doris-catalog:hive:sales", label: "sales", type: "database", connectionId: "conn-1", catalog: "hive", database: "sales", children: [] };
    const icebergDatabase: TreeNode = { id: "conn-1:doris-catalog:iceberg:sales", label: "sales", type: "database", connectionId: "conn-1", catalog: "iceberg", database: "sales", children: [] };
    store.treeNodes.push({
      id: "conn-1",
      label: "conn-1",
      type: "connection",
      connectionId: "conn-1",
      children: [
        { id: "conn-1:doris-catalog:hive", label: "hive", type: "doris-catalog", connectionId: "conn-1", catalog: "hive", children: [hiveDatabase] },
        { id: "conn-1:doris-catalog:iceberg", label: "iceberg", type: "doris-catalog", connectionId: "conn-1", catalog: "iceberg", children: [icebergDatabase] },
      ],
    });
    let indexReadCount = 0;
    loadSchemaCacheMock.mockImplementation(async (cacheKey: string) => {
      if (cacheKey === MANIFEST_CACHE_KEY) return null;
      indexReadCount += 1;
      return indexEnvelope([{ name: indexReadCount === 1 ? "hive_orders" : "iceberg_orders", tableType: "TABLE" }]);
    });

    const hiveEntries = await store.loadSidebarTableSearchIndex(hiveDatabase.id, { connectionId: "conn-1", database: "sales", catalog: "hive", nodeType: "database" });
    const icebergEntries = await store.loadSidebarTableSearchIndex(icebergDatabase.id, { connectionId: "conn-1", database: "sales", catalog: "iceberg", nodeType: "database" });
    const scopes = await store.loadSidebarTableSearchIndexScopes();

    assert.deepEqual(
      hiveEntries?.map((entry) => entry.name),
      ["hive_orders"],
    );
    assert.deepEqual(
      icebergEntries?.map((entry) => entry.name),
      ["iceberg_orders"],
    );
    assert.equal(indexReadCount, 2);
    assert.deepEqual(scopes.map(({ scope }) => scope.catalog).sort(), ["hive", "iceberg"]);
    assert.equal(new Set(scopes.map(({ scope }) => scope.cacheKey)).size, 2);
  } finally {
    restoreStorage();
  }
});

test("registering a catalog-scoped index replaces its legacy manifest entry", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    const database: TreeNode = { id: "conn-1:doris-catalog:hive:sales", label: "sales", type: "database", connectionId: "conn-1", catalog: "hive", database: "sales", children: [] };
    store.treeNodes.push({
      id: "conn-1",
      label: "conn-1",
      type: "connection",
      connectionId: "conn-1",
      children: [{ id: "conn-1:doris-catalog:hive", label: "hive", type: "doris-catalog", connectionId: "conn-1", catalog: "hive", children: [database] }],
    });
    const legacyCacheKey = "conn-1:sales:objects-grouped-v8:table-search-index-v1";
    persistedCache.set(
      MANIFEST_CACHE_KEY,
      encodeTableSearchIndexManifest([
        manifestScope(legacyCacheKey, database.id, {
          database: "sales",
          catalog: "hive",
          nodeType: "database",
        }),
      ]),
    );
    persistedCache.set(legacyCacheKey, indexEnvelope([{ name: "stale_orders", tableType: "TABLE" }]));
    loadSchemaCacheMock.mockImplementation(async (cacheKey: string) => {
      if (cacheKey === MANIFEST_CACHE_KEY || cacheKey === legacyCacheKey) return persistedCache.get(cacheKey) ?? null;
      return indexEnvelope([{ name: "fresh_orders", tableType: "TABLE" }]);
    });

    const entries = await store.loadSidebarTableSearchIndex(database.id, { connectionId: "conn-1", database: "sales", catalog: "hive", nodeType: "database" });
    const scopes = await store.loadSidebarTableSearchIndexScopes();

    assert.deepEqual(
      entries?.map((entry) => entry.name),
      ["fresh_orders"],
    );
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0]?.scope.catalog, "hive");
    assert.notEqual(scopes[0]?.scope.cacheKey, legacyCacheKey);
    assert.deepEqual(
      scopes[0]?.entries.map((entry) => entry.name),
      ["fresh_orders"],
    );
  } finally {
    restoreStorage();
  }
});

test("concurrent scope registrations keep every manifest entry", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.treeNodes.push(connectionNodeWithDatabases("db1", "db2"));
    loadSchemaCacheMock.mockImplementation(async (cacheKey: string) => {
      if (cacheKey === MANIFEST_CACHE_KEY) return null;
      return indexEnvelope([{ name: "orders", tableType: "TABLE" }]);
    });

    await Promise.all([store.loadSidebarTableSearchIndex("conn-1:db1"), store.loadSidebarTableSearchIndex("conn-1:db2")]);
    const scopes = await store.loadSidebarTableSearchIndexScopes();

    assert.deepEqual(scopes.map(({ scope }) => scope.parentNodeId).sort(), ["conn-1:db1", "conn-1:db2"]);
    const manifestSaves = saveSchemaCacheMock.mock.calls.filter(([key]) => key === MANIFEST_CACHE_KEY);
    const lastPayload = manifestSaves.at(-1)?.[1] as { scopes: Array<{ parentNodeId: string }> };
    assert.equal(lastPayload?.scopes.length, 2);
    assert.equal(listTablesMock.mock.calls.length, 0);
  } finally {
    restoreStorage();
  }
});

test("an index without a complete table index never registers a manifest scope", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.treeNodes.push(connectionNodeWithDatabases("app"));
    loadSchemaCacheMock.mockImplementation(async (cacheKey: string) => {
      if (cacheKey === MANIFEST_CACHE_KEY) return null;
      return encodeSchemaTreeCache<TreeNode[]>([], Date.now());
    });

    const entries = await store.loadSidebarTableSearchIndex("conn-1:app");

    assert.equal(entries, null);
    assert.equal(saveSchemaCacheMock.mock.calls.filter(([key]) => key === MANIFEST_CACHE_KEY).length, 0);
    assert.equal(listTablesMock.mock.calls.length, 0);
    assert.equal(checkConnectionHealthMock.mock.calls.length, 0);
  } finally {
    restoreStorage();
  }
});

test("refreshSidebarTableSearchIndex is the only path that paginates listTables", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.treeNodes.push(connectionNodeWithDatabases("app"));
    const all = Array.from({ length: 501 }, (_, index) => ({ name: "t" + index, table_type: "TABLE" }));
    listTablesMock.mockImplementation(async (_connectionId: string, _database: string, _schema: string, _filter: unknown, limit: number, offset: number) => all.slice(offset, offset + limit));

    const entries = await store.refreshSidebarTableSearchIndex("conn-1:app");

    assert.equal(entries.length, 501);
    const calls = listTablesMock.mock.calls as Array<[string, string, string, unknown, number, number]>;
    const pageSize = calls[0]?.[4];
    assert.ok(typeof pageSize === "number" && pageSize > 0);
    assert.deepEqual(
      calls.map((call) => call[5]),
      Array.from({ length: calls.length }, (_, index) => index * pageSize),
    );
    assert.equal(calls.length, Math.ceil(501 / pageSize));
    assert.equal(checkConnectionHealthMock.mock.calls.length, 0);

    const scopes = await store.loadSidebarTableSearchIndexScopes();
    assert.equal(scopes.length, 1);
    assert.equal(scopes[0]?.entries.length, 501);
  } finally {
    restoreStorage();
  }
});

test("updating a connection invalidates its in-memory index and manifest scopes", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    store.addEphemeralConnection(conn("conn-1"));
    store.treeNodes.push(connectionNodeWithDatabases("app"));
    let indexName = "old_orders";
    loadSchemaCacheMock.mockImplementation(async (cacheKey: string) => {
      if (cacheKey === MANIFEST_CACHE_KEY) return persistedCache.get(cacheKey) ?? null;
      return indexEnvelope([{ name: indexName, tableType: "TABLE" }]);
    });

    const initialEntries = await store.loadSidebarTableSearchIndex("conn-1:app");
    assert.deepEqual(
      initialEntries?.map((entry) => entry.name),
      ["old_orders"],
    );

    await store.updateConnection({ ...conn("conn-1"), host: "replacement.example.com" });

    assert.deepEqual(await store.loadSidebarTableSearchIndexScopes(), []);
    const manifestSavesAfterUpdate = saveSchemaCacheMock.mock.calls.filter(([key]) => key === MANIFEST_CACHE_KEY);
    const clearedManifest = manifestSavesAfterUpdate.at(-1)?.[1] as { scopes: unknown[] };
    assert.deepEqual(clearedManifest?.scopes, []);
    store.treeNodes = [connectionNodeWithDatabases("app")];
    indexName = "new_orders";
    const refreshedEntries = await store.loadSidebarTableSearchIndex("conn-1:app");
    assert.deepEqual(
      refreshedEntries?.map((entry) => entry.name),
      ["new_orders"],
    );
    const manifestSaves = saveSchemaCacheMock.mock.calls.filter(([key]) => key === MANIFEST_CACHE_KEY);
    const lastPayload = manifestSaves.at(-1)?.[1] as { scopes: unknown[] };
    assert.equal(lastPayload?.scopes.length, 1);
    assert.equal(listTablesMock.mock.calls.length, 0);
    assert.equal(checkConnectionHealthMock.mock.calls.length, 0);
  } finally {
    restoreStorage();
  }
});
