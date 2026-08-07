import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

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

describe("connectionStore default schema", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("persists set and clear without disconnecting the active connection", async () => {
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

    await store.setDefaultSchema(connection.id, " archive ");

    expect(store.getConfig(connection.id)?.default_schema).toBe("archive");
    expect(store.isDefaultSchema(connection.id, "archive")).toBe(true);
    expect(store.connectedIds.has(connection.id)).toBe(true);
    expect(saveConnections).toHaveBeenLastCalledWith([expect.objectContaining({ id: connection.id, default_schema: "archive" })]);

    await store.clearDefaultSchema(connection.id);

    expect(store.getConfig(connection.id)?.default_schema).toBeUndefined();
    expect(store.connectedIds.has(connection.id)).toBe(true);
    expect(saveConnections).toHaveBeenLastCalledWith([expect.objectContaining({ id: connection.id, default_schema: undefined })]);
  });
});
