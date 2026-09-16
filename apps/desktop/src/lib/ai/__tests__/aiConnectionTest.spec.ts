import { describe, expect, it } from "vitest";
import type { AiConfig } from "@/types/ai";
import { isAiConnectionTestConfigCurrent } from "../aiConnectionTest";

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: "openai-compatible",
    apiKey: "key",
    authMethod: "bearer",
    endpoint: "https://example.com/v1",
    model: "model-a",
    apiStyle: "completions",
    ...overrides,
  };
}

describe("AI connection test configuration", () => {
  it("accepts a result only while the tested form values remain current", () => {
    const tested = config();

    expect(isAiConnectionTestConfigCurrent(tested, config())).toBe(true);
    expect(isAiConnectionTestConfigCurrent(tested, config({ model: "model-b" }))).toBe(false);
    expect(isAiConnectionTestConfigCurrent(tested, config({ endpoint: "https://other.example/v1" }))).toBe(false);
    expect(isAiConnectionTestConfigCurrent(tested, config({ apiKey: "new-key" }))).toBe(false);
  });
});
