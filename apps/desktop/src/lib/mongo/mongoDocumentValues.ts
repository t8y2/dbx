import type { CellValue } from "@/lib/dataGrid/cellValue";
import { applyColumnFormatter, type ColumnFormatterConfig } from "@/lib/dataGrid/columnFormatter";

export type MongoInputValue = string | number | boolean | null;

const MONGO_SHELL_DATE_PATTERN = /^(?:ISODate|new Date)\(\s*(["'])(.+)\1\s*\)$/;
const MONGO_SHELL_NUMBER_LONG_PATTERN = /^NumberLong\(\s*(["'])(-?\d+)\1\s*\)$/;
const MONGO_OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/;
const MONGO_INTEGER_PATTERN = /^-?\d+$/;
// These values are internal to the MongoDB collection grid. BSON strings may
// contain any UTF-8 text, so strings in this reserved namespace are escaped
// before entering the grid and restored before being saved.
const MONGO_DOCUMENT_GRID_PREFIX = "\u0000dbx:mongo-document-grid:";
const MONGO_DOCUMENT_GRID_ESCAPED_STRING_PREFIX = `${MONGO_DOCUMENT_GRID_PREFIX}string:`;
const MONGO_DOCUMENT_GRID_JSON_PREFIX = `${MONGO_DOCUMENT_GRID_PREFIX}json:`;
export const MONGO_DOCUMENT_GRID_NULL = `${MONGO_DOCUMENT_GRID_PREFIX}null`;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_BSON_INT64 = -9223372036854775808n;
const MAX_BSON_INT64 = 9223372036854775807n;
/** Extended JSON wrapper key -> the BSON scalar it stands for. */
const MONGO_EXTENDED_JSON_VALUE_TYPES = new Map([
  ["$binary", "binary"],
  ["$code", "javascript"],
  ["$date", "date"],
  ["$dbPointer", "dbPointer"],
  ["$maxKey", "maxKey"],
  ["$minKey", "minKey"],
  ["$numberDecimal", "decimal128"],
  ["$numberDouble", "double"],
  ["$numberInt", "int32"],
  ["$numberLong", "int64"],
  ["$oid", "objectId"],
  ["$regularExpression", "regex"],
  ["$symbol", "symbol"],
  ["$timestamp", "timestamp"],
  ["$undefined", "undefined"],
  ["$uuid", "uuid"],
]);
const MONGO_EXTENDED_JSON_VALUE_KEYS = new Set(MONGO_EXTENDED_JSON_VALUE_TYPES.keys());

/**
 * The BSON scalar an extended JSON wrapper stands for, or undefined when the value is
 * a plain object. `{$oid: "..."}` is how the driver ships an ObjectId over JSON; it is
 * one value, not a subdocument with a `$oid` field.
 */
export function mongoExtendedJsonValueType(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 2 && keys.includes("$code") && keys.includes("$scope")) return "javascript";
  return keys.length === 1 ? MONGO_EXTENDED_JSON_VALUE_TYPES.get(keys[0] ?? "") : undefined;
}
const MONGO_EXTENDED_JSON_NUMERIC_TYPES = new Map([
  ["$numberInt", "int32"],
  ["$numberLong", "int64"],
  ["$numberDouble", "double"],
  ["$numberDecimal", "decimal128"],
] as const);

function mongoDocumentNumericValueType(value: unknown): string | undefined {
  if (typeof value === "number") return "number";
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== 1) return undefined;
  const key = keys[0] as "$numberInt" | "$numberLong" | "$numberDouble" | "$numberDecimal";
  return typeof object[key] === "string" ? MONGO_EXTENDED_JSON_NUMERIC_TYPES.get(key) : undefined;
}

type MongoDateTimeFormatter = Extract<ColumnFormatterConfig, { kind: "datetime" }>;

function mongoExtendedJsonDateValue(value: unknown): string | number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 1 || !("$date" in object)) return undefined;
  const date = object.$date;
  if (typeof date === "string" || typeof date === "number") return date;
  if (!date || typeof date !== "object" || Array.isArray(date)) return undefined;
  const canonical = date as Record<string, unknown>;
  return Object.keys(canonical).length === 1 && typeof canonical.$numberLong === "string" ? canonical.$numberLong : undefined;
}

export function mongoDocumentGridColumnTypes(documents: readonly Record<string, unknown>[], columns: readonly string[]): string[] {
  return columns.map((column) => {
    let inferredType: string | undefined;
    for (const document of documents) {
      const value = document[column];
      if (value === undefined || value === null) continue;
      if (mongoExtendedJsonDateValue(value) !== undefined) {
        if (inferredType && inferredType !== "datetime") return "";
        inferredType = "datetime";
        continue;
      }
      const numericType = mongoDocumentNumericValueType(value);
      if (!numericType || inferredType === "datetime") return "";
      inferredType = inferredType && inferredType !== numericType ? "number" : numericType;
    }
    return inferredType ?? "";
  });
}

export function mongoShellDateToExtendedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = value.trim().match(MONGO_SHELL_DATE_PATTERN);
  if (!match) return value;
  return { $date: normalizeMongoDateInput(match[2] ?? "") ?? match[2] };
}

/** `2025-04-01 19:46:03`, `2025/04/01`, `2025-04-01T19:46` … : a date with no zone, as people read one off a screen. */
const MONGO_LOCAL_DATE_PATTERN = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/;
/** The one spelling the server's `$date` parser accepts, kept as written. */
const MONGO_RFC3339_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Turns the date text a person types into the RFC 3339 string `$date` requires.
 *
 * The server accepts nothing else, but people paste what they see: a grid cell
 * shows `2025-04-01 19:46:03`, a log line `2025-04-01`. Those name no zone, so
 * they are read as local time, the way the person reads them, and sent as UTC.
 * Text that already spells RFC 3339 is kept as written; any other spelling the
 * platform can parse is canonicalised. Returns null when the text is no date.
 */
export function normalizeMongoDateInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (MONGO_RFC3339_DATE_PATTERN.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) return trimmed;

  const local = MONGO_LOCAL_DATE_PATTERN.exec(trimmed);
  if (local) {
    const [, year = "", month = "", day = "", hour = "0", minute = "0", second = "0", fraction = "0"] = local;
    const parts = [Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second), Number(fraction.padEnd(3, "0"))] as const;
    const date = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5], parts[6]);
    // `new Date(2025, 1, 30)` rolls over into March; a day that does not exist is a typo, not a date.
    const exists = date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 && date.getDate() === parts[2];
    if (!exists || parts[3] > 23 || parts[4] > 59 || parts[5] > 59) return null;
    return date.toISOString();
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export function parseMongoDocumentInputValue(raw: MongoInputValue): unknown {
  if (raw === null || typeof raw === "number" || typeof raw === "boolean") return raw;

  const trimmed = raw.trim();
  if (trimmed === "NULL") return null;
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (/^null$/i.test(trimmed)) return null;

  const shellDate = mongoShellDateToExtendedJson(trimmed);
  if (shellDate !== trimmed) return shellDate;
  const shellNumberLong = mongoShellNumberLongToExtendedJson(trimmed);
  if (shellNumberLong !== trimmed) return shellNumberLong;

  if (MONGO_INTEGER_PATTERN.test(trimmed)) {
    const integer = BigInt(trimmed);
    if (integer > MAX_SAFE_BIGINT || integer < -MAX_SAFE_BIGINT) {
      return integer >= MIN_BSON_INT64 && integer <= MAX_BSON_INT64 ? { $numberLong: trimmed } : trimmed;
    }
    return Number(trimmed);
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
    try {
      return mongoShellDateToExtendedJson(JSON.parse(trimmed));
    } catch {
      // JSON-shaped text is still valid user data when it is not valid JSON.
      return raw;
    }
  }
  return raw;
}

export function mongoDocumentDisplayValue(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && typeof object.$numberLong === "string") return `NumberLong(${JSON.stringify(object.$numberLong)})`;
  }
  return value;
}

/**
 * Strings that are already shell-style BSON display literals. The driver ships
 * dates as `ISODate("…")` text and the grid renders other typed scalars the same
 * way, so inside arrays and subdocuments they must stay verbatim instead of
 * being re-quoted (which produced the escaped `ISODate(\"…\")` mess).
 */
const MONGO_SHELL_DISPLAY_LITERAL_PATTERN = /^(?:ISODate|new Date|ObjectId|NumberLong|NumberInt|NumberDouble|NumberDecimal)\(\s*(["']).+\1\s*\)$/;

/**
 * Renders a browser/extended-JSON BSON value the way mongosh prints it, so an
 * array cell reads `[ObjectId("…"), ISODate("…")]` instead of the internal
 * `[{"$oid":"…"},"ISODate(\\\"…\\\")"]` encoding. Display-only: edit, copy and
 * save paths keep the original JSON representation untouched.
 */
export function mongoDocumentDisplayText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return MONGO_SHELL_DISPLAY_LITERAL_PATTERN.test(value) ? value : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => mongoDocumentDisplayText(item)).join(", ")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const wrapper = mongoShellWrapperDisplayText(object);
    if (wrapper !== undefined) return wrapper;
    return `{${Object.entries(object)
      .map(([key, item]) => `${JSON.stringify(key)}: ${mongoDocumentDisplayText(item)}`)
      .join(", ")}}`;
  }
  return JSON.stringify(String(value));
}

function mongoShellWrapperDisplayText(object: Record<string, unknown>): string | undefined {
  const keys = Object.keys(object);
  if (keys.length !== 1) return undefined;
  const inner = object[keys[0] ?? ""];
  switch (keys[0]) {
    case "$oid":
      return typeof inner === "string" ? `ObjectId(${JSON.stringify(inner)})` : undefined;
    case "$numberLong":
      return typeof inner === "string" ? `NumberLong(${JSON.stringify(inner)})` : undefined;
    case "$numberInt":
      return typeof inner === "string" ? `NumberInt(${JSON.stringify(inner)})` : undefined;
    case "$numberDouble":
      return typeof inner === "string" ? `NumberDouble(${JSON.stringify(inner)})` : undefined;
    case "$numberDecimal":
      return typeof inner === "string" ? `NumberDecimal(${JSON.stringify(inner)})` : undefined;
    case "$date":
      return mongoShellDateWrapperDisplayText(inner);
    case "$minKey":
      return "MinKey()";
    case "$maxKey":
      return "MaxKey()";
    default:
      return undefined;
  }
}

function mongoShellDateWrapperDisplayText(inner: unknown): string | undefined {
  if (typeof inner === "string") return `ISODate(${JSON.stringify(inner)})`;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const long = (inner as Record<string, unknown>).$numberLong;
    if (typeof long === "string" && /^-?\d+$/.test(long)) {
      const millis = Number(long);
      // Dates beyond the JS Date range cannot round-trip through toISOString();
      // fall back to the raw wrapper instead of throwing past the grid formatter.
      if (Number.isFinite(millis) && Math.abs(millis) <= 8.64e15) {
        return `ISODate(${JSON.stringify(new Date(millis).toISOString())})`;
      }
    }
  }
  return undefined;
}

/**
 * Relaxed Extended JSON for read-only document previews: the browser form keeps
 * dates as `ISODate("…")` strings, and the preview must show them as
 * `{"$date": "…"}` like MongoDB Compass instead of escaped shell text.
 */
export function mongoDocumentRelaxedExtendedJson(value: unknown): unknown {
  const date = mongoShellDateToExtendedJson(value);
  if (date !== value) return date;
  if (Array.isArray(value)) return value.map((item) => mongoDocumentRelaxedExtendedJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, mongoDocumentRelaxedExtendedJson(item)]));
  }
  return value;
}

/**
 * Maps BSON values into the flat collection-grid representation.  The grid
 * needs an internal sentinel for an explicit BSON null because an empty cell
 * represents a field that does not exist. The grid formatter renders that
 * sentinel as NULL, while a literal "NULL" remains ordinary string data.
 */
export function mongoDocumentGridValue(value: unknown): unknown {
  if (value === null) return MONGO_DOCUMENT_GRID_NULL;
  if (typeof value === "string" && value.startsWith(MONGO_DOCUMENT_GRID_PREFIX)) return `${MONGO_DOCUMENT_GRID_ESCAPED_STRING_PREFIX}${value}`;
  const displayValue = mongoDocumentDisplayValue(value);
  return displayValue && typeof displayValue === "object" ? `${MONGO_DOCUMENT_GRID_JSON_PREFIX}${JSON.stringify(displayValue)}` : displayValue;
}

function mongoDocumentGridEscapedString(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith(MONGO_DOCUMENT_GRID_ESCAPED_STRING_PREFIX) ? value.slice(MONGO_DOCUMENT_GRID_ESCAPED_STRING_PREFIX.length) : undefined;
}

function mongoDocumentGridJson(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith(MONGO_DOCUMENT_GRID_JSON_PREFIX) ? value.slice(MONGO_DOCUMENT_GRID_JSON_PREFIX.length) : undefined;
}

/** Returns the text presented in a collection-grid editor, when customized. */
export function mongoDocumentGridEditorText(value: unknown): string | undefined {
  // An existing BSON null is represented as NULL in the grid, but editing it
  // starts with an empty input. The private marker must never be user-facing.
  if (value === MONGO_DOCUMENT_GRID_NULL) return "";
  const json = mongoDocumentGridJson(value);
  if (json !== undefined) return json;
  return mongoDocumentGridEscapedString(value);
}

/** Returns the text used when copying a collection-grid cell. */
export function mongoDocumentGridClipboardText(value: unknown): string | undefined {
  if (value === MONGO_DOCUMENT_GRID_NULL) return "NULL";
  return mongoDocumentGridEditorText(value);
}

/** Returns the custom display text required by collection-grid BSON values. */
export function mongoDocumentGridDisplayText(value: unknown, formatter?: ColumnFormatterConfig): string | undefined {
  if (value === MONGO_DOCUMENT_GRID_NULL) return "NULL";
  const escapedString = mongoDocumentGridEscapedString(value);
  if (escapedString !== undefined) return JSON.stringify(escapedString);
  const json = mongoDocumentGridJson(value);
  if (json !== undefined) return formatMongoDocumentGridJson(json, formatter);
  return value === "NULL" ? JSON.stringify(value) : undefined;
}

function formatMongoDocumentGridJson(json: string, formatter: ColumnFormatterConfig | undefined): string {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return json;
  }
  if (formatter?.kind === "datetime" && validMongoDisplayTimeZone(formatter.timezone)) {
    const transformed = formatMongoDocumentDates(value, formatter);
    if (transformed.changed) return typeof transformed.value === "string" ? transformed.value : mongoDocumentDisplayText(transformed.value);
  }
  // Shell-style structure text keeps BSON types inside arrays/subdocuments
  // readable (`[ObjectId("…"), ISODate("…")]`) instead of raw JSON wrappers.
  return mongoDocumentDisplayText(value);
}

function validMongoDisplayTimeZone(timeZone: string | undefined): boolean {
  if (!timeZone) return true;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function formatMongoDocumentDates(value: unknown, formatter: MongoDateTimeFormatter): { value: unknown; changed: boolean } {
  const date = mongoExtendedJsonDateValue(value);
  if (date !== undefined) return { value: applyColumnFormatter(date, formatter), changed: true };
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const transformed = formatMongoDocumentDates(item, formatter);
      changed ||= transformed.changed;
      return transformed.value;
    });
    return { value: changed ? items : value, changed };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  let changed = false;
  const object = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const transformed = formatMongoDocumentDates(item, formatter);
      changed ||= transformed.changed;
      return [key, transformed.value];
    }),
  );
  return { value: changed ? object : value, changed };
}

/** Restores a collection-grid value before it leaves the grid externally. */
export function mongoDocumentGridExternalValue(value: CellValue): CellValue {
  if (value === MONGO_DOCUMENT_GRID_NULL) return null;
  const json = mongoDocumentGridJson(value);
  if (json !== undefined) return json;
  const escapedString = mongoDocumentGridEscapedString(value);
  return escapedString === undefined ? value : escapedString;
}

/** Preserves encoded grid clipboard values and escapes other reserved input. */
export function mongoDocumentGridInputValue(value: string): string {
  // Internal copy/paste already carries encoded values; escaping again would
  // save BSON null as a literal sentinel string.
  if (value === MONGO_DOCUMENT_GRID_NULL || value.startsWith(MONGO_DOCUMENT_GRID_ESCAPED_STRING_PREFIX)) return value;
  return value.startsWith(MONGO_DOCUMENT_GRID_PREFIX) ? `${MONGO_DOCUMENT_GRID_ESCAPED_STRING_PREFIX}${value}` : value;
}

function parseMongoExistingFieldInputValue(raw: Exclude<MongoInputValue, null>, originalValue: unknown): unknown {
  // Objects and arrays are serialized into grid text too, so the raw document
  // is the only reliable way to distinguish them from JSON-shaped BSON strings.
  // The collection grid's private sentinel represents an explicit BSON null.
  // A literal "NULL" remains a normal string, including in Mongo query results.
  if (raw === MONGO_DOCUMENT_GRID_NULL) return null;
  const escapedString = mongoDocumentGridEscapedString(raw);
  if (escapedString !== undefined) return escapedString;
  if (typeof originalValue === "string") {
    return typeof raw === "string" ? raw : String(raw);
  }
  return parseMongoDocumentInputValue(raw);
}

function mongoDocumentFieldValue(document: unknown, field: string): unknown {
  if (!document || typeof document !== "object" || Array.isArray(document)) return undefined;
  return (document as Record<string, unknown>)[field];
}

function mongoShellNumberLongToExtendedJson(value: string): unknown {
  const match = value.match(MONGO_SHELL_NUMBER_LONG_PATTERN);
  return match ? { $numberLong: match[2] } : value;
}

/**
 * `NumberLong("-7")`, `NumberInt(3)`, `NumberDouble("1.5")`, `NumberDecimal("-12.5")`
 * — the shell-style display text the collection grid renders typed BSON scalars with.
 */
const MONGO_SHELL_NUMBER_LITERAL_PATTERN = /^(?:NumberLong|NumberInt|NumberDouble|NumberDecimal)\(\s*(?:"([^"]*)"|'([^']*)'|([^()]*))\s*\)$/;
const MONGO_NUMERIC_WRAPPER_KEYS: ReadonlySet<string> = new Set<string>(MONGO_EXTENDED_JSON_NUMERIC_TYPES.keys());

function mongoNumericText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function mongoShellNumericText(text: string): number | undefined {
  const literal = MONGO_SHELL_NUMBER_LITERAL_PATTERN.exec(text.trim());
  if (!literal) return mongoNumericText(text);
  return mongoNumericText(literal[1] ?? literal[2] ?? literal[3] ?? "");
}

function mongoJsonNumericValue(json: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed === "number") return Number.isFinite(parsed) ? parsed : undefined;
  if (typeof parsed === "string") return mongoShellNumericText(parsed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length !== 1) return undefined;
  const [key, inner] = entries[0]!;
  if (!MONGO_NUMERIC_WRAPPER_KEYS.has(key)) return undefined;
  if (typeof inner === "number") return Number.isFinite(inner) ? inner : undefined;
  return typeof inner === "string" ? mongoNumericText(inner) : undefined;
}

/**
 * The number a collection-grid cell contributes to a selection total, or
 * undefined when it is not a number.
 *
 * BSON keeps numeric types the JSON grid cannot express: `int32` / `int64` /
 * `decimal128` values arrive as extended-JSON wrappers or shell literals
 * (`NumberLong("-7")`), so plain `Number(...)` coercion rejects them. Without
 * this, a column whose plain doubles are counted while its wrapped values are
 * skipped reports a total built from only part of the column — the dropped part
 * being whichever type the rest of the column happens not to use, commonly the
 * negative entries.
 *
 * Shell literals are read exactly as the grid displays them, so a BSON string
 * whose text happens to be `NumberLong("-7")` contributes -7; that string is
 * indistinguishable from a typed Int64 once it reaches a cell.
 */
export function mongoDocumentGridNumericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  if (value === MONGO_DOCUMENT_GRID_NULL) return undefined;
  // Values in the reserved namespace are escaped BSON strings: only plain
  // numeric text counts, never a shell literal that was stored as text.
  const escaped = mongoDocumentGridEscapedString(value);
  if (escaped !== undefined) return mongoNumericText(escaped);
  const json = mongoDocumentGridJson(value);
  if (json !== undefined) return mongoJsonNumericValue(json);
  return mongoShellNumericText(value);
}

export function buildMongoUpdateDocument(changes: Map<number, MongoInputValue>, columns: string[], originalDocument?: unknown): Record<string, unknown> {
  const setFields: Record<string, unknown> = {};
  const unsetFields: Record<string, unknown> = {};
  for (const [colIdx, newVal] of changes) {
    const col = columns[colIdx];
    if (!col || col === "_id") continue;
    if (newVal === null) {
      unsetFields[col] = "";
    } else {
      setFields[col] = parseMongoExistingFieldInputValue(newVal, mongoDocumentFieldValue(originalDocument, col));
    }
  }
  const doc: Record<string, unknown> = {};
  if (Object.keys(setFields).length > 0) doc.$set = setFields;
  if (Object.keys(unsetFields).length > 0) doc.$unset = unsetFields;
  return doc;
}

export function buildMongoCopyUpdateDocument(row: MongoInputValue[], columns: string[], dirtyColumns: boolean[], originalDocument?: unknown, idColumn = "_id"): Record<string, unknown> | null {
  if (!originalDocument || typeof originalDocument !== "object" || Array.isArray(originalDocument)) return null;

  const source = originalDocument as Record<string, unknown>;
  const setFields: Record<string, unknown> = {};
  const unsetFields: Record<string, unknown> = {};
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
    const column = columns[columnIndex];
    if (!column || column === idColumn) continue;

    const value = row[columnIndex] ?? null;
    if (dirtyColumns[columnIndex]) {
      if (value === null) {
        unsetFields[column] = "";
      } else {
        setFields[column] = parseMongoExistingFieldInputValue(value, source[column]);
      }
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(source, column)) {
      setFields[column] = source[column];
    } else {
      unsetFields[column] = "";
    }
  }

  const update: Record<string, unknown> = {};
  if (Object.keys(setFields).length > 0) update.$set = setFields;
  if (Object.keys(unsetFields).length > 0) update.$unset = unsetFields;
  return Object.keys(update).length > 0 ? update : null;
}

export function applyMongoGridChangesToDocument(document: unknown, changes: Map<number, MongoInputValue>, columns: string[]): unknown {
  if (!document || typeof document !== "object" || Array.isArray(document)) return document;

  const updated = { ...(document as Record<string, unknown>) };
  for (const [colIdx, newVal] of changes) {
    const column = columns[colIdx];
    if (!column || column === "_id") continue;
    if (newVal === null) {
      delete updated[column];
    } else {
      updated[column] = parseMongoExistingFieldInputValue(newVal, updated[column]);
    }
  }
  return updated;
}

function mongoDocumentIdentityKey(document: unknown): string | undefined {
  if (!document || typeof document !== "object" || Array.isArray(document)) return undefined;
  const object = document as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(object, "_id")) return undefined;
  return JSON.stringify(object._id);
}

export function applyMongoGridChangesToDocumentBaseline(baselineDocuments: unknown[], currentDocuments: unknown[], dirtyRows: Map<number, Map<number, MongoInputValue>>, columns: string[]): unknown[] {
  const changesByDocumentId = new Map<string, Map<number, MongoInputValue>>();
  for (const [rowIndex, changes] of dirtyRows) {
    const identityKey = mongoDocumentIdentityKey(currentDocuments[rowIndex]);
    if (identityKey !== undefined) changesByDocumentId.set(identityKey, changes);
  }
  return baselineDocuments.map((document) => {
    const identityKey = mongoDocumentIdentityKey(document);
    const changes = identityKey === undefined ? undefined : changesByDocumentId.get(identityKey);
    return changes ? applyMongoGridChangesToDocument(document, changes, columns) : document;
  });
}

export function buildMongoInsertDocument(row: MongoInputValue[], columns: string[]): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci];
    if (!col || col === "_id") continue;
    const val = row[ci];
    if (val === null) continue;
    doc[col] = val === MONGO_DOCUMENT_GRID_NULL ? null : (mongoDocumentGridEscapedString(val) ?? parseMongoDocumentInputValue(val));
  }
  return doc;
}

export function buildMongoCopyInsertDocument(row: MongoInputValue[], columns: string[], options: { excludePrimaryKeys?: boolean } = {}): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci];
    if (!col || (options.excludePrimaryKeys && col === "_id")) continue;
    const val = row[ci];
    if (val === null) continue;
    if (col === "_id" && typeof val === "string" && MONGO_OBJECT_ID_PATTERN.test(val)) {
      doc[col] = { $oid: val };
      continue;
    }
    doc[col] = val === MONGO_DOCUMENT_GRID_NULL ? null : (mongoDocumentGridEscapedString(val) ?? parseMongoDocumentInputValue(val));
  }
  return doc;
}

export function buildMongoCopyDocumentFromOriginal(original: unknown, row: MongoInputValue[], columns: string[], dirtyColumns: boolean[], options: { excludePrimaryKeys?: boolean } = {}): Record<string, unknown> | null {
  if (!original || typeof original !== "object" || Array.isArray(original)) return null;

  const source = original as Record<string, unknown>;
  const document: Record<string, unknown> = {};
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
    const column = columns[columnIndex];
    if (!column || (options.excludePrimaryKeys && column === "_id")) continue;

    // Display strings are ambiguous, so only explicitly edited cells may replace original BSON values.
    if (dirtyColumns[columnIndex]) {
      const value = row[columnIndex];
      if (value !== null) {
        document[column] = value === MONGO_DOCUMENT_GRID_NULL ? null : (mongoDocumentGridEscapedString(value) ?? parseMongoDocumentInputValue(value));
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(source, column)) document[column] = source[column];
  }
  return document;
}

export function formatMongoShellLiteral(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(formatMongoShellLiteral).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (keys.length === 1 && typeof object.$date === "string") {
      return `ISODate(${JSON.stringify(object.$date)})`;
    }
    if (keys.length === 1 && typeof object.$oid === "string" && MONGO_OBJECT_ID_PATTERN.test(object.$oid)) {
      return `ObjectId(${JSON.stringify(object.$oid)})`;
    }
    if (keys.length === 1 && typeof object.$numberLong === "string") {
      return `NumberLong(${JSON.stringify(object.$numberLong)})`;
    }
    if ((keys.length === 1 && MONGO_EXTENDED_JSON_VALUE_KEYS.has(keys[0] ?? "")) || (keys.length === 2 && keys.includes("$code") && keys.includes("$scope"))) {
      return `EJSON.deserialize(${JSON.stringify(object)})`;
    }
    return `{${keys.map((key) => `${JSON.stringify(key)}:${formatMongoShellLiteral(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function serializeMongoDocumentId(value: unknown): string {
  if (typeof value === "string") return `__dbx_mongo_string_id__${JSON.stringify(value)}`;
  // An extended-JSON wrapper ($date/$numberInt/…), an array or a compound subdocument id must be
  // JSON-encoded so the backend can decode it; `String(value)` would yield "[object Object]" and
  // the update/delete would silently match nothing.
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function mongoDocumentIdForGrid(value: unknown): MongoInputValue {
  if (isMongoExtendedJsonId(value)) return String(value.$numberLong ?? value.$oid);
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

/** A single typed scalar wrapper (`{$oid}` / `{$numberLong}`) the grid shows compactly. */
export function isMongoExtendedJsonId(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  return keys.length === 1 && (typeof object.$numberLong === "string" || typeof object.$oid === "string");
}
