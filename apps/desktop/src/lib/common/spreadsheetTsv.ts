export function encodeSpreadsheetTsvCell(value: string | undefined): string {
  if (value === undefined) return "";
  const guarded = guardSpreadsheetFormula(value);
  return /[\t\r\n"]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function guardSpreadsheetFormula(value: string): string {
  const candidate = value.replace(/^ +/, "");
  if (candidate.startsWith("-") && isExactSpreadsheetDecimal(candidate.slice(1))) return value;
  if (candidate.startsWith("@") && (candidate.length === 1 || candidate.charCodeAt(1) > 0x7f)) return value;
  return /^[=+\-@\t\r]/.test(candidate) ? `'${value}` : value;
}

function isExactSpreadsheetDecimal(value: string): boolean {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return false;
  const significant = value.replace(".", "").replace(/^0+/, "");
  return significant.length <= 15;
}
