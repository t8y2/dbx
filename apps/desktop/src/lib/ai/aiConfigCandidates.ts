import type { AiConfig } from "@/types/ai";

const CLI_PROVIDERS = new Set<AiConfig["provider"]>(["codex-cli", "claude-code-cli", "opencode-cli", "pi-agent-cli", "cursor-cli", "grok-cli", "codebuddy-cli", "qoder-cli"]);

/**
 * Mirrors `is_cli_provider` in `crates/dbx-ai-provider/src/ai.rs`.
 *
 * CLI providers run an external agent and DBX hands it its own MCP server, so
 * their tool surface is the MCP registry (`dbx_*` names). Native providers use
 * the in-process registry in `crates/dbx-core/src/ai/agent_tools.rs`, whose
 * tool names have no prefix. The same prompt is built for both lanes, so
 * anything that names a tool has to know which lane it is talking to.
 */
export function isCliProvider(provider: AiConfig["provider"] | undefined): boolean {
  return !!provider && CLI_PROVIDERS.has(provider);
}

export function isAiConfigModelCandidate(config: AiConfig, requiresApiKey: boolean, supportsCliProviders = true): boolean {
  // CLI providers resolve their model and credentials externally, so keep the existing eligibility bypass.
  if (CLI_PROVIDERS.has(config.provider)) return supportsCliProviders;
  return !!config.endpoint?.trim() && (!requiresApiKey || !!config.apiKey?.trim());
}
