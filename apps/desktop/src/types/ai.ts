export type AiProvider = "claude" | "openai" | "gemini" | "deepseek" | "qwen" | "minimax" | "ollama" | "anthropic-compatible" | "openai-compatible" | "claude-code-cli" | "pi-agent-cli" | "codex-cli" | "custom";
export type AiApiStyle = "completions" | "responses" | "anthropic-messages";
export type AiAuthMethod = "api-key" | "bearer";
export type AiEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type AiReasoningLevel = "default" | "minimal" | AiEffortLevel;
export type AiCapabilitySource = "providerApi" | "localCli" | "officialRegistry" | "custom";

export type AiEffortSelection = { kind: "providerDefault" } | { kind: "disabled" } | { kind: "enum"; value: string } | { kind: "integer"; value: number } | { kind: "boolean"; value: boolean } | { kind: "text"; value: string };

export interface AiEffortOption {
  id: string;
  label: string;
  description?: string;
  selection: AiEffortSelection;
}

export type AiEffortCapability =
  | { kind: "enum"; options: AiEffortOption[]; default: AiEffortSelection; source: AiCapabilitySource }
  | { kind: "integer"; min: number; max: number; step: number; default: AiEffortSelection; specialValues?: AiEffortOption[]; source: AiCapabilitySource }
  | { kind: "boolean"; default: AiEffortSelection; source: AiCapabilitySource }
  | { kind: "freeText"; placeholder?: string; source: AiCapabilitySource }
  | { kind: "unsupported" };

export interface AiConfiguredModel {
  name: string;
  label?: string;
  supportedEffortLevels?: AiEffortLevel[];
}

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  authMethod: AiAuthMethod;
  endpoint: string;
  model: string;
  models?: AiConfiguredModel[];
  apiStyle: AiApiStyle;
  proxyEnabled?: boolean;
  proxyUrl?: string;
  enableThinking?: boolean;
  reasoningLevel?: AiReasoningLevel;
  contextWindow?: number;
  codexCliPath?: string | null;
  codexCliEnv?: Record<string, string>;
  claudeCodeCliPath?: string | null;
  claudeCodeCliEnv?: Record<string, string>;
  piAgentCliPath?: string | null;
  piAgentCliEnv?: Record<string, string>;
  runtimeEffort?: AiEffortSelection | null;
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

export interface AiActiveModelSelection {
  configId: string;
  modelId: string;
}

export interface AiModelEffortPreference {
  configId: string;
  modelId: string;
  selection: AiEffortSelection;
}

export interface AiChatSelectionState {
  version: number;
  active?: AiActiveModelSelection;
  effortPreferences: AiModelEffortPreference[];
}
