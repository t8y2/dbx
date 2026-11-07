import { describe, expect, it } from "vitest";
import { filterDatabaseNamesForConnection, filterSchemaNamesForConnection, isSystemSchemaName, migrateSchemaVisibility, schemaVisibilityNeedsMigration, schemaVisibilityOverrides } from "@/lib/database/visibleDatabases";
import type { ConnectionConfig } from "@/types/database";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";

const names = ["APP", "REPORT", "SYS"];
const system = new Set(["SYS"]);
const oracle: Partial<ConnectionConfig> = { db_type: "oracle", database: "XE", username: "APP" };

function migrate(connection: Partial<ConnectionConfig>, candidates = names) {
  return { ...connection, schema_visibility: migrateSchemaVisibility(connection, "XE", candidates, system) };
}

describe("schema visibility defaults and migration", () => {
  it.each([
    { fields: {}, expected: ["dbo", "sys_business", "db_owner_app"] },
    { fields: { visible_schemas: { app: ["sys"] }, show_system_schemas: true }, expected: ["sys"] },
    { fields: { visible_schemas: { app: [] }, show_system_schemas: true }, expected: [] },
  ])("migrates SQL Server main fields without treating real database filters as Schema choices: $fields", ({ fields, expected }) => {
    const candidates = ["dbo", "sys", "INFORMATION_SCHEMA", "guest", "db_owner", "sys_business", "db_owner_app"];
    const connection = { db_type: "sqlserver" as const, username: "app_user", visible_databases: ["app"], visible_database_patterns: ["archive%"], ...fields };
    const systemNames = new Set(candidates.filter((name) => isSystemSchemaName("sqlserver", name)));
    expect([...systemNames]).toEqual(["sys", "INFORMATION_SCHEMA", "guest", "db_owner"]);
    const schema_visibility = migrateSchemaVisibility(connection, "app", candidates, systemNames);
    expect(filterSchemaNamesForConnection(candidates, { ...connection, schema_visibility }, "app")).toEqual(expected);
    expect(filterDatabaseNamesForConnection(["app", "archive_old", "other", "master"], { ...connection, schema_visibility })).toEqual(["app", "archive_old"]);
  });
  it.each([
    { db_type: "oracle" as const, connection_string: "oracle-service" },
    { db_type: "jdbc" as const, connection_string: "jdbc:oracle:thin:@//localhost:1521/XE" },
  ])("uses the root bucket when database is absent, independently of the object execution owner: $db_type", (target) => {
    const connection = { ...target, schema_visibility: { migrate_legacy: true, databases: { "": { APP: false } } } };
    expect(schemaVisibilityNeedsMigration(connection, "APP")).toBe(false);
    expect(filterSchemaNamesForConnection(["APP", "OTHER", "SYS"], connection, "APP")).toEqual(["OTHER"]);
    const migrated = migrateSchemaVisibility({ ...target, visible_schemas: { "": [] } }, "APP", ["APP", "OTHER", "SYS"], new Set(["SYS"]));
    expect(migrated.databases).toEqual({ "": { APP: false, OTHER: false } });
  });
  it("treats Schema and database names as dictionary keys, including object property names", () => {
    const names = ["__proto__", "constructor", "public"];
    const overrides = schemaVisibilityOverrides(names, [], new Set());
    expect(Object.hasOwn(overrides, "__proto__")).toBe(true);
    const connection = { db_type: "postgres" as const, schema_visibility: { migrate_legacy: false, databases: { app: overrides } } };
    expect(filterSchemaNamesForConnection(names, connection, "app")).toEqual([]);
    expect(filterSchemaNamesForConnection(["constructor"], { ...connection, db_type: "oracle" }, "__proto__", { oracleMaintainedSchemas: new Set(["constructor"]) })).toEqual([]);
    expect(migrateSchemaVisibility({ db_type: "postgres", visible_schemas: {} }, "__proto__", ["public"], new Set()).databases).toEqual(JSON.parse('{"__proto__":{}}'));
  });
  it("does not change physical connection identity when visibility preferences change", () => {
    const connection: ConnectionConfig = { id: "identity", name: "Identity", db_type: "postgres", host: "test.invalid", port: 5432, username: "test", password: "", database: "app" };
    expect(connectionConfigFingerprint({ ...connection, schema_visibility: { migrate_legacy: true, databases: { app: { public: false, pg_catalog: true } } } })).toBe(connectionConfigFingerprint(connection));
  });
  // Upstream main ded5ca5a0a353aaf1f1323dda172c302c02b7b47:
  // visibleDatabases.ts:254-292; no schema_visibility or maintenance-catalog rule.
  it.each([
    { fields: {}, expected: ["APP"], overrides: {} },
    { fields: { show_system_schemas: true }, expected: ["APP", "SYS", "SYSRAC", "CUSTOM_INSTALLER"], overrides: { SYS: true, SYSRAC: true, CUSTOM_INSTALLER: true } },
    { fields: { visible_schemas: { XE: ["SYSRAC", "CUSTOM_INSTALLER"] } }, expected: ["SYSRAC", "CUSTOM_INSTALLER"], overrides: { APP: false, SYSRAC: true, CUSTOM_INSTALLER: true } },
    { fields: { visible_database_patterns: ["SYS%"] }, expected: ["SYS", "SYSRAC"], overrides: { APP: false, SYS: true, SYSRAC: true } },
  ])("migrates main configuration intent separately from corrected system recognition: $fields", ({ fields, expected, overrides }) => {
    const candidates = ["APP", "SYS", "SYSRAC", "CUSTOM_INSTALLER"];
    const maintained = new Set(["SYS", "SYSRAC", "CUSTOM_INSTALLER"]);
    const connection = { ...oracle, ...fields };
    const schema_visibility = migrateSchemaVisibility(connection, "XE", candidates, maintained);
    expect(schema_visibility.databases.XE).toEqual(overrides);
    expect(filterSchemaNamesForConnection(candidates, { ...connection, schema_visibility }, "XE", { oracleMaintainedSchemas: maintained })).toEqual(expected);
  });

  it("distinguishes new, legacy and partially migrated connections after JSON roundtrip", () => {
    expect(schemaVisibilityNeedsMigration(oracle, "XE")).toBe(true);
    const fresh = JSON.parse(JSON.stringify({ db_type: "postgres", schema_visibility: { migrate_legacy: false, databases: {} } }));
    expect(schemaVisibilityNeedsMigration(fresh, "new_database")).toBe(false);
    const partial = JSON.parse(JSON.stringify({ db_type: "postgres", schema_visibility: { migrate_legacy: true, databases: { first: {} } } }));
    expect(schemaVisibilityNeedsMigration(partial, "first")).toBe(false);
    expect(schemaVisibilityNeedsMigration(partial, "second")).toBe(true);
  });

  it("defaults to ordinary visible and system hidden even when the login is SYS", () => {
    const connection = { ...oracle, username: "SYS", schema_visibility: { migrate_legacy: false, databases: {} } };
    expect(filterSchemaNamesForConnection(names, connection, "XE")).toEqual(["APP", "REPORT"]);
    expect(filterSchemaNamesForConnection(["APP", "CUSTOM_SYSTEM"], connection, "XE", { oracleMaintainedSchemas: new Set(["CUSTOM_SYSTEM"]) })).toEqual(["APP"]);
  });

  it("migrates the legacy system-login exception as an explicit override", () => {
    const connection = migrate({ ...oracle, username: "SYS" });
    expect(connection.schema_visibility.databases.XE).toEqual({ SYS: true });
    expect(filterSchemaNamesForConnection(names, connection, "XE")).toEqual(names);
    expect(filterSchemaNamesForConnection([...names, "NEW_APP", "MDSYS"], connection, "XE")).toEqual([...names, "NEW_APP"]);
  });

  it("gives an explicit empty list priority over root filters and the old toggle", () => {
    const connection = migrate({ ...oracle, visible_schemas: { XE: [] }, visible_databases: ["APP"], visible_database_patterns: ["%"], show_system_schemas: true });
    expect(connection.schema_visibility.databases.XE).toEqual({ APP: false, REPORT: false });
    expect(filterSchemaNamesForConnection([...names, "NEW_APP"], connection, "XE")).toEqual(["NEW_APP"]);
  });

  it("preserves unavailable explicit choices and does not widen a zero-match legacy range", () => {
    const connection = migrate({ ...oracle, visible_schemas: { XE: ["UNAVAILABLE"] } });
    expect(connection.schema_visibility.databases.XE).toEqual({ APP: false, REPORT: false, UNAVAILABLE: true });
    expect(filterSchemaNamesForConnection([...names, "UNAVAILABLE", "NEW_APP"], connection, "XE")).toEqual(["UNAVAILABLE", "NEW_APP"]);
  });

  it("migrates root exact names and patterns as a union, but future names use group defaults", () => {
    const connection = migrate({ ...oracle, visible_databases: ["SYS"], visible_database_patterns: ["APP%"] });
    expect(filterSchemaNamesForConnection(names, connection, "XE")).toEqual(["APP", "SYS"]);
    expect(filterSchemaNamesForConnection([...names, "NEW_APP", "SYSBACKUP"], connection, "XE")).toEqual(["APP", "SYS", "NEW_APP"]);
    const zero = migrate({ ...oracle, visible_database_patterns: ["MISSING%"] });
    expect(filterSchemaNamesForConnection(names, zero, "XE")).toEqual([]);
  });

  it("does not interpret real database allowlists as schema filters", () => {
    const connection = migrate({ db_type: "postgres", visible_databases: ["other"], visible_database_patterns: ["other%"] }, ["public", "reporting", "pg_catalog"]);
    expect(filterSchemaNamesForConnection(["public", "reporting", "pg_catalog"], connection, "XE")).toEqual(["public", "reporting"]);
    expect(connection.visible_databases).toEqual(["other"]);
    expect(connection.visible_database_patterns).toEqual(["other%"]);
  });

  it("migrates the old show-system toggle without making future system schemas visible", () => {
    const connection = migrate({ ...oracle, show_system_schemas: true });
    expect(connection.schema_visibility.databases.XE).toEqual({ SYS: true });
    expect(filterSchemaNamesForConnection([...names, "MDSYS"], connection, "XE")).toEqual(names);
  });

  it("retains explicit unavailable names when a successful complete read is empty", () => {
    const connection = migrate({ ...oracle, visible_schemas: { XE: ["LATER"] } }, []);
    expect(connection.schema_visibility.databases.XE).toEqual({ LATER: true });
    expect(filterSchemaNamesForConnection(["NEW_APP", "SYS"], connection, "XE")).toEqual(["NEW_APP"]);
  });

  it("select-all and clear only override current names, retaining unavailable choices", () => {
    const previous = { UNAVAILABLE: false };
    const all = schemaVisibilityOverrides(names, names, system, previous);
    const none = schemaVisibilityOverrides(names, [], system, previous);
    expect(all).toEqual({ UNAVAILABLE: false, SYS: true });
    expect(none).toEqual({ UNAVAILABLE: false, APP: false, REPORT: false });
    for (const overrides of [all, none]) {
      const connection = { ...oracle, schema_visibility: { migrate_legacy: false, databases: { XE: overrides } } };
      expect(filterSchemaNamesForConnection(["NEW_APP", "MDSYS", "UNAVAILABLE"], connection, "XE")).toEqual(["NEW_APP"]);
    }
  });

  it("only initializes the accessed database and normalizes the single-db sentinel", () => {
    const connection: Partial<ConnectionConfig> = { db_type: "postgres", visible_schemas: { "": [], other: ["history"] } };
    const visibility = migrateSchemaVisibility(connection, "_", ["public", "pg_catalog"], new Set(["pg_catalog"]));
    expect(visibility.databases).toEqual({ "": { public: false } });
    expect(schemaVisibilityNeedsMigration({ ...connection, schema_visibility: visibility }, "other")).toBe(true);
    expect(filterSchemaNamesForConnection(["public", "pg_catalog"], { ...connection, schema_visibility: visibility }, "_")).toEqual([]);
  });
});
