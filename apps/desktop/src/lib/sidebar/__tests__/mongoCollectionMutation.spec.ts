import { describe, expect, it } from "vitest";
import { isRenamableMongoCollection, mongoCollectionKindFromNode, mongoDropAllIndexesPreview, mongoDropCollectionPreview, mongoDropIndexPreview, mongoRenameCollectionPreview, toMongoCollectionKind } from "../mongoCollectionMutation";

describe("isRenamableMongoCollection", () => {
  it("allows ordinary collections and defaults", () => {
    expect(isRenamableMongoCollection("users")).toBe(true);
    expect(isRenamableMongoCollection("users", "collection")).toBe(true);
  });

  it("rejects views, time-series collections, and system namespaces", () => {
    expect(isRenamableMongoCollection("users_view", "view")).toBe(false);
    expect(isRenamableMongoCollection("metrics", "timeseries")).toBe(false);
    expect(isRenamableMongoCollection("system.views", "collection")).toBe(false);
  });
});

describe("mongoCollectionKindFromNode", () => {
  it("reads collectionKind from node meta without using SQL tableType", () => {
    expect(mongoCollectionKindFromNode({ meta: { collectionKind: "view" } })).toBe("view");
    expect(mongoCollectionKindFromNode({ meta: { collectionKind: "timeseries" } })).toBe("timeseries");
    expect(mongoCollectionKindFromNode({ meta: { collectionKind: "collection" } })).toBe("collection");
    expect(mongoCollectionKindFromNode({})).toBe("collection");
  });
});

describe("toMongoCollectionKind", () => {
  it("normalizes wire kinds", () => {
    expect(toMongoCollectionKind("view")).toBe("view");
    expect(toMongoCollectionKind("timeseries")).toBe("timeseries");
    expect(toMongoCollectionKind("bucket")).toBe("collection");
    expect(toMongoCollectionKind(undefined)).toBe("collection");
  });
});

describe("mongo shell previews", () => {
  it("preserves identifier whitespace in rename preview", () => {
    expect(mongoRenameCollectionPreview("app", " users ", " renamed ")).toBe('db.getSiblingDB("app").getCollection(" users ").renameCollection(" renamed ")');
  });

  it("builds drop previews with database scope", () => {
    expect(mongoDropCollectionPreview("app", "users")).toBe('db.getSiblingDB("app").getCollection("users").drop()');
    expect(mongoDropIndexPreview("app", "users", "idx_name")).toBe('db.getSiblingDB("app").getCollection("users").dropIndex("idx_name")');
    expect(mongoDropAllIndexesPreview("app", "users")).toBe('db.getSiblingDB("app").getCollection("users").dropIndexes()');
  });
});
