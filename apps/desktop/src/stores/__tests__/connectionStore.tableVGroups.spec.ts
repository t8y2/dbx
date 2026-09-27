import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TreeNode } from "@/types/database";

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
      loadPinnedTreeNodeIds: vi.fn().mockResolvedValue([]),
      loadSidebarLayout: vi.fn().mockResolvedValue(null),
      loadTableVGroups: vi.fn().mockResolvedValue({}),
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
});
