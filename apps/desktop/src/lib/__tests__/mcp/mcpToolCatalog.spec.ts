import { describe, expect, it } from "vitest";

import type { McpToolCatalog, McpToolCatalogToolset } from "@/types/mcpCatalog";
import { MCP_PLUGIN_TOOLS_WILDCARD } from "@/lib/mcp/mcpPolicySelection";
import {
  groupMcpDatabaseTypesByCategory,
  mcpCoverageByCategory,
  mcpCoverageCategory,
  mcpToolLabelKey,
  mcpToolsetScopeKinds,
  mcpToolsetAccessLevels,
  mcpToolsetMessageKey,
  mcpToolsetState,
  mcpToolsetsForDatabaseType,
  mcpUncoveredConnections,
  setMcpToolsetEnabled,
  summarizeMcpToolsetCoverage,
  MCP_CAPABILITY_CATEGORIES,
  mcpCapabilityCategories,
  mcpCapabilityCategoryId,
  setMcpCategoryEnabled,
  setMcpToolsEnabled,
  mergeMcpToolsetSelection,
} from "@/lib/mcp/mcpToolCatalog";

const schema: McpToolCatalogToolset = {
  id: "sql.schema",
  provider: "builtin:sql",
  resourceKinds: ["database"],
  scopeKind: "database",
  scopeKinds: ["database"],
  tools: [
    { name: "dbx_list_tables", access: "read", accessMode: "static", coverageKind: "capability", databaseTypes: ["mysql", "postgres", "sqlite"], description: "", parameters: [] },
    { name: "dbx_get_routine_source", access: "read", accessMode: "static", coverageKind: "capability", databaseTypes: ["mysql", "postgres"], description: "", parameters: [] },
  ],
};

const query: McpToolCatalogToolset = {
  id: "sql.query",
  provider: "builtin:sql",
  resourceKinds: ["database"],
  scopeKind: "database",
  scopeKinds: ["database"],
  tools: [{ name: "dbx_execute_query", access: "full", accessMode: "classified", coverageKind: "capability", databaseTypes: ["mysql", "postgres", "sqlite", "redis"], description: "", parameters: [] }],
};

const admin: McpToolCatalogToolset = {
  id: "admin.connections",
  provider: "builtin:admin",
  resourceKinds: [],
  scopeKinds: [],
  tools: [
    { name: "dbx_add_connection", access: "write", accessMode: "static", coverageKind: "none", databaseTypes: [], description: "", parameters: [] },
    { name: "dbx_remove_connection", access: "full", accessMode: "static", coverageKind: "none", databaseTypes: [], description: "", parameters: [] },
  ],
};

const catalog: McpToolCatalog = { toolsets: [query, schema, admin] };

const connections = [
  { id: "c1", name: "local-mysql", dbType: "mysql" as const },
  { id: "c2", name: "notes", dbType: "sqlite" as const },
  { id: "c3", name: "dev-nacos", dbType: "nacos" as const },
];

describe("MCP toolset switches", () => {
  it("keeps allow-all unrestricted when the selected toolset has no effective change", () => {
    expect(mergeMcpToolsetSelection(null, ["dbx_list_tables", "dbx_get_routine_source"], schema, catalog)).toBeNull();
  });

  it("exposes provider resource scope metadata", () => {
    expect(mcpToolsetScopeKinds(schema)).toEqual(["database"]);
    expect(schema.scopeKind).toBe("database");
    expect(mcpToolsetScopeKinds(admin)).toEqual([]);
    expect(admin.scopeKind).toBeUndefined();
  });
  it("derives on/off/partial from the flat allowlist", () => {
    expect(mcpToolsetState(null, schema)).toBe("on");
    expect(mcpToolsetState(["dbx_list_tables"], schema)).toBe("partial");
    expect(mcpToolsetState([], schema)).toBe("off");
  });

  it("materializes allow-all with the plugin wildcard before switching a toolset off", () => {
    const next = setMcpToolsetEnabled(null, schema, false, catalog);
    expect(next).toContain(MCP_PLUGIN_TOOLS_WILDCARD);
    expect(next).toContain("dbx_execute_query");
    expect(next).not.toContain("dbx_list_tables");
    expect(next).not.toContain("dbx_get_routine_source");
    expect(next).toHaveLength(catalog.toolsets.flatMap((toolset) => toolset.tools).length - schema.tools.length + 1);
  });

  it("switches every tool of a toolset on without touching custom entries", () => {
    expect(setMcpToolsetEnabled(["dbx_ssh__*"], schema, true, catalog)).toEqual(["dbx_ssh__*", "dbx_list_tables", "dbx_get_routine_source"]);
  });

  it("badges classified tools as reaching write and high-risk levels", () => {
    expect(mcpToolsetAccessLevels(query)).toEqual(["read", "write", "full"]);
    expect(mcpToolsetAccessLevels(schema)).toEqual(["read"]);
    expect(mcpToolsetAccessLevels(admin)).toEqual(["read", "write", "full"]);
  });

  it("maps toolset ids to camelCase message keys and tools to existing labels", () => {
    expect(mcpToolsetMessageKey("admin.connections", "title")).toBe("settings.mcpToolset.adminConnections.title");
    expect(mcpToolsetMessageKey("redis", "description")).toBe("settings.mcpToolset.redis.description");
    expect(mcpToolLabelKey("dbx_list_tables")).toBe("settings.mcpToolListTables");
    expect(mcpToolLabelKey("dbx_unknown")).toBeUndefined();
  });
});

describe("MCP capability categories", () => {
  function toolset(id: string, names: string[]): McpToolCatalogToolset {
    return { ...schema, id, tools: names.map((name) => ({ ...schema.tools[0], name })) };
  }
  const complete: McpToolCatalog = {
    toolsets: [query, schema, toolset("nacos.config", ["nacos_read", "nacos_write"]), toolset("consul.service", ["consul_services"]), toolset("core.discovery", ["dbx_list_connections"]), toolset("plugin.router", ["plugin_discover"]), toolset("future.toolset", ["new_runtime_tool"])],
  };

  it("assigns every known group once and keeps unknown groups accessible", () => {
    const configuredIds = MCP_CAPABILITY_CATEGORIES.flatMap((category) => [...category.toolsetIds]);
    expect(new Set(configuredIds).size).toBe(configuredIds.length);
    const groups = mcpCapabilityCategories(complete);
    expect(groups.map((group) => group.id)).toEqual(["database", "nacos", "consul", "mq", "salesforce", "dbx", "other"]);
    expect(
      groups
        .flatMap((group) => group.toolsets)
        .map((group) => group.id)
        .sort(),
    ).toEqual(complete.toolsets.map((group) => group.id).sort());
    expect(groups.at(-1)?.toolsets[0].id).toBe("future.toolset");
    expect(mcpCapabilityCategoryId("redis")).toBe("database");
    expect(mcpCapabilityCategoryId("core.discovery")).toBe("dbx");
    expect(mcpCapabilityCategories(catalog).map((group) => group.id)).not.toContain("other");
  });

  it("disables database tools without removing other products, shared discovery, future tools or plugins", () => {
    const next = setMcpCategoryEnabled(null, complete, "database", false);
    expect(next).toEqual(["nacos_read", "nacos_write", "consul_services", "dbx_list_connections", "plugin_discover", "new_runtime_tool", MCP_PLUGIN_TOOLS_WILDCARD]);
    expect(complete.toolsets[0].tools[0].name).toBe("dbx_execute_query");
  });

  it("uses the complete category even when only some tools are enabled or visible", () => {
    const current = ["nacos_read", "dbx_ssh__*", "dbx_custom__tool", "custom_name"];
    const all = setMcpCategoryEnabled(current, complete, "nacos", true);
    expect(all).toEqual([...current, "nacos_write"]);
    expect(setMcpCategoryEnabled(all, complete, "nacos", false)).toEqual(current.slice(1));
    expect(current).toEqual(["nacos_read", "dbx_ssh__*", "dbx_custom__tool", "custom_name"]);
  });

  it("materializes a single tool and toolset from the same full runtime catalog", () => {
    const single = setMcpToolsEnabled(null, complete, ["dbx_list_tables"], false);
    const group = setMcpToolsetEnabled(null, schema, false, complete);
    for (const names of [single, group]) {
      expect(names).toContain("new_runtime_tool");
      expect(names).toContain(MCP_PLUGIN_TOOLS_WILDCARD);
      expect(names).not.toContain("dbx_list_tables");
    }
    expect(single).toContain("dbx_get_routine_source");
    expect(group).not.toContain("dbx_get_routine_source");
  });
});

describe("MCP coverage summaries", () => {
  it("counts usable connections and flags connections only some tools support", () => {
    const summary = summarizeMcpToolsetCoverage(schema, connections);
    expect(summary.typeCount).toBe(3);
    expect(summary.usableConnections.map((connection) => connection.id)).toEqual(["c1", "c2"]);
    expect(summary.partialConnections).toEqual([{ connection: connections[1], unsupportedTools: [schema.tools[1]] }]);
    expect(summary.distinctToolCounts.map(({ tools, typeCount }) => [tools.map((tool) => tool.name), typeCount])).toEqual([
      [["dbx_list_tables"], 3],
      [["dbx_get_routine_source"], 2],
    ]);
  });

  it("collapses identical tool coverage into one summary and skips connection-less tools", () => {
    expect(summarizeMcpToolsetCoverage(query, connections).distinctToolCounts).toEqual([]);
    expect(summarizeMcpToolsetCoverage(admin, connections)).toMatchObject({ typeCount: 0, usableConnections: [], partialConnections: [] });
  });

  it("lists connections no built-in toolset reaches", () => {
    expect(mcpUncoveredConnections(catalog, connections).map((connection) => connection.name)).toEqual(["dev-nacos"]);
  });

  it("groups coverage by connection picker categories and marks per-tool support", () => {
    expect(mcpCoverageCategory("mysql")).toBe("sql");
    expect(mcpCoverageCategory("sqlite")).toBe("lightweight");
    // Only types some tool in the set supports appear — no unsupported entries.
    const rows = mcpCoverageByCategory(schema);
    expect(rows.map((row) => row.category)).toEqual(["sql", "lightweight"]);
    const lightweight = rows.find((row) => row.category === "lightweight")!;
    expect(lightweight.types).toEqual(["sqlite"]);
    expect(lightweight.tools.map((entry) => [entry.tool.name, [...entry.supported]])).toEqual([
      ["dbx_list_tables", ["sqlite"]],
      ["dbx_get_routine_source", []],
    ]);
  });

  it("groups a single tool's supported types by category without unsupported entries", () => {
    expect(groupMcpDatabaseTypesByCategory(["sqlite", "postgres", "mysql", "sqlite"])).toEqual([
      { category: "sql", titleKey: "connection.databaseCategorySql", types: ["mysql", "postgres"] },
      { category: "lightweight", titleKey: "connection.databaseCategoryLightweight", types: ["sqlite"] },
    ]);
    expect(groupMcpDatabaseTypesByCategory([])).toEqual([]);
  });

  it("finds the toolsets a connection type can use", () => {
    expect(mcpToolsetsForDatabaseType(catalog, "sqlite").map((toolset) => toolset.id)).toEqual(["sql.query", "sql.schema"]);
    expect(mcpToolsetsForDatabaseType(catalog, "nacos")).toEqual([]);
  });
});
