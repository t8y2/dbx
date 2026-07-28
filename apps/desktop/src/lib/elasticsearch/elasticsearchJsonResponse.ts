import type { DatabaseType, QueryResult } from "@/types/database";
import { stripLeadingElasticsearchComments } from "@/lib/sql/sqlStatementRanges";

export interface ElasticsearchJsonResponse {
  status: number;
  body: string;
}

const ELASTICSEARCH_REST_STATEMENT = /^(?:GET|POST|PUT|DELETE|HEAD)\s+\S+/i;

/**
 * Detect the raw HTTP result emitted for an Elasticsearch REST request.
 * DBX asks unformatted CAT requests for JSON so they use this response panel.
 */
export function elasticsearchJsonResponseForResult(databaseType: DatabaseType | undefined, sourceStatement: string | undefined, result: QueryResult | undefined): ElasticsearchJsonResponse | undefined {
  if (databaseType !== "elasticsearch" || !result || typeof sourceStatement !== "string") return undefined;
  if (!ELASTICSEARCH_REST_STATEMENT.test(stripLeadingElasticsearchComments(sourceStatement))) return undefined;
  if (result.columns.length !== 2 || result.columns[0] !== "status" || result.columns[1] !== "response" || result.rows.length !== 1) return undefined;

  const row = result.rows[0];
  if (!row || row.length !== 2) return undefined;

  const [status, body] = row;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599 || typeof body !== "string") return undefined;
  return { status, body };
}
