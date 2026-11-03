import type { QueryMessage, QueryResult } from "@/types/database";

export function queryResultMessages(result: Pick<QueryResult, "rows" | "messages" | "server_message">): QueryMessage[] {
  if (result.messages?.length || result.server_message !== true) return result.messages ?? [];
  return result.rows.flatMap((row) => (row[0] == null ? [] : [{ severity: "INFO", message: String(row[0]) }]));
}

export function mergeQueryMessages(streamed: QueryMessage[], completed: QueryMessage[]): QueryMessage[] {
  if (!streamed.length) return completed;
  const remaining = new Map<string, number>();
  for (const message of streamed) {
    const key = JSON.stringify([message.severity, message.message, message.code ?? null, message.detail ?? null, message.hint ?? null]);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const extra = completed.filter((message) => {
    const key = JSON.stringify([message.severity, message.message, message.code ?? null, message.detail ?? null, message.hint ?? null]);
    const count = remaining.get(key) ?? 0;
    if (!count) return true;
    remaining.set(key, count - 1);
    return false;
  });
  return [...streamed, ...extra];
}
