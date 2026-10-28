import type { DatabaseType } from "@/types/database";

/** Mirrors `dbx_core::mcp_catalog` — the built-in MCP tool descriptor catalog. */
export type McpAccessLevel = "read" | "write" | "full";
export type McpAccessMode = "static" | "classified";
export type McpCoverageKind = "none" | "allConnections" | "capability" | "types";

export interface McpToolParameter {
  name: string;
  /** Display type such as `string`, `integer`, `string[]` or `latest | earliest | offset`. */
  valueType: string;
  required: boolean;
  default?: unknown;
  description: string;
}

export interface McpToolCatalogTool {
  name: string;
  access: McpAccessLevel;
  accessMode: McpAccessMode;
  coverageKind: McpCoverageKind;
  /** Applicable connection types; empty when `coverageKind` is `none`. */
  databaseTypes: DatabaseType[];
  /** Description the MCP server advertises to clients (English, for the model). */
  description: string;
  parameters: McpToolParameter[];
}

export interface McpToolCatalogToolset {
  id: string;
  provider: string;
  resourceKinds: string[];
  scopeKind?: string;
  /** Resource scope ids declared by the provider (database, namespace, ...). */
  scopeKinds: string[];
  tools: McpToolCatalogTool[];
}

export interface McpToolCatalog {
  toolsets: McpToolCatalogToolset[];
}

/** Mirrors `dbx_core::storage::PluginMcpAccessLevel`. */
export type PluginMcpAccessLevel = "read" | "write" | "full";

/** Mirrors `dbx_core::storage::PluginMcpGrant` — the user's external MCP decision for one plugin. */
export interface PluginMcpGrant {
  external: boolean;
  ceiling: PluginMcpAccessLevel;
  /** Accepted tools with the access level each had when accepted. */
  approvedTools: Record<string, PluginMcpAccessLevel>;
  disabledTools: string[];
}

export type PluginToolExposure = "exposed" | "undeclared" | "pluginDisabled" | "toolDisabled" | "aboveCeiling" | "pendingApproval";

export interface PluginMcpToolView {
  name: string;
  description: string;
  toolset: string;
  /** Declared access level; `null` when the manifest does not declare the tool (never exposed). */
  access: PluginMcpAccessLevel | null;
  exposure: PluginToolExposure;
  parameters: McpToolParameter[];
}

export interface PluginMcpToolsetView {
  id: string;
  /** Declared title; `null` for the default group. */
  title: string | null;
  description: string | null;
}

/** Mirrors `dbx_core::plugin_mcp::PluginMcpView` — one plugin card. */
export interface PluginMcpView {
  pluginId: string;
  pluginName: string;
  version: string;
  authorAllowsExternal: boolean;
  hasSavedGrant: boolean;
  grant: PluginMcpGrant;
  toolsets: PluginMcpToolsetView[];
  tools: PluginMcpToolView[];
  discoveryError: string | null;
}

/** Mirrors `dbx_core::mcp_access` — the v2 access policy (plugin sub-scope rules live only here). */
export type McpAccessLevelV2 = "none" | "read" | "write" | "full";
export type McpSubScopeMode = "all" | "selected" | "none";
export type McpRuleTarget = { kind: "group"; id: string } | { kind: "connection"; id: string } | { kind: "scope"; connectionId: string; scope: string; value: string };

export interface McpAccessRule {
  access?: McpAccessLevelV2;
  ceiling?: McpAccessLevelV2;
  visible?: boolean;
  subScope?: McpSubScopeMode;
  subScopeKind?: string;
  toolsetCeilings?: Record<string, McpAccessLevelV2>;
}

export interface McpAccessPolicy {
  version: number;
  defaultAccess: McpAccessLevelV2;
  rules: Array<{ target: McpRuleTarget } & McpAccessRule>;
}
