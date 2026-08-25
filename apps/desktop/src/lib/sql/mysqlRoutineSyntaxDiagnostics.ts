import type { SqlTextSpan } from "@/types/database";

export interface MysqlRoutineSyntaxDiagnostic {
  span: SqlTextSpan;
  message: string;
  severity: "error";
}

export interface MysqlRoutineSyntaxAnalysis {
  diagnostics: MysqlRoutineSyntaxDiagnostic[];
  hasRoutine: boolean;
  routineRanges: Array<{ from: number; to: number }>;
}

interface RoutineToken {
  kind: "word" | "leftParen" | "rightParen" | "comma" | "semicolon" | "other";
  value: string;
  from: number;
  to: number;
}

interface RoutineDeclaration {
  kind: "PROCEDURE" | "FUNCTION";
  createTokenIndex: number;
  tokenIndex: number;
}

const NON_ROUTINE_CREATE_TYPES = new Set(["DATABASE", "INDEX", "LOGFILE", "ROLE", "SCHEMA", "SERVER", "SPATIAL", "TABLE", "TEMPORARY", "UNIQUE", "USER", "VIEW"]);
const CONTROL_BLOCK_SUFFIXES = new Set(["IF", "LOOP", "CASE", "REPEAT", "WHILE"]);

export function analyzeMysqlRoutineSyntax(sql: string): MysqlRoutineSyntaxAnalysis {
  const tokens = tokenizeMysqlRoutineSql(sql);
  const declarations = findRoutineDeclarations(tokens);
  const diagnostics: MysqlRoutineSyntaxDiagnostic[] = [];
  const routineRanges: Array<{ from: number; to: number }> = [];

  declarations.forEach((declaration, declarationIndex) => {
    const nextDeclarationTokenIndex = declarations[declarationIndex + 1]?.createTokenIndex ?? tokens.length;
    const parameterStart = findTokenKind(tokens, declaration.tokenIndex + 1, nextDeclarationTokenIndex, "leftParen");
    if (parameterStart === -1) return;
    const parameterEnd = findMatchingRightParen(tokens, parameterStart, nextDeclarationTokenIndex);
    if (parameterEnd === -1) return;
    const routineEnd = findRoutineEndToken(tokens, parameterEnd + 1, nextDeclarationTokenIndex);
    const routineEndOffset = routineEnd === -1 ? (tokens[nextDeclarationTokenIndex]?.from ?? sql.length) : tokens[routineEnd].to;
    routineRanges.push({ from: tokens[declaration.createTokenIndex].from, to: routineEndOffset });

    const previousParameterToken = tokens[parameterEnd - 1];
    if (previousParameterToken?.kind === "comma") {
      diagnostics.push(diagnosticAtOffset(sql, previousParameterToken.from, previousParameterToken.to, "Trailing comma is not allowed in a MySQL routine parameter list"));
    }

    const bodyEnd = routineEnd === -1 ? nextDeclarationTokenIndex : routineEnd + 1;
    for (let index = parameterEnd + 1; index < bodyEnd; index += 1) {
      const token = tokens[index];
      if (token.kind !== "word" || token.value !== "RETURN") continue;
      if (declaration.kind === "PROCEDURE") {
        diagnostics.push(diagnosticAtOffset(sql, token.from, token.to, "RETURN is not valid in a MySQL procedure; use LEAVE with a block label"));
        continue;
      }
      const nextToken = tokens[index + 1];
      if (!nextToken || nextToken.kind === "semicolon") {
        diagnostics.push(diagnosticAtOffset(sql, token.from, token.to, "RETURN in a MySQL function requires an expression"));
      }
    }
  });

  return { diagnostics, hasRoutine: declarations.length > 0, routineRanges };
}

function findRoutineDeclarations(tokens: readonly RoutineToken[]): RoutineDeclaration[] {
  const declarations: RoutineDeclaration[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.kind !== "word" || tokens[index]?.value !== "CREATE") continue;
    for (let lookahead = index + 1; lookahead < Math.min(tokens.length, index + 24); lookahead += 1) {
      const token = tokens[lookahead];
      if (token.kind === "semicolon" || (token.kind === "word" && token.value === "CREATE")) break;
      if (token.kind !== "word") continue;
      if (token.value === "PROCEDURE" || token.value === "FUNCTION") {
        declarations.push({ kind: token.value, createTokenIndex: index, tokenIndex: lookahead });
        break;
      }
      if (NON_ROUTINE_CREATE_TYPES.has(token.value)) break;
    }
  }
  return declarations;
}

function findRoutineEndToken(tokens: readonly RoutineToken[], from: number, to: number): number {
  const bodyStart = findWordToken(tokens, from, to, "BEGIN");
  if (bodyStart === -1) return findTokenKind(tokens, from, to, "semicolon");

  let depth = 0;
  for (let index = bodyStart; index < to; index += 1) {
    const token = tokens[index];
    if (token.kind !== "word") continue;
    if (token.value === "BEGIN") {
      if (previousWordToken(tokens, index, bodyStart) !== "END") depth += 1;
      continue;
    }
    if (token.value !== "END" || CONTROL_BLOCK_SUFFIXES.has(nextWordToken(tokens, index, to) ?? "")) continue;
    depth = Math.max(0, depth - 1);
    if (depth === 0) return index;
  }
  return -1;
}

function findWordToken(tokens: readonly RoutineToken[], from: number, to: number, value: string): number {
  for (let index = from; index < to; index += 1) {
    if (tokens[index]?.kind === "word" && tokens[index]?.value === value) return index;
  }
  return -1;
}

function previousWordToken(tokens: readonly RoutineToken[], from: number, lowerBound: number): string | null {
  for (let index = from - 1; index >= lowerBound; index -= 1) {
    if (tokens[index]?.kind === "word") return tokens[index].value;
  }
  return null;
}

function nextWordToken(tokens: readonly RoutineToken[], from: number, upperBound: number): string | null {
  for (let index = from + 1; index < upperBound; index += 1) {
    if (tokens[index]?.kind === "word") return tokens[index].value;
  }
  return null;
}

function findTokenKind(tokens: readonly RoutineToken[], from: number, to: number, kind: RoutineToken["kind"]): number {
  for (let index = from; index < to; index += 1) {
    if (tokens[index]?.kind === kind) return index;
  }
  return -1;
}

function findMatchingRightParen(tokens: readonly RoutineToken[], start: number, to: number): number {
  let depth = 0;
  for (let index = start; index < to; index += 1) {
    if (tokens[index]?.kind === "leftParen") depth += 1;
    if (tokens[index]?.kind !== "rightParen") continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function diagnosticAtOffset(sql: string, from: number, to: number, message: string): MysqlRoutineSyntaxDiagnostic {
  const start = offsetToPosition(sql, from);
  const end = offsetToPosition(sql, Math.max(from + 1, to));
  return {
    span: {
      start_line: start.line,
      start_column: start.column,
      end_line: end.line,
      end_column: Math.max(end.column - 1, start.column),
    },
    message,
    severity: "error",
  };
}

function offsetToPosition(sql: string, offset: number): { line: number; column: number } {
  const boundedOffset = Math.max(0, Math.min(offset, sql.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < boundedOffset; index += 1) {
    if (sql[index] !== "\n") continue;
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: boundedOffset - lineStart + 1 };
}

function tokenizeMysqlRoutineSql(sql: string): RoutineToken[] {
  const tokens: RoutineToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1] ?? "";
    if (char === "-" && next === "-" && /\s/.test(sql[index + 2] ?? "")) {
      index = skipLine(sql, index + 2);
      continue;
    }
    if (char === "#") {
      index = skipLine(sql, index + 1);
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const end = skipQuoted(sql, index, char);
      tokens.push({ kind: "other", value: sql.slice(index, end), from: index, to: end });
      index = end;
      continue;
    }

    const kind = char === "(" ? "leftParen" : char === ")" ? "rightParen" : char === "," ? "comma" : char === ";" ? "semicolon" : null;
    if (kind) {
      tokens.push({ kind, value: char, from: index, to: index + 1 });
      index += 1;
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index))?.[0];
    if (word) {
      tokens.push({ kind: "word", value: word.toUpperCase(), from: index, to: index + word.length });
      index += word.length;
      continue;
    }
    if (!/\s/.test(char)) tokens.push({ kind: "other", value: char, from: index, to: index + 1 });
    index += 1;
  }
  return tokens;
}

function skipLine(sql: string, from: number): number {
  const newline = sql.indexOf("\n", from);
  return newline === -1 ? sql.length : newline + 1;
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === "\\" && index + 1 < sql.length) {
      index += 2;
      continue;
    }
    if (sql[index] === quote && sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    if (sql[index] === quote) return index + 1;
    index += 1;
  }
  return sql.length;
}
