import { describe, expect, it } from "vitest";
import { buildMcpCodexConfig, buildMcpJsonConfig, buildMcpOpenCodeConfig, buildMcpVsCodeConfig, type McpEnvEntry } from "@/lib/mcpConfigTemplates";

describe("MCP config templates", () => {
  it("builds the standard mcpServers JSON used by Claude, Cursor, TRAE, and Windsurf", () => {
    const config = JSON.parse(buildMcpJsonConfig());

    expect(config).toEqual({
      mcpServers: {
        dbx: {
          command: "dbx-mcp-server",
        },
      },
    });
  });

  it("adds DBX MCP env entries to standard JSON configs", () => {
    const env: McpEnvEntry[] = [
      ["DBX_MCP_ALLOW_WRITES", "0"],
      ["DBX_MCP_ALLOW_DANGEROUS_SQL", "1"],
    ];
    const config = JSON.parse(buildMcpJsonConfig(env));

    expect(config.mcpServers.dbx.env).toEqual({
      DBX_MCP_ALLOW_WRITES: "0",
      DBX_MCP_ALLOW_DANGEROUS_SQL: "1",
    });
  });

  it("builds standard JSON configs with a direct node launch command", () => {
    const config = JSON.parse(buildMcpJsonConfig([], { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\zhiyo\\AppData\\Roaming\\npm\\node_modules\\@dbx-app\\mcp-server\\dist\\index.js"] }));

    expect(config).toEqual({
      mcpServers: {
        dbx: {
          command: "C:\\Program Files\\nodejs\\node.exe",
          args: ["C:\\Users\\zhiyo\\AppData\\Roaming\\npm\\node_modules\\@dbx-app\\mcp-server\\dist\\index.js"],
        },
      },
    });
  });

  it("builds VS Code MCP config with the servers root", () => {
    const config = JSON.parse(buildMcpVsCodeConfig([["DBX_MCP_ALLOW_WRITES", "0"]]));

    expect(config).toEqual({
      servers: {
        dbx: {
          type: "stdio",
          command: "dbx-mcp-server",
          env: {
            DBX_MCP_ALLOW_WRITES: "0",
          },
        },
      },
    });
  });

  it("builds VS Code config with a direct node launch command", () => {
    const config = JSON.parse(buildMcpVsCodeConfig([["DBX_MCP_ALLOW_WRITES", "0"]], { command: "node", args: ["C:\\dbx\\mcp\\dist\\index.js"] }));

    expect(config).toEqual({
      servers: {
        dbx: {
          type: "stdio",
          command: "node",
          args: ["C:\\dbx\\mcp\\dist\\index.js"],
          env: {
            DBX_MCP_ALLOW_WRITES: "0",
          },
        },
      },
    });
  });

  it("builds Codex TOML config with env entries", () => {
    expect(buildMcpCodexConfig([["DBX_MCP_ALLOW_WRITES", "0"]])).toBe(["[mcp_servers.dbx]", 'command = "dbx-mcp-server"', "", "[mcp_servers.dbx.env]", 'DBX_MCP_ALLOW_WRITES = "0"'].join("\n"));
  });

  it("builds Codex TOML config with a direct node launch command", () => {
    expect(buildMcpCodexConfig([["DBX_MCP_ALLOW_WRITES", "0"]], { command: "node", args: ["C:\\dbx\\mcp\\dist\\index.js"] })).toBe(["[mcp_servers.dbx]", 'command = "node"', 'args = ["C:\\\\dbx\\\\mcp\\\\dist\\\\index.js"]', "", "[mcp_servers.dbx.env]", 'DBX_MCP_ALLOW_WRITES = "0"'].join("\n"));
  });

  it("builds OpenCode config using environment entries", () => {
    const config = JSON.parse(buildMcpOpenCodeConfig([["DBX_MCP_ALLOW_DANGEROUS_SQL", "1"]]));

    expect(config).toEqual({
      mcp: {
        dbx: {
          type: "local",
          command: ["dbx-mcp-server"],
          environment: {
            DBX_MCP_ALLOW_DANGEROUS_SQL: "1",
          },
        },
      },
    });
  });

  it("builds OpenCode config with a direct node launch command", () => {
    const config = JSON.parse(buildMcpOpenCodeConfig([], { command: "node", args: ["C:\\dbx\\mcp\\dist\\index.js"] }));

    expect(config).toEqual({
      mcp: {
        dbx: {
          type: "local",
          command: ["node", "C:\\dbx\\mcp\\dist\\index.js"],
        },
      },
    });
  });
});
