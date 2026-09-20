import { describe, expect, it } from "vitest";
import { flattenExplainPlanNodes, parseExplainResult, supportsExplainPlan } from "@/lib/diagram/explainPlan";
import type { QueryResult } from "@/types/database";

const JSON_PLAN = {
  ID: 0,
  OPERATOR: "HASH JOIN ",
  NAME: "",
  "EST.ROWS": 1,
  "EST.TIME(us)": 5,
  output: "output([T1.C1], [T2.C1])",
  CHILD_2: { ID: 2, OPERATOR: "TABLE FULL SCAN", NAME: "T2", "EST.ROWS": 3, "EST.TIME(us)": 3, filter: "filter([T2.C1 > 4])" },
  CHILD_1: {
    ID: 1,
    OPERATOR: "SUBPLAN SCAN",
    NAME: "T1",
    "EST.ROWS": 2,
    "EST.TIME(us)": 3,
    output: "output([T1.C1])",
    CHILD_1: { ID: 3, OPERATOR: "EXPRESSION", NAME: "", "EST.ROWS": 1, "EST.TIME(us)": 1 },
  },
};

function explainResult(text: string): QueryResult {
  return { columns: ["Query Plan"], rows: text.split("\n").map((line) => [line]), affected_rows: 0, execution_time_ms: 1 };
}

describe("OceanBase Oracle explain plan", () => {
  it("is enabled by the generated driver capability", () => {
    expect(supportsExplainPlan("oceanbase-oracle")).toBe(true);
  });

  it("joins JDBC rows and keeps the ordered child tree and estimated metrics", () => {
    const plan = parseExplainResult("oceanbase-oracle", explainResult(JSON.stringify(JSON_PLAN, null, 2)));
    const nodes = flattenExplainPlanNodes(plan.nodes);

    expect(plan.raw).toEqual(JSON_PLAN);
    expect(nodes.map((node) => node.id)).toEqual(["0", "1", "3", "2"]);
    expect(nodes.map((node) => node.title)).toEqual(["HASH JOIN", "SUBPLAN SCAN on T1", "EXPRESSION", "TABLE FULL SCAN on T2"]);
    expect(nodes[0]).toMatchObject({ rows: "1", details: ["Estimated time: 5 µs", "output: output([T1.C1], [T2.C1])"] });
    expect(nodes[1]).toMatchObject({ relation: "T1", rows: "2" });
    expect(nodes[3].details).toContain("filter: filter([T2.C1 > 4])");
    expect(nodes[0].cost).toBeUndefined();
  });

  it("preserves an unrecognized plan as raw text", () => {
    expect(parseExplainResult("oceanbase-oracle", explainResult("unexpected format"))).toEqual({
      databaseType: "oceanbase-oracle",
      raw: "unexpected format",
      nodes: [],
    });
  });
});
