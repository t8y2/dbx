import { describe, expect, it } from "vitest";
import { orderAiConfigsForDisplay } from "@/lib/ai/aiConfigOrdering";
import type { AiProvider } from "@/types/ai";

interface TestConfig {
  id: string;
  provider: AiProvider;
}

describe("orderAiConfigsForDisplay", () => {
  it("matches the canonical provider order", () => {
    const configs: TestConfig[] = [
      { id: "claude-code-1", provider: "claude-code-cli" },
      { id: "claude", provider: "claude" },
      { id: "openai", provider: "openai" },
      { id: "codex", provider: "codex-cli" },
      { id: "custom", provider: "custom" },
    ];

    expect(orderAiConfigsForDisplay(configs).map((config) => config.id)).toEqual(["claude", "openai", "claude-code-1", "codex", "custom"]);
  });

  it("preserves creation order for configs from the same provider", () => {
    const configs: TestConfig[] = [
      { id: "codex-1", provider: "codex-cli" },
      { id: "claude-code-1", provider: "claude-code-cli" },
      { id: "codex-2", provider: "codex-cli" },
      { id: "claude-code-2", provider: "claude-code-cli" },
    ];

    expect(orderAiConfigsForDisplay(configs).map((config) => config.id)).toEqual(["claude-code-1", "claude-code-2", "codex-1", "codex-2"]);
  });
});
