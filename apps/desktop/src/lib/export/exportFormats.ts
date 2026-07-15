import type { DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";

export type ExportCellValue = string | number | boolean | null;

export function formatCsv(columns: string[], rows: ExportCellValue[][]): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = columns.map(esc).join(",");
  const body = rows.map((row) => row.map((c) => (c === null ? "" : esc(String(c)))).join(",")).join("\n");
  return `${header}\n${body}`;
}

// Tab-separated values with a header row, mirroring Navicat's "Text File (*.txt)"
// export: fields are joined by a tab, NULL becomes empty, and a field is only
// wrapped in double quotes (with " doubled) when it contains a tab, newline,
// or quote - i.e. the minimum needed to round-trip the value.
export function formatTsv(columns: string[], rows: ExportCellValue[][]): string {
  const esc = (value: ExportCellValue) => {
    const text = value === null ? "" : String(value);
    if (text.includes("\t") || text.includes("\n") || text.includes("\r") || text.includes('"')) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };
  const header = columns.map(esc).join("\t");
  const body = rows.map((row) => row.map(esc).join("\t")).join("\n");
  return `${header}\n${body}`;
}

export interface FormatSqlInsertOptions {
  databaseType?: DatabaseType;
  schema?: string;
  tableName?: string;
  qualifiedTableName?: string;
  columns: string[];
  columnTypes?: Array<string | null | undefined>;
  rows: ExportCellValue[][];
}

export function formatSqlInsert(options: FormatSqlInsertOptions): Promise<string> {
  return api.buildExportSqlInsert({
    ...options,
    batchSize: 1,
  });
}
