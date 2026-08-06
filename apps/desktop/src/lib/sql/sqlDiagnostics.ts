export interface SqlErrorLocation {
  line: number;
  column: number;
}

export interface SqlErrorRange {
  from: number;
  to: number;
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

export function sqlErrorDecorationRange(sql: string, message: string): SqlErrorRange | null {
  const location = parseSqlErrorLocation(message);
  if (location) {
    const offset = lineColumnToOffset(sql, location);
    if (offset == null || offset >= sql.length) return null;
    return { from: offset, to: offset + 1 };
  }

  // Oracle Agent reports a zero-based absolute offset. For qualified invalid
  // identifiers it can point later in the selector, so prefer the named token.
  const positionMatch = /\berror\s+occur(?:red)?\s+at\s+position\s*:\s*(\d+)\b/i.exec(message);
  if (!positionMatch?.[1]) return null;
  const position = Number.parseInt(positionMatch[1], 10);
  if (!Number.isSafeInteger(position) || position < 0 || position >= sql.length) return null;

  return oracleInvalidIdentifierRange(sql, message, position) ?? { from: position, to: position + 1 };
}
