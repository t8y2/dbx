import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { applyConnectionEditPrefill, resolveConnectionEditPrefill, type ConnectionEditPrefill } from "@/lib/connection/connectionEditPrefill";
import { pluginConnectionEditFields, requirePluginConnectionEditFields } from "@/lib/connection/pluginConnectionEdit";

const saved: ConnectionConfig = {
  id: "saved-id",
  name: "Reports",
  db_type: "postgres",
  host: "database.example.test",
  port: 5432,
  database: "reports",
  username: "saved-user",
  password: "saved-secret",
  ssl: true,
  read_only: true,
  is_production: true,
};
const displayFields = ["name", "note", "color"];
const networkFields = ["host", "port", "database", "username", "password"];

function fieldsFor(config: Partial<ConnectionConfig>) {
  return pluginConnectionEditFields({ ...saved, ...config }).map(({ key }) => key);
}

describe("plugin connection editing", () => {
  it.each([
    [{ db_type: "mysql", driver_profile: "tidb" }, networkFields],
    [{ db_type: "postgres", driver_profile: "cockroachdb" }, networkFields],
    [{ db_type: "clickhouse" }, networkFields],
    [{ db_type: "mongodb" }, networkFields],
    [{ db_type: "mongodb", connection_string: "mongodb+srv://database.example.test/reports" }, []],
    [{ db_type: "mongodb", url_params: "authMechanism=MONGODB-OIDC" }, []],
    [{ db_type: "redis" }, ["host", "port", "username", "password"]],
    [{ db_type: "redis", redis_connection_mode: "cluster" }, ["username", "password"]],
    [{ db_type: "sqlite" }, []],
    [{ db_type: "jdbc" }, []],
    [{ db_type: "plugin" }, []],
  ] satisfies [Partial<ConnectionConfig>, string[]][])("describes the fields supported by form %j", (config, extraFields) => {
    expect(fieldsFor(config)).toEqual([...displayFields, ...extraFields]);
  });

  it("returns field definitions without saved values", () => {
    const fields = pluginConnectionEditFields(saved);
    expect(fields).toContainEqual({ key: "port", type: "integer", min: 1, max: 65535 });
    expect(fields).toContainEqual({ key: "password", type: "password", maxLength: 4096, allowEmpty: true });
    const data = JSON.stringify(fields);
    for (const privateValue of [saved.host, saved.username, saved.password]) expect(data).not.toContain(privateValue);
  });

  it.each(["localhost", "db.internal", "192.0.2.4", "2001:db8::4", "[2001:db8::4]"])("accepts endpoint host %s", (host) => {
    expect(requirePluginConnectionEditFields({ host })).toEqual({ host });
  });

  it.each([
    { host: "name:5432" },
    { host: "https://db.example.test" },
    { host: "name\\instance" },
    { port: "5432" },
    { port: 1.5 },
    { port: 0 },
    { name: " " },
    { color: "var(--custom)" },
    { password: "__DBX_SAVED_CREDENTIAL__:reference" },
    { id: "change-target" },
    { transport_layers: [] },
    { save_password: true },
    { ["__proto__"]: { read_only: false } },
  ])("rejects invalid or host-owned fields %j", (fields) => {
    expect(() => requirePluginConnectionEditFields(fields)).toThrow();
  });

  it("validates against the actual saved target and rejects a competing editor", () => {
    const draft: ConnectionEditPrefill = { source: "plugin", connectionId: saved.id, patch: { port: 3307 } };
    const sameName = { ...saved, id: "different-id" };
    expect(resolveConnectionEditPrefill(draft, [sameName, saved], false)).toBe(saved);
    expect(() => resolveConnectionEditPrefill(draft, [sameName], false)).toThrow(/not found/);
    expect(() => resolveConnectionEditPrefill(draft, [{ ...saved, one_time: true }], false)).toThrow(/saved connection/);
    expect(() => resolveConnectionEditPrefill(draft, [{ ...saved, db_type: "sqlite" }], false)).toThrow(/unavailable for this connection form/);
    expect(() => resolveConnectionEditPrefill(draft, [saved], true)).toThrow(/current connection dialog/);
  });

  it("keeps stored values and protection flags while applying explicit fields to a detached draft", () => {
    const config = Object.freeze({ ...saved });
    const fields = { note: "", color: "#328A7F", password: " new-secret+& " };
    const draft = applyConnectionEditPrefill(config, { source: "plugin", connectionId: config.id, patch: requirePluginConnectionEditFields(fields) });
    expect(draft).toEqual({ ...saved, ...fields });
    expect(config).toEqual(saved);
  });

  it("replaces a SQL Server port embedded in an older saved hostname", () => {
    const legacy: ConnectionConfig = { ...saved, db_type: "sqlserver", host: "node.example.test,1444", port: 1433, external_config: { legacy: true, port_explicit: false } };
    const result = applyConnectionEditPrefill(legacy, { source: "plugin", connectionId: legacy.id, patch: { port: 1555 } });
    expect(result).toMatchObject({ host: "node.example.test", port: 1555, external_config: { legacy: true, portExplicit: true } });
    expect(legacy.host).toBe("node.example.test,1444");
  });
});
