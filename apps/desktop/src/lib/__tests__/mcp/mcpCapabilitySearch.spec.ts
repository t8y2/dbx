import { describe, expect, it } from "vitest";
import { searchMcpCapabilities } from "@/lib/mcp/mcpCapabilitySearch";
import type { McpToolCatalog, PluginMcpView } from "@/types/mcpCatalog";

const messages: Record<string, string> = {
  "settings.mcpBrowser.category.nacos.title": "Nacos",
  "settings.mcpToolset.nacosConfig.title": "配置管理",
  "settings.mcpToolset.nacosConfig.description": "发布与查询配置",
  "settings.mcpToolNacosListConfigs": "列出配置",
};
const t = (key: string) => messages[key] ?? key;
const catalog: McpToolCatalog = {
  toolsets: [
    {
      id: "nacos.config",
      provider: "builtin:nacos",
      resourceKinds: ["namespace"],
      scopeKinds: ["namespace"],
      tools: [
        { name: "dbx_nacos_list_configs", description: "List configurations", access: "read", accessMode: "static", coverageKind: "types", databaseTypes: ["nacos"], parameters: [] },
        { name: "dbx_nacos_publish_config", description: "Publish configuration", access: "write", accessMode: "static", coverageKind: "types", databaseTypes: ["nacos"], parameters: [] },
      ],
    },
  ],
};
const plugin: PluginMcpView = {
  pluginId: "nacos-extension",
  pluginName: "Nacos",
  version: "1",
  authorAllowsExternal: true,
  hasSavedGrant: true,
  grant: { external: true, ceiling: "read", approvedTools: {}, disabledTools: ["dbx_ext__disabled"] },
  toolsets: [{ id: "admin", title: "扩展管理", description: "Operations" }],
  tools: [
    { name: "dbx_ext__pending", access: "write", exposure: "pendingApproval", toolset: "admin", description: "Pending write", parameters: [] },
    { name: "dbx_ext__ceiling", access: "full", exposure: "aboveCeiling", toolset: "admin", description: "Above ceiling", parameters: [] },
    { name: "dbx_ext__disabled", access: "read", exposure: "toolDisabled", toolset: "admin", description: "Disabled", parameters: [] },
  ],
  discoveryError: null,
};
const search = (query: string, overrides: Partial<Parameters<typeof searchMcpCapabilities>[0]> = {}) => searchMcpCapabilities({ query, catalog, plugins: [plugin], allowedToolNames: null, onlyEnabled: false, t, ...overrides });

describe("capability search", () => {
  it("keeps a same-named builtin category and plugin separate, with source and paths", () => {
    const groups = search("NaCoS");
    expect(groups.map((group) => [group.id, group.source])).toEqual([
      ["nacos", "builtin"],
      ["plugin:nacos-extension", "plugin"],
    ]);
    expect(groups[0].items[0]).toMatchObject({ path: "Nacos / 配置管理", toolsetId: "nacos.config" });
    expect(groups[1].items[0]).toMatchObject({ pluginId: "nacos-extension" });
  });

  it("finds localized toolset titles, tool IDs, plugin IDs and plugin toolsets", () => {
    expect(search("配置管理")[0].items[0].toolsetId).toBe("nacos.config");
    expect(search("dbx_nacos_publish_config")[0].items[0]).toMatchObject({ toolsetId: "nacos.config", toolName: "dbx_nacos_publish_config" });
    expect(search("nacos-extension")[0].items[0].pluginId).toBe("nacos-extension");
    expect(search("扩展管理")[0].items).toHaveLength(3);
    expect(search("dbx_ext__pending")[0].items[0]).toMatchObject({ pluginId: "nacos-extension", toolName: "dbx_ext__pending" });
  });

  it("filters by configuration rather than runtime exposure and retains enabled plugins with errors", () => {
    expect(search("dbx_ext__", { onlyEnabled: true })[0].items.map((item) => item.toolName)).toEqual(["dbx_ext__pending", "dbx_ext__ceiling"]);
    expect(search("Nacos", { onlyEnabled: true, allowedToolNames: [] }).map((group) => group.source)).toEqual(["plugin"]);
    const errorPlugin = { ...plugin, tools: [], discoveryError: "Unavailable" };
    expect(search("Nacos", { catalog: null, plugins: [errorPlugin], onlyEnabled: true })[0].items).toHaveLength(1);
    expect(search("Nacos", { catalog: null, plugins: [{ ...plugin, grant: { ...plugin.grant, external: false } }], onlyEnabled: true })).toEqual([]);
  });

  it("only returns enabled matching builtin tools and safely handles partial catalog availability", () => {
    expect(search("dbx_nacos_publish_config", { onlyEnabled: true, allowedToolNames: ["dbx_nacos_list_configs"] })).toEqual([]);
    expect(search("nacos", { plugins: null }).every((group) => group.source === "builtin")).toBe(true);
    expect(search("dbx_ext__pending", { catalog: null })[0].source).toBe("plugin");
    expect(search("   ")).toEqual([]);
    expect(search("no-such-tool")).toEqual([]);
  });
});
