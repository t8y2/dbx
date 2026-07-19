import { describe, expect, it } from "vitest";
import { shouldShowReasoningCharCount, reasoningCharCountClass, REASONING_CHAR_COUNT_BASE_CLASS, REASONING_CHAR_COUNT_PULSE_CLASS } from "@/lib/ai/aiReasoningPresentation";

describe("shouldShowReasoningCharCount", () => {
  it("shows the counter when reasoning exists and the panel is collapsed", () => {
    expect(shouldShowReasoningCharCount("正在分析表结构...", false)).toBe(true);
  });

  it("hides the counter when the panel is expanded", () => {
    expect(shouldShowReasoningCharCount("正在分析表结构...", true)).toBe(false);
  });

  it("hides the counter when reasoning is empty", () => {
    expect(shouldShowReasoningCharCount("", false)).toBe(false);
  });

  it("hides the counter when reasoning is undefined", () => {
    expect(shouldShowReasoningCharCount(undefined, false)).toBe(false);
  });
});

describe("reasoningCharCountClass", () => {
  it("includes the pulse class while the model is still thinking", () => {
    const cls = reasoningCharCountClass(true);
    expect(cls).toContain(REASONING_CHAR_COUNT_BASE_CLASS);
    expect(cls).toContain(REASONING_CHAR_COUNT_PULSE_CLASS);
  });

  it("uses only the base class when thinking has finished", () => {
    expect(reasoningCharCountClass(false)).toBe(REASONING_CHAR_COUNT_BASE_CLASS);
  });
});
