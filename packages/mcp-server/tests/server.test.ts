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

test("mongodb list tables returns collections from the selected database", async () => {
  let usedDatabase = "";
  const mongoConnection: ConnectionConfig = { ...connection, db_type: "mongodb", database: "admin" };
  const scopedBackend: Backend = {
    ...backend,
    findConnection: async () => mongoConnection,
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
    findConnection: async () => mongoConnection,
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

test("mongodb execute query formats shell-style find results", async () => {
  const mongoConnection: ConnectionConfig = { ...connection, db_type: "mongodb" };
  const scopedBackend: Backend = {
    ...backend,
    findConnection: async () => mongoConnection,
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
    findConnection: async () => undefined,
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
  const oldHome = process.env.HOME;
  const dir = await mkdtemp(join(tmpdir(), "dbx-mcp-home-"));
  process.env.HOME = dir;

  try {
    const server = createDbxMcpServer(backend, { isWebMode: false });
    const result = await (server as any)._registeredTools.dbx_open_table.handler({
      connection_name: "local",
      table: "users",
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /DBX_NOT_RUNNING:/);
    assert.match(result.content[0].text, /DBX is not running/);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
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
    findConnection: async () => mongoConnection,
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
