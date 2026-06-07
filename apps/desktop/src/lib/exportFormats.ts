import type { DatabaseType } from "@/types/database";
import * as api from "@/lib/api";

export type ExportCellValue = string | number | boolean | null;

export function formatCsv(columns: string[], rows: ExportCellValue[][]): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = columns.map(esc).join(",");
  const body = rows.map((row) => row.map((c) => esc(c === null ? "" : String(c))).join(",")).join("\n");
  return `${header}\n${body}`;
}

export interface FormatSqlInsertOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName?: string;
  qualifiedTableName?: string;
  columns: string[];
  rows: ExportCellValue[][];
}

export function formatSqlInsert(options: FormatSqlInsertOptions): Promise<string> {
  return api.buildExportSqlInsert({
    ...options,
    batchSize: 1,
  });
}
