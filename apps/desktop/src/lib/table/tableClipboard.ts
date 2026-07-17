import type { ColumnInfo, DatabaseType } from "@/types/database";

export type PasteTableMode = "structure-and-data" | "structure-only" | "data-only";

export interface TableClipboardContext {
  connectionId: string;
  database: string;
  schema?: string | null;
}

export interface TableDataCopyColumnOptions {
  columns: string[];
  postgresOverridingSystemValue: boolean;
  sqlserverIdentityInsert: boolean;
}

function normalizeSchema(schema: string | null | undefined): string {
  return schema?.trim() ?? "";
}

export function tableClipboardEntryMatchesTarget(entry: TableClipboardContext, target: TableClipboardContext): boolean {
  return entry.connectionId === target.connectionId && entry.database === target.database && normalizeSchema(entry.schema) === normalizeSchema(target.schema);
}

export function tableClipboardMatchesTarget(entries: TableClipboardContext[], target: TableClipboardContext | null): boolean {
  return !!target && entries.length > 0 && entries.every((entry) => tableClipboardEntryMatchesTarget(entry, target));
}

export function supportsWholeRowTableDataCopy(databaseType: DatabaseType | undefined): boolean {
  return !!databaseType;
}

export function defaultPasteTableMode(databaseType: DatabaseType | undefined): PasteTableMode {
  return supportsWholeRowTableDataCopy(databaseType) ? "structure-and-data" : "structure-only";
}

export function pasteTableModeCopiesData(mode: PasteTableMode): boolean {
  return mode === "structure-and-data" || mode === "data-only";
}

export function tableDataCopyColumnOptions(databaseType: DatabaseType | undefined, columns: ColumnInfo[]): TableDataCopyColumnOptions {
  const writableColumns = columns.filter((column) => isWritableTableDataCopyColumn(databaseType, column));
  return {
    columns: writableColumns.map((column) => column.name),
    postgresOverridingSystemValue: databaseType === "postgres" && writableColumns.some(isIdentityColumn),
    sqlserverIdentityInsert: databaseType === "sqlserver" && writableColumns.some(isIdentityColumn),
  };
}

function isWritableTableDataCopyColumn(databaseType: DatabaseType | undefined, column: ColumnInfo): boolean {
  const extra = (column.extra ?? "").toLowerCase();
  if (databaseType === "mysql") {
    return !extra.includes("generated");
  }
  if (databaseType === "postgres") {
    return !extra.includes("generated always as (");
  }
  if (databaseType === "sqlserver") {
    return !extra.includes("computed");
  }
  return !extra.includes("computed") && !(extra.includes("generated") && !extra.includes("identity"));
}

function isIdentityColumn(column: ColumnInfo): boolean {
  return (column.extra ?? "").toLowerCase().includes("identity");
}
