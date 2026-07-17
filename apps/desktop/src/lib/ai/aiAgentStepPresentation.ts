import type { AiAgentPlan, AiAgentStep } from "@/lib/ai/aiAgentPlan";

export type AiAgentStepTone = "success" | "active" | "warning" | "danger" | "muted";

export interface AiAgentStepItem {
  key: string;
  labelKey: string;
  tone: AiAgentStepTone;
  titleKey?: string;
  titleParams?: Record<string, string>;
  /** Tool name for display */
  toolName?: string;
  /** Tool arguments (e.g., SQL query) for display */
  toolArgs?: Record<string, unknown>;
  /** Tool result content (e.g., query results) for display */
  toolResult?: string;
  /** Whether this is an error result */
  isError?: boolean;
  /** Structured explain plan data (for explain_query tool results) */
  explainData?: unknown;
}

/** Backend fallback tool_call_id values that repeat across calls and must not be used as stable merge keys. */
const REPEATING_TOOL_CALL_IDS = new Set(["cli-tool-call"]);

/**
 * Build a tool step key. Real tool_call_id values merge start/end into one card;
 * missing or known repeating fallback IDs stay event-specific to avoid collapsing unrelated calls.
 */
export function toolCallStepKey(toolCallId: string, index: number, eventType: string): string {
  if (toolCallId && !REPEATING_TOOL_CALL_IDS.has(toolCallId)) return `tool-${toolCallId}`;
  return `tool-${eventType}-${index}`;
}

/** Upsert a step, preserving details gathered from the previous state of the same card. */
export function upsertAgentStep(steps: AiAgentStepItem[], step: AiAgentStepItem) {
  const idx = steps.findIndex((s) => s.key === step.key);
  if (idx < 0) {
    steps.push(step);
    return;
  }

  const existing = steps[idx];
  const merged: AiAgentStepItem = { ...step };
  if (!merged.toolArgs && existing.toolArgs) merged.toolArgs = existing.toolArgs;
  if (!merged.explainData && existing.explainData) merged.explainData = existing.explainData;
  if (!merged.titleKey && existing.titleKey) merged.titleKey = existing.titleKey;
  if (!merged.titleParams && existing.titleParams) merged.titleParams = existing.titleParams;
  steps.splice(idx, 1, merged);
}

export function buildAiAgentStepItems(plan: AiAgentPlan): AiAgentStepItem[] {
  return plan.steps.map(presentStep);
}

function presentStep(step: AiAgentStep): AiAgentStepItem {
  if (step.kind === "generate_sql") {
    if (step.status === "done") {
      return { key: "generated", labelKey: "ai.agentSteps.generated", tone: "success" };
    }
    return { key: "noSql", labelKey: "ai.agentSteps.noSql", tone: "muted" };
  }

  if (step.kind === "risk_check") {
    const title = {
      titleKey: "ai.agentStepTitles.riskCheck",
      titleParams: {
        action: step.action,
        category: step.category,
        environment: step.environment,
        reasons: step.reasons.length ? step.reasons.join(", ") : "-",
      },
    };
    if (step.action === "auto_execute") {
      return { key: "safe", labelKey: "ai.agentSteps.safe", tone: "success", ...title };
    }
    if (step.action === "confirm") {
      return { key: "needsConfirm", labelKey: "ai.agentSteps.needsConfirm", tone: "warning", ...title };
    }
    return { key: "blocked", labelKey: "ai.agentSteps.blocked", tone: "danger", ...title };
  }

  if (step.status === "pending") {
    return { key: "autoExecute", labelKey: "ai.agentSteps.autoExecute", tone: "active" };
  }

  if (step.reason === "no_execution_intent") {
    return {
      key: "notRequested",
      labelKey: "ai.agentSteps.notRequested",
      titleKey: "ai.agentStepTitles.notRequested",
      tone: "muted",
    };
  }

  return {
    key: "skipped",
    labelKey: "ai.agentSteps.skipped",
    titleKey: skippedTitleKey(step.reason),
    tone: "muted",
  };
}

function skippedTitleKey(reason: string): string {
  switch (reason) {
    case "blocked_by_policy":
      return "ai.agentStepTitles.blocked";
    case "requires_confirmation":
      return "ai.agentStepTitles.requiresConfirmation";
    case "ask_mode":
      return "ai.agentStepTitles.askMode";
    case "no_sql":
      return "ai.agentStepTitles.noSql";
    default:
      return "ai.agentStepTitles.skipped";
  }
}
