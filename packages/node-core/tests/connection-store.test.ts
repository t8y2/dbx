import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { inspectConnectionStore, loadConnections } from "../src/connections.js";

test("connection store diagnostics report rows even when loading fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbx-store-"));
  const path = join(dir, "dbx.db");

  try {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE connections (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
      CREATE TABLE connection_secrets (connection_id TEXT, key TEXT, secret TEXT);
    `);
    db.prepare("INSERT INTO connections (id, config_json) VALUES (?, ?)").run("broken", "{not json");
    db.close();

    await assert.rejects(() => loadConnections({ path }), /Failed to load DBX connections/);

    const diagnostics = await inspectConnectionStore({ path });
    assert.equal(diagnostics.dbPath, path);
    assert.equal(diagnostics.dbPathExists, true);
    assert.equal(diagnostics.connectionsTableExists, true);
    assert.equal(diagnostics.connectionRowCount, 1);
    assert.equal(diagnostics.loadConnectionsOk, false);
    assert.match(diagnostics.loadConnectionsError ?? "", /Failed to load DBX connections/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing connection store is treated as an empty store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dbx-store-"));
  const path = join(dir, "missing.db");

  try {
    assert.deepEqual(await loadConnections({ path }), []);

    const diagnostics = await inspectConnectionStore({ path });
    assert.equal(diagnostics.dbPathExists, false);
    assert.equal(diagnostics.connectionsTableExists, false);
    assert.equal(diagnostics.connectionRowCount, 0);
    assert.equal(diagnostics.loadConnectionsOk, true);
    assert.equal(diagnostics.loadedConnectionCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
