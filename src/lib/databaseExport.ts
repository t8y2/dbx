import type { DatabaseType, QueryResult } from "../types/database.ts";
import { buildTableSelectSql } from "./tableSelectSql.ts";

type SqlValue = QueryResult["rows"][number][number];

export const DATABASE_EXPORT_ROW_LIMIT = 10_000;
export const DATABASE_EXPORT_PAGE_SIZE = 500;
export const DATABASE_EXPORT_INSERT_BATCH_SIZE = 100;

export interface ExportedTableSql {
  displayName: string;
  qualifiedTableName: string;
  ddl?: string;
  columns: string[];
  rows: QueryResult["rows"];
  truncated?: boolean;
}

export interface BuildDatabaseSqlExportOptions {
  databaseName: string;
  exportedAt?: Date;
  tables: ExportedTableSql[];
  quoteIdentifier: (name: string) => string;
  rowLimitPerTable?: number;
  insertBatchSize?: number;
}

export interface BuildExportPageSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  limit?: number;
  offset?: number;
}

export function formatSqlLiteral(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildInsertStatements(
  table: Pick<ExportedTableSql, "qualifiedTableName" | "columns" | "rows"> & {
    quoteIdentifier: (name: string) => string;
    batchSize?: number;
  },
): string[] {
  if (table.columns.length === 0 || table.rows.length === 0) return [];
  const batchSize = Math.max(1, table.batchSize ?? DATABASE_EXPORT_INSERT_BATCH_SIZE);
  const columns = table.columns.map((column) => table.quoteIdentifier(column)).join(", ");
  const statements: string[] = [];

  for (let start = 0; start < table.rows.length; start += batchSize) {
    const values = table.rows
      .slice(start, start + batchSize)
      .map((row) => `(${row.map(formatSqlLiteral).join(", ")})`)
      .join(", ");
    statements.push(`INSERT INTO ${table.qualifiedTableName} (${columns}) VALUES ${values};`);
  }

  return statements;
}

export function buildExportPageSql(options: BuildExportPageSqlOptions): string {
  return buildTableSelectSql({
    databaseType: options.databaseType,
    schema: options.schema,
    tableName: options.tableName,
    limit: options.limit ?? DATABASE_EXPORT_PAGE_SIZE,
    offset: options.offset,
  });
}

export function buildDatabaseSqlExport(options: BuildDatabaseSqlExportOptions): string {
  const exportedAt = options.exportedAt ?? new Date();
  const rowLimit = options.rowLimitPerTable ?? DATABASE_EXPORT_ROW_LIMIT;
  const insertBatchSize = options.insertBatchSize ?? DATABASE_EXPORT_INSERT_BATCH_SIZE;
  const lines: string[] = [
    "-- DBX database export",
    `-- Database: ${options.databaseName}`,
    `-- Exported at: ${exportedAt.toISOString()}`,
    `-- Row limit per table: ${rowLimit}`,
    "",
  ];

  for (const table of options.tables) {
    if (table.ddl?.trim()) {
      lines.push(`-- Structure for ${table.displayName}`);
      lines.push(table.ddl.trim().replace(/;*$/, ";"));
      lines.push("");
    }

    lines.push(`-- Data for ${table.displayName}`);
    lines.push(table.truncated
      ? `-- Exported rows: ${table.rows.length} (truncated at ${rowLimit})`
      : `-- Exported rows: ${table.rows.length}`);
    const inserts = buildInsertStatements({ ...table, quoteIdentifier: options.quoteIdentifier, batchSize: insertBatchSize });
    if (inserts.length > 0) {
      lines.push(...inserts);
    } else {
      lines.push("-- No rows");
    }
    lines.push("");
  }

  return lines.join("\n");
}
