import { computed, type ComputedRef, type Ref, createApp, watch, getCurrentScope, onScopeDispose } from "vue";
import { getActivePinia } from "pinia";
import { useI18n } from "vue-i18n";
import { useDataGridExtractor } from "@/composables/useDataGridExtractor";
import { mysqlDataCharsetAllowsExport } from "@/lib/connection/mysqlDataCharset";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { promptExportSavePath } from "@/lib/export/exportPath";
import { saveTextFile, sanitizeExportBaseName, compactLocalTimestamp } from "@/lib/export/saveTextFile";
import { notifyExportComplete } from "@/lib/export/exportReveal";
import { dropsSchemaQualifier } from "@/lib/table/tableSelectSql";
import * as api from "@/lib/backend/api";
import { type CellSelectionMatrix, type CellSelectionRange, type SelectionData } from "@/lib/dataGrid/gridSelection";
import { DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, type DataGridCopyExtractorId, type DataGridExtractRequest, type DataGridExtractorOptions, type DataGridPrimaryKeyMode } from "@/lib/dataGrid/dataGridCopyExtractor";
import { useToast } from "@/composables/useToast";
import { useExportTracker } from "@/composables/useExportTracker";
import { clipboardCellValue, type CellValue } from "@/lib/dataGrid/cellValue";
import { binaryCellClipboardText } from "@/lib/dataGrid/binaryCellDownload";
import { materializeSnapshotResultRows, waitForLargeValueSnapshot } from "@/lib/dataGrid/largeValueSnapshot";
import { snapshotExportSelection, assertSnapshotXlsxCellLengths } from "@/lib/dataGrid/snapshotExport";
import { tryStartExclusiveActivation, type ActionActivationGuard } from "@/lib/connection/actionActivation";
import { clipboardLineEndings, copyRichTextToClipboard, copyToClipboard } from "@/lib/common/clipboard";
import { clearDataGridClipboardCopy, rememberDataGridClipboardCopy } from "@/lib/dataGrid/dataGridClipboard";
import { buildDataGridCopyInsertStatement, type DataGridColumnInfo, type DataGridCopyInsertMode, type DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";
import { formatSqlInsert, formatTsv } from "@/lib/export/exportFormats";
import { showSqlInsertModeDialog, type SqlExportColumnSelection, type SqlExportOptions, type SqlInsertMode } from "@/lib/export/sqlInsertMode";
import { resolveSqlExportColumnIndexes, sqlExportColumnChoices } from "@/lib/export/sqlExportColumns";
import { summarizeExportRows } from "@/lib/export/exportDiagnostics";
import { appendDebugLog, appendNativeProcessMemoryLog, getBrowserMemorySnapshot, isDebugLoggingEnabled } from "@/lib/backend/debugLog";
import { uuid } from "@/lib/common/utils";
import { useSettingsStore } from "@/stores/settingsStore";
import { csvNullLiteralForMode } from "@/lib/export/csvNullMode";
import { expandNestedJsonStringsForCopy } from "@/lib/common/jsonCopyValue";
import { buildMongoCopyDocumentFromOriginal, buildMongoCopyInsertDocument, buildMongoCopyUpdateDocument, formatMongoShellLiteral, type MongoInputValue } from "@/lib/mongo/mongoDocumentValues";
import { formatMongoShellText } from "@/lib/mongo/mongoFormatter";
import { isTemporalColumnType } from "@/lib/dataGrid/columnFormatter";
import type { DatabaseType, QueryResult } from "@/types/database";
import type { QueryResultExportRequest } from "@/lib/backend/api";
import { usesSyntheticRowIdKey } from "@/lib/table/tableEditing";
import { buildXlsxSqlWorksheet } from "@/lib/export/xlsxSqlSheet";
import { formatTemporalRowsForExport } from "@/lib/dataGrid/columnFormatter";
import { translateBackendError } from "@/i18n/backend-errors";
import XlsxHeaderDialog from "@/components/export/XlsxHeaderDialog.vue";
import i18n from "@/i18n";
import { buildXlsxHeaderOverrides, hasXlsxHeaderComments, xlsxHeaderUsesCommentRows, type XlsxExportOptions, type XlsxHeaderMode } from "@/lib/export/xlsxHeader";
import { isPartiallyLoadedCopy, partialLoadCopyHintKey, type PartialLoadCopyInfo } from "@/lib/dataGrid/copyPartialLoadHint";
import { showExportExecutionModeDialog } from "@/lib/export/exportExecutionMode";
import { SnapshotCompletionError } from "@/lib/export/snapshotCompletion";
import type { CapturedLegacyLargeValueExport } from "@/lib/dataGrid/legacyLargeValueExport";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import type { ManualExportMode } from "@/lib/export/manualExportQueue";

/**
 * Format metadata for backend table exports. Each entry maps a format key
 * to its default file extension and native save-dialog filter label.
 *
 * When a new export format is added only this table needs to be updated;
 * the extension / filterName ternary chains that used to live inside
 * exportFullTableDataViaBackend / exportQueryResultViaBackend are no
 * longer needed.
 */
const FORMAT_META: Record<string, { ext: string; label: string }> = {
  csv: { ext: "csv", label: "CSV" },
  xlsx: { ext: "xlsx", label: "Excel" },
  json: { ext: "json", label: "JSON" },
  markdown: { ext: "md", label: "Markdown" },
  html: { ext: "html", label: "HTML" },
  sql: { ext: "sql", label: "SQL" },
  txt: { ext: "txt", label: "Text" },
};

export interface DataGridExportTarget {
  rowIds?: number[];
  columnIndexes?: number[];
}

export type ExportTargetParam = number[] | DataGridExportTarget;

export function normalizeExportTarget(target?: ExportTargetParam, columnIndexesParam?: number[]): { rowIds?: number[]; columnIndexes?: number[] } {
  if (Array.isArray(target)) {
    return { rowIds: target, columnIndexes: columnIndexesParam };
  }
  return {
    rowIds: target?.rowIds,
    columnIndexes: columnIndexesParam ?? target?.columnIndexes,
  };
}

export interface DataGridExportSheet {
  sheetName: string;
  result: QueryResult;
  sql?: string;
  captureSourceValues?: () => CapturedLegacyLargeValueExport;
}

interface RowItem {
  id: number;
  sourceIndex?: number;
  newIndex?: number;
  data: CellValue[];
  isNew: boolean;
  isDraft?: boolean;
  isDeleted: boolean;
  isDirtyCol: boolean[];
  status: string;
}

export interface MongoCopyUpdateTarget {
  collection: string;
  idColumn: "_id";
}

export interface UseDataGridExportOptions {
  mysqlDataCharsetReadOnly?: ComputedRef<boolean>;
  columns: ComputedRef<string[]>;
  displayItems: ComputedRef<RowItem[]>;
  allColumns?: ComputedRef<string[]>;
  allDisplayItems?: ComputedRef<RowItem[]>;
  allSourceColumns?: ComputedRef<Array<string | undefined> | undefined>;
  visibleColumnIndexes?: ComputedRef<number[]>;
  extractorOptions?: ComputedRef<DataGridExtractorOptions>;
  sql: ComputedRef<string | undefined>;
  exportSql?: ComputedRef<string | undefined>;
  pageSql?: ComputedRef<string | undefined>;
  tableMeta: ComputedRef<DataGridTableMeta | undefined>;
  /** Editor setting "Include database name in generated SQL" — passed through to SQL extractors and INSERT exports. */
  includeDatabaseName?: ComputedRef<boolean>;
  /** True only when query metadata resolves exactly one source table as the INSERT target. */
  hasUniqueQueryInsertTarget?: ComputedRef<boolean>;
  copyInsertTargetLabel?: ComputedRef<string | undefined>;
  mongoUpdateTarget?: ComputedRef<MongoCopyUpdateTarget | undefined>;
  databaseType: ComputedRef<DatabaseType | undefined>;
  displayValue?: (value: CellValue, columnIndex: number) => string;
  captureColumnFormatterDisplay?: () => (value: CellValue, columnIndex: number) => string;
  editValue?: (value: CellValue, columnIndex: number) => string;
  hasColumnFormatter?: (columnIndex: number) => boolean;
  applyColumnFormattersOnExport?: ComputedRef<boolean>;
  cellClipboardText?: (value: CellValue, columnIndex: number) => string | undefined;
  externalCellValue?: (value: CellValue, columnIndex: number) => CellValue;
  identifierQuote?: ComputedRef<string | undefined>;
  connectionId: ComputedRef<string | undefined>;
  database: ComputedRef<string | undefined>;
  context: ComputedRef<"results" | "table-data" | undefined>;
  sourceColumns: ComputedRef<Array<string | undefined> | undefined>;
  columnComments?: ComputedRef<Array<string | undefined>>;
  allColumnComments?: ComputedRef<Array<string | undefined>>;
  mongoDocuments?: ComputedRef<unknown[] | undefined>;
  spatialColumns?: ComputedRef<QueryResult["spatial_columns"] | undefined>;
  spatialValues?: ComputedRef<QueryResult["spatial_values"] | undefined>;
  columnTypes: ComputedRef<Array<string | undefined> | undefined>;
  allColumnTypes?: ComputedRef<Array<string | undefined> | undefined>;
  whereInput: ComputedRef<string | undefined>;
  orderBy: ComputedRef<string | undefined>;
  exportBatchSize: ComputedRef<number>;
  hasCellSelection: ComputedRef<boolean>;
  hasColumnSelection?: ComputedRef<boolean>;
  selectedCells: ComputedRef<SelectionData>;
  selectedCellMatrix: ComputedRef<CellSelectionMatrix | null>;
  selectedRange: ComputedRef<CellSelectionRange | null>;
  contextCell: Ref<{ rowId: number; rowIndex: number; col: number } | null> | ComputedRef<{ rowId: number; rowIndex: number; col: number } | null>;
  contextSelectionIsSynthetic: Ref<boolean> | ComputedRef<boolean>;
  getRowItem: (rowId: number) => RowItem | undefined;
  selectedRowIds: Ref<Set<number>> | ComputedRef<Set<number>>;
  hasRowSelection: ComputedRef<boolean>;
  resolveSourceValues?: (rowIds: number[], sourceColumnIndexes: number[]) => Promise<Map<number, Map<number, CellValue>>>;
  captureSourceValues?: (cells: Array<{ rowId: number; sourceIndex: number; columnIndex: number }>) => (signal: AbortSignal) => Promise<Map<number, Map<number, CellValue>>>;
  fullExportResult?: (onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void, control?: { signal: AbortSignal }) => Promise<QueryResult | undefined>;
  captureFullExportResult?: () => UseDataGridExportOptions["fullExportResult"];
  captureQueryResultExportRequest?: (queued: boolean) => UseDataGridExportOptions["queryResultExportRequest"];
  queryResultExportRequest?: (options: {
    exportId: string;
    filePath: string;
    format: "csv" | "xlsx" | "json" | "txt" | "sql";
    includeSqlSheet?: boolean;
    exportTableName?: string;
    exportSchema?: string;
    exportColumnTypes?: Array<string | null | undefined>;
    exportColumnExtras?: Array<string | null | undefined>;
    insertMode?: SqlInsertMode;
  }) => Promise<QueryResultExportRequest | undefined>;
  /**
   * True when the in-memory result already holds the complete result set —
   * i.e. the query ran without server-side pagination, was not truncated, and
   * has no further pages. When true, full-result exports skip the re-executing
   * backend/frontend streaming paths and write the local rows directly, so a
   * slow query is never re-run just to export rows that are already on screen.
   */
  hasCompleteLocalResult?: ComputedRef<boolean>;
  /** Present when the grid cannot guarantee the whole result set is loaded; drives the partial-copy hint. */
  partialLoadCopyInfo?: ComputedRef<PartialLoadCopyInfo | null>;
  /**
   * The raw in-memory QueryResult to use for "export all" when
   * hasCompleteLocalResult is true. Exports the original query result (all
   * rows, all columns, committed values) so the output matches the original
   * re-run-SQL semantics — displayItems only covers visible columns and
   * reflects client-side filters/search and unsaved edits, which would
   * silently change what "export all data" produces.
   */
  completeLocalResult?: ComputedRef<QueryResult | undefined>;
  snapshotResult?: ComputedRef<QueryResult>;
  allExportResults?: ComputedRef<DataGridExportSheet[] | undefined>;
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
    filePath: string | null;
    startedAt?: number;
    finishedAt?: number;
  }>;
  exportCancelHandler?: Ref<(() => Promise<void>) | null>;
  exportCanMinimize?: Ref<boolean>;
}

interface CopyInsertData {
  columns: string[];
  sourceColumns?: Array<string | undefined>;
  columnTypes?: Array<string | undefined>;
  rows: RowItem[];
}

export function useDataGridExport(options: UseDataGridExportOptions) {
  const activeSnapshotCancels = new Set<() => Promise<void>>();
  let scopeDisposed = false;
  if (getCurrentScope())
    onScopeDispose(() => {
      scopeDisposed = true;
      for (const cancel of activeSnapshotCancels) void cancel().catch(() => undefined);
    });
  const { t } = useI18n();
  const { toast } = useToast();
  const tracker = useExportTracker();
  const exportGuard: ActionActivationGuard = {};
  let currentExportViewId: string | undefined;
  function allowExport(format: string): boolean {
    if (mysqlDataCharsetAllowsExport(options.mysqlDataCharsetReadOnly?.value === true, format)) return true;
    toast(t("connection.mysqlDataCharsetExportHint"), 5000);
    return false;
  }

  const {
    columns,
    displayItems,
    allColumns: allColumnsOption,
    allDisplayItems: allDisplayItemsOption,
    allSourceColumns: allSourceColumnsOption,
    visibleColumnIndexes: visibleColumnIndexesOption,
    extractorOptions: extractorOptionsOption,
    sql,
    exportSql: resultExportSql,
    pageSql: resultPageSql,
    tableMeta,
    hasUniqueQueryInsertTarget,
    copyInsertTargetLabel,
    sourceColumns,
    columnComments: columnCommentsOption,
    allColumnComments: allColumnCommentsOption,
    databaseType,
    identifierQuote,
    connectionId,
    database,
    context,
    spatialColumns: spatialColumnsOption,
    spatialValues: spatialValuesOption,
    whereInput,
    orderBy,
    columnTypes,
    allColumnTypes: allColumnTypesOption,
    exportBatchSize,
    hasCellSelection,
    hasColumnSelection: hasColumnSelectionOption,
    selectedCells,
    selectedCellMatrix: selectedCellMatrixOption,
    selectedRange,
    contextCell,
    contextSelectionIsSynthetic,
    getRowItem,
    selectedRowIds,
    hasRowSelection,
    resolveSourceValues,
    fullExportResult,
    queryResultExportRequest,
    hasCompleteLocalResult,
    partialLoadCopyInfo,
    completeLocalResult,
    allExportResults,
    currentResultLabel,
    exportFileBaseName,
    exportProgressDialog,
    exportProgressState,
    exportCancelHandler,
    exportCanMinimize,
  } = options;
  const selectedCellMatrix = selectedCellMatrixOption;
  const allColumns = allColumnsOption ?? columns;
  const allDisplayItems = allDisplayItemsOption ?? displayItems;
  const allSourceColumns = allSourceColumnsOption ?? sourceColumns;
  const allColumnTypes = computed(() => allColumnTypesOption?.value ?? columnTypes.value);
  const visibleColumnIndexes = visibleColumnIndexesOption ?? computed(() => columns.value.map((_, index) => index));
  const hasColumnSelection = hasColumnSelectionOption ?? computed(() => false);

  async function copyText(text: string, gridCopy?: { rows: readonly (readonly unknown[])[]; header?: readonly unknown[] }, richHtml?: string) {
    const copiedRows = gridCopy?.rows.map((row) => [...row]);
    const copiedHeader = gridCopy?.header ? [...gridCopy.header] : undefined;
    clearDataGridClipboardCopy();
    try {
      if (richHtml !== undefined) await copyRichTextToClipboard(richHtml, text);
      else await copyToClipboard(text);
      // Remember the text as it now sits on the clipboard, so a paste back into
      // the grid still matches and keeps its null-cell metadata.
      if (copiedRows) rememberDataGridClipboardCopy(clipboardLineEndings(text), copiedRows, copiedHeader);
      toast(t("grid.copied"));
      return true;
    } catch (e: any) {
      toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
      return false;
    }
  }

  function rowsToExport(rowIds?: number[]): RowItem[] {
    if (rowIds === undefined) return displayItems.value.filter((item) => !item.isDraft);
    const rowIdSet = new Set(rowIds);
    return displayItems.value.filter((item) => rowIdSet.has(item.id) && !item.isDraft);
  }

  async function resolveVisibleRowValues(items: RowItem[], visibleIndexes = visibleColumnIndexes.value): Promise<RowItem[]> {
    if (!resolveSourceValues || items.length === 0 || visibleIndexes.length === 0) return items;
    const resolved = await resolveSourceValues(
      items.map((item) => item.id),
      visibleIndexes,
    );
    if (resolved.size === 0) return items;
    return items.map((item) => {
      const values = resolved.get(item.id);
      if (!values) return item;
      const data = [...item.data];
      visibleIndexes.forEach((sourceIndex) => {
        const visibleIndex = visibleColumnIndexes.value.indexOf(sourceIndex);
        if (visibleIndex >= 0 && values.has(sourceIndex)) data[visibleIndex] = values.get(sourceIndex) ?? null;
      });
      return { ...item, data };
    });
  }

  async function materializeExportSnapshot(result: QueryResult, isResultCurrent: () => boolean): Promise<QueryResult["rows"]> {
    if (result.large_value_cells?.some((cell) => cell.pending_decode)) throw new Error(t("grid.largeValuePendingDecodeExport"));
    if (!result.large_value_cells?.some((cell) => cell.value_ref)) return result.rows;
    const originalConnectionId = connectionId.value;
    const originalDatabase = database.value;
    const isCurrent = () => !scopeDisposed && isResultCurrent() && connectionId.value === originalConnectionId && database.value === originalDatabase;
    if (!isCurrent()) throw new Error("LOB result context changed");
    const executionId = uuid();
    const controller = new AbortController();
    const cancel = async () => {
      controller.abort(new Error("LOB export cancelled locally"));
      await api.cancelQuery(executionId);
    };
    activeSnapshotCancels.add(cancel);
    const previousCancel = exportCancelHandler?.value;
    if (exportCancelHandler) exportCancelHandler.value = cancel;
    const stop = watch(
      isCurrent,
      (current) => {
        if (!current) void cancel().catch(() => undefined);
      },
      { flush: "sync" },
    );
    try {
      return await materializeSnapshotResultRows(result, isCurrent, controller.signal, executionId);
    } finally {
      stop();
      activeSnapshotCancels.delete(cancel);
      if (exportCancelHandler?.value === cancel) exportCancelHandler.value = previousCancel ?? null;
    }
  }

  function shouldApplyColumnFormatter(columnIndex: number): boolean {
    if (!options.hasColumnFormatter?.(columnIndex)) return false;
    if (options.applyColumnFormattersOnExport?.value !== undefined) {
      return options.applyColumnFormattersOnExport.value;
    }
    return getActivePinia() ? useSettingsStore().editorSettings.applyColumnFormattersOnExport : true;
  }

  function applyGlobalDateTimeExportFormat(result: { columns: string[]; columnTypes: string[]; rows: CellValue[][] }, enabled: boolean, sourceIndexes?: number[]) {
    const pattern = enabled ? useSettingsStore().editorSettings.globalDateTimeExportFormat : "";
    if (!pattern) return result;
    const applyFormatters = options.applyColumnFormattersOnExport?.value ?? (getActivePinia() ? useSettingsStore().editorSettings.applyColumnFormattersOnExport : true);
    const effectiveTypes = result.columnTypes.map((type, colIdx) => {
      const sourceIdx = sourceIndexes ? sourceIndexes[colIdx] : (visibleColumnIndexesOption?.value?.[colIdx] ?? colIdx);
      if (applyFormatters && sourceIdx !== undefined && options.hasColumnFormatter?.(sourceIdx)) {
        return undefined;
      }
      return type;
    });
    return { ...result, rows: formatTemporalRowsForExport(result.rows, effectiveTypes, pattern) };
  }

  function tableCommentsForColumns(targetColumns: readonly string[]): Array<string | undefined> {
    const meta = tableMeta.value;
    if (!meta?.columns) return targetColumns.map(() => undefined);
    const commentMap = new Map<string, string>();
    for (const col of meta.columns) {
      if (col.comment) commentMap.set(col.name.toLocaleLowerCase(), col.comment);
    }
    return targetColumns.map((column) => commentMap.get(column.toLocaleLowerCase()));
  }

  const visibleXlsxColumnComments = computed(() => columnCommentsOption?.value ?? tableCommentsForColumns(columns.value));
  const allXlsxColumnComments = computed(() => allColumnCommentsOption?.value ?? tableCommentsForColumns(allColumns.value));

  function commentsForExportColumns(targetColumns: readonly string[], preferAllColumns = true): Array<string | undefined> {
    return captureExportColumnComments(preferAllColumns)(targetColumns);
  }

  function captureExportColumnComments(preferAllColumns = true) {
    const sourceColumns = [...(preferAllColumns ? allColumns.value : columns.value)];
    const sourceComments = [...(preferAllColumns ? allXlsxColumnComments.value : visibleXlsxColumnComments.value)];
    const metadataColumns = tableMeta.value?.columns?.map((column) => ({ name: column.name, comment: column.comment })) ?? [];
    return (targetColumns: readonly string[]): Array<string | undefined> => {
      if (targetColumns.length === sourceColumns.length && targetColumns.every((column, index) => column === sourceColumns[index])) {
        return [...sourceComments];
      }

      const commentsByName = new Map<string, string>();
      sourceColumns.forEach((column, index) => {
        const comment = sourceComments[index];
        if (comment) commentsByName.set(column.toLocaleLowerCase(), comment);
      });
      for (const column of metadataColumns) {
        if (column.comment && !commentsByName.has(column.name.toLocaleLowerCase())) {
          commentsByName.set(column.name.toLocaleLowerCase(), column.comment);
        }
      }
      return targetColumns.map((column) => commentsByName.get(column.toLocaleLowerCase()));
    };
  }

  function showXlsxHeaderDialog(showExecutionMode = false): Promise<XlsxExportOptions | null> {
    if (typeof document === "undefined") return Promise.resolve({ headerMode: "name", autoFilter: false });

    return new Promise((resolve) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const app = createApp(XlsxHeaderDialog, {
        open: true,
        showExecutionMode,
        showHeaderOptions: hasXlsxHeaderComments(allXlsxColumnComments.value) || hasXlsxHeaderComments(visibleXlsxColumnComments.value),
        onConfirm: (exportOptions: XlsxExportOptions) => {
          resolve(exportOptions);
          app.unmount();
          document.body.removeChild(container);
        },
        onCancel: () => {
          resolve(null);
          app.unmount();
          document.body.removeChild(container);
        },
      });
      app.use(i18n);
      app.mount(container);
    });
  }

  function normalizeCompleteLocalResult(
    result: QueryResult,
    targetCols?: readonly string[],
    sourceIndexesParam?: readonly number[],
  ): { columns: string[]; columnTypes: string[]; columnComments: Array<string | undefined>; rows: CellValue[][]; mongoCopyDocuments?: unknown[]; spatialColumns?: QueryResult["spatial_columns"]; spatialValues?: QueryResult["spatial_values"] } {
    const editorSettings = useSettingsStore().editorSettings;
    const isSubset = targetCols !== undefined && (targetCols.length !== result.columns.length || !targetCols.every((col, i) => col === result.columns[i]));
    if (databaseType.value === "mongodb" || isSubset) {
      const projected = projectResultColumns(result, targetCols ?? columns.value, sourceIndexesParam);
      const rows = editorSettings.exportRowLimitEnabled ? projected.rows.slice(0, editorSettings.exportRowLimit) : projected.rows;
      return {
        columns: projected.columns,
        columnTypes: projected.columnTypes,
        columnComments: commentsForExportColumns(projected.columns),
        rows,
        mongoCopyDocuments: result.mongo_copy_documents?.slice(0, rows.length),
        spatialColumns: projected.spatialColumns,
        spatialValues: projected.spatialValues?.slice(0, rows.length),
      };
    }

    const hiddenColumnIndexes = new Set(result.hidden_column_indexes ?? []);
    const exportedColumnIndexes = result.columns.map((_, index) => index).filter((index) => !hiddenColumnIndexes.has(index));
    const hasHiddenColumns = exportedColumnIndexes.length !== result.columns.length;
    const rows = editorSettings.exportRowLimitEnabled ? result.rows.slice(0, editorSettings.exportRowLimit) : result.rows;
    const targetIndexBySource = new Map(exportedColumnIndexes.map((sourceIndex, index) => [sourceIndex, index]));

    // Internal key columns are query-only metadata. Keep every user column,
    // including columns hidden manually in the grid, while preserving alignment.
    return {
      columns: hasHiddenColumns ? exportedColumnIndexes.map((index) => result.columns[index]!) : result.columns,
      columnTypes: hasHiddenColumns ? exportedColumnIndexes.map((index) => result.column_types?.[index] ?? "") : (result.column_types ?? []),
      columnComments: hasHiddenColumns ? exportedColumnIndexes.map((index) => allXlsxColumnComments.value[index]) : [...allXlsxColumnComments.value],
      rows: hasHiddenColumns ? rows.map((row) => exportedColumnIndexes.map((index) => row[index])) : rows,
      mongoCopyDocuments: result.mongo_copy_documents?.slice(0, rows.length),
      spatialColumns: result.spatial_columns?.flatMap((column) => {
        const columnIndex = targetIndexBySource.get(column.column_index);
        return columnIndex === undefined ? [] : [{ ...column, column_index: columnIndex }];
      }),
      spatialValues: result.spatial_values?.slice(0, rows.length).map((row) => exportedColumnIndexes.map((index) => row[index] ?? null)),
    };
  }

  function mongoDocumentRowsForJson(columnsToExport: string[], rows: CellValue[][], documents: unknown[] | undefined, isMongo = databaseType.value === "mongodb"): CellValue[][] {
    if (!isMongo || !documents || documents.length !== rows.length) return rows;
    return rows.map((row, rowIndex) => {
      const document = documents[rowIndex];
      if (!document || typeof document !== "object" || Array.isArray(document)) return row;
      const source = document as Record<string, unknown>;
      return columnsToExport.map((column) => (Object.prototype.hasOwnProperty.call(source, column) ? (source[column] as CellValue) : null));
    });
  }

  function projectResultColumns(
    result: QueryResult,
    targetColumns: readonly string[],
    sourceIndexesParam?: readonly number[],
  ): {
    columns: string[];
    columnTypes: string[];
    rows: CellValue[][];
    spatialColumns?: QueryResult["spatial_columns"];
    spatialValues?: QueryResult["spatial_values"];
  } {
    // Name lookup resolves duplicate column names (e.g. SELECT a.id, b.id) to
    // the first occurrence; prefer the caller's explicit source indexes.
    const sourceIndexes = sourceIndexesParam?.length === targetColumns.length ? sourceIndexesParam.map((index) => (index >= 0 && index < result.columns.length ? index : -1)) : targetColumns.map((column) => result.columns.indexOf(column));
    const targetIndexBySource = new Map<number, number>();
    sourceIndexes.forEach((sourceIndex, targetIndex) => {
      if (sourceIndex >= 0) targetIndexBySource.set(sourceIndex, targetIndex);
    });
    return {
      columns: [...targetColumns],
      columnTypes: sourceIndexes.map((sourceIndex) => (sourceIndex >= 0 ? (result.column_types?.[sourceIndex] ?? "") : "")),
      rows: result.rows.map((row) => sourceIndexes.map((sourceIndex) => (sourceIndex >= 0 ? (row[sourceIndex] ?? null) : null))),
      spatialColumns: result.spatial_columns?.flatMap((column) => {
        const targetIndex = targetIndexBySource.get(column.column_index);
        return targetIndex === undefined ? [] : [{ ...column, column_index: targetIndex }];
      }),
      spatialValues: result.spatial_values?.map((row) => sourceIndexes.map((sourceIndex) => (sourceIndex >= 0 ? (row[sourceIndex] ?? null) : null))),
    };
  }

  function mongoLocalRowsForJson(items: RowItem[], targetCols: readonly string[] = columns.value): CellValue[][] {
    return items.map((item) => {
      const document = rowToJsonObject(item);
      return targetCols.map((column) => (document[column] as CellValue) ?? null);
    });
  }

  function externalizeRows(rows: CellValue[][], columnIndexes?: number[], applyFormatters = true, sourceIndexes?: number[]): CellValue[][] {
    if (columnIndexes) {
      return rows.map((row) => columnIndexes.map((colIdx, i) => externalCellValue(row[colIdx], colIdx, sourceIndexes?.[i], applyFormatters)));
    }
    if (sourceIndexes) {
      return rows.map((row) => row.map((value, colIdx) => externalCellValue(value, colIdx, sourceIndexes[colIdx], applyFormatters)));
    }
    return rows.map((row) => row.map((value, columnIndex) => externalCellValue(value, columnIndex, undefined, applyFormatters)));
  }

  function captureFullResultProjection(columnIndexes: number[] | undefined, formatDateTime: boolean, headerMode: XlsxHeaderMode, preserveMongoExtendedJson: boolean) {
    const isMongo = databaseType.value === "mongodb";
    const isOracle = databaseType.value === "oracle" || databaseType.value === "oceanbase-oracle";
    const indexes = (columnIndexes ?? columns.value.map((_, index) => index)).filter((index) => index >= 0 && index < columns.value.length);
    const targetColumns = indexes.map((index) => columns.value[index]!);
    const sourceIndexes = visibleColumnIndexesOption?.value ? indexes.map((index) => visibleColumnIndexesOption.value?.[index] ?? index) : undefined;
    const comments = captureExportColumnComments();
    const settings = { ...useSettingsStore().editorSettings };
    const formattedIndexes = new Set(allColumns.value.map((_, index) => index).filter((index) => shouldApplyColumnFormatter(index)));
    const display = options.captureColumnFormatterDisplay?.() ?? options.displayValue;
    return (result: QueryResult): Awaited<ReturnType<typeof resultToExport>> => {
      if (result.large_value_cells?.some((cell) => cell.pending_decode)) throw new Error(t("grid.largeValuePendingDecodeExport"));
      const projected = isMongo || columnIndexes !== undefined ? projectResultColumns(result, targetColumns, sourceIndexes) : undefined;
      const exportedColumns = projected?.columns ?? result.columns;
      const exportedTypes = projected?.columnTypes ?? result.column_types ?? [];
      const rawRows = projected?.rows ?? result.rows;
      const rows =
        preserveMongoExtendedJson && isMongo
          ? mongoDocumentRowsForJson(exportedColumns, rawRows, result.mongo_copy_documents, true)
          : rawRows.map((row) =>
              row.map((value, index) => {
                const sourceIndex = sourceIndexes?.[index] ?? index;
                return formatDateTime && display && value !== null && (formattedIndexes.has(sourceIndex) || (isOracle && isTemporalColumnType(exportedTypes[index]))) ? display(value, sourceIndex) : value;
              }),
            );
      const effectiveTypes = exportedTypes.map((type, index) => (formattedIndexes.has(sourceIndexes?.[index] ?? index) ? undefined : type));
      return {
        columns: exportedColumns,
        columnTypes: exportedTypes,
        columnComments: buildXlsxHeaderOverrides(exportedColumns, comments(exportedColumns), headerMode),
        rows: formatDateTime && !preserveMongoExtendedJson && settings.globalDateTimeExportFormat ? formatTemporalRowsForExport(rows, effectiveTypes, settings.globalDateTimeExportFormat) : rows,
        spatialColumns: projected?.spatialColumns ?? result.spatial_columns,
        spatialValues: projected?.spatialValues ?? result.spatial_values,
      };
    };
  }

  async function resultToExport(
    target?: ExportTargetParam,
    onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void,
    useFullExport = true,
    formatDateTime = true,
    headerMode: XlsxHeaderMode = "name",
    preserveMongoExtendedJson = false,
    columnIndexesParam?: number[],
    sourceValuesAlreadyComplete = false,
  ): Promise<{
    columns: string[];
    columnTypes: string[];
    columnComments?: (string | null)[];
    spatialColumns?: QueryResult["spatial_columns"];
    spatialValues?: QueryResult["spatial_values"];
    rows: CellValue[][];
  }> {
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
    const hasColumnSubset = columnIndexes !== undefined;
    const validColumnIndexes = hasColumnSubset ? columnIndexes.filter((index) => index >= 0 && index < columns.value.length) : columns.value.map((_, index) => index);
    const targetColumns = validColumnIndexes.map((index) => columns.value[index]!);
    const targetColumnTypes = (columnTypes.value ?? []).length === columns.value.length ? validColumnIndexes.map((index) => columnTypes.value?.[index] ?? "") : targetColumns.map(() => "");
    const visibleSourceIndexes = visibleColumnIndexesOption?.value;
    // Explicit source indexes are only meaningful when the grid maps visible
    // columns to result positions; otherwise keep name-based resolution.
    const projectionSourceIndexes = visibleSourceIndexes ? validColumnIndexes.map((targetIdx) => visibleSourceIndexes[targetIdx] ?? targetIdx) : undefined;

    if (useFullExport && rowIds === undefined && fullExportResult && !hasCompleteLocalResult?.value) {
      const project = captureFullResultProjection(columnIndexes, formatDateTime, headerMode, preserveMongoExtendedJson);
      const result = await fullExportResult(onProgress);
      if (result) {
        if (result.large_value_cells?.some((cell) => cell.pending_decode)) throw new Error(t("grid.largeValuePendingDecodeExport"));
        // fullExportResult returns source rows, not the collection grid's
        // marker-encoded rows. Applying the Mongo externalCellValue decode here would
        // mistake a real BSON string in the reserved namespace for a grid marker and
        // corrupt the exported value — only the formatter-gated displayValue may run.
        return project(result);
      }
    }
    // The full result is already in memory — export all rows with the source
    // result's committed values. MongoDB applies the current visible-column
    // projection above; other result types retain their existing all-column
    // semantics. displayItems only covers visible columns and reflects
    // client-side filters/search and unsaved edits, which would silently
    // change what the export contains.
    if (useFullExport && rowIds === undefined && hasCompleteLocalResult?.value && completeLocalResult?.value) {
      const original = completeLocalResult.value;
      const projected = hasColumnSubset || databaseType.value === "mongodb";
      const hiddenIndexes = new Set(original.hidden_column_indexes ?? []);
      const sourceIndexes = projected ? (projectionSourceIndexes ?? targetColumns.map((column) => original.columns.indexOf(column))) : original.columns.map((_, index) => index).filter((index) => !hiddenIndexes.has(index));
      const settings = useSettingsStore().editorSettings;
      const sourceRows = settings.exportRowLimitEnabled ? original.rows.slice(0, settings.exportRowLimit) : original.rows;
      const selected = { ...original, rows: sourceRows, large_value_cells: original.large_value_cells?.filter((cell) => cell.row_index < sourceRows.length && sourceIndexes.includes(cell.column_index)) };
      const rows = await materializeExportSnapshot(selected, () => completeLocalResult.value === original);
      const materialized = { ...original, rows };
      const normalized = hasColumnSubset || databaseType.value === "mongodb" ? normalizeCompleteLocalResult(materialized, targetColumns, projectionSourceIndexes) : normalizeCompleteLocalResult(materialized);
      const columnComments = buildXlsxHeaderOverrides(normalized.columns, normalized.columnComments, headerMode);
      return {
        ...applyGlobalDateTimeExportFormat(
          {
            columns: normalized.columns,
            columnTypes: normalized.columnTypes,
            rows: preserveMongoExtendedJson ? mongoDocumentRowsForJson(normalized.columns, normalized.rows, normalized.mongoCopyDocuments) : externalizeRows(normalized.rows, undefined, formatDateTime, sourceIndexes),
          },
          formatDateTime && !preserveMongoExtendedJson,
          sourceIndexes,
        ),
        columnComments,
        spatialColumns: normalized.spatialColumns,
        spatialValues: normalized.spatialValues,
      };
    }
    const targetComments = commentsForExportColumns(targetColumns, false);
    const commentHeader = buildXlsxHeaderOverrides(targetColumns, targetComments, headerMode);
    const visibleIndexes = visibleColumnIndexesOption?.value ?? columns.value.map((_, index) => index);
    const targetSourceIndexes = validColumnIndexes.map((targetIdx) => visibleIndexes[targetIdx] ?? targetIdx);
    const exportItems = sourceValuesAlreadyComplete ? rowsToExport(rowIds) : await resolveVisibleRowValues(rowsToExport(rowIds), targetSourceIndexes);
    const targetIndexBySource = new Map<number, number>();
    targetSourceIndexes.forEach((sourceIdx, targetIdx) => {
      targetIndexBySource.set(sourceIdx, targetIdx);
    });
    const spatialColumns = spatialColumnsOption?.value?.flatMap((column) => {
      const targetIndex = targetIndexBySource.get(column.column_index);
      return targetIndex === undefined ? [] : [{ column_index: targetIndex, srid: column.srid }];
    });
    const spatialValues = spatialValuesOption?.value;
    const mappedSpatialValues = spatialValues?.length ? exportItems.map((item) => targetSourceIndexes.map((sourceIdx) => spatialValues[item.sourceIndex ?? -1]?.[sourceIdx] ?? null)) : undefined;

    return {
      ...applyGlobalDateTimeExportFormat(
        {
          columns: targetColumns,
          columnTypes: targetColumnTypes,
          rows:
            preserveMongoExtendedJson && databaseType.value === "mongodb"
              ? mongoLocalRowsForJson(exportItems, targetColumns)
              : externalizeRows(
                  exportItems.map((item) => item.data),
                  validColumnIndexes,
                  formatDateTime,
                  targetSourceIndexes,
                ),
        },
        formatDateTime && !preserveMongoExtendedJson,
        targetSourceIndexes,
      ),
      columnComments: commentHeader,
      ...(spatialColumns?.length ? { spatialColumns } : {}),
      ...(mappedSpatialValues?.length ? { spatialValues: mappedSpatialValues } : {}),
    };
  }

  function currentXlsxSheetName(): string {
    return currentResultLabel?.value || tableMeta.value?.tableName || "Export";
  }

  function currentExportTitle(): string {
    return tableMeta.value?.tableName || currentResultLabel?.value || "Query Result";
  }

  function currentExportSql(): string | undefined {
    return resultExportSql?.value || sql.value;
  }

  function currentPageExportSql(): string | undefined {
    return resultPageSql?.value || currentExportSql();
  }

  function captureExportConfirmationSource() {
    const sourceConnection = connectionId.value;
    const sourceDatabase = database.value;
    const sourceSql = currentExportSql();
    const sourceResult = options.snapshotResult?.value;
    const sourceCompleteResult = completeLocalResult?.value;
    const table = tableMeta.value?.tableName;
    const schema = tableMeta.value?.schema;
    const catalog = tableMeta.value?.catalog;
    return () =>
      !scopeDisposed &&
      connectionId.value === sourceConnection &&
      database.value === sourceDatabase &&
      currentExportSql() === sourceSql &&
      options.snapshotResult?.value === sourceResult &&
      completeLocalResult?.value === sourceCompleteResult &&
      tableMeta.value?.tableName === table &&
      tableMeta.value?.schema === schema &&
      tableMeta.value?.catalog === catalog;
  }

  async function writeXlsxResult(outputPath: string, result: { columns: string[]; columnTypes: string[]; columnComments?: (string | null)[]; rows: CellValue[][] }, includeSqlSheet: boolean, autoFilter: boolean, sqlOverride?: string, headerCommentRows = false) {
    await captureXlsxWriter(includeSqlSheet, autoFilter, sqlOverride, headerCommentRows)(outputPath, result);
  }

  function captureXlsxWriter(includeSqlSheet: boolean, autoFilter: boolean, sqlOverride?: string, headerCommentRows = false) {
    const checkLobLengths = !!(options.snapshotResult?.value.large_value_refs?.length || options.snapshotResult?.value.large_value_cells?.some((cell) => cell.value_ref));
    const sheetName = currentXlsxSheetName();
    const effectiveSql = sqlOverride ?? currentExportSql();
    const sqlWorksheet = includeSqlSheet ? buildXlsxSqlWorksheet([{ sql: effectiveSql || "" }]) : undefined;
    const rightAlign = useSettingsStore().editorSettings.numericColumnRightAlign;
    // The rows are already rendered with the global export pattern, but the
    // workbook still needs the pattern itself so its numFmt matches; without it
    // a `SSS` pattern silently displays as `yyyy-mm-dd hh:mm:ss`.
    const dateTimeFormat = useSettingsStore().editorSettings.globalDateTimeExportFormat || undefined;
    return async (outputPath: string, result: { columns: string[]; columnTypes: string[]; columnComments?: (string | null)[]; rows: CellValue[][] }) => {
      if (checkLobLengths) assertSnapshotXlsxCellLengths(result.rows);
      if (!sqlWorksheet) {
        await api.exportQueryResultXlsx(outputPath, sheetName, result.columns, result.columnTypes, result.columnComments, result.rows, rightAlign, autoFilter, dateTimeFormat, headerCommentRows);
        return;
      }
      await api.exportQueryResultsXlsx(
        outputPath,
        [
          {
            sheetName,
            columns: result.columns,
            columnTypes: result.columnTypes,
            columnComments: result.columnComments,
            rows: result.rows,
            numericColumnRightAlign: rightAlign,
            autoFilter,
            headerCommentRows,
          },
          { ...sqlWorksheet, autoFilter: false },
        ],
        autoFilter,
        dateTimeFormat,
      );
    };
  }

  function targetedRows(): RowItem[] {
    if (hasRowSelection.value && selectedRowIds.value.size > 0) {
      return displayItems.value.filter((item) => selectedRowIds.value.has(item.id) && !item.isDraft);
    }
    const range = selectedRange.value;
    if (range && range.startRow !== range.endRow) {
      return displayItems.value.slice(range.startRow, range.endRow + 1).filter((item) => !item.isDraft);
    }
    if (!contextCell.value) return [];
    const item = getRowItem(contextCell.value.rowId);
    return item && !item.isDraft ? [item] : [];
  }

  const copyRowCount = computed(() => targetedRows().length);
  const canCopyRow = computed(() => copyRowCount.value > 0);

  function selectionInsertData(): CopyInsertData | null {
    const matrix = selectedCellMatrix.value;
    if (!matrix) return null;
    const selectedRows = matrix.rowIndexes.map((rowIndex) => displayItems.value[rowIndex]).filter((item): item is RowItem => !!item && !item.isDraft);
    if (selectedRows.length !== matrix.rowIndexes.length) return null;
    const selectedColumns = matrix.columnIndexes.map((columnIndex) => columns.value[columnIndex]).filter((column): column is string => column !== undefined);
    if (selectedColumns.length !== matrix.columnIndexes.length) return null;
    const selectedSourceColumns = sourceColumns.value?.length === columns.value.length ? matrix.columnIndexes.map((columnIndex) => sourceColumns.value?.[columnIndex]) : undefined;
    const selectedColumnTypes = columnTypes.value?.length === columns.value.length ? matrix.columnIndexes.map((columnIndex) => columnTypes.value?.[columnIndex] ?? undefined) : undefined;
    return {
      columns: selectedColumns,
      sourceColumns: selectedSourceColumns,
      columnTypes: selectedColumnTypes,
      rows: selectedRows.map((item) => ({
        ...item,
        data: matrix.columnIndexes.map((columnIndex) => item.data[columnIndex] ?? null),
        isDirtyCol: matrix.columnIndexes.map((columnIndex) => item.isDirtyCol[columnIndex] ?? false),
      })),
    };
  }

  async function buildCopyInsertStatement(data: CopyInsertData, primaryKeyMode: DataGridPrimaryKeyMode, insertMode: DataGridCopyInsertMode): Promise<string | undefined> {
    if (databaseType.value === "mongodb") {
      return formatMongoCopyStatement(
        buildMongoCopyInsertStatement({
          collection: copyInsertTargetLabel?.value || tableMeta.value?.tableName || "collection",
          columns: data.columns,
          sourceColumns: data.sourceColumns,
          rows: data.rows,
          mongoDocuments: options.mongoDocuments?.value,
          excludePrimaryKeys: primaryKeyMode !== "include",
          insertMode,
        }),
      );
    }
    return buildDataGridCopyInsertStatement({
      databaseType: databaseType.value,
      identifierQuote: options.identifierQuote?.value,
      tableMeta: tableMeta.value,
      columns: data.columns,
      columnTypes: data.columnTypes,
      sourceColumns: data.sourceColumns,
      rows: data.rows.map((item) => item.data),
      primaryKeyMode,
      insertMode,
    });
  }

  function binaryClipboardCellValue(value: CellValue, columnIndex: number): CellValue {
    return binaryCellClipboardText(value, columnTypes.value?.[columnIndex], databaseType.value) ?? value;
  }

  function isOracleTemporalColumn(columnIndex: number, sourceIndex?: number): boolean {
    const dbType = options.databaseType.value;
    if (dbType !== "oracle" && dbType !== "oceanbase-oracle") return false;
    const colType = options.columnTypes.value?.[columnIndex] ?? (sourceIndex !== undefined ? options.allColumnTypes?.value?.[sourceIndex] : undefined);
    return isTemporalColumnType(colType);
  }

  function externalCellValue(value: CellValue, columnIndex: number, sourceIndex?: number, applyFormatters = true, skipExternal = false): CellValue {
    // skipExternal serves source-row exports (full-result snapshot): those rows never
    // went through the grid's marker encoding, so decoding would mistake a real BSON
    // string in the reserved namespace for a marker (see the warning in resultToExport).
    const externalValue = skipExternal ? undefined : options.externalCellValue?.(value, columnIndex);
    const resolvedValue = externalValue === undefined ? value : externalValue;
    if (resolvedValue !== null && resolvedValue !== undefined && options.displayValue) {
      const resolvedSourceIndex = sourceIndex ?? visibleColumnIndexes.value[columnIndex] ?? columnIndex;
      if (applyFormatters && isOracleTemporalColumn(columnIndex, resolvedSourceIndex)) {
        return options.displayValue(resolvedValue, resolvedSourceIndex);
      }
      if (applyFormatters && shouldApplyColumnFormatter(resolvedSourceIndex)) {
        return options.displayValue(resolvedValue, resolvedSourceIndex);
      }
    }
    return resolvedValue;
  }

  function rowToJsonObject(item: RowItem): Record<string, unknown> {
    if (options.databaseType.value === "mongodb" && item.sourceIndex !== undefined) {
      const original = options.mongoDocuments?.value?.[item.sourceIndex];
      const document = buildMongoCopyDocumentFromOriginal(original, item.data as MongoInputValue[], columns.value, item.isDirtyCol);
      if (document) return document;
    }
    const obj: Record<string, unknown> = {};
    columns.value.forEach((col, i) => {
      const value = externalCellValue(binaryClipboardCellValue(item.data[i], i), i);
      if (typeof value === "string" && columnTypes.value?.[i]?.trim().toLowerCase() === "json") {
        try {
          obj[col] = JSON.parse(value);
          return;
        } catch {
          // Keep malformed JSON cells as their original text.
        }
      }
      obj[col] = value;
    });
    return obj;
  }

  async function copyRowsAsJson(items: RowItem[]) {
    if (items.length === 0) return;
    const resolvedItems = await resolveVisibleRowValues(items);
    const value = resolvedItems.length === 1 ? rowToJsonObject(resolvedItems[0]) : resolvedItems.map(rowToJsonObject);
    const hasOriginalMongoDocuments = options.databaseType.value === "mongodb" && items.every((item) => item.sourceIndex !== undefined && options.mongoDocuments?.value?.[item.sourceIndex] !== undefined);
    const copyValue = options.databaseType.value === "mongodb" && !hasOriginalMongoDocuments ? expandNestedJsonStringsForCopy(value) : value;
    await copyText(JSON.stringify(copyValue, null, 2));
  }

  // --- Cell/row copy ---
  async function copyCell() {
    const target = contextCell.value;
    if (!target || target.col < 0) return;
    const columnIndex = target.col;
    const item = getRowItem(target.rowId);
    if (!item || item.isDraft) return;
    const sourceIndex = visibleColumnIndexes.value[columnIndex] ?? columnIndex;
    const [resolvedItem] = await resolveVisibleRowValues([item], [sourceIndex]);
    const val = resolvedItem?.data[columnIndex] ?? null;
    // 外部剪贴板呈现文本型 MySQL VARBINARY（NULL 也按空串输出）；内部网格副本仍保留原 hex，保证回粘无损。
    const rawValue = options.cellClipboardText?.(val, sourceIndex) ?? clipboardCellValue(binaryClipboardCellValue(val, columnIndex));
    const shouldFormat = isOracleTemporalColumn(columnIndex, sourceIndex) || shouldApplyColumnFormatter(sourceIndex);
    const copyValue = shouldFormat ? (options.displayValue?.(val, sourceIndex) ?? rawValue) : rawValue;
    await copyText(copyValue, { rows: [[val]] });
  }

  async function copyRow() {
    if (hasRowSelection.value && selectedRowIds.value.size > 0) {
      const items = displayItems.value.filter((item) => selectedRowIds.value.has(item.id) && !item.isDraft);
      await copyRowsAsJson(items);
      return;
    }
    const range = selectedRange.value;
    if (range && range.startRow !== range.endRow) {
      const items = displayItems.value.slice(range.startRow, range.endRow + 1).filter((item) => !item.isDraft);
      await copyRowsAsJson(items);
      return;
    }
    if (!contextCell.value) return;
    const item = getRowItem(contextCell.value.rowId);
    if (!item || item.isDraft) return;
    await copyRowsAsJson([item]);
  }

  function insertEligibleRows(): RowItem[] {
    return targetedRows().filter((item) => !item.isDraft);
  }

  function updateEligibleRows(): RowItem[] {
    return targetedRows().filter((item) => !item.isNew && !item.isDraft && !item.isDeleted);
  }

  function insertableCopyColumnCount(primaryKeyMode: DataGridPrimaryKeyMode, copyColumns = effectiveColumns(sourceColumns.value, columns.value), extractorOptions?: DataGridExtractorOptions): number {
    return copyColumns.filter((column): column is string => {
      if (!column || isCopyInsertOmittedColumn(databaseType.value, column, tableMeta.value, extractorOptions, copyColumns)) return false;
      const isPrimaryKey = isPrimaryKeyColumn(databaseType.value, column, tableMeta.value, copyColumns);
      if (!isPrimaryKey || primaryKeyMode === "include") return true;
      return primaryKeyMode === "exclude-generated" ? !isAutoGeneratedColumn(databaseType.value, column, tableMeta.value) : false;
    }).length;
  }

  async function buildMongoExtractorInsert(extractorOptions: DataGridExtractorOptions, rowLimit?: number): Promise<string | undefined> {
    const data: CopyInsertData | null =
      hasRowSelection.value || !hasCellSelection.value
        ? {
            columns: columns.value,
            sourceColumns: sourceColumns.value,
            columnTypes: columnTypes.value?.map((type) => type ?? undefined),
            rows: insertEligibleRows(),
          }
        : selectionInsertData();
    if (!data) return undefined;
    await yieldToMainThread();
    return buildCopyInsertStatement(rowLimit === undefined ? data : { ...data, rows: data.rows.slice(0, rowLimit) }, extractorOptions.sql.primaryKeyMode, extractorOptions.sql.insertMode);
  }

  function mongoUpdateColumnIndexes(request: DataGridExtractRequest): number[] {
    const selectedColumns = new Set(
      request.selectedColumnIndexes
        .map((index) => request.columns[index]?.sourceName ?? request.columns[index]?.displayName)
        .filter((column): column is string => !!column)
        .map(normalizeColumnName),
    );
    return effectiveColumns(sourceColumns.value, columns.value)
      .map((column, index) => (column && selectedColumns.has(normalizeColumnName(column)) ? index : -1))
      .filter((index) => index >= 0);
  }

  async function buildMongoExtractorUpdate(request: DataGridExtractRequest, rowLimit?: number): Promise<string | undefined> {
    const target = options.mongoUpdateTarget?.value;
    const documents = options.mongoDocuments?.value;
    if (!target || !documents) return undefined;
    const rows = updateEligibleRows();
    if (rows.length === 0) return undefined;
    const limitedRows = rowLimit === undefined ? rows : rows.slice(0, rowLimit);
    const allCopyColumns = effectiveColumns(sourceColumns.value, columns.value).map((column) => column ?? "");
    const selectedColumnIndexes = mongoUpdateColumnIndexes(request);
    const copyColumns = selectedColumnIndexes.map((index) => allCopyColumns[index]);
    await yieldToMainThread();
    const statements: string[] = [];
    for (const item of limitedRows) {
      if (item.sourceIndex === undefined) continue;
      const originalDocument = documents[item.sourceIndex];
      if (!originalDocument || typeof originalDocument !== "object" || Array.isArray(originalDocument)) continue;
      const source = originalDocument as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(source, target.idColumn)) continue;
      const update = buildMongoCopyUpdateDocument(
        selectedColumnIndexes.map((index) => item.data[index]) as MongoInputValue[],
        copyColumns,
        selectedColumnIndexes.map((index) => item.isDirtyCol[index] ?? false),
        originalDocument,
        target.idColumn,
      );
      if (!update) continue;
      const statement = `db.getCollection(${JSON.stringify(target.collection)}).updateOne({${JSON.stringify(target.idColumn)}:${formatMongoShellLiteral(source[target.idColumn])}},${formatMongoShellLiteral(update)});`;
      statements.push(formatMongoCopyStatement(statement) ?? statement);
    }
    return statements.length > 0 ? statements.join("\n") : undefined;
  }

  function canBuildMongoExtractorUpdate(request: DataGridExtractRequest): boolean {
    const target = options.mongoUpdateTarget?.value;
    const documents = options.mongoDocuments?.value;
    const rows = updateEligibleRows();
    if (!target || !documents || rows.length === 0) return false;

    const normalizedIdColumn = normalizeColumnName(target.idColumn);
    const copyColumns = mongoUpdateColumnIndexes(request).map((index) => effectiveColumns(sourceColumns.value, columns.value)[index] ?? "");
    if (!copyColumns.some((column) => column && normalizeColumnName(column) !== normalizedIdColumn)) return false;

    return rows.every((item) => {
      if (item.sourceIndex === undefined) return false;
      const document = documents[item.sourceIndex];
      return !!document && typeof document === "object" && !Array.isArray(document) && Object.prototype.hasOwnProperty.call(document, target.idColumn);
    });
  }

  const { extractWithExtractor, copyWithExtractor, copyWithPreference, previewWithExtractor, previewWithPreference, canCopyWithExtractor } = useDataGridExtractor({
    allowExtractor: (extractor) => !options.mysqlDataCharsetReadOnly?.value || (!extractor.startsWith("sql-") && extractor !== "where-clause"),
    columns,
    displayItems,
    allColumns,
    allDisplayItems,
    allSourceColumns,
    visibleColumnIndexes,
    columnTypes,
    allColumnTypes: allColumnTypesOption,
    columnComments: columnCommentsOption,
    allColumnComments: allColumnCommentsOption,
    extractorOptions: extractorOptionsOption,
    databaseType,
    identifierQuote,
    tableMeta,
    database: options.database,
    includeDatabaseName: options.includeDatabaseName,
    hasCellSelection,
    selectedCells,
    selectedCellMatrix,
    hasRowSelection,
    hasColumnSelection,
    selectedRowIds,
    resolveSourceValues,
    copyText,
    canCopySqlInsert: (request) => {
      const selectedColumns = request.selectedColumnIndexes.map((index) => request.columns[index]?.sourceName ?? request.columns[index]?.displayName).filter((column): column is string => !!column);
      return request.rows.length > 0 && insertableCopyColumnCount(request.options.sql.primaryKeyMode, selectedColumns, request.options) > 0;
    },
    buildMongoInsert: buildMongoExtractorInsert,
    buildMongoUpdate: buildMongoExtractorUpdate,
    partialLoadInfo: partialLoadCopyInfo,
    canBuildMongoUpdate: canBuildMongoExtractorUpdate,
    displayValue: options.displayValue,
    editValue: options.editValue,
    hasColumnFormatter: options.hasColumnFormatter,
    applyColumnFormattersOnExport: options.applyColumnFormattersOnExport,
    externalCellValue: (value, columnIndex) => {
      const externalValue = options.externalCellValue?.(value as CellValue, columnIndex);
      return externalValue === undefined ? value : externalValue;
    },
    contextCell,
    contextSelectionIsSynthetic,
  });

  async function copyAll() {
    const rows = (await resolveVisibleRowValues(displayItems.value.filter((item) => !item.isDraft))).map((item) => item.data);
    // formatTsv 引用处理解码后文本中可能出现的制表符/换行；内部副本仍用原始 rows（hex）保证回粘无损。
    const decodedRows = rows.map((row) => row.map((cell, index) => externalCellValue(binaryClipboardCellValue(cell, index), index)));
    const copied = await copyText(formatTsv(columns.value, decodedRows), { rows, header: columns.value });
    const partialLoadInfo = options.partialLoadCopyInfo?.value;
    if (copied && partialLoadInfo && isPartiallyLoadedCopy(partialLoadInfo)) {
      toast(t(partialLoadCopyHintKey(partialLoadInfo), { loaded: partialLoadInfo.loadedRows, total: partialLoadInfo.totalRows ?? undefined }), 5000);
    }
  }

  // --- Export functions ---
  function notifyExportSuccess(outputPath?: string | null) {
    notifyExportComplete({
      filePath: outputPath,
      message: t("grid.exported"),
      openFolderLabel: t("exportProgress.openFolder"),
      toast,
    });
  }

  async function runExclusiveExport(action: () => Promise<void>) {
    const finish = tryStartExclusiveActivation(exportGuard);
    if (!finish) return;
    currentExportViewId = undefined;
    try {
      await action();
    } finally {
      finish();
    }
  }

  async function exportWithExtractor(extractor: DataGridCopyExtractorId, extractorOptions: DataGridExtractorOptions = extractorOptionsOption?.value ?? DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS): Promise<boolean> {
    if (!allowExport(extractor === "csv-with-headers" ? "csv" : extractor)) return false;
    let exported = false;
    await runExclusiveExport(async () => {
      if (!canCopyWithExtractor(extractor, extractorOptions)) return;
      try {
        const extraction = await extractWithExtractor(extractor, extractorOptions);
        if (!extraction) return;
        const extension = extraction.result.fileExtension.replace(/^\.+/, "") || "txt";
        const baseName = `${exportFileBaseName?.value || tableMeta.value?.tableName || "export"}_selected`;
        const saved = await saveTextFile(extraction.result.text, exportFileName(baseName, extension, { preferFallback: true }), extension.toUpperCase(), extension, {
          operation: `selection-extractor-${extractor}`,
        });
        if (!saved) return;
        notifyExportSuccess(typeof saved === "string" ? saved : undefined);
        exported = true;
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
    return exported;
  }

  async function exportLocalSnapshot(
    format: "csv" | "json" | "xlsx" | "markdown" | "html" | "txt" | "sql",
    rowIds: number[] | undefined,
    columnIndexes: number[] | undefined,
    full: boolean,
    exportOptions: { xlsx?: XlsxExportOptions; includeSqlSheet?: boolean; sql?: SqlExportOptions; openAfterExport?: boolean } = {},
  ): Promise<boolean> {
    const original = options.snapshotResult?.value;
    const originalConnectionId = connectionId.value;
    const originalDatabase = database.value;
    const native = isTauriRuntime();
    if (!native && format !== "csv" && format !== "json") return false;
    const streamedSnapshot = format === "csv" || format === "json";
    const applyFormatting = format !== "sql";
    if (!original || (full && rowIds === undefined && !hasCompleteLocalResult?.value)) return false;
    const exportAll = full && rowIds === undefined && hasCompleteLocalResult?.value;
    const visibleIndexes = visibleColumnIndexesOption?.value ?? columns.value.map((_, index) => index);
    const indexes = columnIndexes?.filter((index) => index >= 0 && index < columns.value.length);
    const hiddenIndexes = new Set(original.hidden_column_indexes ?? []);
    const sourceIndexes = exportAll && !indexes ? original.columns.map((_, index) => index).filter((index) => !hiddenIndexes.has(index)) : (indexes ?? columns.value.map((_, index) => index)).map((index) => visibleIndexes[index] ?? index);
    const names = sourceIndexes.map((index) => original.columns[index]!);
    const editorSettings = { ...useSettingsStore().editorSettings };
    const originalRows = editorSettings.exportRowLimitEnabled ? original.rows.slice(0, editorSettings.exportRowLimit) : original.rows;
    const items = exportAll
      ? originalRows.map((row, sourceIndex) => ({ id: sourceIndex, sourceIndex, isNew: false, isDirtyCol: [] as boolean[], data: sourceIndexes.map((index) => row[index]) }))
      : rowsToExport(rowIds).map((item) => ({
          id: item.id,
          sourceIndex: item.sourceIndex,
          isNew: item.isNew,
          data: (indexes ?? columns.value.map((_, index) => index)).map((index) => item.data[index]),
          isDirtyCol: (indexes ?? columns.value.map((_, index) => index)).map((index) => item.isDirtyCol[index] ?? false),
        }));
    const legacyMetadata = new Map(original.large_value_cells?.filter((cell) => !cell.value_ref).map((cell) => [`${cell.row_index}:${cell.column_index}`, cell]));
    const legacyCells = items.flatMap((item, rowIndex) =>
      sourceIndexes.flatMap((columnIndex, targetColumnIndex) => {
        if (item.isNew || item.sourceIndex === undefined || item.isDirtyCol?.[targetColumnIndex]) return [];
        const cell = legacyMetadata.get(`${item.sourceIndex}:${columnIndex}`);
        return cell ? [{ rowId: item.id, sourceIndex: item.sourceIndex, columnIndex, rowIndex, targetColumnIndex }] : [];
      }),
    );
    const resolveLegacy = native && legacyCells.length ? options.captureSourceValues?.(legacyCells) : undefined;
    if (legacyCells.length && !resolveLegacy) return false;
    const locatorSelection = snapshotExportSelection(original, names, sourceIndexes, items);
    if (!locatorSelection && !resolveLegacy) return false;
    const selected = locatorSelection ?? { columns: names, rows: items.map((item) => item.data), cells: [], context: { connectionId: originalConnectionId!, database: originalDatabase!, valueRef: "" } };
    const hasLocators = !!locatorSelection;
    const types = sourceIndexes.map((index) => original.column_types?.[index] ?? "");
    const title = currentExportTitle();
    const formattedCells = selected.cells.filter((cell) => applyFormatting && shouldApplyColumnFormatter(sourceIndexes[cell.columnIndex]!));
    const materializedCells = streamedSnapshot ? formattedCells : selected.cells;
    const formattedLegacyCells = legacyCells.filter((cell) => applyFormatting && shouldApplyColumnFormatter(cell.columnIndex));
    const formatterDisplay = formattedCells.length || formattedLegacyCells.length ? (options.captureColumnFormatterDisplay?.() ?? options.displayValue) : undefined;
    selected.rows = selected.rows.map((row) => row.map((value, columnIndex) => externalCellValue(value as CellValue, exportAll ? sourceIndexes[columnIndex]! : (indexes?.[columnIndex] ?? columnIndex), sourceIndexes[columnIndex], applyFormatting, !!exportAll)));
    selected.rows = applyGlobalDateTimeExportFormat({ columns: names, columnTypes: types, rows: selected.rows as CellValue[][] }, applyFormatting, sourceIndexes).rows;
    const materializationResult = {
      ...original,
      rows: selected.rows as CellValue[][],
      large_value_context: original.large_value_context ? { ...original.large_value_context } : undefined,
      large_value_cells: materializedCells.map((cell) => ({ ...original.large_value_cells!.find((source) => source.value_ref === cell.valueRef)!, row_index: cell.rowIndex, column_index: cell.columnIndex })),
    };
    const headerMode = exportOptions.xlsx?.headerMode ?? "name";
    const xlsxComments = buildXlsxHeaderOverrides(names, commentsForExportColumns(names), headerMode);
    const writeWorkbook = format === "xlsx" ? captureXlsxWriter(exportOptions.includeSqlSheet === true, exportOptions.xlsx?.autoFilter ?? false, full ? undefined : currentPageExportSql(), xlsxHeaderUsesCommentRows(headerMode)) : undefined;
    const targetIndexBySource = new Map(sourceIndexes.map((sourceIndex, index) => [sourceIndex, index]));
    const projectedSpatialColumns = original.spatial_columns?.flatMap((column) => {
      const index = targetIndexBySource.get(column.column_index);
      return index === undefined ? [] : [{ ...column, column_index: index }];
    });
    const projectedSpatialValues = original.spatial_values?.length ? items.map((item) => sourceIndexes.map((index) => original.spatial_values?.[item.sourceIndex ?? -1]?.[index] ?? null)) : undefined;
    const projectSql = format === "sql" ? captureSqlInsertExportData({ columns: names, columnTypes: types, rows: selected.rows as CellValue[][], spatialColumns: projectedSpatialColumns, spatialValues: projectedSpatialValues }, exportOptions.sql?.selectedColumns) : undefined;
    const insertTarget = format === "sql" ? sqlInsertTargetMeta() : undefined;
    const sqlMetadata = projectSql?.([]);
    const insertOptions = sqlMetadata
      ? { databaseType: databaseType.value, identifierQuote: options.identifierQuote?.value, schema: sqlInsertTargetSchema(insertTarget), tableName: sqlInsertTargetName(insertTarget), insertMode: exportOptions.sql?.insertMode, excludeColumns: sqlExportExcludedColumns(sqlMetadata.columns) }
      : undefined;
    const connections = native && getActivePinia() ? useConnectionStore() : undefined;
    const resourceConnectionId = selected.context.connectionId;
    const revision = connections?.connectionStateRevision(resourceConnectionId);
    const originalConfig = connections?.getConfig(resourceConnectionId);
    const fingerprint = originalConfig ? connectionConfigFingerprint(originalConfig) : undefined;
    const isCurrent = () => {
      if (!hasLocators) return true;
      if (scopeDisposed || options.snapshotResult?.value !== original || connectionId.value !== originalConnectionId || database.value !== originalDatabase) return false;
      if (!connections) return true;
      const current = connections.getConfig(resourceConnectionId);
      return connections.isCurrentConnectionStateRevision(resourceConnectionId, revision!) && !!current && connectionConfigFingerprint(current) === fingerprint;
    };
    const fileFormat = FORMAT_META[format]!;
    let outputPath = full && (format === "txt" || format === "sql") ? exportFileName(tableMeta.value?.tableName || "export", fileFormat.ext, { preferFallback: true }) : exportFileName(full ? "export" : "export-page", fileFormat.ext, { page: !full });
    const mode = exportOptions.openAfterExport ? "immediate" : (exportOptions.xlsx?.executionMode ?? exportOptions.sql?.executionMode ?? (await showExportExecutionModeDialog()));
    if (mode === null) return true;
    if (native) {
      const path = exportOptions.openAfterExport ? await api.createQueryResultTempFile(fileFormat.ext) : await promptExportSavePath({ defaultFileName: outputPath, filters: [{ name: fileFormat.label, extensions: [fileFormat.ext] }], preferredPath: editorSettings.preferredExportPath });
      if (!path) return true;
      outputPath = path;
    }
    if (options.snapshotResult?.value !== original || connectionId.value !== originalConnectionId || database.value !== originalDatabase || !isCurrent()) throw new Error("LOB result context changed");
    const executionId = uuid();
    const controller = new AbortController();
    let userCancelled = false;
    const cancel = async (user: boolean) => {
      if (!controller.signal.aborted) userCancelled = user;
      controller.abort(new Error(user ? "LOB export cancelled locally" : "LOB result context changed"));
      if (hasLocators) await api.cancelQuery(executionId);
    };
    const cancelSource = () => cancel(false);
    await submitBackendExport({
      exportId: executionId,
      tableName: title,
      format,
      outputPath,
      mode,
      openAfterExport: exportOptions.openAfterExport === true,
      cancelDuringWrite: streamedSnapshot && hasLocators,
      initialTotalRows: selected.rows.length,
      prepare: async () => {
        if (!isCurrent()) throw new Error("LOB result context changed");
      },
      cancel: () => cancel(true),
      start: async (onProgress) => {
        let nativeUnknown = false;
        const progress = (status: api.TableExportProgress["status"], errorMessage?: string): api.TableExportProgress => ({
          exportId: executionId,
          tableName: title,
          rowsExported: status === "Done" || status === "Writing" ? selected.rows.length : 0,
          totalRows: selected.rows.length,
          status,
          errorMessage,
        });
        const readChunk: typeof api.readLargeValueChunk = async (request) => {
          try {
            return await (native ? api.readLargeValueChunk(request, true) : api.readLargeValueChunk(request));
          } catch (error) {
            nativeUnknown = native && (!(error instanceof SnapshotCompletionError) || error.status === "unknown");
            throw error;
          }
        };
        activeSnapshotCancels.add(cancelSource);
        const stop = watch(
          isCurrent,
          (current) => {
            if (!current) void cancelSource().catch(() => undefined);
          },
          { flush: "sync" },
        );
        try {
          if (!isCurrent()) throw new Error("LOB result context changed");
          if (resolveLegacy) {
            let resolved: Map<number, Map<number, CellValue>>;
            try {
              resolved = await resolveLegacy(controller.signal);
            } catch (error) {
              nativeUnknown = !(error instanceof SnapshotCompletionError) || error.status === "unknown";
              throw error;
            }
            for (const cell of legacyCells) {
              const values = resolved.get(cell.rowId);
              if (!values?.has(cell.columnIndex)) throw new Error("Export large value is unavailable");
              const value = values.get(cell.columnIndex)!;
              selected.rows[cell.rowIndex]![cell.targetColumnIndex] = formatterDisplay && formattedLegacyCells.includes(cell) ? formatterDisplay(value, cell.columnIndex) : value;
            }
            materializationResult.rows = selected.rows as CellValue[][];
          }
          if (materializedCells.length) {
            selected.rows = await materializeSnapshotResultRows(materializationResult, isCurrent, controller.signal, executionId, { waitForNative: native, readChunk });
            if (formatterDisplay)
              for (const cell of formattedCells) {
                const row = selected.rows[cell.rowIndex]!;
                row[cell.columnIndex] = formatterDisplay(row[cell.columnIndex] as CellValue, sourceIndexes[cell.columnIndex]!);
              }
            selected.cells = selected.cells.filter((cell) => !materializedCells.includes(cell));
          }
          controller.signal.throwIfAborted();
          if (!isCurrent()) throw new Error("LOB result context changed");
          if (writeWorkbook) assertSnapshotXlsxCellLengths(selected.rows as CellValue[][]);
          onProgress(progress("Writing"));
          let writing: Promise<void>;
          if (format === "csv" && !hasLocators) writing = api.exportQueryResultCsv(outputPath, names, selected.rows as CellValue[][], editorSettings.csvQuoteMode, csvNullLiteralForMode(editorSettings.csvNullMode));
          else if (format === "json" && !hasLocators) writing = api.exportQueryResultJson(outputPath, names, selected.rows as CellValue[][]);
          else if (format === "csv" || format === "json") {
            const request = { ...selected, context: { ...selected.context, executionId }, format, quoteMode: editorSettings.csvQuoteMode, nullLiteral: csvNullLiteralForMode(editorSettings.csvNullMode) };
            writing = native ? api.exportSnapshotResult(request, outputPath, undefined, true) : api.exportSnapshotResult(request, outputPath, controller.signal);
          } else if (writeWorkbook) writing = writeWorkbook(outputPath, { columns: names, columnTypes: types, columnComments: xlsxComments, rows: selected.rows as CellValue[][] });
          else if (format === "markdown") writing = api.exportQueryResultMarkdown(outputPath, names, selected.rows as CellValue[][]);
          else if (format === "html") writing = api.exportQueryResultHtml(outputPath, title, names, selected.rows as CellValue[][]);
          else {
            const { writeTextFile } = await import("@tauri-apps/plugin-fs");
            controller.signal.throwIfAborted();
            let content: string;
            if (projectSql && insertOptions) {
              try {
                content = await formatSqlInsert({ ...insertOptions, ...projectSql(selected.rows as CellValue[][]) });
              } catch (error) {
                nativeUnknown = true;
                throw error;
              }
            } else content = formatTsv(names, selected.rows as CellValue[][]);
            controller.signal.throwIfAborted();
            writing = writeTextFile(outputPath, content);
          }
          if (native) {
            try {
              await writing;
            } catch (error) {
              nativeUnknown = !(error instanceof SnapshotCompletionError) || error.status === "unknown";
              throw error;
            }
          } else {
            await waitForLargeValueSnapshot(writing, controller.signal);
            if (!isCurrent()) throw new Error("LOB result context changed");
          }
          const done = progress("Done");
          onProgress(done);
          return done;
        } catch (error) {
          if (nativeUnknown) throw error;
          if (native && ((error instanceof SnapshotCompletionError && error.status === "cancelled") || (controller.signal.aborted && userCancelled && error === controller.signal.reason))) {
            const cancelled = progress("Cancelled");
            onProgress(cancelled);
            return cancelled;
          }
          onProgress(progress("Error", error instanceof Error ? error.message : String(error)));
          throw error;
        } finally {
          if (!nativeUnknown) {
            stop();
            activeSnapshotCancels.delete(cancelSource);
          }
        }
      },
    });
    return true;
  }

  async function exportMemoryDataFile(
    format: "csv" | "json" | "markdown" | "html" | "txt" | "xlsx" | "sql",
    rowIds: number[] | undefined,
    columnIndexes: number[] | undefined,
    full: boolean,
    exportOptions: { xlsx?: XlsxExportOptions; includeSqlSheet?: boolean; sql?: SqlExportOptions; openAfterExport?: boolean } = {},
  ): Promise<boolean> {
    const original = completeLocalResult?.value ?? options.snapshotResult?.value;
    if (!isTauriRuntime() || !original) return false;
    const needsFullRead = full && rowIds === undefined && !hasCompleteLocalResult?.value;
    const readFull = needsFullRead ? options.captureFullExportResult?.() : undefined;
    if (needsFullRead && !readFull) throw new Error("Export source cannot be captured");
    const visibleIndexes = visibleColumnIndexesOption?.value ?? columns.value.map((_, index) => index);
    const indexes = (columnIndexes ?? columns.value.map((_, index) => index)).filter((index) => index >= 0 && index < columns.value.length);
    const sourceIndexes = new Set(full && rowIds === undefined && columnIndexes === undefined ? original.columns.map((_, index) => index).filter((index) => !original.hidden_column_indexes?.includes(index)) : indexes.map((index) => visibleIndexes[index] ?? index));
    const selectedItems = full && rowIds === undefined ? undefined : rowsToExport(rowIds);
    const settings = { ...useSettingsStore().editorSettings };
    const hasSelectedPreview = original.large_value_cells?.some((cell) => {
      if (!sourceIndexes.has(cell.column_index)) return false;
      if (!selectedItems) return !settings.exportRowLimitEnabled || cell.row_index < settings.exportRowLimit;
      return selectedItems.some((item) => !item.isNew && item.sourceIndex === cell.row_index && indexes.some((index) => (visibleIndexes[index] ?? index) === cell.column_index && !item.isDirtyCol[index]));
    });
    if (!needsFullRead && hasSelectedPreview) return false;
    const originalConnection = connectionId.value;
    const originalDatabase = database.value;
    const title = currentExportTitle();
    const { xlsx: xlsxOptions, sql: sqlOptions, includeSqlSheet = false } = exportOptions;
    const writeWorkbook = format === "xlsx" ? captureXlsxWriter(includeSqlSheet, xlsxOptions?.autoFilter ?? false, full ? undefined : currentPageExportSql(), xlsxHeaderUsesCommentRows(xlsxOptions?.headerMode ?? "name")) : undefined;
    const meta = FORMAT_META[format]!;
    const fileName = full && (format === "txt" || format === "sql") ? exportFileName(tableMeta.value?.tableName || "export", meta.ext, { preferFallback: true }) : exportFileName(full ? "export" : "export-page", meta.ext, { page: !full });
    const projectFull = needsFullRead ? captureFullResultProjection(columnIndexes, format !== "sql", xlsxOptions?.headerMode ?? "name", format === "json") : undefined;
    const sqlContext = format === "sql" ? captureSqlInsertContext() : undefined;
    const selectedSqlColumns = sqlOptions?.selectedColumns?.map((column) => ({ ...column }));
    const excludedColumns = captureSqlExportExcludedColumns();
    const prepared = needsFullRead ? undefined : await resultToExport({ rowIds, columnIndexes }, undefined, full, format !== "sql", xlsxOptions?.headerMode ?? "name", format === "json", undefined, true);
    if (prepared) prepared.rows = prepared.rows.map((row) => row.map((value) => (value !== null && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value)));
    const insertTarget = format === "sql" ? sqlInsertTargetMeta() : undefined;
    const insertOptions =
      format === "sql"
        ? {
            databaseType: databaseType.value,
            identifierQuote: options.identifierQuote?.value,
            schema: sqlInsertTargetSchema(insertTarget),
            tableName: sqlInsertTargetName(insertTarget),
            insertMode: sqlOptions?.insertMode,
          }
        : undefined;
    const isCurrent = () => !scopeDisposed && (completeLocalResult?.value ?? options.snapshotResult?.value) === original && connectionId.value === originalConnection && database.value === originalDatabase;
    if (!isCurrent()) throw new Error("Export result context changed");
    const mode = exportOptions.openAfterExport ? "immediate" : (xlsxOptions?.executionMode ?? sqlOptions?.executionMode ?? (await showExportExecutionModeDialog()));
    if (mode === null) return true;
    const outputPath = exportOptions.openAfterExport ? await api.createQueryResultTempFile(meta.ext) : await promptExportSavePath({ defaultFileName: fileName, filters: [{ name: meta.label, extensions: [meta.ext] }], preferredPath: settings.preferredExportPath });
    if (!outputPath) return true;
    if (!isCurrent()) throw new Error("Export result context changed");
    const exportId = uuid();
    const controller = new AbortController();
    await submitBackendExport({
      exportId,
      tableName: title,
      format,
      outputPath,
      mode,
      openAfterExport: exportOptions.openAfterExport === true,
      initialTotalRows: prepared?.rows.length ?? null,
      cancelDuringWrite: false,
      ...(readFull
        ? {
            cancel: async () => {
              controller.abort();
            },
          }
        : {}),
      start: async (onProgress) => {
        let result = prepared;
        if (readFull && projectFull) {
          let reading = true;
          try {
            const fetched = await readFull((info) => onProgress({ exportId, tableName: title, ...info, status: "Running" }), { signal: controller.signal });
            reading = false;
            if (fetched?.execution_error) throw new SnapshotCompletionError(fetched.error?.operationOutcome === "not_started" ? "failed" : "unknown", "Export query failed");
            if (controller.signal.aborted) throw new SnapshotCompletionError("cancelled", "Export cancelled");
            if (!fetched || fetched.large_value_cells?.length) throw new Error("Export source is incomplete");
            result = projectFull(fetched);
          } catch (error) {
            if ((error instanceof SnapshotCompletionError && error.status === "unknown") || (reading && !(error instanceof SnapshotCompletionError))) throw error;
            const status = error instanceof SnapshotCompletionError && error.status === "cancelled" ? "Cancelled" : "Error";
            const progress: api.TableExportProgress = { exportId, tableName: title, rowsExported: 0, totalRows: null, status, errorMessage: error instanceof Error ? error.message : String(error) };
            onProgress(progress);
            return progress;
          }
        }
        if (!result) throw new Error("Export source is unavailable");
        const sqlData = insertOptions ? captureSqlInsertExportData(result, selectedSqlColumns, sqlContext)(result.rows) : undefined;
        onProgress({ exportId, tableName: title, rowsExported: result.rows.length, totalRows: result.rows.length, status: "Writing" });
        if (writeWorkbook) await writeWorkbook(outputPath, result);
        else if (format === "csv") await api.exportQueryResultCsv(outputPath, result.columns, result.rows, settings.csvQuoteMode, csvNullLiteralForMode(settings.csvNullMode));
        else if (format === "json") await api.exportQueryResultJson(outputPath, result.columns, result.rows);
        else if (format === "markdown") await api.exportQueryResultMarkdown(outputPath, result.columns, result.rows);
        else if (format === "html") await api.exportQueryResultHtml(outputPath, title, result.columns, result.rows);
        else {
          const { writeTextFile } = await import("@tauri-apps/plugin-fs");
          await writeTextFile(outputPath, insertOptions && sqlData ? await formatSqlInsert({ ...insertOptions, ...sqlData, excludeColumns: excludedColumns(sqlData.columns) }) : formatTsv(result.columns, result.rows));
        }
        return { exportId, tableName: title, rowsExported: result.rows.length, totalRows: result.rows.length, status: "Done" };
      },
    });
    return true;
  }

  async function exportCsv(target?: ExportTargetParam, columnIndexesParam?: number[]) {
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
    await runExclusiveExport(async () => {
      try {
        if (await exportLocalSnapshot("csv", rowIds, columnIndexes, true)) return;
        if (await exportQueryResultViaBackend("csv", rowIds, false, "name", true, undefined, false, columnIndexes)) return;
        if (await exportFullTableDataViaBackend("csv", rowIds, "name", true, undefined, false, columnIndexes)) return;
        if (await exportMemoryDataFile("csv", rowIds, columnIndexes, true)) return;

        const needsFullExport = rowIds === undefined && !!fullExportResult && !hasCompleteLocalResult?.value;
        if (needsFullExport && exportProgressDialog && exportProgressState) {
          exportProgressState.value = {
            title: t("exportProgress.title"),
            tableName: tableMeta.value?.tableName || "",
            format: "csv",
            rowsExported: 0,
            totalRows: null,
            status: "Running",
            errorMessage: null,
            filePath: null,
            startedAt: Date.now(),
            finishedAt: undefined,
          };
          exportProgressDialog.value = true;
        }
        const result = await resultToExport({ rowIds, columnIndexes }, (info) => {
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
        // Let the Rust command format and write the raw values off the UI thread.
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
          const path = await promptExportSavePath({
            defaultFileName: outputPath,
            filters: [{ name: "CSV", extensions: ["csv"] }],
            preferredPath: useSettingsStore().editorSettings.preferredExportPath,
          });
          if (!path) {
            if (exportProgressDialog) exportProgressDialog.value = false;
            return;
          }
          outputPath = path;
        }
        await api.exportQueryResultCsv(outputPath, result.columns, result.rows, useSettingsStore().editorSettings.csvQuoteMode, csvNullLiteralForMode(useSettingsStore().editorSettings.csvNullMode));
        if (needsFullExport && exportProgressState) {
          exportProgressState.value = {
            ...exportProgressState.value,
            filePath: outputPath,
            status: "Done",
            rowsExported: result.rows.length,
            totalRows: result.rows.length,
            finishedAt: Date.now(),
          };
        }
        notifyExportSuccess(outputPath);
      } catch (e: any) {
        if (exportProgressState && exportProgressState.value.status !== "Unknown") {
          exportProgressState.value = {
            ...exportProgressState.value,
            status: "Error",
            errorMessage: e?.message || String(e),
          };
        }
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportCurrentPageCsv(columnIndexes?: number[]) {
    await runExclusiveExport(async () => {
      try {
        if (await exportLocalSnapshot("csv", undefined, columnIndexes, false)) return;
        if (await exportMemoryDataFile("csv", undefined, columnIndexes, false)) return;
        let outputPath = exportFileName("export-page", "csv", { page: true });
        if (isTauriRuntime()) {
          const path = await promptExportSavePath({
            defaultFileName: outputPath,
            filters: [{ name: "CSV", extensions: ["csv"] }],
            preferredPath: useSettingsStore().editorSettings.preferredExportPath,
          });
          if (!path) return;
          outputPath = path;
        }
        const result = await resultToExport({ columnIndexes }, undefined, false);
        await api.exportQueryResultCsv(outputPath, result.columns, result.rows, useSettingsStore().editorSettings.csvQuoteMode, csvNullLiteralForMode(useSettingsStore().editorSettings.csvNullMode));
        notifyExportSuccess(outputPath);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportJson(target?: ExportTargetParam, columnIndexesParam?: number[]) {
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
    await runExclusiveExport(async () => {
      try {
        if (await exportLocalSnapshot("json", rowIds, columnIndexes, true)) return;
        if (await exportFullTableDataViaBackend("json", rowIds, "name", true, undefined, false, columnIndexes)) return;
        if (await exportQueryResultViaBackend("json", rowIds, false, "name", true, undefined, false, columnIndexes)) return;
        if (await exportMemoryDataFile("json", rowIds, columnIndexes, true)) return;

        let outputPath = exportFileName("export", "json");
        if (isTauriRuntime()) {
          const path = await promptExportSavePath({
            defaultFileName: outputPath,
            filters: [{ name: "JSON", extensions: ["json"] }],
            preferredPath: useSettingsStore().editorSettings.preferredExportPath,
          });
          if (!path) return;
          outputPath = path;
        }
        const result = await resultToExport({ rowIds, columnIndexes }, undefined, true, true, "name", true);
        await api.exportQueryResultJson(outputPath, result.columns, result.rows);
        notifyExportSuccess(outputPath);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportCurrentPageJson(columnIndexes?: number[]) {
    await runExclusiveExport(async () => {
      try {
        if (await exportLocalSnapshot("json", undefined, columnIndexes, false)) return;
        if (await exportMemoryDataFile("json", undefined, columnIndexes, false)) return;
        let outputPath = exportFileName("export-page", "json", { page: true });
        if (isTauriRuntime()) {
          const path = await promptExportSavePath({
            defaultFileName: outputPath,
            filters: [{ name: "JSON", extensions: ["json"] }],
            preferredPath: useSettingsStore().editorSettings.preferredExportPath,
          });
          if (!path) return;
          outputPath = path;
        }
        const result = await resultToExport({ columnIndexes }, undefined, false, true, "name", true);
        await api.exportQueryResultJson(outputPath, result.columns, result.rows);
        notifyExportSuccess(outputPath);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportMarkdown(target?: ExportTargetParam, columnIndexesParam?: number[]) {
    if (!allowExport("markdown")) return;
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
    await runExclusiveExport(async () => {
      try {
        if (await exportFullTableDataViaBackend("markdown", rowIds, "name", true, undefined, false, columnIndexes)) return;
        if (await exportLocalSnapshot("markdown", rowIds, columnIndexes, true)) return;
        if (await exportMemoryDataFile("markdown", rowIds, columnIndexes, true)) return;

        let outputPath = exportFileName("export", "md");
        if (isTauriRuntime()) {
          const path = await promptExportSavePath({
            defaultFileName: outputPath,
            filters: [{ name: "Markdown", extensions: ["md"] }],
            preferredPath: useSettingsStore().editorSettings.preferredExportPath,
          });
          if (!path) return;
          outputPath = path;
        }
        const result = await resultToExport({ rowIds, columnIndexes });
        await api.exportQueryResultMarkdown(outputPath, result.columns, result.rows);
        notifyExportSuccess(outputPath);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportCurrentPageMarkdown(columnIndexes?: number[]) {
    if (!allowExport("markdown")) return;
    await runExclusiveExport(async () => {
      try {
        if (await exportLocalSnapshot("markdown", undefined, columnIndexes, false)) return;
        if (await exportMemoryDataFile("markdown", undefined, columnIndexes, false)) return;
        let outputPath = exportFileName("export-page", "md", { page: true });
        if (isTauriRuntime()) {
          const path = await promptExportSavePath({
            defaultFileName: outputPath,
            filters: [{ name: "Markdown", extensions: ["md"] }],
            preferredPath: useSettingsStore().editorSettings.preferredExportPath,
          });
          if (!path) return;
          outputPath = path;
        }
        const result = await resultToExport({ columnIndexes }, undefined, false);
        await api.exportQueryResultMarkdown(outputPath, result.columns, result.rows);
        notifyExportSuccess(outputPath);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportTxt(target?: ExportTargetParam, columnIndexesParam?: number[]) {
    if (!allowExport("txt")) return;
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
    await runExclusiveExport(async () => {
      try {
        if (await exportQueryResultViaBackend("txt", rowIds, false, "name", true, undefined, false, columnIndexes)) return;
        if (await exportFullTableDataViaBackend("txt", rowIds, "name", true, undefined, false, columnIndexes)) return;
        if (await exportLocalSnapshot("txt", rowIds, columnIndexes, true)) return;
        if (await exportMemoryDataFile("txt", rowIds, columnIndexes, true)) return;
        const result = await resultToExport({ rowIds, columnIndexes });
        const content = formatTsv(result.columns, result.rows);
        const saved = await saveTextFile(content, exportFileName(tableMeta.value?.tableName || "export", "txt", { preferFallback: true }), "Text", "txt");
        if (!saved) return;
        notifyExportSuccess(typeof saved === "string" ? saved : undefined);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportHtml(target?: ExportTargetParam, openAfterExport = false, columnIndexesParam?: number[]) {
    if (!allowExport("html")) return;
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
    await runExclusiveExport(async () => {
      try {
        if (await exportLocalSnapshot("html", rowIds, columnIndexes, true, { openAfterExport })) return;
        if (await exportMemoryDataFile("html", rowIds, columnIndexes, true, { openAfterExport })) return;
        let outputPath = exportFileName("export", "html");
        if (isTauriRuntime()) {
          if (openAfterExport) outputPath = await api.createQueryResultTempFile("html");
          else {
            const path = await promptExportSavePath({
              defaultFileName: outputPath,
              filters: [{ name: "HTML", extensions: ["html"] }],
              preferredPath: useSettingsStore().editorSettings.preferredExportPath,
            });
            if (!path) return;
            outputPath = path;
          }
        }
        const result = await resultToExport({ rowIds, columnIndexes });
        await api.exportQueryResultHtml(outputPath, currentExportTitle(), result.columns, result.rows);
        notifyExportSuccess(openAfterExport ? undefined : outputPath);
        if (openAfterExport && isTauriRuntime()) await api.openQueryResultTempFile(outputPath);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportCurrentPageHtml(columnIndexes?: number[]) {
    if (!allowExport("html")) return;
    await runExclusiveExport(async () => {
      try {
        if (await exportLocalSnapshot("html", undefined, columnIndexes, false)) return;
        if (await exportMemoryDataFile("html", undefined, columnIndexes, false)) return;
        let outputPath = exportFileName("export-page", "html", { page: true });
        if (isTauriRuntime()) {
          const path = await promptExportSavePath({
            defaultFileName: outputPath,
            filters: [{ name: "HTML", extensions: ["html"] }],
            preferredPath: useSettingsStore().editorSettings.preferredExportPath,
          });
          if (!path) return;
          outputPath = path;
        }
        const result = await resultToExport({ columnIndexes }, undefined, false);
        await api.exportQueryResultHtml(outputPath, currentExportTitle(), result.columns, result.rows);
        notifyExportSuccess(outputPath);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportCurrentPageTxt(columnIndexes?: number[]) {
    if (!allowExport("txt")) return;
    await runExclusiveExport(async () => {
      try {
        if (await exportLocalSnapshot("txt", undefined, columnIndexes, false)) return;
        if (await exportMemoryDataFile("txt", undefined, columnIndexes, false)) return;
        const result = await resultToExport({ columnIndexes }, undefined, false);
        const content = formatTsv(result.columns, result.rows);
        const saved = await saveTextFile(content, exportFileName("export-page", "txt", { page: true }), "Text", "txt");
        if (!saved) return;
        notifyExportSuccess(typeof saved === "string" ? saved : undefined);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportXlsxResult(target?: ExportTargetParam, includeSqlSheet = false, openAfterExport = false, columnIndexesParam?: number[]) {
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
    const isSourceCurrent = captureExportConfirmationSource();
    const exportOptions = await showXlsxHeaderDialog(isTauriRuntime() && !openAfterExport);
    if (exportOptions === null) return;

    await runExclusiveExport(async () => {
      try {
        if (isTauriRuntime() && !isSourceCurrent()) throw new Error("Export result context changed");
        if (await exportQueryResultViaBackend("xlsx", rowIds, includeSqlSheet, exportOptions.headerMode, exportOptions.autoFilter, undefined, openAfterExport, columnIndexes, exportOptions.executionMode)) return;
        if (await exportFullTableDataViaBackend("xlsx", rowIds, exportOptions.headerMode, exportOptions.autoFilter, undefined, openAfterExport, columnIndexes, exportOptions.executionMode)) return;
        if (await exportLocalSnapshot("xlsx", rowIds, columnIndexes, true, { xlsx: exportOptions, includeSqlSheet, openAfterExport })) return;
        if (await exportMemoryDataFile("xlsx", rowIds, columnIndexes, true, { xlsx: exportOptions, includeSqlSheet, openAfterExport })) return;

        let outputPath = exportFileName("export", "xlsx");
        if (isTauriRuntime()) {
          if (openAfterExport) outputPath = await api.createQueryResultTempFile("xlsx");
          else {
            const path = await promptExportSavePath({
              defaultFileName: outputPath,
              filters: [{ name: "Excel", extensions: ["xlsx"] }],
              preferredPath: useSettingsStore().editorSettings.preferredExportPath,
            });
            if (!path) return;
            outputPath = path;
          }
        }
        const needsFullExport = rowIds === undefined && !!fullExportResult && !hasCompleteLocalResult?.value;
        if (needsFullExport && exportProgressDialog && exportProgressState) {
          exportProgressState.value = {
            title: t("exportProgress.title"),
            tableName: tableMeta.value?.tableName || "",
            format: "xlsx",
            rowsExported: 0,
            totalRows: null,
            status: "Running",
            errorMessage: null,
            filePath: outputPath,
            startedAt: Date.now(),
            finishedAt: undefined,
          };
          exportProgressDialog.value = true;
        }
        const result = await resultToExport(
          { rowIds, columnIndexes },
          (info) => {
            if (needsFullExport && exportProgressState && exportProgressState.value.status === "Running") {
              const adjustedTotal = info.totalRows !== null && info.rowsExported > info.totalRows ? info.rowsExported : info.totalRows;
              exportProgressState.value = {
                ...exportProgressState.value,
                rowsExported: info.rowsExported,
                totalRows: adjustedTotal,
              };
            }
          },
          true,
          true,
          exportOptions.headerMode,
        );
        if (needsFullExport && exportProgressState) {
          exportProgressState.value = {
            ...exportProgressState.value,
            status: "Writing",
            rowsExported: result.rows.length,
            totalRows: result.rows.length,
          };
        }
        await writeXlsxResult(outputPath, result, includeSqlSheet, exportOptions.autoFilter, undefined, xlsxHeaderUsesCommentRows(exportOptions.headerMode));
        if (needsFullExport && exportProgressState) {
          exportProgressState.value = {
            ...exportProgressState.value,
            status: "Done",
            rowsExported: result.rows.length,
            totalRows: result.rows.length,
            finishedAt: Date.now(),
          };
        }
        notifyExportSuccess(openAfterExport ? undefined : outputPath);
        if (openAfterExport && isTauriRuntime()) {
          await api.openQueryResultTempFile(outputPath);
        }
      } catch (e: any) {
        if (exportProgressState) {
          exportProgressState.value = {
            ...exportProgressState.value,
            status: "Error",
            errorMessage: e?.message || String(e),
          };
        }
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportXlsx(target?: ExportTargetParam, columnIndexes?: number[]) {
    await exportXlsxResult(target, false, false, columnIndexes);
  }

  async function openXlsx(target?: ExportTargetParam, columnIndexes?: number[]) {
    await exportXlsxResult(target, false, true, columnIndexes);
  }

  async function openBrowser(target?: ExportTargetParam, columnIndexes?: number[]) {
    await exportHtml(target, true, columnIndexes);
  }

  async function exportXlsxWithSql(target?: ExportTargetParam, columnIndexes?: number[]) {
    await exportXlsxResult(target, true, false, columnIndexes);
  }

  async function exportCurrentPageXlsxResult(includeSqlSheet: boolean, columnIndexes?: number[]) {
    const isSourceCurrent = captureExportConfirmationSource();
    const exportOptions = await showXlsxHeaderDialog(isTauriRuntime());
    if (exportOptions === null) return;

    await runExclusiveExport(async () => {
      try {
        if (isTauriRuntime() && !isSourceCurrent()) throw new Error("Export result context changed");
        if (await exportLocalSnapshot("xlsx", undefined, columnIndexes, false, { xlsx: exportOptions, includeSqlSheet })) return;
        if (await exportMemoryDataFile("xlsx", undefined, columnIndexes, false, { xlsx: exportOptions, includeSqlSheet })) return;
        let outputPath = exportFileName("export-page", "xlsx", { page: true });
        if (isTauriRuntime()) {
          const path = await promptExportSavePath({
            defaultFileName: outputPath,
            filters: [{ name: "Excel", extensions: ["xlsx"] }],
            preferredPath: useSettingsStore().editorSettings.preferredExportPath,
          });
          if (!path) return;
          outputPath = path;
        }
        const result = await resultToExport({ columnIndexes }, undefined, false, true, exportOptions.headerMode);
        await writeXlsxResult(outputPath, result, includeSqlSheet, exportOptions.autoFilter, currentPageExportSql(), xlsxHeaderUsesCommentRows(exportOptions.headerMode));
        notifyExportSuccess(outputPath);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportCurrentPageXlsx(columnIndexes?: number[]) {
    await exportCurrentPageXlsxResult(false, columnIndexes);
  }

  async function exportCurrentPageXlsxWithSql(columnIndexes?: number[]) {
    await exportCurrentPageXlsxResult(true, columnIndexes);
  }

  async function exportMemoryResultSheetsXlsx(sheetsToExport: DataGridExportSheet[] | undefined, includeSqlSheet: boolean): Promise<boolean> {
    if (!isTauriRuntime()) return false;
    let sheets = (sheetsToExport ?? allExportResults?.value ?? []).filter((sheet) => sheet.result.columns.length > 0);
    if (!sheets.length) return true;
    // 导出全部结果集（sheetsToExport === undefined）时，当前激活结果集可能只持
    // 有当前页：SQL 分页会把 tab.result 替换为当前页，而 allExportResults 直接
    // 引用它（snapshotResult === props.result === 激活结果集）。此时重跑一次查询
    // 拉全量，避免"导出所有数据"实际只导出当前页（#13726）。
    const completedResultResults = new Set<QueryResult>();
    if (sheetsToExport === undefined && fullExportResult && !hasCompleteLocalResult?.value) {
      const activeIndex = sheets.findIndex((sheet) => sheet.result === options.snapshotResult?.value);
      if (activeIndex >= 0) {
        // 用户要求全部数据：补全查询失败（含取消）时中止导出而不是静默回退到
        // 当前页快照，否则会产出残缺文件；错误向上传播，与单结果导出路径
        // （resultToExport 中的 fullExportResult 调用）一致，由统一 toast 提示。
        const fullResult = await fullExportResult();
        if (fullResult?.columns.length) {
          sheets = sheets.map((sheet, index) => (index === activeIndex ? { ...sheet, result: fullResult } : sheet));
          completedResultResults.add(fullResult);
        }
      }
    }
    // 补全后的激活 sheet 是重建对象（result 替换为全量结果），不再与
    // allExportResults 中任一原对象共享引用，但其"仍是当前激活结果集"已由
    // sourceCurrent() 通过 snapshotResult 引用一致性保证，故在此豁免，避免
    // 补全后误报 "Export result context changed"。
    const isSheetInAllExportResults = (sheet: DataGridExportSheet) => completedResultResults.has(sheet.result) || !!allExportResults?.value?.some((origin) => origin === sheet || origin.result === sheet.result);
    const sourceCurrent = captureExportConfirmationSource();
    const sources = sheets.map((sheet) => ({ sheet, result: sheet.result, rows: sheet.result.rows }));
    const isCurrent = () => sourceCurrent() && sources.every(({ sheet, result, rows }) => sheet.result === result && sheet.result.rows === rows && (sheetsToExport !== undefined || isSheetInAllExportResults(sheet)));
    const settings = { ...useSettingsStore().editorSettings };
    const title = currentExportTitle();
    const fileName = exportFileName("query-results", "xlsx", { allResults: true });
    const captured = sheets.map((sheet) => ({
      sheetName: sheet.sheetName,
      columns: [...sheet.result.columns],
      columnTypes: [...(sheet.result.column_types ?? [])],
      comments: commentsForExportColumns(sheet.result.columns),
      rows: formatTemporalRowsForExport(
        sheet.result.rows.map((row) => row.map((value) => (value !== null && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value))),
        sheet.result.column_types ?? [],
        settings.globalDateTimeExportFormat,
      ),
      sql: sheet.sql || sheet.result.sourceStatement || "",
      legacyCells: sheet.result.large_value_cells?.filter((cell) => !cell.value_ref).map((cell) => ({ ...cell })) ?? [],
      legacyRead: sheet.result.large_value_cells?.some((cell) => !cell.value_ref) ? sheet.captureSourceValues?.() : undefined,
      snapshot: {
        ...sheet.result,
        rows: sheet.result.rows.map((row) => row.map((value) => (value !== null && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value))),
        large_value_cells: sheet.result.large_value_cells?.map((cell) => ({ ...cell })),
        large_value_context: sheet.result.large_value_context ? { ...sheet.result.large_value_context } : undefined,
      },
    }));
    const lobSources = sources.filter(({ result }) => result.large_value_cells?.some((cell) => cell.value_ref));
    const connections = lobSources.length && getActivePinia() ? useConnectionStore() : undefined;
    const resources = lobSources.map(({ result }) => {
      const context = result.large_value_context;
      if (!context) throw new Error("LOB result connection is unavailable; execute the query again");
      const config = connections?.getConfig(context.connectionId);
      return { connectionId: context.connectionId, revision: connections?.connectionStateRevision(context.connectionId), fingerprint: config ? connectionConfigFingerprint(config) : undefined };
    });
    const resourcesCurrent = () =>
      !scopeDisposed &&
      sourceCurrent() &&
      lobSources.every(({ sheet, result, rows }) => sheet.result === result && result.rows === rows && (sheetsToExport !== undefined || isSheetInAllExportResults(sheet))) &&
      resources.every((resource) => {
        if (!connections) return true;
        const config = connections.getConfig(resource.connectionId);
        return connections.isCurrentConnectionStateRevision(resource.connectionId, resource.revision!) && !!config && connectionConfigFingerprint(config) === resource.fingerprint;
      });
    const exportOptions = await showXlsxHeaderDialog(true);
    if (exportOptions === null) return true;
    if (!isCurrent()) throw new Error("Export result context changed");
    const mode = exportOptions.executionMode ?? (await showExportExecutionModeDialog());
    if (mode === null) return true;
    const outputPath = await promptExportSavePath({ defaultFileName: fileName, filters: [{ name: "Excel", extensions: ["xlsx"] }], preferredPath: settings.preferredExportPath });
    if (!outputPath) return true;
    if (!isCurrent()) throw new Error("Export result context changed");
    const worksheets = captured.map((sheet) => ({
      sheetName: sheet.sheetName,
      columns: sheet.columns,
      columnTypes: sheet.columnTypes,
      columnComments: buildXlsxHeaderOverrides(sheet.columns, sheet.comments, exportOptions.headerMode),
      rows: sheet.rows,
      numericColumnRightAlign: settings.numericColumnRightAlign,
      autoFilter: exportOptions.autoFilter,
      headerCommentRows: xlsxHeaderUsesCommentRows(exportOptions.headerMode),
    }));
    const sqlWorksheet = includeSqlSheet ? buildXlsxSqlWorksheet(captured.map((sheet) => ({ resultName: sheet.sheetName, sql: sheet.sql }))) : undefined;
    const exportId = uuid();
    const totalRows = worksheets.reduce((count, sheet) => count + sheet.rows.length, 0);
    const controller = new AbortController();
    const hasDeferredReads = lobSources.length > 0 || captured.some((sheet) => sheet.legacyCells.length);
    let userCancelled = false;
    let locatorReading = false;
    const cancel = async (user = true) => {
      if (!controller.signal.aborted) userCancelled = user;
      controller.abort(new Error("LOB workbook export cancelled"));
      if (locatorReading) await api.cancelQuery(exportId);
    };
    const cancelSource = () => cancel(false);
    await submitBackendExport({
      exportId,
      tableName: title,
      format: "xlsx",
      outputPath,
      mode,
      openAfterExport: false,
      initialTotalRows: totalRows,
      cancelDuringWrite: false,
      ...(hasDeferredReads
        ? {
            cancel,
            prepare: async () => {
              for (const sheet of captured) if (sheet.legacyCells.length && (!sheet.legacyRead?.read || sheet.legacyRead.unavailableReason)) throw new Error(`${sheet.sheetName}: ${sheet.legacyRead?.unavailableReason ?? "Original table source is unavailable; execute the query again"}`);
              if (lobSources.length && !resourcesCurrent()) throw new Error("LOB result context changed");
            },
          }
        : {}),
      start: async (onProgress) => {
        let unknown = false;
        const readChunk: typeof api.readLargeValueChunk = async (request) => {
          try {
            return await api.readLargeValueChunk(request, true);
          } catch (error) {
            unknown ||= !(error instanceof SnapshotCompletionError) || error.status === "unknown";
            throw error;
          }
        };
        const stop = lobSources.length
          ? watch(
              resourcesCurrent,
              (current) => {
                if (!current) void cancelSource().catch(() => undefined);
              },
              { flush: "sync" },
            )
          : undefined;
        if (hasDeferredReads) activeSnapshotCancels.add(cancelSource);
        try {
          for (let index = 0; index < captured.length; index++) {
            const sheet = captured[index]!;
            if (!sheet.snapshot.large_value_cells?.length) continue;
            try {
              if (sheet.legacyCells.length) {
                let values;
                try {
                  values = await sheet.legacyRead!.read!(controller.signal);
                } catch (error) {
                  unknown ||= !(error instanceof SnapshotCompletionError) || error.status === "unknown";
                  throw error;
                }
                for (const cell of sheet.legacyCells) {
                  const row = values.get(cell.row_index);
                  if (!row?.has(cell.column_index)) throw new Error(`${sheet.sheetName}: complete cell value is unavailable`);
                  sheet.snapshot.rows[cell.row_index]![cell.column_index] = row.get(cell.column_index)!;
                }
                sheet.snapshot.large_value_cells = sheet.snapshot.large_value_cells?.filter((cell) => !!cell.value_ref);
              }
              let rows = sheet.snapshot.rows;
              if (sheet.snapshot.large_value_cells?.length) {
                locatorReading = true;
                try {
                  rows = await materializeSnapshotResultRows(sheet.snapshot, resourcesCurrent, controller.signal, exportId, { waitForNative: true, readChunk });
                } finally {
                  locatorReading = false;
                }
              }
              if (controller.signal.aborted) throw controller.signal.reason;
              assertSnapshotXlsxCellLengths(rows);
              worksheets[index]!.rows = formatTemporalRowsForExport(rows, sheet.columnTypes, settings.globalDateTimeExportFormat);
            } catch (error) {
              if (unknown) throw error;
              const cancelled = userCancelled && ((error instanceof SnapshotCompletionError && error.status === "cancelled") || error === controller.signal.reason);
              const progress: api.TableExportProgress = { exportId, tableName: title, rowsExported: 0, totalRows, status: cancelled ? "Cancelled" : "Error", errorMessage: error instanceof Error ? error.message : String(error) };
              onProgress(progress);
              return progress;
            }
          }
          onProgress({ exportId, tableName: title, rowsExported: totalRows, totalRows, status: "Writing" });
          try {
            await api.exportQueryResultsXlsx(outputPath, sqlWorksheet ? [...worksheets, { ...sqlWorksheet, autoFilter: false }] : worksheets, exportOptions.autoFilter, settings.globalDateTimeExportFormat || undefined);
          } catch (error) {
            unknown = true;
            throw error;
          }
          return { exportId, tableName: title, rowsExported: totalRows, totalRows, status: "Done" };
        } finally {
          if (!unknown) {
            stop?.();
            activeSnapshotCancels.delete(cancelSource);
          }
        }
      },
    });
    return true;
  }

  async function exportResultSheetsXlsxResult(sheetsToExport: DataGridExportSheet[] | undefined, includeSqlSheet: boolean) {
    if (isTauriRuntime()) {
      let handled = false;
      await runExclusiveExport(async () => {
        try {
          handled = await exportMemoryResultSheetsXlsx(sheetsToExport, includeSqlSheet);
        } catch (error) {
          handled = true;
          toast(t("grid.exportFailed", { message: translateBackendError(t, error) }), 5000);
        }
      });
      if (!handled) await exportResultSheetsXlsxFallback(sheetsToExport, includeSqlSheet);
      return;
    }
    await exportResultSheetsXlsxFallback(sheetsToExport, includeSqlSheet);
  }

  async function exportResultSheetsXlsxFallback(sheetsToExport: DataGridExportSheet[] | undefined, includeSqlSheet: boolean) {
    const exportOptions = await showXlsxHeaderDialog();
    if (exportOptions === null) return;

    await runExclusiveExport(async () => {
      try {
        let sheets = (sheetsToExport ?? allExportResults?.value ?? []).filter((sheet) => sheet.result.columns.length > 0);
        if (sheets.length === 0) return;

        // 与 exportMemoryResultSheetsXlsx 相同：导出全部结果集且激活结果集分页
        // 未完整时，重跑查询拉全量，避免只导出当前页（#13726）。
        const completedResultResults = new Set<QueryResult>();
        if (sheetsToExport === undefined && fullExportResult && !hasCompleteLocalResult?.value) {
          const activeIndex = sheets.findIndex((sheet) => sheet.result === options.snapshotResult?.value);
          if (activeIndex >= 0) {
            // 与 exportMemoryResultSheetsXlsx 相同：补全失败（含取消）时中止导出，
            // 不静默回退到当前页，错误由外层统一 toast 报错。
            const fullResult = await fullExportResult();
            if (fullResult?.columns.length) {
              sheets = sheets.map((sheet, index) => (index === activeIndex ? { ...sheet, result: fullResult } : sheet));
              completedResultResults.add(fullResult);
            }
          }
        }
        // 补全后的激活 sheet 是重建对象，不再与 allExportResults 共享引用，但
        // snapshotResult 引用一致性已保证其仍为当前激活结果集，故豁免成员检查。
        const isSheetInAllExportResults = (sheet: DataGridExportSheet) => completedResultResults.has(sheet.result) || !!allExportResults?.value?.some((origin) => origin === sheet || origin.result === sheet.result);

        let outputPath = exportFileName("query-results", "xlsx", { allResults: true });
        if (isTauriRuntime()) {
          const path = await promptExportSavePath({
            defaultFileName: outputPath,
            filters: [{ name: "Excel", extensions: ["xlsx"] }],
            preferredPath: useSettingsStore().editorSettings.preferredExportPath,
          });
          if (!path) return;
          outputPath = path;
        }

        const exportPattern = useSettingsStore().editorSettings.globalDateTimeExportFormat;
        const rightAlign = useSettingsStore().editorSettings.numericColumnRightAlign;
        const worksheets = [];
        for (const sheet of sheets) {
          const sourceRows = sheet.result.rows;
          const rows = await materializeExportSnapshot(sheet.result, () => sheet.result.rows === sourceRows && (sheetsToExport !== undefined || isSheetInAllExportResults(sheet)));
          if (sheet.result.large_value_refs?.length || sheet.result.large_value_cells?.some((cell) => cell.value_ref)) assertSnapshotXlsxCellLengths(rows);
          worksheets.push({
            sheetName: sheet.sheetName,
            columns: sheet.result.columns,
            columnTypes: sheet.result.column_types ?? [],
            columnComments: buildXlsxHeaderOverrides(sheet.result.columns, commentsForExportColumns(sheet.result.columns), exportOptions.headerMode),
            rows: formatTemporalRowsForExport(rows, sheet.result.column_types ?? [], exportPattern),
            numericColumnRightAlign: rightAlign,
            autoFilter: exportOptions.autoFilter,
            headerCommentRows: xlsxHeaderUsesCommentRows(exportOptions.headerMode),
          });
        }
        const sqlWorksheet = includeSqlSheet ? buildXlsxSqlWorksheet(sheets.map((sheet) => ({ resultName: sheet.sheetName, sql: sheet.sql || sheet.result.sourceStatement || "" }))) : undefined;
        await api.exportQueryResultsXlsx(outputPath, sqlWorksheet ? [...worksheets, { ...sqlWorksheet, autoFilter: false }] : worksheets, exportOptions.autoFilter, exportPattern || undefined);
        notifyExportSuccess(outputPath);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function exportAllResultsXlsx() {
    await exportResultSheetsXlsxResult(undefined, false);
  }

  async function exportAllResultsXlsxWithSql() {
    await exportResultSheetsXlsxResult(undefined, true);
  }

  /** SQL 文件导出与 SQL INSERT 复制共用同一主键处理模式。 */
  function sqlExportExcludedColumns(columnNames?: readonly string[]): string[] | undefined {
    return captureSqlExportExcludedColumns()(columnNames);
  }

  function captureSqlExportExcludedColumns() {
    const mode = extractorOptionsOption?.value?.sql.primaryKeyMode ?? "include";
    if (mode === "include") return (_columnNames?: readonly string[]) => undefined;
    const primaryKeys = [...(tableMeta.value?.primaryKeys ?? [])];
    const excluded = mode === "exclude-all" ? primaryKeys : primaryKeys.filter((column) => isAutoGeneratedColumn(databaseType.value, column, tableMeta.value));
    const knownColumns = tableMeta.value?.columns?.length ? tableMeta.value.columns.map((column) => column.name) : [...allColumns.value];
    const type = databaseType.value;
    return (columnNames?: readonly string[]) => {
      const projectedExcluded = columnNames ? columnNames.filter((column) => isSqlExportPrimaryKeyExcluded(type, column, knownColumns, excluded)) : excluded;
      return projectedExcluded.length > 0 ? projectedExcluded : undefined;
    };
  }

  /**
   * 导出列对应的原表 EXTRA 元数据（SQL Server/Dameng 的 identity 等）。后端据此
   * 给导出的 INSERT 包上 `SET IDENTITY_INSERT`，否则回放时报 SQL Server 544。
   * 拿不到表元数据时返回 undefined，后端保持“未知”语义，不额外查一次元数据。
   */
  function sqlExportColumnExtras(columnNames: string[]): Array<string | null> | undefined {
    const metaColumns = tableMeta.value?.columns;
    if (!metaColumns?.length) return undefined;
    const extras = columnNames.map((column) => findCopyColumnInfo(databaseType.value, column, tableMeta.value)?.extra ?? null);
    return extras.some((extra) => !!extra) ? extras : undefined;
  }

  function sqlInsertTargetMeta(): DataGridTableMeta | undefined {
    if (context.value === "results" && hasUniqueQueryInsertTarget?.value !== true) return undefined;
    return tableMeta.value;
  }

  function sqlInsertTargetSchema(meta: DataGridTableMeta | undefined): string | undefined {
    if (!meta?.schema || dropsSchemaQualifier(databaseType.value, options.includeDatabaseName?.value, meta.catalog)) return undefined;
    return meta.schema;
  }

  function sqlInsertTargetName(meta: DataGridTableMeta | undefined): string {
    return meta?.tableName || (context.value === "results" ? "query_result" : "table_name");
  }

  /** 供 SQL 导出请求传递共享的主键模式和原表主键列表。 */
  function sqlExportPrimaryKeyOptions(format: string): { primaryKeyMode?: DataGridPrimaryKeyMode; primaryKeys?: string[] } {
    if (format !== "sql") return {};
    return {
      primaryKeyMode: extractorOptionsOption?.value?.sql.primaryKeyMode ?? "include",
      ...(tableMeta.value?.primaryKeys ? { primaryKeys: tableMeta.value.primaryKeys } : {}),
    };
  }

  function hasActiveColumnFormatters(columnIndexes?: number[]): boolean {
    if (!options.hasColumnFormatter) return false;
    const applyFormatters = options.applyColumnFormattersOnExport?.value ?? (getActivePinia() ? useSettingsStore().editorSettings.applyColumnFormattersOnExport : true);
    if (!applyFormatters) return false;
    const allCount = options.allColumns?.value?.length ?? options.columns.value.length;
    if (columnIndexes && columnIndexes.length > 0) {
      const visibleIndexes = visibleColumnIndexesOption?.value;
      return columnIndexes.some((index) => {
        const sourceIndex = visibleIndexes ? (visibleIndexes[index] ?? index) : index;
        return options.hasColumnFormatter!(sourceIndex);
      });
    }
    for (let i = 0; i < allCount; i++) {
      if (options.hasColumnFormatter(i)) return true;
    }
    return false;
  }

  async function exportFullTableDataViaBackend(
    format: "csv" | "xlsx" | "json" | "markdown" | "sql" | "txt",
    rowIds?: number[],
    headerMode: XlsxHeaderMode = "name",
    autoFilter = true,
    sqlExportOptions?: SqlExportOptions,
    openAfterExport = false,
    columnIndexes?: number[],
    selectedMode?: ManualExportMode,
  ): Promise<boolean> {
    const meta = tableMeta.value;
    // The backend table exporter currently builds two-part table names. External
    // Doris/StarRocks catalogs need the data-tab paginator's three-part SQL.
    if (rowIds !== undefined || columnIndexes !== undefined || context.value !== "table-data" || !meta || meta.catalog || !connectionId.value || !database.value) {
      return false;
    }
    if (format !== "sql" && hasActiveColumnFormatters(columnIndexes)) {
      return false;
    }

    const editorSettings = { ...useSettingsStore().editorSettings };
    const exportId = uuid();
    const exportedColumns = format === "sql" ? effectiveColumns(sourceColumns.value, columns.value).map((column, index) => column ?? columns.value[index]!) : [...columns.value];
    const request: api.TableExportRequest = {
      exportId,
      connectionId: connectionId.value,
      database: database.value,
      schema: meta.schema,
      identifierQuote: options.identifierQuote?.value,
      tableName: meta.tableName,
      filePath: "",
      format,
      ...(format === "sql" && sqlExportOptions
        ? {
            insertMode: sqlExportOptions.insertMode,
            splitMaxMb: sqlExportOptions.splitMaxMb,
            selectedColumns: sqlExportOptions.selectedColumns?.map((column) => ({ ...column })),
            omitDatabaseQualifier: dropsSchemaQualifier(databaseType.value, options.includeDatabaseName?.value, meta.catalog),
          }
        : {}),
      csvQuoteMode: editorSettings.csvQuoteMode,
      nullLiteral: csvNullLiteralForMode(editorSettings.csvNullMode),
      columns: exportedColumns,
      columnTypes: columnTypes.value ? [...columnTypes.value] : undefined,
      ...(format === "sql" ? { columnExtras: sqlExportColumnExtras(exportedColumns) } : {}),
      columnComments: format === "xlsx" ? buildXlsxHeaderOverrides(columns.value, visibleXlsxColumnComments.value, headerMode) : undefined,
      headerCommentRows: format === "xlsx" ? xlsxHeaderUsesCommentRows(headerMode) : undefined,
      primaryKeys: meta.primaryKeys ? [...meta.primaryKeys] : undefined,
      ...sqlExportPrimaryKeyOptions(format),
      whereInput: whereInput.value,
      orderBy: orderBy.value,
      skipCount: false,
      batchSize: exportBatchSize.value,
      rowLimit: editorSettings.exportRowLimitEnabled ? editorSettings.exportRowLimit : null,
      dateTimeFormat: editorSettings.globalDateTimeExportFormat || undefined,
      numericColumnRightAlign: editorSettings.numericColumnRightAlign ?? true,
      autoFilter: format === "xlsx" ? autoFilter : undefined,
    };
    const preparingStore = isTauriRuntime() && getActivePinia() ? useConnectionStore() : undefined;
    const originalConfig = preparingStore?.getConfig(request.connectionId);
    const fingerprint = originalConfig ? connectionConfigFingerprint(originalConfig) : undefined;
    const mode = openAfterExport ? "immediate" : (selectedMode ?? sqlExportOptions?.executionMode ?? (await showExportExecutionModeDialog()));
    if (mode === null) return true;
    const connStore = mode === "queued" ? useConnectionStore() : undefined;
    const fmt = FORMAT_META[format];
    const splitSqlOutput = format === "sql" && request.splitMaxMb !== undefined;
    const extension = splitSqlOutput ? "zip" : (fmt?.ext ?? format);
    const filterName = splitSqlOutput ? "ZIP" : (fmt?.label ?? format.toUpperCase());
    let outputPath = exportFileName(request.tableName || "export", extension, { preferFallback: true });
    if (openAfterExport && isTauriRuntime()) {
      outputPath = await api.createQueryResultTempFile(extension);
    } else if (isTauriRuntime()) {
      const path = await promptExportSavePath({
        defaultFileName: outputPath,
        filters: [{ name: filterName, extensions: [extension] }],
        preferredPath: editorSettings.preferredExportPath,
      });
      if (!path) return true;
      outputPath = path;
    }

    if (scopeDisposed || connectionId.value !== request.connectionId || database.value !== request.database || tableMeta.value?.tableName !== request.tableName || tableMeta.value?.schema !== request.schema) {
      toast(t("exportProgress.connectionChanged"), 5000);
      return true;
    }
    request.filePath = outputPath;
    await submitBackendExport({
      exportId,
      tableName: request.tableName,
      format,
      outputPath,
      mode,
      openAfterExport,
      start: (onProgress) => (isTauriRuntime() ? api.startTableExport(request, onProgress, true) : api.startTableExport(request, onProgress)),
      cancel: () => api.cancelTableExport(exportId),
      prepare: connStore
        ? async () => {
            const assertCurrent = () => {
              const current = connStore.getConfig(request.connectionId);
              if (!current || connectionConfigFingerprint(current) !== fingerprint) throw new Error(t("exportProgress.connectionChanged"));
            };
            assertCurrent();
            await connStore.ensureConnected(request.connectionId);
            assertCurrent();
          }
        : undefined,
    });
    return true;
  }

  async function submitBackendExport({
    exportId,
    tableName,
    format,
    outputPath,
    mode,
    openAfterExport,
    initialTotalRows = null,
    prepare,
    start,
    cancel,
    cancelDuringWrite = true,
  }: {
    exportId: string;
    tableName: string;
    format: string;
    outputPath: string;
    mode: ManualExportMode;
    openAfterExport: boolean;
    initialTotalRows?: number | null;
    prepare?: () => Promise<void>;
    start: (onProgress: (progress: api.TableExportProgress) => void) => Promise<api.TableExportProgress>;
    cancel?: () => Promise<void>;
    cancelDuringWrite?: boolean;
  }): Promise<void> {
    currentExportViewId = exportId;

    if (exportProgressState) {
      exportProgressState.value = {
        title: t("exportProgress.title"),
        tableName,
        format,
        rowsExported: 0,
        totalRows: initialTotalRows,
        status: "Running",
        errorMessage: null,
        filePath: outputPath,
        startedAt: Date.now(),
        finishedAt: undefined,
      };
    }
    if (exportProgressDialog) exportProgressDialog.value = true;
    if (exportCanMinimize) exportCanMinimize.value = true;

    const task = tracker.addTask(tableName, format, outputPath, exportId);
    task.totalRows = initialTotalRows;
    if (exportCancelHandler) {
      exportCancelHandler.value = () => tracker.cancelTask(exportId);
    }
    const ownsView = () => !scopeDisposed && currentExportViewId === exportId;
    const updateView = () => {
      if (ownsView()) {
        if (exportProgressState) exportProgressState.value = { ...exportProgressState.value, status: task.status, startedAt: task.startedAt, finishedAt: task.finishedAt, errorMessage: task.errorMessage };
        if (exportCancelHandler) exportCancelHandler.value = task.canCancel === false || task.status === "Done" || task.status === "Error" || task.status === "Cancelled" ? null : () => tracker.cancelTask(exportId);
      }
    };
    let executionError: unknown;
    const execute = async (): Promise<"settled" | "unknown"> => {
      let started = false;
      let terminalSeen = false;
      let cancellationRequested = false;
      tracker.registerTaskCancelHandler(exportId, async () => {
        cancellationRequested = true;
        task.status = "Cancelling";
        updateView();
        if (started) await cancel?.();
      });
      try {
        if (prepare) await prepare();
        if (cancellationRequested) {
          tracker.updateTableExportTask(exportId, { exportId, tableName, rowsExported: 0, totalRows: null, status: "Cancelled" });
          updateView();
          return "settled";
        }
        started = true;
        task.canCancel = cancel !== undefined;
        updateView();
        const progress = await start((progress) => {
          if (!cancelDuringWrite && progress.status === "Writing") {
            task.canCancel = false;
            updateView();
          }
          terminalSeen ||= progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled";
          tracker.updateTableExportTask(exportId, progress);
          if (ownsView() && exportProgressState) {
            exportProgressState.value = {
              ...exportProgressState.value,
              tableName: progress.tableName || tableName,
              rowsExported: progress.rowsExported,
              totalRows: progress.totalRows !== null && progress.rowsExported > progress.totalRows ? progress.rowsExported : progress.totalRows,
              status: task.status,
              errorMessage: progress.errorMessage || null,
              finishedAt: progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled" ? Date.now() : exportProgressState.value.finishedAt,
            };
          }
        });
        if (!terminalSeen) tracker.updateTableExportTask(exportId, progress);
        terminalSeen ||= progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled";
        if (progress.status === "Done") {
          notifyExportSuccess(openAfterExport ? undefined : outputPath);
          if (openAfterExport && isTauriRuntime()) await api.openQueryResultTempFile(outputPath);
        }
        return terminalSeen ? "settled" : "unknown";
      } catch (error) {
        executionError = error;
        const confirmedFailure = error instanceof SnapshotCompletionError && error.status === "failed";
        if (confirmedFailure) started = false;
        if (started && !terminalSeen && isTauriRuntime() && !confirmedFailure) throw error;
        if (terminalSeen && task.status === "Done") return "settled";
        tracker.updateTableExportTask(exportId, { exportId, tableName, rowsExported: task.rowsExported, totalRows: task.totalRows, status: "Error", errorMessage: error instanceof Error ? error.message : String(error) });
        updateView();
        if (!started || terminalSeen || confirmedFailure) return "settled";
        throw error;
      } finally {
        if (!isTauriRuntime() || !started || terminalSeen) {
          tracker.unregisterTaskCancelHandler(exportId);
          if (ownsView()) {
            if (exportCancelHandler) exportCancelHandler.value = null;
            if (exportCanMinimize) exportCanMinimize.value = false;
          }
        }
      }
    };
    if (!isTauriRuntime()) {
      await execute();
      if (executionError !== undefined) throw executionError;
      return;
    }
    let completion: Promise<"settled" | "unknown"> | undefined;
    tracker.submitExportTask(task, mode, () => (completion = execute()), updateView);
    if (mode === "immediate") {
      await completion;
      if (executionError !== undefined) throw executionError;
    }
  }

  async function exportQueryResultViaBackend(
    format: "csv" | "xlsx" | "json" | "txt" | "sql",
    rowIds?: number[],
    includeSqlSheet = false,
    headerMode: XlsxHeaderMode = "name",
    autoFilter = true,
    sqlExportOptions?: SqlExportOptions,
    openAfterExport = false,
    columnIndexes?: number[],
    selectedMode?: ManualExportMode,
  ): Promise<boolean> {
    if (rowIds !== undefined || columnIndexes !== undefined || context.value !== "results" || !queryResultExportRequest) {
      return false;
    }
    if (format !== "sql" && hasActiveColumnFormatters(columnIndexes)) {
      return false;
    }
    if (databaseType.value === "mongodb") return false;
    // The full result is already in memory — don't re-execute the query on the
    // backend just to stream the same rows back to a file.
    if (hasCompleteLocalResult?.value) return false;

    const sourceConnectionId = connectionId.value;
    const sourceDatabase = database.value;
    const sourceSql = sql.value;
    const sourceResult = options.snapshotResult?.value;
    const immediateBuilder = options.captureQueryResultExportRequest?.(false);
    const queuedBuilder = options.captureQueryResultExportRequest?.(true);
    const editorSettings = { ...useSettingsStore().editorSettings };
    const exportId = uuid();
    const insertTarget = format === "sql" ? sqlInsertTargetMeta() : undefined;
    const buildOptions = {
      exportId,
      format,
      includeSqlSheet,
      exportTableName: insertTarget?.tableName,
      exportSchema: insertTarget?.tableName ? sqlInsertTargetSchema(insertTarget) : undefined,
      exportColumnTypes: format === "sql" || format === "xlsx" ? allColumnTypes.value?.map((type) => type ?? null) : undefined,
      exportColumnExtras: format === "sql" ? sqlExportColumnExtras(allColumns.value) : undefined,
      ...(format === "sql" && sqlExportOptions ? { insertMode: sqlExportOptions.insertMode } : {}),
    };
    const requestOptions = {
      ...(format === "sql" ? { selectedColumns: sqlExportOptions?.selectedColumns?.map((column) => ({ ...column })) } : {}),
      csvQuoteMode: editorSettings.csvQuoteMode,
      nullLiteral: csvNullLiteralForMode(editorSettings.csvNullMode),
      ...sqlExportPrimaryKeyOptions(format),
      dateTimeFormat: editorSettings.globalDateTimeExportFormat || undefined,
      numericColumnRightAlign: editorSettings.numericColumnRightAlign ?? true,
      columnComments: format === "xlsx" ? buildXlsxHeaderOverrides(allColumns.value, allXlsxColumnComments.value, headerMode) : undefined,
      headerCommentRows: format === "xlsx" && xlsxHeaderUsesCommentRows(headerMode),
      autoFilter: format === "xlsx" ? autoFilter : undefined,
    };
    const fmt = FORMAT_META[format];
    const extension = fmt?.ext ?? format;
    const filterName = fmt?.label ?? format.toUpperCase();
    let outputPath = exportFileName("query-result", extension);
    const mode = openAfterExport ? "immediate" : (selectedMode ?? sqlExportOptions?.executionMode ?? (await showExportExecutionModeDialog()));
    if (mode === null) return true;
    if (isTauriRuntime()) {
      if (openAfterExport) outputPath = await api.createQueryResultTempFile(extension);
      else {
        const path = await promptExportSavePath({
          defaultFileName: outputPath,
          filters: [{ name: filterName, extensions: [extension] }],
          preferredPath: editorSettings.preferredExportPath,
        });
        if (!path) return true;
        outputPath = path;
      }
    }

    if (scopeDisposed || connectionId.value !== sourceConnectionId || database.value !== sourceDatabase || sql.value !== sourceSql || options.snapshotResult?.value !== sourceResult) {
      toast(t("exportProgress.connectionChanged"), 5000);
      return true;
    }
    const builder = mode === "queued" ? queuedBuilder : (immediateBuilder ?? queryResultExportRequest);
    if (!builder) throw new Error("Unable to capture query result export request");
    const build = async () => {
      const baseRequest = await builder({ ...buildOptions, filePath: outputPath });
      if (!baseRequest) throw new Error("Unable to build query result export request");
      return { ...baseRequest, ...requestOptions };
    };
    let request: QueryResultExportRequest | undefined;
    if (mode === "immediate") request = await build();
    await submitBackendExport({
      exportId,
      tableName: "Query Result",
      format,
      outputPath,
      mode,
      openAfterExport,
      initialTotalRows: request?.totalRows ?? null,
      prepare:
        mode === "queued"
          ? async () => {
              request = await build();
            }
          : undefined,
      start: (onProgress) => (isTauriRuntime() ? api.startQueryResultExport(request!, onProgress, true) : api.startQueryResultExport(request!, onProgress)),
      cancel: () => api.cancelQueryResultExport(exportId, request!.executionId),
    });
    return true;
  }

  async function exportQueryResultSqlViaBackend(rowIds: number[] | undefined, sqlExportOptions: SqlExportOptions, columnIndexes?: number[]): Promise<boolean> {
    if (!isTauriRuntime() || columnIndexes !== undefined) return false;
    return exportQueryResultViaBackend("sql", rowIds, false, "name", true, sqlExportOptions, false, columnIndexes);
  }

  function sqlExportChoices(fullResult: boolean, columnSubset?: readonly string[]): SqlExportColumnSelection[] {
    const names = columnSubset ?? (context.value === "table-data" ? effectiveColumns(sourceColumns.value, columns.value) : fullResult ? allColumns.value : columns.value);
    const excluded = sqlExportExcludedColumns() ?? [];
    const types = fullResult && context.value === "results" ? allColumnTypes.value : columnTypes.value;
    // A subset's sourceIndex is its position within the subset; resolve the
    // metadata-less type fallback by name against the typed column list.
    const typeNames = fullResult && context.value === "results" ? allColumns.value : context.value === "table-data" ? effectiveColumns(sourceColumns.value, columns.value) : columns.value;
    const typeByName = columnSubset ? new Map(typeNames.map((name, index) => [name, types?.[index]])) : undefined;
    const metadataByName = new Map((tableMeta.value?.columns ?? []).map((column) => [normalizeColumnName(column.name), column]));
    return sqlExportColumnChoices(names).filter((column) => {
      if (isSqlExportPrimaryKeyExcluded(databaseType.value, column.name, names, excluded) || usesSyntheticRowIdKey(databaseType.value, [column.name])) return false;
      const metadata = metadataByName.get(normalizeColumnName(column.name));
      if (databaseType.value === "mysql" && /\b(?:virtual|stored|persistent)\s+generated\b|\bgenerated\s+always\s+as\s*\(/i.test(metadata?.extra ?? "")) return false;
      const columnType = (metadata?.data_type || (columnSubset ? typeByName?.get(column.name) : types?.[column.sourceIndex]))?.trim().replace(/^"|"$/g, "").toLowerCase();
      return databaseType.value !== "postgres" || (columnType !== "tsvector" && !columnType?.endsWith(".tsvector"));
    });
  }

  async function exportSql(target?: ExportTargetParam, columnIndexesParam?: number[]) {
    if (!allowExport("sql")) return;
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
    const isSourceCurrent = captureExportConfirmationSource();
    await runExclusiveExport(async () => {
      const exportId = uuid();
      const exportStartedAt = performance.now();
      const logExportStage = (stage: string, details: Record<string, unknown> = {}, sampleNativeMemory = false) => {
        if (!isDebugLoggingEnabled()) return;
        appendDebugLog("info", `[DBX][export:sql:${stage}]`, {
          exportId,
          elapsedMs: Math.round(performance.now() - exportStartedAt),
          ...details,
          browserMemory: getBrowserMemorySnapshot(),
        });
        if (sampleNativeMemory) void appendNativeProcessMemoryLog(`export-sql-${stage}`, { exportId });
      };

      logExportStage(
        "start",
        {
          context: context.value,
          databaseType: databaseType.value,
          exportAllRows: rowIds === undefined,
          requestedRowCount: rowIds?.length ?? null,
          hasCompleteLocalResult: hasCompleteLocalResult?.value ?? null,
        },
        true,
      );
      const chosenColumns = columnIndexes !== undefined ? columnIndexes.map((i) => columns.value[i]).filter((c): c is string => !!c) : undefined;
      const selectedSqlExportOptions = (await showSqlInsertModeDialog({
        allowSplit: rowIds === undefined && columnIndexes === undefined && context.value === "table-data",
        columns: sqlExportChoices(rowIds === undefined, chosenColumns),
        showExecutionMode: isTauriRuntime(),
      })) as SqlExportOptions | SqlInsertMode | null;
      if (selectedSqlExportOptions === null) {
        logExportStage("cancelled", { stage: "insert-mode-dialog" });
        return;
      }
      const sqlExportOptions: SqlExportOptions = typeof selectedSqlExportOptions === "string" ? { insertMode: selectedSqlExportOptions } : selectedSqlExportOptions;
      const insertMode = sqlExportOptions.insertMode;
      logExportStage("mode-selected", { insertMode, splitMaxMb: sqlExportOptions.splitMaxMb });
      try {
        if (isTauriRuntime() && !isSourceCurrent()) throw new Error("Export result context changed");
        // Step 1: table-data context — existing backend table export
        logExportStage("backend-export-start");
        const handledByBackend = await exportFullTableDataViaBackend("sql", rowIds, "name", true, sqlExportOptions, false, columnIndexes);
        logExportStage("backend-export-finished", { handledByBackend });
        if (handledByBackend) {
          logExportStage("done", { path: "backend" });
          return;
        }

        // Step 2: query-result context — NEW backend streaming with background task
        logExportStage("query-backend-export-start");
        const handledQueryByBackend = await exportQueryResultSqlViaBackend(rowIds, sqlExportOptions, columnIndexes);
        logExportStage("query-backend-export-finished", { handledByBackend: handledQueryByBackend });
        if (handledQueryByBackend) {
          logExportStage("done", { path: "query-backend" });
          return;
        }

        if (await exportLocalSnapshot("sql", rowIds, columnIndexes, true, { sql: sqlExportOptions })) return;
        if (await exportMemoryDataFile("sql", rowIds, columnIndexes, true, { sql: sqlExportOptions })) return;

        // Step 3: fallback — local export (Web and edge-case scenarios)
        const result = await resultToExport({ rowIds, columnIndexes }, undefined, true, false);
        logExportStage(
          "result-ready",
          {
            columns: result.columns.length,
            rows: result.rows.length,
            values: isDebugLoggingEnabled() ? summarizeExportRows(result.rows) : undefined,
          },
          true,
        );

        logExportStage("row-remap-start");
        const exportData = sqlInsertExportData(result, sqlExportOptions.selectedColumns);
        logExportStage("row-remap-done", {
          columns: exportData.columns.length,
          rows: exportData.rows.length,
          values: isDebugLoggingEnabled() ? summarizeExportRows(exportData.rows) : undefined,
        });

        logExportStage("sql-build-start");
        const insertTarget = sqlInsertTargetMeta();
        const content = await formatSqlInsert({
          databaseType: databaseType.value,
          identifierQuote: options.identifierQuote?.value,
          schema: sqlInsertTargetSchema(insertTarget),
          tableName: sqlInsertTargetName(insertTarget),
          columns: exportData.columns,
          columnTypes: exportData.columnTypes,
          columnExtras: exportData.columnExtras,
          spatialColumns: exportData.spatialColumns,
          spatialValues: exportData.spatialValues,
          rows: exportData.rows,
          insertMode,
          excludeColumns: sqlExportExcludedColumns(exportData.columns),
        });
        logExportStage(
          "sql-build-done",
          {
            sqlChars: content.length,
          },
          true,
        );
        logExportStage("save-start", { contentChars: content.length }, true);
        const saved = await saveTextFile(content, exportFileName(tableMeta.value?.tableName || "export", "sql", { preferFallback: true }), "SQL", "sql", { exportId, operation: "sql-insert-all" });
        if (!saved) return;
        logExportStage("done", { contentChars: content.length });
        notifyExportSuccess(typeof saved === "string" ? saved : undefined);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
        logExportStage("error", {
          errorName: e?.name || typeof e,
          errorMessage: e?.message || String(e),
        });
      }
    });
  }

  async function exportCurrentPageSql(columnIndexes?: number[]) {
    const isSourceCurrent = captureExportConfirmationSource();
    if (!allowExport("sql")) return;
    await runExclusiveExport(async () => {
      const chosenColumns = columnIndexes !== undefined ? columnIndexes.map((i) => columns.value[i]).filter((c): c is string => !!c) : undefined;
      const selectedSqlExportOptions = (await showSqlInsertModeDialog({ columns: sqlExportChoices(false, chosenColumns), showExecutionMode: isTauriRuntime() })) as SqlExportOptions | SqlInsertMode | null;
      if (selectedSqlExportOptions === null) return;
      const sqlExportOptions: SqlExportOptions = typeof selectedSqlExportOptions === "string" ? { insertMode: selectedSqlExportOptions } : selectedSqlExportOptions;
      const insertMode = sqlExportOptions.insertMode;
      try {
        if (isTauriRuntime() && !isSourceCurrent()) throw new Error("Export result context changed");
        if (await exportLocalSnapshot("sql", undefined, columnIndexes, false, { sql: sqlExportOptions })) return;
        if (await exportMemoryDataFile("sql", undefined, columnIndexes, false, { sql: sqlExportOptions })) return;
        const result = await resultToExport({ columnIndexes }, undefined, false, false);
        const exportData = sqlInsertExportData(result, sqlExportOptions.selectedColumns);
        const insertTarget = sqlInsertTargetMeta();
        const content = await formatSqlInsert({
          databaseType: databaseType.value,
          identifierQuote: options.identifierQuote?.value,
          schema: sqlInsertTargetSchema(insertTarget),
          tableName: sqlInsertTargetName(insertTarget),
          columns: exportData.columns,
          columnTypes: exportData.columnTypes,
          columnExtras: exportData.columnExtras,
          spatialColumns: exportData.spatialColumns,
          spatialValues: exportData.spatialValues,
          rows: exportData.rows,
          insertMode,
          excludeColumns: sqlExportExcludedColumns(exportData.columns),
        });
        const saved = await saveTextFile(content, exportFileName("export-page", "sql", { page: true }), "SQL", "sql");
        if (!saved) return;
        notifyExportSuccess(typeof saved === "string" ? saved : undefined);
      } catch (e: any) {
        toast(t("grid.exportFailed", { message: translateBackendError(t, e) }), 5000);
      }
    });
  }

  async function copySql() {
    if (!sql.value) return;
    await copyText(sql.value);
  }

  function sqlInsertExportData(result: Parameters<typeof captureSqlInsertExportData>[0], selectedColumns?: SqlExportColumnSelection[]) {
    return captureSqlInsertExportData(result, selectedColumns)(result.rows);
  }

  function captureSqlInsertContext() {
    return {
      columns: [...columns.value],
      sourceColumns: sourceColumns.value ? [...sourceColumns.value] : undefined,
      columnTypes: columnTypes.value ? [...columnTypes.value] : undefined,
      context: context.value,
      databaseType: databaseType.value,
      tableMeta: tableMeta.value ? (JSON.parse(JSON.stringify(tableMeta.value)) as NonNullable<typeof tableMeta.value>) : undefined,
    };
  }

  function captureSqlInsertExportData(
    result: { columns: string[]; columnTypes?: Array<string | undefined>; rows: CellValue[][]; spatialColumns?: QueryResult["spatial_columns"]; spatialValues?: QueryResult["spatial_values"] },
    selectedColumns?: SqlExportColumnSelection[],
    snapshot = captureSqlInsertContext(),
  ) {
    const matchesVisibleColumns = result.columns.length === snapshot.columns.length && result.columns.every((column, index) => column === snapshot.columns[index]);
    const exportColumns = snapshot.context === "table-data" && snapshot.tableMeta && matchesVisibleColumns ? effectiveColumns(snapshot.sourceColumns, result.columns) : result.columns;
    const columnIndexes = resolveSqlExportColumnIndexes(exportColumns, selectedColumns)
      .map((index) => ({ column: exportColumns[index], index }))
      .filter((item): item is { column: string; index: number } => !!item.column);
    const exportColumnTypes = matchesVisibleColumns && snapshot.columnTypes?.length === result.columns.length ? snapshot.columnTypes : result.columnTypes?.length === result.columns.length ? result.columnTypes : undefined;
    const metaColumns = snapshot.tableMeta?.columns;
    const exportColumnExtras = metaColumns?.length ? exportColumns.map((column) => (column ? (findCopyColumnInfo(snapshot.databaseType, column, snapshot.tableMeta)?.extra ?? null) : null)) : undefined;
    // SQL Server 的结果集列类型来自 TDS：rowversion 会报成 varbinary/binary，据此无法识别不可插入列；
    // 表元数据（sys.columns）里才是 "timestamp"。与数据库级导出链同口径，SQL Server 的 INSERT 载荷
    // 优先用表元数据类型、缺元数据时回退结果集类型（其它引擎维持结果集类型优先）。
    const metadataTypeByColumn = snapshot.databaseType === "sqlserver" && metaColumns?.length ? new Map(metaColumns.map((meta) => [normalizeColumnName(meta.name), meta.data_type])) : undefined;
    const indexBySource = new Map(columnIndexes.map((item, index) => [item.index, index]));
    const spatialColumns = result.spatialColumns?.flatMap((column) => {
      const columnIndex = indexBySource.get(column.column_index);
      return columnIndex === undefined ? [] : [{ column_index: columnIndex, srid: column.srid }];
    });
    const captured = {
      columns: columnIndexes.map((item) => item.column),
      columnTypes:
        exportColumnTypes || metadataTypeByColumn
          ? columnIndexes.map((item) => {
              const metadataType = metadataTypeByColumn?.get(normalizeColumnName(item.column))?.trim();
              return metadataType || exportColumnTypes?.[item.index] || null;
            })
          : undefined,
      columnExtras: exportColumnExtras?.some((extra) => !!extra) ? columnIndexes.map((item) => exportColumnExtras[item.index] ?? null) : undefined,
      ...(spatialColumns?.length ? { spatialColumns } : {}),
      ...(result.spatialValues?.length ? { spatialValues: result.spatialValues.map((row) => columnIndexes.map((item) => row[item.index] ?? null)) } : {}),
    };
    return (rows: CellValue[][]) => ({ ...captured, rows: rows.map((row) => columnIndexes.map((item) => row[item.index] ?? null)) });
  }

  function exportFileName(fallbackBaseName: string, extension: string, options: { page?: boolean; allResults?: boolean; preferFallback?: boolean } = {}): string {
    const rawBaseName = options.preferFallback ? fallbackBaseName : exportFileBaseName?.value || fallbackBaseName;
    return defaultDataGridExportFileName(rawBaseName, fallbackBaseName, extension, options);
  }

  return {
    copyText,
    copyCell,
    copyRow,
    copyRowCount,
    canCopyRow,
    copyAll,
    copyWithExtractor,
    copyWithPreference,
    previewWithExtractor,
    previewWithPreference,
    canCopyWithExtractor,
    exportWithExtractor,
    exportCsv,
    exportCurrentPageCsv,
    exportJson,
    exportCurrentPageJson,
    exportMarkdown,
    exportCurrentPageMarkdown,
    exportHtml,
    exportCurrentPageHtml,
    exportTxt,
    exportCurrentPageTxt,
    exportXlsx,
    openXlsx,
    openBrowser,
    exportXlsxWithSql,
    exportCurrentPageXlsx,
    exportCurrentPageXlsxWithSql,
    exportAllResultsXlsx,
    exportAllResultsXlsxWithSql,
    exportResultSheetsXlsx: (sheets: DataGridExportSheet[]) => exportResultSheetsXlsxResult(sheets, false),
    exportSql,
    exportCurrentPageSql,
    copySql,
  };
}

export function defaultDataGridExportFileName(baseName: string | undefined, fallbackBaseName: string, extension: string, options: { page?: boolean; allResults?: boolean } = {}): string {
  const sanitizedBaseName = sanitizeExportBaseName(baseName || "") || sanitizeExportBaseName(fallbackBaseName) || "export";
  const suffix = options.allResults ? "results" : options.page ? "page" : "";
  return [sanitizedBaseName, suffix, compactLocalTimestamp()].filter(Boolean).join("_") + `.${extension}`;
}

function buildMongoCopyInsertStatement(options: { collection: string; columns: string[]; sourceColumns?: Array<string | undefined>; rows: RowItem[]; mongoDocuments?: unknown[]; excludePrimaryKeys?: boolean; insertMode?: DataGridCopyInsertMode }): string | undefined {
  const saveColumns = effectiveColumns(options.sourceColumns, options.columns);
  const columnIndexes = saveColumns.map((column, index) => ({ column, index })).filter((item): item is { column: string; index: number } => !!item.column);
  if (columnIndexes.length === 0 || options.rows.length === 0) return undefined;
  const documentColumns = columnIndexes.map((item) => item.column);
  const documents = options.rows.map((item) => {
    const row = columnIndexes.map(({ index }) => item.data[index]) as MongoInputValue[];
    const dirtyColumns = columnIndexes.map(({ index }) => item.isDirtyCol[index] ?? false);
    const original = item.sourceIndex === undefined ? undefined : options.mongoDocuments?.[item.sourceIndex];
    return buildMongoCopyDocumentFromOriginal(original, row, documentColumns, dirtyColumns, { excludePrimaryKeys: options.excludePrimaryKeys }) ?? buildMongoCopyInsertDocument(row, documentColumns, { excludePrimaryKeys: options.excludePrimaryKeys });
  });
  const collection = `db.getCollection(${JSON.stringify(options.collection)})`;
  if (documents.length === 1) return `${collection}.insert(${formatMongoShellLiteral(documents[0])});`;
  if (options.insertMode === "row-by-row") {
    return documents.map((document) => `${collection}.insert(${formatMongoShellLiteral(document)});`).join("\n");
  }
  return `${collection}.insertMany(${formatMongoShellLiteral(documents)});`;
}

function formatMongoCopyStatement(statement: string | undefined): string | undefined {
  if (!statement) return undefined;
  try {
    return formatMongoShellText(statement);
  } catch {
    return statement;
  }
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function effectiveColumns(sourceColumns: Array<string | undefined> | undefined, columns: string[]): Array<string | undefined> {
  if (!sourceColumns || sourceColumns.length !== columns.length) return columns;
  return sourceColumns;
}

function isAutoGeneratedColumn(databaseType: DatabaseType | undefined, column: string, tableMeta: DataGridTableMeta | undefined): boolean {
  const columnInfo = findCopyColumnInfo(databaseType, column, tableMeta);
  const extra = columnInfo?.extra?.toLowerCase() ?? "";
  const defaultValue = columnInfo?.column_default?.toLowerCase() ?? "";
  return /\b(auto_increment|autoincrement|identity|smallserial|serial|bigserial)\b/.test(extra) || /\bnextval\s*\(/.test(defaultValue);
}

function isCopyInsertOmittedColumn(databaseType: DatabaseType | undefined, column: string, tableMeta: DataGridTableMeta | undefined, extractorOptions?: DataGridExtractorOptions, knownColumns: (string | undefined)[] = [column]): boolean {
  if (usesSyntheticRowIdKey(databaseType, [column])) return true;
  const columnInfo = findCopyColumnInfo(databaseType, column, tableMeta);
  const normalizedType = columnInfo?.data_type.trim().replace(/^"|"$/g, "").toLowerCase();
  if (databaseType === "postgres" && (normalizedType === "tsvector" || normalizedType?.endsWith(".tsvector"))) return true;
  // SQL Server 的 timestamp/rowversion 是服务端计数器（TDS 上即 binary(8)），永远不能显式插入；
  // 与 tsvector 同款无条件剔除（镜像 data_grid_sql 的 is_grid_insert_omitted_column）。
  const baseType = normalizedType?.split("(")[0]?.trim();
  if (databaseType === "sqlserver" && (baseType === "timestamp" || baseType === "rowversion")) return true;
  const extra = columnInfo?.extra?.toLowerCase() ?? "";
  const isAutoGenerated = isAutoGeneratedColumn(databaseType, column, tableMeta);
  // SQL Server 计算列的 extra 是裸字符串 "computed"（sys.columns），与其它方言的 generated 关键字同样受「跳过计算列」开关控制。
  const isComputed = (extra.includes("generated always as") || (databaseType === "sqlserver" && extra.trim() === "computed")) && !extra.includes("identity");
  const isPrimaryKey = isPrimaryKeyColumn(databaseType, column, tableMeta, knownColumns);
  return ((extractorOptions?.sql.skipGeneratedColumns ?? true) && isAutoGenerated && !isPrimaryKey) || ((extractorOptions?.sql.skipComputedColumns ?? true) && isComputed);
}

function findCopyColumnInfo(databaseType: DatabaseType | undefined, column: string, tableMeta: DataGridTableMeta | undefined): DataGridColumnInfo | undefined {
  const metadata = tableMeta?.columns ?? [];
  const exact = metadata.find((item) => item.name === column);
  if (exact) return exact;
  if (databaseType === "postgres" || databaseType === "redshift") return undefined;
  const matches = metadata.filter((item) => normalizeColumnName(item.name) === normalizeColumnName(column));
  return matches.length === 1 ? matches[0] : undefined;
}

function isPrimaryKeyColumn(databaseType: DatabaseType | undefined, column: string, tableMeta: DataGridTableMeta | undefined, knownColumns: (string | undefined)[]): boolean {
  const primaryKeys = tableMeta?.primaryKeys ?? [];
  if (primaryKeys.includes(column)) return true;

  const normalized = normalizeColumnName(column);
  const metadataMatches = (tableMeta?.columns ?? []).filter((item) => normalizeColumnName(item.name) === normalized);
  const exactMetadata = metadataMatches.find((item) => item.name === column);
  if (exactMetadata?.is_primary_key) return true;
  if (databaseType === "postgres" || databaseType === "redshift") return false;
  if (metadataMatches.length === 1) {
    return (metadataMatches[0].is_primary_key ?? false) || primaryKeys.filter((key) => normalizeColumnName(key) === normalized).length === 1;
  }
  if (metadataMatches.length > 1) return false;

  const visibleSpellings = new Set(knownColumns.filter((name): name is string => !!name && normalizeColumnName(name) === normalized));
  if (visibleSpellings.size > 1) return false;
  return primaryKeys.filter((key) => normalizeColumnName(key) === normalized).length === 1;
}

function normalizeColumnName(name: string): string {
  return name.toUpperCase();
}

function isSqlExportPrimaryKeyExcluded(databaseType: DatabaseType | undefined, column: string, columns: readonly (string | undefined)[], excludedPrimaryKeys: readonly string[]): boolean {
  if (excludedPrimaryKeys.includes(column)) return true;
  if (databaseType === "postgres" || databaseType === "redshift") return false;
  const normalized = normalizeColumnName(column);
  return columns.filter((name): name is string => !!name && normalizeColumnName(name) === normalized).length === 1 && excludedPrimaryKeys.filter((key) => normalizeColumnName(key) === normalized).length === 1;
}
