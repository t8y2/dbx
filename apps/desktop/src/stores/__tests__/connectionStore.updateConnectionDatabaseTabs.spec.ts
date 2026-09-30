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

function postgresConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "pg-1",
    name: "Reporting",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "secret",
    database: "testdb",
    read_only: false,
    ...overrides,
  } as ConnectionConfig;
}

async function createStores() {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    disconnectDb: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    connectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
  }));
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useQueryStore } = await import("@/stores/queryStore");
  return { connectionStore: useConnectionStore(), queryStore: useQueryStore() };
}

describe("connectionStore updateConnection re-syncs open query tabs' database", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("re-points a tab still on the connection's old default database, but leaves a tab the user pointed elsewhere alone", async () => {
    const { connectionStore, queryStore } = await createStores();
    const connection = postgresConnection();
    connectionStore.connections = [connection];

    // Opened before the edit, still on the connection's original default database (#7905 repro).
    const staleTabId = queryStore.createTab("pg-1", "testdb", "stale query");
    queryStore.setTableMeta(staleTabId, { schema: "public", database: "testdb", tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] });
    // A tab the user explicitly pointed at a different database via the tab's own
    // connection/database switcher — must not be silently reassigned.
    const explicitTabId = queryStore.createTab("pg-1", "reporting_archive", "explicit query", "query", undefined, undefined, undefined, { forceNew: true });

    await connectionStore.updateConnection({ ...connection, database: "hive313" });

    expect(connectionStore.getConfig("pg-1")?.database).toBe("hive313");
    const staleTab = queryStore.tabs.find((tab) => tab.id === staleTabId);
    expect(staleTab?.database).toBe("hive313");
    // The stale snapshot's cached metadata/result state must not survive the switch.
    expect(staleTab?.tableMeta).toBeUndefined();

    const explicitTab = queryStore.tabs.find((tab) => tab.id === explicitTabId);
    expect(explicitTab?.database).toBe("reporting_archive");
  });

  it("does nothing to open tabs when the edited connection's database is unchanged", async () => {
    const { connectionStore, queryStore } = await createStores();
    const connection = postgresConnection();
    connectionStore.connections = [connection];
    const tabId = queryStore.createTab("pg-1", "testdb", "unaffected query");

    await connectionStore.updateConnection({ ...connection, host: "new-host.internal" });

    expect(queryStore.tabs.find((tab) => tab.id === tabId)?.database).toBe("testdb");
  });
});
