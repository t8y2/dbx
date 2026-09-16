/** Tokenizes Redis command text with the same quoting and escape rules as the backend. */
export interface RedisArgvToken {
  value: string;
  /** 1-based start/end character columns within the source line. */
  startColumn: number;
  endColumn: number;
}

export interface RedisArgvResult {
  argv: RedisArgvToken[];
  unclosedQuote: boolean;
  unclosedQuoteStart?: number;
}

function escapedCharacter(value: string): string {
  return value === "n" ? "\n" : value === "r" ? "\r" : value === "t" ? "\t" : value;
}

export function tokenizeRedisLine(line: string): RedisArgvResult {
  let end = line.length;
  while (end > 0 && /\s/.test(line[end - 1]!)) end--;
  while (end > 0 && line[end - 1] === ";") end--;

  const argv: RedisArgvToken[] = [];
  let value = "";
  let startColumn: number | undefined;
  let quote: string | undefined;
  let unclosedQuoteStart: number | undefined;
  let escaping = false;

  const pushToken = (endColumn: number) => {
    if (startColumn != null) {
      argv.push({ value, startColumn, endColumn });
    }
    value = "";
    startColumn = undefined;
  };

  for (let index = 0; index < end; index++) {
    const character = line[index]!;
    if (startColumn == null) {
      if (/\s/.test(character)) continue;
      startColumn = index + 1;
    }

    if (escaping) {
      value += escapedCharacter(character);
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else value += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      unclosedQuoteStart = index + 1;
      continue;
    }
    if (/\s/.test(character)) {
      pushToken(index + 1);
      continue;
    }
    value += character;
  }

  if (escaping) value += "\\";
  if (quote) {
    pushToken(end + 1);
    return { argv, unclosedQuote: true, unclosedQuoteStart };
  }
  pushToken(end + 1);
  return { argv, unclosedQuote: false };
}
