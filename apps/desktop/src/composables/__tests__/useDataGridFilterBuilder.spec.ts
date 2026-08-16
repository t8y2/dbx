import { describe, expect, it, vi } from "vitest";
import { buildDataGridStructuredWhere, createDataGridFilterConditionCache, moveDataGridStructuredFilterRule, useDataGridFilterBuilder, type DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";

describe("useDataGridFilterBuilder", () => {
  it("searches columns by camel-case initials and any-position text", () => {
    const builder = useDataGridFilterBuilder({ columns: ["userProfile", "order_id", "created_at"], createId: () => "rule-1", isComplete: () => true, buildCondition: async () => "" });

    builder.columnSearch.value = "up";
    expect(builder.filteredColumns.value).toEqual(["userProfile"]);

    builder.columnSearch.value = "id";
    expect(builder.filteredColumns.value).toEqual(["order_id"]);
  });

  it("normalizes values when modes change", () => {
    const builder = useDataGridFilterBuilder({ columns: ["id"], createId: () => "rule-1", isComplete: () => true, buildCondition: async () => "id = 1" });
    builder.ensureRule();
    builder.updateRule("rule-1", { rawValue: "1", rawEndValue: "2", mode: "is-null" });
    expect(builder.rules.value[0]).toMatchObject({ rawValue: "", rawEndValue: "" });
  });

  it("starts new filter rules without preselecting a column", () => {
    const builder = useDataGridFilterBuilder({ columns: ["id", "name"], createId: () => "rule-1", isComplete: () => true, buildCondition: async () => "" });

    builder.ensureRule();

    expect(builder.rules.value[0]?.columnName).toBe("");
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
    builder.updateRule("rule-1", { columnName: "id", rawValue: "1" });
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

  it("moves complete and disabled rules while preserving their condition data", async () => {
    let nextId = 0;
    const builder = useDataGridFilterBuilder({
      columns: ["a", "b", "c"],
      createId: () => `rule-${++nextId}`,
      isComplete: () => true,
      buildCondition: async (rule) => `${rule.columnName} = ${rule.rawValue}`,
    });
    builder.ensureRule();
    builder.updateRule("rule-1", { columnName: "a", rawValue: "1" });
    builder.addRule();
    builder.updateRule("rule-2", { columnName: "b", rawValue: "2", disabled: true });
    builder.addRule();
    builder.updateRule("rule-3", { columnName: "c", rawValue: "3" });

    builder.moveRule("rule-3", 0);

    expect(builder.rules.value.map((rule) => rule.id)).toEqual(["rule-3", "rule-1", "rule-2"]);
    expect(builder.rules.value[2]).toMatchObject({ columnName: "b", rawValue: "2", disabled: true });
    expect(await builder.buildWhere()).toBe("(c = 3) AND (a = 1)");
  });

  it("clamps rule moves and ignores unknown rule ids", () => {
    const rule = (id: string): DataGridStructuredFilterRule => ({ id, columnName: id, mode: "equals", rawValue: id, rawEndValue: "", conjunction: "AND" });
    const rules = [rule("a"), rule("b"), rule("c")];

    expect(moveDataGridStructuredFilterRule(rules, "a", 99).map((item) => item.id)).toEqual(["b", "c", "a"]);
    expect(moveDataGridStructuredFilterRule(rules, "c", -2).map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(moveDataGridStructuredFilterRule(rules, "missing", 1)).toEqual(rules);
  });

  it("reuses unchanged rule conditions and drops removed rules", async () => {
    const cache = createDataGridFilterConditionCache();
    const buildFirst = vi.fn(async () => "id = 1");
    const buildChanged = vi.fn(async () => "id = 2");

    await expect(cache.resolve("rule-1", "id:1", buildFirst)).resolves.toBe("id = 1");
    await expect(cache.resolve("rule-1", "id:1", buildFirst)).resolves.toBe("id = 1");
    expect(buildFirst).toHaveBeenCalledOnce();

    await expect(cache.resolve("rule-1", "id:2", buildChanged)).resolves.toBe("id = 2");
    expect(buildChanged).toHaveBeenCalledOnce();

    cache.retain([]);
    await expect(cache.resolve("rule-1", "id:2", buildChanged)).resolves.toBe("id = 2");
    expect(buildChanged).toHaveBeenCalledTimes(2);
  });
});
