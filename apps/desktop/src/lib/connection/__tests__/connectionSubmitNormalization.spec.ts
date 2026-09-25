import { describe, expect, it } from "vitest";
import { normalizeConnectionScope, normalizeConnectionTimeouts } from "../connectionSubmitNormalization";
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
  it("normalizes invalid timeout values and inherited global values", () => {
    const inherited = config({ connect_timeout_inherit: true, query_timeout_inherit: true, idle_timeout_secs: -1, keepalive_interval_secs: Number.NaN });
    normalizeConnectionTimeouts(inherited, 12, 34);
    expect(inherited).toMatchObject({ connect_timeout_secs: 12, query_timeout_secs: 34, idle_timeout_secs: 60, keepalive_interval_secs: 30 });

    const invalid = config({ query_timeout_secs: Number.NaN, idle_timeout_secs: -1, keepalive_interval_secs: -2 });
    normalizeConnectionTimeouts(invalid, 12, 34);
    expect(invalid).toMatchObject({ query_timeout_secs: 60, idle_timeout_secs: 60, keepalive_interval_secs: 30 });
  });

  it("canonicalizes scope flags and production database names", () => {
    const value = config({ db_type: "postgres", one_time: false, read_only: false, save_password: undefined, production_databases: [" app ", "app", ""] });
    normalizeConnectionScope(value);
    expect(value).toMatchObject({ one_time: undefined, read_only: undefined, save_password: true, production_databases: ["app"] });
  });
});
