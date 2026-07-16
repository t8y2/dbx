import { describe, expect, it } from "vitest";
import { buildDataGridStructuredWhere, useDataGridFilterBuilder, type DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";

describe("useDataGridFilterBuilder", () => {
  it("normalizes values when modes change", () => {
    const builder = useDataGridFilterBuilder({ columns: ["id"], createId: () => "rule-1", isComplete: () => true, buildCondition: async () => "id = 1" });
    builder.ensureRule();
    builder.updateRule("rule-1", { rawValue: "1", rawEndValue: "2", mode: "is-null" });
    expect(builder.rules.value[0]).toMatchObject({ rawValue: "", rawEndValue: "" });
  });

  it("skips disabled rules and applies conjunctions", async () => {
    let nextId = 0;
    const builder = useDataGridFilterBuilder({
      columns: ["id", "name"],
      createId: () => `rule-${++nextId}`,
      isComplete: (rule) => !!rule.rawValue,
      buildCondition: async (rule) => `${rule.columnName} = '${rule.rawValue}'`,
    });
    builder.ensureRule();
    builder.updateRule("rule-1", { rawValue: "1" });
    builder.addRule();
    builder.updateRule("rule-2", { columnName: "name", rawValue: "Alice", conjunction: "OR" });
    expect(await builder.apply()).toBe("(id = '1') OR (name = 'Alice')");
  });

  it("groups conditions in rule order", () => {
    const rule = (id: string, conjunction: "AND" | "OR"): DataGridStructuredFilterRule => ({ id, columnName: id, mode: "equals", rawValue: id, rawEndValue: "", conjunction });
    expect(
      buildDataGridStructuredWhere([
        { rule: rule("a", "AND"), condition: "a" },
        { rule: rule("b", "AND"), condition: "b" },
        { rule: rule("c", "OR"), condition: "c" },
      ]),
    ).toBe("((a) AND (b)) OR (c)");
  });
});
