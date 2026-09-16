import { describe, expect, it } from "vitest";
import { resolveDataGridFilterRuleDropPlacement } from "@/lib/dataGrid/dataGridFilterRuleDrag";

const bounds = [
  { id: "r1", top: 100, bottom: 130 },
  { id: "r2", top: 130, bottom: 160 },
  { id: "r3", top: 160, bottom: 190 },
  { id: "r4", top: 190, bottom: 220 },
];

describe("resolveDataGridFilterRuleDropPlacement", () => {
  it("keeps the first and last insertion targets active beyond the outer rows", () => {
    expect(resolveDataGridFilterRuleDropPlacement(["r1", "r2", "r3", "r4"], "r3", bounds, 40)).toEqual({ ruleId: "r1", position: "before", targetIndex: 0 });
    expect(resolveDataGridFilterRuleDropPlacement(["r1", "r2", "r3", "r4"], "r2", bounds, 280)).toEqual({ ruleId: "r4", position: "after", targetIndex: 3 });
  });

  it("calculates the final index after removing the dragged rule", () => {
    expect(resolveDataGridFilterRuleDropPlacement(["r1", "r2", "r3", "r4"], "r1", bounds, 165)).toEqual({ ruleId: "r3", position: "before", targetIndex: 1 });
    expect(resolveDataGridFilterRuleDropPlacement(["r1", "r2", "r3", "r4"], "r4", bounds, 140)).toEqual({ ruleId: "r2", position: "before", targetIndex: 1 });
  });
});
