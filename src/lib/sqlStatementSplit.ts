export function findStatementAtCursor(sql: string, cursorPos: number): string {
  const statements = splitStatements(sql);
  for (const stmt of statements) {
    if (cursorPos >= stmt.start && cursorPos <= stmt.end) {
      return stmt.text;
    }
  }
  if (statements.length > 0) {
    const last = statements[statements.length - 1];
    if (cursorPos >= last.end) return last.text;
  }
  return sql.trim();
}

interface StatementRange {
  text: string;
  start: number;
  end: number;
}

function splitStatements(sql: string): StatementRange[] {
  const results: StatementRange[] = [];
  let i = 0;
  let stmtStart = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "-" && sql[i + 1] === "-") {
      i = skipLineComment(sql, i);
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i);
      continue;
    }

    if (ch === "'" || ch === '"') {
      i = skipQuoted(sql, i, ch);
      continue;
    }

    if (ch === "`") {
      i = skipQuoted(sql, i, "`");
      continue;
    }

    if (ch === ";") {
      const text = sql.slice(stmtStart, i).trim();
      if (text) {
        results.push({ text, start: stmtStart, end: i + 1 });
      }
      stmtStart = i + 1;
    }

    i++;
  }

  const trailing = sql.slice(stmtStart).trim();
  if (trailing) {
    results.push({ text: trailing, start: stmtStart, end: sql.length });
  }

  return results;
}

function skipLineComment(sql: string, pos: number): number {
  let i = pos + 2;
  while (i < sql.length && sql[i] !== "\n") i++;
  return i + 1;
}

function skipBlockComment(sql: string, pos: number): number {
  let i = pos + 2;
  while (i < sql.length - 1) {
    if (sql[i] === "*" && sql[i + 1] === "/") return i + 2;
    i++;
  }
  return sql.length;
}

function skipQuoted(sql: string, pos: number, quote: string): number {
  let i = pos + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (sql[i] === "\\" && quote === "'") {
      i += 2;
      continue;
    }
    i++;
  }
  return sql.length;
}
