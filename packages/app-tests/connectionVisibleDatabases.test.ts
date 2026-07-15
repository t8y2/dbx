import assert from "node:assert/strict";
import { test } from "vitest";
import { appendVisibleDatabaseSelection, buildDraftVisibleDatabasesConnectionId, connectionCanChooseVisibleDatabases, visibleDatabaseSelectionIsStale, initialVisibleDatabaseSelection } from "../../apps/desktop/src/lib/connection/connectionVisibleDatabases.ts";
import { connectionUsesVisibleSchemaFilter, filterDatabaseNamesForConnection, filterDatabaseNamesForVisiblePicker, filterSchemaNamesForConnection, normalizeVisibleSchemaSelection } from "../../apps/desktop/src/lib/database/visibleDatabases.ts";
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

test("visible database picker ignores saved filters while keeping default system database hiding", () => {
  const databaseNames = ["app", "analytics", "mysql", "sys"];
  const connection = config({ visible_databases: ["app"] });
  assert.deepEqual(filterDatabaseNamesForVisiblePicker(databaseNames, connection), ["app", "analytics"]);
  assert.deepEqual(initialVisibleDatabaseSelection(databaseNames, connection.visible_databases, connection), ["app"]);
});

test("Redis visible database picker keeps every database and initial selection uses saved filters", () => {
  const databaseNames = ["0", "1", "2"];
  const connection = config({ db_type: "redis", driver_profile: "redis", visible_databases: ["0"] });
  assert.deepEqual(filterDatabaseNamesForVisiblePicker(databaseNames, connection), ["0", "1", "2"]);
  assert.deepEqual(initialVisibleDatabaseSelection(databaseNames, connection.visible_databases, connection), ["0"]);
});

test("connection database filtering still applies saved visible database filters for sidebar display", () => {
  assert.deepEqual(filterDatabaseNamesForConnection(["app", "analytics", "mysql", "sys"], config({ visible_databases: ["app"] })), ["app"]);
});

test("append visible database selection only when filter is enabled", () => {
  assert.deepEqual(appendVisibleDatabaseSelection(["app"], "analytics"), ["app", "analytics"]);
  assert.deepEqual(appendVisibleDatabaseSelection(["app", "analytics"], "analytics"), ["app", "analytics"]);
  assert.equal(appendVisibleDatabaseSelection(undefined, "analytics"), undefined);
});

test("append visible database selection trims new database names and ignores empty names", () => {
  assert.deepEqual(appendVisibleDatabaseSelection(["app"], " analytics "), ["app", "analytics"]);
  assert.deepEqual(appendVisibleDatabaseSelection(["app"], "   "), ["app"]);
});

test("ZooKeeper connections do not offer visible database selection", () => {
  assert.equal(connectionCanChooseVisibleDatabases(config({ db_type: "zookeeper" })), false);
});

test("Cloudflare D1 does not offer a visible database filter for its fixed main namespace", () => {
  assert.equal(connectionCanChooseVisibleDatabases(config({ db_type: "cloudflare-d1" })), false);
});

test("Turso does not offer a visible database filter for its fixed main namespace", () => {
  assert.equal(connectionCanChooseVisibleDatabases(config({ db_type: "turso" })), false);
});

test("OceanBase Oracle uses schema filtering for visible object selection", () => {
  assert.equal(connectionUsesVisibleSchemaFilter(config({ db_type: "oceanbase-oracle" })), true);
  assert.equal(connectionUsesVisibleSchemaFilter(config({ db_type: "mysql", driver_profile: "oceanbase" })), false);
});

test("Vastbase schema filters preserve ordinary schemas and explicit empty selections", () => {
  const schemas = ["public", "app"];
  assert.deepEqual(filterSchemaNamesForConnection(schemas, config({ db_type: "vastbase", database: "vastbase" }), "vastbase"), schemas);
  assert.deepEqual(filterSchemaNamesForConnection(schemas, config({ db_type: "vastbase", database: "vastbase", visible_schemas: { vastbase: [] } }), "vastbase"), []);
  assert.deepEqual(normalizeVisibleSchemaSelection([], schemas), []);
  assert.deepEqual(normalizeVisibleSchemaSelection(["app", "missing", "app", "public"], schemas), ["app", "public"]);
});

test("Dameng default SYSDBA user remains selectable", () => {
  assert.deepEqual(filterDatabaseNamesForConnection(["SYS", "SYSDBA", "SYSAUDITOR"], config({ db_type: "dameng" })), ["SYSDBA"]);
});

test("visible database selection is stale when connection target changes", () => {
  const previous = config({ host: "db.internal", visible_databases: ["app"] });
  assert.equal(visibleDatabaseSelectionIsStale(previous, config({ host: "db.internal" })), false);
  assert.equal(visibleDatabaseSelectionIsStale(previous, config({ host: "db2.internal" })), true);
  assert.equal(visibleDatabaseSelectionIsStale(previous, config({ username: "readonly" })), true);
  assert.equal(visibleDatabaseSelectionIsStale(previous, config({ database: "admin" })), true);
});
