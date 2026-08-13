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
    editorSettings: { pageSize: 1000 },
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
        { name: "created_at", data_type: "timestamp", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
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
      columns: ["id", "status", "created_at"],
      columnTypes: ["integer", "text", "timestamp"],
      primaryKeys: ["id"],
      largeValuePreviewSize: 8192,
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

  it("uses JDBC ResultSet offset pagination for Caché data tabs", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "cache-1",
      name: "Caché 2016",
      db_type: "jdbc",
      database: "USER",
      connection_string: "jdbc:Cache://localhost:1972/USER",
      query_timeout_secs: 30,
    });
    mocks.buildTableSelectSql.mockResolvedValue('SELECT * FROM "SS"."SS_User" ORDER BY "ID" ASC');
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("cache-1", "USER", "SS_User", "data", "SS");
    store.setTableMeta(tabId, {
      schema: "SS",
      tableName: "SS_User",
      tableType: "TABLE",
      columns: [{ name: "ID", data_type: "%Library.Integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["ID"],
    });
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.orderByInput = '"ID" ASC';
    tab.resultPageLimit = 100;
    tab.resultPageOffset = 100;

    await store.refreshDataTab(tabId);

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseType: "iris",
        limit: 100,
        offset: 100,
        useDriverRowOffset: true,
      }),
    );
    expect(mocks.executeMulti).toHaveBeenCalledWith("cache-1", "USER", 'SELECT * FROM "SS"."SS_User" ORDER BY "ID" ASC', undefined, expect.any(String), expect.objectContaining({ maxRows: 100, fetchSize: 100, rowOffset: 100 }));
  });

  it("refreshes one targeted tab while preserving its query context", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const firstTabId = store.createTab("pg-1", "app", "users", "data", "public");
    const secondTabId = store.createTab("pg-1", "app", "users-copy", "data", "public");
    for (const tabId of [firstTabId, secondTabId]) {
      store.setTableMeta(tabId, {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        columns: [
          { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
          { name: "created_at", data_type: "timestamp", is_nullable: false, column_default: null, is_primary_key: false, extra: null },
        ],
        primaryKeys: ["id"],
      });
    }
    const firstTab = store.tabs.find((tab) => tab.id === firstTabId)!;
    firstTab.whereInput = "status = 'ACTIVE'";
    firstTab.resultSortColumn = "created_at";
    firstTab.resultSortDirection = "desc";
    firstTab.resultPageLimit = 25;
    firstTab.resultPageOffset = 50;

    const refreshed = await store.refreshDataTab(firstTabId);

    expect(refreshed).toBe(true);
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(
      expect.objectContaining({
        whereInput: "status = 'ACTIVE'",
        orderBy: '"created_at" DESC',
        limit: 25,
        offset: 50,
      }),
    );
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(store.tabs.find((tab) => tab.id === firstTabId)?.result?.rows).toEqual([]);
    expect(store.tabs.find((tab) => tab.id === secondTabId)?.result).toBeUndefined();
  });

  it("keeps the configured MySQL page size when results contain large-value previews", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "mysql-1",
      name: "MySQL",
      db_type: "mysql",
      database: "app",
      query_timeout_secs: 30,
    });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "app", "users", "data");
    store.setTableMeta(tabId, {
      tableName: "users",
      tableType: "TABLE",
      columns: [
        { name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "payload", data_type: "longtext", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ],
      primaryKeys: ["id"],
    });
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.resultPageLimit = 100;
    tab.resultPageOffset = 0;
    mocks.executeMulti.mockResolvedValueOnce([
      {
        columns: ["id", "payload"],
        rows: Array.from({ length: 100 }, (_, index) => [String(index + 1), "preview..."]),
        large_value_cells: Array.from({ length: 100 }, (_, index) => ({ row_index: index, column_index: 1, original_bytes: 1_000_000 })),
        affected_rows: 100,
        execution_time_ms: 1,
      },
    ]);

    await expect(store.refreshDataTab(tabId)).resolves.toBe(true);

    expect(tab.result?.rows).toHaveLength(100);
    expect(tab.resultPageLimit).toBe(100);
    expect(mocks.executeMulti).toHaveBeenCalledWith(
      "mysql-1",
      "app",
      expect.any(String),
      undefined,
      expect.any(String),
      expect.objectContaining({
        maxRows: 100,
        fetchSize: 100,
        maxResultBytes: 32 * 1024 * 1024,
        resultKeyColumns: ["id"],
      }),
    );
  });

  it("keeps a MySQL table refresh unqualified in the selected database context", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "mysql-1",
      name: "MySQL Proxy",
      db_type: "mysql",
      database: "yf_db",
      query_timeout_secs: 30,
    });
    mocks.buildTableSelectSql.mockResolvedValue("SELECT * FROM `zcyy_write_off_record` LIMIT 100;");
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("mysql-1", "yf_db", "zcyy_write_off_record", "data");
    store.setTableMeta(tabId, {
      database: "yf_db",
      schema: undefined,
      tableName: "zcyy_write_off_record",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "bigint", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });

    await expect(store.refreshDataTab(tabId)).resolves.toBe(true);

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "mysql", database: "yf_db", schema: undefined, tableName: "zcyy_write_off_record" }));
    expect(store.tabs.find((tab) => tab.id === tabId)?.sql).toBe("SELECT * FROM `zcyy_write_off_record` LIMIT 100;");
  });

  it("clears a structured sort when refreshed table metadata no longer contains its column", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [
        { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "old_name", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ],
      primaryKeys: ["id"],
    });
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.whereInput = "id > 0";
    tab.orderByInput = '"old_name" ASC';
    tab.resultSortColumn = "old_name";
    tab.resultSortColumnIndex = 1;
    tab.resultSortDirection = "asc";
    tab.resultSortMode = "database";
    tab.resultSortedSql = 'SELECT * FROM public.users ORDER BY "old_name" ASC';
    tab.resultLocalSortOriginalRows = [[1, "alpha"]];
    tab.resultLocalSortOriginalLargeValueCells = [{ row_index: 0, column_index: 1, original_bytes: 1_000_000 }];
    tab.resultLocalSortOriginalMongoDocuments = [{ id: 1, old_name: "alpha" }];
    tab.resultLocalSortOriginalMongoCopyDocuments = [{ id: 1, old_name: "alpha" }];
    tab.resultPageLimit = 25;
    tab.resultPageOffset = 50;

    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [
        { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "new_name", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ],
      primaryKeys: ["id"],
    });

    expect(tab.resultSortColumn).toBeUndefined();
    expect(tab.resultSortColumnIndex).toBeUndefined();
    expect(tab.resultSortDirection).toBeUndefined();
    expect(tab.resultSortMode).toBeUndefined();
    expect(tab.resultSortedSql).toBeUndefined();
    expect(tab.resultLocalSortOriginalRows).toBeUndefined();
    expect(tab.resultLocalSortOriginalLargeValueCells).toBeUndefined();
    expect(tab.resultLocalSortOriginalMongoDocuments).toBeUndefined();
    expect(tab.resultLocalSortOriginalMongoCopyDocuments).toBeUndefined();
    expect(tab.orderByInput).toBeUndefined();
    expect(tab.whereInput).toBe("id > 0");
    expect(tab.resultPageLimit).toBe(25);
    expect(tab.resultPageOffset).toBe(50);
  });

  it("preserves manual conditions when metadata changes without an invalid structured sort", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.whereInput = "id > 0";
    tab.orderByInput = "LOWER(name) ASC";

    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });

    expect(tab.whereInput).toBe("id > 0");
    expect(tab.orderByInput).toBe("LOWER(name) ASC");
  });

  it("preserves a manual order when only residual structured sort state is invalid", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.resultSortColumn = "old_name";
    tab.resultSortColumnIndex = 1;
    tab.resultSortDirection = "asc";
    tab.resultSortMode = "database";
    tab.orderByInput = "LOWER(new_name) ASC";

    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [
        { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "new_name", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ],
      primaryKeys: ["id"],
    });

    expect(tab.resultSortColumn).toBeUndefined();
    expect(tab.resultSortDirection).toBeUndefined();
    expect(tab.orderByInput).toBe("LOWER(new_name) ASC");
  });

  it("clears quoted sorts after a case-only column rename", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.resultSortColumn = "DisplayName";
    tab.resultSortColumnIndex = 1;
    tab.resultSortDirection = "asc";
    tab.resultSortMode = "database";
    tab.orderByInput = '"DisplayName" ASC';

    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [
        { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "displayname", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ],
      primaryKeys: ["id"],
    });

    expect(tab.resultSortColumn).toBeUndefined();
    expect(tab.resultSortDirection).toBeUndefined();
    expect(tab.orderByInput).toBeUndefined();
  });

  it("drops restored stale sort state before building a table refresh query", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [
        { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "new_name", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ],
      primaryKeys: ["id"],
    });
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.resultSortColumn = "old_name";
    tab.resultSortColumnIndex = 1;
    tab.resultSortDirection = "asc";
    tab.resultSortMode = "database";
    tab.orderByInput = '"old_name" ASC';

    await expect(store.refreshDataTab(tabId)).resolves.toBe(true);

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ orderBy: undefined }));
    expect(tab.resultSortColumn).toBeUndefined();
    expect(tab.resultSortDirection).toBeUndefined();
    expect(tab.orderByInput).toBeUndefined();
  });

  it("drops a stale generated order even when the structured sort state was already cleared", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [
        { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
        { name: "new_name", data_type: "text", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
      ],
      primaryKeys: ["id"],
    });
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.orderByInput = '"old_name" ASC';

    await expect(store.refreshDataTab(tabId)).resolves.toBe(true);

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ orderBy: undefined }));
    expect(tab.orderByInput).toBeUndefined();
  });

  it("uses the table-open default when a refreshed data tab has no saved pagination", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });

    await expect(store.refreshDataTab(tabId)).resolves.toBe(true);

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
        offset: 0,
      }),
    );
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(store.tabs.find((tab) => tab.id === tabId)?.resultPageLimit).toBe(100);
  });

  it("rejects a repeated refresh while SQL construction is in progress", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });
    let resolveSql!: (sql: string) => void;
    mocks.buildTableSelectSql.mockReturnValueOnce(new Promise((resolve) => (resolveSql = resolve)));

    const firstRefresh = store.refreshDataTab(tabId);
    expect(store.tabs.find((tab) => tab.id === tabId)?.isExecuting).toBe(true);
    await expect(store.refreshDataTab(tabId)).resolves.toBe(false);
    expect(mocks.buildTableSelectSql).toHaveBeenCalledTimes(1);
    expect(mocks.executeMulti).not.toHaveBeenCalled();

    resolveSql("SELECT id FROM public.users LIMIT 100 OFFSET 0");
    await expect(firstRefresh).resolves.toBe(true);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
  });

  it("returns false for SQL build failures, stores an error result, and clears the busy state", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [],
      primaryKeys: [],
    });
    mocks.buildTableSelectSql.mockRejectedValueOnce(new Error("failed to build refresh SQL"));

    await expect(store.refreshDataTab(tabId)).resolves.toBe(false);

    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.isExecuting).toBe(false);
    expect(tab.executionId).toBeUndefined();
    expect(tab.result?.execution_error).toBe(true);
    expect(tab.result?.rows).toEqual([["failed to build refresh SQL"]]);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });

  it("keeps the bulk refresh supersede and count behavior for busy matching tabs", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.isExecuting = true;
    tab.executionId = "previous-execution";

    await expect(
      store.refreshDataTabsForTable({
        connectionId: "pg-1",
        database: "app",
        schema: "public",
        name: "users",
      }),
    ).resolves.toBe(1);

    expect(mocks.buildTableSelectSql).toHaveBeenCalledTimes(1);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(tab.isExecuting).toBe(false);
    expect(tab.executionId).toBeUndefined();
  });

  it("keeps bulk SQL build failures observable to callers", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [],
      primaryKeys: [],
    });
    mocks.buildTableSelectSql.mockRejectedValueOnce(new Error("bulk refresh SQL failed"));

    await expect(
      store.refreshDataTabsForTable({
        connectionId: "pg-1",
        database: "app",
        schema: "public",
        name: "users",
      }),
    ).rejects.toThrow("bulk refresh SQL failed");

    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.isExecuting).toBe(false);
    expect(tab.result?.execution_error).toBe(true);
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });
});
