import { encodeSpreadsheetTsvCell } from "@/lib/common/spreadsheetTsv";

export interface TableClipboardColumn<T> {
  label: string;
  value: (row: T) => string | undefined;
}

/** Formats rows as a spreadsheet-friendly TSV document with a header row. */
export function formatRowsAsSpreadsheetTsv<T>(rows: readonly T[], columns: readonly TableClipboardColumn<T>[]): string {
  const lines = [columns.map((column) => encodeSpreadsheetTsvCell(column.label)).join("\t")];
  for (const row of rows) lines.push(columns.map((column) => encodeSpreadsheetTsvCell(column.value(row))).join("\t"));
  return lines.join("\n");
}
