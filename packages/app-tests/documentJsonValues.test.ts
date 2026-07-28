import assert from "node:assert/strict";
import { test } from "vitest";
import {
  documentStoreIdentityEquals,
  documentStoreValueForGrid,
  isDocumentStoreIdentityField,
  normalizeDocumentStoreRouting,
  parseDocumentStoreInputValue,
  parseDocumentStoreJsonDocument,
  documentStoreIdsEqual,
  planDocumentStoreIdentityMigration,
  prepareDocumentStoreWriteDocument,
  resolveDocumentStoreWriteRouting,
  serializeDocumentStoreId,
  stringifyDocumentStoreValue,
} from "../../apps/desktop/src/lib/app/documentJsonValues.ts";

test("keeps Elasticsearch long values as native numeric JSON without rounding", () => {
  const value = parseDocumentStoreInputValue("2018551659033767937", "elasticsearch");

  assert.equal(documentStoreValueForGrid(value, "elasticsearch"), "2018551659033767937");
  assert.equal(stringifyDocumentStoreValue({ id: value }, "elasticsearch"), '{"id":2018551659033767937}');
});

test("keeps Elasticsearch string ids distinct from numeric long values", () => {
  const value = parseDocumentStoreInputValue('"2018551659033767937"', "elasticsearch");

  assert.equal(value, "2018551659033767937");
  assert.equal(serializeDocumentStoreId("orders/2018551659033767937", "elasticsearch"), "orders/2018551659033767937");
  assert.equal(stringifyDocumentStoreValue({ id: value }, "elasticsearch"), '{"id":"2018551659033767937"}');
});

test("retains MongoDB Extended JSON parsing for int64 fields", () => {
  const value = parseDocumentStoreInputValue("2018551659033767937", "mongodb");

  assert.deepEqual(value, { $numberLong: "2018551659033767937" });
  assert.equal(serializeDocumentStoreId("2018551659033767937", "mongodb"), '__dbx_mongo_string_id__"2018551659033767937"');
  assert.equal(stringifyDocumentStoreValue({ id: value }, "mongodb"), '{"id":{"$numberLong":"2018551659033767937"}}');
});

test("does not reinterpret Mongo-compatible objects stored in Elasticsearch", () => {
  const value = parseDocumentStoreInputValue('{"$numberLong":"2018551659033767937"}', "elasticsearch");

  assert.deepEqual(value, { $numberLong: "2018551659033767937" });
  assert.equal(stringifyDocumentStoreValue({ legacy: value }, "elasticsearch"), '{"legacy":{"$numberLong":"2018551659033767937"}}');
});

test("parses whole MongoDB document JSON with extended types and large ints", () => {
  const parsed = parseDocumentStoreJsonDocument(
    `{
      "_id": {"$oid": "6743e4bfa3f6f84bc3fff6c8"},
      "createdAt": {"$date": "2026-06-10T13:59:31.287Z"},
      "amount": 2018551659033767937,
      "nested": {"score": 42}
    }`,
    "mongodb",
  );

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.document, {
    _id: { $oid: "6743e4bfa3f6f84bc3fff6c8" },
    createdAt: { $date: "2026-06-10T13:59:31.287Z" },
    amount: { $numberLong: "2018551659033767937" },
    nested: { score: 42 },
  });
});

test("parses whole Elasticsearch document JSON while preserving large numbers", () => {
  const parsed = parseDocumentStoreJsonDocument('{"id":2018551659033767937,"name":"Ada"}', "elasticsearch");

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(documentStoreValueForGrid(parsed.document.id, "elasticsearch"), "2018551659033767937");
  assert.equal(stringifyDocumentStoreValue(parsed.document, "elasticsearch"), '{"id":2018551659033767937,"name":"Ada"}');
});

test("rejects invalid whole document JSON payloads", () => {
  assert.deepEqual(parseDocumentStoreJsonDocument("", "mongodb"), { ok: false, error: "empty" });
  assert.deepEqual(parseDocumentStoreJsonDocument("{", "mongodb"), { ok: false, error: "invalid" });
  assert.deepEqual(parseDocumentStoreJsonDocument("[1,2]", "elasticsearch"), { ok: false, error: "not-object" });
  assert.deepEqual(parseDocumentStoreJsonDocument("null", "mongodb"), { ok: false, error: "not-object" });
  assert.deepEqual(parseDocumentStoreJsonDocument('{"amount":9223372036854775808}', "mongodb"), { ok: false, error: "unsupported-number" });
  assert.deepEqual(
    parseDocumentStoreJsonDocument('{"name":"a","age":1,"name":"b"}', "mongodb"),
    { ok: false, error: "duplicate-key", field: "name" },
  );
});

test("prepareDocumentStoreWriteDocument always strips ES routing; update strips _id", () => {
  const mongo = prepareDocumentStoreWriteDocument(
    {
      _id: { $oid: "6743e4bfa3f6f84bc3fff6c8" },
      name: "Ada",
    },
    {
      kind: "mongodb",
      mode: "update",
    },
  );
  assert.deepEqual(mongo, { name: "Ada" });

  const esUpdate = prepareDocumentStoreWriteDocument(
    {
      _id: "doc-1",
      _routing: "shard-a",
      title: "hello",
    },
    {
      kind: "elasticsearch",
      mode: "update",
    },
  );
  assert.deepEqual(esUpdate, { title: "hello" });

  const insertKeepsId = prepareDocumentStoreWriteDocument(
    {
      _id: { $oid: "6743e4bfa3f6f84bc3fff6c8" },
      name: "Ada",
    },
    {
      kind: "mongodb",
      mode: "insert",
    },
  );
  assert.deepEqual(insertKeepsId, {
    _id: { $oid: "6743e4bfa3f6f84bc3fff6c8" },
    name: "Ada",
  });

  // ES insert also strips _routing — routing is always an API argument.
  const esInsert = prepareDocumentStoreWriteDocument(
    {
      _routing: "tenant-1",
      title: "hello",
    },
    {
      kind: "elasticsearch",
      mode: "insert",
    },
  );
  assert.deepEqual(esInsert, { title: "hello" });
});

test("documentStoreIdsEqual falls back safely for unstringifiable values", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(documentStoreIdsEqual(circular, circular, "mongodb"), true);
  assert.doesNotThrow(() => documentStoreIdsEqual({ value: 1n }, { value: 2n }, "mongodb"));
});

test("isDocumentStoreIdentityField covers _id and ES routing only", () => {
  assert.equal(isDocumentStoreIdentityField("mongodb", "_id"), true);
  assert.equal(isDocumentStoreIdentityField("mongodb", "_routing"), false);
  assert.equal(isDocumentStoreIdentityField("elasticsearch", "_id"), true);
  assert.equal(isDocumentStoreIdentityField("elasticsearch", "_routing"), true);
  assert.equal(isDocumentStoreIdentityField("elasticsearch", "title"), false);
});

test("normalizeDocumentStoreRouting trims empty values to undefined", () => {
  assert.equal(normalizeDocumentStoreRouting(" tenant-a "), "tenant-a");
  assert.equal(normalizeDocumentStoreRouting(""), undefined);
  assert.equal(normalizeDocumentStoreRouting("   "), undefined);
  assert.equal(normalizeDocumentStoreRouting(null), undefined);
  assert.equal(normalizeDocumentStoreRouting(undefined), undefined);
  assert.equal(normalizeDocumentStoreRouting(42), "42");
});

test("resolveDocumentStoreWriteRouting distinguishes omit from explicit clear", () => {
  assert.equal(resolveDocumentStoreWriteRouting({ name: "Ada" }, "shard-a"), "shard-a");
  assert.equal(resolveDocumentStoreWriteRouting({ _routing: "shard-b", name: "Ada" }, "shard-a"), "shard-b");
  assert.equal(resolveDocumentStoreWriteRouting({ _routing: "", name: "Ada" }, "shard-a"), undefined);
  assert.equal(resolveDocumentStoreWriteRouting({ _routing: null, name: "Ada" }, "shard-a"), undefined);
  assert.equal(resolveDocumentStoreWriteRouting({ _routing: "  ", name: "Ada" }, "shard-a"), undefined);
});

test("planDocumentStoreIdentityMigration covers owner review ES routing cases", () => {
  // Same id + routing → replace body only.
  assert.deepEqual(
    planDocumentStoreIdentityMigration({
      write: { id: "doc-1", routing: "shard-a" },
      current: { id: "doc-1", routing: "shard-a" },
    }),
    { action: "replace", writeId: "doc-1", writeRouting: "shard-a" },
  );

  // Same _id, routing A→B: rekey write(B) delete(A).
  assert.deepEqual(
    planDocumentStoreIdentityMigration({
      write: { id: "doc-1", routing: "shard-b" },
      current: { id: "doc-1", routing: "shard-a" },
    }),
    {
      action: "rekey",
      writeId: "doc-1",
      writeRouting: "shard-b",
      deleteId: "doc-1",
      deleteRouting: "shard-a",
    },
  );

  // Same _id, clear routing.
  assert.deepEqual(
    planDocumentStoreIdentityMigration({
      write: { id: "doc-1", routing: undefined },
      current: { id: "doc-1", routing: "shard-a" },
    }),
    {
      action: "rekey",
      writeId: "doc-1",
      writeRouting: undefined,
      deleteId: "doc-1",
      deleteRouting: "shard-a",
    },
  );

  // Both _id and routing change.
  assert.deepEqual(
    planDocumentStoreIdentityMigration({
      write: { id: "doc-2", routing: "shard-b" },
      current: { id: "doc-1", routing: "shard-a" },
    }),
    {
      action: "rekey",
      writeId: "doc-2",
      writeRouting: "shard-b",
      deleteId: "doc-1",
      deleteRouting: "shard-a",
    },
  );

  // Id-only change, same routing.
  assert.deepEqual(
    planDocumentStoreIdentityMigration({
      write: { id: "doc-2", routing: "shard-a" },
      current: { id: "doc-1", routing: "shard-a" },
    }),
    {
      action: "rekey",
      writeId: "doc-2",
      writeRouting: "shard-a",
      deleteId: "doc-1",
      deleteRouting: "shard-a",
    },
  );

  // Same identity never produces rekey (no self-delete).
  const same = planDocumentStoreIdentityMigration({
    write: { id: "doc-1", routing: "shard-a" },
    current: { id: "doc-1", routing: "shard-a" },
  });
  assert.equal(same.action, "replace");
  assert.equal(documentStoreIdentityEquals({ id: "doc-1", routing: "shard-a" }, { id: "doc-1", routing: "shard-a" }), true);
});
