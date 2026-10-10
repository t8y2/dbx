import { describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, QueryResult } from "@/types/database";
import { loadOracleSecurity, oracleGrantSources, oracleObjectGrantSources, oracleSecurityObjectMatches, supportsOracleSecurity, ORACLE_SECURITY_ROW_LIMIT } from "@/lib/database/oracleSecurity";
import { connectionSupportsDatabaseUserAdmin } from "@/lib/database/databaseUserAdmin";

const result = (columns: string[], rows: unknown[][] = []) => ({ columns, rows, affected_rows: 0, execution_time_ms: 0 }) as QueryResult;
const blankQuery = async (sql: string) => (sql.includes("FROM DUAL") ? result(["USERNAME"], [["Reader"]]) : result([]));

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

  it("enables the connected user-admin entry only for the Oracle family", () => {
    for (const db_type of ["oracle", "oceanbase-oracle"] as const) {
      const config = { id: db_type, db_type } as ConnectionConfig;
      expect(supportsOracleSecurity(config)).toBe(true);
      expect(connectionSupportsDatabaseUserAdmin(config)).toBe(true);
    }
    expect(supportsOracleSecurity({ db_type: "mysql" } as ConnectionConfig)).toBe(false);
  });
});
