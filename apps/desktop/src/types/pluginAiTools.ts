/**
 * Plugin MCP tools in the built-in AI agent.
 *
 * Mirrors `crates/dbx-core/src/ai/plugin_tools.rs` (preview types) and the
 * approval events of `crates/dbx-ai-provider/src/agent_events.rs`.
 */

export interface PluginToolSummary {
  name: string;
  description: string;
  /** Declared read-only via MCP `annotations.readOnlyHint`; other tools need an approval per call. */
  readOnly: boolean;
}

export interface PluginToolConnectionSummary {
  id: string;
  name: string;
}

export interface PluginToolPreview {
  tools: PluginToolSummary[];
  /** Open connections of the plugin the agent would bind tool calls to. */
  openConnections: PluginToolConnectionSummary[];
}

export type AiToolApprovalOutcome = "approved" | "denied" | "timed_out" | "cancelled";

/** Separator between the plugin prefix and the plugin's own tool name (`ssh__ssh_exec`). */
export const PLUGIN_TOOL_NAME_SEPARATOR = "__";
