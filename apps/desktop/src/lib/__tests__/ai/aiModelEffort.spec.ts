import { describe, expect, it } from "vitest";
import { normalizeAiModelEffortLevels, normalizeClaudeCodeReasoningLevel } from "@/lib/ai/aiModelEffort";
import type { AiModelInfo } from "@/lib/backend/tauri";

describe("normalizeAiModelEffortLevels", () => {
  it("preserves the CLI order while removing duplicates and unknown levels", () => {
    expect(normalizeAiModelEffortLevels(["low", "high", "xhigh", "high", "future", null, "max"])).toEqual(["low", "high", "xhigh", "max"]);
  });

  it("returns no configurable levels when metadata is unavailable", () => {
    expect(normalizeAiModelEffortLevels(undefined)).toEqual([]);
  });
});

describe("normalizeClaudeCodeReasoningLevel", () => {
  const model: AiModelInfo = {
    id: "claude-sonnet-5",
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  };

  it("keeps an effort level reported by the selected model", () => {
    expect(normalizeClaudeCodeReasoningLevel("xhigh", model)).toBe("xhigh");
  });

  it("falls back to default for unsupported or missing model metadata", () => {
    expect(normalizeClaudeCodeReasoningLevel("minimal", model)).toBe("default");
    expect(normalizeClaudeCodeReasoningLevel("max", { id: "default" })).toBe("default");
  });
});
