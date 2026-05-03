import type { ColumnInfo, IndexInfo } from "../types/database.ts";
import type { EditableStructureColumn, EditableStructureIndex } from "./tableStructureEditorSql.ts";

export function createColumnDrafts(columns: ColumnInfo[]): EditableStructureColumn[] {
  return columns.map((column) => ({
    id: `existing:${column.name}`,
    name: column.name,
    dataType: column.data_type,
    isNullable: column.is_nullable,
    defaultValue: column.column_default ?? "",
    comment: column.comment ?? "",
    isPrimaryKey: column.is_primary_key,
    original: column,
    markedForDrop: false,
  }));
}

export function createIndexDrafts(indexes: IndexInfo[]): EditableStructureIndex[] {
  return indexes.map((index) => ({
    id: `existing:${index.name}`,
    name: index.name,
    columns: [...index.columns],
    isUnique: index.is_unique,
    isPrimary: index.is_primary,
    filter: index.filter ?? "",
    indexType: index.index_type ?? "",
    includedColumns: index.included_columns ? [...index.included_columns] : [],
    comment: index.comment ?? "",
    original: index,
    markedForDrop: false,
  }));
}

export function toColumnNames(columns: string[]): string {
  return columns.join(", ");
}
