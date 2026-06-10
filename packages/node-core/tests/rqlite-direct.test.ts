import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "vitest";
import type { ConnectionConfig } from "../src/connections.js";
import { describeTable, executeQuery, listTables } from "../src/database.js";

function rqliteConfig(port: number): ConnectionConfig {
  return {
    id: "rqlite-test",
    name: "local-rqlite",
    db_type: "rqlite",
    host: "127.0.0.1",
    port,
    username: "dbx",
    password: "secret",
    database: "main",
    ssh_enabled: false,
    ssl: false,
  };
}

async function withRqliteServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function json(res: ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("executes rqlite query through the HTTP API", async () => {
  const server = await withRqliteServer((req, res, body) => {
    assert.equal(req.url, "/db/query");
    assert.equal(req.headers.authorization, "Basic ZGJ4OnNlY3JldA==");
    assert.deepEqual(JSON.parse(body), ["select id, name from users"]);
    json(res, {
      results: [
        {
          columns: ["id", "name"],
          values: [
            [1, "Ada"],
            [2, "Linus"],
          ],
        },
      ],
    });
  });

  try {
    const result = await executeQuery(rqliteConfig(server.port), "select id, name from users", { maxRows: 1 });
    assert.deepEqual(result, { columns: ["id", "name"], rows: [{ id: 1, name: "Ada" }], row_count: 1 });
  } finally {
    await server.close();
  }
});

test("lists rqlite tables and describes columns", async () => {
  const server = await withRqliteServer((_req, res, body) => {
    const sql = JSON.parse(body)[0] as string;
    if (sql.includes("sqlite_master")) {
      json(res, {
        results: [
          {
            columns: ["name", "type"],
            values: [
              ["users", "table"],
              ["active_users", "view"],
            ],
          },
        ],
      });
      return;
    }
    if (sql.includes("PRAGMA table_info")) {
      json(res, {
        results: [
          {
            columns: ["cid", "name", "type", "notnull", "dflt_value", "pk"],
            values: [
              [0, "id", "INTEGER", 1, null, 1],
              [1, "name", "TEXT", 0, "'unknown'", 0],
            ],
          },
        ],
      });
      return;
    }
    json(res, { results: [{ columns: [], values: [] }] });
  });

  try {
    assert.deepEqual(await listTables(rqliteConfig(server.port)), [
      { name: "users", type: "table" },
      { name: "active_users", type: "view" },
    ]);
    assert.deepEqual(await describeTable(rqliteConfig(server.port), "users"), [
      {
        name: "id",
        data_type: "INTEGER",
        is_nullable: false,
        column_default: null,
        is_primary_key: true,
        comment: null,
      },
      {
        name: "name",
        data_type: "TEXT",
        is_nullable: true,
        column_default: "'unknown'",
        is_primary_key: false,
        comment: null,
      },
    ]);
  } finally {
    await server.close();
  }
});
