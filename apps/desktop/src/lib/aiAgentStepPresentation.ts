import type { AiAgentPlan, AiAgentStep } from "@/lib/aiAgentPlan";

export type AiAgentStepTone = "success" | "active" | "warning" | "danger" | "muted";

export interface AiAgentStepItem {
  key: string;
  labelKey: string;
  tone: AiAgentStepTone;
  titleKey?: string;
  titleParams?: Record<string, string>;
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
    case "unsupported_action":
      return "ai.agentStepTitles.unsupportedAction";
    case "no_sql":
      return "ai.agentStepTitles.noSql";
    default:
      return "ai.agentStepTitles.skipped";
  }
}
