import type { ColumnInfo, DatabaseType } from "@/types/database";
import type { DataGridColumnInfo, DataGridContextFilterMode, GridCellValue } from "@/lib/dataGrid/dataGridSql";
import { buildDataGridColumnValueFilterCondition, buildDataGridColumnValuesFilterCondition } from "@/lib/dataGrid/dataGridSql";
import { normalizeWhereInput } from "@/lib/table/tableSelectSql";
import type { DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";
import { uuid } from "@/lib/common/utils";

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
  return mode !== "is-null" && mode !== "is-not-null" && mode !== "is-blank" && mode !== "is-not-blank";
}

export function filterModeUsesList(mode: DataGridContextFilterMode): boolean {
  return mode === "in" || mode === "not-in";
}

export function filterModeUsesRange(mode: DataGridContextFilterMode): boolean {
  return mode === "between" || mode === "not-between";
}

export function filterModeIsSupportedForDatabase(mode: DataGridContextFilterMode, databaseType?: DatabaseType): boolean {
  if (databaseType === "victoriametrics") return false;
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
    // Leading zeros are part of the user's text value, not numeric noise:
    // Number("0000000") is 0, which turned a text-column filter into an
    // integer comparison when the column type was not available (#13059).
    if (/^[+-]?0\d/.test(unquoted)) {
      return unquoted;
    }
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

export function formatFilterRawValue(value: GridCellValue, quoteStrings = false): string {
  if (typeof value === "string") {
    const wrappedInMatchingQuotes = value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')));
    if (!quoteStrings && value.trim() === value && !wrappedInMatchingQuotes) return value;
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (value === null) return "null";
  if (typeof value === "object") return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
  return String(value);
}

export function formatFilterRawValues(values: readonly GridCellValue[]): string {
  return values.map((value) => formatFilterRawValue(value, true)).join(", ");
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
      const quote = first as "'" | '"';
      return text.slice(1, -1).replaceAll(`${quote}${quote}`, quote);
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

/**
 * Parse a hand-written WHERE fragment into structured filter rules, so the
 * filter panel below the grid can show (and edit) the same conditions the
 * user typed in the WHERE box (#15320). All-or-nothing: any conjunct the
 * builder cannot represent (functions, subqueries, column-to-column
 * comparisons, unknown columns, ...) makes the whole parse fail and the
 * caller must leave the manual input and the existing rules untouched.
 * Identifiers may be bare, backtick-quoted (MySQL), double-quoted, or
 * bracket-quoted, and may carry a table qualifier (`t`.`col`).
 */
export function parseDataGridWhereInputToRules(whereInput: string | undefined, columns: readonly string[], createId: () => string = uuid): DataGridStructuredFilterRule[] | null {
  const normalized = normalizeWhereInput(whereInput);
  if (!normalized || !columns.length) return null;
  const segments = splitTopLevelConditions(normalized);
  if (!segments) return null;
  const rules: DataGridStructuredFilterRule[] = [];
  for (const segment of segments) {
    const parsed = parseDataGridWhereCondition(segment.text, columns);
    if (!parsed) return null;
    rules.push({ id: createId(), conjunction: segment.conjunction, ...parsed });
  }
  return rules.length ? rules : null;
}

type DataGridWhereConditionSegment = {
  text: string;
  conjunction: "AND" | "OR";
};

function isAsciiLetter(char: string): boolean {
  return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
}

/**
 * Split on top-level AND/OR, quote- and paren-aware. The AND inside a
 * BETWEEN predicate is part of that predicate, not a split point.
 */
function splitTopLevelConditions(expression: string): DataGridWhereConditionSegment[] | null {
  const segments: DataGridWhereConditionSegment[] = [];
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let bracketQuoted = false;
  let awaitingBetweenAnd = false;
  let conjunction: "AND" | "OR" = "AND";
  let start = 0;

  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]!;
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
      if (depth < 0) return null;
      continue;
    }
    if (depth !== 0 || !isAsciiLetter(char)) continue;
    let end = index + 1;
    while (end < expression.length && isAsciiLetter(expression[end]!)) end += 1;
    const word = expression.slice(index, end).toUpperCase();
    if (word === "BETWEEN") {
      awaitingBetweenAnd = true;
    } else if (word === "AND" || word === "OR") {
      if (word === "AND" && awaitingBetweenAnd) {
        awaitingBetweenAnd = false;
      } else {
        const text = expression.slice(start, index).trim();
        if (!text) return null;
        segments.push({ text, conjunction });
        conjunction = word;
        start = end;
      }
    }
    index = end - 1;
  }
  if (depth !== 0 || quote || bracketQuoted) return null;
  const last = expression.slice(start).trim();
  if (!last) return null;
  segments.push({ text: last, conjunction });
  return segments;
}

function splitTopLevelCommas(source: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let bracketQuoted = false;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (bracketQuoted) {
      if (char === "]") {
        if (source[index + 1] === "]") index += 1;
        else bracketQuoted = false;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (source[index + 1] === quote) index += 1;
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
    else if (char === "," && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
    if (depth < 0) return null;
  }
  if (depth !== 0 || quote || bracketQuoted) return null;
  parts.push(source.slice(start));
  return parts;
}

/** Find the first top-level AND; the BETWEEN separator, never a split point. */
function splitTopLevelAndOnce(expression: string): { left: string; right: string } | null {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  let bracketQuoted = false;
  for (let index = 0; index < expression.length; index += 1) {
    const char = expression[index]!;
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
    if (depth < 0) return null;
    if (depth !== 0 || !isAsciiLetter(char)) continue;
    let end = index + 1;
    while (end < expression.length && isAsciiLetter(expression[end]!)) end += 1;
    if (expression.slice(index, end).toUpperCase() === "AND") {
      return { left: expression.slice(0, index).trim(), right: expression.slice(end).trim() };
    }
    index = end - 1;
  }
  if (depth !== 0 || quote || bracketQuoted) return null;
  return null;
}

/** Unescape a quoted identifier or string literal (doubled quote = one quote). */
function unescapeDoubledQuotes(text: string, quote: string): string {
  return text.replaceAll(`${quote}${quote}`, quote);
}

function matchQuotedIdentifier(text: string): { name: string; rest: string } | null {
  const quote = text[0]!;
  if (quote !== "`" && quote !== '"' && quote !== "[") return null;
  const close = quote === "[" ? "]" : quote;
  let end = 1;
  while (end < text.length) {
    if (text[end] === close) {
      if (text[end + 1] === close && close !== "]") {
        end += 2;
        continue;
      }
      return { name: unescapeDoubledQuotes(text.slice(1, end), close), rest: text.slice(end + 1) };
    }
    end += 1;
  }
  return null;
}

function resolveWhereColumnName(identifier: string, columns: readonly string[]): string | null {
  const parts = identifier.split(".");
  const name = parts[parts.length - 1]!.trim();
  if (!name) return null;
  const found = columns.find((column) => column.toLowerCase() === name.toLowerCase());
  return found ?? null;
}

/** A single literal the builder can round-trip: quoted string, number, true/false. */
function parseWhereLiteral(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const first = trimmed[0]!;
  if (first === "'" || first === '"') {
    let end = 1;
    while (end < trimmed.length) {
      if (trimmed[end] === first) {
        if (trimmed[end + 1] === first) {
          end += 2;
          continue;
        }
        if (end !== trimmed.length - 1) return null;
        return unescapeDoubledQuotes(trimmed.slice(1, end), first);
      }
      end += 1;
    }
    return null;
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed;
  if (isNumericLiteral(trimmed)) return trimmed;
  return null;
}

const WHERE_OPERATORS: Array<{ pattern: RegExp; mode: DataGridContextFilterMode }> = [
  { pattern: /^is\s+not\s+null\b/i, mode: "is-not-null" },
  { pattern: /^is\s+null\b/i, mode: "is-null" },
  { pattern: /^not\s+between\b/i, mode: "not-between" },
  { pattern: /^between\b/i, mode: "between" },
  { pattern: /^not\s+like\b/i, mode: "not-like" },
  { pattern: /^like\b/i, mode: "like" },
  { pattern: /^not\s+in\b/i, mode: "not-in" },
  { pattern: /^in\b/i, mode: "in" },
  { pattern: /^!=/, mode: "not-equals" },
  { pattern: /^<>/, mode: "not-equals" },
  { pattern: /^>=/, mode: "greater-than-or-equal" },
  { pattern: /^<=/, mode: "less-than-or-equal" },
  { pattern: /^=/, mode: "equals" },
  { pattern: /^>/, mode: "greater-than" },
  { pattern: /^</, mode: "less-than" },
];

/**
 * A LIKE pattern only maps onto a builder mode when its wildcards sit
 * exactly at the edges; anything else (a bare literal, inner wildcards)
 * would change meaning if rebuilt, so it stays unparseable.
 */
function parseLikePattern(pattern: string, negated: boolean): { mode: DataGridContextFilterMode; rawValue: string } | null {
  const hasLeading = pattern.startsWith("%");
  const hasTrailing = pattern.endsWith("%");
  const inner = pattern.slice(hasLeading ? 1 : 0, hasTrailing ? -1 : undefined);
  if (!inner || /[%_]/.test(inner)) return null;
  if (hasLeading && hasTrailing) return { mode: negated ? "not-like" : "like", rawValue: inner };
  if (hasTrailing) return { mode: negated ? "not-begins-with" : "begins-with", rawValue: inner };
  if (hasLeading) return { mode: negated ? "not-ends-with" : "ends-with", rawValue: inner };
  return null;
}

type ParsedWhereCondition = Omit<DataGridStructuredFilterRule, "id" | "conjunction" | "disabled">;

function parseDataGridWhereCondition(segment: string, columns: readonly string[]): ParsedWhereCondition | null {
  let text = segment.trim();
  for (;;) {
    const unwrapped = unwrapOuterParentheses(text);
    if (unwrapped === text) break;
    text = unwrapped;
  }
  if (!text) return null;

  const readIdentifier = (source: string): { name: string; rest: string } | null => {
    const quotedPart = matchQuotedIdentifier(source);
    if (quotedPart) return quotedPart;
    const bare = /^[A-Za-z_$\p{L}][\w$]*/u.exec(source);
    if (!bare) return null;
    return { name: bare[0], rest: source.slice(bare[0].length) };
  };
  const first = readIdentifier(text);
  if (!first) return null;
  // A table qualifier (`t`.`col`, t.col) is not part of the column name.
  let lastName = first.name;
  let rest = first.rest;
  while (rest.startsWith(".")) {
    const next = readIdentifier(rest.slice(1));
    if (!next) return null;
    lastName = next.name;
    rest = next.rest;
  }
  const columnName = resolveWhereColumnName(lastName, columns);
  if (!columnName) return null;
  rest = rest.trimStart();
  if (!rest) return null;

  const operator = WHERE_OPERATORS.find((candidate) => candidate.pattern.test(rest));
  if (!operator) return null;
  rest = rest.replace(operator.pattern, "").trim();
  const mode = operator.mode;

  if (mode === "is-null" || mode === "is-not-null") {
    if (rest) return null;
    return { columnName, mode, rawValue: "", rawEndValue: "" };
  }

  if (mode === "in" || mode === "not-in") {
    const inner = unwrapOuterParentheses(rest);
    if (inner === rest) return null;
    const parts = splitTopLevelCommas(inner);
    if (!parts) return null;
    const values = parts.map((part) => parseWhereLiteral(part));
    if (!values.length || values.some((value) => value === null)) return null;
    return { columnName, mode, rawValue: inner.trim(), rawEndValue: "" };
  }

  if (mode === "between" || mode === "not-between") {
    const split = splitTopLevelAndOnce(rest);
    if (!split) return null;
    const low = parseWhereLiteral(split.left);
    const high = parseWhereLiteral(split.right);
    if (low === null || high === null) return null;
    return { columnName, mode, rawValue: low, rawEndValue: high };
  }

  if (mode === "like" || mode === "not-like") {
    const value = parseWhereLiteral(rest);
    if (value === null) return null;
    const mapped = parseLikePattern(value, mode === "not-like");
    if (!mapped) return null;
    return { columnName, mode: mapped.mode, rawValue: mapped.rawValue, rawEndValue: "" };
  }

  const value = parseWhereLiteral(rest);
  if (value === null) return null;
  return { columnName, mode, rawValue: value, rawEndValue: "" };
}
