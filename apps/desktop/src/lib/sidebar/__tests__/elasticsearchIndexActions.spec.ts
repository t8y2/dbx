import { describe, expect, it } from "vitest";
import { elasticsearchClearIndexPreview, isElasticsearchClearConfirmed, isElasticsearchIndexPattern, isElasticsearchProtocolIndex, isPartialElasticsearchClear, matchesElasticsearchIndexPattern } from "@/lib/sidebar/elasticsearchIndexActions";
import type { ElasticsearchDeleteByQueryResult } from "@/lib/backend/tauri";

function clearResult(overrides: Partial<ElasticsearchDeleteByQueryResult> = {}): ElasticsearchDeleteByQueryResult {
  return { total: 10, deleted: 10, versionConflicts: 0, timedOut: false, failures: [], ...overrides };
}

describe("Elasticsearch index actions", () => {
  it("only claims index nodes on Elasticsearch-protocol connections", () => {
    expect(isElasticsearchProtocolIndex("elasticsearch-index", "elasticsearch")).toBe(true);
    expect(isElasticsearchProtocolIndex("elasticsearch-index", "easysearch")).toBe(true);
    // Meilisearch reuses the same tree node type but speaks a different API.
    expect(isElasticsearchProtocolIndex("elasticsearch-index", "meilisearch")).toBe(false);
    expect(isElasticsearchProtocolIndex("vector-collection", "elasticsearch")).toBe(false);
    expect(isElasticsearchProtocolIndex("elasticsearch-index", undefined)).toBe(false);
  });

  it("previews the exact request the clear action sends", () => {
    const preview = elasticsearchClearIndexPreview("logs-2026.08");
    expect(preview).toContain("POST /logs-2026.08/_delete_by_query?conflicts=proceed&refresh=true");
    expect(preview).toContain('"match_all"');
    // The index itself must not appear as a DELETE target.
    expect(preview).not.toContain("DELETE");
  });

  it("matches concrete indexes under a grouped node's pattern", () => {
    expect(matchesElasticsearchIndexPattern("logs-2026.08.*", "logs-2026.08.01")).toBe(true);
    expect(matchesElasticsearchIndexPattern("logs-?.*", "logs-1.daily")).toBe(true);
    expect(matchesElasticsearchIndexPattern("logs-2026.08.*", "logs-2026.09.01")).toBe(false);
    expect(matchesElasticsearchIndexPattern("logs-?", "logs-12")).toBe(false);
    expect(matchesElasticsearchIndexPattern("logs", "logs-daily")).toBe(false);
    expect(matchesElasticsearchIndexPattern("*", "anything")).toBe(true);
  });

  it("separates grouped wildcard nodes from real index names", () => {
    expect(isElasticsearchIndexPattern("logs-2026.08.*")).toBe(true);
    expect(isElasticsearchIndexPattern("logs-?")).toBe(true);
    // Characters that are legal in an index name must not read as a pattern.
    expect(isElasticsearchIndexPattern("logs-2026.08.04")).toBe(false);
    expect(isElasticsearchIndexPattern("orders_v2-prod")).toBe(false);
  });

  it("lets a concrete index clear without extra typing", () => {
    expect(isElasticsearchClearConfirmed("orders", "")).toBe(true);
    expect(isElasticsearchClearConfirmed("logs-2026.08.04", "anything")).toBe(true);
  });

  it("holds a wildcard clear back until the pattern is typed back verbatim", () => {
    expect(isElasticsearchClearConfirmed("logs-2026.08.*", "")).toBe(false);
    expect(isElasticsearchClearConfirmed("logs-2026.08.*", "logs-2026.08")).toBe(false);
    // A near miss must not unlock: this is the whole point of the gate.
    expect(isElasticsearchClearConfirmed("logs-2026.08.*", "logs-2026.09.*")).toBe(false);
    expect(isElasticsearchClearConfirmed("logs-2026.08.*", "LOGS-2026.08.*")).toBe(false);
    expect(isElasticsearchClearConfirmed("logs-2026.08.*", "logs-2026.08.*")).toBe(true);
    // Padding is invisible in the input, so it is forgiven.
    expect(isElasticsearchClearConfirmed("logs-2026.08.*", "  logs-2026.08.*  ")).toBe(true);
  });

  it("treats a fully deleted match set as a complete clear", () => {
    expect(isPartialElasticsearchClear(clearResult())).toBe(false);
    expect(isPartialElasticsearchClear(clearResult({ total: 0, deleted: 0 }))).toBe(false);
  });

  it("flags every way _delete_by_query can leave documents behind", () => {
    expect(isPartialElasticsearchClear(clearResult({ deleted: 7 }))).toBe(true);
    expect(isPartialElasticsearchClear(clearResult({ versionConflicts: 2 }))).toBe(true);
    expect(isPartialElasticsearchClear(clearResult({ timedOut: true }))).toBe(true);
    expect(isPartialElasticsearchClear(clearResult({ failures: ['{"index":"logs"}'] }))).toBe(true);
  });
});
