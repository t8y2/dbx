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

  it("passes the selected SQL INSERT mode to the backend request", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("kingbase-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.sql = "SELECT id, name FROM users";
    tab.lastExecutedSql = tab.sql;
    tab.result = {
      columns: ["id", "name"],
      rows: [[1, "Ada"]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "export-single",
      filePath: "users.sql",
      format: "sql",
      exportTableName: "users",
      insertMode: "single",
    });

    expect(request?.insertMode).toBe("single");
  });

  it("keeps query execution schema separate from the resolved Oracle INSERT owner", async () => {
    mocks.getConfig.mockReturnValue({
      id: "oracle-1",
      name: "Oracle",
      db_type: "oracle",
      database: "ORCLPDB1",
      default_schema: "CURRENT_USER",
      query_timeout_secs: 30,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCLPDB1", "Query", "query", "CURRENT_USER", "SELECT ID FROM APP_OWNER.USERS");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.lastExecutedSql = tab.sql;
    tab.result = {
      columns: ["ID"],
      rows: [[1]],
      affected_rows: 0,
      execution_time_ms: 1,
    };
    tab.tableMeta = { schema: "APP_OWNER", tableName: "USERS", columns: [], primaryKeys: ["ID"] };
    tab.queryAnalysis = {
      schema: "APP_OWNER",
      tableName: "USERS",
      selectStar: false,
      sources: [{ key: "USERS:0", schema: "APP_OWNER", tableName: "USERS" }],
      columns: [{ sourceName: "ID", resultName: "ID", expression: "ID" }],
    };

    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "oracle-owner-export",
      filePath: "users.sql",
      format: "sql",
      exportTableName: "USERS",
      exportSchema: "APP_OWNER",
    });

    expect(request).toMatchObject({
      databaseType: "oracle",
      database: "ORCLPDB1",
      schema: "CURRENT_USER",
      exportSchema: "APP_OWNER",
      exportTableName: "USERS",
    });
  });

  it("does not use a first source as the INSERT target of a multi-source query", async () => {
    mocks.getConfig.mockReturnValue({
      id: "oracle-1",
      name: "Oracle",
      db_type: "oracle",
      database: "ORCLPDB1",
      default_schema: "CURRENT_USER",
      query_timeout_secs: 30,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("oracle-1", "ORCLPDB1", "Query", "query", "CURRENT_USER", "SELECT U.ID FROM APP_OWNER.USERS U JOIN APP_OWNER.ORDERS O ON O.USER_ID = U.ID");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.lastExecutedSql = tab.sql;
    tab.result = { columns: ["ID"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    tab.tableMeta = { schema: "APP_OWNER", tableName: "USERS", columns: [], primaryKeys: ["ID"] };
    tab.queryAnalysis = {
      schema: "APP_OWNER",
      tableName: "USERS",
      selectStar: false,
      multiSource: true,
      sources: [
        { key: "USERS:0", schema: "APP_OWNER", tableName: "USERS" },
        { key: "ORDERS:1", schema: "APP_OWNER", tableName: "ORDERS" },
      ],
      columns: [{ sourceName: "ID", resultName: "ID", expression: "U.ID" }],
    };

    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "oracle-join-export",
      filePath: "query.sql",
      format: "sql",
      exportTableName: "USERS",
      exportSchema: "APP_OWNER",
    });

    expect(request?.schema).toBe("CURRENT_USER");
    expect(request?.exportTableName).toBeUndefined();
    expect(request?.exportSchema).toBeUndefined();
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

  it("strips the MySQL CLI vertical-output suffix from export re-execution SQL", async () => {
    mocks.getConfig.mockReturnValue({ id: "mysql-1", name: "MySQL", db_type: "mysql", database: "app", query_timeout_secs: 30 });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "Query");
    const tab = store.tabs.find((item) => item.id === tabId)!;
    tab.sql = "SHOW CREATE FUNCTION fun_grade \\G";
    tab.lastExecutedSql = tab.sql;
    tab.result = {
      columns: ["Create Function"],
      rows: [["definition"]],
      affected_rows: 0,
      execution_time_ms: 1,
    };

    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "export-g",
      filePath: "fun.csv",
      format: "csv",
    });

    expect(request?.sql).toBe("SHOW CREATE FUNCTION fun_grade");
    expect(request?.queryBaseSql).toBe("SHOW CREATE FUNCTION fun_grade");
  });
});
