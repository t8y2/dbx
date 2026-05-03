#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConnections, findConnection } from "./connections.js";
import { listTables, describeTable, executeQuery } from "./database.js";

const server = new McpServer({
  name: "dbx",
  version: "0.1.0",
});

server.tool(
  "dbx_list_connections",
  "List all database connections configured in DBX",
  {},
  async () => {
    const connections = await loadConnections();
    const list = connections.map((c) => ({
      name: c.name,
      type: c.db_type,
      host: c.host,
      port: c.port,
      database: c.database || "",
    }));
    return { content: [{ type: "text" as const, text: JSON.stringify(list, null, 2) }] };
  },
);

server.tool(
  "dbx_list_tables",
  "List tables and views for a database connection",
  {
    connection_name: z.string().describe("Name of the DBX connection"),
    schema: z.string().optional().describe("Schema name (default: public for PostgreSQL)"),
  },
  async ({ connection_name, schema }) => {
    const config = await findConnection(connection_name);
    if (!config) return { content: [{ type: "text" as const, text: `Connection "${connection_name}" not found` }] };
    const tables = await listTables(config, schema);
    return { content: [{ type: "text" as const, text: JSON.stringify(tables, null, 2) }] };
  },
);

server.tool(
  "dbx_describe_table",
  "Get column definitions for a table",
  {
    connection_name: z.string().describe("Name of the DBX connection"),
    table: z.string().describe("Table name"),
    schema: z.string().optional().describe("Schema name (default: public for PostgreSQL)"),
  },
  async ({ connection_name, table, schema }) => {
    const config = await findConnection(connection_name);
    if (!config) return { content: [{ type: "text" as const, text: `Connection "${connection_name}" not found` }] };
    const columns = await describeTable(config, table, schema);
    return { content: [{ type: "text" as const, text: JSON.stringify(columns, null, 2) }] };
  },
);

server.tool(
  "dbx_execute_query",
  "Execute a SQL query on a database connection (max 100 rows returned)",
  {
    connection_name: z.string().describe("Name of the DBX connection"),
    sql: z.string().describe("SQL query to execute"),
  },
  async ({ connection_name, sql }) => {
    const config = await findConnection(connection_name);
    if (!config) return { content: [{ type: "text" as const, text: `Connection "${connection_name}" not found` }] };
    try {
      const result = await executeQuery(config, sql);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: `Query error: ${msg}` }] };
    }
  },
);

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";

function appDataDir(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "com.dbx.app");
    case "win32":
      return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "com.dbx.app");
    default:
      return join(home, ".config", "com.dbx.app");
  }
}

async function getBridgeUrl(): Promise<string> {
  const portFile = join(appDataDir(), "mcp-bridge-port");
  const port = (await readFile(portFile, "utf-8")).trim();
  return `http://127.0.0.1:${port}`;
}

server.tool(
  "dbx_open_table",
  "Open a table in DBX desktop app UI. Requires DBX to be running.",
  {
    connection_name: z.string().describe("Name of the DBX connection"),
    table: z.string().describe("Table name to open"),
    database: z.string().optional().describe("Database name"),
    schema: z.string().optional().describe("Schema name"),
  },
  async ({ connection_name, table, database, schema }) => {
    try {
      const bridgeUrl = await getBridgeUrl();
      const res = await fetch(`${bridgeUrl}/open-table`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_name, table, database, schema }),
      });
      if (res.ok) {
        return { content: [{ type: "text" as const, text: `Opened ${table} in DBX` }] };
      }
      const text = await res.text();
      return { content: [{ type: "text" as const, text: `Failed: ${text}` }] };
    } catch {
      return { content: [{ type: "text" as const, text: "DBX is not running. Please start DBX first." }] };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error("MCP Server failed to start:", e);
  process.exit(1);
});
