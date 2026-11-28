import type { DatabaseType } from "@/types/database";

/**
 * SQL that returns the CREATE statement of a whole database, or null when the
 * engine has no such statement (or DBX does not support it for that driver).
 */
export function buildShowCreateDatabaseSql(databaseType: DatabaseType | undefined, database: string): string | null {
  if (databaseType === "mysql") return `SHOW CREATE DATABASE \`${database.replaceAll("`", "``")}\`;`;
  return null;
}
