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
      loadPinnedTreeNodeIds: vi.fn().mockResolvedValue([]),
      loadSidebarLayout: vi.fn().mockResolvedValue(null),
      loadTableVGroups: vi.fn().mockResolvedValue({}),
      loadTunnelProfiles: vi.fn().mockResolvedValue([]),
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
});
