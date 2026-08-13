import type { QueryResult } from "@/types/database";

/**
 * Picks the default output view for a result that has no result set.
 * Message-only results (e.g. PostgreSQL `DO $$ RAISE NOTICE $$`) open the
 * messages view; routine DML like a MySQL INSERT also carries an INFO message
 * ("Records: N ...") but keeps the established summary view.
 */
export function defaultViewForResult(result: Pick<QueryResult, "columns" | "rows" | "affected_rows" | "messages">): "messages" | "summary" {
  const messageOnly = result.columns.length === 0 && result.rows.length === 0 && result.affected_rows === 0 && (result.messages?.length ?? 0) > 0;
  return messageOnly ? "messages" : "summary";
}
