import type { DatabaseType } from "@/types/database";
import { qualifiedTableName, quoteTableIdentifier } from "./tableSelectSql.ts";

export type GridCellValue = string | number | boolean | null;

export interface DataGridTableMeta {
  schema?: string;
  tableName: string;
  primaryKeys: string[];
}

export interface DataGridSaveStatementOptions {
  databaseType?: DatabaseType;
  tableMeta: DataGridTableMeta;
  columns: string[];
  rows: GridCellValue[][];
  dirtyRows: Array<[number, Array<[number, GridCellValue]>]>;
  deletedRows: number[];
  newRows: GridCellValue[][];
}

export function buildDataGridSaveStatements(options: DataGridSaveStatementOptions): string[] {
  const table = qualifiedTableName({
    databaseType: options.databaseType,
    schema: options.tableMeta.schema,
    tableName: options.tableMeta.tableName,
  });
  const statements: string[] = [];

  for (const [rowIndex, changes] of options.dirtyRows) {
    const row = options.rows[rowIndex];
    if (!row) continue;
    const sets = changes
      .map(([columnIndex, value]) => `${quoteIdent(options.databaseType, options.columns[columnIndex])} = ${formatGridSqlLiteral(value)}`)
      .join(", ");
    const where = buildPrimaryKeyWhere(options.databaseType, options.tableMeta.primaryKeys, options.columns, row);
    statements.push(`UPDATE ${table} SET ${sets} WHERE ${where};`);
  }

  for (const rowIndex of options.deletedRows) {
    const row = options.rows[rowIndex];
    if (!row) continue;
    const where = buildPrimaryKeyWhere(options.databaseType, options.tableMeta.primaryKeys, options.columns, row);
    statements.push(`DELETE FROM ${table} WHERE ${where};`);
  }

  for (const row of options.newRows) {
    const columns = options.columns.map((column) => quoteIdent(options.databaseType, column)).join(", ");
    const values = row.map(formatGridSqlLiteral).join(", ");
    statements.push(`INSERT INTO ${table} (${columns}) VALUES (${values});`);
  }

  return statements;
}

export function formatGridSqlLiteral(value: GridCellValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const text = String(value);
  if (text === "") return "''";
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function buildPrimaryKeyWhere(
  databaseType: DatabaseType | undefined,
  primaryKeys: string[],
  columns: string[],
  row: GridCellValue[],
): string {
  return primaryKeys
    .map((primaryKey) => {
      const value = row[columns.indexOf(primaryKey)];
      return `${quoteIdent(databaseType, primaryKey)} = ${formatGridSqlLiteral(value)}`;
    })
    .join(" AND ");
}

function quoteIdent(databaseType: DatabaseType | undefined, name: string): string {
  return quoteTableIdentifier(databaseType, name);
}
