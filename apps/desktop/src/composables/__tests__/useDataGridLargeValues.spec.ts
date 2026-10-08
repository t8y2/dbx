// @vitest-environment happy-dom

import { computed, createApp, defineComponent, h, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDataGridLargeValues } from "@/composables/useDataGridLargeValues";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({
  buildDataGridContextFilterCondition: vi.fn(),
  buildTableSelectSql: vi.fn(),
  cancelQuery: vi.fn(),
  executeMulti: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => ({
  buildDataGridContextFilterCondition: mocks.buildDataGridContextFilterCondition,
  cancelQuery: mocks.cancelQuery,
  executeMulti: mocks.executeMulti,
}));

vi.mock("@/lib/table/tableSelectSql", () => ({ buildTableSelectSql: mocks.buildTableSelectSql }));

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.clearAllMocks();
});

describe("useDataGridLargeValues", () => {
  it("hydrates a deferred DB2 BLOB through its primary key", async () => {
    const result = ref<QueryResult>({
      columns: ["ID", "APP"],
      column_types: ["BIGINT", "BLOB"],
      rows: [[1, "<BLOB>"]],
      affected_rows: 0,
      execution_time_ms: 1,
      large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 64 * 1024 * 1024 }],
    });
    const toast = vi.fn();
    mocks.buildDataGridContextFilterCondition.mockResolvedValue('"ID" = 1');
    mocks.buildTableSelectSql.mockResolvedValue('SELECT "ID", "APP" FROM "APP_DATA" WHERE "ID" = 1 FETCH FIRST 1 ROWS ONLY');
    mocks.executeMulti.mockResolvedValue([
      {
        columns: ["ID", "APP"],
        rows: [[1, "0x0102"]],
        affected_rows: 0,
        execution_time_ms: 1,
      },
    ]);

    let largeValues: ReturnType<typeof useDataGridLargeValues> | undefined;
    const app = createApp(
      defineComponent({
        setup() {
          largeValues = useDataGridLargeValues({
            result: computed(() => result.value),
            tableMeta: computed(() => ({
              schema: "APP",
              tableName: "APP_DATA",
              tableType: "TABLE",
              columns: [
                { name: "ID", data_type: "BIGINT", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
                { name: "APP", data_type: "BLOB", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
              ],
              primaryKeys: ["ID"],
            })),
            databaseType: computed(() => "db2"),
            connectionId: computed(() => "db2-1"),
            executionDatabase: computed(() => "MAXIMO"),
            resultSourceColumns: computed(() => ["ID", "APP"]),
            allColumnTypes: computed(() => ["BIGINT", "BLOB"]),
            renderedGridColumns: computed(() => []),
            showTranspose: ref(false),
            displayRowCount: computed(() => 1),
            gridScrollerElement: () => null,
            displayItemAt: () => undefined,
            getRowItem: (rowId) =>
              rowId === 1
                ? {
                    id: 1,
                    sourceIndex: 0,
                    data: result.value.rows[0]!,
                    isNew: false,
                    isDeleted: false,
                    isDirtyCol: [false, false],
                  }
                : undefined,
            tableColumnForGridColumn: () => undefined,
            formatCell: (value) => String(value ?? ""),
            formatCellCached: (value) => String(value ?? ""),
            scheduleCanvasDraw: vi.fn(),
            clearCellFormatCache: vi.fn(),
            invalidateResultEstimate: vi.fn(),
            connectionIdentifierQuote: () => '"',
            getConnectionConfig: () => undefined,
            includeDatabaseName: computed(() => true),
            globalQueryTimeoutSecs: computed(() => 30),
            resultLifecycle: { beginOperation: () => 1, isCurrent: () => true },
            largeValueResolutionVersion: ref(0),
            runtimeScope: { disposed: false, addCleanup: () => () => undefined, dispose: () => undefined },
            uuid: () => "execution-1",
            translate: (key) => key,
            translateBackendError: (error) => String(error),
            appendDebugLog: vi.fn(),
            toast,
            cloneRow: vi.fn(),
            cloneRows: vi.fn(),
          });
          return () => h("div");
        },
      }),
    );
    app.mount(document.createElement("div"));
    disposers.push(() => app.unmount());
    if (!largeValues) throw new Error("useDataGridLargeValues was not mounted");

    await expect(largeValues.hydrateLargeValueCell(1, 1)).resolves.toBe(true);

    expect(mocks.buildTableSelectSql).toHaveBeenCalledWith(expect.objectContaining({ databaseType: "db2", columns: ["ID", "APP"], primaryKeys: ["ID"] }));
    expect(mocks.executeMulti).toHaveBeenCalledWith("db2-1", "MAXIMO", expect.any(String), undefined, "execution-1", {
      maxRows: 1,
      fetchSize: 1,
      timeoutSecs: 60,
    });
    expect(result.value.rows).toEqual([[1, "0x0102"]]);
    expect(result.value.large_value_cells).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });
});
