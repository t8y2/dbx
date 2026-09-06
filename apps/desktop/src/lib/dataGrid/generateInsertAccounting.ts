import { BackendErrorException } from "@/lib/backend/errorUtils";
import type { QueryResult } from "@/types/database";

export interface BatchExecutionOutcome {
  /** Rows the backend confirmed, counted only from statements that succeeded. */
  readonly insertedRows: number;
  /** True when at least one statement in the batch failed. */
  readonly failed: boolean;
  /** Message of the first failed statement, when one is available. */
  readonly error?: string;
  /** Index of the first failed statement, when one is available. */
  readonly failedStatement?: number;
}

const EMPTY_OUTCOME: BatchExecutionOutcome = { insertedRows: 0, failed: false };

/**
 * Maps the per-statement results of one executed batch back to the rows that
 * were really inserted.
 *
 * Not every backend throws when a statement fails: the sequential executor
 * (`query.rs`) records the failure in the result array and still returns `Ok`,
 * and the MySQL batch route returns `Ok` with an embedded error result even on
 * connection checkout failure. Counting rows on the `await` alone therefore
 * over-reports inserts and can leave `continueOnError` silently dropping rows.
 *
 * `rowsPerStatement` comes from `generateInsertBatches()` and is aligned with
 * the statements that were sent; a statement counts as successful only when it
 * carries neither `execution_error` nor an `error`.
 */
export function summarizeBatchResults(results: QueryResult[] | null | undefined, rowsPerStatement: number[]): BatchExecutionOutcome {
  if (!results || results.length === 0 || rowsPerStatement.length === 0) return EMPTY_OUTCOME;

  let insertedRows = 0;
  let error: string | undefined;
  let failedStatement: number | undefined;

  for (let index = 0; index < results.length && index < rowsPerStatement.length; index++) {
    const result = results[index];
    const statementError = statementErrorMessage(result);
    if (statementError === undefined) {
      insertedRows += Math.max(0, rowsPerStatement[index]);
      continue;
    }
    if (failedStatement === undefined) {
      failedStatement = index;
      error = statementError;
    }
  }

  const failed = failedStatement !== undefined;
  return failed ? { insertedRows, failed, error, failedStatement } : { insertedRows, failed };
}

function statementErrorMessage(result: QueryResult): string | undefined {
  if (!result) return "Unknown statement failure";
  if (result.execution_error === true) {
    return result.error?.detail ?? result.error?.messageKey ?? errorMessageFromRows(result);
  }
  if (result.error) {
    return result.error.detail ?? result.error.messageKey;
  }
  return undefined;
}

/** Error-shaped results carry the driver message in a single "Error" row. */
function errorMessageFromRows(result: QueryResult): string | undefined {
  const firstRow = result.rows?.[0];
  const firstCell = Array.isArray(firstRow) ? firstRow[0] : undefined;
  return typeof firstCell === "string" && firstCell.trim().length > 0 ? firstCell : undefined;
}

const CANCELLATION_PATTERN = /\bcancel(?:ed|led|ing|ling|lation)?\b/i;

/**
 * Recognizes a failure produced by cancelling a query.
 *
 * Cancelling a transaction or a single-statement round trip surfaces as an
 * error instead of a quiet stop, so a user-initiated cancel has to be told
 * apart from a real SQL failure. The backend reports cancellation as
 * "Query canceled" (`QUERY_CANCELED`); structured backend errors are matched on
 * their code/message key as well.
 */
export function isQueryCanceledError(error: unknown): boolean {
  if (error instanceof BackendErrorException) {
    const { code, messageKey, detail } = error.backendError;
    if (CANCELLATION_PATTERN.test(code) || CANCELLATION_PATTERN.test(messageKey)) return true;
    if (detail !== undefined && CANCELLATION_PATTERN.test(detail)) return true;
  }
  return CANCELLATION_PATTERN.test(errorMessage(error));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
