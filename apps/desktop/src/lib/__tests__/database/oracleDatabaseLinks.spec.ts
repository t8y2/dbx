import { describe, expect, it } from "vitest";
import { ORACLE_DATABASE_LINKS_SQL, createOracleDatabaseLinkSql, alterOracleDatabaseLinkSql, dropOracleDatabaseLinkSql, oracleDatabaseLinkName } from "@/lib/database/oracleDatabaseLinks";
import { oracleDatabaseLinkCompletionContext as context, oracleDatabaseLinkCompletionItems as items } from "@/lib/sql/oracleDatabaseLinkCompletion";
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
  it("creates fixed-user links with an escaped connect string", () => {
    expect(createOracleDatabaseLinkSql({ name: privateLink.name, username: "REMOTE_USER", password: "p@ss", host: "test'host", public: false })).toBe(`CREATE DATABASE LINK REMOTE.EXAMPLE.COM CONNECT TO "REMOTE_USER" IDENTIFIED BY "p@ss" USING 'test''host'`);
  });
  it("updates the remote credential without redefining the link", () => expect(alterOracleDatabaseLinkSql(privateLink, "new-pass")).toBe('ALTER DATABASE LINK REMOTE.EXAMPLE.COM CONNECT TO "REMOTE_USER" IDENTIFIED BY "new-pass"'));
  it("preserves a case-sensitive remote user read from metadata", () => expect(alterOracleDatabaseLinkSql({ ...privateLink, username: "MixedCase" }, "new-pass")).toContain('CONNECT TO "MixedCase"'));
  it("normalizes unquoted usernames when creating links", () => expect(createOracleDatabaseLinkSql({ name: "REMOTE", username: "remote_user", password: "pass", host: "XE", public: false })).toContain('CONNECT TO "REMOTE_USER"'));
  it("drops public links with the public modifier", () => expect(dropOracleDatabaseLinkSql({ ...privateLink, owner: "PUBLIC" })).toBe("DROP PUBLIC DATABASE LINK REMOTE.EXAMPLE.COM"));
  it.each(["x; DROP TABLE t", "x--", 'x"', "a b", "a..b"])("rejects unsafe link names %s", (name) => expect(() => oracleDatabaseLinkName(name)).toThrow());
});
