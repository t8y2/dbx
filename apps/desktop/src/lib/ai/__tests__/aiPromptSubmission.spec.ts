import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canSubmitAiPrompt } from "@/lib/ai/aiPromptKeyboard";

const aiAssistantSource = readFileSync(new URL("../../../components/editor/AiAssistant.vue", import.meta.url), "utf8");

function submissionState(overrides: Partial<Parameters<typeof canSubmitAiPrompt>[0]> = {}) {
  return {
    prompt: "",
    contextItemCount: 0,
    isAttachmentProcessing: false,
    hasTab: true,
    hasConnection: true,
    ...overrides,
  };
}

describe("AI prompt submission eligibility", () => {
  it("allows text and attachment submissions without requiring a tab-local database", () => {
    expect(canSubmitAiPrompt(submissionState({ prompt: "show current users" }))).toBe(true);
    expect(canSubmitAiPrompt(submissionState({ contextItemCount: 1 }))).toBe(true);
  });

  it("rejects empty, processing, and missing-context submissions", () => {
    expect(canSubmitAiPrompt(submissionState())).toBe(false);
    expect(canSubmitAiPrompt(submissionState({ prompt: "ask", isAttachmentProcessing: true }))).toBe(false);
    expect(canSubmitAiPrompt(submissionState({ prompt: "ask", hasTab: false }))).toBe(false);
    expect(canSubmitAiPrompt(submissionState({ prompt: "ask", hasConnection: false }))).toBe(false);
  });

  it("wires the click button to the shared eligibility rule", () => {
    expect(aiAssistantSource).toContain("const canSubmitPrompt = computed(() =>");
    expect(aiAssistantSource).toContain(':disabled="!canSubmitPrompt"');
    expect(aiAssistantSource).not.toMatch(/:disabled=.*props\.tab\?\.database/);
  });
});
