import type { FunctionDiff, SchemaDiffRoutineStep, SchemaDiffRoutineValidation } from "@/lib/schema/schemaDiff";
import { schemaDiffRoutineType } from "@/lib/schema/schemaDiffRoutine";

export interface DeployTxResult {
  success: boolean;
  status?: string;
  message: string;
  affectedRows?: number;
  error?: string;
  executedCount?: number;
  statementCount?: number;
  routineValidations?: SchemaDiffRoutineValidation[];
  executedSteps?: string[];
}

/** Keep each PL/SQL body whole; trigger state changes are separate statements. */
export function schemaDiffRoutineExecutionStatements(steps: SchemaDiffRoutineStep[]): string[] {
  if (steps.some((step) => step.blockedReason || !step.sql?.trim())) throw new Error("Program object plan is blocked or incomplete");
  return steps.flatMap((step) => [step.sql!, ...(step.postSql ?? [])]);
}

export function schemaDiffRoutineExecutedSteps(steps: SchemaDiffRoutineStep[], executedCount: number): string[] {
  return steps.flatMap((step) => [
    `${step.routineType} ${step.targetSchema ? `${step.targetSchema}.` : ""}${step.name}${step.trigger ? ` · ${step.trigger.tableOwner}.${step.trigger.tableName}` : ""}`,
    ...(step.postSql ?? []),
  ]).slice(0, Math.max(0, executedCount));
}

/** Validate the generated target definition, including reviewed owner/edition conversion. */
export function schemaDiffRoutineExpectedDefinitions(expected: FunctionDiff[], steps: SchemaDiffRoutineStep[], rollback = false): FunctionDiff[] {
  return expected.map((diff) => {
    const info = rollback ? diff.target : diff.source;
    const step = steps.find((step) => step.name === diff.name && step.routineType === schemaDiffRoutineType(info?.function_type));
    if (!info || !step?.sql || step.operation === "removed") return diff;
    const mapped = { ...info, definition: step.sql };
    return rollback ? { ...diff, target: mapped } : { ...diff, source: mapped };
  });
}

/** Oracle DDL can commit while leaving an INVALID routine. Readback is part of deployment. */
export async function finishSchemaDiffDeployment(txLog: any, expected: FunctionDiff[], validate: (expected: FunctionDiff[]) => Promise<SchemaDiffRoutineValidation[]>, t: (key: string, params?: Record<string, any>) => string, rollback = false, targetSchema?: string): Promise<DeployTxResult> {
  const result = buildDeployTxResult(txLog, t);
  if (expected.length > 0 && result.status === "rolled_back") return { ...result, message: t("diff.routineRecoveryHint") };
  if (!result.success || expected.length === 0) return result;
  const validationInput = rollback ? expected.map((diff): FunctionDiff => ({ ...diff, type: diff.type === "added" ? "removed" : diff.type === "removed" ? "added" : "modified", source: diff.target, target: diff.source })) : expected;
  try {
    const validations = await validate(validationInput);
    const complete = validationInput.every((diff) => {
      const fn = diff.source ?? diff.target;
      const routineType = schemaDiffRoutineType(fn?.function_type);
      const trigger = fn?.trigger;
      const tableOwner = trigger && trigger.tableOwner === fn?.schema ? targetSchema ?? trigger.tableOwner : trigger?.tableOwner;
      const matches = validations.filter((item) => (!targetSchema || item.schema === undefined || item.schema === targetSchema) && item.name === diff.name && item.routineType === routineType && item.trigger?.tableName === trigger?.tableName && item.trigger?.tableOwner === tableOwner);
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
