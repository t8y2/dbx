import type { ColumnInfo, DatabaseType, ForeignKeyInfo, IndexInfo, TriggerInfo } from "../types/database.ts";

export interface ColumnIdentity {
  generation?: "BY DEFAULT" | "ALWAYS";
  seed?: number;
  increment?: number;
}

export interface ColumnExtra {
  autoIncrement?: boolean;
  onUpdateCurrentTimestamp?: boolean;
  identity?: ColumnIdentity;
  manticoreIndexed?: boolean;
  manticoreStored?: boolean;
  manticoreAttribute?: boolean;
  manticoreSecondaryIndex?: boolean;
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
  nameEdited?: boolean;
  isUnique: boolean;
  isPrimary: boolean;
  filter: string;
  indexType: string;
  includedColumns: string[];
  comment: string;
  original?: IndexInfo;
  markedForDrop: boolean;
}

export interface EditableStructureForeignKey {
  id: string;
  name: string;
  column: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
  onUpdate: string;
  onDelete: string;
  original?: ForeignKeyInfo;
  markedForDrop: boolean;
}

export interface EditableStructureTrigger {
  id: string;
  name: string;
  timing: string;
  event: string;
  statement: string;
  original?: TriggerInfo;
  markedForDrop: boolean;
}

export interface BuildTableStructureChangeSqlOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName: string;
  columns: EditableStructureColumn[];
  indexes: EditableStructureIndex[];
  foreignKeys?: EditableStructureForeignKey[];
  triggers?: EditableStructureTrigger[];
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