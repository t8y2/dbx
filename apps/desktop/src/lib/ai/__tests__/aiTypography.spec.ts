import { describe, expect, it } from "vitest";
import {
  AI_CONVERSATION_FONT_FAMILY_DEFAULT,
  AI_CONVERSATION_FONT_SIZE_DEFAULT,
  AI_CONVERSATION_FONT_SIZE_MAX,
  AI_CONVERSATION_FONT_SIZE_MIN,
  aiConversationFontFamilyForName,
  aiConversationTypographyCssVariables,
  normalizeAiConversationFontFamily,
  normalizeAiConversationFontFamilyInput,
  normalizeAiConversationFontSize,
  normalizeAiConversationTypography,
} from "@/lib/ai/aiTypography";

describe("AI conversation typography", () => {
  it("preserves the legacy inherited 12px appearance for sparse settings", () => {
    expect(normalizeAiConversationTypography(undefined)).toEqual({
      fontFamily: AI_CONVERSATION_FONT_FAMILY_DEFAULT,
      fontSize: AI_CONVERSATION_FONT_SIZE_DEFAULT,
    });
    expect(aiConversationTypographyCssVariables(undefined)).toEqual({
      "--dbx-ai-content-font-size": "12px",
      "--dbx-ai-code-font-size": "12px",
      "--dbx-ai-inline-code-font-size": "11px",
    });
  });

  it("sanitizes font families and clamps invalid sizes", () => {
    expect(normalizeAiConversationFontFamily(null)).toBe("");
    expect(normalizeAiConversationFontFamily("  'Atkinson Hyperlegible', sans-serif\n")).toBe("'Atkinson Hyperlegible', sans-serif");
    expect(aiConversationFontFamilyForName("Reader's Choice")).toBe("'Reader\\'s Choice', sans-serif");
    expect(normalizeAiConversationFontFamilyInput("Atkinson Hyperlegible")).toBe("'Atkinson Hyperlegible', sans-serif");
    expect(normalizeAiConversationFontFamilyInput("Georgia, serif")).toBe("Georgia, serif");
    expect(normalizeAiConversationFontSize(Number.NaN)).toBe(AI_CONVERSATION_FONT_SIZE_DEFAULT);
    expect(normalizeAiConversationFontSize("18")).toBe(AI_CONVERSATION_FONT_SIZE_DEFAULT);
    expect(normalizeAiConversationFontSize(1)).toBe(AI_CONVERSATION_FONT_SIZE_MIN);
    expect(normalizeAiConversationFontSize(99)).toBe(AI_CONVERSATION_FONT_SIZE_MAX);
    expect(normalizeAiConversationFontSize(15.6)).toBe(16);
  });

  it("creates scoped prose and monospace code sizes from a custom preference", () => {
    expect(aiConversationTypographyCssVariables({ fontFamily: "Georgia, serif", fontSize: 18 })).toEqual({
      "--dbx-ai-content-font-family": "Georgia, serif",
      "--dbx-ai-content-font-size": "18px",
      "--dbx-ai-code-font-size": "18px",
      "--dbx-ai-inline-code-font-size": "17px",
    });
  });
});
