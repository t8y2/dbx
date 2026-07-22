/**
 * Shared Mongo shell → JSON argument preprocessing.
 * Single home for ObjectId/ISODate rewriting, key quoting, and paren/arg splitting.
 */

/** Normalize a shell argument to JSON text the backend can parse, or null if invalid. */
export function normalizeJsonArgument(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "{}";
  const withoutComments = stripMongoJsonComments(trimmed).trim();
  if (!withoutComments) return "{}";
  // Rewrite mongo shell constructors that are not valid JSON into extended JSON
  // (mongo_driver::json_value_to_bson): ObjectId / NumberLong / ISODate / new Date.
  const withExtendedJson = replaceMongoShellConstructors(withoutComments);
  const preprocessed = quoteUnquotedObjectKeys(convertSingleQuotedStrings(withExtendedJson));
  try {
    JSON.parse(preprocessed);
    return preprocessed;
  } catch {
    return null;
  }
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

function replaceMongoShellConstructors(source: string): string {
  const constructor = /^(ObjectId|NumberLong|ISODate)\s*\(\s*["']([^"']+)["']\s*\)|^(ObjectId|NumberLong)\s*\(\s*(-?\d+)\s*\)|^(?:new\s+Date)\s*\(\s*["']([^"']+)["']\s*\)/;
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
    const match = source.slice(index).match(constructor);
    if (!match) {
      result += source[index++]!;
      continue;
    }
    if (match[1]) {
      result += match[1] === "ObjectId" ? `{"$oid":"${match[2]}"}` : match[1] === "NumberLong" ? `{"$numberLong":"${match[2]}"}` : `{"$date":"${match[2]}"}`;
    } else if (match[3]) {
      result += match[3] === "NumberLong" ? `{"$numberLong":"${match[4]}"}` : `{"$oid":"${match[4]}"}`;
    } else {
      result += `{"$date":"${match[5]}"}`;
    }
    index += match[0].length;
  }
  return result;
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

  return quote === "'" ? source : result + source.slice(copiedUntil);
}
