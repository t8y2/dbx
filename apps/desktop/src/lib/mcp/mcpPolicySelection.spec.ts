import { describe, expect, it } from "vitest";
import { MCP_PLUGIN_TOOLS_WILDCARD, MCP_TOOL_OPTIONS, addMcpAllowedToolName, customMcpAllowedToolNames, toggleMcpAllowedToolName } from "./mcpPolicySelection";

describe("mcpPolicySelection tool allowlist", () => {
  it("seeds the plugin wildcard when the null allowlist becomes explicit", () => {
    // A null allowlist lets every discovered plugin tool through. The first
    // checkbox toggle materializes the list, and without the wildcard seed it
    // would silently revoke all of them.
    const names = toggleMcpAllowedToolName(null, "dbx_list_tables", false);
    expect(names).toContain(MCP_PLUGIN_TOOLS_WILDCARD);
    expect(names).not.toContain("dbx_list_tables");
    expect(names).toEqual(expect.arrayContaining(MCP_TOOL_OPTIONS.map((tool) => tool.name).filter((name) => name !== "dbx_list_tables")));
  });

  it("keeps the explicit list exact once materialized", () => {
    const seeded = toggleMcpAllowedToolName(null, "dbx_list_tables", true);
    const withoutWildcard = toggleMcpAllowedToolName(seeded, MCP_PLUGIN_TOOLS_WILDCARD, false);
    expect(withoutWildcard).not.toContain(MCP_PLUGIN_TOOLS_WILDCARD);
    expect(withoutWildcard).not.toContain("dbx_kafka__kafka_topics_delete");
    expect(withoutWildcard).toContain("dbx_list_tables");
  });

  it("adds trimmed custom entries without duplicates", () => {
    const seeded = toggleMcpAllowedToolName(null, "dbx_list_tables", true);
    const first = addMcpAllowedToolName(seeded, " dbx_ssh__* ");
    expect(first.added).toBe(true);
    expect(first.names).toContain("dbx_ssh__*");
    const second = addMcpAllowedToolName(first.names, "dbx_ssh__*");
    expect(second.added).toBe(false);
    expect(second.names).toEqual(first.names);
  });

  it("ignores empty custom entries", () => {
    const result = addMcpAllowedToolName(["dbx_ssh__*"], "   ");
    expect(result.added).toBe(false);
    expect(result.names).toEqual(["dbx_ssh__*"]);
  });

  it("reports custom entries beyond the static options", () => {
    const names = toggleMcpAllowedToolName(null, "dbx_list_tables", true);
    expect(customMcpAllowedToolNames(names)).toEqual([MCP_PLUGIN_TOOLS_WILDCARD]);
    expect(customMcpAllowedToolNames(null)).toEqual([]);
  });
});
