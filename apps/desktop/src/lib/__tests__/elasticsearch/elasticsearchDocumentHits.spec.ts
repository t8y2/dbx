import { describe, expect, it } from "vitest";
import { elasticsearchDocumentHits, elasticsearchDocumentHitsFromBody, elasticsearchDocumentHitsFromResult, elasticsearchDocumentJson } from "../../elasticsearch/elasticsearchDocumentHits";
import type { QueryResult } from "@/types/database";

function body(hits: unknown): string {
  return JSON.stringify({ took: 3, hits: { total: { value: hits instanceof Array ? hits.length : 0 }, hits } });
}

function result(columns: string[], rows: unknown[][]): QueryResult {
  return { columns, rows } as QueryResult;
}

describe("elasticsearchDocumentHitsFromBody", () => {
  it("keeps every field of a search hit", () => {
    const hits = [
      {
        _index: "logs-2026",
        _id: "doc-1",
        _source: { message: "hello", count: 42 },
        highlight: { message: ["<em>hello</em>"] },
        inner_hits: { children: { hits: { hits: [] } } },
      },
    ];

    expect(elasticsearchDocumentHitsFromBody(body(hits))).toEqual([{ label: "doc-1", index: "logs-2026", record: hits[0] }]);
  });

  it("falls back to a positional label when a hit has no _id", () => {
    const hits = [{ _source: { a: 1 } }, { _source: { a: 2 } }];

    expect(elasticsearchDocumentHitsFromBody(body(hits)).map((hit) => hit.label)).toEqual(["1", "2"]);
  });

  it("returns an empty list for unusable bodies instead of throwing", () => {
    expect(elasticsearchDocumentHitsFromBody("not json")).toEqual([]);
    expect(elasticsearchDocumentHitsFromBody("")).toEqual([]);
    expect(elasticsearchDocumentHitsFromBody(undefined)).toEqual([]);
    expect(elasticsearchDocumentHitsFromBody(JSON.stringify({ hits: "nope" }))).toEqual([]);
    expect(elasticsearchDocumentHitsFromBody(JSON.stringify({ hits: { hits: "nope" } }))).toEqual([]);
    expect(elasticsearchDocumentHitsFromBody(JSON.stringify([1, 2]))).toEqual([]);
  });

  it("skips hits that are not objects", () => {
    expect(elasticsearchDocumentHitsFromBody(body([null, 3, { _id: "ok" }])).map((hit) => hit.label)).toEqual(["ok"]);
  });
});

describe("elasticsearchDocumentHitsFromResult", () => {
  it("rebuilds documents from tabular rows", () => {
    const parsed = elasticsearchDocumentHitsFromResult(result(["_id", "_index", "level"], [["a", "logs", "info"]]));

    expect(parsed).toEqual([{ label: "a", index: "logs", record: { _id: "a", _index: "logs", level: "info" } }]);
  });

  it("returns an empty list when the result has no rows", () => {
    expect(elasticsearchDocumentHitsFromResult(result([], []))).toEqual([]);
    expect(elasticsearchDocumentHitsFromResult(undefined)).toEqual([]);
  });
});

describe("elasticsearchDocumentHits", () => {
  it("prefers raw-body hits over the flattened rows", () => {
    const hits = [{ _id: "raw", _source: { nested: { deep: true } } }];

    expect(elasticsearchDocumentHits(body(hits), result(["_id"], [["table"]]))[0]?.label).toBe("raw");
  });

  it("falls back to rows when the body carries no hits", () => {
    expect(elasticsearchDocumentHits(undefined, result(["_id"], [["table"]]))[0]?.label).toBe("table");
    expect(elasticsearchDocumentHits("{}", undefined)).toEqual([]);
  });
});

describe("elasticsearchDocumentJson", () => {
  it("pretty-prints the selected record and tolerates a missing selection", () => {
    const [hit] = elasticsearchDocumentHitsFromBody(body([{ _id: "a", _source: { n: 1 } }]));

    expect(elasticsearchDocumentJson(hit)).toContain('"_id": "a"');
    expect(elasticsearchDocumentJson(undefined)).toBe("");
  });
});
