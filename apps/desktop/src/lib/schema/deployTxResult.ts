export interface DeployTxResult {
  success: boolean;
  status?: string;
  message: string;
  affectedRows?: number;
  error?: string;
  executedCount?: number;
  statementCount?: number;
}

export function buildDeployTxResult(txLog: any, t: (key: string, params?: Record<string, any>) => string): DeployTxResult {
  const status = txLog?.status;
  const error = txLog?.error ?? txLog?.metadata?.error;
  const executedCount = txLog?.executedCount ?? txLog?.executed_count;
  const statementCount = txLog?.statementCount ?? txLog?.statement_count;
  const affectedRows = txLog?.metadata?.affected_rows ?? txLog?.affectedRows;

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
