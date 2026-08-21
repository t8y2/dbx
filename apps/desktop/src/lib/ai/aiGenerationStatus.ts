/**
 * Pure state machine + copy helpers for the AI assistant's live generation-status
 * line (Issue #6743, feature 1).
 *
 * The component keeps an `AiGenerationStatus` ref, feeds every `ai-agent-event`
 * into `applyStatusEvent`, and drives a 1s interval that recomputes `now` for
 * `statusText`/`shouldShowLongRunningHint`. Keeping the reducer and the copy
 * selection pure (both inject `now`, i18n `t` is injected into `statusText`)
 * makes the whole feature unit-testable without a DOM harness, matching the
 * existing pattern of `aiConversationLifecycle.ts` / `aiGenerationGuard.ts`.
 *
 * Phase determination is EVENT-DRIVEN, never mode-based: Ask mode also emits
 * `turn_start` and can invoke read-only tools, so `running_tool` is decided purely
 * by `tool_call_start`/`tool_call_end`, not by `assistantMode`.
 */
import type { AgentEvent } from "@/lib/backend/tauri";

export interface AiGenerationStatus {
  /** When `send()` set `isGenerating=true`. Elapsed time is derived from this. */
  startedAt: number;
  /** Most recent event time; `undefined` means no agent event has arrived yet. */
  lastEventAt?: number;
  /** 0-based turn from the latest `turn_start`; display as `turn + 1`. */
  turn?: number;
  /** Active tool between `tool_call_start` and the matching `tool_call_end`. */
  activeTool?: { name: string; startedAt: number };
  phase: "preparing" | "waiting_model" | "generating" | "running_tool" | "cancelling";
  /** When the user explicitly requested cancellation (Stop button). */
  cancelledAt?: number;
}

/** Events silent longer than this switch the copy to "等待此步骤完成 · 最后活动 Ns 前". */
export const STATUS_IDLE_THRESHOLD_MS = 20_000;

/** Generations running longer than this get the gentle "可继续等待或停止" hint. */
export const STATUS_LONG_RUNNING_THRESHOLD_MS = 60_000;

/** vue-i18n `t` surface consumed by `statusText` / `toolLabel` (injected for testability). */
export type AiStatusTranslate = {
  (key: string): string;
  (key: string, named: Record<string, unknown>): string;
};

/** i18n key per agent tool name; unknown tools fall back to the raw snake_case name. */
export const STATUS_TOOL_LABEL_KEYS: Record<string, string> = {
  execute_query: "ai.status.toolLabels.executeQuery",
  execute_sql: "ai.status.toolLabels.executeSql",
  list_tables: "ai.status.toolLabels.listTables",
  get_columns: "ai.status.toolLabels.getColumns",
  get_current_time: "ai.status.toolLabels.getCurrentTime",
  explain_query: "ai.status.toolLabels.explainQuery",
  get_sample_data: "ai.status.toolLabels.getSampleData",
  list_collections: "ai.status.toolLabels.listCollections",
  browse_collection: "ai.status.toolLabels.browseCollection",
};

/** Initial status at `send()` time: `phase=preparing`, `startedAt=now`. */
export function createGenerationStatus(now: number): AiGenerationStatus {
  return { startedAt: now, phase: "preparing" };
}

/**
 * Event-driven reducer. Returns a NEW status object (never mutates the input).
 *
 * - Any event refreshes `lastEventAt`.
 * - `turn_start` records the 0-based turn.
 * - `tool_call_start` enters `running_tool` and sets `activeTool`.
 * - `tool_call_end` MUST clear `activeTool`; the phase falls back to `generating`
 *   (waiting for the next model response).
 * - `text_delta` / `reasoning_delta` with no active tool enter `generating`.
 * - `write_sql_confirmation_required` / `production_write_blocked` /
 *   `context_compacted` only refresh `lastEventAt`, they never change the phase.
 * - `agent_end` / `error` are terminal and clear the status.
 * - Once the user requested cancellation, later agent events must not overwrite
 *   the `cancelling` phase — only the interval keeps ticking until the generation
 *   actually ends (component `finally`/abandon path clears it).
 */
export function applyStatusEvent(status: AiGenerationStatus, event: AgentEvent, now: number): AiGenerationStatus {
  if (status.phase === "cancelling") {
    return { ...status, lastEventAt: now };
  }
  const next: AiGenerationStatus = { ...status, lastEventAt: now };
  switch (event.type) {
    case "turn_start":
      next.turn = event.turn;
      break;
    case "tool_call_start":
      next.phase = "running_tool";
      next.activeTool = { name: event.tool_name, startedAt: now };
      break;
    case "tool_call_end":
      next.activeTool = undefined;
      next.phase = "generating";
      break;
    case "text_delta":
    case "reasoning_delta":
      if (!next.activeTool) next.phase = "generating";
      break;
    case "write_sql_confirmation_required":
    case "production_write_blocked":
    case "context_compacted":
      // Only refresh lastEventAt above; do NOT change phase.
      break;
    case "agent_end":
    case "error":
      return createGenerationStatus(now);
    default:
      break;
  }
  return next;
}

/** User explicitly requested stop — show the cancelling phase until the generation ends. */
export function markCancelling(status: AiGenerationStatus, now: number): AiGenerationStatus {
  return { ...status, phase: "cancelling", cancelledAt: now, lastEventAt: now };
}

/** Resolve a snake_case tool name through the i18n label map, falling back to the raw name. */
export function toolLabel(toolName: string, t: AiStatusTranslate): string {
  const key = STATUS_TOOL_LABEL_KEYS[toolName];
  return key ? t(key) : toolName;
}

/** Round a duration up to whole seconds. */
function secondsUp(milliseconds: number): number {
  return Math.ceil(milliseconds / 1000);
}

/**
 * Status-line copy, highest priority first:
 *
 * 1. Idle timeout (`lastEventAt` defined AND `now - lastEventAt > 20s`) →
 *    "等待此步骤完成 · 最后活动 {idle}s 前" (+ " · 正在执行 {tool}" when a tool is active).
 * 2. `running_tool` with an active tool → "第 {turn+1} 轮 · 正在执行 {tool} · 已运行 {elapsed}s".
 * 3. `generating` (a delta has arrived) → "正在生成回复 · 已运行 {elapsed}s".
 * 4. `lastEventAt === undefined` (no events yet — e.g. a slow CLI first token) →
 *    "等待模型响应 · 已运行 {elapsed}s". Separate branch: it must NOT hit the idle branch.
 *
 * Cancelling is handled first — once the user clicks Stop the line reads "正在取消…".
 * The >60s gentle hint is NOT part of this string; it renders next to the Stop
 * button via `shouldShowLongRunningHint`.
 */
export function statusText(status: AiGenerationStatus, now: number, t: AiStatusTranslate): string {
  const elapsed = secondsUp(now - status.startedAt);
  if (status.phase === "cancelling") {
    return t("ai.status.cancelling");
  }

  if (status.lastEventAt !== undefined && now - status.lastEventAt > STATUS_IDLE_THRESHOLD_MS) {
    const idle = secondsUp(now - status.lastEventAt);
    if (status.activeTool) {
      return t("ai.status.idleWithTool", { idle, tool: toolLabel(status.activeTool.name, t) });
    }
    return t("ai.status.idle", { idle });
  }

  if (status.phase === "running_tool" && status.activeTool) {
    return t("ai.status.runningTool", {
      turn: status.turn !== undefined ? status.turn + 1 : 1,
      tool: toolLabel(status.activeTool.name, t),
      elapsed,
    });
  }

  if (status.phase === "generating") {
    return t("ai.status.generating", { elapsed });
  }

  return t("ai.status.waitingModel", { elapsed });
}

/** Whether the gentle "响应时间较长，可继续等待或停止" hint should appear next to Stop. */
export function shouldShowLongRunningHint(status: AiGenerationStatus, now: number): boolean {
  return now - status.startedAt > STATUS_LONG_RUNNING_THRESHOLD_MS;
}
