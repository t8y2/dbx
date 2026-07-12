import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, ObjectInfo, TableInfo, TreeNode } from "@/types/database";

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

function procedure(name: string): ObjectInfo {
  return {
    name,
    object_type: "PROCEDURE",
    schema: "app",
    comment: null,
    created_at: null,
    updated_at: null,
    parent_schema: null,
    parent_name: null,
  };
}

describe("connectionStore metadata loading", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("renders simple-mode table children without waiting for supplemental objects", async () => {
    const tables: TableInfo[] = [{ name: "users", table_type: "TABLE", comment: null }];
    const listTables = vi.fn().mockResolvedValue(tables);
    const listObjects = vi.fn(() => new Promise(() => undefined));

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listObjects,
      listTables,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.sidebarObjectDisplay = "simple";

    const connection = postgresConnection();
    const schemaNode: TreeNode = {
      id: "pg-1:app:public",
      label: "public",
      type: "schema",
      connectionId: connection.id,
      database: "app",
      schema: "public",
      isExpanded: false,
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
            id: "pg-1:app",
            label: "app",
            type: "database",
            connectionId: connection.id,
            database: "app",
            isExpanded: true,
            children: [schemaNode],
          },
        ],
      },
    ];

    const result = await Promise.race([store.loadTables(connection.id, "app", "public").then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("timeout"), 50))]);

    expect(result).toBe("done");
    expect(listTables).toHaveBeenCalledWith(connection.id, "app", "public", undefined, 1001, 0);
    expect(listObjects).toHaveBeenCalled();
    expect(schemaNode.children?.map((node) => node.label)).toEqual(["users"]);
  });

  it("paginates procedure groups and appends the next page", async () => {
    const firstPage = Array.from({ length: 201 }, (_, index) => procedure(`p_${String(index + 1).padStart(4, "0")}`));
    const listObjects = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([procedure("p_0201"), procedure("p_0202")])
      .mockResolvedValueOnce([procedure("p_0999")]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      listObjects,
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.sidebarObjectDisplay = "grouped";
    settingsStore.desktopSettings.sidebar_table_page_size = 200;

    const connection = mysqlConnection();
    const procedureGroup: TreeNode = {
      id: "mysql-1:app:__procedures",
      label: "tree.procedures",
      type: "group-procedures",
      connectionId: connection.id,
      database: "app",
      isExpanded: false,
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
            id: "mysql-1:app",
            label: "app",
            type: "database",
            connectionId: connection.id,
            database: "app",
            isExpanded: true,
            children: [procedureGroup],
          },
        ],
      },
    ];

    const storedProcedureGroup = store.treeNodes[0].children?.[0].children?.[0];
    expect(storedProcedureGroup?.type).toBe("group-procedures");
    await store.loadObjectGroupChildren(storedProcedureGroup!);

    expect(listObjects).toHaveBeenNthCalledWith(1, connection.id, "app", "app", ["PROCEDURE"], undefined, 201, 0);
    expect(storedProcedureGroup?.children).toHaveLength(201);
    expect(storedProcedureGroup?.children?.[0].label).toBe("p_0001");
    expect(storedProcedureGroup?.children?.[199].label).toBe("p_0200");
    expect(storedProcedureGroup?.children?.[200].label).toBe("tree.loadMore");

    const loadMoreNode = storedProcedureGroup?.children?.at(-1);
    expect(loadMoreNode?.type).toBe("load-more");
    await store.loadMoreObjectGroupChildren(loadMoreNode!);

    expect(listObjects).toHaveBeenNthCalledWith(2, connection.id, "app", "app", ["PROCEDURE"], undefined, 201, 200);
    expect(storedProcedureGroup?.children).toHaveLength(202);
    expect(storedProcedureGroup?.children?.at(-1)?.label).toBe("p_0202");

    store.sidebarSearchQuery = "p_0999";
    await store.loadObjectGroupChildren(storedProcedureGroup!, { force: true, searchFilter: "p_0999" });

    expect(listObjects).toHaveBeenNthCalledWith(3, connection.id, "app", "app", ["PROCEDURE"], "p_0999", undefined, undefined);
    expect(storedProcedureGroup?.children?.map((node) => node.label)).toEqual(["p_0999"]);
  });
});
