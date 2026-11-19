import type { DatabaseType } from "@/types/database";
import type { McpAccessLevel, McpToolCatalog, McpToolCatalogTool, McpToolCatalogToolset } from "@/types/mcpCatalog";
import { CONNECTION_PICKER_OPTIONS } from "@/types/generated/connectionProfiles";
import { AGENT_DRIVER_CATEGORY_MAP, DRIVER_CATEGORIES, type DriverCategoryKey } from "@/lib/connection/driver-category-definitions";
import { databaseManifestEntry } from "@/lib/database/databaseDriverManifest";
import { MCP_PLUGIN_TOOLS_WILDCARD, MCP_TOOL_OPTIONS } from "@/lib/mcp/mcpPolicySelection";

/**
 * View-model helpers for the MCP capability tab. The catalog itself comes from
 * the backend (`dbx_core::mcp_catalog`); everything here is pure so the tab
 * stays a thin renderer. Tool permissions are still the flat
 * `allowedToolNames` allowlist — a toolset switch only edits that list.
 */

export const MCP_ACCESS_LEVELS: readonly McpAccessLevel[] = ["read", "write", "full"];

/** Product navigation is presentation metadata, independent of policy scopes. */
export const MCP_CAPABILITY_CATEGORIES = [
  { id: "database", toolsetIds: ["sql.query", "sql.session", "sql.schema", "redis"] },
  { id: "nacos", toolsetIds: ["nacos.config", "nacos.service"] },
  { id: "consul", toolsetIds: ["consul.kv", "consul.service"] },
  { id: "mq", toolsetIds: ["mq"] },
  { id: "salesforce", toolsetIds: ["salesforce"] },
  { id: "dbx", toolsetIds: ["core.discovery", "workbench", "admin.connections", "plugin.router"] },
] as const;

export type McpCapabilityCategoryId = (typeof MCP_CAPABILITY_CATEGORIES)[number]["id"] | "other";

export function mcpCapabilityCategoryId(toolsetId: string): McpCapabilityCategoryId {
  return MCP_CAPABILITY_CATEGORIES.find((category) => (category.toolsetIds as readonly string[]).includes(toolsetId))?.id ?? "other";
}

export function mcpCapabilityCategories(catalog: McpToolCatalog | null): Array<{ id: McpCapabilityCategoryId; toolsets: McpToolCatalogToolset[] }> {
  const toolsets = catalog?.toolsets ?? [];
  const categories = MCP_CAPABILITY_CATEGORIES.map((category) => ({
    id: category.id as McpCapabilityCategoryId,
    toolsets: category.toolsetIds.flatMap((id) => toolsets.filter((toolset) => toolset.id === id)),
  }));
  const other = toolsets.filter((toolset) => mcpCapabilityCategoryId(toolset.id) === "other");
  if (other.length) categories.push({ id: "other", toolsets: other });
  return categories;
}

/** i18n keys for toolset titles and descriptions, keyed by catalog toolset id. */
export function mcpToolsetMessageKey(toolsetId: string, part: "title" | "description"): string {
  const key = toolsetId.replace(/\.(\w)/g, (_, letter: string) => letter.toUpperCase());
  return `settings.mcpToolset.${key}.${part}`;
}

/** Label key for one tool, reusing the per-tool labels of the static option list. */
export function mcpToolLabelKey(toolName: string): string | undefined {
  return MCP_TOOL_OPTIONS.find((tool) => tool.name === toolName)?.labelKey;
}

export function mcpToolAllowed(allowedToolNames: readonly string[] | null, toolName: string): boolean {
  return allowedToolNames === null || allowedToolNames.includes(toolName);
}

export type McpToolsetState = "on" | "off" | "partial";

export function mcpToolsetState(allowedToolNames: readonly string[] | null, toolset: McpToolCatalogToolset): McpToolsetState {
  const enabled = toolset.tools.filter((tool) => mcpToolAllowed(allowedToolNames, tool.name)).length;
  if (enabled === 0) return "off";
  return enabled === toolset.tools.length ? "on" : "partial";
}

/**
 * Turns every tool of a toolset on or off. Materializing the null ("all")
 * allowlist seeds the plugin wildcard, exactly like the single-tool toggle, so
 * switching a built-in toolset never silently strips discovered plugin tools.
 */
export function setMcpToolsEnabled(allowedToolNames: readonly string[] | null, catalog: McpToolCatalog, toolNames: readonly string[], enabled: boolean): string[] {
  // Use the complete runtime catalog: a newer server can advertise tools that
  // this frontend's static label list does not know yet.
  const selected = new Set<string>(allowedToolNames === null ? [...catalog.toolsets.flatMap((toolset) => toolset.tools.map((tool) => tool.name)), MCP_PLUGIN_TOOLS_WILDCARD] : allowedToolNames);
  for (const name of toolNames) {
    if (enabled) selected.add(name);
    else selected.delete(name);
  }
  return [...selected];
}

export function setMcpToolsetEnabled(allowedToolNames: readonly string[] | null, toolset: McpToolCatalogToolset, enabled: boolean, catalog: McpToolCatalog): string[] {
  return setMcpToolsEnabled(
    allowedToolNames,
    catalog,
    toolset.tools.map((tool) => tool.name),
    enabled,
  );
}

/** Copy only this toolset's switches into a saved allowlist, preserving all other entries. */
export function mergeMcpToolsetSelection(saved: readonly string[] | null, draft: readonly string[] | null, toolset: McpToolCatalogToolset, catalog: McpToolCatalog): string[] | null {
  let merged = saved === null ? null : [...saved];
  for (const tool of toolset.tools) {
    const enabled = mcpToolAllowed(draft, tool.name);
    if (mcpToolAllowed(merged, tool.name) !== enabled) merged = setMcpToolsEnabled(merged, catalog, [tool.name], enabled);
  }
  return merged;
}

export function setMcpCategoryEnabled(allowedToolNames: readonly string[] | null, catalog: McpToolCatalog, categoryId: McpCapabilityCategoryId, enabled: boolean): string[] {
  const names = catalog.toolsets.filter((toolset) => mcpCapabilityCategoryId(toolset.id) === categoryId).flatMap((toolset) => toolset.tools.map((tool) => tool.name));
  return setMcpToolsEnabled(allowedToolNames, catalog, names, enabled);
}

/** Access levels present in a toolset, in Read → Full order (badge row). */
export function mcpToolsetAccessLevels(toolset: McpToolCatalogToolset): McpAccessLevel[] {
  const levels = new Set<McpAccessLevel>();
  for (const tool of toolset.tools) {
    levels.add("read");
    if (tool.accessMode === "classified" || tool.access !== "read") levels.add("write");
    if (tool.access === "full") levels.add("full");
  }
  return MCP_ACCESS_LEVELS.filter((level) => levels.has(level));
}

/** Whether the toolset is bound to connections at all (connection-less toolsets have no coverage). */
export function mcpToolsetHasCoverage(toolset: McpToolCatalogToolset): boolean {
  return toolset.tools.some((tool) => tool.coverageKind !== "none");
}

/** Stable resource scope ids supplied by the backend descriptor. */
export function mcpToolsetScopeKinds(toolset: McpToolCatalogToolset): string[] {
  return toolset.resourceKinds;
}

/** Union of connection types the toolset reaches. */
export function mcpToolsetDatabaseTypes(toolset: McpToolCatalogToolset): Set<DatabaseType> {
  return new Set(toolset.tools.flatMap((tool) => tool.databaseTypes));
}

export interface McpCoverageConnection {
  id: string;
  name: string;
  dbType: DatabaseType;
}

export interface McpToolsetCoverageSummary {
  /** Distinct connection types any tool in the set reaches. */
  typeCount: number;
  /** Per distinct coverage, the number of types (only when tools differ). */
  distinctToolCounts: Array<{ tools: McpToolCatalogTool[]; typeCount: number }>;
  /** User connections at least one tool in the set reaches. */
  usableConnections: McpCoverageConnection[];
  /** User connections the set reaches only partially: some tools skip their type. */
  partialConnections: Array<{ connection: McpCoverageConnection; unsupportedTools: McpToolCatalogTool[] }>;
}

function coverageKey(tool: McpToolCatalogTool): string {
  return tool.databaseTypes.join(",");
}

export function summarizeMcpToolsetCoverage(toolset: McpToolCatalogToolset, connections: readonly McpCoverageConnection[]): McpToolsetCoverageSummary {
  const bound = toolset.tools.filter((tool) => tool.coverageKind !== "none");
  const types = new Set(bound.flatMap((tool) => tool.databaseTypes));
  const groups = new Map<string, McpToolCatalogTool[]>();
  for (const tool of bound) groups.set(coverageKey(tool), [...(groups.get(coverageKey(tool)) ?? []), tool]);
  const distinctToolCounts = groups.size > 1 ? [...groups.values()].map((tools) => ({ tools, typeCount: tools[0].databaseTypes.length })).sort((left, right) => right.typeCount - left.typeCount) : [];
  const usableConnections = connections.filter((connection) => types.has(connection.dbType));
  const partialConnections = usableConnections.map((connection) => ({ connection, unsupportedTools: bound.filter((tool) => !tool.databaseTypes.includes(connection.dbType)) })).filter((entry) => entry.unsupportedTools.length > 0);
  return { typeCount: types.size, distinctToolCounts, usableConnections, partialConnections };
}

/** Connections no built-in toolset reaches (types MCP does not support yet). */
export function mcpUncoveredConnections(catalog: McpToolCatalog, connections: readonly McpCoverageConnection[]): McpCoverageConnection[] {
  const covered = new Set(catalog.toolsets.flatMap((toolset) => toolset.tools.flatMap((tool) => tool.databaseTypes)));
  return connections.filter((connection) => !covered.has(connection.dbType));
}

export type McpCoverageCategory = DriverCategoryKey | "other";

const PICKER_CATEGORY_BY_TYPE = new Map<string, DriverCategoryKey>();
for (const option of CONNECTION_PICKER_OPTIONS) {
  const type = option.value;
  if (!PICKER_CATEGORY_BY_TYPE.has(type)) PICKER_CATEGORY_BY_TYPE.set(type, option.category as DriverCategoryKey);
}

export function mcpCoverageCategory(dbType: DatabaseType): McpCoverageCategory {
  return PICKER_CATEGORY_BY_TYPE.get(dbType) ?? AGENT_DRIVER_CATEGORY_MAP[dbType] ?? "other";
}

export function mcpDatabaseTypeLabel(dbType: DatabaseType): string {
  return databaseManifestEntry(dbType)?.label ?? dbType;
}

export interface McpCoverageCategoryRow {
  category: McpCoverageCategory;
  titleKey: string;
  /** Supported types of this category, sorted by label. */
  types: DatabaseType[];
  /** Per tool: which of `types` it supports. */
  tools: Array<{ tool: McpToolCatalogTool; supported: Set<DatabaseType> }>;
}

const COVERAGE_CATEGORIES: Array<{ key: McpCoverageCategory; titleKey: string }> = [...DRIVER_CATEGORIES.map(({ key, titleKey }) => ({ key, titleKey })), { key: "other", titleKey: "settings.mcpCoverageCategoryOther" }];

/** Groups connection types by the connection-picker categories users already know. */
export function groupMcpDatabaseTypesByCategory(types: Iterable<DatabaseType>): Array<{ category: McpCoverageCategory; titleKey: string; types: DatabaseType[] }> {
  const rows = new Map<McpCoverageCategory, DatabaseType[]>();
  for (const type of new Set(types)) {
    const category = mcpCoverageCategory(type);
    rows.set(category, [...(rows.get(category) ?? []), type]);
  }
  return COVERAGE_CATEGORIES.filter(({ key }) => rows.has(key)).map(({ key, titleKey }) => ({
    category: key,
    titleKey,
    types: (rows.get(key) ?? []).sort((left, right) => mcpDatabaseTypeLabel(left).localeCompare(mcpDatabaseTypeLabel(right))),
  }));
}

/**
 * Toolset coverage detail: only the types at least one tool in the set
 * supports, grouped by category, with per-tool support so a type that only
 * some tools reach can be marked.
 */
export function mcpCoverageByCategory(toolset: McpToolCatalogToolset): McpCoverageCategoryRow[] {
  const bound = toolset.tools.filter((tool) => tool.coverageKind !== "none");
  return groupMcpDatabaseTypesByCategory(mcpToolsetDatabaseTypes(toolset)).map((row) => ({
    ...row,
    tools: bound.map((tool) => ({ tool, supported: new Set(tool.databaseTypes.filter((type) => row.types.includes(type))) })),
  }));
}

/** Every type any catalog tool reaches. */
export function mcpReachableDatabaseTypes(catalog: McpToolCatalog): Set<DatabaseType> {
  return new Set(catalog.toolsets.flatMap((toolset) => toolset.tools.flatMap((tool) => tool.databaseTypes)));
}

/** Toolsets whose tools reach this connection type (connection row hint). */
export function mcpToolsetsForDatabaseType(catalog: McpToolCatalog, dbType: DatabaseType): McpToolCatalogToolset[] {
  return catalog.toolsets.filter((toolset) => toolset.tools.some((tool) => tool.databaseTypes.includes(dbType)));
}
