import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { Backend, ConnectionConfig } from "@dbx-app/node-core";
import { createDbxMcpServer, DBX_MCP_PACKAGE_VERSION } from "../src/index.js";

const connection: ConnectionConfig = {
  id: "1",
  name: "local",
  db_type: "postgres",
  host: "127.0.0.1",
  port: 5432,
  username: "app",
  password: "",
  database: "demo",
  ssh_enabled: false,
  ssl: false,
};

const backend: Backend = {
  loadConnections: async () => [connection],
  findConnection: async (name) => (name === "local" ? connection : undefined),
  addConnection: async () => connection,
  removeConnection: async () => true,
  listTables: async () => [{ name: "users", type: "BASE TABLE" }],
  describeTable: async () => [{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, comment: null }],
  executeQuery: async () => ({ columns: ["total"], rows: [{ total: 1 }], row_count: 1 }),
};

async function withScopedEnv<T>(env: Record<string, string>, fn: () => T | Promise<T>): Promise<T> {
  const oldValues = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    oldValues.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of oldValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("creates an MCP server without starting stdio transport", () => {
  const server = createDbxMcpServer(backend, { isWebMode: true });

  assert.equal(typeof server.connect, "function");
});

test("MCP server metadata version matches package metadata", () => {
  const server = createDbxMcpServer(backend, { isWebMode: true });

  assert.equal((server as any).server._serverInfo.version, DBX_MCP_PACKAGE_VERSION);
});

test("README runtime requirements match package engines", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8")) as {
    engines: { node: string };
  };
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf-8");
  const minimumNodeVersion = packageJson.engines.node.replace(">=", "");

  assert.match(readme, new RegExp(`Node\\.js ${minimumNodeVersion.replace(/\./g, "\\.")} or newer`));
  assert.match(readme, new RegExp(`Node\\.js ${minimumNodeVersion.replace(/\./g, "\\.")} 或更高版本`));
});

test("execute query scopes the connection to the requested database", async () => {
  let usedDatabase = "";
  const scopedBackend: Backend = {
    ...backend,
    executeQuery: async (config) => {
      usedDatabase = config.database || "";
      return { columns: ["total"], rows: [{ total: 1 }], row_count: 1 };
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  await (server as any)._registeredTools.dbx_execute_query.handler({
    connection_name: "local",
    database: "stores_demo",
    sql: "SELECT FIRST 1 tabname FROM systables",
  });

  assert.equal(usedDatabase, "stores_demo");
});

test("execute query runs safe multi-statement SQL one statement at a time", async () => {
  const executed: string[] = [];
  const scopedBackend: Backend = {
    ...backend,
    executeQuery: async (_config, sql) => {
      executed.push(sql);
      return { columns: ["value"], rows: [{ value: executed.length }], row_count: 1 };
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  const result = await (server as any)._registeredTools.dbx_execute_query.handler({
    connection_name: "local",
    sql: "select 1; select 2;",
  });

  assert.deepEqual(executed, ["select 1", "select 2"]);
  assert.match(result.content[0].text, /Statement 1/);
  assert.match(result.content[0].text, /Statement 2/);
});

test("execute query preserves string literals and PostgreSQL dollar quotes", async () => {
  const executed: string[] = [];
  const scopedBackend: Backend = {
    ...backend,
    executeQuery: async (_config, sql) => {
      executed.push(sql);
      return { columns: ["value"], rows: [{ value: 1 }], row_count: 1 };
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  await (server as any)._registeredTools.dbx_execute_query.handler({
    connection_name: "local",
    sql: "SELECT 'a;b' AS first; SELECT $tag$c;d$tag$ AS second;",
  });

  assert.deepEqual(executed, ["SELECT 'a;b' AS first", "SELECT $tag$c;d$tag$ AS second"]);
});

test("execute query reports the blocked statement number for unsafe multi-statement SQL", async () => {
  const server = createDbxMcpServer(backend, { isWebMode: true });

  const result = await (server as any)._registeredTools.dbx_execute_query.handler({
    connection_name: "local",
    sql: "select 1; delete from users;",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /SQL_BLOCKED:/);
  assert.match(result.content[0].text, /Statement 2/);
  assert.match(result.content[0].text, /WHERE/);
});

test("scoped MCP lists only the active connection", async () => {
  const other: ConnectionConfig = { ...connection, id: "2", name: "other", database: "other_db" };
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [connection, other],
  };

  const result = await withScopedEnv({ DBX_MCP_SCOPE_CONNECTION_ID: "1" }, () => {
    const server = createDbxMcpServer(scopedBackend, { isWebMode: true });
    return (server as any)._registeredTools.dbx_list_connections.handler({});
  });

  assert.match(result.content[0].text, /local/);
  assert.doesNotMatch(result.content[0].text, /other/);
});

test("scoped MCP rejects out-of-scope connection tool calls", async () => {
  const result = await withScopedEnv({ DBX_MCP_SCOPE_CONNECTION_ID: "1" }, () => {
    const server = createDbxMcpServer(backend, { isWebMode: true });
    return (server as any)._registeredTools.dbx_list_tables.handler({ connection_name: "other" });
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /CONNECTION_OUT_OF_SCOPE:/);
});

test("scoped MCP defaults connection-taking tools to the active connection and database", async () => {
  let usedDatabase = "";
  const scopedBackend: Backend = {
    ...backend,
    listTables: async (config) => {
      usedDatabase = config.database || "";
      return [{ name: "users", type: "BASE TABLE" }];
    },
  };

  const result = await withScopedEnv({ DBX_MCP_SCOPE_CONNECTION_ID: "1", DBX_MCP_SCOPE_DATABASE: "scoped_db" }, () => {
    const server = createDbxMcpServer(scopedBackend, { isWebMode: true });
    return (server as any)._registeredTools.dbx_list_tables.handler({});
  });

  assert.match(result.content[0].text, /users/);
  assert.equal(usedDatabase, "scoped_db");
});

test("scoped MCP does not register mutation or desktop bridge tools", async () => {
  await withScopedEnv({ DBX_MCP_SCOPE_CONNECTION_ID: "1" }, () => {
    const server = createDbxMcpServer(backend, { isWebMode: false });
    const tools = (server as any)._registeredTools;

    assert.equal(tools.dbx_add_connection, undefined);
    assert.equal(tools.dbx_remove_connection, undefined);
    assert.equal(tools.dbx_open_table, undefined);
    assert.equal(tools.dbx_execute_and_show, undefined);
  });
});

test("scoped MCP with writes disabled blocks write SQL", async () => {
  const result = await withScopedEnv({ DBX_MCP_SCOPE_CONNECTION_ID: "1", DBX_MCP_ALLOW_WRITES: "0" }, () => {
    const server = createDbxMcpServer(backend, { isWebMode: true });
    return (server as any)._registeredTools.dbx_execute_query.handler({
      sql: "update users set name = 'x' where id = 1",
    });
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /SQL_BLOCKED:/);
});

test("redis execute query points callers to the redis command tool", async () => {
  const redisConnection: ConnectionConfig = { ...connection, db_type: "redis", database: "0" };
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [redisConnection],
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  const result = await (server as any)._registeredTools.dbx_execute_query.handler({
    connection_name: "local",
    sql: "GET session:1",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /REDIS_COMMAND_REQUIRED:/);
  assert.match(result.content[0].text, /dbx_execute_redis_command/);
});

test("redis command tool executes redis commands on the selected database", async () => {
  const redisConnection: ConnectionConfig = { ...connection, db_type: "redis", database: "2" };
  let usedDb = -1;
  let usedCommand = "";
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [redisConnection],
    executeRedisCommand: async (_config, db, command) => {
      usedDb = db;
      usedCommand = command;
      return { command: "GET", safety: "allowed", value: "value-1" };
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  const result = await (server as any)._registeredTools.dbx_execute_redis_command.handler({
    connection_name: "local",
    command: "GET session:1",
  });

  assert.equal(result.isError, undefined);
  assert.equal(usedDb, 2);
  assert.equal(usedCommand, "GET session:1");
  assert.match(result.content[0].text, /Command: GET/);
  assert.match(result.content[0].text, /value-1/);
});

test("redis command tool blocks write commands in read-only MCP sessions", async () => {
  let executed = false;
  const redisConnection: ConnectionConfig = { ...connection, db_type: "redis" };
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [redisConnection],
    executeRedisCommand: async () => {
      executed = true;
      return { command: "SET", safety: "write", value: "OK" };
    },
  };

  const result = await withScopedEnv({ DBX_MCP_ALLOW_WRITES: "0" }, () => {
    const server = createDbxMcpServer(scopedBackend, { isWebMode: true });
    return (server as any)._registeredTools.dbx_execute_redis_command.handler({
      connection_name: "local",
      command: "SET session:1 value",
    });
  });

  assert.equal(executed, false);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /REDIS_COMMAND_BLOCKED:/);
});

test("redis command tool allows dangerous redis commands only when explicitly enabled", async () => {
  const redisConnection: ConnectionConfig = { ...connection, db_type: "redis" };
  let skipSafetyCheck = false;
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [redisConnection],
    executeRedisCommand: async (_config, _db, _command, options) => {
      skipSafetyCheck = options?.skipSafetyCheck ?? false;
      return { command: "KEYS", safety: "blocked", value: ["session:1"] };
    },
  };

  const blocked = await withScopedEnv({ DBX_MCP_ALLOW_DANGEROUS_SQL: "0" }, () => {
    const server = createDbxMcpServer(scopedBackend, { isWebMode: true });
    return (server as any)._registeredTools.dbx_execute_redis_command.handler({
      connection_name: "local",
      command: "KEYS *",
    });
  });
  const allowed = await withScopedEnv({ DBX_MCP_ALLOW_DANGEROUS_SQL: "1" }, () => {
    const server = createDbxMcpServer(scopedBackend, { isWebMode: true });
    return (server as any)._registeredTools.dbx_execute_redis_command.handler({
      connection_name: "local",
      command: "KEYS *",
    });
  });

  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /REDIS_COMMAND_BLOCKED:/);
  assert.equal(allowed.isError, undefined);
  assert.equal(skipSafetyCheck, true);
  assert.match(allowed.content[0].text, /session:1/);
});

test("mongodb list tables returns collections from the selected database", async () => {
  let usedDatabase = "";
  const mongoConnection: ConnectionConfig = { ...connection, db_type: "mongodb", database: "admin" };
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [mongoConnection],
    listTables: async (config) => {
      usedDatabase = config.database || "";
      return [{ name: "projects", type: "COLLECTION" }];
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  const result = await (server as any)._registeredTools.dbx_list_tables.handler({
    connection_name: "local",
    database: "pystrument",
  });

  assert.equal(usedDatabase, "pystrument");
  assert.match(result.content[0].text, /projects/);
  assert.match(result.content[0].text, /COLLECTION/);
});

test("mongodb describe table returns inferred document fields", async () => {
  const mongoConnection: ConnectionConfig = { ...connection, db_type: "mongodb" };
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [mongoConnection],
    describeTable: async () => [
      {
        name: "_id",
        data_type: "object",
        is_nullable: false,
        column_default: null,
        is_primary_key: true,
        comment: null,
      },
      {
        name: "name",
        data_type: "string",
        is_nullable: false,
        column_default: null,
        is_primary_key: false,
        comment: null,
      },
    ],
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  const result = await (server as any)._registeredTools.dbx_describe_table.handler({
    connection_name: "local",
    database: "pystrument",
    table: "projects",
  });

  assert.match(result.content[0].text, /_id \(PK\)/);
  assert.match(result.content[0].text, /name/);
});

test("dameng metadata tools default to the login user schema", async () => {
  const damengConnection: ConnectionConfig = {
    ...connection,
    db_type: "dameng",
    username: "SYSDBA",
    database: "DAMENG",
  };
  const usedScopes: Array<{ database?: string; schema?: string }> = [];
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [damengConnection],
    listTables: async (config, schema) => {
      usedScopes.push({ database: config.database, schema });
      return [{ name: "ORDERS", type: "TABLE" }];
    },
    describeTable: async (config, _table, schema) => {
      usedScopes.push({ database: config.database, schema });
      return [{ name: "ID", data_type: "BIGINT", is_nullable: false, column_default: null, is_primary_key: true, comment: null }];
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  await (server as any)._registeredTools.dbx_list_tables.handler({ connection_name: "local" });
  await (server as any)._registeredTools.dbx_describe_table.handler({ connection_name: "local", table: "ORDERS" });

  assert.deepEqual(usedScopes, [
    { database: "DAMENG", schema: "SYSDBA" },
    { database: "DAMENG", schema: "SYSDBA" },
  ]);
});

test("dameng metadata tools treat database as a schema alias while preferring explicit schema", async () => {
  const damengConnection: ConnectionConfig = { ...connection, db_type: "dameng", username: "SYSDBA", database: "DAMENG" };
  let usedSchema = "";
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [damengConnection],
    listTables: async (_config, schema) => {
      usedSchema = schema || "";
      return [{ name: "ORDERS", type: "TABLE" }];
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  await (server as any)._registeredTools.dbx_list_tables.handler({ connection_name: "local", database: "XC" });

  assert.equal(usedSchema, "XC");

  await (server as any)._registeredTools.dbx_list_tables.handler({ connection_name: "local", database: "XC", schema: "REPORTING" });

  assert.equal(usedSchema, "REPORTING");
});

test("mongodb execute query formats shell-style find results", async () => {
  const mongoConnection: ConnectionConfig = { ...connection, db_type: "mongodb" };
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [mongoConnection],
    executeQuery: async () => ({
      columns: ["_id", "meta", "missing"],
      rows: [{ _id: "1", meta: { name: "demo" }, missing: null }],
      row_count: 1,
    }),
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  const result = await (server as any)._registeredTools.dbx_execute_query.handler({
    connection_name: "local",
    database: "pystrument",
    sql: "db.projects.find({}).limit(1)",
  });

  assert.match(result.content[0].text, /"name":"demo"/);
  assert.match(result.content[0].text, /NULL/);
  assert.match(result.content[0].text, /1 row\(s\)/);
});

test("connection lookup failures include a stable MCP error code", async () => {
  const server = createDbxMcpServer(backend, { isWebMode: true });

  const result = await (server as any)._registeredTools.dbx_list_tables.handler({
    connection_name: "missing",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /CONNECTION_NOT_FOUND:/);
  assert.match(result.content[0].text, /missing/);
});

test("add connection accepts H2 file paths without a port", async () => {
  let added: Omit<ConnectionConfig, "id"> | undefined;
  const scopedBackend: Backend = {
    ...backend,
    addConnection: async (config) => {
      added = config;
      return { id: "h2-file", ...config };
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  const result = await (server as any)._registeredTools.dbx_add_connection.handler({
    name: "h2-local",
    db_type: "h2",
    host: "/data/app.mv.db",
    username: "sa",
    password: "",
  });

  assert.equal(result.isError, undefined);
  assert.equal(added?.db_type, "h2");
  assert.equal(added?.host, "/data/app.mv.db");
  assert.equal(added?.port, 0);
});

test("SQL safety failures include a stable MCP error code", async () => {
  const server = createDbxMcpServer(backend, { isWebMode: true });

  const result = await (server as any)._registeredTools.dbx_execute_query.handler({
    connection_name: "local",
    sql: "drop table users",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /SQL_BLOCKED:/);
  assert.match(result.content[0].text, /Dangerous SQL/);
});

test("query exceptions include a stable MCP error code", async () => {
  const scopedBackend: Backend = {
    ...backend,
    executeQuery: async () => {
      throw new Error("database timeout");
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  const result = await (server as any)._registeredTools.dbx_execute_query.handler({
    connection_name: "local",
    sql: "select 1",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /QUERY_ERROR: database timeout/);
});

test("desktop bridge failures include a stable MCP error code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbx-mcp-home-"));

  try {
    // Use DBX_DATA_DIR (honoured cross-platform) to point bridgePortFilePath()
    // at an empty temp directory so no real bridge is reachable.
    await withScopedEnv({ DBX_DATA_DIR: dir }, async () => {
      const server = createDbxMcpServer(backend, { isWebMode: false });
      const result = await (server as any)._registeredTools.dbx_open_table.handler({
        connection_name: "local",
        table: "users",
      });

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /DBX_NOT_RUNNING:/);
      assert.match(result.content[0].text, /DBX is not running/);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mongodb execute-and-show blocks aggregate write stages before desktop bridge", async () => {
  const oldAllowWrites = process.env.DBX_MCP_ALLOW_WRITES;
  const oldAllowDangerous = process.env.DBX_MCP_ALLOW_DANGEROUS_SQL;
  delete process.env.DBX_MCP_ALLOW_WRITES;
  delete process.env.DBX_MCP_ALLOW_DANGEROUS_SQL;
  const mongoConnection: ConnectionConfig = { ...connection, db_type: "mongodb" };
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [mongoConnection],
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: false });

  try {
    const result = await (server as any)._registeredTools.dbx_execute_and_show.handler({
      connection_name: "local",
      database: "pystrument",
      sql: 'db.projects.aggregate([{"$out":"projects_dump"}])',
    });

    assert.match(result.content[0].text, /SQL_BLOCKED:/);
    assert.match(result.content[0].text, /DBX_MCP_ALLOW_DANGEROUS_SQL=1/);
  } finally {
    if (oldAllowWrites === undefined) delete process.env.DBX_MCP_ALLOW_WRITES;
    else process.env.DBX_MCP_ALLOW_WRITES = oldAllowWrites;
    if (oldAllowDangerous === undefined) delete process.env.DBX_MCP_ALLOW_DANGEROUS_SQL;
    else process.env.DBX_MCP_ALLOW_DANGEROUS_SQL = oldAllowDangerous;
  }
});

test("connection_id parameter resolves correctly", async () => {
  const connA: ConnectionConfig = { ...connection, id: "a1b2c3", name: "shared-name", db_type: "postgres" };
  const connB: ConnectionConfig = { ...connection, id: "d4e5f6", name: "shared-name", db_type: "redis", host: "redis.local", port: 6379 };
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [connA, connB],
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  // Resolve by connection_id should return the correct connection
  const result = await (server as any)._registeredTools.dbx_list_tables.handler({
    connection_id: "d4e5f6",
  });

  assert.match(result.content[0].text, /users/);
});

test("duplicate connection names return AMBIGUOUS_CONNECTION error", async () => {
  const connA: ConnectionConfig = { ...connection, id: "a1b2c3", name: "shared-name", db_type: "postgres", host: "pg.local", port: 5432 };
  const connB: ConnectionConfig = { ...connection, id: "d4e5f6", name: "shared-name", db_type: "redis", host: "redis.local", port: 6379 };
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [connA, connB],
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  // Using connection_name with duplicates should return AMBIGUOUS_CONNECTION
  const result = await (server as any)._registeredTools.dbx_list_tables.handler({
    connection_name: "shared-name",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /AMBIGUOUS_CONNECTION:/);
  assert.match(result.content[0].text, /a1b2c3:/);
  assert.match(result.content[0].text, /d4e5f6:/);
  assert.match(result.content[0].text, /postgres @ pg.local:5432/);
  assert.match(result.content[0].text, /redis @ redis.local:6379/);
});

test("connection_id takes priority over connection_name", async () => {
  const connA: ConnectionConfig = { ...connection, id: "a1b2c3", name: "shared-name", db_type: "postgres" };
  const connB: ConnectionConfig = { ...connection, id: "d4e5f6", name: "shared-name", db_type: "mysql", host: "mysql.local", port: 3306 };
  let usedConfig: ConnectionConfig | undefined;
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [connA, connB],
    listTables: async (config) => {
      usedConfig = config;
      return [{ name: "users", type: "BASE TABLE" }];
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  // Provide both connection_id and connection_name; connection_id should win
  await (server as any)._registeredTools.dbx_list_tables.handler({
    connection_id: "d4e5f6",
    connection_name: "shared-name",
  });

  assert.equal(usedConfig?.id, "d4e5f6");
});

test("dbx_list_connections includes ID column", async () => {
  const server = createDbxMcpServer(backend, { isWebMode: true });
  const result = await (server as any)._registeredTools.dbx_list_connections.handler({});

  // The table header should include the ID column
  assert.match(result.content[0].text, /ID.*Name.*Type.*Host.*Port.*Database/);
  // The connection's ID value "1" should appear in the table
  assert.match(result.content[0].text, /1\s+\|\s+local/);
});

test("same name and db_type with different host/port returns AMBIGUOUS_CONNECTION", async () => {
  const connA: ConnectionConfig = {
    ...connection,
    id: "pg-prod-us",
    name: "my-db",
    db_type: "postgres",
    host: "10.0.1.100",
    port: 5432,
    database: "app",
  };
  const connB: ConnectionConfig = {
    ...connection,
    id: "pg-prod-eu",
    name: "my-db",
    db_type: "postgres",
    host: "10.0.2.200",
    port: 5432,
    database: "app",
  };
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [connA, connB],
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  // Using connection_name with duplicates (same db_type) should still return AMBIGUOUS_CONNECTION
  const result = await (server as any)._registeredTools.dbx_list_tables.handler({
    connection_name: "my-db",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /AMBIGUOUS_CONNECTION:/);
  assert.match(result.content[0].text, /pg-prod-us: postgres @ 10\.0\.1\.100:5432/);
  assert.match(result.content[0].text, /pg-prod-eu: postgres @ 10\.0\.2\.200:5432/);
});

test("connection_id routes to correct host among same-name same-type connections", async () => {
  const connA: ConnectionConfig = {
    ...connection,
    id: "pg-prod-us",
    name: "my-db",
    db_type: "postgres",
    host: "10.0.1.100",
    port: 5432,
    database: "app",
  };
  const connB: ConnectionConfig = {
    ...connection,
    id: "pg-prod-eu",
    name: "my-db",
    db_type: "postgres",
    host: "10.0.2.200",
    port: 5432,
    database: "app",
  };
  const usedConfigs: ConnectionConfig[] = [];
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [connA, connB],
    listTables: async (config) => {
      usedConfigs.push(config);
      return [{ name: "orders", type: "BASE TABLE" }];
    },
    executeQuery: async (config, _sql) => {
      usedConfigs.push(config);
      return { columns: ["cnt"], rows: [{ cnt: 42 }], row_count: 1 };
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  // Route to US instance via connection_id
  const listResult = await (server as any)._registeredTools.dbx_list_tables.handler({
    connection_id: "pg-prod-us",
  });
  assert.match(listResult.content[0].text, /orders/);
  assert.equal(usedConfigs[0].id, "pg-prod-us");
  assert.equal(usedConfigs[0].host, "10.0.1.100");

  // Route to EU instance via connection_id
  const queryResult = await (server as any)._registeredTools.dbx_execute_query.handler({
    connection_id: "pg-prod-eu",
    database: "app",
    sql: "select count(*) as cnt from orders",
  });
  assert.match(queryResult.content[0].text, /42/);
  assert.equal(usedConfigs[1].id, "pg-prod-eu");
  assert.equal(usedConfigs[1].host, "10.0.2.200");
});

test("tool responses are prefixed with connection identity label", async () => {
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [{ ...connection, id: "conn-xyz", name: "orders-db", db_type: "postgres", host: "10.5.5.5", port: 5432 }],
    listTables: async () => [{ name: "orders", type: "BASE TABLE" }],
    executeQuery: async () => ({ columns: ["cnt"], rows: [{ cnt: 7 }], row_count: 1 }),
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  const listResult = await (server as any)._registeredTools.dbx_list_tables.handler({ connection_id: "conn-xyz" });
  assert.match(listResult.content[0].text, /^\[orders-db \(conn-xyz\) \[postgres @ 10\.5\.5\.5:5432\]\]/);

  const queryResult = await (server as any)._registeredTools.dbx_execute_query.handler({ connection_id: "conn-xyz", sql: "select count(*) as cnt from orders" });
  assert.match(queryResult.content[0].text, /^\[orders-db \(conn-xyz\) \[postgres @ 10\.5\.5\.5:5432\]\]/);
});

test("dbx_remove_connection with duplicate names returns AMBIGUOUS_CONNECTION", async () => {
  const connA: ConnectionConfig = { ...connection, id: "db-a", name: "staging", db_type: "postgres", host: "pg-a.local" };
  const connB: ConnectionConfig = { ...connection, id: "db-b", name: "staging", db_type: "mysql", host: "mysql-b.local", port: 3306 };
  let removedName: string | undefined;
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [connA, connB],
    removeConnection: async (name) => {
      removedName = name;
      return true;
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  const result = await (server as any)._registeredTools.dbx_remove_connection.handler({
    connection_name: "staging",
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /AMBIGUOUS_CONNECTION:/);
  assert.match(result.content[0].text, /db-a: postgres @ pg-a\.local/);
  assert.match(result.content[0].text, /db-b: mysql @ mysql-b\.local/);
  // removeConnection must NOT have been called — no silent deletion
  assert.equal(removedName, undefined);
});

test("dbx_execute_query with connection_id routes correctly on bridge-backed (SSH) connections", async () => {
  const connDirect: ConnectionConfig = { ...connection, id: "pg-direct", name: "shared", db_type: "postgres", host: "direct.local", ssh_enabled: false };
  const connSsh: ConnectionConfig = { ...connection, id: "pg-ssh", name: "shared", db_type: "postgres", host: "private.local", ssh_enabled: true };
  const usedConfigs: ConnectionConfig[] = [];
  const scopedBackend: Backend = {
    ...backend,
    loadConnections: async () => [connDirect, connSsh],
    executeQuery: async (config, _sql) => {
      usedConfigs.push(config);
      return { columns: ["result"], rows: [{ result: "ok" }], row_count: 1 };
    },
  };
  const server = createDbxMcpServer(scopedBackend, { isWebMode: true });

  // connection_name with two same-name connections (one SSH-backed) → AMBIGUOUS_CONNECTION
  const ambigResult = await (server as any)._registeredTools.dbx_execute_query.handler({
    connection_name: "shared",
    sql: "select 1",
  });
  assert.equal(ambigResult.isError, true);
  assert.match(ambigResult.content[0].text, /AMBIGUOUS_CONNECTION:/);
  assert.match(ambigResult.content[0].text, /pg-direct/);
  assert.match(ambigResult.content[0].text, /pg-ssh/);

  // connection_id routes to the SSH-backed instance and passes its config through
  const result = await (server as any)._registeredTools.dbx_execute_query.handler({
    connection_id: "pg-ssh",
    sql: "select 1",
  });
  assert.equal(result.isError, undefined);
  assert.equal(usedConfigs.length, 1);
  assert.equal(usedConfigs[0].id, "pg-ssh");
  assert.equal(usedConfigs[0].host, "private.local");
  assert.equal(usedConfigs[0].ssh_enabled, true);
});
