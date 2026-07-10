import { computed } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridActions } from "@/composables/useDataGridActions";
import type { QueryTab } from "@/types/database";

const mocks = vi.hoisted(() => ({
  buildSortedQuerySql: vi.fn(),
  executeTabSql: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/backend/api", () => ({
  buildSortedQuerySql: mocks.buildSortedQuerySql,
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: mocks.getConfig,
  }),
}));

vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({
    executeTabSql: mocks.executeTabSql,
  }),
}));

vi.mock("@/stores/settingsStore", () => ({
  useSettingsStore: () => ({
    editorSettings: { pageSize: 100 },
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

describe("useDataGridActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({ id: "postgres-1", db_type: "postgres" });
    mocks.buildSortedQuerySql.mockResolvedValue({ ok: true, sql: "SELECT sorted" });
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
