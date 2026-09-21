import type { ObjectStatistics } from "@/types/database";

/**
 * Picks the statistics entry for a table from a schema-level list. Prefers an
 * exact schema match; drivers that do not report schema (or report null) fall
 * back to a plain name match.
 */
export function findTableStatistics(stats: readonly ObjectStatistics[], tableName: string, schema?: string): ObjectStatistics | undefined {
  if (schema !== undefined && schema !== "") {
    const exact = stats.find((entry) => entry.name === tableName && entry.schema === schema);
    if (exact) return exact;
  }
  return stats.find((entry) => entry.name === tableName);
}
