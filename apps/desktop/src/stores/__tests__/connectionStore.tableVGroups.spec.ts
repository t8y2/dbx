import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TableInfo, TreeNode } from "@/types/database";

describe("connectionStore table virtual groups during disk reload", () => {
  beforeEach(() => {
    vi.resetModules();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      loadConnections: vi.fn().mockResolvedValue([]),
      loadEditorSettings: vi.fn().mockResolvedValue(null),
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listTables: vi.fn().mockResolvedValue([]),
      getColumns: vi.fn().mockResolvedValue([]),
      loadPinnedTreeNodeIds: vi.fn().mockResolvedValue([]),
      loadSidebarLayout: vi.fn().mockResolvedValue(null),
      loadTableVGroups: vi.fn().mockResolvedValue({}),
      saveTableVGroups: vi.fn().mockResolvedValue(undefined),
      loadTunnelProfiles: vi.fn().mockResolvedValue([]),
      listObjects: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveEditorSettings: vi.fn().mockResolvedValue(undefined),
      savePinnedTreeNodeIds: vi.fn().mockResolvedValue(undefined),
    }));
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function paginatedGroupFixture(display: "simple" | "grouped", schema?: string) {
    const api = await import("@/lib/backend/api");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { tableVGroupScopeKey } = await import("@/lib/table/tableVGroup");
    const config: ConnectionConfig = { id: "mysql-13285", name: "Test database", db_type: schema ? "postgres" : "mysql", host: "127.0.0.1", port: schema ? 5432 : 3306, username: "root", password: "", database: "app" };
    const scope = { connectionId: config.id, database: "app", schema };
    const member: TableInfo = { name: "z_orders", table_type: "TABLE", comment: "Order records" };
    const tables: TableInfo[] = [{ name: "a_first", table_type: "TABLE" }, { name: "b_next", table_type: "TABLE" }, member];
    const layout = {
      version: 1,
      enabled: true,
      groups: [{ id: "business", name: "Business", collapsed: false }],
      order: [{ type: "group" as const, id: "business", children: [{ type: "table" as const, name: member.name }] }],
    };
    vi.mocked(api.loadConnections).mockResolvedValue([config]);
    vi.mocked(api.loadTableVGroups).mockResolvedValue({ [tableVGroupScopeKey(scope)!]: layout });
    vi.mocked(api.listTables).mockImplementation(async (_connection, _database, _schema, filter, limit, offset, _types, _catalog, nameFilter) => {
      if (nameFilter?.includePatterns.length) return [member];
      if (filter) return filter === member.name ? [member] : [];
      return tables.slice(offset ?? 0, limit === undefined ? undefined : (offset ?? 0) + limit);
    });
    const store = useConnectionStore();
    await store.initFromDisk();
    const settings = useSettingsStore();
    settings.editorSettings.sidebarObjectDisplay = display;
    settings.desktopSettings.sidebar_table_page_size = 1;
    store.connectedIds = new Set([config.id]);
    const database: TreeNode = { id: `${config.id}:app`, label: "app", type: "database", connectionId: config.id, database: "app", isExpanded: true, children: [] };
    if (schema) database.children!.push({ id: `${database.id}:${schema}`, label: schema, type: "schema", ...scope, isExpanded: true, children: [] });
    store.treeNodes[0]!.children!.push(database);
    await store.loadTables(config.id, "app", schema, { force: true });
    const liveDatabase = store.treeNodes[0]!.children!.find((node) => node.id === database.id)!;
    const parent = schema ? liveDatabase.children!.find((node) => node.schema === schema)! : liveDatabase;
    const container = display === "simple" ? parent : parent.children!.find((node) => node.type === "group-tables")!;
    if (display === "grouped") await store.loadObjectGroupChildren(container, { force: true });
    return { api, store, container, member, scope };
  }

  it.each(["simple", "grouped"] as const)("keeps off-page group members after clearing table search in %s display", async (display) => {
    const { store, container, member, api } = await paginatedGroupFixture(display);
    const groupMembers = () => container.children?.find((node) => node.type === "table-vgroup")?.children ?? [];
    expect(groupMembers().map((node) => node.label)).toEqual([member.name]);
    store.setSidebarTableSearchQuery(container.id, "no_match");
    await store.refreshSidebarTableSearch(container.id);
    expect(groupMembers()).toEqual([]);
    store.setSidebarTableSearchQuery(container.id, member.name);
    await store.refreshSidebarTableSearch(container.id);
    expect(groupMembers().map((node) => node.label)).toEqual([member.name]);

    store.setSidebarTableSearchQuery(container.id, "");
    await store.refreshSidebarTableSearch(container.id);
    expect(groupMembers().map((node) => [node.label, node.comment])).toEqual([[member.name, member.comment]]);
    expect(container.children?.filter((node) => node.type === "table").map((node) => node.label)).toEqual(["a_first"]);
    expect(container.children?.find((node) => node.type === "load-more")?.loadMore?.offset).toBe(1);

    for (let page = 0; page < 2; page++) {
      await store.loadMoreObjectGroupChildren(container.children!.find((node) => node.type === "load-more")!);
    }
    expect(groupMembers().map((node) => node.label)).toEqual([member.name]);
    expect(container.children?.filter((node) => node.type === "table").map((node) => node.label)).toEqual(["a_first", "b_next"]);
    expect(container.children?.some((node) => node.type === "load-more")).toBe(false);
    expect(
      vi
        .mocked(api.listTables)
        .mock.calls.filter((call) => call[5] === 1 || call[5] === 2)
        .map((call) => call[5]),
    ).toEqual([1, 2]);
  });

  it.each(["simple", "grouped"] as const)("keeps schema member identities stable between search and pagination in %s display", async (display) => {
    const { store, container, member } = await paginatedGroupFixture(display, "public");
    const groupMember = () => container.children!.find((node) => node.type === "table-vgroup")!.children![0]!;
    store.setSidebarTableSearchQuery(container.id, member.name);
    await store.refreshSidebarTableSearch(container.id);
    const searchId = groupMember().id;
    expect(groupMember().schema).toBe("public");

    store.setSidebarTableSearchQuery(container.id, "");
    await store.refreshSidebarTableSearch(container.id);
    expect(groupMember().id).toBe(searchId);
    for (let page = 0; page < 2; page++) await store.loadMoreObjectGroupChildren(container.children!.find((node) => node.type === "load-more")!);
    expect(groupMember().id).toBe(searchId);
  });

  it("keeps first-page tables when a grouped member name contains the schema prefix", async () => {
    const { store, container, member } = await paginatedGroupFixture("grouped", "public");
    member.name = "public:a_first";
    store.tableVGroupLayoutFor(container)!.order = [{ type: "group", id: "business", children: [{ type: "table", name: member.name }] }];
    await store.refreshSidebarTableSearch(container.id);
    const firstPageTable = container.children!.find((node) => node.type === "table" && node.label === "a_first");
    const groupedTable = container.children!.find((node) => node.type === "table-vgroup")!.children![0]!;
    expect(firstPageTable).toBeDefined();
    expect(groupedTable.label).toBe(member.name);
    expect(groupedTable.id).not.toBe(firstPageTable!.id);
  });

  it("counts each exact member once when case-insensitive batch responses overlap", async () => {
    const { store, container, api } = await paginatedGroupFixture("grouped");
    const names = Array.from({ length: 60 }, (_, index) => `z${index}${"x".repeat(60)}`);
    names.push(names[0]!.toUpperCase());
    store.tableVGroupLayoutFor(container)!.order = [{ type: "group", id: "business", children: names.map((name) => ({ type: "table", name })) }];
    vi.mocked(api.listTables)
      .mockClear()
      .mockImplementation(async (_connection, _database, _schema, _filter, _limit, _offset, _types, _catalog, nameFilter) => {
        if (nameFilter) return names.filter((name) => nameFilter.includePatterns.some((pattern) => pattern.toLowerCase() === name.toLowerCase())).map((name) => ({ name, table_type: "TABLE" }));
        return [
          { name: "a_first", table_type: "TABLE" },
          { name: "b_next", table_type: "TABLE" },
        ];
      });
    await store.refreshSidebarTableSearch(container.id);
    expect(vi.mocked(api.listTables).mock.calls.filter((call) => call[8]).length).toBeGreaterThan(1);
    const members = container.children!.find((node) => node.type === "table-vgroup")!.children!;
    expect(members.map((node) => node.label)).toEqual(names);
    expect(container.objectCount).toBe(names.length + 1);
  });

  it("does not restore group members over a newer search while their metadata is loading", async () => {
    const { store, container, member, api } = await paginatedGroupFixture("simple");
    let finishMembers: ((tables: TableInfo[]) => void) | undefined;
    vi.mocked(api.listTables).mockImplementation(async (_connection, _database, _schema, filter, _limit, _offset, _types, _catalog, nameFilter) => {
      if (nameFilter)
        return new Promise<TableInfo[]>((resolve) => {
          finishMembers = resolve;
        });
      if (filter) return [{ name: "a_first", table_type: "TABLE" }];
      return [
        { name: "a_first", table_type: "TABLE" },
        { name: "b_next", table_type: "TABLE" },
      ];
    });
    const olderLoad = store.refreshSidebarTableSearch(container.id);
    await vi.waitFor(() => expect(finishMembers).toBeDefined());
    store.setSidebarTableSearchQuery(container.id, "a_first");
    await store.refreshSidebarTableSearch(container.id);
    finishMembers!([member]);
    await olderLoad;
    expect(container.children?.find((node) => node.type === "table-vgroup")?.children).toEqual([]);
    expect(container.children?.filter((node) => node.type === "table").map((node) => node.label)).toEqual(["a_first"]);
  });

  it("discards a member response when its group was deleted during the load", async () => {
    const { store, container, member, api } = await paginatedGroupFixture("simple");
    let finishMembers: ((tables: TableInfo[]) => void) | undefined;
    vi.mocked(api.listTables).mockImplementation(async (_connection, _database, _schema, _filter, _limit, _offset, _types, _catalog, nameFilter) => {
      if (nameFilter)
        return new Promise<TableInfo[]>((resolve) => {
          finishMembers = resolve;
        });
      return [
        { name: "a_first", table_type: "TABLE" },
        { name: "b_next", table_type: "TABLE" },
      ];
    });
    const pending = store.refreshSidebarTableSearch(container.id);
    await vi.waitFor(() => expect(finishMembers).toBeDefined());
    store.deleteTableVGroups(container, ["business"]);
    finishMembers!([member]);
    await pending;
    expect(container.children?.some((node) => node.type === "table-vgroup")).toBe(false);
    expect(container.children?.filter((node) => node.type === "table").map((node) => node.label)).toEqual(["a_first"]);
  });

  it("reports member metadata errors without replacing the previous tree or deleting membership", async () => {
    const { store, container, member, api } = await paginatedGroupFixture("simple");
    const previousChildren = container.children;
    vi.mocked(api.listTables).mockImplementation(async (_connection, _database, _schema, _filter, _limit, _offset, _types, _catalog, nameFilter) => {
      if (nameFilter) throw new Error("metadata unavailable");
      return [
        { name: "a_first", table_type: "TABLE" },
        { name: "b_next", table_type: "TABLE" },
      ];
    });
    await expect(store.refreshSidebarTableSearch(container.id)).rejects.toThrow("metadata unavailable");
    expect(container.children).toBe(previousChildren);
    expect(store.tableVGroupPathForTable(container, member.name)).toEqual(["business"]);
  });

  it.each(["simple", "grouped"] as const)("removes a deleted table from a complete %s reload without synthesizing a row", async (display) => {
    const { store, container, member, api, scope } = await paginatedGroupFixture(display);
    vi.mocked(api.listTables)
      .mockClear()
      .mockResolvedValue([{ name: "a_first", table_type: "TABLE" }]);
    if (display === "simple") await store.loadTables(scope.connectionId, scope.database, undefined, { force: true });
    else await store.loadObjectGroupChildren(container, { force: true });
    expect(container.children?.find((node) => node.type === "table-vgroup")?.children).toEqual([]);
    expect(store.tableVGroupPathForTable(container, member.name)).toEqual([]);
    expect(api.listTables).toHaveBeenCalledTimes(1);
  });

  it.each(["simple", "grouped"] as const)("keeps name-filtered group members hidden in %s display", async (display) => {
    const { store, container, api, scope } = await paginatedGroupFixture(display);
    const scopeKey = store.tableNameFilterScopeKey({ ...scope, schema: display === "simple" ? "app" : undefined, nodeKind: display === "simple" ? "simple-tables" : "group-tables" });
    for (const filter of [
      { includePatterns: ["a_%"], excludePatterns: [] },
      { includePatterns: [], excludePatterns: ["z_%"] },
    ]) {
      vi.mocked(api.listTables)
        .mockClear()
        .mockResolvedValue([
          { name: "a_first", table_type: "TABLE" },
          { name: "a_next", table_type: "TABLE" },
        ]);
      const revision = store.setSidebarTableNameFilter(scopeKey, filter);
      await store.refreshTreeNodeForTableNameFilter(container, scopeKey, revision);
      expect(container.children?.find((node) => node.type === "table-vgroup")?.children).toEqual([]);
      expect(api.listTables).toHaveBeenCalledTimes(1);
    }
  });

  it("batches long member names and stops requesting batches after the tree is disconnected", async () => {
    const { store, container, api } = await paginatedGroupFixture("simple");
    const names = Array.from({ length: 60 }, (_, index) => `z${index}${"x".repeat(60)}`);
    const layout = store.tableVGroupLayoutFor(container)!;
    layout.order = [{ type: "group", id: "business", children: names.map((name) => ({ type: "table", name })) }];
    vi.mocked(api.listTables)
      .mockClear()
      .mockImplementation(async (_connection, _database, _schema, _filter, _limit, _offset, _types, _catalog, nameFilter) => {
        if (nameFilter) return nameFilter.includePatterns.map((name) => ({ name, table_type: "TABLE" }));
        return [
          { name: "a_first", table_type: "TABLE" },
          { name: "b_next", table_type: "TABLE" },
        ];
      });
    await store.refreshSidebarTableSearch(container.id);
    expect(container.children?.find((node) => node.type === "table-vgroup")?.children?.map((node) => node.label)).toEqual(names);
    const batches = vi.mocked(api.listTables).mock.calls.filter((call) => call[8]);
    expect(batches.length).toBeGreaterThan(1);
    for (const call of batches) expect(encodeURIComponent(JSON.stringify(call[8])).length).toBeLessThan(2500);
    expect(container.children?.find((node) => node.type === "load-more")?.loadMore?.offset).toBe(1);

    let finishBatch: ((tables: TableInfo[]) => void) | undefined;
    vi.mocked(api.listTables)
      .mockClear()
      .mockImplementation(async (_connection, _database, _schema, _filter, _limit, _offset, _types, _catalog, nameFilter) => {
        if (nameFilter)
          return new Promise<TableInfo[]>((resolve) => {
            finishBatch = resolve;
          });
        return [
          { name: "a_first", table_type: "TABLE" },
          { name: "b_next", table_type: "TABLE" },
        ];
      });
    const pending = store.refreshSidebarTableSearch(container.id);
    await vi.waitFor(() => expect(finishBatch).toBeDefined());
    store.connectedIds = new Set();
    store.treeNodes = [];
    finishBatch!([]);
    await pending;
    expect(api.listTables).toHaveBeenCalledTimes(2);
    expect(store.treeNodes).toEqual([]);
  });

  it.each(["simple", "grouped"])("preserves group layout through repeated disk reloads in %s display", async (display) => {
    const api = await import("@/lib/backend/api");
    const { applyTableVGroupsToChildren, tableVGroupScopeKey } = await import("@/lib/table/tableVGroup");
    const { syncPinnedTreeNodeStateInPlace } = await import("@/lib/app/pinnedItems");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const config: ConnectionConfig = { id: "mysql-9665", name: "MySQL", db_type: "mysql", host: "127.0.0.1", port: 3306, username: "root", password: "", database: "app" };
    const scope = { connectionId: config.id, database: "app" };
    const layout = {
      version: 1,
      enabled: true,
      groups: [{ id: "business", name: "Business", collapsed: false }],
      order: [
        {
          type: "group" as const,
          id: "business",
          children: [
            { type: "table" as const, name: "t_c" },
            { type: "table" as const, name: "t_a" },
          ],
        },
      ],
    };
    vi.mocked(api.loadConnections).mockResolvedValue([config]);
    vi.mocked(api.loadTableVGroups).mockResolvedValue({ [tableVGroupScopeKey(scope)!]: layout });
    const store = useConnectionStore();
    await store.initFromDisk();

    const tables: TreeNode[] = ["t_a", "t_b", "t_c"].map((name) => ({ id: `${config.id}:app:table:${name}`, label: name, type: "table", ...scope }));
    const database: TreeNode = { id: `${config.id}:app`, label: "app", type: "database", ...scope, isExpanded: true, children: tables };
    const container: TreeNode = display === "simple" ? database : { id: `${database.id}:__tables`, label: "Tables", type: "group-tables", ...scope, isExpanded: true, children: tables };
    if (display === "grouped") database.children = [container];
    store.treeNodes[0]!.isExpanded = true;
    store.treeNodes[0]!.children!.push(database);
    syncPinnedTreeNodeStateInPlace(store.treeNodes, new Set());
    container.children = applyTableVGroupsToChildren(container.children!, layout, scope);

    for (let reload = 0; reload < 3; reload++) {
      await store.initFromDisk();

      const currentDatabase = store.treeNodes[0]!.children!.find((node) => node.id === database.id)!;
      const currentContainer = display === "simple" ? currentDatabase : currentDatabase.children![0]!;
      expect(currentContainer.children?.map((node) => node.label)).toEqual(["Business", "t_b"]);
      expect(currentContainer.children?.[0]?.children?.map((node) => node.label)).toEqual(["t_c", "t_a"]);
      expect(currentContainer.children?.[0]?.isExpanded).toBe(true);
    }

    expect(api.loadConnections).toHaveBeenCalledTimes(4);
    expect(store.tableVGroupLayoutFor(container)).toEqual(layout);
  });

  it("keeps views layouts separate from tables layouts for the same database", async () => {
    const api = await import("@/lib/backend/api");
    const { tableVGroupScopeKey } = await import("@/lib/table/tableVGroup");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const config: ConnectionConfig = { id: "pg-9733", name: "PG", db_type: "postgresql", host: "127.0.0.1", port: 5432, username: "u", password: "", database: "app" };
    const viewsScope = { connectionId: config.id, database: "app", objectType: "views" as const };
    const viewsLayout = { version: 1, enabled: true, groups: [{ id: "vg", name: "支付视图", collapsed: false }], order: [{ type: "group" as const, id: "vg", children: [{ type: "table" as const, name: "v_pay" }] }] };
    vi.mocked(api.loadConnections).mockResolvedValue([config]);
    vi.mocked(api.loadTableVGroups).mockResolvedValue({ [tableVGroupScopeKey(viewsScope)!]: viewsLayout });
    const store = useConnectionStore();
    await store.initFromDisk();

    const groupViews: TreeNode = { id: `${config.id}:app:__views`, label: "Views", type: "group-views", connectionId: config.id, database: "app" };
    const database: TreeNode = { id: `${config.id}:app`, label: "app", type: "database", connectionId: config.id, database: "app", children: [groupViews] };
    store.treeNodes[0]!.isExpanded = true;
    store.treeNodes[0]!.children!.push(database);
    expect(store.tableVGroupLayoutFor(groupViews)).toEqual(viewsLayout);
    expect(store.tableVGroupLayoutFor(database)).toBeUndefined();
  });

  it("keeps projected view groups through the setChildren reload path", async () => {
    const api = await import("@/lib/backend/api");
    const { tableVGroupScopeKey } = await import("@/lib/table/tableVGroup");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const config: ConnectionConfig = { id: "pg-view-1", name: "PG", db_type: "postgresql", host: "127.0.0.1", port: 5432, username: "u", password: "", database: "app" };
    const viewsScope = { connectionId: config.id, database: "app", objectType: "views" as const };
    const viewsLayout = { version: 1, enabled: true, groups: [{ id: "vg", name: "支付视图", collapsed: false }], order: [{ type: "group" as const, id: "vg", children: [{ type: "table" as const, name: "v_pay" }] }] };
    vi.mocked(api.loadConnections).mockResolvedValue([config]);
    vi.mocked(api.loadTableVGroups).mockResolvedValue({ [tableVGroupScopeKey(viewsScope)!]: viewsLayout });
    const store = useConnectionStore();
    await store.initFromDisk();
    const groupViews: TreeNode = { id: `${config.id}:app:__views`, label: "Views", type: "group-views", connectionId: config.id, database: "app", children: [], isExpanded: true };
    const database: TreeNode = { id: `${config.id}:app`, label: "app", type: "database", connectionId: config.id, database: "app", children: [groupViews], isExpanded: true };
    vi.mocked(api.listTables).mockResolvedValue([
      { name: "v_pay", table_type: "VIEW", schema: "public", comment: null },
      { name: "v_other", table_type: "VIEW", schema: "public", comment: null },
    ]);
    store.connectedIds = new Set([config.id]);
    store.treeNodes[0]!.isExpanded = true;
    store.treeNodes[0]!.children!.push(database);

    await store.refreshTreeNode(groupViews);

    // setChildren 必须用解析后的 views scope 投影：分组顶置、成员重挂、非成员原位
    const labels = groupViews.children?.map((node) => node.label) ?? [];
    expect(labels[0]).toBe("支付视图");
    expect(groupViews.children![0]!.type).toBe("table-vgroup");
    expect(groupViews.children![0]!.children?.map((node) => node.label)).toEqual(["v_pay"]);
    expect(labels).toContain("v_other");
  });

  it("does not mount table virtual groups under table nodes or columns (issue #12960)", async () => {
    const api = await import("@/lib/backend/api");
    const { tableVGroupScopeKey } = await import("@/lib/table/tableVGroup");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const config: ConnectionConfig = { id: "mysql-12960", name: "MySQL", db_type: "mysql", host: "127.0.0.1", port: 3306, username: "root", password: "", database: "temporal" };
    const scope = { connectionId: config.id, database: "temporal" };
    const layout = {
      version: 1,
      enabled: true,
      groups: [
        { id: "g1", name: "test1", collapsed: false },
        { id: "g2", name: "test2", collapsed: false },
      ],
      order: [
        {
          type: "group" as const,
          id: "g1",
          children: [{ type: "table" as const, name: "activity_info_maps" }],
        },
        {
          type: "group" as const,
          id: "g2",
          children: [],
        },
      ],
    };
    vi.mocked(api.loadConnections).mockResolvedValue([config]);
    vi.mocked(api.loadTableVGroups).mockResolvedValue({ [tableVGroupScopeKey(scope)!]: layout });
    vi.mocked(api.getColumns).mockResolvedValue([
      { name: "shard_id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, comment: null },
      { name: "namespace_id", data_type: "binary(16)", is_nullable: false, column_default: null, is_primary_key: false, comment: null },
    ]);
    const store = useConnectionStore();
    await store.initFromDisk();

    const tableNode: TreeNode = {
      id: `${config.id}:temporal:activity_info_maps`,
      label: "activity_info_maps",
      type: "table",
      connectionId: config.id,
      database: "temporal",
    };
    const database: TreeNode = {
      id: `${config.id}:temporal`,
      label: "temporal",
      type: "database",
      connectionId: config.id,
      database: "temporal",
      children: [tableNode],
      isExpanded: true,
    };
    store.connectedIds = new Set([config.id]);
    store.treeNodes[0]!.isExpanded = true;
    store.treeNodes[0]!.children!.push(database);

    // Expand table: loads table groups (columns, indexes, triggers, etc.)
    await store.loadTreeNodeChildren(tableNode);

    // 1. Table node children should only contain structure groups, NO table-vgroup nodes
    expect(tableNode.children?.some((node) => node.type === "table-vgroup")).toBe(false);
    const columnsGroup = tableNode.children?.find((node) => node.type === "group-columns");
    expect(columnsGroup).toBeDefined();

    // Expand columns: loads column rows
    await store.loadTreeNodeChildren(columnsGroup!);

    // 2. Columns group children should only contain column nodes, NO table-vgroup nodes
    expect(columnsGroup!.children?.some((node) => node.type === "table-vgroup")).toBe(false);
    expect(columnsGroup!.children?.map((node) => node.type)).toEqual(["column", "column"]);
  });

  it("does not mount table virtual groups under database node when group-tables is present (issue #13030)", async () => {
    const api = await import("@/lib/backend/api");
    const { tableVGroupScopeKey } = await import("@/lib/table/tableVGroup");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const config: ConnectionConfig = { id: "mysql-13030", name: "MySQL", db_type: "mysql", host: "127.0.0.1", port: 3306, username: "root", password: "", database: "gtis_cloud" };
    const scope = { connectionId: config.id, database: "gtis_cloud" };
    const layout = {
      version: 1,
      enabled: true,
      groups: [
        { id: "g1", name: "国际物流表", collapsed: false },
        { id: "g2", name: "备件物流表", collapsed: false },
      ],
      order: [
        {
          type: "group" as const,
          id: "g1",
          children: [{ type: "table" as const, name: "t_shipping" }],
        },
        {
          type: "group" as const,
          id: "g2",
          children: [{ type: "table" as const, name: "t_parts" }],
        },
      ],
    };
    vi.mocked(api.loadConnections).mockResolvedValue([config]);
    vi.mocked(api.loadTableVGroups).mockResolvedValue({ [tableVGroupScopeKey(scope)!]: layout });
    const store = useConnectionStore();
    await store.initFromDisk();

    const groupTables: TreeNode = {
      id: `${config.id}:gtis_cloud:group-tables`,
      label: "Tables",
      type: "group-tables",
      connectionId: config.id,
      database: "gtis_cloud",
      children: [
        { id: `${config.id}:gtis_cloud:t_shipping`, label: "t_shipping", type: "table", connectionId: config.id, database: "gtis_cloud" },
        { id: `${config.id}:gtis_cloud:t_parts`, label: "t_parts", type: "table", connectionId: config.id, database: "gtis_cloud" },
        { id: `${config.id}:gtis_cloud:t_other`, label: "t_other", type: "table", connectionId: config.id, database: "gtis_cloud" },
      ],
      isExpanded: true,
    };
    const groupViews: TreeNode = {
      id: `${config.id}:gtis_cloud:group-views`,
      label: "Views",
      type: "group-views",
      connectionId: config.id,
      database: "gtis_cloud",
      children: [],
    };
    const database: TreeNode = {
      id: `${config.id}:gtis_cloud`,
      label: "gtis_cloud",
      type: "database",
      connectionId: config.id,
      database: "gtis_cloud",
      children: [groupTables, groupViews],
      isExpanded: true,
    };
    store.connectedIds = new Set([config.id]);
    store.treeNodes[0]!.isExpanded = true;
    store.treeNodes[0]!.children!.push(database);

    // Reproject layout or create a new group
    store.createTableVGroup(groupTables, "新分组");

    // Database children must NOT contain table-vgroup nodes
    expect(database.children?.some((node) => node.type === "table-vgroup")).toBe(false);
    expect(database.children?.map((node) => node.type)).toEqual(["group-tables", "group-views"]);

    // Tables group node must contain the projected table-vgroups
    expect(groupTables.children?.some((node) => node.type === "table-vgroup")).toBe(true);
    const vgroupLabels = groupTables.children?.filter((node) => node.type === "table-vgroup").map((node) => node.label);
    expect(vgroupLabels).toContain("国际物流表");
    expect(vgroupLabels).toContain("备件物流表");
    expect(vgroupLabels).toContain("新分组");
  });

  it("strips legacy or cached table virtual groups from database children when group-tables is loaded (issue #13030)", async () => {
    const api = await import("@/lib/backend/api");
    const { tableVGroupScopeKey } = await import("@/lib/table/tableVGroup");
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const config: ConnectionConfig = { id: "mysql-13030-strip", name: "MySQL", db_type: "mysql", host: "127.0.0.1", port: 3306, username: "root", password: "", database: "gtis_cloud" };
    const scope = { connectionId: config.id, database: "gtis_cloud" };
    const layout = {
      version: 1,
      enabled: true,
      groups: [{ id: "g1", name: "国际物流表", collapsed: false }],
      order: [{ type: "group" as const, id: "g1", children: [] }],
    };
    vi.mocked(api.loadConnections).mockResolvedValue([config]);
    vi.mocked(api.loadTableVGroups).mockResolvedValue({ [tableVGroupScopeKey(scope)!]: layout });
    const store = useConnectionStore();
    await store.initFromDisk();

    const leakedVGroup: TreeNode = {
      id: "table-vgroup:g1",
      label: "国际物流表",
      type: "table-vgroup",
      connectionId: config.id,
      database: "gtis_cloud",
      vgroupId: "g1",
    };
    const groupTables: TreeNode = {
      id: `${config.id}:gtis_cloud:group-tables`,
      label: "Tables",
      type: "group-tables",
      connectionId: config.id,
      database: "gtis_cloud",
      children: [],
    };
    const database: TreeNode = {
      id: `${config.id}:gtis_cloud`,
      label: "gtis_cloud",
      type: "database",
      connectionId: config.id,
      database: "gtis_cloud",
      children: [leakedVGroup, groupTables],
      isExpanded: true,
    };
    store.connectedIds = new Set([config.id]);
    store.treeNodes[0]!.isExpanded = true;
    store.treeNodes[0]!.children!.push(database);

    // Call reproject
    store.createTableVGroup(groupTables, "新分组2");

    // Database children must have the leaked table-vgroup stripped
    expect(database.children?.some((node) => node.type === "table-vgroup")).toBe(false);
    expect(database.children?.map((node) => node.type)).toEqual(["group-tables"]);
  });
});
