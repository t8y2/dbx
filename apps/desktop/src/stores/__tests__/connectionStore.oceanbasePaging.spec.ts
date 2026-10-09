import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { filterSidebarTree } from "@/lib/sidebar/sidebarSearchTree";
import type { ConnectionConfig, ObjectInfo, TreeNode } from "@/types/database";

const connection = { id: "ob-11418-sidebar", name: "OceanBase Oracle", db_type: "oceanbase-oracle", username: "APP", database: "APP" } as ConnectionConfig;
const procedure = (name: string): ObjectInfo => ({ name, object_type: "PROCEDURE", schema: "APP", comment: "needle" });

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) });
  setActivePinia(createPinia());
});

async function setup(listObjects: ReturnType<typeof vi.fn>, listTables?: ReturnType<typeof vi.fn>) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    listObjects,
    listTables: listTables ?? vi.fn().mockResolvedValue([]),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  const store = useConnectionStore();
  useSettingsStore().editorSettings.sidebarObjectDisplay = "grouped";
  useSettingsStore().desktopSettings.sidebar_table_page_size = 2;
  const group: TreeNode = {
    id: `${connection.id}:APP:APP:${listTables ? "__tables" : "__procedures"}`,
    label: listTables ? "tree.tables" : "tree.procedures",
    type: listTables ? "group-tables" : "group-procedures",
    connectionId: connection.id,
    database: "APP",
    schema: "APP",
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
          id: `${connection.id}:APP`,
          label: "APP",
          type: "database",
          connectionId: connection.id,
          database: "APP",
          isExpanded: true,
          children: [{ id: `${connection.id}:APP:APP`, label: "APP", type: "schema", connectionId: connection.id, database: "APP", schema: "APP", isExpanded: true, children: [group] }],
        },
      ],
    },
  ];
  return { store, group };
}

function findMore(nodes: TreeNode[]): TreeNode | undefined {
  for (const node of nodes) {
    if (node.type === "load-more") return node;
    const child = node.children && findMore(node.children);
    if (child) return child;
  }
}

describe("OceanBase Oracle sidebar paging (#11418)", () => {
  it("uses one bounded object stream in simple mode, retaining a package and its body across pages", async () => {
    const objects: ObjectInfo[] = [
      { name: "A_TABLE", schema: "APP", object_type: "TABLE", comment: "table comment" },
      { name: "SHARED", schema: "APP", object_type: "PACKAGE" },
      { name: "SHARED", schema: "APP", object_type: "PACKAGE_BODY" },
    ];
    const listObjects = vi.fn().mockResolvedValueOnce(objects).mockResolvedValueOnce([objects[2]]);
    const { store } = await setup(listObjects);
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const schema = store.treeNodes[0].children![0].children![0];
    schema.children = [];
    await store.loadTables(connection.id, "APP", "APP", { force: true });
    expect(listObjects).toHaveBeenCalledTimes(1);
    expect(listObjects.mock.calls[0]?.[3]).toEqual(expect.arrayContaining(["TABLE", "PACKAGE", "PACKAGE_BODY"]));
    expect(listObjects.mock.calls[0]?.slice(5, 7)).toEqual([3, 0]);
    expect(schema.children?.map((node) => node.type)).toContain("package");
    expect(schema.children?.map((node) => node.type)).not.toContain("package-body");
    await store.loadMoreObjectGroupChildren(schema.children!.at(-1)!);
    expect(listObjects).toHaveBeenCalledTimes(2);
    expect(listObjects.mock.calls[1]?.[3]).toEqual(listObjects.mock.calls[0]?.[3]);
    expect(listObjects.mock.calls[1]?.slice(5, 7)).toEqual([3, 2]);
    expect(
      schema.children
        ?.filter((node) => node.label === "SHARED")
        .map((node) => node.type)
        .sort(),
    ).toEqual(["package", "package-body"]);
  });

  it("pages globally searched tables using their captured filter", async () => {
    const tables = ["T_A", "T_B", "T_C"].map((name) => ({ name, table_type: "TABLE", comment: "needle" }));
    const listTables = vi.fn().mockResolvedValueOnce(tables).mockResolvedValueOnce([tables[2]]);
    const { store, group } = await setup(vi.fn(), listTables);
    store.sidebarSearchQuery = "needle";
    await store.loadObjectGroupChildren(group, { force: true });
    expect(listTables.mock.calls[0]?.slice(3, 7)).toEqual(["needle", 3, 0, ["TABLE"]]);
    const more = findMore(filterSidebarTree(store.treeNodes, "needle", new Set()));
    expect(more).toBeDefined();
    await store.loadMoreObjectGroupChildren(more!);
    expect(listTables.mock.calls[1]?.slice(3, 7)).toEqual(["needle", 3, 2, ["TABLE"]]);
    expect(group.children?.map((node) => node.label)).toEqual(["T_A", "T_B", "T_C"]);
  });

  it("keeps simple-mode table-scoped searches table-only across pages", async () => {
    const objects = ["T_A", "T_B", "T_C"].map((name) => ({ name, schema: "APP", object_type: "TABLE", comment: "needle" }));
    const listObjects = vi.fn().mockResolvedValueOnce(objects).mockResolvedValueOnce([objects[2]]);
    const { store } = await setup(listObjects);
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const schema = store.treeNodes[0].children![0].children![0];
    schema.children = [];
    store.setSidebarTableSearchQuery(schema.id, "needle");
    await store.refreshSidebarTableSearch(schema.id);
    expect(listObjects.mock.calls[0]?.slice(3, 7)).toEqual([["TABLE"], "needle", 3, 0]);
    await store.loadMoreObjectGroupChildren(schema.children!.at(-1)!, { searchFilter: "needle" });
    expect(listObjects.mock.calls[1]?.slice(3, 7)).toEqual([["TABLE"], "needle", 3, 2]);
  });

  it("keeps filtered object pages bounded and exposes their next page in global search", async () => {
    const listObjects = vi
      .fn()
      .mockResolvedValueOnce([procedure("P_A"), procedure("P_B"), procedure("P_C")])
      .mockResolvedValueOnce([procedure("P_C")]);
    const { store, group } = await setup(listObjects);
    store.sidebarSearchQuery = "needle";
    await store.loadObjectGroupChildren(group, { force: true, searchFilter: "needle", expectedSidebarSearchQuery: "needle" });
    expect(listObjects).toHaveBeenNthCalledWith(1, connection.id, "APP", "APP", ["PROCEDURE"], "needle", 3, 0);
    expect(group.children?.map((node) => node.label)).toEqual(["P_A", "P_B", "tree.loadMore"]);
    const more = findMore(filterSidebarTree(store.treeNodes, "needle", new Set()));
    expect(more).toBeDefined();
    expect(findMore(filterSidebarTree(store.treeNodes, "needle", new Set(), new Set(["table"])))).toBeUndefined();
    await store.loadMoreObjectGroupChildren(more!);
    expect(listObjects).toHaveBeenNthCalledWith(2, connection.id, "APP", "APP", ["PROCEDURE"], "needle", 3, 2);
    expect(group.children?.map((node) => node.label)).toEqual(["P_A", "P_B", "P_C"]);
  });

  it("rejects a captured search page before sending when the filter changed", async () => {
    const listObjects = vi.fn().mockResolvedValue([procedure("P_A"), procedure("P_B"), procedure("P_C")]);
    const { store, group } = await setup(listObjects);
    store.sidebarSearchQuery = "needle";
    await store.loadObjectGroupChildren(group, { force: true });
    const more = group.children!.at(-1)!;
    store.sidebarSearchQuery = "other";
    expect(findMore(filterSidebarTree(store.treeNodes, "other", new Set()))).toBeUndefined();
    await store.loadMoreObjectGroupChildren(more);
    expect(listObjects).toHaveBeenCalledTimes(1);
  });

  it("keeps paging when a matching schema makes the object filter empty", async () => {
    const listObjects = vi
      .fn()
      .mockResolvedValueOnce([procedure("P_A"), procedure("P_B"), procedure("P_C")])
      .mockResolvedValueOnce([procedure("P_C")]);
    const { store, group } = await setup(listObjects);
    store.sidebarSearchQuery = "APP";
    await store.loadObjectGroupChildren(group, { force: true, searchFilter: "", expectedSidebarSearchQuery: "APP", allowGlobalSearchMismatch: true });
    await store.loadMoreObjectGroupChildren(group.children!.at(-1)!);
    expect(listObjects).toHaveBeenNthCalledWith(2, connection.id, "APP", "APP", ["PROCEDURE"], undefined, 3, 2);
    expect(group.children?.map((node) => node.label)).toEqual(["P_A", "P_B", "P_C"]);
  });

  it.each(["filter", "cancel", "schema", "refresh"] as const)("rejects a delayed page after %s invalidates its context", async (change) => {
    let resolveOld!: (objects: ObjectInfo[]) => void;
    const pending = new Promise<ObjectInfo[]>((resolve) => {
      resolveOld = resolve;
    });
    const listObjects = vi
      .fn()
      .mockResolvedValueOnce([procedure("P_A"), procedure("P_B"), procedure("P_C")])
      .mockReturnValueOnce(pending)
      .mockResolvedValue([procedure("P_FRESH")]);
    const { store, group } = await setup(listObjects);
    store.sidebarSearchQuery = "needle";
    await store.loadObjectGroupChildren(group, { force: true });
    const loading = store.loadMoreObjectGroupChildren(group.children!.at(-1)!);
    await vi.waitFor(() => expect(listObjects).toHaveBeenCalledTimes(2));
    if (change === "filter") store.sidebarSearchQuery = "other";
    else if (change === "cancel") store.cancelTreeNodeLoad(group.id);
    else if (change === "schema") store.treeNodes[0].children = [{ id: "OTHER", label: "OTHER", type: "schema", schema: "OTHER", children: [] }];
    else await store.loadObjectGroupChildren(group, { force: true });
    resolveOld([procedure("P_C")]);
    await loading;
    expect(group.children?.some((node) => node.label === "P_C")).toBe(false);
    if (change === "refresh") expect(group.children?.map((node) => node.label)).toEqual(["P_FRESH"]);
  });

  it("does not surface a delayed page error after the search changed", async () => {
    let rejectOld!: (error: Error) => void;
    const pending = new Promise<ObjectInfo[]>((_resolve, reject) => {
      rejectOld = reject;
    });
    const listObjects = vi
      .fn()
      .mockResolvedValueOnce([procedure("P_A"), procedure("P_B"), procedure("P_C")])
      .mockReturnValueOnce(pending);
    const { store, group } = await setup(listObjects);
    store.sidebarSearchQuery = "needle";
    await store.loadObjectGroupChildren(group, { force: true });
    const loading = store.loadMoreObjectGroupChildren(group.children!.at(-1)!);
    await vi.waitFor(() => expect(listObjects).toHaveBeenCalledTimes(2));
    store.sidebarSearchQuery = "other";
    rejectOld(new Error("old page failed"));
    await expect(loading).resolves.toBeUndefined();
  });
});
