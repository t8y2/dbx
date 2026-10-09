import type { AiAgentPlan, AiAgentStep } from "@/lib/ai/aiAgentPlan";
import type { AiToolApprovalOutcome } from "@/types/pluginAiTools";

export type AiAgentStepTone = "success" | "active" | "warning" | "danger" | "muted";

/**
 * Approval state of a plugin tool call that may change state. `pending` shows
 * the approve/deny buttons; `submitting` is the in-flight answer; `expired`
 * means the backend no longer waited when the answer arrived.
 */
export type AiAgentStepApprovalStatus = "pending" | "submitting" | "expired" | AiToolApprovalOutcome;

export interface AiAgentStepApproval {
  approvalId: string;
  /** Agent session that asked; the answer must go back to the same run. */
  sessionId: string;
  pluginName: string;
  pluginTool: string;
  connectionName: string;
  /** Exactly the arguments DBX forwards when approved. */
  args: Record<string, unknown>;
  /** Wall-clock deadline after which the backend treats the call as denied. */
  expiresAtMs: number;
  status: AiAgentStepApprovalStatus;
}

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
  /** Wall-clock timestamp when the tool call started (stamped by tool_call_start) */
  startedAtMs?: number;
  /** Wall-clock timestamp when the tool call finished (stamped by tool_call_end) */
  endedAtMs?: number;
  /** Computed tool duration (endedAtMs - startedAtMs), present only when both stamps exist */
  durationMs?: number;
  /** Present while (and after) a plugin tool call asked the user for approval */
  approval?: AiAgentStepApproval;
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
  if (!merged.approval && existing.approval) merged.approval = existing.approval;
  if (merged.startedAtMs === undefined && existing.startedAtMs !== undefined) merged.startedAtMs = existing.startedAtMs;
  if (merged.endedAtMs !== undefined && merged.startedAtMs !== undefined) {
    merged.durationMs = Math.max(0, merged.endedAtMs - merged.startedAtMs);
  }
  steps.splice(idx, 1, merged);
}

/**
 * Apply an approval change to the step keyed `toolCallKey`. Returns false when
 * the card does not exist (yet), so callers can decide whether to create it.
 */
export function updateAgentStepApproval(steps: AiAgentStepItem[], toolCallKey: string, update: (approval: AiAgentStepApproval | undefined) => AiAgentStepApproval | undefined): boolean {
  const idx = steps.findIndex((step) => step.key === toolCallKey);
  if (idx < 0) return false;
  const approval = update(steps[idx].approval);
  steps.splice(idx, 1, { ...steps[idx], approval });
  return true;
}

/**
 * `ssh__ssh_exec` → `ssh › ssh_exec`: plugin tools carry a DBX prefix that the
 * card shows as provenance; built-in tool names pass through unchanged.
 */
export function formatAgentToolName(toolName: string): string {
  const separator = toolName.indexOf("__");
  if (separator <= 0 || separator + 2 >= toolName.length) return toolName;
  return `${toolName.slice(0, separator)} › ${toolName.slice(separator + 2)}`;
}

/**
 * Format a tool duration for the step-card tail: sub-second → one decimal
 * ("0.8s"); 1s–10s → one decimal ("1.2s"); ≥10s → integer ("12s").
 * Negative durations clamp to 0; callers hide the tail entirely when
 * `durationMs` is absent.
 */
export function formatToolDurationMs(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe >= 10_000) return `${Math.round(safe / 1000)}s`;
  return `${(safe / 1000).toFixed(1)}s`;
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
