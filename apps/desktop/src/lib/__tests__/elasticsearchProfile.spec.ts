import { describe, expect, it } from "vitest";
import { countProfileNodes, elasticsearchProfileBodyForResult, formatProfileNanos, maxProfileDepth, parseElasticsearchProfile } from "@/lib/elasticsearch/elasticsearchProfile";
import type { QueryResult } from "@/types/database";

const PROFILE_BODY = JSON.stringify({
  took: 42,
  timed_out: false,
  profile: {
    shards: [
      {
        id: "[2aE02wQiS1y8JQxQ4YrW3w][products][0]",
        searches: [
          {
            query: [
              {
                type: "BooleanQuery",
                description: "title:text description:text",
                time_in_nanos: 1234567,
                breakdown: {
                  build_scorer_count: 1,
                  build_scorer: 40000,
                  next_doc: 300000,
                  score: 450000,
                  match: 0,
                },
                children: [
                  {
                    type: "TermQuery",
                    description: "title:dbx",
                    time_in_nanos: 500000,
                    breakdown: { score: 250000, next_doc: 100000 },
                    children: [],
                  },
                  {
                    type: "TermQuery",
                    description: "description:profiler",
                    time_in_nanos: 300000,
                    breakdown: { score: 150000, next_doc: 50000 },
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: "[2aE02wQiS1y8JQxQ4YrW3w][products][1]",
        searches: [
          {
            query: [
              {
                type: "TermQuery",
                description: "title:dbx",
                time_in_nanos: 900000,
                breakdown: { score: 300000 },
                children: [],
              },
            ],
          },
        ],
      },
    ],
  },
});

describe("parseElasticsearchProfile", () => {
  it("maps ES profile query nodes onto the profiler tree", () => {
    const parsed = parseElasticsearchProfile(PROFILE_BODY);
    expect(parsed).not.toBeNull();
    const root = parsed!.shards[0]!.tree;
    expect(root.type).toBe("BooleanQuery");
    expect(root.description).toBe("title:text description:text");
    expect(root.timeInNanos).toBe(1234567);
    expect(root.children).toHaveLength(2);
    expect(root.children[0]!.type).toBe("TermQuery");
    expect(root.children[0]!.timeInNanos).toBe(500000);
  });

  it("computes selfTime as cumulative time minus children", () => {
    const root = parseElasticsearchProfile(PROFILE_BODY)!.shards[0]!.tree;
    expect(root.selfTimeInNanos).toBe(1234567 - 500000 - 300000);
    expect(root.children[0]!.selfTimeInNanos).toBe(500000);
    expect(root.selfTimeInNanos).toBeGreaterThanOrEqual(0);
  });

  it("clamps selfTime to zero when children exceed the parent", () => {
    const body = JSON.stringify({
      profile: {
        shards: [
          {
            id: "shard-0",
            searches: [{ query: [{ type: "ParentQuery", time_in_nanos: 100, children: [{ type: "ChildQuery", time_in_nanos: 250, children: [] }] }] }],
          },
        ],
      },
    });
    const tree = parseElasticsearchProfile(body)!.shards[0]!.tree;
    expect(tree.selfTimeInNanos).toBe(0);
    expect(tree.costShare).toBe(0);
    expect(tree.heatLevel).toBe("none");
  });

  it("computes costShare relative to the tree root time and assigns heat levels", () => {
    const tree = parseElasticsearchProfile(PROFILE_BODY)!.shards[0]!.tree;
    // selfCosts telescope to the root: 1234567.
    expect(tree.costShare).toBeCloseTo((1234567 - 800000) / 1234567, 6);
    expect(tree.children[0]!.costShare).toBeCloseTo(500000 / 1234567, 6);
    expect(tree.children[1]!.costShare).toBeCloseTo(300000 / 1234567, 6);
    // ~35% self share is >20% → hot, matching planCanvas thresholds.
    expect(tree.heatLevel).toBe("hot");
  });

  it("marks the critical path recursively to the leaf", () => {
    const tree = parseElasticsearchProfile(PROFILE_BODY)!.shards[0]!.tree;
    const [left, right] = tree.children;
    // The highest-cost child is TermQuery title:dbx (500000).
    expect(tree.isCriticalPath).toBe(true);
    expect(left!.isCriticalPath).toBe(true);
    expect(right!.isCriticalPath).toBe(false);
  });

  it("sorts shards so the highest total is first", () => {
    const parsed = parseElasticsearchProfile(PROFILE_BODY)!;
    expect(parsed.shards).toHaveLength(2);
    expect(parsed.shards[0]!.totalTimeInNanos).toBeGreaterThanOrEqual(parsed.shards[1]!.totalTimeInNanos);
    expect(parsed.shards[0]!.id).toContain("[0]");
  });

  it("merges multiple searches into one tree per shard", () => {
    const body = JSON.stringify({
      profile: {
        shards: [
          {
            id: "s0",
            searches: [{ query: [{ type: "TermQuery", time_in_nanos: 100, children: [] }] }, { query: [{ type: "MatchAllQuery", time_in_nanos: 50, children: [] }] }],
          },
        ],
      },
    });
    const shard = parseElasticsearchProfile(body)!.shards[0]!;
    expect(shard.tree.type).toBe("search");
    expect(shard.tree.children).toHaveLength(2);
    expect(shard.tree.timeInNanos).toBe(150);
    expect(shard.searchCount).toBe(2);
  });

  it("parses time_in_nanos beyond Number.MAX_SAFE_INTEGER without corrupting the tree", () => {
    // 2^53 is exactly representable but exceeds Number.MAX_SAFE_INTEGER, so the
    // safe JSON parser keeps the literal verbatim and the tree still parses to a
    // finite, usable timing instead of dropping or re-quoting the value.
    const huge = 2 ** 53;
    const body = JSON.stringify({
      profile: { shards: [{ id: "s0", searches: [{ query: [{ type: "BigQuery", time_in_nanos: huge, children: [] }] }] }] },
    });
    const shard = parseElasticsearchProfile(body)!.shards[0]!;
    expect(shard.tree.timeInNanos).toBe(huge);
    expect(shard.tree.selfTimeInNanos).toBe(huge);
  });

  it("returns null for malformed JSON", () => {
    expect(parseElasticsearchProfile("not json")).toBeNull();
    expect(parseElasticsearchProfile("")).toBeNull();
  });

  it("returns null when profile or shards are missing", () => {
    expect(parseElasticsearchProfile(JSON.stringify({ took: 1 }))).toBeNull();
    expect(parseElasticsearchProfile(JSON.stringify({ profile: {} }))).toBeNull();
    expect(parseElasticsearchProfile(JSON.stringify({ profile: { shards: [] } }))).toBeNull();
  });

  it("returns null when every shard has no query nodes", () => {
    const body = JSON.stringify({ profile: { shards: [{ id: "s0", searches: [{ query: [] }] }] } });
    expect(parseElasticsearchProfile(body)).toBeNull();
  });
});

describe("elasticsearchProfileBodyForResult", () => {
  const esResult = (partial: Partial<QueryResult>): QueryResult => ({
    columns: [],
    rows: [],
    affected_rows: 0,
    execution_time_ms: 1,
    ...partial,
  });

  it("reads the preserved raw body for ES-compatible databases", () => {
    const body = '{"profile":{"shards":[]}}';
    const result = esResult({ elasticsearch_raw_body: body });
    expect(elasticsearchProfileBodyForResult("elasticsearch", result)).toBe(body);
    expect(elasticsearchProfileBodyForResult("easysearch", result)).toBe(body);
  });

  it("falls back to the two-column status/response row shape", () => {
    const result = esResult({ columns: ["status", "response"], rows: [[200, '{"profile":{}}']] });
    expect(elasticsearchProfileBodyForResult("elasticsearch", result)).toBe('{"profile":{}}');
  });

  it("returns null for non-ES databases and empty bodies", () => {
    const result = esResult({ elasticsearch_raw_body: '{"profile":{}}' });
    expect(elasticsearchProfileBodyForResult("mysql", result)).toBeNull();
    expect(elasticsearchProfileBodyForResult("elasticsearch", esResult({}))).toBeNull();
    expect(elasticsearchProfileBodyForResult("elasticsearch", esResult({ elasticsearch_raw_body: "" }))).toBeNull();
  });
});

describe("profile helpers", () => {
  it("counts nodes and measures depth", () => {
    const tree = parseElasticsearchProfile(PROFILE_BODY)!.shards[0]!.tree;
    expect(countProfileNodes(tree)).toBe(3);
    expect(maxProfileDepth(tree)).toBe(1);
  });

  it("formats nanoseconds into readable units", () => {
    expect(formatProfileNanos(0)).toBe("0ns");
    expect(formatProfileNanos(500)).toBe("500ns");
    expect(formatProfileNanos(1500)).toBe("1.5µs");
    expect(formatProfileNanos(2_500_000)).toBe("2.5ms");
    expect(formatProfileNanos(1.2e9)).toBe("1.2s");
  });

  it("shares the planCanvas heatLevel thresholds", () => {
    // Assert the wiring: shares >20% → hot, 5–20% → warm, else cool.
    const body = JSON.stringify({
      profile: {
        shards: [
          {
            id: "s0",
            searches: [
              {
                query: [
                  {
                    type: "Root",
                    time_in_nanos: 1000,
                    children: [
                      { type: "Hot", time_in_nanos: 250, children: [] },
                      { type: "Warm", time_in_nanos: 100, children: [] },
                      { type: "Cool", time_in_nanos: 10, children: [] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const tree = parseElasticsearchProfile(body)!.shards[0]!.tree;
    expect(tree.children[0]!.heatLevel).toBe("hot");
    expect(tree.children[1]!.heatLevel).toBe("warm");
    expect(tree.children[2]!.heatLevel).toBe("cool");
  });
});
