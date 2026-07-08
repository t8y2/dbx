// Client-side SQL variable expansion.
//
// Lets users declare reusable values inside a SQL script with `@set name = value;`
// and reference them elsewhere as `@name`. Expansion happens entirely on the client:
// declarations are stripped and every reference is replaced with the declared value
// verbatim (raw). Because the SQL sent to the server contains only plain literals,
// this works uniformly across PostgreSQL, MySQL, SQL Server and every other backend
// regardless of whether they have native variable support.
//
// This is intentionally separate from the placeholder parameter system
// (`sqlParameters.ts`). A `@name` reference is only expanded when a matching
// `@set` declaration exists in the same script; any other `@name` (SQL Server
// native variables, `@@version`, dialog parameters) is left untouched.

const VARIABLE_NAME_START_RE = /[\p{L}_]/u;
const VARIABLE_NAME_CHAR_RE = /[\p{L}\p{N}_]/u;

export interface SqlVariableExpansion {
  sql: string;
  expanded: boolean;
}

interface DeclarationSpan {
  name: string;
  value: string;
  start: number;
  end: number;
}

/**
 * Expand `@set name = value;` declarations within a SQL script.
 *
 * Returns the SQL with declarations removed and `@name` references replaced by
 * their declared values. When no declaration is found the input is returned
 * unchanged with `expanded: false`.
 */
export function expandSqlVariables(sql: string): SqlVariableExpansion {
  const declarations = collectDeclarations(sql);
  if (!declarations.length) return { sql, expanded: false };

  const values = new Map<string, string>();
  for (const declaration of declarations) {
    values.set(declaration.name.toLowerCase(), declaration.value);
  }

  // Remove declaration spans first (right-to-left keeps earlier offsets valid),
  // then replace references in the remaining text.
  let result = sql;
  for (let i = declarations.length - 1; i >= 0; i -= 1) {
    const declaration = declarations[i];
    result = stripDeclaration(result, declaration.start, declaration.end);
  }

  result = replaceReferences(result, values);
  return { sql: result, expanded: true };
}

function collectDeclarations(sql: string): DeclarationSpan[] {
  const declarations: DeclarationSpan[] = [];
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
    if (ch === "@" && matchesWord(sql, i + 1, "set") && isStatementStart(sql, i)) {
      const declaration = readDeclaration(sql, i);
      if (declaration) {
        declarations.push(declaration);
        i = declaration.end;
        continue;
      }
    }
    i += 1;
  }

  return declarations;
}

// Parse `@set name = value` starting at `start` (the `@`). The value runs until
// the terminating `;` or end of input, honouring nested quotes, comments and
// parentheses so that `IN (...)` lists and quoted strings survive intact.
function readDeclaration(sql: string, start: number): DeclarationSpan | null {
  let i = start + 1 + "set".length;
  i = skipInlineWhitespace(sql, i);

  const name = readVariableName(sql, i);
  if (!name) return null;
  i += name.length;

  i = skipInlineWhitespace(sql, i);
  if (sql[i] !== "=") return null;
  i += 1;
  i = skipInlineWhitespace(sql, i);

  const valueStart = i;
  const valueEnd = readValueEnd(sql, i);
  const value = sql.slice(valueStart, valueEnd).trim();
  if (!value) return null;

  // Consume the terminating semicolon so the declaration disappears cleanly.
  let end = valueEnd;
  if (sql[end] === ";") end += 1;

  return { name, value, start, end };
}

function readValueEnd(sql: string, start: number): number {
  let i = start;
  let depth = 0;
  while (i < sql.length) {
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
    if (ch === "-" && next === "-") return i;
    if (ch === "/" && next === "*") return i;
    if (ch === "$") {
      const marker = readDollarQuoteMarker(sql, i);
      if (marker) {
        const end = sql.indexOf(marker, i + marker.length);
        i = end === -1 ? sql.length : end + marker.length;
        continue;
      }
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if ((ch === ";" || ch === "\n") && depth === 0) return i;
    i += 1;
  }
  return sql.length;
}

function replaceReferences(sql: string, values: Map<string, string>): string {
  let result = "";
  let i = 0;
  let dollarQuoteEnd = "";

  while (i < sql.length) {
    if (dollarQuoteEnd) {
      const end = sql.indexOf(dollarQuoteEnd, i);
      const stop = end === -1 ? sql.length : end + dollarQuoteEnd.length;
      result += sql.slice(i, stop);
      i = stop;
      dollarQuoteEnd = "";
      continue;
    }

    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'" || ch === '"' || ch === "`") {
      const end = skipQuoted(sql, i, ch);
      result += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "[") {
      const end = skipBracketIdentifier(sql, i);
      result += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "-" && next === "-") {
      const end = skipLine(sql, i + 2);
      result += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = skipBlockComment(sql, i + 2);
      result += sql.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "$") {
      const marker = readDollarQuoteMarker(sql, i);
      if (marker) {
        result += marker;
        i += marker.length;
        dollarQuoteEnd = marker;
        continue;
      }
    }
    if (ch === "@" && next !== "@" && sql[i - 1] !== "@") {
      const name = readVariableName(sql, i + 1);
      if (name) {
        const value = values.get(name.toLowerCase());
        if (value !== undefined) {
          result += value;
          i += 1 + name.length;
          continue;
        }
      }
    }
    result += ch;
    i += 1;
  }

  return result;
}

// Remove a declaration span, collapsing the leftover blank line it leaves behind
// so the expanded SQL stays tidy.
function stripDeclaration(sql: string, start: number, end: number): string {
  let lineStart = start;
  while (lineStart > 0 && sql[lineStart - 1] !== "\n") {
    if (sql[lineStart - 1] !== " " && sql[lineStart - 1] !== "\t" && sql[lineStart - 1] !== "\r") break;
    lineStart -= 1;
  }
  const trimmableStart = lineStart === 0 || sql[lineStart - 1] === "\n" ? lineStart : start;

  let lineEnd = end;
  while (lineEnd < sql.length && (sql[lineEnd] === " " || sql[lineEnd] === "\t" || sql[lineEnd] === "\r")) lineEnd += 1;
  if (trimmableStart === lineStart && sql[lineEnd] === "\n") lineEnd += 1;

  return sql.slice(0, trimmableStart) + sql.slice(lineEnd);
}

function isStatementStart(sql: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && /\s/.test(sql[i])) i -= 1;
  return i < 0 || sql[i] === ";";
}

function matchesWord(sql: string, start: number, word: string): boolean {
  const value = sql.slice(start, start + word.length);
  if (value.toLowerCase() !== word) return false;
  return !VARIABLE_NAME_CHAR_RE.test(sql[start + word.length] ?? "");
}

function readVariableName(sql: string, start: number): string {
  if (!VARIABLE_NAME_START_RE.test(sql[start] ?? "")) return "";
  let i = start + 1;
  while (i < sql.length && VARIABLE_NAME_CHAR_RE.test(sql[i])) i += 1;
  return sql.slice(start, i);
}

function skipInlineWhitespace(sql: string, start: number): number {
  let i = start;
  while (i < sql.length && (sql[i] === " " || sql[i] === "\t" || sql[i] === "\r")) i += 1;
  return i;
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
