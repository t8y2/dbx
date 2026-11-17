export type SqlCompletionMatchMode = "contains" | "fuzzy";

export const DEFAULT_SQL_COMPLETION_MATCH_MODE: SqlCompletionMatchMode = "fuzzy";

export function normalizeCompletionMatchMode(value: unknown, fallback: SqlCompletionMatchMode = DEFAULT_SQL_COMPLETION_MATCH_MODE): SqlCompletionMatchMode {
  return value === "contains" ? "contains" : fallback;
}
