import type { SqlSemanticDiagnostic } from "@/lib/sql/semantic/diagnostics";
import type { DatabaseType, SqlTextSpan } from "@/types/database";

export const SQLSERVER_DECLARE_MISSING_DATA_TYPE_MESSAGE = "T-SQL DECLARE requires a data type before the default value";

type SqlServerTokenKind = "word" | "variable" | "symbol";

interface SqlServerToken {
  kind: SqlServerTokenKind;
  value: string;
  from: number;
  to: number;
}

export function supportsSqlServerRoutineSyntaxDiagnostics(databaseType?: DatabaseType): boolean {
  return databaseType === "sqlserver";
}

/**
 * Syntax rules for T-SQL routine bodies (`CREATE/ALTER PROCEDURE | FUNCTION`).
 *
 * Routine batches are skipped by the semantic diagnostic pipeline (the analyzer's
 * MsSql grammar cannot parse the parameter list), so nothing inside a stored
 * procedure was ever checked while editing it. Re-parsing the body with that same
 * grammar is not an option either: valid T-SQL such as `WHILE ... BEGIN ... END`,
 * `IF/ELSE`, `TRY/CATCH` and `GOTO` make it report phantom errors. The rules here
 * are token based, so only constructs the server itself rejects are flagged
 * (issue #9315).
 */
export function buildSqlServerRoutineSyntaxDiagnostics(source: string, databaseType?: DatabaseType): SqlSemanticDiagnostic[] {
  if (!supportsSqlServerRoutineSyntaxDiagnostics(databaseType)) return [];

  const diagnostics: SqlSemanticDiagnostic[] = [];
  for (const token of missingDeclareDataTypeTokens(source)) diagnostics.push(diagnosticAtToken(source, token));
  return diagnostics;
}

function diagnosticAtToken(source: string, token: SqlServerToken): SqlSemanticDiagnostic {
  return {
    span: spanForOffsets(source, token.from, token.to),
    message: SQLSERVER_DECLARE_MISSING_DATA_TYPE_MESSAGE,
    severity: "error",
  };
}

/**
 * `DECLARE @name = value` is not valid T-SQL: the declaration needs a data type
 * (`DECLARE @name INT = value`, an optional `AS` is allowed in between). The
 * server rejects the statement with `Incorrect syntax near '='`, so the same
 * position is reported here.
 *
 * Only positions that can actually start a declaration item are inspected — the
 * declaration keyword itself, or a top level comma continuing its list — so
 * assignment statements such as `SELECT @name = value` or `SET @name = value`
 * are never flagged.
 */
function missingDeclareDataTypeTokens(source: string): SqlServerToken[] {
  const tokens = tokenizeSqlServerSyntax(source);
  const violations: SqlServerToken[] = [];

  let index = 0;
  let expectsDeclaration = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!expectsDeclaration) {
      expectsDeclaration = token.kind === "word" && token.value === "DECLARE";
      index += 1;
      continue;
    }

    if (token.kind !== "variable") {
      // `DECLARE name CURSOR FOR ...` names a cursor without an `@`; anything
      // else ends the declaration list we were tracking.
      expectsDeclaration = false;
      continue;
    }

    let cursor = index + 1;
    if (tokens[cursor]?.kind === "word" && tokens[cursor].value === "AS") cursor += 1;

    if (tokens[cursor]?.kind === "symbol" && tokens[cursor].value === "=") {
      violations.push(tokens[cursor]);
      // The declaration is broken, but the list may continue after the value;
      // keep tracking it so every untyped entry is reported.
      cursor = skipInitializerValue(tokens, cursor + 1);
    } else {
      // The item has a data type (or `TABLE`/`CURSOR`); skip the type, and the
      // optional `= value` initializer, to find whether the list continues.
      cursor = skipDeclarationItem(tokens, cursor);
    }
    if (tokens[cursor]?.kind === "symbol" && tokens[cursor].value === ",") {
      index = cursor + 1;
      continue;
    }
    index = cursor;
    expectsDeclaration = false;
  }
  return violations;
}

/** Advances past a declared data type plus an optional `= value` initializer. */
function skipDeclarationItem(tokens: readonly SqlServerToken[], start: number): number {
  let index = start;
  if (tokens[index]?.kind === "word") index += 1;
  else if (tokens[index]?.kind === "variable") index += 1;

  if (tokens[index]?.kind === "symbol" && tokens[index].value === "(") index = skipBalancedParentheses(tokens, index);

  if (tokens[index]?.kind === "symbol" && tokens[index].value === "=") {
    index = skipInitializerValue(tokens, index + 1);
  }
  return index;
}

function skipInitializerValue(tokens: readonly SqlServerToken[], start: number): number {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === "symbol" && token.value === ",") return index;
    if (token.kind === "symbol" && token.value === "(") {
      index = skipBalancedParentheses(tokens, index);
      continue;
    }
    if (token.kind === "symbol" && token.value === ";") return index;
    if (token.kind === "word" && STATEMENT_BOUNDARY_KEYWORDS.has(token.value)) return index;
    index += 1;
  }
  return index;
}

function skipBalancedParentheses(tokens: readonly SqlServerToken[], openingIndex: number): number {
  let depth = 0;
  let index = openingIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === "symbol" && token.value === "(") depth += 1;
    else if (token.kind === "symbol" && token.value === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return index;
}

// Statement keywords that end an un-terminated declaration list (`DECLARE @a INT`
// followed by the next statement without a semicolon).
const STATEMENT_BOUNDARY_KEYWORDS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE", "SET", "EXEC", "EXECUTE", "IF", "WHILE", "RETURN", "PRINT", "RAISERROR", "THROW", "WITH", "BEGIN", "GO"]);

function tokenizeSqlServerSyntax(source: string): SqlServerToken[] {
  const tokens: SqlServerToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "-" && next === "-") {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === "/" && next === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (char === "'" || char === '"') {
      index = skipQuotedLiteral(source, index, char);
      continue;
    }
    if (char === "[") {
      index = skipBracketedIdentifier(source, index);
      continue;
    }
    if (char === "@") {
      const end = readWordEnd(source, index + 1);
      if (end > index + 1) {
        tokens.push({ kind: "variable", value: source.slice(index + 1, end).toUpperCase(), from: index, to: end });
        index = end;
        continue;
      }
      tokens.push({ kind: "symbol", value: char, from: index, to: index + 1 });
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const end = readWordEnd(source, index);
      tokens.push({ kind: "word", value: source.slice(index, end).toUpperCase(), from: index, to: end });
      index = end;
      continue;
    }
    if (/[0-9]/.test(char)) {
      const end = readNumberEnd(source, index);
      index = end;
      continue;
    }
    if (char === "#") {
      const end = readWordEnd(source, index + 1);
      tokens.push({ kind: "word", value: source.slice(index, end).toUpperCase(), from: index, to: end });
      index = end;
      continue;
    }
    if (/[ \t\r\n]/.test(char)) {
      index += 1;
      continue;
    }
    tokens.push({ kind: "symbol", value: char, from: index, to: index + 1 });
    index += 1;
  }
  return tokens;
}

function readWordEnd(source: string, start: number): number {
  let index = start;
  while (index < source.length && /[A-Za-z0-9_$#@]/.test(source[index])) index += 1;
  return index;
}

function readNumberEnd(source: string, start: number): number {
  let index = start;
  while (index < source.length && /[0-9A-Za-z_.]/.test(source[index])) index += 1;
  return index;
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf("\n", start);
  return newline < 0 ? source.length : newline + 1;
}

// T-SQL nests block comments, so the closing marker has to be matched by depth.
function skipBlockComment(source: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < source.length) {
    if (source.startsWith("/*", index)) {
      depth += 1;
      index += 2;
      continue;
    }
    if (source.startsWith("*/", index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
      continue;
    }
    index += 1;
  }
  return source.length;
}

function skipQuotedLiteral(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] !== quote) {
      index += 1;
      continue;
    }
    if (source[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return source.length;
}

function skipBracketedIdentifier(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] !== "]") {
      index += 1;
      continue;
    }
    if (source[index + 1] === "]") {
      index += 2;
      continue;
    }
    return index + 1;
  }
  return source.length;
}

function spanForOffsets(source: string, startOffset: number, endOffset: number): SqlTextSpan {
  const start = lineColumnAtOffset(source, startOffset);
  const end = lineColumnAtOffset(source, endOffset);
  return {
    start_line: start.line,
    start_column: start.column,
    end_line: end.line,
    end_column: Math.max(end.column - 1, start.column),
  };
}

function lineColumnAtOffset(source: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let column = 1;
  for (let index = 0; index < clamped; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
      continue;
    }
    column += 1;
  }
  return { line, column };
}
