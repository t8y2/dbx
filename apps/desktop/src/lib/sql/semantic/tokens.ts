import type { SqlSemanticSpan, SqlSemanticToken } from "@/lib/sql/semantic/types";

const WORD_START = /[A-Za-z_@$#]/;
const WORD_PART = /[A-Za-z0-9_@$#]/;

function token(kind: SqlSemanticToken["kind"], text: string, start: number, end: number, depth: number, quote?: string): SqlSemanticToken {
  return {
    kind,
    text,
    normalized: kind === "word" ? text.toLowerCase() : text,
    span: { start, end },
    depth,
    quote,
  };
}

function readQuoted(input: string, start: number, open: string, close: string): number {
  let index = start + open.length;
  while (index < input.length) {
    if (input.startsWith(close, index)) {
      if (input.startsWith(close + close, index)) {
        index += close.length * 2;
        continue;
      }
      return index + close.length;
    }
    index += 1;
  }
  return input.length;
}

export function tokenizeSqlSemantic(input: string): SqlSemanticToken[] {
  const tokens: SqlSemanticToken[] = [];
  let index = 0;
  let depth = 0;

  while (index < input.length) {
    const start = index;
    const ch = input[index] ?? "";
    const next = input[index + 1] ?? "";

    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      index += 2;
      while (index < input.length && input[index] !== "\n" && input[index] !== "\r") index += 1;
      tokens.push(token("comment", input.slice(start, index), start, index, depth));
      continue;
    }

    if (ch === "#") {
      index += 1;
      while (index < input.length && input[index] !== "\n" && input[index] !== "\r") index += 1;
      tokens.push(token("comment", input.slice(start, index), start, index, depth));
      continue;
    }

    if (ch === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1;
      index = Math.min(input.length, index + (index < input.length ? 2 : 0));
      tokens.push(token("comment", input.slice(start, index), start, index, depth));
      continue;
    }

    if (ch === "'") {
      index = readQuoted(input, start, "'", "'");
      tokens.push(token("string", input.slice(start, index), start, index, depth, "'"));
      continue;
    }

    if (ch === "$") {
      const marker = /^\$[A-Za-z_0-9]*\$/.exec(input.slice(start))?.[0];
      if (marker) {
        const closing = input.indexOf(marker, start + marker.length);
        index = closing < 0 ? input.length : closing + marker.length;
        tokens.push(token("string", input.slice(start, index), start, index, depth, marker));
        continue;
      }
    }

    if (ch === '"') {
      index = readQuoted(input, start, '"', '"');
      tokens.push(token("quoted_identifier", input.slice(start, index), start, index, depth, '"'));
      continue;
    }

    if (ch === "`") {
      index = readQuoted(input, start, "`", "`");
      tokens.push(token("quoted_identifier", input.slice(start, index), start, index, depth, "`"));
      continue;
    }

    if (ch === "[") {
      index = readQuoted(input, start, "[", "]");
      tokens.push(token("quoted_identifier", input.slice(start, index), start, index, depth, "["));
      continue;
    }

    if (ch === ":" || ch === "?") {
      index += 1;
      while (index < input.length && WORD_PART.test(input[index] ?? "")) index += 1;
      tokens.push(token("parameter", input.slice(start, index), start, index, depth));
      continue;
    }

    if (/[0-9]/.test(ch)) {
      index += 1;
      while (index < input.length && /[0-9.]/.test(input[index] ?? "")) index += 1;
      tokens.push(token("number", input.slice(start, index), start, index, depth));
      continue;
    }

    if (WORD_START.test(ch)) {
      index += 1;
      while (index < input.length && WORD_PART.test(input[index] ?? "")) index += 1;
      tokens.push(token("word", input.slice(start, index), start, index, depth));
      continue;
    }

    if ("(),.;*".includes(ch)) {
      if (ch === ")") depth = Math.max(0, depth - 1);
      tokens.push(token("punctuation", ch, start, start + 1, depth));
      if (ch === "(") depth += 1;
      index += 1;
      continue;
    }

    index += 1;
    tokens.push(token("operator", ch, start, index, depth));
  }

  return tokens;
}

export function tokenContainsPosition(tokenValue: SqlSemanticToken, position: number): boolean {
  return tokenValue.span.start <= position && position <= tokenValue.span.end;
}

export function isSuppressedSqlSemanticContext(tokens: readonly SqlSemanticToken[], cursor: number): boolean {
  return tokens.some((item) => (item.kind === "comment" || item.kind === "string") && item.span.start < cursor && cursor <= item.span.end);
}

export function findActiveSqlStatementSpan(sql: string, tokens: readonly SqlSemanticToken[], cursor: number): SqlSemanticSpan {
  let start = 0;
  let end = sql.length;
  for (const item of tokens) {
    if (item.kind !== "punctuation" || item.text !== ";" || item.depth !== 0) continue;
    if (item.span.end <= cursor) start = item.span.end;
    if (item.span.start >= cursor) {
      end = item.span.start;
      break;
    }
  }

  while (start < end && /\s/.test(sql[start] ?? "")) start += 1;
  while (end > start && /\s/.test(sql[end - 1] ?? "")) end -= 1;
  return { start, end };
}

export function unquoteSqlSemanticIdentifier(tokenValue: SqlSemanticToken): string {
  if (tokenValue.kind !== "quoted_identifier") return tokenValue.text;
  if (tokenValue.quote === "[") return tokenValue.text.slice(1, -1).replaceAll("]]", "]");
  const quote = tokenValue.quote ?? tokenValue.text[0] ?? "";
  return tokenValue.text.slice(1, -1).replaceAll(quote + quote, quote);
}

export function tokenIsIdentifier(tokenValue: SqlSemanticToken | undefined): tokenValue is SqlSemanticToken {
  return !!tokenValue && (tokenValue.kind === "word" || tokenValue.kind === "quoted_identifier");
}
