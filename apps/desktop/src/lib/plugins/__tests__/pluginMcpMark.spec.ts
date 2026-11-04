import { describe, expect, it } from "vitest";

import type { InstalledPlugin } from "@/types/database";
import { installedPluginOffersExternalMcp, installedPluginProvidesMcpTools, marketplacePluginProvidesMcpTools } from "@/lib/plugins/pluginMcpMark";

function plugin(manifest: Partial<InstalledPlugin["manifest"]>): Pick<InstalledPlugin, "manifest"> {
  return { manifest: { id: "io.dbx.x", name: "X", version: "1.0.0", ...manifest } as InstalledPlugin["manifest"] };
}

const backend = { backend: { executable: "bin/x" } };

describe("plugin MCP mark", () => {
  it("is carried by plugins with a backend and an mcp contribution", () => {
    expect(installedPluginProvidesMcpTools(plugin({ entrypoints: backend, contributions: [{ type: "mcp", id: "x.mcp" }] }))).toBe(true);
    expect(installedPluginProvidesMcpTools(plugin({ entrypoints: backend, contributions: [] }))).toBe(false);
    expect(installedPluginProvidesMcpTools(plugin({ contributions: [{ type: "mcp", id: "x.mcp" }] }))).toBe(false);
    expect(installedPluginProvidesMcpTools(plugin({}))).toBe(false);
  });

  it("separates the mark from the author's external opt-in", () => {
    const marked = plugin({ entrypoints: backend, contributions: [{ type: "mcp", id: "x.mcp" }] });
    expect(installedPluginOffersExternalMcp(marked)).toBe(false);
    expect(installedPluginOffersExternalMcp(plugin({ entrypoints: backend, contributions: [{ type: "mcp", id: "x.mcp", external_tools: true }] }))).toBe(true);
  });

  it("reads the store listing flag", () => {
    expect(marketplacePluginProvidesMcpTools({ mcpTools: true })).toBe(true);
    expect(marketplacePluginProvidesMcpTools({})).toBe(false);
  });
});
