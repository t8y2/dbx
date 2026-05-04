import type { ColumnInfo, DatabaseType } from "../types/database.ts";
import { qualifiedTableName, quoteTableIdentifier } from "./tableSelectSql.ts";

export interface DatabaseSearchSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  columns: ColumnInfo[];
  term: string;
  limit?: number;
}

export interface DatabaseSearchSql {
  sql: string;
  searchableColumns: string[];
}

export interface SearchResultWhereOptions {
  databaseType?: DatabaseType;
  columns: ColumnInfo[];
  resultColumns: string[];
  row: unknown[];
  matchedColumns?: string[];
}

const TEXT_TYPES = [
  "char",
  "text",
  "clob",
  "varchar",
  "nvarchar",
  "nchar",
  "uuid",
  "uniqueidentifier",
  "enum",
];

const NUMBER_TYPES = [
  "int",
  "serial",
  "number",
  "numeric",
  "decimal",
  "float",
  "double",
  "real",
  "money",
];

const SKIPPED_TYPES = ["blob", "binary", "bytea", "image", "geometry", "geography"];

function normalizedType(column: ColumnInfo): string {
  return column.data_type.toLowerCase();
}

export function isTextSearchColumn(column: ColumnInfo): boolean {
  const type = normalizedType(column);
  if (SKIPPED_TYPES.some((skipped) => type.includes(skipped))) return false;
  return TEXT_TYPES.some((textType) => type.includes(textType));
}

export function isNumericSearchColumn(column: ColumnInfo): boolean {
  const type = normalizedType(column);
  if (SKIPPED_TYPES.some((skipped) => type.includes(skipped))) return false;
  return NUMBER_TYPES.some((numberType) => type.includes(numberType));
}

function cleanTerm(term: string): string {
  return term.trim();
}

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(limit ?? 20)));
}

function parseNumericTerm(term: string): string | null {
  const trimmed = cleanTerm(term);
  if (!/^[+-]?(?:\d+|\d+\.\d+|\.\d+)$/.test(trimmed)) return null;
  return trimmed;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function likePattern(term: string): string {
  return `%${cleanTerm(term).toLowerCase().replace(/[~%_]/g, (match) => `~${match}`)}%`;
}

function textCastExpression(databaseType: DatabaseType | undefined, identifier: string): string {
  if (databaseType === "mysql") return `LOWER(CAST(${identifier} AS CHAR))`;
  if (databaseType === "sqlserver") return `LOWER(CAST(${identifier} AS NVARCHAR(MAX)))`;
  if (databaseType === "oracle") return `LOWER(CAST(${identifier} AS VARCHAR2(4000)))`;
  if (databaseType === "clickhouse") return `lower(toString(${identifier}))`;
  return `LOWER(CAST(${identifier} AS TEXT))`;
}

function sqlValueLiteral(databaseType: DatabaseType | undefined, column: ColumnInfo | undefined, value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const stringValue = String(value);
  if (column && isNumericSearchColumn(column) && parseNumericTerm(stringValue)) {
    return stringValue.trim();
  }
  if (databaseType === "sqlserver") return `N${sqlStringLiteral(stringValue)}`;
  return sqlStringLiteral(stringValue);
}

export function buildDatabaseSearchSql(options: DatabaseSearchSqlOptions): DatabaseSearchSql | null {
  const term = cleanTerm(options.term);
  if (!term) return null;

  const textColumns = options.columns.filter(isTextSearchColumn);
  const numericTerm = parseNumericTerm(term);
  const numericColumns = numericTerm ? options.columns.filter(isNumericSearchColumn) : [];
  const conditions: string[] = [];

  for (const column of textColumns) {
    const identifier = quoteTableIdentifier(options.databaseType, column.name);
    conditions.push(`${textCastExpression(options.databaseType, identifier)} LIKE ${sqlStringLiteral(likePattern(term))} ESCAPE '~'`);
  }

  for (const column of numericColumns) {
    const identifier = quoteTableIdentifier(options.databaseType, column.name);
    conditions.push(`${identifier} = ${numericTerm}`);
  }

  if (!conditions.length) return null;

  const table = qualifiedTableName({
    databaseType: options.databaseType,
    schema: options.schema,
    tableName: options.tableName,
  });
  const where = conditions.join(" OR ");
  const limit = clampLimit(options.limit);
  const searchableColumns = [...textColumns, ...numericColumns].map((column) => column.name);

  if (options.databaseType === "sqlserver") {
    return {
      sql: `SELECT TOP ${limit} * FROM ${table} WHERE (${where})`,
      searchableColumns,
    };
  }

  if (options.databaseType === "oracle") {
    return {
      sql: `SELECT * FROM ${table} WHERE (${where}) FETCH FIRST ${limit} ROWS ONLY`,
      searchableColumns,
    };
  }

  return {
    sql: `SELECT * FROM ${table} WHERE (${where}) LIMIT ${limit};`,
    searchableColumns,
  };
}

function columnByName(columns: ColumnInfo[], name: string): ColumnInfo | undefined {
  return columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
}

export function findMatchedSearchColumns(
  resultColumns: string[],
  row: unknown[],
  columns: ColumnInfo[],
  term: string,
): string[] {
  const query = cleanTerm(term).toLowerCase();
  const numericTerm = parseNumericTerm(term);
  if (!query) return [];

  const matches: string[] = [];
  resultColumns.forEach((columnName, index) => {
    const value = row[index];
    if (value === null || value === undefined) return;
    const column = columnByName(columns, columnName);
    if (!column || (!isTextSearchColumn(column) && !isNumericSearchColumn(column))) return;

    if (isNumericSearchColumn(column) && numericTerm && String(value).trim() === numericTerm) {
      matches.push(columnName);
      return;
    }

    if (isTextSearchColumn(column) && String(value).toLowerCase().includes(query)) {
      matches.push(columnName);
    }
  });
  return matches;
}

export function buildSearchResultWhere(options: SearchResultWhereOptions): string {
  const valueByColumn = new Map<string, unknown>();
  options.resultColumns.forEach((column, index) => {
    valueByColumn.set(column.toLowerCase(), options.row[index]);
  });

  const primaryColumns = options.columns.filter((column) =>
    column.is_primary_key && valueByColumn.get(column.name.toLowerCase()) !== undefined,
  );
  const fallbackColumns = options.columns.filter((column) =>
    (options.matchedColumns ?? []).some((name) => name.toLowerCase() === column.name.toLowerCase()) &&
    valueByColumn.get(column.name.toLowerCase()) !== undefined,
  );
  const selectedColumns = (primaryColumns.length ? primaryColumns : fallbackColumns).slice(0, 3);

  return selectedColumns
    .map((column) => {
      const identifier = quoteTableIdentifier(options.databaseType, column.name);
      const value = valueByColumn.get(column.name.toLowerCase());
      if (value === null || value === undefined) return `${identifier} IS NULL`;
      return `${identifier} = ${sqlValueLiteral(options.databaseType, column, value)}`;
    })
    .join(" AND ");
}
