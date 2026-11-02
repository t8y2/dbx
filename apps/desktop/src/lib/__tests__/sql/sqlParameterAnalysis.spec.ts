import { describe, expect, it } from "vitest";
import { maskSqlParametersForAnalysis, sqlParameterAnalysisRanges, substituteSqlParameters } from "@/lib/sql/sqlParameters";

describe("SQL parameter analysis input", () => {
  it.each(["@packetCode", "#{packetCode}", "${packetCode}", ":packetCode", "?", "[${packetCode}]"])("masks supported scalar parameters without moving SQL offsets: %s", (parameter) => {
    const sql = `SELECT htm FROM packets WHERE htm = ${parameter} AND missing = 1\r\nORDER BY djbth`;
    const masked = maskSqlParametersForAnalysis(sql, { databaseType: "mysql" });
    expect(masked).toHaveLength(sql.length);
    expect(masked.indexOf("missing")).toBe(sql.indexOf("missing"));
    expect(masked.indexOf("\r\n")).toBe(sql.indexOf("\r\n"));
    expect(masked).toContain(`= 0${" ".repeat(parameter.length - 1)} AND missing`);
    expect(sql).toContain(parameter);
  });
  it("preserves quoted strings, identifiers, comments, and disabled syntaxes", () => {
    const sql = "SELECT '#{literal}', `@column` FROM packets -- @comment\nWHERE htm = #{id} # @ignored";
    expect(maskSqlParametersForAnalysis(sql, { databaseType: "mysql", enabledSyntaxes: [] })).toBe(sql);
    const masked = maskSqlParametersForAnalysis(sql, { databaseType: "mysql" });
    expect(masked).toContain("'#{literal}'");
    expect(masked).toContain("`@column`");
    expect(masked).toContain("-- @comment");
    expect(masked).toContain("# @ignored");
    expect(sqlParameterAnalysisRanges(sql, { databaseType: "mysql" })).toEqual([{ from: sql.indexOf("#{id}"), to: sql.indexOf("#{id}") + 5 }]);
  });
  it("preserves newlines inside a braced parameter", () => {
    const sql = "SELECT #{\n id\n} AS value";
    expect(maskSqlParametersForAnalysis(sql, { databaseType: "mysql" })).toBe("SELECT 0 \n   \n  AS value");
  });
  it("does not rewrite native SQL Server variables or temp tables", () => {
    const sql = "DECLARE @id int = 1; SELECT @id, @@ROWCOUNT FROM #temp";
    expect(maskSqlParametersForAnalysis(sql, { databaseType: "sqlserver" })).toBe(sql);
  });
  it("keeps Oracle database links and PostgreSQL operators intact", () => {
    expect(maskSqlParametersForAnalysis("SELECT * FROM accounts@remote", { databaseType: "oracle" })).toBe("SELECT * FROM accounts@remote");
    expect(maskSqlParametersForAnalysis("SELECT doc #>> '{name}' FROM records", { databaseType: "postgres" })).toBe("SELECT doc #>> '{name}' FROM records");
  });
  it("leaves execution substitution behavior unchanged", () => {
    const sql = "SELECT * FROM packets WHERE htm = #{packetCode} AND other = @packetCode ORDER BY djbth";
    maskSqlParametersForAnalysis(sql, { databaseType: "mysql" });
    expect(substituteSqlParameters(sql, { packetCode: { kind: "string", value: "abc" } }, { databaseType: "mysql" })).toBe("SELECT * FROM packets WHERE htm = 'abc' AND other = 'abc' ORDER BY djbth");
  });
});
