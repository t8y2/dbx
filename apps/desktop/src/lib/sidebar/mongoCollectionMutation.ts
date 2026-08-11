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
}

export type MongoCreateIndexRequest =
  | {
      valid: true;
      keysJson: string;
      optionsJson?: string;
    }
  | {
      valid: false;
      error: "field-required" | "field-duplicate";
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
  const options = {
    ...(form.name.trim() ? { name: form.name.trim() } : {}),
    ...(form.unique ? { unique: true } : {}),
    ...(form.sparse ? { sparse: true } : {}),
  };
  const optionsJson = Object.keys(options).length ? JSON.stringify(options) : undefined;
  return { valid: true, keysJson, optionsJson };
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
