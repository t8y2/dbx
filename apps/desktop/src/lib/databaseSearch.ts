import type { ColumnInfo, DatabaseType } from "../types/database.ts";
import * as api from "./api.ts";

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

const TEXT_TYPES = ["char", "text", "clob", "varchar", "nvarchar", "nchar", "uuid", "uniqueidentifier", "enum"];

const NUMBER_TYPES = ["int", "serial", "number", "numeric", "decimal", "float", "double", "real", "money"];

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

function parseNumericTerm(term: string): string | null {
  const trimmed = cleanTerm(term);
  if (!/^[+-]?(?:\d+|\d+\.\d+|\.\d+)$/.test(trimmed)) return null;
  return trimmed;
}

export async function buildDatabaseSearchSql(options: DatabaseSearchSqlOptions): Promise<DatabaseSearchSql | null> {
  return api.buildDatabaseSearchSql(options);
}

function columnByName(columns: ColumnInfo[], name: string): ColumnInfo | undefined {
  return columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
}

export function findMatchedSearchColumns(resultColumns: string[], row: unknown[], columns: ColumnInfo[], term: string): string[] {
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

export async function buildSearchResultWhere(options: SearchResultWhereOptions): Promise<string> {
  return api.buildSearchResultWhere(options);
}
