export type CsvQuoteMode = "all" | "necessary";

export const DEFAULT_CSV_QUOTE_MODE: CsvQuoteMode = "all";

/**
 * 与 Rust `dbx_formats::csv_export::DEFAULT_CSV_NULL_LITERAL` 保持一致：
 * 导出 CSV 时 NULL 写成该字面量，空字符串才写成空字段，两者在文件里可区分。
 * 显式传空串表示关闭该字面量（旧行为：NULL 与空字符串都写成空字段）。
 */
export const DEFAULT_CSV_NULL_LITERAL = "\\N";

export function normalizeCsvQuoteMode(value: unknown): CsvQuoteMode {
  return value === "necessary" ? "necessary" : DEFAULT_CSV_QUOTE_MODE;
}

export function csvFieldNeedsQuotes(value: string): boolean {
  return /[",\r\n]/.test(value);
}

export function escapeCsvField(value: string, quoteMode: CsvQuoteMode): string {
  if (quoteMode === "necessary" && !csvFieldNeedsQuotes(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
