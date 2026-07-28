import type { DataGridConditionColumnOption } from "@/composables/useDataGridConditionEditor";
import { codeMirrorSqlDialect } from "@/lib/database/jdbcDialect";
import { quoteSqlIdentifier } from "@/lib/sql/sqlCompletion";
import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";
import type { DatabaseType } from "@/types/database";

export function dataGridConditionColumnOptions(columns: readonly DataGridConditionColumnOption[], databaseType?: DatabaseType): DataGridConditionColumnOption[] {
  const dialect = codeMirrorSqlDialect(databaseType);
  return columns.map((column) => {
    const name = typeof column === "string" ? column : column.name;
    const insertText = quoteSqlIdentifier(name, dialect);
    const comment = typeof column === "string" ? undefined : column.comment;
    return { name, insertText, ...(comment !== undefined ? { comment } : {}) };
  });
}

export function dataGridConditionIdentifierQuote(databaseType?: DatabaseType, runtimeQuote?: string): string | undefined {
  if (runtimeQuote !== undefined) return runtimeQuote || undefined;
  return sqlSemanticDialectFor({ databaseType }).identifierQuotes[0]?.open;
}
