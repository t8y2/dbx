import type { AiConfig } from "@/types/ai";

const CLI_PROVIDERS = new Set<AiConfig["provider"]>(["codex-cli", "claude-code-cli"]);

export function getAiConfigModelIds(config: Pick<AiConfig, "model" | "models">): string[] {
  const configuredModels = [...new Set(config.models?.map((model) => model.name) ?? [])];
  return config.model && !configuredModels.includes(config.model) ? [config.model, ...configuredModels] : configuredModels;
}

export function isAiConfigModelCandidate(config: AiConfig, requiresApiKey: boolean): boolean {
  // CLI providers resolve their model and credentials externally, so keep the existing eligibility bypass.
  if (CLI_PROVIDERS.has(config.provider)) return true;
  if (!config.endpoint?.trim() || (requiresApiKey && !config.apiKey?.trim())) return false;

  // A discovered model list is sufficient even before the user chooses a default model.
  return getAiConfigModelIds(config).some((model) => !!model.trim());
}
