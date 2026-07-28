const LOSSLESS_JSON_NUMBER = Symbol("DBX lossless JSON number");

export interface LosslessJsonNumber {
  readonly [LOSSLESS_JSON_NUMBER]: true;
  readonly raw: string;
}

interface ProtectedJsonNumbers {
  text: string;
  numbers: Map<string, string>;
}

const MAX_SAFE_INTEGER_TEXT = String(Number.MAX_SAFE_INTEGER);

export function isLosslessJsonNumber(value: unknown): value is LosslessJsonNumber {
  return typeof value === "object" && value !== null && (value as Partial<LosslessJsonNumber>)[LOSSLESS_JSON_NUMBER] === true && typeof (value as Partial<LosslessJsonNumber>).raw === "string";
}

/**
 * Parses JSON while retaining numeric literals that JavaScript cannot safely
 * represent exactly. Callers can render these values without adding quotes.
 */
export function parseJsonPreservingLargeNumbers(text: string): unknown {
  const protectedJson = protectLargeJsonNumbers(text);
  const parsed = JSON.parse(protectedJson.text);
  return restoreLosslessNumbers(parsed, protectedJson.numbers);
}

/**
 * Parse and re-stringify JSON while preserving numeric literals whose integer
 * parts exceed Number.MAX_SAFE_INTEGER (2^53 - 1), plus decimal and exponent
 * forms that JavaScript may round or turn into Infinity.
 *
 * Note: this rebuilds a JS object, so duplicate object members are collapsed.
 * Prefer {@link formatJsonSource} when the source text itself must stay lossless.
 */
export function safeJsonFormat(text: string, indent?: number): string {
  const protectedJson = protectLargeJsonNumbers(text);
  const parsed = JSON.parse(protectedJson.text);
  let result = JSON.stringify(parsed, null, indent ?? undefined);

  for (const [placeholder, raw] of protectedJson.numbers) {
    result = result.replaceAll(JSON.stringify(placeholder), raw);
  }

  return result;
}

/**
 * Stringifies values produced by {@link parseJsonPreservingLargeNumbers}
 * without routing their numeric literals through JavaScript Number.
 */
export function stringifyJsonPreservingLargeNumbers(value: unknown, indent?: number): string {
  let placeholderPrefix = "__DBX_LOSSLESS_NUMBER_";
  const ordinaryJson = JSON.stringify(value);
  while (ordinaryJson?.includes(placeholderPrefix)) placeholderPrefix += "_";

  const numbers = new Map<string, string>();
  const result = JSON.stringify(
    value,
    (_key, item) => {
      if (!isLosslessJsonNumber(item)) return item;
      const placeholder = `${placeholderPrefix}${numbers.size}__`;
      numbers.set(placeholder, item.raw);
      return placeholder;
    },
    indent ?? undefined,
  );

  if (result === undefined) throw new TypeError("Value is not JSON serializable");
  let restored = result;
  for (const [placeholder, raw] of numbers) {
    restored = restored.replaceAll(JSON.stringify(placeholder), raw);
  }
  return restored;
}

/**
 * Validate JSON and re-emit source tokens while only changing insignificant
 * whitespace. Unlike {@link safeJsonFormat}, this keeps duplicate object
 * members, key order, string escapes, and number spellings intact.
 */
export function formatJsonSource(text: string, indent?: number): string {
  const scanner = new JsonSourceScanner(text);
  const writer = new JsonSourceWriter(indent);
  writeJsonValue(scanner, writer, 0);
  scanner.skipWhitespace();
  if (!scanner.eof()) throw new SyntaxError(`Unexpected trailing content in JSON at position ${scanner.position}`);
  return writer.toString();
}

function protectLargeJsonNumbers(text: string): ProtectedJsonNumbers {
  let placeholderPrefix = "__DBX_LOSSLESS_NUMBER_";
  while (text.includes(placeholderPrefix)) placeholderPrefix += "_";

  const numbers = new Map<string, string>();
  let output = "";
  let index = 0;

  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const stringEnd = findJsonStringEnd(text, index);
      output += text.slice(index, stringEnd);
      index = stringEnd;
      continue;
    }

    const numberMatch = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      const raw = numberMatch[0];
      if (shouldPreserveJsonNumber(raw)) {
        // A quoted placeholder lets the native parser validate the rest of the JSON.
        const placeholder = `${placeholderPrefix}${numbers.size}__`;
        numbers.set(placeholder, raw);
        output += JSON.stringify(placeholder);
      } else {
        output += raw;
      }
      index += raw.length;
      continue;
    }

    output += character;
    index += 1;
  }

  return { text: output, numbers };
}

function findJsonStringEnd(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return index + 1;
    }
  }
  return text.length;
}

function shouldPreserveJsonNumber(raw: string): boolean {
  // Keep fractional/exponent forms verbatim. Even when a particular value is
  // representable today, parsing it through Number can change its precision or
  // spelling before the JSON viewer renders it.
  if (raw.includes(".") || raw.includes("e") || raw.includes("E") || raw === "-0") return true;

  const unsigned = raw.startsWith("-") ? raw.slice(1) : raw;
  const integerPart = unsigned.split(/[.eE]/, 1)[0];
  const normalized = integerPart.replace(/^0+(?=\d)/, "");
  return normalized.length > MAX_SAFE_INTEGER_TEXT.length || (normalized.length === MAX_SAFE_INTEGER_TEXT.length && normalized > MAX_SAFE_INTEGER_TEXT);
}

function restoreLosslessNumbers(value: unknown, numbers: Map<string, string>): unknown {
  if (typeof value === "string") {
    const raw = numbers.get(value);
    return raw === undefined ? value : ({ [LOSSLESS_JSON_NUMBER]: true, raw } satisfies LosslessJsonNumber);
  }
  if (Array.isArray(value)) return value.map((item) => restoreLosslessNumbers(item, numbers));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreLosslessNumbers(item, numbers)]));
  }
  return value;
}

class JsonSourceScanner {
  readonly text: string;
  position = 0;

  constructor(text: string) {
    this.text = text;
  }

  eof(): boolean {
    return this.position >= this.text.length;
  }

  peek(): string | undefined {
    return this.text[this.position];
  }

  skipWhitespace() {
    while (this.position < this.text.length) {
      const character = this.text[this.position];
      if (character === " " || character === "\t" || character === "\n" || character === "\r") {
        this.position += 1;
        continue;
      }
      break;
    }
  }

  expect(character: string) {
    this.skipWhitespace();
    if (this.text[this.position] !== character) {
      throw new SyntaxError(`Expected '${character}' at position ${this.position}`);
    }
    this.position += 1;
  }

  readStringToken(): string {
    this.skipWhitespace();
    if (this.text[this.position] !== '"') {
      throw new SyntaxError(`Expected string at position ${this.position}`);
    }

    const start = this.position;
    this.position += 1;
    let escaped = false;
    while (this.position < this.text.length) {
      const character = this.text[this.position];
      if (escaped) {
        if (character === "u") {
          const hex = this.text.slice(this.position + 1, this.position + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new SyntaxError(`Invalid unicode escape at position ${this.position}`);
          }
          this.position += 5;
        } else if (!'"\\/bfnrt'.includes(character)) {
          throw new SyntaxError(`Invalid escape sequence at position ${this.position}`);
        } else {
          this.position += 1;
        }
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        this.position += 1;
        continue;
      }
      if (character === '"') {
        this.position += 1;
        return this.text.slice(start, this.position);
      }
      // JSON strings cannot contain raw control characters.
      if (character.charCodeAt(0) < 0x20) {
        throw new SyntaxError(`Invalid control character in string at position ${this.position}`);
      }
      this.position += 1;
    }
    throw new SyntaxError(`Unterminated string at position ${start}`);
  }

  readNumberToken(): string {
    this.skipWhitespace();
    const start = this.position;
    if (this.text[this.position] === "-") this.position += 1;

    if (this.text[this.position] === "0") {
      this.position += 1;
    } else if (this.isDigit(this.text[this.position])) {
      while (this.isDigit(this.text[this.position])) this.position += 1;
    } else {
      throw new SyntaxError(`Invalid number at position ${start}`);
    }

    if (this.text[this.position] === ".") {
      this.position += 1;
      if (!this.isDigit(this.text[this.position])) {
        throw new SyntaxError(`Invalid number at position ${start}`);
      }
      while (this.isDigit(this.text[this.position])) this.position += 1;
    }

    if (this.text[this.position] === "e" || this.text[this.position] === "E") {
      this.position += 1;
      if (this.text[this.position] === "+" || this.text[this.position] === "-") this.position += 1;
      if (!this.isDigit(this.text[this.position])) {
        throw new SyntaxError(`Invalid number at position ${start}`);
      }
      while (this.isDigit(this.text[this.position])) this.position += 1;
    }

    if (this.position === start || (this.position === start + 1 && this.text[start] === "-")) {
      throw new SyntaxError(`Invalid number at position ${start}`);
    }
    return this.text.slice(start, this.position);
  }

  readKeywordToken(keyword: "true" | "false" | "null"): string {
    this.skipWhitespace();
    if (this.text.slice(this.position, this.position + keyword.length) !== keyword) {
      throw new SyntaxError(`Expected '${keyword}' at position ${this.position}`);
    }
    this.position += keyword.length;
    return keyword;
  }

  private isDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "0" && character <= "9";
  }
}

class JsonSourceWriter {
  private readonly chunks: string[] = [];
  private readonly indentSize: number | undefined;
  private readonly pretty: boolean;

  constructor(indent?: number) {
    this.indentSize = indent !== undefined && indent > 0 ? indent : undefined;
    this.pretty = this.indentSize !== undefined;
  }

  write(text: string) {
    this.chunks.push(text);
  }

  newline(depth: number) {
    if (!this.pretty || this.indentSize === undefined) return;
    this.chunks.push("\n" + " ".repeat(this.indentSize * depth));
  }

  space() {
    if (this.pretty) this.chunks.push(" ");
  }

  toString(): string {
    return this.chunks.join("");
  }
}

function writeJsonValue(scanner: JsonSourceScanner, writer: JsonSourceWriter, depth: number) {
  scanner.skipWhitespace();
  const character = scanner.peek();
  if (character === undefined) throw new SyntaxError("Unexpected end of JSON input");

  if (character === "{") {
    writeJsonObject(scanner, writer, depth);
    return;
  }
  if (character === "[") {
    writeJsonArray(scanner, writer, depth);
    return;
  }
  if (character === '"') {
    writer.write(scanner.readStringToken());
    return;
  }
  if (character === "-" || (character >= "0" && character <= "9")) {
    writer.write(scanner.readNumberToken());
    return;
  }
  if (character === "t") {
    writer.write(scanner.readKeywordToken("true"));
    return;
  }
  if (character === "f") {
    writer.write(scanner.readKeywordToken("false"));
    return;
  }
  if (character === "n") {
    writer.write(scanner.readKeywordToken("null"));
    return;
  }

  throw new SyntaxError(`Unexpected token '${character}' at position ${scanner.position}`);
}

function writeJsonObject(scanner: JsonSourceScanner, writer: JsonSourceWriter, depth: number) {
  scanner.expect("{");
  writer.write("{");
  scanner.skipWhitespace();

  if (scanner.peek() === "}") {
    scanner.position += 1;
    writer.write("}");
    return;
  }

  let first = true;
  while (true) {
    if (!first) {
      scanner.expect(",");
      writer.write(",");
    }
    first = false;
    writer.newline(depth + 1);
    writer.write(scanner.readStringToken());
    scanner.expect(":");
    writer.write(":");
    writer.space();
    writeJsonValue(scanner, writer, depth + 1);
    scanner.skipWhitespace();
    if (scanner.peek() === "}") {
      scanner.position += 1;
      writer.newline(depth);
      writer.write("}");
      return;
    }
    if (scanner.peek() !== ",") {
      throw new SyntaxError(`Expected ',' or '}' in object at position ${scanner.position}`);
    }
  }
}

function writeJsonArray(scanner: JsonSourceScanner, writer: JsonSourceWriter, depth: number) {
  scanner.expect("[");
  writer.write("[");
  scanner.skipWhitespace();

  if (scanner.peek() === "]") {
    scanner.position += 1;
    writer.write("]");
    return;
  }

  let first = true;
  while (true) {
    if (!first) {
      scanner.expect(",");
      writer.write(",");
    }
    first = false;
    writer.newline(depth + 1);
    writeJsonValue(scanner, writer, depth + 1);
    scanner.skipWhitespace();
    if (scanner.peek() === "]") {
      scanner.position += 1;
      writer.newline(depth);
      writer.write("]");
      return;
    }
    if (scanner.peek() !== ",") {
      throw new SyntaxError(`Expected ',' or ']' in array at position ${scanner.position}`);
    }
  }
}
