export function sqlServerStatementForDerivedTable(statement: string): string {
  const orderBy = findTopLevelTrailingOrderBy(statement);
  if (orderBy === undefined) return statement;
  if (hasTopLevelSelectTop(statement) || hasTopLevelForXml(statement)) return statement;
  return statement.slice(0, orderBy).trimEnd();
}

function findTopLevelTrailingOrderBy(sql: string): number | undefined {
  const tokens = topLevelSqlTokens(sql);
  for (let i = tokens.length - 2; i >= 0; i--) {
    if (tokens[i].text === "ORDER" && tokens[i + 1]?.text === "BY") {
      return tokens[i].start;
    }
  }
  return undefined;
}

function hasTopLevelSelectTop(sql: string): boolean {
  const tokens = topLevelSqlTokens(sql);
  const selectIndex = tokens.findIndex((token) => token.text === "SELECT");
  if (selectIndex < 0) return false;
  const fromIndex = tokens.findIndex((token, index) => index > selectIndex && token.text === "FROM");
  const end = fromIndex < 0 ? tokens.length : fromIndex;
  return tokens.slice(selectIndex + 1, end).some((token) => token.text === "TOP");
}

function hasTopLevelForXml(sql: string): boolean {
  const tokens = topLevelSqlTokens(sql);
  return tokens.some((token, index) => token.text === "FOR" && tokens[index + 1]?.text === "XML");
}

function topLevelSqlTokens(sql: string): Array<{ text: string; start: number }> {
  const tokens: Array<{ text: string; start: number }> = [];
  let i = 0;
  let depth = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length - 1 && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, sql.length);
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipSqlQuoted(sql, i, ch);
      continue;
    }

    if (ch === "[") {
      i = skipSqlBracketIdentifier(sql, i);
      continue;
    }

    if (ch === "(") {
      depth++;
      i++;
      continue;
    }

    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }

    if (depth === 0 && isSqlTokenStart(ch)) {
      const start = i;
      i++;
      while (i < sql.length && isSqlTokenPart(sql[i])) i++;
      tokens.push({ text: sql.slice(start, i).toUpperCase(), start });
      continue;
    }

    i++;
  }

  return tokens;
}

function skipSqlQuoted(sql: string, pos: number, quote: string): number {
  let i = pos + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    if (quote === "'" && sql[i] === "\\") {
      i += 2;
      continue;
    }
    i++;
  }
  return sql.length;
}

function skipSqlBracketIdentifier(sql: string, pos: number): number {
  let i = pos + 1;
  while (i < sql.length) {
    if (sql[i] === "]") {
      if (sql[i + 1] === "]") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

function isSqlTokenStart(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z_]/.test(ch);
}

function isSqlTokenPart(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_$#]/.test(ch);
}
