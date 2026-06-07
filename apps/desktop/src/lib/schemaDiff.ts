import type { ColumnInfo, IndexInfo, ForeignKeyInfo, TriggerInfo, DatabaseType, TableInfo } from "@/types/database";

export interface ColumnDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: ColumnInfo;
  target?: ColumnInfo;
  changes?: string[];
}

export interface IndexDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: IndexInfo;
  target?: IndexInfo;
  changes?: string[];
}

export interface ForeignKeyDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: ForeignKeyInfo;
  target?: ForeignKeyInfo;
  changes?: string[];
}

export interface TriggerDiff {
  type: "added" | "removed" | "modified";
  name: string;
  source?: TriggerInfo;
  target?: TriggerInfo;
  changes?: string[];
}

export interface TableDiff {
  type: "added" | "removed" | "modified";
  objectType?: "table" | "view";
  name: string;
  columns?: ColumnDiff[];
  indexes?: IndexDiff[];
  foreignKeys?: ForeignKeyDiff[];
  triggers?: TriggerDiff[];
  ddl?: string;
  sourceTableComment?: string | null;
  targetTableComment?: string | null;
}

export interface TableSchemaDetail {
  name: string;
  columns?: ColumnInfo[];
  indexes?: IndexInfo[];
  foreignKeys?: ForeignKeyInfo[];
  triggers?: TriggerInfo[];
  ddl?: string;
}

export interface SchemaDiffPreparationOptions {
  sourceTables: TableInfo[];
  targetTables: TableInfo[];
  sourceDetails: TableSchemaDetail[];
  targetDetails: TableSchemaDetail[];
  databaseType: DatabaseType;
  targetSchema?: string;
  ignoreComments?: boolean;
}

export interface SchemaDiffPreparation {
  diffs: TableDiff[];
  syncSql: string;
}
