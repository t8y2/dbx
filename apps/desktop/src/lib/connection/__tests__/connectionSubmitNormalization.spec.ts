import { describe, expect, it } from "vitest";
import { normalizeConnectionIdentityFields, normalizeConnectionScope, normalizeConnectionTimeouts } from "../connectionSubmitNormalization";
import type { ConnectionConfig } from "@/types/database";

function config(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "test",
    name: "Test",
    db_type: "postgres",
    host: "localhost",
    port: 5432,
    username: "user",
    password: "password",
    ...overrides,
  };
}

describe("connection submit normalization", () => {
  it.each(["connection", "database", "table"] as const)("preserves %s badge scope without changing production protection", (scope) => {
    const value = config({ production_badge_scope: scope, is_production: true, production_databases: ["app"] });
    normalizeConnectionScope(value);
    expect(value).toMatchObject({ production_badge_scope: scope, is_production: true, production_databases: ["app"] });
  });

  it("defaults legacy connections to database/schema badges", () => {
    const value = config();
    normalizeConnectionScope(value);
    expect(value.production_badge_scope).toBe("database");
  });

  it("normalizes invalid timeout values and inherited global values", () => {
    const inherited = config({ connect_timeout_inherit: true, query_timeout_inherit: true, idle_timeout_secs: -1, idle_disconnect_secs: -1, keepalive_interval_secs: Number.NaN });
    normalizeConnectionTimeouts(inherited, 12, 34);
    expect(inherited).toMatchObject({ connect_timeout_secs: 12, query_timeout_secs: 34, idle_timeout_secs: 60, idle_disconnect_secs: 0, keepalive_interval_secs: 30 });

    const invalid = config({ query_timeout_secs: Number.NaN, idle_timeout_secs: -1, idle_disconnect_secs: 120, keepalive_interval_secs: -2 });
    normalizeConnectionTimeouts(invalid, 12, 34);
    expect(invalid).toMatchObject({ query_timeout_secs: 60, idle_timeout_secs: 60, idle_disconnect_secs: 120, keepalive_interval_secs: 30 });
  });

  it("defaults auto-disconnect-when-idle to disabled when the field is absent", () => {
    const value = config();
    normalizeConnectionTimeouts(value, 12, 34);
    expect(value.idle_disconnect_secs).toBe(0);
  });

  it("clamps the manual transaction idle timeout and falls back to the default for unset values", () => {
    const unset = config({});
    normalizeConnectionTimeouts(unset, 12, 34);
    expect(unset.manual_transaction_timeout_secs).toBe(300);

    const tooSmall = config({ manual_transaction_timeout_secs: 5 });
    normalizeConnectionTimeouts(tooSmall, 12, 34);
    expect(tooSmall.manual_transaction_timeout_secs).toBe(30);

    const tooLarge = config({ manual_transaction_timeout_secs: 999_999 });
    normalizeConnectionTimeouts(tooLarge, 12, 34);
    expect(tooLarge.manual_transaction_timeout_secs).toBe(86400);

    const custom = config({ manual_transaction_timeout_secs: 1800 });
    normalizeConnectionTimeouts(custom, 12, 34);
    expect(custom.manual_transaction_timeout_secs).toBe(1800);
  });

  it("canonicalizes scope flags and production database names", () => {
    const value = config({ db_type: "postgres", one_time: false, read_only: false, save_password: undefined, production_databases: [" app ", "app", ""] });
    normalizeConnectionScope(value);
    expect(value).toMatchObject({ one_time: undefined, read_only: undefined, save_password: true, production_databases: ["app"] });
  });

  it("trims host, username and database but never the password (#12884)", () => {
    const value = config({ host: "  db.internal  ", username: "  app  ", database: "  appdb  ", password: "  pass  " });
    normalizeConnectionIdentityFields(value);
    expect(value).toMatchObject({ host: "db.internal", username: "app", database: "appdb", password: "  pass  " });
  });

  it("treats a whitespace-only database as unset (#12884)", () => {
    const value = config({ database: "   " });
    normalizeConnectionIdentityFields(value);
    expect(value.database).toBeUndefined();
  });

  it("keeps file-path hosts byte-exact for local-file engines (#12884)", () => {
    for (const dbType of ["sqlite", "duckdb", "access"] as const) {
      const value = config({ db_type: dbType, host: "  /tmp/report.db  ", username: "  user  " });
      normalizeConnectionIdentityFields(value);
      expect(value.host).toBe("  /tmp/report.db  ");
      expect(value.username).toBe("user");
    }
  });

  it("tolerates undefined or omitted username and host without crashing (#13826)", () => {
    const value = config({ host: undefined as any, username: undefined as any, database: undefined });
    normalizeConnectionIdentityFields(value);
    expect(value.host).toBeUndefined();
    expect(value.username).toBeUndefined();
    expect(value.database).toBeUndefined();
  });
});
