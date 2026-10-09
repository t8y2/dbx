import { describe, expect, it } from "vitest";
import type { QueryResult } from "@/types/database";
import {
  XUGU_OBJECT_TYPES,
  decodeXuguAuthority,
  xuguAclAuthorityLabels,
  parseXuguAclRows,
  parseXuguMemberships,
  parseXuguPrincipals,
  xuguAclRowsFallbackSql,
  xuguAclRowsSql,
  xuguAclColumnTargetsSql,
  xuguAlterLockSql,
  xuguAlterAccountSql,
  xuguAlterPasswordSql,
  xuguCreatePrincipalSql,
  xuguEnrichAclColumnTargets,
  xuguDropPrincipalSql,
  xuguDatabaseOptions,
  xuguGrantSql,
  xuguInheritedRoleIds,
  xuguListRolesSql,
  xuguListSchemasSql,
  xuguListUsersSql,
  xuguListObjectNamesSql,
  xuguListColumnNamesSql,
  xuguPrivilegesForScope,
  xuguQuoteIdentifier,
  xuguQuoteLiteral,
  xuguRevokeSql,
  xuguRoleMembershipsSql,
  type XuguPrincipal,
} from "../xuguUserPermissions";

function result(columns: string[], rows: unknown[][]): QueryResult {
  return { columns, rows } as QueryResult;
}

const user: XuguPrincipal = {
  id: "42",
  name: "APP_USER",
  isRole: false,
  locked: false,
  expired: false,
  isSystem: false,
};

describe("Xugu user and privilege helpers", () => {
  it("quotes identifiers and literals without allowing statement injection", () => {
    expect(xuguQuoteIdentifier('user"; DROP USER X')).toBe('"user""; DROP USER X"');
    expect(xuguQuoteLiteral("p'ass;word")).toBe("'p''ass;word'");
    expect(() => xuguQuoteIdentifier("  ")).toThrow("An identifier is required.");
    expect(() => xuguQuoteIdentifier("bad\nvalue")).toThrow("An identifier is required.");
    expect(() => xuguQuoteLiteral("bad\0value")).toThrow("Invalid string value.");
  });

  it("keeps database selection explicit and includes the confirmed current context", () => {
    expect(xuguDatabaseOptions([" DB_B ", "DB_A", "DB_A", ""], "DB_C")).toEqual(["DB_A", "DB_B", "DB_C"]);
    expect(xuguDatabaseOptions([], "DB_CURRENT")).toEqual(["DB_CURRENT"]);
    expect(xuguDatabaseOptions(["DB_A"], "")).toEqual(["DB_A"]);
  });

  it("scopes all catalog enumeration to the currently connected Xugu database", () => {
    expect(xuguListUsersSql()).toContain("DB_ID = CURRENT_DB_ID");
    expect(xuguListRolesSql()).toContain("DB_ID = CURRENT_DB_ID");
    expect(xuguRoleMembershipsSql()).toContain("DB_ID = CURRENT_DB_ID");
    expect(xuguListSchemasSql()).toContain("DB_ID = CURRENT_DB_ID");
    expect(xuguListObjectNamesSql("APP' SCHEMA", "TABLE")).toContain("S.SCHEMA_NAME = 'APP'' SCHEMA'");
    expect(xuguListObjectNamesSql("APP", "TABLE")).toContain("FROM DBA_OBJECTS O JOIN DBA_SCHEMAS S");
    expect(xuguListObjectNamesSql("APP", "TABLE")).toContain("O.OBJ_TYPE = 5");
    expect(xuguListObjectNamesSql("APP", "TABLE", false)).toContain("FROM ALL_OBJECTS O JOIN ALL_SCHEMAS S");
    expect(() => xuguListObjectNamesSql("APP", "TRIGGER")).toThrow("Choose a supported object type.");
    expect(xuguListColumnNamesSql("APP", "ORDERS", "TABLE")).toContain("FROM DBA_COLUMNS C JOIN DBA_TABLES T");
    expect(xuguListColumnNamesSql("APP", "ORDERS", "TABLE")).toContain("T.TABLE_NAME = 'ORDERS'");
    expect(xuguListColumnNamesSql("APP", "ORDER_VIEW", "VIEW")).toContain("FROM DBA_VIEW_COLUMNS C JOIN DBA_VIEWS V");
    expect(xuguListColumnNamesSql("APP", "ORDER_VIEW", "VIEW")).toContain("V.VIEW_NAME = 'ORDER_VIEW'");
    expect(xuguListColumnNamesSql("APP", "ORDER_VIEW", "VIEW", false)).toContain("FROM ALL_VIEW_COLUMNS C JOIN ALL_VIEWS V");
    expect(() => xuguListObjectNamesSql("APP", "DATABASE")).toThrow("Choose a supported object type.");
    expect(() => xuguListColumnNamesSql("APP", "SEQ", "SEQUENCE")).toThrow("Column grants are supported only for tables and views.");
  });

  it("filters ACL lookup to numeric principal IDs and provides a visibility fallback", () => {
    const sql = xuguAclRowsSql(["42", "7", "42", "1); DROP USER X"]);
    expect(sql).toContain("A.DB_ID = CURRENT_DB_ID");
    expect(sql).toContain("A.GRANTEE_ID IN (42, 7)");
    expect(sql).not.toContain("DROP USER");
    expect(xuguAclRowsSql(["42"])).toContain("FROM DBA_ACLS A");
    expect(xuguAclRowsSql(["42"])).toContain("A.OBJECT_ID = O.OBJ_ID AND A.OBJECT_TYPE = O.OBJ_TYPE AND A.DB_ID = O.DB_ID");
    expect(xuguAclRowsSql(["42"])).toContain("A.OBJECT_ID < 0 OR A.OBJECT_TYPE = 4");
    expect(xuguAclRowsSql(["42"])).toContain("S.SCHEMA_ID = CASE WHEN A.OBJECT_ID < 0 THEN -A.OBJECT_ID ELSE A.OBJECT_ID END AND A.DB_ID = S.DB_ID");
    expect(xuguAclRowsSql(["42"])).toContain("WHEN SO.SCHEMA_NAME IS NOT NULL AND O.OBJ_NAME IS NOT NULL");
    expect(xuguAclRowsSql(["42"])).not.toMatch(/\b(SHR|BIT_AND)\s*\(/i);
    expect(xuguAclRowsFallbackSql(["42"])).toContain("FROM ALL_ACLS A");
    expect(xuguAclRowsFallbackSql(["42"])).toContain("ALL_SCHEMAS");
  });

  it("resolves table and view column ACL targets in a separate optional catalog query", () => {
    const sql = xuguAclColumnTargetsSql(["42", "7", "42", "1); DROP USER X"]);
    expect(sql).toContain("A.GRANTEE_ID IN (42, 7)");
    expect(sql).toContain("A.OBJECT_TYPE = 6");
    expect(sql).toContain("T.TABLE_ID = SHR(A.OBJECT_ID, 10)");
    expect(sql).toContain("C.COL_NO = BIT_AND(A.OBJECT_ID, 1023)");
    expect(sql).toContain("V.VIEW_ID = SHR(A.OBJECT_ID, 10)");
    expect(sql).toContain("VC.COL_NO = BIT_AND(A.OBJECT_ID, 1023)");
    expect(sql).toContain("A.DB_ID = CURRENT_DB_ID");
    expect(sql).not.toContain("DROP USER");
    expect(xuguAclColumnTargetsSql(["42"], false)).toContain("FROM ALL_ACLS A");
    expect(xuguAclColumnTargetsSql([])).toContain("WHERE 1 = 0");

    const aclRows = [
      { grantorId: "1", granteeId: "42", objectId: "1076", objectType: 6, authority: "1", regrant: false, target: "Column object ID 1076", scope: "column" as const },
      { grantorId: "1", granteeId: "42", objectId: "2084", objectType: 28, authority: "2", regrant: false, target: "Column object ID 2084", scope: "column" as const },
      { grantorId: "1", granteeId: "42", objectId: "9999", objectType: 6, authority: "1", regrant: false, target: "Column object ID 9999", scope: "column" as const },
    ];
    const targets = result(
      ["GRANTEE_ID", "OBJECT_ID", "OBJECT_TYPE", "TARGET_NAME"],
      [
        [42, 1076, 6, "APP_SCHEMA.ORDERS.ORDER_ID"],
        [42, 2084, 28, "APP_SCHEMA.ORDER_VIEW.ORDER_ID"],
        [42, 9999, 6, "Column object ID 9999"],
      ],
    );
    expect(xuguEnrichAclColumnTargets(aclRows, targets).map((row) => row.target)).toEqual(["APP_SCHEMA.ORDERS.ORDER_ID", "APP_SCHEMA.ORDER_VIEW.ORDER_ID", "Column object ID 9999"]);
  });

  it("parses user status and roles from database catalog result rows", () => {
    const principals = parseXuguPrincipals(result(["USER_ID", "USER_NAME", "LOCKED", "EXPIRED", "IS_SYS", "UNTIL_TIME", "ALIAS"], [[42, "APP_USER", true, false, false, "2030-01-01", "Application account"]]), false);
    expect(principals).toEqual([
      {
        id: "42",
        name: "APP_USER",
        isRole: false,
        locked: true,
        expired: false,
        isSystem: false,
        validUntil: "2030-01-01",
        alias: "Application account",
      },
    ]);
    expect(parseXuguPrincipals(result(["USER_ID", "USER_NAME", "IS_SYS"], [[7, "APP_ROLE", false]]), true)[0]?.isRole).toBe(true);
    expect(parseXuguMemberships(result(["USER_ID", "ROLE_ID"], [[42, 7]]))).toEqual([{ userId: "42", roleId: "7" }]);
  });

  it("walks nested role membership without looping on corrupt or cyclic catalog rows", () => {
    expect(
      xuguInheritedRoleIds("42", [
        { userId: "42", roleId: "7" },
        { userId: "7", roleId: "8" },
        { userId: "8", roleId: "7" },
        { userId: "8", roleId: "42" },
      ]),
    ).toEqual(expect.arrayContaining(["7", "8"]));
    expect(xuguInheritedRoleIds("42", [{ userId: "42", roleId: "42" }])).toEqual([]);
  });

  it("decodes database, schema, object, and column authority masks", () => {
    expect(decodeXuguAuthority(0x7fffff, 0, "database")).toEqual(["DBA"]);
    expect(decodeXuguAuthority(0x80, 0, "database")).toEqual(["CREATE"]);
    expect(decodeXuguAuthority(0x80, 1, "database")).toEqual(["CREATE"]);
    expect(decodeXuguAuthority(0x80, 9, "database")).toEqual(["CREATE VIEW"]);
    expect(decodeXuguAuthority(0x100, 9, "database")).toEqual(["CREATE ANY VIEW"]);
    expect(decodeXuguAuthority(1 | 4, 5, "database")).toEqual(["SELECT ANY TABLE", "INSERT ANY TABLE"]);
    expect(decodeXuguAuthority(1 | 4, 5, "schema")).toEqual(["SELECT ANY TABLE", "INSERT ANY TABLE"]);
    expect(decodeXuguAuthority(1 | 4, 5, "object")).toEqual(["SELECT", "INSERT"]);
    expect(decodeXuguAuthority(3, 6, "column")).toEqual(["SELECT", "UPDATE"]);
    expect(decodeXuguAuthority("not-a-mask", 5, "object")).toEqual([]);
    expect(xuguAclAuthorityLabels(4096, 5, "object", "Unmapped authority")).toEqual(["Unmapped authority (4096)"]);
  });

  it("maps ACL rows to targets and labels inherited role grants separately", () => {
    const role: XuguPrincipal = { id: "7", name: "APP_READ_ROLE", isRole: true, locked: false, expired: false, isSystem: false };
    const parsed = parseXuguAclRows(result(["GRANTOR_ID", "GRANTEE_ID", "OBJECT_ID", "OBJECT_TYPE", "AUTHORITY", "REGRANT", "TARGET_NAME"], [[1, 7, 0, 5, 1, "F", "Current database"]]), [user, role], user.id);
    expect(parsed[0]).toMatchObject({ target: "Current database", scope: "database", regrant: false, inheritedFrom: "APP_READ_ROLE" });
  });

  it("identifies schema grants encoded as negative schema IDs by the live Xugu catalog", () => {
    const rows = result(["GRANTOR_ID", "GRANTEE_ID", "OBJECT_ID", "OBJECT_TYPE", "AUTHORITY", "REGRANT", "TARGET_NAME"], [[1, 42, -129, 5, 1, "F", "DBX_PERMISSION_SCHEMA_260929"]]);
    const grant = parseXuguAclRows(rows, [user], user.id)[0];
    expect(grant).toMatchObject({ scope: "schema", target: "DBX_PERMISSION_SCHEMA_260929", objectId: "-129", objectType: 5 });
    expect(decodeXuguAuthority(grant!.authority, grant!.objectType, grant!.scope)).toEqual(["SELECT ANY TABLE"]);
    const missingTarget = result(["GRANTOR_ID", "GRANTEE_ID", "OBJECT_ID", "OBJECT_TYPE", "AUTHORITY", "REGRANT"], [[1, 42, -129, 5, 1, "F"]]);
    expect(parseXuguAclRows(missingTarget, [user], user.id)[0]).toMatchObject({ scope: "schema", target: "Schema ID 129" });
    const typeFour = result(["GRANTOR_ID", "GRANTEE_ID", "OBJECT_ID", "OBJECT_TYPE", "AUTHORITY", "REGRANT"], [[1, 42, 12, 4, 1, "F"]]);
    expect(parseXuguAclRows(typeFour, [user], user.id)[0]).toMatchObject({ scope: "schema", target: "Schema ID 12" });
  });

  it("identifies instance-wide database lifecycle grants only in the system database", () => {
    const rows = result(["GRANTOR_ID", "GRANTEE_ID", "OBJECT_ID", "OBJECT_TYPE", "AUTHORITY", "REGRANT", "TARGET_NAME"], [[1, 42, 0, 1, 0x100, "F", "Current database"]]);
    const systemGrant = parseXuguAclRows(rows, [user], user.id, true)[0];
    const databaseGrant = parseXuguAclRows(rows, [user], user.id, false)[0];
    expect(systemGrant).toMatchObject({ scope: "system", target: "All databases" });
    expect(decodeXuguAuthority(systemGrant!.authority, systemGrant!.objectType, systemGrant!.scope)).toEqual(["CREATE ANY DATABASE"]);
    expect(databaseGrant).toMatchObject({ scope: "database", target: "Current database" });
  });

  it("builds scope-correct grant and revoke statements with identifier quoting", () => {
    expect(xuguGrantSql({ principal: user, scope: "database", privileges: ["CREATE ANY TABLE"] })).toBe('GRANT CREATE ANY TABLE TO "APP_USER";');
    expect(xuguGrantSql({ principal: user, scope: "schema", privileges: ["SELECT ANY TABLE"], schema: "APP SCHEMA" })).toBe('GRANT SELECT ANY TABLE IN SCHEMA "APP SCHEMA" TO "APP_USER";');
    expect(xuguGrantSql({ principal: user, scope: "object", privileges: ["SELECT", "UPDATE"], schema: "APP", object: "ORDERS", objectType: "TABLE", grantOption: true })).toBe('GRANT SELECT, UPDATE ON TABLE "APP"."ORDERS" TO "APP_USER" WITH GRANT OPTION;');
    expect(xuguGrantSql({ principal: user, scope: "object", privileges: ["EXECUTE"], schema: "APP", object: "DBX_PACKAGE", objectType: "PACKAGE" })).toBe('GRANT EXECUTE ON "APP"."DBX_PACKAGE" TO "APP_USER";');
    expect(xuguGrantSql({ principal: user, scope: "column", privileges: ["SELECT"], schema: "APP", object: "ORDERS", column: "ORDER_ID", objectType: "TABLE" })).toBe('GRANT SELECT ("ORDER_ID") ON "APP"."ORDERS" TO "APP_USER";');
    expect(xuguRevokeSql({ principal: user, scope: "object", privileges: ["SELECT"], schema: "APP", object: "ORDERS", objectType: "TABLE" })).toBe('REVOKE SELECT ON TABLE "APP"."ORDERS" FROM "APP_USER";');
    expect(xuguRevokeSql({ principal: user, scope: "column", privileges: ["UPDATE"], schema: "APP", object: "ORDERS", column: "STATUS", objectType: "TABLE" })).toBe('REVOKE UPDATE ("STATUS") ON "APP"."ORDERS" FROM "APP_USER";');
    expect(xuguGrantSql({ principal: user, scope: "role", role: "APP_READ_ROLE" })).toBe('GRANT ROLE "APP_READ_ROLE" TO "APP_USER";');
    expect(xuguRevokeSql({ principal: user, scope: "role", role: "APP_READ_ROLE" })).toBe('REVOKE ROLE "APP_READ_ROLE" FROM "APP_USER";');
    expect(() => xuguGrantSql({ principal: { ...user, isRole: true }, scope: "role", role: "APP_READ_ROLE" })).toThrow(/only be granted to users/);
    expect(() => xuguRevokeSql({ principal: { ...user, isRole: true }, scope: "role", role: "APP_READ_ROLE" })).toThrow(/only be revoked from users/);
    expect(xuguGrantSql({ principal: user, scope: "object", privileges: ["ALL PRIVILEGES"], schema: "APP", object: "ORDERS", objectType: "TABLE" })).toBe('GRANT ALL PRIVILEGES ON TABLE "APP"."ORDERS" TO "APP_USER";');
    expect(xuguRevokeSql({ principal: user, scope: "object", privileges: ["ALL PRIVILEGES"], schema: "APP", object: "ORDERS", objectType: "TABLE" })).toBe('REVOKE ALL PRIVILEGES ON TABLE "APP"."ORDERS" FROM "APP_USER";');
  });

  it("limits direct-object grant choices to documented target forms", () => {
    expect(XUGU_OBJECT_TYPES.map((item) => item.sql)).toEqual(["TABLE", "VIEW", "PROCEDURE", "SEQUENCE", "PACKAGE", "OBJECT"]);
    expect(xuguPrivilegesForScope("object", "TABLE").map((item) => item.name)).toContain("TRIGGER");
    expect(xuguPrivilegesForScope("database").map((item) => item.name)).toContain("CREATE ANY TRIGGER");
    expect(xuguPrivilegesForScope("schema").map((item) => item.name)).toContain("CREATE ANY TRIGGER");
    expect(xuguGrantSql({ principal: user, scope: "object", privileges: ["TRIGGER"], schema: "APP", object: "ORDERS", objectType: "TABLE" })).toBe('GRANT TRIGGER ON TABLE "APP"."ORDERS" TO "APP_USER";');
  });

  it("keeps generic job creation separate from CREATE ANY JOB", () => {
    const jobPrivileges = xuguPrivilegesForScope("database").filter((privilege) => privilege.name.endsWith("JOB"));
    expect(jobPrivileges).toEqual([
      { name: "CREATE ANY JOB", authorityType: 22, authorityBit: 0x100 },
      { name: "ALTER ANY JOB", authorityType: 22, authorityBit: 0x200 },
      { name: "DROP ANY JOB", authorityType: 22, authorityBit: 0x400 },
      { name: "CREATE JOB", authorityType: 0, authorityBit: 0x40000 },
    ]);
    const allPrivileges = xuguPrivilegesForScope("database");
    expect(new Set(allPrivileges.map((privilege) => privilege.name)).size).toBe(allPrivileges.length);
    expect(xuguGrantSql({ principal: user, scope: "database", privileges: ["CREATE ANY JOB"] })).toBe('GRANT CREATE ANY JOB TO "APP_USER";');
    expect(xuguGrantSql({ principal: user, scope: "database", privileges: ["CREATE JOB"] })).toBe('GRANT CREATE JOB TO "APP_USER";');
  });

  it("rejects unsupported scope/privilege combinations and database grant option", () => {
    expect(xuguPrivilegesForScope("schema").some((item) => item.name === "CREATE TABLE")).toBe(false);
    expect(xuguPrivilegesForScope("database").some((item) => item.name === "CREATE ANY DATABASE")).toBe(false);
    expect(xuguPrivilegesForScope("system")).toEqual([]);
    expect(xuguPrivilegesForScope("object", "TABLE").find((item) => item.name === "ALL PRIVILEGES")?.authorityBit).toBe(0x7df);
    expect(xuguPrivilegesForScope("object", "PROCEDURE").find((item) => item.name === "ALL PRIVILEGES")?.authorityBit).toBe(0x1a0);
    expect(xuguPrivilegesForScope("object", "SEQUENCE").find((item) => item.name === "ALL PRIVILEGES")?.authorityBit).toBe(0x183);
    expect(xuguPrivilegesForScope("system", undefined, true).map((item) => item.name)).toEqual(["CREATE ANY DATABASE", "ALTER ANY DATABASE", "DROP ANY DATABASE"]);
    expect(xuguGrantSql({ principal: user, scope: "system", privileges: ["CREATE ANY DATABASE"], systemDatabase: true })).toBe('GRANT CREATE ANY DATABASE TO "APP_USER";');
    expect(() => xuguGrantSql({ principal: user, scope: "system", privileges: ["CREATE ANY DATABASE"] })).toThrow("System database privileges can only be managed from the SYSTEM database.");
    expect(xuguRevokeSql({ principal: user, scope: "system", privileges: ["DROP ANY DATABASE"], systemDatabase: true })).toBe('REVOKE DROP ANY DATABASE FROM "APP_USER";');
    expect(() => xuguRevokeSql({ principal: user, scope: "system", privileges: ["DROP ANY DATABASE"] })).toThrow("System database privileges can only be managed from the SYSTEM database.");
    expect(() => xuguGrantSql({ principal: user, scope: "database", privileges: ["DROP USER"] })).toThrow("One or more privileges are not valid for this scope.");
    expect(() => xuguGrantSql({ principal: user, scope: "database", privileges: ["CREATE ANY TABLE"], grantOption: true })).toThrow("WITH GRANT OPTION is supported only for object-level privileges.");
    expect(() => xuguGrantSql({ principal: user, scope: "schema", privileges: ["SELECT ANY TABLE"], schema: "APP", grantOption: true })).toThrow("WITH GRANT OPTION is supported only for object-level privileges.");
    expect(() => xuguGrantSql({ principal: user, scope: "column", privileges: ["SELECT"], schema: "APP", object: "ORDERS", column: "ID", objectType: "TABLE", grantOption: true })).toThrow(/object-level/);
    expect(() => xuguGrantSql({ principal: user, scope: "column", privileges: ["SELECT"], schema: "APP", object: "ORDERS", column: "ID", objectType: "PROCEDURE" })).toThrow(/tables and views/);
    expect(() => xuguRevokeSql({ principal: user, scope: "column", privileges: ["SELECT"], schema: "APP", object: "ORDERS", column: "ID", objectType: "PROCEDURE" })).toThrow(/tables and views/);
    expect(() => xuguRevokeSql({ principal: user, scope: "column", privileges: ["SELECT"], schema: "APP", object: "ORDERS", column: "ID", objectType: "TABLE", revokeGrantOptionOnly: true })).toThrow(/object-level/);
    expect(() => xuguGrantSql({ principal: user, scope: "object", privileges: ["ALL PRIVILEGES", "SELECT"], schema: "APP", object: "ORDERS", objectType: "TABLE" })).toThrow(/cannot be combined/);
    expect(() => xuguRevokeSql({ principal: user, scope: "object", privileges: ["ALL PRIVILEGES", "SELECT"], schema: "APP", object: "ORDERS", objectType: "TABLE" })).toThrow(/cannot be combined/);
  });

  it("builds account lifecycle SQL and blocks built-in/system principal mutations", () => {
    expect(xuguCreatePrincipalSql("APP USER", false, "secret")).toBe("CREATE USER \"APP USER\" IDENTIFIED BY 'secret';");
    expect(
      xuguCreatePrincipalSql("APP USER", false, "p'ass", {
        defaultRoles: ["APP_READ_ROLE", "app_read_role", "APP_WRITE_ROLE; DROP USER X"],
        validUntil: "2035-06-07T08:09",
        locked: true,
        passwordExpired: true,
      }),
    ).toBe("CREATE USER \"APP USER\" IDENTIFIED BY 'p''ass'\n  DEFAULT ROLE \"APP_READ_ROLE\", \"APP_WRITE_ROLE; DROP USER X\"\n  VALID UNTIL '2035-06-07 08:09'\n  ACCOUNT LOCK\n  PASSWORD EXPIRE;");
    expect(xuguCreatePrincipalSql("APP ROLE", true)).toBe('CREATE ROLE "APP ROLE";');
    expect(() => xuguCreatePrincipalSql("APP USER", false, "secret", { validUntil: "2035-02-31" })).toThrow("Enter a valid date or date and time.");
    expect(xuguAlterAccountSql(user, { validUntil: "2035-06-07T08:09:10", passwordExpired: true })).toBe("ALTER USER \"APP_USER\"\n  VALID UNTIL '2035-06-07 08:09:10'\n  PASSWORD EXPIRE;");
    expect(() => xuguAlterAccountSql(user, {})).toThrow("Set a validity date or mark the password as expired.");
    expect(() => xuguAlterAccountSql({ ...user, isRole: true }, { validUntil: "2035-06-07" })).toThrow("Only non-system users can have account settings changed here.");
    expect(() => xuguAlterAccountSql({ ...user, isSystem: true }, { validUntil: "2035-06-07" })).toThrow("Only non-system users can have account settings changed here.");
    expect(xuguAlterPasswordSql(user, "next'password")).toBe("ALTER USER \"APP_USER\" IDENTIFIED BY 'next''password';");
    expect(xuguAlterLockSql(user, true)).toBe('ALTER USER "APP_USER" ACCOUNT LOCK;');
    expect(xuguDropPrincipalSql(user)).toBe('DROP USER "APP_USER" RESTRICT;');
    expect(() => xuguDropPrincipalSql({ ...user, isSystem: true })).toThrow("Built-in or system principals cannot be dropped from this screen.");
    expect(() => xuguDropPrincipalSql({ ...user, isRole: true, name: "PUBLIC" })).toThrow("Built-in or system principals cannot be dropped from this screen.");
    expect(() => xuguAlterLockSql({ ...user, name: "SYSDBA" }, false)).toThrow("Only non-system users can be locked or unlocked here.");
    expect(() => xuguAlterPasswordSql({ ...user, name: "SYSTEM" }, "x")).toThrow("Password changes are only allowed for non-system users.");
    expect(() => xuguAlterLockSql({ ...user, isSystem: true }, false)).toThrow("Only non-system users can be locked or unlocked here.");
    expect(() => xuguAlterPasswordSql({ ...user, isRole: true }, "x")).toThrow("Password changes are only allowed for non-system users.");
  });

  it("blocks direct grant changes to built-in principals while allowing ordinary principals", () => {
    const systemRole = { ...user, name: "DB_ADMIN", isRole: true, isSystem: true };
    expect(() => xuguGrantSql({ principal: systemRole, scope: "database", privileges: ["CREATE ANY TABLE"] })).toThrow("Built-in or system principals cannot be modified from this screen.");
    expect(() => xuguRevokeSql({ principal: systemRole, scope: "database", privileges: ["CREATE ANY TABLE"] })).toThrow("Built-in or system principals cannot be modified from this screen.");
    expect(xuguGrantSql({ principal: user, scope: "database", privileges: ["CREATE ANY TABLE"] })).toBe('GRANT CREATE ANY TABLE TO "APP_USER";');
  });
});
