import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildElasticsearchCompletionItems, elasticsearchCompletionNeedsFields, flattenElasticsearchMappingFields, getElasticsearchCompletionContext, shouldAutoOpenElasticsearchCompletion } from "../../apps/desktop/src/lib/elasticsearch/elasticsearchCompletion.ts";
import { buildSqlCompletionItems } from "../../apps/desktop/src/lib/sql/sqlCompletion.ts";

const indices = ["orders", "order_items", "users"];
const fields = [
  { name: "city", dataType: "keyword" },
  { name: "status", dataType: "keyword" },
  { name: "createdAt", dataType: "date" },
  { name: "user.name", dataType: "text" },
];

function applyCompletion(text: string, cursor: number, label: string, extra: { fields?: typeof fields } = {}): string {
  const context = getElasticsearchCompletionContext(text, cursor);
  const item = buildElasticsearchCompletionItems(text, cursor, { indices, ...extra }).find((candidate) => candidate.label === label);
  assert.ok(item, `Expected completion item ${label}`);
  // Mirrors the editor: the auto-closed quote at the cursor is part of the
  // replaced range, and snippet fields expand to their placeholder text.
  const to = item.replaceClosingQuote && text[cursor] === item.replaceClosingQuote ? cursor + 1 : cursor;
  const insert = (item.apply ?? item.label).replace(/\$\{([^}]*)\}/g, "$1");
  return `${text.slice(0, context.from)}${insert}${text.slice(to)}`;
}

test("suggests Elasticsearch HTTP methods for empty and prefix input", () => {
  assert.deepEqual(
    buildElasticsearchCompletionItems("", 0).map((item) => item.label),
    ["GET", "POST", "PUT", "DELETE", "HEAD"],
  );

  const items = buildElasticsearchCompletionItems("po", 2);
  assert.equal(items.find((item) => item.label === "POST")?.apply, "POST /");
});

test("suggests Elasticsearch root endpoints", () => {
  const items = buildElasticsearchCompletionItems("GET /_", "GET /_".length);

  assert.ok(items.find((item) => item.label === "/_search"));
  assert.ok(items.find((item) => item.label === "/_cat/indices"));
  assert.ok(items.find((item) => item.label === "/_nodes/stats"));
  assert.ok(items.find((item) => item.label === "/_msearch"));
});

test("suggests methods and endpoints after comments and in later REST requests", () => {
  const commentedMethod = "# inspect node\nHE";
  assert.ok(buildElasticsearchCompletionItems(commentedMethod, commentedMethod.length).some((item) => item.label === "HEAD"));

  const secondRequest = "GET /_cluster/health\n\nGET /_no";
  assert.ok(buildElasticsearchCompletionItems(secondRequest, secondRequest.length).some((item) => item.label === "/_nodes/stats"));
});

test("suggests Elasticsearch index endpoints", () => {
  const items = buildElasticsearchCompletionItems("GET /orders/_", "GET /orders/_".length);

  assert.ok(items.find((item) => item.label === "_search"));
  assert.ok(items.find((item) => item.label === "_mapping"));
  assert.ok(items.find((item) => item.label === "_count"));
});

test("suggests Elasticsearch indices by prefix", () => {
  const items = buildElasticsearchCompletionItems("GET /ord", "GET /ord".length, { indices });

  assert.deepEqual(
    items.filter((item) => item.detail === "index").map((item) => item.label),
    ["orders", "order_items"],
  );
});

test("suggests Elasticsearch indices by case-insensitive ordered cross-segment match", () => {
  const text = "GET /MiM";
  const items = buildElasticsearchCompletionItems(text, text.length, {
    indices: ["my_index_misc_20260907", "my_index_logs_20260907"],
  });

  assert.deepEqual(
    items.filter((item) => item.detail === "index").map((item) => item.label),
    ["my_index_misc_20260907"],
  );
});

test("index completion preserves endpoint suffix after cursor", () => {
  const text = "GET /ord/_search";
  const cursor = "GET /ord".length;

  assert.equal(applyCompletion(text, cursor, "orders"), "GET /orders/_search");
});

test("suggests Elasticsearch JSON DSL keys and snippets", () => {
  const keyItems = buildElasticsearchCompletionItems('GET /orders/_search\n{\n  "qu', 'GET /orders/_search\n{\n  "qu'.length);
  assert.ok(keyItems.find((item) => item.label === '"query"'));

  const snippetItems = buildElasticsearchCompletionItems('GET /orders/_search\n{\n  "match_', 'GET /orders/_search\n{\n  "match_'.length);
  const matchAll = snippetItems.find((item) => item.label === "match_all");
  assert.ok(matchAll);
  assert.doesNotThrow(() => JSON.parse(`{${matchAll?.apply}}`));
});

test("Elasticsearch JSON key completion replaces the auto-closed quote", () => {
  const text = 'GET /orders/_search\n{\n  "query": {\n    "bool":{\n      "f"\n    }\n  }\n}';
  const cursor = text.indexOf('"f"') + 2;

  const context = getElasticsearchCompletionContext(text, cursor);
  assert.equal(context.replaceClosingQuote, '"');
  assert.equal(buildElasticsearchCompletionItems(text, cursor).find((item) => item.label === '"fields"')?.replaceClosingQuote, '"');

  const applied = applyCompletion(text, cursor, '"fields"');
  assert.ok(applied.includes('"fields": []'));
  assert.equal(applied.includes('""'), false);
});

test("Elasticsearch JSON keys bring their value brackets along", () => {
  const objectKey = 'GET /orders/_search\n{\n  "qu';
  assert.equal(applyCompletion(objectKey, objectKey.length, '"query"'), 'GET /orders/_search\n{\n  "query": {}');
  assert.equal(buildElasticsearchCompletionItems(objectKey, objectKey.length).find((item) => item.label === '"query"')?.applyAsSnippet, true);

  const arrayKey = 'GET /orders/_search\n{\n  "query": {\n    "bool": {\n      "mu';
  assert.ok(applyCompletion(arrayKey, arrayKey.length, '"must"').endsWith('"must": []'));

  const scalarKey = 'GET /orders/_search\n{\n  "si';
  assert.equal(applyCompletion(scalarKey, scalarKey.length, '"size"'), 'GET /orders/_search\n{\n  "size": ');
});

test("Elasticsearch query snippets provide term field and value placeholders", () => {
  const text = "GET /orders/_search\n{\n    te";
  assert.equal(getElasticsearchCompletionContext(text, text.length).mode, "json");
  const term = buildElasticsearchCompletionItems(text, text.length).find((item) => item.label === "term");

  assert.ok(term);
  assert.equal(term?.type, "snippet");
  assert.equal(applyCompletion(text, text.length, "term"), 'GET /orders/_search\n{\n    "term": {\n      "field": "value"\n    }');
  assert.match(term?.apply ?? "", /\$\{field\}/);
  assert.match(term?.apply ?? "", /\$\{value\}/);
});

test("Elasticsearch JSON keys keep the scaffold out when a separator already exists", () => {
  const text = 'GET /orders/_search\n{\n  "qu": {}';
  const cursor = 'GET /orders/_search\n{\n  "qu'.length;

  assert.equal(getElasticsearchCompletionContext(text, cursor).hasKeySeparator, true);
  assert.equal(applyCompletion(text, cursor, '"query"'), 'GET /orders/_search\n{\n  "query": {}');

  // The caret may also sit inside an existing key, past its own separator.
  const inside = 'GET /orders/_search\n{\n  "size": 10\n}';
  assert.equal(getElasticsearchCompletionContext(inside, inside.indexOf('"size"') + 3).hasKeySeparator, true);
});

test("Elasticsearch JSON slot survives comments and earlier requests", () => {
  const commented = 'GET /orders/_search\n# the "orders body\n{\n  "bo';
  assert.equal(getElasticsearchCompletionContext(commented, commented.length).jsonSlot, "key");

  const secondRequest = 'GET /orders/_search\n{\n  "query": {\n\nGET /users/_search\n{\n  "bo';
  assert.equal(getElasticsearchCompletionContext(secondRequest, secondRequest.length).jsonSlot, "key");
});

test("Elasticsearch JSON value slots are not completed as keys", () => {
  const text = 'GET /orders/_search\n{\n  "query": {\n    "bool": {\n      "must": [\n        "fi';
  const items = buildElasticsearchCompletionItems(text, text.length);

  assert.equal(getElasticsearchCompletionContext(text, text.length).jsonSlot, "value");
  assert.equal(items.find((item) => item.label === '"fields"')?.apply, '"fields"');
  assert.equal(
    items.some((item) => item.label === "bool"),
    false,
  );
});

test("Elasticsearch JSON snippets stay reachable after an opening quote", () => {
  const quoted = 'GET /orders/_search\n{\n  "bo';
  assert.equal(buildElasticsearchCompletionItems(quoted, quoted.length).find((item) => item.label === "bool")?.filterText, '"bool"');

  const bare = 'GET /orders/_search\n{\n  "query": {bo';
  assert.equal(getElasticsearchCompletionContext(bare, bare.length).mode, "json");
  assert.equal(buildElasticsearchCompletionItems(bare, bare.length).find((item) => item.label === "bool")?.filterText, undefined);
});

test("Elasticsearch completion auto trigger ignores structural JSON punctuation", () => {
  assert.equal(shouldAutoOpenElasticsearchCompletion("GET /", "GET /".length), true);
  assert.equal(shouldAutoOpenElasticsearchCompletion("GET /_", "GET /_".length), true);
  assert.equal(shouldAutoOpenElasticsearchCompletion("GET /orders/_search\n{", "GET /orders/_search\n{".length), false);
  assert.equal(shouldAutoOpenElasticsearchCompletion('GET /orders/_search\n{"query": {},', 'GET /orders/_search\n{"query": {},'.length), false);
});

test("Elasticsearch term field slot suggests index mapping fields instead of DSL keywords", () => {
  const text = 'GET /orders/_search\n{\n  "query": {\n    "term": {\n      "';
  const context = getElasticsearchCompletionContext(text, text.length);

  assert.equal(context.mode, "json");
  assert.equal(context.jsonFieldSlot, true);
  assert.equal(context.index, "orders");
  assert.equal(elasticsearchCompletionNeedsFields(context), true);

  const items = buildElasticsearchCompletionItems(text, text.length, { fields });
  assert.equal(items.find((item) => item.label === '"city"')?.detail, "keyword");
  assert.equal(items.find((item) => item.label === '"city"')?.type, "column");
  assert.equal(
    items.some((item) => item.label === '"should"' || item.label === '"size"' || item.label === '"sort"'),
    false,
  );
});

test("Elasticsearch bool and query slots still suggest DSL keywords", () => {
  const queryText = 'GET /orders/_search\n{\n  "query": {\n    "';
  assert.equal(getElasticsearchCompletionContext(queryText, queryText.length).jsonFieldSlot, false);
  assert.ok(buildElasticsearchCompletionItems(queryText, queryText.length, { fields }).find((item) => item.label === '"bool"'));
  assert.equal(
    buildElasticsearchCompletionItems(queryText, queryText.length, { fields }).some((item) => item.label === '"city"'),
    false,
  );

  const boolText = 'GET /orders/_search\n{\n  "query": {\n    "bool": {\n      "';
  assert.equal(getElasticsearchCompletionContext(boolText, boolText.length).jsonFieldSlot, false);
  assert.ok(buildElasticsearchCompletionItems(boolText, boolText.length, { fields }).find((item) => item.label === '"must"'));
  assert.equal(
    buildElasticsearchCompletionItems(boolText, boolText.length, { fields }).some((item) => item.label === '"city"'),
    false,
  );
});

test("Elasticsearch exists field value and sort slots suggest mapping fields", () => {
  const existsText = 'GET /orders/_search\n{\n  "query": {\n    "exists": {\n      "field": "';
  assert.equal(getElasticsearchCompletionContext(existsText, existsText.length).jsonFieldSlot, true);
  assert.ok(buildElasticsearchCompletionItems(existsText, existsText.length, { fields }).find((item) => item.label === '"status"'));

  const sortArray = 'GET /orders/_search\n{\n  "sort": [\n    "';
  assert.equal(getElasticsearchCompletionContext(sortArray, sortArray.length).jsonFieldSlot, true);
  assert.ok(buildElasticsearchCompletionItems(sortArray, sortArray.length, { fields }).find((item) => item.label === '"createdAt"'));

  const sortObject = 'GET /orders/_search\n{\n  "sort": [\n    {\n      "';
  assert.equal(getElasticsearchCompletionContext(sortObject, sortObject.length).jsonFieldSlot, true);
  assert.ok(buildElasticsearchCompletionItems(sortObject, sortObject.length, { fields }).find((item) => item.label === '"createdAt"'));

  const sortMap = 'GET /orders/_search\n{\n  "sort": {\n    "';
  assert.equal(getElasticsearchCompletionContext(sortMap, sortMap.length).jsonFieldSlot, true);
});

test("Elasticsearch _source and fields objects are not mapping-field key slots", () => {
  const sourceObject = 'GET /orders/_search\n{\n  "_source": {\n    "';
  assert.equal(getElasticsearchCompletionContext(sourceObject, sourceObject.length).jsonFieldSlot, false);
  assert.ok(buildElasticsearchCompletionItems(sourceObject, sourceObject.length, { fields }).find((item) => item.label === '"fields"'));

  const fieldsObject = 'GET /orders/_search\n{\n  "fields": [\n    {\n      "';
  assert.equal(getElasticsearchCompletionContext(fieldsObject, fieldsObject.length).jsonFieldSlot, false);

  const sourceArray = 'GET /orders/_search\n{\n  "_source": [\n    "';
  assert.equal(getElasticsearchCompletionContext(sourceArray, sourceArray.length).jsonFieldSlot, true);
  assert.ok(buildElasticsearchCompletionItems(sourceArray, sourceArray.length, { fields }).find((item) => item.label === '"city"'));
});

test("Elasticsearch field completion ranks prefix matches before the 100-item cap", () => {
  const text = 'GET /orders/_search\n{\n  "query": {\n    "term": {\n      "st';
  const manyFields = [...Array.from({ length: 120 }, (_, index) => ({ name: `status_${index}`, dataType: "keyword" })), { name: "status", dataType: "keyword" }];
  const items = buildElasticsearchCompletionItems(text, text.length, { fields: manyFields });
  assert.ok(items.find((item) => item.label === '"status"'));
  assert.equal(items.length, 100);
  assert.ok(items.every((item) => item.label.startsWith('"st')));
});

test("Elasticsearch field completion follows Kibana-style dotted-path prefix matching", () => {
  const nestedFields = [
    { name: "nested_comments", dataType: "nested" },
    { name: "nested_comments.message", dataType: "text" },
    { name: "nested_comments.user", dataType: "keyword" },
    { name: "rf_hotness", dataType: "rank_feature" },
  ];
  const top = 'GET /orders/_search\n{\n  "query": {\n    "term": {\n      "ne';
  const topItems = buildElasticsearchCompletionItems(top, top.length, { fields: nestedFields });
  assert.deepEqual(
    topItems.map((item) => item.label),
    ['"nested_comments"', '"nested_comments.message"', '"nested_comments.user"'],
  );
  assert.ok((topItems[0]?.boost ?? 0) > (topItems[1]?.boost ?? 0));
  assert.equal(
    [...topItems]
      .sort((left, right) => (left.sortText ?? left.label).localeCompare(right.sortText ?? right.label))
      .map((item) => item.label)
      .join(","),
    topItems.map((item) => item.label).join(","),
  );

  const child = 'GET /orders/_search\n{\n  "query": {\n    "term": {\n      "nested_comments.';
  const childItems = buildElasticsearchCompletionItems(child, child.length, { fields: nestedFields });
  assert.deepEqual(childItems.map((item) => item.label).sort(), ['"nested_comments.message"', '"nested_comments.user"']);
});

test("Elasticsearch aggregation terms and range keep DSL keys, while query terms stay field slots", () => {
  const aggTerms = 'GET /orders/_search\n{\n  "aggs": {\n    "by_status": {\n      "terms": {\n        "';
  assert.equal(getElasticsearchCompletionContext(aggTerms, aggTerms.length).jsonFieldSlot, false);
  assert.equal(
    buildElasticsearchCompletionItems(aggTerms, aggTerms.length, { fields }).some((item) => item.label === '"status"'),
    false,
  );

  const aggField = 'GET /orders/_search\n{\n  "aggs": {\n    "by_status": {\n      "terms": {\n        "field": "';
  assert.equal(getElasticsearchCompletionContext(aggField, aggField.length).jsonFieldSlot, true);
  assert.ok(buildElasticsearchCompletionItems(aggField, aggField.length, { fields }).find((item) => item.label === '"status"'));

  const queryTerms = 'GET /orders/_search\n{\n  "query": {\n    "terms": {\n      "';
  assert.equal(getElasticsearchCompletionContext(queryTerms, queryTerms.length).jsonFieldSlot, true);

  const filterAgg = 'GET /orders/_search\n{\n  "aggs": {\n    "active": {\n      "filter": {\n        "term": {\n          "';
  assert.equal(getElasticsearchCompletionContext(filterAgg, filterAgg.length).jsonFieldSlot, true);
});

test("flattens a shallow all-types mapping without recursion", () => {
  const mapping = {
    dbx_all_types: {
      mappings: {
        properties: {
          ali_title: { type: "alias", path: "title_text" },
          b_is_active: { type: "boolean" },
          nested_comments: { type: "nested", properties: { message: { type: "text" }, user: { type: "keyword" } } },
          obj_author: { properties: { age: { type: "integer" }, name: { type: "text" } } },
          title_text: { type: "text", fields: { keyword: { type: "keyword" } } },
          dv_vector: { type: "dense_vector", dims: 3, index_options: { type: "int8_hnsw", m: 16 } },
        },
      },
    },
  };
  const flattened = flattenElasticsearchMappingFields(mapping);
  assert.equal(flattened.find((field) => field.name === "ali_title")?.dataType, "alias");
  assert.equal(flattened.find((field) => field.name === "nested_comments.message")?.dataType, "text");
  assert.equal(flattened.find((field) => field.name === "obj_author.name")?.dataType, "text");
  assert.equal(flattened.find((field) => field.name === "title_text.keyword")?.dataType, "keyword");
  assert.equal(flattened.find((field) => field.name === "dv_vector")?.dataType, "dense_vector");
  assert.equal(
    flattened.some((field) => field.name.includes("index_options")),
    false,
  );
  assert.ok(flattened.length < 20);
});

test("flattening mapping fields ignores object identity cycles", () => {
  const properties: Record<string, unknown> = {
    title_text: { type: "text" },
  };
  (properties.title_text as Record<string, unknown>).properties = properties;
  const flattened = flattenElasticsearchMappingFields({ dbx: { mappings: { properties } } });
  assert.equal(flattened.find((field) => field.name === "title_text")?.dataType, "text");
  assert.ok(flattened.length < 10);
});

test("Elasticsearch unquoted field items expose a bare filterText", () => {
  const text = 'GET /orders/_search\n{\n  "query": {\n    "term": {\n      ci';
  const item = buildElasticsearchCompletionItems(text, text.length, { fields }).find((candidate) => candidate.label === '"city"');
  assert.equal(item?.filterText, "city");
  assert.equal(item?.apply, '"city"');
});

test("Elasticsearch root _search field slots do not expose an index", () => {
  const text = 'GET /_search\n{\n  "query": {\n    "term": {\n      "';
  const context = getElasticsearchCompletionContext(text, text.length);
  assert.equal(context.jsonFieldSlot, true);
  assert.equal(context.index, undefined);
  assert.equal(elasticsearchCompletionNeedsFields(context), true);
});

test("Elasticsearch request index keeps wildcard and comma patterns", () => {
  const wildcard = 'GET /logs-*/_search\n{\n  "query": {\n    "term": {\n      "';
  assert.equal(getElasticsearchCompletionContext(wildcard, wildcard.length).index, "logs-*");

  const multi = 'GET /orders,users/_search\n{\n  "query": {\n    "term": {\n      "';
  assert.equal(getElasticsearchCompletionContext(multi, multi.length).index, "orders,users");
});

test("Elasticsearch term field completion replaces the empty key in a value pair", () => {
  const text = 'GET /orders/_search\n{\n  "query": {\n    "bool": {\n      "must": [\n        {\n          "term": {\n            "": "31"';
  const cursor = text.indexOf('""') + 1;
  const context = getElasticsearchCompletionContext(text, cursor);

  assert.equal(context.jsonFieldSlot, true);
  assert.equal(context.hasKeySeparator, true);
  assert.equal(context.index, "orders");
  assert.equal(context.replaceClosingQuote, '"');
  assert.equal(applyCompletion(text, cursor, '"city"', { fields }), text.replace('""', '"city"'));
});

test("SQL completion does not include Elasticsearch endpoints", () => {
  const items = buildSqlCompletionItems("select", "select".length, {
    tables: [],
    columnsByTable: new Map(),
  });

  assert.equal(
    items.some((item) => item.label === "/_search" || item.label === "_search"),
    false,
  );
});
