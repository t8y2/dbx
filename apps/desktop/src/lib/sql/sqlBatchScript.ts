import type { DatabaseType } from "@/types/database";

/**
 * Joins generated DDL statements into a script for display/copy. SQL Server statements
 * are separated with GO so tools that execute the copied script (SSMS, sqlcmd, DBX's
 * GO-aware runner) treat each statement as an independent batch — one failing statement
 * (e.g. a column that already exists) no longer aborts the rest of the script.
 */
export function joinSqlStatementsForScript(statements: readonly string[], databaseType?: DatabaseType): string {
  if (databaseType !== "sqlserver") return statements.join("\n");
  return statements.map((statement) => statement.trimEnd()).join("\nGO\n");
}
