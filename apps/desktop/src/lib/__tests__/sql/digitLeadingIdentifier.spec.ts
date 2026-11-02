import { describe, expect, it } from "vitest";
import { analyzeEditableQueryEditability } from "@/lib/sql/sqlAnalysis";
import { extractIdentifierAt, extractQualifiedIdentifierAt } from "@/lib/sql/sqlNavigation";

/**
 * MySQL/MariaDB allow an unquoted identifier to start with a digit as long as it is not a pure
 * number: `01_tablename` is a table name, `123` / `1e3` stay numeric literals. Before this the
 * grid could not map the result back to a base table (read-only) and hover/Ctrl+click found no
 * identifier at all. Regression coverage for #9992.
 */
describe("digit-leading identifiers (#9992)", () => {
  it("treats a digit-leading table name as editable", () => {
    const result = analyzeEditableQueryEditability("select * from 01_tablename");

    expect(result.editable).toBe(true);
    if (!result.editable) return;
    expect(result.analysis.tableName).toBe("01_tablename");
    expect(result.analysis.tableNameQuoted).toBe(false);
    expect(result.analysis.selectStar).toBe(true);
  });

  it("keeps schema-qualified digit-leading table names editable", () => {
    const result = analyzeEditableQueryEditability("select id, name from app.01_tablename");

    expect(result.editable).toBe(true);
    if (!result.editable) return;
    expect(result.analysis.schema).toBe("app");
    expect(result.analysis.tableName).toBe("01_tablename");
    expect(result.analysis.columns.map((column) => column.sourceName)).toEqual(["id", "name"]);
  });

  it("still treats a pure number as a literal instead of a source", () => {
    expect(analyzeEditableQueryEditability("select * from 123").editable).toBe(false);
    expect(analyzeEditableQueryEditability("select * from 1e3").editable).toBe(false);
  });

  it("extracts digit-leading identifiers for hover and Ctrl+click", () => {
    const sql = "select * from 01_tablename";

    expect(extractIdentifierAt(sql, sql.indexOf("01_tablename"))).toBe("01_tablename");
    expect(extractQualifiedIdentifierAt(sql, sql.indexOf("01_tablename"))?.parts).toEqual([{ value: "01_tablename", quoted: false }]);
  });

  it("does not extract numeric literals as identifiers", () => {
    const sql = "select 123, 1e3 from t";

    expect(extractIdentifierAt(sql, sql.indexOf("123"))).toBeNull();
    expect(extractIdentifierAt(sql, sql.indexOf("1e3"))).toBeNull();
  });
});
