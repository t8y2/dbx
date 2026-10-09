import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import type { HistoryEntry, HistorySearchRequest } from "@/lib/backend/api";
import type { QueryResult } from "@/types/database";
import { collectOceanBaseRuntimeDiagnostic, findOceanBaseDiagnosticTargets, type AuditWindow, type OceanBaseDiagnosticTarget } from "./oceanbaseRuntimeDiagnostics";

export type DiagnosticStatus = "collected" | "not_collected" | "permission_denied" | "target_not_found" | "target_changed" | "unsupported" | "cancelled" | "timeout" | "failed" | "audit_disabled" | "connection_changed";
export interface DiagnosticContext {
  connectionId: string;
  connectionName: string;
  database: string;
  engine: "oracle" | "oceanbase-oracle";
}
export interface OracleDiagnosticTarget {
  kind?: "oracle_cursor";
  instanceId: string;
  sqlId: string;
  childNumber: string;
  childAddress: string;
  firstLoadTime: string;
  executions: string;
  lastActiveTime: string;
}
export type DiagnosticTarget = OracleDiagnosticTarget | OceanBaseDiagnosticTarget;
export interface DiagnosticMetric {
  name: string;
  value: string | null;
  unit: "count" | "rows" | "blocks" | "microseconds";
  scope: "cursor_cumulative" | "request";
  source: string;
  missingReason?: DiagnosticStatus;
}
export interface RuntimeDiagnosticRecord {
  format: "dbx-runtime-diagnostic-v1";
  id: string;
  context: DiagnosticContext;
  engineVersion: string | null;
  target: DiagnosticTarget;
  collectedAt: string;
  status: DiagnosticStatus;
  metrics: DiagnosticMetric[];
  /** Only selected numeric/identity evidence, never SQL text, binds or raw errors. */
  evidence: Record<string, string | null>;
}
type Backend = Pick<typeof api, "executeQuery" | "cancelQuery" | "saveHistory" | "searchHistory">;
export type DiagnosticQuery = (sql: string) => Promise<QueryResult>;

export function diagnosticErrorStatus(error: unknown): DiagnosticStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (/audit disabled/i.test(message)) return "audit_disabled";
  if (/connection (?:lost|closed)|disconnected|reconnect|ORA-03113|ORA-03114|socket/i.test(message)) return "connection_changed";
  if (/abort|cancel|ORA-01013/i.test(message)) return "cancelled";
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/ORA-01031|ORA-00942|permission|privilege|access denied/i.test(message)) return "permission_denied";
  if (/ORA-00904|not supported|unsupported/i.test(message)) return "unsupported";
  return "failed";
}

export function diagnosticRows(result: QueryResult): Record<string, unknown>[] {
  if (result.execution_error) throw new Error(JSON.stringify(result.error ?? "Diagnostic query failed"));
  return result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column.toUpperCase(), row[index]])));
}
function text(value: unknown): string {
  return value == null ? "" : String(value);
}
function numeric(value: unknown): string | null {
  const raw = text(value);
  return /^\d+(?:\.\d+)?$/.test(raw) ? raw : null;
}
function targetFromRow(row: Record<string, unknown>): OracleDiagnosticTarget {
  return {
    instanceId: text(row.INST_ID),
    sqlId: text(row.SQL_ID),
    childNumber: text(row.CHILD_NUMBER),
    childAddress: text(row.CHILD_ADDRESS),
    firstLoadTime: text(row.FIRST_LOAD_TIME),
    executions: text(row.EXECUTIONS),
    lastActiveTime: text(row.LAST_ACTIVE_TIME),
  };
}
function validateTarget(target: OracleDiagnosticTarget): void {
  if (
    !/^\d+$/.test(target.instanceId) ||
    !/^\d+$/.test(target.childNumber) ||
    !/^\d+$/.test(target.executions) ||
    !/^[0-9a-z]{13}$/.test(target.sqlId) ||
    !/^[0-9A-Fa-f]{8,32}$/.test(target.childAddress) ||
    !/^\d{4}-\d{2}-\d{2}\/\d{2}:\d{2}:\d{2}$/.test(target.firstLoadTime) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(target.lastActiveTime)
  ) {
    throw new Error("Invalid cursor identity");
  }
}
const cursorColumns = "INST_ID, SQL_ID, CHILD_NUMBER, RAWTOHEX(CHILD_ADDRESS) AS CHILD_ADDRESS, FIRST_LOAD_TIME, EXECUTIONS, USERS_EXECUTING, TO_CHAR(LAST_ACTIVE_TIME, 'YYYY-MM-DD\"T\"HH24:MI:SS') AS LAST_ACTIVE_TIME";
function cursorWhere(target: OracleDiagnosticTarget): string {
  validateTarget(target);
  return `INST_ID = ${target.instanceId} AND SQL_ID = '${target.sqlId}' AND CHILD_NUMBER = ${target.childNumber} AND CHILD_ADDRESS = HEXTORAW('${target.childAddress}') AND FIRST_LOAD_TIME = '${target.firstLoadTime}'`;
}
function sameCursorExecution(a: OracleDiagnosticTarget, b: OracleDiagnosticTarget): boolean {
  return a.instanceId === b.instanceId && a.sqlId === b.sqlId && a.childNumber === b.childNumber && a.childAddress === b.childAddress && a.firstLoadTime === b.firstLoadTime && a.executions === b.executions && a.lastActiveTime === b.lastActiveTime;
}
const counterDefinitions = [
  ["executions", "EXECUTIONS", "count"],
  ["rows_processed", "ROWS_PROCESSED", "rows"],
  ["buffer_gets", "BUFFER_GETS", "blocks"],
  ["disk_reads", "DISK_READS", "blocks"],
  ["elapsed", "ELAPSED_TIME", "microseconds"],
  ["cpu", "CPU_TIME", "microseconds"],
  ["application_wait", "APPLICATION_WAIT_TIME", "microseconds"],
  ["concurrency_wait", "CONCURRENCY_WAIT_TIME", "microseconds"],
  ["cluster_wait", "CLUSTER_WAIT_TIME", "microseconds"],
  ["user_io_wait", "USER_IO_WAIT_TIME", "microseconds"],
] as const;

/** Existing statistics only: never ALTER SESSION, execute the target, or inspect "last SQL". */
export async function collectOracleRuntimeDiagnostic(context: DiagnosticContext, target: OracleDiagnosticTarget, query: DiagnosticQuery): Promise<RuntimeDiagnosticRecord> {
  validateTarget(target);
  const record: RuntimeDiagnosticRecord = {
    format: "dbx-runtime-diagnostic-v1",
    id: uuid(),
    context: { connectionId: context.connectionId, connectionName: context.connectionName, database: context.database, engine: context.engine },
    target: { instanceId: target.instanceId, sqlId: target.sqlId, childNumber: target.childNumber, childAddress: target.childAddress, firstLoadTime: target.firstLoadTime, executions: target.executions, lastActiveTime: target.lastActiveTime },
    engineVersion: null,
    collectedAt: new Date().toISOString(),
    status: "not_collected",
    metrics: [],
    evidence: {},
  };
  try {
    const version = diagnosticRows(await query("SELECT VERSION FROM V$INSTANCE"))[0];
    record.engineVersion = version ? text(version.VERSION) : null;
    const rows = diagnosticRows(
      await query(
        `SELECT ${cursorColumns}, ${counterDefinitions
          .slice(1)
          .map(([, column]) => column)
          .join(", ")} FROM GV$SQL WHERE ${cursorWhere(target)}`,
      ),
    );
    if (rows.length !== 1) {
      record.status = "target_not_found";
      return record;
    }
    if (text(rows[0].USERS_EXECUTING) !== "0" || !sameCursorExecution(target, targetFromRow(rows[0]))) {
      record.status = "target_changed";
      return record;
    }
    for (const [name, column, unit] of counterDefinitions) {
      const value = numeric(rows[0][column]);
      record.metrics.push({ name, value, unit, scope: "cursor_cumulative", source: `GV$SQL.${column}`, ...(value === null ? { missingReason: "not_collected" as const } : {}) });
      record.evidence[`GV$SQL.${column}`] = value;
    }
    // Row-source counters are optional and cumulative, never estimated cardinalities or
    // LAST_OUTPUT_ROWS attributed to an execution that we cannot independently identify.
    let planValue: string | null = null;
    let planMissing: DiagnosticStatus = "not_collected";
    try {
      const plan = diagnosticRows(await query(`SELECT STARTS, OUTPUT_ROWS FROM GV$SQL_PLAN_STATISTICS_ALL WHERE INST_ID = ${target.instanceId} AND SQL_ID = '${target.sqlId}' AND CHILD_NUMBER = ${target.childNumber} AND CHILD_ADDRESS = HEXTORAW('${target.childAddress}') AND ID = 0`));
      if (plan.length === 1 && Number(plan[0].STARTS) > 0) planValue = numeric(plan[0].OUTPUT_ROWS);
      record.evidence["GV$SQL_PLAN_STATISTICS_ALL.STARTS"] = plan.length === 1 ? numeric(plan[0].STARTS) : null;
    } catch (error) {
      planMissing = diagnosticErrorStatus(error);
      if (planMissing === "cancelled" || planMissing === "timeout") throw error;
    }
    record.metrics.push({ name: "root_output_rows", value: planValue, unit: "rows", scope: "cursor_cumulative", source: "GV$SQL_PLAN_STATISTICS_ALL.OUTPUT_ROWS (ID=0)", ...(planValue === null ? { missingReason: planMissing } : {}) });
    record.evidence["GV$SQL_PLAN_STATISTICS_ALL.OUTPUT_ROWS"] = planValue;
    const after = diagnosticRows(await query(`SELECT ${cursorColumns} FROM GV$SQL WHERE ${cursorWhere(target)}`));
    if (after.length !== 1 || text(after[0].USERS_EXECUTING) !== "0" || !sameCursorExecution(target, targetFromRow(after[0]))) {
      record.status = after.length ? "target_changed" : "target_not_found";
      record.metrics = [];
      record.evidence = {};
      return record;
    }
    record.status = "collected";
  } catch (error) {
    record.status = diagnosticErrorStatus(error);
    record.metrics = [];
    record.evidence = {};
  }
  return record;
}

export function createRuntimeDiagnostics(backend: Backend = api) {
  function queryFor(context: DiagnosticContext, signal: AbortSignal): DiagnosticQuery {
    return async (sql) => {
      if (signal.aborted) throw new Error("Diagnostic cancelled");
      const executionId = uuid();
      const cancel = () => {
        void backend.cancelQuery(executionId).catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        // No tab/client/manual session ID: this read cannot join the user's transaction.
        const result = await backend.executeQuery(context.connectionId, context.database, sql, undefined, executionId, { maxRows: 101, timeoutSecs: 10 });
        if (signal.aborted) throw new Error("Diagnostic cancelled");
        return result;
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    };
  }
  return {
    async findTargets(context: DiagnosticContext, sqlId: string, signal: AbortSignal, window?: AuditWindow): Promise<DiagnosticTarget[]> {
      if (context.engine === "oceanbase-oracle") return findOceanBaseDiagnosticTargets(sqlId, window, queryFor(context, signal));
      if (!/^[0-9a-z]{13}$/.test(sqlId)) throw new Error("Invalid SQL ID");
      const rows = diagnosticRows(await queryFor(context, signal)(`SELECT ${cursorColumns} FROM GV$SQL WHERE SQL_ID = '${sqlId}' AND EXECUTIONS > 0 AND USERS_EXECUTING = 0 ORDER BY INST_ID, CHILD_NUMBER`));
      if (rows.length > 100) throw new Error("Too many cursor targets");
      return rows.map((row) => {
        const target = targetFromRow(row);
        validateTarget(target);
        return target;
      });
    },
    async collect(context: DiagnosticContext, target: DiagnosticTarget, signal: AbortSignal): Promise<RuntimeDiagnosticRecord> {
      if (target.kind === "ob_request") {
        if (context.engine !== "oceanbase-oracle") throw new Error("Unsupported diagnostic target");
        return collectOceanBaseRuntimeDiagnostic(context, target, queryFor(context, signal));
      }
      if (context.engine !== "oracle") throw new Error("Unsupported diagnostic target");
      return collectOracleRuntimeDiagnostic(context, target, queryFor(context, signal));
    },
    async save(record: RuntimeDiagnosticRecord): Promise<void> {
      const entry: HistoryEntry = {
        id: record.id,
        connection_id: record.context.connectionId,
        connection_name: record.context.connectionName,
        database: record.context.database,
        sql: "",
        executed_at: record.collectedAt,
        execution_time_ms: 0,
        success: record.status === "collected",
        activity_kind: "query",
        source: "other",
        operation: "runtime_diagnostic",
        target: record.target.sqlId,
        details_json: JSON.stringify(record),
      };
      await backend.saveHistory(entry);
    },
    async load(context: DiagnosticContext, cursor?: HistorySearchRequest["cursor"]): Promise<{ records: RuntimeDiagnosticRecord[]; cursor: HistorySearchRequest["cursor"] }> {
      const page = await backend.searchHistory({ search_text: "", connections: [{ connection_id: context.connectionId, connection_name: "" }], databases: [], source: "other", limit: 100, cursor });
      const records: RuntimeDiagnosticRecord[] = [];
      for (const entry of page.entries) {
        if (entry.operation !== "runtime_diagnostic" || !entry.details_json) continue;
        try {
          const record = JSON.parse(entry.details_json) as RuntimeDiagnosticRecord;
          if (record.format === "dbx-runtime-diagnostic-v1" && record.context.connectionId === context.connectionId && record.context.database === context.database && Array.isArray(record.metrics)) records.push(record);
        } catch {
          /* A malformed/older history entry must not prevent reopening valid records. */
        }
      }
      return { records, cursor: page.next_cursor ?? undefined };
    },
  };
}
