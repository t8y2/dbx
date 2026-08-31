import { describe, expect, it } from "vitest";
import { convertSqlSelectionCase } from "@/lib/sql/sqlSelectionCase";

describe("convertSqlSelectionCase", () => {
  it("converts SQL text without changing string literals", () => {
    const sql = "SELECT Code FROM Orders WHERE Code = 'ABC001' AND Note = 'It''s Ready'";

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "lower")).toBe("select code from orders where code = 'ABC001' and note = 'It''s Ready'");
  });

  it("preserves string literals when converting to uppercase", () => {
    const sql = "select code from orders where code = 'abc001'";

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "upper")).toBe("SELECT CODE FROM ORDERS WHERE CODE = 'abc001'");
  });

  it("preserves the selected fragment when the selection is inside a string literal", () => {
    const sql = "select * from orders where code = 'AbC001'";
    const from = sql.indexOf("bC");

    expect(convertSqlSelectionCase(sql, { from, to: from + 2 }, "lower")).toBe("bC");
  });

  it("preserves PostgreSQL dollar-quoted string literals", () => {
    const sql = "select $tag$Mixed Value$tag$ as label";

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "upper", "postgres")).toBe("SELECT $tag$Mixed Value$tag$ AS LABEL");
  });

  it("continues converting comments and quoted identifiers", () => {
    const sql = 'select "MixedName" -- Keep Comment\nfrom users';

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "lower")).toBe('select "mixedname" -- keep comment\nfrom users');
  });

  it("uses SQL Server tokenization so temp tables do not hide later literals", () => {
    const sql = "SELECT * FROM #Temp WHERE Code = 'AbC001'";

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "lower", "sqlserver")).toBe("select * from #temp where code = 'AbC001'");
  });

  it("preserves MySQL double-quoted strings", () => {
    const sql = 'SELECT "Mixed Value" AS Label';

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "lower", "mysql")).toBe('select "Mixed Value" as label');
  });

  it("preserves MySQL executable comments", () => {
    const sql = "SELECT 1 /*!40101 SET @Name = 'Mixed Value' */ FROM Dual";

    expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "lower", "mysql")).toBe("select 1 /*!40101 SET @Name = 'Mixed Value' */ from dual");
  });
});
