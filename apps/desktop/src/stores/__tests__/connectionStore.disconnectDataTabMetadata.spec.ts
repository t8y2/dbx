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

function pgConnection(id: string): ConnectionConfig {
  return {
    id,
    name: id,
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app",
    read_only: false,
  } as ConnectionConfig;
}

describe("connectionStore disconnect data-tab metadata freshness", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("disconnect keeps an unsaved query pending until the user resolves scoped close", async () => {
    const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);
    const disconnectDb = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      disconnectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.disconnectTabHandlingMode = "close-tabs";
    store.connections = [pgConnection("conn-a"), pgConnection("conn-b")];
    store.connectedIds.add("conn-a");

    const queryStore = useQueryStore();
    const queryId = queryStore.createTab("conn-a", "app", "draft query");
    queryStore.updateSql(queryId, "select 1;");
    const outsideId = queryStore.createTab("conn-b", "app", "outside");

    await store.disconnect("conn-a");

    expect(disconnectDb).toHaveBeenCalledWith("conn-a", undefined);
    expect(store.connectedIds.has("conn-a")).toBe(false);
    expect(queryStore.showCloseConfirm).toBe(true);
    expect(queryStore.pendingCloseTabId).toBe(queryId);
    expect(queryStore.tabs.map((tab) => tab.id)).toEqual([queryId, outsideId]);

    queryStore.forceCloseAllPendingTabs();
    expect(queryStore.tabs.map((tab) => tab.id)).toEqual([outsideId]);
  }, 10_000);

  it("clears data-tab metadata freshness for the disconnected connection only", async () => {
    const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);
    const disconnectDb = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      disconnectDb,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    // keep-tabs：数据标签页在断开后继续存在，是 tab-local 元数据跨 reconnect
    // 存活的场景（default close-tabs 会直接关掉标签页，不存在该问题）
    useSettingsStore().editorSettings.disconnectTabHandlingMode = "keep-tabs-clear-results";

    const connectionA = pgConnection("conn-a");
    const connectionB = pgConnection("conn-b");
    store.connections = [connectionA, connectionB];

    const queryStore = useQueryStore();
    const tabA = queryStore.createTab("conn-a", "app", "users", "data", "public", undefined, undefined, { forceNew: true });
    const tabB = queryStore.createTab("conn-b", "app", "orders", "data", "public", undefined, undefined, { forceNew: true });
    queryStore.setTableMeta(tabA, { schema: "public", database: "app", tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] });
    queryStore.setTableMeta(tabB, { schema: "public", database: "app", tableName: "orders", tableType: "TABLE", columns: [], primaryKeys: [] });
    expect(queryStore.tabs.find((tab) => tab.id === tabA)?.tableMetaUpdatedAt).toBeDefined();
    expect(queryStore.tabs.find((tab) => tab.id === tabB)?.tableMetaUpdatedAt).toBeDefined();

    store.connectedIds.add("conn-a");
    await store.disconnect("conn-a");

    // conn-a 的 data tab：freshness 戳被清除（重连后重开必须重新拉取结构）
    expect(queryStore.tabs.find((tab) => tab.id === tabA)?.tableMetaUpdatedAt).toBeUndefined();
    // conn-b 不受影响：缓存保持 warm
    expect(queryStore.tabs.find((tab) => tab.id === tabB)?.tableMetaUpdatedAt).toBeDefined();
    expect(disconnectDb).toHaveBeenCalledWith("conn-a", undefined);
  }, 10_000);

  it("clears data-tab metadata freshness for a closed database only", async () => {
    const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);
    const closeDatabaseConnection = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      closeDatabaseConnection,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.disconnectTabHandlingMode = "keep-tabs-clear-results";

    const connection = pgConnection("conn-a");
    store.connections = [connection];

    const queryStore = useQueryStore();
    const tabApp = queryStore.createTab("conn-a", "app", "users", "data", "public", undefined, undefined, { forceNew: true });
    const tabOther = queryStore.createTab("conn-a", "other", "orders", "data", "public", undefined, undefined, { forceNew: true });
    queryStore.setTableMeta(tabApp, { schema: "public", database: "app", tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] });
    queryStore.setTableMeta(tabOther, { schema: "public", database: "other", tableName: "orders", tableType: "TABLE", columns: [], primaryKeys: [] });
    expect(queryStore.tabs.find((tab) => tab.id === tabApp)?.tableMetaUpdatedAt).toBeDefined();
    expect(queryStore.tabs.find((tab) => tab.id === tabOther)?.tableMetaUpdatedAt).toBeDefined();

    store.connectedIds.add("conn-a");
    await store.closeDatabaseConnection("conn-a", "app");

    expect(queryStore.tabs.find((tab) => tab.id === tabApp)?.tableMetaUpdatedAt).toBeUndefined();
    expect(queryStore.tabs.find((tab) => tab.id === tabOther)?.tableMetaUpdatedAt).toBeDefined();
    expect(closeDatabaseConnection).toHaveBeenCalledWith("conn-a", "app");
  }, 10_000);

  it("treats markConnectionLost as a metadata lifecycle boundary for one connection only", async () => {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/backend/api")>();
      return {
        ...actual,
        checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
        getColumns: vi.fn().mockResolvedValue([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]),
        listIndexes: vi.fn().mockResolvedValue([]),
        listInstalledAgents: vi.fn().mockResolvedValue([]),
        listInstalledAgentsLocal: vi.fn().mockResolvedValue([]),
        deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
        saveConnections: vi.fn().mockResolvedValue(undefined),
        saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      };
    });

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const { loadTableMetadata, getCachedTableMetadata, clearTableMetadataCache } = await import("@/lib/metadata/tableMetadataCache");
    clearTableMetadataCache();
    const store = useConnectionStore();
    useSettingsStore().editorSettings.disconnectTabHandlingMode = "keep-tabs-clear-results";

    store.connections = [pgConnection("conn-a"), pgConnection("conn-b")];
    const queryStore = useQueryStore();
    const tabA = queryStore.createTab("conn-a", "app", "users", "data", "public", undefined, undefined, { forceNew: true });
    const tabB = queryStore.createTab("conn-b", "app", "orders", "data", "public", undefined, undefined, { forceNew: true });
    queryStore.setTableMeta(tabA, { schema: "public", database: "app", tableName: "users", tableType: "TABLE", columns: [], primaryKeys: [] });
    queryStore.setTableMeta(tabB, { schema: "public", database: "app", tableName: "orders", tableType: "TABLE", columns: [], primaryKeys: [] });
    const generationBeforeA = store.metadataGenerationFor("conn-a", "app");
    const generationBeforeB = store.metadataGenerationFor("conn-b", "app");

    await loadTableMetadata({
      connectionId: "conn-a",
      database: "app",
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      databaseType: "postgres",
    });
    expect(
      getCachedTableMetadata({
        connectionId: "conn-a",
        database: "app",
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        databaseType: "postgres",
      }),
    ).toBeDefined();

    store.connectedIds.add("conn-a");
    store.markConnectionLost("conn-a", new Error("connection lost"));
    await vi.waitFor(() => {
      expect(queryStore.tabs.find((tab) => tab.id === tabA)?.tableMetaUpdatedAt).toBeUndefined();
    });

    expect(store.metadataGenerationFor("conn-a", "app")).toBeGreaterThan(generationBeforeA);
    expect(store.metadataGenerationFor("conn-b", "app")).toBe(generationBeforeB);
    expect(queryStore.tabs.find((tab) => tab.id === tabB)?.tableMetaUpdatedAt).toBeDefined();
    expect(
      getCachedTableMetadata({
        connectionId: "conn-a",
        database: "app",
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        databaseType: "postgres",
      }),
    ).toBeUndefined();
  }, 10_000);
});
