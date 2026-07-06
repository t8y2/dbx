export type SqlParameterValueKind = "string" | "number" | "boolean" | "null" | "raw";

export interface SqlParameterInput {
  kind: SqlParameterValueKind;
  value: string;
}

export type SqlParameterSyntax = "positional" | "named" | "shell" | "mybatis" | "sqlserver";

export interface SqlParameterDescriptor {
  key: string;
  name: string;
  syntax: SqlParameterSyntax;
  token: string;
}

interface ParameterOccurrence extends SqlParameterDescriptor {
  start: number;
  end: number;
}

const PARAMETER_NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const PARAMETER_NAME_START_RE = /[\p{L}_]/u;
const PARAMETER_NAME_CHAR_RE = /[\p{L}\p{N}_]/u;

export function extractSqlParameters(sql: string): string[] {
  return extractSqlParameterDescriptors(sql).map((descriptor) => descriptor.key);
}

export function extractSqlParameterDescriptors(sql: string): SqlParameterDescriptor[] {
  const names = new Set<string>();
  const descriptors: SqlParameterDescriptor[] = [];
  for (const occurrence of findSqlParameterOccurrences(sql)) {
    if (names.has(occurrence.key)) continue;
    names.add(occurrence.key);
    descriptors.push({
      key: occurrence.key,
      name: occurrence.name,
      syntax: occurrence.syntax,
      token: occurrence.token,
    });
  }
  return descriptors;
}

export function substituteSqlParameters(sql: string, values: Record<string, SqlParameterInput>): string {
  const occurrences = findSqlParameterOccurrences(sql);
  if (!occurrences.length) return sql;

  let result = "";
  let cursor = 0;
  for (const occurrence of occurrences) {
    result += sql.slice(cursor, occurrence.start);
    result += sqlParameterLiteral(values[occurrence.key] ?? { kind: "string", value: "" });
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
  const declaredSqlServerVariables = collectDeclaredSqlServerVariables(sql);
  let i = 0;
  let dollarQuoteEnd = "";
  let positionalIndex = 0;

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
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (ch === "?") {
      positionalIndex += 1;
      const key = `?${positionalIndex}`;
      occurrences.push({ key, name: key, syntax: "positional", token: "?", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === ":") {
      const name = readParameterName(sql, i + 1);
      if (name && sql[i - 1] !== ":" && sql[i + 1] !== "=") {
        occurrences.push({
          key: name,
          name,
          syntax: "named",
          token: sql.slice(i, i + 1 + name.length),
          start: i,
          end: i + 1 + name.length,
        });
        i += 1 + name.length;
        continue;
      }
    }
    if (ch === "$" && next === "{") {
      const end = sql.indexOf("}", i + 2);
      if (end !== -1) {
        const name = sql.slice(i + 2, end).trim();
        if (PARAMETER_NAME_RE.test(name)) {
          occurrences.push({ key: name, name, syntax: "shell", token: sql.slice(i, end + 1), start: i, end: end + 1 });
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === "#" && next === "{") {
      const end = sql.indexOf("}", i + 2);
      if (end !== -1) {
        const name = sql.slice(i + 2, end).trim();
        if (PARAMETER_NAME_RE.test(name)) {
          occurrences.push({ key: name, name, syntax: "mybatis", token: sql.slice(i, end + 1), start: i, end: end + 1 });
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === "#") {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "@") {
      const name = readParameterName(sql, i + 1);
      if (name && next !== "@" && sql[i - 1] !== "@" && !declaredSqlServerVariables.has(name.toLowerCase())) {
        occurrences.push({
          key: name,
          name,
          syntax: "sqlserver",
          token: sql.slice(i, i + 1 + name.length),
          start: i,
          end: i + 1 + name.length,
        });
        i += 1 + name.length;
        continue;
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

function collectDeclaredSqlServerVariables(sql: string): Set<string> {
  const declared = new Set<string>();
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
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (ch === "$") {
      const marker = readDollarQuoteMarker(sql, i);
      if (marker) {
        dollarQuoteEnd = marker;
        i += marker.length;
        continue;
      }
    }
    if (ch === "#") {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (matchesWord(sql, i, "declare")) {
      i = collectDeclareStatementVariables(sql, i + "declare".length, declared);
      continue;
    }
    i += 1;
  }

  return declared;
}

function collectDeclareStatementVariables(sql: string, start: number, declared: Set<string>): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === ";") return i + 1;
    if (isLineStatementStart(sql, i) && isSqlStatementKeyword(sql, i)) return i;
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
    if (ch === "/" && next === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (ch === "#") {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "@") {
      const name = readParameterName(sql, i + 1);
      if (name && next !== "@" && sql[i - 1] !== "@") {
        declared.add(name.toLowerCase());
        i += 1 + name.length;
        continue;
      }
    }
    i += 1;
  }
  return i;
}

function isLineStatementStart(sql: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && (sql[i] === " " || sql[i] === "\t" || sql[i] === "\r")) i -= 1;
  return i >= 0 && sql[i] === "\n";
}

function isSqlStatementKeyword(sql: string, start: number): boolean {
  return ["select", "with", "insert", "update", "delete", "merge", "exec", "execute", "set", "if", "while", "begin", "create", "alter", "drop", "truncate"].some((keyword) => matchesWord(sql, start, keyword));
}

function matchesWord(sql: string, start: number, word: string): boolean {
  const value = sql.slice(start, start + word.length);
  if (value.toLowerCase() !== word) return false;
  return !PARAMETER_NAME_CHAR_RE.test(sql[start - 1] ?? "") && !PARAMETER_NAME_CHAR_RE.test(sql[start + word.length] ?? "");
}

function readParameterName(sql: string, start: number): string {
  if (!PARAMETER_NAME_START_RE.test(sql[start] ?? "")) return "";
  let i = start + 1;
  while (i < sql.length && PARAMETER_NAME_CHAR_RE.test(sql[i])) i += 1;
  return sql.slice(start, i);
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
