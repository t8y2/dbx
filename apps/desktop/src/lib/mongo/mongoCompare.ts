import { mongoExtendedJsonValueType } from "@/lib/mongo/mongoDocumentValues";

export type MongoCompareDocument = Record<string, unknown>;
export type MongoCompareSide = "source" | "target";
export type MongoCompareStatus = "same" | "different" | "sourceOnly" | "targetOnly" | "multiple";

export interface MongoFieldDifference {
  path: string;
  segments: string[];
  source?: unknown;
  target?: unknown;
  sourceExists: boolean;
  targetExists: boolean;
}

export interface MongoCompareRow {
  key: string;
  status: MongoCompareStatus;
  source?: MongoCompareDocument;
  target?: MongoCompareDocument;
  sourceMatches: number;
  targetMatches: number;
  fields: MongoFieldDifference[];
  missingMatchField: boolean;
}

export interface MongoCompareOptions {
  matchFields: string[];
  ignoredFields?: string[];
  numericTypesEqual?: boolean;
}

export interface MongoCompareResult {
  rows: MongoCompareRow[];
  counts: Record<MongoCompareStatus, number>;
}

const MISSING = Symbol("missing MongoDB comparison value");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Extended JSON scalar wrappers are atomic values, not embedded documents. */
function isEmbeddedDocument(value: unknown): value is MongoCompareDocument {
  return isRecord(value) && !mongoExtendedJsonValueType(value);
}

export function mongoValueAtPath(document: MongoCompareDocument, path: string): unknown | typeof MISSING {
  let current: unknown = document;
  for (const segment of path.split(".")) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return MISSING;
    current = current[segment];
  }
  return current;
}

export function mongoFieldExists(document: MongoCompareDocument, path: string): boolean {
  return mongoValueAtPath(document, path) !== MISSING;
}

function normalizeNumber(raw: string): string {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!match || !(match[2] || match[3])) return raw;
  const digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "").replace(/0+$/, "");
  if (!digits) return "0";
  const allDigits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "");
  const exponent = BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length) + BigInt(allDigits.length - digits.length);
  return `${match[1] === "-" ? "-" : ""}${digits}e${exponent}`;
}

function numericValue(value: unknown): string | undefined {
  if (typeof value === "number") return normalizeNumber(String(value));
  if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
  const key = Object.keys(value)[0];
  if (!["$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"].includes(key)) return undefined;
  const raw = value[key];
  return typeof raw === "string" ? normalizeNumber(raw) : undefined;
}

export function mongoCompareFingerprint(value: unknown, numericTypesEqual = false): string {
  if (numericTypesEqual) {
    const number = numericValue(value);
    if (number !== undefined) return `number:${number}`;
  }
  if (value === null) return "null";
  if (Array.isArray(value)) return `array:[${value.map((entry) => mongoCompareFingerprint(entry, numericTypesEqual)).join(",")}]`;
  if (isRecord(value)) {
    return `object:{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${mongoCompareFingerprint(value[key], numericTypesEqual)}`)
      .join(",")}}`;
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

function keyFor(document: MongoCompareDocument, fields: string[], numericTypesEqual: boolean): string {
  return fields
    .map((field) => {
      const value = mongoValueAtPath(document, field);
      return `${JSON.stringify(field)}=${value === MISSING ? "<missing>" : mongoCompareFingerprint(value, numericTypesEqual)}`;
    })
    .join(" | ");
}

function groupByKey(documents: MongoCompareDocument[], fields: string[], numericTypesEqual: boolean): Map<string, MongoCompareDocument[]> {
  const groups = new Map<string, MongoCompareDocument[]>();
  for (const document of documents) {
    const key = keyFor(document, fields, numericTypesEqual);
    const group = groups.get(key) ?? [];
    group.push(document);
    groups.set(key, group);
  }
  return groups;
}

function diffFields(source: MongoCompareDocument, target: MongoCompareDocument, options: MongoCompareOptions): MongoFieldDifference[] {
  const ignored = new Set(options.ignoredFields ?? []);
  const fields: MongoFieldDifference[] = [];
  function visit(left: MongoCompareDocument, right: MongoCompareDocument, prefix: string[]): void {
    for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const segments = [...prefix, name];
      const path = segments.join(".");
      if (ignored.has(path) || [...ignored].some((ignoredPath) => path.startsWith(`${ignoredPath}.`))) continue;
      const sourceExists = Object.prototype.hasOwnProperty.call(left, name);
      const targetExists = Object.prototype.hasOwnProperty.call(right, name);
      const sourceValue = left[name];
      const targetValue = right[name];
      if (sourceExists && targetExists && isEmbeddedDocument(sourceValue) && isEmbeddedDocument(targetValue)) {
        visit(sourceValue, targetValue, segments);
      } else if ((isEmbeddedDocument(sourceValue) || isEmbeddedDocument(targetValue)) && [...ignored].some((ignoredPath) => ignoredPath.startsWith(`${path}.`))) {
        // An excluded descendant must not be deleted or copied via its parent.
        // Traverse only when both sides can be merged without replacing a scalar.
        if ((!sourceExists || isEmbeddedDocument(sourceValue)) && (!targetExists || isEmbeddedDocument(targetValue))) {
          visit(isEmbeddedDocument(sourceValue) ? sourceValue : {}, isEmbeddedDocument(targetValue) ? targetValue : {}, segments);
        } else {
          throw new Error(`Cannot exclude nested fields under ${path} when one side is a scalar; exclude the whole field instead`);
        }
      } else if (!sourceExists || !targetExists || mongoCompareFingerprint(sourceValue, options.numericTypesEqual) !== mongoCompareFingerprint(targetValue, options.numericTypesEqual)) {
        fields.push({ path, segments, source: sourceValue, target: targetValue, sourceExists, targetExists });
      }
    }
  }
  visit(source, target, []);
  return fields;
}

/** Compares complete document snapshots. Ambiguous keys are surfaced but never paired. */
export function compareMongoDocuments(source: MongoCompareDocument[], target: MongoCompareDocument[], options: MongoCompareOptions): MongoCompareResult {
  if (options.matchFields.length === 0) throw new Error("Choose at least one match field");
  const left = groupByKey(source, options.matchFields, !!options.numericTypesEqual);
  const right = groupByKey(target, options.matchFields, !!options.numericTypesEqual);
  const rows: MongoCompareRow[] = [];
  const counts: Record<MongoCompareStatus, number> = { same: 0, different: 0, sourceOnly: 0, targetOnly: 0, multiple: 0 };
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const sources = left.get(key) ?? [];
    const targets = right.get(key) ?? [];
    let status: MongoCompareStatus;
    let fields: MongoFieldDifference[] = [];
    const missingMatchField = [...sources, ...targets].some((doc) => options.matchFields.some((field) => !mongoFieldExists(doc, field)));
    if (sources.length > 1 || targets.length > 1 || missingMatchField) status = "multiple";
    else if (!sources.length) status = "targetOnly";
    else if (!targets.length) status = "sourceOnly";
    else {
      fields = diffFields(sources[0], targets[0], options);
      status = fields.length ? "different" : "same";
    }
    counts[status] += 1;
    rows.push({ key, status, source: sources[0], target: targets[0], sourceMatches: sources.length, targetMatches: targets.length, fields, missingMatchField });
  }
  return { rows, counts };
}

export function mongoCompareCsv(result: MongoCompareResult): string {
  const quote = (value: unknown) => {
    const text = String(value ?? "");
    return `"${(/^[=+\-@\t\r]/.test(text) ? "'" + text : text).replaceAll('"', '""')}"`;
  };
  return [
    "status,key,field,source,target",
    ...result.rows.flatMap((row) => (row.fields.length ? row.fields : [{ path: "", source: row.source, target: row.target }]).map((field) => [row.status, row.key, field.path, JSON.stringify(field.source), JSON.stringify(field.target)].map(quote).join(","))),
  ].join("\r\n");
}

export interface MongoSyncChange {
  kind: "insert" | "replace" | "delete";
  row: MongoCompareRow;
  before?: MongoCompareDocument;
  after?: MongoCompareDocument;
  origin?: MongoCompareDocument;
}

/** Updates only compared fields. The destination's immutable _id is retained. */
export function planMongoSync(row: MongoCompareRow, destination: MongoCompareSide, selectedFields?: string[][]): MongoSyncChange | null {
  if (row.status === "multiple" || row.status === "same") return null;
  const before = row[destination];
  const origin = row[destination === "target" ? "source" : "target"];
  if (!before && origin) return { kind: "insert", row, origin, after: JSON.parse(JSON.stringify(origin)) };
  if (before && !origin) return { kind: "delete", row, before };
  if (!before || !origin) return null;
  const after = JSON.parse(JSON.stringify(before)) as MongoCompareDocument;
  let changed = false;
  for (const field of row.fields) {
    if (field.segments[0] === "_id" || (selectedFields && !selectedFields.some((segments) => JSON.stringify(segments) === JSON.stringify(field.segments)))) continue;
    let parent = after;
    for (const segment of field.segments.slice(0, -1)) {
      if (!Object.prototype.hasOwnProperty.call(parent, segment) || !isRecord(parent[segment])) {
        Object.defineProperty(parent, segment, { value: {}, enumerable: true, writable: true, configurable: true });
      }
      parent = parent[segment] as MongoCompareDocument;
    }
    const name = field.segments[field.segments.length - 1]!;
    const exists = destination === "target" ? field.sourceExists : field.targetExists;
    const value = destination === "target" ? field.source : field.target;
    if (exists) Object.defineProperty(parent, name, { value: JSON.parse(JSON.stringify(value)), enumerable: true, configurable: true, writable: true });
    else delete parent[name];
    changed = true;
  }
  return changed ? { kind: "replace", row, origin, before, after } : null;
}

/** Exact document CAS, with $literal preventing values from becoming operators. */
export function mongoSnapshotFilter(document: MongoCompareDocument): MongoCompareDocument {
  if (!Object.prototype.hasOwnProperty.call(document, "_id")) throw new Error("Document has no _id; compare again");
  return {
    _id: { $eq: document._id },
    $expr: { $eq: ["$$ROOT", { $literal: document }] },
  };
}
