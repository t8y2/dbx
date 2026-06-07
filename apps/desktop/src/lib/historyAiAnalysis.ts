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
  activity_kind?: "query" | "data_change" | "schema_change" | "import" | "transfer";
  operation?: string;
  target?: string;
  affected_rows?: number | null;
  rollback_sql?: string | null;
  details_json?: string | null;
};

export function canRollbackHistoryEntry(
  entry: Pick<HistoryAiAnalysisEntry, "connection_id" | "database" | "rollback_sql">,
) {
  return !!entry.connection_id?.trim() && !!entry.database?.trim() && !!entry.rollback_sql?.trim();
}

export function buildHistoryAiAnalysisPrompt(entry: HistoryAiAnalysisEntry): string {
  const details = [
    "请分析这条 DBX 历史记录，重点说明：",
    "1. 这次操作做了什么，以及可能影响哪些数据或结构。",
    "2. 是否有风险，例如无 WHERE 更新、删除、DDL、锁表、性能或权限问题。",
    "3. 如果有 Rollback SQL，请评估它是否足够安全，执行前还应该确认什么。",
    "4. 如果没有 Rollback SQL，请明确说明无法直接回滚，并给出可行的人工恢复建议。",
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
