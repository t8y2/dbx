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

function postgresConnection(): ConnectionConfig {
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

function schemaNode(children: TreeNode[]): TreeNode {
  return {
    id: "pg-1:app:public",
    label: "public",
    type: "schema",
    connectionId: "pg-1",
    database: "app",
    schema: "public",
    isExpanded: true,
    children,
  };
}

function objectGroup(type: "group-views" | "group-procedures", key: string, child: TreeNode): TreeNode {
  return {
    id: `pg-1:app:public:${key}`,
    label: type === "group-views" ? "tree.views" : "tree.procedures",
    type,
    connectionId: "pg-1",
    database: "app",
    schema: "public",
    isExpanded: true,
    objectCount: 7,
    children: [child],
  };
}

function installApiMocks(options?: { listTables?: ReturnType<typeof vi.fn>; listObjects?: ReturnType<typeof vi.fn> }) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    listObjects: options?.listObjects ?? vi.fn().mockResolvedValue([]),
    listTables: options?.listTables ?? vi.fn().mockResolvedValue([]),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));
}

async function createStore(root: TreeNode) {
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  const store = useConnectionStore();
  useSettingsStore().editorSettings.sidebarObjectDisplay = "grouped";
  const connection = postgresConnection();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, isExpanded: true, children: [root] }];
  return store;
}

describe("connectionStore tree refresh state", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("preserves an object group count while rebuilding grouped placeholders", async () => {
    installApiMocks();
    const oldView: TreeNode = { id: "pg-1:app:public:old_view", label: "old_view", type: "view", connectionId: "pg-1", database: "app", schema: "public" };
    const root = schemaNode([objectGroup("group-views", "__views", oldView)]);
    root.children![0]!.isExpanded = false;
    const store = await createStore(root);

    await store.loadTreeNodeChildren(root, { force: true });

    expect(root.children?.find((child) => child.type === "group-views")?.objectCount).toBe(7);
  });

  it("rolls back tree data and loaded markers when an expanded child refresh fails", async () => {
    const listTables = vi.fn().mockResolvedValue([{ name: "fresh_view", table_type: "VIEW", comment: null }]);
    const listObjects = vi.fn().mockRejectedValue(new Error("metadata denied"));
    installApiMocks({ listTables, listObjects });

    const oldView: TreeNode = { id: "pg-1:app:public:old_view", label: "old_view", type: "view", connectionId: "pg-1", database: "app", schema: "public" };
    const oldProcedure: TreeNode = { id: "pg-1:app:public:old_procedure", label: "old_procedure", type: "procedure", connectionId: "pg-1", database: "app", schema: "public" };
    const root = schemaNode([objectGroup("group-views", "__views", oldView), objectGroup("group-procedures", "__procedures", oldProcedure)]);
    const hiddenChildren: TreeNode[] = [{ id: "pg-1:app:public:hidden", label: "hidden", type: "view", connectionId: "pg-1", database: "app", schema: "public" }];
    root.hiddenChildren = hiddenChildren;
    root.objectCount = 42;
    const store = await createStore(root);

    await store.loadTreeNodeChildren(root, { force: true });
    const previousChildren = root.children;
    const viewsGroupId = root.children!.find((child) => child.type === "group-views")!.id;
    const proceduresGroupId = root.children!.find((child) => child.type === "group-procedures")!.id;
    expect(store.isTreeNodeChildrenLoaded(root.id)).toBe(true);
    expect(store.isTreeNodeChildrenLoaded(viewsGroupId)).toBe(false);

    await expect(store.refreshTreeNode(root)).rejects.toThrow("metadata denied");

    expect(listTables).toHaveBeenCalledOnce();
    expect(listObjects).toHaveBeenCalledOnce();
    expect(root.children).toBe(previousChildren);
    expect(root.hiddenChildren).toBe(hiddenChildren);
    expect(root.objectCount).toBe(42);
    expect(root.children?.find((child) => child.type === "group-views")?.children?.map((child) => child.label)).toEqual(["old_view"]);
    expect(root.children?.find((child) => child.type === "group-procedures")?.children?.map((child) => child.label)).toEqual(["old_procedure"]);
    expect(store.isTreeNodeChildrenLoaded(root.id)).toBe(true);
    expect(store.isTreeNodeChildrenLoaded(viewsGroupId)).toBe(false);
    expect(store.isTreeNodeChildrenLoaded(proceduresGroupId)).toBe(false);
  });
});
