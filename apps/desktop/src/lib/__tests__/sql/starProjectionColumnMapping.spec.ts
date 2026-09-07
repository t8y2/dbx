import { describe, expect, it } from "vitest";
import { analyzeEditableQueryEditability, resolveSourceColumnsByOrdinal } from "@/lib/sql/sqlAnalysis";

/**
 * An unqualified `*` is unambiguous when the query has exactly one source,
 * so it must bind to that source the same way a qualified `alias.*` does.
 * Regression coverage for #8015: `SELECT *, col FROM t` (bare star mixed
 * with an explicit column, single source, no alias) was dropping the star
 * expansion entirely because the bare-star projection carried no
 * `sourceKey`, misaligning every result column from that point on.
 */
describe("single-source star projection column mapping", () => {
  it("expands a bare unqualified star mixed with an explicit column", () => {
    const result = analyzeEditableQueryEditability("SELECT *, amount FROM orders");
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const source = { key: "orders:0", tableName: "orders" };
    const resolved = resolveSourceColumnsByOrdinal("mysql", result.analysis, [{ source, columns: [{ name: "id" }, { name: "user_id" }, { name: "amount" }] }], 4);
    expect(resolved).toEqual([
      { sourceKey: "orders:0", sourceColumn: "id" },
      { sourceKey: "orders:0", sourceColumn: "user_id" },
      { sourceKey: "orders:0", sourceColumn: "amount" },
      { sourceKey: "orders:0", sourceColumn: "amount" },
    ]);
  });

  it("expands a bare unqualified star mixed with an aliased source and leading explicit columns", () => {
    // Matches the issue's own repro shape: qualified explicit columns before
    // a trailing bare `*`, single aliased source, no primary key.
    const result = analyzeEditableQueryEditability("SELECT fl.sqlicenseno, fl.sqtypetext, * FROM flow_licenseapprove AS fl");
    expect(result.editable).toBe(true);
    if (!result.editable) return;

    const source = { key: "fl:0", tableName: "flow_licenseapprove" };
    const resolved = resolveSourceColumnsByOrdinal("kingbase", result.analysis, [{ source, columns: [{ name: "sqlicenseno" }, { name: "sqtypetext" }, { name: "uniformid" }, { name: "sqtypeid" }] }], 5);
    expect(resolved).toEqual([
      { sourceKey: "fl:0", sourceColumn: "sqlicenseno" },
      { sourceKey: "fl:0", sourceColumn: "sqtypetext" },
      { sourceKey: "fl:0", sourceColumn: "sqlicenseno" },
      { sourceKey: "fl:0", sourceColumn: "sqtypetext" },
      { sourceKey: "fl:0", sourceColumn: "uniformid" },
    ]);
  });

  it("still expands a plain unqualified star with no other columns (baseline, unchanged)", () => {
    const result = analyzeEditableQueryEditability("SELECT * FROM orders");
    expect(result.editable).toBe(true);
    if (!result.editable) return;
    expect(result.analysis.selectStar).toBe(true);

    const source = { key: "orders:0", tableName: "orders" };
    const resolved = resolveSourceColumnsByOrdinal("mysql", result.analysis, [{ source, columns: [{ name: "id" }, { name: "amount" }] }], 2);
    expect(resolved).toEqual([
      { sourceKey: "orders:0", sourceColumn: "id" },
      { sourceKey: "orders:0", sourceColumn: "amount" },
    ]);
  });
});
