import type { DatabaseType } from "@/types/database";
import { DBX_ROWID_COLUMN } from "./tableEditing.ts";
import { qualifiedTableName, quoteTableIdentifier } from "./tableSelectSql.ts";

export type GridCellValue = string | number | boolean | null;

export interface DataGridTableMeta {
  schema?: string;
  tableName: string;
  primaryKeys: string[];
}

export interface DataGridColumnInfo {
  name: string;
  is_nullable: boolean;
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

export interface DataGridSaveValidationOptions {
  databaseType?: DatabaseType;
  columns: string[];
  columnInfo?: DataGridColumnInfo[];
  dirtyRows: Array<[number, Array<[number, GridCellValue]>]>;
  newRows: GridCellValue[][];
}

export function validateDataGridSave(options: DataGridSaveValidationOptions): string | undefined {
  const notNullColumns = new Set(
    (options.columnInfo ?? [])
      .filter((column) => !column.is_nullable && !isOracleRowId(options.databaseType, column.name))
      .map((column) => normalizeColumnName(column.name)),
  );
  if (notNullColumns.size === 0) return undefined;

  for (const [, changes] of options.dirtyRows) {
    for (const [columnIndex, value] of changes) {
      const column = options.columns[columnIndex];
      if (isNullWriteToNotNullColumn(options.databaseType, notNullColumns, column, value)) {
        return nullWriteError(column);
      }
    }
  }

  for (const row of options.newRows) {
    for (const [columnIndex, column] of options.columns.entries()) {
      if (isNullWriteToNotNullColumn(options.databaseType, notNullColumns, column, row[columnIndex])) {
        return nullWriteError(column);
      }
    }
  }

  return undefined;
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
      .filter(([columnIndex]) => !isOracleRowId(options.databaseType, options.columns[columnIndex]))
      .map(
        ([columnIndex, value]) =>
          `${quoteIdent(options.databaseType, options.columns[columnIndex])} = ${formatGridSqlLiteral(value, options.databaseType)}`,
      )
      .join(", ");
    if (!sets) continue;
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
    const insertPairs = options.columns
      .map((column, index) => ({ column, value: row[index] }))
      .filter((pair) => !isOracleRowId(options.databaseType, pair.column));
    const columns = insertPairs.map((pair) => quoteIdent(options.databaseType, pair.column)).join(", ");
    const values = insertPairs.map((pair) => formatGridSqlLiteral(pair.value, options.databaseType)).join(", ");
    statements.push(`INSERT INTO ${table} (${columns}) VALUES (${values});`);
  }

  return statements;
}

export function buildDataGridRollbackStatements(options: DataGridSaveStatementOptions): string[] {
  const table = qualifiedTableName({
    databaseType: options.databaseType,
    schema: options.tableMeta.schema,
    tableName: options.tableMeta.tableName,
  });
  const statements: string[] = [];

  for (const row of options.newRows) {
    const where = buildRowWhere(options.databaseType, options.columns, row);
    if (where) statements.push(`DELETE FROM ${table} WHERE ${where};`);
  }

  for (const rowIndex of options.deletedRows) {
    const row = options.rows[rowIndex];
    if (!row) continue;
    const insertPairs = options.columns
      .map((column, index) => ({ column, value: row[index] }))
      .filter((pair) => !isOracleRowId(options.databaseType, pair.column));
    const columns = insertPairs.map((pair) => quoteIdent(options.databaseType, pair.column)).join(", ");
    const values = insertPairs.map((pair) => formatGridSqlLiteral(pair.value, options.databaseType)).join(", ");
    statements.push(`INSERT INTO ${table} (${columns}) VALUES (${values});`);
  }

  for (const [rowIndex, changes] of options.dirtyRows) {
    const row = options.rows[rowIndex];
    if (!row) continue;
    const afterRow = [...row];
    for (const [columnIndex, value] of changes) {
      afterRow[columnIndex] = value;
    }
    const writableChanges = changes.filter(
      ([columnIndex]) => !isOracleRowId(options.databaseType, options.columns[columnIndex]),
    );
    const sets = writableChanges
      .map(
        ([columnIndex]) =>
          `${quoteIdent(options.databaseType, options.columns[columnIndex])} = ${formatGridSqlLiteral(row[columnIndex], options.databaseType)}`,
      )
      .join(", ");
    if (!sets) continue;
    const where = [
      buildPrimaryKeyWhere(options.databaseType, options.tableMeta.primaryKeys, options.columns, afterRow),
      ...writableChanges.map(([columnIndex, value]) =>
        buildColumnPredicate(options.databaseType, options.columns[columnIndex], value),
      ),
    ]
      .filter(Boolean)
      .join(" AND ");
    statements.push(`UPDATE ${table} SET ${sets} WHERE ${where};`);
  }

  return statements;
}

export function dataGridSaveExecutionSchema(
  databaseType: DatabaseType | undefined,
  tableMeta: DataGridTableMeta | undefined,
): string | undefined {
  if (databaseType === "oracle") return undefined;
  return tableMeta?.schema;
}

export function formatGridSqlLiteral(value: GridCellValue, databaseType?: DatabaseType): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const text = String(value);
  if (text === "") return databaseType === "sqlserver" ? "N''" : "''";
  const escaped = `'${text.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  return databaseType === "sqlserver" ? `N${escaped}` : escaped;
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
      return `${predicateIdent(databaseType, primaryKey)} = ${formatGridSqlLiteral(value, databaseType)}`;
    })
    .join(" AND ");
}

function buildRowWhere(databaseType: DatabaseType | undefined, columns: string[], row: GridCellValue[]): string {
  return columns
    .map((column, index) =>
      isOracleRowId(databaseType, column) ? "" : buildColumnPredicate(databaseType, column, row[index]),
    )
    .filter(Boolean)
    .join(" AND ");
}

function buildColumnPredicate(databaseType: DatabaseType | undefined, column: string, value: GridCellValue): string {
  const ident = predicateIdent(databaseType, column);
  if (value === null || value === undefined) return `${ident} IS NULL`;
  return `${ident} = ${formatGridSqlLiteral(value, databaseType)}`;
}

function isOracleRowId(databaseType: DatabaseType | undefined, name: string | undefined): boolean {
  return databaseType === "oracle" && name?.toUpperCase() === DBX_ROWID_COLUMN;
}

function isNullWriteToNotNullColumn(
  databaseType: DatabaseType | undefined,
  notNullColumns: Set<string>,
  column: string | undefined,
  value: GridCellValue,
): boolean {
  if (!column || isOracleRowId(databaseType, column)) return false;
  return value === null && notNullColumns.has(normalizeColumnName(column));
}

function normalizeColumnName(name: string): string {
  return name.toUpperCase();
}

function nullWriteError(column: string): string {
  return `Column "${column}" does not allow NULL.`;
}

function predicateIdent(databaseType: DatabaseType | undefined, name: string): string {
  return isOracleRowId(databaseType, name) ? "ROWIDTOCHAR(ROWID)" : quoteIdent(databaseType, name);
}

function quoteIdent(databaseType: DatabaseType | undefined, name: string): string {
  return quoteTableIdentifier(databaseType, name);
}
