import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  buildDocumentFilterCondition,
  buildElasticsearchQueryFromRules,
  combineDocumentFilterConditions,
  currentDocumentFilterJson,
  documentStoreProviderFor,
  elasticsearchQueryTypeOptions,
  elasticsearchSearchBodyFromDocumentQuery,
  elasticsearchStructuredFilter,
  type DocumentFilterRule,
} from "../../apps/desktop/src/lib/app/documentStoreProvider.ts";

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
  assert.equal(mongo.queryPreview({ collection: "orders", filterJson: '{"snowflake":{"$numberLong":"9007199254740993"}}', sortJson: undefined, skip: 0, limit: 100 }), 'db.getCollection("orders").find({"snowflake":NumberLong("9007199254740993")}).skip(0).limit(100)');
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

test("preserves MongoDB int64 document filter values", () => {
  const id = "2048938405781032962";
  const firstUnsafeInteger = "9007199254740993";
  assert.deepEqual(buildDocumentFilterCondition(rule({ fieldName: "processInfoId", rawValue: id }), { kind: "mongodb" }), {
    processInfoId: { $numberLong: id },
  });
  assert.deepEqual(buildDocumentFilterCondition(rule({ fieldName: "snowflake", rawValue: firstUnsafeInteger }), { kind: "mongodb" }), {
    snowflake: { $numberLong: firstUnsafeInteger },
  });
  assert.deepEqual(buildDocumentFilterCondition(rule({ fieldName: "processInfoId", mode: "greater-than", rawValue: id }), { kind: "mongodb" }), {
    processInfoId: { $gt: { $numberLong: id } },
  });
  assert.deepEqual(buildDocumentFilterCondition(rule({ fieldName: "processInfoId", mode: "like", rawValue: id }), { kind: "mongodb" }), {
    processInfoId: { $regex: id, $options: "i" },
  });
  assert.deepEqual(buildDocumentFilterCondition(rule({ fieldName: "processInfoId", rawValue: `"${id}"` }), { kind: "mongodb" }), {
    processInfoId: id,
  });
  assert.equal(currentDocumentFilterJson(`{processInfoId:${id}}`, null, "mongodb"), JSON.stringify({ processInfoId: { $numberLong: id } }));
  assert.equal(currentDocumentFilterJson("", { processInfoId: { $numberLong: id } }, "mongodb"), JSON.stringify({ processInfoId: { $numberLong: id } }));
});

test("keeps unsafe standalone document filter integers precise outside MongoDB", () => {
  assert.deepEqual(buildDocumentFilterCondition(rule({ fieldName: "processInfoId", rawValue: "2048938405781032962" })), {
    processInfoId: "2048938405781032962",
  });
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

test("builds native Elasticsearch bool queries from visual rules", () => {
  const query = buildElasticsearchQueryFromRules([
    rule({ fieldName: "customer_name", rawValue: "Customer", elasticsearchClause: "must", elasticsearchQueryType: "match" }),
    rule({ fieldName: "amount", rawValue: "500", elasticsearchClause: "filter", elasticsearchQueryType: "range_gte" }),
    rule({ fieldName: "status", rawValue: "cancelled", elasticsearchClause: "must_not", elasticsearchQueryType: "term" }),
    rule({ fieldName: "note", rawValue: "", elasticsearchClause: "should", elasticsearchQueryType: "exists" }),
  ]);

  assert.deepEqual(query, {
    bool: {
      must: [{ match: { customer_name: "Customer" } }],
      filter: [{ range: { amount: { gte: 500 } } }],
      must_not: [{ term: { status: "cancelled" } }],
      should: [{ exists: { field: "note" } }],
      minimum_should_match: 1,
    },
  });

  const body = elasticsearchSearchBodyFromDocumentQuery({
    filterJson: currentDocumentFilterJson("", elasticsearchStructuredFilter(query), "elasticsearch"),
    skip: 0,
    limit: 25,
  });
  assert.deepEqual(body.query, query);
});

test("offers Elasticsearch query types based on mapping field type", () => {
  assert.deepEqual(elasticsearchQueryTypeOptions("text"), ["match", "match_phrase", "term", "wildcard", "exists"]);
  assert.deepEqual(elasticsearchQueryTypeOptions("keyword"), ["term", "terms", "wildcard", "exists"]);
  assert.ok(elasticsearchQueryTypeOptions("double").includes("range_gte"));
  assert.deepEqual(elasticsearchQueryTypeOptions("boolean"), ["term", "exists"]);
});

test("builds wildcard queries compatible with Elasticsearch 7.x", () => {
  assert.deepEqual(buildElasticsearchQueryFromRules([rule({ fieldName: "sku", rawValue: "DBX-*", elasticsearchQueryType: "wildcard" })]), {
    bool: { filter: [{ wildcard: { sku: "DBX-*" } }] },
  });
});
