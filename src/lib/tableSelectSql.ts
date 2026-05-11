import type { DatabaseType } from "../types/database.ts";
import { isSchemaAware, usesFetchFirst } from "./databaseCapabilities.ts";
import { DBX_ROWID_COLUMN } from "./tableEditing.ts";

export interface BuildTableSelectSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  primaryKeys?: string[];
  fallbackOrderColumns?: string[];
  orderBy?: string;
  limit?: number;
  offset?: number;
  whereInput?: string;
  includeRowId?: boolean;
}

export function quoteTableIdentifier(databaseType: DatabaseType | undefined, name: string): string {
  if (databaseType === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (databaseType === "sqlserver") return `[${name.replace(/\]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

function isOracleRowId(databaseType: DatabaseType | undefined, name: string): boolean {
  return databaseType === "oracle" && name.toUpperCase() === DBX_ROWID_COLUMN;
}

function quoteOrderIdentifier(databaseType: DatabaseType | undefined, name: string, tableAlias?: string): string {
  if (isOracleRowId(databaseType, name)) return tableAlias ? `${tableAlias}.ROWID` : "ROWID";
  return quoteTableIdentifier(databaseType, name);
}

export function qualifiedTableName(
  options: Pick<BuildTableSelectSqlOptions, "databaseType" | "schema" | "tableName">,
): string {
  const { databaseType, schema, tableName } = options;
  if (isSchemaAware(databaseType) && schema) {
    return `${quoteTableIdentifier(databaseType, schema)}.${quoteTableIdentifier(databaseType, tableName)}`;
  }
  return quoteTableIdentifier(databaseType, tableName);
}

export function normalizeWhereInput(whereInput?: string): string {
  const withoutSemicolon = whereInput?.trim().replace(/;+$/, "").trim() ?? "";
  return withoutSemicolon.replace(/^where\b/i, "").trim();
}

export function buildTableSelectSql(options: BuildTableSelectSqlOptions): string {
  const databaseType = options.databaseType;
  const limit = options.limit ?? 100;
  const table = qualifiedTableName(options);
  const predicate = normalizeWhereInput(options.whereInput);
  const where = predicate ? ` WHERE (${predicate})` : "";
  const rowIdAlias = options.includeRowId && databaseType === "oracle" ? "t" : undefined;
  const defaultOrderBy = options.primaryKeys?.length
    ? options.primaryKeys.map((pk) => `${quoteOrderIdentifier(databaseType, pk, rowIdAlias)} ASC`).join(", ")
    : options.fallbackOrderColumns?.length
      ? options.fallbackOrderColumns.map((column) => `${quoteTableIdentifier(databaseType, column)} ASC`).join(", ")
      : undefined;
  const orderBy = options.orderBy ?? defaultOrderBy;
  const order = orderBy ? ` ORDER BY ${orderBy}` : "";

  const selectColumns =
    options.includeRowId && databaseType === "oracle" ? `ROWIDTOCHAR(t.ROWID) AS "${DBX_ROWID_COLUMN}", t.*` : "*";
  const tableAlias = options.includeRowId && usesFetchFirst(databaseType) ? `${table} t` : table;

  if (usesFetchFirst(databaseType)) {
    const offset = options.offset ? ` OFFSET ${options.offset} ROWS` : "";
    return `SELECT ${selectColumns} FROM ${tableAlias}${where}${order}${offset} FETCH FIRST ${limit} ROWS ONLY`;
  }

  if (databaseType === "sqlserver") {
    const stableOrder = order || " ORDER BY (SELECT NULL)";
    return `SELECT * FROM ${table}${where}${stableOrder} OFFSET ${options.offset ?? 0} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }

  const offset = options.offset ? ` OFFSET ${options.offset}` : "";
  return `SELECT * FROM ${table}${where}${order} LIMIT ${limit}${offset};`;
}
