import type { MongoCollectionKind, TreeNode } from "@/types/database";

/**
 * MongoDB only supports renameCollection for ordinary, non-system collections.
 * Views, time-series collections, and reserved system namespaces must not expose a rename action.
 * @see https://www.mongodb.com/docs/manual/reference/command/renameCollection/
 */
export function isRenamableMongoCollection(name: string, kind: MongoCollectionKind = "collection"): boolean {
  return kind === "collection" && !name.startsWith("system.");
}

export function mongoCollectionKindFromNode(node: Pick<TreeNode, "meta">): MongoCollectionKind {
  const meta = node.meta;
  if (meta && "collectionKind" in meta && meta.collectionKind) {
    return meta.collectionKind;
  }
  return "collection";
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
