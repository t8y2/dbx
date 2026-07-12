import type { DatabaseType, QueryResult } from "@/types/database";

export interface ElasticsearchJsonResponse {
  status: number;
  body: string;
}

const ELASTICSEARCH_REST_STATEMENT = /^(?:GET|POST|PUT|DELETE)\s+\S+/i;

/**
 * Detect the result shape emitted for a JSON response to an explicit
 * Elasticsearch REST request. SQL and text (such as CAT) results keep using
 * the normal data-grid path.
 */
export function elasticsearchJsonResponseForResult(databaseType: DatabaseType | undefined, sourceStatement: string | undefined, result: QueryResult | undefined): ElasticsearchJsonResponse | undefined {
  if (databaseType !== "elasticsearch" || !result || typeof sourceStatement !== "string") return undefined;
  if (!ELASTICSEARCH_REST_STATEMENT.test(sourceStatement.trim())) return undefined;
  if (result.columns.length !== 2 || result.columns[0] !== "status" || result.columns[1] !== "response" || result.rows.length !== 1) return undefined;

  const row = result.rows[0];
  if (!row || row.length !== 2) return undefined;

  const [status, body] = row;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599 || typeof body !== "string") return undefined;
  return { status, body };
}
