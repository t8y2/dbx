import type { AiConfig } from "@/types/ai";

const CLI_PROVIDERS = new Set<AiConfig["provider"]>(["codex-cli", "claude-code-cli", "opencode-cli", "pi-agent-cli", "cursor-cli", "grok-cli"]);

export function isAiConfigModelCandidate(config: AiConfig, requiresApiKey: boolean): boolean {
  // CLI providers resolve their model and credentials externally, so keep the existing eligibility bypass.
  if (CLI_PROVIDERS.has(config.provider)) return true;
  return !!config.endpoint?.trim() && (!requiresApiKey || !!config.apiKey?.trim());
}
