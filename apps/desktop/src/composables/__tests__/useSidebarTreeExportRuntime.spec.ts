import { readFileSync } from "node:fs";
import { shallowRef } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnInfo, TreeNode } from "@/types/database";

const source = readFileSync(new URL("../useSidebarTreeExportRuntime.ts", import.meta.url), "utf8");
const toastMock = vi.hoisted(() => vi.fn());
const addExportTaskMock = vi.hoisted(() => vi.fn());
const updateTableExportTaskMock = vi.hoisted(() => vi.fn());
const apiMock = vi.hoisted(() => ({
  buildTableSelectSql: vi.fn(async () => 'SELECT * FROM "main"."users" LIMIT 10000'),
  executeQuery: vi.fn(),
  exportQueryResultCsv: vi.fn(),
  exportQueryResultJson: vi.fn(),
  exportQueryResultXlsx: vi.fn(),
  getColumns: vi.fn(),
  getTableDdl: vi.fn(),
  startTableExport: vi.fn(),
}));

vi.mock("@/lib/backend/api", () => apiMock);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: toastMock }) }));
vi.mock("@/composables/useExportTracker", () => ({ useExportTracker: () => ({ addTask: addExportTaskMock, updateTableExportTask: updateTableExportTaskMock }) }));
vi.mock("@/i18n", () => ({ default: { install() {} } }));
vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === "editor.duckdbDraining") return "上一个 DuckDB 查询仍在停止中，请稍后重试。";
      if (key === "grid.exportFailed") return `导出失败：${params?.message}`;
      return key;
    },
  }),
}));

import { useSidebarTreeExportRuntime } from "@/composables/useSidebarTreeExportRuntime";
import { showStructurePreviewDialog, structurePreviewSql, structurePreviewTitle } from "@/components/sidebar/sidebarTreeDialogState";

function functionBody(name: string): string {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::\\s*[^\\{]+)?\\{`, "m").exec(source);
  if (!signature) throw new Error(`Missing function ${name}`);
  const bodyStart = signature.index + signature[0].length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  throw new Error(`Unclosed function ${name}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function column(name: string, isPrimaryKey = false): ColumnInfo {
  return {
    name,
    data_type: "text",
    is_nullable: !isPrimaryKey,
    column_default: null,
    is_primary_key: isPrimaryKey,
    extra: null,
    comment: null,
  };
}

function exportSettings() {
  return {
    editorSettings: {
      exportBatchSize: 128,
      exportRowLimit: 500,
      exportRowLimitEnabled: true,
    },
  };
}

describe("useSidebarTreeExportRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addExportTaskMock.mockImplementation((tableName: string, format: string, filePath: string) => ({
      exportId: "export-1",
      tableName,
      format,
      filePath,
      status: "Running",
      rowsExported: 0,
      totalRows: null,
    }));
    apiMock.startTableExport.mockResolvedValue({});
    showStructurePreviewDialog.value = false;
    structurePreviewSql.value = "";
    structurePreviewTitle.value = "";
  });

  it("translates direct executeQuery errors for sidebar JSON export", async () => {
    apiMock.executeQuery.mockRejectedValueOnce(new Error("The previous DuckDB query is still stopping. Please try again shortly."));
    const activeNode = shallowRef({ id: "table-1", type: "table", label: "users", connectionId: "conn-1", database: "db", schema: "main", children: [] } as TreeNode);
    const connectionStore = {
      ensureConnected: vi.fn(),
      getConfig: vi.fn(() => ({ db_type: "duckdb" })),
      connectionIdentifierQuote: vi.fn(() => '"'),
      treeNodes: [],
      selectedTreeNodeIds: [],
    };
    const runtime = useSidebarTreeExportRuntime({
      activeNode,
      connectionStore: connectionStore as never,
      settingsStore: exportSettings() as never,
      acceptedSelectionIds: () => null,
    });

    await runtime.exportData("json");

    expect(apiMock.executeQuery).toHaveBeenCalledOnce();
    expect(toastMock).toHaveBeenCalledWith("导出失败：上一个 DuckDB 查询仍在停止中，请稍后重试。", 5000);
  });

  it("loads and joins every selected DDL in tree order", async () => {
    apiMock.getTableDdl.mockResolvedValueOnce("CREATE TABLE one (id INT)").mockResolvedValueOnce("CREATE VIEW two AS SELECT 1;");
    const first = { id: "table-1", type: "table", label: "one", connectionId: "conn-1", database: "db", schema: "main" } as TreeNode;
    const second = { id: "view-1", type: "view", label: "two", connectionId: "conn-1", database: "db", schema: "main" } as TreeNode;
    const group = { id: "tables", type: "group-tables", label: "Tables", children: [first, second] } as TreeNode;
    const activeNode = shallowRef(first);
    const connectionStore = {
      ensureConnected: vi.fn(),
      treeNodes: [group],
      selectedTreeNodeIds: [second.id, first.id],
    };
    const runtime = useSidebarTreeExportRuntime({
      activeNode,
      connectionStore: connectionStore as never,
      settingsStore: {} as never,
      acceptedSelectionIds: () => null,
    });

    await runtime.exportStructure();

    expect(connectionStore.ensureConnected).toHaveBeenNthCalledWith(1, first.connectionId);
    expect(connectionStore.ensureConnected).toHaveBeenNthCalledWith(2, second.connectionId);
    expect(apiMock.getTableDdl).toHaveBeenNthCalledWith(1, first.connectionId, first.database, first.schema, first.label, undefined, undefined, true);
    expect(apiMock.getTableDdl).toHaveBeenNthCalledWith(2, second.connectionId, second.database, second.schema, second.label, "VIEW", undefined, true);
    expect(structurePreviewSql.value).toBe("CREATE TABLE one (id INT);\n\nCREATE VIEW two AS SELECT 1;\n");
    expect(structurePreviewTitle.value).toBe("contextMenu.exportStructurePreviewTitleMultiple");
    expect(showStructurePreviewDialog.value).toBe(true);
  });

  it("prompts for export options before it opens the save dialog", () => {
    const exportDataXlsx = functionBody("exportDataXlsx");

    expect(source).toContain('import XlsxHeaderDialog from "@/components/export/XlsxHeaderDialog.vue"');
    expect(exportDataXlsx).toContain("await api.getColumns(");
    expect(exportDataXlsx).toContain("hasXlsxHeaderComments(columnInfos.map((column) => column.comment))");
    expect(exportDataXlsx.indexOf("await showSidebarTreeXlsxHeaderDialog(")).toBeLessThan(exportDataXlsx.indexOf('await exportTableData(target, "xlsx"'));
  });

  it("falls back to field-name headers when column metadata is unavailable", () => {
    const exportDataXlsx = functionBody("exportDataXlsx");

    expect(exportDataXlsx).toContain("// Export still works with field-name headers when column metadata is unavailable.");
    expect(exportDataXlsx).toContain('await exportTableData(target, "xlsx"');
  });

  it("sends the selected mode's header overrides to both XLSX export paths", () => {
    const exportTableData = functionBody("exportTableData");

    expect(exportTableData).toContain("buildXlsxHeaderOverrides(result.columns, comments, headerMode)");
    expect(exportTableData).toContain("columnComments,");
  });

  it("keeps the original table and export options when selection changes during XLSX preparation", async () => {
    const metadata = deferred<ColumnInfo[]>();
    apiMock.getColumns.mockReturnValueOnce(metadata.promise);
    const originalNode = { id: "table-1", type: "table", label: "users", connectionId: "conn-1", database: "db-a", schema: "public", catalog: "catalog-a", children: [] } as TreeNode;
    const activeNode = shallowRef(originalNode);
    const settingsStore = exportSettings();
    const connectionStore = {
      ensureConnected: vi.fn(),
      getConfig: vi.fn(() => ({ db_type: "postgres" })),
      connectionIdentifierQuote: vi.fn((connectionId: string) => (connectionId === "conn-1" ? '"' : "`")),
      treeNodes: [],
      selectedTreeNodeIds: [],
    };
    const runtime = useSidebarTreeExportRuntime({
      activeNode,
      connectionStore: connectionStore as never,
      settingsStore: settingsStore as never,
      acceptedSelectionIds: () => null,
    });

    const exportPromise = runtime.exportDataXlsx();
    await vi.waitFor(() => expect(apiMock.getColumns).toHaveBeenCalledWith("conn-1", "db-a", "public", "users", "catalog-a"));
    activeNode.value = { id: "table-2", type: "table", label: "orders", connectionId: "conn-2", database: "db-b", schema: "sales", children: [] } as TreeNode;
    settingsStore.editorSettings.exportBatchSize = 16;
    settingsStore.editorSettings.exportRowLimit = 10;
    metadata.resolve([column("name")]);

    await exportPromise;

    expect(apiMock.startTableExport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-1",
        database: "db-a",
        schema: "public",
        identifierQuote: '"',
        tableName: "users",
        filePath: "users.xlsx",
        columns: ["name"],
        batchSize: 128,
        rowLimit: 500,
      }),
      expect.any(Function),
    );
  });

  it("keeps explicit column order and primary keys for keyset XLSX export", async () => {
    apiMock.getColumns.mockResolvedValueOnce([column("display_name"), column("id", true), column("created_at")]);
    const activeNode = shallowRef({ id: "table-1", type: "table", label: "users", connectionId: "conn-1", database: "db", schema: "public", children: [] } as TreeNode);
    const connectionStore = {
      ensureConnected: vi.fn(),
      getConfig: vi.fn(() => ({ db_type: "postgres" })),
      connectionIdentifierQuote: vi.fn(() => '"'),
      treeNodes: [],
      selectedTreeNodeIds: [],
    };
    const runtime = useSidebarTreeExportRuntime({
      activeNode,
      connectionStore: connectionStore as never,
      settingsStore: exportSettings() as never,
      acceptedSelectionIds: () => null,
    });

    await runtime.exportDataXlsx();

    expect(apiMock.startTableExport).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: ["display_name", "id", "created_at"],
        primaryKeys: ["id"],
      }),
      expect.any(Function),
    );
  });

  it("exports every selected table when multiple tables are selected", async () => {
    const first = { id: "table-1", type: "table", label: "users", connectionId: "conn-1", database: "db", schema: "public", children: [] } as TreeNode;
    const second = { id: "table-2", type: "table", label: "orders", connectionId: "conn-1", database: "db", schema: "public", children: [] } as TreeNode;
    const group = { id: "tables", type: "group-tables", label: "Tables", children: [first, second] } as TreeNode;
    const activeNode = shallowRef(first);
    const settingsStore = exportSettings();
    const connectionStore = {
      ensureConnected: vi.fn(),
      getConfig: vi.fn(() => ({ db_type: "postgres" })),
      connectionIdentifierQuote: vi.fn(() => '"'),
      treeNodes: [group],
      selectedTreeNodeIds: [second.id, first.id],
    };
    const runtime = useSidebarTreeExportRuntime({
      activeNode,
      connectionStore: connectionStore as never,
      settingsStore: settingsStore as never,
      acceptedSelectionIds: () => null,
    });

    await runtime.exportData("csv");

    expect(apiMock.startTableExport).toHaveBeenCalledTimes(2);
    expect(apiMock.startTableExport).toHaveBeenNthCalledWith(1, expect.objectContaining({ tableName: "users", filePath: "users.csv" }), expect.any(Function));
    expect(apiMock.startTableExport).toHaveBeenNthCalledWith(2, expect.objectContaining({ tableName: "orders", filePath: "orders.csv" }), expect.any(Function));
  });

  it("exports same-name tables from different schemas to distinct files", async () => {
    const publicUsers = { id: "table-1", type: "table", label: "users", connectionId: "conn-1", database: "db", schema: "public", children: [] } as TreeNode;
    const salesUsers = { id: "table-2", type: "table", label: "users", connectionId: "conn-1", database: "db", schema: "sales", children: [] } as TreeNode;
    const group = { id: "tables", type: "group-tables", label: "Tables", children: [publicUsers, salesUsers] } as TreeNode;
    const activeNode = shallowRef(publicUsers);
    const connectionStore = {
      ensureConnected: vi.fn(),
      getConfig: vi.fn(() => ({ db_type: "postgres" })),
      connectionIdentifierQuote: vi.fn(() => '"'),
      treeNodes: [group],
      selectedTreeNodeIds: [salesUsers.id, publicUsers.id],
    };
    const runtime = useSidebarTreeExportRuntime({
      activeNode,
      connectionStore: connectionStore as never,
      settingsStore: exportSettings() as never,
      acceptedSelectionIds: () => null,
    });

    await runtime.exportData("csv");

    expect(apiMock.startTableExport).toHaveBeenCalledTimes(2);
    expect(apiMock.startTableExport).toHaveBeenNthCalledWith(1, expect.objectContaining({ tableName: "users", filePath: "public.users.csv" }), expect.any(Function));
    expect(apiMock.startTableExport).toHaveBeenNthCalledWith(2, expect.objectContaining({ tableName: "users", filePath: "sales.users.csv" }), expect.any(Function));
  });

  it("keeps unique table names unqualified when schemas differ without collisions", async () => {
    const publicUsers = { id: "table-1", type: "table", label: "users", connectionId: "conn-1", database: "db", schema: "public", children: [] } as TreeNode;
    const salesOrders = { id: "table-2", type: "table", label: "orders", connectionId: "conn-1", database: "db", schema: "sales", children: [] } as TreeNode;
    const group = { id: "tables", type: "group-tables", label: "Tables", children: [publicUsers, salesOrders] } as TreeNode;
    const activeNode = shallowRef(publicUsers);
    const connectionStore = {
      ensureConnected: vi.fn(),
      getConfig: vi.fn(() => ({ db_type: "postgres" })),
      connectionIdentifierQuote: vi.fn(() => '"'),
      treeNodes: [group],
      selectedTreeNodeIds: [salesOrders.id, publicUsers.id],
    };
    const runtime = useSidebarTreeExportRuntime({
      activeNode,
      connectionStore: connectionStore as never,
      settingsStore: exportSettings() as never,
      acceptedSelectionIds: () => null,
    });

    await runtime.exportData("csv");

    expect(apiMock.startTableExport).toHaveBeenCalledTimes(2);
    expect(apiMock.startTableExport).toHaveBeenNthCalledWith(1, expect.objectContaining({ filePath: "users.csv" }), expect.any(Function));
    expect(apiMock.startTableExport).toHaveBeenNthCalledWith(2, expect.objectContaining({ filePath: "orders.csv" }), expect.any(Function));
  });

  it("exports only tables in the active execution context when the selection spans connections", async () => {
    const localUsers = { id: "table-1", type: "table", label: "users", connectionId: "conn-1", database: "db", schema: "public", children: [] } as TreeNode;
    const foreignOrders = { id: "table-2", type: "table", label: "orders", connectionId: "conn-2", database: "db", schema: "public", children: [] } as TreeNode;
    const foreignDatabase = { id: "db-b", type: "database", label: "db", connectionId: "conn-2", children: [foreignOrders] } as TreeNode;
    const localGroup = { id: "tables", type: "group-tables", label: "Tables", children: [localUsers] } as TreeNode;
    const localDatabase = { id: "db-a", type: "database", label: "db", connectionId: "conn-1", children: [localGroup] } as TreeNode;
    const activeNode = shallowRef(localUsers);
    const connectionStore = {
      ensureConnected: vi.fn(),
      getConfig: vi.fn(() => ({ db_type: "postgres" })),
      connectionIdentifierQuote: vi.fn(() => '"'),
      treeNodes: [localDatabase, foreignDatabase],
      selectedTreeNodeIds: [foreignOrders.id, localUsers.id],
    };
    const runtime = useSidebarTreeExportRuntime({
      activeNode,
      connectionStore: connectionStore as never,
      settingsStore: exportSettings() as never,
      acceptedSelectionIds: () => null,
    });

    await runtime.exportData("csv");

    expect(apiMock.startTableExport).toHaveBeenCalledTimes(1);
    expect(apiMock.startTableExport).toHaveBeenCalledWith(expect.objectContaining({ connectionId: "conn-1", tableName: "users", filePath: "users.csv" }), expect.any(Function));
  });

  it("keeps single-table export behavior when only one table is selected", async () => {
    const activeNode = shallowRef({ id: "table-1", type: "table", label: "users", connectionId: "conn-1", database: "db", schema: "public", children: [] } as TreeNode);
    const connectionStore = {
      ensureConnected: vi.fn(),
      getConfig: vi.fn(() => ({ db_type: "postgres" })),
      connectionIdentifierQuote: vi.fn(() => '"'),
      treeNodes: [],
      selectedTreeNodeIds: [],
    };
    const runtime = useSidebarTreeExportRuntime({
      activeNode,
      connectionStore: connectionStore as never,
      settingsStore: exportSettings() as never,
      acceptedSelectionIds: () => null,
    });

    await runtime.exportData("csv");

    expect(apiMock.startTableExport).toHaveBeenCalledOnce();
    expect(apiMock.startTableExport).toHaveBeenCalledWith(expect.objectContaining({ tableName: "users", filePath: "users.csv" }), expect.any(Function));
  });
});
