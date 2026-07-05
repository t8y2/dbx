import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TableInfo, TreeNode } from "@/types/database";

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
});
