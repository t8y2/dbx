import { describe, expect, it } from "vitest";
import { buildMcpCherryStudioConfig, buildMcpCodexConfig, buildMcpJsonConfig, buildMcpOpenCodeConfig, buildMcpVsCodeConfig, mcpWebBackendUrl } from "@/lib/mcp/mcpConfigTemplates";

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

  it("builds standard JSON configs with a direct node launch command", () => {
    const config = JSON.parse(buildMcpJsonConfig({ command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\Users\\zhiyo\\AppData\\Roaming\\npm\\node_modules\\@dbx-app\\mcp-server\\dist\\index.js"] }));

    expect(config).toEqual({
      mcpServers: {
        dbx: {
          command: "C:\\Program Files\\nodejs\\node.exe",
          args: ["C:\\Users\\zhiyo\\AppData\\Roaming\\npm\\node_modules\\@dbx-app\\mcp-server\\dist\\index.js"],
        },
      },
    });
  });

  it("includes Web runtime settings without restoring permission environment variables", () => {
    const launch = {
      command: "dbx-mcp-server",
      env: {
        DBX_WEB_URL: "https://dbx.example.com/tools/dbx",
        DBX_WEB_PASSWORD: "your-web-login-password",
      },
    };

    expect(JSON.parse(buildMcpJsonConfig(launch))).toEqual({
      mcpServers: { dbx: { command: "dbx-mcp-server", env: launch.env } },
    });
    expect(buildMcpCodexConfig(launch)).toContain('[mcp_servers.dbx.env]\nDBX_WEB_URL = "https://dbx.example.com/tools/dbx"');
    expect(JSON.parse(buildMcpOpenCodeConfig(launch)).mcp.dbx.environment).toEqual(launch.env);
    expect(buildMcpJsonConfig(launch)).not.toContain("DBX_MCP_ALLOW_WRITES");
  });

  it("keeps a deployed Web base path in DBX_WEB_URL", () => {
    expect(mcpWebBackendUrl("https://dbx.example.com", "/tools/dbx/api")).toBe("https://dbx.example.com/tools/dbx");
  });

  it("builds VS Code MCP config with the servers root and no policy environment", () => {
    const config = JSON.parse(buildMcpVsCodeConfig());

    expect(config).toEqual({
      servers: {
        dbx: {
          type: "stdio",
          command: "dbx-mcp-server",
        },
      },
    });
  });

  it("builds VS Code config with a direct node launch command", () => {
    const config = JSON.parse(buildMcpVsCodeConfig({ command: "node", args: ["C:\\dbx\\mcp\\dist\\index.js"] }));

    expect(config).toEqual({
      servers: {
        dbx: {
          type: "stdio",
          command: "node",
          args: ["C:\\dbx\\mcp\\dist\\index.js"],
        },
      },
    });
  });

  it("builds the Cherry Studio stdio configuration", () => {
    const config = JSON.parse(
      buildMcpCherryStudioConfig({
        command: "/opt/homebrew/bin/node",
        args: ["/opt/dbx/mcp-server/dist/index.js"],
        env: { DBX_WEB_URL: "https://dbx.example.com" },
      }),
    );

    expect(config).toEqual({
      mcpServers: {
        dbx: {
          name: "dbx",
          description: "",
          baseUrl: "",
          command: "/opt/homebrew/bin/node",
          args: ["/opt/dbx/mcp-server/dist/index.js"],
          env: { DBX_WEB_URL: "https://dbx.example.com" },
          isActive: true,
          type: "stdio",
        },
      },
    });
  });

  it("builds Codex TOML config without policy environment", () => {
    expect(buildMcpCodexConfig()).toBe(["[mcp_servers.dbx]", 'command = "dbx-mcp-server"'].join("\n"));
  });

  it("builds Codex TOML config with a direct node launch command", () => {
    expect(buildMcpCodexConfig({ command: "node", args: ["C:\\dbx\\mcp\\dist\\index.js"] })).toBe(["[mcp_servers.dbx]", 'command = "node"', 'args = ["C:\\\\dbx\\\\mcp\\\\dist\\\\index.js"]'].join("\n"));
  });

  it("builds OpenCode config without policy environment", () => {
    const config = JSON.parse(buildMcpOpenCodeConfig());

    expect(config).toEqual({
      mcp: {
        dbx: {
          type: "local",
          command: ["dbx-mcp-server"],
        },
      },
    });
  });

  it("builds OpenCode config with a direct node launch command", () => {
    const config = JSON.parse(buildMcpOpenCodeConfig({ command: "node", args: ["C:\\dbx\\mcp\\dist\\index.js"] }));

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
