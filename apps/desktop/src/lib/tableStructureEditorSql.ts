import type { ColumnInfo, DatabaseType, IndexInfo } from "../types/database.ts";

export interface ColumnIdentity {
  generation?: "BY DEFAULT" | "ALWAYS";
  seed?: number;
  increment?: number;
}

export interface ColumnExtra {
  autoIncrement?: boolean;
  onUpdateCurrentTimestamp?: boolean;
  identity?: ColumnIdentity;
}

export interface EditableStructureColumn {
  id: string;
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string;
  comment: string;
  isPrimaryKey: boolean;
  extra: ColumnExtra;
  original?: ColumnInfo;
  originalPosition?: number;
  markedForDrop: boolean;
}

export interface EditableStructureIndex {
  id: string;
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  filter: string;
  indexType: string;
  includedColumns: string[];
  comment: string;
  original?: IndexInfo;
  markedForDrop: boolean;
}

export interface BuildTableStructureChangeSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  columns: EditableStructureColumn[];
  indexes: EditableStructureIndex[];
  tableComment?: string;
  originalTableComment?: string;
}

export interface TableStructureChangeSql {
  statements: string[];
  warnings: string[];
}

export interface BuildSingleColumnAlterSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  column: EditableStructureColumn;
}
