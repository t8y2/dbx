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

async function setup(listObjects: ReturnType<typeof vi.fn>, listTables?: ReturnType<typeof vi.fn>, listTriggers = vi.fn().mockResolvedValue([])) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    disconnectDb: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    listObjects,
    listTriggers,
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
  function trigger(name: string, id: string): ObjectInfo {
    return {
      name,
      schema: " Trigger Owner ",
      object_type: "TRIGGER",
      trigger: {
        name,
        event: "UPDATE",
        timing: "INSTEAD OF",
        enabled: false,
        valid: true,
        oracle_metadata: {
          contractVersion: 1,
          identityMode: "exact",
          engine: "oceanbase-oracle",
          engineVersion: "4.2.5.7",
          owner: " Trigger Owner ",
          name,
          objectId: id,
          scope: "VIEW",
          parent: { owner: " Parent Owner ", name: " Parent ", objectType: "VIEW" },
          reads: { identity: { state: "available" } },
        },
      },
    };
  }

  it("uses exact trigger reads and re-reads a shifted page instead of merging a recreated anchor", async () => {
    const first = [trigger(" A ", "1"), trigger(" A", "2"), trigger(" a ", "3")];
    const replaced = trigger(" a ", "99");
    const last = trigger(" D ", "4");
    const listObjects = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce([replaced, last]).mockResolvedValueOnce([first[0], first[1], replaced, last]);
    const { store, group } = await setup(listObjects);
    group.type = "group-triggers";
    group.label = "tree.triggers";
    group.catalog = " Catalog ";
    await store.loadObjectGroupChildren(group, { force: true });
    expect(listObjects.mock.calls[0][10]).toEqual({ identityMode: "exact", catalog: " Catalog " });
    expect(group.children!.slice(0, 2).map((node) => node.objectName)).toEqual([" A", " A "]);
    await store.loadMoreObjectGroupChildren(group.children!.at(-1)!);
    expect(listObjects.mock.calls.map((args) => args[6])).toEqual([0, 2, 0]);
    expect(listObjects.mock.calls[2][5]).toBe(5);
    expect(group.children).toHaveLength(4);
    expect(new Set(group.children!.map((node) => node.id)).size).toBe(4);
    expect(group.children!.every((node) => node.schema === " Trigger Owner " && node.parentSchema === " Parent Owner " && node.catalog === " Catalog ")).toBe(true);
  });

  it.each(["oracle", "dameng"] as const)("uses the same bounded trigger stream in %s simple mode", async (db_type) => {
    const listObjects = vi.fn().mockImplementation(async (...args: unknown[]) => (args[10] === true ? [] : [trigger(" Trigger ", "1")]));
    const listTables = vi.fn().mockResolvedValue([]);
    const { store } = await setup(listObjects, listTables);
    store.connections = [{ ...connection, db_type }];
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const schema = store.treeNodes[0].children![0].children![0];
    schema.children = [];
    await store.loadTables(connection.id, "APP", "APP", { force: true });
    expect(listObjects.mock.calls.filter((args) => args[10] !== true)).toHaveLength(1);
    expect(listObjects.mock.calls[0][3]).toContain("TRIGGER");
    expect(listObjects.mock.calls[0][10]).toEqual({ identityMode: "exact" });
    expect(listTables).not.toHaveBeenCalled();
    expect(schema.children![0]).toMatchObject({ type: "trigger", objectName: " Trigger ", schema: " Trigger Owner ", parentSchema: " Parent Owner " });
  });

  it("keeps the parent entry bound to the returned trigger owner rather than the table owner", async () => {
    const info = trigger(" Trigger ", "1").trigger!;
    const listTriggers = vi.fn().mockResolvedValue([info]);
    const { store, group } = await setup(vi.fn(), undefined, listTriggers);
    group.type = "group-triggers";
    group.tableName = " Parent ";
    await store.loadTriggers(connection.id, "APP", " Parent ", " Parent Owner ", group.id, " Catalog ");
    expect(listTriggers).toHaveBeenCalledWith(connection.id, "APP", " Parent Owner ", " Parent ", " Catalog ", { identityMode: "exact", catalog: " Catalog " });
    expect(group.children![0]).toMatchObject({ type: "trigger", schema: " Trigger Owner ", objectName: " Trigger ", parentSchema: " Parent Owner ", parentName: " Parent ", parentType: "view", catalog: " Catalog " });
  });

  it("does not impose exact metadata on old mixed-object reads because of an Oracle-compatible JDBC label", async () => {
    const listObjects = vi.fn().mockImplementation(async (...args: unknown[]) => (args[10] === true ? [] : [procedure("P")]));
    const listTables = vi.fn().mockResolvedValue([{ name: "T", table_type: "TABLE" }]);
    const { store } = await setup(listObjects, listTables);
    store.connections = [{ ...connection, db_type: "jdbc", driver_label: "Oracle-compatible Yashan", connection_string: "jdbc:yasdb://fixture", database_info: { productName: "YashanDB" } }];
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const schema = store.treeNodes[0].children![0].children![0];
    schema.children = [];
    await store.loadTables(connection.id, "APP", "APP", { force: true });
    await vi.waitFor(() => expect(listObjects).toHaveBeenCalledWith(connection.id, "APP", "APP", ["INDEX"], undefined, 3, 0, undefined, undefined, undefined, true));
    expect(listTables).toHaveBeenCalled();
    const ordinaryCalls = listObjects.mock.calls.filter((args) => !args[3]?.includes("INDEX"));
    expect(ordinaryCalls).toHaveLength(1);
    expect(ordinaryCalls[0][10]).toBeUndefined();
  });

  it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("adds exact %s indexes to the flat tree without changing the legacy table request", async (dbType) => {
    const listObjects = vi.fn().mockImplementation(async (...args: unknown[]) => (args[10] === true ? [{ name: " Ix(a) ", object_type: "INDEX", schema: " Mixed ", parent_schema: " Other ", parent_name: " T(a) " }] : []));
    const { store } = await setup(listObjects);
    store.connections = [{ ...connection, db_type: dbType }];
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const schema = store.treeNodes[0].children![0].children![0];
    schema.id = `${connection.id}:APP: Mixed `;
    schema.schema = " Mixed ";
    schema.children = [];
    await store.loadTables(connection.id, "APP", " Mixed ", { force: true });
    await vi.waitFor(() => expect(schema.children?.find((node) => node.type === "index")).toMatchObject({ objectName: " Ix(a) ", schema: " Mixed ", parentSchema: " Other ", parentName: " T(a) ", objectScope: "schema" }));
    expect(listObjects).toHaveBeenCalledWith(connection.id, "APP", " Mixed ", ["INDEX"], undefined, 3, 0, undefined, undefined, undefined, true);
    const api = await import("@/lib/backend/api");
    expect(vi.mocked(api.saveSchemaCache).mock.calls.every((call) => !JSON.stringify(call[1]).includes('"objectScope":"schema"'))).toBe(true);
  });

  it.each(["table-first", "index-first"])("pages flat indexes and tables independently (%s)", async (order) => {
    const indexes: ObjectInfo[] = ["I1", "I2", "I3", "I4"].map((name) => ({ name, object_type: "INDEX", schema: "APP", parent_schema: "OTHER", parent_name: "T" }));
    const tables = ["T1", "T2", "T3", "T4"].map((name) => ({ name, table_type: "TABLE" }));
    const listObjects = vi.fn(async (...args: unknown[]) => (args[10] === true ? indexes.slice(Number(args[6] ?? 0), Number(args[6] ?? 0) + Number(args[5] ?? indexes.length)) : []));
    const listTables = vi.fn(async (...args: unknown[]) => tables.slice(Number(args[5] ?? 0), Number(args[5] ?? 0) + Number(args[4] ?? tables.length)));
    const { store } = await setup(listObjects, listTables);
    store.connections = [{ ...connection, db_type: "oracle" }];
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const schema = store.treeNodes[0].children![0].children![0];
    schema.children = [];
    store.setSidebarTableNameFilter(store.tableNameFilterScopeKey({ connectionId: connection.id, database: "APP", schema: "APP", nodeKind: "simple-tables" }), { includePatterns: ["%"], excludePatterns: [] });
    await store.loadTables(connection.id, "APP", "APP", { force: true });
    await vi.waitFor(() => expect(schema.children?.filter((node) => node.type === "load-more")).toHaveLength(2));
    const markers = schema.children!.filter((node) => node.type === "load-more");
    expect(new Set(markers.map((node) => node.id)).size).toBe(2);
    const indexMore = markers.find((node) => node.loadMore?.objectType === "INDEX")!;
    const tableMore = markers.find((node) => node.loadMore?.objectType !== "INDEX")!;
    await store.loadMoreObjectGroupChildren(order === "table-first" ? tableMore : indexMore);
    expect(schema.children?.filter((node) => node.type === "load-more").map((node) => node.id)).toEqual([order === "table-first" ? indexMore.id : tableMore.id]);
    await store.loadMoreObjectGroupChildren(order === "table-first" ? indexMore : tableMore);
    expect(schema.children?.some((node) => node.type === "load-more")).toBe(false);
    expect(schema.children?.filter((node) => node.type === "index").map((node) => node.objectName)).toEqual(indexes.map((object) => object.name));
    expect(schema.children?.filter((node) => node.type === "table").map((node) => node.label)).toEqual(tables.map((table) => table.name));
    expect(listObjects.mock.calls.filter((args) => args[10] === true).map((args) => args.slice(5, 7))).toEqual([
      [3, 0],
      [3, 2],
    ]);
    const api = await import("@/lib/backend/api");
    expect(vi.mocked(api.saveSchemaCache).mock.calls.every((call) => !JSON.stringify(call[1]).includes('"objectType":"INDEX"'))).toBe(true);
  });

  it("keeps the captured flat index search on later pages and clears it on refresh", async () => {
    const indexes: ObjectInfo[] = ["needle1", "needle2", "needle3", "other"].map((name) => ({ name, object_type: "INDEX", schema: "APP", parent_schema: "APP", parent_name: "T" }));
    const listObjects = vi.fn(async (...args: unknown[]) => {
      if (args[10] !== true) return [];
      const filtered = indexes.filter((object) => !args[4] || object.name.includes(String(args[4])));
      return filtered.slice(Number(args[6] ?? 0), Number(args[6] ?? 0) + Number(args[5]));
    });
    const { store } = await setup(listObjects);
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const schema = store.treeNodes[0].children![0].children![0];
    schema.children = [];
    store.sidebarSearchQuery = "needle";
    await store.loadTables(connection.id, "APP", "APP", { force: true, searchFilter: "needle", expectedSidebarSearchQuery: "needle" });
    await vi.waitFor(() => expect(schema.children?.find((node) => node.loadMore?.objectType === "INDEX")).toBeDefined());
    await store.loadMoreObjectGroupChildren(schema.children!.find((node) => node.loadMore?.objectType === "INDEX")!);
    expect(listObjects.mock.calls.filter((args) => args[10] === true).map((args) => args.slice(4, 7))).toEqual([
      ["needle", 3, 0],
      ["needle", 3, 2],
    ]);
    expect(schema.children?.filter((node) => node.type === "index").map((node) => node.objectName)).toEqual(["needle1", "needle2", "needle3"]);
    store.sidebarSearchQuery = "";
    await store.loadTables(connection.id, "APP", "APP", { force: true, searchFilter: "", expectedSidebarSearchQuery: "" });
    await vi.waitFor(() => expect(schema.children?.find((node) => node.loadMore?.objectType === "INDEX")).toBeDefined());
    expect(
      listObjects.mock.calls
        .filter((args) => args[10] === true)
        .at(-1)
        ?.slice(4, 7),
    ).toEqual([undefined, 3, 0]);
  });

  it("rejects a late supplemental index page after the parent is refreshed", async () => {
    let release!: (objects: ObjectInfo[]) => void;
    let exactCalls = 0;
    const listObjects = vi.fn((...args: unknown[]) => {
      if (args[10] !== true) return Promise.resolve([]);
      if (++exactCalls === 1)
        return new Promise<ObjectInfo[]>((resolve) => {
          release = resolve;
        });
      return Promise.resolve([{ name: "CURRENT", object_type: "INDEX", schema: "APP", parent_schema: "APP", parent_name: "T" }]);
    });
    const { store } = await setup(listObjects);
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const schema = store.treeNodes[0].children![0].children![0];
    schema.children = [];
    await store.loadTables(connection.id, "APP", "APP", { force: true });
    await vi.waitFor(() => expect(exactCalls).toBe(1));
    await store.loadTables(connection.id, "APP", "APP", { force: true });
    await vi.waitFor(() => expect(schema.children?.some((node) => node.objectName === "CURRENT")).toBe(true));
    release([{ name: "STALE", object_type: "INDEX", schema: "APP", parent_schema: "APP", parent_name: "T" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(schema.children?.some((node) => node.objectName === "STALE")).toBe(false);
    expect(schema.children?.some((node) => node.objectName === "CURRENT")).toBe(true);
  });

  it("does not start an exact page from a retired ordinary supplement", async () => {
    let release!: (objects: ObjectInfo[]) => void;
    let ordinaryCalls = 0;
    let exactCalls = 0;
    const listObjects = vi.fn((...args: unknown[]) => {
      if (args[10] === true) {
        exactCalls++;
        return Promise.resolve([{ name: "CURRENT", object_type: "INDEX", schema: "APP", parent_schema: "APP", parent_name: "T" }]);
      }
      if (++ordinaryCalls === 1)
        return new Promise<ObjectInfo[]>((resolve) => {
          release = resolve;
        });
      return Promise.resolve([]);
    });
    const { store } = await setup(listObjects);
    store.connections = [{ ...connection, db_type: "oracle" }];
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const schema = store.treeNodes[0].children![0].children![0];
    schema.children = [];
    store.setSidebarTableNameFilter(store.tableNameFilterScopeKey({ connectionId: connection.id, database: "APP", schema: "APP", nodeKind: "simple-tables" }), { includePatterns: ["%"], excludePatterns: [] });
    await store.loadTables(connection.id, "APP", "APP", { force: true });
    await vi.waitFor(() => expect(ordinaryCalls).toBe(1));
    await store.loadTables(connection.id, "APP", "APP", { force: true });
    await vi.waitFor(() => expect(exactCalls).toBe(1));
    release([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exactCalls).toBe(1);
  });

  it("replaces only the index window when a flat index page anchor moves", async () => {
    const index = (name: string): ObjectInfo => ({ name, object_type: "INDEX", schema: "APP", parent_schema: "APP", parent_name: "T" });
    const pages = [[index("I1"), index("I2"), index("I3")], [index("I4")], [index("I2"), index("I3"), index("I4")]];
    const listObjects = vi.fn(async (...args: unknown[]) => (args[10] === true ? pages.shift()! : []));
    const { store } = await setup(listObjects, vi.fn().mockResolvedValue([{ name: "TABLE_KEPT", table_type: "TABLE" }]));
    store.connections = [{ ...connection, db_type: "oracle" }];
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const schema = store.treeNodes[0].children![0].children![0];
    schema.children = [];
    store.setSidebarTableNameFilter(store.tableNameFilterScopeKey({ connectionId: connection.id, database: "APP", schema: "APP", nodeKind: "simple-tables" }), { includePatterns: ["%"], excludePatterns: [] });
    await store.loadTables(connection.id, "APP", "APP", { force: true });
    await vi.waitFor(() => expect(schema.children?.find((node) => node.loadMore?.objectType === "INDEX")).toBeDefined());
    await store.loadMoreObjectGroupChildren(schema.children!.find((node) => node.loadMore?.objectType === "INDEX")!);
    expect(schema.children?.filter((node) => node.type === "index").map((node) => node.objectName)).toEqual(["I2", "I3", "I4"]);
    expect(schema.children?.some((node) => node.label === "TABLE_KEPT")).toBe(true);
    expect(listObjects.mock.calls.filter((args) => args[10] === true).map((args) => args.slice(5, 7))).toEqual([
      [3, 0],
      [3, 2],
      [5, 0],
    ]);
  });

  it("keeps flat legacy objects usable while exposing an exact-index read error", async () => {
    const listObjects = vi.fn().mockImplementation(async (...args: unknown[]) => {
      if (args[10] === true) throw new Error("Cannot verify exact_metadata_identity_v1");
      return [{ name: "T", object_type: "TABLE", schema: "APP" }];
    });
    const { store } = await setup(listObjects);
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const schema = store.treeNodes[0].children![0].children![0];
    schema.children = [];
    await store.loadTables(connection.id, "APP", "APP", { force: true });
    await vi.waitFor(() => expect(store.connectionErrors[connection.id]).toContain("exact_metadata_identity_v1"));
    expect(schema.children?.some((node) => node.type === "table" && node.label === "T")).toBe(true);
  });

  it.each(["oracle", "oceanbase-oracle", "dameng"] as const)("%s schema indexes use exact raw owners and one captured search page", async (dbType) => {
    const objects: ObjectInfo[] = [" Ix(a) ", "ix(A)", "Ix_A_2"].map((name) => ({ name, object_type: "INDEX", schema: " Mixed ", parent_schema: " Other Owner ", parent_name: " T(a) " }));
    const listObjects = vi.fn().mockResolvedValueOnce(objects).mockResolvedValueOnce([objects[2]]);
    const { store, group } = await setup(listObjects);
    store.connections = [{ ...connection, db_type: dbType }];
    group.type = "group-database-indexes";
    group.id = group.id.replace("__procedures", "__indexes");
    group.schema = " Mixed ";
    store.sidebarSearchQuery = "Ix";
    await store.loadObjectGroupChildren(group, { force: true, searchFilter: "Ix", expectedSidebarSearchQuery: "Ix" });
    expect(listObjects).toHaveBeenNthCalledWith(1, connection.id, "APP", " Mixed ", ["INDEX"], "Ix", 3, 0, undefined, undefined, undefined, true);
    expect(group.children?.[0]).toMatchObject({ objectName: " Ix(a) ", schema: " Mixed ", parentSchema: " Other Owner ", parentName: " T(a) ", objectScope: "schema" });
    const more = group.children?.find((node) => node.type === "load-more");
    expect(more).toBeDefined();
    await store.loadMoreObjectGroupChildren(more!);
    expect(listObjects).toHaveBeenNthCalledWith(2, connection.id, "APP", " Mixed ", ["INDEX"], "Ix", 3, 2, undefined, undefined, undefined, true);
    expect(group.children?.filter((node) => node.type === "index").map((node) => node.objectName)).toEqual(objects.map((object) => object.name));
  });

  it("does not hydrate a legacy persisted index list or turn an exact capability error into an empty success", async () => {
    const listObjects = vi.fn().mockRejectedValue(new Error("Cannot verify exact_metadata_identity_v1"));
    const { store, group } = await setup(listObjects);
    group.type = "group-database-indexes";
    group.id = group.id.replace("__procedures", "__indexes");
    const api = await import("@/lib/backend/api");
    vi.mocked(api.loadSchemaCache).mockResolvedValue([{ id: "legacy-index", type: "index", label: "WRONG", schema: "APP" }]);
    await expect(store.loadObjectGroupChildren(group)).rejects.toThrow("exact_metadata_identity_v1");
    expect(group.children?.some((node) => node.id === "legacy-index")).toBe(false);
    expect(listObjects).toHaveBeenCalledOnce();
  });

  it("does not reuse a late exact index page after the connection lifetime ends", async () => {
    let release!: (objects: ObjectInfo[]) => void;
    const listObjects = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<ObjectInfo[]>((resolve) => {
          release = resolve;
        }),
      )
      .mockRejectedValueOnce(new Error("new process lacks exact_metadata_identity_v1"));
    const { store, group } = await setup(listObjects);
    group.type = "group-database-indexes";
    group.id = group.id.replace("__procedures", "__indexes");
    const schema = store.treeNodes[0].children![0].children![0];
    const database = store.treeNodes[0].children![0];
    const pending = store.loadObjectGroupChildren(group);
    await vi.waitFor(() => expect(listObjects).toHaveBeenCalledOnce());
    await store.disconnect(connection.id, { skipTabHandling: true, markClosedByUser: false });
    release([{ name: "OLD_CAPABLE_PROCESS", object_type: "INDEX", schema: "APP", parent_schema: "APP", parent_name: "T" }]);
    await pending;
    store.connectedIds.add(connection.id);
    store.treeNodes[0].children = [database];
    database.children = [schema];
    schema.children = [group];
    await expect(store.loadObjectGroupChildren(group)).rejects.toThrow("new process lacks exact_metadata_identity_v1");
    expect(listObjects).toHaveBeenCalledTimes(2);
    expect(group.children?.some((node) => node.objectName === "OLD_CAPABLE_PROCESS")).toBe(false);
  });

  it("uses one bounded object stream in simple mode, retaining a package and its body across pages", async () => {
    const objects: ObjectInfo[] = [
      { name: "A_TABLE", schema: "APP", object_type: "TABLE", comment: "table comment" },
      { name: "SHARED", schema: "APP", object_type: "PACKAGE" },
      { name: "SHARED", schema: "APP", object_type: "PACKAGE_BODY" },
    ];
    let ordinaryPage = 0;
    const listObjects = vi.fn().mockImplementation(async (...args: unknown[]) => (args[10] === true ? [] : ordinaryPage++ === 0 ? objects : [objects[2]]));
    const { store } = await setup(listObjects);
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore().editorSettings.sidebarObjectDisplay = "simple";
    const schema = store.treeNodes[0].children![0].children![0];
    schema.children = [];
    await store.loadTables(connection.id, "APP", "APP", { force: true });
    expect(listObjects.mock.calls.filter((call) => call[10] !== true)).toHaveLength(1);
    expect(listObjects.mock.calls[0]?.[3]).toEqual(expect.arrayContaining(["TABLE", "PACKAGE", "PACKAGE_BODY"]));
    expect(listObjects.mock.calls[0]?.slice(5, 7)).toEqual([3, 0]);
    expect(schema.children?.map((node) => node.type)).toContain("package");
    expect(schema.children?.map((node) => node.type)).not.toContain("package-body");
    await store.loadMoreObjectGroupChildren(schema.children!.at(-1)!);
    const ordinaryCalls = listObjects.mock.calls.filter((call) => call[10] !== true);
    expect(ordinaryCalls).toHaveLength(2);
    expect(ordinaryCalls[1]?.[3]).toEqual(ordinaryCalls[0]?.[3]);
    expect(ordinaryCalls[1]?.slice(5, 7)).toEqual([3, 2]);
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
