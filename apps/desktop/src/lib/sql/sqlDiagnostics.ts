export interface SqlErrorLocation {
  line: number;
  column: number;
}

export interface SqlErrorRange {
  from: number;
  to: number;
}

function normalizeSqlForComparison(sql: string): string {
  return sql.trim().replace(/;\s*$/u, "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function removeDbxPagination(sql: string): string {
  return sql.replace(/\s+(?:limit\s+\d+(?:\s+offset\s+\d+)?|offset\s+\d+\s+rows?(?:\s+fetch\s+(?:next|first)\s+\d+\s+rows?(?:\s+only)?)?|fetch\s+(?:first|next)\s+\d+\s+rows?\s+only)\s*;?\s*$/iu, "").trim();
}

/**
 * Pagination is appended to the SQL sent to the database, so an execution
 * error can refer to a SQL string that differs from the editor by only that
 * generated suffix. Keep error highlighting disabled for unrelated stale
 * errors while allowing this known DBX rewrite.
 */
export function sqlErrorSqlMatchesEditor(editorSql: string, executedSql: string): boolean {
  if (editorSql === executedSql) return true;
  const norm = (sql: string) => normalizeSqlForComparison(sql);
  if (norm(executedSql) === norm(editorSql)) return true;
  return norm(removeDbxPagination(executedSql)) === norm(removeDbxPagination(editorSql));
}

function toZeroBased(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return parsed - 1;
}

export function parseSqlErrorLocation(message: string): SqlErrorLocation | null {
  const lineColumn = /\bline\s+(\d+)\s*[,:\s]\s*column\s+(\d+)\b/i.exec(message) ?? /\bline\s+(\d+)\b[\s\S]{0,80}?\bcol(?:umn)?\s+(\d+)\b/i.exec(message);
  if (lineColumn) {
    const line = toZeroBased(lineColumn[1]);
    const column = toZeroBased(lineColumn[2]);
    if (line != null && column != null) return { line, column };
  }

  const lines = message.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const lineMatch = /^LINE\s+(\d+):/i.exec(lines[index] ?? "");
    if (!lineMatch) continue;
    const caretLine = lines.slice(index + 1).find((line) => line.includes("^"));
    const line = toZeroBased(lineMatch[1]);
    const caretIndex = caretLine?.indexOf("^") ?? -1;
    if (line != null && caretIndex >= 0) return { line, column: caretIndex };
  }

  // MySQL commonly reports only "at line N" for syntax errors. With no
  // column information available, point at the beginning of that line.
  const lineOnly = /\bline\s+(\d+)\b/i.exec(message);
  if (lineOnly) {
    const line = toZeroBased(lineOnly[1]);
    if (line != null) return { line, column: 0 };
  }

  return null;
}

export function lineColumnToOffset(sql: string, location: SqlErrorLocation): number | null {
  const lines = sql.split(/\r?\n/);
  if (location.line < 0 || location.line >= lines.length) return null;

  let offset = 0;
  for (let index = 0; index < location.line; index++) {
    offset += lines[index].length + 1;
  }

  return Math.min(offset + location.column, offset + lines[location.line].length);
}

function oracleInvalidIdentifierRange(sql: string, message: string, position: number): SqlErrorRange | null {
  const identifierMatch = /\bORA-00904:\s*"((?:""|[^"])*)"\s*:\s*invalid identifier\b/i.exec(message);
  if (!identifierMatch?.[1]) return null;

  const reportedIdentifier = identifierMatch[1].replace(/""/g, '"');
  const identifierPattern = /"(?:""|[^"])*"|[\p{L}_][\p{L}\p{N}_$#]*/gu;
  let bestRange: SqlErrorRange | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const match of sql.matchAll(identifierPattern)) {
    const token = match[0];
    const tokenStart = match.index;
    const quoted = token.startsWith('"');
    const identifier = quoted ? token.slice(1, -1).replace(/""/g, '"') : token;
    if (quoted ? identifier !== reportedIdentifier : identifier.toUpperCase() !== reportedIdentifier.toUpperCase()) continue;

    const from = tokenStart + (quoted ? 1 : 0);
    const to = tokenStart + token.length - (quoted ? 1 : 0);
    const distance = position < from ? from - position : position > to ? position - to : 0;
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    bestRange = { from, to };
  }

  return bestRange;
}

/**
 * A position a driver reported in its error text, without needing the SQL it
 * refers to. Engines that do not attach a typed position to their error
 * envelope (Oracle) still name one in the message.
 */
export type SqlErrorMessagePosition = { kind: "location"; location: SqlErrorLocation } | { kind: "offset"; offset: number };

const ORACLE_AGENT_POSITION_PATTERN = /\berror\s+occur(?:red)?\s+at\s+position\s*:\s*(\d+)\b/i;

/**
 * Parse the position carried by a driver error message.
 *
 * Textual locations (`line N, column M`, `LINE N:` with a `^` caret, and the
 * line-only form MySQL emits) win over the Oracle Agent's absolute offset, the
 * same precedence {@link sqlErrorDecorationRange} has always used.
 */
export function sqlErrorMessagePosition(message: string): SqlErrorMessagePosition | null {
  const location = parseSqlErrorLocation(message);
  if (location) return { kind: "location", location };

  // Oracle Agent reports a zero-based absolute offset into the statement text.
  const positionMatch = ORACLE_AGENT_POSITION_PATTERN.exec(message);
  if (!positionMatch?.[1]) return null;
  const offset = Number.parseInt(positionMatch[1], 10);
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  return { kind: "offset", offset };
}

export function sqlErrorDecorationRange(sql: string, message: string): SqlErrorRange | null {
  const position = sqlErrorMessagePosition(message);
  if (!position) return null;

  if (position.kind === "location") {
    const offset = lineColumnToOffset(sql, position.location);
    if (offset == null || offset >= sql.length) return null;
    return { from: offset, to: offset + 1 };
  }

  const { offset } = position;
  if (offset >= sql.length) return null;
  // For qualified invalid identifiers the offset can point later in the
  // selector, so prefer the named token.
  return oracleInvalidIdentifierRange(sql, message, offset) ?? { from: offset, to: offset + 1 };
}
