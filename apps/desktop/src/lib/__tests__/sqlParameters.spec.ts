import { describe, expect, it } from "vitest";
import { extractSqlParameters, sqlParameterLiteral, substituteSqlParameters } from "../sqlParameters";

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
});

describe("sqlParameterLiteral", () => {
  it("falls back to quoted strings for invalid boolean input", () => {
    expect(sqlParameterLiteral({ kind: "boolean", value: "maybe" })).toBe("'maybe'");
  });
});
