import type { PluginMcpAccessLevel, PluginMcpGrant, PluginMcpToolView, PluginMcpView } from "@/types/mcpCatalog";

/**
 * Pure helpers for the plugin cards of the MCP capability tab. The backend
 * (`dbx_core::plugin_mcp`) decides exposure; these only derive display state
 * and build the next grant to save.
 */

export const PLUGIN_MCP_ACCESS_LEVELS: readonly PluginMcpAccessLevel[] = ["read", "write", "full"];

const LEVEL_RANK: Record<PluginMcpAccessLevel, number> = { read: 0, write: 1, full: 2 };

export function pluginMcpLevelAtMost(level: PluginMcpAccessLevel, ceiling: PluginMcpAccessLevel): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[ceiling];
}

/** Tools the author declared an access level for; only these can ever be exposed. */
export function pluginMcpDeclaredTools(tools: readonly PluginMcpToolView[]): Array<PluginMcpToolView & { access: PluginMcpAccessLevel }> {
  return tools.filter((tool): tool is PluginMcpToolView & { access: PluginMcpAccessLevel } => tool.access !== null);
}

/** Highest declared access level among the plugin's tools (read when none). */
export function pluginMcpHighestLevel(tools: readonly PluginMcpToolView[]): PluginMcpAccessLevel {
  return pluginMcpDeclaredTools(tools).reduce<PluginMcpAccessLevel>((highest, tool) => (LEVEL_RANK[tool.access] > LEVEL_RANK[highest] ? tool.access : highest), "read");
}

/** Declared access levels present among the plugin's tools, in Read → Full order. */
export function pluginMcpAccessLevels(tools: readonly PluginMcpToolView[]): PluginMcpAccessLevel[] {
  const present = new Set(pluginMcpDeclaredTools(tools).map((tool) => tool.access));
  return PLUGIN_MCP_ACCESS_LEVELS.filter((level) => present.has(level));
}

export function pluginMcpUndeclaredTools(tools: readonly PluginMcpToolView[]): PluginMcpToolView[] {
  return tools.filter((tool) => tool.access === null);
}

export function pluginMcpPendingTools(view: PluginMcpView): PluginMcpToolView[] {
  return view.tools.filter((tool) => tool.exposure === "pendingApproval");
}

export function pluginMcpExposedCount(view: PluginMcpView): number {
  return view.tools.filter((tool) => tool.exposure === "exposed").length;
}

/** Whether the plugin card switch shows on: the user's grant, gated by the author opt-in. */
export function pluginMcpEnabled(view: PluginMcpView): boolean {
  return view.authorAllowsExternal && view.grant.external;
}

/**
 * Whether turning a plugin on must go through the authorization dialog: the
 * user never saved a grant, the saved grant is off, or tools wait for
 * confirmation. Re-enabling an already reviewed plugin with nothing pending
 * is a plain switch.
 */
export function pluginMcpNeedsAuthorization(view: PluginMcpView): boolean {
  return !view.hasSavedGrant || !view.grant.external || pluginMcpPendingTools(view).length > 0;
}

/** Default ceiling offered in the authorization dialog: the plugin's highest level, capped at write. */
export function pluginMcpDefaultCeiling(view: PluginMcpView): PluginMcpAccessLevel {
  const highest = pluginMcpHighestLevel(view.tools);
  return LEVEL_RANK[highest] > LEVEL_RANK.write ? "write" : highest;
}

/** The grant saved by the authorization dialog (paired with `approveCurrent: true`). */
export function pluginMcpAuthorizedGrant(view: PluginMcpView, ceiling: PluginMcpAccessLevel): PluginMcpGrant {
  return { ...view.grant, external: true, ceiling, disabledTools: view.hasSavedGrant ? [...view.grant.disabledTools] : [] };
}

export function pluginMcpSetEnabled(grant: PluginMcpGrant, enabled: boolean): PluginMcpGrant {
  return { ...grant, external: enabled };
}

export function pluginMcpSetCeiling(grant: PluginMcpGrant, ceiling: PluginMcpAccessLevel): PluginMcpGrant {
  return { ...grant, ceiling };
}

export function pluginMcpSetToolEnabled(grant: PluginMcpGrant, toolName: string, enabled: boolean): PluginMcpGrant {
  const disabled = new Set(grant.disabledTools);
  if (enabled) disabled.delete(toolName);
  else disabled.add(toolName);
  return { ...grant, disabledTools: [...disabled].sort() };
}

/** A mutable copy of the grant behind a card (an unauthorized plugin carries the backend's "off" grant). */
export function pluginMcpBaseGrant(view: PluginMcpView): PluginMcpGrant {
  return { ...view.grant, approvedTools: { ...view.grant.approvedTools }, disabledTools: [...view.grant.disabledTools] };
}

/** Tools grouped by toolset in declaration order (the default group last). */
export function pluginMcpToolsByToolset(view: PluginMcpView): Array<{ id: string; title: string | null; description: string | null; tools: PluginMcpToolView[] }> {
  return view.toolsets.map((toolset) => ({ ...toolset, tools: view.tools.filter((tool) => tool.toolset === toolset.id) })).filter((group) => group.tools.length > 0);
}
