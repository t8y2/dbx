import { describe, expect, it } from "vitest";
import { CONCURRENT_INDEX_QUERY_TIMEOUT_SECS, frontendQueryTimeoutDelayMs, frontendQueryTimeoutSecsForSql, queryTimeoutSecsForConcurrentIndex, queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";

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
});
