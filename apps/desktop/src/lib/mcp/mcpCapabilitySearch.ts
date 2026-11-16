import type { McpToolCatalog, PluginMcpView } from "@/types/mcpCatalog";
import { mcpCapabilityCategories, mcpToolAllowed, mcpToolLabelKey, mcpToolsetMessageKey, type McpCapabilityCategoryId } from "./mcpToolCatalog";
import { pluginMcpEnabled } from "./pluginMcpGrant";

export interface McpCapabilitySearchItem {
  key: string;
  title: string;
  path: string;
  toolsetId?: string;
  toolName?: string;
  pluginId?: string;
}

export interface McpCapabilitySearchGroup {
  id: string;
  title: string;
  source: "builtin" | "plugin";
  items: McpCapabilitySearchItem[];
}

type Translate = (key: string) => string;

export interface McpCapabilityBrowserState {
  selected: McpCapabilityCategoryId | `plugin:${string}` | "advanced";
  search: string;
  onlyEnabled: boolean;
  viewMode: McpCapabilityViewMode;
}

export type McpCapabilityViewMode = "manage" | "overview";

export type McpCapabilityNavigationTarget = { kind: "tool"; toolName: string } | { kind: "advanced" };

export interface McpCapabilityNavigator {
  revealSearchTarget(target?: McpCapabilityNavigationTarget): void;
}

export function initialMcpCapabilityBrowserState(): McpCapabilityBrowserState {
  return { selected: "database", search: "", onlyEnabled: false, viewMode: "manage" };
}

export function mcpCategoryTitle(id: McpCapabilityCategoryId, t: Translate): string {
  return t(`settings.mcpBrowser.category.${id}.title`);
}

export function mcpToolsetTitle(id: string, t: Translate): string {
  const key = mcpToolsetMessageKey(id, "title");
  const title = t(key);
  return title === key ? id : title;
}

/** Search the full catalogs, keeping navigation and saved authorization independent. */
export function searchMcpCapabilities(options: { query: string; catalog: McpToolCatalog | null; plugins: readonly PluginMcpView[] | null; allowedToolNames: readonly string[] | null; onlyEnabled: boolean; t: Translate }): McpCapabilitySearchGroup[] {
  const { query, catalog, plugins, allowedToolNames, onlyEnabled, t } = options;
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches = (...values: Array<string | null | undefined>) => values.some((value) => value?.toLocaleLowerCase().includes(needle));
  const results: McpCapabilitySearchGroup[] = [];
  for (const category of mcpCapabilityCategories(catalog)) {
    const title = mcpCategoryTitle(category.id, t);
    const categoryMatch = matches(title, category.id);
    const items: McpCapabilitySearchItem[] = [];
    for (const toolset of category.toolsets) {
      const tools = toolset.tools.filter((tool) => !onlyEnabled || mcpToolAllowed(allowedToolNames, tool.name));
      if (onlyEnabled && !tools.length) continue;
      const toolsetTitle = mcpToolsetTitle(toolset.id, t);
      const path = `${title} / ${toolsetTitle}`;
      if (categoryMatch || matches(toolset.id, toolsetTitle, t(mcpToolsetMessageKey(toolset.id, "description")))) {
        items.push({ key: toolset.id, title: toolsetTitle, path, toolsetId: toolset.id });
      }
      for (const tool of tools) {
        const labelKey = mcpToolLabelKey(tool.name);
        const label = labelKey ? t(labelKey) : tool.name;
        if (matches(tool.name, label, tool.description)) items.push({ key: `${toolset.id}/${tool.name}`, title: label, path, toolsetId: toolset.id, toolName: tool.name });
      }
    }
    if (items.length) results.push({ id: category.id, title, source: "builtin", items });
  }
  for (const plugin of plugins ?? []) {
    if (onlyEnabled && !pluginMcpEnabled(plugin)) continue;
    const items: McpCapabilitySearchItem[] = [];
    if (matches(plugin.pluginName, plugin.pluginId)) items.push({ key: plugin.pluginId, title: plugin.pluginName, path: plugin.pluginId, pluginId: plugin.pluginId });
    for (const tool of plugin.tools) {
      if (onlyEnabled && (tool.access === null || plugin.grant.disabledTools.includes(tool.name))) continue;
      const group = plugin.toolsets.find((toolset) => toolset.id === tool.toolset);
      if (!matches(tool.name, tool.description, group?.title, group?.id, group?.description)) continue;
      items.push({ key: `${plugin.pluginId}/${tool.name}`, title: tool.name, path: `${plugin.pluginName} / ${group?.title ?? t("settings.mcpPluginDefaultToolset")}`, pluginId: plugin.pluginId, toolName: tool.name });
    }
    if (items.length) results.push({ id: `plugin:${plugin.pluginId}`, title: plugin.pluginName, source: "plugin", items });
  }
  return results;
}
