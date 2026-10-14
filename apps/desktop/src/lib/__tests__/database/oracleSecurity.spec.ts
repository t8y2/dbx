import { describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, QueryResult } from "@/types/database";
import { loadOracleSecurity, oracleGrantSources, oracleObjectGrantSources, oracleSecurityObjectMatches, oracleWriteRejected, parseOracleErrorCode, supportsOracleSecurity, ORACLE_SECURITY_ROW_LIMIT } from "@/lib/database/oracleSecurity";
import { connectionSupportsDatabaseUserAdmin } from "@/lib/database/databaseUserAdmin";

const result = (columns: string[], rows: unknown[][] = []) => ({ columns, rows, affected_rows: 0, execution_time_ms: 0 }) as QueryResult;
const blankQuery = async (sql: string) => (sql.includes("FROM DUAL") ? result(["USERNAME"], [["Reader"]]) : result([]));

describe("Oracle write rejection classification", () => {
  it("classifies rejection by error code, independent of any locale text", () => {
    expect(parseOracleErrorCode("ORA-01031: insufficient privileges")).toEqual({ prefix: "ORA", code: "01031" });
    expect(parseOracleErrorCode("Error: OBE-00942: table or view does not exist")).toEqual({ prefix: "OBE", code: "00942" });
    expect(parseOracleErrorCode("connection reset")).toBeNull();
    expect(oracleWriteRejected("ORA-01031: insufficient privileges", true)).toBe(true);
    expect(oracleWriteRejected("ORA-03113: end-of-file on communication channel", true)).toBe(false);
    // Transport errors can also arrive as execution errors; only refusal codes establish rejection.
    expect(oracleWriteRejected("ORA-01031: insufficient privileges", false)).toBe(false);
    expect(oracleWriteRejected("connection reset", true)).toBe(false);
  });
});

describe("Oracle security dictionary reads", () => {
  it("uses only SELECTs and exposes exact quoted identities and grant options", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM DBA_USERS"))
        return result(
          ["USERNAME", "ACCOUNT_STATUS"],
          [
            ["Reader", "OPEN"],
            ["READER", "LOCKED"],
          ],
        );
      if (sql.includes("FROM DBA_TAB_PRIVS")) return result(["GRANTEE", "OWNER", "TABLE_NAME", "GRANTOR", "PRIVILEGE", "GRANTABLE"], [["Reader", "Owner", "Mixed.Name", "Owner", "SELECT", "YES"]]);
      return blankQuery(sql);
    });
    const snapshot = await loadOracleSecurity(query);
    expect(snapshot.users.rows.map((user) => user.name)).toEqual(["Reader", "READER"]);
    expect(snapshot.objectGrants.rows[0]).toMatchObject({ owner: "Owner", objectName: "Mixed.Name", grantable: true });
    expect(query.mock.calls.every(([sql]) => /^SELECT\s/.test(sql))).toBe(true);
    expect(query.mock.calls.filter(([sql]) => /FROM DBA_(TAB|COL)_PRIVS/.test(sql)).every(([sql]) => !/ORDER BY/i.test(sql))).toBe(true);
    expect(oracleSecurityObjectMatches(snapshot.objectGrants.rows[0], "OWNER", "Mixed.Name")).toBe(false);
  });

  it("marks fallback visibility as limited without concealing the denied primary read", async () => {
    const snapshot = await loadOracleSecurity(async (sql) => {
      if (sql.includes("FROM DBA_USERS")) throw new Error("ORA-01031: insufficient privileges");
      if (sql.includes("FROM ALL_USERS")) return result(["USERNAME"], [["Reader"]]);
      return blankQuery(sql);
    });
    expect(snapshot.users).toMatchObject({ state: "ok", visibility: "limited", rows: [{ name: "Reader" }] });
    expect(snapshot.users.message).toContain("ORA-01031");
    expect(snapshot.users.rows[0].accountStatus).toBeUndefined();
  });

  it("falls back when OceanBase names an inaccessible dictionary view in OBE-00942", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM DBA_USERS")) throw new Error("OBE-00942: table or view 'SYS.DBA_USERS' does not exist");
      if (sql.includes("FROM ALL_USERS")) return result(["USERNAME"], [["Reader"]]);
      return blankQuery(sql);
    });
    const snapshot = await loadOracleSecurity(query, { db_type: "oceanbase-oracle" } as ConnectionConfig);
    expect(snapshot.users).toMatchObject({ state: "ok", visibility: "limited", rows: [{ name: "Reader" }] });
    expect(snapshot.users.message).toContain("OBE-00942");
    expect(query.mock.calls.some(([sql]) => sql.includes("FROM ALL_USERS"))).toBe(true);
  });

  it.each(["table or view does not exist", "table or view 'SYS.DBA_USERS' does not exist"])("falls back when a dictionary view is unavailable without an error code: %s", async (message) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM DBA_USERS")) throw new Error(message);
      if (sql.includes("FROM ALL_USERS")) return result(["USERNAME"], [["Reader"]]);
      return blankQuery(sql);
    });
    const snapshot = await loadOracleSecurity(query, { db_type: "oceanbase-oracle" } as ConnectionConfig);
    expect(snapshot.users).toMatchObject({ state: "ok", visibility: "limited", rows: [{ name: "Reader" }] });
    expect(snapshot.users.message).toContain(message);
    expect(query.mock.calls.some(([sql]) => sql.includes("FROM ALL_USERS"))).toBe(true);
  });

  it("falls back on OBE-01031 and preserves the insufficient-privilege reason", async () => {
    const snapshot = await loadOracleSecurity(
      async (sql) => {
        if (sql.includes("FROM DBA_USERS")) throw new Error("OBE-01031: insufficient privileges");
        if (sql.includes("FROM ALL_USERS")) return result(["USERNAME"], [["Reader"]]);
        return blankQuery(sql);
      },
      { db_type: "oceanbase-oracle" } as ConnectionConfig,
    );
    expect(snapshot.users).toMatchObject({ state: "ok", visibility: "limited", rows: [{ name: "Reader" }] });
    expect(snapshot.users.message).toContain("OBE-01031");
  });

  it.each(["OBE-00944: table or view 'SYS.DBA_USERS' does not exist", "OBE-009420: table or view 'SYS.DBA_USERS' does not exist", "XOBE-00942: table or view 'SYS.DBA_USERS' does not exist"])("does not use the dictionary fallback for unknown or approximate OBE codes: %s", async (message) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM DBA_USERS")) throw new Error(message);
      if (sql.includes("FROM ALL_USERS")) return result(["USERNAME"], [["Reader"]]);
      return blankQuery(sql);
    });
    const snapshot = await loadOracleSecurity(query, { db_type: "oceanbase-oracle" } as ConnectionConfig);
    expect(snapshot.users.state).toBe("error");
    expect(query.mock.calls.some(([sql]) => sql.includes("FROM ALL_USERS"))).toBe(false);
  });

  it("distinguishes empty, denied, inaccessible and unexpected errors", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM DBA_USERS") || sql.includes("FROM ALL_USERS")) throw new Error("ORA-01031");
      if (sql.includes("FROM DBA_ROLES") || sql.includes("FROM USER_ROLE_PRIVS")) throw new Error("ORA-00942");
      if (sql.includes("FROM DBA_SYS_PRIVS")) throw new Error("connection lost");
      return blankQuery(sql);
    });
    const snapshot = await loadOracleSecurity(query);
    expect(snapshot.users.state).toBe("denied");
    expect(snapshot.roles.state).toBe("unavailable");
    expect(snapshot.systemGrants.state).toBe("error");
    expect(snapshot.objectGrants.state).toBe("empty");
    expect(query.mock.calls.some(([sql]) => sql.includes("FROM USER_SYS_PRIVS"))).toBe(false);
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("reads restricted role and column dictionaries with %s column names", async (db_type) => {
    const oceanbase = db_type === "oceanbase-oracle";
    const snapshot = await loadOracleSecurity(
      async (sql) => {
        if (/FROM DBA_/.test(sql)) throw new Error("ORA-00942");
        if (sql.includes("FROM USER_ROLE_PRIVS UNION")) {
          const expected = oceanbase ? "SELECT GRANTEE," : "SELECT USERNAME AS GRANTEE,";
          if (!sql.startsWith(expected)) throw new Error("ORA-00904: invalid role grantee");
          return result(
            ["GRANTEE", "GRANTED_ROLE", "ADMIN_OPTION", "DEFAULT_ROLE"],
            [
              ["Reader", "R1", "NO", "YES"],
              ["R1", "R2", "NO", null],
            ],
          );
        }
        if (sql.includes("FROM ALL_COL_PRIVS")) {
          const expected = oceanbase ? "SELECT GRANTEE, OWNER," : "SELECT GRANTEE, TABLE_SCHEMA AS OWNER,";
          if (!sql.startsWith(expected)) throw new Error("ORA-00904: invalid column owner");
          return result(["GRANTEE", "OWNER", "TABLE_NAME", "COLUMN_NAME", "GRANTOR", "PRIVILEGE", "GRANTABLE"], [["R2", "Owner", "Quoted.Table", "Mixed.Col", "Owner", "UPDATE", "NO"]]);
        }
        if (sql.includes("FROM ALL_TAB_PRIVS")) {
          expect(sql).toContain("TABLE_SCHEMA AS OWNER");
          return result(["GRANTEE", "OWNER", "TABLE_NAME", "GRANTOR", "PRIVILEGE", "GRANTABLE"], [["Reader", "Owner", "Quoted.Table", "Owner", "SELECT", "YES"]]);
        }
        return blankQuery(sql);
      },
      { db_type } as ConnectionConfig,
    );
    expect(snapshot.roleGrants).toMatchObject({ state: "ok", visibility: "limited" });
    expect(snapshot.columnGrants).toMatchObject({ state: "ok", visibility: "limited" });
    expect(snapshot.columnGrants.message).toContain("ORA-00942");
    expect(oracleGrantSources(snapshot, "Reader").grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "role", rolePath: ["R1", "R2"], grant: expect.objectContaining({ owner: "Owner", objectName: "Quoted.Table", columnName: "Mixed.Col", privilege: "UPDATE" }) }),
        expect.objectContaining({ source: "direct", grant: expect.objectContaining({ privilege: "SELECT", grantable: true }) }),
      ]),
    );
  });

  it("does not treat a capped dictionary response as complete", async () => {
    const snapshot = await loadOracleSecurity(async (sql) =>
      sql.includes("FROM DBA_USERS")
        ? result(
            ["USERNAME"],
            Array.from({ length: ORACLE_SECURITY_ROW_LIMIT }, (_, i) => [`U${i}`]),
          )
        : blankQuery(sql),
    );
    expect(snapshot.users).toMatchObject({ visibility: "limited", truncated: true });
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("includes visible role/public object and column grants without inventing grantors for %s", async (db_type) => {
    const snapshot = await loadOracleSecurity(
      async (sql) => {
        if (/FROM DBA_/.test(sql)) throw new Error("ORA-00942");
        if (sql.includes("FROM USER_ROLE_PRIVS UNION"))
          return result(
            ["GRANTEE", "GRANTED_ROLE", "ADMIN_OPTION"],
            [
              ["Reader", "R1", "NO"],
              ["R1", "R2", "NO"],
            ],
          );
        if (sql.includes("FROM ALL_TAB_PRIVS")) {
          expect(sql).toContain("R.COLUMN_NAME IS NULL AND NOT EXISTS");
          expect(sql).toContain("A.TABLE_SCHEMA = R.OWNER");
          const rows = [["Reader", "Owner", "T", "Owner", "SELECT", "YES"]];
          if (sql.includes("FROM ROLE_TAB_PRIVS")) rows.push(["R2", "Owner", "T", "", "SELECT", "NO"], ["PUBLIC", "Owner", "T", "", "SELECT", "NO"]);
          return result(["GRANTEE", "OWNER", "TABLE_NAME", "GRANTOR", "PRIVILEGE", "GRANTABLE"], rows);
        }
        if (sql.includes("FROM ALL_COL_PRIVS")) {
          expect(sql).toContain("R.COLUMN_NAME IS NOT NULL AND NOT EXISTS");
          expect(sql).toContain(`A.${db_type === "oceanbase-oracle" ? "OWNER" : "TABLE_SCHEMA"} = R.OWNER`);
          return result(["GRANTEE", "OWNER", "TABLE_NAME", "COLUMN_NAME", "GRANTOR", "PRIVILEGE", "GRANTABLE"], sql.includes("FROM ROLE_TAB_PRIVS") ? [["R2", "Owner", "T", "Col", null, "UPDATE", "NO"]] : []);
        }
        return blankQuery(sql);
      },
      { db_type } as ConnectionConfig,
    );
    const sources = oracleGrantSources(snapshot, "Reader").grants;
    expect(sources.map((row) => [row.kind, row.source])).toEqual([
      ["object", "direct"],
      ["object", "role"],
      ["column", "role"],
      ["object", "public"],
    ]);
    expect(sources[1]).toMatchObject({ rolePath: ["R1", "R2"], grant: { grantor: "" } });
    expect(sources[2].grant).toMatchObject({ columnName: "Col", grantor: "" });
    expect(snapshot.objectGrants).toMatchObject({ visibility: "limited", message: "Error: ORA-00942" });
  });

  it.each(["truncated", "has_more"] as const)("keeps short dictionary responses limited when the backend reports %s", async (flag) => {
    const snapshot = await loadOracleSecurity(async (sql) => (sql.includes("FROM DBA_USERS") ? { ...result(["USERNAME"], [["Reader"]]), [flag]: true } : blankQuery(sql)));
    expect(snapshot.users).toMatchObject({ state: "ok", visibility: "limited", truncated: true });
  });

  it("preserves direct, role and public paths and terminates role cycles", async () => {
    const snapshot = await loadOracleSecurity(blankQuery);
    snapshot.roleGrants.rows = [
      { grantee: "Reader", role: "R1", adminOption: false },
      { grantee: "R1", role: "R2", adminOption: false },
      { grantee: "R2", role: "R1", adminOption: false },
      { grantee: "PUBLIC", role: "R2", adminOption: false },
    ];
    snapshot.systemGrants.rows = ["Reader", "R2", "PUBLIC"].map((grantee) => ({ grantee, privilege: "CREATE SESSION", adminOption: false }));
    const sources = oracleGrantSources(snapshot, "Reader");
    expect(sources.bounded).toBe(false);
    expect(sources.grants.map((row) => [row.grant.grantee, row.source])).toEqual([
      ["Reader", "direct"],
      ["R2", "role"],
      ["R2", "public"],
      ["PUBLIC", "public"],
    ]);
    expect(sources.grants[1].rolePath).toEqual(["R1", "R2"]);
    expect(sources.grants[2].rolePath).toEqual(["PUBLIC", "R2"]);
  });

  it("lets the object view inspect grants for every visible principal", async () => {
    const snapshot = await loadOracleSecurity(blankQuery);
    snapshot.objectGrants.rows = ["A", "B"].map((grantee) => ({ grantee, owner: "Owner", objectName: "T", grantor: "Owner", privilege: "SELECT", grantable: false }));
    expect(oracleObjectGrantSources(snapshot).map((row) => row.grant.grantee)).toEqual(["A", "B"]);
  });

  it("keeps one discovered path per role when inheritance paths converge", async () => {
    const snapshot = await loadOracleSecurity(blankQuery);
    snapshot.roleGrants.rows = [
      { grantee: "Reader", role: "R1", adminOption: false },
      { grantee: "Reader", role: "R2", adminOption: false },
      { grantee: "R1", role: "R3", adminOption: false },
      { grantee: "R2", role: "R3", adminOption: false },
      { grantee: "PUBLIC", role: "R3", adminOption: false },
    ];
    snapshot.systemGrants.rows = [{ grantee: "R3", privilege: "CREATE SESSION", adminOption: false }];
    expect(oracleGrantSources(snapshot, "Reader").grants).toEqual([expect.objectContaining({ source: "role", rolePath: ["R1", "R3"] }), expect.objectContaining({ source: "public", rolePath: ["PUBLIC", "R3"] })]);
  });

  it("bounds a large role graph without inventing inaccessible paths", async () => {
    const snapshot = await loadOracleSecurity(blankQuery);
    snapshot.roleGrants.rows = Array.from({ length: 1001 }, (_, i) => ({ grantee: i ? `R${i - 1}` : "Reader", role: `R${i}`, adminOption: false }));
    snapshot.systemGrants.rows = ["R998", "R999", "R1000"].map((grantee) => ({ grantee, privilege: "CREATE SESSION", adminOption: false }));
    const sources = oracleGrantSources(snapshot, "Reader");
    expect(sources.bounded).toBe(true);
    expect(sources.grants.map((row) => row.grant.grantee)).toEqual(["R998"]);
    expect(sources.grants[0].rolePath).toHaveLength(999);
  });

  it("handles execution-error results as failures rather than empty dictionaries", async () => {
    const snapshot = await loadOracleSecurity(async () => ({ ...result([]), execution_error: true, error: { code: "ORA-01031", detail: "ORA-01031: insufficient privileges" } }) as QueryResult);
    expect(snapshot.objectGrants).toMatchObject({ state: "denied", visibility: "limited", rows: [] });
  });

  it("supports identified Oracle JDBC without changing other user-admin providers", () => {
    expect(connectionSupportsDatabaseUserAdmin({ db_type: "jdbc", connection_string: "jdbc:oracle:thin:@//localhost:1521/XE" } as ConnectionConfig)).toBe(true);
    for (const db_type of ["mysql", "postgres"] as const) expect(connectionSupportsDatabaseUserAdmin({ db_type } as ConnectionConfig)).toBe(true);
    expect(connectionSupportsDatabaseUserAdmin({ db_type: "sqlite" } as ConnectionConfig)).toBe(false);
  });

  it("enables the connected user-admin entry only for the Oracle family", () => {
    for (const db_type of ["oracle", "oceanbase-oracle"] as const) {
      const config = { id: db_type, db_type } as ConnectionConfig;
      expect(supportsOracleSecurity(config)).toBe(true);
      expect(connectionSupportsDatabaseUserAdmin(config)).toBe(true);
    }
    expect(supportsOracleSecurity({ db_type: "mysql" } as ConnectionConfig)).toBe(false);
  });
});
