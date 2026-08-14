import { computed, type ComputedRef, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { useToast } from "@/composables/useToast";
import { dedupeColumnIndexes, type CellSelectionMatrix, type SelectionData } from "@/lib/dataGrid/gridSelection";
import {
  DATA_GRID_COPY_EXTRACTOR_DESCRIPTORS,
  DATA_GRID_EXTRACTOR_CONTRACT_VERSION,
  DATA_GRID_EXTRACTOR_PREVIEW_MAX_ROWS,
  DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS,
  extractorUnavailableForDatabase,
  normalizeDataGridExtractorOptions,
  resolveDataGridCopyPreference,
  type DataGridCopyExtractorId,
  type DataGridCopyPreference,
  type DataGridExtractPreview,
  type DataGridExtractRequest,
  type DataGridExtractorOptions,
  type DataGridExtractWarningCode,
} from "@/lib/dataGrid/dataGridCopyExtractor";
import type { DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";
import { formatError } from "@/lib/backend/errorUtils";
import type { DatabaseType } from "@/types/database";

interface ExtractorRowItem {
  id: number;
  data: SelectionData["rows"][number];
  isDraft?: boolean;
}

interface UseDataGridExtractorOptions {
  columns: ComputedRef<string[]>;
  displayItems: ComputedRef<ExtractorRowItem[]>;
  allColumns: ComputedRef<string[]>;
  allDisplayItems: ComputedRef<ExtractorRowItem[]>;
  allSourceColumns: ComputedRef<Array<string | undefined> | undefined>;
  visibleColumnIndexes: ComputedRef<number[]>;
  columnTypes: ComputedRef<Array<string | undefined> | undefined>;
  extractorOptions?: ComputedRef<DataGridExtractorOptions>;
  databaseType: ComputedRef<DatabaseType | undefined>;
  identifierQuote?: ComputedRef<string | undefined>;
  tableMeta: ComputedRef<DataGridTableMeta | undefined>;
  hasCellSelection: ComputedRef<boolean>;
  selectedCells: ComputedRef<SelectionData>;
  selectedCellMatrix: ComputedRef<CellSelectionMatrix | null>;
  hasRowSelection: ComputedRef<boolean>;
  hasColumnSelection: ComputedRef<boolean>;
  selectedRowIds: Ref<Set<number>> | ComputedRef<Set<number>>;
  resolveSourceValues?: (rowIds: number[], sourceColumnIndexes: number[]) => Promise<Map<number, Map<number, unknown>>>;
  contextCell: ComputedRef<{ rowId: number; rowIndex: number; col: number } | null> | Ref<{ rowId: number; rowIndex: number; col: number } | null>;
  contextSelectionIsSynthetic: ComputedRef<boolean> | Ref<boolean>;
  copyText: (text: string, gridCopy?: { rows: readonly (readonly unknown[])[]; header?: readonly unknown[] }) => Promise<boolean>;
  canCopySqlInsert: (request: DataGridExtractRequest) => boolean;
  buildMongoInsert: (extractorOptions: DataGridExtractorOptions, rowLimit?: number) => Promise<string | undefined>;
  buildMongoUpdate?: (request: DataGridExtractRequest, rowLimit?: number) => Promise<string | undefined>;
  canBuildMongoUpdate?: (request: DataGridExtractRequest) => boolean;
}

export function useDataGridExtractor(options: UseDataGridExtractorOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const hasUnsupportedDiscreteSelection = computed(() => options.hasCellSelection.value && options.selectedCellMatrix.value === null);
  const requestSources = new WeakMap<DataGridExtractRequest, { rowIds: number[]; sourceColumnIndexes: number[]; columnTypes: Array<string | undefined>; normalizeValues: boolean }>();

  function normalizeCellValue(value: unknown, columnType: string | undefined): unknown {
    if (typeof value !== "string" || columnType?.trim().toLowerCase() !== "json") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  function selectionData(): SelectionData | null {
    if (options.hasRowSelection.value && options.selectedRowIds.value.size > 0) {
      const rows = options.displayItems.value.filter((item) => options.selectedRowIds.value.has(item.id) && !item.isDraft).map((item) => item.data);
      return rows.length > 0 ? { columns: options.columns.value, rows } : null;
    }
    return options.hasCellSelection.value ? options.selectedCells.value : null;
  }

  function buildRequest(extractor: DataGridCopyExtractorId, extractorOptions: DataGridExtractorOptions = options.extractorOptions?.value ?? DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS): DataGridExtractRequest | null {
    const visibleIndexes = options.visibleColumnIndexes.value;
    const sourceNames = options.allSourceColumns.value;
    const fullColumns = options.allColumns.value;
    const fullItemsById = new Map(options.allDisplayItems.value.map((item) => [item.id, item]));
    let sourceRows: unknown[][] = [];
    let sourceRowIds: number[] = [];
    let selectedSourceIndexes: number[] = [];
    let selectionKind: DataGridExtractRequest["selectionKind"] = "cells";

    const matrix = options.selectedCellMatrix.value;
    const isMultiCellSelection = !!matrix && (matrix.rowIndexes.length > 1 || matrix.columnIndexes.length > 1);
    // A right-click sets contextCell.col to the clicked column (≥ 0); the test
    // harness and non-right-click paths leave it at -1. Only treat a 1×1 matrix
    // as synthetic when there's a real right-click context.
    const hasRightClickContext = !!options.contextCell.value && options.contextSelectionIsSynthetic.value;

    if (options.hasRowSelection.value && options.selectedRowIds.value.size > 0) {
      const items = options.displayItems.value.filter((item) => options.selectedRowIds.value.has(item.id) && !item.isDraft);
      sourceRows = items.map((item) => (fullItemsById.get(item.id) ?? item).data);
      sourceRowIds = items.map((item) => item.id);
      selectedSourceIndexes = dedupeColumnIndexes(visibleIndexes).filter((index) => index < fullColumns.length);
      selectionKind = "rows";
    } else if (isMultiCellSelection && matrix) {
      const items = matrix.rowIndexes.map((rowIndex) => options.displayItems.value[rowIndex]).filter((item): item is ExtractorRowItem => !!item && !item.isDraft);
      sourceRows = items.map((item) => (fullItemsById.get(item.id) ?? item).data);
      sourceRowIds = items.map((item) => item.id);
      selectedSourceIndexes = dedupeColumnIndexes(matrix.columnIndexes.map((index) => visibleIndexes[index] ?? index)).filter((index) => index < fullColumns.length);
      if (options.hasColumnSelection.value) selectionKind = "columns";
    } else if (hasRightClickContext && options.contextCell.value) {
      // A SELECT targets the clicked cell; existing extractors keep their full-row context behavior.
      const item = fullItemsById.get(options.contextCell.value.rowId);
      if (item && !item.isDraft) {
        sourceRows = [item.data];
        sourceRowIds = [item.id];
        if (extractor === "sql-select") {
          const sourceIndex = visibleIndexes[options.contextCell.value.col];
          selectedSourceIndexes = sourceIndex === undefined ? [] : [sourceIndex];
        } else {
          selectedSourceIndexes = dedupeColumnIndexes(visibleIndexes).filter((index) => index < fullColumns.length);
          selectionKind = "rows";
        }
      }
    } else if (matrix) {
      // Single-cell matrix without a context cell — still honor the explicit selection.
      const items = matrix.rowIndexes.map((rowIndex) => options.displayItems.value[rowIndex]).filter((item): item is ExtractorRowItem => !!item && !item.isDraft);
      sourceRows = items.map((item) => (fullItemsById.get(item.id) ?? item).data);
      sourceRowIds = items.map((item) => item.id);
      selectedSourceIndexes = dedupeColumnIndexes(matrix.columnIndexes.map((index) => visibleIndexes[index] ?? index)).filter((index) => index < fullColumns.length);
      if (options.hasColumnSelection.value) selectionKind = "columns";
    }

    if (sourceRows.length === 0 || selectedSourceIndexes.length === 0) return null;
    const requiredSourceIndexes = [...selectedSourceIndexes];
    if (extractor === "sql-select" && selectionKind === "rows") {
      const primaryKeys = options.tableMeta.value?.primaryKeys ?? [];
      const identityIndexes = primaryKeys.map((primaryKey) => fullColumns.findIndex((displayName, index) => normalizeName(sourceNames?.[index] ?? displayName) === normalizeName(primaryKey)));
      const hasCompleteIdentity = primaryKeys.length > 0 && identityIndexes.every((index) => index >= 0) && sourceRows.every((row) => identityIndexes.every((index) => row[index] !== null && row[index] !== undefined));
      selectedSourceIndexes = hasCompleteIdentity ? identityIndexes : [...fullColumns.keys()];
      requiredSourceIndexes.splice(0, requiredSourceIndexes.length, ...selectedSourceIndexes);
    } else if (extractor === "sql-updates") {
      for (const primaryKey of options.tableMeta.value?.primaryKeys ?? []) {
        const primaryKeyIndex = fullColumns.findIndex((displayName, index) => normalizeName(sourceNames?.[index] ?? displayName) === normalizeName(primaryKey));
        if (primaryKeyIndex >= 0 && !requiredSourceIndexes.includes(primaryKeyIndex)) requiredSourceIndexes.push(primaryKeyIndex);
      }
    }
    const compactIndexBySource = new Map(requiredSourceIndexes.map((sourceIndex, compactIndex) => [sourceIndex, compactIndex]));
    const columnTypesBySource = new Map(visibleIndexes.map((sourceIndex, visibleIndex) => [sourceIndex, options.columnTypes.value?.[visibleIndex]]));
    const columns = requiredSourceIndexes.map((sourceIndex, compactIndex) => ({
      displayName: fullColumns[sourceIndex],
      sourceName: sourceNames?.[sourceIndex],
      sourceIndex: compactIndex,
    }));
    const descriptor = DATA_GRID_COPY_EXTRACTOR_DESCRIPTORS[extractor];
    const selectedColumnIndexes = selectedSourceIndexes.map((sourceIndex) => compactIndexBySource.get(sourceIndex)).filter((index): index is number => index !== undefined);
    const rows = sourceRows.map((row) => requiredSourceIndexes.map((sourceIndex) => (descriptor.category === "json" || descriptor.category === "sql" ? normalizeCellValue(row[sourceIndex], columnTypesBySource.get(sourceIndex)) : row[sourceIndex])));
    const tableMeta =
      descriptor.category === "sql"
        ? compactTableMeta(
            options.tableMeta.value,
            columns.map((column) => column.sourceName ?? column.displayName),
          )
        : undefined;
    const request: DataGridExtractRequest = {
      version: DATA_GRID_EXTRACTOR_CONTRACT_VERSION,
      extractor,
      databaseType: descriptor.category === "sql" ? options.databaseType.value : undefined,
      identifierQuote: descriptor.category === "sql" ? options.identifierQuote?.value : undefined,
      tableMeta,
      columns,
      selectedColumnIndexes,
      rows,
      selectionKind,
      options: normalizeDataGridExtractorOptions(extractorOptions),
    };
    requestSources.set(request, {
      rowIds: sourceRowIds,
      sourceColumnIndexes: requiredSourceIndexes,
      columnTypes: requiredSourceIndexes.map((sourceIndex) => columnTypesBySource.get(sourceIndex)),
      normalizeValues: descriptor.category === "json" || descriptor.category === "sql",
    });
    return request;
  }

  async function resolveRequestSourceValues(request: DataGridExtractRequest, rowLimit?: number): Promise<DataGridExtractRequest> {
    const source = requestSources.get(request);
    if (!source || !options.resolveSourceValues) return rowLimit === undefined ? request : { ...request, rows: request.rows.slice(0, rowLimit) };
    const rowIds = rowLimit === undefined ? source.rowIds : source.rowIds.slice(0, rowLimit);
    const overlays = await options.resolveSourceValues(rowIds, source.sourceColumnIndexes);
    const rows = request.rows.slice(0, rowIds.length).map((row, rowIndex) => {
      const values = overlays.get(rowIds[rowIndex]!);
      if (!values) return row;
      return row.map((value, compactIndex) => {
        const sourceIndex = source.sourceColumnIndexes[compactIndex];
        if (sourceIndex === undefined || !values.has(sourceIndex)) return value;
        const resolved = values.get(sourceIndex);
        return source.normalizeValues ? normalizeCellValue(resolved, source.columnTypes[compactIndex]) : resolved;
      });
    });
    return { ...request, rows };
  }

  function canBuildSqlUpdateRequest(): boolean {
    const request = buildRequest("sql-updates");
    const primaryKeys = request?.tableMeta?.primaryKeys ?? [];
    if (!request || primaryKeys.length === 0) return false;
    const primaryKeyNames = new Set(primaryKeys.map(normalizeName));
    const hasWritableColumn = request.selectedColumnIndexes.some((index) => {
      const column = request.columns[index];
      if (!column) return false;
      const sourceName = column.sourceName ?? column.displayName;
      return !primaryKeyNames.has(normalizeName(sourceName)) && (!request.options.sql.skipGeneratedColumns || !isAutoGeneratedColumn(sourceName, request.tableMeta)) && (!request.options.sql.skipComputedColumns || !isComputedColumn(sourceName, request.tableMeta));
    });
    if (!hasWritableColumn) return false;
    return primaryKeys.every((primaryKey) => {
      const column = request.columns.find((candidate) => normalizeName(candidate.sourceName ?? candidate.displayName) === normalizeName(primaryKey));
      return !!column && request.rows.every((row) => row[column.sourceIndex] !== null && row[column.sourceIndex] !== undefined);
    });
  }

  function canCopyWithExtractor(extractor: DataGridCopyExtractorId, extractorOptions: DataGridExtractorOptions = options.extractorOptions?.value ?? DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS): boolean {
    if (hasUnsupportedDiscreteSelection.value) return false;
    if (!options.hasRowSelection.value && !options.hasCellSelection.value && !options.contextCell.value) return false;
    if (extractorUnavailableForDatabase(extractor, options.databaseType.value)) return false;
    if (extractor === "sql-inserts") {
      const request = buildRequest(extractor, extractorOptions);
      return request !== null && options.canCopySqlInsert(request);
    }
    if (extractor === "sql-updates") {
      // Mongo has a dedicated updateOne path that doesn't need SQL primary keys.
      if (options.databaseType.value === "mongodb") {
        const request = buildRequest(extractor, extractorOptions);
        return request !== null && (options.canBuildMongoUpdate?.(request) ?? false);
      }
      return canBuildSqlUpdateRequest();
    }
    if (extractor === "sql-select") {
      const matrix = options.selectedCellMatrix.value;
      if (options.hasRowSelection.value) {
        if (options.selectedRowIds.value.size !== 1) return false;
      } else if (matrix) {
        if (matrix.rowIndexes.length !== 1 || matrix.columnIndexes.length !== 1) return false;
      } else if (!options.contextCell.value || !options.contextSelectionIsSynthetic.value) {
        return false;
      }
      const request = buildRequest(extractor, extractorOptions);
      if (!request?.tableMeta?.tableName.trim() || request.rows.length !== 1) return false;
      if (request.selectionKind === "columns") return false;
      if (request.selectionKind === "cells" && request.selectedColumnIndexes.length !== 1) return false;
      return request.columns.length > 0 && request.columns.every((column) => !!column.sourceName?.trim());
    }
    if (extractor === "raw") {
      const request = buildRequest(extractor, extractorOptions);
      return request !== null && request.rows.length * request.selectedColumnIndexes.length === 1;
    }
    return selectionData() !== null;
  }

  function resolveCopyPreference(preference: DataGridCopyPreference, extractorOptions: DataGridExtractorOptions): DataGridCopyExtractorId | null {
    const request = buildRequest("raw", extractorOptions);
    if (!request) return null;
    return resolveDataGridCopyPreference(preference, request.rows.length * request.selectedColumnIndexes.length);
  }

  async function resolveMongoExtractorResult(extractor: DataGridCopyExtractorId, request: DataGridExtractRequest, rowLimit?: number) {
    if (options.databaseType.value !== "mongodb") return undefined;
    if (extractor !== "sql-inserts" && extractor !== "sql-updates") return undefined;
    const text = extractor === "sql-inserts" ? ((await options.buildMongoInsert(request.options, rowLimit)) ?? "") : ((await options.buildMongoUpdate?.(request, rowLimit)) ?? "");
    return { text, mimeType: "application/javascript", fileExtension: "js", rowCount: rowLimit ?? request.rows.length, columnCount: request.selectedColumnIndexes.length, warnings: undefined, omittedColumns: undefined };
  }

  async function copyWithExtractor(extractor: DataGridCopyExtractorId, extractorOptions: DataGridExtractorOptions = options.extractorOptions?.value ?? DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS): Promise<boolean> {
    if (hasUnsupportedDiscreteSelection.value) {
      toast(t("grid.copyExtractorUnsupportedSelection"), 5000);
      return false;
    }
    if (!canCopyWithExtractor(extractor, extractorOptions)) return false;
    const initialRequest = buildRequest(extractor, extractorOptions);
    if (!initialRequest) return false;
    try {
      const request = await resolveRequestSourceValues(initialRequest);
      const mongoResult = await resolveMongoExtractorResult(extractor, request);
      const result = mongoResult ?? (await api.extractDataGridSelection(request));
      if (!result.text) return false;
      // Derive the grid paste-back payload from the effective request schema so
      // hidden support columns, row headers, NULLs, tabs, and newlines keep the
      // same shape and values as the rendered raw text or TSV.
      const isGridTabularCopy = extractor === "raw" || extractor === "tsv" || extractor === "tsv-with-headers";
      const gridCopy = isGridTabularCopy
        ? (() => {
            const includeRowHeader = extractor !== "raw" && request.options.dsv.includeRowHeader;
            const rows = request.rows.map((row, rowIndex) => {
              const selectedRow = request.selectedColumnIndexes.map((index) => row[index]);
              return includeRowHeader ? [rowIndex + 1, ...selectedRow] : selectedRow;
            });
            const selectedHeaders = request.selectedColumnIndexes.map((index) => request.columns[index]?.displayName ?? "");
            const header = extractor === "tsv-with-headers" ? (includeRowHeader ? ["#", ...selectedHeaders] : selectedHeaders) : undefined;
            return { rows, header };
          })()
        : undefined;
      const copied = await options.copyText(result.text, gridCopy);
      if (!copied) return false;
      showWarnings(result.warnings, result.omittedColumns);
      return true;
    } catch (error: unknown) {
      toast(t("grid.copyFailed", { message: formatError(error) }), 5000);
      return false;
    }
  }

  async function previewWithExtractor(extractor: DataGridCopyExtractorId, extractorOptions: DataGridExtractorOptions): Promise<DataGridExtractPreview> {
    if (hasUnsupportedDiscreteSelection.value) throw new Error(t("grid.copyExtractorUnsupportedSelection"));
    const initialRequest = buildRequest(extractor, extractorOptions);
    if (!initialRequest) throw new Error(t("grid.copyExtractorEmptySelection"));
    const sourceRowCount = initialRequest.rows.length;
    const previewRowCount = Math.min(sourceRowCount, DATA_GRID_EXTRACTOR_PREVIEW_MAX_ROWS);
    const request = await resolveRequestSourceValues(initialRequest, previewRowCount);
    const mongoResult = await resolveMongoExtractorResult(extractor, request, previewRowCount);
    const result = mongoResult ?? (await api.extractDataGridSelection(request));
    if (!result.text) throw new Error(t("grid.copyExtractorEmptySelection"));
    return { ...result, sourceRowCount, truncated: sourceRowCount > result.rowCount };
  }

  async function copyWithPreference(preference: DataGridCopyPreference, extractorOptions: DataGridExtractorOptions = options.extractorOptions?.value ?? DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS): Promise<boolean> {
    if (hasUnsupportedDiscreteSelection.value) {
      toast(t("grid.copyExtractorUnsupportedSelection"), 5000);
      return false;
    }
    const extractor = resolveCopyPreference(preference, extractorOptions);
    return extractor ? copyWithExtractor(extractor, extractorOptions) : false;
  }

  async function previewWithPreference(preference: DataGridCopyPreference, extractorOptions: DataGridExtractorOptions): Promise<DataGridExtractPreview> {
    if (hasUnsupportedDiscreteSelection.value) throw new Error(t("grid.copyExtractorUnsupportedSelection"));
    const extractor = resolveCopyPreference(preference, extractorOptions);
    if (!extractor) throw new Error(t("grid.copyExtractorEmptySelection"));
    return previewWithExtractor(extractor, extractorOptions);
  }

  function showWarnings(warnings: Array<{ code: DataGridExtractWarningCode; message: string }> | undefined, omittedColumns: string[] | undefined) {
    if (!warnings?.length) return;
    for (const warning of warnings) {
      const message = warning.code === "omitted-columns" ? t("grid.copyExtractorWarningOmittedColumns", { columns: omittedColumns?.join(", ") || "-" }) : t("grid.copyExtractorWarningDuplicateJsonColumns");
      toast(message, 5000);
    }
  }

  return { copyWithExtractor, copyWithPreference, previewWithExtractor, previewWithPreference, canCopyWithExtractor };
}

function compactTableMeta(tableMeta: DataGridTableMeta | undefined, requiredColumns: string[]): DataGridTableMeta | undefined {
  if (!tableMeta?.columns) return tableMeta;
  const requiredNames = new Set(requiredColumns.map(normalizeName));
  return { ...tableMeta, columns: tableMeta.columns.filter((column) => requiredNames.has(normalizeName(column.name))) };
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  const unquoted = (first === "`" && last === "`") || (first === '"' && last === '"') || (first === "[" && last === "]") ? trimmed.slice(1, -1) : trimmed;
  return unquoted.replace(/[a-z]/g, (character) => character.toUpperCase());
}

function columnExtra(column: string, tableMeta: DataGridTableMeta | undefined): string {
  const columnInfo = tableMeta?.columns?.find((item) => normalizeName(item.name) === normalizeName(column));
  return columnInfo?.extra?.toLowerCase() ?? "";
}

function isAutoGeneratedColumn(column: string, tableMeta: DataGridTableMeta | undefined): boolean {
  return /\b(auto_increment|autoincrement|identity)\b/.test(columnExtra(column, tableMeta));
}

function isComputedColumn(column: string, tableMeta: DataGridTableMeta | undefined): boolean {
  const extra = columnExtra(column, tableMeta);
  return extra.includes("generated always as") && !extra.includes("identity");
}
