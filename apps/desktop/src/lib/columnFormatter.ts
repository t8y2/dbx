import { displayCellValue, type CellValue } from "@/lib/cellValue";
import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

export type DateTimeFormatterUnit = "seconds" | "milliseconds" | "auto";
const DEFAULT_DATETIME_PATTERN = "YYYY-MM-DD HH:mm:ss";
export const DateTimePatterns = ["HH:mm:ss", "HH:mm:ss.SSS", "YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm:ss.SSS", "YYYY/MM/DD HH:mm:ss", "YYYY/MM/DD HH:mm:ss.SSS", "YYYY-MM-DDTHH:mm:ssZ[Z]", "YYYY-MM-DDTHH:mm:ss.SSSZ[Z]", "YYYY/MM/DDTHH:mm:ssZ[Z]", "YYYY/MM/DDTHH:mm:ss.SSSZ[Z]"];

export interface CustomColumnFormatterConfig {
  id: string;
  name: string;
  template: string;
}

export type ColumnFormatterConfig = { kind: "datetime"; unit: DateTimeFormatterUnit; pattern: string } | { kind: "json-path"; path: string } | { kind: "mask"; prefix: number; suffix: number } | { kind: "custom-template"; template: string } | { kind: "custom-ref"; formatterId: string };

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
  const config = value as Record<string, unknown>;

  if (config.kind === "datetime") {
    return config.unit === "seconds" || config.unit === "milliseconds" || config.unit === "auto"
      ? {
          kind: "datetime",
          unit: config.unit,
          pattern: (config.pattern as string) || "YYYY-MM-DD HH:mm:ss",
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

export function resolveColumnFormatter(formatter: ColumnFormatterConfig | undefined, customFormatters: Record<string, CustomColumnFormatterConfig>): ColumnFormatterConfig | undefined {
  if (!formatter) return undefined;
  if (formatter.kind !== "custom-ref") return formatter;
  const customFormatter = customFormatters[formatter.formatterId];
  return customFormatter ? { kind: "custom-template", template: customFormatter.template } : undefined;
}

export function applyColumnFormatter(value: CellValue, formatter: ColumnFormatterConfig | undefined): string {
  if (!formatter) return displayCellValue(value);

  try {
    if (formatter.kind === "datetime") return formatDateTime(value, formatter.unit, formatter.pattern);
    if (formatter.kind === "json-path") return formatJsonPath(value, formatter.path);
    if (formatter.kind === "mask") return formatMask(value, formatter);
    if (formatter.kind === "custom-template") return formatCustomTemplate(value, formatter.template);
    return displayCellValue(value);
  } catch {
    return displayCellValue(value);
  }
}

function formatDateTime(value: CellValue, unit: DateTimeFormatterUnit, pattern: string): string {
  if (value === null) return displayCellValue(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  const parsed: Dayjs | undefined = resolveDateTimeValue(value, unit);
  return parsed ? parsed.format(pattern || DEFAULT_DATETIME_PATTERN) : displayCellValue(value);
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
    const parsedDate = dayjs(trimmed);
    return parsedDate.isValid() ? parsedDate : undefined;
  }

  const timestamp = parseTimestampMilliseconds(value, unit);
  if (timestamp === undefined) return undefined;

  const parsedTimestamp = dayjs(timestamp);
  return parsedTimestamp.isValid() ? parsedTimestamp : undefined;
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
    if (!/^-?\d+$/.test(trimmed)) return undefined;
    return trimmed.startsWith("-") ? trimmed.length - 1 : trimmed.length;
  } else if (!Number.isInteger(value)) {
    return undefined;
  } else {
    return Math.abs(value).toString().length;
  }
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
