import type { DatabaseType } from "@/types/database";
import { isNumericColumnType } from "@/lib/dataGrid/dataGridColumnType";

export type DataGridSortDirection = "asc" | "desc";
export type DataGridSortMode = "database" | "local";

/**
 * Cassandra rejects ORDER BY unless the partition key is restricted by an
 * equality filter, so a browse query can never be sorted database-side there
 * and the sort would keep failing on every refresh or page jump while applied.
 */
export function databaseSortSupportedForDatabase(databaseType?: DatabaseType): boolean {
  return databaseType !== "cassandra";
}

export interface DataGridSortState {
  column: string | null;
  columnIndex: number | null;
  direction: DataGridSortDirection;
}

interface SimpleDataGridOrderBy {
  column: string;
  direction: DataGridSortDirection;
  quoted: boolean;
}

function parseSimpleDataGridOrderBy(orderBy: string | undefined): SimpleDataGridOrderBy | undefined {
  const match = orderBy?.trim().match(/^((?:n\.)?(?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[(?:[^\]]|\]\])+\]|[A-Za-z_][A-Za-z0-9_$]*))\s+(?:ASC|DESC)$/i);
  if (!match) return undefined;
  let identifier = match[1]!;
  if (/^n\./i.test(identifier)) identifier = identifier.slice(2);
  const direction = orderBy!.trim().toLocaleLowerCase().endsWith(" desc") ? "desc" : "asc";
  if (identifier.startsWith('"')) return { column: identifier.slice(1, -1).replace(/""/g, '"'), direction, quoted: true };
  if (identifier.startsWith("`")) return { column: identifier.slice(1, -1).replace(/``/g, "`"), direction, quoted: true };
  if (identifier.startsWith("[")) return { column: identifier.slice(1, -1).replace(/\]\]/g, "]"), direction, quoted: true };
  return { column: identifier, direction, quoted: false };
}

function simpleDataGridColumnMatches(orderBy: SimpleDataGridOrderBy, column: string): boolean {
  return orderBy.quoted ? column === orderBy.column : column.toLocaleLowerCase() === orderBy.column.toLocaleLowerCase();
}

export function simpleDataGridOrderByColumn(orderBy: string | undefined): string | undefined {
  return parseSimpleDataGridOrderBy(orderBy)?.column;
}

export function simpleDataGridOrderByReferencesMissingColumn(orderBy: string | undefined, columns: readonly string[]): boolean {
  const parsed = parseSimpleDataGridOrderBy(orderBy);
  if (!parsed) return false;
  return !columns.some((column) => simpleDataGridColumnMatches(parsed, column));
}

export function simpleDataGridOrderByMatchesSort(orderBy: string | undefined, column: string | null | undefined, direction: DataGridSortDirection | null | undefined): boolean {
  if (!column || !direction) return false;
  const parsed = parseSimpleDataGridOrderBy(orderBy);
  return !!parsed && parsed.direction === direction && simpleDataGridColumnMatches(parsed, column);
}

export function nextDataGridSortState(current: DataGridSortState, column: string, columnIndex: number): DataGridSortState {
  if (current.column === column && current.columnIndex === columnIndex) {
    if (current.direction === "asc") {
      return { column, columnIndex, direction: "desc" };
    }
    return { column: null, columnIndex: null, direction: "asc" };
  }
  return { column, columnIndex, direction: "asc" };
}

type DataGridCellValue = string | number | boolean | null | undefined;
type DataGridRow = DataGridCellValue[];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function sortDataGridRows<T extends DataGridRow>(rows: readonly T[], columnIndex: number, direction: DataGridSortDirection, columnType?: string): T[] {
  return sortDataGridRowIndexes(rows, columnIndex, direction, columnType).map((index) => rows[index]!);
}

export function sortDataGridRowIndexes(rows: readonly DataGridRow[], columnIndex: number, direction: DataGridSortDirection, columnType?: string): number[] {
  const directionMultiplier = direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const emptyCompared = compareEmptyValues(left.row[columnIndex], right.row[columnIndex]);
      if (emptyCompared !== null) return emptyCompared;
      const compared = compareDataGridValues(left.row[columnIndex], right.row[columnIndex], columnType);
      if (compared !== 0) return compared * directionMultiplier;
      return left.index - right.index;
    })
    .map((item) => item.index);
}

export function compareDataGridValues(left: DataGridCellValue, right: DataGridCellValue, columnType?: string): number {
  const leftEmpty = left == null;
  const rightEmpty = right == null;
  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) return 0;
    return leftEmpty ? 1 : -1;
  }

  if (isNumericColumnType(columnType)) {
    const numericCompared = compareNumericCellValues(left, right);
    if (numericCompared !== null) return numericCompared;
  }

  if (typeof left === "number" && typeof right === "number") {
    return compareNumbers(left, right);
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  if (typeof left === "string" && typeof right === "string") {
    const leftDate = dateSortValue(left);
    const rightDate = dateSortValue(right);
    if (leftDate !== null && rightDate !== null) return compareNumbers(leftDate, rightDate);
    return collator.compare(left, right);
  }

  return collator.compare(String(left), String(right));
}

interface NumericSortValue {
  sign: -1 | 0 | 1;
  magnitude: bigint;
  digits: string;
}

function compareNumericCellValues(left: DataGridCellValue, right: DataGridCellValue): number | null {
  const leftNumber = parseNumericSortValue(left);
  const rightNumber = parseNumericSortValue(right);
  if (!leftNumber || !rightNumber) return null;
  if (leftNumber.sign !== rightNumber.sign) return leftNumber.sign - rightNumber.sign;
  if (leftNumber.sign === 0) return 0;

  let compared = compareBigInts(leftNumber.magnitude, rightNumber.magnitude);
  if (compared === 0) {
    const width = Math.max(leftNumber.digits.length, rightNumber.digits.length);
    compared = leftNumber.digits.padEnd(width, "0").localeCompare(rightNumber.digits.padEnd(width, "0"));
  }
  return leftNumber.sign === 1 ? compared : -compared;
}

function parseNumericSortValue(value: DataGridCellValue): NumericSortValue | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  const negative = text.startsWith("-");
  const unsigned = /^[+-]/.test(text) ? text.slice(1) : text;
  const match = unsigned.match(/^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;

  const integerDigits = match[1] ?? "";
  const fractionDigits = match[2] ?? "";
  const allDigits = `${integerDigits}${fractionDigits}`;
  if (!allDigits) return null;
  const leadingZeroCount = allDigits.match(/^0*/)?.[0].length ?? 0;
  const digits = allDigits.slice(leadingZeroCount);
  if (!digits) return { sign: 0, magnitude: 0n, digits: "0" };

  const exponent = BigInt(match[3] ?? "0");
  const magnitude = BigInt(integerDigits.length - leadingZeroCount) + exponent;
  return { sign: negative ? -1 : 1, magnitude, digits };
}

function compareBigInts(left: bigint, right: bigint): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareEmptyValues(left: DataGridCellValue, right: DataGridCellValue): number | null {
  const leftEmpty = left == null;
  const rightEmpty = right == null;
  if (!leftEmpty && !rightEmpty) return null;
  if (leftEmpty && rightEmpty) return 0;
  return leftEmpty ? 1 : -1;
}

function compareNumbers(left: number, right: number): number {
  if (Number.isNaN(left) || Number.isNaN(right)) {
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    return Number.isNaN(left) ? 1 : -1;
  }
  return left - right;
}

function dateSortValue(value: string): number | null {
  const trimmed = value.trim();
  // PostgreSQL and KingbaseES render timestamps as `YYYY-MM-DD HH:MM:SS.ffffff`
  // (space separator, microsecond precision, optional numeric UTC offset) plus
  // the special values infinity/-infinity. Date.parse rejects several of those
  // shapes depending on the engine, silently degrading time columns to
  // lexicographic order (issue #7281), so parse them deterministically.
  if (trimmed === "infinity") return Number.MAX_SAFE_INTEGER;
  if (trimmed === "-infinity") return Number.MIN_SAFE_INTEGER;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?/.exec(trimmed);
  if (!match) return null;
  const [, year, month, day, hour = "0", minute = "0", second = "0", fraction, zone] = match;
  let sortValue = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) + (fraction ? Number(`0.${fraction}`) * 1000 : 0);
  if (zone && zone !== "Z") {
    const zoneMatch = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
    if (zoneMatch) {
      const offsetMinutes = Number(zoneMatch[2]) * 60 + Number(zoneMatch[3] ?? 0);
      sortValue -= (zoneMatch[1] === "-" ? -1 : 1) * offsetMinutes * 60_000;
    }
  }
  return Number.isFinite(sortValue) ? sortValue : null;
}
