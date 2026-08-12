import type { AiConfig } from "@/types/ai";

const CLI_PROVIDERS = new Set<AiConfig["provider"]>(["codex-cli", "claude-code-cli", "opencode-cli", "pi-agent-cli", "cursor-cli", "grok-cli", "codebuddy-cli", "qoder-cli"]);

export function isAiConfigModelCandidate(config: AiConfig, requiresApiKey: boolean, supportsCliProviders = true): boolean {
  // CLI providers resolve their model and credentials externally, so keep the existing eligibility bypass.
  if (CLI_PROVIDERS.has(config.provider)) return supportsCliProviders;
  return !!config.endpoint?.trim() && (!requiresApiKey || !!config.apiKey?.trim());
}
