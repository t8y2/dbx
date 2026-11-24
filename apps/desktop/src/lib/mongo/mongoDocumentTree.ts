import { formatMongoShellLiteral, mongoExtendedJsonValueType } from "@/lib/mongo/mongoDocumentValues";

/**
 * Helpers behind the NoSQLBooster-style MongoDB views: the Tree view
 * (Key | Value | Type rows that drill into subdocuments and arrays) and the
 * Table view's expandable / flattened nested-field columns.
 *
 * Every helper works on the documents the collection browser already holds
 * (canonical extended JSON when available, the browser form otherwise), so no
 * extra query is needed and BSON wrappers such as `{$oid}` / `{$date}` stay one
 * scalar value instead of being mistaken for subdocuments.
 */

export type MongoFieldPath = readonly (string | number)[];

/** A top-level or nested grid column: `name` is the dot path shown in the header. */
export interface MongoFlatColumn {
  name: string;
  path: readonly string[];
}

export interface MongoFlatColumnOptions {
  /** Dot-path column names the user expanded into sub-columns. */
  expanded?: ReadonlySet<string> | readonly string[];
  /** Expand every subdocument (not arrays) into dot-path columns. */
  flattenAll?: boolean;
  /** Deepest nesting level flattened; deeper subdocuments stay one JSON cell. */
  maxDepth?: number;
  /** Hard cap on produced columns so a wide schema cannot freeze the grid. */
  maxColumns?: number;
}

export const MONGO_FLATTEN_DEFAULT_MAX_DEPTH = 6;
export const MONGO_FLATTEN_DEFAULT_MAX_COLUMNS = 400;

const MONGO_SHELL_LITERAL_TYPES: Array<[RegExp, string]> = [
  [/^(?:ISODate|new Date)\(/, "Date"],
  [/^(?:ObjectId|new ObjectId)\(/, "ObjectId"],
  [/^NumberLong\(/, "Int64"],
  [/^NumberInt\(/, "Int32"],
  [/^NumberDouble\(/, "Double"],
  [/^NumberDecimal\(/, "Decimal128"],
];
const MONGO_SHELL_LITERAL_PATTERN = /^(?:ISODate|new Date|ObjectId|new ObjectId|NumberLong|NumberInt|NumberDouble|NumberDecimal)\(\s*(["']).*\1\s*\)$/;

const EXTENDED_JSON_TYPE_LABELS: Record<string, string> = {
  binary: "Binary",
  javascript: "Code",
  date: "Date",
  dbPointer: "DBPointer",
  maxKey: "MaxKey",
  minKey: "MinKey",
  decimal128: "Decimal128",
  double: "Double",
  int32: "Int32",
  int64: "Int64",
  objectId: "ObjectId",
  regex: "Regex",
  symbol: "Symbol",
  timestamp: "Timestamp",
  undefined: "Undefined",
  uuid: "UUID",
};

/** True for a subdocument: a plain object that is not an extended JSON BSON scalar. */
export function isMongoSubdocument(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && mongoExtendedJsonValueType(value) === undefined;
}

/** The BSON type name shown in the Tree view's Type column. */
export function mongoValueTypeLabel(value: unknown): string {
  if (value === null) return "Null";
  if (value === undefined) return "Undefined";
  if (Array.isArray(value)) return "Array";
  if (typeof value === "boolean") return "Bool";
  if (typeof value === "number") return Number.isInteger(value) ? "Int32" : "Double";
  if (typeof value === "bigint") return "Int64";
  if (typeof value === "string") {
    if (MONGO_SHELL_LITERAL_PATTERN.test(value.trim())) {
      for (const [pattern, label] of MONGO_SHELL_LITERAL_TYPES) if (pattern.test(value.trim())) return label;
    }
    return "String";
  }
  if (typeof value === "object") {
    const ejsonType = mongoExtendedJsonValueType(value);
    if (ejsonType === "binary") {
      const subType = ((value as Record<string, unknown>).$binary as Record<string, unknown> | undefined)?.subType;
      if (subType === "04" || subType === "03") return "UUID";
    }
    if (ejsonType) return EXTENDED_JSON_TYPE_LABELS[ejsonType] ?? ejsonType;
    return "Object";
  }
  return typeof value;
}

/**
 * The text shown in the Value column: scalars the way mongosh prints them,
 * strings unquoted (as NoSQLBooster does), containers as a size summary.
 */
export function mongoValuePreviewText(value: unknown, labels: { fields: (count: number) => string; elements: (count: number) => string } = DEFAULT_PREVIEW_LABELS): string {
  if (Array.isArray(value)) return labels.elements(value.length);
  if (isMongoSubdocument(value)) return labels.fields(Object.keys(value).length);
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return value.toString();
  const scalar = mongoExtendedJsonScalarText(value);
  return scalar ?? formatMongoShellLiteral(value);
}

/**
 * `{$date: "…"}` (relaxed) and `{$date: {$numberLong: "…"}}` (canonical, what
 * query results carry) both read as `ISODate("…")`. Dates outside the JS Date
 * range fall back to the raw milliseconds instead of throwing.
 */
function mongoDateText(inner: unknown): string | undefined {
  if (typeof inner === "string") return `ISODate("${inner}")`;
  let millis: number | undefined;
  let raw: string | undefined;
  if (typeof inner === "number") millis = inner;
  else if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    const long = (inner as Record<string, unknown>).$numberLong;
    if (typeof long === "string" && /^-?\d+$/.test(long)) {
      raw = long;
      millis = Number(long);
    }
  }
  if (millis === undefined || !Number.isFinite(millis)) return undefined;
  if (Math.abs(millis) > 8.64e15) return `Date(${raw ?? millis})`;
  return `ISODate("${new Date(millis).toISOString()}")`;
}

/**
 * Numeric wrappers read as plain numbers (the Type column carries Int32 /
 * Int64 / Decimal128), the way NoSQLBooster lists them, instead of mongosh's
 * `EJSON.deserialize({...})` fallback.
 */
function mongoExtendedJsonScalarText(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== 1) return undefined;
  const inner = object[keys[0] ?? ""];
  switch (keys[0]) {
    case "$numberInt":
    case "$numberLong":
    case "$numberDouble":
    case "$numberDecimal":
      return typeof inner === "string" ? inner : undefined;
    case "$date":
      return mongoDateText(inner);
    case "$uuid":
      return typeof inner === "string" ? `UUID("${inner}")` : undefined;
    case "$timestamp": {
      const ts = inner as Record<string, unknown> | undefined;
      return ts && typeof ts.t === "number" && typeof ts.i === "number" ? `Timestamp(${ts.t}, ${ts.i})` : undefined;
    }
    case "$regularExpression": {
      const regex = inner as Record<string, unknown> | undefined;
      return regex && typeof regex.pattern === "string" ? `/${regex.pattern}/${typeof regex.options === "string" ? regex.options : ""}` : undefined;
    }
    case "$minKey":
      return "MinKey()";
    case "$maxKey":
      return "MaxKey()";
    default:
      return undefined;
  }
}

const DEFAULT_PREVIEW_LABELS = {
  fields: (count: number) => `{ ${count} ${count === 1 ? "field" : "fields"} }`,
  elements: (count: number) => `[ ${count} ${count === 1 ? "element" : "elements"} ]`,
};

// ---------------------------------------------------------------------------
// NoSQLBooster-style value display
// ---------------------------------------------------------------------------

export interface MongoValueDisplay {
  /** Main text in the Value column. */
  text: string;
  /** Secondary text shown after the value (e.g. "22 minutes ago" for an ObjectId). */
  hint?: string;
  /** Multi-line hover detail (dates: UTC / locale / ISO with offset). */
  tooltip?: string;
}

export interface MongoDisplayOptions {
  /** BCP 47 locale for dates and relative times; undefined = system locale. */
  locale?: string;
  /** Reference time for "… ago"; injectable for tests. */
  now?: number;
  /** Count suffix labels, e.g. `21 fields` / `3 elements`. */
  countLabels?: { fields: (count: number) => string; elements: (count: number) => string };
  /** Scalar fields shown inline in a document/array preview. */
  previewItems?: number;
}

const DEFAULT_COUNT_LABELS = {
  fields: (count: number) => `${count} ${count === 1 ? "field" : "fields"}`,
  elements: (count: number) => `${count} ${count === 1 ? "element" : "elements"}`,
};

/** Milliseconds since epoch for any BSON date spelling, or undefined. */
export function mongoDateMillis(value: unknown): number | undefined {
  if (typeof value === "string") {
    const match = /^(?:ISODate|new Date)\(\s*(["'])(.+)\1\s*\)$/.exec(value.trim());
    if (!match) return undefined;
    const parsed = Date.parse(match[2] ?? "");
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  if (mongoExtendedJsonValueType(value) !== "date") return undefined;
  const inner = (value as Record<string, unknown>).$date;
  let millis: number | undefined;
  if (typeof inner === "number") millis = inner;
  else if (typeof inner === "string") millis = Date.parse(inner);
  else if (inner && typeof inner === "object") {
    const long = (inner as Record<string, unknown>).$numberLong;
    if (typeof long === "string" && /^-?\d+$/.test(long)) millis = Number(long);
  }
  return millis !== undefined && Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? millis : undefined;
}

/** 24-hex ObjectId string, or undefined. */
export function mongoObjectIdHex(value: unknown): string | undefined {
  if (typeof value === "string") {
    const match = /^(?:new )?ObjectId\(\s*["']?([a-fA-F0-9]{24})["']?\s*\)$/.exec(value.trim());
    return match?.[1];
  }
  if (mongoExtendedJsonValueType(value) !== "objectId") return undefined;
  const hex = (value as Record<string, unknown>).$oid;
  return typeof hex === "string" && /^[a-fA-F0-9]{24}$/.test(hex) ? hex : undefined;
}

function dateTimeFormat(locale: string | undefined): Intl.DateTimeFormat {
  // Gregorian even for th-TH, so 2026 does not turn into the Buddhist 2569.
  return new Intl.DateTimeFormat(locale, { calendar: "gregory", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function mongoRelativeTime(millis: number, now: number, locale?: string): string {
  const seconds = Math.round((millis - now) / 1000);
  const abs = Math.abs(seconds);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  let formatter: Intl.RelativeTimeFormat;
  try {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  } catch {
    formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  }
  for (const [unit, size] of units) if (abs >= size) return formatter.format(Math.round(seconds / size), unit);
  return formatter.format(seconds, "second");
}

function isoWithOffset(millis: number): string {
  const date = new Date(millis);
  const offset = -date.getTimezoneOffset();
  const pad = (value: number, length = 2) => String(Math.abs(value)).padStart(length, "0");
  const sign = offset >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

function safeDateTimeFormat(locale: string | undefined): Intl.DateTimeFormat {
  try {
    return dateTimeFormat(locale);
  } catch {
    return dateTimeFormat("en-US");
  }
}

/** Compact one-line form used inside document/array previews. */
function inlinePreview(value: unknown, locale: string | undefined): string {
  if (typeof value === "string") {
    const millis = mongoDateMillis(value);
    if (millis !== undefined) return safeDateTimeFormat(locale).format(millis);
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  }
  const hex = mongoObjectIdHex(value);
  if (hex) return hex;
  const millis = mongoDateMillis(value);
  if (millis !== undefined) return safeDateTimeFormat(locale).format(millis);
  if (Array.isArray(value)) return value.length ? "[…]" : "[]";
  if (isMongoSubdocument(value)) return Object.keys(value).length ? "{…}" : "{}";
  return mongoValuePreviewText(value);
}

/**
 * What the Tree view shows for a value, modelled on NoSQLBooster: dates in
 * local time with "… ago", ObjectIds as hex with their creation age, and
 * documents / arrays as an inline preview of their first scalar entries.
 */
export function mongoValueDisplay(value: unknown, options: MongoDisplayOptions = {}): MongoValueDisplay {
  const locale = options.locale;
  const now = options.now ?? Date.now();
  const labels = options.countLabels ?? DEFAULT_COUNT_LABELS;
  const previewItems = options.previewItems ?? 3;

  const millis = mongoDateMillis(value);
  if (millis !== undefined) {
    const local = safeDateTimeFormat(locale).format(millis);
    const relative = mongoRelativeTime(millis, now, locale);
    return {
      text: `${local} - ${relative}`,
      tooltip: `${local} - ${relative}\n\nUTC: ${new Date(millis).toISOString()}\nLocale: ${local}\nISO: ${isoWithOffset(millis)}`,
    };
  }

  const hex = mongoObjectIdHex(value);
  if (hex) {
    const created = parseInt(hex.slice(0, 8), 16) * 1000;
    return { text: hex, hint: mongoRelativeTime(created, now, locale), tooltip: `ObjectId("${hex}")\n${safeDateTimeFormat(locale).format(created)} (UTC ${new Date(created).toISOString()})` };
  }

  if (Array.isArray(value)) {
    const shown = value.slice(0, previewItems).map((item) => inlinePreview(item, locale));
    const more = value.length > previewItems ? ", …" : "";
    return { text: `[ ${shown.join(", ")}${more} ] (${labels.elements(value.length)})` };
  }

  if (isMongoSubdocument(value)) {
    const entries = Object.entries(value);
    const scalars = entries.filter(([key, item]) => key !== "_id" && !Array.isArray(item) && !isMongoSubdocument(item));
    const picked = (scalars.length ? scalars : entries).slice(0, previewItems);
    const body = picked.map(([key, item]) => `${key} : ${inlinePreview(item, locale)}`).join(", ");
    return { text: `{ ${body}${entries.length > picked.length ? ", …" : ""} } (${labels.fields(entries.length)})` };
  }

  return { text: mongoValuePreviewText(value) };
}

export function isMongoContainer(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : isMongoSubdocument(value) && Object.keys(value).length > 0;
}

/** Reads a nested value; a missing step (or a step through a scalar) yields undefined. */
export function getMongoPathValue(document: unknown, path: MongoFieldPath): unknown {
  let current: unknown = document;
  for (const step of path) {
    if (Array.isArray(current)) {
      if (typeof step !== "number") return undefined;
      current = current[step];
    } else if (isMongoSubdocument(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, String(step))) return undefined;
      current = current[String(step)];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Dot path for display and for Mongo sort/filter keys (`items.0.sku`). */
export function mongoPathToDotted(path: MongoFieldPath): string {
  return path.map(String).join(".");
}

/**
 * Builds the grid's column list. Expanded columns are replaced by their child
 * fields (in first-seen order across documents); a column whose value is a
 * scalar in some documents and a subdocument in others keeps the parent column
 * too, so no value disappears from the grid.
 */
export function buildMongoFlatColumns(documents: readonly Record<string, unknown>[], baseColumns: readonly string[], options: MongoFlatColumnOptions = {}): MongoFlatColumn[] {
  const expanded = new Set(options.expanded ?? []);
  const flattenAll = options.flattenAll === true;
  const maxDepth = Math.max(1, options.maxDepth ?? MONGO_FLATTEN_DEFAULT_MAX_DEPTH);
  const maxColumns = Math.max(baseColumns.length, options.maxColumns ?? MONGO_FLATTEN_DEFAULT_MAX_COLUMNS);
  const result: MongoFlatColumn[] = [];
  const usedNames = new Set<string>();

  const push = (path: readonly string[]) => {
    let name = mongoPathToDotted(path);
    // A literal dotted key ("a.b") and a nested path a → b would collide; keep both visible.
    while (usedNames.has(name)) name = `${name}​`;
    usedNames.add(name);
    result.push({ name, path });
  };

  const visit = (path: readonly string[]) => {
    const name = mongoPathToDotted(path);
    const shouldExpand = path[0] !== "_id" && path.length < maxDepth + 1 && (flattenAll || expanded.has(name));
    if (!shouldExpand || result.length >= maxColumns) {
      push(path);
      return;
    }
    const childKeys: string[] = [];
    const seen = new Set<string>();
    let hasNonObjectValue = false;
    for (const document of documents) {
      const value = getMongoPathValue(document, path);
      if (value === undefined) continue;
      if (!isMongoSubdocument(value)) {
        hasNonObjectValue = true;
        continue;
      }
      for (const key of Object.keys(value)) {
        if (!seen.has(key)) {
          seen.add(key);
          childKeys.push(key);
        }
      }
    }
    if (childKeys.length === 0) {
      push(path);
      return;
    }
    if (hasNonObjectValue) push(path);
    for (const key of childKeys) {
      if (result.length >= maxColumns) break;
      visit([...path, key]);
    }
  };

  for (const column of baseColumns) visit([column]);
  return result;
}

/** Column names (dot paths) whose values are subdocuments in at least one document. */
export function listExpandableMongoColumns(documents: readonly Record<string, unknown>[], columns: readonly MongoFlatColumn[]): string[] {
  return columns
    .filter(
      (column) =>
        column.path[0] !== "_id" &&
        documents.some((document) => {
          const value = getMongoPathValue(document, column.path);
          return isMongoSubdocument(value) && Object.keys(value).length > 0;
        }),
    )
    .map((column) => column.name);
}

/**
 * Projects documents onto flat columns: the returned records are keyed by the
 * column name, so the existing grid row/type helpers can be reused unchanged.
 * Missing fields stay undefined (rendered blank, unlike an explicit null).
 */
export function projectMongoDocument(document: Record<string, unknown>, columns: readonly MongoFlatColumn[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const column of columns) {
    const value = getMongoPathValue(document, column.path);
    if (value !== undefined) projected[column.name] = value;
  }
  return projected;
}

/** True when the column list differs from the plain top-level layout. */
export function hasNestedMongoColumns(columns: readonly MongoFlatColumn[]): boolean {
  return columns.some((column) => column.path.length > 1);
}

// ---------------------------------------------------------------------------
// Tree view rows
// ---------------------------------------------------------------------------

export interface MongoTreeRow {
  /** Stable id: document index plus path, e.g. `3/address/city`. */
  id: string;
  documentIndex: number;
  path: readonly (string | number)[];
  depth: number;
  key: string;
  value: unknown;
  valueText: string;
  valueHint?: string;
  tooltip?: string;
  type: string;
  expandable: boolean;
  expanded: boolean;
  /** Array element rows show their index as the key, like NoSQLBooster. */
  isArrayElement: boolean;
}

export interface MongoTreeRowOptions {
  /** Row ids currently expanded. */
  expanded: ReadonlySet<string>;
  /** Label for a document root row, e.g. `(1) ObjectId("…")`. */
  rootKey?: (document: Record<string, unknown>, index: number) => string;
  previewLabels?: { fields: (count: number) => string; elements: (count: number) => string };
  /** NoSQLBooster-style display (dates, ObjectId age, inline previews). */
  display?: MongoDisplayOptions;
  /** Children shown per container before a "more" row; protects huge arrays. */
  maxChildren?: number;
  /** Index offset for the `(n)` root labels (page offset). */
  indexOffset?: number;
}

export const MONGO_TREE_DEFAULT_MAX_CHILDREN = 1000;

export function mongoTreeRowId(documentIndex: number, path: MongoFieldPath): string {
  return [documentIndex, ...path.map((step) => (typeof step === "number" ? `#${step}` : encodeURIComponent(step)))].join("/");
}

export function defaultMongoTreeRootKey(document: Record<string, unknown>, index: number, total = 0): string {
  const id = document._id;
  const number = String(index + 1).padStart(Math.max(2, String(total).length), "0");
  if (id === undefined) return `(${number})`;
  const hex = mongoObjectIdHex(id);
  return `(${number}) ${hex ?? (typeof id === "string" ? id : mongoValuePreviewText(id))}`;
}

/** Visible rows of the tree in display order: roots plus the children of expanded rows. */
export function buildMongoTreeRows(documents: readonly Record<string, unknown>[], options: MongoTreeRowOptions): MongoTreeRow[] {
  const rows: MongoTreeRow[] = [];
  const labels = options.previewLabels ?? DEFAULT_PREVIEW_LABELS;
  const maxChildren = Math.max(1, options.maxChildren ?? MONGO_TREE_DEFAULT_MAX_CHILDREN);
  const offset = options.indexOffset ?? 0;
  const rootKey = options.rootKey ?? ((document, index) => defaultMongoTreeRootKey(document, index + offset, documents.length + offset));
  const describe = (value: unknown): MongoValueDisplay => (options.display ? mongoValueDisplay(value, options.display) : { text: mongoValuePreviewText(value, labels) });

  const addChildren = (documentIndex: number, parentPath: readonly (string | number)[], container: unknown, depth: number) => {
    const entries: Array<[string | number, unknown]> = Array.isArray(container) ? container.map((item, index) => [index, item]) : Object.entries(container as Record<string, unknown>);
    for (const [step, value] of entries.slice(0, maxChildren)) {
      const path = [...parentPath, step];
      const id = mongoTreeRowId(documentIndex, path);
      const expandable = isMongoContainer(value);
      const expanded = expandable && options.expanded.has(id);
      rows.push({
        id,
        documentIndex,
        path,
        depth,
        key: typeof step === "number" ? `[${step}]` : step,
        value,
        ...displayFields(describe(value)),
        type: mongoValueTypeLabel(value),
        expandable,
        expanded,
        isArrayElement: typeof step === "number",
      });
      if (expanded) addChildren(documentIndex, path, value, depth + 1);
    }
    if (entries.length > maxChildren) {
      const path = [...parentPath, "…"];
      rows.push({
        id: `${mongoTreeRowId(documentIndex, parentPath)}/…`,
        documentIndex,
        path,
        depth,
        key: "…",
        value: undefined,
        valueText: `+${entries.length - maxChildren}`,
        type: "",
        expandable: false,
        expanded: false,
        isArrayElement: false,
      });
    }
  };

  documents.forEach((document, documentIndex) => {
    const id = mongoTreeRowId(documentIndex, []);
    const expandable = Object.keys(document).length > 0;
    const expanded = expandable && options.expanded.has(id);
    rows.push({
      id,
      documentIndex,
      path: [],
      depth: 0,
      key: rootKey(document, documentIndex),
      value: document,
      ...(options.display ? displayFields(mongoValueDisplay(document, options.display)) : { valueText: labels.fields(Object.keys(document).length) }),
      type: "Document",
      expandable,
      expanded,
      isArrayElement: false,
    });
    if (expanded) addChildren(documentIndex, [], document, 1);
  });
  return rows;
}

function displayFields(display: MongoValueDisplay): Pick<MongoTreeRow, "valueText" | "valueHint" | "tooltip"> {
  return { valueText: display.text, ...(display.hint ? { valueHint: display.hint } : {}), ...(display.tooltip ? { tooltip: display.tooltip } : {}) };
}

/** Ids of every container under the given documents, for "Expand all". */
export function collectMongoTreeContainerIds(documents: readonly Record<string, unknown>[], maxDepth = 3): string[] {
  const ids: string[] = [];
  const walk = (documentIndex: number, path: (string | number)[], value: unknown, depth: number) => {
    if (!isMongoContainer(value) || depth > maxDepth) return;
    ids.push(mongoTreeRowId(documentIndex, path));
    const entries: Array<[string | number, unknown]> = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value as Record<string, unknown>);
    for (const [step, child] of entries.slice(0, MONGO_TREE_DEFAULT_MAX_CHILDREN)) walk(documentIndex, [...path, step], child, depth + 1);
  };
  documents.forEach((document, index) => walk(index, [], document, 0));
  return ids;
}

// ---------------------------------------------------------------------------
// Tree view actions: filters, index labels, inline edits
// ---------------------------------------------------------------------------

/** Dot path without array positions: `orders.0.sku` → `orders.sku` (multikey form). */
export function mongoPathWithoutIndexes(path: MongoFieldPath): string {
  return path
    .filter((step) => typeof step !== "number")
    .map(String)
    .join(".");
}

/**
 * A value as it should appear in a filter: plain numbers instead of numeric
 * wrappers (MongoDB compares numbers across types), `{$date: "ISO"}` instead of
 * the canonical milliseconds, and other BSON wrappers kept as extended JSON.
 */
export function mongoFilterValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mongoFilterValue);
  if (value && typeof value === "object") {
    const type = mongoExtendedJsonValueType(value);
    const object = value as Record<string, unknown>;
    if (type === "int32" || type === "double") {
      const number = Number(object.$numberInt ?? object.$numberDouble);
      return Number.isFinite(number) ? number : value;
    }
    if (type === "int64") {
      const number = Number(object.$numberLong);
      return Number.isSafeInteger(number) ? number : value;
    }
    if (type === "date") {
      const millis = mongoDateMillis(value);
      return millis === undefined ? value : { $date: new Date(millis).toISOString() };
    }
    if (type) return value;
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, mongoFilterValue(item)]));
  }
  if (typeof value === "string") {
    const millis = mongoDateMillis(value);
    if (millis !== undefined) return { $date: new Date(millis).toISOString() };
    const hex = mongoObjectIdHex(value);
    if (hex) return { $oid: hex };
  }
  return value;
}

/** `{ "address.city": "Bangkok" }` for a field row; `{ _id: … }` for a document row. */
export function buildMongoValueFilter(document: Record<string, unknown>, path: MongoFieldPath): Record<string, unknown> {
  if (path.length === 0) return { _id: mongoFilterValue(document._id) };
  return { [mongoPathWithoutIndexes(path) || "_id"]: mongoFilterValue(getMongoPathValue(document, path)) };
}

/**
 * Adds conditions to the filter text the user already has. Text that is not a
 * JSON object (shell syntax, a typo) is replaced rather than corrupted.
 */
export function mergeMongoFilterText(existing: string, addition: Record<string, unknown>): string {
  const trimmed = existing.trim();
  let base: Record<string, unknown> = {};
  if (trimmed && trimmed !== "{}") {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  return JSON.stringify({ ...base, ...addition });
}

export interface MongoIndexKeySpec {
  field: string;
  direction: string;
}

export interface MongoIndexSpecLike {
  keys: readonly MongoIndexKeySpec[];
  is_unique?: boolean;
}

/**
 * Label per indexed field path, like NoSQLBooster's `(asc index)`: the leading
 * key of an index reads asc/desc/text/hashed/2dsphere (prefixed "unique" when
 * the index is unique); a later key of a compound index reads "compound index".
 */
export function buildMongoIndexLabels(specs: readonly MongoIndexSpecLike[]): Map<string, string> {
  const labels = new Map<string, { label: string; rank: number }>();
  const kind = (direction: string) => {
    const normalized = String(direction).trim();
    if (normalized === "1" || normalized === "1.0") return "asc";
    if (normalized === "-1" || normalized === "-1.0") return "desc";
    return normalized.replace(/^"|"$/g, "");
  };
  for (const spec of specs) {
    spec.keys.forEach((key, position) => {
      if (!key.field || key.field === "_fts" || key.field === "_ftsx") return;
      const leading = position === 0;
      const label = leading ? `${spec.is_unique ? "unique " : ""}${kind(key.direction)} index` : "compound index";
      // Prefer a single-field / leading-key label over a compound mention.
      const rank = (leading ? 2 : 0) + (leading && spec.keys.length === 1 ? 1 : 0);
      const current = labels.get(key.field);
      if (!current || rank > current.rank) labels.set(key.field, { label, rank });
    });
  }
  return new Map([...labels].map(([field, { label }]) => [field, label]));
}

/** Text placed in the inline editor for a scalar value. */
export function mongoTreeEditText(value: unknown): string {
  if (typeof value === "string") {
    const millis = mongoDateMillis(value);
    return millis !== undefined ? new Date(millis).toISOString() : value;
  }
  const millis = mongoDateMillis(value);
  if (millis !== undefined) return new Date(millis).toISOString();
  const hex = mongoObjectIdHex(value);
  if (hex) return hex;
  if (value === null) return "null";
  const scalar = mongoValuePreviewText(value);
  return scalar;
}

/** True for rows the inline editor may change: scalars below the document, never `_id`. */
export function isMongoTreeEditable(row: { path: MongoFieldPath; expandable: boolean; value: unknown; key: string }): boolean {
  if (!row.path.length || row.path[0] === "_id" || row.key === "…") return false;
  if (Array.isArray(row.value) || isMongoSubdocument(row.value)) return false;
  const type = mongoExtendedJsonValueType(row.value);
  return !type || ["date", "objectId", "int32", "int64", "double", "decimal128"].includes(type);
}

/** Returns a copy of `document` with `path` set to `value` (containers cloned along the path). */
export function setMongoPathValue<T>(document: T, path: MongoFieldPath, value: unknown): T {
  if (!path.length) return value as T;
  const [step, ...rest] = path;
  if (Array.isArray(document)) {
    const copy = [...document];
    copy[step as number] = setMongoPathValue(copy[step as number], rest, value);
    return copy as T;
  }
  const record = (document && typeof document === "object" ? document : {}) as Record<string, unknown>;
  return { ...record, [String(step)]: setMongoPathValue(record[String(step)], rest, value) } as T;
}

/**
 * Converts a canonical extended JSON value to the "browser" form query results
 * keep in `mongo_documents` (plain numbers, `ISODate("…")` text), so patched
 * rows render exactly like freshly loaded ones.
 */
export function mongoCanonicalToBrowserValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mongoCanonicalToBrowserValue);
  if (value && typeof value === "object") {
    const type = mongoExtendedJsonValueType(value);
    const object = value as Record<string, unknown>;
    if (type === "int32" || type === "double") {
      const number = Number(object.$numberInt ?? object.$numberDouble);
      return Number.isFinite(number) ? number : value;
    }
    if (type === "date") {
      const millis = mongoDateMillis(value);
      return millis === undefined ? value : `ISODate("${new Date(millis).toISOString()}")`;
    }
    if (type) return value;
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, mongoCanonicalToBrowserValue(item)]));
  }
  return value;
}
