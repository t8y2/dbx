import type { DatabaseType } from "@/types/database";

/**
 * Joins generated DDL statements into a script for display/copy. SQL Server statements
 * are separated with GO so tools that execute the copied script (SSMS, sqlcmd, DBX's
 * GO-aware runner) treat each statement as an independent batch. GO only defines batch
 * boundaries; whether execution continues after an error depends on the client policy.
 */
export function joinSqlStatementsForScript(statements: readonly string[], databaseType?: DatabaseType): string {
  if (databaseType !== "sqlserver") return statements.join("\n");
  return statements.map((statement) => statement.trimEnd()).join("\nGO\n");
}
