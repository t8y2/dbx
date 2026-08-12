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
      { id: "anthropic-compatible", provider: "anthropic-compatible" },
      { id: "openai", provider: "openai" },
      { id: "gemini", provider: "gemini" },
      { id: "deepseek", provider: "deepseek" },
      { id: "qwen", provider: "qwen" },
      { id: "minimax", provider: "minimax" },
      { id: "ollama", provider: "ollama" },
      { id: "openai-compatible", provider: "openai-compatible" },
      { id: "codex", provider: "codex-cli" },
      { id: "opencode", provider: "opencode-cli" },
      { id: "cursor", provider: "cursor-cli" },
      { id: "codebuddy", provider: "codebuddy-cli" },
      { id: "qoder", provider: "qoder-cli" },
      { id: "grok", provider: "grok-cli" },
      { id: "pi", provider: "pi-agent-cli" },
      { id: "custom", provider: "custom" },
    ];

    expect(orderAiConfigsForDisplay(configs).map((config) => config.id)).toEqual(["claude", "openai", "gemini", "deepseek", "qwen", "minimax", "ollama", "anthropic-compatible", "openai-compatible", "claude-code-1", "codex", "opencode", "cursor", "codebuddy", "qoder", "grok", "pi", "custom"]);
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
