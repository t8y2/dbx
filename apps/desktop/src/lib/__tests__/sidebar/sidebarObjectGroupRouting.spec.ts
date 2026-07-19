import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSidebarObjectGroup } from "@/lib/sidebar/sidebarObjectGroupRouting";
import type { ConnectionConfig, ObjectInfo, TreeNode } from "@/types/database";

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

function objectGroup(type: "group-triggers" | "group-types", id: string): TreeNode {
  return {
    id,
    label: type === "group-triggers" ? "tree.triggers" : "tree.types",
    type,
    connectionId: "mysql-1",
    database: "app",
    schema: "app",
    isExpanded: false,
    children: [],
  };
}

async function createStore({ listObjects, listTriggers }: { listObjects: ReturnType<typeof vi.fn>; listTriggers: ReturnType<typeof vi.fn> }) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    listObjects,
    listTriggers,
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));

  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  const store = useConnectionStore();
  const connection = mysqlConnection();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  useSettingsStore().desktopSettings.sidebar_table_page_size = 10;
  return { connection, store };
}

describe("sidebar object-group routing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("uses listObjects for schema-level trigger and type groups, including empty results", async () => {
    const listObjects = vi.fn<() => Promise<ObjectInfo[]>>().mockResolvedValue([]);
    const listTriggers = vi.fn<() => Promise<never[]>>().mockResolvedValue([]);
    const { connection, store } = await createStore({ listObjects, listTriggers });
    const triggerGroup = objectGroup("group-triggers", `${connection.id}:app:app:__triggers`);
    const typeGroup = objectGroup("group-types", `${connection.id}:app:app:__types`);
    store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, children: [triggerGroup, typeGroup] }];
    const storedTriggerGroup = store.treeNodes[0].children![0];
    const storedTypeGroup = store.treeNodes[0].children![1];

    await loadSidebarObjectGroup(storedTriggerGroup, store);
    await loadSidebarObjectGroup(storedTypeGroup, store);

    expect(listObjects).toHaveBeenNthCalledWith(1, connection.id, "app", "app", ["TRIGGER"], undefined, 11, 0);
    expect(listObjects).toHaveBeenNthCalledWith(2, connection.id, "app", "app", ["TYPE", "TYPE_BODY"], undefined, 11, 0);
    expect(listTriggers).not.toHaveBeenCalled();
    expect(storedTriggerGroup).toMatchObject({ isExpanded: true, isLoading: false, children: [] });
    expect(storedTypeGroup).toMatchObject({ isExpanded: true, isLoading: false, children: [] });
  });

  it("keeps table-level trigger groups on listTriggers", async () => {
    const listObjects = vi.fn<() => Promise<ObjectInfo[]>>().mockResolvedValue([]);
    const listTriggers = vi.fn<() => Promise<never[]>>().mockResolvedValue([]);
    const { connection, store } = await createStore({ listObjects, listTriggers });
    const tableTriggerGroup: TreeNode = {
      ...objectGroup("group-triggers", `${connection.id}:app:app:orders:__triggers`),
      tableName: "orders",
    };
    store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, children: [tableTriggerGroup] }];
    const storedTriggerGroup = store.treeNodes[0].children![0];

    await loadSidebarObjectGroup(storedTriggerGroup, store);

    expect(listTriggers).toHaveBeenCalledWith(connection.id, "app", "app", "orders", undefined);
    expect(listObjects).not.toHaveBeenCalled();
    expect(storedTriggerGroup).toMatchObject({ isExpanded: true, isLoading: false, children: [] });
  });

  it("propagates rejected schema-level metadata while clearing the loading state", async () => {
    const listObjects = vi.fn<() => Promise<ObjectInfo[]>>().mockRejectedValue(new Error("metadata access denied"));
    const listTriggers = vi.fn<() => Promise<never[]>>().mockResolvedValue([]);
    const { connection, store } = await createStore({ listObjects, listTriggers });
    const triggerGroup = objectGroup("group-triggers", `${connection.id}:app:app:__triggers`);
    store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, children: [triggerGroup] }];
    const storedTriggerGroup = store.treeNodes[0].children![0];

    await expect(loadSidebarObjectGroup(storedTriggerGroup, store)).rejects.toThrow("metadata access denied");

    expect(listObjects).toHaveBeenCalledWith(connection.id, "app", "app", ["TRIGGER"], undefined, 11, 0);
    expect(listTriggers).not.toHaveBeenCalled();
    expect(storedTriggerGroup).toMatchObject({ isExpanded: false, isLoading: false, children: [] });
  });
});
