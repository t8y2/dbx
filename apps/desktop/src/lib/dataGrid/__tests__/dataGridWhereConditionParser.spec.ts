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
      // NOT LIKE 的否定必须保留模式的形状：'b%' 是不以 b 开头（not-begins-with），
      // 折叠成 contains 形的 not-like 会把 xbx 也错误排除（#15448 评审）。
      { id: "id-2", columnName: "name", mode: "not-begins-with", rawValue: "b", rawEndValue: "", conjunction: "AND" },
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

  it("keeps NOT LIKE negation lossless per pattern shape (#15448)", () => {
    expect(parse("name NOT LIKE '%x%'")?.[0]?.mode).toBe("not-like");
    expect(parse("name NOT LIKE 'x%'")?.[0]?.mode).toBe("not-begins-with");
    expect(parse("name NOT LIKE '%x'")?.[0]?.mode).toBe("not-ends-with");
    // 正向三形保持既有归类
    expect(parse("name LIKE '%x%'")?.[0]?.mode).toBe("like");
    expect(parse("name LIKE '%x'")?.[0]?.mode).toBe("ends-with");
    // `_` 是单字符通配符：后端会把值里的元字符转义成字面量，导入即漂移，拒绝
    expect(parse("name LIKE 'a_c%'")).toBeNull();
    expect(parse("name NOT LIKE 'a_c%'")).toBeNull();
    expect(parse("name LIKE 'a%c%'")).toBeNull();
  });

  it("is strict about identifier case sensitivity and ambiguity (#15448)", () => {
    const cased = ["Name", "name"];
    function parseOn(list: readonly string[], where: string) {
      let seq = 0;
      const rules = parseDataGridWhereCondition(where, list, () => `id-${(seq += 1)}`);
      return rules === null ? null : rules.map((rule) => ({ mode: rule.mode, columnName: rule.columnName }));
    }
    // 带引号标识符大小写敏感：精确命中才导入，不许折叠到大小写不同的兄弟列
    expect(parseOn(cased, `"Name" = 'x'`)).toEqual([{ mode: "equals", columnName: "Name" }]);
    expect(parseOn(cased, `"NAME" = 'x'`)).toBeNull();
    expect(parseOn(cased, "`Name` = 'x'")).toEqual([{ mode: "equals", columnName: "Name" }]);
    expect(parseOn(cased, "[Name] = 'x'")).toEqual([{ mode: "equals", columnName: "Name" }]);
    // 未引号标识符不敏感匹配在 Name/name 并存时有歧义，拒绝导入
    expect(parseOn(cased, "name = 'x'")).toBeNull();
    expect(parseOn(cased, "NAME = 'x'")).toBeNull();
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
