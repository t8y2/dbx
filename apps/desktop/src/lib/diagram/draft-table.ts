import type { ColumnInfo, DatabaseType } from "@/types/database";
import type { DiagramTable } from "./erDiagram";
import { editableStructureIndexes, hasDroppedColumns, hasPendingColumns, isPendingColumn } from "./erDiagram";
import type { BuildTableStructureChangeSqlOptions, EditableStructureColumn, EditableStructureIndex } from "@/lib/table/tableStructureEditorSql";
import { generateUniqueIndexName } from "@/lib/table/tableStructureEditorState";
import { resolveDiagramDialectAdapter } from "./diagram-dialect-adapter";

export function createDefaultIdColumn(databaseType?: DatabaseType): ColumnInfo {
  return resolveDiagramDialectAdapter(databaseType).createDefaultIdColumn();
}

export function createEmptyColumn(name = "column_1", databaseType?: DatabaseType): ColumnInfo {
  return resolveDiagramDialectAdapter(databaseType).createEmptyColumn(name);
}

export function createDraftTable(name: string, options?: { withDefaultId?: boolean; databaseType?: DatabaseType }): DiagramTable {
  const withDefaultId = options?.withDefaultId !== false;
  const adapter = resolveDiagramDialectAdapter(options?.databaseType);
  return {
    name: name.trim(),
    columns: withDefaultId ? [adapter.createDefaultIdColumn()] : [],
    foreignKeys: [],
    indexes: [],
    origin: "draft",
    syncStatus: "pending",
  };
}

export function createDraftIndex(tableName: string, columns: string[], existingIndexes: EditableStructureIndex[] = []): EditableStructureIndex {
  const existingNames = existingIndexes.map((index) => index.name);
  const name = generateUniqueIndexName(tableName, columns, existingNames) || `idx_${tableName}`;
  return {
    id: `idx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    columns: [...columns],
    isUnique: false,
    isPrimary: false,
    filter: "",
    indexType: "",
    includedColumns: [],
    comment: "",
    markedForDrop: false,
  };
}

export function columnToEditable(column: ColumnInfo, index: number): EditableStructureColumn {
  return {
    id: `col-${index}-${column.name}`,
    name: column.name,
    dataType: column.data_type,
    enumValues: column.enum_values ?? undefined,
    isNullable: column.is_nullable,
    defaultValue: column.column_default ?? "",
    comment: column.comment ?? "",
    isPrimaryKey: column.is_primary_key,
    extra: {},
    characterSet: column.character_set ?? undefined,
    collation: column.collation ?? undefined,
    markedForDrop: false,
  };
}

export function draftTableToCreateSqlOptions(table: DiagramTable, databaseType: DatabaseType | undefined, schema: string | undefined): BuildTableStructureChangeSqlOptions {
  return {
    databaseType,
    schema: schema || undefined,
    tableName: table.name,
    columns: table.columns.map(columnToEditable),
    indexes: editableStructureIndexes(table).filter((index) => !index.markedForDrop),
    foreignKeys: [],
    triggers: [],
  };
}

/** Live table pending adds/drops → ALTER ADD / DROP COLUMN. */
export function liveTableToAlterSqlOptions(table: DiagramTable, databaseType: DatabaseType | undefined, schema: string | undefined): BuildTableStructureChangeSqlOptions {
  const pending = new Set(table.pendingColumnNames ?? []);
  const dropped = new Set(table.droppedColumnNames ?? []);
  return {
    databaseType,
    schema: schema || undefined,
    tableName: table.name,
    columns: table.columns.map((column, index) => {
      const editable = columnToEditable(column, index);
      if (pending.has(column.name)) {
        return editable;
      }
      return {
        ...editable,
        original: { ...column },
        originalPosition: index + 1,
        markedForDrop: dropped.has(column.name),
      };
    }),
    indexes: [],
    foreignKeys: [],
    triggers: [],
  };
}

export function nextUniqueColumnName(columns: ColumnInfo[], base = "column"): string {
  const names = new Set(columns.map((c) => c.name.toLowerCase()));
  let i = 1;
  while (names.has(`${base}_${i}`.toLowerCase())) i += 1;
  return `${base}_${i}`;
}

export function validateDraftTable(table: DiagramTable): string[] {
  const errors: string[] = [];
  if (!table.name.trim()) errors.push("Table name is required");
  if (table.columns.length === 0) errors.push(`Table "${table.name}" needs at least one column`);
  const seen = new Set<string>();
  for (const col of table.columns) {
    if (!col.name.trim()) errors.push(`Table "${table.name}" has an empty column name`);
    const key = col.name.toLowerCase();
    if (seen.has(key)) errors.push(`Table "${table.name}" has duplicate column "${col.name}"`);
    seen.add(key);
    if (!col.data_type.trim()) errors.push(`Column "${table.name}.${col.name}" needs a type`);
  }
  const columnNames = new Set(table.columns.map((c) => c.name.toLowerCase()));
  for (const index of editableStructureIndexes(table)) {
    if (index.markedForDrop) continue;
    if (!index.name.trim()) errors.push(`Table "${table.name}" has an index with an empty name`);
    if (index.columns.length === 0) errors.push(`Index "${index.name || "(unnamed)"}" on "${table.name}" needs at least one column`);
    for (const col of index.columns) {
      if (!columnNames.has(col.toLowerCase())) {
        errors.push(`Index "${index.name}" references missing column "${col}"`);
      }
    }
  }
  return errors;
}

/** Validate pending ADD columns and DROP column marks on a live table before ALTER sync. */
export function validateLivePendingColumns(table: DiagramTable): string[] {
  const errors: string[] = [];
  if (!hasPendingColumns(table) && !hasDroppedColumns(table)) return errors;
  const pendingNames = table.pendingColumnNames ?? [];
  const existingNames = new Set(table.columns.filter((col) => !isPendingColumn(table, col.name)).map((col) => col.name.toLowerCase()));
  const seenPending = new Set<string>();
  for (const name of pendingNames) {
    const col = table.columns.find((c) => c.name === name);
    if (!col) {
      errors.push(`Table "${table.name}" pending column "${name}" is missing`);
      continue;
    }
    if (!col.name.trim()) errors.push(`Table "${table.name}" has an empty pending column name`);
    const key = col.name.toLowerCase();
    if (seenPending.has(key)) errors.push(`Table "${table.name}" has duplicate pending column "${col.name}"`);
    seenPending.add(key);
    if (existingNames.has(key)) {
      errors.push(`Table "${table.name}" pending column conflicts with existing "${col.name}"`);
    }
    if (!col.data_type.trim()) errors.push(`Column "${table.name}.${col.name}" needs a type`);
  }
  const seenDropped = new Set<string>();
  for (const name of table.droppedColumnNames ?? []) {
    const key = name.toLowerCase();
    if (seenDropped.has(key)) {
      errors.push(`Table "${table.name}" has duplicate dropped column "${name}"`);
      continue;
    }
    seenDropped.add(key);
    if (isPendingColumn(table, name)) {
      errors.push(`Table "${table.name}" cannot drop pending column "${name}"`);
      continue;
    }
    if (!table.columns.some((col) => col.name === name)) {
      errors.push(`Table "${table.name}" dropped column "${name}" is missing`);
    }
  }
  return errors;
}

export function hasLiveColumnChanges(table: DiagramTable): boolean {
  return hasPendingColumns(table) || hasDroppedColumns(table);
}
