import { describe, expect, it } from "vitest";
import { extractSqlParameters, maskSqlParametersForAnalysis, substituteSqlParameters } from "@/lib/sql/sqlParameters";

const options = { databaseType: "sqlserver" } as const;
const procedure = `ALTER PROCEDURE dbo.validate_customer @contractItemId INT
AS
BEGIN
  DECLARE @customerNickName VARCHAR(100);
  SELECT @customerNickName = b.nickName
  FROM dbo.Contracts a
  LEFT JOIN dbo.ContractItems sci ON a.recId = sci.contractId
  INNER JOIN dbo.Customers b ON b.recId = a.customerId
  WHERE sci.recId = @customerNickNamedddddasdds;
END`;

describe("SQL Server module variable parameters", () => {
  it("preserves undeclared procedure variables for server-side validation", () => {
    expect(extractSqlParameters(procedure, options)).toEqual([]);
    expect(substituteSqlParameters(procedure, { customerNickNamedddddasdds: { kind: "string", value: "" } }, options)).toBe(procedure);
    expect(maskSqlParametersForAnalysis(procedure, options)).toBe(procedure);
  });

  it.each([
    "CREATE PROCEDURE dbo.p AS SELECT @missing;",
    "ALTER PROC dbo.p AS SELECT @missing;",
    "CREATE OR ALTER PROCEDURE dbo.p AS SELECT @missing;",
    "CREATE /* header */ OR /* modifier */ ALTER PROC dbo.p AS SELECT @missing;",
    "CREATE FUNCTION dbo.f() RETURNS INT AS BEGIN RETURN @missing; END;",
    "ALTER FUNCTION dbo.f() RETURNS INT AS BEGIN RETURN @missing; END;",
    "CREATE TRIGGER dbo.tr ON dbo.t AFTER INSERT AS SELECT @missing;",
    "ALTER TRIGGER dbo.tr ON dbo.t AFTER INSERT AS SELECT @missing;",
    "CREATE OR ALTER FUNCTION dbo.f() RETURNS INT AS BEGIN RETURN @missing; END;",
    "CREATE OR ALTER TRIGGER dbo.tr ON dbo.t AFTER INSERT AS SELECT @missing;",
  ])("does not replace native variables in %s", (sql) => {
    expect(extractSqlParameters(sql, options)).toEqual([]);
    expect(substituteSqlParameters(sql, { missing: { kind: "number", value: "42" } }, options)).toBe(sql);
  });

  it("keeps explicit braced templates available within module definitions", () => {
    const sql = "CREATE PROCEDURE dbo.p AS SELECT @missing, ${tenant}, #{status};";
    expect(extractSqlParameters(sql, options)).toEqual(["tenant", "status"]);
    expect(substituteSqlParameters(sql, { tenant: { kind: "number", value: "7" }, status: { kind: "string", value: "paid" } }, options)).toBe("CREATE PROCEDURE dbo.p AS SELECT @missing, 7, 'paid';");
  });

  it.each(["GO", "go 2", "GO -- next batch", "/* batch separator */ GO", "GO /* next batch */"])("ends native-variable scope at %s", (separator) => {
    const prefix = "SELECT @before;\n";
    const sql = `${prefix}GO\n${procedure}\n${separator}\nSELECT @customerNickNamedddddasdds, @after;`;
    expect(extractSqlParameters(sql, options)).toEqual(["before", "customerNickNamedddddasdds", "after"]);
    expect(substituteSqlParameters(sql, { before: { kind: "raw", value: "@before" }, customerNickNamedddddasdds: { kind: "number", value: "42" }, after: { kind: "raw", value: "@after" } }, options)).toBe(`${prefix}GO\n${procedure}\n${separator}\nSELECT 42, @after;`);
  });

  it("ignores GO inside strings, comments, identifiers and ordinary SQL", () => {
    const sql = "CREATE PROCEDURE dbo.p AS BEGIN SELECT N'first\nGO\nlast', [GO]; /*\nGO\n*/ SELECT go, @missing FROM dbo.go; END;";
    expect(extractSqlParameters(sql, options)).toEqual([]);
  });

  it("keeps ordinary queries, calls and non-module DDL parameterized", () => {
    expect(extractSqlParameters("SELECT @tenant; EXEC dbo.p @id = @value; CREATE TABLE dbo.t (id INT DEFAULT @initial);", options)).toEqual(["tenant", "value", "initial"]);
    expect(extractSqlParameters("SELECT 'CREATE PROCEDURE p AS SELECT @missing', @value;", options)).toEqual(["value"]);
    expect(extractSqlParameters("CREATE VIEW dbo.v AS SELECT @initial AS value;", options)).toEqual(["initial"]);
  });

  it("preserves parameter behavior when the SQL Server dialect is not selected", () => {
    expect(extractSqlParameters(procedure)).toEqual(["customerNickNamedddddasdds"]);
    expect(extractSqlParameters("SELECT @tenant", { databaseType: "mysql" })).toEqual(["tenant"]);
    expect(extractSqlParameters("SELECT :tenant, ${status}", { databaseType: "postgres" })).toEqual(["tenant", "status"]);
  });
});
