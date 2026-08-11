import { describe, expect, it } from "vitest";
import {
  buildMongoCreateIndexRequest,
  isCloneableMongoCollection,
  isProtectedMongoIndex,
  isRenamableMongoCollection,
  mongoCollectionKindFromNode,
  mongoCollectionTableTypeFromNode,
  mongoCloneCollectionPreview,
  mongoCreateIndexPreview,
  mongoDropCollectionPreview,
  mongoDropAllIndexesPreview,
  mongoDropIndexFailureCount,
  mongoDropIndexPreview,
  mongoRenameCollectionPreview,
  toMongoCollectionKind,
  type MongoCreateIndexForm,
} from "../mongoCollectionMutation";

function indexForm(fields: MongoCreateIndexForm["fields"], options: Partial<Omit<MongoCreateIndexForm, "fields">> = {}): MongoCreateIndexForm {
  return { name: "", unique: false, sparse: false, ...options, fields };
}

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

describe("isCloneableMongoCollection", () => {
  it("allows ordinary collections only", () => {
    expect(isCloneableMongoCollection("users")).toBe(true);
    expect(isCloneableMongoCollection("report_view", "view")).toBe(false);
    expect(isCloneableMongoCollection("metrics", "timeseries")).toBe(false);
    expect(isCloneableMongoCollection("system.users")).toBe(false);
  });
});

describe("mongoCollectionKindFromNode", () => {
  it("reads collectionKind from node meta without using SQL tableType", () => {
    expect(mongoCollectionKindFromNode({ meta: { collectionKind: "view" } })).toBe("view");
    expect(mongoCollectionKindFromNode({ meta: { collectionKind: "timeseries" } })).toBe("timeseries");
    expect(mongoCollectionKindFromNode({ meta: { collectionKind: "collection" } })).toBe("collection");
    expect(mongoCollectionKindFromNode({})).toBe("collection");
  });

  it("maps collection kinds to data-tab table types", () => {
    expect(mongoCollectionTableTypeFromNode({ meta: { collectionKind: "collection" } })).toBe("TABLE");
    expect(mongoCollectionTableTypeFromNode({ meta: { collectionKind: "view" } })).toBe("VIEW");
    expect(mongoCollectionTableTypeFromNode({ meta: { collectionKind: "timeseries" } })).toBe("TIMESERIES");
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

describe("isProtectedMongoIndex", () => {
  it("protects the default index by name or primary metadata", () => {
    expect(isProtectedMongoIndex({ name: "_id_", is_primary: false })).toBe(true);
    expect(isProtectedMongoIndex({ name: "unexpected", is_primary: true })).toBe(true);
    expect(isProtectedMongoIndex({ name: "email_1", is_primary: false })).toBe(false);
  });
});

describe("mongo shell previews", () => {
  it("preserves identifier whitespace in rename preview", () => {
    expect(mongoRenameCollectionPreview("app", " users ", " renamed ")).toBe('db.getSiblingDB("app").getCollection(" users ").renameCollection(" renamed ")');
  });

  it("describes the version-compatible clone primitives", () => {
    expect(mongoCloneCollectionPreview("app", " users ", " users_backup ")).toBe(
      "// DBX copies collection options, documents, and non-_id indexes.\n" +
        'db.getSiblingDB("app").createCollection(" users_backup ", /* source options */);\n' +
        'db.getSiblingDB("app").getCollection(" users ").find({}).forEach(function (document) { db.getSiblingDB("app").getCollection(" users_backup ").insertOne(document); });\n' +
        "// Recreate source indexes except the target's automatic _id index.",
    );
  });

  it("builds drop previews with database scope", () => {
    expect(mongoDropCollectionPreview("app", "users")).toBe('db.getSiblingDB("app").getCollection("users").drop()');
    expect(mongoDropIndexPreview("app", "users", "idx_name")).toBe('db.getSiblingDB("app").getCollection("users").dropIndex("idx_name")');
    expect(mongoDropAllIndexesPreview("app", "users")).toBe('db.getSiblingDB("app").getCollection("users").dropIndexes()');
  });

  it("counts per-index failures in partial batch results", () => {
    expect(mongoDropIndexFailureCount({})).toBe(0);
    expect(mongoDropIndexFailureCount({ failures: [{ name: "missing_1", message: "index not found" }] })).toBe(1);
  });

  it("builds a create-index request and shell preview from the visual form", () => {
    const request = buildMongoCreateIndexRequest(
      indexForm(
        [
          { id: 1, path: "email", type: "1" },
          { id: 2, path: "createdAt", type: "-1" },
        ],
        { name: "email_created_at", unique: true, sparse: true },
      ),
    );

    expect(request).toMatchObject({
      valid: true,
      keysJson: '{"email":1,"createdAt":-1}',
      optionsJson: '{"name":"email_created_at","unique":true,"sparse":true}',
    });
    if (!request.valid) throw new Error("expected valid index form");
    expect(mongoCreateIndexPreview("app", "users", request.keysJson, request.optionsJson)).toBe('db.getSiblingDB("app").getCollection("users").createIndex({"email":1,"createdAt":-1}, {"name":"email_created_at","unique":true,"sparse":true})');
  });

  it("keeps visual compound-field order, including integer-like names", () => {
    const request = buildMongoCreateIndexRequest(
      indexForm([
        { id: 1, path: "10", type: "1" },
        { id: 2, path: "2", type: "-1" },
      ]),
    );

    if (!request.valid) throw new Error("expected valid index form");
    expect(request.optionsJson).toBeUndefined();
    expect(mongoCreateIndexPreview("app", "events", request.keysJson, request.optionsJson)).toBe('db.getSiblingDB("app").getCollection("events").createIndex({"10":1,"2":-1})');
  });

  it("serializes MongoDB-specific key types without exposing JSON inputs", () => {
    const request = buildMongoCreateIndexRequest(
      indexForm([
        { id: 1, path: "content", type: "text" },
        { id: 2, path: "location", type: "2dsphere" },
      ]),
    );

    expect(request).toEqual({ valid: true, keysJson: '{"content":"text","location":"2dsphere"}', optionsJson: undefined });
  });

  it("requires every field and rejects duplicate field paths", () => {
    expect(buildMongoCreateIndexRequest(indexForm([]))).toEqual({ valid: false, error: "field-required" });
    expect(buildMongoCreateIndexRequest(indexForm([{ id: 1, path: "  ", type: "1" }]))).toEqual({ valid: false, error: "field-required" });
    expect(
      buildMongoCreateIndexRequest(
        indexForm([
          { id: 1, path: "email", type: "1" },
          { id: 2, path: "email", type: "-1" },
        ]),
      ),
    ).toEqual({ valid: false, error: "field-duplicate", field: "email" });
  });
});
