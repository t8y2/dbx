import { describe, expect, it } from "vitest";
import { parseDataGridWhereCondition } from "../dataGridWhereConditionParser";

const columns = ["task_id", "order_no", "name", "status", "amount", "created_at", "updated_at"];
function parse(where: string) {
  let seq = 0;
  const rules = parseDataGridWhereCondition(where, columns, () => `id-${(seq += 1)}`);
  return rules === null ? null : rules.map((rule, index) => ({ ...rule, id: `id-${index + 1}` }));
}

describe("parseDataGridWhereCondition (#15320)", () => {
  it("parses the issue's example into an equals rule", () => {
    expect(parse("task_id = 100234")).toEqual([{ id: "id-1", columnName: "task_id", mode: "equals", rawValue: "100234", rawEndValue: "", conjunction: "AND" }]);
  });

  it("parses AND chains of comparisons, LIKE and IS NULL", () => {
    expect(parse("task_id = 1 AND name LIKE 'x%' AND status IS NULL")).toEqual([
      { id: "id-1", columnName: "task_id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" },
      { id: "id-2", columnName: "name", mode: "begins-with", rawValue: "x", rawEndValue: "", conjunction: "AND" },
      { id: "id-3", columnName: "status", mode: "is-null", rawValue: "", rawEndValue: "", conjunction: "AND" },
    ]);
  });

  it("maps comparison operators and NOT variants", () => {
    expect(parse("amount > 10 OR amount <= 20")).toEqual([
      { id: "id-1", columnName: "amount", mode: "greater-than", rawValue: "10", rawEndValue: "", conjunction: "AND" },
      { id: "id-2", columnName: "amount", mode: "less-than-or-equal", rawValue: "20", rawEndValue: "", conjunction: "OR" },
    ]);
    expect(parse("status <> 'a' AND name NOT LIKE 'b%'")).toEqual([
      { id: "id-1", columnName: "status", mode: "not-equals", rawValue: "'a'", rawEndValue: "", conjunction: "AND" },
      { id: "id-2", columnName: "name", mode: "not-like", rawValue: "b", rawEndValue: "", conjunction: "AND" },
    ]);
    expect(parse("status IN ('a', 'b') OR status NOT IN ('c')")).toEqual([
      { id: "id-1", columnName: "status", mode: "in", rawValue: "'a', 'b'", rawEndValue: "", conjunction: "AND" },
      { id: "id-2", columnName: "status", mode: "not-in", rawValue: "'c'", rawEndValue: "", conjunction: "OR" },
    ]);
    expect(parse("status IS NOT NULL AND name = 'it''s'")).toEqual([
      { id: "id-1", columnName: "status", mode: "is-not-null", rawValue: "", rawEndValue: "", conjunction: "AND" },
      { id: "id-2", columnName: "name", mode: "equals", rawValue: "'it''s'", rawEndValue: "", conjunction: "AND" },
    ]);
  });

  it("matches columns case-insensitively and keeps typed quotes", () => {
    expect(parse("TASK_ID = 1 AND `order_no` = 'x'")).toEqual([
      { id: "id-1", columnName: "task_id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" },
      { id: "id-2", columnName: "order_no", mode: "equals", rawValue: "'x'", rawEndValue: "", conjunction: "AND" },
    ]);
  });

  it("rejects anything it cannot represent conservatively", () => {
    expect(parse("")).toBeNull();
    expect(parse("   ")).toBeNull();
    expect(parse("1 = 1")).toBeNull();
    expect(parse("COUNT(*) > 1")).toBeNull();
    expect(parse("a = 1 AND (b = 2 OR c = 3)")).toBeNull();
    expect(parse("a = 1 AND b = 2 OR c = 3")).toBeNull();
    expect(parse("unknown_col = 1")).toBeNull();
    expect(parse("amount = NULL")).toBeNull();
    expect(parse("name LIKE '%x' AND 1 = 1")).toBeNull();
    expect(parse("task_id = 'a")).toBeNull();
    expect(parse("name = 1 AND unknown = 2")).toBeNull();
  });

  it("accepts a trailing semicolon-stripped condition", () => {
    expect(parse("task_id = 100234;")?.[0]?.rawValue).toBe("100234");
  });
});
