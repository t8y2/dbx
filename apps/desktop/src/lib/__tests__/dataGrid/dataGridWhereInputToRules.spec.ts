import { describe, expect, it } from "vitest";
import { parseDataGridWhereInputToRules } from "@/lib/dataGrid/dataGridColumnFilter";

const COLUMNS = ["id", "status", "age", "name", "created_at"];

function parse(whereInput: string | undefined) {
  let count = 0;
  const rules = parseDataGridWhereInputToRules(whereInput, COLUMNS, () => `rule-${++count}`);
  if (rules === null) return null;
  return rules.map(({ id, ...rule }) => rule);
}

describe("parseDataGridWhereInputToRules (#15320)", () => {
  it("parses a simple equals condition", () => {
    expect(parse("id = 1")).toEqual([{ columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" }]);
  });

  it("parses MySQL backtick identifiers and quoted string values", () => {
    expect(parse("`status` = 'active'")).toEqual([{ columnName: "status", mode: "equals", rawValue: "active", rawEndValue: "", conjunction: "AND" }]);
    expect(parse("`t`.`status` = 'active'")).toEqual([{ columnName: "status", mode: "equals", rawValue: "active", rawEndValue: "", conjunction: "AND" }]);
    expect(parse("t.status = 'active'")).toEqual([{ columnName: "status", mode: "equals", rawValue: "active", rawEndValue: "", conjunction: "AND" }]);
  });

  it("matches column names case-insensitively and keeps the known casing", () => {
    expect(parse("STATUS = 'active'")).toEqual([{ columnName: "status", mode: "equals", rawValue: "active", rawEndValue: "", conjunction: "AND" }]);
  });

  it("keeps AND/OR conjunctions across conditions", () => {
    expect(parse("status = 'active' AND age > 18")).toEqual([
      { columnName: "status", mode: "equals", rawValue: "active", rawEndValue: "", conjunction: "AND" },
      { columnName: "age", mode: "greater-than", rawValue: "18", rawEndValue: "", conjunction: "AND" },
    ]);
    expect(parse("id = 1 OR id = 2")).toEqual([
      { columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" },
      { columnName: "id", mode: "equals", rawValue: "2", rawEndValue: "", conjunction: "OR" },
    ]);
  });

  it("parses comparison operators", () => {
    expect(parse("age >= 18")?.[0]?.mode).toBe("greater-than-or-equal");
    expect(parse("age <= 65")?.[0]?.mode).toBe("less-than-or-equal");
    expect(parse("age < 65")?.[0]?.mode).toBe("less-than");
    expect(parse("status != 'gone'")?.[0]?.mode).toBe("not-equals");
    expect(parse("status <> 'gone'")?.[0]?.mode).toBe("not-equals");
  });

  it("does not split on the AND inside BETWEEN", () => {
    expect(parse("age BETWEEN 18 AND 65")).toEqual([{ columnName: "age", mode: "between", rawValue: "18", rawEndValue: "65", conjunction: "AND" }]);
    expect(parse("age NOT BETWEEN 18 AND 65")?.[0]?.mode).toBe("not-between");
    expect(parse("age BETWEEN 18 AND 65 AND status = 'active'")).toHaveLength(2);
  });

  it("parses IN lists and NULL checks", () => {
    expect(parse("status IN ('a', 'b')")).toEqual([{ columnName: "status", mode: "in", rawValue: "'a', 'b'", rawEndValue: "", conjunction: "AND" }]);
    expect(parse("status NOT IN ('a')")?.[0]?.mode).toBe("not-in");
    expect(parse("name IS NULL")).toEqual([{ columnName: "name", mode: "is-null", rawValue: "", rawEndValue: "", conjunction: "AND" }]);
    expect(parse("name IS NOT NULL")?.[0]?.mode).toBe("is-not-null");
  });

  it("maps LIKE wildcards onto the matching builder mode", () => {
    expect(parse("name LIKE '%ann%'")?.[0]).toMatchObject({ mode: "like", rawValue: "ann" });
    expect(parse("name LIKE 'ann%'")?.[0]).toMatchObject({ mode: "begins-with", rawValue: "ann" });
    expect(parse("name LIKE '%ann'")?.[0]).toMatchObject({ mode: "ends-with", rawValue: "ann" });
    expect(parse("name NOT LIKE '%ann%'")?.[0]).toMatchObject({ mode: "not-like", rawValue: "ann" });
  });

  it("unwraps outer parentheses and tolerates a leading WHERE and trailing semicolon", () => {
    expect(parse("(id = 1)")).toEqual([{ columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" }]);
    expect(parse("WHERE id = 1;")).toEqual([{ columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" }]);
  });

  it("keeps quoted values with escaped quotes and AND inside strings intact", () => {
    expect(parse("name = 'O''Brien'")?.[0]).toMatchObject({ rawValue: "O'Brien" });
    expect(parse("name = 'a AND b' AND id = 1")).toHaveLength(2);
  });

  it("returns null for anything the builder cannot represent", () => {
    expect(parse(undefined)).toBeNull();
    expect(parse("")).toBeNull();
    expect(parse("LOWER(name) = 'x'")).toBeNull();
    expect(parse("name = other_col")).toBeNull();
    expect(parse("id IN (SELECT id FROM t)")).toBeNull();
    expect(parse("id = 1 AND (age > 2 OR age < 0)")).toBeNull();
    expect(parse("nope = 1")).toBeNull();
    expect(parse("id = 1 AND")).toBeNull();
    expect(parse("name LIKE 'abc'")).toBeNull();
    expect(parse("name LIKE 'a%b'")).toBeNull();
    expect(parse("id = 1 AND status = 'x' AND")).toBeNull();
  });
});
