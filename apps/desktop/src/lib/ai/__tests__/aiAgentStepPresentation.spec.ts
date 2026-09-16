import { describe, expect, it } from "vitest";
import { formatToolDurationMs, toolCallStepKey, upsertAgentStep, type AiAgentStepItem } from "@/lib/ai/aiAgentStepPresentation";

const startStep: AiAgentStepItem = {
  key: "tool-call-1",
  labelKey: "ai.agentSteps.callingTool",
  tone: "active",
  toolName: "list_tables",
  toolArgs: { sql: "SHOW TABLES" },
  startedAtMs: 1_000,
};

describe("aiAgentStepPresentation", () => {
  describe("toolCallStepKey (stable merge key)", () => {
    it("merges start/end for a real tool_call_id", () => {
      expect(toolCallStepKey("call-1", 0, "tool_call_start")).toBe(toolCallStepKey("call-1", 1, "tool_call_end"));
    });

    it("keeps missing/repeating fallback ids event-specific so unrelated calls cannot collapse", () => {
      expect(toolCallStepKey("", 0, "tool_call_start")).not.toBe(toolCallStepKey("", 0, "tool_call_end"));
      expect(toolCallStepKey("cli-tool-call", 0, "tool_call_start")).not.toBe(toolCallStepKey("cli-tool-call", 1, "tool_call_end"));
    });
  });

  describe("upsertAgentStep (duration merge)", () => {
    it("merges the end step onto the start card, computing durationMs and preserving startedAtMs", () => {
      const steps: AiAgentStepItem[] = [];
      upsertAgentStep(steps, startStep);
      upsertAgentStep(steps, {
        key: "tool-call-1",
        labelKey: "ai.agentSteps.toolDone",
        tone: "success",
        toolName: "list_tables",
        toolResult: "…",
        isError: false,
        endedAtMs: 1_800,
      });

      expect(steps).toHaveLength(1);
      const merged = steps[0];
      expect(merged.durationMs).toBe(800);
      expect(merged.startedAtMs).toBe(1_000);
      expect(merged.endedAtMs).toBe(1_800);
      // Details gathered from the start card survive the merge.
      expect(merged.toolArgs).toEqual({ sql: "SHOW TABLES" });
    });

    it("does not compute durationMs for an end step without a seen start", () => {
      const steps: AiAgentStepItem[] = [];
      upsertAgentStep(steps, {
        key: "tool-call-2",
        labelKey: "ai.agentSteps.toolDone",
        tone: "success",
        toolName: "execute_query",
        toolResult: "ok",
        isError: false,
        endedAtMs: 5_000,
      });

      expect(steps).toHaveLength(1);
      expect(steps[0].durationMs).toBeUndefined();
    });

    it("clamps a negative duration to 0 (out-of-order stamps)", () => {
      const steps: AiAgentStepItem[] = [];
      upsertAgentStep(steps, { ...startStep, startedAtMs: 2_000 });
      upsertAgentStep(steps, {
        key: "tool-call-1",
        labelKey: "ai.agentSteps.toolDone",
        tone: "success",
        toolName: "list_tables",
        endedAtMs: 500,
      });

      expect(steps[0].durationMs).toBe(0);
    });
  });

  describe("formatToolDurationMs", () => {
    it("formats sub-second durations with one decimal", () => {
      expect(formatToolDurationMs(799)).toBe("0.8s");
      expect(formatToolDurationMs(800)).toBe("0.8s");
    });

    it("formats 1s–10s with one decimal", () => {
      expect(formatToolDurationMs(1_000)).toBe("1.0s");
      expect(formatToolDurationMs(1_200)).toBe("1.2s");
      expect(formatToolDurationMs(9_999)).toBe("10.0s");
    });

    it("formats ≥10s as an integer", () => {
      expect(formatToolDurationMs(10_000)).toBe("10s");
      expect(formatToolDurationMs(12_000)).toBe("12s");
      expect(formatToolDurationMs(65_432)).toBe("65s");
    });
  });
});
