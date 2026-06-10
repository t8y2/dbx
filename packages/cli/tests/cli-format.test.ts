import assert from "node:assert/strict";
import { test } from "vitest";
import type { ConnectionConfig } from "@dbx-app/node-core";
import { connectionSummary, csvTable, errorPayload, formatCell, formatErrorMessage, mdTable } from "../src/cli-format.js";

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
  proxy_password: "proxy-secret",
  ssl: false,
};

test("redacts secrets from connection summaries", () => {
  const summary = connectionSummary(connection);

  assert.deepEqual(summary, {
    name: "local",
    type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    database: "demo",
  });
  assert.equal(JSON.stringify(summary).includes("secret"), false);
});

test("formats markdown tables", () => {
  const table = mdTable(["Name", "Type"], [["local", "postgres"]]);

  assert.match(table, /Name/);
  assert.match(table, /postgres/);
});

test("formats database cell values with shared formatter", () => {
  assert.equal(formatCell(null), "NULL");
  assert.equal(formatCell({ ok: true }), '{"ok":true}');
});

test("builds stable error payloads", () => {
  assert.deepEqual(errorPayload("SQL_BLOCKED", "read-only"), {
    error: { code: "SQL_BLOCKED", message: "read-only" },
  });
});

test("adds remediation hints for native SQLite ABI errors", () => {
  assert.deepEqual(errorPayload("CONNECTION_STORE_ERROR", "NODE_MODULE_VERSION 127 mismatch"), {
    error: {
      code: "CONNECTION_STORE_ERROR",
      message: "NODE_MODULE_VERSION 127 mismatch",
      hint: "Rebuild DBX CLI native dependencies with your active Node.js: pnpm rebuild better-sqlite3 keytar --pending, or reinstall the package with the same Node.js version you use to run dbx.",
    },
  });
  assert.match(formatErrorMessage("CONNECTION_STORE_ERROR", "compiled against a different Node.js version"), /Hint: Rebuild/);
});

test("formats csv tables with escaping", () => {
  const csv = csvTable(["name", "note"], [{ name: "Ada", note: 'hello, "dbx"' }]);

  assert.equal(csv, 'name,note\nAda,"hello, ""dbx"""\n');
});
