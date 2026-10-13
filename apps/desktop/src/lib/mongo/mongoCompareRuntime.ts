import { mongoCompareFingerprint, mongoFieldExists, mongoSnapshotFilter, mongoValueAtPath, type MongoCompareDocument, type MongoSyncChange } from "./mongoCompare";
import { parseMongoJson } from "./mongoJson";

export interface MongoCompareEndpoint {
  connectionId: string;
  database: string;
  collection: string;
  filter: string;
}

interface DocumentPage {
  documents: unknown[];
  extended_documents?: unknown[];
}

export interface MongoCompareApi {
  mongoFindDocuments(connectionId: string, database: string, collection: string, skip: number, limit: number, filter?: string, projection?: string, sort?: string, collation?: string, executionId?: string): Promise<DocumentPage>;
  mongoRunCommand(connectionId: string, database: string, command: string): Promise<DocumentPage>;
  mongoListIndexSpecs?(connectionId: string, database: string, collection: string): Promise<MongoCompareIndexSpec[]>;
}

interface MongoCompareIndexSpec {
  keys: { field: string; direction: string }[];
  is_unique: boolean;
  is_sparse: boolean;
  partial_filter_expression: string | null;
  properties_complete: boolean;
}

export class MongoCompareError extends Error {
  constructor(
    public readonly code: "bsonUnavailable" | "invalidFilter" | "invalidLimit" | "memoryLimit" | "cancelled" | "conflict" | "writeFailed" | "collectionMissing" | "invalidMatchFields" | "uniqueIndexRequired" | "sameEndpoint",
    details = "",
  ) {
    super(details || code);
  }
}

export function canonicalDocuments(page: DocumentPage): MongoCompareDocument[] {
  // Display JSON loses ObjectId / Date / Int64 information. Never silently
  // compare it or later turn it into writes when a Legacy driver omits EJSON.
  if (!page.extended_documents || page.extended_documents.length !== page.documents.length) throw new MongoCompareError("bsonUnavailable");
  return page.extended_documents.map((doc) => {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new MongoCompareError("bsonUnavailable");
    return doc as MongoCompareDocument;
  });
}

export function validateMongoCompareFilter(filter: string): string {
  try {
    const parsed = parseMongoJson(filter.trim() || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return JSON.stringify(parsed);
  } catch {
    throw new MongoCompareError("invalidFilter");
  }
}

export async function readMongoCompareSnapshot(api: MongoCompareApi, endpoint: MongoCompareEndpoint, options: { limit: number; executionId: string; signal: AbortSignal; onProgress?: (count: number) => void }) {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100_000) throw new MongoCompareError("invalidLimit");
  const filter = validateMongoCompareFilter(endpoint.filter);
  const documents: MongoCompareDocument[] = [];
  let bytes = 0;
  while (documents.length <= options.limit) {
    if (options.signal.aborted) throw new MongoCompareError("cancelled");
    const batchSize = Math.min(500, options.limit + 1 - documents.length);
    const page = await api.mongoFindDocuments(endpoint.connectionId, endpoint.database, endpoint.collection, documents.length, batchSize, filter, undefined, '{"_id":1}', undefined, options.executionId);
    if (options.signal.aborted) throw new MongoCompareError("cancelled");
    const batch = canonicalDocuments(page);
    bytes += new TextEncoder().encode(JSON.stringify(batch)).byteLength;
    if (bytes > 64 * 1024 * 1024) throw new MongoCompareError("memoryLimit");
    documents.push(...batch);
    options.onProgress?.(Math.min(documents.length, options.limit));
    if (documents.length > options.limit) return { documents: documents.slice(0, options.limit), truncated: true };
    if (batch.length === 0) return { documents, truncated: false };
    // Some drivers cap batches below the requested size; only an empty page
    // establishes completion. Count estimates must never establish completeness.
  }
  return { documents, truncated: true };
}

export function mongoMatchFilter(document: MongoCompareDocument, fields: string[]): MongoCompareDocument {
  if (!fields.length || fields.some((path) => !mongoFieldExists(document, path))) throw new MongoCompareError("conflict");
  return { $expr: { $and: fields.map((field) => ({ $eq: [`$${field}`, { $literal: mongoValueAtPath(document, field) }] })) } };
}

async function verifySide(api: MongoCompareApi, endpoint: MongoCompareEndpoint, expected: MongoCompareDocument | undefined, keyDocument: MongoCompareDocument, fields: string[]): Promise<void> {
  // Do not use the UI filter here: a matching document outside that filter must
  // still prevent an insert or an ambiguous update.
  const page = await api.mongoFindDocuments(endpoint.connectionId, endpoint.database, endpoint.collection, 0, 2, JSON.stringify(mongoMatchFilter(expected ?? keyDocument, fields)));
  const actual = canonicalDocuments(page);
  if (actual.length !== (expected ? 1 : 0) || (expected && mongoCompareFingerprint(actual[0]) !== mongoCompareFingerprint(expected))) throw new MongoCompareError("conflict");
}

/** runCommand uses the existing strict Extended JSON decoder on both backends. */
export function mongoSyncCommand(collection: string, change: MongoSyncChange): MongoCompareDocument {
  if (change.kind === "insert") return { insert: collection, documents: [change.after], ordered: true };
  if (!change.before) throw new MongoCompareError("conflict");
  const query = mongoSnapshotFilter(change.before);
  if (change.kind === "delete") return { delete: collection, deletes: [{ q: query, limit: 1 }], ordered: true };
  return { update: collection, updates: [{ q: query, u: change.after, multi: false, upsert: false }], ordered: true };
}

function responseNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Number(record.$numberInt ?? record.$numberLong ?? record.$numberDouble);
  }
  return NaN;
}

export async function executeMongoSync(api: MongoCompareApi, source: MongoCompareEndpoint, target: MongoCompareEndpoint, fields: string[], changes: MongoSyncChange[], onProgress?: (completed: number) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new MongoCompareError("cancelled");
  if (!changes.length) return;
  // The read-before-insert check cannot prevent another client from inserting
  // the same business key. Require a server-enforced unique index before a
  // custom-key plan containing inserts is applied. _id uses MongoDB's built-in index; on sharded
  // collections its uniqueness across shards remains the deployment's concern.
  if (!fields.includes("_id") && changes.some((change) => change.kind === "insert")) {
    if (!api.mongoListIndexSpecs) throw new MongoCompareError("uniqueIndexRequired");
    const indexes = await api.mongoListIndexSpecs(target.connectionId, target.database, target.collection);
    if (signal?.aborted) throw new MongoCompareError("cancelled");
    const matchFields = new Set(fields);
    const safeIndex = indexes.some((index) => index.properties_complete && index.is_unique && !index.is_sparse && !index.partial_filter_expression && index.keys.length > 0 && index.keys.every((key) => matchFields.has(key.field) && (key.direction === "1" || key.direction === "-1")));
    if (!safeIndex) throw new MongoCompareError("uniqueIndexRequired");
  }
  // Validate the complete plan before its first write. Then validate again per
  // operation and atomically compare the destination snapshot during the write.
  const verify = async (change: MongoSyncChange) => {
    if (signal?.aborted) throw new MongoCompareError("cancelled");
    const keyDocument = change.before ?? change.after!;
    const expectedSource = change.origin;
    await verifySide(api, source, expectedSource, keyDocument, fields);
    if (signal?.aborted) throw new MongoCompareError("cancelled");
    await verifySide(api, target, change.before, keyDocument, fields);
  };
  for (const change of changes) await verify(change);
  for (const [index, change] of changes.entries()) {
    await verify(change);
    if (signal?.aborted) throw new MongoCompareError("cancelled");
    const result = await api.mongoRunCommand(target.connectionId, target.database, JSON.stringify(mongoSyncCommand(target.collection, change)));
    const response = result.documents[0] as Record<string, unknown> | undefined;
    if (!response || responseNumber(response.ok) !== 1 || (Array.isArray(response.writeErrors) && response.writeErrors.length) || response.writeConcernError) {
      throw new MongoCompareError("writeFailed", JSON.stringify(response ?? "Empty MongoDB write response"));
    }
    if (responseNumber(response.n) !== 1) throw new MongoCompareError("conflict");
    onProgress?.(index + 1);
  }
}
