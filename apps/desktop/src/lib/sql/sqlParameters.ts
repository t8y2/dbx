import type { DatabaseType } from "@/types/database";

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

type ComplexTypeDeclarationKind = "struct" | "variant";

export interface SqlParameterOptions {
  databaseType?: DatabaseType;
  // Which placeholder syntaxes are recognized. Undefined enables all of them.
  enabledSyntaxes?: readonly SqlParameterSyntax[];
}

const PARAMETER_NAME_RE = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const PARAMETER_NAME_START_RE = /[\p{L}_]/u;
const PARAMETER_NAME_CHAR_RE = /[\p{L}\p{N}_]/u;
const SQL_SERVER_TEMP_TABLE_CONTEXT_KEYWORDS = new Set(["table", "from", "join", "into", "update", "truncate"]);

export function extractSqlParameters(sql: string, options?: SqlParameterOptions): string[] {
  return extractSqlParameterDescriptors(sql, options).map((descriptor) => descriptor.key);
}

export function extractSqlParameterDescriptors(sql: string, options?: SqlParameterOptions): SqlParameterDescriptor[] {
  const names = new Set<string>();
  const descriptors: SqlParameterDescriptor[] = [];
  for (const occurrence of findSqlParameterOccurrences(sql, options)) {
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

export function substituteSqlParameters(sql: string, values: Record<string, SqlParameterInput>, options?: SqlParameterOptions): string {
  const occurrences = findSqlParameterOccurrences(sql, options);
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

function findSqlParameterOccurrences(sql: string, options?: SqlParameterOptions): ParameterOccurrence[] {
  const occurrences: ParameterOccurrence[] = [];
  const nativeSqlServerParameters = collectNativeSqlServerParameters(sql);
  const supportsNamedParameters = options?.databaseType !== "saphana";
  const enabledSyntaxes = options?.enabledSyntaxes ? new Set(options.enabledSyntaxes) : null;
  const isSyntaxEnabled = (syntax: SqlParameterSyntax) => !enabledSyntaxes || enabledSyntaxes.has(syntax);
  const complexTypeFieldSeparators = supportsNamedParameters && isSyntaxEnabled("named") ? collectComplexTypeFieldSeparators(sql) : new Set<number>();
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

    if (ch === "'" || ch === '"') {
      // Exact quoted braced placeholders only (`'${name}'` / `"#{name}"`).
      // Do not scan inside arbitrary quoted text — that path needs dialect-specific
      // escaping contracts (see PR #3666) and must not change skipQuoted semantics.
      const quoted = tryReadQuotedBracedPlaceholder(sql, i, ch as "'" | '"', isSyntaxEnabled);
      if (quoted) {
        occurrences.push(quoted);
        i = quoted.end;
        continue;
      }
      i = skipQuoted(sql, i, ch);
      continue;
    }
    if (ch === "`") {
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
    if (ch === "?" && isSyntaxEnabled("positional")) {
      positionalIndex += 1;
      const key = `?${positionalIndex}`;
      occurrences.push({ key, name: key, syntax: "positional", token: "?", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === ":" && supportsNamedParameters && isSyntaxEnabled("named")) {
      const name = readParameterName(sql, i + 1);
      if (name && sql[i - 1] !== ":" && sql[i + 1] !== "=" && !complexTypeFieldSeparators.has(i)) {
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
    if (ch === "$" && next === "{" && isSyntaxEnabled("shell")) {
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
    if (ch === "#" && next === "{" && isSyntaxEnabled("mybatis")) {
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
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "@" && isSyntaxEnabled("sqlserver")) {
      const name = readParameterName(sql, i + 1);
      if (name && next !== "@" && sql[i - 1] !== "@" && !isJdbcxMcpScopedPackage(sql, i, i + 1 + name.length) && !nativeSqlServerParameters.declared.has(name.toLowerCase()) && !nativeSqlServerParameters.ignoredStarts.has(i)) {
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

// JDBCX MCP commands accept npm scoped packages in their unquoted args value,
// for example `args=-y @modelcontextprotocol/server-everything`. The `@scope`
// prefix is command data, not a SQL Server-style template parameter.
function isJdbcxMcpScopedPackage(sql: string, start: number, nameEnd: number): boolean {
  if (sql[nameEnd] !== "/" || !/[\p{L}\p{N}_.-]/u.test(sql[nameEnd + 1] ?? "")) return false;

  const blockStart = sql.lastIndexOf("{{", start);
  if (blockStart === -1 || sql.lastIndexOf("}}", start) > blockStart) return false;

  const extensionPrefix = sql.slice(blockStart + 2, start);
  return /^\s*mcp\s*\(/i.test(extensionPrefix) && /(?:^|[,\s])args\s*=[^,]*$/i.test(extensionPrefix);
}

// Doris-style complex types use colons between field names and types; those are not bind parameters.
function collectComplexTypeFieldSeparators(sql: string): Set<number> {
  const separators = new Set<number>();
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
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
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
    const declaration = readComplexTypeDeclaration(sql, i);
    if (declaration) {
      i = collectComplexTypeFieldSeparatorsInDeclaration(sql, declaration.openingBracket + 1, declaration.kind, separators) + 1;
      continue;
    }
    i += 1;
  }

  return separators;
}

function collectComplexTypeFieldSeparatorsInDeclaration(sql: string, start: number, kind: ComplexTypeDeclarationKind, separators: Set<number>): number {
  let i = start;
  let genericDepth = 0;
  let parenthesisDepth = 0;
  let expectsFieldName = true;

  while (i < sql.length) {
    if (expectsFieldName && genericDepth === 0 && parenthesisDepth === 0) {
      const fieldStart = skipSqlWhitespaceAndComments(sql, i);
      if (fieldStart !== i) {
        i = fieldStart;
        continue;
      }
      if (isLineStatementStart(sql, i) && isSqlStatementKeyword(sql, i)) return i;
      const fieldNameEnd = readComplexTypeFieldNameEnd(sql, i, kind);
      if (fieldNameEnd > i) {
        const separator = skipSqlWhitespaceAndComments(sql, fieldNameEnd);
        if (sql[separator] === ":") {
          separators.add(separator);
          i = separator + 1;
          expectsFieldName = false;
          continue;
        }
        i = fieldNameEnd;
        expectsFieldName = false;
        continue;
      }
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
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    const declaration = readComplexTypeDeclaration(sql, i);
    if (declaration) {
      i = collectComplexTypeFieldSeparatorsInDeclaration(sql, declaration.openingBracket + 1, declaration.kind, separators) + 1;
      continue;
    }
    if (ch === ";" && genericDepth === 0 && parenthesisDepth === 0) return i;
    if (ch === "<") {
      genericDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ">") {
      if (genericDepth === 0 && parenthesisDepth === 0) return i;
      if (genericDepth > 0) genericDepth -= 1;
      i += 1;
      continue;
    }
    if (ch === "(") {
      parenthesisDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (parenthesisDepth > 0) parenthesisDepth -= 1;
      i += 1;
      continue;
    }
    if (ch === "," && genericDepth === 0 && parenthesisDepth === 0) {
      expectsFieldName = true;
    }
    i += 1;
  }

  return sql.length;
}

function readComplexTypeDeclaration(sql: string, start: number): { kind: ComplexTypeDeclarationKind; openingBracket: number } | null {
  const kind: ComplexTypeDeclarationKind | null = matchesWord(sql, start, "struct") ? "struct" : matchesWord(sql, start, "variant") ? "variant" : null;
  if (!kind) return null;

  const openingBracket = skipSqlWhitespaceAndComments(sql, start + kind.length);
  return sql[openingBracket] === "<" ? { kind, openingBracket } : null;
}

function readComplexTypeFieldNameEnd(sql: string, start: number, kind: ComplexTypeDeclarationKind): number {
  if (kind === "variant") return readVariantFieldNameEnd(sql, start);

  const ch = sql[start];
  if (ch === '"' || ch === "`") return skipQuoted(sql, start, ch);
  if (ch === "[") return skipBracketIdentifier(sql, start);
  if (!PARAMETER_NAME_START_RE.test(ch ?? "")) return start;

  let i = start + 1;
  while (i < sql.length && PARAMETER_NAME_CHAR_RE.test(sql[i])) i += 1;
  return i;
}

function readVariantFieldNameEnd(sql: string, start: number): number {
  let i = start;
  const modifier = matchesWord(sql, i, "match_name") ? "match_name" : matchesWord(sql, i, "match_name_glob") ? "match_name_glob" : "";
  if (modifier) i = skipSqlWhitespaceAndComments(sql, i + modifier.length);
  return sql[i] === "'" ? skipQuoted(sql, i, "'") : start;
}

function skipSqlWhitespaceAndComments(sql: string, start: number): number {
  let i = start;
  while (i < sql.length) {
    while (i < sql.length && /\s/.test(sql[i])) i += 1;
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    break;
  }
  return i;
}

function collectNativeSqlServerParameters(sql: string): { declared: Set<string>; ignoredStarts: Set<number> } {
  const declared = new Set<string>();
  const ignoredStarts = new Set<number>();
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
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (matchesWord(sql, i, "declare")) {
      i = collectDeclareStatementVariables(sql, i + "declare".length, declared);
      continue;
    }
    if (matchesWord(sql, i, "set")) {
      i = collectSetStatementVariables(sql, i + "set".length, declared);
      continue;
    }
    if (matchesWord(sql, i, "select")) {
      i = collectSelectAssignmentVariables(sql, i + "select".length, declared);
      continue;
    }
    if ((matchesWord(sql, i, "create") || matchesWord(sql, i, "alter")) && isRoutineDefinitionStart(sql, i)) {
      i = collectRoutineDefinitionVariables(sql, i, declared);
      continue;
    }
    if (matchesWord(sql, i, "exec") || matchesWord(sql, i, "execute")) {
      i = collectExecNamedArgumentStarts(sql, i + (matchesWord(sql, i, "exec") ? "exec".length : "execute".length), ignoredStarts);
      continue;
    }
    i += 1;
  }

  return { declared, ignoredStarts };
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
    if (isHashLineComment(sql, i)) {
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

function collectSetStatementVariables(sql: string, start: number, declared: Set<string>): number {
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
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "@") {
      const name = readParameterName(sql, i + 1);
      if (name && next !== "@" && sql[i - 1] !== "@" && isSetAssignmentTarget(sql, i + 1 + name.length)) {
        declared.add(name.toLowerCase());
        i += 1 + name.length;
        continue;
      }
    }
    i += 1;
  }
  return i;
}

function collectSelectAssignmentVariables(sql: string, start: number, declared: Set<string>): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === ";") return i + 1;
    if (isLineStatementStart(sql, i) && isSqlStatementKeyword(sql, i)) return i;
    if (matchesWord(sql, i, "from")) return i;
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
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "@") {
      const name = readParameterName(sql, i + 1);
      if (name && next !== "@" && sql[i - 1] !== "@" && isSetAssignmentTarget(sql, i + 1 + name.length)) {
        declared.add(name.toLowerCase());
        i += 1 + name.length;
        continue;
      }
    }
    i += 1;
  }
  return i;
}

function collectRoutineDefinitionVariables(sql: string, start: number, declared: Set<string>): number {
  let i = start;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === ";") return i + 1;
    if (matchesWord(sql, i, "as") || matchesWord(sql, i, "returns")) return i;
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
    if (isHashLineComment(sql, i)) {
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

function collectExecNamedArgumentStarts(sql: string, start: number, ignoredStarts: Set<number>): number {
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
    if (isHashLineComment(sql, i)) {
      i = skipLine(sql, i + 1);
      continue;
    }
    if (ch === "@") {
      const name = readParameterName(sql, i + 1);
      if (name && next !== "@" && sql[i - 1] !== "@" && isSetAssignmentTarget(sql, i + 1 + name.length)) {
        ignoredStarts.add(i);
        i += 1 + name.length;
        continue;
      }
    }
    i += 1;
  }
  return i;
}

function isRoutineDefinitionStart(sql: string, start: number): boolean {
  const keyword = matchesWord(sql, start, "create") ? "create" : matchesWord(sql, start, "alter") ? "alter" : "";
  if (!keyword) return false;

  let next = readNextKeyword(sql, start + keyword.length);
  if (!next) return false;
  if (keyword === "create" && next.word === "or") {
    const afterOr = readNextKeyword(sql, next.end);
    if (!afterOr || (afterOr.word !== "alter" && afterOr.word !== "replace")) return false;
    next = readNextKeyword(sql, afterOr.end);
    if (!next) return false;
  }
  return next.word === "procedure" || next.word === "proc" || next.word === "function";
}

function readNextKeyword(sql: string, start: number): { word: string; end: number } | null {
  let i = start;
  while (i < sql.length) {
    while (i < sql.length && /\s/.test(sql[i])) i += 1;
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i = skipLine(sql, i + 2);
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i + 2);
      continue;
    }
    break;
  }
  if (!PARAMETER_NAME_START_RE.test(sql[i] ?? "")) return null;
  let end = i + 1;
  while (end < sql.length && PARAMETER_NAME_CHAR_RE.test(sql[end])) end += 1;
  return { word: sql.slice(i, end).toLowerCase(), end };
}

function isSetAssignmentTarget(sql: string, start: number): boolean {
  let i = start;
  while (i < sql.length && /\s/.test(sql[i])) i += 1;
  return sql[i] === "=" || (sql[i] === ":" && sql[i + 1] === "=");
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

/** Match only unprefixed quote + exact `${name}`/`#{name}` + same quote. Leaves skipQuoted unchanged. */
function tryReadQuotedBracedPlaceholder(sql: string, start: number, quote: "'" | '"', isSyntaxEnabled: (syntax: SqlParameterSyntax) => boolean): ParameterOccurrence | null {
  if (sql[start] !== quote) return null;
  // Reject E'...', U&'...', B'...', X'...', N'...' — replacing the quoted span would leave the
  // prefix attached to a typed literal (e.g. E'${path}' → E'C:\new', B'${flag}' → BTRUE).
  if (hasSqlStringLiteralPrefix(sql, start)) return null;

  const open = sql.slice(start + 1, start + 3);
  let syntax: SqlParameterSyntax | null = null;
  if (open === "${") syntax = "shell";
  else if (open === "#{") syntax = "mybatis";
  else return null;
  if (!isSyntaxEnabled(syntax)) return null;

  const nameStart = start + 3;
  const closeBrace = sql.indexOf("}", nameStart);
  if (closeBrace === -1 || sql[closeBrace + 1] !== quote) return null;

  const name = sql.slice(nameStart, closeBrace).trim();
  if (!PARAMETER_NAME_RE.test(name)) return null;

  const end = closeBrace + 2;
  // The closing quote must be a real string terminator under the same rules as skipQuoted
  // (doubled quotes / backslash escapes). Otherwise '${value}''suffix' would match '${value}'.
  if (skipQuoted(sql, start, quote) !== end) return null;

  return {
    key: name,
    name,
    syntax,
    token: sql.slice(start, end),
    start,
    end,
  };
}

/** True when `quoteStart` opens a prefixed literal such as E'...', U&'...', or MySQL _charset'...'. */
function hasSqlStringLiteralPrefix(sql: string, quoteStart: number): boolean {
  if (quoteStart <= 0) return false;

  if (quoteStart >= 2 && sql[quoteStart - 1] === "&" && (sql[quoteStart - 2] === "U" || sql[quoteStart - 2] === "u") && !PARAMETER_NAME_CHAR_RE.test(sql[quoteStart - 3] ?? "")) {
    return true;
  }

  // SQL dialects attach word-like introducers directly to the quote. Reject the
  // whole category so typed replacement cannot leave invalid prefixes such as
  // `_utf8mb4TRUE`, and so future introducers do not require another allowlist.
  return PARAMETER_NAME_CHAR_RE.test(sql[quoteStart - 1]);
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

function isHashLineComment(sql: string, start: number): boolean {
  if (sql[start] !== "#" || sql[start + 1] === "{") return false;
  // Keep SQL Server #temp table names parseable while treating other # tokens as MySQL-style comments.
  return !isSqlServerTempTableReference(sql, start);
}

function isSqlServerTempTableReference(sql: string, start: number): boolean {
  let nameStart = start + 1;
  if (sql[nameStart] === "#") nameStart += 1;
  if (!PARAMETER_NAME_START_RE.test(sql[nameStart] ?? "")) return false;

  const previous = previousKeyword(sql, start);
  return !!previous && SQL_SERVER_TEMP_TABLE_CONTEXT_KEYWORDS.has(previous);
}

function previousKeyword(sql: string, start: number): string {
  let end = start - 1;
  while (end >= 0 && /\s/.test(sql[end])) end -= 1;
  let begin = end;
  while (begin >= 0 && PARAMETER_NAME_CHAR_RE.test(sql[begin])) begin -= 1;
  begin += 1;
  if (begin > end || !PARAMETER_NAME_START_RE.test(sql[begin] ?? "")) return "";
  return sql.slice(begin, end + 1).toLowerCase();
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
