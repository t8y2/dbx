import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeEditableQueryEditability as analyzeSql } from "@/lib/sql/sqlAnalysis";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getColumns: vi.fn(),
  listIndexes: vi.fn(),
  executeMulti: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  analyzeEditableQueryEditability: vi.fn(async (sql: string) => analyzeSql(sql)),
  getColumns: mocks.getColumns,
  listIndexes: mocks.listIndexes,
  executeMulti: mocks.executeMulti,
  listObjects: vi.fn().mockResolvedValue([]),
  listTables: vi.fn().mockResolvedValue([]),
  prepareQueryPaginationExecutionPlan: vi.fn(async (options) => ({ sqlToExecute: options.sql, useAgentResultSession: false })),
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    getConfig: mocks.getConfig,
    lookupLocalCompletionTables: () => [],
    recordConnectionLostError: vi.fn(),
    metadataGenerationFor: () => 0,
  }),
}));
vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({ editorSettings: { pageSize: 100, autoCalculateTotalRows: false } }),
}));

describe("DB2 query source identifiers", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { clearTableMetadataCache } = await import("@/lib/metadata/tableMetadataCache");
    clearTableMetadataCache();
    setActivePinia(createPinia());
    mocks.listIndexes.mockResolvedValue([]);
    mocks.executeMulti.mockResolvedValue([{ columns: ["TEST_TX1ID", "DESCRIPTION"], rows: [[7, "before"]], affected_rows: 0, execution_time_ms: 1 }]);
  });

  for (const dbType of ["db2", "jdbc"] as const) {
    it.each([
      { sql: "select * from test_tx1", schema: "MAXIMO", table: "TEST_TX1" },
      { sql: "select * from TEST_TX1", schema: "MAXIMO", table: "TEST_TX1" },
      { sql: "select * from maximo.test_tx1 t", schema: "MAXIMO", table: "TEST_TX1" },
      { sql: 'select * from "MAXIMO"."test_tx1"', schema: "MAXIMO", table: "test_tx1" },
      { sql: 'select * from "MiXeD"."Test_Tx1"', schema: "MiXeD", table: "Test_Tx1" },
      { sql: 'select * from "MiXeD".test_tx1', schema: "MiXeD", table: "TEST_TX1" },
      { sql: 'select * from maximo."Test_Tx1"', schema: "MAXIMO", table: "Test_Tx1" },
      { sql: "select * from test_tx1", schema: "MiXeD", table: "TEST_TX1", tabSchema: "MiXeD" },
      { sql: "select * from test_tx1", schema: "lower", table: "TEST_TX1", tabSchema: "lower" },
    ])(`resolves ${dbType} metadata and write identity for $sql in $schema`, async ({ sql, schema, table, tabSchema }: { sql: string; schema: string; table: string; tabSchema?: string }) => {
      mocks.getConfig.mockReturnValue({
        id: "db2-1",
        name: "DB2",
        db_type: dbType,
        database: "DBX8834",
        default_schema: "MAXIMO",
        ...(dbType === "jdbc" ? { connection_string: "jdbc:db2://localhost:50000/DBX8834" } : {}),
      });
      // Ordinary wrong identities miss metadata. For selected mixed/lowercase
      // schemas, also model a same-named table in the uppercase schema: finding
      // metadata there must not redirect writes away from the selected schema.
      mocks.getColumns.mockImplementation(async (_id, _database, requestedSchema, requestedTable) =>
        (requestedSchema === schema || (tabSchema && requestedSchema === schema.toUpperCase())) && requestedTable === table
          ? [
              { name: "TEST_TX1ID", data_type: "INTEGER", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
              { name: "DESCRIPTION", data_type: "VARCHAR(100)", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
            ]
          : [],
      );
      const { useQueryStore } = await import("@/stores/queryStore");
      const store = useQueryStore();
      const tabId = store.createTab("db2-1", "DBX8834", "Query", "query", tabSchema ?? "MAXIMO");
      store.setAutoCommit(tabId, true);
      await store.executeTabSql(tabId, sql);
      const tab = store.tabs.find((entry) => entry.id === tabId)!;
      expect(tab.error).toBeUndefined();
      await vi.waitFor(() => expect(mocks.getColumns).toHaveBeenCalledWith("db2-1", "DBX8834", schema, table, undefined));
      await vi.waitFor(() => expect(tab.tableMeta?.primaryKeys).toEqual(["TEST_TX1ID"]));
      // The grid's UPDATE builder and DDL panel both consume this canonical identity.
      expect(tab.tableMeta).toMatchObject({ schema, tableName: table });
      expect(tab.queryAnalysis).toMatchObject({ schema, tableName: table });
      expect(tab.queryEditabilityReason).toBeUndefined();
      expect(tab.tableMeta?.columns.map((column) => column.name)).toEqual(["TEST_TX1ID", "DESCRIPTION"]);
    });
  }
});
