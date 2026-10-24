import { parseJsonPreservingLargeNumbers, stringifyJsonPreservingLargeNumbers } from "@/lib/common/safeJsonFormat";
import type { QueryResult } from "@/types/database";

/** One search hit rendered in the Elasticsearch document split view. */
export interface ElasticsearchDocumentHit {
  /** Document identity shown in the result list, normally `_id`. */
  label: string;
  /** Index the hit came from, when the response carries `_index`. */
  index?: string;
  /** Complete record, keeping highlights, inner hits and large integers intact. */
  record: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse `hits.hits[]` out of a raw Elasticsearch `_search` response body.
 * Anything that is not a well-formed search response yields an empty list so
 * callers can fall back to the tabular result instead of rendering a blank pane.
 */
export function elasticsearchDocumentHitsFromBody(body: string | undefined | null): ElasticsearchDocumentHit[] {
  if (typeof body !== "string" || body.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = parseJsonPreservingLargeNumbers(body);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.hits)) return [];

  const documents = parsed.hits.hits;
  if (!Array.isArray(documents)) return [];

  return documents.flatMap((hit, index): ElasticsearchDocumentHit[] => {
    if (!isRecord(hit)) return [];
    const id = typeof hit._id === "string" && hit._id ? hit._id : String(index + 1);
    const indexName = typeof hit._index === "string" && hit._index ? hit._index : undefined;
    // Keep the whole hit: `_source`, `highlight`, `inner_hits` and `sort` are
    // all part of what Kibana-style browsing shows.
    return [{ label: id, index: indexName, record: hit }];
  });
}

/**
 * Rebuild documents from a tabular Elasticsearch result when no raw body is
 * available (for example SQL results that were flattened into columns).
 */
export function elasticsearchDocumentHitsFromResult(result: QueryResult | undefined | null): ElasticsearchDocumentHit[] {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) return [];

  return result.rows.flatMap((row, rowIndex): ElasticsearchDocumentHit[] => {
    if (!Array.isArray(row)) return [];
    const record: Record<string, unknown> = {};
    result.columns.forEach((column, columnIndex) => {
      record[column] = row[columnIndex] ?? null;
    });
    const id = typeof record._id === "string" && record._id ? record._id : String(rowIndex + 1);
    const indexName = typeof record._index === "string" && record._index ? record._index : undefined;
    const source = isRecord(record._source) ? record._source : undefined;
    return [{ label: id, index: indexName, record: source ?? record }];
  });
}

/**
 * Documents for the split view: raw hits keep the most fidelity, tabular rows
 * are the fallback so the pane still renders something useful.
 */
export function elasticsearchDocumentHits(body: string | undefined | null, result: QueryResult | undefined | null): ElasticsearchDocumentHit[] {
  const fromBody = elasticsearchDocumentHitsFromBody(body);
  if (fromBody.length > 0) return fromBody;
  return elasticsearchDocumentHitsFromResult(result);
}

/** Pretty-printed JSON for the selected document; empty when there is none. */
export function elasticsearchDocumentJson(hit: ElasticsearchDocumentHit | undefined): string {
  if (!hit) return "";
  try {
    return stringifyJsonPreservingLargeNumbers(hit.record, 2);
  } catch {
    return "";
  }
}
