import { describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import { buildDataGridStructuredWhere, createDataGridFilterConditionCache, moveDataGridStructuredFilterRule, useDataGridFilterBuilder, type DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";

describe("useDataGridFilterBuilder", () => {
  it("finds columns by comments and keeps the column name when building a condition", async () => {
    const buildCondition = vi.fn(async (rule: DataGridStructuredFilterRule) => `${rule.columnName} = 'Alice'`);
    const builder = useDataGridFilterBuilder({
      columns: ["id", "customer_name", "email"],
      commentByColumn: new Map([["customer_name", "客户名称 / Customer Name"]]),
      createId: () => "rule-1",
      isComplete: () => true,
      buildCondition,
    });

    for (const query of ["客户", " CUSTOMER ", "name"]) {
      builder.columnSearch.value = query;
      expect(builder.filteredColumns.value).toEqual(["customer_name"]);
    }
    builder.ensureRule();
    builder.updateRule("rule-1", { columnName: builder.filteredColumns.value[0], rawValue: "Alice" });
    expect(await builder.buildWhere()).toBe("customer_name = 'Alice'");
    expect(buildCondition).toHaveBeenCalledWith(expect.objectContaining({ columnName: "customer_name" }));

    builder.columnSearch.value = "missing";
    expect(builder.filteredColumns.value).toEqual([]);
    builder.columnSearch.value = "  ";
    expect(builder.filteredColumns.value).toEqual(["id", "customer_name", "email"]);
  });

  it("reacts to refreshed comments and columns without including comments from absent columns", () => {
    const columns = ref(["id", "customer_name"]);
    const comments = ref(
      new Map([
        ["customer_name", "客户名称"],
        ["removed", "客户历史"],
      ]),
    );
    const builder = useDataGridFilterBuilder({ columns, commentByColumn: () => comments.value, isComplete: () => true, buildCondition: async () => "" });
    builder.columnSearch.value = "客户";
    expect(builder.filteredColumns.value).toEqual(["customer_name"]);
    comments.value = new Map([["customer_name", "姓名"]]);
    expect(builder.filteredColumns.value).toEqual([]);
    builder.columnSearch.value = "姓名";
    expect(builder.filteredColumns.value).toEqual(["customer_name"]);
    columns.value = ["id"];
    expect(builder.filteredColumns.value).toEqual([]);
  });

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

  it("adds one rule after the final rule is removed", () => {
    let nextId = 0;
    const builder = useDataGridFilterBuilder({ columns: ["id"], createId: () => `rule-${++nextId}`, isComplete: () => true, buildCondition: async () => "" });

    builder.ensureRule();
    builder.removeRule("rule-1");
    builder.addRule();

    expect(builder.rules.value.map((rule) => rule.id)).toEqual(["rule-2"]);
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

  it("applies only a previously disabled rule while retaining the other conditions", async () => {
    const builder = useDataGridFilterBuilder({
      columns: ["id", "method"],
      isComplete: () => true,
      buildCondition: async (rule) => `${rule.columnName} = '${rule.rawValue}'`,
    });
    builder.rules.value = [
      { id: "id-rule", columnName: "id", mode: "equals", rawValue: "1", rawEndValue: "", conjunction: "AND" },
      { id: "method-rule", columnName: "method", mode: "equals", rawValue: "POST", rawEndValue: "", conjunction: "OR", disabled: true },
    ];
    const originalRules = builder.rules.value.map((rule) => ({ ...rule }));
    builder.enableOnlyRule("method-rule");
    expect(await builder.buildWhere()).toBe("method = 'POST'");
    expect(builder.activeCount.value).toBe(1);
    expect(builder.rules.value).toEqual(originalRules.map((rule) => ({ ...rule, disabled: rule.id !== "method-rule" })));

    builder.enableOnlyRule("missing");
    builder.enableOnlyRule("method-rule");
    expect(await builder.buildWhere()).toBe("method = 'POST'");
    builder.updateRule("id-rule", { disabled: false });
    expect(await builder.buildWhere()).toBe("(id = '1') OR (method = 'POST')");
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
