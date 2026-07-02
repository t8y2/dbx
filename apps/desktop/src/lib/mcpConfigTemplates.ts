export type McpEnvEntry = readonly [key: string, value: string];

export interface McpLaunchConfig {
  command: string;
  args?: readonly string[];
}

const DEFAULT_MCP_LAUNCH_CONFIG: McpLaunchConfig = {
  command: "dbx-mcp-server",
};

function envObject(envEntries: readonly McpEnvEntry[]): Record<string, string> {
  return Object.fromEntries(envEntries);
}

function launchConfig(config?: McpLaunchConfig): McpLaunchConfig {
  return config ?? DEFAULT_MCP_LAUNCH_CONFIG;
}

function withLaunchConfig(dbx: Record<string, unknown>, config?: McpLaunchConfig): Record<string, unknown> {
  const launch = launchConfig(config);
  dbx.command = launch.command;
  if (launch.args && launch.args.length > 0) {
    dbx.args = [...launch.args];
  }
  return dbx;
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

export function buildMcpJsonConfig(envEntries: readonly McpEnvEntry[] = [], config?: McpLaunchConfig): string {
  const dbx: Record<string, unknown> = {
    ...withLaunchConfig({}, config),
  };

  if (envEntries.length > 0) {
    dbx.env = envObject(envEntries);
  }

  return JSON.stringify({ mcpServers: { dbx } }, null, 2);
}

export function buildMcpVsCodeConfig(envEntries: readonly McpEnvEntry[] = [], config?: McpLaunchConfig): string {
  const dbx: Record<string, unknown> = {
    type: "stdio",
    ...withLaunchConfig({}, config),
  };

  if (envEntries.length > 0) {
    dbx.env = envObject(envEntries);
  }

  return JSON.stringify({ servers: { dbx } }, null, 2);
}

export function buildMcpCodexConfig(envEntries: readonly McpEnvEntry[] = [], config?: McpLaunchConfig): string {
  const launch = launchConfig(config);
  const lines = ["[mcp_servers.dbx]", `command = ${JSON.stringify(launch.command)}`];

  if (launch.args && launch.args.length > 0) {
    lines.push(`args = ${tomlStringArray(launch.args)}`);
  }

  if (envEntries.length > 0) {
    lines.push("");
    lines.push("[mcp_servers.dbx.env]");
    for (const [key, value] of envEntries) {
      lines.push(`${key} = ${JSON.stringify(value)}`);
    }
  }

  return lines.join("\n");
}

export function buildMcpOpenCodeConfig(envEntries: readonly McpEnvEntry[] = [], config?: McpLaunchConfig): string {
  const launch = launchConfig(config);
  const dbx: Record<string, unknown> = {
    type: "local",
    command: [launch.command, ...(launch.args ?? [])],
  };

  if (envEntries.length > 0) {
    dbx.environment = envObject(envEntries);
  }

  return JSON.stringify({ mcp: { dbx } }, null, 2);
}
