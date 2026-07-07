import { describe, expect, it } from "vitest";
import { getDatabaseUserAdminProvider, kingbaseShowGrantsSql } from "@/lib/database/databaseUserAdmin";

describe("database user admin providers", () => {
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
