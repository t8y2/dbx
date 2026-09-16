import type { QueryMessage, QueryResult } from "@/types/database";

export function queryResultMessages(result: Pick<QueryResult, "rows" | "messages" | "server_message">): QueryMessage[] {
  if (result.messages?.length || result.server_message !== true) return result.messages ?? [];
  return result.rows.flatMap((row) => (row[0] == null ? [] : [{ severity: "INFO", message: String(row[0]) }]));
}
