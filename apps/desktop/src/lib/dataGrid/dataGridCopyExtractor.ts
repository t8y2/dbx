import type { DatabaseType } from "@/types/database";
import type { DataGridCopyInsertMode, DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";

export const DATA_GRID_COPY_EXTRACTOR_IDS = ["raw", "tsv", "tsv-with-headers", "csv", "csv-with-headers", "pipe-separated", "dsv", "json", "json-lines", "one-row", "sql-in-list", "sql-inserts", "sql-updates", "where-clause", "markdown", "html", "xml", "pretty"] as const;

export type DataGridCopyExtractorId = (typeof DATA_GRID_COPY_EXTRACTOR_IDS)[number];
export type DataGridCopyPreference = "smart" | Exclude<DataGridCopyExtractorId, "raw">;
export type DataGridExtractorCategory = "raw" | "delimited" | "json" | "sql" | "document";

export const DATA_GRID_DEFAULT_COPY_PREFERENCES: readonly DataGridCopyPreference[] = [
  "smart",
  "tsv",
  "tsv-with-headers",
  "csv",
  "csv-with-headers",
  "pipe-separated",
  "dsv",
  "json",
  "json-lines",
  "one-row",
  "sql-in-list",
  "sql-inserts",
  "sql-updates",
  "where-clause",
  "markdown",
  "html",
  "xml",
  "pretty",
];

export const DATA_GRID_EXTRACTOR_CONTRACT_VERSION = 1 as const;

export const DATA_GRID_COPY_EXTRACTOR_DESCRIPTORS: Record<DataGridCopyExtractorId, { category: DataGridExtractorCategory; separatorBefore?: boolean }> = {
  raw: { category: "raw" },
  tsv: { category: "delimited" },
  "tsv-with-headers": { category: "delimited" },
  csv: { category: "delimited" },
  "csv-with-headers": { category: "delimited" },
  "pipe-separated": { category: "delimited" },
  dsv: { category: "delimited" },
  "one-row": { category: "delimited" },
  json: { category: "json", separatorBefore: true },
  "json-lines": { category: "json" },
  "sql-in-list": { category: "sql", separatorBefore: true },
  "sql-inserts": { category: "sql" },
  "sql-updates": { category: "sql" },
  "where-clause": { category: "sql" },
  markdown: { category: "document", separatorBefore: true },
  html: { category: "document" },
  xml: { category: "document" },
  pretty: { category: "document" },
};

export type DataGridSelectionKind = "cells" | "rows" | "columns";
export type DataGridQuotePolicy = "always" | "minimal" | "never";
export type DataGridExtractorOptionsError = "column-separator-empty" | "row-separator-empty" | "separator-too-long" | "null-text-too-long" | "separators-overlap" | "invalid-quote" | "quote-conflicts";

/** Extractors that emit relational SQL predicates not supported by some stores.
 * sql-updates has a Mongo-specific updateOne path, so Mongo is NOT disabled;
 * where-clause has no Mongo equivalent, so Mongo IS disabled. */
const NO_SQL_UPDATE_DATABASE_TYPES: ReadonlyArray<string> = ["neo4j", "tdengine"];
const NO_WHERE_CLAUSE_DATABASE_TYPES: ReadonlyArray<string> = ["neo4j", "tdengine", "mongodb"];

/** True when the extractor emits relational SQL the database type cannot run. */
export function extractorUnavailableForDatabase(extractor: DataGridCopyExtractorId, databaseType: string | undefined | null): boolean {
  const db = databaseType ?? "";
  if (extractor === "sql-updates") return NO_SQL_UPDATE_DATABASE_TYPES.includes(db);
  if (extractor === "where-clause") return NO_WHERE_CLAUSE_DATABASE_TYPES.includes(db);
  return false;
}

export interface DataGridDsvOptions {
  columnSeparator: string;
  rowSeparator: string;
  nullText: string;
  quote: string;
  quotePolicy: DataGridQuotePolicy;
  includeColumnHeader: boolean;
  includeRowHeader: boolean;
}

export interface DataGridExtractorOptions {
  dsv: DataGridDsvOptions;
  sql: {
    skipComputedColumns: boolean;
    skipGeneratedColumns: boolean;
    insertMode: DataGridCopyInsertMode;
    excludePrimaryKeysFromInsert: boolean;
  };
  json: { pretty: boolean };
}

export interface DataGridExtractColumn {
  displayName: string;
  sourceName?: string;
  sourceIndex: number;
}

export interface DataGridExtractRequest {
  version: typeof DATA_GRID_EXTRACTOR_CONTRACT_VERSION;
  extractor: DataGridCopyExtractorId;
  databaseType?: DatabaseType;
  tableMeta?: DataGridTableMeta;
  columns: DataGridExtractColumn[];
  selectedColumnIndexes: number[];
  rows: unknown[][];
  selectionKind: DataGridSelectionKind;
  options: DataGridExtractorOptions;
}

export type DataGridExtractWarningCode = "omitted-columns" | "duplicate-json-column-names";

export interface DataGridExtractResult {
  text: string;
  mimeType: string;
  fileExtension: string;
  rowCount: number;
  columnCount: number;
  omittedColumns?: string[];
  warnings?: Array<{ code: DataGridExtractWarningCode; message: string }>;
}

export interface DataGridExtractPreview extends DataGridExtractResult {
  sourceRowCount: number;
  truncated: boolean;
}

export const DATA_GRID_EXTRACTOR_PREVIEW_MAX_ROWS = 100;

export const DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS: DataGridExtractorOptions = {
  dsv: {
    columnSeparator: ",",
    rowSeparator: "\n",
    nullText: "NULL",
    quote: '"',
    quotePolicy: "minimal",
    includeColumnHeader: false,
    includeRowHeader: false,
  },
  sql: {
    skipComputedColumns: true,
    skipGeneratedColumns: true,
    insertMode: "merged",
    excludePrimaryKeysFromInsert: false,
  },
  json: { pretty: true },
};

function unicodeCodePointLength(value: string): number {
  return [...value].length;
}

export function normalizeDataGridExtractorOptions(value: unknown): DataGridExtractorOptions {
  const source = typeof value === "object" && value !== null ? (value as Partial<DataGridExtractorOptions>) : {};
  const dsv: Partial<DataGridDsvOptions> = typeof source.dsv === "object" && source.dsv !== null ? source.dsv : {};
  const sql: Partial<DataGridExtractorOptions["sql"]> = typeof source.sql === "object" && source.sql !== null ? source.sql : {};
  const json: Partial<DataGridExtractorOptions["json"]> = typeof source.json === "object" && source.json !== null ? source.json : {};
  const separator = (candidate: unknown, fallback: string) => (typeof candidate === "string" && unicodeCodePointLength(candidate) > 0 && unicodeCodePointLength(candidate) <= 8 ? candidate : fallback);
  const quote = typeof dsv.quote === "string" && unicodeCodePointLength(dsv.quote) === 1 ? dsv.quote : DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv.quote;
  return {
    dsv: {
      columnSeparator: separator(dsv.columnSeparator, DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv.columnSeparator),
      rowSeparator: separator(dsv.rowSeparator, DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv.rowSeparator),
      nullText: typeof dsv.nullText === "string" && unicodeCodePointLength(dsv.nullText) <= 64 ? dsv.nullText : DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv.nullText,
      quote,
      quotePolicy: dsv.quotePolicy === "always" || dsv.quotePolicy === "never" ? dsv.quotePolicy : "minimal",
      includeColumnHeader: dsv.includeColumnHeader === true,
      includeRowHeader: dsv.includeRowHeader === true,
    },
    sql: {
      skipComputedColumns: sql.skipComputedColumns !== false,
      skipGeneratedColumns: sql.skipGeneratedColumns !== false,
      insertMode: sql.insertMode === "row-by-row" ? "row-by-row" : "merged",
      excludePrimaryKeysFromInsert: sql.excludePrimaryKeysFromInsert === true,
    },
    json: { pretty: json.pretty !== false },
  };
}

const DATA_GRID_COPY_PREFERENCE_SET = new Set<string>(DATA_GRID_DEFAULT_COPY_PREFERENCES);

export function normalizeDataGridCopyPreference(value: unknown): DataGridCopyPreference {
  return typeof value === "string" && DATA_GRID_COPY_PREFERENCE_SET.has(value) ? (value as DataGridCopyPreference) : "smart";
}

export function resolveDataGridCopyPreference(preference: DataGridCopyPreference, selectedCellCount: number): DataGridCopyExtractorId {
  if (preference !== "smart") return preference;
  return selectedCellCount === 1 ? "raw" : "tsv";
}

export function validateDataGridExtractorOptions(extractor: DataGridCopyExtractorId, options: DataGridExtractorOptions): DataGridExtractorOptionsError | null {
  const usesDsv = DATA_GRID_COPY_EXTRACTOR_DESCRIPTORS[extractor].category === "delimited";
  if (!usesDsv) return null;
  const quoteCodePoint = options.dsv.quote.codePointAt(0);
  if (unicodeCodePointLength(options.dsv.quote) !== 1 || quoteCodePoint === undefined || quoteCodePoint <= 0x1f || quoteCodePoint === 0x7f) return "invalid-quote";
  if (unicodeCodePointLength(options.dsv.nullText) > 64) return "null-text-too-long";

  const columnSeparator = extractor === "tsv" || extractor === "tsv-with-headers" ? "\t" : extractor === "csv" || extractor === "csv-with-headers" ? "," : extractor === "pipe-separated" ? "|" : options.dsv.columnSeparator;
  if (!columnSeparator) return "column-separator-empty";
  const usesRowSeparator = extractor !== "one-row";
  if (usesRowSeparator && !options.dsv.rowSeparator) return "row-separator-empty";
  if (unicodeCodePointLength(columnSeparator) > 8 || unicodeCodePointLength(options.dsv.rowSeparator) > 8) return "separator-too-long";
  if (usesRowSeparator && (columnSeparator.includes(options.dsv.rowSeparator) || options.dsv.rowSeparator.includes(columnSeparator))) return "separators-overlap";
  if (columnSeparator.includes(options.dsv.quote) || (usesRowSeparator && options.dsv.rowSeparator.includes(options.dsv.quote))) return "quote-conflicts";
  return null;
}
