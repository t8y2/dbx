import { executableStatementRanges } from "@/lib/sql/sqlStatementRanges";
import type { SqlSemanticDiagnostic } from "@/lib/sql/semantic/diagnostics";
import type { DatabaseType, SqlTextSpan } from "@/types/database";

const ORACLE_SYNTAX_DATABASE_TYPES = new Set<DatabaseType>(["oracle", "oceanbase-oracle"]);
const TABLE_CONSTRAINT_STARTERS = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "EXCLUDE", "SUPPLEMENTAL", "PERIOD", "PARTITION", "SUBPARTITION"]);
const NON_TABLE_CREATE_OBJECTS = new Set(["AS", "SELECT", "WITH", "VIEW", "INDEX", "SEQUENCE", "TRIGGER", "PROCEDURE", "FUNCTION", "PACKAGE"]);
const ALTER_TABLE_NON_ADD_ACTIONS = new Set(["MODIFY", "DROP", "RENAME", "ENABLE", "DISABLE"]);
const MESSAGE = "Oracle DEFAULT clause must appear before NOT NULL";

type OracleSyntaxTokenKind = "word" | "symbol";

interface OracleSyntaxToken {
  kind: OracleSyntaxTokenKind;
  value: string;
  from: number;
  to: number;
}

interface TokenRange {
  from: number;
  to: number;
}

export function supportsOracleSyntaxDiagnostics(databaseType?: DatabaseType): boolean {
  return databaseType !== undefined && ORACLE_SYNTAX_DATABASE_TYPES.has(databaseType);
}

export function buildOracleSyntaxDiagnostics(source: string, databaseType?: DatabaseType): SqlSemanticDiagnostic[] {
  if (!supportsOracleSyntaxDiagnostics(databaseType)) return [];

  const diagnostics: SqlSemanticDiagnostic[] = [];
  for (const statement of executableStatementRanges(source, databaseType)) {
    const tokens = tokenizeOracleSyntax(statement.sql, statement.from);
    const definitionRange = columnDefinitionRange(tokens);
    if (!definitionRange) continue;

    for (const definition of splitColumnDefinitions(tokens, definitionRange)) {
      if (isTableConstraint(definition)) continue;
      const offendingDefault = defaultAfterNotNull(definition);
      if (offendingDefault) diagnostics.push(diagnosticAtToken(source, offendingDefault));
    }
  }
  return diagnostics;
}

function columnDefinitionRange(tokens: readonly OracleSyntaxToken[]): TokenRange | null {
  if (tokens[0]?.kind !== "word") return null;

  if (tokens[0].value === "CREATE") {
    const tableIndex = createTableTokenIndex(tokens);
    if (tableIndex === -1) return null;
    const openIndex = firstColumnListOpeningParen(tokens, tableIndex + 1);
    if (openIndex === -1) return null;
    return tokenRangeInsideParentheses(tokens, openIndex);
  }

  if (tokens[0].value !== "ALTER") return null;
  const addIndex = alterTableAddTokenIndex(tokens);
  if (addIndex === -1) return null;

  let definitionStart = addIndex + 1;
  if (tokens[definitionStart]?.kind === "word" && tokens[definitionStart].value === "COLUMN") definitionStart += 1;
  if (tokens[definitionStart]?.kind === "symbol" && tokens[definitionStart].value === "(") {
    return tokenRangeInsideParentheses(tokens, definitionStart);
  }
  return definitionStart < tokens.length ? { from: definitionStart, to: tokens.length } : null;
}

function createTableTokenIndex(tokens: readonly OracleSyntaxToken[]): number {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "symbol" && token.value === "(") return -1;
    if (token.kind !== "word") continue;
    if (token.value === "TABLE") return index;
    if (NON_TABLE_CREATE_OBJECTS.has(token.value)) return -1;
  }
  return -1;
}

function firstColumnListOpeningParen(tokens: readonly OracleSyntaxToken[], from: number): number {
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "symbol" && token.value === "(") return index;
    if (token.kind === "word" && NON_TABLE_CREATE_OBJECTS.has(token.value)) return -1;
  }
  return -1;
}

function alterTableAddTokenIndex(tokens: readonly OracleSyntaxToken[]): number {
  let tableSeen = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "word") continue;
    if (!tableSeen) {
      if (token.value === "TABLE") tableSeen = true;
      continue;
    }
    if (token.value === "ADD") return index;
    if (ALTER_TABLE_NON_ADD_ACTIONS.has(token.value)) return -1;
  }
  return -1;
}

function tokenRangeInsideParentheses(tokens: readonly OracleSyntaxToken[], openIndex: number): TokenRange {
  const closeIndex = matchingRightParen(tokens, openIndex);
  return { from: openIndex + 1, to: closeIndex === -1 ? tokens.length : closeIndex };
}

function matchingRightParen(tokens: readonly OracleSyntaxToken[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "symbol") continue;
    if (token.value === "(") depth += 1;
    else if (token.value === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitColumnDefinitions(tokens: readonly OracleSyntaxToken[], range: TokenRange): OracleSyntaxToken[][] {
  const definitions: OracleSyntaxToken[][] = [];
  let start = range.from;
  let depth = 0;

  for (let index = range.from; index < range.to; index += 1) {
    const token = tokens[index];
    if (token.kind === "symbol" && token.value === "(") depth += 1;
    else if (token.kind === "symbol" && token.value === ")") depth = Math.max(depth - 1, 0);
    else if (token.kind === "symbol" && token.value === "," && depth === 0) {
      if (start < index) definitions.push(tokens.slice(start, index));
      start = index + 1;
    }
  }

  if (start < range.to) definitions.push(tokens.slice(start, range.to));
  return definitions;
}

function isTableConstraint(definition: readonly OracleSyntaxToken[]): boolean {
  const firstWord = definition.find((token) => token.kind === "word")?.value;
  return firstWord !== undefined && TABLE_CONSTRAINT_STARTERS.has(firstWord);
}

function defaultAfterNotNull(definition: readonly OracleSyntaxToken[]): OracleSyntaxToken | null {
  const notNullIndex = definition.findIndex((token, index) => token.kind === "word" && token.value === "NOT" && definition[index + 1]?.kind === "word" && definition[index + 1].value === "NULL");
  if (notNullIndex === -1) return null;
  return definition.slice(notNullIndex + 2).find((token) => token.kind === "word" && token.value === "DEFAULT") ?? null;
}

function diagnosticAtToken(source: string, token: OracleSyntaxToken): SqlSemanticDiagnostic {
  const start = offsetToPosition(source, token.from);
  const end = offsetToPosition(source, token.to);
  const span: SqlTextSpan = {
    start_line: start.line,
    start_column: start.column,
    end_line: end.line,
    end_column: Math.max(end.column - 1, start.column),
  };
  return { span, message: MESSAGE, severity: "error" };
}

function offsetToPosition(source: string, offset: number): { line: number; column: number } {
  const boundedOffset = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < boundedOffset; index += 1) {
    if (source[index] !== "\n") continue;
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: boundedOffset - lineStart + 1 };
}

function tokenizeOracleSyntax(source: string, baseOffset = 0): OracleSyntaxToken[] {
  const tokens: OracleSyntaxToken[] = [];

  for (let index = 0; index < source.length; ) {
    const ignoredEnd = skipIgnorableOracleSyntax(source, index);
    if (ignoredEnd !== null) {
      index = ignoredEnd;
      continue;
    }

    const quotedEnd = skipQuotedOracleSyntax(source, index);
    if (quotedEnd !== null) {
      index = quotedEnd;
      continue;
    }

    const char = source[index];
    const word = /^[A-Za-z_][A-Za-z0-9_$#]*/.exec(source.slice(index))?.[0];
    if (word) {
      tokens.push({ kind: "word", value: word.toUpperCase(), from: baseOffset + index, to: baseOffset + index + word.length });
      index += word.length;
      continue;
    }

    tokens.push({ kind: "symbol", value: char, from: baseOffset + index, to: baseOffset + index + 1 });
    index += 1;
  }

  return tokens;
}

function skipIgnorableOracleSyntax(source: string, index: number): number | null {
  const char = source[index];
  const next = source[index + 1] ?? "";
  if (/\s/.test(char)) return index + 1;
  if (char === "-" && next === "-") return skipLineComment(source, index + 2);
  if (char === "/" && next === "*") return skipBlockComment(source, index + 2);
  return null;
}

function skipQuotedOracleSyntax(source: string, index: number): number | null {
  const char = source[index];
  const next = source[index + 1] ?? "";
  if ((char === "q" || char === "Q") && next === "'") return skipOracleQuotedString(source, index);
  if (char === "'" || char === '"' || char === "`") return skipQuoted(source, index, char);
  return null;
}

function skipLineComment(source: string, from: number): number {
  const newline = source.indexOf("\n", from);
  return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source: string, from: number): number {
  let depth = 1;
  let index = from;
  for (; index < source.length && depth > 0; index += 1) {
    if (source.startsWith("/*", index)) {
      depth += 1;
      index += 1;
    } else if (source.startsWith("*/", index)) {
      depth -= 1;
      index += 1;
    }
  }
  return index;
}

function oracleQuoteCloser(opener: string): string {
  switch (opener) {
    case "[":
      return "]";
    case "(":
      return ")";
    case "{":
      return "}";
    case "<":
      return ">";
    default:
      return opener;
  }
}

function skipOracleQuotedString(source: string, start: number): number {
  const closer = oracleQuoteCloser(source[start + 2] ?? "");
  if (!closer) return source.length;

  for (let index = start + 3; index < source.length; index += 1) {
    if (source[index] === closer && source[index + 1] === "'") return index + 2;
  }
  return source.length;
}

function skipQuoted(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] !== quote) continue;
    if (source[index + 1] === quote) {
      index += 1;
      continue;
    }
    return index + 1;
  }
  return source.length;
}
