import { describe, expect, it, vi } from "vitest";
import type { QueryResult } from "@/types/database";
import { captureOracleDiagnosticTarget, collectOracleSessionDiagnostics, oracleLongOperationProgress, parseOracleCachedPlan } from "../oracleSessionDiagnostics";
import type { SessionDiagnosticsSnapshot } from "../sessionDiagnostics";

const sqlId = "0123456789abc";
const session = { id: "17", serial: "8", instance: "2", container: "3", user: "APP'X", auditSession: "9007199254740993", logonTime: "2026-10-21 10:00:00" };
const live = { SQL_ID: sqlId, CHILD_NUMBER: "1", SQL_EXEC_ID: "9007199254740995", SQL_EXEC_START: "2026-10-21T20:00:00", EVENT: "db file sequential read", WAIT_CLASS: "User I/O", STATE: "WAITING", SECONDS_IN_WAIT: "0", BLOCKING_INSTANCE: null, BLOCKING_SESSION: null };
const sqlText = "SELECT '中文😀' FROM DUAL";
const cursor = {
  SQL_ID: sqlId,
  CHILD_NUMBER: "1",
  CHILD_ADDRESS: "000000001234ABCD",
  FIRST_LOAD_TIME: "2026-10-21/19:50:00",
  PLAN_HASH: "9007199254740997",
  EXECUTIONS: "9007199254740999",
  ROWS_PROCESSED: "3",
  BUFFER_GETS: "0",
  DISK_READS: "0",
  ELAPSED_TIME: "1000",
  CPU_TIME: "400",
  USERS_EXECUTING: "2",
  SQL_TEXT: sqlText,
  SOURCE_LENGTH: String(sqlText.length),
};
const planRows = [
  { ID: "0", PARENT_ID: null, OPERATION: "SELECT STATEMENT", OPTIONS: null, OBJECT_OWNER: null, OBJECT_NAME: null, OBJECT_TYPE: null, COST: "2", ESTIMATED_ROWS: "100", ACCESS_PREDICATES: null, FILTER_PREDICATES: null },
  { ID: "1", PARENT_ID: "0", OPERATION: "TABLE ACCESS", OPTIONS: "FULL", OBJECT_OWNER: "APP", OBJECT_NAME: "T", OBJECT_TYPE: "TABLE", COST: "2", ESTIMATED_ROWS: "100", ACCESS_PREDICATES: null, FILTER_PREDICATES: '"T"."X">1' },
];
const longop = {
  SID: "17",
  SERIAL_NUMBER: "8",
  INSTANCE_ID: "2",
  OPNAME: "Table Scan",
  TARGET: "APP.T",
  SOFAR: "9007199254740999",
  TOTALWORK: "18014398509481998",
  UNITS: "Blocks",
  START_TIME: "2026-10-21T20:00:00",
  LAST_UPDATE_TIME: "2026-10-21T20:01:00",
  ELAPSED_SECONDS: "60",
  TIME_REMAINING: "60",
  MESSAGE: "fixture",
  SQL_ID: sqlId,
  SQL_EXEC_ID: live.SQL_EXEC_ID,
  SQL_EXEC_START: live.SQL_EXEC_START,
};
function result(rows: Record<string, unknown>[], extra: Partial<QueryResult> = {}): QueryResult {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { columns, rows: rows.map((row) => columns.map((column) => row[column] as string | null)), affected_rows: 0, execution_time_ms: 1, ...extra };
}
function fixture(options: { rowError?: string; cursorError?: string; planError?: string; changedCursor?: boolean; sqlLength?: string; notCollected?: boolean; idle?: boolean; sqlSwitched?: boolean } = {}) {
  let sessionReads = 0,
    cursorReads = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("PRODUCT_COMPONENT_VERSION")) return result([{ VERSION: "11.2.0.4.0" }]);
    if (sql.includes("FROM GV$SESSION_LONGOPS")) return result([longop]);
    if (sql.includes("FROM GV$SQL_PLAN_STATISTICS_ALL")) {
      if (options.rowError) throw new Error(options.rowError);
      return result([{ STARTS: options.notCollected ? "0" : "2", OUTPUT_ROWS: "9" }]);
    }
    if (sql.includes("FROM GV$SQL_PLAN p")) {
      if (options.planError) throw new Error(options.planError);
      return result(planRows);
    }
    if (sql.includes("FROM GV$SESSION s")) {
      sessionReads++;
      return result([{ ...live, ...(options.idle ? { SQL_ID: null, CHILD_NUMBER: null, SQL_EXEC_ID: null, SQL_EXEC_START: null } : {}), ...(options.sqlSwitched && sessionReads > 1 ? { SQL_ID: "fedcba9876543" } : {}) }]);
    }
    if (sql.includes("FROM GV$SQL s")) {
      cursorReads++;
      if (options.cursorError) throw new Error(options.cursorError);
      return result([{ ...cursor, ...(options.changedCursor && cursorReads > 2 ? { FIRST_LOAD_TIME: "new-generation" } : {}), ...(options.sqlLength ? { SOURCE_LENGTH: options.sqlLength } : {}) }]);
    }
    throw new Error(`Unexpected diagnostic query: ${sql}`);
  });
  const reader = { query, readCell: vi.fn(async (value: QueryResult, row: number, column: number) => String(value.rows[row]?.[column] ?? "")), stop: vi.fn(), close: vi.fn(), closed: Promise.resolve(), cleanupError: undefined };
  const snapshot: Partial<SessionDiagnosticsSnapshot> = {};
  return { reader, query, snapshot, publish: (patch: Partial<SessionDiagnosticsSnapshot>) => Object.assign(snapshot, patch) };
}

describe("Oracle session-linked diagnostics", () => {
  it("does not attach a new SQL to an idle row selected before that SQL began", async () => {
    const f = fixture();
    await expect(captureOracleDiagnosticTarget({ ...session, sqlId: "" }, 19, f.reader)).rejects.toThrow("Selected session SQL changed");
    expect(f.query).toHaveBeenCalledOnce();
  });

  it("keeps RAC/container/child identity and separates estimated rows from real cumulative counters", async () => {
    const f = fixture();
    const target = await captureOracleDiagnosticTarget(session, 19, f.reader);
    await collectOracleSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.sql).toMatchObject({ state: "ready", data: { text: sqlText, completeness: "complete" } });
    expect(f.snapshot.identity).toMatchObject({ instance: "2", container: "3", childNumber: "1", sqlExecId: live.SQL_EXEC_ID });
    expect(f.snapshot.plan?.data?.plan.nodes[0]?.rows).toBe("100");
    expect(f.snapshot.metrics?.data).toContainEqual(expect.objectContaining({ name: "executions", value: cursor.EXECUTIONS, scope: "cursor_cumulative" }));
    expect(f.snapshot.metrics?.data).toContainEqual(expect.objectContaining({ name: "root_output_rows", value: "9", scope: "cursor_cumulative" }));
    const query = f.query.mock.calls.find(([sql]) => sql.includes("FROM GV$SQL_PLAN p"))?.[0] ?? "";
    expect(query).toContain("p.INST_ID=2 AND p.CON_ID=3");
    expect(query).toContain("p.CHILD_NUMBER=1");
    expect(query).toContain("RAWTOHEX(p.CHILD_ADDRESS)='000000001234ABCD'");
    expect(f.query.mock.calls.some(([sql]) => /USERS_EXECUTING\s*=\s*0|DISPLAY_CURSOR|EXPLAIN PLAN FOR/.test(sql))).toBe(false);
  });

  it("keeps Oracle 11g queries free of container columns and safely scopes full session identity", async () => {
    const f = fixture();
    const target = await captureOracleDiagnosticTarget({ ...session, container: "0" }, undefined, f.reader);
    await collectOracleSessionDiagnostics(target, f.reader, f.publish);
    expect(target.legacy).toBe(true);
    expect(f.query.mock.calls.every(([sql]) => !sql.includes("CON_ID"))).toBe(true);
    const query = f.query.mock.calls.find(([sql]) => sql.includes("FROM GV$SESSION s"))?.[0] ?? "";
    expect(query).toContain(`s.AUDSID=${session.auditSession}`);
    expect(query).toContain("s.USERNAME='APP''X'");
    expect(query).toContain("s.SERIAL#=8 AND s.INST_ID=2");
  });

  it("does not relabel a length-mismatched SQL prefix as complete", async () => {
    const f = fixture({ sqlLength: "999999" });
    const target = await captureOracleDiagnosticTarget(session, 19, f.reader);
    await collectOracleSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.sql).toMatchObject({ state: "ready", incomplete: true, data: { completeness: "fragment" } });
    expect(f.snapshot.metrics?.state).toBe("ready");
  });

  it("keeps counters available when SQL snapshot materialization fails", async () => {
    const f = fixture();
    f.reader.readCell.mockRejectedValue(new Error("LOB snapshot expired"));
    const target = await captureOracleDiagnosticTarget(session, 19, f.reader);
    await collectOracleSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.sql).toMatchObject({ incomplete: true, error: expect.stringContaining("expired"), data: { completeness: "fragment" } });
    expect(f.snapshot.metrics?.state).toBe("ready");
  });

  it("retains ordinary cursor counters beside a row-source permission failure", async () => {
    const f = fixture({ rowError: "ORA-01031: insufficient privileges" });
    const target = await captureOracleDiagnosticTarget(session, 19, f.reader);
    await collectOracleSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.metrics).toMatchObject({ state: "ready", reason: "permission_denied", error: expect.stringContaining("ORA-01031") });
    expect(f.snapshot.metrics?.data?.length).toBe(10);
  });

  it("does not replace uncollected root output rows with optimizer cardinality", async () => {
    const f = fixture({ notCollected: true });
    const target = await captureOracleDiagnosticTarget(session, 19, f.reader);
    await collectOracleSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.metrics?.data).toContainEqual(expect.objectContaining({ name: "root_output_rows", value: null }));
    expect(f.snapshot.metrics?.reason).toBe("not_collected");
  });

  it("rejects a replacement cursor generation while keeping independent session waits", async () => {
    const f = fixture({ changedCursor: true });
    const target = await captureOracleDiagnosticTarget(session, 19, f.reader);
    await collectOracleSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.sql).toMatchObject({ state: "unavailable", reason: "target_changed" });
    expect(f.snapshot.metrics).toMatchObject({ state: "unavailable", reason: "target_changed" });
    expect(f.snapshot.waits?.state).toBe("ready");
  });

  it("keeps the original cursor readable after the session moves to another SQL", async () => {
    const f = fixture({ sqlSwitched: true });
    const target = await captureOracleDiagnosticTarget(session, 19, f.reader);
    await collectOracleSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.stale).toBe(true);
    expect(f.snapshot.sql?.data?.text).toBe(sqlText);
    expect(f.snapshot.plan?.data?.binding).toBe("cursor");
    expect(f.snapshot.waits?.reason).toBe("target_changed");
    expect(f.query.mock.calls.some(([sql]) => sql.includes("FROM GV$SESSION_LONGOPS"))).toBe(false);
  });

  it("labels long operations as execution-bound only with the complete execution identity", async () => {
    const f = fixture();
    const target = await captureOracleDiagnosticTarget(session, 19, f.reader);
    await collectOracleSessionDiagnostics(target, f.reader, f.publish);
    expect(f.snapshot.longOperations?.data?.rows[0]?.[0]).toBe("execution");
    expect(f.snapshot.longOperations?.data?.rows[0]?.at(-1)).toBe("50");
    const g = fixture({ idle: true });
    const idle = await captureOracleDiagnosticTarget(session, 19, g.reader);
    await collectOracleSessionDiagnostics(idle, g.reader, g.publish);
    expect(g.snapshot.sql?.reason).toBe("not_collected");
    expect(g.snapshot.longOperations?.data?.rows[0]?.[0]).toBe("session_sample");
    expect(g.query.mock.calls.some(([sql]) => sql.includes("PREV_SQL_ID"))).toBe(false);
  });

  it("uses progress units conservatively and keeps big counters out of floating-point arithmetic", () => {
    expect(oracleLongOperationProgress("1", "3", "Rows")).toBe("33.3");
    expect(oracleLongOperationProgress("9007199254740999", "18014398509481998", "Blocks")).toBe("50");
    expect(oracleLongOperationProgress("100", "0", "Blocks")).toBeNull();
    expect(oracleLongOperationProgress("10", "20", "")).toBeNull();
    expect(oracleLongOperationProgress("1.5", "20", "Blocks")).toBeNull();
  });

  it("keeps malformed or disconnected plans as raw Oracle evidence", () => {
    expect(parseOracleCachedPlan(result(planRows)).plan.nodes[0]?.children[0]?.relation).toBe("APP.T");
    expect(parseOracleCachedPlan(result([{ ...planRows[1], PARENT_ID: "99" }])).incomplete).toBe(true);
    expect(parseOracleCachedPlan(result([planRows[0], { ...planRows[1], PARENT_ID: "1" }])).plan.nodes).toEqual([]);
    expect(parseOracleCachedPlan(result(planRows, { has_more: true })).plan.databaseType).toBe("oracle");
    expect(parseOracleCachedPlan(result(planRows, { has_more: true })).plan.nodes).toEqual([]);
    expect(parseOracleCachedPlan(result([]))).toMatchObject({ incomplete: false, plan: { databaseType: "oracle", nodes: [] } });
    for (const row of [
      { ...planRows[0], ID: null },
      { ...planRows[1], PARENT_ID: "invalid" },
    ]) {
      const raw = result([row]);
      expect(parseOracleCachedPlan(raw)).toMatchObject({ incomplete: true, plan: { databaseType: "oracle", raw, nodes: [] } });
    }
  });
});
