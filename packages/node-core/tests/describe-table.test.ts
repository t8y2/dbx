import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionConfig } from "../src/connections.js";

const fakeMysqlQuery = vi.fn();
const fakeMysqlEnd = vi.fn().mockResolvedValue(undefined);
const fakePgQuery = vi.fn();
const fakePgEnd = vi.fn().mockResolvedValue(undefined);
const fakePgOn = vi.fn();

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: vi.fn(() => ({
      query: fakeMysqlQuery,
      end: fakeMysqlEnd,
    })),
  },
}));

vi.mock("pg", () => ({
  default: {
    Pool: vi.fn(function MockPool() {
      return {
        query: fakePgQuery,
        end: fakePgEnd,
        on: fakePgOn,
      };
    }),
  },
}));

import { closeDatabaseResources, describeTable } from "../src/database.js";

function mysqlConfig(): ConnectionConfig {
  return {
    id: "mysql-direct-test",
    name: "mysql-direct",
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "secret",
    database: "app",
    ssl: false,
  };
}

function postgresConfig(): ConnectionConfig {
  return {
    id: "postgres-direct-test",
    name: "postgres-direct",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "postgres",
    database: "app",
    ssl: false,
  };
}

const bridgeConfig: ConnectionConfig = {
  id: "pg-bridge",
  name: "bridge-postgres",
  db_type: "postgres",
  host: "127.0.0.1",
  port: 5432,
  username: "postgres",
  password: "postgres",
  database: "postgres",
  ssl: false,
  transport_layers: [
    {
      type: "ssh",
      id: "jump",
      enabled: true,
      host: "bastion.internal",
      port: 22,
      user: "dbx",
    },
  ],
};

afterEach(async () => {
  await closeDatabaseResources();
  fakeMysqlQuery.mockReset();
  fakeMysqlEnd.mockClear();
  fakePgQuery.mockReset();
  fakePgEnd.mockClear();
  fakePgOn.mockClear();
});

test("describeTable maps mysql enum_values from metadata", async () => {
  fakeMysqlQuery.mockResolvedValue([
    [
      {
        name: "state",
        data_type: "enum",
        column_type: "enum('pending','active','archived')",
        is_nullable: 0,
        column_default: "pending",
        is_primary_key: 0,
        comment: "workflow state",
      },
    ],
    [{ name: "name" }],
  ]);

  const columns = await describeTable(mysqlConfig(), "orders");

  assert.match(String(fakeMysqlQuery.mock.calls[0]?.[0] ?? ""), /COLUMN_TYPE AS column_type/);
  assert.deepEqual(fakeMysqlQuery.mock.calls[0]?.[1], ["orders"]);
  assert.deepEqual(columns, [
    {
      name: "state",
      data_type: "enum",
      is_nullable: false,
      column_default: "pending",
      is_primary_key: false,
      comment: "workflow state",
      enum_values: ["pending", "active", "archived"],
    },
  ]);
});

test("describeTable parses mysql enum literal edge cases", async () => {
  fakeMysqlQuery.mockResolvedValue([
    [
      {
        name: "empty_state",
        data_type: "enum",
        column_type: "enum('','a')",
        is_nullable: 1,
        column_default: null,
        is_primary_key: 0,
        comment: null,
      },
      {
        name: "quoted_state",
        data_type: "enum",
        column_type: "enum('x'',''y','z')",
        is_nullable: 1,
        column_default: null,
        is_primary_key: 0,
        comment: null,
      },
      {
        name: "escaped_state",
        data_type: "enum",
        column_type: String.raw`enum('it''s','quote\"d','back\\slash')`,
        is_nullable: 1,
        column_default: null,
        is_primary_key: 0,
        comment: null,
      },
    ],
    [{ name: "name" }],
  ]);

  const columns = await describeTable(mysqlConfig(), "orders");

  assert.deepEqual(
    columns.map((column) => column.enum_values),
    [
      ["", "a"],
      ["x','y", "z"],
      ["it's", 'quote"d', "back\\slash"],
    ],
  );
});

test("describeTable preserves enum values from bridge metadata", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "dbx-node-core-"));
  const previousDataDir = process.env.DBX_DATA_DIR;

  const server = createServer((req, res) => {
    assert.equal(req.url, "/data/describe-table");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        {
          name: "state",
          data_type: "status",
          is_nullable: false,
          column_default: null,
          is_primary_key: false,
          comment: "workflow state",
          enum_values: ["pending", "active", "archived"],
        },
      ]),
    );
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP bridge address");

    process.env.DBX_DATA_DIR = tempDir;
    await writeFile(join(tempDir, "mcp-bridge-port"), String(address.port));

    const columns = await describeTable(bridgeConfig, "orders", "public");

    assert.deepEqual(columns, [
      {
        name: "state",
        data_type: "status",
        is_nullable: false,
        column_default: null,
        is_primary_key: false,
        comment: "workflow state",
        enum_values: ["pending", "active", "archived"],
      },
    ]);
  } finally {
    server.close();
    if (previousDataDir === undefined) {
      delete process.env.DBX_DATA_DIR;
    } else {
      process.env.DBX_DATA_DIR = previousDataDir;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("describeTable reads postgres enum_values from the primary metadata query", async () => {
  fakePgQuery.mockResolvedValueOnce({
    rows: [
      {
        name: "state",
        data_type: "status",
        is_nullable: false,
        column_default: null,
        is_primary_key: false,
        comment: "workflow state",
        enum_values: ["pending", "active", "archived"],
      },
    ],
    fields: [{ name: "name" }],
  });

  const columns = await describeTable(postgresConfig(), "orders", "public");

  assert.match(String(fakePgQuery.mock.calls[0]?.[0] ?? ""), /FROM pg_enum e WHERE e\.enumtypid = enum_t\.oid/);
  assert.equal(fakePgQuery.mock.calls.length, 1);
  assert.deepEqual(columns, [
    {
      name: "state",
      data_type: "status",
      is_nullable: false,
      column_default: null,
      is_primary_key: false,
      comment: "workflow state",
      enum_values: ["pending", "active", "archived"],
    },
  ]);
});

test("describeTable falls back to compat postgres metadata query when enum joins fail", async () => {
  fakePgQuery.mockRejectedValueOnce(new Error("pg_enum catalog unavailable")).mockResolvedValueOnce({
    rows: [
      {
        name: "state",
        data_type: "status",
        is_nullable: false,
        column_default: null,
        is_primary_key: false,
        comment: "workflow state",
        enum_values: null,
      },
    ],
    fields: [{ name: "name" }],
  });

  const columns = await describeTable(postgresConfig(), "orders", "public");

  assert.match(String(fakePgQuery.mock.calls[0]?.[0] ?? ""), /FROM pg_enum e WHERE e\.enumtypid = enum_t\.oid/);
  assert.match(String(fakePgQuery.mock.calls[1]?.[0] ?? ""), /NULL AS enum_values/);
  assert.doesNotMatch(String(fakePgQuery.mock.calls[1]?.[0] ?? ""), /pg_enum/);
  assert.deepEqual(columns, [
    {
      name: "state",
      data_type: "status",
      is_nullable: false,
      column_default: null,
      is_primary_key: false,
      comment: "workflow state",
      enum_values: null,
    },
  ]);
});
