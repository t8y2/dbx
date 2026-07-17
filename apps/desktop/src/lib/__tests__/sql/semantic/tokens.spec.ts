import { describe, expect, it } from "vitest";
import { findActiveSqlStatementSpan, isSuppressedSqlSemanticContext, tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";

describe("sqlSemanticTokens", () => {
  it("tokenizes comments, strings, quoted identifiers, brackets, and backticks", () => {
    const sql = "select [User Name], `order`, \"Mixed\" from users -- comment\nwhere name = 'it''s ok'";
    const tokens = tokenizeSqlSemantic(sql);

    expect(tokens.some((token) => token.kind === "quoted_identifier" && unquoteSqlSemanticIdentifier(token) === "User Name")).toBe(true);
    expect(tokens.some((token) => token.kind === "quoted_identifier" && unquoteSqlSemanticIdentifier(token) === "order")).toBe(true);
    expect(tokens.some((token) => token.kind === "quoted_identifier" && unquoteSqlSemanticIdentifier(token) === "Mixed")).toBe(true);
    expect(tokens.some((token) => token.kind === "comment" && token.text.includes("comment"))).toBe(true);
    expect(tokens.some((token) => token.kind === "string" && token.text === "'it''s ok'")).toBe(true);
  });

  it("marks comments and string literals as suppressed contexts", () => {
    const sql = "select * from users -- user.";
    const tokens = tokenizeSqlSemantic(sql);

    expect(isSuppressedSqlSemanticContext(tokens, sql.length)).toBe(true);
    expect(isSuppressedSqlSemanticContext(tokens, "select * from users".length)).toBe(false);
  });

  it("treats hash prefixes as identifiers for SQL Server but comments for MySQL", () => {
    const sqlServerSql = "SELECT * FROM #temp; SELECT * FROM ##global_temp; SELECT * FROM tempdb..#temp";
    const sqlServerTokens = tokenizeSqlSemantic(sqlServerSql, "sqlserver");

    expect(sqlServerTokens.filter((token) => token.kind === "word" && token.text.startsWith("#")).map((token) => token.text)).toEqual(["#temp", "##global_temp", "#temp"]);
    expect(sqlServerTokens.some((token) => token.kind === "comment")).toBe(false);
    expect(tokenizeSqlSemantic("SELECT 1 # comment", "mysql").some((token) => token.kind === "comment" && token.text === "# comment")).toBe(true);
  });

  it("finds active statement spans across semicolon-separated scripts", () => {
    const sql = "select * from users;\nselect * from orders where id = 1;";
    const cursor = sql.indexOf("orders");
    const span = findActiveSqlStatementSpan(sql, tokenizeSqlSemantic(sql), cursor);

    expect(sql.slice(span.start, span.end)).toBe("select * from orders where id = 1");
  });
});
