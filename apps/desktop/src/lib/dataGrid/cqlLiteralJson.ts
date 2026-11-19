/**
 * Converts a CQL collection literal, as the Cassandra agent renders map / list /
 * set / tuple / UDT values, into JSON text so Cell Details can format it.
 *
 * Examples: `{'color': 'blue'}` → `{"color":"blue"}`, `['a', 'b']` → `["a","b"]`,
 * `(1, 'a')` → `[1,"a"]`, `{'a', 'b'}` (set) → `["a","b"]`.
 * Returns undefined when the text is not a well-formed CQL collection literal.
 */
export function cqlLiteralToJsonText(text: string): string | undefined {
  const source = text.trim();
  if (!/^[{[(]/.test(source)) return undefined;
  const parser = new CqlLiteralParser(source);
  try {
    const json = parser.parseValue();
    parser.skipWhitespace();
    return parser.atEnd() ? json : undefined;
  } catch {
    return undefined;
  }
}

const NUMBER_PATTERN = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

class CqlLiteralParser {
  private index = 0;

  constructor(private readonly source: string) {}

  atEnd(): boolean {
    return this.index >= this.source.length;
  }

  skipWhitespace(): void {
    while (!this.atEnd() && /\s/.test(this.source[this.index]!)) this.index++;
  }

  parseValue(): string {
    this.skipWhitespace();
    const char = this.source[this.index];
    if (char === undefined) throw new Error("unexpected end");
    if (char === "'") return JSON.stringify(this.parseQuoted());
    if (char === "[") return this.parseSequence("]");
    if (char === "(") return this.parseSequence(")");
    if (char === "{") return this.parseBraces();
    return this.parseBare();
  }

  private parseQuoted(): string {
    this.index++;
    let result = "";
    for (;;) {
      const char = this.source[this.index];
      if (char === undefined) throw new Error("unterminated string");
      this.index++;
      if (char !== "'") {
        result += char;
        continue;
      }
      if (this.source[this.index] === "'") {
        result += "'";
        this.index++;
        continue;
      }
      return result;
    }
  }

  private parseBare(): string {
    const start = this.index;
    while (!this.atEnd() && !/[\s,:{}[\]()]/.test(this.source[this.index]!)) this.index++;
    const token = this.source.slice(start, this.index);
    if (token === "") throw new Error("unexpected token");
    if (token === "null" || token === "true" || token === "false" || NUMBER_PATTERN.test(token)) return token;
    return JSON.stringify(token);
  }

  private parseSequence(close: string): string {
    this.index++;
    const items: string[] = [];
    this.skipWhitespace();
    if (this.source[this.index] === close) {
      this.index++;
      return "[]";
    }
    for (;;) {
      items.push(this.parseValue());
      this.skipWhitespace();
      const char = this.source[this.index++];
      if (char === close) return `[${items.join(",")}]`;
      if (char !== ",") throw new Error("expected separator");
    }
  }

  private parseBraces(): string {
    this.index++;
    this.skipWhitespace();
    if (this.source[this.index] === "}") {
      this.index++;
      return "{}";
    }
    const first = this.parseValue();
    this.skipWhitespace();
    if (this.source[this.index] === ":") {
      this.index++;
      return this.parseMapRest(first);
    }
    const items = [first];
    for (;;) {
      const char = this.source[this.index++];
      if (char === "}") return `[${items.join(",")}]`;
      if (char !== ",") throw new Error("expected separator");
      items.push(this.parseValue());
      this.skipWhitespace();
    }
  }

  private parseMapRest(firstKey: string): string {
    const entries: string[] = [];
    let key = firstKey;
    for (;;) {
      entries.push(`${jsonObjectKey(key)}:${this.parseValue()}`);
      this.skipWhitespace();
      const char = this.source[this.index++];
      if (char === "}") return `{${entries.join(",")}}`;
      if (char !== ",") throw new Error("expected separator");
      key = this.parseValue();
      this.skipWhitespace();
      if (this.source[this.index++] !== ":") throw new Error("expected colon");
    }
  }
}

function jsonObjectKey(json: string): string {
  return json.startsWith('"') ? json : JSON.stringify(json);
}
