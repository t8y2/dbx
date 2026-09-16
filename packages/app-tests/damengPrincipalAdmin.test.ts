import { strict as assert } from "node:assert";
import { test } from "vitest";

import {
  DAMENG_SYSTEM_PRIVILEGES,
  DAMENG_SYSTEM_USERS,
  damengAlterUserPasswordSql,
  damengCreateRoleSql,
  damengCreateUserSql,
  damengDropRoleSql,
  damengDropUserSql,
  damengGrantRoleSql,
  damengGrantSystemPrivilegeSql,
  damengListRoleMembersSql,
  damengListRoleSysPrivsSql,
  damengListRolesSql,
  damengListTablespacesSql,
  damengListUserRolesSql,
  damengListUserSysPrivsSql,
  damengListUsersSql,
  damengLockUserSql,
  damengRevokeRoleSql,
  damengRevokeSystemPrivilegeSql,
  damengSystemPrivilegeMapSql,
  damengEnableDdlAnyPrivSql,
  isDamengAnyPrivilege,
  parseDamengEnableDdlAnyPriv,
  damengUnlockUserSql,
  damengUserTypeGrantSqls,
  parseDamengSystemPrivilegeMap,
  damengAvailableSystemPrivileges,
  canDamengAlterUserPassword,
  canDamengRevokeRoleGrant,
  DAMENG_HIDDEN_ROLES,
  damengRoleGraphSql,
  parseDamengRoleGraph,
  parseDamengRoleGrants,
  damengRolesClosure,
  isDamengSystemUser,
  damengUserGroup,
  isDamengPredefinedRole,
  DAMENG_USER_GROUPS,
  parseDamengRoles,
  parseDamengRolePrivs,
  parseDamengSysPrivs,
  parseDamengTablespaces,
  parseDamengUsers,
} from "../../apps/desktop/src/lib/database/damengPrincipalAdmin.ts";
import type { QueryResult } from "../../apps/desktop/src/types/database.ts";

function queryResult(columns: string[], rows: unknown[][]): QueryResult {
  return { columns, rows, types: [], success: true, rowCount: rows.length } as QueryResult;
}

test("user list SQL reads DBA_USERS ordered by username", () => {
  const sql = damengListUsersSql();
  assert.match(sql, /FROM\s+DBA_USERS/i);
  assert.match(sql, /ORDER BY\s+USERNAME/i);
  assert.match(sql, /USERNAME/i);
  assert.match(sql, /ACCOUNT_STATUS/i);
});

test("role list SQL reads DBA_ROLES ordered by role", () => {
  const sql = damengListRolesSql();
  assert.match(sql, /FROM\s+DBA_ROLES/i);
  assert.match(sql, /ORDER BY\s+ROLE/i);
});

test("tablespace list SQL reads DBA_TABLESPACES", () => {
  const sql = damengListTablespacesSql();
  assert.match(sql, /FROM\s+DBA_TABLESPACES/i);
  assert.match(sql, /ORDER BY\s+TABLESPACE_NAME/i);
});

test("role member SQL filters by granted role and orders by grantee", () => {
  const sql = damengListRoleMembersSql("APP_ROLE");
  assert.match(sql, /FROM\s+DBA_ROLE_PRIVS/i);
  assert.match(sql, /WHERE\s+GRANTED_ROLE\s*=\s*'APP_ROLE'/i);
  assert.match(sql, /ORDER BY\s+GRANTEE/i);
});

test("user roles SQL filters by grantee and orders by granted role", () => {
  const sql = damengListUserRolesSql("alice");
  assert.match(sql, /FROM\s+DBA_ROLE_PRIVS/i);
  assert.match(sql, /WHERE\s+GRANTEE\s*=\s*'alice'/i);
  assert.match(sql, /ORDER BY\s+GRANTED_ROLE/i);
});

test("user system privileges SQL filters by grantee", () => {
  const sql = damengListUserSysPrivsSql("alice");
  assert.match(sql, /FROM\s+DBA_SYS_PRIVS/i);
  assert.match(sql, /WHERE\s+GRANTEE\s*=\s*'alice'/i);
});

test("role system privileges SQL filters by grantee", () => {
  const sql = damengListRoleSysPrivsSql("APP_ROLE");
  assert.match(sql, /FROM\s+DBA_SYS_PRIVS/i);
  assert.match(sql, /WHERE\s+GRANTEE\s*=\s*'APP_ROLE'/i);
});

test("create user SQL quotes identifiers and escapes password", () => {
  assert.equal(
    damengCreateUserSql({ username: 'bob"x', password: 'p"wd', tablespace: "TS_DATA" }),
    `CREATE USER "bob""x" IDENTIFIED BY "p""wd" DEFAULT TABLESPACE "TS_DATA";`,
  );
});

test("create user SQL omits tablespace clause when not provided", () => {
  const sql = damengCreateUserSql({ username: "alice", password: "secret" });
  assert.match(sql, /^CREATE USER "alice" IDENTIFIED BY "secret";$/);
  assert.ok(!sql.includes("DEFAULT TABLESPACE"));
});

test("create user SQL appends ACCOUNT LOCK when locked", () => {
  const sql = damengCreateUserSql({ username: "alice", password: "secret", locked: true });
  assert.match(sql, /ACCOUNT LOCK;$/);
});

test("user type grants map to DM predefined roles", () => {
  assert.deepEqual(damengUserTypeGrantSqls("admin", "app_admin"), [`GRANT "DBA" TO "app_admin";`]);
  assert.deepEqual(damengUserTypeGrantSqls("auditor", "app_audit"), [`GRANT "DB_AUDIT_ADMIN" TO "app_audit";`]);
  assert.deepEqual(damengUserTypeGrantSqls("security", "app_sso"), [`GRANT "DB_POLICY_ADMIN" TO "app_sso";`]);
  assert.deepEqual(damengUserTypeGrantSqls("system", "app_sys"), []);
  assert.deepEqual(damengUserTypeGrantSqls("unknown", "x"), []);
});

test("alter password SQL quotes both values", () => {
  assert.equal(damengAlterUserPasswordSql("alice", 'new"pwd'), `ALTER USER "alice" IDENTIFIED BY "new""pwd";`);
});

test("lock and unlock SQL", () => {
  assert.equal(damengLockUserSql("alice"), `ALTER USER "alice" ACCOUNT LOCK;`);
  assert.equal(damengUnlockUserSql("alice"), `ALTER USER "alice" ACCOUNT UNLOCK;`);
});

test("drop user SQL uses CASCADE", () => {
  assert.equal(damengDropUserSql("alice"), `DROP USER "alice" CASCADE;`);
});

test("create and drop role SQL quote identifiers", () => {
  assert.equal(damengCreateRoleSql("APP_ROLE"), `CREATE ROLE "APP_ROLE";`);
  assert.equal(damengDropRoleSql('r"x'), `DROP ROLE "r""x";`);
});

test("grant and revoke role SQL", () => {
  assert.equal(damengGrantRoleSql("alice", "APP_ROLE"), `GRANT "APP_ROLE" TO "alice";`);
  assert.equal(damengRevokeRoleSql("alice", "APP_ROLE"), `REVOKE "APP_ROLE" FROM "alice";`);
});

test("grant system privilege SQL supports admin option", () => {
  assert.equal(damengGrantSystemPrivilegeSql("alice", "CREATE SESSION"), `GRANT CREATE SESSION TO "alice";`);
  assert.equal(damengGrantSystemPrivilegeSql("alice", "CREATE TABLE", true), `GRANT CREATE TABLE TO "alice" WITH ADMIN OPTION;`);
  assert.equal(damengRevokeSystemPrivilegeSql("alice", "CREATE SESSION"), `REVOKE CREATE SESSION FROM "alice";`);
});

test("system users are protected", () => {
  for (const name of DAMENG_SYSTEM_USERS) assert.equal(isDamengSystemUser(name), true, name);
  assert.equal(isDamengSystemUser("sysdba"), true);
  assert.equal(isDamengSystemUser("sysdbo"), true);
  assert.equal(isDamengSystemUser("SYSDBO"), true);
  assert.equal(isDamengSystemUser("sys"), true);
  assert.equal(isDamengSystemUser("alice"), false);
});

test("user grouping maps system accounts to categories and others to other", () => {
  assert.equal(damengUserGroup("SYSDBA"), "admin");
  assert.equal(damengUserGroup("SYSAUDITOR"), "auditor");
  assert.equal(damengUserGroup("SYSSSO"), "security");
  assert.equal(damengUserGroup("SYSDBO"), "system");
  assert.equal(damengUserGroup("sysdbo"), "system");
  assert.equal(damengUserGroup("SYS"), "system");
  assert.equal(damengUserGroup("sysdba"), "admin");
  assert.equal(damengUserGroup("alice"), "other");
  assert.deepEqual(DAMENG_USER_GROUPS, ["admin", "auditor", "security", "system", "other"]);
});

test("user grouping places regular users with management roles into matching categories", () => {
  // Directly granted DBA groups a regular user as admin.
  assert.equal(damengUserGroup("APP_ADMIN", ["DBA"]), "admin");
  assert.equal(damengUserGroup("APP_ADMIN", ["dba", "resource"]), "admin");
  assert.equal(damengUserGroup("APP_AUDIT", ["DB_AUDIT_ADMIN"]), "auditor");
  assert.equal(damengUserGroup("APP_SSO", ["DB_POLICY_ADMIN"]), "security");
  // System accounts keep their category regardless of granted roles.
  assert.equal(damengUserGroup("SYSDBA", ["RESOURCE"]), "admin");
  // No management role (or unknown roles) falls back to other.
  assert.equal(damengUserGroup("APP_READ", ["PUBLIC", "RESOURCE"]), "other");
  assert.equal(damengUserGroup("APP_READ"), "other");
});

test("parseDamengRoleGrants builds a grantee to role set map", () => {
  const grants = parseDamengRoleGrants({
    columns: ["GRANTEE", "GRANTED_ROLE"],
    rows: [
      ["APP_ADMIN", "DBA"],
      ["APP_ADMIN", "PUBLIC"],
      ["alice", "resource"],
    ],
  });
  assert.deepEqual([...grants.get("APP_ADMIN")!].sort(), ["DBA", "PUBLIC"]);
  assert.deepEqual([...grants.get("ALICE")!], ["RESOURCE"]);
  assert.equal(grants.get("nobody"), undefined);
});

test("system privilege catalog contains common session and DDL privileges", () => {
  assert.ok(DAMENG_SYSTEM_PRIVILEGES.includes("CREATE SESSION"));
  assert.ok(DAMENG_SYSTEM_PRIVILEGES.includes("CREATE TABLE"));
  assert.ok(DAMENG_SYSTEM_PRIVILEGES.includes("CREATE ANY TABLE"));
  assert.ok(DAMENG_SYSTEM_PRIVILEGES.includes("GRANT ANY PRIVILEGE"));
  assert.ok(DAMENG_SYSTEM_PRIVILEGES.includes("UNLIMITED TABLESPACE"));
});

test("parseDamengUsers maps rows to user objects with lock status", () => {
  const users = parseDamengUsers(
    queryResult(
      ["USERNAME", "ACCOUNT_STATUS", "DEFAULT_TABLESPACE", "TEMPORARY_TABLESPACE", "PROFILE", "CREATED"],
      [
        ["SYSDBA", "OPEN", "MAIN", "TEMP", "DEFAULT", "2024-01-01 00:00:00"],
        ["alice", "LOCKED", "TS_DATA", "TEMP", "DEFAULT", "2024-02-01 00:00:00"],
        ["bob", "EXPIRED", "MAIN", "TEMP", "DEFAULT", null],
      ],
    ),
  );
  assert.equal(users.length, 3);
  assert.deepEqual(users[0], {
    username: "SYSDBA",
    accountStatus: "OPEN",
    locked: false,
    defaultTablespace: "MAIN",
    temporaryTablespace: "TEMP",
    profile: "DEFAULT",
    created: "2024-01-01 00:00:00",
    raw: { USERNAME: "SYSDBA", ACCOUNT_STATUS: "OPEN", DEFAULT_TABLESPACE: "MAIN", TEMPORARY_TABLESPACE: "TEMP", PROFILE: "DEFAULT", CREATED: "2024-01-01 00:00:00" },
  });
  assert.equal(users[1].locked, true);
  assert.equal(users[1].accountStatus, "LOCKED");
  assert.equal(users[2].created, "");
});

test("parseDamengRoles maps rows", () => {
  const roles = parseDamengRoles(queryResult(["ROLE", "PASSWORD_REQUIRED"], [["APP_ROLE", "NO"]]));
  assert.equal(roles.length, 1);
  assert.equal(roles[0].role, "APP_ROLE");
  assert.equal(roles[0].passwordRequired, "NO");
});

test("parseDamengRolePrivs maps grants", () => {
  const privs = parseDamengRolePrivs(queryResult(["GRANTEE", "GRANTED_ROLE", "ADMIN_OPTION", "DEFAULT_ROLE"], [["alice", "APP_ROLE", "YES", "YES"]]));
  assert.deepEqual(privs, [{ grantee: "alice", grantedRole: "APP_ROLE", adminOption: true, defaultRole: true }]);
});

test("parseDamengSysPrivs maps privileges", () => {
  const privs = parseDamengSysPrivs(queryResult(["GRANTEE", "PRIVILEGE", "ADMIN_OPTION"], [["alice", "CREATE SESSION", "NO"]]));
  assert.deepEqual(privs, [{ grantee: "alice", privilege: "CREATE SESSION", adminOption: false }]);
});

test("parseDamengTablespaces returns table space names", () => {
  const spaces = parseDamengTablespaces(queryResult(["TABLESPACE_NAME", "STATUS"], [["MAIN", "ONLINE"], ["TS_DATA", "ONLINE"]]));
  assert.deepEqual(spaces, ["MAIN", "TS_DATA"]);
});

  test("canDamengAlterUserPassword follows the DM security model", () => {
  // SYS is a built-in non-login user with no password: never changeable.
  assert.equal(canDamengAlterUserPassword("SYSDBA", "SYS"), false);
  assert.equal(canDamengAlterUserPassword("SYS", "SYS"), false);
  // System admin passwords can only be changed by themselves (SYSDBA cannot
  // reset SYSSSO / SYSAUDITOR passwords).
  assert.equal(canDamengAlterUserPassword("SYSDBA", "SYSDBA"), true);
  assert.equal(canDamengAlterUserPassword("SYSDBA", "SYSSSO"), false);
  assert.equal(canDamengAlterUserPassword("SYSDBA", "SYSAUDITOR"), false);
  assert.equal(canDamengAlterUserPassword("SYSSSO", "SYSSSO"), true);
  assert.equal(canDamengAlterUserPassword("SYSAUDITOR", "SYSAUDITOR"), true);
  assert.equal(canDamengAlterUserPassword("SYSDBO", "SYSDBO"), true);
  assert.equal(canDamengAlterUserPassword("SYSDBA", "SYSDBO"), false);
  // SYSDBA can change any regular user's password.
  assert.equal(canDamengAlterUserPassword("SYSDBA", "alice"), true);
  // A regular user can only change their own password.
  assert.equal(canDamengAlterUserPassword("alice", "alice"), true);
  assert.equal(canDamengAlterUserPassword("alice", "bob"), false);
  assert.equal(canDamengAlterUserPassword("alice", "SYSDBA"), false);
  // Non-SYSDBA admins cannot change regular users.
  assert.equal(canDamengAlterUserPassword("SYSSSO", "alice"), false);
  assert.equal(canDamengAlterUserPassword("SYSAUDITOR", "alice"), false);
  // Matching is case-insensitive; undefined connection user cannot change anyone.
  assert.equal(canDamengAlterUserPassword("sysdba", "ALICE"), true);
  assert.equal(canDamengAlterUserPassword(undefined, "alice"), false);
  assert.equal(canDamengAlterUserPassword("SYSDBA", undefined), false);
});

test("role revoke policy permits direct predefined grants only for regular users", () => {
  assert.equal(canDamengRevokeRoleGrant("alice", { grantedRole: "DBA", inherited: false }), true);
  assert.equal(canDamengRevokeRoleGrant("alice", { grantedRole: "RESOURCE" }), true);
  assert.equal(canDamengRevokeRoleGrant("alice", { grantedRole: "VTI", inherited: true }), false);
  assert.equal(canDamengRevokeRoleGrant("alice", { grantedRole: "SVI", inherited: true }), false);
  assert.equal(canDamengRevokeRoleGrant("SYSDBO", { grantedRole: "DB_OBJECT_ADMIN", inherited: false }), false);
  assert.equal(canDamengRevokeRoleGrant("sysdba", { grantedRole: "DBA", inherited: false }), false);
  assert.equal(canDamengRevokeRoleGrant(undefined, { grantedRole: "DBA", inherited: false }), false);
});
test("damengRoleGraphSql selects the full role graph", () => {
  assert.equal(damengRoleGraphSql(), "SELECT GRANTEE, GRANTED_ROLE FROM DBA_ROLE_PRIVS");
});

test("parseDamengRoleGraph builds GRANTEE -> roles map", () => {
  const graph = parseDamengRoleGraph(
    queryResult(["GRANTEE", "GRANTED_ROLE"], [["SYSDBA", "DBA"], ["DBA", "VTI"], ["PUBLIC", "SVI"], ["SYSDBA", "DBA"]]),
  );
  assert.deepEqual([...graph.get("SYSDBA")!], ["DBA"]);
  assert.deepEqual([...graph.get("DBA")!], ["VTI"]);
  assert.deepEqual([...graph.get("PUBLIC")!], ["SVI"]);
});

test("damengRolesClosure mirrors the official DM tool (SYSDBA has 6 roles)", () => {
  const graph = new Map<string, string[]>([
    ["SYSDBA", ["DBA", "RESOURCE", "PUBLIC", "SOI", "SYS_ADMIN"]],
    ["DBA", ["VTI"]],
    ["PUBLIC", ["SVI"]],
  ]);
  const entries = damengRolesClosure("SYSDBA", graph);
  // BFS order: direct grants first, then nested roles in discovery order.
  assert.deepEqual(entries.map((e) => e.role), ["DBA", "RESOURCE", "PUBLIC", "SOI", "VTI", "SVI"]);
  const vti = entries.find((e) => e.role === "VTI")!;
  assert.equal(vti.direct, false);
  assert.equal(vti.via, "DBA");
  const svi = entries.find((e) => e.role === "SVI")!;
  assert.equal(svi.direct, false);
  assert.equal(svi.via, "PUBLIC");
  const dba = entries.find((e) => e.role === "DBA")!;
  assert.equal(dba.direct, true);
  // Hidden internal role SYS_ADMIN is excluded.
  assert.equal(entries.some((e) => e.role === "SYS_ADMIN"), false);
});

test("damengRolesClosure handles nesting for regular users and cycles", () => {
  // Note: parseDamengRoleGraph normalises keys to upper-case.
  const graph = new Map<string, string[]>([["ALICE", ["PUBLIC"]], ["PUBLIC", ["SVI"]], ["A", ["B"]], ["B", ["A"]]]);
  const alice = damengRolesClosure("alice", graph);
  assert.deepEqual(alice.map((e) => e.role), ["PUBLIC", "SVI"]);
  assert.equal(alice[0].direct, true);
  assert.equal(alice[1].direct, false);
  assert.equal(alice[1].via, "PUBLIC");
  // Cycle A <-> B must terminate without infinite recursion.
  const cycle = damengRolesClosure("A", graph);
  assert.ok(cycle.length <= 3);
  assert.ok(cycle.some((e) => e.role === "B"));
});

test("DAMENG_HIDDEN_ROLES contains the internal non-grantable role", () => {
  assert.deepEqual([...DAMENG_HIDDEN_ROLES], ["SYS_ADMIN"]);
});

test("predefined DM roles are detected case-insensitively", () => {
  assert.equal(isDamengPredefinedRole("DBA"), true);
  assert.equal(isDamengPredefinedRole("public"), true);
  assert.equal(isDamengPredefinedRole("DB_AUDIT_ADMIN"), true);
  assert.equal(isDamengPredefinedRole("DB_POLICY_SVI"), true);
  assert.equal(isDamengPredefinedRole("db_object_admin"), true);
  assert.equal(isDamengPredefinedRole("APP_ROLE"), false);
  assert.equal(isDamengPredefinedRole(undefined), false);
  assert.equal(isDamengPredefinedRole(""), false);
});

test("system privilege map SQL reads SYSTEM_PRIVILEGE_MAP", () => {
  const sql = damengSystemPrivilegeMapSql();
  assert.match(sql, /FROM\s+SYSTEM_PRIVILEGE_MAP/i);
  assert.match(sql, /ORDER BY\s+NAME/i);
});

test("parseDamengSystemPrivilegeMap normalises names to upper case", () => {
  const map = parseDamengSystemPrivilegeMap(queryResult(["PRIVILEGE", "NAME"], [[1, "CREATE TABLE"], [2, "select any table"], [3, ""]]));
  assert.equal(map.has("CREATE TABLE"), true);
  assert.equal(map.has("SELECT ANY TABLE"), true);
  assert.equal(map.has(""), false);
});

test("damengAvailableSystemPrivileges filters the catalog by instance map", () => {
  const available = damengAvailableSystemPrivileges(["CREATE SESSION", "CREATE TABLE", "ALTER ANY TABLE"], new Set(["CREATE SESSION", "CREATE TABLE"]));
  assert.deepEqual(available, ["CREATE SESSION", "CREATE TABLE"]);
  // Case-insensitive matching keeps the catalog's canonical spelling.
  const lower = damengAvailableSystemPrivileges(["CREATE SESSION"], new Set(["create session"]));
  assert.deepEqual(lower, ["CREATE SESSION"]);
});

test("ENABLE_DDL_ANY_PRIV SQL reads V$DM_INI parameter", () => {
  const sql = damengEnableDdlAnyPrivSql();
  assert.match(sql, /FROM\s+V\$DM_INI/i);
  assert.match(sql, /ENABLE_DDL_ANY_PRIV/i);
});

test("parseDamengEnableDdlAnyPriv reads the parameter value", () => {
  assert.equal(parseDamengEnableDdlAnyPriv(queryResult(["PARA_VALUE"], [["0"]])), false);
  assert.equal(parseDamengEnableDdlAnyPriv(queryResult(["PARA_VALUE"], [["1"]])), true);
  assert.equal(parseDamengEnableDdlAnyPriv(queryResult(["PARA_VALUE"], [])), true);
});

test("isDamengAnyPrivilege detects ANY-type privileges case-insensitively", () => {
  assert.equal(isDamengAnyPrivilege("CREATE ANY TABLE"), true);
  assert.equal(isDamengAnyPrivilege("select any view"), true);
  assert.equal(isDamengAnyPrivilege("GRANT ANY PRIVILEGE"), true);
  assert.equal(isDamengAnyPrivilege("CREATE TABLE"), false);
  assert.equal(isDamengAnyPrivilege("CREATE SESSION"), false);
});

test("create user SQL rejects empty username or password", () => {
  assert.throws(() => damengCreateUserSql({ username: "  ", password: "secret" }), /username must not be empty/i);
  assert.throws(() => damengCreateUserSql({ username: "alice", password: "" }), /password must not be empty/i);
  assert.throws(() => damengCreateUserSql({ username: "alice", password: "   " }), /password must not be empty/i);
});
