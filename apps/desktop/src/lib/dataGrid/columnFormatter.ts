import { displayCellValue, type CellValue } from "@/lib/dataGrid/cellValue";
import dayjs, { Dayjs } from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

export type DateTimeFormatterUnit = "seconds" | "milliseconds" | "auto";
const DEFAULT_DATETIME_PATTERN = "YYYY-MM-DD HH:mm:ss";
export const DateTimePatterns = [
  "YYYY-MM-DD",
  "YYYY/MM/DD",
  "YYYY/M/D",
  "HH:mm:ss",
  "HH:mm:ss.SSS",
  "YYYY-MM-DD HH:mm:ss",
  "YYYY-MM-DD HH:mm:ss.SSS",
  "YYYY/MM/DD HH:mm:ss",
  "YYYY/MM/DD HH:mm:ss.SSS",
  "YYYY/M/D HH:mm:ss",
  "YYYY-MM-DDTHH:mm:ssZ",
  "YYYY-MM-DDTHH:mm:ss.SSSZ",
  "YYYY/MM/DDTHH:mm:ssZ",
  "YYYY/MM/DDTHH:mm:ss.SSSZ",
];
const SUPPORTED_DATE_TIME_PATTERN_TOKENS = ["YYYY", "SSS", "ZZ", "MM", "DD", "HH", "mm", "ss", "M", "D", "H", "m", "s", "Z"];
const STRICT_LOCAL_DATETIME_INPUT_PATTERNS = [
  "YYYY-MM-DD",
  "YYYY-M-D",
  "YYYY/MM/DD",
  "YYYY/M/D",
  "YYYY-MM-DD HH:mm:ss",
  "YYYY-M-D H:m:s",
  "YYYY-MM-DD HH:mm:ss.SSS",
  "YYYY-M-D H:m:s.SSS",
  "YYYY/MM/DD HH:mm:ss",
  "YYYY/M/D H:m:s",
  "YYYY/MM/DD HH:mm:ss.SSS",
  "YYYY/M/D H:m:s.SSS",
  "YYYY-MM-DDTHH:mm:ss",
  "YYYY-M-DTH:m:s",
  "YYYY-MM-DDTHH:mm:ss.SSS",
  "YYYY-M-DTH:m:s.SSS",
  "YYYY/MM/DDTHH:mm:ss",
  "YYYY/M/DTH:m:s",
  "YYYY/MM/DDTHH:mm:ss.SSS",
  "YYYY/M/DTH:m:s.SSS",
];
const ISO_OFFSET_DATETIME_PATTERN = /^(\d{4})([-/])(\d{2})\2(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const FRACTIONAL_LOCAL_DATETIME_PATTERN = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})([ T])(\d{1,2}):(\d{1,2}):(\d{1,2})\.(\d{1,9})$/;

export interface CustomColumnFormatterConfig {
  id: string;
  name: string;
  template: string;
}

interface IntlTimeZoneSupport {
  supportedValuesOf?: (key: "timeZone") => string[];
}

export function getSupportedTimeZoneOptions(intl: IntlTimeZoneSupport, fallbackTimeZone = "UTC"): string[] {
  try {
    const timeZones = intl.supportedValuesOf?.("timeZone");
    if (timeZones?.length) return timeZones;
  } catch {}
  // Older WebViews may omit or throw from this API, so keep the detected timezone selectable.
  return [fallbackTimeZone || "UTC"];
}

export function normalizeSupportedDateTimePattern(value: string): string {
  const pattern = value.trim();
  if (!pattern || pattern.length > 100 || pattern.includes("%")) return "";

  let index = 0;
  while (index < pattern.length) {
    const remaining = pattern.slice(index);
    if (remaining.startsWith("[")) {
      const closeIndex = remaining.indexOf("]");
      if (closeIndex < 0) return "";
      index += closeIndex + 1;
      continue;
    }

    const token = SUPPORTED_DATE_TIME_PATTERN_TOKENS.find((candidate) => remaining.startsWith(candidate));
    if (token) {
      index += token.length;
      continue;
    }

    if (/[A-Za-z]/.test(pattern[index])) return "";
    index += 1;
  }

  return pattern;
}

export type ColumnFormatterConfig =
  | { kind: "datetime"; unit: DateTimeFormatterUnit; pattern: string; timezone: string | undefined }
  | { kind: "json-path"; path: string }
  | { kind: "mask"; prefix: number; suffix: number }
  | { kind: "custom-template"; template: string }
  | { kind: "custom-ref"; formatterId: string };

export interface ColumnFormatterKeyParts {
  connectionId: string;
  database?: string;
  schema?: string;
  tableName: string;
  column: string;
}

export function buildColumnFormatterKey(parts: ColumnFormatterKeyParts): string {
  return [parts.connectionId, parts.database ?? "", parts.schema ?? "", parts.tableName, parts.column].join("::");
}

export function normalizeColumnFormatter(value: unknown): ColumnFormatterConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const config = value as Record<string, any>;

  if (config.kind === "datetime") {
    return config.unit === "seconds" || config.unit === "milliseconds" || config.unit === "auto"
      ? {
          kind: "datetime",
          unit: config.unit,
          pattern: normalizeDateTimePattern(config.pattern),
          timezone: config.timezone,
        }
      : undefined;
  }

  if (config.kind === "json-path") {
    return typeof config.path === "string" && isSupportedJsonPath(config.path) ? { kind: "json-path", path: config.path } : undefined;
  }

  if (config.kind === "mask") {
    if (!Number.isInteger(config.prefix) || !Number.isInteger(config.suffix)) return undefined;
    if ((config.prefix as number) < 0 || (config.suffix as number) < 0) return undefined;
    return { kind: "mask", prefix: config.prefix as number, suffix: config.suffix as number };
  }

  if (config.kind === "custom-template") {
    return typeof config.template === "string" && config.template.trim() ? { kind: "custom-template", template: config.template.slice(0, 500) } : undefined;
  }

  if (config.kind === "custom-ref") {
    return typeof config.formatterId === "string" && config.formatterId.trim() ? { kind: "custom-ref", formatterId: config.formatterId } : undefined;
  }

  return undefined;
}

export function normalizeCustomColumnFormatter(value: unknown): CustomColumnFormatterConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const config = value as Record<string, unknown>;
  if (typeof config.id !== "string" || !config.id.trim()) return undefined;
  if (typeof config.name !== "string" || !config.name.trim()) return undefined;
  if (typeof config.template !== "string" || !config.template.trim()) return undefined;
  return {
    id: config.id.trim(),
    name: config.name.trim().slice(0, 80),
    template: config.template.slice(0, 500),
  };
}

export function normalizeGlobalDateTimePattern(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}

export function isTemporalColumnType(dataType: string | null | undefined): boolean {
  const normalized = String(dataType || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!normalized) return false;
  const base = normalized.split(/[(:]/)[0]?.trim() ?? "";
  return (
    ["date", "date32", "daten", "time", "time64", "timen", "timetz", "datetime", "datetime2", "datetime4", "datetime64", "datetimen", "datetimeoffset", "datetimeoffsetn", "smalldatetime", "timestamp", "timestampdty", "timestamptz"].includes(base) ||
    base.startsWith("timestamp_") ||
    normalized.startsWith("timestamp with ") ||
    normalized.startsWith("timestamp without ") ||
    normalized.startsWith("time with ") ||
    normalized.startsWith("time without ")
  );
}

export function resolveColumnFormatter(formatter: ColumnFormatterConfig | undefined, customFormatters: Record<string, CustomColumnFormatterConfig>, globalDateTime?: { pattern?: string; columnType?: string | null }): ColumnFormatterConfig | undefined {
  if (!formatter) {
    const pattern = normalizeGlobalDateTimePattern(globalDateTime?.pattern);
    return pattern && isTemporalColumnType(globalDateTime?.columnType) ? { kind: "datetime", unit: "auto", pattern, timezone: undefined } : undefined;
  }
  if (formatter.kind !== "custom-ref") return formatter;
  const customFormatter = customFormatters[formatter.formatterId];
  return customFormatter ? { kind: "custom-template", template: customFormatter.template } : undefined;
}

export function formatTemporalRowsForExport<T extends CellValue>(rows: readonly (readonly T[])[], columnTypes: readonly (string | null | undefined)[], pattern: string): T[][] {
  const normalizedPattern = normalizeGlobalDateTimePattern(pattern);
  if (!normalizedPattern) return rows.map((row) => [...row]);
  return rows.map((row) =>
    row.map((value, index) => {
      if (!isTemporalColumnType(columnTypes[index])) return value;
      return formatTemporalValueForExport(value, normalizedPattern) as T;
    }),
  );
}

function formatTemporalValueForExport(value: CellValue, pattern: string): string {
  if (typeof value === "string") {
    const match = value.match(ISO_OFFSET_DATETIME_PATTERN);
    if (match) {
      const [, year, separator, month, day, hour, minute, second, fraction = "", zone] = match;
      if (!isValidDateTimeParts(year, month, day, hour, minute, second) || !isValidOffset(zone)) {
        return displayCellValue(value);
      }
      const normalizedFraction = fraction ? `.${fraction.slice(1, 4).padEnd(3, "0")}` : "";
      const localValue = `${year}${separator}${month}${separator}${day}T${hour}:${minute}:${second}${normalizedFraction}`;
      const inputPattern = `${separator === "-" ? "YYYY-MM-DD" : "YYYY/MM/DD"}THH:mm:ss${fraction ? ".SSS" : ""}`;
      const parsed = dayjs(localValue, inputPattern, true);
      if (parsed.isValid()) {
        const offsetMinutes = zone === "Z" ? 0 : (zone.startsWith("-") ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
        return parsed.utcOffset(offsetMinutes, true).format(pattern);
      }
    }
  }
  return applyColumnFormatter(value, { kind: "datetime", unit: "auto", pattern, timezone: undefined });
}

export function applyColumnFormatter(value: CellValue, formatter: ColumnFormatterConfig | undefined): string {
  if (!formatter) return displayCellValue(value);

  try {
    if (formatter.kind === "datetime") return formatDateTime(value, formatter.unit, formatter.pattern, formatter.timezone);
    if (formatter.kind === "json-path") return formatJsonPath(value, formatter.path);
    if (formatter.kind === "mask") return formatMask(value, formatter);
    if (formatter.kind === "custom-template") return formatCustomTemplate(value, formatter.template);
    return displayCellValue(value);
  } catch {
    return displayCellValue(value);
  }
}

function formatDateTime(value: CellValue, unit: DateTimeFormatterUnit, pattern: string, timezone: string | undefined): string {
  if (value === null) return displayCellValue(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  const parsed: Dayjs | undefined = resolveDateTimeValue(value, unit);
  if (parsed) {
    const template = pattern || DEFAULT_DATETIME_PATTERN;
    return timezone ? parsed.tz(timezone).format(template) : parsed.format(template);
  } else {
    return displayCellValue(value);
  }
}

function resolveDateTimeValue(value: string | number, unit: DateTimeFormatterUnit) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const timestamp = parseTimestampMilliseconds(trimmed, unit);
    if (timestamp !== undefined) {
      const parsedTimestamp = dayjs(timestamp);
      return parsedTimestamp.isValid() ? parsedTimestamp : undefined;
    }
    if (isIntegerString(trimmed)) return undefined;

    return parseStrictDateTimeString(trimmed);
  }

  const timestamp = parseTimestampMilliseconds(value, unit);
  if (timestamp === undefined) return undefined;

  const parsedTimestamp = dayjs(timestamp);
  return parsedTimestamp.isValid() ? parsedTimestamp : undefined;
}

function normalizeDateTimePattern(pattern: unknown): string {
  return typeof pattern === "string" && pattern.trim() ? pattern : DEFAULT_DATETIME_PATTERN;
}

function parseStrictDateTimeString(value: string): Dayjs | undefined {
  const parsedIsoOffset = parseIsoOffsetDateTimeString(value);
  if (parsedIsoOffset) return parsedIsoOffset;

  const fractionalLocalMatch = value.match(FRACTIONAL_LOCAL_DATETIME_PATTERN);
  if (fractionalLocalMatch) {
    const [, yearText, , monthText, dayText, , hourText, minuteText, secondText, fractionText] = fractionalLocalMatch;
    if (isValidDateTimeParts(yearText, monthText, dayText, hourText, minuteText, secondText)) {
      const normalized = `${yearText}-${monthText.padStart(2, "0")}-${dayText.padStart(2, "0")}T${hourText.padStart(2, "0")}:${minuteText.padStart(2, "0")}:${secondText.padStart(2, "0")}.${fractionText.slice(0, 3).padEnd(3, "0")}`;
      const parsed = dayjs(normalized, "YYYY-MM-DDTHH:mm:ss.SSS", true);
      if (parsed.isValid()) return parsed;
    }
  }

  for (const pattern of STRICT_LOCAL_DATETIME_INPUT_PATTERNS) {
    // Day.js non-strict parsing normalizes overflow dates such as 2022-01-33.
    // Keep cell text strict so invalid values fall back unchanged.
    const parsed = dayjs(value, pattern, true);
    if (parsed.isValid()) return parsed;
  }
  return undefined;
}

function parseIsoOffsetDateTimeString(value: string): Dayjs | undefined {
  const match = value.match(ISO_OFFSET_DATETIME_PATTERN);
  if (!match) return undefined;

  const [, yearText, , monthText, dayText, hourText, minuteText, secondText, fractionText = "", zoneText] = match;
  if (!isValidDateTimeParts(yearText, monthText, dayText, hourText, minuteText, secondText)) return undefined;
  if (!isValidOffset(zoneText)) return undefined;

  const normalizedFraction = fractionText ? `.${fractionText.slice(1, 4).padEnd(3, "0")}` : "";
  const normalized = `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${normalizedFraction}${zoneText}`;
  const parsed = dayjs(normalized);
  return parsed.isValid() ? parsed : undefined;
}

function isValidDateTimeParts(yearText: string, monthText: string, dayText: string, hourText: string, minuteText: string, secondText: string): boolean {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (!Number.isInteger(year) || year < 1) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth) return false;
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

function isValidOffset(offset: string): boolean {
  if (offset === "Z") return true;
  const match = offset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function parseTimestampMilliseconds(value: string | number, unit: DateTimeFormatterUnit): number | undefined {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(numeric)) {
    return undefined;
  }
  if (unit === "seconds" || unit === "milliseconds") {
    return convertToMilliseconds(numeric, unit);
  }
  return isAutoTimestampValue(value, numeric) ? convertToMilliseconds(numeric, unit) : undefined;
}

function convertToMilliseconds(value: number, unit: DateTimeFormatterUnit): number {
  return unit === "seconds" || (unit === "auto" && Math.abs(value) < 100_000_000_000) ? value * 1000 : value;
}

function isAutoTimestampValue(originalValue: string | number, numericValue: number): boolean {
  if (!Number.isInteger(numericValue)) {
    return false;
  }
  const digits = getTimestampDigits(originalValue);
  if (digits !== 10 && digits !== 13) {
    return false;
  }
  const yearFromTimestamp = dayjs(digits === 10 ? numericValue * 1000 : numericValue).year();
  return yearFromTimestamp >= 1970 && yearFromTimestamp <= 2100;
}

function getTimestampDigits(value: string | number): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!isIntegerString(trimmed)) return undefined;
    return trimmed.startsWith("-") ? trimmed.length - 1 : trimmed.length;
  } else if (!Number.isInteger(value)) {
    return undefined;
  } else {
    return Math.abs(value).toString().length;
  }
}

function isIntegerString(value: string): boolean {
  return /^-?\d+$/.test(value);
}

function formatJsonPath(value: CellValue, path: string): string {
  if (value === null) return displayCellValue(value);
  if (typeof value !== "string") return displayCellValue(value);
  const parsed = JSON.parse(value);
  const tokens = parseJsonPath(path);
  let current: unknown = parsed;

  for (const token of tokens) {
    if (current == null) return "";
    if (typeof token === "number") {
      if (!Array.isArray(current)) return "";
      current = current[token];
    } else {
      if (typeof current !== "object" || Array.isArray(current)) return "";
      current = (current as Record<string, unknown>)[token];
    }
  }

  if (current === undefined) return "";
  if (current === null) return "NULL";
  if (typeof current === "object") return JSON.stringify(current);
  return String(current);
}

function formatMask(value: CellValue, formatter: Extract<ColumnFormatterConfig, { kind: "mask" }>): string {
  if (value === null) return displayCellValue(value);
  const text = displayCellValue(value);
  const visibleCount = formatter.prefix + formatter.suffix;
  if (text.length <= visibleCount) return "*".repeat(text.length);
  return `${text.slice(0, formatter.prefix)}${"*".repeat(text.length - visibleCount)}${text.slice(text.length - formatter.suffix)}`;
}

function formatCustomTemplate(value: CellValue, template: string): string {
  const text = displayCellValue(value);
  return template.replaceAll("${value}", text).replaceAll("${upper}", text.toUpperCase()).replaceAll("${lower}", text.toLowerCase()).replaceAll("${length}", String(text.length));
}

function isSupportedJsonPath(path: string): boolean {
  if (!path.startsWith("$")) return false;
  try {
    parseJsonPath(path);
    return true;
  } catch {
    return false;
  }
}

function parseJsonPath(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  let index = 1;

  while (index < path.length) {
    if (path[index] === ".") {
      const match = path.slice(index + 1).match(/^[A-Za-z_$][\w$]*/);
      if (!match) throw new Error("Invalid JSON path");
      tokens.push(match[0]);
      index += match[0].length + 1;
      continue;
    }
    if (path[index] === "[") {
      const match = path.slice(index).match(/^\[(\d+)\]/);
      if (!match) throw new Error("Invalid JSON path");
      tokens.push(Number(match[1]));
      index += match[0].length;
      continue;
    }
    throw new Error("Invalid JSON path");
  }

  return tokens;
}
