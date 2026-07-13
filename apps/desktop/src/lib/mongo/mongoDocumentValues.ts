export type MongoInputValue = string | number | boolean | null;

const MONGO_SHELL_DATE_PATTERN = /^(?:ISODate|new Date)\(\s*(["'])(.+)\1\s*\)$/;
const LEGACY_MONGO_DATE_DISPLAY_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/;
const MONGO_OBJECT_ID_PATTERN = /^[a-fA-F0-9]{24}$/;

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

  const legacyDate = legacyMongoDateDisplayToExtendedJson(trimmed);
  if (legacyDate) return legacyDate;

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
    return mongoShellDateToExtendedJson(JSON.parse(trimmed));
  }
  return raw;
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

function legacyMongoDateDisplayToExtendedJson(value: string): { $date: string } | null {
  const match = value.match(LEGACY_MONGO_DATE_DISPLAY_PATTERN);
  if (!match) return null;
  const [, date, time, millis = "000"] = match;
  return { $date: `${date}T${time}.${millis.padEnd(3, "0")}Z` };
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
