import type { ObjectStatistics } from "@/types/database";

/**
 * Picks the statistics entry for a table from a schema-level list. Drivers can
 * report inconsistent casing between `listObjects` and `listObjectStatistics`,
 * so both the schema and the name fold to lowercase — the same normalization
 * the object browser's statistic keys apply. The name-only fallback stays:
 * the statistics query is already scoped to one database/schema, and
 * MySQL-family tables carry an empty `tableMeta.schema` while their statistics
 * entries report the database as schema.
 */
export function findTableStatistics(stats: readonly ObjectStatistics[], tableName: string, schema?: string): ObjectStatistics | undefined {
  if (schema !== undefined && schema !== "") {
    const exact = stats.find((entry) => (entry.schema ?? "").toLowerCase() === schema.toLowerCase() && entry.name.toLowerCase() === tableName.toLowerCase());
    if (exact) return exact;
  }
  return stats.find((entry) => entry.name.toLowerCase() === tableName.toLowerCase());
}
