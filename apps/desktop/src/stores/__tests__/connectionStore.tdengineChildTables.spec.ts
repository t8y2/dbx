import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo, ConnectionConfig, TableInfo, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function tdengineConnection(): ConnectionConfig {
  return { id: "td-1", name: "TDengine", db_type: "tdengine", host: "127.0.0.1", port: 6041, username: "root", password: "", database: "app" } as ConnectionConfig;
}

const PAGE_SIZE = 3;

/** One super table with `childCount` children, one empty super table and one ordinary table. */
async function setupTdengineTree(childCount: number) {
  const children = Array.from({ length: childCount }, (_, index) => `meter_${String(index).padStart(3, "0")}`);
  const roots: TableInfo[] = [
    { name: "empty_st", table_type: "STABLE" },
    { name: "meters", table_type: "STABLE" },
    { name: "plain", table_type: "TABLE" },
  ];
  const listTables = vi.fn((_id: string, _db: string, _schema: string, _filter?: string, limit?: number, offset?: number) => Promise.resolve(roots.slice(offset ?? 0, (offset ?? 0) + (limit ?? roots.length))));
  const listTableChildren = vi.fn((_id: string, _db: string, _schema: string, parent: string, limit?: number, offset?: number) => {
    const names = parent === "meters" ? children : [];
    return Promise.resolve(names.slice(offset ?? 0, (offset ?? 0) + (limit ?? names.length)).map((name): TableInfo => ({ name, table_type: "TABLE", parent_name: parent })));
  });
  const getColumns = vi.fn().mockResolvedValue([{ name: "ts", data_type: "TIMESTAMP", is_nullable: false, column_default: null, is_primary_key: false, comment: null } as unknown as ColumnInfo]);
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    listTables,
    listTableChildren,
    getColumns,
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  const store = useConnectionStore();
  const settings = useSettingsStore();
  settings.editorSettings.sidebarObjectDisplay = "grouped";
  settings.desktopSettings.sidebar_table_page_size = PAGE_SIZE;
  const connection = tdengineConnection();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  store.treeNodes = [{ id: connection.id, label: "TDengine", type: "connection", connectionId: connection.id, children: [{ id: `${connection.id}:app:__tables`, label: "Tables", type: "group-tables", connectionId: connection.id, database: "app", children: [] }] }];
  const group = store.treeNodes[0].children![0];
  const stable = async (name: string) => {
    const node = group.children!.find((child) => child.label === name)!;
    expect(node, `${name} node`).toBeDefined();
    return node;
  };
  const childGroup = (node: TreeNode) => node.children!.find((child) => child.type === "group-partitions");
  return { store, group, stable, childGroup, listTables, listTableChildren, children };
}

describe("TDengine on-demand child tables", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("lists only root tables in the table group and asks the backend for roots", async () => {
    const { store, group, listTables, listTableChildren } = await setupTdengineTree(7);
    await store.loadObjectGroupChildren(group);
    expect(group.children!.map((child) => child.label)).toEqual(["empty_st", "meters", "plain"]);
    expect(group.children!.every((child) => child.type === "table")).toBe(true);
    // 11th argument is pageTableRoots.
    expect(listTables.mock.calls.every((call) => call[10] === true)).toBe(true);
    expect(listTableChildren).not.toHaveBeenCalled();
  });

  it("pages a super table's child tables in when it is expanded", async () => {
    const { store, group, stable, childGroup, listTableChildren, children } = await setupTdengineTree(7);
    await store.loadObjectGroupChildren(group);
    const meters = await stable("meters");

    await store.loadTreeNodeChildren(meters);

    expect(listTableChildren).toHaveBeenCalledTimes(1);
    // Requests one extra row to learn whether more pages exist.
    expect(listTableChildren.mock.calls[0].slice(0, 6)).toEqual(["td-1", "app", expect.any(String), "meters", PAGE_SIZE + 1, 0]);
    const tableChildren = childGroup(meters)!;
    expect(tableChildren.isExpanded).toBe(true);
    expect(tableChildren.children!.filter((child) => child.type === "table").map((child) => child.label)).toEqual(children.slice(0, PAGE_SIZE));
    const loadMore = tableChildren.children!.find((child) => child.type === "load-more")!;
    expect(loadMore.loadMore).toMatchObject({ parentId: tableChildren.id, offset: PAGE_SIZE, pageSize: PAGE_SIZE });
    expect(tableChildren.objectCount).toBeUndefined();
    // Child tables are sibling-compatible table nodes of the super table.
    expect(tableChildren.children![0]).toMatchObject({ type: "table", tableType: "TABLE", partitionParentName: "meters" });

    await store.loadMoreObjectGroupChildren(loadMore);
    await store.loadMoreObjectGroupChildren(tableChildren.children!.find((child) => child.type === "load-more")!);

    expect(tableChildren.children!.filter((child) => child.type === "table").map((child) => child.label)).toEqual(children);
    expect(tableChildren.children!.some((child) => child.type === "load-more")).toBe(false);
    expect(tableChildren.objectCount).toBe(children.length);
    expect(listTableChildren.mock.calls.map((call) => call[5])).toEqual([0, PAGE_SIZE, PAGE_SIZE * 2]);
  });

  it("does not list another super table's children and drops an empty child group", async () => {
    const { store, group, stable, childGroup, listTableChildren } = await setupTdengineTree(7);
    await store.loadObjectGroupChildren(group);
    const empty = await stable("empty_st");

    await store.loadTreeNodeChildren(empty);

    expect(listTableChildren.mock.calls[0][3]).toBe("empty_st");
    expect(childGroup(empty)).toBeUndefined();
    expect(empty.children!.map((child) => child.type)).toContain("group-columns");
  });

  it("does not add a child-table group to an ordinary table", async () => {
    const { store, group, stable, childGroup, listTableChildren } = await setupTdengineTree(7);
    await store.loadObjectGroupChildren(group);
    const plain = await stable("plain");

    await store.loadTreeNodeChildren(plain);

    expect(childGroup(plain)).toBeUndefined();
    expect(listTableChildren).not.toHaveBeenCalled();
  });
});
