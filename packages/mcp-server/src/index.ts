#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { z } from "zod";
import {
  buildSchemaContext,
  createBackend,
  evaluateRedisCommandSafety,
  evaluateMongoAggregateSafety,
  evaluateSqlSafety,
  formatCell,
  formatSchemaContext,
  isMainModule,
  mdTable,
  notifyReload,
  parseMongoAggregateCommand,
  assessProductionSql,
  isLikelyMongoMutation,
  isProductionDatabase,
  postBridge,
  sqlSafetyFromEnv,
  splitSqlStatements,
  type Backend,
  type ConnectionConfig,
  type QueryResult,
  type RedisCommandResult,
} from "@dbx-app/node-core";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
export const DBX_MCP_PACKAGE_VERSION = packageJson.version ?? "0.0.0";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function toolError(code: string, message: string) {
  return { ...text(`${code}: ${message}`), isError: true };
}

function withDatabase(config: ConnectionConfig, database?: string): ConnectionConfig {
  return database === undefined ? config : { ...config, database };
}

function metadataScope(config: ConnectionConfig, database?: string, schema?: string): { config: ConnectionConfig; schema?: string } {
  if (config.db_type !== "dameng") {
    return { config: withDatabase(config, database), schema };
  }

  // Dameng exposes tables under user-owned schemas rather than separate
  // databases. Accept the legacy database argument as a schema, and default to
  // the login user when neither argument is provided.
  const resolvedSchema = schema?.trim() || database?.trim() || config.username?.trim() || undefined;
  return { config, schema: resolvedSchema };
}

function connectionIdentity(config: ConnectionConfig): string {
  return `${config.name} (${config.id}) [${config.db_type} @ ${config.host}:${config.port}]`;
}

function labeledText(config: ConnectionConfig, body: string): ReturnType<typeof text> {
  return text(`[${connectionIdentity(config)}]\n${body}`);
}

function formatQueryToolResult(result: QueryResult, title?: string) {
  const prefix = title ? `${title}\n` : "";
  if (result.columns.length === 0) return text(`${prefix}Query executed. ${result.row_count} row(s) affected.`);
  const rows = result.rows.map((r) => result.columns.map((c) => formatCell(r[c])));
  return text(`${prefix}${mdTable(result.columns, rows)}\n\n${result.row_count} row(s)`);
}

function redisDbFromValue(value?: string): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const db = Number(trimmed);
  return Number.isInteger(db) && db >= 0 ? db : undefined;
}

function defaultRedisDb(config: ConnectionConfig, scope: McpScope, db?: number): number {
  return db ?? redisDbFromValue(scope.database) ?? redisDbFromValue(config.database) ?? 0;
}

function formatRedisCommandValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

function formatRedisCommandToolResult(result: RedisCommandResult) {
  return text(`Command: ${result.command}\nSafety: ${result.safety}\n\n${formatRedisCommandValue(result.value)}`);
}

export const DBX_CONNECTION_TYPE_DESCRIPTION =
  "Database type: postgres, mysql, sqlite, rqlite, cloudflare-d1, redis, duckdb, clickhouse, sqlserver, mongodb, oracle, elasticsearch, etcd, doris, starrocks, manticoresearch, milvus, qdrant, weaviate, chromadb, redshift, dameng, kingbase, highgo, vastbase, goldendb, databend, gaussdb, kwdb, yashandb, databricks, saphana, teradata, vertica, firebird, exasol, opengauss, oceanbase-oracle, questdb, gbase, h2, snowflake, trino, prestosql, hive, spark, db2, informix, influxdb, iris, neo4j, cassandra, bigquery, kylin, sundb, oscar, tdengine, iotdb, xugu, zookeeper, jdbc, access, mq";
const FILE_CAPABLE_CONNECTION_TYPES = new Set(["sqlite", "duckdb", "access", "h2"]);

interface McpScope {
  connectionId?: string;
  connectionName?: string;
  database?: string;
}

function scopedValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function mcpScopeFromEnv(): McpScope {
  return {
    connectionId: scopedValue(process.env.DBX_MCP_SCOPE_CONNECTION_ID),
    connectionName: scopedValue(process.env.DBX_MCP_SCOPE_CONNECTION_NAME),
    database: scopedValue(process.env.DBX_MCP_SCOPE_DATABASE),
  };
}

function scopeEnabled(scope: McpScope): boolean {
  return !!(scope.connectionId || scope.connectionName);
}

function connectionMatchesScope(config: ConnectionConfig, scope: McpScope): boolean {
  return (!!scope.connectionId && config.id === scope.connectionId) || (!!scope.connectionName && config.name === scope.connectionName);
}

async function loadScopedConnections(backend: Backend, scope: McpScope): Promise<ConnectionConfig[]> {
  const connections = await backend.loadConnections();
  if (!scopeEnabled(scope)) return connections;
  return connections.filter((config) => connectionMatchesScope(config, scope));
}

async function resolveConnection(backend: Backend, scope: McpScope, requestedId?: string, requestedName?: string): Promise<{ config?: ConnectionConfig; error?: ReturnType<typeof toolError> }> {
  // connection_id takes priority over connection_name when both are provided.
  if (requestedId?.trim()) {
    const connections = await backend.loadConnections();
    const config = connections.find((c) => c.id === requestedId.trim());
    if (!config) return { error: toolError("CONNECTION_NOT_FOUND", `Connection with id "${requestedId}" not found.`) };
    // In scoped mode, verify the resolved connection is within the scope.
    if (scopeEnabled(scope) && !connectionMatchesScope(config, scope)) {
      return { error: toolError("CONNECTION_OUT_OF_SCOPE", `Connection "${requestedId}" is outside this DBX AI session scope.`) };
    }
    return { config };
  }

  if (!scopeEnabled(scope)) {
    if (!requestedName?.trim()) return { error: toolError("CONNECTION_NOT_FOUND", "Connection name is required.") };
    const connections = await backend.loadConnections();
    const matching = connections.filter((c) => c.name.toLowerCase() === requestedName.trim().toLowerCase());
    if (matching.length === 0) return { error: toolError("CONNECTION_NOT_FOUND", `Connection "${requestedName}" not found.`) };
    if (matching.length > 1) {
      const lines = matching.map((c) => `- ${c.id}: ${c.db_type} @ ${c.host}:${c.port}`);
      return {
        error: toolError("AMBIGUOUS_CONNECTION", `Multiple connections found with name "${requestedName}". Please specify connection_id:\n${lines.join("\n")}`),
      };
    }
    return { config: matching[0] };
  }

  const [scopedConfig] = await loadScopedConnections(backend, scope);
  if (!scopedConfig) return { error: toolError("CONNECTION_NOT_FOUND", "Scoped DBX connection was not found.") };
  if (requestedName?.trim() && requestedName !== scopedConfig.name && requestedName !== scopedConfig.id) {
    return { error: toolError("CONNECTION_OUT_OF_SCOPE", `Connection "${requestedName}" is outside this DBX AI session scope.`) };
  }
  return { config: scopedConfig };
}

export function createDbxMcpServer(backend: Backend, options: { isWebMode?: boolean } = {}): McpServer {
  const isWebMode = options.isWebMode ?? !!process.env.DBX_WEB_URL;
  const scope = mcpScopeFromEnv();
  const scoped = scopeEnabled(scope);
  const server = new McpServer({
    name: "dbx",
    version: DBX_MCP_PACKAGE_VERSION,
  });

  server.tool("dbx_list_connections", "List all database connections configured in DBX", {}, async () => {
    const connections = await loadScopedConnections(backend, scope);
    if (connections.length === 0) return text("No connections configured in DBX.");
    const rows = connections.map((c) => [c.id, c.name, c.db_type, c.host, String(c.port), c.database || ""]);
    return text(mdTable(["ID", "Name", "Type", "Host", "Port", "Database"], rows));
  });

  server.tool(
    "dbx_list_tables",
    "List tables and views for a database connection",
    {
      connection_id: z.string().optional().describe("Unique ID of the DBX connection (use this to disambiguate when multiple connections share the same name)"),
      connection_name: z.string().optional().describe("Name of the DBX connection"),
      database: z.string().optional().describe("Database name; for Dameng this is also accepted as a schema alias"),
      schema: z.string().optional().describe("Schema name (default: public for PostgreSQL, login user for Dameng)"),
    },
    async ({ connection_id, connection_name, database, schema }) => {
      const { config, error } = await resolveConnection(backend, scope, connection_id, connection_name);
      if (error) return error;
      const resolvedConfig = config!;
      const scopeValue = metadataScope(resolvedConfig, database ?? scope.database, schema);
      const tables = await backend.listTables(scopeValue.config, scopeValue.schema);
      if (tables.length === 0) return text("No tables found.");
      const rows = tables.map((t) => [t.name, t.type]);
      return labeledText(resolvedConfig, mdTable(["Table", "Type"], rows));
    },
  );

  server.tool(
    "dbx_describe_table",
    "Get column definitions for a table",
    {
      connection_id: z.string().optional().describe("Unique ID of the DBX connection (use this to disambiguate when multiple connections share the same name)"),
      connection_name: z.string().optional().describe("Name of the DBX connection"),
      table: z.string().describe("Table name"),
      database: z.string().optional().describe("Database name; for Dameng this is also accepted as a schema alias"),
      schema: z.string().optional().describe("Schema name (default: public for PostgreSQL, login user for Dameng)"),
    },
    async ({ connection_id, connection_name, table, database, schema }) => {
      const { config, error } = await resolveConnection(backend, scope, connection_id, connection_name);
      if (error) return error;
      const resolvedConfig = config!;
      const scopeValue = metadataScope(resolvedConfig, database ?? scope.database, schema);
      const columns = await backend.describeTable(scopeValue.config, table, scopeValue.schema);
      if (columns.length === 0) return text("No columns found.");
      const rows = columns.map((c) => [c.is_primary_key ? `${c.name} (PK)` : c.name, c.data_type, c.is_nullable ? "YES" : "NO", c.column_default ?? "", c.comment ?? ""]);
      return labeledText(resolvedConfig, mdTable(["Column", "Type", "Nullable", "Default", "Comment"], rows));
    },
  );

  server.tool(
    "dbx_execute_query",
    "Execute a SQL query on a database connection (max 100 rows returned)",
    {
      connection_id: z.string().optional().describe("Unique ID of the DBX connection (use this to disambiguate when multiple connections share the same name)"),
      connection_name: z.string().optional().describe("Name of the DBX connection"),
      database: z.string().optional().describe("Database name"),
      sql: z.string().describe("SQL query to execute"),
    },
    async ({ connection_id, connection_name, database, sql }) => {
      const { config, error } = await resolveConnection(backend, scope, connection_id, connection_name);
      if (error) return error;
      const scopedConfig = config!;
      if (scopedConfig.db_type === "redis") {
        return toolError("REDIS_COMMAND_REQUIRED", "Redis connections do not accept SQL through dbx_execute_query. Use dbx_execute_redis_command with a Redis command such as GET key or INFO.");
      }
      if (scopedConfig.db_type !== "mongodb") {
        const safety = evaluateSqlSafety(sql, { ...sqlSafetyFromEnv(), allowMultipleStatements: true });
        if (!safety.allowed) return toolError("SQL_BLOCKED", safety.reason ?? "SQL blocked.");
        const production = assessProductionSql(sql, scopedConfig, database ?? scope.database ?? scopedConfig.database);
        if (production.active && production.isMutation) {
          return toolError("PRODUCTION_WRITE_BLOCKED", "MCP cannot execute writes against a production database. Return the SQL for a user to review and run in DBX.");
        }
      } else if (isProductionDatabase(scopedConfig, database ?? scope.database ?? scopedConfig.database) && isLikelyMongoMutation(sql)) {
        return toolError("PRODUCTION_WRITE_BLOCKED", "MCP cannot execute writes against a production database. Return the command for a user to review and run in DBX.");
      }
      // MongoDB shell commands don't fit the SQL safety evaluator; the backend
      // (node-core executeQuery) applies command-aware read/write gating.
      try {
        const statements = scopedConfig.db_type === "mongodb" ? [sql] : splitSqlStatements(sql);
        const results = [];
        for (const statement of statements) {
          results.push(await backend.executeQuery(withDatabase(scopedConfig, database ?? scope.database), statement));
        }
        if (results.length === 1) return labeledText(scopedConfig, formatQueryToolResult(results[0]).content[0].text);
        return labeledText(scopedConfig, results.map((result, index) => formatQueryToolResult(result, `Statement ${index + 1}`).content[0].text).join("\n\n"));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolError("QUERY_ERROR", msg);
      }
    },
  );

  server.tool(
    "dbx_execute_redis_command",
    "Execute a Redis command on a Redis connection",
    {
      connection_id: z.string().optional().describe("Unique ID of the DBX connection (use this to disambiguate when multiple connections share the same name)"),
      connection_name: z.string().optional().describe("Name of the DBX Redis connection"),
      db: z.number().int().min(0).optional().describe("Redis logical database number (default: scoped/default database or 0)"),
      command: z.string().describe("Redis command to execute, for example: GET mykey, INFO, or DBSIZE"),
    },
    async ({ connection_id, connection_name, db, command }) => {
      const { config, error } = await resolveConnection(backend, scope, connection_id, connection_name);
      if (error) return error;
      const scopedConfig = config!;
      if (scopedConfig.db_type !== "redis") {
        return toolError("INVALID_CONNECTION_TYPE", `Connection "${scopedConfig.name}" is ${scopedConfig.db_type}, not Redis.`);
      }
      if (!backend.executeRedisCommand) {
        return toolError("UNSUPPORTED_BACKEND", "This DBX backend does not support Redis command execution.");
      }
      const safety = evaluateRedisCommandSafety(command, sqlSafetyFromEnv());
      if (!safety.allowed) return toolError("REDIS_COMMAND_BLOCKED", safety.reason ?? "Redis command blocked.");
      if (isProductionDatabase(scopedConfig, String(defaultRedisDb(scopedConfig, scope, db))) && safety.safety !== "allowed") {
        return toolError("PRODUCTION_WRITE_BLOCKED", "MCP cannot execute write or dangerous Redis commands against a production database.");
      }
      try {
        const result = await backend.executeRedisCommand(scopedConfig, defaultRedisDb(scopedConfig, scope, db), command, {
          skipSafetyCheck: safety.skipSafetyCheck,
        });
        return labeledText(scopedConfig, formatRedisCommandToolResult(result).content[0].text);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return toolError("REDIS_COMMAND_ERROR", msg);
      }
    },
  );

  server.tool(
    "dbx_get_schema_context",
    "Get compact table and column context for writing SQL",
    {
      connection_id: z.string().optional().describe("Unique ID of the DBX connection (use this to disambiguate when multiple connections share the same name)"),
      connection_name: z.string().optional().describe("Name of the DBX connection"),
      database: z.string().optional().describe("Database name"),
      schema: z.string().optional().describe("Schema name (default: public for PostgreSQL)"),
      tables: z.array(z.string()).optional().describe("Specific table names to include"),
      max_tables: z.number().int().min(1).max(20).default(8).describe("Maximum number of tables to include"),
    },
    async ({ connection_id, connection_name, database, schema, tables, max_tables }) => {
      const { config, error } = await resolveConnection(backend, scope, connection_id, connection_name);
      if (error) return error;
      const resolvedConfig = config!;
      const context = await buildSchemaContext(backend, withDatabase(resolvedConfig, database ?? scope.database), {
        schema,
        tables,
        maxTables: max_tables,
      });
      if (context.tables.length === 0) return text("No matching tables found.");
      return labeledText(resolvedConfig, formatSchemaContext(context));
    },
  );

  if (!scoped) {
    server.tool(
      "dbx_add_connection",
      "Add a new database connection to DBX",
      {
        name: z.string().describe("Connection name"),
        db_type: z.string().describe(DBX_CONNECTION_TYPE_DESCRIPTION),
        host: z.string().describe("Database host; for cloudflare-d1, use the Cloudflare Account ID"),
        port: z.number().optional().describe("Database port (TDengine defaults to 6041, IoTDB defaults to 6667, XuguDB defaults to 5138)"),
        username: z.string().default("").describe("Username"),
        password: z.string().default("").describe("Password; for cloudflare-d1, use the API Token"),
        database: z.string().optional().describe("Default database name; for cloudflare-d1, use the D1 Database ID"),
        ssl: z.boolean().default(false).describe("Enable SSL"),
        driver_profile: z.string().optional().describe("Driver profile (e.g. 'gbase8a', 'gbase8s')"),
      },
      async ({ name, db_type, host, port, username, password, database, ssl, driver_profile }) => {
        const existing = await backend.findConnection(name);
        if (existing) return text(`Connection "${name}" already exists.`);
        const DEFAULT_PORTS: Record<string, number> = {
          kwdb: 26257,
          rqlite: 4001,
          "cloudflare-d1": 443,
          tdengine: 6041,
          oscar: 2003,
          iotdb: 6667,
          xugu: 5138,
        };
        const resolvedPort = port ?? DEFAULT_PORTS[db_type] ?? (FILE_CAPABLE_CONNECTION_TYPES.has(db_type) ? 0 : undefined);
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
          driver_profile,
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
        connection_id: z.string().optional().describe("Unique ID of the DBX connection (use this to remove by id instead of name)"),
      },
      async ({ connection_name, connection_id }) => {
        if (connection_id?.trim()) {
          if (backend.removeConnectionById) {
            const removed = await backend.removeConnectionById(connection_id.trim());
            if (!removed) return toolError("CONNECTION_NOT_FOUND", `Connection with id "${connection_id}" not found.`);
            await notifyReload();
            return text(`Connection with id "${connection_id}" removed.`);
          }
          // Fallback: resolve by id then remove by name
          const connections = await backend.loadConnections();
          const config = connections.find((c) => c.id === connection_id.trim());
          if (!config) return toolError("CONNECTION_NOT_FOUND", `Connection with id "${connection_id}" not found.`);
          const removed = await backend.removeConnection(config.name);
          if (!removed) return toolError("CONNECTION_NOT_FOUND", `Connection "${config.name}" could not be removed.`);
          await notifyReload();
          return text(`Connection "${config.name}" (id: ${config.id}) removed.`);
        }
        const allConnections = await backend.loadConnections();
        const matching = allConnections.filter((c) => c.name.toLowerCase() === connection_name.toLowerCase());
        if (matching.length === 0) return toolError("CONNECTION_NOT_FOUND", `Connection "${connection_name}" not found.`);
        if (matching.length > 1) {
          const lines = matching.map((c) => `- ${c.id}: ${c.db_type} @ ${c.host}:${c.port}`);
          return toolError("AMBIGUOUS_CONNECTION", `Multiple connections found with name "${connection_name}". Please specify connection_id:\n${lines.join("\n")}`);
        }
        const removed = await backend.removeConnection(connection_name);
        if (!removed) return toolError("CONNECTION_NOT_FOUND", `Connection "${connection_name}" not found.`);
        await notifyReload();
        return text(`Connection "${connection_name}" removed.`);
      },
    );
  }

  // Desktop-only tools: open table and execute-and-show require the Tauri bridge
  if (!isWebMode && !scoped) {
    server.tool(
      "dbx_open_table",
      "Open a table in DBX desktop app UI. Requires DBX to be running.",
      {
        connection_id: z.string().optional().describe("Unique ID of the DBX connection (use this to disambiguate when multiple connections share the same name)"),
        connection_name: z.string().optional().describe("Name of the DBX connection"),
        table: z.string().describe("Table name to open"),
        database: z.string().optional().describe("Database name"),
        schema: z.string().optional().describe("Schema name"),
      },
      async ({ connection_id, connection_name, table, database, schema }) => {
        let config: ConnectionConfig | undefined;
        if (connection_id?.trim()) {
          const connections = await backend.loadConnections();
          config = connections.find((c) => c.id === connection_id.trim());
          if (!config) return toolError("CONNECTION_NOT_FOUND", `Connection with id "${connection_id}" not found.`);
        } else if (connection_name?.trim()) {
          const connections = await backend.loadConnections();
          const matching = connections.filter((c) => c.name.toLowerCase() === connection_name.toLowerCase());
          if (matching.length === 0) return toolError("CONNECTION_NOT_FOUND", `Connection "${connection_name}" not found.`);
          if (matching.length > 1) {
            const lines = matching.map((c) => `- ${c.id}: ${c.db_type} @ ${c.host}:${c.port}`);
            return toolError("AMBIGUOUS_CONNECTION", `Multiple connections found with name "${connection_name}". Please specify connection_id:\n${lines.join("\n")}`);
          }
          config = matching[0];
        } else {
          return toolError("CONNECTION_NOT_FOUND", "Either connection_id or connection_name is required.");
        }
        return bridgeRequest("/open-table", { connection_id: config.id, connection_name: config.name, table, database, schema }, `Opened ${table} in DBX`);
      },
    );

    server.tool(
      "dbx_execute_and_show",
      "Execute a SQL query in DBX desktop app UI and show results there. Requires DBX to be running.",
      {
        connection_id: z.string().optional().describe("Unique ID of the DBX connection (use this to disambiguate when multiple connections share the same name)"),
        connection_name: z.string().optional().describe("Name of the DBX connection"),
        sql: z.string().describe("SQL query to execute"),
        database: z.string().optional().describe("Database name"),
      },
      async ({ connection_id, connection_name, sql, database }) => {
        let config: ConnectionConfig | undefined;
        if (connection_id?.trim()) {
          const connections = await backend.loadConnections();
          config = connections.find((c) => c.id === connection_id.trim());
          if (!config) return toolError("CONNECTION_NOT_FOUND", `Connection with id "${connection_id}" not found.`);
        } else if (connection_name?.trim()) {
          const connections = await backend.loadConnections();
          const matching = connections.filter((c) => c.name.toLowerCase() === connection_name.toLowerCase());
          if (matching.length === 0) return toolError("CONNECTION_NOT_FOUND", `Connection "${connection_name}" not found.`);
          if (matching.length > 1) {
            const lines = matching.map((c) => `- ${c.id}: ${c.db_type} @ ${c.host}:${c.port}`);
            return toolError("AMBIGUOUS_CONNECTION", `Multiple connections found with name "${connection_name}". Please specify connection_id:\n${lines.join("\n")}`);
          }
          config = matching[0];
        } else {
          return toolError("CONNECTION_NOT_FOUND", "Either connection_id or connection_name is required.");
        }
        const safetyOptions = sqlSafetyFromEnv();
        if (config?.db_type === "mongodb") {
          const aggregate = parseMongoAggregateCommand(sql);
          if (aggregate) {
            const safety = evaluateMongoAggregateSafety(aggregate, safetyOptions);
            if (!safety.allowed) return toolError("SQL_BLOCKED", safety.reason ?? "Query blocked.");
          }
        } else {
          const safety = evaluateSqlSafety(sql, { ...safetyOptions, allowMultipleStatements: true });
          if (!safety.allowed) return toolError("SQL_BLOCKED", safety.reason ?? "SQL blocked.");
        }
        if (config?.db_type === "mongodb") {
          if (isProductionDatabase(config, database ?? scope.database ?? config.database) && isLikelyMongoMutation(sql)) {
            return toolError("PRODUCTION_WRITE_BLOCKED", "MCP cannot send writes against a production database to DBX.");
          }
        } else {
          const production = assessProductionSql(sql, config, database ?? scope.database ?? config.database);
          if (production.active && production.isMutation) {
            return toolError("PRODUCTION_WRITE_BLOCKED", "MCP cannot send writes against a production database to DBX.");
          }
        }
        // MongoDB shell commands bypass the SQL safety evaluator; pass MCP
        // safety flags to the desktop executor for command-aware gating.
        return bridgeRequest(
          "/execute-query",
          {
            connection_id: config!.id,
            connection_name: config!.name,
            sql,
            database,
            allow_writes: safetyOptions.allowWrites,
            allow_dangerous: safetyOptions.allowDangerous,
          },
          "Query sent to DBX",
        );
      },
    );
  }

  return server;
}

async function bridgeRequest(path: string, body: Record<string, unknown>, successMsg: string) {
  const res = await postBridge(path, body);
  if (res.ok) return text(successMsg);
  const message = res.text.startsWith("DBX is not running") ? res.text : `Failed: ${res.text}`;
  return toolError("DBX_NOT_RUNNING", message);
}

async function main() {
  const backend = await createBackend();
  const server = createDbxMcpServer(backend);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((e) => {
    console.error("MCP Server failed to start:", e);
    process.exit(1);
  });
}
