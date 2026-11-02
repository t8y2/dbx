import { describe, expect, it } from "vitest";
import { buildOracleObjectAuthorizationPlan, createOracleUserAdminActions, oracleDirectGrantsSql, oraclePrivilegeSql, oraclePasswordSql } from "@/lib/database/oracleUserAdmin";
import { loadOracleSecurity } from "@/lib/database/oracleSecurity";

describe("Oracle user administration", () => {
  it("uses exact selected metadata identities and rejects implicit or incompatible object scopes", async () => {
    const snapshot = await loadOracleSecurity(async (sql) => ({ columns: ["USERNAME"], rows: sql.includes("DBA_USERS") ? [["Reader"]] : [] }));
    const actions = createOracleUserAdminActions(snapshot, "Reader", false)!;
    const selection = { database: " Mixed.Owner ", preset: "custom" as const, privileges: ["SELECT"], tables: [{ name: "Mixed.Table", objectType: "TABLE" }] };
    expect(buildOracleObjectAuthorizationPlan(actions, "Reader", [selection], false).steps[0].sql).toBe('GRANT SELECT ON " Mixed.Owner "."Mixed.Table" TO "Reader";');
    for (const tables of [undefined, [], [{ name: "P", objectType: "PROCEDURE" }]]) expect(() => buildOracleObjectAuthorizationPlan(actions, "Reader", [{ ...selection, tables }], false)).toThrow();
  });
  it("displays only visible direct grants without turning inherited or PUBLIC grants into user grants", async () => {
    const snapshot = await loadOracleSecurity(async () => ({ columns: [], rows: [] }));
    snapshot.roleGrants.rows = [{ grantee: "Reader", role: "R1", adminOption: false }];
    snapshot.systemGrants.rows = [{ grantee: "R1", privilege: "CREATE TABLE", adminOption: false }];
    snapshot.objectGrants.rows = ["Reader", "R1", "PUBLIC"].map((grantee) => ({ grantee, owner: " Mixed.Owner ", objectName: "T", grantor: "OWNER", privilege: "SELECT", grantable: false }));
    expect(oracleDirectGrantsSql(snapshot, "Reader")).toEqual(['GRANT "R1" TO "Reader";', 'GRANT SELECT ON " Mixed.Owner "."T" TO "Reader";']);
  });
  it("quotes credentials without allowing a second SQL statement", () => {
    expect(oraclePasswordSql("MixedUser", "test';--/*pass", "old-pass")).toBe('ALTER USER "MixedUser" IDENTIFIED BY "test\';--/*pass" REPLACE "old-pass";');
    for (const password of ["", 'bad"value', "bad\nvalue", "bad\0value"]) expect(() => oraclePasswordSql("APP", password)).toThrow();
  });
  it("generates precise object and system actions, preserving explicit quoted case", () => {
    const input = { user: { user: "Reader", host: "" }, privileges: ["SELECT"], database: "app", table: '"Mixed.Table"', scope: "table" as const, grantOption: true };
    expect(oraclePrivilegeSql("user", input)).toBe('GRANT SELECT ON "APP"."Mixed.Table" TO "Reader" WITH GRANT OPTION;');
    expect(oraclePrivilegeSql("user", input, true)).toBe('REVOKE SELECT ON "APP"."Mixed.Table" FROM "Reader";');
    expect(oraclePrivilegeSql("user", { ...input, scope: "system", privileges: ["CREATE SESSION"] })).toBe('GRANT CREATE SESSION TO "Reader" WITH ADMIN OPTION;');
    expect(oraclePrivilegeSql("user", { ...input, scope: "role", role: "report_reader" })).toBe('GRANT "REPORT_READER" TO "Reader" WITH ADMIN OPTION;');
  });
  it("rejects invalid options and tokens while allowing plain role and PUBLIC grants", () => {
    const input = { user: { user: "PUBLIC", host: "" }, privileges: ["SELECT"], database: "APP", table: "T", scope: "table" as const };
    expect(oraclePrivilegeSql("public", input)).toBe('GRANT SELECT ON "APP"."T" TO PUBLIC;');
    expect(oraclePrivilegeSql("role", { ...input, user: { user: "R1", host: "" } })).toBe('GRANT SELECT ON "APP"."T" TO "R1";');
    for (const kind of ["public", "role"] as const) expect(() => oraclePrivilegeSql(kind, { ...input, grantOption: true })).toThrow();
    for (const value of ["*", "APP; DROP USER X", ""]) expect(() => oraclePrivilegeSql("user", { ...input, database: value })).toThrow();
    for (const privileges of [[], ["ALL"], ["SELECT; DROP USER X"]]) expect(() => oraclePrivilegeSql("user", { ...input, privileges })).toThrow();
  });
  it("offers account actions only for known users and requires current identity for password changes", async () => {
    const snapshot = await loadOracleSecurity(async (sql) => ({ columns: sql.includes("DBA_ROLES") ? ["ROLE"] : ["USERNAME"], rows: sql.includes("DBA_USERS") ? [["Reader"]] : sql.includes("DBA_ROLES") ? [["R1"]] : [] }));
    expect(createOracleUserAdminActions(snapshot, "Reader", false)?.alterLoginSql?.({ user: "Reader", host: "" }, false)).toBe('ALTER USER "Reader" ACCOUNT LOCK;');
    expect(createOracleUserAdminActions(snapshot, "Reader", false)?.alterPasswordSql).toBeUndefined();
    for (const name of ["R1", "PUBLIC", ""]) expect(createOracleUserAdminActions(snapshot, name, false)?.alterLoginSql).toBeUndefined();
    snapshot.currentUser.rows = ["Reader"];
    expect(createOracleUserAdminActions(snapshot, "Reader", false)?.alterPasswordSql).toBeTypeOf("function");
  });
});
