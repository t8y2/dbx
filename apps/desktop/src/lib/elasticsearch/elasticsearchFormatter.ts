import { formatJsonSource } from "@/lib/common/safeJsonFormat";
import { elasticsearchRestRequestRanges } from "@/lib/sql/sqlStatementRanges";
import type { DatabaseType } from "@/types/database";

const ELASTICSEARCH_REQUEST_LINE = /^(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\S+)/i;

export type ElasticsearchFormatResult = { kind: "elasticsearch"; formatted: string } | { kind: "unsupported" } | { kind: "not-elasticsearch" };

function formatSingleElasticsearchRequest(requestText: string, indentSize: number): string | null {
  const match = requestText.match(ELASTICSEARCH_REQUEST_LINE);
  if (!match) return null;
  const method = match[1].toUpperCase();
  const rawPath = match[2];
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const body = requestText.slice(match[0].length).trim();
  if (!body) return `${method} ${path}`;
  try {
    return `${method} ${path}\n${formatJsonSource(body, indentSize)}`;
  } catch {
    return null;
  }
}

/**
 * Formats Kibana-console-style Elasticsearch/Meilisearch REST requests
 * (`METHOD /path {json body}`, possibly several in one document) by
 * pretty-printing each request's JSON body and normalizing its method/path
 * onto its own line. Text between requests (blank lines, comments) is kept
 * as-is via {@link elasticsearchRestRequestRanges}.
 */
export function detectAndFormatElasticsearchRequests(text: string, databaseType: DatabaseType | undefined, indentSize: number): ElasticsearchFormatResult {
  const ranges = elasticsearchRestRequestRanges(text, databaseType);
  if (ranges.length === 0) return { kind: "not-elasticsearch" };

  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    const formattedOne = formatSingleElasticsearchRequest(range.sql, indentSize);
    if (formattedOne === null) return { kind: "unsupported" };
    result += text.slice(cursor, range.from) + formattedOne;
    cursor = range.to;
  }
  result += text.slice(cursor);
  return { kind: "elasticsearch", formatted: result };
}
