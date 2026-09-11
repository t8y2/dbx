/**
 * Shared Mongo shell → JSON argument preprocessing.
 * Single home for ObjectId/ISODate rewriting, key quoting, and paren/arg splitting.
 */

/** Normalize a shell argument to JSON text the backend can parse, or null if invalid. */
export function normalizeJsonArgument(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "{}";
  const withRegexLiterals = replaceMongoRegexLiterals(trimmed);
  if (!withRegexLiterals) return null;
  const withoutComments = stripMongoJsonComments(withRegexLiterals).trim();
  if (!withoutComments) return "{}";
  const withoutEjsonDeserialize = replaceMongoEjsonDeserialize(withoutComments);
  // Rewrite mongo shell constructors that are not valid JSON into extended JSON
  // (mongo_driver::json_value_to_bson): ObjectId / ISODate / new Date / NumberLong /
  // NumberInt / NumberDecimal.
  const withExtendedJson = replaceMongoShellConstructors(withoutEjsonDeserialize);
  const preprocessed = quoteUnquotedObjectKeys(convertSingleQuotedStrings(withExtendedJson));
  try {
    JSON.parse(preprocessed);
    return preprocessed;
  } catch {
    return null;
  }
}

const MONGO_REGEX_LITERAL_OPTIONS = new Set(["i", "m", "s", "u"]);
// JS-only regex flags with no server-side meaning for a stored regex literal
// (MongoDB's $regex has no global modifier) are dropped instead of failing
// the whole command.
const MONGO_REGEX_LITERAL_IGNORED_OPTIONS = new Set(["d", "g", "v", "y"]);

interface MongoRegexLiteral {
  end: number;
  pattern: string;
  options: string;
}

function mongoRegexLiteralAt(source: string, index: number): MongoRegexLiteral | null {
  if (source[index] !== "/" || !isMongoRegexValuePosition(source, index)) return null;

  return readMongoRegexLiteral(source, index);
}

function readMongoRegexLiteral(source: string, index: number): MongoRegexLiteral | null {
  let cursor = index + 1;
  let pattern = "";
  let escaped = false;
  let inCharacterClass = false;
  let closed = false;
  while (cursor < source.length) {
    const current = source[cursor] ?? "";
    if (current === "\n" || current === "\r" || current === "\u2028" || current === "\u2029") return null;
    if (escaped) {
      pattern += current;
      escaped = false;
      cursor += 1;
      continue;
    }
    if (current === "\\") {
      pattern += current;
      escaped = true;
      cursor += 1;
      continue;
    }
    if (current === "[") inCharacterClass = true;
    else if (current === "]" && inCharacterClass) inCharacterClass = false;
    else if (current === "/" && !inCharacterClass) {
      closed = true;
      cursor += 1;
      break;
    }
    pattern += current;
    cursor += 1;
  }
  if (!closed) return null;

  const options: string[] = [];
  while (/[A-Za-z]/.test(source[cursor] ?? "")) {
    const option = source[cursor] ?? "";
    cursor += 1;
    if (MONGO_REGEX_LITERAL_IGNORED_OPTIONS.has(option)) continue;
    if (!MONGO_REGEX_LITERAL_OPTIONS.has(option) || options.includes(option)) return null;
    options.push(option);
  }
  options.sort();
  return { end: cursor, pattern, options: options.join("") };
}

function replaceMongoRegexLiterals(source: string): string | null {
  let result = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? "";
    if (char === '"' || char === "'") {
      const start = index;
      const quote = char;
      index += 1;
      let escaped = false;
      while (index < source.length) {
        const current = source[index] ?? "";
        index += 1;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === quote) break;
      }
      result += source.slice(start, index);
      continue;
    }

    const commentEnd = mongoCommentEndAt(source, index);
    if (commentEnd !== null) {
      result += source.slice(index, commentEnd);
      index = commentEnd;
      continue;
    }

    if (char !== "/" || !isMongoRegexValuePosition(source, index)) {
      result += char;
      index += 1;
      continue;
    }

    const literal = mongoRegexLiteralAt(source, index);
    if (!literal) return null;
    result += JSON.stringify({ $regularExpression: { pattern: literal.pattern, options: literal.options } });
    index = literal.end;
  }

  return result;
}

function isMongoRegexValuePosition(source: string, index: number): boolean {
  let previousSignificant: string | null = null;
  let cursor = 0;

  while (cursor < index) {
    const char = source[cursor] ?? "";
    if (char === '"' || char === "'") {
      const quote = char;
      cursor += 1;
      let escaped = false;
      while (cursor < index) {
        const current = source[cursor] ?? "";
        cursor += 1;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === quote) break;
      }
      previousSignificant = "value";
      continue;
    }

    const commentEnd = mongoCommentEndAt(source, cursor);
    if (commentEnd !== null) {
      cursor = Math.min(commentEnd, index);
      continue;
    }

    if (char === "/" && isMongoRegexValuePrefix(previousSignificant)) {
      const literal = readMongoRegexLiteral(source, cursor);
      if (literal && literal.end <= index) {
        previousSignificant = "value";
        cursor = literal.end;
        continue;
      }
    }

    if (!/\s/.test(char)) previousSignificant = char;
    cursor += 1;
  }

  return isMongoRegexValuePrefix(previousSignificant);
}

function isMongoRegexValuePrefix(previousSignificant: string | null): boolean {
  return previousSignificant === null || previousSignificant === ":" || previousSignificant === "[" || previousSignificant === "," || previousSignificant === "(";
}

/** Object-shaped shell arg (options documents, etc.). */
export function parseMongoObjectArgument(arg: string | undefined): string | null {
  if (!arg?.trim()) return null;
  const normalized = normalizeJsonArgument(arg);
  if (!normalized) return null;
  try {
    const value = JSON.parse(normalized) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? normalized : null;
  } catch {
    return null;
  }
}

export function parseCollectionMethodTarget(source: string, method: string): { collection: string; methodCallIndex: number } | null {
  const escapedMethod = escapeRegExp(method);
  const direct = new RegExp(`^db\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\.\\s*${escapedMethod}\\s*\\(`).exec(source);
  if (direct) {
    return { collection: direct[1]!, methodCallIndex: findChainedMethodCallIndex(source, method) };
  }
  const getCollection = new RegExp(`^db\\s*\\.\\s*getCollection\\s*\\(\\s*(["'])(.*?)\\1\\s*\\)\\s*\\.\\s*${escapedMethod}\\s*\\(`).exec(source);
  if (getCollection) {
    return { collection: getCollection[2]!, methodCallIndex: findChainedMethodCallIndex(source, method) };
  }
  return null;
}

export function findChainedMethodCallIndex(source: string, method: string): number {
  return chainedMethodCallPattern(method).exec(source)?.index ?? -1;
}

export function chainedMethodCallPattern(method: string): RegExp {
  return new RegExp(`\\.\\s*${escapeRegExp(method)}\\s*\\(`, "g");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    const commentEnd = mongoCommentEndAt(source, i);
    if (commentEnd !== null) {
      i = commentEnd - 1;
      continue;
    }

    const regexLiteral = mongoRegexLiteralAt(source, i);
    if (regexLiteral) {
      i = regexLiteral.end - 1;
      continue;
    }

    if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }

  parts.push(source.slice(start).trim());
  return parts;
}

export function findMatchingParen(source: string, openIndex: number): number {
  if (openIndex < 0 || source[openIndex] !== "(") return -1;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    const commentEnd = mongoCommentEndAt(source, i);
    if (commentEnd !== null) {
      i = commentEnd - 1;
      continue;
    }

    const regexLiteral = mongoRegexLiteralAt(source, i);
    if (regexLiteral) {
      i = regexLiteral.end - 1;
      continue;
    }

    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/** True when (), [], {}, or quotes are unbalanced. */
export function hasUnclosedMongoDelimiters(source: string): boolean {
  const stack: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    const commentEnd = mongoCommentEndAt(source, i);
    if (commentEnd !== null) {
      i = commentEnd - 1;
      continue;
    }
    const regexLiteral = mongoRegexLiteralAt(source, i);
    if (regexLiteral) {
      i = regexLiteral.end - 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      stack.push(char);
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      const expected = char === ")" ? "(" : char === "]" ? "[" : "{";
      if (stack.pop() !== expected) return true;
    }
  }
  return quote !== null || stack.length > 0;
}

/** Remove shell/SQL-style comments from JSON-like Mongo arguments. */
export function stripMongoJsonComments(source: string): string {
  let result = "";
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }

    const commentEnd = mongoCommentEndAt(source, i);
    if (commentEnd !== null) {
      result += source
        .slice(i, commentEnd)
        .replace(/[^\n\r\u2028\u2029]/g, " ")
        .replace(/[\u2028\u2029]/g, "\n");
      i = commentEnd - 1;
      continue;
    }

    result += char;
  }

  return result;
}

/** Strip leading line/block comments (//, --, and block comments). */
export function trimMongoOuterComments(source: string): string {
  let text = source;
  for (;;) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("--")) {
      const end = mongoLineCommentEnd(trimmed, 2);
      text = end >= trimmed.length ? "" : trimmed.slice(end);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end < 0) return trimmed;
      text = trimmed.slice(end + 2);
      continue;
    }
    return trimmed.trimEnd();
  }
}

function mongoCommentEndAt(source: string, index: number): number | null {
  const current = source[index];
  const next = source[index + 1];
  if ((current === "/" && next === "/") || (current === "-" && next === "-")) {
    return mongoLineCommentEnd(source, index + 2);
  }
  if (current === "/" && next === "*") {
    const end = source.indexOf("*/", index + 2);
    return end < 0 ? source.length : end + 2;
  }
  return null;
}

function mongoLineCommentEnd(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\r") return source[index + 1] === "\n" ? index + 2 : index + 1;
    if (char === "\n" || char === "\u2028" || char === "\u2029") return index + 1;
  }
  return source.length;
}

function removeTrailingCommas(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ",") {
      let next = index + 1;
      while (/\s/.test(source[next] ?? "")) next += 1;
      if (source[next] === "}" || source[next] === "]") continue;
    }

    result += char;
  }

  return result;
}

export function quoteUnquotedObjectKeys(source: string): string {
  let result = "";
  let quote: string | null = null;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }

    if (/[A-Za-z_$]/.test(char) && shouldQuoteObjectKey(source, i)) {
      let end = i + 1;
      while (/[\w$]/.test(source[end] || "")) end += 1;
      result += `"${source.slice(i, end)}"`;
      i = end - 1;
      continue;
    }

    result += char;
  }

  return result;
}

function shouldQuoteObjectKey(source: string, index: number): boolean {
  let before = index - 1;
  while (/\s/.test(source[before] || "")) before -= 1;
  if (source[before] !== "{" && source[before] !== ",") return false;

  let after = index + 1;
  while (/[\w$]/.test(source[after] || "")) after += 1;
  while (/\s/.test(source[after] || "")) after += 1;
  return source[after] === ":";
}

function replaceMongoEjsonDeserialize(source: string): string {
  const callPattern = /^EJSON\s*\.\s*deserialize\s*\(/;
  let result = "";
  let index = 0;
  while (index < source.length) {
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      const start = index++;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === quote) {
          index++;
          break;
        } else index++;
      }
      result += source.slice(start, index);
      continue;
    }

    const match = source.slice(index).match(callPattern);
    if (!match) {
      result += source[index++]!;
      continue;
    }
    const openIndex = index + match[0].lastIndexOf("(");
    const closeIndex = findMatchingParen(source, openIndex);
    if (closeIndex < 0) {
      result += source[index++]!;
      continue;
    }
    const args = splitTopLevel(source.slice(openIndex + 1, closeIndex));
    if (args.length !== 1 || !args[0]?.trim()) {
      result += source.slice(index, closeIndex + 1);
      index = closeIndex + 1;
      continue;
    }
    result += args[0].trim();
    index = closeIndex + 1;
  }
  return result;
}

/**
 * Shell value constructors rewritten to extended JSON.
 * `Date` is only recognised after `new`, matching the shell where a bare `Date()`
 * returns a string rather than a date.
 */
const SHELL_CONSTRUCTORS = new Set(["ObjectId", "ISODate", "Date", "NumberLong", "NumberInt", "NumberDecimal"]);
const CONSTRUCTOR_CALL = /^(new\s+)?([A-Za-z_$][\w$]*)\s*\(/;
const QUOTED_ARGUMENT = /^(["'])([^\\]*)\1$/;
const INTEGER_ARGUMENT = /^-?\d+$/;
const DECIMAL_ARGUMENT = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const INT64_BOUNDS = [-9223372036854775808n, 9223372036854775807n] as const;
const INT32_BOUNDS = [-2147483648n, 2147483647n] as const;

/** Bounds parity with the Rust parser, which range-checks before emitting $numberLong / $numberInt. */
function fitsIntegerBounds(value: string, bounds: readonly [bigint, bigint]): boolean {
  try {
    const parsed = BigInt(value);
    return parsed >= bounds[0] && parsed <= bounds[1];
  } catch {
    return false;
  }
}

function replaceMongoShellConstructors(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      const start = index++;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index] === quote) {
          index++;
          break;
        } else index++;
      }
      result += source.slice(start, index);
      continue;
    }
    const call = matchShellConstructorCall(source, index);
    if (!call) {
      result += source[index++]!;
      continue;
    }
    result += call.json;
    index = call.end;
  }
  return result;
}

/** Rewrite one `Name(...)` / `new Name(...)` call at {@link index}, or null when it is not a known constructor. */
function matchShellConstructorCall(source: string, index: number): { json: string; end: number } | null {
  const match = CONSTRUCTOR_CALL.exec(source.slice(index));
  if (!match) return null;
  const name = match[2]!;
  if (!SHELL_CONSTRUCTORS.has(name)) return null;
  if (name === "Date" && !match[1]) return null;

  const openIndex = index + match[0].length - 1;
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0) return null;

  const inner = source.slice(openIndex + 1, closeIndex).trim();
  const args = inner ? splitTopLevel(inner) : [];
  const json = shellConstructorToExtendedJson(name, args);
  return json === null ? null : { json, end: closeIndex + 1 };
}

function shellConstructorToExtendedJson(name: string, args: string[]): string | null {
  if (args.length > 1) return null;
  const arg = args[0]?.trim();
  const literal = arg ? (QUOTED_ARGUMENT.exec(arg)?.[2] ?? null) : null;

  switch (name) {
    case "ObjectId":
      if (!arg) return wrap("$oid", generateObjectIdHex());
      return literal !== null || INTEGER_ARGUMENT.test(arg) ? wrap("$oid", literal ?? arg) : null;
    case "ISODate":
    case "Date":
      if (!arg) return wrap("$date", new Date().toISOString());
      if (literal !== null) return wrap("$date", literal);
      // `new Date(1735689600000)` takes epoch milliseconds, which extended JSON
      // carries as a nested $numberLong rather than a bare number.
      return INTEGER_ARGUMENT.test(arg) && fitsIntegerBounds(arg, INT64_BOUNDS) ? `{"$date":{"$numberLong":${JSON.stringify(arg)}}}` : null;
    case "NumberLong":
    case "NumberInt": {
      const value = literal ?? arg;
      if (value === undefined || !INTEGER_ARGUMENT.test(value)) return null;
      if (!fitsIntegerBounds(value, name === "NumberLong" ? INT64_BOUNDS : INT32_BOUNDS)) return null;
      return wrap(name === "NumberLong" ? "$numberLong" : "$numberInt", value);
    }
    case "NumberDecimal": {
      const value = literal ?? arg;
      if (value === undefined || !DECIMAL_ARGUMENT.test(value)) return null;
      return wrap("$numberDecimal", value);
    }
    default:
      return null;
  }
}

function wrap(key: string, value: string): string {
  return `{${JSON.stringify(key)}:${JSON.stringify(value)}}`;
}

const OBJECT_ID_RANDOM = randomHex(5);
let objectIdCounter = Math.floor(Math.random() * 0xffffff);

/** Client-side ObjectId for a bare `ObjectId()`, mirroring how the shell fills one in. */
function generateObjectIdHex(): string {
  objectIdCounter = (objectIdCounter + 1) % 0x1000000;
  const seconds = Math.floor(Date.now() / 1000) % 0x100000000;
  return seconds.toString(16).padStart(8, "0") + OBJECT_ID_RANDOM + objectIdCounter.toString(16).padStart(6, "0");
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(values);
  else for (let i = 0; i < bytes; i += 1) values[i] = Math.floor(Math.random() * 256);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function convertSingleQuotedStrings(source: string): string {
  let result = "";
  let copiedUntil = 0;
  let quote: string | null = null;
  let start = 0;
  let value = "";
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (!quote) {
      if (char === "'") {
        quote = char;
        start = i;
        value = "";
        escaped = false;
      } else if (char === '"') {
        quote = char;
      }
      continue;
    }

    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = null;
      continue;
    }

    if (escaped) {
      value += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "'") {
      result += source.slice(copiedUntil, start) + JSON.stringify(value);
      copiedUntil = i + 1;
      quote = null;
    } else {
      value += char;
    }
  }

  const converted = quote === "'" ? source : result + source.slice(copiedUntil);
  return removeTrailingCommas(converted);
}
