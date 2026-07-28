import { isLosslessJsonNumber, parseJsonPreservingLargeNumbers, stringifyJsonPreservingLargeNumbers } from "@/lib/common/safeJsonFormat";
import { parseMongoDocumentInputValue, serializeMongoDocumentId, type MongoInputValue } from "@/lib/mongo/mongoDocumentValues";
import type { DocumentStoreKind } from "@/lib/app/documentStoreProvider";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_BSON_INT64 = -9223372036854775808n;
const MAX_BSON_INT64 = 9223372036854775807n;

export type ParseDocumentStoreJsonDocumentError = "empty" | "invalid" | "not-object" | "unsupported-number" | "duplicate-key";

export type ParseDocumentStoreJsonDocumentResult = { ok: true; document: Record<string, unknown> } | { ok: false; error: Exclude<ParseDocumentStoreJsonDocumentError, "duplicate-key"> } | { ok: false; error: "duplicate-key"; field: string };

export type PrepareDocumentStoreWriteDocumentOptions = {
  kind: DocumentStoreKind;
  mode: "insert" | "update";
};

export function parseDocumentStoreInputValue(raw: MongoInputValue, kind: DocumentStoreKind): unknown {
  if (kind === "mongodb") return parseMongoDocumentInputValue(raw);
  if (raw === null || typeof raw === "number" || typeof raw === "boolean") return raw;

  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return parseJsonPreservingLargeNumbers(trimmed);
  } catch {
    return trimmed;
  }
}

export function stringifyDocumentStoreValue(value: unknown, kind: DocumentStoreKind, indent?: number): string {
  return kind === "elasticsearch" ? stringifyJsonPreservingLargeNumbers(value, indent) : JSON.stringify(value, null, indent ?? undefined);
}

export function documentStoreValueForGrid(value: unknown, kind: DocumentStoreKind): MongoInputValue {
  if (kind === "elasticsearch" && isLosslessJsonNumber(value)) return value.raw;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return stringifyDocumentStoreValue(value, kind);
}

export function serializeDocumentStoreId(value: unknown, kind: DocumentStoreKind): string {
  return kind === "elasticsearch" ? String(value) : serializeMongoDocumentId(value);
}

/**
 * Parse a whole document JSON payload for MongoDB / Elasticsearch editors.
 * Accepts standard JSON and Extended JSON objects; rejects non-object roots.
 * Duplicate object keys are rejected instead of being silently collapsed by JSON.parse.
 */
export function parseDocumentStoreJsonDocument(text: string, kind: DocumentStoreKind): ParseDocumentStoreJsonDocumentResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "empty" };

  const duplicateKey = findDuplicateJsonObjectKey(trimmed);
  if (duplicateKey) return { ok: false, error: "duplicate-key", field: duplicateKey };

  let parsed: unknown;
  try {
    parsed = parseJsonPreservingLargeNumbers(trimmed);
  } catch {
    return { ok: false, error: "invalid" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "not-object" };
  }

  try {
    const document = kind === "mongodb" ? (convertMongoJsonValue(parsed) as Record<string, unknown>) : (parsed as Record<string, unknown>);
    return { ok: true, document };
  } catch (error) {
    if (error instanceof UnsupportedMongoJsonNumberError) return { ok: false, error: "unsupported-number" };
    return { ok: false, error: "invalid" };
  }
}

/**
 * Normalize a parsed document for insert/update.
 * - Updates drop `_id` from the body (identity is applied via the write path).
 * - Elasticsearch always drops `_routing` from the body; routing is an API argument on insert/update/delete.
 * - Identity changes are planned by the caller (write under the new id/routing, then delete the old document).
 */
export function prepareDocumentStoreWriteDocument(document: Record<string, unknown>, options: PrepareDocumentStoreWriteDocumentOptions): Record<string, unknown> {
  const next: Record<string, unknown> = { ...document };

  if (options.mode === "update" && Object.prototype.hasOwnProperty.call(next, "_id")) {
    delete next._id;
  }

  if (options.kind === "elasticsearch" && Object.prototype.hasOwnProperty.call(next, "_routing")) {
    delete next._routing;
  }

  return next;
}

export function documentStoreIdsEqual(left: unknown, right: unknown, kind: DocumentStoreKind): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  try {
    return serializeDocumentStoreId(left, kind) === serializeDocumentStoreId(right, kind);
  } catch {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }
}

/** Root identity metadata field (`_id`, and Elasticsearch `_routing`). */
export function isDocumentStoreIdentityField(kind: DocumentStoreKind, name: string): boolean {
  if (name === "_id") return true;
  return kind === "elasticsearch" && name === "_routing";
}

/** Normalize Elasticsearch custom routing for API write/delete arguments. */
export function normalizeDocumentStoreRouting(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const routing = typeof value === "string" ? value : String(value);
  const trimmed = routing.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve write routing from an edited document payload.
 * - Present `_routing` key uses the normalized value (empty/null clears routing).
 * - Absent `_routing` key keeps the current document routing.
 */
export function resolveDocumentStoreWriteRouting(nextDocument: Record<string, unknown>, currentRouting: string | undefined): string | undefined {
  if (Object.prototype.hasOwnProperty.call(nextDocument, "_routing")) {
    return normalizeDocumentStoreRouting(nextDocument._routing);
  }
  return currentRouting;
}

export type DocumentStoreIdentityCoords = {
  id: string;
  routing?: string;
};

export type DocumentStoreIdentityPlan =
  | { action: "replace"; writeId: string; writeRouting?: string }
  | {
      action: "rekey";
      writeId: string;
      writeRouting?: string;
      deleteId: string;
      deleteRouting?: string;
    };

/** True when two document identities (path id + optional ES routing) are equal. */
export function documentStoreIdentityEquals(left: DocumentStoreIdentityCoords, right: DocumentStoreIdentityCoords): boolean {
  return left.id === right.id && left.routing === right.routing;
}

/**
 * Plan how to save relative to the currently selected identity.
 * Callers must resolve path ids and routing first; this only compares string coordinates.
 *
 * Elasticsearch treats custom routing as part of identity: routing-only changes rekey
 * (write under the new routing, then delete under the old routing after a successful write).
 */
export function planDocumentStoreIdentityMigration(options: { write: DocumentStoreIdentityCoords; current: DocumentStoreIdentityCoords }): DocumentStoreIdentityPlan {
  if (documentStoreIdentityEquals(options.write, options.current)) {
    return { action: "replace", writeId: options.write.id, writeRouting: options.write.routing };
  }
  return {
    action: "rekey",
    writeId: options.write.id,
    writeRouting: options.write.routing,
    deleteId: options.current.id,
    deleteRouting: options.current.routing,
  };
}

class UnsupportedMongoJsonNumberError extends Error {
  constructor(raw: string) {
    super(`Unsupported MongoDB numeric literal: ${raw}`);
    this.name = "UnsupportedMongoJsonNumberError";
  }
}

function convertMongoJsonValue(value: unknown): unknown {
  if (isLosslessJsonNumber(value)) return convertMongoLosslessNumber(value.raw);

  if (Array.isArray(value)) return value.map((item) => convertMongoJsonValue(item));

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, convertMongoJsonValue(item)]));
  }

  return value;
}

function convertMongoLosslessNumber(raw: string): unknown {
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed)) {
    try {
      const integer = BigInt(trimmed);
      if (integer > MAX_SAFE_BIGINT || integer < -MAX_SAFE_BIGINT) {
        if (integer >= MIN_BSON_INT64 && integer <= MAX_BSON_INT64) return { $numberLong: trimmed };
        throw new UnsupportedMongoJsonNumberError(trimmed);
      }
      return Number(trimmed);
    } catch (error) {
      if (error instanceof UnsupportedMongoJsonNumberError) throw error;
      throw new UnsupportedMongoJsonNumberError(trimmed);
    }
  }

  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : trimmed;
}

function findDuplicateJsonObjectKey(text: string): string | null {
  try {
    const scanner = new LightweightJsonScanner(text);
    return scanJsonValueForDuplicateKeys(scanner);
  } catch {
    return null;
  }
}

function scanJsonValueForDuplicateKeys(scanner: LightweightJsonScanner): string | null {
  scanner.skipWhitespace();
  const ch = scanner.peek();
  if (ch === "{") return scanJsonObjectForDuplicateKeys(scanner);
  if (ch === "[") return scanJsonArrayForDuplicateKeys(scanner);
  scanner.readPrimitive();
  return null;
}

function scanJsonObjectForDuplicateKeys(scanner: LightweightJsonScanner): string | null {
  scanner.expect("{");
  scanner.skipWhitespace();
  if (scanner.peek() === "}") {
    scanner.position += 1;
    return null;
  }

  const seen = new Set<string>();
  while (true) {
    const key = scanner.readStringValue();
    if (seen.has(key)) return key;
    seen.add(key);
    scanner.expect(":");
    const nested = scanJsonValueForDuplicateKeys(scanner);
    if (nested) return nested;
    scanner.skipWhitespace();
    const next = scanner.peek();
    if (next === ",") {
      scanner.position += 1;
      continue;
    }
    if (next === "}") {
      scanner.position += 1;
      return null;
    }
    throw new SyntaxError(`Expected ',' or '}' at position ${scanner.position}`);
  }
}

function scanJsonArrayForDuplicateKeys(scanner: LightweightJsonScanner): string | null {
  scanner.expect("[");
  scanner.skipWhitespace();
  if (scanner.peek() === "]") {
    scanner.position += 1;
    return null;
  }
  while (true) {
    const nested = scanJsonValueForDuplicateKeys(scanner);
    if (nested) return nested;
    scanner.skipWhitespace();
    const next = scanner.peek();
    if (next === ",") {
      scanner.position += 1;
      continue;
    }
    if (next === "]") {
      scanner.position += 1;
      return null;
    }
    throw new SyntaxError(`Expected ',' or ']' at position ${scanner.position}`);
  }
}

class LightweightJsonScanner {
  readonly text: string;
  position = 0;

  constructor(text: string) {
    this.text = text;
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

  readStringValue(): string {
    this.skipWhitespace();
    if (this.text[this.position] !== '"') throw new SyntaxError(`Expected string at position ${this.position}`);
    this.position += 1;
    let result = "";
    let escaped = false;
    while (this.position < this.text.length) {
      const character = this.text[this.position];
      if (escaped) {
        if (character === "u") {
          const hex = this.text.slice(this.position + 1, this.position + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError(`Invalid unicode escape at position ${this.position}`);
          result += String.fromCharCode(parseInt(hex, 16));
          this.position += 5;
        } else {
          const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          if (!(character in map)) throw new SyntaxError(`Invalid escape sequence at position ${this.position}`);
          result += map[character];
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
        return result;
      }
      if (character.charCodeAt(0) < 0x20) throw new SyntaxError(`Invalid control character in string at position ${this.position}`);
      result += character;
      this.position += 1;
    }
    throw new SyntaxError(`Unterminated string at position ${this.position}`);
  }

  readPrimitive() {
    this.skipWhitespace();
    const ch = this.peek();
    if (ch === '"') {
      this.readStringValue();
      return;
    }
    if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) {
      this.readNumberToken();
      return;
    }
    for (const keyword of ["true", "false", "null"] as const) {
      if (this.text.startsWith(keyword, this.position)) {
        this.position += keyword.length;
        return;
      }
    }
    throw new SyntaxError(`Unexpected token at position ${this.position}`);
  }

  readNumberToken() {
    const start = this.position;
    if (this.text[this.position] === "-") this.position += 1;
    if (this.text[this.position] === "0") this.position += 1;
    else if (this.isDigit(this.text[this.position])) {
      while (this.isDigit(this.text[this.position])) this.position += 1;
    } else throw new SyntaxError(`Invalid number at position ${start}`);
    if (this.text[this.position] === ".") {
      this.position += 1;
      if (!this.isDigit(this.text[this.position])) throw new SyntaxError(`Invalid number at position ${start}`);
      while (this.isDigit(this.text[this.position])) this.position += 1;
    }
    if (this.text[this.position] === "e" || this.text[this.position] === "E") {
      this.position += 1;
      if (this.text[this.position] === "+" || this.text[this.position] === "-") this.position += 1;
      if (!this.isDigit(this.text[this.position])) throw new SyntaxError(`Invalid number at position ${start}`);
      while (this.isDigit(this.text[this.position])) this.position += 1;
    }
  }

  private isDigit(character: string | undefined): boolean {
    return character !== undefined && character >= "0" && character <= "9";
  }
}
