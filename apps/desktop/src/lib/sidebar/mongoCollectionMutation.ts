import type { MongoCollectionKind, TreeNode } from "@/types/database";

export const MONGO_INDEX_KEY_TYPES = ["1", "-1", "text", "hashed", "2dsphere", "2d"] as const;

export type MongoIndexKeyType = (typeof MONGO_INDEX_KEY_TYPES)[number];

export interface MongoCreateIndexField {
  id: number;
  path: string;
  type: MongoIndexKeyType;
}

export interface MongoCreateIndexForm {
  name: string;
  fields: MongoCreateIndexField[];
  unique: boolean;
  sparse: boolean;
  /** TTL in seconds. Kept as text so an empty box stays distinct from `0`. */
  expireAfterSeconds: string;
  /** Partial index condition, entered as an object literal. */
  partialFilterExpression: string;
  /** Ignored by MongoDB 4.2+; retained for older servers. */
  background: boolean;
  /** Only meaningful for geoHaystack indexes, removed in MongoDB 4.4+. */
  bucketSize: string;
  /** Hide the index from the query planner (MongoDB 4.4+). */
  hidden: boolean;
}

export type MongoCreateIndexRequest =
  | {
      valid: true;
      keysJson: string;
      optionsJson?: string;
    }
  | {
      valid: false;
      error: "field-required" | "field-duplicate" | "ttl-invalid" | "filter-invalid" | "bucket-size-invalid";
      field?: string;
    };

/**
 * MongoDB only supports renameCollection for ordinary, non-system collections.
 * Views, time-series collections, and reserved system namespaces must not expose a rename action.
 * @see https://www.mongodb.com/docs/manual/reference/command/renameCollection/
 */
export function isRenamableMongoCollection(name: string, kind: MongoCollectionKind = "collection"): boolean {
  return kind === "collection" && !name.startsWith("system.");
}

/** Only ordinary collections have transferable options, documents, and indexes. */
export function isCloneableMongoCollection(name: string, kind: MongoCollectionKind = "collection"): boolean {
  return kind === "collection" && !name.startsWith("system.");
}

export function mongoCollectionKindFromNode(node: Pick<TreeNode, "meta">): MongoCollectionKind {
  const meta = node.meta;
  if (meta && "collectionKind" in meta && meta.collectionKind) {
    return meta.collectionKind;
  }
  return "collection";
}

export function mongoCollectionTableTypeFromNode(node: Pick<TreeNode, "meta">): "TABLE" | "VIEW" | "TIMESERIES" {
  const kind = mongoCollectionKindFromNode(node);
  return kind === "view" ? "VIEW" : kind === "timeseries" ? "TIMESERIES" : "TABLE";
}

export function toMongoCollectionKind(kind?: string | null): MongoCollectionKind {
  const normalized = (kind || "collection").toLowerCase();
  if (normalized === "view") return "view";
  if (normalized === "timeseries") return "timeseries";
  return "collection";
}

/** Drop GridFS buckets and their backing `.files` / `.chunks` collections from object lists. */
export function visibleMongoCollections<T extends { name: string; kind?: string | null; bucketName?: string }>(collections: readonly T[]): T[] {
  const bucketNames = new Set(collections.filter((collection) => collection.kind === "bucket" && collection.bucketName).map((collection) => collection.bucketName as string));
  const hiddenCollectionNames = new Set([...bucketNames].flatMap((bucketName) => [`${bucketName}.files`, `${bucketName}.chunks`]));
  return collections.filter((collection) => collection.kind !== "bucket" && !hiddenCollectionNames.has(collection.name));
}

export function mongoRenameCollectionPreview(database: string, oldName: string, newName: string): string {
  return `db.getSiblingDB(${JSON.stringify(database)}).getCollection(${JSON.stringify(oldName)}).renameCollection(${JSON.stringify(newName)})`;
}

/**
 * DBX executes these stable primitives in the backend instead of MongoDB's
 * deprecated clone commands, which vary across server generations.
 */
export function mongoCloneCollectionPreview(database: string, sourceName: string, targetName: string): string {
  const db = `db.getSiblingDB(${JSON.stringify(database)})`;
  const source = `${db}.getCollection(${JSON.stringify(sourceName)})`;
  const target = `${db}.getCollection(${JSON.stringify(targetName)})`;
  return [
    `// DBX copies collection options, documents, and non-_id indexes.`,
    `${db}.createCollection(${JSON.stringify(targetName)}, /* source options */);`,
    `${source}.find({}).forEach(function (document) { ${target}.insertOne(document); });`,
    `// Recreate source indexes except the target's automatic _id index.`,
  ].join("\n");
}

export function mongoDropCollectionPreview(database: string, collection: string): string {
  return `db.getSiblingDB(${JSON.stringify(database)}).getCollection(${JSON.stringify(collection)}).drop()`;
}

export function mongoDropDatabasePreview(database: string): string {
  return `db.getSiblingDB(${JSON.stringify(database)}).dropDatabase()`;
}

export function mongoDropIndexPreview(database: string, collection: string, indexName: string): string {
  return `db.getSiblingDB(${JSON.stringify(database)}).getCollection(${JSON.stringify(collection)}).dropIndex(${JSON.stringify(indexName)})`;
}

export function mongoDropAllIndexesPreview(database: string, collection: string): string {
  return `db.getSiblingDB(${JSON.stringify(database)}).getCollection(${JSON.stringify(collection)}).dropIndexes()`;
}

export function mongoDropIndexFailureCount(result: { failures?: readonly unknown[] }): number {
  return result.failures?.length ?? 0;
}

/** MongoDB always protects its default _id index, even when metadata is incomplete. */
export function isProtectedMongoIndex(index: { name: string; is_primary?: boolean }): boolean {
  return index.name === "_id_" || !!index.is_primary;
}

/** Parse an optional non-negative integer box; `null` marks a malformed entry. */
function optionalNonNegativeInteger(raw: string | undefined): number | undefined | null {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Parse the partial filter box; `null` marks anything that is not an object literal. */
function optionalFilterObject(raw: string | undefined): Record<string, unknown> | undefined | null {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Convert the visual form into the driver's JSON transport format. */
export function buildMongoCreateIndexRequest(form: MongoCreateIndexForm): MongoCreateIndexRequest {
  const fields = form.fields.map((field) => ({ ...field, path: field.path.trim() }));
  if (fields.length === 0 || fields.some((field) => !field.path)) return { valid: false, error: "field-required" };
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.path)) return { valid: false, error: "field-duplicate", field: field.path };
    seen.add(field.path);
  }

  // Build the object text directly so compound indexes retain their visual row order,
  // including when a field name looks like an integer.
  const keysJson = `{${fields.map((field) => `${JSON.stringify(field.path)}:${JSON.stringify(field.type === "1" ? 1 : field.type === "-1" ? -1 : field.type)}`).join(",")}}`;
  const expireAfterSeconds = optionalNonNegativeInteger(form.expireAfterSeconds);
  if (expireAfterSeconds === null) return { valid: false, error: "ttl-invalid" };
  const bucketSize = optionalNonNegativeInteger(form.bucketSize);
  if (bucketSize === null) return { valid: false, error: "bucket-size-invalid" };
  const partialFilterExpression = optionalFilterObject(form.partialFilterExpression);
  if (partialFilterExpression === null) return { valid: false, error: "filter-invalid" };

  const options = {
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    ...(form.unique ? { unique: true } : {}),
    ...(form.sparse ? { sparse: true } : {}),
    ...(expireAfterSeconds === undefined ? {} : { expireAfterSeconds }),
    ...(partialFilterExpression === undefined ? {} : { partialFilterExpression }),
    ...(form.background ? { background: true } : {}),
    ...(bucketSize === undefined ? {} : { bucketSize }),
    ...(form.hidden ? { hidden: true } : {}),
  };
  const optionsJson = Object.keys(options).length ? JSON.stringify(options) : undefined;
  return { valid: true, keysJson, optionsJson };
}

/**
 * Merge the server-reported `extraOptions` (collation, wildcardProjection,
 * weights, text defaults, geo options, …) into the form-built request so the
 * drop + recreate preserves every option the form does not model. Form values
 * take precedence: if the user explicitly set `unique` in the form, that wins
 * over any `unique` in `extraOptions` (which shouldn't appear there anyway
 * since it's modeled, but the principle holds for overlapping future fields).
 */
export function mergeExtraOptionsIntoRequest(request: Extract<MongoCreateIndexRequest, { valid: true }>, extraOptions?: string): { keysJson: string; optionsJson?: string } {
  if (!extraOptions?.trim()) return { keysJson: request.keysJson, optionsJson: request.optionsJson };
  let extra: Record<string, unknown>;
  try {
    const parsed = JSON.parse(extraOptions);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return request;
    extra = parsed as Record<string, unknown>;
  } catch {
    // Malformed extra options should not block the edit; fall back to form-only.
    return request;
  }
  // `key` is the index key spec, never an option — filter it defensively.
  delete extra.key;
  const formOptions = request.optionsJson ? (JSON.parse(request.optionsJson) as Record<string, unknown>) : {};
  // Form values take precedence over extraOptions for the same key.
  const merged = { ...extra, ...formOptions };
  const optionsJson = Object.keys(merged).length ? JSON.stringify(merged) : undefined;
  return { keysJson: request.keysJson, optionsJson };
}

export type MongoIndexSpecSource = {
  name: string;
  keys?: readonly { field: string; direction: string }[] | null;
  is_unique?: boolean;
  is_primary?: boolean;
  is_sparse?: boolean;
  expire_after_seconds?: number | null;
  partial_filter_expression?: string | null;
  background?: boolean;
  bucket_size?: number | null;
  hidden?: boolean;
  properties_complete?: boolean;
  extra_options?: string | null;
};

/** Immutable, normalized server specification captured when index editing starts. */
export interface MongoIndexSpecSnapshot {
  name: string;
  keys: { field: string; direction: string }[];
  isUnique: boolean;
  isPrimary: boolean;
  isSparse: boolean;
  expireAfterSeconds: number | null;
  partialFilterExpression?: string;
  background: boolean;
  bucketSize: number | null;
  hidden: boolean;
  propertiesComplete: boolean;
  extraOptions?: string;
}

/** Copy a server result into the stable shape used by preflight and rollback. */
export function snapshotMongoIndexSpec(source: MongoIndexSpecSource): MongoIndexSpecSnapshot {
  return {
    name: source.name,
    keys: (source.keys ?? []).map((key) => ({ field: key.field, direction: String(key.direction) })),
    isUnique: !!source.is_unique,
    isPrimary: !!source.is_primary,
    isSparse: !!source.is_sparse,
    expireAfterSeconds: source.expire_after_seconds ?? null,
    partialFilterExpression: source.partial_filter_expression?.trim() || undefined,
    background: !!source.background,
    bucketSize: source.bucket_size ?? null,
    hidden: !!source.hidden,
    propertiesComplete: source.properties_complete !== false,
    extraOptions: source.extra_options?.trim() || undefined,
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJsonValue(child)]),
  );
}

function canonicalJsonText(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    return JSON.stringify(canonicalJsonValue(JSON.parse(raw)));
  } catch {
    return raw.trim() || undefined;
  }
}

function comparableMongoIndexSpec(spec: MongoIndexSpecSnapshot): unknown {
  return {
    ...spec,
    partialFilterExpression: canonicalJsonText(spec.partialFilterExpression),
    extraOptions: canonicalJsonText(spec.extraOptions),
  };
}

/**
 * Preflight check before a destructive edit: verify the complete normalized
 * server specification still matches the immutable snapshot captured when the
 * editor opened.
 */
export function preflightEditIndexSpec(currentSpecs: readonly MongoIndexSpecSource[], originalSpec: MongoIndexSpecSnapshot): { safe: boolean; reason?: string } {
  const current = currentSpecs.find((spec) => spec.name === originalSpec.name);
  if (!current) return { safe: false, reason: "not-found" };
  const currentSnapshot = snapshotMongoIndexSpec(current);
  if (JSON.stringify(comparableMongoIndexSpec(currentSnapshot)) !== JSON.stringify(comparableMongoIndexSpec(originalSpec))) {
    return { safe: false, reason: "stale" };
  }
  return { safe: true };
}

function parseIndexOptionObject(raw: string | undefined, label: string): Record<string, unknown> {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Rebuild the exact create-index transport request used to restore an original index. */
export function mongoCreateIndexRequestFromSpec(spec: MongoIndexSpecSnapshot): { keysJson: string; optionsJson: string } {
  const keysJson = `{${spec.keys.map((key) => `${JSON.stringify(key.field)}:${JSON.stringify(key.direction === "1" ? 1 : key.direction === "-1" ? -1 : key.direction)}`).join(",")}}`;
  const extraOptions = parseIndexOptionObject(spec.extraOptions, "Index extra options");
  for (const modeledField of ["key", "name", "unique", "sparse", "expireAfterSeconds", "partialFilterExpression", "background", "bucketSize", "hidden"]) {
    delete extraOptions[modeledField];
  }
  const partialFilterExpression = spec.partialFilterExpression ? parseIndexOptionObject(spec.partialFilterExpression, "Partial filter expression") : undefined;
  const options = {
    ...extraOptions,
    name: spec.name,
    ...(spec.isUnique ? { unique: true } : {}),
    ...(spec.isSparse ? { sparse: true } : {}),
    ...(spec.expireAfterSeconds === null ? {} : { expireAfterSeconds: spec.expireAfterSeconds }),
    ...(partialFilterExpression ? { partialFilterExpression } : {}),
    ...(spec.background ? { background: true } : {}),
    ...(spec.bucketSize === null ? {} : { bucketSize: spec.bucketSize }),
    ...(spec.hidden ? { hidden: true } : {}),
  };
  return { keysJson, optionsJson: JSON.stringify(options) };
}

/**
 * Keep the preview and production confirmation byte-for-byte aligned with
 * the JSON passed to the backend. Re-serializing parsed JSON could reorder a
 * compound key or round a large numeric value before the user reviews it.
 */
export function mongoCreateIndexPreview(database: string, collection: string, keysJson: string, optionsJson?: string): string {
  const args = [keysJson, ...(optionsJson ? [optionsJson] : [])];
  return `db.getSiblingDB(${JSON.stringify(database)}).getCollection(${JSON.stringify(collection)}).createIndex(${args.join(", ")})`;
}

/** Render a key direction the way index management tools label it. */
export function mongoIndexKeyLabel(value: unknown): string {
  if (value === 1 || value === "1") return "ASC";
  if (value === -1 || value === "-1") return "DESC";
  return String(value ?? "");
}

/**
 * Reverse {@link mongoIndexKeyLabel} so an edited index can re-enter the form
 * with the same direction the server reported. Anything that is not ASC/DESC
 * (text, 2dsphere, hashed, …) is kept verbatim.
 */
function mongoIndexKeyTypeFromLabel(label: string): MongoIndexKeyType {
  if (label === "ASC") return "1";
  if (label === "DESC") return "-1";
  // Non-numeric key types (text, 2dsphere, hashed, 2d) round-trip as-is when
  // they are part of the known set, otherwise default to ascending.
  return (MONGO_INDEX_KEY_TYPES as readonly string[]).includes(label) ? (label as MongoIndexKeyType) : "1";
}

/**
 * Parse the human-readable keys description produced by {@link mongoIndexKeyDescription}
 * back into the visual form's field rows. Each comma-separated segment is
 * `field DIRECTION`; a segment with no direction defaults to ascending.
 */
function parseMongoIndexKeyDescription(description: string): { field: string; type: MongoIndexKeyType }[] {
  return description
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const spaceIndex = segment.lastIndexOf(" ");
      // Segments like `account ASC` split into field + label; a bare field name
      // (no direction) falls back to ascending.
      if (spaceIndex <= 0) return { field: segment, type: "1" as MongoIndexKeyType };
      const field = segment.slice(0, spaceIndex).trim();
      const label = segment.slice(spaceIndex + 1).trim();
      return { field, type: mongoIndexKeyTypeFromLabel(label) };
    });
}

/** One row of the index management panel. */
export interface MongoIndexRow {
  name: string;
  /** Per-key description, e.g. `account ASC`. */
  keys: string;
  isUnique: boolean;
  isProtected: boolean;
  isSparse: boolean;
  /** TTL in seconds; undefined when the index does not expire. */
  expireAfterSeconds?: number;
  partialFilterExpression?: string;
  background: boolean;
  bucketSize?: number;
  hidden: boolean;
  /**
   * False when the driver could not report the properties above, so the panel
   * hides them instead of presenting defaults as if the server had said so.
   */
  propertiesComplete: boolean;
  extraOptions?: string;
}

/** Describe every key as `field LABEL`, e.g. `account ASC, createTime DESC`. */
function mongoIndexKeyDescription(keys: readonly { field: string; direction: string }[]): string {
  return keys
    .map((key) => {
      const label = mongoIndexKeyLabel(key.direction);
      return label ? `${key.field} ${label}` : key.field;
    })
    .join(", ");
}

/** Adapt a backend index spec into the management panel's row model. */
export function toMongoIndexRow(source: MongoIndexSpecSource): MongoIndexRow {
  return {
    name: source.name,
    keys: mongoIndexKeyDescription(source.keys ?? []),
    isUnique: !!source.is_unique,
    isProtected: isProtectedMongoIndex({ name: source.name, is_primary: source.is_primary }),
    isSparse: !!source.is_sparse,
    expireAfterSeconds: source.expire_after_seconds ?? undefined,
    partialFilterExpression: source.partial_filter_expression?.trim() || undefined,
    background: !!source.background,
    bucketSize: source.bucket_size ?? undefined,
    hidden: !!source.hidden,
    // Absent means the caller did not say, and only the Legacy Agent path says false.
    propertiesComplete: source.properties_complete !== false,
    extraOptions: source.extra_options?.trim() || undefined,
  };
}

/**
 * Prefill the create-index form from an existing index row so the user can
 * edit it as a drop + recreate. The keys description is parsed back into the
 * visual field rows; options map one-to-one.
 */
export function mongoCreateIndexFormFromRow(row: MongoIndexRow): MongoCreateIndexForm {
  const parsed = parseMongoIndexKeyDescription(row.keys);
  const fields = parsed.length > 0 ? parsed.map((entry, index) => ({ id: index + 1, path: entry.field, type: entry.type })) : [{ id: 1, path: "", type: "1" as MongoIndexKeyType }];
  return {
    name: row.name,
    fields,
    unique: row.isUnique,
    sparse: row.isSparse,
    expireAfterSeconds: row.expireAfterSeconds === undefined ? "" : String(row.expireAfterSeconds),
    partialFilterExpression: row.partialFilterExpression ?? "",
    background: row.background,
    bucketSize: row.bucketSize === undefined ? "" : String(row.bucketSize),
    hidden: row.hidden,
  };
}

/**
 * Build the review/preview text for an index edit (drop + recreate).
 * Mirrors the two-step shell commands the backend runs, so production
 * confirmation shows exactly what happens.
 */
export function mongoReplaceIndexPreview(database: string, collection: string, oldName: string, keysJson: string, optionsJson?: string): string {
  const drop = mongoDropIndexPreview(database, collection, oldName);
  const create = mongoCreateIndexPreview(database, collection, keysJson, optionsJson);
  return `${drop}\n${create}`;
}
