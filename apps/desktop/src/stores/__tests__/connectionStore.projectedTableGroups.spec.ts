import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { overlayProjectedTableGroupChildren } from "@/lib/sidebar/sidebarSearchTree";
import type { ConnectionConfig, TreeNode } from "@/types/database";

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

async function setupStore() {
  const getColumns = vi.fn().mockResolvedValue([{ name: "id", data_type: "INT", is_nullable: false, column_default: null, is_primary_key: true, extra: null, comment: null }]);
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    getColumns,
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  }));

  const { useConnectionStore } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  const connection = mysqlConnection();
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
          children: [],
        },
      ],
    },
  ];
  return { store, connection, getColumns };
}

const TABLE_ID = "mysql-1:app:orders";

async function loadProjectedTableGroups(store: Awaited<ReturnType<typeof setupStore>>["store"]) {
  await store.loadTableGroups("mysql-1", "app", "orders", undefined, TABLE_ID, undefined, "table");
}

beforeEach(() => {
  installLocalStorage();
  vi.resetModules();
  setActivePinia(createPinia());
});

describe("projected table group children (#14748)", () => {
  it("caches table groups for a search-projected row without touching the live tree", async () => {
    const { store } = await setupStore();
    await loadProjectedTableGroups(store);

    const cached = store.projectedTableGroupChildren.get(TABLE_ID);
    expect(cached?.map((child) => child.type)).toEqual(["group-columns", "group-indexes", "group-fkeys", "group-triggers"]);
    expect(cached?.[0]?.id).toBe(`${TABLE_ID}:__columns`);
    // The projection must never leak into the live tree.
    expect(store.treeNodes[0].children?.[0].children).toEqual([]);
  });

  it("reuses the cached groups on re-expansion and un-collapses", async () => {
    const { store } = await setupStore();
    await loadProjectedTableGroups(store);
    const first = store.projectedTableGroupChildren.get(TABLE_ID);

    await loadProjectedTableGroups(store);
    expect(store.projectedTableGroupChildren.get(TABLE_ID)).toBe(first);

    store.setProjectedTableGroupExpanded(TABLE_ID, false);
    expect(store.projectedTableGroupCollapsedIds.has(TABLE_ID)).toBe(true);
    await loadProjectedTableGroups(store);
    expect(store.projectedTableGroupCollapsedIds.has(TABLE_ID)).toBe(false);
  });

  it("loads columns into the projected columns group", async () => {
    const { store, getColumns } = await setupStore();
    await loadProjectedTableGroups(store);

    const columnsGroupId = `${TABLE_ID}:__columns`;
    await store.loadColumns("mysql-1", "app", "orders", undefined, columnsGroupId);

    const group = store.projectedTableGroupChildren.get(TABLE_ID)?.find((child) => child.id === columnsGroupId);
    expect(group?.children?.map((child) => child.id)).toEqual([`${columnsGroupId}:id`]);
    expect(group?.children?.[0].label).toBe("id (INT)");
    expect(getColumns).toHaveBeenCalledTimes(1);
  });

  it("ignores collapse requests for tables that exist in the live tree", async () => {
    const { store } = await setupStore();
    await loadProjectedTableGroups(store);
    (store.treeNodes[0].children![0].children as TreeNode[]).push({ id: TABLE_ID, label: "orders", type: "table", connectionId: "mysql-1", database: "app", isExpanded: false, children: [] });

    store.setProjectedTableGroupExpanded(TABLE_ID, false);
    expect(store.projectedTableGroupCollapsedIds.has(TABLE_ID)).toBe(false);
  });

  it("clears projected groups per connection", async () => {
    const { store } = await setupStore();
    await loadProjectedTableGroups(store);
    store.projectedTableGroupChildren.set("pg-1:app:users", []);

    store.clearProjectedTableGroupChildrenForConnection("mysql-1");
    expect(store.projectedTableGroupChildren.has(TABLE_ID)).toBe(false);
    expect(store.projectedTableGroupCollapsedIds.has(TABLE_ID)).toBe(false);
    expect(store.projectedTableGroupChildren.has("pg-1:app:users")).toBe(true);
  });
});

describe("overlayProjectedTableGroupChildren", () => {
  const groups: TreeNode[] = [{ id: "t:__columns", label: "tree.columns", type: "group-columns", isExpanded: false, children: [] }];

  it("attaches cached groups to childless rows and leaves loaded rows untouched", () => {
    const nodes: TreeNode[] = [
      { id: "t", label: "t", type: "table", isExpanded: false, children: [] },
      { id: "live", label: "live", type: "table", isExpanded: true, children: [{ id: "live:__columns", label: "tree.columns", type: "group-columns", isExpanded: true, children: [] }] },
    ];
    const out = overlayProjectedTableGroupChildren(nodes, new Map([["t", groups]]), new Set());
    expect(out[0].children).toBe(groups);
    expect(out[0].isExpanded).toBe(true);
    expect(out[1]).toBe(nodes[1]);
  });

  it("keeps collapsed projected rows collapsed with children attached", () => {
    const out = overlayProjectedTableGroupChildren([{ id: "t", label: "t", type: "table", isExpanded: false, children: [] }], new Map([["t", groups]]), new Set(["t"]));
    expect(out[0].isExpanded).toBe(false);
    expect(out[0].children).toBe(groups);
  });

  it("returns the same array when nothing is cached", () => {
    const nodes: TreeNode[] = [{ id: "t", label: "t", type: "table", isExpanded: false, children: [] }];
    expect(overlayProjectedTableGroupChildren(nodes, new Map(), new Set())).toBe(nodes);
  });
});
