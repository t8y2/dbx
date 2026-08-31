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

/**
 * Decode non-ASCII unicode escapes (`\uXXXX`) inside JSON string tokens (keys
 * and values) so text like `{"name":"张三"}` renders as `{"name":"张三"}`.
 *
 * - Code points >= 0x80 are decoded to their characters; ASCII control escapes
 *   (U+0000, U+000A, ...) are kept verbatim so the output stays valid JSON.
 * - Surrogate pairs combine into a single code point; unpaired surrogates stay
 *   escaped rather than emitting invalid lone surrogate characters.
 * - Escaped backslashes are respected, so a literal `"\\u5f20"` (whose content
 *   is the text `张`) is never mis-decoded, and an escaped quote `\"` is
 *   consumed inside a string token so it never terminates the token.
 *
 * This is a view-layer transform only and must never be written back to a
 * database on its own.
 */
export function decodeJsonUnicodeEscapes(text: string): string {
  return decodeJsonSource(text).display;
}

/**
 * Result of walking a JSON source with {@link decodeJsonSource}: the decoded
 * display text plus the raw-source offset of every display code unit, which lets
 * callers map display edits back onto the source without touching escapes.
 */
export interface JsonUnicodeDecodedSource {
  /** Decoded display text (what the JSON editor shows in decoded mode). */
  display: string;
  /**
   * displayToRaw[i] is the raw-source offset where display code unit i
   * originates, for i in [0, display.length]; displayToRaw[display.length] is
   * raw.length. Surrogate-pair display units both point at the pair's start.
   */
  displayToRaw: number[];
}

function decodeJsonSource(text: string): JsonUnicodeDecodedSource {
  let display = "";
  const displayToRaw: number[] = [];
  let index = 0;
  const push = (ch: string, rawStart: number) => {
    // Iterate code units, not code points, so surrogate-pair characters record
    // an offset for each of their two units and stay aligned with display.length.
    for (let unitIndex = 0; unitIndex < ch.length; unitIndex += 1) {
      display += ch[unitIndex];
      displayToRaw.push(rawStart);
    }
  };

  while (index < text.length) {
    if (text[index] !== '"') {
      push(text[index], index);
      index += 1;
      continue;
    }

    // Rebuild one JSON string token, decoding escapes inside it.
    const tokenStart = index;
    index += 1;
    push('"', tokenStart);
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        push('"', index);
        index += 1;
        break;
      }
      if (character !== "\\") {
        push(character, index);
        index += 1;
        continue;
      }

      const next = text[index + 1];
      if (next === undefined) {
        push("\\", index);
        index += 1;
        break;
      }
      const hex = text.slice(index + 2, index + 6);
      if (next !== "u" || !/^[0-9a-fA-F]{4}$/.test(hex)) {
        // Not a unicode escape (escaped backslash, escaped quote, ...); copy verbatim.
        push(`\\${next}`, index);
        index += 2;
        continue;
      }

      const code = parseInt(hex, 16);
      const lowEscape = text.slice(index + 6, index + 12);
      const lowMatch = /^\\u([0-9a-fA-F]{4})$/.exec(lowEscape);
      if (code >= 0xd800 && code <= 0xdbff && lowMatch) {
        const low = parseInt(lowMatch[1], 16);
        if (low >= 0xdc00 && low <= 0xdfff) {
          push(String.fromCodePoint(0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)), index);
          index += 12;
          continue;
        }
      }
      if (code >= 0xd800 && code <= 0xdfff) {
        // Unpaired surrogate: keep the escape rather than emit a lone surrogate char.
        push(`\\u${hex}`, index);
      } else if (code >= 0x80) {
        push(String.fromCharCode(code), index);
      } else {
        // ASCII control escapes stay escaped for valid JSON.
        push(`\\u${hex}`, index);
      }
      index += 6;
    }
  }
  displayToRaw.push(text.length);
  return { display, displayToRaw };
}

/**
 * Reconstruct the raw JSON source for a decoded-mode editor draft.
 *
 * The editor shows {@link decodeJsonUnicodeEscapes decoded} text; this maps the
 * user's current draft back onto the canonical raw source so untouched escapes
 * and the original whitespace/formatting are preserved. Decoded mode only inlines
 * non-ASCII `\uXXXX` escapes, so every other span of the draft is already JSON
 * source and is written back verbatim — inserted `\\`, `\"`, and control escapes
 * keep their meaning instead of being re-escaped. When the draft equals the
 * decoded baseline the raw source is returned unchanged.
 *
 * The result is only valid JSON when the draft is; callers must still validate
 * with {@link formatJsonSource} before saving.
 */
export function mapDisplayToRaw(raw: string, displayCurrent: string): string {
  const { display: baseline, displayToRaw } = decodeJsonSource(raw);
  if (displayCurrent === baseline) return raw;
  let out = "";
  for (const op of diffText(baseline, displayCurrent)) {
    if (op.kind === "equal") {
      out += raw.slice(displayToRaw[op.aFrom], displayToRaw[op.aTo]);
    } else if (op.kind === "delete") {
      // The deleted display span's raw source is dropped with it.
    } else {
      // Inserted display text is JSON source in the decoded draft; write it back
      // verbatim so its value semantics are preserved.
      out += displayCurrent.slice(op.bFrom, op.bTo);
    }
  }
  return out;
}

type DisplayDiffOp = { kind: "equal"; aFrom: number; aTo: number; bFrom: number; bTo: number } | { kind: "delete"; aFrom: number; aTo: number; bFrom: number; bTo: number } | { kind: "insert"; aFrom: number; aTo: number; bFrom: number; bTo: number };

// Beyond this combined size, fall back to a single replace; whole-document
// rewrites gain nothing from escape-level preservation.
const MAX_DIFF_UNITS = 200_000;
// Cap the Myers edit distance so adversarial edits stay bounded in time and trace.
const MAX_DIFF_DISTANCE = 2000;

function diffText(a: string, b: string): DisplayDiffOp[] {
  const source = splitCodePoints(a);
  const target = splitCodePoints(b);
  let prefix = 0;
  while (prefix < source.units.length && prefix < target.units.length && source.units[prefix] === target.units[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < source.units.length - prefix && suffix < target.units.length - prefix && source.units[source.units.length - 1 - suffix] === target.units[target.units.length - 1 - suffix]) {
    suffix += 1;
  }
  const sourceMiddleEnd = source.units.length - suffix;
  const targetMiddleEnd = target.units.length - suffix;
  const midA = source.units.slice(prefix, sourceMiddleEnd);
  const midB = target.units.slice(prefix, targetMiddleEnd);

  const ops: DisplayDiffOp[] = [];
  if (prefix > 0) ops.push({ kind: "equal", aFrom: 0, aTo: source.offsets[prefix], bFrom: 0, bTo: target.offsets[prefix] });
  if (midA.length > 0 || midB.length > 0) {
    const replace = (): DisplayDiffOp[] => [
      { kind: "delete", aFrom: source.offsets[prefix], aTo: source.offsets[sourceMiddleEnd], bFrom: target.offsets[prefix], bTo: target.offsets[prefix] },
      { kind: "insert", aFrom: source.offsets[prefix], aTo: source.offsets[prefix], bFrom: target.offsets[prefix], bTo: target.offsets[targetMiddleEnd] },
    ];
    const middle = midA.length + midB.length <= MAX_DIFF_UNITS ? myersDiff(midA, midB) : null;
    if (!middle) {
      ops.push(...replace());
    } else {
      for (const op of middle) {
        ops.push({
          kind: op.kind,
          aFrom: source.offsets[prefix + op.aFrom],
          aTo: source.offsets[prefix + op.aTo],
          bFrom: target.offsets[prefix + op.bFrom],
          bTo: target.offsets[prefix + op.bTo],
        });
      }
    }
  }
  if (suffix > 0) {
    ops.push({ kind: "equal", aFrom: source.offsets[sourceMiddleEnd], aTo: a.length, bFrom: target.offsets[targetMiddleEnd], bTo: b.length });
  }
  return ops;
}

function splitCodePoints(text: string): { units: string[]; offsets: number[] } {
  const units: string[] = [];
  const offsets = [0];
  let offset = 0;
  for (const unit of text) {
    units.push(unit);
    offset += unit.length;
    offsets.push(offset);
  }
  return { units, offsets };
}

type MidDiffOp = { kind: "equal" | "delete" | "insert"; aFrom: number; aTo: number; bFrom: number; bTo: number };

function myersDiff(a: readonly string[], b: readonly string[]): MidDiffOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let foundD = -1;
  for (let d = 0; d <= max && d <= MAX_DIFF_DISTANCE; d += 1) {
    // Snapshot V[d-1] for backtracking: reachable k at depth d have parity d,
    // so the previous frontier lives on k with parity d-1.
    const level = new Int32Array(2 * d + 1);
    for (let k = -(d - 1); k <= d - 1; k += 2) level[k + d] = v[k + offset];
    trace.push(level);
    for (let k = -d; k <= d; k += 2) {
      const fromDown = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]);
      let x = fromDown ? v[k + 1 + offset] : v[k - 1 + offset] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD >= 0) break;
  }
  if (foundD < 0) return null;

  const ops: MidDiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d -= 1) {
    const level = trace[d];
    const k = x - y;
    const fromDown = k === -d || (k !== d && level[k - 1 + d] < level[k + 1 + d]);
    const prevK = fromDown ? k + 1 : k - 1;
    const prevX = level[prevK + d];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "equal", aFrom: x - 1, aTo: x, bFrom: y - 1, bTo: y });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ kind: "insert", aFrom: x, aTo: x, bFrom: prevY, bTo: y });
    } else {
      ops.push({ kind: "delete", aFrom: prevX, aTo: x, bFrom: y, bTo: y });
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  return coalesceMidOps(ops);
}

function coalesceMidOps(ops: MidDiffOp[]): MidDiffOp[] {
  const out: MidDiffOp[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.kind === op.kind && last.aTo === op.aFrom && last.bTo === op.bFrom) {
      last.aTo = op.aTo;
      last.bTo = op.bTo;
    } else {
      out.push({ ...op });
    }
  }
  return out;
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
