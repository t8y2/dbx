import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TreeNode } from "@/types/database";
import { XUGU_PUBLIC_SYNONYM_SCOPE } from "@/lib/sidebar/xuguPublicSynonyms";

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
    id: "postgres-1",
    name: "PostgreSQL",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app",
  };
}

function xuguConnection(): ConnectionConfig {
  return {
    ...postgresConnection(),
    id: "xugu-1",
    name: "Xugu",
    db_type: "xugu",
    port: 5138,
    username: "SYSDBA",
    database: "SYSTEM",
  };
}

describe("connectionStore default schema", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("persists set and clear, keeps the connection active, and orders the default schema first", async () => {
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections,
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = postgresConnection();
    store.addEphemeralConnection(connection);
    store.sidebarLayout = { groups: [], order: [{ type: "connection", id: connection.id }] };
    store.treeNodes = [
      {
        id: connection.id,
        label: connection.name,
        type: "connection",
        connectionId: connection.id,
        children: [
          {
            id: `${connection.id}:${connection.database}`,
            label: connection.database!,
            type: "database",
            connectionId: connection.id,
            database: connection.database,
            children: [
              { id: "schema-archive", label: "archive", type: "schema", connectionId: connection.id, database: connection.database, schema: "archive" },
              { id: "schema-public", label: "public", type: "schema", connectionId: connection.id, database: connection.database, schema: "public" },
            ],
          },
        ],
      },
    ];
    const schemaLabels = () => (store.treeNodes[0]?.children?.[0]?.children || []).filter((node: TreeNode) => node.type === "schema").map((node: TreeNode) => node.label);

    await store.setDefaultSchema(connection.id, " public ");

    expect(store.getConfig(connection.id)?.default_schema).toBe("public");
    expect(store.isDefaultSchema(connection.id, "public")).toBe(true);
    expect(store.connectedIds.has(connection.id)).toBe(true);
    expect(schemaLabels()).toEqual(["public", "archive"]);
    expect(saveConnections).toHaveBeenLastCalledWith([expect.objectContaining({ id: connection.id, default_schema: "public" })]);

    await store.clearDefaultSchema(connection.id);

    expect(store.getConfig(connection.id)?.default_schema).toBeUndefined();
    expect(store.connectedIds.has(connection.id)).toBe(true);
    expect(schemaLabels()).toEqual(["archive", "public"]);
    expect(saveConnections).toHaveBeenLastCalledWith([expect.objectContaining({ id: connection.id, default_schema: undefined })]);
  });

  it("does not persist the synthetic Xugu public-synonym scope as a default schema", async () => {
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections,
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const connection = xuguConnection();
    store.addEphemeralConnection(connection);

    await store.setDefaultSchema(connection.id, XUGU_PUBLIC_SYNONYM_SCOPE);

    expect(store.getConfig(connection.id)?.default_schema).toBeUndefined();
    expect(saveConnections).not.toHaveBeenCalled();
  });
});
