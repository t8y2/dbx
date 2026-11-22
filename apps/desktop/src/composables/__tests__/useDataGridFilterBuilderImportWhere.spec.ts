import { nextTick } from "vue";
import { describe, expect, it } from "vitest";
import { useDataGridFilterBuilder } from "../useDataGridFilterBuilder";

const columns = ["task_id", "order_no", "name", "status"];

function createBuilder(currentWhere: string, importFromWhere = true) {
  let seq = 0;
  return useDataGridFilterBuilder({
    columns,
    createId: () => `id-${(seq += 1)}`,
    isComplete: (rule) => rule.columnName !== "" && (rule.mode === "is-null" || rule.mode === "is-not-null" || rule.rawValue !== ""),
    buildCondition: async () => "1 = 1",
    currentWhere: () => currentWhere,
    importFromWhere: importFromWhere
      ? (where, names) => {
          // 与 DataGrid 相同的解析器入口；这里内联一个最小可预测版本以隔离组合逻辑。
          const fragments = where.split(/\s+AND\s+/i);
          const rules = fragments.map((fragment) => {
            const match = /^(\S+)\s*=\s*(.+)$/.exec(fragment.trim());
            if (!match || !names.includes(match[1]!)) return null;
            return { id: `id-${(seq += 1)}`, columnName: match[1]!, mode: "equals" as const, rawValue: match[2]!, rawEndValue: "", conjunction: "AND" as const };
          });
          return rules.every(Boolean) ? rules : null;
        }
      : undefined,
  });
}

describe("useDataGridFilterBuilder imports the typed WHERE on open (#15320)", () => {
  it("fills empty rules from the typed WHERE when the builder opens", async () => {
    const builder = createBuilder("task_id = 100234");
    builder.open.value = true;
    await nextTick();
    expect(builder.rules.value.map((rule) => `${rule.columnName} ${rule.mode} ${rule.rawValue}`)).toEqual(["task_id equals 100234"]);
  });

  it("keeps structured rules the user already built", async () => {
    const builder = createBuilder("task_id = 100234");
    builder.addRule({ columnName: "name", mode: "equals", rawValue: "abc" });
    builder.open.value = true;
    await nextTick();
    expect(builder.rules.value).toHaveLength(1);
    expect(builder.rules.value[0]!.columnName).toBe("name");
  });

  it("opens with the default blank rule when nothing can be imported", async () => {
    const builder = createBuilder("COUNT(*) > 1", true);
    builder.open.value = true;
    builder.ensureRule();
    await nextTick();
    expect(builder.rules.value).toHaveLength(1);
    expect(builder.rules.value[0]!.columnName).toBe("");
  });

  it("does not import without the import callback", async () => {
    const builder = createBuilder("task_id = 100234", false);
    builder.ensureRule();
    builder.open.value = true;
    await nextTick();
    expect(builder.rules.value.every((rule) => rule.columnName === "")).toBe(true);
  });
});
