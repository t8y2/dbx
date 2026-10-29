import { describe, expect, it } from "vitest";

import type { PluginMcpToolView, PluginMcpView } from "@/types/mcpCatalog";
import {
  pluginMcpAccessLevels,
  pluginMcpAuthorizedGrant,
  pluginMcpDefaultCeiling,
  pluginMcpEnabled,
  pluginMcpExposedCount,
  pluginMcpHighestLevel,
  pluginMcpLevelAtMost,
  pluginMcpNeedsAuthorization,
  pluginMcpPendingTools,
  pluginMcpSetCeiling,
  pluginMcpSetEnabled,
  pluginMcpSetToolEnabled,
  pluginMcpToolsByToolset,
  pluginMcpUndeclaredTools,
} from "@/lib/mcp/pluginMcpGrant";

function tool(name: string, access: PluginMcpToolView["access"], exposure: PluginMcpToolView["exposure"] = "exposed", toolset = "default"): PluginMcpToolView {
  return { name, description: "", toolset, access, exposure, parameters: [] };
}

function view(patch: Partial<PluginMcpView> = {}): PluginMcpView {
  return {
    pluginId: "io.dbx.ssh",
    pluginName: "Terminal",
    version: "1.4.0",
    authorAllowsExternal: true,
    hasSavedGrant: true,
    grant: { external: true, ceiling: "write", approvedTools: { list_dir: "read", upload: "write" }, disabledTools: [] },
    toolsets: [
      { id: "files", title: "Files", description: null },
      { id: "default", title: null, description: null },
    ],
    tools: [tool("list_dir", "read", "exposed", "files"), tool("upload", "write", "exposed", "files"), tool("exec", "full", "aboveCeiling")],
    discoveryError: null,
    ...patch,
  };
}

describe("plugin MCP grant helpers", () => {
  it("orders access levels and finds the highest", () => {
    expect(pluginMcpLevelAtMost("read", "write")).toBe(true);
    expect(pluginMcpLevelAtMost("full", "write")).toBe(false);
    expect(pluginMcpHighestLevel(view().tools)).toBe("full");
    expect(pluginMcpHighestLevel([])).toBe("read");
    expect(pluginMcpAccessLevels(view().tools)).toEqual(["read", "write", "full"]);
  });

  it("ignores undeclared tools for levels and the default ceiling", () => {
    const tools = [tool("list_dir", "read"), { ...tool("raw", "full", "undeclared"), access: null }];
    expect(pluginMcpHighestLevel(tools)).toBe("read");
    expect(pluginMcpAccessLevels(tools)).toEqual(["read"]);
    expect(pluginMcpUndeclaredTools(tools).map((entry) => entry.name)).toEqual(["raw"]);
  });

  it("caps the offered default ceiling at write", () => {
    expect(pluginMcpDefaultCeiling(view())).toBe("write");
    expect(pluginMcpDefaultCeiling(view({ tools: [tool("a", "read")] }))).toBe("read");
  });

  it("needs authorization for never-saved, switched-off, or pending plugins only", () => {
    expect(pluginMcpNeedsAuthorization(view())).toBe(false);
    expect(pluginMcpNeedsAuthorization(view({ hasSavedGrant: false }))).toBe(true);
    expect(pluginMcpNeedsAuthorization(view({ grant: { ...view().grant, external: false } }))).toBe(true);
    expect(pluginMcpNeedsAuthorization(view({ tools: [tool("new_tool", "write", "pendingApproval")] }))).toBe(true);
  });

  it("derives enabled state from the author opt-in and the grant", () => {
    expect(pluginMcpEnabled(view())).toBe(true);
    expect(pluginMcpEnabled(view({ authorAllowsExternal: false }))).toBe(false);
    expect(pluginMcpExposedCount(view())).toBe(2);
    expect(pluginMcpPendingTools(view({ tools: [tool("x", "write", "pendingApproval")] })).map((entry) => entry.name)).toEqual(["x"]);
  });

  it("builds the authorized grant, keeping per-tool opt-outs only for reviewed plugins", () => {
    const reviewed = view({ grant: { external: false, ceiling: "read", approvedTools: { list_dir: "read" }, disabledTools: ["upload"] } });
    expect(pluginMcpAuthorizedGrant(reviewed, "full")).toEqual({ external: true, ceiling: "full", approvedTools: { list_dir: "read" }, disabledTools: ["upload"] });
    expect(pluginMcpAuthorizedGrant(view({ hasSavedGrant: false, grant: { ...reviewed.grant } }), "write").disabledTools).toEqual([]);
  });

  it("edits switch, ceiling and per-tool opt-outs immutably", () => {
    const grant = view().grant;
    expect(pluginMcpSetEnabled(grant, false).external).toBe(false);
    expect(pluginMcpSetCeiling(grant, "full").ceiling).toBe("full");
    const off = pluginMcpSetToolEnabled(grant, "upload", false);
    expect(off.disabledTools).toEqual(["upload"]);
    expect(pluginMcpSetToolEnabled(off, "upload", true).disabledTools).toEqual([]);
    expect(grant.disabledTools).toEqual([]);
  });

  it("groups tools by toolset in declaration order and skips empty groups", () => {
    expect(pluginMcpToolsByToolset(view()).map((group) => [group.id, group.tools.map((entry) => entry.name)])).toEqual([
      ["files", ["list_dir", "upload"]],
      ["default", ["exec"]],
    ]);
    expect(pluginMcpToolsByToolset(view({ tools: [tool("a", "read")] })).map((group) => group.id)).toEqual(["default"]);
  });
});
