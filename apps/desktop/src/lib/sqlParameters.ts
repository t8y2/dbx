export type SqlParameterValueKind = "string" | "number" | "boolean" | "null" | "raw";

export interface SqlParameterInput {
  kind: SqlParameterValueKind;
  value: string;
}

interface ParameterOccurrence {
  name: string;
  start: number;
  end: number;
}

const PARAMETER_NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;

export function extractSqlParameters(sql: string): string[] {
  const names = new Set<string>();
  for (const occurrence of findSqlParameterOccurrences(sql)) {
    names.add(occurrence.name);
  }
  return [...names];
}

export function substituteSqlParameters(sql: string, values: Record<string, SqlParameterInput>): string {
  const occurrences = findSqlParameterOccurrences(sql);
  if (!occurrences.length) return sql;

  let result = "";
  let cursor = 0;
  for (const occurrence of occurrences) {
    result += sql.slice(cursor, occurrence.start);
    result += sqlParameterLiteral(values[occurrence.name] ?? { kind: "string", value: "" });
    cursor = occurrence.end;
  }
  result += sql.slice(cursor);
  return result;
}

export function sqlParameterLiteral(input: SqlParameterInput): string {
  if (input.kind === "null") return "NULL";
  const raw = input.value;
  if (input.kind === "raw") return raw.trim() || "NULL";
  if (input.kind === "number") return raw.trim() || "NULL";
  if (input.kind === "boolean") return normalizeBooleanLiteral(raw);
  return quoteSqlString(raw);
}

function findSqlParameterOccurrences(sql: string): ParameterOccurrence[] {
  const occurrences: ParameterOccurrence[] = [];
  let i = 0;
  let dollarQuoteEnd = "";

  while (i < sql.length) {
    if (dollarQuoteEnd) {
      const end = sql.indexOf(dollarQuoteEnd, i);
      if (end === -1) break;
      i = end + dollarQuoteEnd.length;
      dollarQuoteEnd = "";
      continue;
    }

    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "[") {
      i = skipBracketIdentifier(sql, i);
      continue;
    }
    if (ch === "-" && next === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (ch === "#") {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (ch === "$" && next === "{") {
      const end = sql.indexOf("}", i + 2);
      if (end !== -1) {
        const name = sql.slice(i + 2, end).trim();
        if (PARAMETER_NAME_RE.test(name)) {
          occurrences.push({ name, start: i, end: end + 1 });
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === "$") {
      const marker = readDollarQuoteMarker(sql, i);
      if (marker) {
        dollarQuoteEnd = marker;
        i += marker.length;
        continue;
      }
    }
    i += 1;
  }

  return occurrences;
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "\\" && quote === "'" && i + 1 < sql.length) {
      i += 2;
      continue;
    }
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

function skipBracketIdentifier(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "]") {
      if (sql[i + 1] === "]") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

function skipLine(sql: string, start: number): number {
  const nextNewline = sql.indexOf("\n", start);
  return nextNewline === -1 ? sql.length : nextNewline + 1;
}

function skipBlockComment(sql: string, start: number): number {
  const end = sql.indexOf("*/", start);
  return end === -1 ? sql.length : end + 2;
}

function readDollarQuoteMarker(sql: string, start: number): string {
  const match = sql.slice(start).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
  return match?.[0] ?? "";
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizeBooleanLiteral(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "t" || normalized === "yes" || normalized === "y" || normalized === "1") return "TRUE";
  if (normalized === "false" || normalized === "f" || normalized === "no" || normalized === "n" || normalized === "0") return "FALSE";
  return quoteSqlString(value);
}
