import { describe, expect, it } from "vitest";
import { dorisGrantPrivilegesSql, dorisGrantsResult, dorisPrivilegeTargetSql, dorisUsersResult, getDatabaseUserAdminProvider, kingbaseShowGrantsSql, mysqlPrivilegeSelectionFromGrants } from "@/lib/database/databaseUserAdmin";
import type { QueryResult } from "@/types/database";

function result(columns: string[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, affected_rows: 0, execution_time_ms: 1 };
}

describe("MySQL grant privilege selection", () => {
  const availablePrivileges = ["SELECT", "INSERT", "UPDATE", "EXECUTE"];

  it("expands ALL PRIVILEGES and reads WITH GRANT OPTION for the current scope", () => {
    expect(
      mysqlPrivilegeSelectionFromGrants({
        grants: ["grant all privileges on `*`.* to 'root'@'%' WITH GRANT OPTION"],
        database: "*",
        table: "*",
        availablePrivileges,
      }),
    ).toEqual({ privileges: availablePrivileges, grantOption: true });
  });

  it("merges matching grants case-insensitively", () => {
    expect(
      mysqlPrivilegeSelectionFromGrants({
        grants: ["GRANT SELECT, insert ON `Sales`.`Orders` TO 'app'@'%'", "GRANT UPDATE ON sales.orders TO 'app'@'%' WITH GRANT OPTION"],
        database: "SALES",
        table: "orders",
        availablePrivileges,
      }),
    ).toEqual({ privileges: ["SELECT", "INSERT", "UPDATE"], grantOption: true });
  });

  it("supports escaped backticks and ignores grants for other scopes or routines", () => {
    expect(
      mysqlPrivilegeSelectionFromGrants({
        grants: ["GRANT SELECT ON `tenant``db`.`audit``log` TO 'app'@'%'", "GRANT INSERT ON `tenant``db`.* TO 'app'@'%' WITH GRANT OPTION", "GRANT EXECUTE ON PROCEDURE `tenant``db`.`audit``log` TO 'app'@'%' WITH GRANT OPTION"],
        database: "tenant`db",
        table: "audit`log",
        availablePrivileges,
      }),
    ).toEqual({ privileges: ["SELECT"], grantOption: false });
  });

  it("returns an empty selection when the current scope has no grant", () => {
    expect(
      mysqlPrivilegeSelectionFromGrants({
        grants: ["GRANT SELECT ON `other`.* TO 'app'@'%' WITH GRANT OPTION"],
        database: "current",
        table: "*",
        availablePrivileges,
      }),
    ).toEqual({ privileges: [], grantOption: false });
  });
});

describe("database user admin providers", () => {
  it("uses Doris 2.x user and privilege syntax", () => {
    const provider = getDatabaseUserAdminProvider("doris");

    expect(provider?.listUsersSql()).toBe("SHOW ALL GRANTS;");
    expect(provider?.showGrantsSql({ user: "reporter", host: "%" })).toBe("SHOW GRANTS FOR 'reporter'@'%';");
    expect(provider?.alterPasswordSql?.({ user: "reporter", host: "%" }, "new'secret")).toBe("SET PASSWORD FOR 'reporter'@'%' = PASSWORD('new''secret');");
    expect(dorisPrivilegeTargetSql("analytics", "daily`rollup")).toBe("`internal`.`analytics`.`daily``rollup`");
    expect(dorisGrantPrivilegesSql({ user: { user: "reporter", host: "%" }, privileges: ["select_priv", "LOAD_PRIV"], database: "analytics", grantOption: true })).toBe("GRANT SELECT_PRIV, LOAD_PRIV ON `internal`.`analytics`.* TO 'reporter'@'%';");
    expect(provider?.alterLoginSql).toBeUndefined();
    expect(provider?.privilegesForScope?.("table")).toEqual(["SELECT_PRIV", "LOAD_PRIV", "ALTER_PRIV", "CREATE_PRIV", "DROP_PRIV", "SHOW_VIEW_PRIV"]);
  });

  it("parses Doris SHOW GRANTS users and structured privileges", () => {
    const grants = result(["UserIdentity", "Comment", "Password", "Roles", "GlobalPrivs", "DatabasePrivs", "TablePrivs"], [["'root'@'%'", "ROOT", "No", "operator", "Admin_priv", "internal.analytics: Select_priv", null]]);

    expect(dorisUsersResult(grants)).toEqual([{ user: "root", host: "%" }]);
    expect(dorisGrantsResult(grants)).toEqual(["Roles: operator", "GlobalPrivs: Admin_priv", "DatabasePrivs: internal.analytics: Select_priv"]);
  });

  it("syncs loaded grants only for the MySQL provider", () => {
    const mysqlProvider = getDatabaseUserAdminProvider("mysql");
    const dorisProvider = getDatabaseUserAdminProvider("doris");
    const postgresProvider = getDatabaseUserAdminProvider("postgres");
    const starrocksProvider = getDatabaseUserAdminProvider("starrocks");

    expect(
      mysqlProvider?.privilegeSelectionFromGrants?.({
        grants: ["GRANT INSERT ON `app`.* TO 'user'@'%'"],
        database: "app",
        table: "*",
        availablePrivileges: mysqlProvider.privilegesForScope?.("mysql") ?? [],
      }),
    ).toEqual({ privileges: ["INSERT"], grantOption: false });
    expect(postgresProvider?.privilegeSelectionFromGrants).toBeUndefined();
    expect(dorisProvider?.privilegeSelectionFromGrants).toBeUndefined();
    expect(starrocksProvider?.privilegeSelectionFromGrants).toBeUndefined();
    expect(mysqlProvider?.defaultPrivilegesForScope?.("mysql")).toEqual(["SELECT"]);
    expect(postgresProvider?.defaultPrivilegesForScope?.("database")).toEqual(["CONNECT"]);
    expect(dorisProvider?.defaultPrivilegesForScope?.("table")).toEqual(["SELECT_PRIV"]);
    expect(starrocksProvider?.defaultPrivilegesForScope?.("table")).toEqual(["SELECT"]);
  });

  it("uses sys_catalog for Kingbase role metadata", () => {
    const provider = getDatabaseUserAdminProvider("kingbase");

    expect(provider).not.toBeNull();
    expect(provider?.dialect).toBe("postgres");
    expect(provider?.listUsersSql()).toContain("FROM sys_catalog.sys_roles r");
    expect(provider?.listUsersSql()).not.toContain("pg_catalog");
  });

  it("builds Kingbase grant SQL without PostgreSQL catalog tables", () => {
    const sql = kingbaseShowGrantsSql({ user: "role'o", host: "LOGIN" });

    expect(sql).toContain("FROM sys_catalog.sys_roles r");
    expect(sql).toContain("FROM sys_catalog.sys_auth_members m");
    expect(sql).toContain("CROSS JOIN sys_catalog.sys_database d");
    expect(sql).toContain("CROSS JOIN sys_catalog.sys_namespace n");
    expect(sql).toContain("WHERE r.rolname = 'role''o'");
    expect(sql).not.toContain("pg_catalog");
    expect(sql).not.toContain("pg_roles");
  });
});
