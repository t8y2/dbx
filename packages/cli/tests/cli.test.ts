import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Backend, ConnectionConfig, DbxDiagnostics } from "@dbx-app/node-core";
import { runCli } from "../src/cli.js";

const connection: ConnectionConfig = {
  id: "1",
  name: "local",
  db_type: "postgres",
  host: "127.0.0.1",
  port: 5432,
  username: "app",
  password: "secret",
  database: "demo",
  ssh_enabled: false,
  ssl: false,
};

function fakeBackend(overrides: Partial<Backend> = {}): Backend {
  return {
    loadConnections: async () => [connection],
    findConnection: async (name) => (name === "local" ? connection : undefined),
    addConnection: async () => connection,
    removeConnection: async () => true,
    listTables: async () => [{ name: "users", type: "BASE TABLE" }],
    describeTable: async () => [
      {
        name: "id",
        data_type: "integer",
        is_nullable: false,
        column_default: null,
        is_primary_key: true,
        comment: null,
      },
    ],
    executeQuery: async () => ({ columns: ["total"], rows: [{ total: 1 }], row_count: 1 }),
    ...overrides,
  };
}

const diagnostics: DbxDiagnostics = {
  appDataDir: "/tmp/dbx",
  dbPath: "/tmp/dbx/dbx.db",
  dbPathExists: true,
  connectionsTableExists: true,
  connectionRowCount: 2,
  loadConnectionsOk: true,
  loadedConnectionCount: 2,
  bridgePortFile: "/tmp/dbx/mcp-bridge-port",
  bridgePortFileExists: false,
  directQueryTypes: ["postgres", "mysql", "sqlite", "rqlite"],
  bridgeRequiredTypes: ["oracle", "mongodb"],
};

test("lists connections as json", async () => {
  const result = await runCli(["connections", "list", "--json"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    connections: [{ name: "local", type: "postgres", host: "127.0.0.1", port: 5432, database: "demo" }],
  });
});

test("blocks write query by default", async () => {
  const result = await runCli(["query", "local", "update users set name = 'x' where id = 1", "--json"], {
    backend: fakeBackend(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "SQL_BLOCKED");
});

test("runs read query as json", async () => {
  const result = await runCli(["query", "local", "select count(*) as total from users", "--json"], {
    backend: fakeBackend(),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    connection: "local",
    columns: ["total"],
    rows: [{ total: 1 }],
    row_count: 1,
  });
});

test("closes backend resources created by the CLI", async () => {
  let closed = false;
  const result = await runCli(["query", "local", "select count(*) as total from users", "--json"], {
    backendFactory: async () =>
      fakeBackend({
        close: async () => {
          closed = true;
        },
      }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(closed, true);
});

test("closes backend resources created by the CLI after failures", async () => {
  let closed = false;
  const result = await runCli(["query", "local", "select count(*) as total from users", "--json"], {
    backendFactory: async () =>
      fakeBackend({
        executeQuery: async () => {
          throw new Error("boom");
        },
        close: async () => {
          closed = true;
        },
      }),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.message, "boom");
  assert.equal(closed, true);
});

test("does not close caller-provided backend resources", async () => {
  let closed = false;
  const result = await runCli(["query", "local", "select count(*) as total from users", "--json"], {
    backend: fakeBackend({
      close: async () => {
        closed = true;
      },
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(closed, false);
});

test("runs query as csv", async () => {
  const result = await runCli(["query", "local", "select count(*) as total from users", "--format", "csv"], {
    backend: fakeBackend(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "total\n1\n");
});

test("uses json format alias", async () => {
  const result = await runCli(["connections", "list", "--format", "json"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    connections: [{ name: "local", type: "postgres", host: "127.0.0.1", port: 5432, database: "demo" }],
  });
});

test("prints diagnostics as json", async () => {
  const result = await runCli(["doctor", "--json"], {
    backend: fakeBackend(),
    diagnostics: async () => diagnostics,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), diagnostics);
});

test("prints connection-store remediation in doctor output", async () => {
  const result = await runCli(["doctor"], {
    backend: fakeBackend(),
    diagnostics: async () => ({
      ...diagnostics,
      loadConnectionsOk: false,
      loadConnectionsError: "compiled against a different Node.js version",
      loadConnectionsHint: "Rebuild DBX CLI native dependencies with your active Node.js.",
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Connection fix/);
  assert.match(result.stdout, /Rebuild DBX CLI native dependencies/);
});

test("surfaces connection store failures instead of returning an empty list", async () => {
  const result = await runCli(["connections", "list", "--json"], {
    backend: fakeBackend({
      loadConnections: async () => {
        throw Object.assign(new Error("Failed to load DBX connections from /tmp/dbx/dbx.db: NODE_MODULE_VERSION 127 mismatch"), {
          code: "CONNECTION_STORE_ERROR",
        });
      },
    }),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "CONNECTION_STORE_ERROR");
  assert.match(JSON.parse(result.stderr).error.hint, /Rebuild DBX CLI native dependencies/);
});

test("prints capabilities as json", async () => {
  const result = await runCli(["capabilities", "--json"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(result.stdout) as { directQueryTypes: string[]; bridgeRequiredTypes: string[] };
  assert.ok(payload.directQueryTypes.includes("postgres"));
  assert.ok(payload.directQueryTypes.includes("sqlite"));
  assert.ok(payload.directQueryTypes.includes("rqlite"));
  assert.ok(payload.bridgeRequiredTypes.includes("oracle"));
});

test("rejects invalid formats", async () => {
  const result = await runCli(["query", "local", "select 1", "--json", "--format", "xml"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "INVALID_OPTION");
});

test("uses DBX_CONNECTION when query connection is omitted", async () => {
  const result = await runCli(["query", "select count(*) as total from users", "--json"], {
    backend: fakeBackend(),
    env: { DBX_CONNECTION: "local" },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).connection, "local");
});

test("uses DBX_CONNECTION when context connection is omitted", async () => {
  const result = await runCli(["context", "--tables", "users"], {
    backend: fakeBackend(),
    env: { DBX_CONNECTION: "local" },
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Connection: local/);
});

test("passes query limit and timeout to the backend", async () => {
  let received: unknown;
  const result = await runCli(["query", "local", "select * from users", "--limit", "5", "--timeout", "2s", "--json"], {
    backend: fakeBackend({
      executeQuery: async (_config, _sql, options) => {
        received = options;
        return { columns: ["id"], rows: [{ id: 1 }], row_count: 1 };
      },
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(received, { maxRows: 5, timeoutMs: 2000 });
});

test("rejects invalid query limits", async () => {
  const result = await runCli(["query", "local", "select 1", "--limit", "0", "--json"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "INVALID_OPTION");
});

test("rejects invalid query timeouts", async () => {
  const result = await runCli(["query", "local", "select 1", "--timeout", "forever", "--json"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "INVALID_OPTION");
});

test("requires a connection when DBX_CONNECTION is not set", async () => {
  const result = await runCli(["query", "select 1", "--json"], { backend: fakeBackend(), env: {} });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "INVALID_ARGUMENT");
});

test("describes schema as json", async () => {
  const result = await runCli(["schema", "describe", "local", "users", "--json"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).columns[0].name, "id");
});

test("lists schema tables as json", async () => {
  const result = await runCli(["schema", "list", "local", "--schema", "public", "--json"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    connection: "local",
    schema: "public",
    tables: [{ name: "users", type: "BASE TABLE" }],
  });
});

test("builds schema context as prompt-ready text", async () => {
  const result = await runCli(["context", "local", "--tables", "users"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Connection: local/);
  assert.match(result.stdout, /## users/);
  assert.match(result.stdout, /id integer NOT NULL PK/);
});

test("runs SQL from file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbx-cli-"));
  const file = join(dir, "query.sql");
  let executedSql = "";

  try {
    await writeFile(file, "select count(*) as total from users", "utf-8");

    const result = await runCli(["query", "local", "--file", file, "--json"], {
      backend: fakeBackend({
        executeQuery: async (_config, sql) => {
          executedSql = sql;
          return { columns: ["total"], rows: [{ total: 1 }], row_count: 1 };
        },
      }),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(executedSql, "select count(*) as total from users");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("allows non-dangerous writes when explicitly enabled", async () => {
  let executed = false;
  const result = await runCli(["query", "local", "update users set name = 'x' where id = 1", "--allow-writes", "--json"], {
    backend: fakeBackend({
      executeQuery: async () => {
        executed = true;
        return { columns: [], rows: [], row_count: 1 };
      },
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(executed, true);
  assert.equal(JSON.parse(result.stdout).row_count, 1);
});

test("keeps dangerous SQL blocked without allow-dangerous-sql", async () => {
  const result = await runCli(["query", "local", "drop table users", "--allow-writes", "--json"], {
    backend: fakeBackend(),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "SQL_BLOCKED");
});

test("rejects unknown options", async () => {
  const result = await runCli(["connections", "list", "--wat", "--json"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "UNKNOWN_OPTION");
});

test("rejects options with missing values", async () => {
  const result = await runCli(["schema", "list", "local", "--schema", "--json"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "INVALID_OPTION");
});

test("rejects query with both inline SQL and file SQL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbx-cli-"));
  const file = join(dir, "query.sql");

  try {
    await writeFile(file, "select 1", "utf-8");

    const result = await runCli(["query", "local", "select 2", "--file", file, "--json"], { backend: fakeBackend() });

    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_ARGUMENT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("requires allow-writes before allow-dangerous-sql", async () => {
  const result = await runCli(["query", "local", "drop table users", "--allow-dangerous-sql", "--json"], {
    backend: fakeBackend(),
    env: {},
  });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "INVALID_OPTION");
});

test("rejects invalid max-tables values", async () => {
  const result = await runCli(["context", "local", "--max-tables", "nope", "--json"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "INVALID_OPTION");
});

test("prints the package version", async () => {
  const result = await runCli(["--version"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
});

test("rejects unexpected positional arguments", async () => {
  const result = await runCli(["connections", "list", "extra", "--json"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "INVALID_ARGUMENT");
});

test("uses a specific connection-not-found error code", async () => {
  const result = await runCli(["schema", "list", "missing", "--json"], { backend: fakeBackend() });

  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "CONNECTION_NOT_FOUND");
});

test("supports -- to pass SQL that starts with a dash", async () => {
  let executedSql = "";
  const result = await runCli(["query", "local", "--json", "--", "-- comment\nselect 1"], {
    backend: fakeBackend({
      executeQuery: async (_config, sql) => {
        executedSql = sql;
        return { columns: ["total"], rows: [{ total: 1 }], row_count: 1 };
      },
    }),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(executedSql, "-- comment\nselect 1");
});
