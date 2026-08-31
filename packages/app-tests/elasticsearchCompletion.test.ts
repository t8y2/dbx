import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildElasticsearchCompletionItems, getElasticsearchCompletionContext, shouldAutoOpenElasticsearchCompletion } from "../../apps/desktop/src/lib/elasticsearch/elasticsearchCompletion.ts";
import { buildSqlCompletionItems } from "../../apps/desktop/src/lib/sql/sqlCompletion.ts";

const indices = ["orders", "order_items", "users"];

function applyCompletion(text: string, cursor: number, label: string): string {
  const context = getElasticsearchCompletionContext(text, cursor);
  const item = buildElasticsearchCompletionItems(text, cursor, { indices }).find((candidate) => candidate.label === label);
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
  const text = 'GET /orders/_search\n{\n  "sort": [\n    "fi';
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
