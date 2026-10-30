import { describe, expect, it } from "vitest";
import { parseDataGridFilterInput, parseDataGridOrderByInput } from "@/lib/dataGrid/dataGridConditionSync";

describe("grid condition editor synchronization", () => {
  const columns = ["id", "palletNo", "beginTime", "a,b", "AND"];

  it("imports OSCAR quoted fields and string values into the filter panel", () => {
    expect(parseDataGridFilterInput("\"palletNo\" = '6'", columns, "oscar")).toEqual([{ columnName: "palletNo", mode: "equals", rawValue: "6", rawEndValue: "", conjunction: "AND" }]);
  });

  it("keeps quoted punctuation and parentheses out of boolean splitting", () => {
    expect(parseDataGridFilterInput("(id >= -2) AND (\"AND\" = 'a OR b')", columns)).toEqual([
      { columnName: "id", mode: "greater-than-or-equal", rawValue: "-2", rawEndValue: "", conjunction: "AND" },
      { columnName: "AND", mode: "equals", rawValue: "a OR b", rawEndValue: "", conjunction: "AND" },
    ]);
  });

  it("keeps quoted empty text usable in the rule builder", () => {
    expect(parseDataGridFilterInput("palletNo = ''", columns)?.[0]?.rawValue).toBe("''");
  });

  it("does not change explicit comparisons between different SQL value types", () => {
    const types = new Map([
      ["id", "int"],
      ["palletNo", "varchar"],
    ]);
    expect(parseDataGridFilterInput("palletNo = 6", columns, "oscar", types)).toBeUndefined();
    expect(parseDataGridFilterInput("id = '6'", columns, "oscar", types)).toBeUndefined();
    expect(parseDataGridFilterInput("id = 6", columns, "oscar", types)?.[0]?.rawValue).toBe("6");
    expect(parseDataGridFilterInput("palletNo = '6'", columns, "oscar", types)?.[0]?.rawValue).toBe("6");
  });

  it.each(["id = 1 OR id = 2 AND id = 3", "EXISTS (SELECT 1)", "id = other_id", "id =", "id = 'unfinished", "id = 1 2", "id LIKE '1%'", "id = 1 -- keep this comment"])("leaves unsupported expressions in text without approximating %s", (input) => {
    expect(parseDataGridFilterInput(input, columns)).toBeUndefined();
  });

  it("imports multi-column sorting, quoted commas and default ASC", () => {
    expect(parseDataGridOrderByInput('"beginTime" DESC, `a,b`, id ASC', columns)).toEqual([
      { columnName: "beginTime", direction: "desc" },
      { columnName: "a,b", direction: "asc" },
      { columnName: "id", direction: "asc" },
    ]);
  });

  it("recognizes the Neo4j table browser's generated source alias", () => {
    expect(parseDataGridOrderByInput("n.`id` DESC", columns, "neo4j")).toEqual([{ columnName: "id", direction: "desc" }]);
    expect(parseDataGridFilterInput("n.`id` = 1", columns, "neo4j")?.[0]?.columnName).toBe("id");
  });

  it.each(["COALESCE(id, 0) DESC", "id ASC NULLS LAST", "missing ASC", "id DESC,"])("preserves complex or incomplete sorting %s", (input) => {
    expect(parseDataGridOrderByInput(input, columns)).toBeUndefined();
  });
});
