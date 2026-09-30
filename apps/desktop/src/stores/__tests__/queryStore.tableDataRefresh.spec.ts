import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(),
  closeClientConnectionSession: vi.fn(),
  closeQuerySession: vi.fn(),
  executeMulti: vi.fn(),
  getConnectionConfig: vi.fn(),
  saveOpenTabsState: vi.fn(),
  loadTableMetadata: vi.fn(),
  metadataGeneration: 0,
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
    metadataGenerationFor: () => mocks.metadataGeneration,
  }),
}));

vi.mock("@/lib/metadata/tableMetadataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/metadata/tableMetadataCache")>();
  return {
    ...actual,
    loadTableMetadata: mocks.loadTableMetadata,
  };
});

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
    mocks.metadataGeneration = 0;
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

  it("loads a duplicated data tab with its filter, database sort and page without sharing results", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const id = store.createTab("pg-1", "app", "users", "data", "public");
    store.setTableMeta(id, {
      database: "app",
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });
    const original = store.tabs.find((tab) => tab.id === id)!;
    original.whereInput = "status = 'ACTIVE'";
    original.orderByInput = "id DESC";
    original.resultSortColumn = "id";
    original.resultSortDirection = "desc";
    original.resultSortMode = "database";
    original.resultPageLimit = 25;
    original.resultPageOffset = 50;
    original.result = { columns: ["id"], rows: [[99]], affected_rows: 0, execution_time_ms: 1 };
    mocks.executeMulti.mockResolvedValue([{ columns: ["id"], rows: [[42]], affected_rows: 0, execution_time_ms: 1 }]);

    store.duplicateTab(id);
    const copy = store.tabs[1];
    await vi.waitFor(() => expect(copy.result?.rows).toEqual([[42]]));

    expect(copy.id).not.toBe(id);
    expect(copy.mode).toBe("data");
    expect(copy.connectionId).toBe("pg-1");
    expect(copy.database).toBe("app");
    expect(copy.schema).toBe("public");
    expect(store.activeTabId).toBe(copy.id);
    expect(store.groups[0].tabIds).toEqual([id, copy.id]);
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(
      expect.objectContaining({
        whereInput: "status = 'ACTIVE'",
        orderBy: "id DESC",
        limit: 25,
        offset: 50,
      }),
    );
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(original.result?.rows).toEqual([[99]]);
    expect(copy.result).not.toBe(original.result);
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
      injectDefaultTimeSeriesWhere: true,
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

  it("uses JDBC ResultSet offset pagination for dialects that cannot paginate in SQL", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "sybase-1",
      name: "Sybase ASE 16",
      db_type: "jdbc",
      database: "app",
      connection_string: "jdbc:sybase:Tds:db.example.com:5000/app",
      query_timeout_secs: 30,
    });
    mocks.buildTableSelectSql.mockResolvedValue("SELECT * FROM dbo.users ORDER BY id ASC");
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("sybase-1", "app", "users", "data", "dbo");
    store.setTableMeta(tabId, {
      schema: "dbo",
      tableName: "users",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.orderByInput = "id ASC";
    tab.resultPageLimit = 100;
    tab.resultPageOffset = 100;

    await store.refreshDataTab(tabId);

    // Generic JDBC emits a bare SELECT, so the agent has to skip the offset;
    // otherwise page 2 re-renders page 1 (#9015).
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(
      expect.objectContaining({
        databaseType: "jdbc",
        limit: 100,
        offset: 100,
        useDriverRowOffset: true,
      }),
    );
    expect(mocks.executeMulti).toHaveBeenCalledWith("sybase-1", "app", "SELECT * FROM dbo.users ORDER BY id ASC", undefined, expect.any(String), expect.objectContaining({ maxRows: 100, fetchSize: 100, rowOffset: 100 }));
  });

  it("keeps YashanDB JDBC tabs on server-side pagination", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "yasdb-1",
      name: "YashanDB",
      db_type: "jdbc",
      database: "app",
      connection_string: "jdbc:yasdb://localhost:1688/app",
      query_timeout_secs: 30,
    });
    mocks.buildTableSelectSql.mockResolvedValue("SELECT * FROM app.users");
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("yasdb-1", "app", "users", "data");
    store.setTableMeta(tabId, {
      tableName: "users",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.resultPageLimit = 100;
    tab.resultPageOffset = 100;

    await store.refreshDataTab(tabId);

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.not.objectContaining({ useDriverRowOffset: true }));
    expect(mocks.executeMulti).toHaveBeenCalledWith("yasdb-1", "app", "SELECT * FROM app.users", undefined, expect.any(String), expect.not.objectContaining({ rowOffset: expect.anything() }));
  });

  it("continues and restarts Cassandra table cursors without duplicating page one", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "cassandra-1",
      name: "Cassandra",
      db_type: "cassandra",
      database: "app",
      query_timeout_secs: 30,
    });
    mocks.executeMulti
      .mockResolvedValueOnce([{ columns: ["id"], rows: [[1], [2]], affected_rows: 0, execution_time_ms: 1, session_id: "cursor-1", has_more: true }])
      .mockResolvedValueOnce([{ columns: ["id"], rows: [[3], [4]], affected_rows: 0, execution_time_ms: 1, session_id: "cursor-1", has_more: true }])
      .mockResolvedValueOnce([{ columns: ["id"], rows: [[1], [2]], affected_rows: 0, execution_time_ms: 1, session_id: "cursor-2", has_more: true }])
      .mockResolvedValueOnce([{ columns: ["id"], rows: [[3], [4]], affected_rows: 0, execution_time_ms: 1, session_id: "cursor-2", has_more: true }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("cassandra-1", "app", "paged_rows", "data");
    store.setTableMeta(tabId, {
      tableName: "paged_rows",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });
    const sql = 'SELECT * FROM "paged_rows";';

    await store.executeTabSql(tabId, sql, { pagination: { limit: 2, offset: 0 } });
    let tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.result?.rows).toEqual([[1], [2]]);
    expect(tab.resultSessionId).toBe("cursor-1");
    expect(tab.resultClientSessionId).toBe(tabId);

    await store.executeTabSql(tabId, sql, {
      pagination: { limit: 2, offset: 2, sessionId: "cursor-1", clientSessionId: tab.resultClientSessionId },
    });
    tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.result?.rows).toEqual([[3], [4]]);
    expect(mocks.closeQuerySession).not.toHaveBeenCalled();

    await store.executeTabSql(tabId, sql, { pagination: { limit: 2, offset: 0 } });
    tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.result?.rows).toEqual([[1], [2]]);
    expect(mocks.closeQuerySession).toHaveBeenCalledWith("cassandra-1", "app", "cursor-1", tabId);

    await store.executeTabSql(tabId, sql, {
      pagination: { limit: 2, offset: 2, sessionId: "cursor-2", clientSessionId: tab.resultClientSessionId },
    });
    expect(store.tabs.find((candidate) => candidate.id === tabId)?.result?.rows).toEqual([[3], [4]]);
    expect(mocks.executeMulti.mock.calls.map((call) => call[5])).toEqual([
      expect.objectContaining({ maxRows: 2_147_483_647, fetchSize: 2, pageSize: 2, resultSessionId: undefined, clientSessionId: tabId }),
      expect.objectContaining({ maxRows: 2_147_483_647, fetchSize: 2, pageSize: 2, resultSessionId: "cursor-1", clientSessionId: tabId }),
      expect.objectContaining({ maxRows: 2_147_483_647, fetchSize: 2, pageSize: 2, resultSessionId: undefined, clientSessionId: tabId }),
      expect.objectContaining({ maxRows: 2_147_483_647, fetchSize: 2, pageSize: 2, resultSessionId: "cursor-2", clientSessionId: tabId }),
    ]);
  });

  it("replays Cassandra table cursors to direct, last, and exact-boundary pages", async () => {
    mocks.getConnectionConfig.mockReturnValue({ id: "cassandra-1", name: "Cassandra", db_type: "cassandra", database: "app" });
    const page = (rows: number[], sessionId?: string) => ({
      columns: ["id"],
      rows: rows.map((value) => [value]),
      affected_rows: 0,
      execution_time_ms: rows.length,
      session_id: sessionId,
      has_more: !!sessionId,
      query_timings_ms: { agent_total: rows.length },
    });
    mocks.executeMulti
      .mockResolvedValueOnce([page([1, 2], "cursor-last")])
      .mockResolvedValueOnce([page([3, 4], "cursor-last")])
      .mockResolvedValueOnce([page([5])]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("cassandra-1", "app", "paged_rows", "data");
    store.setTableMeta(tabId, {
      tableName: "paged_rows",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });
    const sql = 'SELECT * FROM "paged_rows";';

    await store.executeTabSql(tabId, sql, { pagination: { limit: 2, offset: 4 } });

    let tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.result?.rows).toEqual([[5]]);
    expect(tab.result?.execution_time_ms).toBe(5);
    expect(tab.result?.timing_page_count).toBe(3);
    expect(tab.resultPageOffset).toBe(4);
    expect(tab.resultTotalRowCount).toBe(5);
    expect(mocks.executeMulti.mock.calls.map((call) => call[5]?.resultSessionId)).toEqual([undefined, "cursor-last", "cursor-last"]);

    mocks.executeMulti.mockReset();
    mocks.executeMulti.mockResolvedValueOnce([page([1, 2], "cursor-boundary")]).mockResolvedValueOnce([page([3, 4])]);
    await store.executeTabSql(tabId, sql, { pagination: { limit: 2, offset: 4 } });

    tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.result?.rows).toEqual([]);
    expect(tab.result?.has_more).toBe(false);
    expect(tab.resultPageOffset).toBe(4);
    expect(tab.resultTotalRowCount).toBeUndefined();
    expect(mocks.executeMulti).toHaveBeenCalledTimes(2);
  });

  it("closes a Cassandra replay cursor when a later page fails", async () => {
    mocks.getConnectionConfig.mockReturnValue({ id: "cassandra-1", name: "Cassandra", db_type: "cassandra", database: "app" });
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["id"], rows: [[1], [2]], affected_rows: 0, execution_time_ms: 1, session_id: "cursor-lost", has_more: true }]).mockRejectedValueOnce(new Error("query session not found: cursor-lost"));
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("cassandra-1", "app", "paged_rows", "data");
    store.setTableMeta(tabId, {
      tableName: "paged_rows",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });

    await store.executeTabSql(tabId, 'SELECT * FROM "paged_rows";', { pagination: { limit: 2, offset: 2 } });

    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    expect(tab.result?.execution_error).toBe(true);
    expect(tab.resultSessionId).toBeUndefined();
    expect(mocks.closeQuerySession).toHaveBeenCalledWith("cassandra-1", "app", "cursor-lost", tabId, undefined);
  });

  it.each(["cancellation", "supersession"] as const)("does not dispatch another Cassandra replay page after %s", async (interruption) => {
    mocks.getConnectionConfig.mockReturnValue({ id: "cassandra-1", name: "Cassandra", db_type: "cassandra", database: "app" });
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("cassandra-1", "app", "paged_rows", "data");
    store.setTableMeta(tabId, {
      tableName: "paged_rows",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });
    mocks.executeMulti.mockImplementationOnce(async () => {
      const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
      if (interruption === "cancellation") {
        tab.isCancelling = true;
        tab.cancelRequestCount = (tab.cancelRequestCount ?? 0) + 1;
      } else {
        tab.executionId = "replacement-execution";
      }
      return [{ columns: ["id"], rows: [[1], [2]], affected_rows: 0, execution_time_ms: 1, session_id: "cursor-cancel", has_more: true }];
    });

    await store.executeTabSql(tabId, 'SELECT * FROM "paged_rows";', { pagination: { limit: 2, offset: 4 } });

    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(mocks.closeQuerySession).toHaveBeenCalledWith("cassandra-1", "app", "cursor-cancel", tabId, undefined);
  });

  it("exports Cassandra table data by advancing one Agent cursor", async () => {
    mocks.getConnectionConfig.mockReturnValue({ id: "cassandra-1", name: "Cassandra", db_type: "cassandra", database: "app" });
    mocks.buildTableSelectSql.mockResolvedValue('SELECT * FROM "paged_rows";');
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["id"], rows: [[1], [2]], affected_rows: 0, execution_time_ms: 2, session_id: "export-cursor", has_more: true }]).mockResolvedValueOnce([{ columns: ["id"], rows: [[3]], affected_rows: 0, execution_time_ms: 1, has_more: false }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("cassandra-1", "app", "paged_rows", "data");
    store.setTableMeta(tabId, {
      tableName: "paged_rows",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.result = { columns: ["id"], rows: [[1], [2]], affected_rows: 0, execution_time_ms: 2 };

    const exported = await store.fetchTabResultForExport(tabId);

    expect(exported?.rows).toEqual([[1], [2], [3]]);
    expect(exported?.execution_time_ms).toBe(3);
    expect(mocks.buildTableSelectSql).toHaveBeenCalledTimes(2);
    expect(mocks.executeMulti.mock.calls.map((call) => call[5])).toEqual([
      expect.objectContaining({ maxRows: 2_147_483_647, fetchSize: 10_000, pageSize: 10_000, resultSessionId: undefined, clientSessionId: `${tabId}:export` }),
      expect.objectContaining({ maxRows: 2_147_483_647, fetchSize: 10_000, pageSize: 10_000, resultSessionId: "export-cursor", clientSessionId: `${tabId}:export` }),
    ]);
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith("cassandra-1", "app", `${tabId}:export`);
  });

  it("stops Cassandra table export when continuation has no session", async () => {
    mocks.getConnectionConfig.mockReturnValue({ id: "cassandra-1", name: "Cassandra", db_type: "cassandra", database: "app" });
    mocks.buildTableSelectSql.mockResolvedValue('SELECT * FROM "paged_rows";');
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["id"], rows: [[1], [2]], affected_rows: 0, execution_time_ms: 1, has_more: true }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("cassandra-1", "app", "paged_rows", "data");
    store.setTableMeta(tabId, {
      tableName: "paged_rows",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.result = { columns: ["id"], rows: [[1], [2]], affected_rows: 0, execution_time_ms: 1 };

    await expect(store.fetchTabResultForExport(tabId)).rejects.toThrow("Result session ended before table export completed");
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith("cassandra-1", "app", `${tabId}:export`);
  });

  it.each([{ has_more: undefined }, { has_more: false, truncated: true }, { has_more: true, session_id: " " }])("rejects incomplete Cassandra export continuation %j and cleans its active cursor", async (malformed) => {
    mocks.getConnectionConfig.mockReturnValue({ id: "cassandra-1", name: "Cassandra", db_type: "cassandra", database: "app" });
    mocks.buildTableSelectSql.mockResolvedValue('SELECT * FROM "paged_rows";');
    mocks.executeMulti.mockResolvedValueOnce([{ columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, session_id: "active-cursor", has_more: true }]).mockResolvedValueOnce([{ columns: ["id"], rows: [[2]], affected_rows: 0, execution_time_ms: 1, ...malformed }]);
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("cassandra-1", "app", "paged_rows", "data");
    store.setTableMeta(tabId, {
      tableName: "paged_rows",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    tab.result = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
    await expect(store.fetchTabResultForExport(tabId)).rejects.toThrow(/export/);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(2);
    expect(mocks.closeQuerySession).toHaveBeenCalledWith("cassandra-1", "app", "active-cursor", `${tabId}:export`, undefined);
    expect(mocks.closeClientConnectionSession).toHaveBeenCalledWith("cassandra-1", "app", `${tabId}:export`);
  });

  it("executes Doris external catalog data tabs against the catalog database, not the connection default database", async () => {
    mocks.getConnectionConfig.mockReturnValue({
      id: "doris-1",
      name: "Doris",
      db_type: "doris",
      database: "yunye",
      query_timeout_secs: 30,
    });
    mocks.buildTableSelectSql.mockResolvedValue("SELECT * FROM `ice`.`mydb`.`tt2` LIMIT 100");
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("doris-1", "mydb", "tt2", "data", undefined, undefined, "ice");
    store.setTableMeta(tabId, {
      catalog: "ice",
      tableName: "tt2",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "int", is_nullable: true, column_default: null, is_primary_key: false, extra: null }],
      primaryKeys: [],
    });

    await store.refreshDataTab(tabId);

    // The backend switches catalog first and then runs USE <database>, so the
    // connection's internal default database ("yunye") would fail with 1049.
    expect(mocks.executeMulti).toHaveBeenCalledWith("doris-1", "mydb", "SELECT * FROM `ice`.`mydb`.`tt2` LIMIT 100", undefined, expect.any(String), expect.objectContaining({ catalog: "ice" }));
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

  it("rebuilds the structured sort from persisted tab state on refresh", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    store.setTableMeta(tabId, {
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
    const tab = store.tabs.find((tab) => tab.id === tabId)!;
    tab.orderByInput = '"status" ASC';
    tab.structuredOrderByInput = '"created_at" DESC';

    const refreshed = await store.refreshDataTab(tabId);

    expect(refreshed).toBe(true);
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ orderBy: '"status" ASC, "created_at" DESC' }));
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
    tab.structuredOrderByInput = '"old_name" DESC';
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
    expect(tab.structuredOrderByInput).toBeUndefined();
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

  it("rebuilds table metadata from the new connection before the first reload after a reconnect boundary", async () => {
    const { useQueryStore } = await import("@/stores/queryStore");
    const store = useQueryStore();
    const tabId = store.createTab("pg-1", "app", "users", "data", "public");
    // 断链前的旧结构：只有 [id]
    store.setTableMeta(tabId, {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    });
    const tab = store.tabs.find((candidate) => candidate.id === tabId)!;
    // 外部 ALTER TABLE ... ADD age：DBX 断开→重连。disconnect 会 bump 连接代次
    // 并清 freshness 戳（staleConnectionDataTabMetadata），此处等价模拟：
    // 旧代次(0)的 tableMeta 已与新代次(1)失配，reload 必须重建结构
    mocks.metadataGeneration = 1;
    tab.tableMetaUpdatedAt = undefined;
    mocks.loadTableMetadata.mockResolvedValue({
      metadata: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        database: "app",
        columns: [
          { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
          { name: "age", data_type: "integer", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
        ],
        indexes: [],
        primaryKeys: ["id"],
        cachedAt: Date.now(),
      },
      cacheStatus: "miss",
      ageMs: 0,
    });

    await store.refreshDataTab(tabId);

    // 重建从新连接源头强制拉取（force），不再使用旧显式列列表
    expect(mocks.loadTableMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.loadTableMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "pg-1",
        database: "app",
        schema: "public",
        tableName: "users",
        force: true,
      }),
    );
    // 重建后的新列 [id, age] 进入 SQL 构建并写回 tab
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ columns: ["id", "age"] }));
    expect(tab.tableMeta?.columns.map((column) => column.name)).toEqual(["id", "age"]);
    expect(tab.tableMetaUpdatedAt).toBeDefined();
    expect(tab.tableMetaGeneration).toBe(1);
  });

  it("does not rebuild metadata on a warm reload in the same connection generation", async () => {
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

    await store.refreshDataTab(tabId);

    // 同代次（0）内正常刷新：直接复用 tab 元数据，不重新拉取结构
    expect(mocks.loadTableMetadata).not.toHaveBeenCalled();
    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ columns: ["id"] }));
  });

  it("abandons a forced metadata rebuild when generation changes mid-flight", async () => {
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
    mocks.metadataGeneration = 1;
    tab.tableMetaUpdatedAt = undefined;
    let resolveMetadata!: (value: Awaited<ReturnType<typeof mocks.loadTableMetadata>>) => void;
    mocks.loadTableMetadata.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveMetadata = resolve;
      }),
    );

    const refresh = store.refreshDataTab(tabId);
    await vi.waitFor(() => expect(mocks.loadTableMetadata).toHaveBeenCalledTimes(1));
    mocks.metadataGeneration = 2;
    resolveMetadata({
      metadata: {
        schema: "public",
        tableName: "users",
        tableType: "TABLE",
        database: "app",
        columns: [
          { name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
          { name: "age", data_type: "integer", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
        ],
        indexes: [],
        primaryKeys: ["id"],
        cachedAt: Date.now(),
      },
      cacheStatus: "miss",
      ageMs: 0,
    });
    await expect(refresh).resolves.toBe(false);

    expect(tab.tableMeta?.columns.map((column) => column.name)).toEqual(["id"]);
    expect(tab.tableMetaUpdatedAt).toBeUndefined();
    expect(mocks.buildTableSelectSql).not.toHaveBeenCalled();
    expect(mocks.executeMulti).not.toHaveBeenCalled();
  });
});
