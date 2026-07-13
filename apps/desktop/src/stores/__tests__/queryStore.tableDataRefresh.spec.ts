import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  executeMulti: vi.fn(),
  getConnectionConfig: vi.fn(),
  saveOpenTabsState: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  buildTableSelectSql: mocks.buildTableSelectSql,
  closeClientConnectionSession: mocks.closeClientConnectionSession,
  closeQuerySession: mocks.closeQuerySession,
  executeMulti: mocks.executeMulti,
  saveOpenTabsState: mocks.saveOpenTabsState,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: mocks.getConnectionConfig,
    recordConnectionLostError: vi.fn(),
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { pageSize: 100 },
  }),
}));

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

describe("queryStore table data refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.getConnectionConfig.mockReturnValue({
      id: "pg-1",
      name: "Postgres",
      db_type: "postgres",
      database: "app",
      query_timeout_secs: 30,
    });
    mocks.buildTableSelectSql.mockResolvedValue("SELECT id, status FROM public.users WHERE status = 'ACTIVE' ORDER BY created_at DESC LIMIT 25 OFFSET 50");
    mocks.executeMulti.mockResolvedValue([
      {
        columns: ["id", "status"],
        rows: [],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);
  });

  it("refreshes only matching data tabs after a table mutation", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();

    const publicTabId = store.createTab("pg-1", "app", "users", "data", "public");
    store.setTableMeta(publicTabId, {
      database: "analytics",
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [
        { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "status", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ],
      primaryKeys: ["id"],
    });
    const publicTab = store.tabs.find((tab) => tab.id === publicTabId)!;
    publicTab.whereInput = "status = 'ACTIVE'";
    publicTab.orderByInput = "created_at DESC";
    publicTab.resultPageLimit = 25;
    publicTab.resultPageOffset = 50;

    const archiveTabId = store.createTab("pg-1", "app", "users", "data", "archive");
    store.setTableMeta(archiveTabId, {
      schema: "archive",
      tableName: "users",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });

    const refreshed = await store.refreshDataTabsForTable({
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      name: "users",
    });

    expect(refreshed).toBe(1);
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith({
      databaseType: "postgres",
      identifierQuote: undefined,
      database: "analytics",
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      catalog: undefined,
      columns: ["id", "status"],
      primaryKeys: ["id"],
      includeRowId: false,
      whereInput: "status = 'ACTIVE'",
      orderBy: "created_at DESC",
      limit: 25,
      offset: 50,
    });
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(store.tabs.find((tab) => tab.id === publicTabId)?.result?.rows).toEqual([]);
    expect(store.tabs.find((tab) => tab.id === archiveTabId)?.result).toBeUndefined();
  });
});
