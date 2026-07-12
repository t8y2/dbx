import { strict as assert } from "node:assert";
import { test } from "vitest";
import { elasticsearchJsonResponseForResult } from "../../apps/desktop/src/lib/elasticsearch/elasticsearchJsonResponse.ts";
import type { QueryResult } from "../../apps/desktop/src/types/database.ts";

function jsonResponse(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    columns: ["status", "response"],
    rows: [[200, '{\n  "acknowledged": true\n}']],
    affected_rows: 0,
    execution_time_ms: 1,
    ...overrides,
  };
}

test("classifies Elasticsearch GET mapping and POST JSON responses", () => {
  const mapping = jsonResponse();
  assert.deepEqual(elasticsearchJsonResponseForResult("elasticsearch", "GET /products/_mapping", mapping), {
    status: 200,
    body: '{\n  "acknowledged": true\n}',
  });

  const search = jsonResponse({ rows: [[201, '{"hits":{"hits":[]}}']] });
  assert.deepEqual(elasticsearchJsonResponseForResult("elasticsearch", '  post /products/_search\n{"query":{"match_all":{}}}', search), {
    status: 201,
    body: '{"hits":{"hits":[]}}',
  });
});

test("rejects SQL and non-JSON Elasticsearch result shapes", () => {
  const response = jsonResponse();

  assert.equal(elasticsearchJsonResponseForResult("elasticsearch", "SELECT * FROM products", response), undefined);
  assert.equal(elasticsearchJsonResponseForResult("postgres", "GET /products/_mapping", response), undefined);
  assert.equal(
    elasticsearchJsonResponseForResult("elasticsearch", "GET /_cat/indices", {
      columns: ["response"],
      rows: [["green open products"]],
      affected_rows: 1,
      execution_time_ms: 1,
    }),
    undefined,
  );
});

test("rejects invalid Elasticsearch JSON response status and row shapes", () => {
  const invalidResults: QueryResult[] = [
    jsonResponse({ columns: ["response", "status"] }),
    jsonResponse({ rows: [[200, "{}", "unexpected"]] }),
    jsonResponse({ rows: [[99, "{}"]] }),
    jsonResponse({ rows: [[600, "{}"]] }),
    jsonResponse({ rows: [["200", "{}"]] }),
    jsonResponse({ rows: [[200, null]] }),
  ];

  for (const result of invalidResults) {
    assert.equal(elasticsearchJsonResponseForResult("elasticsearch", "GET /products/_mapping", result), undefined);
  }
});

test("uses the supplied result source statement to classify the response", () => {
  const result = jsonResponse({ sourceStatement: "GET /products/_mapping" });

  assert.deepEqual(elasticsearchJsonResponseForResult("elasticsearch", result.sourceStatement, result), {
    status: 200,
    body: '{\n  "acknowledged": true\n}',
  });
  assert.equal(elasticsearchJsonResponseForResult("elasticsearch", "SELECT * FROM products", result), undefined);
  assert.equal(elasticsearchJsonResponseForResult("elasticsearch", undefined, result), undefined);
});
