export type SqlTableCompletionSchemaQualification = "never" | "collision" | "always";

export const DEFAULT_SQL_TABLE_COMPLETION_SCHEMA_QUALIFICATION: SqlTableCompletionSchemaQualification = "collision";

export function normalizeSqlTableCompletionSchemaQualification(value: unknown): SqlTableCompletionSchemaQualification {
  if (value === "never" || value === "collision" || value === "always") return value;
  return DEFAULT_SQL_TABLE_COMPLETION_SCHEMA_QUALIFICATION;
}
