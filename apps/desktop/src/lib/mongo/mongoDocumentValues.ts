export type MongoInputValue = string | number | boolean | null;

const MONGO_SHELL_DATE_PATTERN = /^(?:ISODate|new Date)\(\s*(["'])(.+)\1\s*\)$/;
const MONGO_SHELL_NUMBER_LONG_PATTERN = /^NumberLong\(\s*(["'])(-?\d+)\1\s*\)$/;
const MONGO_OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/;
const MONGO_INTEGER_PATTERN = /^-?\d+$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_BSON_INT64 = -9223372036854775808n;
const MAX_BSON_INT64 = 9223372036854775807n;

export function mongoShellDateToExtendedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = value.trim().match(MONGO_SHELL_DATE_PATTERN);
  if (!match) return value;
  return { $date: match[2] };
}

export function parseMongoDocumentInputValue(raw: MongoInputValue): unknown {
  if (raw === null || typeof raw === "number" || typeof raw === "boolean") return raw;

  const trimmed = raw.trim();
  if (trimmed === "NULL") return null;
  if (/^(true|false|null)$/i.test(trimmed)) return JSON.parse(trimmed.toLowerCase());

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
    return mongoShellDateToExtendedJson(JSON.parse(trimmed));
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

function parseMongoExistingFieldInputValue(raw: Exclude<MongoInputValue, null>, originalValue: unknown): unknown {
  // Objects and arrays are serialized into grid text too, so the raw document
  // is the only reliable way to distinguish them from JSON-shaped BSON strings.
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

export function buildMongoInsertDocument(row: MongoInputValue[], columns: string[]): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci];
    if (!col || col === "_id") continue;
    const val = row[ci];
    if (val === null) continue;
    doc[col] = parseMongoDocumentInputValue(val);
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
    doc[col] = parseMongoDocumentInputValue(val);
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
      if (value !== null) document[column] = parseMongoDocumentInputValue(value);
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
    return `{${keys.map((key) => `${JSON.stringify(key)}:${formatMongoShellLiteral(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function serializeMongoDocumentId(value: unknown): string {
  if (typeof value === "string") return `__dbx_mongo_string_id__${JSON.stringify(value)}`;
  if (isMongoExtendedJsonId(value)) return JSON.stringify(value);
  return String(value);
}

export function mongoDocumentIdForGrid(value: unknown): MongoInputValue {
  if (isMongoExtendedJsonId(value)) return String(value.$numberLong ?? value.$oid);
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function isMongoExtendedJsonId(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  return keys.length === 1 && (typeof object.$numberLong === "string" || typeof object.$oid === "string");
}
