import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureConnected: vi.fn(),
  getConfig: vi.fn(),
  connectionIdentifierQuote: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: mocks.ensureConnected,
    getConfig: mocks.getConfig,
    connectionIdentifierQuote: mocks.connectionIdentifierQuote,
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: {
      exportBatchSize: 1000,
      exportRowLimitEnabled: false,
      exportRowLimit: 100_000,
      globalQueryTimeoutSecs: 30,
      queryExportKeysetOptimizationEnabled: true,
      numericColumnRightAlign: true,
    },
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

describe("queryStore query result export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installLocalStorage();
    setActivePinia(createPinia());
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.getConfig.mockReturnValue({ id: "kingbase-1", name: "Kingbase", db_type: "kingbase", database: "app", query_timeout_secs: 30 });
    mocks.connectionIdentifierQuote.mockReturnValue("[");
  });

  it("passes the live connection identifier quote to backend SQL export", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.sql = "SELECT select FROM audit_log";
    tab.lastExecutedSql = tab.sql;
    tab.result = {
      columns: ["select"],
      rows: [["value"]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "export-1",
      filePath: "audit.sql",
      format: "sql",
      exportTableName: "audit_log",
      exportColumnTypes: ["text"],
    });

    expect(request?.identifierQuote).toBe("[");
    expect(mocks.connectionIdentifierQuote).toHaveBeenCalledWith("kingbase-1");
  });

  it("uses the Agent cursor for SQL Server legacy result export", async () => {
    mocks.getConfig.mockReturnValue({
      id: "sqlserver-2000",
      name: "SQL Server 2000",
      db_type: "sqlserver",
      driver_profile: "sqlserver-legacy",
      database: "master",
      query_timeout_secs: 30,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sqlserver-2000", "master", "Query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.sql = "SELECT * FROM dbo.Users";
    tab.lastExecutedSql = tab.sql;
    tab.result = {
      columns: ["id"],
      rows: [[1]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "export-legacy",
      filePath: "users.csv",
      format: "csv",
    });

    expect(request?.useAgentCursor).toBe(true);
  });
});
