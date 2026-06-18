import * as api from "./api";
import type { DatabaseType } from "@/types/database";

export type ExecuteMode = "all" | "current";

export interface SqlExecutionSnapshot {
  fullSql: string;
  selectedSql: string;
  cursorPos: number;
}

export type SqlExecutionOverride = string | SqlExecutionSnapshot;

export function isSqlExecutionSnapshot(value: SqlExecutionOverride | undefined): value is SqlExecutionSnapshot {
  return typeof value === "object" && value !== null && typeof value.fullSql === "string" && typeof value.selectedSql === "string" && typeof value.cursorPos === "number";
}

export function resolveExecutableSql(fullSql: string, selectedSql: string, options?: { mode?: ExecuteMode; cursorPos?: number }): string {
  const trimmedSelection = selectedSql.trim();
  if (trimmedSelection) return trimmedSelection;

  if (options?.mode === "current" && options.cursorPos !== undefined) {
    return fullSql;
  }

  return fullSql;
}

export async function resolveExecutableSqlWithBackend(fullSql: string, selectedSql: string, options?: { mode?: ExecuteMode; cursorPos?: number; databaseType?: DatabaseType }): Promise<string> {
  const trimmedSelection = selectedSql.trim();
  if (trimmedSelection) return trimmedSelection;

  if (options?.mode === "current" && options.cursorPos !== undefined) {
    return await api.findStatementAtCursor(fullSql, options.cursorPos, options.databaseType);
  }

  return fullSql;
}
