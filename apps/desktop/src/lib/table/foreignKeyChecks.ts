import type { DatabaseType, QueryResult } from "@/types/database";

/**
 * Navicat-style "Foreign Key Checks" choice for batch Truncate / Empty / Drop.
 *
 * - `default`: run the statements exactly as before (session setting untouched).
 * - `enable`:  force `FOREIGN_KEY_CHECKS = 1` for the batch.
 * - `disable`: force `FOREIGN_KEY_CHECKS = 0`, so referenced tables can be
 *              truncated / emptied / dropped in any order.
 *
 * `FOREIGN_KEY_CHECKS` is a MySQL *session* variable, so a non-default mode runs the whole
 * batch as one `executeMulti` call (one pooled connection) and restores the previous value.
 */
export type ForeignKeyChecksMode = "default" | "enable" | "disable";

export const FOREIGN_KEY_CHECKS_MODES: readonly ForeignKeyChecksMode[] = ["default", "enable", "disable"];

const SAVE_STATEMENT = "SET @dbx_saved_foreign_key_checks = @@SESSION.FOREIGN_KEY_CHECKS";
const RESTORE_STATEMENT = "SET FOREIGN_KEY_CHECKS = @dbx_saved_foreign_key_checks";

/** Statements inserted before the user statements; result indexes are shifted back by this. */
export const FOREIGN_KEY_CHECKS_PREFIX_COUNT = 2;

/** Only MySQL honours the session variable (same scope as Schema Diff's "ignore foreign key checks"). */
export function supportsForeignKeyChecksOption(databaseType: DatabaseType | string | undefined): boolean {
  return databaseType === "mysql";
}

export function isForeignKeyChecksOverride(mode: ForeignKeyChecksMode, databaseType: DatabaseType | string | undefined): mode is "enable" | "disable" {
  return mode !== "default" && supportsForeignKeyChecksOption(databaseType);
}

function stripTrailingSemicolons(sql: string): string {
  return sql
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
}

/** The full script that runs for `mode`; `default` returns the statements unchanged. */
export function foreignKeyChecksScript(statements: readonly string[], mode: ForeignKeyChecksMode, databaseType: DatabaseType | string | undefined): string {
  const body = statements.map(stripTrailingSemicolons).filter(Boolean);
  if (!isForeignKeyChecksOverride(mode, databaseType) || body.length === 0) return body.map((sql) => `${sql};`).join("\n");
  return [SAVE_STATEMENT, `SET FOREIGN_KEY_CHECKS = ${mode === "disable" ? 0 : 1}`, ...body, RESTORE_STATEMENT].map((sql) => `${sql};`).join("\n");
}

/** Preview text for a confirmation dialog whose base preview is newline-separated statements. */
export function foreignKeyChecksPreview(previewSql: string, mode: ForeignKeyChecksMode, databaseType: DatabaseType | string | undefined): string {
  if (!isForeignKeyChecksOverride(mode, databaseType) || !previewSql.trim()) return previewSql;
  return foreignKeyChecksScript(
    previewSql.split("\n").filter((line) => line.trim()),
    mode,
    databaseType,
  );
}

export interface ForeignKeyChecksBatchProgress {
  completed: number;
  total: number;
  success: boolean;
}

export type ForeignKeyChecksBatchExecutor = (sql: string, onProgress: (progress: ForeignKeyChecksBatchProgress) => void, options: { continueOnError: boolean }) => Promise<QueryResult[]>;

function resultIndex(result: QueryResult, position: number): number {
  return Number.isInteger(result.statement_index) ? result.statement_index! : position;
}

function resultError(result: QueryResult, fallback: string): string {
  return String(result.error?.detail || result.rows?.[0]?.[0] || fallback);
}

/**
 * Run `statements` wrapped with the FOREIGN_KEY_CHECKS save / set / restore statements.
 * Returned results and progress refer to the caller's statements only (`statement_index`
 * 0..n-1), so existing per-target result mapping keeps working.
 *
 * Continue-on-error keeps the restore statement running even when a user statement fails.
 * A failed setup statement aborts with an error instead of reporting partial success.
 */
export async function runForeignKeyChecksBatch(statements: readonly string[], mode: "enable" | "disable", execute: ForeignKeyChecksBatchExecutor, onProgress?: (progress: ForeignKeyChecksBatchProgress) => void): Promise<QueryResult[]> {
  const count = statements.length;
  if (count === 0) return [];
  const script = foreignKeyChecksScript(statements, mode, "mysql");
  const results = await execute(
    script,
    (progress) => {
      if (progress.completed <= FOREIGN_KEY_CHECKS_PREFIX_COUNT) return;
      onProgress?.({ completed: Math.min(progress.completed - FOREIGN_KEY_CHECKS_PREFIX_COUNT, count), total: count, success: progress.success });
    },
    { continueOnError: true },
  );

  const mapped: QueryResult[] = [];
  results.forEach((result, position) => {
    if (result.server_message) return;
    const index = resultIndex(result, position);
    if (index < FOREIGN_KEY_CHECKS_PREFIX_COUNT) {
      if (result.execution_error === true) throw new Error(`Failed to set FOREIGN_KEY_CHECKS: ${resultError(result, "unknown error")}`);
      return;
    }
    if (index >= FOREIGN_KEY_CHECKS_PREFIX_COUNT + count) return; // restore statement
    mapped.push({ ...result, statement_index: index - FOREIGN_KEY_CHECKS_PREFIX_COUNT });
  });
  return mapped;
}

export interface ForeignKeyChecksTargetResult<T> {
  succeeded: T[];
  failed: Array<{ target: T; error: Error }>;
}

/** Map per-statement batch results back onto the plan targets (one statement per target). */
export function foreignKeyChecksTargetResults<T>(plan: readonly { target: T }[], results: readonly QueryResult[]): ForeignKeyChecksTargetResult<T> {
  const byIndex = new Map(results.map((result, position) => [resultIndex(result, position), result]));
  const outcome: ForeignKeyChecksTargetResult<T> = { succeeded: [], failed: [] };
  plan.forEach(({ target }, index) => {
    const result = byIndex.get(index);
    if (!result) outcome.failed.push({ target, error: new Error("The statement was not executed") });
    else if (result.execution_error === true) outcome.failed.push({ target, error: new Error(resultError(result, "Statement failed")) });
    else outcome.succeeded.push(target);
  });
  return outcome;
}
