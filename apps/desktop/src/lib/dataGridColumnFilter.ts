import type { ColumnInfo, DatabaseType } from "@/types/database";
import type { DataGridColumnInfo, DataGridContextFilterMode, GridCellValue } from "@/lib/dataGridSql";
import { buildDataGridColumnValueFilterCondition, buildDataGridColumnValuesFilterCondition } from "@/lib/dataGridSql";
import { normalizeWhereInput } from "@/lib/tableSelectSql";

export function buildColumnValueFilterCondition(options: { databaseType?: DatabaseType; columnName: string; columnInfo?: Pick<ColumnInfo, "data_type">; rawValue: string }): Promise<string | undefined> {
  return buildDataGridColumnValueFilterCondition({
    databaseType: options.databaseType,
    columnName: options.columnName,
    columnInfo: options.columnInfo
      ? {
          name: options.columnName,
          data_type: options.columnInfo.data_type,
          is_nullable: true,
        }
      : undefined,
    rawValue: options.rawValue,
  });
}

export function buildColumnValuesFilterCondition(options: { databaseType?: DatabaseType; columnName: string; columnInfo?: Pick<ColumnInfo, "data_type">; values: GridCellValue[] }): Promise<string | undefined> {
  return buildDataGridColumnValuesFilterCondition({
    databaseType: options.databaseType,
    columnName: options.columnName,
    columnInfo: options.columnInfo
      ? {
          name: options.columnName,
          data_type: options.columnInfo.data_type,
          is_nullable: true,
        }
      : undefined,
    values: options.values,
  });
}

export function appendColumnValueFilterCondition(whereInput: string | undefined, condition: string | undefined): string {
  if (!condition) return normalizeWhereInput(whereInput);
  const existing = normalizeWhereInput(whereInput);
  return existing ? `(${existing}) AND (${condition})` : condition;
}

export function combineWhereInputs(manualWhereInput?: string, structuredWhereInput?: string): string | undefined {
  const manual = normalizeWhereInput(manualWhereInput);
  const structured = normalizeWhereInput(structuredWhereInput);
  if (manual && structured) return `(${manual}) AND (${structured})`;
  return manual || structured || undefined;
}

export function filterModeNeedsValue(mode: DataGridContextFilterMode): boolean {
  return mode !== "is-null" && mode !== "is-not-null";
}

export function parseFilterValue(rawValue: string, columnInfo?: Pick<DataGridColumnInfo, "data_type">): GridCellValue {
  const unquoted = unwrapMatchingQuotes(rawValue.trim());
  const dataType = (columnInfo?.data_type ?? "").toLowerCase();

  if (isBooleanType(dataType) && unquoted.toLowerCase() === "true") return true;
  if (isBooleanType(dataType) && unquoted.toLowerCase() === "false") return false;

  if ((isNumericType(dataType) || !dataType) && isNumericLiteral(unquoted)) {
    const numeric = Number(unquoted);
    if (Number.isFinite(numeric)) {
      // Keep large integers as strings to avoid JS precision loss (> Number.MAX_SAFE_INTEGER).
      // The Rust backend parses strings exactly via serde_json::Number, so this is safe.
      if (Number.isInteger(numeric) && Math.abs(numeric) > Number.MAX_SAFE_INTEGER) {
        return unquoted;
      }
      return numeric;
    }
  }

  return unquoted;
}

function unwrapMatchingQuotes(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function isNumericType(dataType: string): boolean {
  return ["int", "integer", "bigint", "smallint", "tinyint", "mediumint", "serial", "number", "numeric", "decimal", "float", "double", "real", "money"].some((part) => dataType.split(/[^a-z0-9]+/).includes(part));
}

function isBooleanType(dataType: string): boolean {
  return dataType.split(/[^a-z0-9]+/).some((part) => part === "bool" || part === "boolean" || part === "bit");
}

function isNumericLiteral(text: string): boolean {
  if (!text || text.trim() !== text) return false;
  return Number.isFinite(Number(text)) && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text);
}
