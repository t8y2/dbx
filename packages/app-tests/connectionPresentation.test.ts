import { test } from "vitest";
import assert from "node:assert/strict";
import type { ConnectionConfig } from "../../apps/desktop/src/types/database.ts";
import { connectionDriverLabel, connectionEndpointLabel, connectionIconType, connectionOptionSubtitle, connectionRedactedEndpointLabel, connectionRedactedNameLabel, connectionRedactedOptionSubtitle } from "../../apps/desktop/src/lib/connectionPresentation.ts";

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

  const accessConnection: ConnectionConfig = {
    ...baseConnection,
    db_type: "access",
    driver_profile: "access",
    driver_label: "Microsoft Access",
    host: "/tmp/Northwind.accdb",
    port: 0,
  };

  assert.equal(connectionOptionSubtitle(accessConnection), "Microsoft Access · /tmp/Northwind.accdb");
});

test("redacts network endpoint labels for quick connection cards", () => {
  assert.equal(
    connectionRedactedEndpointLabel({
      ...baseConnection,
      host: "192.168.1.100",
      port: 3306,
    }),
    "192.***.***.100:****",
  );
  assert.equal(
    connectionRedactedOptionSubtitle({
      ...baseConnection,
      host: "db.prod.example.com",
      port: 5432,
    }),
    "TiDB · db.***.***.com:****",
  );
  assert.equal(
    connectionRedactedEndpointLabel({
      ...baseConnection,
      host: "2001:db8:85a3::8a2e:370:7334",
      port: 5432,
    }),
    "[2001:***:***:***:***:7334]:****",
  );
});

test("redacts host-like quick connection names", () => {
  assert.equal(
    connectionRedactedNameLabel({
      ...baseConnection,
      name: "db.prod.example.com",
      host: "db.prod.example.com",
      port: 5432,
    }),
    "db.***.***.com:****",
  );
  assert.equal(
    connectionRedactedNameLabel({
      ...baseConnection,
      name: "[2001:db8:85a3::8a2e:370:7334]:5432",
      host: "2001:db8:85a3::8a2e:370:7334",
      port: 5432,
    }),
    "[2001:***:***:***:***:7334]:****",
  );
});

test("keeps friendly quick connection names readable", () => {
  assert.equal(
    connectionRedactedNameLabel({
      ...baseConnection,
      name: "Production Analytics",
      host: "db.prod.example.com",
      port: 5432,
    }),
    "Production Analytics",
  );
});

test("keeps local file database endpoint labels readable when redacting", () => {
  const sqliteConnection: ConnectionConfig = {
    ...baseConnection,
    db_type: "sqlite",
    driver_profile: "sqlite",
    driver_label: "SQLite",
    host: "/tmp/local.db",
    port: 0,
  };

  assert.equal(connectionRedactedOptionSubtitle(sqliteConnection), "SQLite · /tmp/local.db");
});
