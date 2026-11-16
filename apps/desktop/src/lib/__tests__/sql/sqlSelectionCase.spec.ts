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

  it("converts a selection that is fully contained inside a string literal", () => {
    const sql = "select * from orders where code = 'AbC001'";
    const from = sql.indexOf("bC");

    expect(convertSqlSelectionCase(sql, { from, to: from + 2 }, "lower")).toBe("bc");
  });

  it("still protects a string literal when the selection extends beyond it", () => {
    const sql = "select code from orders where code = 'abc001'";
    const from = sql.indexOf("code =");

    expect(convertSqlSelectionCase(sql, { from, to: sql.length }, "upper")).toBe("CODE = 'abc001'");
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

  // #10775: a selection made only of string literals joined by punctuation —
  // like the IN-list `('D','C','B','B','A')` — used to hit the string
  // protection and come back unchanged, which read as "the command does
  // nothing". With no identifiers or keywords inside the selection there is no
  // SQL structure to protect, so the explicit request converts the strings.
  it("converts an IN-list selection whose only word content is string literals", () => {
    const sql = "select * from t where code in ('D','C','B','B','A')";
    const from = sql.indexOf("('D'");

    expect(convertSqlSelectionCase(sql, { from, to: sql.length }, "lower")).toBe("('d','c','b','b','a')");
    expect(convertSqlSelectionCase(sql, { from, to: sql.length }, "upper")).toBe("('D','C','B','B','A')");
  });

  it("converts adjacent literals joined by operators or commas", () => {
    const sql = "select * from t where a = 'AbC' || 'DeF' and b in ('GhI','JkL')";

    expect(convertSqlSelectionCase(sql, { from: sql.indexOf("'AbC'"), to: sql.indexOf("||") - 1 }, "lower")).toBe("'abc'");
    expect(convertSqlSelectionCase(sql, { from: sql.indexOf("'GhI'"), to: sql.indexOf("'JkL'") + 5 }, "lower")).toBe("'ghi','jkl'");
  });

  it("still protects literals when the selection reaches identifiers or keywords", () => {
    const sql = "select * from t where code in ('D','C') and flag = 'E'";
    const from = sql.indexOf("in (");

    expect(convertSqlSelectionCase(sql, { from, to: sql.length }, "upper")).toBe("IN ('D','C') AND FLAG = 'E'");
  });

  it("keeps converting a selection fully inside one literal", () => {
    const sql = "select * from t where code = 'AbC001'";
    const from = sql.indexOf("bC");

    expect(convertSqlSelectionCase(sql, { from, to: from + 2 }, "upper")).toBe("BC");
  });

  it("treats number tokens outside literals as structure and keeps the protection", () => {
    const sql = "select * from t where score > 60 and grade = 'AbC'";
    const from = sql.indexOf("> 60");

    expect(convertSqlSelectionCase(sql, { from, to: sql.length }, "upper")).toBe("> 60 AND GRADE = 'AbC'");
  });

  describe("toggle mode (#5085)", () => {
    it("converts lowercase text to uppercase", () => {
      const sql = "select id, name from users";
      expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "toggle")).toBe("SELECT ID, NAME FROM USERS");
    });

    it("defaults mixed case to uppercase first", () => {
      const sql = "Select id, userName From Users";
      expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "toggle")).toBe("SELECT ID, USERNAME FROM USERS");
    });

    it("converts all-uppercase text to lowercase", () => {
      const sql = "SELECT ID, NAME FROM USERS";
      expect(convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "toggle")).toBe("select id, name from users");
    });

    it("cycles between uppercase and lowercase on repeated toggles", () => {
      const initial = "Select Name From Users";
      const first = convertSqlSelectionCase(initial, { from: 0, to: initial.length }, "toggle");
      expect(first).toBe("SELECT NAME FROM USERS");

      const second = convertSqlSelectionCase(first, { from: 0, to: first.length }, "toggle");
      expect(second).toBe("select name from users");

      const third = convertSqlSelectionCase(second, { from: 0, to: second.length }, "toggle");
      expect(third).toBe("SELECT NAME FROM USERS");
    });

    it("protects string literals when toggling case", () => {
      const sql = "select name from users where status = 'active'";
      const upper = convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "toggle");
      expect(upper).toBe("SELECT NAME FROM USERS WHERE STATUS = 'active'");

      const lower = convertSqlSelectionCase(upper, { from: 0, to: upper.length }, "toggle");
      expect(lower).toBe("select name from users where status = 'active'");
    });

    it("toggles bare string literals when selected directly", () => {
      const sql = "('first', 'second')";
      const upper = convertSqlSelectionCase(sql, { from: 0, to: sql.length }, "toggle");
      expect(upper).toBe("('FIRST', 'SECOND')");

      const lower = convertSqlSelectionCase(upper, { from: 0, to: upper.length }, "toggle");
      expect(lower).toBe("('first', 'second')");
    });
  });
});
