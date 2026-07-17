import { computed } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridActions } from "@/composables/useDataGridActions";
import type { QueryTab } from "@/types/database";

const mocks = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(),
  buildSortedQuerySql: vi.fn(),
  executeTabSql: vi.fn(),
  getConfig: vi.fn(),
  setExecuting: vi.fn(),
  updateSql: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  buildSortedQuerySql: mocks.buildSortedQuerySql,
}));

vi.mock("@/lib/table/tableSelectSql", () => ({
  buildTableSelectSql: mocks.buildTableSelectSql,
  quoteTableDataIdentifier: (_databaseType: string, name: string) => `"${name}"`,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: mocks.getConfig,
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    executeTabSql: mocks.executeTabSql,
    setExecuting: mocks.setExecuting,
    updateSql: mocks.updateSql,
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

function tableDataTab(patch: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    connectionId: "postgres-1",
    database: "app",
    title: "users",
    sql: "SELECT * FROM public.users",
    result: { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
    mode: "data",
    isDirty: false,
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    tableMetaUpdatedAt: Date.now(),
    tableMeta: {
      schema: "public",
      tableName: "users",
      tableType: "TABLE",
      columns: [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
      primaryKeys: ["id"],
    },
    ...patch,
  } as QueryTab;
}

describe("useDataGridActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({ id: "postgres-1", db_type: "postgres" });
    mocks.buildTableSelectSql.mockResolvedValue("SELECT * FROM public.users LIMIT 100 OFFSET 0");
    mocks.buildSortedQuerySql.mockResolvedValue({ ok: true, sql: "SELECT sorted" });
  });

  it("uses the table-data default when toolbar reload has no saved pagination", async () => {
    const tab = tableDataTab();
    const actions = useDataGridActions(computed(() => tab));

    await actions.onReloadData(tab.sql, "", "", "", undefined, undefined, "refresh");

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100,
        offset: 0,
      }),
    );
    expect(mocks.executeTabSql).toHaveBeenCalledWith("tab-1", "SELECT * FROM public.users LIMIT 100 OFFSET 0", expect.objectContaining({ pagination: { limit: 100, offset: 0 } }));
    expect(mocks.executeTabSql.mock.calls[0]?.[2]).not.toHaveProperty("preserveTotalRowCountDuringExecution");
  });

  it("preserves the toolbar page segment and offset for table-data refresh", async () => {
    const tab = tableDataTab({
      resultPageLimit: 25,
      resultPageOffset: 50,
    });
    mocks.buildTableSelectSql.mockResolvedValueOnce("SELECT * FROM public.users LIMIT 25 OFFSET 50");
    const actions = useDataGridActions(computed(() => tab));

    await actions.onReloadData(tab.sql, "", "", "", 25, 50, "refresh");

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ limit: 25, offset: 50 }));
    expect(mocks.executeTabSql).toHaveBeenCalledWith("tab-1", "SELECT * FROM public.users LIMIT 25 OFFSET 50", expect.objectContaining({ pagination: { limit: 25, offset: 50 } }));
    expect(mocks.executeTabSql.mock.calls[0]?.[2]).not.toHaveProperty("preserveTotalRowCountDuringExecution");
  });

  it("keeps SQL result toolbar reload free of table pagination defaults", async () => {
    const tab = {
      id: "tab-1",
      connectionId: "postgres-1",
      database: "app",
      title: "Query",
      sql: "SELECT 1",
      result: { columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      mode: "query",
      isDirty: false,
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
    } as QueryTab;
    const actions = useDataGridActions(computed(() => tab));

    await actions.onReloadData(tab.sql, "", "", "", undefined, undefined, "refresh");

    expect(mocks.buildTableSelectSql).not.toHaveBeenCalled();
    expect(mocks.executeTabSql).toHaveBeenCalledWith(
      "tab-1",
      "SELECT 1",
      expect.objectContaining({
        resultBaseSql: "SELECT 1",
        resultSortedSql: undefined,
        preserveResultDuringExecution: true,
      }),
    );
  });

  it("excludes hidden primary keys and remaps the selected column for database sorting", async () => {
    const tab = {
      id: "tab-1",
      connectionId: "postgres-1",
      database: "app",
      title: "Query",
      sql: "SELECT name, email FROM users",
      resultBaseSql: "SELECT name, email FROM users",
      result: {
        columns: ["name", "__DBX_PK_0", "email"],
        hidden_column_indexes: [1],
        rows: [["Alice", 7, "alice@example.com"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
      mode: "query",
      isDirty: false,
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
    } as QueryTab;
    const actions = useDataGridActions(computed(() => tab));

    await actions.onSort("email", 2, "asc");

    expect(mocks.executeTabSql).toHaveBeenCalledWith(
      "tab-1",
      "SELECT name, email FROM users",
      expect.objectContaining({
        resultBaseSql: "SELECT name, email FROM users",
        querySort: {
          resultColumns: ["name", "email"],
          columnIndex: 1,
          column: "email",
          direction: "asc",
        },
      }),
    );
  });
});
