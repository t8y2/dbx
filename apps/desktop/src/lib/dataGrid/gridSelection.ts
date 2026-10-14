export type GridCellValue = string | number | boolean | null;

export interface CellPosition {
  rowIndex: number;
  colIndex: number;
}

export interface CellSelectionRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export interface SelectionData {
  columns: string[];
  rows: GridCellValue[][];
}

export interface CellSelectionMatrix extends SelectionData {
  rowIndexes: number[];
  columnIndexes: number[];
}

export interface SelectionSummary {
  cellCount: number;
  rowCount: number;
  numericCount: number;
  /** Exact decimal text, so integers beyond 2^53 and DECIMAL scales survive. */
  sum: string;
  average: string | null;
}

export interface SelectionSummaryOptions {
  /**
   * Resolves a cell to the number it contributes to SUM/AVG. Defaults to plain
   * numbers and numeric text. Grids whose cells hold typed scalar literals (the
   * MongoDB collection grid keeps `NumberLong("7")` / `{"$numberDecimal":"-1.5"}`
   * as text) pass their own resolver, otherwise every wrapped value — negatives
   * included — is silently dropped from the total.
   */
  numericValue?: (value: GridCellValue) => number | undefined;
}

export function parseClipboardTable(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "");
  if (!normalized) return [[""]];
  return normalized.split("\n").map((row) => row.split("\t"));
}

export function normalizeSelectedColumnIndexes(columnIndexes: Iterable<number>): number[] {
  return [...new Set(columnIndexes)].filter((index) => index >= 0).sort((a, b) => a - b);
}

export function dedupeColumnIndexes(columnIndexes: Iterable<number>): number[] {
  // Deduplicate while preserving the first visible occurrence (insertion order)
  // instead of numeric order. Used by the copy/extractor path so drag-reordered
  // columns stay in the order the user sees them.
  return [...new Set(columnIndexes)].filter((index) => index >= 0);
}

export function normalizeSelectionRange(anchor: CellPosition, focus: CellPosition): CellSelectionRange {
  return {
    startRow: Math.min(anchor.rowIndex, focus.rowIndex),
    endRow: Math.max(anchor.rowIndex, focus.rowIndex),
    startCol: Math.min(anchor.colIndex, focus.colIndex),
    endCol: Math.max(anchor.colIndex, focus.colIndex),
  };
}

export function rowSelectionRange(rowIndex: number, columnCount: number, endRowIndex = rowIndex): CellSelectionRange | null {
  if (rowIndex < 0 || endRowIndex < 0 || columnCount <= 0) return null;
  return {
    startRow: Math.min(rowIndex, endRowIndex),
    endRow: Math.max(rowIndex, endRowIndex),
    startCol: 0,
    endCol: columnCount - 1,
  };
}

export function columnSelectionRange(rowCount: number, colIndex: number, endColIndex = colIndex): CellSelectionRange | null {
  if (rowCount <= 0 || colIndex < 0 || endColIndex < 0) return null;
  return {
    startRow: 0,
    endRow: rowCount - 1,
    startCol: Math.min(colIndex, endColIndex),
    endCol: Math.max(colIndex, endColIndex),
  };
}

export function allCellsSelectionRange(rowCount: number, columnCount: number): CellSelectionRange | null {
  if (rowCount <= 0 || columnCount <= 0) return null;
  return { startRow: 0, endRow: rowCount - 1, startCol: 0, endCol: columnCount - 1 };
}

export function isCellInSelection(rowIndex: number, colIndex: number, range: CellSelectionRange | null): boolean {
  if (!range) return false;
  return rowIndex >= range.startRow && rowIndex <= range.endRow && colIndex >= range.startCol && colIndex <= range.endCol;
}

export function extractSelection(columns: readonly string[], rows: readonly GridCellValue[][], range: CellSelectionRange | null): SelectionData {
  if (!range) return { columns: [], rows: [] };

  const selectedColumns = columns.slice(range.startCol, range.endCol + 1);
  const selectedRows = rows.slice(range.startRow, range.endRow + 1).map((row) => row.slice(range.startCol, range.endCol + 1));

  return { columns: selectedColumns, rows: selectedRows };
}

export function extractColumnsSelection(columns: readonly string[], rows: readonly GridCellValue[][], selectedColumnIndexes: Iterable<number>): SelectionData {
  const normalizedIndexes = normalizeSelectedColumnIndexes(selectedColumnIndexes).filter((index) => index < columns.length);
  if (normalizedIndexes.length === 0) return { columns: [], rows: [] };

  return {
    columns: normalizedIndexes.map((index) => columns[index]),
    rows: rows.map((row) => normalizedIndexes.map((index) => row[index] ?? null)),
  };
}

/** Plain numbers and numeric text; booleans, null and everything else never take part. */
export function plainSelectionNumericValue(value: GridCellValue): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : undefined;
}

// Fraction digits an average keeps: at least as many as the previous floating-point
// display, and beyond that four more than the values it averages, as MySQL does
// for AVG under its default `div_precision_increment`.
const SELECTION_AVERAGE_MIN_SCALE = 12;
const SELECTION_AVERAGE_EXTRA_SCALE = 4;
// Bounds the exponent of numeric text such as `1e-999999`, which would otherwise
// build a power of ten large enough to stall the grid.
const SELECTION_DECIMAL_MAX_SCALE = 400;
// `Intl.NumberFormat` rejects more fraction digits than this.
const SELECTION_FORMAT_MAX_FRACTION_DIGITS = 100;
const DECIMAL_TEXT_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

export interface ExactDecimal {
  coefficient: bigint;
  scale: number;
}

function parseExactDecimal(text: string): ExactDecimal | undefined {
  const match = DECIMAL_TEXT_PATTERN.exec(text);
  if (!match) return undefined;
  const [, sign, integerDigits = "", fractionDigits = "", exponentText] = match;
  if (!integerDigits && !fractionDigits) return undefined;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  let scale = fractionDigits.length - exponent;
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > SELECTION_DECIMAL_MAX_SCALE) return undefined;
  let digits = `${integerDigits}${fractionDigits}`;
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  const magnitude = BigInt(digits);
  return { coefficient: sign === "-" ? -magnitude : magnitude, scale };
}

/**
 * The exact decimal a cell contributes. Numeric text is read digit for digit,
 * because MySQL BIGINT and DECIMAL values arrive as text precisely so they keep
 * digits a double cannot hold. A JS number contributes the shortest decimal that
 * round-trips to it, which is the text the grid displays.
 */
function exactSelectionValue(value: GridCellValue, resolved: number): ExactDecimal {
  if (typeof value === "string") {
    const trimmed = value.trim();
    // A grid-specific resolver may map text to some other number; the text only
    // counts as written when it denotes the same value.
    if (Number(trimmed) === resolved) {
      const exact = parseExactDecimal(trimmed);
      if (exact) return exact;
    }
  }
  return parseExactDecimal(String(resolved)) ?? { coefficient: 0n, scale: 0 };
}

function rescaleDecimal(value: ExactDecimal, scale: number): bigint {
  return value.scale === scale ? value.coefficient : value.coefficient * 10n ** BigInt(scale - value.scale);
}

/** Adds a cell to an exact running total; `resolved` is the number the cell counts as. */
export function addExactSelectionValue(sum: ExactDecimal, value: GridCellValue, resolved: number): ExactDecimal {
  const exact = exactSelectionValue(value, resolved);
  const scale = Math.max(sum.scale, exact.scale);
  return { coefficient: rescaleDecimal(sum, scale) + rescaleDecimal(exact, scale), scale };
}

/** Integer division rounding half away from zero, as MySQL rounds DECIMAL results. */
function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const rounded = (absNumerator % absDenominator) * 2n >= absDenominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export function exactDecimalText(value: ExactDecimal): string {
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient).toString().padStart(value.scale + 1, "0");
  const integerPart = digits.slice(0, digits.length - value.scale);
  const fractionPart = digits.slice(digits.length - value.scale).replace(/0+$/, "");
  const text = fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
  return negative && text !== "0" ? `-${text}` : text;
}

export function summarizeSelection(selection: SelectionData, options: SelectionSummaryOptions = {}): SelectionSummary {
  const numericValue = options.numericValue ?? plainSelectionNumericValue;
  let numericCount = 0;
  let sum: ExactDecimal = { coefficient: 0n, scale: 0 };

  for (const row of selection.rows) {
    for (const value of row) {
      const resolved = numericValue(value);
      if (resolved === undefined || !Number.isFinite(resolved)) continue;
      numericCount += 1;
      sum = addExactSelectionValue(sum, value, resolved);
    }
  }

  const averageScale = Math.max(sum.scale + SELECTION_AVERAGE_EXTRA_SCALE, SELECTION_AVERAGE_MIN_SCALE);
  const average = numericCount > 0 ? exactDecimalText({ coefficient: divideRoundHalfAwayFromZero(rescaleDecimal(sum, averageScale), BigInt(numericCount)), scale: averageScale }) : null;

  return {
    cellCount: selection.rows.reduce((count, row) => count + row.length, 0),
    rowCount: selection.rows.length,
    numericCount,
    sum: exactDecimalText(sum),
    average,
  };
}

export function createPendingSelectionSummary(cellCount: number, rowCount: number): SelectionSummary {
  return {
    cellCount,
    rowCount,
    numericCount: 0,
    sum: "0",
    average: null,
  };
}

/**
 * Integers print as plain digits and fractions in the locale's notation. Decimal
 * text from {@link summarizeSelection} is formatted digit for digit; a JS number
 * keeps at most 12 fraction digits.
 */
export function formatSelectionAggregate(value: number | string, locales?: Intl.LocalesArgument): string {
  if (typeof value === "string") {
    if (!value.includes(".")) return value === "-0" ? "0" : value;
    const fractionDigits = Math.min(value.length - value.indexOf(".") - 1, SELECTION_FORMAT_MAX_FRACTION_DIGITS);
    // Intl.NumberFormat formats string input as an exact decimal, without a round trip through a double.
    return new Intl.NumberFormat(locales, { maximumFractionDigits: fractionDigits }).format(value as unknown as number);
  }
  const normalized = Object.is(value, -0) ? 0 : value;
  return Number.isInteger(normalized) ? String(normalized) : normalized.toLocaleString(locales, { maximumFractionDigits: 12 });
}

export function formatSelectionAverage(value: number | string | null | undefined, locales?: Intl.LocalesArgument): string {
  if (typeof value === "string") return formatSelectionAggregate(value, locales);
  return typeof value === "number" && Number.isFinite(value) ? formatSelectionAggregate(value, locales) : "—";
}
