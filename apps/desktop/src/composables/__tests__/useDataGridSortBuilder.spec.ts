import { nextTick, ref } from "vue";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDataGridStructuredOrderBy, clearDataGridSortBuilderMemoryCache, combineDataGridOrderByInputs, moveDataGridStructuredSortRule, useDataGridSortBuilder, type DataGridStructuredSortRule } from "@/composables/useDataGridSortBuilder";

function idFactory() {
  let index = 0;
  return () => `sort-${++index}`;
}

beforeEach(clearDataGridSortBuilderMemoryCache);

describe("structured data-grid ORDER BY", () => {
  it("combines manual and structured sorting without changing either input", () => {
    const manual = "LOWER(name) ASC";
    const structured = '"id" DESC';

    expect(combineDataGridOrderByInputs(manual, structured)).toBe('LOWER(name) ASC, "id" DESC');
    expect(manual).toBe("LOWER(name) ASC");
    expect(structured).toBe('"id" DESC');
    expect(combineDataGridOrderByInputs("", structured)).toBe(structured);
    expect(combineDataGridOrderByInputs("", "")).toBeUndefined();
  });

  it("builds enabled rules in priority order, allows duplicate fields, and rejects incomplete active rules", () => {
    const rules: DataGridStructuredSortRule[] = [
      { id: "a", columnName: "created at", direction: "desc" },
      { id: "b", columnName: "ignored", direction: "asc", disabled: true },
      { id: "c", columnName: "name", direction: "asc" },
    ];

    expect(buildDataGridStructuredOrderBy(rules, (column) => `"${column}"`)).toBe('"created at" DESC, "name" ASC');
    expect(buildDataGridStructuredOrderBy([...rules, { id: "d", columnName: "", direction: "asc" }], (column) => column)).toBeUndefined();
    expect(buildDataGridStructuredOrderBy([...rules, { id: "d", columnName: "name", direction: "desc" }], (column) => column)).toBe("created at DESC, name ASC, name DESC");
    expect(buildDataGridStructuredOrderBy([], (column) => column)).toBe("");
  });

  it("allows adding more sort rules than the number of available fields", () => {
    const builder = useDataGridSortBuilder({ columns: ["name"], cacheKey: "tab-1", scopeKey: "scope-1", createId: idFactory() });
    builder.setOpen(true);
    builder.updateRule(builder.rules.value[0]!.id, { columnName: "name" });

    builder.addRule();
    builder.updateRule(builder.rules.value[1]!.id, { columnName: "name", direction: "desc" });

    expect(builder.rules.value).toEqual([
      { id: "sort-1", columnName: "name", direction: "asc" },
      { id: "sort-2", columnName: "name", direction: "desc" },
    ]);
  });

  it("moves rules without mutating the source array", () => {
    const rules: DataGridStructuredSortRule[] = [
      { id: "a", columnName: "a", direction: "asc" },
      { id: "b", columnName: "b", direction: "desc" },
    ];
    const moved = moveDataGridStructuredSortRule(rules, "b", 0);
    expect(moved.map((rule) => rule.id)).toEqual(["b", "a"]);
    expect(rules.map((rule) => rule.id)).toEqual(["a", "b"]);
  });
});

describe("useDataGridSortBuilder", () => {
  it("keeps disabled draft rules when the same tab is remounted", async () => {
    const columns = ref(["id", "name"]);
    const first = useDataGridSortBuilder({ columns, cacheKey: "tab-1", scopeKey: "scope-1", createId: idFactory() });
    first.setOpen(true);
    first.updateRule(first.rules.value[0]!.id, { columnName: "id" });
    first.addRule();
    first.updateRule(first.rules.value[1]!.id, { columnName: "name", direction: "desc", disabled: true });
    first.markApplied('"id" ASC');
    await nextTick();

    const second = useDataGridSortBuilder({ columns, cacheKey: "tab-1", scopeKey: "scope-1", createId: idFactory() });
    second.setOpen(true);

    expect(second.rules.value).toHaveLength(2);
    expect(second.rules.value[1]).toMatchObject({ columnName: "name", direction: "desc", disabled: true });
    expect(second.appliedOrderByInput.value).toBe('"id" ASC');
  });

  it("isolates and restores rules for each cache and scope pair", async () => {
    const scopeKey = ref("scope-1");
    const builder = useDataGridSortBuilder({ columns: ["id", "name"], cacheKey: "tab-1", scopeKey, createId: idFactory() });
    builder.setOpen(true);
    builder.updateRule(builder.rules.value[0]!.id, { columnName: "id" });
    builder.markApplied('"id" ASC');
    await nextTick();

    scopeKey.value = "scope-2";
    await nextTick();
    builder.updateRule(builder.rules.value[0]!.id, { columnName: "name", direction: "desc", disabled: true });
    builder.markApplied("");
    await nextTick();

    scopeKey.value = "scope-1";
    await nextTick();
    expect(builder.rules.value).toEqual([{ id: "sort-1", columnName: "id", direction: "asc" }]);
    expect(builder.appliedOrderByInput.value).toBe('"id" ASC');

    scopeKey.value = "scope-2";
    await nextTick();
    expect(builder.rules.value).toEqual([{ id: "sort-2", columnName: "name", direction: "desc", disabled: true }]);
    expect(builder.appliedOrderByInput.value).toBe("");
  });

  it("resets only the draft without clearing the applied structured sort", () => {
    const builder = useDataGridSortBuilder({ columns: ["id", "name"], cacheKey: "tab-1", scopeKey: "scope-1", createId: idFactory() });
    builder.setOpen(true);
    builder.updateRule(builder.rules.value[0]!.id, { columnName: "id", direction: "desc" });
    builder.addRule();
    builder.updateRule(builder.rules.value[1]!.id, { columnName: "name", direction: "desc" });
    builder.markApplied('"id" DESC, "name" DESC');

    builder.reset();

    expect(builder.rules.value).toEqual([{ id: "sort-3", columnName: "", direction: "asc" }]);
    expect(builder.appliedOrderByInput.value).toBe('"id" DESC, "name" DESC');
  });

  it("clears draft and applied structured sorting together", () => {
    const builder = useDataGridSortBuilder({ columns: ["id", "name"], cacheKey: "tab-1", scopeKey: "scope-1", createId: idFactory() });
    builder.setOpen(true);
    builder.updateRule(builder.rules.value[0]!.id, { columnName: "id" });
    builder.markApplied('"id" ASC');

    builder.clear();

    expect(builder.rules.value).toEqual([{ id: "sort-2", columnName: "", direction: "asc" }]);
    expect(builder.activeRuleCount.value).toBe(0);
    expect(builder.appliedOrderByInput.value).toBe("");
  });

  it("updates the badge count from configured active rules before applying", () => {
    const builder = useDataGridSortBuilder({ columns: ["id", "name"], cacheKey: "tab-1", scopeKey: "scope-1", createId: idFactory() });
    builder.setOpen(true);
    expect(builder.activeRuleCount.value).toBe(0);

    builder.updateRule(builder.rules.value[0]!.id, { columnName: "id" });
    expect(builder.activeRuleCount.value).toBe(1);

    builder.addRule();
    expect(builder.activeRuleCount.value).toBe(1);

    builder.updateRule(builder.rules.value[1]!.id, { columnName: "name", direction: "desc" });
    expect(builder.activeRuleCount.value).toBe(2);

    builder.updateRule(builder.rules.value[0]!.id, { disabled: true });
    expect(builder.activeRuleCount.value).toBe(1);

    builder.enableOnlyRule(builder.rules.value[0]!.id);
    expect(builder.rules.value.map((rule) => !!rule.disabled)).toEqual([false, true]);
    expect(builder.activeRuleCount.value).toBe(1);
  });
});
