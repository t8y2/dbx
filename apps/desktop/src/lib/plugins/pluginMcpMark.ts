import type { InstalledPlugin, PluginMarketplacePlugin, PluginMcpContribution } from "@/types/database";

/**
 * The "provides MCP tools" mark. A plugin carries it when its manifest has a
 * backend plus an `mcp` contribution (mirrors
 * `PluginManifest::provides_mcp_tools` in the plugin runtime). Only marked
 * plugins appear in Settings → MCP → Capabilities; unmarked plugins have no MCP
 * surface. Store listings carry the same mark as `mcpTools` so it shows
 * before install.
 */
export function pluginMcpContribution(plugin: Pick<InstalledPlugin, "manifest">): PluginMcpContribution | undefined {
  return (plugin.manifest.contributions || []).find((contribution): contribution is PluginMcpContribution => contribution.type === "mcp");
}

export function installedPluginProvidesMcpTools(plugin: Pick<InstalledPlugin, "manifest">): boolean {
  return Boolean(plugin.manifest.entrypoints?.backend) && pluginMcpContribution(plugin) !== undefined;
}

/** The author lets the tools reach external MCP clients (the MCP card's switch can be turned on). */
export function installedPluginOffersExternalMcp(plugin: Pick<InstalledPlugin, "manifest">): boolean {
  return installedPluginProvidesMcpTools(plugin) && pluginMcpContribution(plugin)?.external_tools === true;
}

export function marketplacePluginProvidesMcpTools(plugin: Pick<PluginMarketplacePlugin, "mcpTools">): boolean {
  return plugin.mcpTools === true;
}
