import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import {
  buildCreateSqlServerTraceSessionSql,
  buildDropSqlServerTraceSessionSql,
  buildCleanupSqlServerTraceSessionsSql,
  buildListSqlServerTraceSessionsSql,
  buildReadSqlServerTraceEventsSql,
  buildSqlServerTraceCapabilitiesSql,
  buildSqlServerTraceSessionName,
  missingSqlServerTraceCapabilities,
  normalizeSqlServerTraceDurationMinutes,
  normalizeSqlServerTraceMaxEvents,
  mergeSqlServerTraceEventSnapshot,
  parseSqlServerTraceCapabilities,
  parseSqlServerTraceEvents,
  sqlServerTraceCapabilityProblem,
  sqlServerTraceSessionExpiresAt,
  sqlServerTraceEventsToCsv,
  staleSqlServerTraceSessionNames,
} from "../sqlServerActivityTrace";

function result(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 0 };
}

describe("SQL Server activity trace", () => {
  it("builds bounded, database-scoped XE sessions", () => {
    const sql = buildCreateSqlServerTraceSessionSql({
      sessionName: "DBX_TRACE_ABC_123",
      databaseId: 7,
      maxEvents: 99_999,
      includeStatements: true,
    });
    expect(sql).toContain("ADD EVENT sqlserver.rpc_completed");
    expect(sql).toContain("ADD EVENT sqlserver.sql_batch_completed");
    expect(sql).toContain("ADD EVENT sqlserver.sp_statement_completed");
    expect(sql).toContain("[sqlserver].[database_id]=(7)");
    expect(sql).toContain("like_i_sql_unicode_string");
    expect(sql).toContain("max_events_limit=(256)");
    expect(sql).toContain("STARTUP_STATE=OFF");
  });

  it("rejects unsafe session names and escapes database literals", () => {
    expect(() => buildReadSqlServerTraceEventsSql("DBX_TRACE_X]; DROP TABLE x;--")).toThrow(/Invalid/);
    expect(() => buildDropSqlServerTraceSessionSql("other_session")).toThrow(/Invalid/);
    expect(buildSqlServerTraceCapabilitiesSql("db'o")).toContain("DB_ID(N'db''o')");
  });

  it("normalizes resource limits and generates safe names", () => {
    expect(normalizeSqlServerTraceMaxEvents(1)).toBe(100);
    expect(normalizeSqlServerTraceMaxEvents(9000)).toBe(5000);
    expect(normalizeSqlServerTraceDurationMinutes(0)).toBe(1);
    expect(normalizeSqlServerTraceDurationMinutes(99)).toBe(60);
    expect(buildSqlServerTraceSessionName(123456789, 0.25)).toMatch(/^DBX_TRACE_[A-Z0-9]+_[A-Z0-9]{8}$/);
    expect(sqlServerTraceSessionExpiresAt(buildSqlServerTraceSessionName(123456789, 0.25))).toBe(123456789);
  });

  it("identifies only expired DBX sessions for cleanup", () => {
    const now = Date.UTC(2026, 7, 12, 12);
    const oldName = buildSqlServerTraceSessionName(now - 1, 0.1);
    const activeName = buildSqlServerTraceSessionName(now + 10 * 60_000, 0.2);
    const stale = staleSqlServerTraceSessionNames(result(["name"], [[oldName], [activeName], ["OTHER_TRACE"]]), now);
    expect(stale).toEqual([oldName]);
    expect(buildListSqlServerTraceSessionsSql()).toContain("DBX_TRACE_%");
    const cleanup = buildCleanupSqlServerTraceSessionsSql(stale);
    expect(cleanup).toContain(`ALTER EVENT SESSION [${oldName}]`);
    expect(cleanup).toContain(`DROP EVENT SESSION [${oldName}]`);
    expect(cleanup).not.toContain(activeName);
  });

  it("parses capabilities and applies version-specific permission rules", () => {
    const capabilities = parseSqlServerTraceCapabilities(
      result(
        [
          "product_version",
          "engine_edition",
          "database_id",
          "can_alter_event_session",
          "can_view_server_state",
          "can_view_server_performance_state",
          "has_rpc_completed_event",
          "has_sql_batch_completed_event",
          "has_sp_statement_completed_event",
          "has_ring_buffer_target",
          "has_database_id_predicate",
          "has_like_predicate",
          "available_actions",
        ],
        [["16.0.4225.2", 3, 5, 1, 1, 1, 1, 1, 1, 1, 1, 1, "client_app_name,client_hostname,database_id,database_name,server_principal_name,session_id,sql_text"]],
      ),
    );
    expect(capabilities.majorVersion).toBe(16);
    expect(sqlServerTraceCapabilityProblem(capabilities)).toBeNull();
    expect(sqlServerTraceCapabilityProblem({ ...capabilities, canViewServerPerformanceState: false })).toBe("view-permission");
    expect(sqlServerTraceCapabilityProblem({ ...capabilities, engineEdition: 5 })).toBe("unsupported-engine");
    expect(sqlServerTraceCapabilityProblem({ ...capabilities, engineEdition: 11 })).toBe("unsupported-engine");
    expect(sqlServerTraceCapabilityProblem({ ...capabilities, hasRingBufferTarget: false })).toBe("missing-capability");
    expect(missingSqlServerTraceCapabilities({ ...capabilities, hasRingBufferTarget: false }, false)).toEqual(["package0.ring_buffer"]);
    expect(sqlServerTraceCapabilityProblem({ ...capabilities, hasSpStatementCompletedEvent: false }, false)).toBeNull();
    expect(sqlServerTraceCapabilityProblem({ ...capabilities, hasSpStatementCompletedEvent: false }, true)).toBe("missing-capability");
  });

  it("bounds each ring-buffer parse and reads incrementally from the timestamp cursor", () => {
    const sql = buildReadSqlServerTraceEventsSql("DBX_TRACE_ABC_123", "2026-08-12T13:23:45.0840000");
    expect(sql).toContain("SELECT TOP (256) *");
    expect(sql).toContain("event_time_utc >= CONVERT(datetime2(7), N'2026-08-12T13:23:45.0840000', 126)");
    expect(sql).toContain("ORDER BY event_time_utc DESC");
  });

  it("maps XE rows by column name, converts microseconds and removes internal events", () => {
    const events = parseSqlServerTraceEvents(
      result(
        ["event_name", "event_time_utc", "database_name", "sql_text", "duration_us", "cpu_time_us", "logical_reads", "writes", "row_count", "session_id", "login_name", "host_name", "client_app", "result_text"],
        [
          ["sql_batch_completed", "2026-08-12 13:23:45.084", "demo", "SELECT 1", 60_429, "6000", 8, 1, 1, 69, "sa", "host", "dbx", "OK"],
          ["sql_batch_completed", "2026-08-12 13:23:46.000", "demo", "/* DBX_INTERNAL_TRACE */ SELECT 1", 100, 0, 0, 0, 0, 70, "sa", "host", "dbx", "OK"],
        ],
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ durationMs: 60.429, cpuMs: 6, sessionId: 69, logicalReads: 8 });
    expect(events[0].key).toContain("SELECT 1");
  });

  it("preserves repeated identical events while deduplicating later snapshots", () => {
    const event = parseSqlServerTraceEvents(
      result(
        ["event_name", "event_time_utc", "database_name", "sql_text", "duration_us", "cpu_time_us", "logical_reads", "writes", "row_count", "session_id", "login_name", "host_name", "client_app", "result_text"],
        [["sql_batch_completed", "2026-08-12", "demo", "EXEC repeat_me", 1000, 0, 0, 0, 0, 2, "sa", "host", "app", "OK"]],
      ),
    )[0];
    const first = mergeSqlServerTraceEventSnapshot(new Map(), [event, event]);
    expect(first.additions).toHaveLength(2);
    expect(new Set(first.additions.map((item) => item.key)).size).toBe(2);
    const second = mergeSqlServerTraceEventSnapshot(first.counts, [event, event, event]);
    expect(second.additions).toHaveLength(1);
    expect(second.counts.get(event.key)).toBe(3);
  });

  it("exports UTF-8 CSV with formula-safe quoting preserved as data", () => {
    const event = parseSqlServerTraceEvents(
      result(
        ["event_name", "event_time_utc", "database_name", "sql_text", "duration_us", "cpu_time_us", "logical_reads", "writes", "row_count", "session_id", "login_name", "host_name", "client_app", "result_text"],
        [["rpc_completed", "2026-08-12", "demo", "EXEC p N'a,b'", 1000, 0, 0, 0, 1, 2, "sa", "host", "app", "OK"]],
      ),
    )[0];
    const csv = sqlServerTraceEventsToCsv([event]);
    expect(csv.startsWith("\uFEFFtime_utc")).toBe(true);
    expect(csv).toContain("\"EXEC p N'a,b'\"");
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(sqlServerTraceEventsToCsv([{ ...event, sqlText: "=cmd()" }])).toContain("'=cmd()");
  });
});
