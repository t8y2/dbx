import type { AiEffortLevel, AiReasoningLevel } from "@/types/ai";

interface AiModelEffortMetadata {
  supportedEffortLevels?: unknown;
}

const AI_EFFORT_LEVELS = new Set<AiEffortLevel>(["low", "medium", "high", "xhigh", "max"]);

export function normalizeAiModelEffortLevels(value: unknown): AiEffortLevel[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<AiEffortLevel>();
  const levels: AiEffortLevel[] = [];
  for (const level of value) {
    if (typeof level !== "string" || !AI_EFFORT_LEVELS.has(level as AiEffortLevel)) continue;
    const normalized = level as AiEffortLevel;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    levels.push(normalized);
  }
  return levels;
}

export function normalizeClaudeCodeReasoningLevel(reasoningLevel: AiReasoningLevel | undefined, model: AiModelEffortMetadata | undefined): AiReasoningLevel {
  if (!reasoningLevel || reasoningLevel === "default") return "default";
  const supported = normalizeAiModelEffortLevels(model?.supportedEffortLevels);
  return supported.includes(reasoningLevel as AiEffortLevel) ? reasoningLevel : "default";
}
