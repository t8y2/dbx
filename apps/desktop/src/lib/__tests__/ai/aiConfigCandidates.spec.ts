import { describe, expect, it } from "vitest";
import { getAiConfigModelIds, isAiConfigModelCandidate } from "@/lib/ai/aiConfigCandidates";
import type { AiConfig } from "@/types/ai";

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: "openai",
    apiKey: "secret",
    authMethod: "bearer",
    endpoint: "https://api.example.com/v1",
    model: "gpt-default",
    apiStyle: "completions",
    ...overrides,
  };
}

describe("isAiConfigModelCandidate", () => {
  it("accepts discovered models when the default model is empty", () => {
    expect(isAiConfigModelCandidate(config({ model: "", models: [{ name: "gpt-new" }] }), true)).toBe(true);
  });

  it("keeps endpoint and required API key validation", () => {
    expect(isAiConfigModelCandidate(config({ endpoint: "" }), true)).toBe(false);
    expect(isAiConfigModelCandidate(config({ apiKey: "" }), true)).toBe(false);
  });

  it.each(["codex-cli", "claude-code-cli"] as const)("keeps %s configs eligible without endpoint, API key, or model metadata", (provider) => {
    expect(
      isAiConfigModelCandidate(
        config({
          provider,
          endpoint: "",
          apiKey: "",
          model: "",
          models: [],
        }),
        false,
      ),
    ).toBe(true);
  });
});

describe("getAiConfigModelIds", () => {
  it("includes the default model once while preserving configured model order", () => {
    expect(
      getAiConfigModelIds(
        config({
          model: "gpt-default",
          models: [{ name: "gpt-fast" }, { name: "gpt-default" }, { name: "gpt-default" }],
        }),
      ),
    ).toEqual(["gpt-fast", "gpt-default"]);
  });
});
