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

function connection(dbType: ConnectionConfig["db_type"]): ConnectionConfig {
  return {
    id: `${dbType}-1`,
    name: dbType,
    db_type: dbType,
    host: "127.0.0.1",
    port: 5138,
    username: "SYSDBA",
    password: "",
    database: "SHOP_DEMO",
  } as ConnectionConfig;
}

function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = node.children && findNode(node.children, id);
    if (child) return child;
  }
  return undefined;
}

async function setup(dbType: ConnectionConfig["db_type"], overrides: Record<string, unknown> = {}) {
  const api = {
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    listConstraints: vi.fn().mockResolvedValue([]),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    listInstalledAgentsLocal: vi.fn().mockResolvedValue([{ db_type: "xugu", installed: true, installed_version: "0.1.23" }]),
    listPartitions: vi.fn().mockResolvedValue([]),
    listSubpartitions: vi.fn().mockResolvedValue([]),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => api);

  const { useConnectionStore } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  const config = connection(dbType);
  const tableId = `${config.id}:SHOP_DEMO:SYSDBA:SHOP_ORDERS`;
  store.connections = [config];
  store.connectedIds.add(config.id);
  store.treeNodes = [
    {
      id: config.id,
      label: config.name,
      type: "connection",
      connectionId: config.id,
      isExpanded: true,
      children: [
        {
          id: tableId,
          label: "SHOP_ORDERS",
          type: "table",
          connectionId: config.id,
          database: "SHOP_DEMO",
          schema: "SYSDBA",
          tableName: "SHOP_ORDERS",
          isExpanded: false,
          children: [],
        },
      ],
    },
  ];

  await store.loadTableGroups(config.id, "SHOP_DEMO", "SHOP_ORDERS", "SYSDBA", tableId);
  return { api, config, store, tableId };
}

describe("connectionStore Xugu table child metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("adds Xugu-only constraint and partition groups without changing PostgreSQL groups", async () => {
    const xugu = await setup("xugu");
    const xuguChildren = findNode(xugu.store.treeNodes, xugu.tableId)?.children?.map((node) => node.type);
    expect(xuguChildren).toEqual(["group-columns", "group-constraints", "group-fkeys", "group-triggers", "group-indexes", "group-table-partitions", "group-table-subpartitions"]);

    vi.resetModules();
    setActivePinia(createPinia());
    const postgres = await setup("postgres");
    const postgresChildren = findNode(postgres.store.treeNodes, postgres.tableId)?.children?.map((node) => node.type);
    expect(postgresChildren).toEqual(["group-columns", "group-indexes", "group-fkeys", "group-triggers"]);
  });

  it("hides Xugu-only groups when the installed Agent predates their metadata methods", async () => {
    const { store, tableId } = await setup("xugu", {
      listInstalledAgentsLocal: vi.fn().mockResolvedValue([{ db_type: "xugu", installed: true, installed_version: "0.1.22" }]),
    });

    const childTypes = findNode(store.treeNodes, tableId)?.children?.map((node) => node.type);
    expect(childTypes).toEqual(["group-columns", "group-fkeys", "group-triggers", "group-indexes"]);
  });

  it("routes Xugu child groups to their dedicated metadata calls, including empty results", async () => {
    const listConstraints = vi.fn().mockResolvedValue([
      {
        name: "PK_SHOP_ORDERS",
        constraint_type: "PRIMARY KEY",
        definition: '"ORDER_ID"',
        columns: ["ORDER_ID"],
        ref_columns: [],
        deferrable: false,
        initially_deferred: false,
        enabled: true,
        valid: true,
      },
    ]);
    const { api, config, store, tableId } = await setup("xugu", { listConstraints });

    const constraints = findNode(store.treeNodes, `${tableId}:__constraints`)!;
    const partitions = findNode(store.treeNodes, `${tableId}:__table-partitions`)!;
    const subpartitions = findNode(store.treeNodes, `${tableId}:__table-subpartitions`)!;

    await store.loadTreeNodeChildren(constraints);
    await store.loadTreeNodeChildren(partitions);
    await store.loadTreeNodeChildren(subpartitions);

    expect(listConstraints).toHaveBeenCalledWith(config.id, "SHOP_DEMO", "SYSDBA", "SHOP_ORDERS", undefined);
    expect(api.listPartitions).toHaveBeenCalledWith(config.id, "SHOP_DEMO", "SYSDBA", "SHOP_ORDERS", undefined);
    expect(api.listSubpartitions).toHaveBeenCalledWith(config.id, "SHOP_DEMO", "SYSDBA", "SHOP_ORDERS", undefined);
    expect(constraints.children?.[0]).toMatchObject({ type: "constraint", label: "PK_SHOP_ORDERS (PRIMARY KEY)" });
    expect(partitions.children).toEqual([]);
    expect(subpartitions.children).toEqual([]);
    expect(partitions.isExpanded).toBe(true);
    expect(subpartitions.isExpanded).toBe(true);
  });

  it("keeps a rejected Xugu metadata group collapsed and clears its loading state", async () => {
    const listPartitions = vi.fn().mockRejectedValue(new Error("metadata denied"));
    const { store, tableId } = await setup("xugu", { listPartitions });
    const partitions = findNode(store.treeNodes, `${tableId}:__table-partitions`)!;

    await expect(store.loadTreeNodeChildren(partitions)).rejects.toThrow("metadata denied");

    expect(partitions.isLoading).toBe(false);
    expect(partitions.isExpanded).toBe(false);
    expect(partitions.children).toEqual([]);
  });
});
