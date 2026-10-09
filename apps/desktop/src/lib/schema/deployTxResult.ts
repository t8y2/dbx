import type { FunctionDiff, SchemaDiffRoutineValidation } from "@/lib/schema/schemaDiff";

export interface DeployTxResult {
  success: boolean;
  status?: string;
  message: string;
  affectedRows?: number;
  error?: string;
  executedCount?: number;
  statementCount?: number;
  routineValidations?: SchemaDiffRoutineValidation[];
}

/** Oracle DDL can commit while leaving an INVALID routine. Readback is part of deployment. */
export async function finishSchemaDiffDeployment(txLog: any, expected: FunctionDiff[], validate: (expected: FunctionDiff[]) => Promise<SchemaDiffRoutineValidation[]>, t: (key: string, params?: Record<string, any>) => string, rollback = false): Promise<DeployTxResult> {
  const result = buildDeployTxResult(txLog, t);
  if (!result.success || expected.length === 0) return result;
  const validationInput = rollback ? expected.map((diff): FunctionDiff => ({ ...diff, type: diff.type === "added" ? "removed" : diff.type === "removed" ? "added" : "modified", source: diff.target, target: diff.source })) : expected;
  try {
    const validations = await validate(validationInput);
    const complete = validationInput.every((diff) => {
      const routineType = (diff.source?.function_type ?? diff.target?.function_type ?? "").toUpperCase().includes("PROC") ? "PROCEDURE" : "FUNCTION";
      const matches = validations.filter((item) => item.name === diff.name && item.routineType === routineType);
      return matches.length === 1 && matches[0]!.success;
    });
    if (complete && validations.every((item) => item.success)) return { ...result, routineValidations: validations };
    return { ...result, success: false, status: "validation_failed", message: t("diff.routineValidationFailed"), routineValidations: validations };
  } catch (error) {
    return { ...result, success: false, status: "validation_failed", message: t("diff.routineValidationFailed"), error: error instanceof Error ? error.message : String(error) };
  }
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
