import { describe, expect, it } from "vitest";
import { CONCURRENT_INDEX_QUERY_TIMEOUT_SECS, effectiveConnectTimeoutSecs, frontendQueryTimeoutDelayMs, frontendQueryTimeoutSecsForSql, metadataLoadTimeoutMs, queryTimeoutSecsForConcurrentIndex, queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";

describe("queryTimeout", () => {
  it("gives CREATE INDEX CONCURRENTLY a dedicated long budget instead of the 30s default", () => {
    expect(CONCURRENT_INDEX_QUERY_TIMEOUT_SECS).toBe(1800);
    expect(CONCURRENT_INDEX_QUERY_TIMEOUT_SECS).toBeGreaterThan(30);
    expect(frontendQueryTimeoutDelayMs(CONCURRENT_INDEX_QUERY_TIMEOUT_SECS)).toBe(1_800_000);
  });

  it.each([
    ["non-concurrent", 30, false, 30],
    ["non-concurrent", 3600, false, 3600],
    ["concurrent + 0 (unlimited)", 0, true, 0],
    ["concurrent + 30 (below floor)", 30, true, 1800],
    ["concurrent + 600 (below floor)", 600, true, 1800],
    ["concurrent + 1800 (floor)", 1800, true, 1800],
    ["concurrent + 3600 (above floor)", 3600, true, 3600],
  ] as const)("queryTimeoutSecsForConcurrentIndex preserves %s", (_name, configured, concurrent, expected) => {
    expect(queryTimeoutSecsForConcurrentIndex(configured, concurrent)).toBe(expected);
  });
  it("lets PostgreSQL row queries use the backend inactivity timeout", () => {
    expect(frontendQueryTimeoutSecsForSql("SELECT * FROM sample_records LIMIT 2000", "postgres", 30)).toBe(0);
    expect(frontendQueryTimeoutSecsForSql("/* page */\nWITH rows AS (SELECT 1) SELECT * FROM rows", "postgres", 30)).toBe(0);
    expect(frontendQueryTimeoutSecsForSql("UPDATE sample_records SET state = 'ready' RETURNING id", "postgres", 30)).toBe(0);
  });

  it("keeps the frontend guard for non-row PostgreSQL statements", () => {
    expect(frontendQueryTimeoutSecsForSql("UPDATE sample_records SET state = 'ready'", "postgres", 30)).toBe(60);
    expect(frontendQueryTimeoutSecsForSql("INSERT INTO sample_records(note) VALUES ('RETURNING is text')", "postgres", 30)).toBe(60);
    expect(frontendQueryTimeoutSecsForSql("UPDATE sample_records SET note = 'ready' /* RETURNING */", "postgres", 30)).toBe(60);
  });

  it("keeps the existing frontend guard for other database types", () => {
    expect(frontendQueryTimeoutSecsForSql("SELECT * FROM sample_records LIMIT 2000", "mysql", 30)).toBe(60);
    expect(queryTimeoutSecsForConnection({ query_timeout_secs: undefined })).toBe(30);
  });

  it("does not schedule frontend timeouts beyond the browser timer limit", () => {
    expect(frontendQueryTimeoutDelayMs(60)).toBe(60_000);
    expect(frontendQueryTimeoutDelayMs(11_401_200)).toBeUndefined();
    expect(frontendQueryTimeoutDelayMs(0)).toBeUndefined();
  });

  it("uses the global timeout only for inheriting connections", () => {
    expect(queryTimeoutSecsForConnection({ query_timeout_secs: 30, query_timeout_inherit: true }, 12)).toBe(12);
    expect(queryTimeoutSecsForConnection({ query_timeout_secs: 30, query_timeout_inherit: false }, 12)).toBe(30);
    expect(queryTimeoutSecsForConnection({ query_timeout_secs: 0, query_timeout_inherit: false }, 12)).toBe(0);
  });

  it("falls back safely when an inherited global timeout is invalid", () => {
    expect(queryTimeoutSecsForConnection({ query_timeout_inherit: true }, Number.NaN)).toBe(30);
  });

  it("resolves the metadata load deadline from the inherited global query timeout", () => {
    expect(metadataLoadTimeoutMs({ query_timeout_secs: 30, query_timeout_inherit: true }, 120)).toBe(155_000);
    expect(metadataLoadTimeoutMs({ query_timeout_secs: 30, query_timeout_inherit: true })).toBe(65_000);
  });

  it("uses the local query timeout for the metadata load deadline when not inheriting", () => {
    expect(metadataLoadTimeoutMs({ query_timeout_secs: 45, query_timeout_inherit: false }, 120)).toBe(80_000);
  });

  it("uses the 60s backend fallback budget when the query timeout is disabled (0 = unlimited)", () => {
    expect(metadataLoadTimeoutMs({ query_timeout_secs: 0, query_timeout_inherit: false }, 120)).toBe(95_000);
    expect(metadataLoadTimeoutMs({ query_timeout_secs: 30, query_timeout_inherit: true }, 0)).toBe(95_000);
  });

  it("covers the whole backend operation (connect x3 + query + cancel) instead of just the query", () => {
    // Defaults: connect 10s, query 30s -> 3*10 + 30 = 60s query+connect total,
    // plus 2s cancel allowance and 3s transport buffer.
    expect(metadataLoadTimeoutMs(undefined)).toBe(65_000);
    expect(metadataLoadTimeoutMs({})).toBe(65_000);
    // A 45s connect timeout extends the connect phases but not the query.
    expect(metadataLoadTimeoutMs({ connect_timeout_secs: 45, connect_timeout_inherit: false, query_timeout_secs: 30 }, 30, 10)).toBe(170_000);
    // An inherited global connect timeout is honored.
    expect(metadataLoadTimeoutMs({ connect_timeout_inherit: true, query_timeout_secs: 30 }, 30, 45)).toBe(170_000);
  });

  it("floors the metadata load deadline at the minimum and defaults safely", () => {
    expect(metadataLoadTimeoutMs({ query_timeout_secs: 1 }, 120)).toBe(36_000);
    expect(metadataLoadTimeoutMs({ query_timeout_secs: 1, connect_timeout_secs: 1 }, 120, 10)).toBe(36_000);
  });

  it("resolves the effective connect timeout honoring inheritance and the global default", () => {
    expect(effectiveConnectTimeoutSecs({ connect_timeout_secs: undefined })).toBe(10);
    expect(effectiveConnectTimeoutSecs({ connect_timeout_secs: 45 })).toBe(45);
    expect(effectiveConnectTimeoutSecs({ connect_timeout_inherit: true }, 45)).toBe(45);
    expect(effectiveConnectTimeoutSecs({ connect_timeout_inherit: true }, 0)).toBe(10);
    expect(effectiveConnectTimeoutSecs({ connect_timeout_secs: 0 })).toBe(10);
  });
});
