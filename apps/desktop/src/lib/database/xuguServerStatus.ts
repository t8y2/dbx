import type { ConnectionConfig, QueryResult } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";

export interface XuguClusterNode {
  nodeId: string;
  rackNo: string;
  host: string;
  port: string;
  nodeType: string;
  state: string;
  cpuLoad: string;
  bootTime: string;
  storeCount: string;
  majorCount: string;
}

export interface XuguRunInfo {
  nodeId: string;
  activeTransactions: string;
  diskReadCount: string;
  diskReadBytes: string;
  diskWriteCount: string;
  diskWriteBytes: string;
  maxTransactionId: string;
  minTransactionId: string;
  xlogWritePosition: string;
  xlogCheckpointPosition: string;
  freeStores: string;
}

export interface XuguSessionSummary {
  nodeId: string;
  sessions: string;
  activeSessions: string;
  memoryBytes: string;
  oldestStatement: string;
}

export interface XuguTransactionSummary {
  nodeId: string;
  activeTransactions: string;
  oldestTransaction: string;
}

export interface XuguMemoryStatus {
  nodeId: string;
  bufferTotalBytes: string;
  bufferFreeBytes: string;
  bufferDirtyBytes: string;
  bufferLruBytes: string;
  sgaTotalBytes: string;
  sgaFreeBytes: string;
  sgaPeakBytes: string;
  swapTotalBytes: string;
  swapFreeBytes: string;
}

export interface XuguSessionStatusSummary {
  nodeId: string;
  status: string;
  sessions: string;
}

export interface XuguLockModeSummary {
  nodeId: string;
  lockMode: string;
  locks: string;
}

export interface XuguTablespaceSummary {
  nodeId: string;
  spaceName: string;
  spaceType: string;
  datafiles: string;
  mediaError: string;
  totalBytes: string;
  freeBytes: string;
}

export const XUGU_VERSION_SQL = "SELECT VERSION() AS VERSION FROM DUAL;";

export const XUGU_CLUSTER_NODES_SQL = `
SELECT
  NODE_ID,
  RACK_NO,
  NODE_IP,
  NODE_PORT,
  NODE_TYPE,
  NODE_STATE,
  CPU_LOAD,
  BOOT_TIME,
  STORE_NUM,
  MAJOR_NUM
FROM SYS_CLUSTERS
ORDER BY NODE_ID;`.trim();

export const XUGU_RUN_INFO_SQL = `
SELECT
  NODEID,
  ACT_TRANS_NUM,
  DISK_R_N,
  DISK_R_BYTES,
  DISK_W_N,
  DISK_W_BYTES,
  MAX_TRANS_ID,
  MIN_TRANS_ID,
  XLOG_WPOS,
  XLOG_CKPT,
  FREE_STO_N
FROM SYS_ALL_RUN_INFO
ORDER BY NODEID;`.trim();

/** Per-node session totals. This is optional because restricted users may not see SYS_ALL_SESSIONS. */
export const XUGU_SESSION_SUMMARY_SQL = `
SELECT NODEID AS NODE_ID,
       COUNT(*) AS SESSIONS,
       SUM(MEM_SIZE) AS MEMORY_BYTES
FROM SYS_ALL_SESSIONS
GROUP BY NODEID
ORDER BY NODEID;`.trim();

/** The thread-session view is the Xugu-specific definition of an active statement. */
export const XUGU_ACTIVE_SESSION_SQL = `
SELECT T.NODEID AS NODE_ID,
       COUNT(*) AS ACTIVE_SESSIONS,
       MIN(S.CMD_START_T) AS OLDEST_STATEMENT
FROM SYS_ALL_THD_SESSION T
JOIN SYS_ALL_SESSIONS S
  ON T.NODEID = S.NODEID AND T.SESSION_ID = S.SESSION_ID
GROUP BY T.NODEID
ORDER BY T.NODEID;`.trim();

export const XUGU_TRANSACTION_SUMMARY_SQL = `
SELECT NODEID AS NODE_ID,
       COUNT(*) AS ACTIVE_TRANSACTIONS,
       MIN(START_T) AS OLDEST_TRANSACTION
FROM SYS_ALL_TRANS
GROUP BY NODEID
ORDER BY NODEID;`.trim();

/** Only table-level lock waiters are exposed by SYS_ALL_LWAITERS. */
export const XUGU_LOCK_WAITS_SQL = `
SELECT
  (SELECT COUNT(*) FROM SYS_ALL_LWAITERS) AS LOCK_WAITS,
  (SELECT COUNT(*) FROM SYS_ALL_LOWNERS) AS LOCK_OWNERS
FROM DUAL;`.trim();

export const XUGU_LOCK_MODE_SUMMARY_SQL = `
SELECT NODEID AS NODE_ID,
       LOCK_LEVEL AS LOCK_MODE,
       COUNT(*) AS LOCKS
FROM SYS_ALL_LOWNERS
GROUP BY NODEID, LOCK_LEVEL
ORDER BY NODEID, LOCK_LEVEL;`.trim();

export const XUGU_SESSION_STATUS_SUMMARY_SQL = `
SELECT NODEID AS NODE_ID,
       STATUS,
       COUNT(*) AS SESSIONS
FROM SYS_ALL_SESSIONS
GROUP BY NODEID, STATUS
ORDER BY NODEID, STATUS;`.trim();

export const XUGU_MEMORY_STATUS_SQL = `
SELECT
  NODEID,
  BUFF_SIZE * TOTAL_BUFF_NUM AS BUFFER_TOTAL_BYTES,
  BUFF_SIZE * FREE_BUFF_NUM AS BUFFER_FREE_BYTES,
  BUFF_SIZE * DIRTY_BUFF_NUM AS BUFFER_DIRTY_BYTES,
  BUFF_SIZE * LRU_BUFF_NUM AS BUFFER_LRU_BYTES,
  SGA_BLK_SIZE * TOTAL_SGA_MEM AS SGA_TOTAL_BYTES,
  SGA_BLK_SIZE * FREE_SGA_MEM AS SGA_FREE_BYTES,
  SGA_BLK_SIZE * PEAK_SGA_MEM AS SGA_PEAK_BYTES,
  SWAP_BLK_SIZE * TOTAL_SWAP_MEM AS SWAP_TOTAL_BYTES,
  SWAP_BLK_SIZE * FREE_SWAP_MEM AS SWAP_FREE_BYTES
FROM SYS_ALL_MEM_STATUS
ORDER BY NODEID;`.trim();

export const XUGU_TABLESPACE_SUMMARY_SQL = `
SELECT
  T.NODEID AS NODE_ID,
  T.SPACE_NAME,
  T.SPACE_TYPE,
  T.DATAFILE_NUM AS DATAFILES,
  T.MEDIA_ERROR,
  T.TOTAL_CHUNK_NUM * C.CHUNK_SIZE AS TOTAL_BYTES,
  T.FREE_CHUNK_NUM * C.CHUNK_SIZE AS FREE_BYTES
FROM SYS_ALL_TABLESPACES T, SYS_CTL_VARS C
ORDER BY T.NODEID, T.SPACE_NAME;`.trim();

export function connectionSupportsXuguServerDashboard(connection: ConnectionConfig | undefined): boolean {
  return !!connection && effectiveDatabaseTypeForConnection(connection) === "xugu";
}

export function xuguClusterNodeStateLabel(state: string): "joining" | "running" | "error" | "offline" | "unknown" {
  switch (Number(state)) {
    case 1:
      return "joining";
    case 2:
      return "running";
    case 3:
      return "error";
    case 4:
      return "offline";
    default:
      return "unknown";
  }
}

export type XuguClusterNodeRole = "master" | "standby" | "storage" | "query" | "worker" | "change";

export function xuguClusterNodeTypeLabels(type: string): XuguClusterNodeRole[] {
  const value = Number(type);
  if (!Number.isFinite(value) || value <= 0) return [];
  const roles: Array<[number, XuguClusterNodeRole]> = [
    [1, "master"],
    [2, "standby"],
    [4, "storage"],
    [8, "query"],
    [16, "worker"],
    [32, "change"],
  ];
  return roles.filter(([bit]) => (value & bit) === bit).map(([, role]) => role);
}

export function xuguClusterNodesFromResult(result: QueryResult): XuguClusterNode[] {
  return result.rows.map((row) => ({
    nodeId: valueAt(result, row, "NODE_ID"),
    rackNo: valueAt(result, row, "RACK_NO"),
    host: valueAt(result, row, "NODE_IP"),
    port: valueAt(result, row, "NODE_PORT"),
    nodeType: valueAt(result, row, "NODE_TYPE"),
    state: valueAt(result, row, "NODE_STATE"),
    cpuLoad: valueAt(result, row, "CPU_LOAD"),
    bootTime: valueAt(result, row, "BOOT_TIME"),
    storeCount: valueAt(result, row, "STORE_NUM"),
    majorCount: valueAt(result, row, "MAJOR_NUM"),
  }));
}

export function xuguRunInfoFromResult(result: QueryResult): XuguRunInfo[] {
  return result.rows.map((row) => ({
    nodeId: valueAt(result, row, "NODEID"),
    activeTransactions: valueAt(result, row, "ACT_TRANS_NUM"),
    diskReadCount: valueAt(result, row, "DISK_R_N"),
    diskReadBytes: valueAt(result, row, "DISK_R_BYTES"),
    diskWriteCount: valueAt(result, row, "DISK_W_N"),
    diskWriteBytes: valueAt(result, row, "DISK_W_BYTES"),
    maxTransactionId: valueAt(result, row, "MAX_TRANS_ID"),
    minTransactionId: valueAt(result, row, "MIN_TRANS_ID"),
    xlogWritePosition: valueAt(result, row, "XLOG_WPOS"),
    xlogCheckpointPosition: valueAt(result, row, "XLOG_CKPT"),
    freeStores: valueAt(result, row, "FREE_STO_N"),
  }));
}

export function xuguSessionSummaryFromResult(result: QueryResult): XuguSessionSummary[] {
  return result.rows.map((row) => ({
    nodeId: valueAt(result, row, "NODE_ID"),
    sessions: valueAt(result, row, "SESSIONS"),
    activeSessions: valueAt(result, row, "ACTIVE_SESSIONS"),
    memoryBytes: valueAt(result, row, "MEMORY_BYTES"),
    oldestStatement: valueAt(result, row, "OLDEST_STATEMENT"),
  }));
}

export function xuguTransactionSummaryFromResult(result: QueryResult): XuguTransactionSummary[] {
  return result.rows.map((row) => ({
    nodeId: valueAt(result, row, "NODE_ID"),
    activeTransactions: valueAt(result, row, "ACTIVE_TRANSACTIONS"),
    oldestTransaction: valueAt(result, row, "OLDEST_TRANSACTION"),
  }));
}

export function xuguMemoryStatusFromResult(result: QueryResult): XuguMemoryStatus[] {
  return result.rows.map((row) => ({
    nodeId: valueAt(result, row, "NODEID"),
    bufferTotalBytes: valueAt(result, row, "BUFFER_TOTAL_BYTES"),
    bufferFreeBytes: valueAt(result, row, "BUFFER_FREE_BYTES"),
    bufferDirtyBytes: valueAt(result, row, "BUFFER_DIRTY_BYTES"),
    bufferLruBytes: valueAt(result, row, "BUFFER_LRU_BYTES"),
    sgaTotalBytes: valueAt(result, row, "SGA_TOTAL_BYTES"),
    sgaFreeBytes: valueAt(result, row, "SGA_FREE_BYTES"),
    sgaPeakBytes: valueAt(result, row, "SGA_PEAK_BYTES"),
    swapTotalBytes: valueAt(result, row, "SWAP_TOTAL_BYTES"),
    swapFreeBytes: valueAt(result, row, "SWAP_FREE_BYTES"),
  }));
}

export function xuguSessionStatusSummaryFromResult(result: QueryResult): XuguSessionStatusSummary[] {
  return result.rows.map((row) => ({
    nodeId: valueAt(result, row, "NODE_ID"),
    status: valueAt(result, row, "STATUS"),
    sessions: valueAt(result, row, "SESSIONS"),
  }));
}

export function xuguLockModeSummaryFromResult(result: QueryResult): XuguLockModeSummary[] {
  return result.rows.map((row) => ({
    nodeId: valueAt(result, row, "NODE_ID"),
    lockMode: valueAt(result, row, "LOCK_MODE"),
    locks: valueAt(result, row, "LOCKS"),
  }));
}

export function xuguTablespaceSummaryFromResult(result: QueryResult): XuguTablespaceSummary[] {
  return result.rows.map((row) => ({
    nodeId: valueAt(result, row, "NODE_ID"),
    spaceName: valueAt(result, row, "SPACE_NAME"),
    spaceType: valueAt(result, row, "SPACE_TYPE"),
    datafiles: valueAt(result, row, "DATAFILES"),
    mediaError: valueAt(result, row, "MEDIA_ERROR"),
    totalBytes: valueAt(result, row, "TOTAL_BYTES"),
    freeBytes: valueAt(result, row, "FREE_BYTES"),
  }));
}

export function xuguScalarFromResult(result: QueryResult, column: string): string {
  return result.rows.length > 0 ? valueAt(result, result.rows[0], column) : "";
}

export function xuguVersionFromResult(result: QueryResult): string {
  return xuguScalarFromResult(result, "VERSION");
}

function valueAt(result: QueryResult, row: unknown[], column: string): string {
  const index = result.columns.findIndex((candidate) => candidate.toUpperCase() === column.toUpperCase());
  return index < 0 || row[index] == null ? "" : String(row[index]);
}
