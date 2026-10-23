import { describe, expect, it } from "vitest";
import { setSqlServerAuthentication, sqlServerAuthentication, sqlServerUsesWindowsAuthentication } from "@/lib/connection/sqlServerAuthentication";

describe("SQL Server authentication parameters", () => {
  it.each([undefined, "", "applicationName=DBX", "integratedSecurity=true", "sqlserverAuth=sql"])("keeps existing SQL authentication for %s", (params) => {
    expect(sqlServerAuthentication(params)).toBe("sql");
  });

  it.each(["sqlserverAuth=windows", "?applicationName=DBX&SQLSERVERAUTH= Windows ", "applicationName={DBX; Client};sqlserverAuth={windows}", "sqlserverAuth=windows&sqlserverAuth=WINDOWS"])("reads Windows authentication from %s", (params) => {
    expect(sqlServerAuthentication(params)).toBe("windows");
  });

  it.each(["sqlserverAuth=", "sqlserverAuth", "sqlserverAuth=other", "sqlserverAuth=sql;sqlserverAuth=windows", "applicationName={DBX;sqlserverAuth=windows"])("rejects invalid or conflicting settings: %s", (params) => {
    expect(sqlServerAuthentication(params)).toBe("invalid");
  });

  it("does not mistake text inside braced values for authentication settings", () => {
    expect(sqlServerAuthentication("applicationName={DBX}};sqlserverAuth=windows}")).toBe("sql");
  });

  it.each(["?applicationName=DBX%20Client&encrypt=true", "applicationName={DBX; Client};password=50%;encrypt=false", "applicationName={DBX}}; Client};custom={a&b};encrypt=false", "integratedSecurity=true;authenticationScheme=JavaKerberos"])(
    "preserves unrelated parameters when changing authentication and back: %s",
    (params) => {
      const windows = setSqlServerAuthentication(params, "windows");
      expect(sqlServerAuthentication(windows)).toBe("windows");
      expect(setSqlServerAuthentication(windows, "sql")).toBe(params);
    },
  );

  it("replaces duplicate or invalid values with one unambiguous mode", () => {
    expect(setSqlServerAuthentication("sqlserverAuth=sql;applicationName=DBX;SQLSERVERAUTH=unknown", "windows")).toBe("applicationName=DBX;sqlserverAuth=windows");
    expect(setSqlServerAuthentication("sqlserverAuth=windows", "sql")).toBe("");
  });

  it("limits Windows authentication to SQL Server connections", () => {
    expect(sqlServerUsesWindowsAuthentication({ db_type: "sqlserver", url_params: "sqlserverAuth=windows" })).toBe(true);
    expect(sqlServerUsesWindowsAuthentication({ db_type: "mysql", url_params: "sqlserverAuth=windows" })).toBe(false);
  });
});
