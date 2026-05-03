import type { GridCellValue } from "./dataGridSql.ts";

export interface MarkdownTableData {
  columns: string[];
  rows: GridCellValue[][];
}

export function formatMarkdownTable(data: MarkdownTableData): string {
  const normalizedColumns = data.columns.map(markdownCell);
  const normalizedRows = data.rows.map((row) => row.map((cell) => markdownCell(displayCell(cell))));
  const widths = normalizedColumns.map((column, index) =>
    Math.max(column.length, ...normalizedRows.map((row) => row[index]?.length ?? 0), 3)
  );
  const header = `| ${normalizedColumns.map((column, index) => pad(column, widths[index])).join(" | ")} |`;
  const separator = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  const body = normalizedRows
    .map((row) => `| ${row.map((cell, index) => pad(cell, widths[index])).join(" | ")} |`)
    .join("\n");
  return `${[header, separator, body].filter(Boolean).join("\n")}\n`;
}

function displayCell(value: GridCellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}
