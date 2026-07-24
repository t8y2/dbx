import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  arrayObjectAncestorPathForDocumentField,
  buildDocumentFilterCondition,
  buildElasticsearchQueryFromRules,
  combineDocumentFilterConditions,
  currentDocumentFilterJson,
  documentFieldPathOptionsFromDocuments,
  documentFieldPathTreeFromDocuments,
  documentStoreProviderFor,
  elasticsearchQueryTypeOptions,
  elasticsearchSearchBodyFromDocumentQuery,
  elasticsearchStructuredFilter,
  flattenDocumentFieldPathTree,
  formatDocumentQueryInput,
  searchDocumentFieldPathTree,
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
  assert.deepEqual(buildDocumentFilterCondition(rule({ mode: "like", rawValue: "a.b[0]*" })), {
    city: { $regex: "a\\.b\\[0\\]\\*", $options: "i" },
  });
  assert.deepEqual(buildDocumentFilterCondition(rule({ mode: "not-like", rawValue: "test?" })), {
    city: { $not: { $regex: "test\\?", $options: "i" } },
  });
  assert.deepEqual(buildDocumentFilterCondition(rule({ mode: "is-not-null", rawValue: "" })), { city: { $ne: null } });
});

test("preserves Extended JSON types for MongoDB structured filters", () => {
  assert.deepEqual(
    buildDocumentFilterCondition(rule({ fieldName: "profile.ownerId", rawValue: "507f1f77bcf86cd799439011" }), {
      kind: "mongodb",
      sampleValue: { $oid: "507f1f77bcf86cd799439011" },
    }),
    { "profile.ownerId": { $oid: "507f1f77bcf86cd799439011" } },
  );
  assert.deepEqual(
    buildDocumentFilterCondition(rule({ fieldName: "profile.createdAt", rawValue: "2026-07-13T00:00:00Z" }), {
      kind: "mongodb",
      sampleValue: { $date: "2025-01-01T00:00:00Z" },
    }),
    { "profile.createdAt": { $date: "2026-07-13T00:00:00Z" } },
  );
  assert.deepEqual(
    buildDocumentFilterCondition(rule({ fieldName: "ownerIds", rawValue: "507f1f77bcf86cd799439013" }), {
      kind: "mongodb",
      sampleValue: [{ $oid: "507f1f77bcf86cd799439011" }, null, { $oid: "507f1f77bcf86cd799439012" }],
    }),
    { ownerIds: { $oid: "507f1f77bcf86cd799439013" } },
  );
  assert.deepEqual(
    buildDocumentFilterCondition(rule({ fieldName: "eventDates", rawValue: "2026-07-13T00:00:00Z" }), {
      kind: "mongodb",
      sampleValue: [{ $date: "2025-01-01T00:00:00Z" }, { $date: { $numberLong: "1752364800000" } }],
    }),
    { eventDates: { $date: "2026-07-13T00:00:00Z" } },
  );
  assert.deepEqual(
    buildDocumentFilterCondition(rule({ fieldName: "mixed", rawValue: "507f1f77bcf86cd799439013" }), {
      kind: "mongodb",
      sampleValue: [{ $oid: "507f1f77bcf86cd799439011" }, "plain-string"],
    }),
    { mixed: "507f1f77bcf86cd799439013" },
  );
});

test("extracts nested document field paths for structured filters", () => {
  assert.deepEqual(
    documentFieldPathOptionsFromDocuments([
      { _id: "1", profile: { city: "上海", address: { zip: 200000 } }, tags: ["a"] },
      { _id: "2", status: "active", profile: { city: "北京" }, audit: [{ by: "ops" }] },
    ]),
    ["_id", "profile", "profile.city", "profile.address", "profile.address.zip", "tags", "status", "audit", "audit.by"],
  );
});

test("treats BSON Extended JSON wrappers as scalar document fields", () => {
  const tree = documentFieldPathTreeFromDocuments([
    {
      _id: { $oid: "507f1f77bcf86cd799439011" },
      ownerId: { $oid: "507f1f77bcf86cd799439012" },
      createdAt: { $date: { $numberLong: "1752364800000" } },
      sequence: { $numberLong: "9007199254740993" },
      encoded: { $binary: { base64: "AQID", subType: "00" }, $type: "00" },
      profile: { name: "Ada" },
    },
  ]);
  const flattened = flattenDocumentFieldPathTree(tree);

  assert.deepEqual(
    flattened.map((node) => node.path),
    ["_id", "ownerId", "createdAt", "sequence", "encoded", "profile", "profile.name"],
  );
  assert.equal(flattened.find((node) => node.path === "ownerId")?.kind, "scalar");
  assert.equal(flattened.find((node) => node.path === "createdAt")?.kind, "scalar");
  assert.equal(flattened.find((node) => node.path === "sequence")?.kind, "scalar");
  assert.equal(flattened.find((node) => node.path === "encoded")?.kind, "scalar");
});

test("builds hierarchical document field path tree for array objects", () => {
  const tree = documentFieldPathTreeFromDocuments([{ _id: "1", orders: [{ sku: "A", qty: 2 }], batches: [[{ lot: "L-1" }]], tags: ["a"], profile: { address: { zip: 1 } } }]);
  const flattened = flattenDocumentFieldPathTree(tree);
  const orders = tree.find((node) => node.path === "orders");
  const batches = tree.find((node) => node.path === "batches");
  const sku = flattened.find((node) => node.path === "orders.sku");

  assert.equal(orders?.kind, "array-object");
  assert.equal(batches?.kind, "array-object");
  assert.equal(orders?.label, "orders[]");
  assert.equal(sku?.path, "orders.sku");
  assert.equal(sku?.displayPath, "orders[] > sku");
  assert.deepEqual(sku?.sampleValue, "A");
  assert.equal(arrayObjectAncestorPathForDocumentField(tree, "orders.sku"), "orders");
  assert.equal(arrayObjectAncestorPathForDocumentField(tree, "profile.address.zip"), null);
  assert.deepEqual(
    flattened.map((node) => node.path),
    ["_id", "orders", "orders.sku", "orders.qty", "batches", "batches.lot", "tags", "profile", "profile.address", "profile.address.zip"],
  );
});

test("excludes BSON Extended JSON wrappers from array document field paths", () => {
  const tree = documentFieldPathTreeFromDocuments([
    {
      _id: "1",
      timestamps: [{ $date: { $numberLong: "1752364800000" } }, { $date: { $numberLong: "1752451200000" } }],
      ownerIds: [{ $oid: "507f1f77bcf86cd799439011" }],
      sequences: [{ $numberLong: "9007199254740993" }],
      nestedDates: [[{ $date: { $numberLong: "1752364800000" } }]],
      events: [{ at: { $date: { $numberLong: "1752364800000" } }, by: "ops" }, { $date: { $numberLong: "1752451200000" } }],
    },
  ]);
  const flattened = flattenDocumentFieldPathTree(tree);

  assert.deepEqual(
    flattened.map((node) => node.path),
    ["_id", "timestamps", "ownerIds", "sequences", "nestedDates", "events", "events.at", "events.by"],
  );
  assert.equal(flattened.find((node) => node.path === "timestamps")?.kind, "array");
  assert.equal(flattened.find((node) => node.path === "ownerIds")?.kind, "array");
  assert.equal(flattened.find((node) => node.path === "sequences")?.kind, "array");
  assert.equal(flattened.find((node) => node.path === "nestedDates")?.kind, "array");
  assert.equal(flattened.find((node) => node.path === "events")?.kind, "array-object");
  assert.equal(flattened.find((node) => node.path === "events.at")?.kind, "scalar");
});

test("searches nested document field paths", () => {
  const tree = documentFieldPathTreeFromDocuments([{ profile: { address: { zip: 200000 }, city: "Shanghai" }, orders: [{ sku: "A" }] }]);
  assert.deepEqual(
    searchDocumentFieldPathTree(tree, "address").map((node) => node.path),
    ["profile.address", "profile.address.zip"],
  );
  assert.deepEqual(
    searchDocumentFieldPathTree(tree, "orders[] > sku").map((node) => node.path),
    ["orders.sku"],
  );
});

test("uses elemMatch only for AND conditions on the same array object", () => {
  const conditions = [{ "orders.sku": "A" }, { "orders.qty": 2 }];
  const rules = [rule({ fieldName: "orders.sku" }), rule({ fieldName: "orders.qty", rawValue: "2", conjunction: "AND" })];
  assert.deepEqual(combineDocumentFilterConditions(conditions, rules, ["orders", "orders"]), {
    orders: { $elemMatch: { $and: [{ sku: "A" }, { qty: 2 }] } },
  });
  assert.deepEqual(combineDocumentFilterConditions([{ status: "active" }, ...conditions], [rule({ fieldName: "status" }), ...rules], [null, "orders", "orders"]), {
    $and: [{ status: "active" }, { orders: { $elemMatch: { $and: [{ sku: "A" }, { qty: 2 }] } } }],
  });
  assert.deepEqual(combineDocumentFilterConditions(conditions, rules, ["orders", "lineItems"]), {
    $and: conditions,
  });
  assert.deepEqual(combineDocumentFilterConditions(conditions, [rules[0], rule({ fieldName: "orders.qty", rawValue: "2", conjunction: "OR" })], ["orders", "orders"]), {
    $or: conditions,
  });
});

test("formats document query object input", () => {
  assert.equal(formatDocumentQueryInput('{profile:{city:"上海"},status:"active"}', "mongodb"), ["{", '  "profile": {', '    "city": "上海"', "  },", '  "status": "active"', "}"].join("\n"));
});
test("normalizes Mongo shell syntax in manual document filters", () => {
  assert.equal(currentDocumentFilterJson("{id:NumberLong('144115205316939462')}", null, "mongodb"), JSON.stringify({ id: { $numberLong: "144115205316939462" } }));
  assert.equal(currentDocumentFilterJson("{owner:ObjectId('507f1f77bcf86cd799439011'),status:'active'}", null, "mongodb"), JSON.stringify({ owner: { $oid: "507f1f77bcf86cd799439011" }, status: "active" }));
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
