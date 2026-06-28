import { computed, ref, type ComputedRef, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import * as api from "@/lib/api";
import { formatSelectionAsCsv, formatSelectionAsJson, formatSelectionAsSqlInList, formatSelectionAsTsv, type CellSelectionRange, type SelectionData } from "@/lib/gridSelection";
import { useToast } from "@/composables/useToast";
import { displayCellValue, type CellValue } from "@/lib/cellValue";
import { tryStartExclusiveActivation, type ActionActivationGuard } from "@/lib/actionActivation";
import { copyToClipboard } from "@/lib/clipboard";
import { buildDataGridCopyInsertStatement, buildDataGridCopyUpdateStatements, type DataGridTableMeta } from "@/lib/dataGridSql";
import { formatSqlInsert } from "@/lib/exportFormats";
import { uuid } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settingsStore";
import type { DatabaseType, QueryResult } from "@/types/database";
import type { QueryResultExportRequest } from "@/lib/api";

interface RowItem {
  id: number;
  sourceIndex?: number;
  newIndex?: number;
  data: CellValue[];
  isNew: boolean;
  isDeleted: boolean;
  isDirtyCol: boolean[];
  status: string;
}

export interface UseDataGridExportOptions {
  columns: ComputedRef<string[]>;
  displayItems: ComputedRef<RowItem[]>;
  sql: ComputedRef<string | undefined>;
  tableMeta: ComputedRef<DataGridTableMeta | undefined>;
  databaseType: ComputedRef<DatabaseType | undefined>;
  connectionId: ComputedRef<string | undefined>;
  database: ComputedRef<string | undefined>;
  context: ComputedRef<"results" | "table-data" | undefined>;
  sourceColumns: ComputedRef<Array<string | undefined> | undefined>;
  columnTypes: ComputedRef<Array<string | undefined> | undefined>;
  whereInput: ComputedRef<string | undefined>;
  orderBy: ComputedRef<string | undefined>;
  exportBatchSize: ComputedRef<number>;
  hasCellSelection: ComputedRef<boolean>;
  selectedCells: ComputedRef<SelectionData>;
  selectedRange: ComputedRef<CellSelectionRange | null>;
  contextCell: Ref<{ rowId: number; rowIndex: number; col: number } | null> | ComputedRef<{ rowId: number; rowIndex: number; col: number } | null>;
  getRowItem: (rowId: number) => RowItem | undefined;
  selectedRowIds: Ref<Set<number>> | ComputedRef<Set<number>>;
  hasRowSelection: ComputedRef<boolean>;
  fullExportResult?: (onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void) => Promise<QueryResult | undefined>;
  queryResultExportRequest?: (options: { exportId: string; filePath: string; format: "csv" | "xlsx" }) => Promise<QueryResultExportRequest | undefined>;
  allExportResults?: ComputedRef<Array<{ sheetName: string; result: QueryResult }> | undefined>;
  currentResultLabel?: ComputedRef<string | undefined>;
  exportFileBaseName?: ComputedRef<string | undefined>;
  exportProgressDialog?: Ref<boolean>;
  exportProgressState?: Ref<{
    title: string;
    tableName: string;
    format: string;
    rowsExported: number;
    totalRows: number | null;
    status: string;
    errorMessage: string | null;
  }>;
  exportCancelHandler?: Ref<(() => Promise<void>) | null>;
}

interface CopyStatementCache {
  key: string;
  text: string;
  loading: boolean;
  ready: boolean;
}

export function useDataGridExport(options: UseDataGridExportOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const exportGuard: ActionActivationGuard = {};
  const copyRowInsertCache = ref<CopyStatementCache>({
    key: "",
    text: "",
    loading: false,
    ready: false,
  });
  const copyRowInsertWithoutPrimaryKeysCache = ref<CopyStatementCache>({
    key: "",
    text: "",
    loading: false,
    ready: false,
  });
  const copyRowUpdateCache = ref<CopyStatementCache>({
    key: "",
    text: "",
    loading: false,
    ready: false,
  });

  const {
    columns,
    displayItems,
    sql,
    tableMeta,
    sourceColumns,
    databaseType,
    connectionId,
    database,
    context,
    whereInput,
    orderBy,
    columnTypes,
    exportBatchSize,
    hasCellSelection,
    selectedCells,
    selectedRange,
    contextCell,
    getRowItem,
    selectedRowIds,
    hasRowSelection,
    fullExportResult,
    queryResultExportRequest,
    allExportResults,
    currentResultLabel,
    exportFileBaseName,
    exportProgressDialog,
    exportProgressState,
    exportCancelHandler,
  } = options;

  async function copyText(text: string) {
    try {
      await copyToClipboard(text);
      toast(t("grid.copied"));
    } catch (e: any) {
      toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
    }
  }

  function rowsToExport(rowIds?: number[]): RowItem[] {
    if (!rowIds?.length) return displayItems.value;
    const rowIdSet = new Set(rowIds);
    return displayItems.value.filter((item) => rowIdSet.has(item.id));
  }

  async function resultToExport(rowIds?: number[], onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void, useFullExport = true): Promise<{ columns: string[]; rows: CellValue[][] }> {
    if (useFullExport && !rowIds?.length && fullExportResult) {
      const result = await fullExportResult(onProgress);
      if (result) return { columns: result.columns, rows: result.rows };
    }
    return {
      columns: columns.value,
      rows: rowsToExport(rowIds).map((item) => item.data),
    };
  }

  function currentXlsxSheetName(): string {
    return currentResultLabel?.value || tableMeta.value?.tableName || "Export";
  }

  function targetedRows(): RowItem[] {
    if (hasRowSelection.value && selectedRowIds.value.size > 0) {
      return displayItems.value.filter((item) => selectedRowIds.value.has(item.id));
    }
    const range = selectedRange.value;
    if (range && range.startRow !== range.endRow) {
      return displayItems.value.slice(range.startRow, range.endRow + 1);
    }
    if (!contextCell.value) return [];
    const item = getRowItem(contextCell.value.rowId);
    return item ? [item] : [];
  }

  function updateEligibleRows(): RowItem[] {
    return targetedRows().filter((item) => !item.isNew && !item.isDeleted);
  }

  function updateCopyKey(): string {
    const rows = updateEligibleRows().map((item) => item.id);
    return JSON.stringify({
      databaseType: databaseType.value ?? null,
      schema: tableMeta.value?.schema ?? null,
      tableName: tableMeta.value?.tableName ?? null,
      primaryKeys: tableMeta.value?.primaryKeys ?? [],
      columns: columns.value,
      sourceColumns: sourceColumns.value ?? null,
      rows,
    });
  }

  function insertCopyKey(excludePrimaryKeys: boolean): string {
    const rows = insertEligibleRows().map((item) => item.id);
    return JSON.stringify({
      databaseType: databaseType.value ?? null,
      schema: tableMeta.value?.schema ?? null,
      tableName: tableMeta.value?.tableName ?? null,
      columns: columns.value,
      sourceColumns: sourceColumns.value ?? null,
      excludePrimaryKeys,
      rows,
    });
  }

  function insertCopyCache(excludePrimaryKeys: boolean): CopyStatementCache {
    return excludePrimaryKeys ? copyRowInsertWithoutPrimaryKeysCache.value : copyRowInsertCache.value;
  }

  function setInsertCopyCache(excludePrimaryKeys: boolean, cache: CopyStatementCache) {
    if (excludePrimaryKeys) {
      copyRowInsertWithoutPrimaryKeysCache.value = cache;
    } else {
      copyRowInsertCache.value = cache;
    }
  }

  function setUpdateCopyCache(cache: CopyStatementCache) {
    copyRowUpdateCache.value = cache;
  }

  async function prefetchRowAsInsertStatement(excludePrimaryKeys: boolean) {
    const rows = insertEligibleRows();
    if (!rows.length) {
      setInsertCopyCache(excludePrimaryKeys, {
        key: "",
        text: "",
        loading: false,
        ready: false,
      });
      return;
    }
    const key = insertCopyKey(excludePrimaryKeys);
    const current = insertCopyCache(excludePrimaryKeys);
    if ((current.loading || current.ready) && current.key === key) return;

    setInsertCopyCache(excludePrimaryKeys, {
      key,
      text: "",
      loading: true,
      ready: false,
    });

    try {
      const statement = await buildDataGridCopyInsertStatement({
        databaseType: databaseType.value,
        tableMeta: tableMeta.value,
        columns: columns.value,
        sourceColumns: sourceColumns.value,
        rows: rows.map((item) => item.data),
        excludePrimaryKeys,
      });
      const latest = insertCopyCache(excludePrimaryKeys);
      if (latest.key !== key) return;
      setInsertCopyCache(excludePrimaryKeys, {
        key,
        text: statement ?? "",
        loading: false,
        ready: !!statement,
      });
    } catch {
      const latest = insertCopyCache(excludePrimaryKeys);
      if (latest.key !== key) return;
      setInsertCopyCache(excludePrimaryKeys, {
        key,
        text: "",
        loading: false,
        ready: false,
      });
    }
  }

  function canCopyPreparedInsert(excludePrimaryKeys: boolean): boolean {
    const cache = insertCopyCache(excludePrimaryKeys);
    return cache.ready && cache.key === insertCopyKey(excludePrimaryKeys);
  }

  function copyPreparedRowAsInsert(excludePrimaryKeys: boolean): boolean {
    if (!canCopyPreparedInsert(excludePrimaryKeys)) return false;
    void copyText(insertCopyCache(excludePrimaryKeys).text);
    return true;
  }

  async function prefetchRowAsUpdateStatement() {
    if (!tableMeta.value?.primaryKeys.length) {
      setUpdateCopyCache({
        key: "",
        text: "",
        loading: false,
        ready: false,
      });
      return;
    }
    const rows = updateEligibleRows();
    if (!rows.length) {
      setUpdateCopyCache({
        key: "",
        text: "",
        loading: false,
        ready: false,
      });
      return;
    }
    const key = updateCopyKey();
    const current = copyRowUpdateCache.value;
    if ((current.loading || current.ready) && current.key === key) return;

    setUpdateCopyCache({
      key,
      text: "",
      loading: true,
      ready: false,
    });

    try {
      const statements = await buildDataGridCopyUpdateStatements({
        databaseType: databaseType.value,
        tableMeta: tableMeta.value,
        columns: columns.value,
        sourceColumns: sourceColumns.value,
        rows: rows.map((item) => item.data),
      });
      const latest = copyRowUpdateCache.value;
      if (latest.key !== key) return;
      const text = statements.join("\n");
      setUpdateCopyCache({
        key,
        text,
        loading: false,
        ready: statements.length > 0,
      });
    } catch {
      const latest = copyRowUpdateCache.value;
      if (latest.key !== key) return;
      setUpdateCopyCache({
        key,
        text: "",
        loading: false,
        ready: false,
      });
    }
  }

  function canCopyPreparedUpdate(): boolean {
    const cache = copyRowUpdateCache.value;
    return cache.ready && cache.key === updateCopyKey();
  }

  function copyPreparedRowAsUpdate(): boolean {
    if (!canCopyPreparedUpdate()) return false;
    void copyText(copyRowUpdateCache.value.text);
    return true;
  }

  // --- Selection copy functions ---
  async function copySelectionTsv() {
    if (!hasCellSelection.value) return;
    await copyText(formatSelectionAsTsv(selectedCells.value));
  }

  async function copySelectionTsvWithHeaders() {
    if (!hasCellSelection.value) return;
    await copyText(formatSelectionAsTsv(selectedCells.value, true));
  }

  async function copySelectionCsv() {
    if (!hasCellSelection.value) return;
    await copyText(formatSelectionAsCsv(selectedCells.value));
  }

  async function copySelectionJson() {
    if (!hasCellSelection.value) return;
    await copyText(formatSelectionAsJson(selectedCells.value));
  }

  async function copySelectionSqlInList() {
    if (!hasCellSelection.value) return;
    await copyText(formatSelectionAsSqlInList(selectedCells.value));
  }

  async function copySelectedRowsTsv() {
    if (!hasRowSelection.value || selectedRowIds.value.size === 0) return;
    const rows = displayItems.value.filter((item) => selectedRowIds.value.has(item.id)).map((item) => item.data);
    await copyText(formatSelectionAsTsv({ columns: columns.value, rows }));
  }

  async function copyColumnNames() {
    if (columns.value.length === 0) return;
    await copyText(columns.value.join("\t"));
  }

  function rowToJsonObject(item: RowItem): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    columns.value.forEach((col, i) => {
      obj[col] = item.data[i];
    });
    return obj;
  }

  async function copyRowsAsJson(items: RowItem[]) {
    if (items.length === 0) return;
    const value = items.length === 1 ? rowToJsonObject(items[0]) : items.map(rowToJsonObject);
    await copyText(JSON.stringify(value, null, 2));
  }

  // --- Cell/row copy ---
  async function copyCell() {
    if (!contextCell.value || contextCell.value.col < 0) return;
    const item = getRowItem(contextCell.value.rowId);
    const val = item?.data[contextCell.value.col] ?? null;
    await copyText(displayCellValue(val));
  }

  async function copyRow() {
    if (hasRowSelection.value && selectedRowIds.value.size > 0) {
      const items = displayItems.value.filter((item) => selectedRowIds.value.has(item.id));
      await copyRowsAsJson(items);
      return;
    }
    const range = selectedRange.value;
    if (range && range.startRow !== range.endRow) {
      const items = displayItems.value.slice(range.startRow, range.endRow + 1);
      await copyRowsAsJson(items);
      return;
    }
    if (!contextCell.value) return;
    const item = getRowItem(contextCell.value.rowId);
    if (!item) return;
    await copyRowsAsJson([item]);
  }

  function insertEligibleRows(): RowItem[] {
    return targetedRows();
  }

  async function copyRowAsInsert() {
    copyPreparedRowAsInsert(false);
  }

  async function copyRowAsInsertWithoutPrimaryKeys() {
    copyPreparedRowAsInsert(true);
  }

  async function copyRowAsUpdate() {
    copyPreparedRowAsUpdate();
  }

  const canCopyRowAsUpdate = computed(() => {
    if (!tableMeta.value?.primaryKeys.length) return false;
    const rows = updateEligibleRows();
    if (!rows.length) return false;
    if (databaseType.value === "neo4j" || databaseType.value === "tdengine") return false;
    const saveColumns = effectiveColumns(sourceColumns.value, columns.value);
    const primaryKeys = tableMeta.value.primaryKeys;
    if (primaryKeys.some((primaryKey) => findColumnIndex(saveColumns, primaryKey) === -1)) return false;
    const primaryKeySet = new Set(primaryKeys.map(normalizeColumnName));
    return saveColumns.some((column) => column && !primaryKeySet.has(normalizeColumnName(column)));
  });

  const canCopyRowAsInsertWithoutPrimaryKeys = computed(() => {
    if (!tableMeta.value?.primaryKeys.length) return false;
    const rows = insertEligibleRows();
    if (!rows.length) return false;
    const saveColumns = effectiveColumns(sourceColumns.value, columns.value);
    const primaryKeySet = new Set(tableMeta.value.primaryKeys.map(normalizeColumnName));
    const insertableCount = saveColumns.filter(Boolean).length;
    const insertColumnsCount = saveColumns.filter((column) => column && !primaryKeySet.has(normalizeColumnName(column))).length;
    return insertColumnsCount > 0 && insertColumnsCount < insertableCount;
  });

  async function copyAll() {
    const header = columns.value.join("\t");
    const body = displayItems.value.map((item) => item.data.map((c) => displayCellValue(c)).join("\t")).join("\n");
    await copyText(`${header}\n${body}`);
  }

  // --- Export functions ---
  async function runExclusiveExport(action: () => Promise<void>) {
    const finish = tryStartExclusiveActivation(exportGuard);
    if (!finish) return;
    try {
      await action();
    } finally {
      finish();
    }
  }

  async function exportCsv(rowIds?: number[]) {
    await runExclusiveExport(async () => {
      try {
        if (await exportQueryResultViaBackend("csv", rowIds)) return;
        if (await exportFullTableDataViaBackend("csv", rowIds)) return;

        const needsFullExport = !rowIds?.length && !!fullExportResult;
        if (needsFullExport && exportProgressDialog && exportProgressState) {
          exportProgressState.value = {
            title: t("exportProgress.title"),
            tableName: tableMeta.value?.tableName || "",
            format: "csv",
            rowsExported: 0,
            totalRows: null,
            status: "Running",
            errorMessage: null,
          };
          exportProgressDialog.value = true;
        }
        const result = await resultToExport(rowIds, (info) => {
          if (needsFullExport && exportProgressState && exportProgressState.value.status === "Running") {
            // Guard against the COUNT estimate being too low: if the real
            // fetched count exceeds it, bump totalRows so the progress bar
            // never shows 100 % while data is still being fetched.
            const adjustedTotal = info.totalRows !== null && info.rowsExported > info.totalRows ? info.rowsExported : info.totalRows;
            exportProgressState.value = {
              ...exportProgressState.value,
              rowsExported: info.rowsExported,
              totalRows: adjustedTotal,
            };
          }
        });
        // Hand the raw rows straight to the Rust command. Formatting (NULL→"",
        // bool/number→text, etc.) happens there on a spawn_blocking thread, so
        // we avoid mapping every cell synchronously on the UI thread.
        const rows = result.rows;
        if (needsFullExport && exportProgressState) {
          exportProgressState.value = {
            ...exportProgressState.value,
            status: "Writing",
            rowsExported: result.rows.length,
            totalRows: result.rows.length,
          };
        }
        let outputPath = exportFileName("export", "csv");
        if (isTauriRuntime()) {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const path = await save({
            defaultPath: outputPath,
            filters: [{ name: "CSV", extensions: ["csv"] }],
          });
          if (!path) {
            if (exportProgressDialog) exportProgressDialog.value = false;
            return;
          }
          outputPath = path as string;
        }
        await api.exportQueryResultCsv(outputPath, result.columns, rows);
        if (needsFullExport && exportProgressState) {
          exportProgressState.value = {
            ...exportProgressState.value,
            status: "Done",
            rowsExported: result.rows.length,
            totalRows: result.rows.length,
          };
        }
        toast(t("grid.exported"));
      } catch (e: any) {
        if (exportProgressState) {
          exportProgressState.value = {
            ...exportProgressState.value,
            status: "Error",
            errorMessage: e?.message || String(e),
          };
        }
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportCurrentPageCsv() {
    await runExclusiveExport(async () => {
      try {
        let outputPath = exportFileName("export-page", "csv", { page: true });
        if (isTauriRuntime()) {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const path = await save({
            defaultPath: outputPath,
            filters: [{ name: "CSV", extensions: ["csv"] }],
          });
          if (!path) return;
          outputPath = path as string;
        }
        const result = await resultToExport(undefined, undefined, false);
        await api.exportQueryResultCsv(outputPath, result.columns, result.rows);
        toast(t("grid.exported"));
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportJson(rowIds?: number[]) {
    await runExclusiveExport(async () => {
      try {
        if (await exportFullTableDataViaBackend("json", rowIds)) return;

        let outputPath = exportFileName("export", "json");
        if (isTauriRuntime()) {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const path = await save({
            defaultPath: outputPath,
            filters: [{ name: "JSON", extensions: ["json"] }],
          });
          if (!path) return;
          outputPath = path as string;
        }
        const result = await resultToExport(rowIds);
        await api.exportQueryResultJson(outputPath, result.columns, result.rows);
        toast(t("grid.exported"));
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportCurrentPageJson() {
    await runExclusiveExport(async () => {
      try {
        let outputPath = exportFileName("export-page", "json", { page: true });
        if (isTauriRuntime()) {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const path = await save({
            defaultPath: outputPath,
            filters: [{ name: "JSON", extensions: ["json"] }],
          });
          if (!path) return;
          outputPath = path as string;
        }
        const result = await resultToExport(undefined, undefined, false);
        await api.exportQueryResultJson(outputPath, result.columns, result.rows);
        toast(t("grid.exported"));
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportMarkdown(rowIds?: number[]) {
    await runExclusiveExport(async () => {
      try {
        if (await exportFullTableDataViaBackend("markdown", rowIds)) return;

        let outputPath = exportFileName("export", "md");
        if (isTauriRuntime()) {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const path = await save({
            defaultPath: outputPath,
            filters: [{ name: "Markdown", extensions: ["md"] }],
          });
          if (!path) return;
          outputPath = path as string;
        }
        const result = await resultToExport(rowIds);
        await api.exportQueryResultMarkdown(outputPath, result.columns, result.rows);
        toast(t("grid.exported"));
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportCurrentPageMarkdown() {
    await runExclusiveExport(async () => {
      try {
        let outputPath = exportFileName("export-page", "md", { page: true });
        if (isTauriRuntime()) {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const path = await save({
            defaultPath: outputPath,
            filters: [{ name: "Markdown", extensions: ["md"] }],
          });
          if (!path) return;
          outputPath = path as string;
        }
        const result = await resultToExport(undefined, undefined, false);
        await api.exportQueryResultMarkdown(outputPath, result.columns, result.rows);
        toast(t("grid.exported"));
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportXlsx(rowIds?: number[]) {
    await runExclusiveExport(async () => {
      try {
        if (await exportQueryResultViaBackend("xlsx", rowIds)) return;
        if (await exportFullTableDataViaBackend("xlsx", rowIds)) return;

        let outputPath = exportFileName("export", "xlsx");
        if (isTauriRuntime()) {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const path = await save({
            defaultPath: outputPath,
            filters: [{ name: "Excel", extensions: ["xlsx"] }],
          });
          if (!path) return;
          outputPath = path as string;
        }
        const needsFullExport = !rowIds?.length && !!fullExportResult;
        if (needsFullExport && exportProgressDialog && exportProgressState) {
          exportProgressState.value = {
            title: t("exportProgress.title"),
            tableName: tableMeta.value?.tableName || "",
            format: "xlsx",
            rowsExported: 0,
            totalRows: null,
            status: "Running",
            errorMessage: null,
          };
          exportProgressDialog.value = true;
        }
        const result = await resultToExport(rowIds, (info) => {
          if (needsFullExport && exportProgressState && exportProgressState.value.status === "Running") {
            const adjustedTotal = info.totalRows !== null && info.rowsExported > info.totalRows ? info.rowsExported : info.totalRows;
            exportProgressState.value = {
              ...exportProgressState.value,
              rowsExported: info.rowsExported,
              totalRows: adjustedTotal,
            };
          }
        });
        if (needsFullExport && exportProgressState) {
          exportProgressState.value = {
            ...exportProgressState.value,
            status: "Writing",
            rowsExported: result.rows.length,
            totalRows: result.rows.length,
          };
        }
        await api.exportQueryResultXlsx(outputPath, currentXlsxSheetName(), result.columns, result.rows);
        if (needsFullExport && exportProgressState) {
          exportProgressState.value = {
            ...exportProgressState.value,
            status: "Done",
            rowsExported: result.rows.length,
            totalRows: result.rows.length,
          };
        }
        toast(t("grid.exported"));
      } catch (e: any) {
        if (exportProgressState) {
          exportProgressState.value = {
            ...exportProgressState.value,
            status: "Error",
            errorMessage: e?.message || String(e),
          };
        }
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportCurrentPageXlsx() {
    await runExclusiveExport(async () => {
      try {
        let outputPath = exportFileName("export-page", "xlsx", { page: true });
        if (isTauriRuntime()) {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const path = await save({
            defaultPath: outputPath,
            filters: [{ name: "Excel", extensions: ["xlsx"] }],
          });
          if (!path) return;
          outputPath = path as string;
        }
        const result = await resultToExport(undefined, undefined, false);
        await api.exportQueryResultXlsx(outputPath, currentXlsxSheetName(), result.columns, result.rows);
        toast(t("grid.exported"));
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportAllResultsXlsx() {
    await runExclusiveExport(async () => {
      try {
        const sheets = (allExportResults?.value ?? []).filter((sheet) => sheet.result.columns.length > 0);
        if (sheets.length === 0) return;

        let outputPath = exportFileName("query-results", "xlsx", { allResults: true });
        if (isTauriRuntime()) {
          const { save } = await import("@tauri-apps/plugin-dialog");
          const path = await save({
            defaultPath: outputPath,
            filters: [{ name: "Excel", extensions: ["xlsx"] }],
          });
          if (!path) return;
          outputPath = path as string;
        }

        await api.exportQueryResultsXlsx(
          outputPath,
          sheets.map((sheet) => ({
            sheetName: sheet.sheetName,
            columns: sheet.result.columns,
            rows: sheet.result.rows,
          })),
        );
        toast(t("grid.exported"));
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportFullTableDataViaBackend(format: "csv" | "xlsx" | "json" | "markdown" | "sql", rowIds?: number[]): Promise<boolean> {
    const meta = tableMeta.value;
    if (rowIds?.length || context.value !== "table-data" || !meta || !connectionId.value || !database.value) {
      return false;
    }

    const extension = format === "markdown" ? "md" : format;
    const filterName = format === "csv" ? "CSV" : format === "xlsx" ? "Excel" : format === "json" ? "JSON" : format === "markdown" ? "Markdown" : "SQL";
    let outputPath = exportFileName(meta.tableName || "export", extension, { preferFallback: true });
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: outputPath,
        filters: [{ name: filterName, extensions: [extension] }],
      });
      if (!path) return true;
      outputPath = path as string;
    }

    if (exportProgressState) {
      exportProgressState.value = {
        title: t("exportProgress.title"),
        tableName: meta.tableName,
        format,
        rowsExported: 0,
        totalRows: null,
        status: "Running",
        errorMessage: null,
      };
    }
    if (exportProgressDialog) exportProgressDialog.value = true;

    const exportId = uuid();
    if (exportCancelHandler) {
      exportCancelHandler.value = () => api.cancelTableExport(exportId);
    }
    const editorSettings = useSettingsStore().editorSettings;
    const rowLimit = editorSettings.exportRowLimitEnabled ? editorSettings.exportRowLimit : null;

    try {
      const progress = await api.startTableExport(
        {
          exportId,
          connectionId: connectionId.value,
          database: database.value,
          schema: meta.schema,
          tableName: meta.tableName,
          filePath: outputPath,
          format,
          columns: columns.value,
          columnTypes: columnTypes.value,
          primaryKeys: meta.primaryKeys,
          whereInput: whereInput.value,
          orderBy: orderBy.value,
          skipCount: false,
          batchSize: exportBatchSize.value,
          rowLimit,
        },
        (progress) => {
          if (exportProgressState) {
            exportProgressState.value = {
              ...exportProgressState.value,
              tableName: progress.tableName || meta.tableName,
              rowsExported: progress.rowsExported,
              totalRows: progress.totalRows,
              status: progress.status,
              errorMessage: progress.errorMessage || null,
            };
          }
        },
      );
      if (progress.status === "Done") {
        toast(t("grid.exported"));
      }
    } finally {
      if (exportCancelHandler) exportCancelHandler.value = null;
    }
    return true;
  }

  async function exportQueryResultViaBackend(format: "csv" | "xlsx", rowIds?: number[]): Promise<boolean> {
    if (rowIds?.length || context.value !== "results" || !queryResultExportRequest) {
      return false;
    }

    const extension = format;
    const filterName = format === "csv" ? "CSV" : "Excel";
    let outputPath = exportFileName("query-result", extension);
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: outputPath,
        filters: [{ name: filterName, extensions: [extension] }],
      });
      if (!path) return true;
      outputPath = path as string;
    }

    const exportId = uuid();
    const request = await queryResultExportRequest({ exportId, filePath: outputPath, format });
    if (!request) throw new Error("Unable to build query result export request");

    if (exportProgressState) {
      exportProgressState.value = {
        title: t("exportProgress.title"),
        tableName: "Query Result",
        format,
        rowsExported: 0,
        totalRows: request.totalRows ?? null,
        status: "Running",
        errorMessage: null,
      };
    }
    if (exportProgressDialog) exportProgressDialog.value = true;
    if (exportCancelHandler) {
      exportCancelHandler.value = () => api.cancelQueryResultExport(exportId, request.executionId);
    }

    try {
      const terminalProgress = await api.startQueryResultExport(request, (progress) => {
        if (exportProgressState) {
          const adjustedTotal = progress.totalRows !== null && progress.rowsExported > progress.totalRows ? progress.rowsExported : progress.totalRows;
          exportProgressState.value = {
            ...exportProgressState.value,
            tableName: progress.tableName || "Query Result",
            rowsExported: progress.rowsExported,
            totalRows: adjustedTotal,
            status: progress.status,
            errorMessage: progress.errorMessage || null,
          };
        }
      });
      if (terminalProgress.status === "Done") {
        toast(t("grid.exported"));
      }
    } finally {
      if (exportCancelHandler) exportCancelHandler.value = null;
    }
    return true;
  }

  async function exportSql(rowIds?: number[]) {
    await runExclusiveExport(async () => {
      try {
        if (await exportFullTableDataViaBackend("sql", rowIds)) return;

        const result = await resultToExport(rowIds);
        const exportData = sqlInsertExportData(result);
        const content = await formatSqlInsert({
          databaseType: databaseType.value,
          schema: tableMeta.value?.schema,
          tableName: tableMeta.value?.tableName || "table_name",
          columns: exportData.columns,
          columnTypes: exportData.columnTypes,
          rows: exportData.rows,
        });
        await saveTextFile(content, exportFileName(tableMeta.value?.tableName || "export", "sql", { preferFallback: true }), "SQL", "sql");
        toast(t("grid.exported"));
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function exportCurrentPageSql() {
    await runExclusiveExport(async () => {
      try {
        const result = await resultToExport(undefined, undefined, false);
        const exportData = sqlInsertExportData(result);
        const content = await formatSqlInsert({
          databaseType: databaseType.value,
          schema: tableMeta.value?.schema,
          tableName: tableMeta.value?.tableName || "table_name",
          columns: exportData.columns,
          columnTypes: exportData.columnTypes,
          rows: exportData.rows,
        });
        await saveTextFile(content, exportFileName("export-page", "sql", { page: true }), "SQL", "sql");
        toast(t("grid.exported"));
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
      }
    });
  }

  async function copySql() {
    if (!sql.value) return;
    await copyText(sql.value);
  }

  function sqlInsertExportData(result: { columns: string[]; rows: CellValue[][] }): {
    columns: string[];
    columnTypes?: Array<string | undefined>;
    rows: CellValue[][];
  } {
    const exportColumns = tableMeta.value ? effectiveColumns(sourceColumns.value, result.columns) : result.columns;
    const columnIndexes = exportColumns.map((column, index) => ({ column, index })).filter((item): item is { column: string; index: number } => !!item.column);
    return {
      columns: columnIndexes.map((item) => item.column),
      columnTypes: tableMeta.value ? columnIndexes.map((item) => columnTypes.value?.[item.index]) : undefined,
      rows: result.rows.map((row) => columnIndexes.map((item) => row[item.index] ?? null)),
    };
  }

  function exportFileName(fallbackBaseName: string, extension: string, options: { page?: boolean; allResults?: boolean; preferFallback?: boolean } = {}): string {
    const rawBaseName = options.preferFallback ? fallbackBaseName : exportFileBaseName?.value || fallbackBaseName;
    return defaultDataGridExportFileName(rawBaseName, fallbackBaseName, extension, options);
  }

  return {
    copyText,
    copyCell,
    copyRow,
    copyRowAsInsert,
    copyRowAsInsertWithoutPrimaryKeys,
    prefetchRowAsInsertStatement,
    canCopyPreparedInsert,
    copyPreparedRowAsInsert,
    prefetchRowAsUpdateStatement,
    canCopyPreparedUpdate,
    copyPreparedRowAsUpdate,
    copyRowAsUpdate,
    canCopyRowAsInsertWithoutPrimaryKeys,
    canCopyRowAsUpdate,
    copyAll,
    copySelectionTsv,
    copySelectionTsvWithHeaders,
    copySelectionCsv,
    copySelectionJson,
    copySelectionSqlInList,
    copySelectedRowsTsv,
    copyColumnNames,
    exportCsv,
    exportCurrentPageCsv,
    exportJson,
    exportCurrentPageJson,
    exportMarkdown,
    exportCurrentPageMarkdown,
    exportXlsx,
    exportCurrentPageXlsx,
    exportAllResultsXlsx,
    exportSql,
    exportCurrentPageSql,
    copySql,
  };
}

async function saveTextFile(content: string, defaultFileName: string, filterName: string, filterExt: string) {
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: defaultFileName,
      filters: [{ name: filterName, extensions: [filterExt] }],
    });
    if (path) await writeTextFile(path, content);
    return;
  }

  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultFileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function defaultDataGridExportFileName(baseName: string | undefined, fallbackBaseName: string, extension: string, options: { page?: boolean; allResults?: boolean } = {}): string {
  const sanitizedBaseName = sanitizeExportBaseName(baseName || "") || sanitizeExportBaseName(fallbackBaseName) || "export";
  const suffix = options.allResults ? "results" : options.page ? "page" : "";
  return [sanitizedBaseName, suffix, compactLocalTimestamp()].filter(Boolean).join("_") + `.${extension}`;
}

function sanitizeExportBaseName(value: string): string {
  return replaceControlCharacters(
    value
      .trim()
      .replace(/\.[sS][qQ][lL]$/, "")
      .replace(/[<>:"/\\|?*]/g, "_"),
    "_",
  )
    .replace(/\s+/g, " ")
    .replace(/[._\s-]+$/g, "")
    .slice(0, 120);
}

function replaceControlCharacters(value: string, replacement: string): string {
  return Array.from(value)
    .map((char) => (char.charCodeAt(0) < 32 ? replacement : char))
    .join("");
}

function compactLocalTimestamp(date = new Date()): string {
  const yy = String(date.getFullYear() % 100).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${yy}${month}${day}${hour}${minute}${second}`;
}

function effectiveColumns(sourceColumns: Array<string | undefined> | undefined, columns: string[]): Array<string | undefined> {
  if (!sourceColumns || sourceColumns.length !== columns.length) return columns;
  return sourceColumns;
}

function findColumnIndex(columns: Array<string | undefined>, target: string): number {
  const normalizedTarget = normalizeColumnName(target);
  return columns.findIndex((column) => (column ? normalizeColumnName(column) : "") === normalizedTarget);
}

function normalizeColumnName(name: string): string {
  return name.toUpperCase();
}
