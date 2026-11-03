import type { DatabaseType } from "@/types/database";

// A cheap prefilter that keeps reads free of the extra option. The Oracle agent
// decides which statements actually compile an object, so a false positive from
// a comment or a string literal only costs that check.
export function shouldReportOracleCompilationErrors(databaseType: DatabaseType | undefined, sql: string): boolean {
  return databaseType === "oracle" && /\b(?:create|alter)\b/i.test(sql);
}
