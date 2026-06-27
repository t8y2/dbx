import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildDocumentFilterCondition, combineDocumentFilterConditions, currentDocumentFilterJson, documentStoreProviderFor, elasticsearchSearchBodyFromDocumentQuery, type DocumentFilterRule } from "../../apps/desktop/src/lib/documentStoreProvider.ts";

function rule(patch: Partial<DocumentFilterRule>): DocumentFilterRule {
  return {
    id: "rule-1",
    fieldName: "city",
    mode: "equals",
    rawValue: "长治",
    conjunction: "AND",
    ...patch,
  };
}

test("selects MongoDB and Elasticsearch document store providers", () => {
  assert.equal(documentStoreProviderFor("mongodb").kind, "mongodb");
  assert.equal(documentStoreProviderFor("elasticsearch").kind, "elasticsearch");
});

test("providers build store-specific query previews", () => {
  const t = ((key: string, params?: Record<string, unknown>) => `${key}:${params?.count ?? ""}`) as never;
  const mongo = documentStoreProviderFor("mongodb");
  const elasticsearch = documentStoreProviderFor("elasticsearch");

  assert.equal(mongo.documentsLabel({ total: 7, t }), "mongo.documents:7");
  assert.equal(mongo.queryPreview({ collection: "orders", filterJson: '{"city":"长治"}', sortJson: '{"createdAt":-1}', skip: 20, limit: 10 }), 'db.getCollection("orders").find({"city":"长治"}).sort({"createdAt":-1}).skip(20).limit(10)');
  assert.equal(mongo.queryPreview({ collection: "order-events", filterJson: '{"city":"长治"}', sortJson: undefined, skip: 0, limit: 100 }), 'db.getCollection("order-events").find({"city":"长治"}).skip(0).limit(100)');
  assert.equal(elasticsearch.documentsLabel({ total: 7, t }), "Documents");
  assert.equal(elasticsearch.filterInputLabel, "filter");
  assert.equal(
    elasticsearch.queryPreview({ collection: "orders", filterJson: '{"city":"长治"}', sortJson: '{"createdAt":-1}', skip: 20, limit: 10 }),
    ["POST /orders/_search", "{", '  "from": 20,', '  "size": 10,', '  "query": {', '    "term": {', '      "city": "长治"', "    }", "  },", '  "sort": [', "    {", '      "createdAt": {', '        "order": "desc"', "      }", "    }", "  ]", "}"].join("\n"),
  );
});

test("builds reusable document filter conditions", () => {
  assert.deepEqual(buildDocumentFilterCondition(rule({})), { city: "长治" });
  assert.deepEqual(buildDocumentFilterCondition(rule({ mode: "not-like", rawValue: "test" })), {
    city: { $not: { $regex: "test", $options: "i" } },
  });
  assert.deepEqual(buildDocumentFilterCondition(rule({ mode: "is-not-null", rawValue: "" })), { city: { $ne: null } });
});

test("combines manual and structured document filters", () => {
  const structured = combineDocumentFilterConditions([{ city: "长治" }, { status: "active" }], [rule({}), rule({ fieldName: "status", rawValue: "active", conjunction: "OR" })]);

  assert.deepEqual(structured, { $or: [{ city: "长治" }, { status: "active" }] });
  assert.equal(currentDocumentFilterJson('{"tenant":"a"}', structured), JSON.stringify({ $and: [{ tenant: "a" }, structured] }));
});

test("translates document filters to Elasticsearch search body previews", () => {
  assert.deepEqual(
    elasticsearchSearchBodyFromDocumentQuery({
      filterJson: JSON.stringify({ $and: [{ city: { $ne: "上海" } }, { age: { $gt: 18, $lte: 60 } }] }),
      sortJson: '{"createdAt":-1}',
      skip: 0,
      limit: 50,
    }),
    {
      from: 0,
      size: 50,
      query: {
        bool: {
          filter: [{ bool: { must_not: [{ term: { city: "上海" } }] } }, { range: { age: { gt: 18, lte: 60 } } }],
        },
      },
      sort: [{ createdAt: { order: "desc" } }],
    },
  );
});
