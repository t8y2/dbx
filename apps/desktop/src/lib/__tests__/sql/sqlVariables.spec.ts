import { describe, expect, it } from "vitest";
import { expandSqlVariables } from "@/lib/sql/sqlVariables";

describe("expandSqlVariables", () => {
  it("returns the SQL unchanged when there is no @set declaration", () => {
    const sql = "select * from t where id = @id";
    expect(expandSqlVariables(sql)).toEqual({ sql, expanded: false });
  });

  it("inlines a declared IN-list verbatim across the script", () => {
    const sql = ["@set client_id = (606,322,634);", "select * from invoices where client_id in @client_id"].join("\n");
    const { sql: result, expanded } = expandSqlVariables(sql);
    expect(expanded).toBe(true);
    expect(result).toBe("select * from invoices where client_id in (606,322,634)");
  });

  it("inlines a quoted string value verbatim", () => {
    const sql = ["@set date_start = '2026-07-04 00:00:00';", "select * from t where created_at < @date_start"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from t where created_at < '2026-07-04 00:00:00'");
  });

  it("inlines a declared shell-style reference", () => {
    const sql = ["@set postid = '224';", "select * from t where post_id = ${postid}"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from t where post_id = '224'");
  });

  it("recognizes a declaration after a leading line comment", () => {
    const sql = ["-- saved query", "@set devid=7062;", "select * from t where device_id = ${devid}"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("-- saved query\nselect * from t where device_id = 7062");
  });

  it("recognizes declarations after comments at a statement boundary", () => {
    const sql = ["select 1;", "/* next statement */", "@set devid = 7062;", "select ${devid}"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select 1;\n/* next statement */\nselect 7062");
  });

  it("does not recognize a declaration after an unterminated statement", () => {
    const sql = ["select 1", "-- same statement", "@set devid = 7062;", "select ${devid}"].join("\n");
    expect(expandSqlVariables(sql)).toEqual({ sql, expanded: false });
  });

  it("uses declarations from the surrounding document for a selected statement", () => {
    const selectedSql = "select * from t where post_id = ${postid}";
    const declarationSql = ["@set postid = '224';", selectedSql].join("\n");
    expect(expandSqlVariables(selectedSql, { declarationSql }).sql).toBe("select * from t where post_id = '224'");
  });

  it("leaves undeclared shell-style references for parameter prompting", () => {
    const sql = ["@set postid = '224';", "select ${postid}, ${missing}"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select '224', ${missing}");
  });

  it("expands the same variable in multiple places", () => {
    const sql = ["@set tenant = 42;", "select @tenant, count(*) from t where tenant_id = @tenant"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select 42, count(*) from t where tenant_id = 42");
  });

  it("supports several declarations", () => {
    const sql = ["@set a = 1;", "@set b = 'x';", "select @a, @b"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select 1, 'x'");
  });

  it("leaves undeclared @name references untouched", () => {
    const sql = ["@set a = 1;", "select @a, @b, @@version"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select 1, @b, @@version");
  });

  it("does not expand references inside strings, comments, or quoted identifiers", () => {
    const sql = ["@set a = 1;", "select '@a' as s, \"@a\" as q, `@a` as b -- @a"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select '@a' as s, \"@a\" as q, `@a` as b -- @a");
  });

  it("does not treat @set inside a string as a declaration", () => {
    const sql = "select '@set a = 1;' as note, @a";
    expect(expandSqlVariables(sql)).toEqual({ sql, expanded: false });
  });

  it("keeps PostgreSQL ARRAY literals from corrupting later variable references", () => {
    const sql = ["@set selected = 7;", "select ARRAY[']']::varchar[], @selected, ${missing}"].join("\n");
    expect(expandSqlVariables(sql, { databaseType: "postgres" }).sql).toBe("select ARRAY[']']::varchar[], 7, ${missing}");
  });

  it("keeps multiline PostgreSQL ARRAY values in @set declarations", () => {
    const sql = ["@set values = ARRAY[", "  'first',", "  'second'", "];", "select @values;"].join("\n");

    expect(expandSqlVariables(sql, { databaseType: "postgres" }).sql).toBe("select ARRAY[\n  'first',\n  'second'\n];");
  });

  it.each(["sqlserver", "sqlite", "jdbc"] as const)("preserves %s bracket identifiers during variable expansion", (databaseType) => {
    const sql = ["@set selected = 7;", "select [column:@ignored], @selected"].join("\n");
    expect(expandSqlVariables(sql, { databaseType }).sql).toBe("select [column:@ignored], 7");
  });

  it("keeps a value's own quotes and parentheses intact", () => {
    const sql = ["@set filter = (status = 'drafted' and deleted_at is null);", "select * from t where @filter"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from t where (status = 'drafted' and deleted_at is null)");
  });

  it("matches @set case-insensitively", () => {
    const sql = ["@SET a = 7;", "select @a"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select 7");
  });

  it("does not treat @settings as an @set declaration", () => {
    const sql = "select @settings from t";
    expect(expandSqlVariables(sql)).toEqual({ sql, expanded: false });
  });

  it("inlines a multiline value starting on a new line after =", () => {
    const sql = ["@set cond =", "  from users", "  where id = 42;", "select * @cond"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users\n  where id = 42");
  });

  it("terminates a value starting on the same line as = at newline without spanning lines", () => {
    const sql = ["@set cond = from users", "where id = 42;", "select * @cond"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("where id = 42;\nselect * from users");
  });

  it("expands a declaration without semicolon followed by an ordinary statement", () => {
    const sql = ["@set user_id = 42", "select * from users where id = @user_id"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users where id = 42");
  });

  it("preserves following statement when an unsemicoloned declaration has a line comment", () => {
    const sql = ["@set user_id = 42 -- user id", "select * from users where id = @user_id"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("-- user id\nselect * from users where id = 42");
  });

  it("preserves subsequent statements when an unsemicoloned declaration is followed by multiple statements", () => {
    const sql = ["@set user_id = 42", "select * from users where id = @user_id;", "select 1;"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users where id = 42;\nselect 1;");
  });

  it("does not swallow selected statement into preceding unsemicoloned declaration", () => {
    const selectedSql = "select * from users where id = @user_id";
    const declarationSql = ["@set user_id = 42", selectedSql].join("\n");
    expect(expandSqlVariables(selectedSql, { declarationSql }).sql).toBe("select * from users where id = 42");
  });

  it("expands an unsemicoloned declaration with CRLF line endings", () => {
    const sql = ["@set user_id = 42", "select * from users where id = @user_id"].join("\r\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users where id = 42");
  });

  it("expands a semicoloned declaration with CRLF line endings", () => {
    const sql = ["@set user_id = 42;", "select * from users where id = @user_id"].join("\r\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users where id = 42");
  });

  it("inlines a multiline value with CRLF line endings", () => {
    const sql = ["@set cond =", "  from users", "  where id = 42;", "select * @cond"].join("\r\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users\r\n  where id = 42");
  });

  it("supports sequential declarations with CRLF line endings", () => {
    const sql = ["@set a = 1", "@set b = 2;", "select @a, @b"].join("\r\n");
    expect(expandSqlVariables(sql).sql).toBe("select 1, 2");
  });

  it("inlines multiline values with line and block comments", () => {
    const sql = ["@set cond =", "  -- target table", "  from users /* active accounts */", "  where status = 'active';", "select id @cond"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select id -- target table\n  from users /* active accounts */\n  where status = 'active'");
  });

  it("handles semicolons inside comments within a multiline value", () => {
    const sql = ["@set cond =", "  from users -- note: filter by id; active only", "  where id = 42;", "select * @cond"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users -- note: filter by id; active only\n  where id = 42");
  });

  it("supports multiple multiline declarations in sequence", () => {
    const sql = ["@set cond_a =", "  from users", "  where id = 1;", "@set cond_b =", "  from orders", "  where id = 2;", "select * @cond_a union all select * @cond_b"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select * from users\n  where id = 1 union all select * from orders\n  where id = 2");
  });

  it("terminates declaration at newline when followed by another @set declaration without semicolon", () => {
    const sql = ["@set a = 1", "@set b = 2;", "select @a, @b"].join("\n");
    expect(expandSqlVariables(sql).sql).toBe("select 1, 2");
  });
});
