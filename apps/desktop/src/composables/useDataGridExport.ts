import { computed, type ComputedRef, type Ref, createApp } from "vue";
import { useI18n } from "vue-i18n";
import { useDataGridExtractor } from "@/composables/useDataGridExtractor";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { promptExportSavePath } from "@/lib/export/exportPath";
import { saveTextFile, sanitizeExportBaseName, compactLocalTimestamp } from "@/lib/export/saveTextFile";
import { notifyExportComplete } from "@/lib/export/exportReveal";
import { dropsSchemaQualifier } from "@/lib/table/tableSelectSql";
import * as api from "@/lib/backend/api";
import { type CellSelectionMatrix, type CellSelectionRange, type SelectionData } from "@/lib/dataGrid/gridSelection";
import { DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS, type DataGridCopyExtractorId, type DataGridExtractRequest, type DataGridExtractorOptions } from "@/lib/dataGrid/dataGridCopyExtractor";
import { useToast } from "@/composables/useToast";
import { useExportTracker } from "@/composables/useExportTracker";
import { clipboardCellValue, type CellValue } from "@/lib/dataGrid/cellValue";
import { binaryCellClipboardText } from "@/lib/dataGrid/binaryCellDownload";
import { tryStartExclusiveActivation, type ActionActivationGuard } from "@/lib/connection/actionActivation";
import { clipboardLineEndings, copyToClipboard } from "@/lib/common/clipboard";
import { clearDataGridClipboardCopy, rememberDataGridClipboardCopy } from "@/lib/dataGrid/dataGridClipboard";
import { buildDataGridCopyInsertStatement, type DataGridCopyInsertMode, type DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";
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
  fullExportResult?: (onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void) => Promise<QueryResult | undefined>;
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
  /**
   * The raw in-memory QueryResult to use for "export all" when
   * hasCompleteLocalResult is true. Exports the original query result (all
   * rows, all columns, committed values) so the output matches the original
   * re-run-SQL semantics — displayItems only covers visible columns and
   * reflects client-side filters/search and unsaved edits, which would
   * silently change what "export all data" produces.
   */
  completeLocalResult?: ComputedRef<QueryResult | undefined>;
  allExportResults?: ComputedRef<Array<{ sheetName: string; result: QueryResult; sql?: string }> | undefined>;
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
  const { t } = useI18n();
  const { toast } = useToast();
  const tracker = useExportTracker();
  const exportGuard: ActionActivationGuard = {};

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

  async function copyText(text: string, gridCopy?: { rows: readonly (readonly unknown[])[]; header?: readonly unknown[] }) {
    const copiedRows = gridCopy?.rows.map((row) => [...row]);
    const copiedHeader = gridCopy?.header ? [...gridCopy.header] : undefined;
    clearDataGridClipboardCopy();
    try {
      await copyToClipboard(text);
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

  function applyGlobalDateTimeExportFormat(result: { columns: string[]; columnTypes: string[]; rows: CellValue[][] }, enabled: boolean) {
    const pattern = enabled ? useSettingsStore().editorSettings.globalDateTimeExportFormat : "";
    return pattern ? { ...result, rows: formatTemporalRowsForExport(result.rows, result.columnTypes, pattern) } : result;
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
    const sourceColumns = preferAllColumns ? allColumns.value : columns.value;
    const sourceComments = preferAllColumns ? allXlsxColumnComments.value : visibleXlsxColumnComments.value;
    if (targetColumns.length === sourceColumns.length && targetColumns.every((column, index) => column === sourceColumns[index])) {
      return [...sourceComments];
    }

    const commentsByName = new Map<string, string>();
    sourceColumns.forEach((column, index) => {
      const comment = sourceComments[index];
      if (comment) commentsByName.set(column.toLocaleLowerCase(), comment);
    });
    for (const column of tableMeta.value?.columns ?? []) {
      if (column.comment && !commentsByName.has(column.name.toLocaleLowerCase())) {
        commentsByName.set(column.name.toLocaleLowerCase(), column.comment);
      }
    }
    return targetColumns.map((column) => commentsByName.get(column.toLocaleLowerCase()));
  }

  function showXlsxHeaderDialog(): Promise<XlsxExportOptions | null> {
    if (typeof document === "undefined") return Promise.resolve({ headerMode: "name", autoFilter: false });

    return new Promise((resolve) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const app = createApp(XlsxHeaderDialog, {
        open: true,
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

  function mongoDocumentRowsForJson(columnsToExport: string[], rows: CellValue[][], documents: unknown[] | undefined): CellValue[][] {
    if (databaseType.value !== "mongodb" || !documents || documents.length !== rows.length) return rows;
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

  function externalizeRows(rows: CellValue[][], columnIndexes?: number[]): CellValue[][] {
    if (columnIndexes) {
      return rows.map((row) => columnIndexes.map((colIdx) => (options.externalCellValue ? options.externalCellValue(row[colIdx], colIdx) : row[colIdx])));
    }
    if (!options.externalCellValue) return rows;
    return rows.map((row) => row.map((value, columnIndex) => options.externalCellValue!(value, columnIndex)));
  }

  async function resultToExport(
    target?: ExportTargetParam,
    onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void,
    useFullExport = true,
    formatDateTime = true,
    headerMode: XlsxHeaderMode = "name",
    preserveMongoExtendedJson = false,
    columnIndexesParam?: number[],
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
      const result = await fullExportResult(onProgress);
      if (result) {
        const projected = databaseType.value === "mongodb" || hasColumnSubset ? projectResultColumns(result, targetColumns, projectionSourceIndexes) : undefined;
        const exportedColumns = projected?.columns ?? result.columns;
        const exportedColumnTypes = projected?.columnTypes ?? result.column_types ?? [];
        const exportedRows = projected?.rows ?? result.rows;
        const exportedSpatialColumns = projected?.spatialColumns ?? result.spatial_columns;
        const exportedSpatialValues = projected?.spatialValues ?? result.spatial_values;
        const columnComments = buildXlsxHeaderOverrides(exportedColumns, commentsForExportColumns(exportedColumns), headerMode);
        return {
          ...applyGlobalDateTimeExportFormat(
            // fullExportResult returns source rows, not the collection grid's
            // marker-encoded rows. Applying externalCellValue here would
            // mistake a real BSON string in the reserved namespace for a grid
            // marker and corrupt the exported value.
            { columns: exportedColumns, columnTypes: exportedColumnTypes, rows: preserveMongoExtendedJson ? mongoDocumentRowsForJson(exportedColumns, exportedRows, result.mongo_copy_documents) : exportedRows },
            formatDateTime && !preserveMongoExtendedJson,
          ),
          columnComments,
          spatialColumns: exportedSpatialColumns,
          spatialValues: exportedSpatialValues,
        };
      }
    }
    // The full result is already in memory — export all rows with the source
    // result's committed values. MongoDB applies the current visible-column
    // projection above; other result types retain their existing all-column
    // semantics. displayItems only covers visible columns and reflects
    // client-side filters/search and unsaved edits, which would silently
    // change what the export contains.
    if (useFullExport && rowIds === undefined && hasCompleteLocalResult?.value && completeLocalResult?.value) {
      const normalized = hasColumnSubset || databaseType.value === "mongodb" ? normalizeCompleteLocalResult(completeLocalResult.value, targetColumns, projectionSourceIndexes) : normalizeCompleteLocalResult(completeLocalResult.value);
      const columnComments = buildXlsxHeaderOverrides(normalized.columns, normalized.columnComments, headerMode);
      return {
        ...applyGlobalDateTimeExportFormat(
          { columns: normalized.columns, columnTypes: normalized.columnTypes, rows: preserveMongoExtendedJson ? mongoDocumentRowsForJson(normalized.columns, normalized.rows, normalized.mongoCopyDocuments) : externalizeRows(normalized.rows) },
          formatDateTime && !preserveMongoExtendedJson,
        ),
        columnComments,
        spatialColumns: normalized.spatialColumns,
        spatialValues: normalized.spatialValues,
      };
    }
    const targetComments = commentsForExportColumns(targetColumns, false);
    const commentHeader = buildXlsxHeaderOverrides(targetColumns, targetComments, headerMode);
    const exportItems = await resolveVisibleRowValues(rowsToExport(rowIds));
    const visibleIndexes = visibleColumnIndexesOption?.value ?? columns.value.map((_, index) => index);
    const targetSourceIndexes = validColumnIndexes.map((targetIdx) => visibleIndexes[targetIdx] ?? targetIdx);
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
                ),
        },
        formatDateTime && !preserveMongoExtendedJson,
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

  async function writeXlsxResult(outputPath: string, result: { columns: string[]; columnTypes: string[]; columnComments?: (string | null)[]; rows: CellValue[][] }, includeSqlSheet: boolean, autoFilter: boolean, sqlOverride?: string, headerCommentRows = false) {
    const effectiveSql = sqlOverride ?? currentExportSql();
    const sqlWorksheet = includeSqlSheet ? buildXlsxSqlWorksheet([{ sql: effectiveSql || "" }]) : undefined;
    const rightAlign = useSettingsStore().editorSettings.numericColumnRightAlign;
    // The rows are already rendered with the global export pattern, but the
    // workbook still needs the pattern itself so its numFmt matches; without it
    // a `SSS` pattern silently displays as `yyyy-mm-dd hh:mm:ss`.
    const dateTimeFormat = useSettingsStore().editorSettings.globalDateTimeExportFormat || undefined;
    if (!sqlWorksheet) {
      await api.exportQueryResultXlsx(outputPath, currentXlsxSheetName(), result.columns, result.columnTypes, result.columnComments, result.rows, rightAlign, autoFilter, dateTimeFormat, headerCommentRows);
      return;
    }
    await api.exportQueryResultsXlsx(
      outputPath,
      [
        {
          sheetName: currentXlsxSheetName(),
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

  async function buildCopyInsertStatement(data: CopyInsertData, excludePrimaryKeys: boolean, insertMode: DataGridCopyInsertMode): Promise<string | undefined> {
    if (databaseType.value === "mongodb") {
      return formatMongoCopyStatement(
        buildMongoCopyInsertStatement({
          collection: copyInsertTargetLabel?.value || tableMeta.value?.tableName || "collection",
          columns: data.columns,
          sourceColumns: data.sourceColumns,
          rows: data.rows,
          mongoDocuments: options.mongoDocuments?.value,
          excludePrimaryKeys,
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
      excludePrimaryKeys,
      insertMode,
    });
  }

  function binaryClipboardCellValue(value: CellValue, columnIndex: number): CellValue {
    return binaryCellClipboardText(value, columnTypes.value?.[columnIndex], databaseType.value) ?? value;
  }

  function externalCellValue(value: CellValue, columnIndex: number): CellValue {
    const externalValue = options.externalCellValue?.(value, columnIndex);
    return externalValue === undefined ? value : externalValue;
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
    if (!contextCell.value || contextCell.value.col < 0) return;
    const item = getRowItem(contextCell.value.rowId);
    if (!item || item.isDraft) return;
    const sourceIndex = visibleColumnIndexes.value[contextCell.value.col] ?? contextCell.value.col;
    const [resolvedItem] = await resolveVisibleRowValues([item], [sourceIndex]);
    const val = resolvedItem?.data[contextCell.value.col] ?? null;
    // 外部剪贴板呈现文本型 MySQL VARBINARY（NULL 也按空串输出）；内部网格副本仍保留原 hex，保证回粘无损。
    const rawValue = options.cellClipboardText?.(val, sourceIndex) ?? clipboardCellValue(binaryClipboardCellValue(val, contextCell.value.col));
    const copyValue = options.databaseType.value === "oracle" && isTemporalColumnType(options.columnTypes.value?.[contextCell.value.col]) ? (options.displayValue?.(val, sourceIndex) ?? rawValue) : rawValue;
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

  function insertableCopyColumnCount(excludePrimaryKeys: boolean, copyColumns = effectiveColumns(sourceColumns.value, columns.value), extractorOptions?: DataGridExtractorOptions): number {
    const primaryKeySet = new Set((tableMeta.value?.primaryKeys ?? []).map(normalizeColumnName));
    return copyColumns.filter((column): column is string => !!column && !isCopyInsertOmittedColumn(databaseType.value, column, tableMeta.value, extractorOptions) && (!excludePrimaryKeys || !primaryKeySet.has(normalizeColumnName(column)) || !isAutoGeneratedColumn(column, tableMeta.value))).length;
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
    return buildCopyInsertStatement(rowLimit === undefined ? data : { ...data, rows: data.rows.slice(0, rowLimit) }, extractorOptions.sql.excludePrimaryKeysFromInsert, extractorOptions.sql.insertMode);
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
    columns,
    displayItems,
    allColumns,
    allDisplayItems,
    allSourceColumns,
    visibleColumnIndexes,
    columnTypes,
    extractorOptions: extractorOptionsOption,
    databaseType,
    identifierQuote,
    tableMeta,
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
      return request.rows.length > 0 && insertableCopyColumnCount(request.options.sql.excludePrimaryKeysFromInsert, selectedColumns, request.options) > 0;
    },
    buildMongoInsert: buildMongoExtractorInsert,
    buildMongoUpdate: buildMongoExtractorUpdate,
    canBuildMongoUpdate: canBuildMongoExtractorUpdate,
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
    await copyText(formatTsv(columns.value, decodedRows), { rows, header: columns.value });
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
    try {
      await action();
    } finally {
      finish();
    }
  }

  async function exportWithExtractor(extractor: DataGridCopyExtractorId, extractorOptions: DataGridExtractorOptions = extractorOptionsOption?.value ?? DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS): Promise<boolean> {
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

  async function exportCsv(target?: ExportTargetParam, columnIndexesParam?: number[]) {
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
    await runExclusiveExport(async () => {
      try {
        if (await exportQueryResultViaBackend("csv", rowIds, false, "name", true, undefined, false, columnIndexes)) return;
        if (await exportFullTableDataViaBackend("csv", rowIds, "name", true, undefined, false, columnIndexes)) return;

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

  async function exportCurrentPageCsv(columnIndexes?: number[]) {
    await runExclusiveExport(async () => {
      try {
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
        if (await exportFullTableDataViaBackend("json", rowIds, "name", true, undefined, false, columnIndexes)) return;
        if (await exportQueryResultViaBackend("json", rowIds, false, "name", true, undefined, false, columnIndexes)) return;

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
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
    await runExclusiveExport(async () => {
      try {
        if (await exportFullTableDataViaBackend("markdown", rowIds, "name", true, undefined, false, columnIndexes)) return;

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
    await runExclusiveExport(async () => {
      try {
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
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
    await runExclusiveExport(async () => {
      try {
        if (await exportQueryResultViaBackend("txt", rowIds, false, "name", true, undefined, false, columnIndexes)) return;
        if (await exportFullTableDataViaBackend("txt", rowIds, "name", true, undefined, false, columnIndexes)) return;
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
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
    await runExclusiveExport(async () => {
      try {
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
    await runExclusiveExport(async () => {
      try {
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
    await runExclusiveExport(async () => {
      try {
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
    const exportOptions = await showXlsxHeaderDialog();
    if (exportOptions === null) return;

    await runExclusiveExport(async () => {
      try {
        if (await exportQueryResultViaBackend("xlsx", rowIds, includeSqlSheet, exportOptions.headerMode, exportOptions.autoFilter, undefined, openAfterExport, columnIndexes)) return;
        if (await exportFullTableDataViaBackend("xlsx", rowIds, exportOptions.headerMode, exportOptions.autoFilter, undefined, openAfterExport, columnIndexes)) return;

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
    const exportOptions = await showXlsxHeaderDialog();
    if (exportOptions === null) return;

    await runExclusiveExport(async () => {
      try {
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

  async function exportResultSheetsXlsxResult(sheetsToExport: Array<{ sheetName: string; result: QueryResult; sql?: string }> | undefined, includeSqlSheet: boolean) {
    const exportOptions = await showXlsxHeaderDialog();
    if (exportOptions === null) return;

    await runExclusiveExport(async () => {
      try {
        const sheets = (sheetsToExport ?? allExportResults?.value ?? []).filter((sheet) => sheet.result.columns.length > 0);
        if (sheets.length === 0) return;

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
        const worksheets = sheets.map((sheet) => ({
          sheetName: sheet.sheetName,
          columns: sheet.result.columns,
          columnTypes: sheet.result.column_types ?? [],
          columnComments: buildXlsxHeaderOverrides(sheet.result.columns, commentsForExportColumns(sheet.result.columns), exportOptions.headerMode),
          rows: formatTemporalRowsForExport(sheet.result.rows, sheet.result.column_types ?? [], exportPattern),
          numericColumnRightAlign: rightAlign,
          autoFilter: exportOptions.autoFilter,
          headerCommentRows: xlsxHeaderUsesCommentRows(exportOptions.headerMode),
        }));
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

  /**
   * SQL 导出需要排除的主键列：跟随数据提取设置里的“排除主键”，与
   * copy-as-INSERT (e3d5d1418) 一致只剔除自增/identity 主键，手动赋值的
   * 主键保留，否则回放 INSERT 会缺值；只有拿得到表元数据时才生效。
   */
  function sqlExportExcludedColumns(): string[] | undefined {
    if (!extractorOptionsOption?.value?.sql.excludePrimaryKeysFromInsert) return undefined;
    const primaryKeys = tableMeta.value?.primaryKeys ?? [];
    const autoGenerated = primaryKeys.filter((column) => isAutoGeneratedColumn(column, tableMeta.value));
    return autoGenerated.length > 0 ? autoGenerated : undefined;
  }

  /**
   * 导出列对应的原表 EXTRA 元数据（SQL Server/Dameng 的 identity 等）。后端据此
   * 给导出的 INSERT 包上 `SET IDENTITY_INSERT`，否则回放时报 SQL Server 544。
   * 拿不到表元数据时返回 undefined，后端保持“未知”语义，不额外查一次元数据。
   */
  function sqlExportColumnExtras(columnNames: string[]): Array<string | null> | undefined {
    const metaColumns = tableMeta.value?.columns;
    if (!metaColumns?.length) return undefined;
    const extras = columnNames.map((column) => metaColumns.find((meta) => normalizeColumnName(meta.name) === normalizeColumnName(column))?.extra ?? null);
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

  /** 供导出请求使用：把“不含主键”设置转换成后端请求字段。 */
  function sqlExportPrimaryKeyOptions(): { excludePrimaryKeys?: boolean; primaryKeys?: string[] } {
    const excludeColumns = sqlExportExcludedColumns();
    return excludeColumns ? { excludePrimaryKeys: true, primaryKeys: excludeColumns } : {};
  }

  async function exportFullTableDataViaBackend(format: "csv" | "xlsx" | "json" | "markdown" | "sql" | "txt", rowIds?: number[], headerMode: XlsxHeaderMode = "name", autoFilter = true, sqlExportOptions?: SqlExportOptions, openAfterExport = false, columnIndexes?: number[]): Promise<boolean> {
    const meta = tableMeta.value;
    // The backend table exporter currently builds two-part table names. External
    // Doris/StarRocks catalogs need the data-tab paginator's three-part SQL.
    if (rowIds !== undefined || columnIndexes !== undefined || context.value !== "table-data" || !meta || meta.catalog || !connectionId.value || !database.value) {
      return false;
    }

    const fmt = FORMAT_META[format];
    const splitSqlOutput = format === "sql" && sqlExportOptions?.splitMaxMb !== undefined;
    const extension = splitSqlOutput ? "zip" : (fmt?.ext ?? format);
    const filterName = splitSqlOutput ? "ZIP" : (fmt?.label ?? format.toUpperCase());
    let outputPath = exportFileName(meta.tableName || "export", extension, { preferFallback: true });
    if (openAfterExport && isTauriRuntime()) {
      outputPath = await api.createQueryResultTempFile(extension);
    } else if (isTauriRuntime()) {
      const path = await promptExportSavePath({
        defaultFileName: outputPath,
        filters: [{ name: filterName, extensions: [extension] }],
        preferredPath: useSettingsStore().editorSettings.preferredExportPath,
      });
      if (!path) return true;
      outputPath = path;
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
        filePath: outputPath,
        startedAt: Date.now(),
        finishedAt: undefined,
      };
    }
    if (exportProgressDialog) exportProgressDialog.value = true;
    if (exportCanMinimize) exportCanMinimize.value = true;

    const task = tracker.addTask(meta.tableName, format, outputPath);
    const exportId = task.exportId;
    if (exportCancelHandler) {
      exportCancelHandler.value = () => api.cancelTableExport(exportId);
    }
    tracker.registerTaskCancelHandler(exportId, () => api.cancelTableExport(exportId));
    const editorSettings = useSettingsStore().editorSettings;
    const rowLimit = editorSettings.exportRowLimitEnabled ? editorSettings.exportRowLimit : null;

    try {
      const progress = await api.startTableExport(
        {
          exportId,
          connectionId: connectionId.value,
          database: database.value,
          schema: meta.schema,
          identifierQuote: options.identifierQuote?.value,
          tableName: meta.tableName,
          filePath: outputPath,
          format,
          ...(format === "sql" && sqlExportOptions
            ? {
                insertMode: sqlExportOptions.insertMode,
                splitMaxMb: sqlExportOptions.splitMaxMb,
                selectedColumns: sqlExportOptions.selectedColumns,
                omitDatabaseQualifier: dropsSchemaQualifier(databaseType.value, options.includeDatabaseName?.value, meta.catalog),
              }
            : {}),
          csvQuoteMode: editorSettings.csvQuoteMode,
          nullLiteral: csvNullLiteralForMode(editorSettings.csvNullMode),
          columns: format === "sql" ? effectiveColumns(sourceColumns.value, columns.value).map((column, index) => column ?? columns.value[index]!) : columns.value,
          columnTypes: columnTypes.value,
          ...(format === "sql" ? { columnExtras: sqlExportColumnExtras(effectiveColumns(sourceColumns.value, columns.value).map((column, index) => column ?? columns.value[index]!)) } : {}),
          columnComments: format === "xlsx" ? buildXlsxHeaderOverrides(columns.value, visibleXlsxColumnComments.value, headerMode) : undefined,
          headerCommentRows: format === "xlsx" ? xlsxHeaderUsesCommentRows(headerMode) : undefined,
          primaryKeys: meta.primaryKeys,
          ...sqlExportPrimaryKeyOptions(),
          whereInput: whereInput.value,
          orderBy: orderBy.value,
          skipCount: false,
          batchSize: exportBatchSize.value,
          rowLimit,
          dateTimeFormat: editorSettings.globalDateTimeExportFormat || undefined,
          numericColumnRightAlign: editorSettings.numericColumnRightAlign ?? true,
          autoFilter: format === "xlsx" ? autoFilter : undefined,
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
              finishedAt: progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled" ? Date.now() : exportProgressState.value.finishedAt,
            };
          }
          tracker.updateTableExportTask(exportId, progress);
        },
      );
      if (progress.status === "Done") {
        notifyExportSuccess(openAfterExport ? undefined : outputPath);
        if (openAfterExport && isTauriRuntime()) await api.openQueryResultTempFile(outputPath);
      }
    } finally {
      if (exportCancelHandler) exportCancelHandler.value = null;
      tracker.unregisterTaskCancelHandler(exportId);
      if (exportCanMinimize) exportCanMinimize.value = false;
    }
    return true;
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
  ): Promise<boolean> {
    if (rowIds !== undefined || columnIndexes !== undefined || context.value !== "results" || !queryResultExportRequest) {
      return false;
    }
    if (databaseType.value === "mongodb") return false;
    // The full result is already in memory — don't re-execute the query on the
    // backend just to stream the same rows back to a file.
    if (hasCompleteLocalResult?.value) return false;

    const fmt = FORMAT_META[format];
    const extension = fmt?.ext ?? format;
    const filterName = fmt?.label ?? format.toUpperCase();
    let outputPath = exportFileName("query-result", extension);
    if (isTauriRuntime()) {
      if (openAfterExport) outputPath = await api.createQueryResultTempFile(extension);
      else {
        const path = await promptExportSavePath({
          defaultFileName: outputPath,
          filters: [{ name: filterName, extensions: [extension] }],
          preferredPath: useSettingsStore().editorSettings.preferredExportPath,
        });
        if (!path) return true;
        outputPath = path;
      }
    }

    const exportId = uuid();
    const insertTarget = format === "sql" ? sqlInsertTargetMeta() : undefined;
    const baseRequest = await queryResultExportRequest({
      exportId,
      filePath: outputPath,
      format,
      includeSqlSheet,
      exportTableName: insertTarget?.tableName,
      exportSchema: insertTarget?.tableName ? sqlInsertTargetSchema(insertTarget) : undefined,
      exportColumnTypes: format === "sql" || format === "xlsx" ? allColumnTypes.value?.map((type) => type ?? null) : undefined,
      exportColumnExtras: format === "sql" ? sqlExportColumnExtras(allColumns.value) : undefined,
      ...(format === "sql" && sqlExportOptions ? { insertMode: sqlExportOptions.insertMode } : {}),
    });
    const columnComments = format === "xlsx" ? buildXlsxHeaderOverrides(allColumns.value, allXlsxColumnComments.value, headerMode) : undefined;
    const headerCommentRows = format === "xlsx" && xlsxHeaderUsesCommentRows(headerMode);
    const request = baseRequest
      ? {
          ...baseRequest,
          ...(format === "sql" ? { selectedColumns: sqlExportOptions?.selectedColumns } : {}),
          csvQuoteMode: useSettingsStore().editorSettings.csvQuoteMode,
          nullLiteral: csvNullLiteralForMode(useSettingsStore().editorSettings.csvNullMode),
          ...sqlExportPrimaryKeyOptions(),
          dateTimeFormat: useSettingsStore().editorSettings.globalDateTimeExportFormat || undefined,
          numericColumnRightAlign: useSettingsStore().editorSettings.numericColumnRightAlign ?? true,
          columnComments,
          headerCommentRows,
          autoFilter: format === "xlsx" ? autoFilter : undefined,
        }
      : undefined;
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
        filePath: outputPath,
        startedAt: Date.now(),
        finishedAt: undefined,
      };
    }
    if (exportProgressDialog) exportProgressDialog.value = true;
    if (exportCanMinimize) exportCanMinimize.value = true;
    tracker.addTask("Query Result", format, outputPath, exportId);
    if (exportCancelHandler) {
      exportCancelHandler.value = () => api.cancelQueryResultExport(exportId, request.executionId);
    }
    tracker.registerTaskCancelHandler(exportId, () => api.cancelQueryResultExport(exportId, request.executionId));

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
            finishedAt: progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled" ? Date.now() : exportProgressState.value.finishedAt,
          };
        }
        tracker.updateTableExportTask(exportId, progress);
      });
      if (terminalProgress.status === "Done") {
        notifyExportSuccess(openAfterExport ? undefined : outputPath);
        if (openAfterExport && isTauriRuntime()) {
          await api.openQueryResultTempFile(outputPath);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (exportProgressState) {
        exportProgressState.value = {
          ...exportProgressState.value,
          status: "Error",
          errorMessage,
          finishedAt: Date.now(),
        };
      }
      tracker.updateTableExportTask(exportId, {
        exportId,
        tableName: "Query Result",
        rowsExported: exportProgressState?.value.rowsExported ?? 0,
        totalRows: exportProgressState?.value.totalRows ?? null,
        status: "Error",
        errorMessage,
      });
      throw error;
    } finally {
      if (exportCancelHandler) exportCancelHandler.value = null;
      tracker.unregisterTaskCancelHandler(exportId);
      if (exportCanMinimize) exportCanMinimize.value = false;
    }
    return true;
  }

  async function exportQueryResultSqlViaBackend(rowIds: number[] | undefined, sqlExportOptions: SqlExportOptions, columnIndexes?: number[]): Promise<boolean> {
    if (!isTauriRuntime() || columnIndexes !== undefined) return false;
    return exportQueryResultViaBackend("sql", rowIds, false, "name", true, sqlExportOptions, false, columnIndexes);
  }

  function sqlExportChoices(fullResult: boolean, columnSubset?: readonly string[]): SqlExportColumnSelection[] {
    const names = columnSubset ?? (context.value === "table-data" ? effectiveColumns(sourceColumns.value, columns.value) : fullResult ? allColumns.value : columns.value);
    const excluded = new Set((sqlExportExcludedColumns() ?? []).map(normalizeColumnName));
    const types = fullResult && context.value === "results" ? allColumnTypes.value : columnTypes.value;
    // A subset's sourceIndex is its position within the subset; resolve the
    // metadata-less type fallback by name against the typed column list.
    const typeNames = fullResult && context.value === "results" ? allColumns.value : context.value === "table-data" ? effectiveColumns(sourceColumns.value, columns.value) : columns.value;
    const typeByName = columnSubset ? new Map(typeNames.map((name, index) => [name, types?.[index]])) : undefined;
    const metadataByName = new Map((tableMeta.value?.columns ?? []).map((column) => [normalizeColumnName(column.name), column]));
    return sqlExportColumnChoices(names).filter((column) => {
      if (excluded.has(normalizeColumnName(column.name)) || usesSyntheticRowIdKey(databaseType.value, [column.name])) return false;
      const metadata = metadataByName.get(normalizeColumnName(column.name));
      if (databaseType.value === "mysql" && /\b(?:virtual|stored|persistent)\s+generated\b|\bgenerated\s+always\s+as\s*\(/i.test(metadata?.extra ?? "")) return false;
      const columnType = (metadata?.data_type || (columnSubset ? typeByName?.get(column.name) : types?.[column.sourceIndex]))?.trim().replace(/^"|"$/g, "").toLowerCase();
      return databaseType.value !== "postgres" || (columnType !== "tsvector" && !columnType?.endsWith(".tsvector"));
    });
  }

  async function exportSql(target?: ExportTargetParam, columnIndexesParam?: number[]) {
    const { rowIds, columnIndexes } = normalizeExportTarget(target, columnIndexesParam);
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
      })) as SqlExportOptions | SqlInsertMode | null;
      if (selectedSqlExportOptions === null) {
        logExportStage("cancelled", { stage: "insert-mode-dialog" });
        return;
      }
      const sqlExportOptions: SqlExportOptions = typeof selectedSqlExportOptions === "string" ? { insertMode: selectedSqlExportOptions } : selectedSqlExportOptions;
      const insertMode = sqlExportOptions.insertMode;
      logExportStage("mode-selected", { insertMode, splitMaxMb: sqlExportOptions.splitMaxMb });
      try {
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
          excludeColumns: sqlExportExcludedColumns(),
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
    await runExclusiveExport(async () => {
      const chosenColumns = columnIndexes !== undefined ? columnIndexes.map((i) => columns.value[i]).filter((c): c is string => !!c) : undefined;
      const selectedSqlExportOptions = (await showSqlInsertModeDialog({ columns: sqlExportChoices(false, chosenColumns) })) as SqlExportOptions | SqlInsertMode | null;
      if (selectedSqlExportOptions === null) return;
      const sqlExportOptions: SqlExportOptions = typeof selectedSqlExportOptions === "string" ? { insertMode: selectedSqlExportOptions } : selectedSqlExportOptions;
      const insertMode = sqlExportOptions.insertMode;
      try {
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
          excludeColumns: sqlExportExcludedColumns(),
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

  function sqlInsertExportData(
    result: { columns: string[]; columnTypes?: Array<string | undefined>; rows: CellValue[][]; spatialColumns?: QueryResult["spatial_columns"]; spatialValues?: QueryResult["spatial_values"] },
    selectedColumns?: SqlExportColumnSelection[],
  ): {
    columns: string[];
    columnTypes?: Array<string | null | undefined>;
    columnExtras?: Array<string | null>;
    spatialColumns?: QueryResult["spatial_columns"];
    spatialValues?: QueryResult["spatial_values"];
    rows: CellValue[][];
  } {
    const matchesVisibleColumns = result.columns.length === columns.value.length && result.columns.every((column, index) => column === columns.value[index]);
    const exportColumns = context.value === "table-data" && tableMeta.value && matchesVisibleColumns ? effectiveColumns(sourceColumns.value, result.columns) : result.columns;
    const columnIndexes = resolveSqlExportColumnIndexes(exportColumns, selectedColumns)
      .map((index) => ({ column: exportColumns[index], index }))
      .filter((item): item is { column: string; index: number } => !!item.column);
    const exportColumnTypes = matchesVisibleColumns && columnTypes.value?.length === result.columns.length ? columnTypes.value : result.columnTypes?.length === result.columns.length ? result.columnTypes : undefined;
    const metaColumns = tableMeta.value?.columns;
    const exportColumnExtras = metaColumns?.length ? exportColumns.map((column) => (column ? (metaColumns.find((meta) => normalizeColumnName(meta.name) === normalizeColumnName(column))?.extra ?? null) : null)) : undefined;
    // SQL Server 的结果集列类型来自 TDS：rowversion 会报成 varbinary/binary，据此无法识别不可插入列；
    // 表元数据（sys.columns）里才是 "timestamp"。与数据库级导出链同口径，SQL Server 的 INSERT 载荷
    // 优先用表元数据类型、缺元数据时回退结果集类型（其它引擎维持结果集类型优先）。
    const metadataTypeByColumn = databaseType.value === "sqlserver" && metaColumns?.length ? new Map(metaColumns.map((meta) => [normalizeColumnName(meta.name), meta.data_type])) : undefined;
    const indexBySource = new Map(columnIndexes.map((item, index) => [item.index, index]));
    const spatialColumns = result.spatialColumns?.flatMap((column) => {
      const columnIndex = indexBySource.get(column.column_index);
      return columnIndex === undefined ? [] : [{ column_index: columnIndex, srid: column.srid }];
    });
    return {
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
    exportResultSheetsXlsx: (sheets: Array<{ sheetName: string; result: QueryResult; sql?: string }>) => exportResultSheetsXlsxResult(sheets, false),
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

function isAutoGeneratedColumn(column: string, tableMeta: DataGridTableMeta | undefined): boolean {
  const columnInfo = tableMeta?.columns?.find((item) => normalizeColumnName(item.name) === normalizeColumnName(column));
  const extra = columnInfo?.extra?.toLowerCase() ?? "";
  const defaultValue = columnInfo?.column_default?.toLowerCase() ?? "";
  return /\b(auto_increment|autoincrement|identity|smallserial|serial|bigserial)\b/.test(extra) || /\bnextval\s*\(/.test(defaultValue);
}

function isCopyInsertOmittedColumn(databaseType: DatabaseType | undefined, column: string, tableMeta: DataGridTableMeta | undefined, extractorOptions?: DataGridExtractorOptions): boolean {
  if (usesSyntheticRowIdKey(databaseType, [column])) return true;
  const columnInfo = tableMeta?.columns?.find((item) => normalizeColumnName(item.name) === normalizeColumnName(column));
  const normalizedType = columnInfo?.data_type.trim().replace(/^"|"$/g, "").toLowerCase();
  if (databaseType === "postgres" && (normalizedType === "tsvector" || normalizedType?.endsWith(".tsvector"))) return true;
  // SQL Server 的 timestamp/rowversion 是服务端计数器（TDS 上即 binary(8)），永远不能显式插入；
  // 与 tsvector 同款无条件剔除（镜像 data_grid_sql 的 is_grid_insert_omitted_column）。
  const baseType = normalizedType?.split("(")[0]?.trim();
  if (databaseType === "sqlserver" && (baseType === "timestamp" || baseType === "rowversion")) return true;
  const extra = columnInfo?.extra?.toLowerCase() ?? "";
  const isAutoGenerated = isAutoGeneratedColumn(column, tableMeta);
  // SQL Server 计算列的 extra 是裸字符串 "computed"（sys.columns），与其它方言的 generated 关键字同样受「跳过计算列」开关控制。
  const isComputed = (extra.includes("generated always as") || (databaseType === "sqlserver" && extra.trim() === "computed")) && !extra.includes("identity");
  const isPrimaryKey = (tableMeta?.primaryKeys ?? []).some((key) => normalizeColumnName(key) === normalizeColumnName(column));
  return ((extractorOptions?.sql.skipGeneratedColumns ?? true) && isAutoGenerated && !isPrimaryKey) || ((extractorOptions?.sql.skipComputedColumns ?? true) && isComputed);
}

function normalizeColumnName(name: string): string {
  return name.toUpperCase();
}
