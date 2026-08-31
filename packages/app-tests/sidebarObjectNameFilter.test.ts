import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { ConnectionConfig, TreeNode } from "../../apps/desktop/src/types/database.ts";

function installMemoryStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
}

function connection(): ConnectionConfig {
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

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  installMemoryStorage();
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("object-group filters keep table, view, procedure, and function scopes isolated", async () => {
  const listTables = vi.fn(async (...args: unknown[]) => {
    const objectTypes = args[6] as string[] | undefined;
    if (objectTypes?.[0] === "TABLE") return [{ name: "tbl_orders", table_type: "BASE TABLE", comment: null }];
    if (objectTypes?.[0] === "VIEW") return [{ name: "vw_orders", table_type: "VIEW", comment: null }];
    return [];
  });
  const listObjects = vi.fn(async (...args: unknown[]) => {
    const objectTypes = args[3] as string[] | undefined;
    const filter = args[8] as { includePatterns: string[]; excludePatterns: string[] } | undefined;
    if (objectTypes?.[0] === "PROCEDURE" && filter?.includePatterns.includes("proc_%")) return [{ name: "proc_sync_orders", object_type: "PROCEDURE" }];
    if (objectTypes?.[0] === "FUNCTION" && filter?.includePatterns.includes("fn_%")) return [{ name: "fn_get_user", object_type: "FUNCTION" }];
    if (objectTypes?.[0] === "FUNCTION" && !filter)
      return [
        { name: "fn_get_user", object_type: "FUNCTION" },
        { name: "internal_hash", object_type: "FUNCTION" },
      ];
    return [];
  });

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

  const { useConnectionStore } = await import("../../apps/desktop/src/stores/connectionStore.ts");
  const store = useConnectionStore();
  const currentConnection = connection();
  const group = (type: TreeNode["type"]): TreeNode => ({
    id: `pg-1:app:public:__${type.slice("group-".length)}`,
    label: type,
    type,
    connectionId: currentConnection.id,
    database: "app",
    schema: "public",
    isExpanded: false,
    children: [],
  });
  const groups = [group("group-tables"), group("group-views"), group("group-procedures"), group("group-functions")];
  const schemaNode: TreeNode = {
    id: "pg-1:app:public",
    label: "public",
    type: "schema",
    connectionId: currentConnection.id,
    database: "app",
    schema: "public",
    isExpanded: true,
    children: groups,
  };
  store.connections = [currentConnection];
  store.connectedIds.add(currentConnection.id);
  store.treeNodes = [
    {
      id: currentConnection.id,
      label: currentConnection.name,
      type: "connection",
      connectionId: currentConnection.id,
      isExpanded: true,
      children: [{ id: "pg-1:app", label: "app", type: "database", connectionId: currentConnection.id, database: "app", isExpanded: true, children: [schemaNode] }],
    },
  ];

  const liveGroup = (type: TreeNode["type"]): TreeNode => {
    const node = store.treeNodes[0]?.children?.[0]?.children?.[0]?.children?.find((child: TreeNode) => child.type === type);
    if (!node) throw new Error(`Missing object group: ${type}`);
    return node;
  };
  const filters = [
    ["group-tables", { includePatterns: ["tbl_%"], excludePatterns: [] }],
    ["group-views", { includePatterns: ["vw_%"], excludePatterns: [] }],
    ["group-procedures", { includePatterns: ["proc_%"], excludePatterns: [] }],
    ["group-functions", { includePatterns: ["fn_%"], excludePatterns: ["%_bak"] }],
  ] as const;
  for (const [type, filter] of filters) {
    const node = liveGroup(type);
    const scopeKey = store.tableNameFilterScopeKey({ connectionId: currentConnection.id, database: "app", schema: "public", nodeKind: node.type });
    const revision = store.setSidebarTableNameFilter(scopeKey, filter);
    await store.refreshTreeNodeForTableNameFilter(node, scopeKey, revision);
  }

  const liveGroups = filters.map(([type]) => liveGroup(type));
  expect(new Set(liveGroups.map((node) => store.tableNameFilterScopeKey({ connectionId: currentConnection.id, database: "app", schema: "public", nodeKind: node.type }))).size).toBe(4);
  expect(liveGroups.map((node) => node.children?.map((child) => child.label))).toEqual([["tbl_orders"], ["vw_orders"], ["proc_sync_orders"], ["fn_get_user"]]);
  expect(store.tableNameFilterForScope({ connectionId: currentConnection.id, database: "app", schema: "public", nodeKind: "group-functions" })).toEqual({
    includePatterns: ["fn_%"],
    excludePatterns: ["%_bak"],
  });

  const functionGroup = liveGroup("group-functions");
  const functionScopeKey = store.tableNameFilterScopeKey({ connectionId: currentConnection.id, database: "app", schema: "public", nodeKind: functionGroup.type });
  const clearRevision = store.setSidebarTableNameFilter(functionScopeKey, { includePatterns: [], excludePatterns: [] });
  await store.refreshTreeNodeForTableNameFilter(functionGroup, functionScopeKey, clearRevision);

  expect(liveGroup("group-functions").children?.map((child) => child.label)).toEqual(["fn_get_user", "internal_hash"]);
  expect(listObjects.mock.calls.at(-1)).toEqual([currentConnection.id, "app", "public", ["FUNCTION"], undefined, 1001, 0]);
}, 15000);
