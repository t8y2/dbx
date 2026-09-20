import { describe, expect, it } from "vitest";
import { parseConnectionDeepLinkUpdate } from "@/lib/connection/connectionDeepLink";
import { applyConnectionDeepLinkUpdate, resolveConnectionDeepLinkUpdate } from "@/lib/connection/connectionDeepLinkUpdate";
import type { ConnectionConfig } from "@/types/database";

const saved: ConnectionConfig = {
  id: "saved-id",
  name: "Shared name",
  db_type: "postgres",
  driver_profile: "postgres",
  host: "database.example.test",
  port: 15432,
  username: "old-user",
  password: "old-password",
  database: "orders",
  ssl: true,
  read_only: true,
  is_production: true,
  production_databases: ["orders"],
  visible_databases: ["orders"],
  ca_cert_path: "/certs/custom-ca.pem",
  save_password: false,
  query_timeout_secs: 45,
};

describe("saved connection update links", () => {
  it("selects the exact saved ID, even when another connection has the same name", () => {
    const other = { ...saved, id: "other-id" };
    const update = parseConnectionDeepLinkUpdate("dbx://connection/new?id=saved-id&password=new")!;
    expect(resolveConnectionDeepLinkUpdate(update, [other, saved], false)).toBe(saved);
  });

  it("rejects missing or temporary targets without selecting a same-name fallback", () => {
    const update = parseConnectionDeepLinkUpdate("dbx://connection/new?id=missing&name=Shared+name")!;
    expect(() => resolveConnectionDeepLinkUpdate(update, [saved], false)).toThrow(/not found/);
    expect(() => resolveConnectionDeepLinkUpdate({ ...update, connectionId: saved.id }, [{ ...saved, one_time: true }], false)).toThrow(/saved connection/);
  });

  it("refuses to replace an open editor or creation draft", () => {
    const update = parseConnectionDeepLinkUpdate("dbx://connection/new?id=saved-id&password=new")!;
    expect(() => resolveConnectionDeepLinkUpdate(update, [saved], true)).toThrow(/current connection dialog/);
  });

  it.each([{ db_type: "mongodb", driver_profile: "mongodb" }, { db_type: "mysql", driver_profile: "tidb" }, { connection_string: "postgres://original.example.test/orders" }] as Partial<ConnectionConfig>[])("rejects a target with unsupported configuration %j", (overrides) => {
    const update = parseConnectionDeepLinkUpdate("dbx://connection/new?id=saved-id&password=new")!;
    const config = { ...saved, ...overrides };
    expect(() => resolveConnectionDeepLinkUpdate(update, [config], false)).toThrow(/field-based/);
    expect(() => applyConnectionDeepLinkUpdate(config, update)).toThrow(/field-based/);
  });

  it("patches credentials without changing IDs, endpoint, SSL, policy or unsupplied fields", () => {
    const original = structuredClone(saved);
    const update = parseConnectionDeepLinkUpdate("dbx://connection/new?id=saved-id&user=+new-user+&password=%20token%2B%26%3D%20")!;
    const result = applyConnectionDeepLinkUpdate(Object.freeze(original), update);
    expect(result).toEqual({ ...saved, username: " new-user ", password: " token+&= " });
    expect(original).toEqual(saved);
    expect(result).not.toBe(original);
  });

  it("honors explicit clears and false values without applying create defaults", () => {
    const update = parseConnectionDeepLinkUpdate("dbx://connection/new?id=saved-id&database=&password=&url_params=&ssl=false")!;
    expect(applyConnectionDeepLinkUpdate({ ...saved, url_params: "old-options" }, update)).toEqual({ ...saved, database: "", password: "", url_params: "", ssl: false });
  });

  it("an ID-only link leaves the entire saved configuration intact", () => {
    const update = parseConnectionDeepLinkUpdate("dbx://connection/new?id=saved-id")!;
    expect(applyConnectionDeepLinkUpdate(saved, update)).toEqual(saved);
  });

  it("rejects oversized parameter values while accepting values at the bound", () => {
    expect(parseConnectionDeepLinkUpdate(`dbx://connection/new?id=saved-id&name=${"n".repeat(4096)}`)!.patch.name).toBe("n".repeat(4096));
    for (const key of ["name", "host", "password", "url_params"]) {
      expect(() => parseConnectionDeepLinkUpdate(`dbx://connection/new?id=saved-id&${key}=${"x".repeat(4097)}`)).toThrow(`Connection update ${key} is too long`);
    }
  });

  it("rejects an oversized update URL without rejecting other long deep links", () => {
    expect(() => parseConnectionDeepLinkUpdate(`dbx://connection/new?id=saved-id&url_params=${"k=v&".repeat(5000)}`)).toThrow("Connection update URL is too long");
    expect(parseConnectionDeepLinkUpdate(`dbx://query/open?sql=${"x".repeat(20000)}`)).toBe(null);
  });
});
