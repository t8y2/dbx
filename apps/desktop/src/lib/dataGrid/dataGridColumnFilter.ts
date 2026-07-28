import type { ColumnInfo, DatabaseType } from "@/types/database";
import type { DataGridColumnInfo, DataGridContextFilterMode, GridCellValue } from "@/lib/dataGrid/dataGridSql";
import { buildDataGridColumnValueFilterCondition, buildDataGridColumnValuesFilterCondition } from "@/lib/dataGrid/dataGridSql";
import { normalizeWhereInput } from "@/lib/table/tableSelectSql";

export function buildColumnValueFilterCondition(options: { databaseType?: DatabaseType; identifierQuote?: string; columnName: string; columnInfo?: Pick<ColumnInfo, "data_type">; rawValue: string }): Promise<string | undefined> {
  return buildDataGridColumnValueFilterCondition({
    databaseType: options.databaseType,
    identifierQuote: options.identifierQuote,
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

export function buildColumnValuesFilterCondition(options: { databaseType?: DatabaseType; identifierQuote?: string; columnName: string; columnInfo?: Pick<ColumnInfo, "data_type">; values: GridCellValue[] }): Promise<string | undefined> {
  return buildDataGridColumnValuesFilterCondition({
    databaseType: options.databaseType,
    identifierQuote: options.identifierQuote,
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

export function removeColumnValueFilterCondition(whereInput: string | undefined, condition: string | undefined): string {
  const existing = normalizeWhereInput(whereInput);
  const target = normalizeWhereInput(condition);
  if (!existing || !target) return existing;
  return removeExactCondition(existing, target).value;
}

export function replaceColumnValueFilterCondition(whereInput: string | undefined, previousCondition: string | undefined, nextCondition: string | undefined): string {
  return appendColumnValueFilterCondition(removeColumnValueFilterCondition(whereInput, previousCondition), nextCondition);
}

type RemovedCondition = {
  value: string;
  removed: boolean;
};

function removeExactCondition(expression: string, target: string): RemovedCondition {
  const normalized = normalizeWhereInput(expression);
  if (normalized === target) return { value: "", removed: true };

  // Only decompose top-level AND groups produced by appendColumnValueFilterCondition;
  // quote-aware scanning keeps literals and predicates such as BETWEEN intact.
  const inner = unwrapOuterParentheses(normalized);
  if (inner !== normalized) {
    const result = removeExactCondition(inner, target);
    if (result.removed) return result;
  }

  const split = splitTopLevelAnd(normalized);
  if (!split) return { value: normalized, removed: false };
  const left = removeExactCondition(split.left, target);
  const right = removeExactCondition(split.right, target);
  if (!left.removed && !right.removed) return { value: normalized, removed: false };
  if (!left.value) return { value: unwrapOuterParentheses(right.value), removed: true };
  if (!right.value) return { value: unwrapOuterParentheses(left.value), removed: true };
  return {
    value: `(${unwrapOuterParentheses(left.value)}) AND (${unwrapOuterParentheses(right.value)})`,
    removed: true,
  };
}

function unwrapOuterParentheses(expression: string): string {
  if (!expression.startsWith("(") || !expression.endsWith(")")) return expression;
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let bracketQuoted = false;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index];
    if (bracketQuoted) {
      if (char === "]") {
        if (expression[index + 1] === "]") index += 1;
        else bracketQuoted = false;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (expression[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "[") {
      bracketQuoted = true;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth === 0 && index < expression.length - 1) return expression;
  }
  return depth === 0 ? expression.slice(1, -1).trim() : expression;
}

function splitTopLevelAnd(expression: string): { left: string; right: string } | null {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let bracketQuoted = false;
  for (let index = 0; index <= expression.length - 5; index += 1) {
    const char = expression[index];
    if (bracketQuoted) {
      if (char === "]") {
        if (expression[index + 1] === "]") index += 1;
        else bracketQuoted = false;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (expression[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "[") {
      bracketQuoted = true;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && expression.slice(index, index + 5).toUpperCase() === " AND ") {
      return {
        left: expression.slice(0, index).trim(),
        right: expression.slice(index + 5).trim(),
      };
    }
  }
  return null;
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

export function filterModeUsesList(mode: DataGridContextFilterMode): boolean {
  return mode === "in" || mode === "not-in";
}

export function filterModeUsesRange(mode: DataGridContextFilterMode): boolean {
  return mode === "between" || mode === "not-between";
}

export function filterModeIsSupportedForDatabase(mode: DataGridContextFilterMode, databaseType?: DatabaseType): boolean {
  if (!filterModeUsesList(mode) && !filterModeUsesRange(mode)) return true;
  // These targets do not support all four new SQL predicates reliably.
  return databaseType !== "cassandra" && databaseType !== "influxdb" && databaseType !== "jdbc";
}

export function filterModeHasCompleteValue(mode: DataGridContextFilterMode, rawValue: string, rawEndValue = ""): boolean {
  if (!filterModeNeedsValue(mode)) return true;
  if (filterModeUsesList(mode)) return parseFilterValues(rawValue).length > 0;
  if (filterModeUsesRange(mode)) return rawValue.trim().length > 0 && rawEndValue.trim().length > 0;
  return rawValue.trim().length > 0;
}

export function parseFilterValue(rawValue: string, columnInfo?: Pick<DataGridColumnInfo, "data_type">, databaseType?: DatabaseType): GridCellValue {
  const unquoted = unwrapMatchingQuotes(rawValue.trim());
  const dataType = (columnInfo?.data_type ?? "").toLowerCase();

  if (isBooleanType(dataType, databaseType) && unquoted.toLowerCase() === "true") return true;
  if (isBooleanType(dataType, databaseType) && unquoted.toLowerCase() === "false") return false;

  if (isNumericType(dataType) && isNumericLiteral(unquoted)) {
    // Preserve the original decimal/integer spelling so the backend can emit it exactly.
    return unquoted;
  }

  if (!dataType && isNumericLiteral(unquoted)) {
    const numeric = Number(unquoted);
    if (Number.isFinite(numeric)) {
      // Keep large integers as strings to avoid JS precision loss (> Number.MAX_SAFE_INTEGER).
      if (Number.isInteger(numeric) && Math.abs(numeric) > Number.MAX_SAFE_INTEGER) {
        return unquoted;
      }
      return numeric;
    }
  }

  return unquoted;
}

export function parseFilterValues(rawValue: string, columnInfo?: Pick<DataGridColumnInfo, "data_type">, databaseType?: DatabaseType): GridCellValue[] {
  return splitFilterValues(rawValue).map(({ value, quoted }) => {
    if (!quoted && value.toLowerCase() === "null") return null;
    return parseFilterValue(value, columnInfo, databaseType);
  });
}

type ParsedFilterValue = {
  value: string;
  quoted: boolean;
};

function splitFilterValues(source: string): ParsedFilterValue[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if ((char === "'" || char === '"') && current.trim().length === 0) {
      quote = char;
      current += char;
      continue;
    }

    if (char === "," || char === "\n" || char === "\r") {
      tokens.push(current);
      current = "";
      continue;
    }

    current += char;
  }
  tokens.push(current);

  return tokens.map(normalizeFilterValue).filter((value): value is ParsedFilterValue => !!value);
}

function normalizeFilterValue(token: string): ParsedFilterValue | null {
  const text = token.trim();
  if (!text) return null;

  const first = text[0];
  const last = text[text.length - 1];
  const quoted = text.length >= 2 && ((first === "'" && last === "'") || (first === '"' && last === '"'));
  if (!quoted) return { value: text, quoted: false };

  const quote = first as "'" | '"';
  const value = text.slice(1, -1).replaceAll(`${quote}${quote}`, quote);
  return { value, quoted: true };
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

function isBooleanType(dataType: string, databaseType?: DatabaseType): boolean {
  return dataType.split(/[^a-z0-9]+/).some((part) => part === "bool" || part === "boolean" || (part === "bit" && databaseType !== "postgres"));
}

function isNumericLiteral(text: string): boolean {
  if (!text || text.trim() !== text) return false;
  return Number.isFinite(Number(text)) && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text);
}
