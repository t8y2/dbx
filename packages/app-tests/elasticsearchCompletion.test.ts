import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildElasticsearchCompletionItems, getElasticsearchCompletionContext, shouldAutoOpenElasticsearchCompletion } from "../../apps/desktop/src/lib/elasticsearchCompletion.ts";
import { buildSqlCompletionItems } from "../../apps/desktop/src/lib/sqlCompletion.ts";

const indices = ["orders", "order_items", "users"];

function applyCompletion(text: string, cursor: number, label: string): string {
  const context = getElasticsearchCompletionContext(text, cursor);
  const item = buildElasticsearchCompletionItems(text, cursor, { indices }).find((candidate) => candidate.label === label);
  assert.ok(item, `Expected completion item ${label}`);
  return `${text.slice(0, context.from)}${item.apply ?? item.label}${text.slice(cursor)}`;
}

test("suggests Elasticsearch HTTP methods for empty and prefix input", () => {
  assert.deepEqual(
    buildElasticsearchCompletionItems("", 0).map((item) => item.label),
    ["GET", "POST", "PUT", "DELETE"],
  );

  const items = buildElasticsearchCompletionItems("po", 2);
  assert.equal(items.find((item) => item.label === "POST")?.apply, "POST /");
});

test("suggests Elasticsearch root endpoints", () => {
  const items = buildElasticsearchCompletionItems("GET /_", "GET /_".length);

  assert.ok(items.find((item) => item.label === "/_search"));
  assert.ok(items.find((item) => item.label === "/_cat/indices"));
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
