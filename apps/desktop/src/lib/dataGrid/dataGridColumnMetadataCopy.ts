import { encodeSpreadsheetTsvCell } from "@/lib/common/spreadsheetTsv";

export interface DataGridColumnMetadataForCopy {
  name: string;
  type?: string;
  source?: string;
  nullable?: boolean;
  comment?: string;
}

export function formatDataGridColumnMetadataForCopy(columns: readonly DataGridColumnMetadataForCopy[]): string {
  const rows = [["Name", "Type", "Source", "Nullable", "Comment"], ...columns.map((column) => [column.name, column.type ?? "", column.source ?? "", column.nullable === undefined ? "" : column.nullable ? "YES" : "NO", column.comment ?? ""])];
  return rows.map((row) => row.map(encodeSpreadsheetTsvCell).join("\t")).join("\n");
}
