import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";

export interface MonitorContext {
  connectionId: string;
  database: string;
  engine: "oracle" | "oceanbase-oracle";
}
export type MonitorError = "permission_denied" | "unsupported" | "cancelled" | "timeout" | "connection_changed" | "failed";
export interface MonitoredSession {
  key: string;
  identity: string;
  state: string;
  wait: string;
  sqlId: string;
  blocking: "observed" | "not_observed" | "unknown";
  visible: boolean;
}
export interface BlockingEdge {
  waiter: string;
  holder: string;
  source: string;
}
export interface SessionSnapshot {
  startedAt: string;
  completedAt: string;
  sessions: MonitoredSession[];
  edges: BlockingEdge[];
  limitations: (MonitorError | "truncated" | "legacy_locks" | "identity_changed" | "invisible_holder")[];
}
type Row = Record<string, unknown>;
type Backend = Pick<typeof api, "executeQuery" | "cancelQuery">;
const limit = 1000;
const str = (value: unknown) => (value == null ? "" : String(value));
const key = (...parts: string[]) => JSON.stringify(parts);

export function monitorError(cause: unknown): MonitorError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/timeout|timed out|ORA-01013.*timeout/i.test(message)) return "timeout";
  if (/abort|cancel|ORA-01013/i.test(message)) return "cancelled";
  if (/ORA-03113|ORA-03114|connection.*(?:closed|lost)|disconnected|socket/i.test(message)) return "connection_changed";
  if (/ORA-01031|ORA-00942|permission|privilege|access denied/i.test(message)) return "permission_denied";
  if (/ORA-00904|unsupported|not supported/i.test(message)) return "unsupported";
  return "failed";
}

const oracleSql = `SELECT TO_CHAR(s.INST_ID) AS INSTANCE_ID, TO_CHAR(s.SID) AS SID,
  TO_CHAR(s.SERIAL#) AS SERIAL_ID, s.STATUS, s.STATE, s.EVENT, s.SQL_ID,
  s.BLOCKING_SESSION_STATUS AS BLOCKING_STATUS,
  TO_CHAR(s.BLOCKING_INSTANCE) AS HOLDER_INSTANCE, TO_CHAR(s.BLOCKING_SESSION) AS HOLDER_SID,
  TO_CHAR(b.SERIAL#) AS HOLDER_SERIAL
  FROM GV$SESSION s LEFT JOIN GV$SESSION b
  ON b.INST_ID = s.BLOCKING_INSTANCE AND b.SID = s.BLOCKING_SESSION
  WHERE s.TYPE = 'USER' AND ROWNUM <= 1001`;
const obSessionSql = `SELECT SVR_IP, TO_CHAR(SVR_PORT) AS SVR_PORT, TO_CHAR(ID) AS SID,
  TENANT, TO_CHAR(TRANS_ID) AS TRANS_ID, STATE, SQL_ID
  FROM SYS.GV$OB_PROCESSLIST WHERE ROWNUM <= 1001`;

/** Each path follows actual snapshot edges. Missing nodes and cycles terminate explicitly. */
export function blockingPaths(snapshot: SessionSnapshot, start: string): { keys: string[]; end: "cycle" | "unknown" | "not_observed" }[] {
  const nodes = new Map(snapshot.sessions.map((node) => [node.key, node]));
  const paths: { keys: string[]; end: "cycle" | "unknown" | "not_observed" }[] = [];
  const pending = [[start]];
  // Bound branching as well as depth; a partial traversal must never mean no blocker.
  while (pending.length && paths.length < 100) {
    const chain = pending.pop()!;
    const tail = chain[chain.length - 1];
    if (chain.slice(0, -1).includes(tail)) {
      paths.push({ keys: chain, end: "cycle" });
      continue;
    }
    const next = snapshot.edges.filter((edge) => edge.waiter === tail);
    if (!next.length || chain.length >= 100) {
      paths.push({ keys: chain, end: chain.length >= 100 || !nodes.get(tail)?.visible || nodes.get(tail)?.blocking === "unknown" ? "unknown" : "not_observed" });
    } else {
      for (const edge of next) {
        if (pending.length + paths.length < 100) pending.push([...chain, edge.holder]);
        else if (!paths.some((path) => path.end === "unknown")) paths.push({ keys: chain, end: "unknown" });
      }
    }
  }
  return paths;
}

export function createSessionBlockingMonitor(backend: Backend = api) {
  return {
    async collect(context: MonitorContext, signal: AbortSignal): Promise<SessionSnapshot> {
      const snapshot: SessionSnapshot = { startedAt: new Date().toISOString(), completedAt: "", sessions: [], edges: [], limitations: [] };
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(() => {
        timedOut = true;
        abort();
      }, 30_000);
      const addLimit = (reason: SessionSnapshot["limitations"][number]) => {
        if (!snapshot.limitations.includes(reason)) snapshot.limitations.push(reason);
      };
      async function query(sql: string): Promise<Row[]> {
        if (controller.signal.aborted) throw new Error(timedOut ? "timeout" : "cancelled");
        const executionId = uuid();
        let rejectAbort!: (cause: Error) => void;
        const aborted = new Promise<never>((_, reject) => {
          rejectAbort = reject;
        });
        const cancel = () => {
          // End local waiting even if execution or cancellation never settles.
          // Requesting cancellation does not confirm that the server stopped.
          rejectAbort(new Error(timedOut ? "timeout" : "cancelled"));
          try {
            void backend.cancelQuery(executionId).catch(() => undefined);
          } catch {
            // A transport failure must not retain the local pending state.
          }
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          // Separate diagnostic execution; never borrow the editor's manual transaction.
          const result = await Promise.race([backend.executeQuery(context.connectionId, context.database, sql, undefined, executionId, { maxRows: limit + 1, timeoutSecs: 10 }), aborted]);
          if (controller.signal.aborted) throw new Error(timedOut ? "timeout" : "cancelled");
          if (result.execution_error) throw new Error(JSON.stringify(result.error ?? "Collection failed"));
          if (result.rows.length > limit) addLimit("truncated");
          return result.rows.slice(0, limit).map((row) => Object.fromEntries(result.columns.map((column, index) => [column.toUpperCase(), row[index]])));
        } catch (cause) {
          if (controller.signal.aborted) throw new Error(timedOut ? "timeout" : "cancelled");
          throw cause;
        } finally {
          controller.signal.removeEventListener("abort", cancel);
        }
      }
      function missing(id: string, identity: string) {
        if (!snapshot.sessions.some((node) => node.key === id)) snapshot.sessions.push({ key: id, identity, state: "", wait: "", sqlId: "", blocking: "unknown", visible: false });
        addLimit("invisible_holder");
      }
      try {
        if (context.engine === "oracle") {
          const rows = await query(oracleSql);
          for (const row of rows) {
            const id = key("oracle", str(row.INSTANCE_ID), str(row.SID), str(row.SERIAL_ID));
            snapshot.sessions.push({
              key: id,
              identity: `${row.INSTANCE_ID}/${row.SID}/${row.SERIAL_ID}`,
              state: str(row.STATUS),
              wait: row.STATE === "WAITING" ? str(row.EVENT) : str(row.STATE),
              sqlId: str(row.SQL_ID),
              visible: true,
              blocking: row.BLOCKING_STATUS === "VALID" ? "observed" : ["NO HOLDER", "NOT IN WAIT"].includes(str(row.BLOCKING_STATUS)) ? "not_observed" : "unknown",
            });
            if (row.BLOCKING_STATUS === "VALID" && row.HOLDER_INSTANCE != null && row.HOLDER_SID != null) {
              snapshot.edges.push({ waiter: id, holder: key("oracle", str(row.HOLDER_INSTANCE), str(row.HOLDER_SID), str(row.HOLDER_SERIAL)), source: "GV$SESSION.BLOCKING_SESSION" });
            }
          }
          for (const edge of snapshot.edges) if (!snapshot.sessions.some((node) => node.key === edge.holder)) missing(edge.holder, (JSON.parse(edge.holder) as string[]).slice(1).join("/"));
        } else {
          const before = await query(obSessionSql);
          const tenants = new Map<string, string>();
          try {
            for (const row of await query("SELECT TENANT_NAME, TO_CHAR(TENANT_ID) AS TENANT_ID FROM SYS.DBA_OB_TENANTS WHERE ROWNUM <= 1001")) tenants.set(str(row.TENANT_NAME), str(row.TENANT_ID));
          } catch (cause) {
            const status = monitorError(cause);
            if (status !== "permission_denied" && status !== "unsupported") throw cause;
            addLimit(status);
          }
          let modern = true;
          let locks: Row[] = [];
          try {
            try {
              await query("SELECT ID3 FROM SYS.GV$OB_LOCKS WHERE 1 = 0");
            } catch (cause) {
              // Only a missing column establishes the legacy schema; access errors do not.
              if (!/ORA-00904/i.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
              modern = false;
              addLimit("legacy_locks");
            }
            // Modern ID1 is HOLDER_TRANS_ID for waiting TR/TX/TM rows. Legacy TX ID1
            // is the holder transaction; legacy TR ID2 contains a row key and is never read.
            locks = await query(`SELECT TO_CHAR(TENANT_ID) AS TENANT_ID, TO_CHAR(TRANS_ID) AS TRANS_ID,
              TO_CHAR(ID1) AS HOLDER_TRANS_ID, TYPE FROM SYS.GV$OB_LOCKS
              WHERE BLOCK = 1 AND TYPE ${modern ? "IN ('TR', 'TX', 'TM')" : "= 'TX'"} AND ROWNUM <= 1001`);
          } catch (cause) {
            const status = monitorError(cause);
            if (status !== "permission_denied" && status !== "unsupported") throw cause;
            addLimit(status);
          }
          const after = await query(obSessionSql);
          const sessionKey = (row: Row) => key("ob", str(row.TENANT), str(row.SVR_IP), str(row.SVR_PORT), str(row.SID), str(row.TRANS_ID));
          const stable = new Set(before.map(sessionKey));
          const transactions = new Map<string, string[]>();
          for (const row of after) {
            const id = sessionKey(row);
            snapshot.sessions.push({ key: id, identity: `${row.TENANT}@${row.SVR_IP}:${row.SVR_PORT}/${row.SID} · TX ${row.TRANS_ID ?? "?"}`, state: str(row.STATE), wait: str(row.STATE), sqlId: str(row.SQL_ID), visible: true, blocking: "unknown" });
            const tenant = tenants.get(str(row.TENANT));
            const tx = str(row.TRANS_ID);
            if (!stable.has(id)) {
              addLimit("identity_changed");
              continue;
            }
            if (tenant && /^\d+$/.test(tx) && tx !== "0") {
              const txKey = key(tenant, tx);
              transactions.set(txKey, [...(transactions.get(txKey) ?? []), id]);
            }
          }
          const endpoint = (tenant: string, tx: string) => {
            const candidates = transactions.get(key(tenant, tx)) ?? [];
            if (candidates.length === 1) return candidates[0];
            const id = key("ob-transaction", tenant, tx);
            missing(id, `${tenant} / TX ${tx}`);
            return id;
          };
          for (const row of locks) {
            const tenant = str(row.TENANT_ID),
              waiterTx = str(row.TRANS_ID),
              holderTx = str(row.HOLDER_TRANS_ID);
            if (![tenant, waiterTx, holderTx].every((value) => /^\d+$/.test(value) && value !== "0")) {
              addLimit("identity_changed");
              continue;
            }
            const waiter = endpoint(tenant, waiterTx),
              holder = endpoint(tenant, holderTx);
            if (!snapshot.edges.some((edge) => edge.waiter === waiter && edge.holder === holder)) snapshot.edges.push({ waiter, holder, source: `GV$OB_LOCKS.${row.TYPE}` });
            const node = snapshot.sessions.find((node) => node.key === waiter);
            if (node) node.blocking = "observed";
          }
        }
        snapshot.completedAt = new Date().toISOString();
        return snapshot;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
