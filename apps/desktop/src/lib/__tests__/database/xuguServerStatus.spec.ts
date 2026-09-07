import { describe, expect, it } from "vitest";
import {
  XUGU_ACTIVE_SESSION_SQL,
  XUGU_CLUSTER_NODES_SQL,
  XUGU_LOCK_MODE_SUMMARY_SQL,
  XUGU_LOCK_WAITS_SQL,
  XUGU_MEMORY_STATUS_SQL,
  XUGU_RUN_INFO_SQL,
  XUGU_SESSION_SUMMARY_SQL,
  XUGU_SESSION_STATUS_SUMMARY_SQL,
  XUGU_TABLESPACE_SUMMARY_SQL,
  XUGU_TRANSACTION_SUMMARY_SQL,
  XUGU_VERSION_SQL,
  connectionSupportsXuguServerDashboard,
  xuguClusterNodeStateLabel,
  xuguClusterNodeTypeLabels,
  xuguClusterNodesFromResult,
  xuguLockModeSummaryFromResult,
  xuguMemoryStatusFromResult,
  xuguRunInfoFromResult,
  xuguSessionSummaryFromResult,
  xuguSessionStatusSummaryFromResult,
  xuguTablespaceSummaryFromResult,
  xuguTransactionSummaryFromResult,
  xuguVersionFromResult,
} from "@/lib/database/xuguServerStatus";

describe("Xugu server status helpers", () => {
  it("keeps the first-phase catalog queries scoped to Xugu system views", () => {
    expect(XUGU_VERSION_SQL).toContain("VERSION()");
    expect(XUGU_CLUSTER_NODES_SQL).toContain("FROM SYS_CLUSTERS");
    expect(XUGU_RUN_INFO_SQL).toContain("FROM SYS_ALL_RUN_INFO");
    expect(XUGU_SESSION_SUMMARY_SQL).toContain("FROM SYS_ALL_SESSIONS");
    expect(XUGU_ACTIVE_SESSION_SQL).toContain("FROM SYS_ALL_THD_SESSION");
    expect(XUGU_ACTIVE_SESSION_SQL).toContain("JOIN SYS_ALL_SESSIONS");
    expect(XUGU_ACTIVE_SESSION_SQL).not.toMatch(/WHERE\s+STATE\s*=\s*1/i);
    expect(XUGU_TRANSACTION_SUMMARY_SQL).toContain("FROM SYS_ALL_TRANS");
    expect(XUGU_LOCK_WAITS_SQL).toContain("SYS_ALL_LWAITERS");
    expect(XUGU_LOCK_MODE_SUMMARY_SQL).toContain("SYS_ALL_LOWNERS");
    expect(XUGU_SESSION_STATUS_SUMMARY_SQL).toContain("FROM SYS_ALL_SESSIONS");
    expect(XUGU_MEMORY_STATUS_SQL).toContain("SYS_ALL_MEM_STATUS");
    expect(XUGU_TABLESPACE_SUMMARY_SQL).toContain("SYS_ALL_TABLESPACES");
  });

  it("recognizes native and JDBC Xugu connections only", () => {
    expect(connectionSupportsXuguServerDashboard({ id: "x", name: "Xugu", db_type: "xugu" } as any)).toBe(true);
    expect(connectionSupportsXuguServerDashboard({ id: "pg", name: "Postgres", db_type: "postgres" } as any)).toBe(false);
    expect(connectionSupportsXuguServerDashboard(undefined)).toBe(false);
  });

  it("maps documented node states and roles", () => {
    expect(xuguClusterNodeStateLabel("2")).toBe("running");
    expect(xuguClusterNodeStateLabel("4")).toBe("offline");
    expect(xuguClusterNodeTypeLabels("1")).toEqual(["master"]);
    expect(xuguClusterNodeTypeLabels("29")).toEqual(["master", "storage", "query", "worker"]);
    expect(xuguClusterNodeTypeLabels("0")).toEqual([]);
    expect(xuguClusterNodeStateLabel("999")).toBe("unknown");
  });

  it("parses status rows by column name instead of column order", () => {
    const nodes = xuguClusterNodesFromResult({
      columns: ["NODE_IP", "NODE_ID", "NODE_STATE", "NODE_TYPE", "NODE_PORT", "RACK_NO", "CPU_LOAD", "BOOT_TIME", "STORE_NUM", "MAJOR_NUM"],
      rows: [["127.0.0.1", 1, 2, 1, 5138, 0, 4, "2026-01-01", 10, 8]],
    });
    const runInfo = xuguRunInfoFromResult({
      columns: ["FREE_STO_N", "NODEID", "ACT_TRANS_NUM", "DISK_R_N", "DISK_R_BYTES", "DISK_W_N", "DISK_W_BYTES", "MAX_TRANS_ID", "MIN_TRANS_ID", "XLOG_WPOS", "XLOG_CKPT"],
      rows: [[11, 1, 2, 3, 4, 5, 6, 100, 99, 1000, 900]],
    });
    const sessions = xuguSessionSummaryFromResult({
      columns: ["MEMORY_BYTES", "SESSIONS", "NODE_ID", "ACTIVE_SESSIONS", "OLDEST_STATEMENT"],
      rows: [[1024, 4, 1, 2, "2026-01-01 00:00:00"]],
    });
    const transactions = xuguTransactionSummaryFromResult({
      columns: ["ACTIVE_TRANSACTIONS", "NODE_ID", "OLDEST_TRANSACTION"],
      rows: [[3, 1, "2026-01-01 00:00:00"]],
    });
    const memory = xuguMemoryStatusFromResult({
      columns: ["SGA_FREE_BYTES", "NODEID", "SGA_TOTAL_BYTES", "BUFFER_FREE_BYTES", "BUFFER_TOTAL_BYTES"],
      rows: [[20, 1, 100, 40, 200]],
    });
    const sessionStatuses = xuguSessionStatusSummaryFromResult({
      columns: ["SESSIONS", "STATUS", "NODE_ID"],
      rows: [[3, 112, 1]],
    });
    const lockModes = xuguLockModeSummaryFromResult({
      columns: ["LOCKS", "LOCK_MODE", "NODE_ID"],
      rows: [[3, "IS", 1]],
    });
    const tablespaces = xuguTablespaceSummaryFromResult({
      columns: ["FREE_BYTES", "TOTAL_BYTES", "MEDIA_ERROR", "DATAFILES", "SPACE_TYPE", "SPACE_NAME", "NODE_ID"],
      rows: [[10, 100, false, 1, "DATA_SPACE", "DATA1", 1]],
    });

    expect(nodes[0]).toMatchObject({ nodeId: "1", host: "127.0.0.1", state: "2", majorCount: "8" });
    expect(runInfo[0]).toMatchObject({ nodeId: "1", activeTransactions: "2", diskReadCount: "3", freeStores: "11", xlogWritePosition: "1000" });
    expect(sessions[0]).toMatchObject({ nodeId: "1", sessions: "4", activeSessions: "2", memoryBytes: "1024", oldestStatement: "2026-01-01 00:00:00" });
    expect(transactions[0]).toMatchObject({ nodeId: "1", activeTransactions: "3", oldestTransaction: "2026-01-01 00:00:00" });
    expect(memory[0]).toMatchObject({ nodeId: "1", sgaTotalBytes: "100", sgaFreeBytes: "20", bufferTotalBytes: "200" });
    expect(sessionStatuses[0]).toMatchObject({ nodeId: "1", status: "112", sessions: "3" });
    expect(lockModes[0]).toMatchObject({ nodeId: "1", lockMode: "IS", locks: "3" });
    expect(tablespaces[0]).toMatchObject({ nodeId: "1", spaceName: "DATA1", spaceType: "DATA_SPACE", totalBytes: "100" });
  });

  it("returns an empty value for missing or null values", () => {
    expect(xuguVersionFromResult({ columns: ["VERSION"], rows: [[null]] })).toBe("");
    expect(xuguVersionFromResult({ columns: ["OTHER"], rows: [["x"]] })).toBe("");
  });
});
