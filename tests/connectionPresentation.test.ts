import test from "node:test";
import assert from "node:assert/strict";
import type { ConnectionConfig } from "../src/types/database.ts";
import { connectionDriverLabel, connectionEndpointLabel, connectionIconType, connectionOptionSubtitle } from "../src/lib/connectionPresentation.ts";

const baseConnection: ConnectionConfig = {
  id: "conn-1",
  name: "localhost",
  db_type: "mysql",
  driver_profile: "tidb",
  driver_label: "TiDB",
  host: "127.0.0.1",
  port: 4000,
  username: "root",
  password: "",
  database: "test",
};

test("uses driver profile for connection option icon identity", () => {
  assert.equal(connectionIconType(baseConnection), "tidb");
});

test("builds a compact subtitle for duplicate connection names", () => {
  assert.equal(connectionDriverLabel(baseConnection), "TiDB");
  assert.equal(connectionEndpointLabel(baseConnection), "127.0.0.1:4000");
  assert.equal(connectionOptionSubtitle(baseConnection), "TiDB · 127.0.0.1:4000");
});

test("uses file path as endpoint for local database connections", () => {
  const sqliteConnection: ConnectionConfig = {
    ...baseConnection,
    db_type: "sqlite",
    driver_profile: "sqlite",
    driver_label: "SQLite",
    host: "/tmp/local.db",
    port: 0,
  };

  assert.equal(connectionOptionSubtitle(sqliteConnection), "SQLite · /tmp/local.db");
});
