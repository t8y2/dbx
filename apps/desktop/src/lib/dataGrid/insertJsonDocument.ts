import { parseJsonPreservingLargeNumbers, stringifyJsonPreservingLargeNumbers } from "@/lib/common/safeJsonFormat";

export type JsonDocument = Record<string, unknown>;

export type InsertJsonParseResult = { ok: true; documents: JsonDocument[] } | { ok: false; error: InsertJsonParseError };

export type InsertJsonParseError = { kind: "empty" } | { kind: "syntax"; message: string; line?: number; column?: number } | { kind: "not-object" } | { kind: "empty-array" };

export const EMPTY_INSERT_JSON_DOCUMENT = "{\n  \n}";

function isJsonDocument(value: unknown): value is JsonDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const JSON_LITERALS = ["true", "false", "null"];
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
// JSON forbids raw control characters inside strings.
// oxlint-disable-next-line no-control-regex
const JSON_STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

/**
 * Finds where JSON text stops being valid. JSON.parse messages carry no
 * position in WebKit (the macOS webview) or current V8, so the dialog locates
 * the error itself to point at a line.
 */
function findJsonSyntaxError(text: string): { offset: number; message: string } | null {
  let index = 0;
  const skipWhitespace = () => {
    while (index < text.length && " \t\n\r".includes(text[index]!)) index++;
  };
  const fail = (expected: string): never => {
    throw { offset: index, message: index >= text.length ? `Unexpected end of input, expected ${expected}` : `Unexpected '${text[index]}', expected ${expected}` };
  };
  const match = (pattern: RegExp) => {
    pattern.lastIndex = index;
    if (!pattern.test(text)) return false;
    index = pattern.lastIndex;
    return true;
  };
  const value = (): void => {
    skipWhitespace();
    const char = text[index];
    if (char === "{") {
      index++;
      skipWhitespace();
      if (text[index] === "}") return void index++;
      for (;;) {
        skipWhitespace();
        if (!match(JSON_STRING)) fail("a quoted property name");
        skipWhitespace();
        if (text[index] !== ":") fail("':'");
        index++;
        value();
        skipWhitespace();
        if (text[index] === ",") index++;
        else if (text[index] === "}") return void index++;
        else fail("',' or '}'");
      }
    }
    if (char === "[") {
      index++;
      skipWhitespace();
      if (text[index] === "]") return void index++;
      for (;;) {
        value();
        skipWhitespace();
        if (text[index] === ",") index++;
        else if (text[index] === "]") return void index++;
        else fail("',' or ']'");
      }
    }
    if (char === '"') {
      if (!match(JSON_STRING)) fail("a valid string");
      return;
    }
    const literal = JSON_LITERALS.find((word) => text.startsWith(word, index));
    if (literal) return void (index += literal.length);
    if (!match(JSON_NUMBER)) fail("a value");
  };
  try {
    value();
    skipWhitespace();
    if (index < text.length) fail("end of input");
    return null;
  } catch (error) {
    return error as { offset: number; message: string };
  }
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n") };
}

/** Accepts one JSON object or an array of JSON objects. */
export function parseInsertJsonDocuments(text: string): InsertJsonParseResult {
  if (!text.trim()) return { ok: false, error: { kind: "empty" } };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const located = findJsonSyntaxError(text);
    if (located) return { ok: false, error: { kind: "syntax", message: located.message, ...lineAndColumn(text, located.offset) } };
    return { ok: false, error: { kind: "syntax", message: error instanceof Error ? error.message : String(error) } };
  }
  if (isJsonDocument(value)) return { ok: true, documents: [value] };
  if (Array.isArray(value)) {
    if (value.length === 0) return { ok: false, error: { kind: "empty-array" } };
    if (!value.every(isJsonDocument)) return { ok: false, error: { kind: "not-object" } };
    return { ok: true, documents: value };
  }
  return { ok: false, error: { kind: "not-object" } };
}

/** Pretty-prints valid JSON without rounding large numbers; returns null when the text does not parse. */
export function formatInsertJson(text: string): string | null {
  try {
    return stringifyJsonPreservingLargeNumbers(parseJsonPreservingLargeNumbers(text), 2);
  } catch {
    return null;
  }
}

/**
 * Splits validated insert text into one JSON text per document, keeping large
 * numbers exact so each piece can go through the store's own document parser.
 */
export function splitInsertJsonDocumentTexts(text: string): string[] {
  const value = parseJsonPreservingLargeNumbers(text);
  return Array.isArray(value) ? value.map((document) => stringifyJsonPreservingLargeNumbers(document)) : [text];
}

/** Document-store hooks behind the grid's Insert JSON Document and Edit Row dialogs (MongoDB). */
export interface DataGridJsonDocumentEditor {
  breadcrumb?: string[];
  insert: (text: string) => Promise<void>;
  /** Formatted JSON of the stored document behind a result row. */
  documentText: (sourceIndex: number) => string | undefined;
  update: (sourceIndex: number, text: string) => Promise<void>;
}
