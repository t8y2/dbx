// @vitest-environment happy-dom

import { computed, createApp, defineComponent, h, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binaryCellDisplayText, binaryCellDownloadPayload } from "@/lib/dataGrid/binaryCellDownload";
import { useDataGridLargeValues } from "@/composables/useDataGridLargeValues";
import type { DatabaseType, QueryResult } from "@/types/database";

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
  vi.resetAllMocks();
});

function mountLargeValues(databaseType: DatabaseType, result: Ref<QueryResult>) {
  const toast = vi.fn();
  const formatCell = (value: unknown, columnIndex?: number, originalBytes?: number) => binaryCellDisplayText(value, result.value.column_types?.[columnIndex ?? 0], originalBytes, databaseType) ?? String(value ?? "");
  const item = (rowId = 1) => ({ id: rowId, sourceIndex: rowId - 1, data: result.value.rows[rowId - 1]!, isNew: false, isDeleted: false, isDirtyCol: [false, false] });
  let largeValues: ReturnType<typeof useDataGridLargeValues> | undefined;
  const app = createApp(
    defineComponent({
      setup() {
        largeValues = useDataGridLargeValues({
          result: computed(() => result.value),
          tableMeta: computed(() => ({
            schema: "public",
            tableName: "APP_DATA",
            tableType: "TABLE",
            columns: result.value.columns.map((name, index) => ({ name, data_type: result.value.column_types![index]!, is_nullable: index !== 0, column_default: null, is_primary_key: index === 0, extra: null })),
            primaryKeys: ["ID"],
          })),
          databaseType: computed(() => databaseType),
          connectionId: computed(() => `${databaseType}-1`),
          executionDatabase: computed(() => "MAXIMO"),
          resultSourceColumns: computed(() => ["ID", "APP"]),
          allColumnTypes: computed(() => result.value.column_types ?? []),
          renderedGridColumns: computed(() => []),
          showTranspose: ref(false),
          displayRowCount: computed(() => 1),
          gridScrollerElement: () => null,
          displayItemAt: () => undefined,
          getRowItem: (rowId) => (rowId >= 1 && rowId <= result.value.rows.length ? item(rowId) : undefined),
          tableColumnForGridColumn: () => undefined,
          formatCell,
          formatCellCached: formatCell,
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
  return { largeValues, toast, item };
}

function previewResult(columnType = "bytea", value = "\\x00017f80ff...", originalBytes = 9645) {
  return ref<QueryResult>({
    columns: ["ID", "APP"],
    column_types: ["int4", columnType],
    rows: [[1, value]],
    affected_rows: 0,
    execution_time_ms: 1,
    large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: originalBytes }],
  });
}

describe("useDataGridLargeValues", () => {
  it.each([
    ["postgres", 3],
    ["mysql", 1],
  ] as const)("preserves %s fetch batching when a small binary column shares a row with another large value", async (databaseType, expectedBatches) => {
    const result = previewResult("bytea", "0x00...", 8193);
    result.value.columns.push("DOCUMENT");
    result.value.column_types!.push("text");
    result.value.rows = [1, 2, 3].map((id) => [id, "0x00...", "large document..."]);
    result.value.large_value_cells = [0, 1, 2].flatMap((row_index) => [
      { row_index, column_index: 1, original_bytes: 8193 },
      { row_index, column_index: 2, original_bytes: 64 * 1024 * 1024 },
    ]);
    const { largeValues } = mountLargeValues(databaseType, result);
    mocks.buildDataGridContextFilterCondition.mockImplementation(({ value }) => Promise.resolve(`"ID" = ${value}`));
    mocks.buildTableSelectSql.mockImplementation((options) => Promise.resolve(JSON.stringify(options)));
    mocks.executeMulti.mockImplementation(async (_connection, _database, sql) => {
      const options = JSON.parse(sql);
      const ids = [...options.whereInput.matchAll(/"ID" = (\d+)/g)].map((match) => Number(match[1]));
      return [{ columns: ["ID", "APP", "DOCUMENT"], rows: ids.map((id) => [id, "0x00", "full document"]), affected_rows: 0, execution_time_ms: 1 }];
    });

    const resolved = await largeValues.resolveLargeValueCells([1, 2, 3], [1]);

    expect([...resolved.keys()]).toEqual([1, 2, 3]);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(expectedBatches);
    expect(mocks.buildTableSelectSql.mock.calls.every(([options]) => options.limit === 3 / expectedBatches)).toBe(true);
  });

  it.each(["0x", "0X", "\\x"])("shows the full bytea size and downloads all bytes after hydrating a %s preview", async (prefix) => {
    const bytes = Uint8Array.from({ length: 9645 }, (_, index) => index % 256);
    const hex = Buffer.from(bytes).toString("hex");
    const result = previewResult("bytea", `${prefix}${hex.slice(0, 3276 * 2)}...`, bytes.length);
    const { largeValues, toast, item } = mountLargeValues("postgres", result);
    mocks.buildDataGridContextFilterCondition.mockResolvedValue('"ID" = 1');
    mocks.buildTableSelectSql.mockResolvedValue('SELECT "ID", "APP" FROM "public"."APP_DATA" WHERE "ID" = 1 LIMIT 1');
    mocks.executeMulti.mockResolvedValue([{ columns: ["ID", "APP"], rows: [[1, `${prefix}${hex}`]], affected_rows: 0, execution_time_ms: 1 }]);

    expect(largeValues.formatGridItemCell(item(), 1)).toBe("BYTEA [9.4 KB]");
    expect(() => binaryCellDownloadPayload(result.value.rows[0]![1], "binary", "bytea", "postgres")).toThrow();
    await expect(largeValues.hydrateLargeValueCell(1, 1)).resolves.toBe(true);

    const selectOptions = mocks.buildTableSelectSql.mock.calls[0]![0];
    expect(selectOptions).toMatchObject({ databaseType: "postgres", columns: ["ID", "APP"], primaryKeys: ["ID"], limit: 1 });
    expect(selectOptions).not.toHaveProperty("largeValuePreviewSize");
    expect(result.value.large_value_cells).toEqual([]);
    expect(largeValues.formatGridItemCell(item(), 1)).toBe("BYTEA [9.4 KB]");
    expect(binaryCellDownloadPayload(result.value.rows[0]![1], "binary", "bytea", "postgres").data).toEqual(bytes);
    await expect(largeValues.hydrateLargeValueCell(1, 1)).resolves.toBe(true);
    expect(mocks.executeMulti).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it("retains an incomplete bytea preview when the full value cannot be fetched", async () => {
    const result = previewResult();
    const { largeValues, toast, item } = mountLargeValues("postgres", result);
    mocks.buildDataGridContextFilterCondition.mockResolvedValue('"ID" = 1');
    mocks.buildTableSelectSql.mockResolvedValue('SELECT "ID", "APP" FROM "APP_DATA" WHERE "ID" = 1');
    mocks.executeMulti.mockRejectedValue(new Error("connection lost"));

    await expect(largeValues.hydrateLargeValueCell(1, 1)).resolves.toBe(false);

    expect(largeValues.isLargeValuePreview(item(), 1)).toBe(true);
    expect(result.value.rows[0]![1]).toBe("\\x00017f80ff...");
    expect(() => binaryCellDownloadPayload(result.value.rows[0]![1], "binary", "bytea", "postgres")).toThrow();
    expect(toast).toHaveBeenCalledWith("grid.largeValueLoadFailedWithMessage", 5000);
  });

  it.each([
    ["postgres", " BYTEA ", 64 * 1024 * 1024],
    ["postgres", "text", undefined],
    ["postgres", "bytea[]", undefined],
    ["db2", "BLOB", undefined],
    ["mysql", "LONGBLOB", 64 * 1024 * 1024],
  ] as const)("uses only known original sizes for %s %s", (databaseType, columnType, expected) => {
    const result = previewResult(columnType, "0x00...", 64 * 1024 * 1024);
    const { largeValues, item } = mountLargeValues(databaseType, result);
    expect(largeValues.largeValueOriginalBytes(item(), 1)).toBe(expected);
    expect(largeValues.largeValueOriginalBytes({ ...item(), isDirtyCol: [false, true] }, 1)).toBeUndefined();
    expect(largeValues.largeValueOriginalBytes({ ...item(), isNew: true }, 1)).toBeUndefined();
  });

  it("hydrates a deferred DB2 BLOB through its primary key", async () => {
    const result = ref<QueryResult>({
      columns: ["ID", "APP"],
      column_types: ["BIGINT", "BLOB"],
      rows: [[1, "<BLOB>"]],
      affected_rows: 0,
      execution_time_ms: 1,
      large_value_cells: [{ row_index: 0, column_index: 1, original_bytes: 64 * 1024 * 1024 }],
    });
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

    const { largeValues, toast } = mountLargeValues("db2", result);

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
