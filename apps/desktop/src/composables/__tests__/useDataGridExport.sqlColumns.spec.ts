import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDataGridExport, type UseDataGridExportOptions } from "@/composables/useDataGridExport";
import { useExportTracker } from "@/composables/useExportTracker";
import { sqlExportColumnChoices } from "@/lib/export/sqlExportColumns";
import { showSqlInsertModeDialog } from "@/lib/export/sqlInsertMode";
import { formatSqlInsert } from "@/lib/export/exportFormats";
import { saveTextFile } from "@/lib/export/saveTextFile";
import * as api from "@/lib/backend/api";
import type { QueryResult } from "@/types/database";

const mocks = vi.hoisted(() => ({ native: true, toast: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.native }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn().mockResolvedValue("/exports/result.sql") }));
vi.mock("@/lib/backend/api", () => ({ startQueryResultExport: vi.fn(), startTableExport: vi.fn(), cancelQueryResultExport: vi.fn(), cancelTableExport: vi.fn() }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/composables/useDataGridExtractor", () => ({ useDataGridExtractor: () => ({ copyWithExtractor: vi.fn(), previewWithExtractor: vi.fn(), canCopyWithExtractor: vi.fn() }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { exportBatchSize: 1000, globalDateTimeExportFormat: "", numericColumnRightAlign: true } }) }));
vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/i18n", () => ({ default: { install() {} } }));
vi.mock("@/lib/export/sqlInsertMode", () => ({ showSqlInsertModeDialog: vi.fn() }));
vi.mock("@/lib/export/exportFormats", () => ({ formatSqlInsert: vi.fn().mockResolvedValue("INSERT INTO users VALUES ('Ada');"), formatTsv: vi.fn() }));
vi.mock("@/lib/export/saveTextFile", async (importOriginal) => ({ ...(await importOriginal<object>()), saveTextFile: vi.fn() }));

function createOptions(overrides: Partial<UseDataGridExportOptions> = {}): UseDataGridExportOptions {
  const items = [
    { id: 7, sourceIndex: 0, data: [1, "Ada"], isNew: false, isDeleted: false, isDirtyCol: [], status: "" },
    { id: 8, sourceIndex: 1, data: [2, "Lin"], isNew: false, isDeleted: false, isDirtyCol: [], status: "" },
  ];
  return {
    columns: computed(() => ["id", "name"]),
    displayItems: computed(() => items),
    sql: computed(() => "SELECT id, name FROM users"),
    tableMeta: computed(() => ({
      tableName: "users",
      primaryKeys: [],
      columns: [
        { name: "id", data_type: "int" },
        { name: "name", data_type: "text" },
      ],
    })),
    databaseType: computed(() => "postgres"),
    connectionId: computed(() => "conn"),
    database: computed(() => "dbx"),
    context: computed(() => "results"),
    sourceColumns: computed(() => ["id", "name"]),
    columnTypes: computed(() => ["int4", "text"]),
    whereInput: computed(() => undefined),
    orderBy: computed(() => undefined),
    exportBatchSize: computed(() => 1000),
    hasCellSelection: computed(() => false),
    selectedCells: computed(() => ({ columns: [], rows: [] })),
    selectedCellMatrix: computed(() => null),
    selectedRange: computed(() => null),
    contextCell: ref(null),
    contextSelectionIsSynthetic: ref(false),
    getRowItem: (id) => items.find((item) => item.id === id),
    selectedRowIds: ref(new Set<number>()),
    hasRowSelection: computed(() => false),
    queryResultExportRequest: vi.fn(async (request) => ({ ...request, connectionId: "conn", database: "dbx", databaseType: "postgres", sql: "SELECT id, name FROM users", queryBaseSql: "SELECT id, name FROM users", useAgentCursor: false, pageSize: 1000, keysetOptimizationEnabled: true })),
    ...overrides,
  };
}

describe("SQL export column selection across entrypoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.native = true;
    vi.mocked(showSqlInsertModeDialog).mockResolvedValue({ insertMode: "single", selectedColumns: [sqlExportColumnChoices(["id", "name"])[1]!] });
    const done = { exportId: "export", tableName: "users", rowsExported: 2, totalRows: 2, status: "Done" as const };
    vi.mocked(api.startQueryResultExport).mockResolvedValue(done);
    vi.mocked(api.startTableExport).mockResolvedValue(done);
  });

  afterEach(() => {
    const tracker = useExportTracker();
    for (const task of tracker.tasks.value) tracker.removeTask(task.exportId);
  });

  it("passes full-result selection to backend without changing query, paging or metadata", async () => {
    const choices = sqlExportColumnChoices(["id", "name", "id"]);
    vi.mocked(showSqlInsertModeDialog).mockResolvedValue({ insertMode: "single", selectedColumns: [choices[2]!] });
    const state = useDataGridExport(createOptions({ allColumns: computed(() => ["id", "name", "id"]), allColumnTypes: computed(() => ["int", "text", "bigint"]) }));
    await state.exportSql();
    expect(showSqlInsertModeDialog).toHaveBeenCalledWith({ allowSplit: false, columns: choices });
    expect(api.startQueryResultExport).toHaveBeenCalledWith(expect.objectContaining({ selectedColumns: [choices[2]!], exportColumnTypes: ["int", "text", "bigint"], insertMode: "single", keysetOptimizationEnabled: true, sql: "SELECT id, name FROM users" }), expect.any(Function));
  });

  it("preserves full table paging keys and split options in the backend request", async () => {
    const selectedColumns = [sqlExportColumnChoices(["id", "name"])[1]!];
    vi.mocked(showSqlInsertModeDialog).mockResolvedValue({ insertMode: "batch", selectedColumns, splitMaxMb: 128 });
    await useDataGridExport(createOptions({ context: computed(() => "table-data") })).exportSql();
    expect(api.startTableExport).toHaveBeenCalledWith(expect.objectContaining({ columns: ["id", "name"], columnTypes: ["int4", "text"], selectedColumns, splitMaxMb: 128 }), expect.any(Function));
    expect(api.startQueryResultExport).not.toHaveBeenCalled();
  });

  it.each(["page", "selected"] as const)("projects %s rows and types together without requerying", async (scope) => {
    const state = useDataGridExport(createOptions());
    if (scope === "page") await state.exportCurrentPageSql();
    else await state.exportSql([8]);
    expect(formatSqlInsert).toHaveBeenCalledWith(expect.objectContaining({ columns: ["name"], columnTypes: ["text"], rows: scope === "page" ? [["Ada"], ["Lin"]] : [["Lin"]], insertMode: "single" }));
    expect(api.startQueryResultExport).not.toHaveBeenCalled();
    expect(api.startTableExport).not.toHaveBeenCalled();
    expect(saveTextFile).toHaveBeenCalledOnce();
  });

  it("keeps second duplicate, spatial metadata and raw types aligned after internal-key removal", async () => {
    const names = ["__DBX_ROWID", "id", "id", "shape"];
    const choices = sqlExportColumnChoices(names);
    vi.mocked(showSqlInsertModeDialog).mockResolvedValue({ insertMode: "batch", selectedColumns: [choices[2]!, choices[3]!] });
    const result = { columns: names, column_types: ["ROWID", "int", "bigint", "geometry"], rows: [["key", 1, 20, "POINT(1 2)"]], hidden_column_indexes: [0], spatial_columns: [{ column_index: 3, srid: 4326 }], spatial_values: [[null, null, null, 4326]] } as QueryResult;
    await useDataGridExport(createOptions({ databaseType: computed(() => "oracle"), allColumns: computed(() => names), hasCompleteLocalResult: computed(() => true), completeLocalResult: computed(() => result) })).exportSql();
    expect(showSqlInsertModeDialog).toHaveBeenCalledWith({ allowSplit: false, columns: choices.slice(1) });
    expect(formatSqlInsert).toHaveBeenCalledWith(expect.objectContaining({ columns: ["id", "shape"], columnTypes: ["bigint", "geometry"], rows: [[20, "POINT(1 2)"]], spatialColumns: [{ column_index: 1, srid: 4326 }], spatialValues: [[null, 4326]] }));
    expect(api.startQueryResultExport).not.toHaveBeenCalled();
  });

  it("applies the selection to the Web full-result fallback", async () => {
    mocks.native = false;
    const fullExportResult = vi.fn(async () => ({ columns: ["id", "name"], column_types: ["int", "varchar"], rows: [[3, "Grace"]] }) as QueryResult);
    await useDataGridExport(createOptions({ fullExportResult })).exportSql();
    expect(fullExportResult).toHaveBeenCalledOnce();
    expect(formatSqlInsert).toHaveBeenCalledWith(expect.objectContaining({ columns: ["name"], columnTypes: ["text"], rows: [["Grace"]] }));
  });

  it("does not remap reordered full-table results by visible positions", async () => {
    mocks.native = false;
    const fullExportResult = vi.fn(async () => ({ columns: ["name", "id"], column_types: ["varchar", "bigint"], rows: [["Grace", 3]] }) as QueryResult);
    await useDataGridExport(createOptions({ context: computed(() => "table-data"), tableMeta: computed(() => ({ tableName: "users", catalog: "external", primaryKeys: [], columns: [] })), fullExportResult })).exportSql();
    expect(formatSqlInsert).toHaveBeenCalledWith(expect.objectContaining({ columns: ["name"], columnTypes: ["varchar"], rows: [["Grace"]] }));
  });

  it("omits generated MySQL columns from the chooser but preserves identity and expression defaults", async () => {
    vi.mocked(showSqlInsertModeDialog).mockResolvedValue(null);
    const names = ["id", "generated", "defaulted", "identity"];
    await useDataGridExport(
      createOptions({
        context: computed(() => "table-data"),
        databaseType: computed(() => "mysql"),
        columns: computed(() => names),
        sourceColumns: computed(() => names),
        tableMeta: computed(() => ({
          tableName: "users",
          primaryKeys: ["id"],
          columns: [
            { name: "id", data_type: "int", extra: "auto_increment" },
            { name: "generated", data_type: "text", extra: "VIRTUAL GENERATED" },
            { name: "defaulted", data_type: "timestamp", extra: "DEFAULT_GENERATED" },
            { name: "identity", data_type: "int", extra: "auto_increment" },
          ],
        })),
      }),
    ).exportSql();
    expect(showSqlInsertModeDialog).toHaveBeenCalledWith({ allowSplit: true, columns: sqlExportColumnChoices(names).filter((column) => column.name !== "generated") });
  });

  it("omits PostgreSQL tsvector fields using query metadata", async () => {
    vi.mocked(showSqlInsertModeDialog).mockResolvedValue(null);
    await useDataGridExport(createOptions({ allColumns: computed(() => ["id", "search"]), allColumnTypes: computed(() => ["int", "pg_catalog.tsvector"]) })).exportSql();
    expect(showSqlInsertModeDialog).toHaveBeenCalledWith({ allowSplit: false, columns: sqlExportColumnChoices(["id"]) });
  });

  it("does not export after cancellation or an invalid empty selection", async () => {
    const state = useDataGridExport(createOptions());
    vi.mocked(showSqlInsertModeDialog).mockResolvedValue(null);
    await state.exportSql();
    vi.mocked(showSqlInsertModeDialog).mockResolvedValue({ insertMode: "batch", selectedColumns: [] });
    await state.exportCurrentPageSql();
    expect(api.startQueryResultExport).not.toHaveBeenCalled();
    expect(formatSqlInsert).not.toHaveBeenCalled();
    expect(saveTextFile).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("grid.exportFailed", 5000);
  });

  it("keeps legacy omitted selection behavior", async () => {
    vi.mocked(showSqlInsertModeDialog).mockResolvedValue({ insertMode: "batch" });
    await useDataGridExport(createOptions()).exportCurrentPageSql();
    expect(formatSqlInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: ["id", "name"],
        rows: [
          [1, "Ada"],
          [2, "Lin"],
        ],
      }),
    );
  });
});
