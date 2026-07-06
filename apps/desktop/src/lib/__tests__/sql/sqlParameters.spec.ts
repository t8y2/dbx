import { describe, expect, it } from "vitest";
import { extractSqlParameterDescriptors, extractSqlParameters, sqlParameterLiteral, substituteSqlParameters } from "@/lib/sql/sqlParameters";

describe("extractSqlParameters", () => {
  it("extracts unique template parameters in order", () => {
    const sql = "select * from t where pt_dt between ${start_date} and ${end_date} or pt_dt = ${start_date}";
    expect(extractSqlParameters(sql)).toEqual(["start_date", "end_date"]);
  });

  it("ignores placeholders inside strings, quoted identifiers, and comments", () => {
    const sql = `
      select '\${quoted}' as a, "\${identifier}" as b, \`\${mysql_identifier}\`
      -- \${line_comment}
      # \${hash_comment}
      /* \${block_comment} */
      from t
      where id = \${id}
    `;
    expect(extractSqlParameters(sql)).toEqual(["id"]);
  });

  it("ignores placeholders inside Postgres dollar-quoted strings", () => {
    const sql = "select $$ ${body_param} $$, $tag$ ${tag_param} $tag$, ${real_param}";
    expect(extractSqlParameters(sql)).toEqual(["real_param"]);
  });

  it("extracts supported placeholder syntaxes in order", () => {
    const sql = "select ? as a, :named as b, ${shell_name} as c, #{mybatis_name} as d, @sql_server_name as e";
    expect(extractSqlParameters(sql)).toEqual(["?1", "named", "shell_name", "mybatis_name", "sql_server_name"]);
  });

  it("describes each placeholder syntax for the parameter dialog", () => {
    const sql = "select ? as a, :named as b, ${shell_name} as c, #{mybatis_name} as d, @sql_server_name as e";
    expect(extractSqlParameterDescriptors(sql)).toEqual([
      { key: "?1", name: "?1", syntax: "positional", token: "?" },
      { key: "named", name: "named", syntax: "named", token: ":named" },
      { key: "shell_name", name: "shell_name", syntax: "shell", token: "${shell_name}" },
      { key: "mybatis_name", name: "mybatis_name", syntax: "mybatis", token: "#{mybatis_name}" },
      { key: "sql_server_name", name: "sql_server_name", syntax: "sqlserver", token: "@sql_server_name" },
    ]);
  });

  it("ignores declared SQL Server variables and system variables", () => {
    const sql = `
      declare @id int = 1, @name nvarchar(50);
      select @@version, @id, @name, @input_value
    `;
    expect(extractSqlParameters(sql)).toEqual(["input_value"]);
  });

  it("stops SQL Server declaration scanning when a new statement starts without a semicolon", () => {
    const sql = `
      declare @id int = 1
      select @id, @tenant_id
    `;
    expect(extractSqlParameters(sql)).toEqual(["tenant_id"]);
  });

  it("does not treat PostgreSQL casts or assignment operators as named parameters", () => {
    const sql = "select value::int, value := 1, :actual_value";
    expect(extractSqlParameters(sql)).toEqual(["actual_value"]);
  });
});

describe("substituteSqlParameters", () => {
  it("replaces placeholders with SQL literals", () => {
    const sql = "select * from t where dt >= ${start_date} and amount > ${amount} and enabled = ${enabled}";
    expect(
      substituteSqlParameters(sql, {
        start_date: { kind: "string", value: "2026-06-26" },
        amount: { kind: "number", value: "100.50" },
        enabled: { kind: "boolean", value: "true" },
      }),
    ).toBe("select * from t where dt >= '2026-06-26' and amount > 100.50 and enabled = TRUE");
  });

  it("escapes string values and supports null and raw SQL", () => {
    const sql = "select ${name}, ${empty_value}, ${expression}";
    expect(
      substituteSqlParameters(sql, {
        name: { kind: "string", value: "O'Reilly" },
        empty_value: { kind: "null", value: "" },
        expression: { kind: "raw", value: "current_date" },
      }),
    ).toBe("select 'O''Reilly', NULL, current_date");
  });

  it("replaces all supported placeholder syntaxes with SQL literals", () => {
    const sql = "select ? as a, :named as b, ${shell_name} as c, #{mybatis_name} as d, @sql_server_name as e";
    expect(
      substituteSqlParameters(sql, {
        "?1": { kind: "number", value: "42" },
        named: { kind: "string", value: "alpha" },
        shell_name: { kind: "boolean", value: "yes" },
        mybatis_name: { kind: "null", value: "" },
        sql_server_name: { kind: "raw", value: "current_timestamp" },
      }),
    ).toBe("select 42 as a, 'alpha' as b, TRUE as c, NULL as d, current_timestamp as e");
  });

  it("replaces repeated named placeholders once and positional placeholders independently", () => {
    const sql = "select :name, :name, ?, ?";
    expect(
      substituteSqlParameters(sql, {
        name: { kind: "string", value: "same" },
        "?1": { kind: "number", value: "1" },
        "?2": { kind: "number", value: "2" },
      }),
    ).toBe("select 'same', 'same', 1, 2");
  });

  it("leaves declared SQL Server variables untouched while replacing undeclared variables", () => {
    const sql = "DECLARE @id int = 1; SELECT * FROM users WHERE id = @id AND tenant_id = @tenant_id";
    expect(substituteSqlParameters(sql, { tenant_id: { kind: "number", value: "7" } })).toBe("DECLARE @id int = 1; SELECT * FROM users WHERE id = @id AND tenant_id = 7");
  });
});

describe("sqlParameterLiteral", () => {
  it("falls back to quoted strings for invalid boolean input", () => {
    expect(sqlParameterLiteral({ kind: "boolean", value: "maybe" })).toBe("'maybe'");
  });
});
