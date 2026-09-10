import { describe, expect, it } from "vitest";
import { flattenExplainPlanNodes, parseExplainResult, supportsExplainPlan } from "@/lib/diagram/explainPlan";
import type { QueryResult } from "@/types/database";

const DORIS_PLAN = `PLAN FRAGMENT 0
OUTPUT EXPRS:
  1:<slot 11> : 11: order_id
PARTITION: UNPARTITIONED

VEXCHANGE
  0:VSCAN NODE
    TABLE: internal.sales.orders
    PREAGGREGATION: ON`;

function explainResult(planText: string): QueryResult {
  return {
    columns: ["Explain String"],
    rows: planText.split("\n").map((line) => [line]),
    affected_rows: 0,
    execution_time_ms: 1,
  };
}

describe("Doris explain plan", () => {
  it("is enabled by the driver capability manifest", () => {
    expect(supportsExplainPlan("doris")).toBe(true);
  });

  it("keeps the text plan available without sending it through a JSON parser", () => {
    const parsed = parseExplainResult("doris", explainResult(DORIS_PLAN));

    expect(parsed.databaseType).toBe("doris");
    expect(parsed.raw).toBe(DORIS_PLAN);
    expect(flattenExplainPlanNodes(parsed.nodes).map((node) => node.title)).toEqual(["PLAN FRAGMENT 0", "OUTPUT EXPRS:", "1:<slot 11> : 11: order_id", "PARTITION: UNPARTITIONED", "VEXCHANGE", "0:VSCAN NODE", "TABLE: internal.sales.orders", "PREAGGREGATION: ON"]);
  });
});
