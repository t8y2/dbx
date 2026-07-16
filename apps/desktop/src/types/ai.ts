export type AiProvider = "claude" | "openai" | "gemini" | "deepseek" | "qwen" | "ollama" | "openai-compatible" | "codex-cli" | "custom";
export type AiApiStyle = "completions" | "responses" | "anthropic-messages";
export type AiAuthMethod = "api-key" | "bearer";
export type AiReasoningLevel = "default" | "minimal" | "low" | "medium" | "high";

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  authMethod: AiAuthMethod;
  endpoint: string;
  model: string;
  models?: Array<{ name: string; label?: string }>;
  apiStyle: AiApiStyle;
  proxyEnabled?: boolean;
  proxyUrl?: string;
  enableThinking?: boolean;
  reasoningLevel?: AiReasoningLevel;
  contextWindow?: number;
  codexCliPath?: string | null;
  codexCliEnv?: Record<string, string>;
}

export interface AiTestConnectionResult {
  success: boolean;
  message: string;
  latencyMs?: number;
  modelUsed: string;
  errorCategory?: string;
}

export interface AiConfigItem extends AiConfig {
  id: string;
  name: string;
  isDefault?: boolean;
}
