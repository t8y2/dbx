import { analyzeSelectStructureForDisplay, resolveMetadataColumnName } from "@/lib/sql/sqlAnalysis";
import { canInsertTableRows } from "@/lib/table/tableEditing";
import type { QueryMetadataPatch } from "@/stores/queryStore";
import type { QueryResult, DatabaseType } from "@/types/database";
import type { DataGridExtractRequest, DataGridExtractorOptions } from "@/lib/dataGrid/dataGridCopyExtractor";

/** A display source label is insufficient to authorize an INSERT target. */
export function batchResultInsertRequest(result: QueryResult, metadata: QueryMetadataPatch | undefined, databaseType: DatabaseType | undefined, identifierQuote: string | undefined, options: DataGridExtractorOptions): DataGridExtractRequest | undefined {
  if (result.execution_error || result.server_message || !result.sourceStatement || !databaseType || result.large_value_cells?.length) return undefined;
  const structure = analyzeSelectStructureForDisplay(result.sourceStatement);
  if (!structure || structure.multiSource || structure.distinct || structure.groupByColumns !== undefined || structure.hasHavingClause || structure.hasWindowClause) return undefined;
  if (!structure.selectStar && structure.columns.some((column) => !column.sourceName)) return undefined;
  const analysis = metadata?.queryAnalysis;
  const tableMeta = metadata?.tableMeta;
  const tableColumnNames = tableMeta?.columns?.map((item) => item.name);
  const mapping = metadata?.querySourceColumns ?? (structure.selectStar && tableColumnNames?.length ? result.columns.map((column) => resolveMetadataColumnName(databaseType, column, undefined, tableColumnNames)) : undefined);
  if (!tableMeta || !mapping || analysis?.multiSource || analysis?.allowInsert === false || !canInsertTableRows(databaseType) || tableMeta.tableType?.toUpperCase().includes("VIEW")) return undefined;
  const hidden = new Set(result.hidden_column_indexes ?? []);
  const indexes = result.columns.map((_, index) => index).filter((index) => !hidden.has(index));
  if (!indexes.length || indexes.some((index) => !mapping[index])) return undefined;
  const targetIndexBySource = new Map(indexes.map((sourceIndex, targetIndex) => [sourceIndex, targetIndex]));
  const spatialColumns = result.spatial_columns?.flatMap((col) => {
    const targetIndex = targetIndexBySource.get(col.column_index);
    return targetIndex === undefined ? [] : [{ ...col, column_index: targetIndex }];
  });
  const spatialValues = result.spatial_values?.map((row) => indexes.map((idx) => row[idx] ?? null));
  return {
    version: 1,
    extractor: "sql-inserts",
    databaseType,
    identifierQuote,
    tableMeta,
    columns: indexes.map((index, ordinal) => ({ displayName: result.columns[index], sourceName: mapping[index], sourceIndex: ordinal })),
    selectedColumnIndexes: indexes.map((_, index) => index),
    rows: result.rows.map((row) => indexes.map((index) => row[index])),
    selectionKind: "rows",
    options,
    spatialColumns: spatialColumns?.length ? spatialColumns : undefined,
    spatialValues: spatialValues?.length ? spatialValues : undefined,
  };
}
