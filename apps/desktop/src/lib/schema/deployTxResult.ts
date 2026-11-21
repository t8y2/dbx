import { formatError } from "@/lib/backend/errorUtils";
import type { QueryResult } from "@/types/database";

export interface DeployFailure {
  /** Zero-based index of the statement that failed. */
  index: number;
  error: string;
}

export interface DeployTxResult {
  success: boolean;
  status?: string;
  message: string;
  affectedRows?: number;
  error?: string;
  executedCount?: number;
  statementCount?: number;
  failedCount?: number;
  failures?: DeployFailure[];
}

/**
 * Builds a deploy log for the schema-diff "continue on error" mode.
 *
 * Unlike the transactional deploy path, `executeMulti(..., { continueOnError: true })`
 * commits every statement on its own and keeps running after a failure. The result is
 * shaped like a transaction log so the existing deploy result dialog can render it,
 * with the failed statements carried in `metadata.failures`.
 */
export function buildContinueOnErrorDeployLog(results: QueryResult[]): Record<string, any> {
  const failures: DeployFailure[] = [];
  results.forEach((result, position) => {
    if (result.execution_error !== true && !result.error) return;
    failures.push({
      index: result.statement_index ?? position,
      error: result.error ? formatError(result.error) : "Statement failed",
    });
  });
  const now = new Date().toISOString();
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    transaction_id: `deploy_continue_${suffix}`,
    status: failures.length ? "completed_with_errors" : "committed",
    participants: [{ id: "connection", name: "schema-diff", role: "database" }],
    created_at: now,
    updated_at: now,
    executed_count: results.length,
    statement_count: results.length,
    error: failures.length ? failures.map((failure) => `#${failure.index + 1}: ${failure.error}`).join("\n") : null,
    metadata: {
      source: "schema_diff_deploy",
      mode: "continue_on_error",
      failures,
    },
  };
}

export function buildDeployTxResult(txLog: any, t: (key: string, params?: Record<string, any>) => string): DeployTxResult {
  const status = txLog?.status;
  const error = txLog?.error ?? txLog?.metadata?.error;
  const executedCount = txLog?.executedCount ?? txLog?.executed_count;
  const statementCount = txLog?.statementCount ?? txLog?.statement_count;
  const affectedRows = txLog?.metadata?.affected_rows ?? txLog?.affectedRows;
  const failures: DeployFailure[] = Array.isArray(txLog?.metadata?.failures) ? txLog.metadata.failures : [];
  const failedCount = failures.length;

  if (status === "committed") {
    return {
      success: true,
      status,
      message: t("diff.executeSuccess"),
      affectedRows,
      executedCount,
      statementCount,
    };
  }
  if (status === "completed_with_errors") {
    return {
      success: false,
      status,
      message: t("diff.deployCompletedWithErrors", { executedCount: executedCount ?? 0, failedCount }),
      error,
      executedCount,
      statementCount,
      failedCount,
      failures,
    };
  }
  if (status === "mixed") {
    return {
      success: false,
      status,
      message: t("diff.deployMixed", {
        participants: txLog?.participants?.length ?? 0,
        executedCount: executedCount ?? 0,
        statementCount: statementCount ?? 0,
      }),
      error,
      executedCount,
      statementCount,
      failedCount: failedCount || undefined,
      failures: failures.length ? failures : undefined,
    };
  }
  if (status === "rolled_back") {
    const detail = error ? `: ${error}` : "";
    return {
      success: false,
      status,
      message: `${t("diff.deployRolledBack")}${detail}`,
      error,
      executedCount: executedCount ?? 0,
      statementCount,
      failedCount: failedCount || undefined,
      failures: failures.length ? failures : undefined,
    };
  }
  return {
    success: false,
    status: status || "unknown",
    message: t("diff.deployFailed", { status: status || "unknown" }),
    error,
    executedCount,
    statementCount,
  };
}
