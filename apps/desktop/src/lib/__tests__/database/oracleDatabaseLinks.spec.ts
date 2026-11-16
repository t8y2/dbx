import { describe, expect, it } from "vitest";
import {
  OCEANBASE_ORACLE_DATABASE_LINKS_SQL,
  ORACLE_DATABASE_LINKS_SQL,
  createOracleDatabaseLinkSql,
  createOceanBaseDatabaseLinkSql,
  supportsOracleDatabaseLinks,
  alterOracleDatabaseLinkSql,
  dropOracleDatabaseLinkSql,
  oracleDatabaseLinkName,
  oracleDatabaseLinksSql,
  redactOracleDatabaseLinkError,
  testOracleDatabaseLinkSql,
} from "@/lib/database/oracleDatabaseLinks";
import { databaseObjectCapabilities } from "@/lib/database/databaseObjectCapabilities";
import { oracleDatabaseLinkCompletionContext as context, oracleDatabaseLinkCompletionItems as items } from "@/lib/sql/oracleDatabaseLinkCompletion";
describe("OceanBase Oracle schema objects", () => {
  it("exposes sequence and synonym source through the same object model as Oracle", () => {
    for (const db of ["oracle", "oceanbase-oracle"] as const) {
      const capabilities = databaseObjectCapabilities(db);
      expect(capabilities.sidebarObjects).toEqual(expect.arrayContaining(["SEQUENCE", "SYNONYM"]));
      expect(capabilities.sourceReadable).toEqual(expect.arrayContaining(["SEQUENCE", "SYNONYM"]));
      expect(supportsOracleDatabaseLinks(db)).toBe(true);
    }
    expect(supportsOracleDatabaseLinks("mysql")).toBe(false);
    expect(supportsOracleDatabaseLinks(undefined)).toBe(false);
  });
  const input = { name: "REMOTE.EXAMPLE", public: false, username: "remote_user", tenant: "MixedTenant", password: "test-only@pass", host: "127.0.0.1:2881", protocol: "OB" as const };
  it("creates OB links using HOST and preserves tenant and cluster case", () => {
    expect(createOceanBaseDatabaseLinkSql({ ...input, cluster: "MixedCluster" })).toBe('CREATE DATABASE LINK REMOTE.EXAMPLE CONNECT TO "REMOTE_USER"@"MixedTenant" IDENTIFIED BY "test-only@pass" OB HOST \'127.0.0.1:2881\' CLUSTER "MixedCluster"');
  });
  it("generates the explicit PUBLIC form when selected", () => {
    expect(createOceanBaseDatabaseLinkSql({ ...input, public: true })).toBe('CREATE PUBLIC DATABASE LINK REMOTE.EXAMPLE CONNECT TO "REMOTE_USER"@"MixedTenant" IDENTIFIED BY "test-only@pass" OB HOST \'127.0.0.1:2881\'');
  });
  it("creates OCI links using the oracle tenant and preserves quoted remote users", () => {
    expect(createOceanBaseDatabaseLinkSql({ ...input, username: '"MixedUser"', protocol: "OCI", host: "127.0.0.1:1521/service" })).toBe('CREATE DATABASE LINK REMOTE.EXAMPLE CONNECT TO "MixedUser"@"oracle" IDENTIFIED BY "test-only@pass" OCI HOST \'127.0.0.1:1521/service\'');
  });
  it("escapes host literals rather than accepting SQL syntax", () => {
    expect(createOceanBaseDatabaseLinkSql({ ...input, host: "bad'host" })).toContain("HOST 'bad''host'");
  });
  it("redacts complete and truncated passwords echoed by database errors", () => {
    expect(redactOracleDatabaseLinkError('failed: IDENTIFIED BY "test-only@pass" OB HOST', "test-only@pass")).not.toContain("test-only@pass");
    expect(redactOracleDatabaseLinkError('failed near IDENTIFIED BY "test-on', "test-only@pass")).toBe('failed near IDENTIFIED BY "[redacted]"');
  });
  it.each([{ tenant: "" }, { tenant: "\n" }, { password: "" }, { password: 'p"ass' }, { password: "p\nass" }, { host: "" }, { host: "bad\0host" }, { name: "x;DROP TABLE T" }, { protocol: "OCI", cluster: "c" }, { username: "" }])("rejects malformed link inputs %j", (overrides) => {
    expect(() => createOceanBaseDatabaseLinkSql({ ...input, ...overrides } as Parameters<typeof createOceanBaseDatabaseLinkSql>[0])).toThrow();
  });
  it("enables the shared @link completion only in supported contexts", () => {
    const sql = "SELECT * FROM DUAL@REM";
    expect(context(sql, sql.length, "oceanbase-oracle")).toEqual({ prefix: "REM", from: sql.indexOf("REM"), to: sql.length });
    for (const text of ["SELECT 'DUAL@", "-- DUAL@", "SELECT @@"]) expect(context(text, text.length, "oceanbase-oracle")).toBeNull();
  });
});

const privateLink = { owner: "APP", name: "REMOTE.EXAMPLE.COM", username: "REMOTE_USER", host: "//localhost:1521/XE", created: "" };
describe("Oracle database links", () => {
  it.each(["SELECT * FROM DUAL@", "SELECT * FROM APP.DUAL@", 'SELECT * FROM "Odd table"@', "UPDATE APP.T@", "BEGIN APP.PROC@", "INSERT INTO T@", "DELETE FROM T@", "SELECT * FROM A JOIN B@"])("offers suffix completion in %s", (sql) => {
    expect(context(sql, sql.length, "oracle")).toEqual({ prefix: "", from: sql.length, to: sql.length });
  });
  it("replaces an entire domain suffix, including text after the cursor", () => {
    const sql = "SELECT * FROM DUAL@REMOTE.EXAMPLE.COM";
    const cursor = sql.indexOf("EXAMPLE");
    expect(context(sql, cursor, "oracle")).toEqual({ prefix: "REMOTE.", from: sql.indexOf("REMOTE"), to: sql.length });
  });
  it.each(["SELECT '@", "-- DUAL@", "/* DUAL@", "SELECT @", "SELECT @@", "SELECT * FROM DUAL@@"])("suppresses non-link context %s", (sql) => expect(context(sql, sql.length, "oracle")).toBeNull());
  it("does not affect other dialects", () => expect(context("SELECT T@", 9, "mysql")).toBeNull());
  it("deduplicates public links shadowed by a private link and never inserts owner qualification", () => {
    expect(items([{ ...privateLink, owner: "PUBLIC" }, privateLink], "remote.")).toEqual([{ label: privateLink.name, apply: privateLink.name, type: "namespace", detail: "APP · REMOTE_USER · //localhost:1521/XE" }]);
  });
  it("keeps the login user's private links visible regardless of the editor's current schema", () => {
    const publicLink = { ...privateLink, owner: "PUBLIC", name: "PUBLIC.EXAMPLE.COM" };
    expect(items([privateLink, publicLink], "")).toHaveLength(2);
    expect(items([privateLink], "remote.")).toHaveLength(1);
    expect(items([privateLink], "other.")).toEqual([]);
  });
  it("uses the login user's visibility independently of current schema", () => {
    expect(ORACLE_DATABASE_LINKS_SQL).toContain("SESSION_USER");
    expect(ORACLE_DATABASE_LINKS_SQL).toContain("'PUBLIC'");
    expect(ORACLE_DATABASE_LINKS_SQL).not.toContain("CURRENT_SCHEMA");
  });
  it("lists tenant-visible OceanBase links and marks links created by the session user", () => {
    expect(oracleDatabaseLinksSql("oceanbase-oracle")).toBe(OCEANBASE_ORACLE_DATABASE_LINKS_SQL);
    expect(OCEANBASE_ORACLE_DATABASE_LINKS_SQL).toContain("FROM ALL_DB_LINKS");
    expect(OCEANBASE_ORACLE_DATABASE_LINKS_SQL).toContain("FROM USER_DB_LINKS");
    expect(OCEANBASE_ORACLE_DATABASE_LINKS_SQL).toContain("DBX_CAN_DROP");
    expect(oracleDatabaseLinksSql("oracle")).toBe(ORACLE_DATABASE_LINKS_SQL);
  });
  it("tests OceanBase links through a remote catalog table instead of DUAL", () => {
    expect(testOracleDatabaseLinkSql(privateLink, "oceanbase-oracle")).toBe("SELECT 1 AS DBX_LINK_OK FROM SYS.ALL_USERS@REMOTE.EXAMPLE.COM WHERE ROWNUM = 1");
    expect(testOracleDatabaseLinkSql(privateLink, "oracle")).toBe("SELECT 1 AS DBX_LINK_OK FROM DUAL@REMOTE.EXAMPLE.COM");
  });
  it("creates fixed-user links with an escaped connect string", () => {
    expect(createOracleDatabaseLinkSql({ name: privateLink.name, username: "REMOTE_USER", password: "p@ss", host: "test'host", public: false })).toBe(`CREATE DATABASE LINK REMOTE.EXAMPLE.COM CONNECT TO "REMOTE_USER" IDENTIFIED BY "p@ss" USING 'test''host'`);
  });
  it("updates the remote credential without redefining the link", () => expect(alterOracleDatabaseLinkSql(privateLink, "new-pass")).toBe('ALTER DATABASE LINK REMOTE.EXAMPLE.COM CONNECT TO "REMOTE_USER" IDENTIFIED BY "new-pass"'));
  it("preserves a case-sensitive remote user read from metadata", () => expect(alterOracleDatabaseLinkSql({ ...privateLink, username: "MixedCase" }, "new-pass")).toContain('CONNECT TO "MixedCase"'));
  it("normalizes unquoted usernames when creating links", () => expect(createOracleDatabaseLinkSql({ name: "REMOTE", username: "remote_user", password: "pass", host: "XE", public: false })).toContain('CONNECT TO "REMOTE_USER"'));
  it("drops public links with the public modifier", () => expect(dropOracleDatabaseLinkSql({ ...privateLink, owner: "PUBLIC" })).toBe("DROP PUBLIC DATABASE LINK REMOTE.EXAMPLE.COM"));
  it("drops OceanBase public links with the syntax accepted by OceanBase 4.2.5", () => expect(dropOracleDatabaseLinkSql({ ...privateLink, owner: "PUBLIC" }, "oceanbase-oracle")).toBe("DROP DATABASE LINK REMOTE.EXAMPLE.COM"));
  it.each(["x; DROP TABLE t", "x--", 'x"', "a b", "a..b"])("rejects unsafe link names %s", (name) => expect(() => oracleDatabaseLinkName(name)).toThrow());
});
