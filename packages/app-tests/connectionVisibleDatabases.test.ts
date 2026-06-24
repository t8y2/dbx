import assert from "node:assert/strict";
import { test } from "vitest";
import { buildDraftVisibleDatabasesConnectionId, connectionCanChooseVisibleDatabases, visibleDatabaseSelectionIsStale, initialVisibleDatabaseSelection } from "../../apps/desktop/src/lib/connectionVisibleDatabases.ts";
import type { ConnectionConfig } from "../../apps/desktop/src/types/database.ts";

function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "conn",
    name: "Local",
    db_type: "mysql",
    driver_profile: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    database: undefined,
    visible_databases: undefined,
    transport_layers: [],
    connect_timeout_secs: 5,
    query_timeout_secs: 30,
    idle_timeout_secs: 60,
    ssl: false,
    ca_cert_path: "",
    client_cert_path: "",
    client_key_path: "",
    sysdba: false,
    jdbc_driver_paths: [],
    redis_sentinel_master: "",
    redis_sentinel_nodes: "",
    redis_sentinel_username: "",
    redis_sentinel_password: "",
    redis_sentinel_tls: false,
    redis_cluster_nodes: "",
    etcd_endpoints: "",
    ...overrides,
  };
}

test("draft visible database connection ids are namespaced", () => {
  assert.equal(buildDraftVisibleDatabasesConnectionId("abc"), "__visible_draft_abc");
});

test("initial selection uses configured visible databases when available", () => {
  assert.deepEqual(initialVisibleDatabaseSelection(["app", "analytics", "billing"], ["billing", "missing"]), ["billing"]);
});

test("initial selection uses default visible database names when no filter is configured", () => {
  assert.deepEqual(initialVisibleDatabaseSelection(["app", "mysql", "sys"], undefined, config()), ["app"]);
});

test("ZooKeeper connections do not offer visible database selection", () => {
  assert.equal(connectionCanChooseVisibleDatabases(config({ db_type: "zookeeper" })), false);
});

test("visible database selection is stale when connection target changes", () => {
  const previous = config({ host: "db.internal", visible_databases: ["app"] });
  assert.equal(visibleDatabaseSelectionIsStale(previous, config({ host: "db.internal" })), false);
  assert.equal(visibleDatabaseSelectionIsStale(previous, config({ host: "db2.internal" })), true);
  assert.equal(visibleDatabaseSelectionIsStale(previous, config({ username: "readonly" })), true);
  assert.equal(visibleDatabaseSelectionIsStale(previous, config({ database: "admin" })), true);
});
