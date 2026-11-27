import { nextTick } from "vue";
import { describe, expect, it } from "vitest";
import { useDataGridFilterBuilder } from "../useDataGridFilterBuilder";
import { parseDataGridWhereCondition } from "@/lib/dataGrid/dataGridWhereConditionParser";

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

  // #15448 评审：端到端往返——真实解析器把手输 WHERE 导入为规则行，且规则行
  // 生成的条件语义与原句一致；无法无损表达的句子保持原 WHERE（规则不被填充）。
  describe("round-trips the typed WHERE through the real parser (#15448)", () => {
    function createRealBuilder(currentWhere: string) {
      let seq = 0;
      return useDataGridFilterBuilder({
        columns,
        createId: () => `id-${(seq += 1)}`,
        isComplete: (rule) => rule.columnName !== "" && (rule.mode === "is-null" || rule.mode === "is-not-null" || rule.rawValue !== ""),
        buildCondition: async () => "1 = 1",
        currentWhere: () => currentWhere,
        importFromWhere: (where, names) => parseDataGridWhereCondition(where, names, () => `id-${(seq += 1)}`),
      });
    }

    it("imports lossless LIKE shapes that round-trip to the same predicate", async () => {
      const builder = createRealBuilder("task_id = 1 AND name NOT LIKE 'abc%' AND order_no LIKE '%9'");
      builder.open.value = true;
      await nextTick();
      expect(builder.rules.value.map((rule) => `${rule.columnName} ${rule.mode} ${rule.rawValue}`)).toEqual([
        "task_id equals 1",
        // NOT LIKE 'abc%' 保持「不以 abc 开头」，而非 contains 形的 not-like
        "name not-begins-with abc",
        "order_no ends-with 9",
      ]);
    });

    it.each([String.raw`name LIKE 'abc\%'`, "name = 'a' || 'b'"])("leaves the builder blank and applies no structured condition for %s", async (where) => {
      const builder = createRealBuilder(where);
      builder.ensureRule();
      builder.open.value = true;
      await nextTick();

      expect(builder.rules.value[0]?.columnName).toBe("");
      expect(await builder.apply()).toBe("");
    });

    it("keeps the raw WHERE when any fragment cannot be expressed losslessly", async () => {
      // NOT LIKE 'a_c%' 带 `_` 通配符、`LIKE 'a%c%'` 有内部通配：解析器整体拒绝
      const builder = createRealBuilder("name NOT LIKE 'a_c%' AND task_id = 1");
      builder.open.value = true;
      await nextTick();
      expect(builder.rules.value.every((rule) => rule.columnName === "")).toBe(true);
      // 手输 WHERE 仍是数据网格实际执行的过滤条件，不受打开弹层影响
      expect(builder.appliedWhereInput.value).toBe("");
    });
  });
});
