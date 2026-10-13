import type { QueryResult } from "@/types/database";

/**
 * Xugu's DBA operation kills a transaction, not its owning session. Keep the
 * BIGINT transaction id as text so JSON/JavaScript never rounds the target.
 * The join deliberately matches the transaction to its current session on
 * both node and transaction id; idle sessions are not part of this view.
 */
export const XUGU_TRANSACTION_LIST_SQL = `SELECT T.NODEID AS NODE_ID,
       CAST(T.TRANID AS VARCHAR(32)) AS TRANSACTION_ID,
       S.SESSION_ID AS SESSION_ID,
       S.USER_NAME AS USER_NAME,
       S.DB_NAME AS DB_NAME,
       S.IP AS CLIENT_IP,
       T.START_T AS START_TIME
FROM SYS_ALL_TRANS T
JOIN SYS_ALL_SESSIONS S
  ON T.NODEID = S.NODEID AND T.TRANID = S.CURR_TID
ORDER BY T.START_T`;

/** The SYSTEM control connection is serialized by the Xugu agent. */
export const XUGU_OWN_SESSION_SQL = "SELECT NODEID, SESSION_ID FROM SYS_SESSIONS WHERE SESSION_ID = USERENV('SID')";

export interface XuguTransactionRow {
  /** Session id for display only; it is not the transaction kill target. */
  id: number;
  nodeId: number;
  transactionId: string;
  user: string;
  db: string | null;
  host: string | null;
  startTime: string | null;
}

const MAX_SIGNED_BIGINT = 9223372036854775807n;

function columnIndex(columns: string[], name: string): number {
  return columns.findIndex((column) => column.toUpperCase() === name);
}

function textAt(result: QueryResult, row: unknown[], name: string): string | null {
  const index = columnIndex(result.columns, name);
  const value = index < 0 ? null : row[index];
  return value === null || value === undefined ? null : String(value);
}

function safeInteger(value: string | null): number | null {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function mapXuguTransactionRows(result: QueryResult | null | undefined): XuguTransactionRow[] {
  if (!result?.rows) return [];
  const mapped: XuguTransactionRow[] = [];
  for (const raw of result.rows) {
    const nodeId = safeInteger(textAt(result, raw, "NODE_ID"));
    const sessionId = safeInteger(textAt(result, raw, "SESSION_ID"));
    const transactionId = textAt(result, raw, "TRANSACTION_ID");
    if (nodeId === null || nodeId <= 0 || sessionId === null || transactionId === null || !/^[1-9]\d*$/.test(transactionId)) continue;
    const transaction = BigInt(transactionId);
    if (transaction > MAX_SIGNED_BIGINT) continue;
    mapped.push({
      id: sessionId,
      nodeId,
      transactionId,
      user: textAt(result, raw, "USER_NAME") ?? "",
      db: textAt(result, raw, "DB_NAME"),
      host: textAt(result, raw, "CLIENT_IP"),
      startTime: textAt(result, raw, "START_TIME"),
    });
  }
  return mapped;
}

export function xuguTransactionKey(row: XuguTransactionRow): string {
  return `${row.nodeId}:${row.transactionId}:${row.id}`;
}

export function buildXuguKillTransactionSql(row: Pick<XuguTransactionRow, "nodeId" | "transactionId">): string {
  const { nodeId, transactionId } = row;
  if (!Number.isSafeInteger(nodeId) || nodeId <= 0 || !/^[1-9]\d*$/.test(transactionId)) throw new Error("Invalid Xugu transaction target");
  const transaction = BigInt(transactionId);
  if (transaction > MAX_SIGNED_BIGINT) throw new Error("Invalid Xugu transaction target");
  return `CALL DBMS_DBA.KILL_TRANS(${nodeId}, ${transactionId})`;
}
