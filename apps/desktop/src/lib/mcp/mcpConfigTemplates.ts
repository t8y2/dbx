export interface McpLaunchConfig {
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

const DEFAULT_MCP_LAUNCH_CONFIG: McpLaunchConfig = {
  command: "dbx-mcp-server",
};

function launchConfig(config?: McpLaunchConfig): McpLaunchConfig {
  return config ?? DEFAULT_MCP_LAUNCH_CONFIG;
}

function withLaunchConfig(dbx: Record<string, unknown>, config?: McpLaunchConfig): Record<string, unknown> {
  const launch = launchConfig(config);
  dbx.command = launch.command;
  if (launch.args && launch.args.length > 0) {
    dbx.args = [...launch.args];
  }
  if (launch.env && Object.keys(launch.env).length > 0) {
    dbx.env = { ...launch.env };
  }
  return dbx;
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

export function mcpWebBackendUrl(origin: string, apiPath: string): string {
  return new URL(apiPath, origin).toString().replace(/\/api\/?$/, "");
}

export function buildMcpJsonConfig(config?: McpLaunchConfig): string {
  const dbx: Record<string, unknown> = {
    ...withLaunchConfig({}, config),
  };

  return JSON.stringify({ mcpServers: { dbx } }, null, 2);
}

export function buildMcpVsCodeConfig(config?: McpLaunchConfig): string {
  const dbx: Record<string, unknown> = {
    type: "stdio",
    ...withLaunchConfig({}, config),
  };

  return JSON.stringify({ servers: { dbx } }, null, 2);
}

export function buildMcpCherryStudioConfig(config?: McpLaunchConfig): string {
  const launch = launchConfig(config);
  const dbx: Record<string, unknown> = {
    name: "dbx",
    description: "",
    baseUrl: "",
    command: launch.command,
    args: [...(launch.args ?? [])],
    env: { ...launch.env },
    isActive: true,
    type: "stdio",
  };

  return JSON.stringify({ mcpServers: { dbx } }, null, 2);
}

export function buildMcpCodexConfig(config?: McpLaunchConfig): string {
  const launch = launchConfig(config);
  const lines = ["[mcp_servers.dbx]", `command = ${JSON.stringify(launch.command)}`];

  if (launch.args && launch.args.length > 0) {
    lines.push(`args = ${tomlStringArray(launch.args)}`);
  }
  if (launch.env && Object.keys(launch.env).length > 0) {
    lines.push("", "[mcp_servers.dbx.env]");
    for (const [key, value] of Object.entries(launch.env)) {
      lines.push(`${key} = ${JSON.stringify(value)}`);
    }
  }

  return lines.join("\n");
}

export function buildMcpOpenCodeConfig(config?: McpLaunchConfig): string {
  const launch = launchConfig(config);
  const dbx: Record<string, unknown> = {
    type: "local",
    command: [launch.command, ...(launch.args ?? [])],
  };
  if (launch.env && Object.keys(launch.env).length > 0) {
    dbx.environment = { ...launch.env };
  }

  return JSON.stringify({ mcp: { dbx } }, null, 2);
}
