/**
 * Markdown "wide table" (transposed) export.
 *
 * Regular Markdown exports render one table row per result row and one column
 * per result column. A wide table flips that shape: every result column becomes
 * a row, so a result with dozens or hundreds of columns stays readable in chat
 * or documentation. The first two columns carry the field name and its comment,
 * the remaining columns carry the selected rows (at most
 * MARKDOWN_WIDE_TABLE_MAX_ROWS).
 */

export const MARKDOWN_WIDE_TABLE_MAX_ROWS = 8;

export interface MarkdownWideTableOptions {
  /** Upper bound on data columns; defaults to MARKDOWN_WIDE_TABLE_MAX_ROWS. */
  maxRows?: number;
  /** Labels for the two heading columns. */
  fieldNameLabel?: string;
  fieldCommentLabel?: string;
  /** Builds the per-row heading, e.g. `行1`. */
  rowLabel?: (index: number) => string;
}

export interface MarkdownWideTableResult {
  markdown: string;
  rowCount: number;
  truncated: boolean;
}

/** Escape a cell so pipes and line breaks cannot break the table layout. */
export function escapeMarkdownWideCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\r\n|\r|\n/g, "<br>")
    .replace(/\|/g, "\\|");
}

export function formatMarkdownWideTable(columns: readonly string[], comments: readonly (string | null | undefined)[] | undefined, rows: readonly (readonly unknown[])[], options: MarkdownWideTableOptions = {}): MarkdownWideTableResult {
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? MARKDOWN_WIDE_TABLE_MAX_ROWS));
  const rowCount = Math.min(rows.length, maxRows);
  const rowLabel = options.rowLabel ?? ((index: number) => `行${index + 1}`);
  const header = [options.fieldNameLabel ?? "字段名", options.fieldCommentLabel ?? "字段描述", ...Array.from({ length: rowCount }, (_, index) => rowLabel(index))];
  const lines = [`| ${header.map(escapeMarkdownWideCell).join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];

  columns.forEach((column, columnIndex) => {
    const cells = [column, comments?.[columnIndex] ?? "", ...rows.slice(0, rowCount).map((row) => row[columnIndex])];
    lines.push(`| ${cells.map(escapeMarkdownWideCell).join(" | ")} |`);
  });

  return { markdown: `${lines.join("\n")}\n`, rowCount, truncated: rows.length > rowCount };
}
