#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  buildSchemaContext,
  createBackend,
  evaluateSqlSafety,
  formatSchemaContext,
  notifyReload,
  postBridge,
  sqlSafetyFromEnv,
  type Backend,
  type ConnectionConfig,
} from "@dbx-app/node-core";

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

function withDatabase(config: ConnectionConfig, database?: string): ConnectionConfig {
  return database === undefined ? config : { ...config, database };
}

export const DBX_CONNECTION_TYPE_DESCRIPTION =
  "Database type: postgres, mysql, sqlite, redis, duckdb, clickhouse, sqlserver, mongodb, oracle, elasticsearch, doris, starrocks, redshift, dameng, kingbase, highgo, vastbase, goldendb, gaussdb, yashandb, databricks, saphana, teradata, vertica, firebird, exasol, opengauss, oceanbase-oracle, gbase, h2, snowflake, trino, hive, db2, informix, neo4j, cassandra, bigquery, kylin, sundb, tdengine, jdbc, access";

export function createDbxMcpServer(backend: Backend, options: { isWebMode?: boolean } = {}): McpServer {
  const isWebMode = options.isWebMode ?? !!process.env.DBX_WEB_URL;
  const server = new McpServer({
    name: "dbx",
    version: "0.4.2",
  });

  server.tool("dbx_list_connections", "List all database connections configured in DBX", {}, async () => {
  const connections = await backend.loadConnections();
  if (connections.length === 0) return text("No connections configured in DBX.");
  const rows = connections.map((c) => [c.name, c.db_type, c.host, String(c.port), c.database || ""]);
  return text(mdTable(["Name", "Type", "Host", "Port", "Database"], rows));
  });

  server.tool(
  "dbx_list_tables",
  "List tables and views for a database connection",
  {
    connection_name: z.string().describe("Name of the DBX connection"),
    database: z.string().optional().describe("Database name"),
    schema: z.string().optional().describe("Schema name (default: public for PostgreSQL)"),
  },
  async ({ connection_name, database, schema }) => {
    const config = await backend.findConnection(connection_name);
    if (!config) return text(`Connection "${connection_name}" not found`);
    const tables = await backend.listTables(withDatabase(config, database), schema);
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
    database: z.string().optional().describe("Database name"),
    schema: z.string().optional().describe("Schema name (default: public for PostgreSQL)"),
  },
  async ({ connection_name, table, database, schema }) => {
    const config = await backend.findConnection(connection_name);
    if (!config) return text(`Connection "${connection_name}" not found`);
    const columns = await backend.describeTable(withDatabase(config, database), table, schema);
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
    database: z.string().optional().describe("Database name"),
    sql: z.string().describe("SQL query to execute"),
  },
  async ({ connection_name, database, sql }) => {
    const config = await backend.findConnection(connection_name);
    if (!config) return text(`Connection "${connection_name}" not found`);
    const safety = evaluateSqlSafety(sql, sqlSafetyFromEnv());
    if (!safety.allowed) return text(`Query blocked: ${safety.reason}`);
    try {
      const result = await backend.executeQuery(withDatabase(config, database), sql);
      if (result.columns.length === 0) return text(`Query executed. ${result.row_count} row(s) affected.`);
      const rows = result.rows.map((r) => result.columns.map((c) => formatCell(r[c])));
      return text(`${mdTable(result.columns, rows)}\n\n${result.row_count} row(s)`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return text(`Query error: ${msg}`);
    }
  },
  );

  server.tool(
  "dbx_get_schema_context",
  "Get compact table and column context for writing SQL",
  {
    connection_name: z.string().describe("Name of the DBX connection"),
    database: z.string().optional().describe("Database name"),
    schema: z.string().optional().describe("Schema name (default: public for PostgreSQL)"),
    tables: z.array(z.string()).optional().describe("Specific table names to include"),
    max_tables: z.number().int().min(1).max(20).default(8).describe("Maximum number of tables to include"),
  },
  async ({ connection_name, database, schema, tables, max_tables }) => {
    const config = await backend.findConnection(connection_name);
    if (!config) return text(`Connection "${connection_name}" not found`);
    const context = await buildSchemaContext(backend, withDatabase(config, database), { schema, tables, maxTables: max_tables });
    if (context.tables.length === 0) return text("No matching tables found.");
    return text(formatSchemaContext(context));
  },
  );

  server.tool(
  "dbx_add_connection",
  "Add a new database connection to DBX",
  {
    name: z.string().describe("Connection name"),
    db_type: z
      .string()
      .describe(DBX_CONNECTION_TYPE_DESCRIPTION),
    host: z.string().describe("Database host"),
    port: z.number().optional().describe("Database port (TDengine defaults to 6041)"),
    username: z.string().default("").describe("Username"),
    password: z.string().default("").describe("Password"),
    database: z.string().optional().describe("Default database name"),
    ssl: z.boolean().default(false).describe("Enable SSL"),
  },
  async ({ name, db_type, host, port, username, password, database, ssl }) => {
    const existing = await backend.findConnection(name);
    if (existing) return text(`Connection "${name}" already exists.`);
    const FILE_BASED_TYPES = new Set(["sqlite", "duckdb", "access"]);
    const resolvedPort = port ?? (db_type === "tdengine" ? 6041 : FILE_BASED_TYPES.has(db_type) ? 0 : undefined);
    if (resolvedPort === undefined) return text("Port is required for this database type.");
    const config = await backend.addConnection({
      name,
      db_type,
      host,
      port: resolvedPort,
      username,
      password,
      database,
      ssl,
      ssh_enabled: false,
    } as Omit<ConnectionConfig, "id">);
    await notifyReload();
    return text(`Connection "${config.name}" added (id: ${config.id}).`);
  },
  );

  server.tool(
  "dbx_remove_connection",
  "Remove a database connection from DBX",
  {
    connection_name: z.string().describe("Name of the connection to remove"),
  },
  async ({ connection_name }) => {
    const removed = await backend.removeConnection(connection_name);
    if (!removed) return text(`Connection "${connection_name}" not found.`);
    await notifyReload();
    return text(`Connection "${connection_name}" removed.`);
  },
  );

// Desktop-only tools: open table and execute-and-show require the Tauri bridge
  if (!isWebMode) {
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
      return bridgeRequest("/open-table", { connection_name, table, database, schema }, `Opened ${table} in DBX`);
    },
    );

    server.tool(
    "dbx_execute_and_show",
    "Execute a SQL query in DBX desktop app UI and show results there. Requires DBX to be running.",
    {
      connection_name: z.string().describe("Name of the DBX connection"),
      sql: z.string().describe("SQL query to execute"),
      database: z.string().optional().describe("Database name"),
    },
    async ({ connection_name, sql, database }) => {
      const safety = evaluateSqlSafety(sql, sqlSafetyFromEnv());
      if (!safety.allowed) return text(`Query blocked: ${safety.reason}`);
      return bridgeRequest("/execute-query", { connection_name, sql, database }, "Query sent to DBX");
    },
    );
  }

  return server;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

async function bridgeRequest(path: string, body: Record<string, unknown>, successMsg: string) {
  const res = await postBridge(path, body);
  if (res.ok) return text(successMsg);
  return text(res.text.startsWith("DBX is not running") ? res.text : `Failed: ${res.text}`);
}

async function main() {
  const backend = await createBackend();
  const server = createDbxMcpServer(backend);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("MCP Server failed to start:", e);
    process.exit(1);
  });
}
