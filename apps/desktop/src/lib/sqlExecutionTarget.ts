import * as api from "./api";
import type { DatabaseType } from "@/types/database";

export type ExecuteMode = "all" | "current";

export interface SqlExecutionSnapshot {
  fullSql: string;
  selectedSql: string;
  cursorPos: number;
}

export type SqlExecutionOverride = string | SqlExecutionSnapshot;

export type SqlExecutionTargetKind = "cursor" | "all";

/**
 * A candidate execution target surfaced by the execution target picker.
 * `from`/`to` are offsets into the full document so the editor can highlight
 * the corresponding range as a preview while the picker is open.
 */
export interface SqlExecutionCandidate {
  kind: SqlExecutionTargetKind;
  label: string;
  sql: string;
  from: number;
  to: number;
}

export interface SqlExecutionChoiceRequest {
  fullSql: string;
  selectedSql: string;
  cursorPos: number;
  candidates: SqlExecutionCandidate[];
}

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

  // MongoDB uses dedicated per-command gutter actions for "current command";
  // the main editor execute action keeps its long-standing "run all text"
  // behavior when nothing is selected.
  if (options?.databaseType === "mongodb") return fullSql;

  if (options?.mode === "current" && options.cursorPos !== undefined) {
    return await api.findStatementAtCursor(fullSql, options.cursorPos, options.databaseType);
  }

  return fullSql;
}
