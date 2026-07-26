import { describe, expect, it } from "vitest";
import { buildOracleTnsConnectionString, normalizeOracleTnsAdminPath, parseOracleTnsConnectionString } from "./oracleTnsConnection";

describe("Oracle TNS connection settings", () => {
  it("round-trips an alias and TNS_ADMIN directory", () => {
    const value = buildOracleTnsConnectionString("DBX_FAILOVER", "C:\\oracle network\\admin");

    expect(parseOracleTnsConnectionString(value)).toEqual({
      alias: "DBX_FAILOVER",
      tnsAdmin: "C:\\oracle network\\admin",
    });
  });

  it("normalizes a selected tnsnames.ora file to its parent directory", () => {
    expect(normalizeOracleTnsAdminPath("C:\\oracle\\network\\admin\\tnsnames.ora")).toBe("C:\\oracle\\network\\admin");
    expect(normalizeOracleTnsAdminPath("C:\\tnsnames.ora")).toBe("C:\\");
    expect(normalizeOracleTnsAdminPath("/opt/oracle/network/admin/tnsnames.ora")).toBe("/opt/oracle/network/admin");
  });

  it("does not reinterpret service, SID, or descriptor JDBC URLs as TNS aliases", () => {
    expect(parseOracleTnsConnectionString("jdbc:oracle:thin:@//db.example.com:1521/ORCLPDB1")).toBeNull();
    expect(parseOracleTnsConnectionString("jdbc:oracle:thin:@db.example.com:1521:ORCL")).toBeNull();
    expect(parseOracleTnsConnectionString("jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(HOST=db.example.com)))")).toBeNull();
  });

  it("ignores malformed encoded aliases instead of breaking connection editing", () => {
    expect(parseOracleTnsConnectionString("jdbc:oracle:thin:@DBX%ZZ?TNS_ADMIN=%2Fopt%2Foracle")).toBeNull();
  });
});
