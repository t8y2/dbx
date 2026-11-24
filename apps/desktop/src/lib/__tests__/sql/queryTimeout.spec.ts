import { describe, expect, it } from "vitest";
import {
  CONCURRENT_INDEX_QUERY_TIMEOUT_SECS,
  DEFAULT_WRITE_TIMEOUT_SECS,
  frontendDeadlineForConnection,
  frontendDeadlineForStatement,
  frontendQueryTimeoutDelayMs,
  frontendQueryTimeoutSecsForSql,
  normalizeWriteTimeoutSecs,
  queryTimeoutSecsForConcurrentIndex,
  queryTimeoutSecsForConnection,
  statementOutlivesReadTimeoutBudget,
  statementScopeForSql,
  writeTimeoutSecsForConnection,
} from "@/lib/sql/queryTimeout";

describe("queryTimeout", () => {
  it("gives CREATE INDEX CONCURRENTLY a dedicated long budget instead of the 60s default", () => {
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

  it("uses conservative package splitting for an unresolved openGauss mode", () => {
    const packageSpec = `CREATE OR REPLACE PACKAGE pkg_utils AS
  FUNCTION get_version RETURN VARCHAR2;
END pkg_utils;`;
    // The package body is DDL, so it now runs without a read deadline.
    expect(frontendQueryTimeoutSecsForSql(`${packageSpec}\n/\nSELECT 1;`, "opengauss", 30)).toBe(0);
    expect(statementOutlivesReadTimeoutBudget(`${packageSpec}\n/\nSELECT 1;`, "opengauss")).toBe(true);
  });

  it("never puts a read deadline on DDL or writes", () => {
    expect(frontendQueryTimeoutSecsForSql("UPDATE sample_records SET state = 'ready'", "postgres", 30)).toBe(0);
    expect(frontendQueryTimeoutSecsForSql("INSERT INTO sample_records(note) VALUES ('RETURNING is text')", "postgres", 30)).toBe(0);
    expect(frontendQueryTimeoutSecsForSql("UPDATE sample_records SET note = 'ready' /* RETURNING */", "postgres", 30)).toBe(0);
  });

  it("classifies schema changes, writes and reads", () => {
    expect(statementScopeForSql("SELECT 1", "mysql")).toBe("read");
    expect(statementScopeForSql("/* c */ INSERT INTO t VALUES (1)", "mysql")).toBe("write");
    expect(statementScopeForSql("ALTER TABLE t ADD COLUMN c INT", "mysql")).toBe("schema-change");
    expect(statementScopeForSql("-- migration\nTRUNCATE TABLE t", "mysql")).toBe("schema-change");
    expect(statementOutlivesReadTimeoutBudget("SELECT 1; CREATE TABLE t (id INT)", "mysql")).toBe(true);
    expect(statementOutlivesReadTimeoutBudget("SELECT 1", "mysql")).toBe(false);
  });

  it("recognises production partition DDL without a parser", () => {
    const createPartitioned = `CREATE TABLE events_2024 (
  id BIGINT NOT NULL,
  created_at DATETIME NOT NULL
) PARTITION BY RANGE (TO_DAYS(created_at)) (
  PARTITION p0 VALUES LESS THAN (TO_DAYS('2024-02-01'))
);`;
    expect(statementScopeForSql(createPartitioned, "mysql")).toBe("schema-change");
    expect(statementScopeForSql("ALTER TABLE events ADD PARTITION (PARTITION p3 VALUES LESS THAN (MAXVALUE))", "mysql")).toBe("schema-change");
  });

  it("never puts a deadline on schema changes, even with a write limit", () => {
    expect(frontendDeadlineForStatement("CREATE TABLE t (id INT)", "mysql", 60, 0)).toEqual({ afterSecs: 0, cancelOnTimeout: false });
    expect(frontendDeadlineForStatement("ALTER TABLE t ADD PARTITION (PARTITION p9 VALUES LESS THAN (10))", "mysql", 60, 5)).toEqual({
      afterSecs: 0,
      cancelOnTimeout: false,
    });
  });

  it("leaves writes unbounded by default and never cancels them", () => {
    expect(frontendDeadlineForStatement("INSERT INTO t SELECT * FROM s", "mysql", 60, 0)).toEqual({ afterSecs: 0, cancelOnTimeout: false });
    expect(frontendDeadlineForStatement("INSERT INTO t SELECT * FROM s", "mysql", 60, 5)).toEqual({ afterSecs: 5, cancelOnTimeout: false });
  });

  it.each([
    ["WITH x AS (SELECT 1 AS id) UPDATE items SET n = 1 FROM x WHERE items.id = x.id", "postgres"],
    ["EXPLAIN ANALYZE UPDATE items SET n = 1", "postgres"],
    ["SELECT id INTO new_items FROM items", "sqlserver"],
    ["BEGIN TRANSACTION; UPDATE items SET n = 1; COMMIT;", "sqlserver"],
    ["SELECT 1\nGO\nUPDATE items SET n = 1", "sqlserver"],
    ["WAITFOR (RECEIVE TOP(1) * FROM queue), TIMEOUT 2000", "sqlserver"],
  ] as const)("never cancels a hidden write: %s", (sql, dbType) => {
    expect(frontendDeadlineForStatement(sql, dbType, 1, 5)).toEqual({ afterSecs: 5, cancelOnTimeout: false });
  });

  it("applies the read deadline to a SQL Server delay followed by a read", () => {
    expect(frontendDeadlineForStatement("WAITFOR DELAY '00:00:02'; SELECT 1", "sqlserver", 1, 5).cancelOnTimeout).toBe(true);
  });

  it("retains per-statement batch budgets and PostgreSQL backend-owned row timeouts", () => {
    expect(frontendDeadlineForStatement("SELECT SLEEP(0.75); SELECT SLEEP(0.75)", "mysql", 1, 5)).toEqual({ afterSecs: 2, cancelOnTimeout: true });
    expect(frontendDeadlineForStatement("SELECT * FROM generate_series(1,1000)", "postgres", 1, 5)).toEqual({ afterSecs: 0, cancelOnTimeout: false });
  });

  it.each([
    ["", 0],
    [-1, 0],
    [Number.NaN, 0],
    [1.5, 2],
    [9999, 3600],
  ])("normalizes a write timeout of %s to %s", (value, expected) => {
    expect(normalizeWriteTimeoutSecs(value)).toBe(expected);
  });

  it("keeps the cancellable read deadline", () => {
    expect(frontendDeadlineForStatement("SELECT * FROM t", "mysql", 60, 5)).toEqual({ afterSecs: 60, cancelOnTimeout: true });
    expect(frontendDeadlineForStatement("SELECT SLEEP(30)", "mysql", 0, 5)).toEqual({ afterSecs: 0, cancelOnTimeout: false });
  });

  it("reads the write limit from the connection settings", () => {
    expect(writeTimeoutSecsForConnection({ write_timeout_secs: undefined })).toBe(DEFAULT_WRITE_TIMEOUT_SECS);
    expect(writeTimeoutSecsForConnection({ write_timeout_secs: 15 })).toBe(15);
    expect(writeTimeoutSecsForConnection({ write_timeout_secs: -1 })).toBe(DEFAULT_WRITE_TIMEOUT_SECS);
  });

  it("derives the deadline from a connection", () => {
    expect(frontendDeadlineForConnection("SELECT 1", "mysql", { query_timeout_secs: 45, write_timeout_secs: 0 }, 60)).toEqual({
      afterSecs: 45,
      cancelOnTimeout: true,
    });
    expect(frontendDeadlineForConnection("INSERT INTO t VALUES (1)", "mysql", { query_timeout_secs: 45, write_timeout_secs: 10 }, 60)).toEqual({
      afterSecs: 10,
      cancelOnTimeout: false,
    });
    expect(frontendDeadlineForConnection("DROP TABLE t", "mysql", { query_timeout_secs: 45, write_timeout_secs: 10 }, 60)).toEqual({
      afterSecs: 0,
      cancelOnTimeout: false,
    });
  });

  it("keeps the existing frontend guard for other database types", () => {
    expect(frontendQueryTimeoutSecsForSql("SELECT * FROM sample_records LIMIT 2000", "mysql", 30)).toBe(30);
    expect(frontendQueryTimeoutSecsForSql("SELECT SLEEP(30)", "mysql", 10)).toBe(10);
    expect(queryTimeoutSecsForConnection({ query_timeout_secs: undefined })).toBe(60);
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
    expect(queryTimeoutSecsForConnection({ query_timeout_inherit: true }, Number.NaN)).toBe(60);
  });
});
