import type { GridCellValue } from "@/lib/dataGrid/dataGridSql";
import type { DatabaseType, ColumnInfo } from "@/types/database";

export interface CoerceDataGridCellValueOptions {
  value: string;
  oldValue: GridCellValue | undefined;
  databaseType: DatabaseType | undefined;
  columnInfo: Pick<ColumnInfo, "data_type"> | undefined;
}

export function coerceDataGridCellValue(options: CoerceDataGridCellValueOptions): GridCellValue {
  const { value, oldValue } = options;
  if (value.toUpperCase() === "NULL") return null;
  if (value === "" && oldValue === null) return null;
  const postgresArrayValue = coercePostgresArrayValue(options);
  if (postgresArrayValue !== undefined) return postgresArrayValue;
  if (typeof oldValue === "number") {
    const num = Number(value);
    if (!Number.isNaN(num)) {
      if (shouldPreserveNumericText(options, num)) {
        // Keep precision-sensitive numeric edits as text; JS Number rounds 64-bit integers.
        const text = value.trim();
        if (text === String(oldValue)) return oldValue;
        return text;
      }
      return num;
    }
  }
  if (typeof oldValue === "boolean") {
    return value === "true" || value === "1";
  }
  return normalizeSmartQuotedJsonInput(value);
}

export function dataGridCellEditorText(options: { value: GridCellValue | undefined; databaseType: DatabaseType | undefined; columnInfo: Pick<ColumnInfo, "data_type"> | undefined }): string {
  const value = options.value ?? null;
  if (value === null) return "";
  if (Array.isArray(value) && options.databaseType === "postgres" && isPostgresArrayColumn(options.columnInfo, value)) {
    return formatPostgresArrayText(value);
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function dataGridCellDisplayText(options: { value: GridCellValue; databaseType: DatabaseType | undefined; columnInfo: Pick<ColumnInfo, "data_type"> | undefined }): string | undefined {
  if (Array.isArray(options.value) && options.databaseType === "postgres" && isPostgresArrayColumn(options.columnInfo, options.value)) {
    return formatPostgresArrayText(options.value);
  }
  if (typeof options.value === "string" && isOracleDateColumn(options.databaseType, options.columnInfo)) {
    return formatOracleDateDisplayText(options.value);
  }
  return undefined;
}

function coercePostgresArrayValue(options: CoerceDataGridCellValueOptions): unknown[] | undefined {
  if (options.databaseType !== "postgres") return undefined;
  if (!isPostgresArrayColumn(options.columnInfo, options.oldValue)) return undefined;
  const trimmed = options.value.trim();

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(normalizeSmartQuotes(trimmed));
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = parsePostgresArrayText(trimmed, {
        numericDataType: postgresArrayElementDataType(options.columnInfo?.data_type),
      });
      if (Array.isArray(options.oldValue) && deepEqual(parsed, options.oldValue)) {
        return options.oldValue;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPostgresArrayColumn(columnInfo: Pick<ColumnInfo, "data_type"> | undefined, oldValue: GridCellValue | undefined): boolean {
  if (Array.isArray(oldValue)) return true;
  const dataType = columnInfo?.data_type.trim().toLowerCase() ?? "";
  return dataType === "array" || dataType.endsWith("[]") || dataType.startsWith("_");
}

function shouldPreserveNumericText(options: CoerceDataGridCellValueOptions, parsedNumber: number): boolean {
  const text = options.value.trim();
  if (!isNumericLiteralText(text)) return false;
  return shouldPreserveNumericTextForType(options.columnInfo?.data_type, text, parsedNumber);
}

function postgresArrayElementDataType(dataType: string | undefined): string {
  const normalized = normalizeDataType(dataType);
  if (normalized.startsWith("_")) return normalized.slice(1);
  if (normalized.endsWith("[]")) return normalized.slice(0, -2).trim();
  return normalized;
}

function shouldPreserveNumericTextForType(dataType: string | undefined, text: string, parsedNumber: number): boolean {
  const normalized = normalizeDataType(dataType);
  if (isExactDecimalDataType(normalized)) return true;
  if (isLargeIntegerDataType(normalized)) return !Number.isSafeInteger(parsedNumber);
  return numericTextWouldLosePrecision(text, parsedNumber);
}

function normalizeDataType(dataType: string | undefined): string {
  return (dataType ?? "").trim().toLowerCase();
}

function isOracleDateColumn(databaseType: DatabaseType | undefined, columnInfo: Pick<ColumnInfo, "data_type"> | undefined): boolean {
  if (databaseType !== "oracle" && databaseType !== "oceanbase-oracle") return false;
  const base = normalizeDataType(columnInfo?.data_type).split(/[()\s\t\n]/)[0] ?? "";
  return base === "date";
}

function formatOracleDateDisplayText(value: string): string | undefined {
  const parts = parseOracleDateLikeText(value);
  if (!parts) return undefined;
  if (parts.time === "00:00:00" && !parts.fraction) return parts.date;
  return `${parts.date} ${parts.time}${parts.fraction ?? ""}`;
}

function parseOracleDateLikeText(value: string): { date: string; time: string; fraction?: string } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  const date = value.slice(0, 10);
  if (value.length === 10) return { date, time: "00:00:00" };
  const separator = value[10];
  if (separator !== "T" && separator !== " ") return undefined;
  if (!/^\d{2}:\d{2}:\d{2}/.test(value.slice(11))) return undefined;
  const time = value.slice(11, 19);
  let rest = value.slice(19);
  let fraction: string | undefined;
  if (rest.startsWith(".")) {
    const match = rest.match(/^(\.\d{1,9})(.*)$/);
    if (!match) return undefined;
    fraction = match[1];
    rest = match[2];
  }
  if (rest && !/^z$/i.test(rest) && !/^[+-]\d{2}:\d{2}$/.test(rest)) return undefined;
  return { date, time, fraction };
}

function isExactDecimalDataType(dataType: string): boolean {
  return /\b(?:decimal|numeric|number|dec|money|smallmoney|bigdecimal|bignumeric|big_numeric|fixed)\b/.test(dataType);
}

function isLargeIntegerDataType(dataType: string): boolean {
  return /\b(?:bigint|int8|int64|uint64|u64|bigserial|serial8|int128|uint128|int256|uint256)\b/.test(dataType);
}

function numericTextWouldLosePrecision(text: string, parsedNumber: number): boolean {
  if (isIntegerLiteralText(text)) return !Number.isSafeInteger(parsedNumber);
  return significantDigitCount(text) > 15;
}

function isNumericLiteralText(text: string): boolean {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text);
}

function isIntegerLiteralText(text: string): boolean {
  return /^[+-]?\d+$/.test(text);
}

function significantDigitCount(text: string): number {
  const mantissa = text.replace(/^[+-]/, "").split(/[eE]/)[0].replace(".", "");
  const withoutLeadingZeros = mantissa.replace(/^0+/, "");
  return withoutLeadingZeros.length;
}

function normalizeSmartQuotedJsonInput(value: string): string {
  // Check for smart double quotes that input methods might insert.
  // U+201C, U+201D, U+201E, U+201F, U+FF02
  if (!hasSmartDoubleQuotes(value)) return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;

  try {
    JSON.parse(value);
    return value;
  } catch {
    // Input methods can turn JSON delimiters into smart quotes.
  }

  // Input methods (especially on macOS and with Chinese IME) can turn JSON delimiters
  // into smart quotes. Normalize them to standard ASCII quotes.
  const normalized = normalizeSmartQuotes(value);
  try {
    JSON.parse(normalized);
    return normalized;
  } catch {
    return value;
  }
}

function hasSmartDoubleQuotes(value: string): boolean {
  // Check for smart double quotes: U+201C, U+201D, U+201E, U+201F, U+FF02
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x201c || code === 0x201d || code === 0x201e || code === 0x201f || code === 0xff02) {
      return true;
    }
  }
  return false;
}

function normalizeSmartQuotes(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x201c || code === 0x201d || code === 0x201e || code === 0x201f || code === 0xff02) {
      // Convert to standard double quote
      result += '"';
    } else {
      result += value[i];
    }
  }
  return result;
}

function formatPostgresArrayText(value: unknown[]): string {
  return `{${value.map(formatPostgresArrayElement).join(",")}}`;
}

function formatPostgresArrayElement(value: unknown): string {
  if (Array.isArray(value)) return formatPostgresArrayText(value);
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  if (!needsQuotedPostgresArrayElement(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function needsQuotedPostgresArrayElement(value: string): boolean {
  return value === "" || /[\s,"{}\\]/.test(value) || value.toUpperCase() === "NULL";
}

function parsePostgresArrayText(value: string, options: { numericDataType?: string } = {}): unknown[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("Invalid PG array literal");
  }
  const inner = trimmed.slice(1, -1);
  if (inner.length === 0) return [];

  const elements: unknown[] = [];
  let i = 0;
  while (i < inner.length) {
    while (i < inner.length && inner[i] === " ") i++;
    if (i >= inner.length) break;

    let element: unknown;
    if (inner[i] === '"') {
      i++;
      let str = "";
      while (i < inner.length) {
        if (inner[i] === "\\" && i + 1 < inner.length) {
          i++;
          str += inner[i];
          i++;
        } else if (inner[i] === '"') {
          i++;
          break;
        } else {
          str += inner[i];
          i++;
        }
      }
      element = str;
    } else if (inner[i] === "{") {
      let depth = 0;
      const start = i;
      while (i < inner.length) {
        if (inner[i] === "{") depth++;
        else if (inner[i] === "}") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
      element = parsePostgresArrayText(inner.slice(start, i), options);
    } else {
      let start = i;
      while (i < inner.length && inner[i] !== "," && inner[i] !== "}") i++;
      const token = inner.slice(start, i).trim();
      if (token.toUpperCase() === "NULL") {
        element = null;
      } else if (/^(true|false)$/i.test(token)) {
        element = token.toLowerCase() === "true";
      } else if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)) {
        const num = Number(token);
        // JS numbers cannot carry 64-bit integer or high-precision decimal array elements exactly.
        element = shouldPreserveNumericTextForType(options.numericDataType, token, num) ? token : num;
      } else {
        element = token;
      }
    }

    elements.push(element);

    while (i < inner.length && inner[i] === " ") i++;
    if (i < inner.length && inner[i] === ",") i++;
  }

  return elements;
}
