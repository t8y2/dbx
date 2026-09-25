import type { DatabaseType, QueryResult } from "@/types/database";
import * as api from "@/lib/backend/api";
import { escapeCsvField, type CsvQuoteMode } from "@/lib/export/csvQuoteMode";
import type { SqlInsertMode } from "@/lib/export/sqlInsertMode";

export type ExportCellValue = string | number | boolean | null;

export function formatCsv(columns: string[], rows: ExportCellValue[][], quoteMode: CsvQuoteMode = "all"): string {
  const header = columns.map((column) => escapeCsvField(column, quoteMode)).join(",");
  const body = rows.map((row) => row.map((cell) => (cell === null ? "" : escapeCsvField(String(cell), quoteMode))).join(",")).join("\n");
  return `${header}\n${body}`;
}

// Tab-separated values with a header row, mirroring Navicat's "Text File (*.txt)"
// export: fields are joined by a tab and NULL becomes empty. A field is wrapped
// in double quotes only when it contains a tab or a line break - the characters
// that would otherwise corrupt the TSV row/column shape. A field that merely
// contains a double quote is emitted verbatim: TSV is parsed by splitting on the
// tab alone (there is no quote state machine on paste-back), so quoting such a
// value would corrupt it (e.g. a value of `"abc"` must not become `"""abc"""`).
export function formatTsv(columns: string[], rows: ExportCellValue[][]): string {
  const esc = (value: ExportCellValue) => {
    const text = value === null ? "" : String(value);
    if (text.includes("\t") || text.includes("\n") || text.includes("\r")) {
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
  identifierQuote?: string;
  schema?: string;
  tableName?: string;
  qualifiedTableName?: string;
  columns: string[];
  columnTypes?: Array<string | null | undefined>;
  /** 与 `columns` 对齐的列 EXTRA 元数据，用于 identity 列的 `SET IDENTITY_INSERT` 包裹。 */
  columnExtras?: Array<string | null | undefined>;
  spatialColumns?: QueryResult["spatial_columns"];
  spatialValues?: QueryResult["spatial_values"];
  rows: ExportCellValue[][];
  insertMode?: SqlInsertMode;
  excludeColumns?: string[];
}

export function formatSqlInsert({ insertMode = "batch", ...options }: FormatSqlInsertOptions): Promise<string> {
  return api.buildExportSqlInsert({
    ...options,
    batchSize: insertMode === "single" ? 1 : undefined,
  });
}
