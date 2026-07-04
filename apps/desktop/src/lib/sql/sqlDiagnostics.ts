export interface SqlErrorLocation {
  line: number;
  column: number;
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
