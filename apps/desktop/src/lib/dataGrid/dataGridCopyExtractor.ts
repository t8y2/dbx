import type { DatabaseType } from "@/types/database";
import type { DataGridCopyInsertMode, DataGridTableMeta } from "@/lib/dataGrid/dataGridSql";

export const DATA_GRID_COPY_EXTRACTOR_IDS = [
  "raw",
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
  "sql-deletes-inserts",
  "sql-updates",
  "sql-select",
  "where-clause",
  "markdown",
  "html",
  "xml",
  "pretty",
  "dbunit",
  "php",
] as const;

export type DataGridCopyExtractorId = (typeof DATA_GRID_COPY_EXTRACTOR_IDS)[number];
export type DataGridCopyPreference = "smart" | DataGridCopyExtractorId;
export type DataGridExtractorCategory = "raw" | "delimited" | "json" | "sql" | "document";

export const DATA_GRID_DEFAULT_COPY_PREFERENCES: readonly DataGridCopyPreference[] = [
  "smart",
  "raw",
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
  "sql-deletes-inserts",
  "sql-updates",
  "where-clause",
  "markdown",
  "html",
  "xml",
  "pretty",
  "dbunit",
  "php",
];
export const DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS: readonly DataGridCopyExtractorId[] = DATA_GRID_COPY_EXTRACTOR_IDS;

export const DATA_GRID_EXTRACTOR_CONTRACT_VERSION = 1 as const;
// v3：复制/导出 SQL 的「包含数据库名称」默认恢复开启（带库名/模式名，#12146），
// 历史被 v2 迁移归位为 false 的持久化配置升级到新默认 true。
export const DATA_GRID_EXTRACTOR_OPTIONS_MIGRATION_VERSION = 3 as const;

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
  "sql-deletes-inserts": { category: "sql" },
  "sql-updates": { category: "sql" },
  "sql-select": { category: "sql" },
  "where-clause": { category: "sql" },
  markdown: { category: "document", separatorBefore: true },
  html: { category: "document" },
  xml: { category: "document" },
  pretty: { category: "document" },
  dbunit: { category: "document", separatorBefore: true },
  php: { category: "document" },
};

export type DataGridSelectionKind = "cells" | "rows" | "columns";
export type DataGridValueFormat = "default" | "legacy" | "display" | "edit" | "native";
export type DataGridQuotePolicy = "always" | "minimal" | "never" | "strings" | "all-but-numbers" | "all-including-nulls";
export type DataGridExtractorOptionsError = "column-separator-empty" | "row-separator-empty" | "separator-too-long" | "null-text-too-long" | "separators-overlap" | "invalid-quote" | "quote-conflicts" | "invalid-php-row-delimiter";

/** Extractors that emit relational SQL predicates not supported by some stores.
 * sql-updates has a Mongo-specific updateOne path, so Mongo is NOT disabled;
 * where-clause has no Mongo equivalent, so Mongo IS disabled. */
const NO_SQL_UPDATE_DATABASE_TYPES: ReadonlyArray<string> = ["neo4j", "tdengine"];
const NO_SQL_DELETES_INSERTS_DATABASE_TYPES: ReadonlyArray<string> = ["neo4j", "tdengine", "mongodb"];
const NO_WHERE_CLAUSE_DATABASE_TYPES: ReadonlyArray<string> = ["neo4j", "tdengine", "mongodb"];

/** True when the extractor emits relational SQL the database type cannot run. */
export function extractorUnavailableForDatabase(extractor: DataGridCopyExtractorId, databaseType: string | undefined | null): boolean {
  const db = databaseType ?? "";
  if (extractor === "sql-updates") return NO_SQL_UPDATE_DATABASE_TYPES.includes(db);
  if (extractor === "sql-deletes-inserts") return NO_SQL_DELETES_INSERTS_DATABASE_TYPES.includes(db);
  if (extractor === "where-clause" || extractor === "sql-select") return NO_WHERE_CLAUSE_DATABASE_TYPES.includes(db);
  return false;
}

export interface DataGridDsvOptions {
  columnSeparator: string;
  rowSeparator: string;
  nullText: string;
  quote: string;
  quotePolicy: DataGridQuotePolicy;
  quoteNumericStrings: boolean;
  includeColumnHeader: boolean;
  includeRowHeader: boolean;
  headerPosition: "legacy" | "none" | "top" | "bottom";
  headerFormat: "name" | "description" | "both";
  headerCase: "preserve" | "upper" | "lower";
  escapeFormulas: boolean;
  lineFeedEscapeString: string;
  arrayFormat: "preserve" | "braces" | "brackets" | "parentheses";
  formatNumbers: "inherit" | "native" | "display";
}

export type DataGridPrimaryKeyMode = "include" | "exclude-generated" | "exclude-all";

export interface DataGridExtractorOptions {
  dsv: DataGridDsvOptions;
  sql: {
    skipComputedColumns: boolean;
    skipGeneratedColumns: boolean;
    insertMode: DataGridCopyInsertMode;
    primaryKeyMode: DataGridPrimaryKeyMode;
    includeDatabaseName: boolean;
    quoteIdentifiers: boolean;
    temporalFormat: "native" | "string";
  };
  json: {
    pretty: boolean;
    camelCaseFieldNames: boolean;
    /** Bare array of values instead of objects; only honored for single-column selections. */
    valuesOnly: boolean;
  };
  dbunit: { tableName: string; upperCaseTableName: boolean; upperCaseColumnNames: boolean; includeNullValues: boolean; nullValueString: string };
  php: { arraySyntax: "legacy" | "short"; quoteChar: "'" | '"'; formatDateIso: boolean; rowDelimiter: string; variableName: string };
  valueFormat: DataGridValueFormat;
}

export interface DataGridExtractColumn {
  displayName: string;
  sourceName?: string;
  sourceIndex: number;
  dataType?: string;
  description?: string;
}

export interface DataGridExtractRequest {
  version: typeof DATA_GRID_EXTRACTOR_CONTRACT_VERSION;
  extractor: DataGridCopyExtractorId;
  databaseType?: DatabaseType;
  identifierQuote?: string;
  tableMeta?: DataGridTableMeta;
  sourceTableName?: string;
  columns: DataGridExtractColumn[];
  selectedColumnIndexes: number[];
  rows: unknown[][];
  selectionKind: DataGridSelectionKind;
  options: DataGridExtractorOptions;
}

export type DataGridExtractWarningCode = "omitted-columns" | "duplicate-json-column-names" | "php-date-not-iso";

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
    nullText: "",
    quote: '"',
    quotePolicy: "minimal",
    quoteNumericStrings: false,
    includeColumnHeader: false,
    includeRowHeader: false,
    headerPosition: "legacy",
    headerFormat: "name",
    headerCase: "preserve",
    escapeFormulas: false,
    lineFeedEscapeString: "",
    arrayFormat: "preserve",
    formatNumbers: "inherit",
  },
  sql: {
    skipComputedColumns: true,
    skipGeneratedColumns: true,
    insertMode: "merged",
    primaryKeyMode: "include",
    includeDatabaseName: true,
    quoteIdentifiers: true,
    temporalFormat: "native",
  },
  json: { pretty: true, camelCaseFieldNames: false, valuesOnly: false },
  dbunit: { tableName: "", upperCaseTableName: true, upperCaseColumnNames: true, includeNullValues: true, nullValueString: "[NULL]" },
  php: { arraySyntax: "short", quoteChar: '"', formatDateIso: true, rowDelimiter: "\n", variableName: "" },
  valueFormat: "default",
};

function unicodeCodePointLength(value: string): number {
  return [...value].length;
}

export function normalizeDataGridExtractorOptions(value: unknown): DataGridExtractorOptions {
  const source = typeof value === "object" && value !== null ? (value as Partial<DataGridExtractorOptions>) : {};
  const dsv: Partial<DataGridDsvOptions> = typeof source.dsv === "object" && source.dsv !== null ? source.dsv : {};
  const sql: Record<string, unknown> = typeof source.sql === "object" && source.sql !== null ? (source.sql as Record<string, unknown>) : {};
  const json: Partial<DataGridExtractorOptions["json"]> = typeof source.json === "object" && source.json !== null ? source.json : {};
  const dbunit: Partial<DataGridExtractorOptions["dbunit"]> = typeof source.dbunit === "object" && source.dbunit !== null ? source.dbunit : {};
  const php: Partial<DataGridExtractorOptions["php"]> = typeof source.php === "object" && source.php !== null ? source.php : {};
  const phpLegacy = php as Record<string, unknown>;
  const separator = (candidate: unknown, fallback: string) => (typeof candidate === "string" && unicodeCodePointLength(candidate) > 0 && unicodeCodePointLength(candidate) <= 8 ? candidate : fallback);
  const quote = typeof dsv.quote === "string" && unicodeCodePointLength(dsv.quote) === 1 ? dsv.quote : DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv.quote;
  return {
    dsv: {
      columnSeparator: separator(dsv.columnSeparator, DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv.columnSeparator),
      rowSeparator: separator(dsv.rowSeparator, DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv.rowSeparator),
      nullText: typeof dsv.nullText === "string" && unicodeCodePointLength(dsv.nullText) <= 64 ? dsv.nullText : DEFAULT_DATA_GRID_EXTRACTOR_OPTIONS.dsv.nullText,
      quote,
      quotePolicy: dsv.quotePolicy === "always" || dsv.quotePolicy === "never" || dsv.quotePolicy === "strings" || dsv.quotePolicy === "all-but-numbers" || dsv.quotePolicy === "all-including-nulls" ? dsv.quotePolicy : "minimal",
      quoteNumericStrings: dsv.quoteNumericStrings === true,
      includeColumnHeader: dsv.includeColumnHeader === true,
      includeRowHeader: dsv.includeRowHeader === true,
      headerPosition: dsv.headerPosition === "none" || dsv.headerPosition === "top" || dsv.headerPosition === "bottom" ? dsv.headerPosition : "legacy",
      headerFormat: dsv.headerFormat === "description" || dsv.headerFormat === "both" ? dsv.headerFormat : "name",
      headerCase: dsv.headerCase === "upper" || dsv.headerCase === "lower" ? dsv.headerCase : "preserve",
      escapeFormulas: dsv.escapeFormulas === true,
      lineFeedEscapeString: typeof dsv.lineFeedEscapeString === "string" && dsv.lineFeedEscapeString.length <= 32 ? dsv.lineFeedEscapeString : "",
      arrayFormat: dsv.arrayFormat === "braces" || dsv.arrayFormat === "brackets" || dsv.arrayFormat === "parentheses" ? dsv.arrayFormat : "preserve",
      formatNumbers: dsv.formatNumbers === "native" || dsv.formatNumbers === "display" ? dsv.formatNumbers : "inherit",
    },
    sql: {
      skipComputedColumns: sql.skipComputedColumns !== false,
      skipGeneratedColumns: sql.skipGeneratedColumns !== false,
      insertMode: sql.insertMode === "row-by-row" ? "row-by-row" : "merged",
      primaryKeyMode: sql.primaryKeyMode === "exclude-generated" || sql.primaryKeyMode === "exclude-all" || sql.primaryKeyMode === "include" ? sql.primaryKeyMode : sql.excludePrimaryKeysFromInsert === true ? "exclude-generated" : "include",
      includeDatabaseName: sql.includeDatabaseName !== false,
      quoteIdentifiers: sql.quoteIdentifiers !== false,
      temporalFormat: sql.temporalFormat === "string" ? "string" : "native",
    },
    json: {
      pretty: json.pretty !== false,
      camelCaseFieldNames: json.camelCaseFieldNames === true,
      valuesOnly: json.valuesOnly === true,
    },
    dbunit: {
      tableName: typeof dbunit.tableName === "string" ? dbunit.tableName : "",
      upperCaseTableName: dbunit.upperCaseTableName !== false,
      upperCaseColumnNames: dbunit.upperCaseColumnNames !== false,
      includeNullValues: dbunit.includeNullValues !== false,
      nullValueString: typeof dbunit.nullValueString === "string" && dbunit.nullValueString.length <= 128 ? dbunit.nullValueString : "[NULL]",
    },
    php: {
      arraySyntax: php.arraySyntax === "legacy" ? "legacy" : "short",
      quoteChar: php.quoteChar === "'" ? "'" : '"',
      formatDateIso: typeof php.formatDateIso === "boolean" ? php.formatDateIso : phpLegacy.formatDateISO !== false,
      rowDelimiter: typeof php.rowDelimiter === "string" && php.rowDelimiter.length <= 8 ? php.rowDelimiter : "\n",
      variableName: typeof php.variableName === "string" && (php.variableName === "" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(php.variableName)) ? php.variableName : "",
    },
    valueFormat: source.valueFormat === "legacy" || source.valueFormat === "display" || source.valueFormat === "edit" || source.valueFormat === "native" ? source.valueFormat : "default",
  };
}

const DATA_GRID_COPY_PREFERENCE_SET = new Set<string>(DATA_GRID_DEFAULT_COPY_PREFERENCES);

export function normalizeDataGridCopyPreference(value: unknown): DataGridCopyPreference {
  return typeof value === "string" && DATA_GRID_COPY_PREFERENCE_SET.has(value) ? (value as DataGridCopyPreference) : "smart";
}

export function normalizeVisibleDataGridCopyExtractors(value: unknown): DataGridCopyExtractorId[] {
  if (!Array.isArray(value)) return [...DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS];
  const selected = new Set(value.filter((item): item is DataGridCopyExtractorId => typeof item === "string" && DATA_GRID_COPY_EXTRACTOR_IDS.includes(item as DataGridCopyExtractorId)));
  return DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS.filter((item) => selected.has(item));
}

export function resolveDataGridCopyPreference(preference: DataGridCopyPreference, selectedCellCount: number): DataGridCopyExtractorId {
  if (preference !== "smart") return preference;
  return selectedCellCount === 1 ? "raw" : "tsv";
}

export function validateDataGridExtractorOptions(extractor: DataGridCopyExtractorId, options: DataGridExtractorOptions): DataGridExtractorOptionsError | null {
  if (extractor === "php" && !/^[ \t\r\n\f\v]*$/.test(options.php.rowDelimiter)) return "invalid-php-row-delimiter";
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
