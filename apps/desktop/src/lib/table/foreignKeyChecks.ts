import type { DatabaseType, QueryResult } from "@/types/database";

/**
 * Navicat-style "Foreign Key Checks" choice for batch Truncate / Empty / Drop.
 *
 * - `default`: run the statements exactly as before (session setting untouched).
 * - `enable`:  force `FOREIGN_KEY_CHECKS = 1` for the batch.
 * - `disable`: force `FOREIGN_KEY_CHECKS = 0`, so referenced tables can be
 *              truncated / emptied / dropped in any order.
 *
 * `FOREIGN_KEY_CHECKS` is a MySQL *session* variable, so a non-default mode pins one client
 * session, runs setup and the body through that session, restores the previous value, and
 * closes the session before it can be reused.
 */
export type ForeignKeyChecksMode = "default" | "enable" | "disable";

export const FOREIGN_KEY_CHECKS_MODES: readonly ForeignKeyChecksMode[] = ["default", "enable", "disable"];

const SAVE_STATEMENT = "SET @dbx_saved_foreign_key_checks = @@SESSION.FOREIGN_KEY_CHECKS";
const RESTORE_STATEMENT = "SET FOREIGN_KEY_CHECKS = @dbx_saved_foreign_key_checks";

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

export type ForeignKeyChecksBatchExecute = (sql: string, onProgress: (progress: ForeignKeyChecksBatchProgress) => void, options: { continueOnError: boolean }) => Promise<QueryResult[]>;

export interface ForeignKeyChecksBatchExecutor {
  open: () => Promise<void>;
  execute: ForeignKeyChecksBatchExecute;
  close: () => Promise<void>;
}

function resultIndex(result: QueryResult, position: number): number {
  return Number.isInteger(result.statement_index) ? result.statement_index! : position;
}

function resultError(result: QueryResult, fallback: string): string {
  return String(result.error?.detail || result.rows?.[0]?.[0] || fallback);
}

function assertSuccessfulStatement(results: readonly QueryResult[], description: string): void {
  const result = results.find((item) => !item.server_message) ?? results[0];
  if (!result) throw new Error(`${description}: no result returned`);
  if (result.execution_error !== true) return;
  throw new Error(`${description}: ${resultError(result, "unknown error")}`);
}

function combineErrors(primary: unknown, secondary: unknown): Error {
  const primaryError = primary instanceof Error ? primary : new Error(String(primary));
  const secondaryError = secondary instanceof Error ? secondary : new Error(String(secondary));
  return new AggregateError([primaryError, secondaryError], `${primaryError.message}; ${secondaryError.message}`);
}

/**
 * Run `statements` with setup, body, and restore on one pinned client session.
 * Returned results and progress refer to the caller's statements only (`statement_index`
 * 0..n-1), so existing per-target result mapping keeps working.
 */
export async function runForeignKeyChecksBatch(statements: readonly string[], mode: "enable" | "disable", executor: ForeignKeyChecksBatchExecutor, onProgress?: (progress: ForeignKeyChecksBatchProgress) => void): Promise<QueryResult[]> {
  const count = statements.length;
  if (count === 0) return [];
  let failure: unknown;
  let mapped: QueryResult[] = [];
  let opened = false;
  let saved = false;

  try {
    await executor.open();
    opened = true;

    const saveResult = await executor.execute(SAVE_STATEMENT, () => {}, { continueOnError: false });
    assertSuccessfulStatement(saveResult, "Failed to save FOREIGN_KEY_CHECKS");
    saved = true;

    const set = await executor.execute(`SET FOREIGN_KEY_CHECKS = ${mode === "disable" ? 0 : 1}`, () => {}, { continueOnError: false });
    assertSuccessfulStatement(set, "Failed to set FOREIGN_KEY_CHECKS");

    const results = await executor.execute(
      statements
        .map(stripTrailingSemicolons)
        .filter(Boolean)
        .map((sql) => `${sql};`)
        .join("\n"),
      (progress) => onProgress?.({ completed: Math.min(progress.completed, count), total: count, success: progress.success }),
      { continueOnError: true },
    );
    mapped = results.filter((result) => !result.server_message).map((result, position) => ({ ...result, statement_index: resultIndex(result, position) }));
  } catch (error) {
    failure = error;
  }

  if (opened && saved) {
    try {
      const restored = await executor.execute(RESTORE_STATEMENT, () => {}, { continueOnError: false });
      assertSuccessfulStatement(restored, "Failed to restore FOREIGN_KEY_CHECKS");
    } catch (error) {
      failure = failure === undefined ? error : combineErrors(failure, error);
    }
  }

  try {
    await executor.close();
  } catch (error) {
    failure = failure === undefined ? error : combineErrors(failure, error);
  }

  if (failure !== undefined) throw failure;
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
