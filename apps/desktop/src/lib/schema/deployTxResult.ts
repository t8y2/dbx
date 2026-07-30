export interface DeployStatementResult {
  index: number;
  statement?: string;
  status: "success" | "failed" | "skipped" | "rolled_back";
  error?: string;
  affectedRows?: number;
  executionTimeMs?: number;
}

export interface DeployTxResult {
  success: boolean;
  status?: string;
  message: string;
  affectedRows?: number;
  executionTimeMs?: number;
  error?: string;
  executedCount?: number;
  statementCount?: number;
  statementResults?: DeployStatementResult[];
}

export function buildDeployTxResult(txLog: any, t: (key: string, params?: Record<string, any>) => string): DeployTxResult {
  const status = txLog?.status;
  const error = txLog?.error ?? txLog?.metadata?.error;
  const executedCount = txLog?.executedCount ?? txLog?.executed_count;
  const statementCount = txLog?.statementCount ?? txLog?.statement_count;
  const affectedRows = txLog?.metadata?.affected_rows ?? txLog?.affectedRows;
  const executionTimeMs = txLog?.metadata?.execution_time_ms ?? txLog?.executionTimeMs ?? txLog?.execution_time_ms;
  const statementResults: DeployStatementResult[] | undefined = txLog?.statementResults ?? txLog?.statement_results;

  if (status === "committed") {
    return {
      success: true,
      status,
      message: t("diff.executeSuccess"),
      affectedRows,
      executionTimeMs,
      executedCount,
      statementCount,
      statementResults,
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
      affectedRows,
      executionTimeMs,
      executedCount,
      statementCount,
      statementResults,
    };
  }
  if (status === "rolled_back") {
    const detail = error ? `: ${error}` : "";
    return {
      success: false,
      status,
      message: `${t("diff.deployRolledBack")}${detail}`,
      error,
      affectedRows,
      executionTimeMs,
      executedCount: executedCount ?? 0,
      statementCount,
      statementResults,
    };
  }
  return {
    success: false,
    status: status || "unknown",
    message: t("diff.deployFailed", { status: status || "unknown" }),
    error,
    affectedRows,
    executionTimeMs,
    executedCount,
    statementCount,
    statementResults,
  };
}
