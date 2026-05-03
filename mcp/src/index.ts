#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { loadConnections, findConnection } from "./connections.js";
import { listTables, describeTable, executeQuery } from "./database.js";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function mdTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] || "").length), 3));
  const header = `| ${headers.map((h, i) => h.padEnd(widths[i])).join(" | ")} |`;
  const sep = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map((c, i) => (c || "").padEnd(widths[i])).join(" | ")} |`).join("\n");
  return `${header}\n${sep}\n${body}`;
}

const server = new McpServer({
  name: "dbx",
  version: "0.1.1",
});

server.tool(
  "dbx_list_connections",
  "List all database connections configured in DBX",
  {},
  async () => {
    const connections = await loadConnections();
    if (connections.length === 0) return text("No connections configured in DBX.");
    const rows = connections.map((c) => [c.name, c.db_type, c.host, String(c.port), c.database || ""]);
    return text(mdTable(["Name", "Type", "Host", "Port", "Database"], rows));
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
    if (!config) return text(`Connection "${connection_name}" not found`);
    const tables = await listTables(config, schema);
    if (tables.length === 0) return text("No tables found.");
    const rows = tables.map((t) => [t.name, t.type]);
    return text(mdTable(["Table", "Type"], rows));
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
    if (!config) return text(`Connection "${connection_name}" not found`);
    const columns = await describeTable(config, table, schema);
    if (columns.length === 0) return text("No columns found.");
    const rows = columns.map((c) => [
      c.is_primary_key ? `${c.name} (PK)` : c.name,
      c.data_type,
      c.is_nullable ? "YES" : "NO",
      c.column_default ?? "",
      c.comment ?? "",
    ]);
    return text(mdTable(["Column", "Type", "Nullable", "Default", "Comment"], rows));
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
    if (!config) return text(`Connection "${connection_name}" not found`);
    try {
      const result = await executeQuery(config, sql);
      if (result.columns.length === 0) return text(`Query executed. ${result.row_count} row(s) affected.`);
      const rows = result.rows.map((r) => result.columns.map((c) => formatCell(r[c])));
      return text(`${mdTable(result.columns, rows)}\n\n${result.row_count} row(s)`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return text(`Query error: ${msg}`);
    }
  },
);

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

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
      if (res.ok) return text(`Opened ${table} in DBX`);
      return text(`Failed: ${await res.text()}`);
    } catch {
      return text("DBX is not running. Please start DBX first.");
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
