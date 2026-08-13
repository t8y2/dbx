import { describe, expect, it } from "vitest";
import {
  buildMongoCreateIndexRequest,
  isProtectedMongoIndex,
  isRenamableMongoCollection,
  mongoCollectionKindFromNode,
  mongoCollectionTableTypeFromNode,
  mongoCreateIndexPreview,
  mongoDropCollectionPreview,
  mongoDropAllIndexesPreview,
  mongoDropIndexFailureCount,
  mongoDropIndexPreview,
  mongoIndexKeyLabel,
  mongoRenameCollectionPreview,
  toMongoCollectionKind,
  toMongoIndexRow,
  type MongoCreateIndexForm,
} from "../mongoCollectionMutation";

function indexForm(fields: MongoCreateIndexForm["fields"], options: Partial<Omit<MongoCreateIndexForm, "fields">> = {}): MongoCreateIndexForm {
  return { name: "", unique: false, sparse: false, expireAfterSeconds: "", partialFilterExpression: "", background: false, bucketSize: "", ...options, fields };
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

  it("emits TTL and partial-filter options in a stable order", () => {
    const request = buildMongoCreateIndexRequest(
      indexForm([{ id: 1, path: "createdAt", type: "1" }], {
        name: "ttl_idx",
        unique: true,
        sparse: true,
        expireAfterSeconds: "3600",
        partialFilterExpression: '{"archived":false}',
      }),
    );

    expect(request).toEqual({
      valid: true,
      keysJson: '{"createdAt":1}',
      optionsJson: '{"name":"ttl_idx","unique":true,"sparse":true,"expireAfterSeconds":3600,"partialFilterExpression":{"archived":false}}',
    });
  });

  it("keeps a zero-second TTL distinct from an empty box", () => {
    const withZero = buildMongoCreateIndexRequest(indexForm([{ id: 1, path: "createdAt", type: "1" }], { expireAfterSeconds: "0" }));
    expect(withZero).toEqual({ valid: true, keysJson: '{"createdAt":1}', optionsJson: '{"expireAfterSeconds":0}' });

    const withBlank = buildMongoCreateIndexRequest(indexForm([{ id: 1, path: "createdAt", type: "1" }], { expireAfterSeconds: "   " }));
    expect(withBlank).toEqual({ valid: true, keysJson: '{"createdAt":1}', optionsJson: undefined });
  });

  it("passes legacy options through only when enabled", () => {
    const request = buildMongoCreateIndexRequest(indexForm([{ id: 1, path: "email", type: "1" }], { background: true, bucketSize: "10" }));
    expect(request).toEqual({ valid: true, keysJson: '{"email":1}', optionsJson: '{"background":true,"bucketSize":10}' });
  });

  it("rejects a non-numeric TTL, a bad bucket size, and a non-object filter", () => {
    expect(buildMongoCreateIndexRequest(indexForm([{ id: 1, path: "a", type: "1" }], { expireAfterSeconds: "-5" }))).toEqual({ valid: false, error: "ttl-invalid" });
    expect(buildMongoCreateIndexRequest(indexForm([{ id: 1, path: "a", type: "1" }], { expireAfterSeconds: "1.5" }))).toEqual({ valid: false, error: "ttl-invalid" });
    expect(buildMongoCreateIndexRequest(indexForm([{ id: 1, path: "a", type: "1" }], { bucketSize: "abc" }))).toEqual({ valid: false, error: "bucket-size-invalid" });
    expect(buildMongoCreateIndexRequest(indexForm([{ id: 1, path: "a", type: "1" }], { partialFilterExpression: "{not valid" }))).toEqual({ valid: false, error: "filter-invalid" });
    expect(buildMongoCreateIndexRequest(indexForm([{ id: 1, path: "a", type: "1" }], { partialFilterExpression: "[1,2]" }))).toEqual({ valid: false, error: "filter-invalid" });
  });

  it("reports a missing field before a malformed option", () => {
    expect(buildMongoCreateIndexRequest(indexForm([{ id: 1, path: "", type: "1" }], { expireAfterSeconds: "nope" }))).toEqual({ valid: false, error: "field-required" });
  });
});

describe("mongoIndexKeyLabel", () => {
  it("maps sort directions to readable labels and passes other types through", () => {
    expect(mongoIndexKeyLabel(1)).toBe("ASC");
    expect(mongoIndexKeyLabel("1")).toBe("ASC");
    expect(mongoIndexKeyLabel(-1)).toBe("DESC");
    expect(mongoIndexKeyLabel("-1")).toBe("DESC");
    expect(mongoIndexKeyLabel("text")).toBe("text");
    expect(mongoIndexKeyLabel(undefined)).toBe("");
  });
});

describe("toMongoIndexRow", () => {
  it("describes compound keys from a spec with directions", () => {
    expect(
      toMongoIndexRow({
        name: "account_created",
        keys: [
          { field: "account", direction: "1" },
          { field: "createTime", direction: "-1" },
        ],
      }),
    ).toEqual({
      name: "account_created",
      keys: "account ASC, createTime DESC",
      isUnique: false,
      isProtected: false,
      isSparse: false,
      expireAfterSeconds: undefined,
      partialFilterExpression: undefined,
      background: false,
      bucketSize: undefined,
      hidden: false,
      propertiesComplete: true,
      extraOptions: undefined,
    });
  });

  it("keeps non-numeric directions literal", () => {
    expect(
      toMongoIndexRow({
        name: "content_text",
        keys: [{ field: "content", direction: "text" }],
      }).keys,
    ).toBe("content text");
  });

  it("maps spec properties and flags the default index as protected", () => {
    const row = toMongoIndexRow({
      name: "_id_",
      keys: [{ field: "_id", direction: "1" }],
      is_unique: true,
      is_primary: true,
      is_sparse: true,
      expire_after_seconds: 3600,
      partial_filter_expression: '{"archived":false}',
      background: true,
      bucket_size: 32,
      hidden: true,
      properties_complete: true,
      extra_options: '{"collation":{"locale":"en"}}',
    });

    expect(row.isProtected).toBe(true);
    expect(row.isSparse).toBe(true);
    expect(row.expireAfterSeconds).toBe(3600);
    expect(row.partialFilterExpression).toBe('{"archived":false}');
    expect(row.background).toBe(true);
    expect(row.bucketSize).toBe(32);
    expect(row.hidden).toBe(true);
    expect(row.propertiesComplete).toBe(true);
    expect(row.extraOptions).toBe('{"collation":{"locale":"en"}}');
  });

  it("exposes the Legacy Agent's incomplete property set", () => {
    const row = toMongoIndexRow({ name: "email_1", keys: [{ field: "email", direction: "1" }], properties_complete: false });

    expect(row.propertiesComplete).toBe(false);
    expect(row.isSparse).toBe(false);
    expect(row.expireAfterSeconds).toBeUndefined();
  });
});
