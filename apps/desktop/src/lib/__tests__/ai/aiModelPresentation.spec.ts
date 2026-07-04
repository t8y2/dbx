import { describe, expect, it } from "vitest";
import { formatAiModelOption, shouldShowAiModelSecondaryLabel } from "@/lib/ai/aiModelPresentation";

describe("shouldShowAiModelSecondaryLabel", () => {
  it("hides secondary text when display name only changes case", () => {
    expect(shouldShowAiModelSecondaryLabel("GPT-5.5", "gpt-5.5")).toBe(false);
  });

  it("hides secondary text when display name only changes separators", () => {
    expect(shouldShowAiModelSecondaryLabel("GPT-5.4-Mini", "gpt-5.4-mini")).toBe(false);
  });

  it("hides secondary text for exact matches", () => {
    expect(shouldShowAiModelSecondaryLabel("gpt-5.3-codex", "gpt-5.3-codex")).toBe(false);
  });

  it("keeps secondary text when provider display name is meaningfully different", () => {
    expect(shouldShowAiModelSecondaryLabel("Claude Sonnet 4", "claude-sonnet-4-20250514")).toBe(true);
  });
});

describe("formatAiModelOption", () => {
  it("returns a single-line Codex-style model option", () => {
    expect(formatAiModelOption("GPT-5.5", "gpt-5.5")).toEqual({ primary: "GPT-5.5", secondary: undefined });
  });

  it("returns model id as secondary text only when useful", () => {
    expect(formatAiModelOption("Claude Sonnet 4", "claude-sonnet-4-20250514")).toEqual({
      primary: "Claude Sonnet 4",
      secondary: "claude-sonnet-4-20250514",
    });
  });
});
