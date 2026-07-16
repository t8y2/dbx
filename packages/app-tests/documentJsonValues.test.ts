import assert from "node:assert/strict";
import { test } from "vitest";
import { documentStoreValueForGrid, parseDocumentStoreInputValue, serializeDocumentStoreId, stringifyDocumentStoreValue } from "../../apps/desktop/src/lib/app/documentJsonValues.ts";

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
