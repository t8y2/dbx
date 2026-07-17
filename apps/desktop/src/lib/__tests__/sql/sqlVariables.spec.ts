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
});
