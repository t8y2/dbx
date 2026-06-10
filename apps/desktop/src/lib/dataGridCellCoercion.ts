import type { GridCellValue } from "@/lib/dataGridSql";
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
    if (!Number.isNaN(num)) return num;
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
      const parsed = parsePostgresArrayText(trimmed);
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

function normalizeSmartQuotedJsonInput(value: string): string {
  if (!/[“”]/.test(value)) return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    JSON.parse(value);
    return value;
  } catch {
    // macOS smart punctuation can turn JSON delimiters into Chinese-style quotes.
  }
  const normalized = normalizeSmartQuotes(value);
  try {
    JSON.parse(normalized);
    return normalized;
  } catch {
    return value;
  }
}

function normalizeSmartQuotes(value: string): string {
  return value.replace(/[“”]/g, '"');
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

function parsePostgresArrayText(value: string): unknown[] {
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
      element = parsePostgresArrayText(inner.slice(start, i));
    } else {
      let start = i;
      while (i < inner.length && inner[i] !== "," && inner[i] !== "}") i++;
      const token = inner.slice(start, i).trim();
      if (token.toUpperCase() === "NULL") {
        element = null;
      } else if (/^(true|false)$/i.test(token)) {
        element = token.toLowerCase() === "true";
      } else if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)) {
        element = Number(token);
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
