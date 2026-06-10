import type { AiAction, AiAssistantMode } from "@/lib/ai";
import { classifyAiSqlExecution, shouldAttemptAiAutoExecute, stripAiSqlComments, type AiSqlExecutionDecision } from "@/lib/aiSqlExecutionPolicy";
import type { ConnectionConfig } from "@/types/database";

export type AiAgentStep =
  | { kind: "generate_sql"; status: "done"; sql: string }
  | { kind: "generate_sql"; status: "skipped"; reason: "no_sql" }
  | ({
      kind: "risk_check";
      status: "done";
    } & AiSqlExecutionDecision)
  | { kind: "execute_sql"; status: "pending"; sql: string }
  | {
      kind: "execute_sql";
      status: "skipped";
      reason: "ask_mode" | "no_sql" | "no_execution_intent" | "unsupported_action" | "blocked_by_policy" | "requires_confirmation";
    };

export interface AiAgentPlanInput {
  mode: AiAssistantMode;
  action: AiAction;
  instruction: string;
  assistantContent: string;
  connection?: ConnectionConfig;
}

export interface AiAgentPlan {
  steps: AiAgentStep[];
  executableSql?: string;
  handoffSql?: string;
}

export function buildAiAgentPlan(input: AiAgentPlanInput): AiAgentPlan {
  const sql = extractFirstExecutableSqlCodeBlock(input.assistantContent);
  if (!sql) {
    return {
      steps: [
        { kind: "generate_sql", status: "skipped", reason: "no_sql" },
        { kind: "execute_sql", status: "skipped", reason: "no_sql" },
      ],
    };
  }

  const steps: AiAgentStep[] = [{ kind: "generate_sql", status: "done", sql }];

  if (input.mode !== "agent") {
    steps.push({ kind: "execute_sql", status: "skipped", reason: "ask_mode" });
    return { steps };
  }

  if (input.action !== "generate") {
    steps.push({ kind: "execute_sql", status: "skipped", reason: "unsupported_action" });
    return { steps };
  }

  if (!shouldAttemptAiAutoExecute(input.instruction, input.action)) {
    steps.push({ kind: "execute_sql", status: "skipped", reason: "no_execution_intent" });
    return { steps };
  }

  const decision = classifyAiSqlExecution(sql, input.connection);
  steps.push({ kind: "risk_check", status: "done", ...decision });

  if (decision.action === "auto_execute") {
    steps.push({ kind: "execute_sql", status: "pending", sql });
    return { steps, executableSql: sql, handoffSql: sql };
  }

  steps.push({
    kind: "execute_sql",
    status: "skipped",
    reason: decision.action === "block" ? "blocked_by_policy" : "requires_confirmation",
  });
  return { steps, handoffSql: sql };
}

function extractFirstExecutableSqlCodeBlock(content: string): string | undefined {
  const blocks = content.matchAll(/```(?:sql|mysql|postgresql|sqlite|tsql|clickhouse)?\s*\n([\s\S]*?)```/gi);
  for (const block of blocks) {
    const sql = block[1]?.trim();
    if (sql && stripAiSqlComments(sql).trim()) return sql;
  }
  return undefined;
}
