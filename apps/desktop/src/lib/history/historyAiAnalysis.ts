export type HistoryAiAnalysisEntry = {
  id: string;
  connection_id?: string;
  connection_name: string;
  database: string;
  sql: string;
  executed_at: string;
  execution_time_ms: number;
  success: boolean;
  error?: string | null;
  activity_kind?: "query" | "data_change" | "schema_change" | "import" | "transfer" | "redis_command";
  operation?: string;
  target?: string;
  affected_rows?: number | null;
  rollback_sql?: string | null;
  details_json?: string | null;
};

export function canRollbackHistoryEntry(entry: Pick<HistoryAiAnalysisEntry, "connection_id" | "database" | "rollback_sql">) {
  return !!entry.connection_id?.trim() && !!entry.database?.trim() && !!entry.rollback_sql?.trim();
}

export function buildHistoryAiAnalysisPrompt(entry: HistoryAiAnalysisEntry): string {
  const details = [
    "Analyse this DBX history entry and focus on:",
    "1. What this operation did, and which data or structures it may have affected.",
    "2. Whether it carries risk, e.g. an UPDATE without WHERE, deletes, DDL, table locks, performance or permission problems.",
    "3. If rollback SQL is present, judge whether it is safe enough and what should be confirmed before running it.",
    "4. If no rollback SQL is present, state clearly that it cannot be rolled back directly and suggest a workable manual recovery path.",
    "",
    "History metadata:",
    `Connection: ${entry.connection_name || "(unknown)"}`,
    `Database: ${entry.database || "(unknown)"}`,
    `Activity kind: ${entry.activity_kind || "query"}`,
    `Operation: ${entry.operation || "(unknown)"}`,
    `Target: ${entry.target || "(unknown)"}`,
    `Status: ${entry.success ? "success" : "failed"}`,
    `Executed at: ${entry.executed_at || "(unknown)"}`,
    `Duration: ${entry.execution_time_ms}ms`,
    `Affected rows: ${entry.affected_rows ?? "(unknown)"}`,
    entry.error ? `Error: ${entry.error}` : "",
    entry.details_json ? `Details JSON: ${entry.details_json}` : "",
    "",
    "SQL:",
    "```sql",
    entry.sql.trim() || "-- empty",
    "```",
    "",
    "Rollback SQL:",
    entry.rollback_sql?.trim() ? "```sql" : "(not available)",
    entry.rollback_sql?.trim() ? entry.rollback_sql.trim() : "",
    entry.rollback_sql?.trim() ? "```" : "",
  ];

  return details.filter((line) => line !== "").join("\n");
}
