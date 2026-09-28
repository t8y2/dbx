export type CsvQuoteMode = "all" | "necessary";

export const DEFAULT_CSV_QUOTE_MODE: CsvQuoteMode = "all";

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
