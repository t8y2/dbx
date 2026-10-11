import { describe, expect, it } from "vitest";
import { connectionSupportsProcessList, resolveProcessListDriver, resolveProcessListDriverForConnection } from "@/lib/database/processListDrivers";
import { assessProductionSql } from "@/lib/database/productionSafety";
import { buildXuguKillTransactionSql, mapXuguTransactionRows, XUGU_OWN_SESSION_SQL, XUGU_TRANSACTION_LIST_SQL, xuguTransactionKey } from "@/lib/database/xuguProcessList";

describe("Xugu active transaction management", () => {
  it("uses the system-wide active-transaction join, not all idle sessions", () => {
    expect(XUGU_TRANSACTION_LIST_SQL).toContain("FROM SYS_ALL_TRANS T");
    expect(XUGU_TRANSACTION_LIST_SQL).toContain("JOIN SYS_ALL_SESSIONS S");
    expect(XUGU_TRANSACTION_LIST_SQL).toContain("T.NODEID = S.NODEID AND T.TRANID = S.CURR_TID");
    expect(XUGU_TRANSACTION_LIST_SQL).toContain("CAST(T.TRANID AS VARCHAR(32))");
    expect(XUGU_OWN_SESSION_SQL).toContain("USERENV('SID')");
  });

  it("maps shuffled columns while preserving a BIGINT transaction id exactly", () => {
    const rows = mapXuguTransactionRows({
      columns: ["TRANSACTION_ID", "USER_NAME", "SESSION_ID", "NODE_ID", "CLIENT_IP", "START_TIME", "DB_NAME"],
      rows: [["9007199254740993", "APP_TEST", 7, 2, "10.0.0.1", "2026-09-30 10:00:00", "SHOP_DEMO"]],
    });
    expect(rows).toEqual([{ id: 7, nodeId: 2, transactionId: "9007199254740993", user: "APP_TEST", db: "SHOP_DEMO", host: "10.0.0.1", startTime: "2026-09-30 10:00:00" }]);
    expect(xuguTransactionKey(rows[0]!)).toBe("2:9007199254740993:7");
    expect(buildXuguKillTransactionSql(rows[0]!)).toBe("CALL DBMS_DBA.KILL_TRANS(2, 9007199254740993)");
  });

  it("distinguishes equal session and transaction numbers on different nodes", () => {
    const rows = mapXuguTransactionRows({
      columns: ["NODE_ID", "TRANSACTION_ID", "SESSION_ID", "USER_NAME"],
      rows: [
        [1, "123", 5, "A"],
        [2, "123", 5, "B"],
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map(xuguTransactionKey)).toEqual(["1:123:5", "2:123:5"]);
  });

  it("drops unusable identities and rejects unsafe SQL inputs", () => {
    expect(
      mapXuguTransactionRows({
        columns: ["NODE_ID", "TRANSACTION_ID", "SESSION_ID"],
        rows: [
          [1, "0", 2],
          [0, "12", 2],
          [1, "1; DROP TABLE X", 2],
          [1, "9223372036854775808", 2],
          [1, "12", "not-an-id"],
        ],
      }),
    ).toEqual([]);
    expect(() => buildXuguKillTransactionSql({ nodeId: 1, transactionId: "1); DROP TABLE X" })).toThrow("Invalid Xugu transaction target");
    expect(() => buildXuguKillTransactionSql({ nodeId: Number.MAX_SAFE_INTEGER + 1, transactionId: "2" })).toThrow("Invalid Xugu transaction target");
  });

  it("registers Xugu without changing the other process-list drivers", () => {
    const xugu = resolveProcessListDriver("xugu");
    expect(xugu?.mode).toBe("transaction");
    expect(xugu?.database).toBe("SYSTEM");
    expect(xugu?.buildCancelQuerySql).toBeUndefined();
    expect(xugu?.buildKillTransactionSql?.({ id: 7, nodeId: 2, transactionId: "9007199254740993" })).toBe("CALL DBMS_DBA.KILL_TRANS(2, 9007199254740993)");
    expect(xugu?.buildTerminateSessionSql).toBeUndefined();
    expect(xugu?.supportsBatchCancel).toBeUndefined();
    expect(resolveProcessListDriverForConnection({ id: "x", db_type: "xugu", username: "SYSDBA", database: "SHOP_DEMO" } as any)).toBe(xugu);
    for (const type of ["mysql", "postgres", "opengauss", "kingbase"] as const) {
      expect(resolveProcessListDriver(type)?.mode).toBeUndefined();
      expect(resolveProcessListDriver(type)?.database).toBeUndefined();
    }
  });

  it("only exposes Xugu transaction management to SYSDBA connections", () => {
    for (const username of ["SYSDBA", " sysdba "]) {
      expect(connectionSupportsProcessList({ id: "x", db_type: "xugu", username, database: "SHOP_DEMO" } as any)).toBe(true);
    }
    for (const username of ["APP_TEST", "DBX_7102_DBA", "", undefined]) {
      const connection = { id: "x", db_type: "xugu", username, database: "SYSTEM" } as any;
      expect(resolveProcessListDriverForConnection(connection)).toBeNull();
      expect(connectionSupportsProcessList(connection)).toBe(false);
    }
  });

  it("classifies termination as a protected write for production connections", () => {
    const sql = buildXuguKillTransactionSql({ nodeId: 1, transactionId: "42" });
    expect(assessProductionSql(sql, { id: "x", db_type: "xugu", is_production: true } as any, "SYSTEM")).toMatchObject({ active: true, isMutation: true });
  });
});
